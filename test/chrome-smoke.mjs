#!/usr/bin/env node
/*
 * Kyareeh+ — test de fumée du paquet Chrome.
 *
 * Ce que le script vérifie, dans un vrai Chrome (headless) :
 *   1. l'extension se charge sans erreur de manifeste (service worker présent) ;
 *   2. le service worker répond aux messages (version du manifeste) ;
 *   3. le content script s'injecte et monte le panneau dans un Shadow DOM ;
 *   4. la popup s'ouvre et affiche la version ;
 *   5. le panneau (mode harness, sans compte) rend chaque onglet sans exception JS.
 *
 * Le harness local est servi par test/server.cjs ; le content script n'étant
 * autorisé que sur https://kyara.games/*, une copie de test du paquet ajoute
 * http://127.0.0.1:8787/* à ses correspondances — le paquet publié, lui, n'est
 * pas modifié.
 *
 * Usage :
 *   node test/chrome-smoke.mjs
 *   CHROME_PATH="C:\...\chrome.exe" node test/chrome-smoke.mjs
 */

import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHROME =
  process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const HARNESS = 'http://127.0.0.1:8787/test/harness.html';
const SHOTS = resolve(ROOT, '..', '_shots');
const TMP = process.env.TEMP || process.env.TMP || ROOT;

const results = [];
let failures = 0;

function check(label, ok, detail = '') {
  results.push({ label, ok, detail });
  if (!ok) failures += 1;
  console.log(`${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, { timeout = 12000, interval = 150, label = 'condition' } = {}) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeout) {
    try {
      last = await fn();
      if (last) return last;
    } catch (err) {
      last = err;
    }
    await sleep(interval);
  }
  throw new Error(`Délai dépassé : ${label}`);
}

function killTree(pid) {
  if (!pid) return;
  spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
}

/* --- serveur du harness ---------------------------------------------- */

let server = null;

async function startServer() {
  server = spawn(process.execPath, [join(ROOT, 'test', 'server.cjs')], { cwd: ROOT, stdio: 'ignore' });
  await waitFor(
    async () => {
      try {
        return (await fetch(HARNESS)).ok;
      } catch {
        return false;
      }
    },
    { label: 'serveur harness', timeout: 8000 }
  );
}

function stopServer() {
  if (server) killTree(server.pid);
  server = null;
}

/* --- client CDP minimal ---------------------------------------------- */

async function connect(port) {
  let info = null;
  await waitFor(
    async () => {
      try {
        info = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
        return Boolean(info?.webSocketDebuggerUrl);
      } catch {
        return false;
      }
    },
    { label: 'Chrome CDP', timeout: 15000 }
  );

  const ws = new WebSocket(info.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });

  let nextId = 0;
  const pending = new Map();
  const listeners = new Set();
  const exceptions = [];

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve: res, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(`${msg.error.message} (${msg.error.code})`));
      else res(msg.result);
      return;
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      exceptions.push(msg.params?.exceptionDetails?.exception?.description || msg.params?.exceptionDetails?.text);
    }
    for (const fn of listeners) fn(msg);
  };

  const send = (method, params = {}, sessionId = undefined) =>
    new Promise((res, rej) => {
      const id = ++nextId;
      pending.set(id, { resolve: res, reject: rej });
      ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });

  return { ws, send, listeners, exceptions };
}

async function attach(cdp, targetId, { page = true } = {}) {
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Runtime.enable', {}, sessionId);
  if (page) await cdp.send('Page.enable', {}, sessionId);
  return sessionId;
}

async function evaluate(cdp, sessionId, expression, { awaitPromise = true } = {}) {
  const { result, exceptionDetails } = await cdp.send(
    'Runtime.evaluate',
    { expression, awaitPromise, returnByValue: true },
    sessionId
  );
  if (exceptionDetails) {
    throw new Error(exceptionDetails.exception?.description || exceptionDetails.text || 'erreur JS');
  }
  return result?.value;
}

async function openTab(cdp, url) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const sessionId = await attach(cdp, targetId);
  await cdp.send('Page.navigate', { url }, sessionId);
  await waitFor(() => evaluate(cdp, sessionId, 'document.readyState === "complete"'), {
    label: `chargement ${url}`
  });
  return { targetId, sessionId };
}

/* --- lancement de Chrome --------------------------------------------- */

function launchChrome({ name, extension = null, port }) {
  const profile = join(TMP, `kp-chrome-${name}`);
  rmSync(profile, { recursive: true, force: true });
  const args = [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--window-size=1600,1000',
    'about:blank'
  ];
  if (extension) args.unshift(`--load-extension=${extension}`);
  const proc = spawn(CHROME, args, { stdio: 'ignore' });
  return { proc, profile };
}

async function closeChrome(proc) {
  try {
    proc.kill();
  } catch {
    /* ignore */
  }
  killTree(proc.pid);
}

/* --- copie de test du paquet ----------------------------------------- */

function makeTestPackage() {
  const dir = join(TMP, 'kp-chrome-test-ext');
  rmSync(dir, { recursive: true, force: true });
  cpSync(join(ROOT, 'dist', 'chrome'), dir, { recursive: true });

  const manifestPath = join(dir, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const local = 'http://127.0.0.1:8787/*';
  for (const cs of manifest.content_scripts ?? []) {
    cs.matches = [...new Set([...(cs.matches ?? []), local])];
  }
  for (const war of manifest.web_accessible_resources ?? []) {
    war.matches = [...new Set([...(war.matches ?? []), local])];
  }
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return dir;
}

/* --- tests ----------------------------------------------------------- */

async function visualPass() {
  console.log('\n— Rendu de l’interface (harness, sans extension) —');
  const { proc } = launchChrome({ name: 'visual', port: 9334, extension: null });
  let cdp = null;
  try {
    cdp = await connect(9334);
    const { sessionId } = await openTab(cdp, HARNESS);
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false
    }, sessionId);

    await waitFor(() => evaluate(cdp, sessionId, 'Boolean(window.__kyaraPlus)'), {
      label: 'hook __kyaraPlus'
    });
    await waitFor(() => evaluate(cdp, sessionId, 'window.__kyaraPlus.state.ready === true'), {
      label: 'données du harness chargées'
    });
    // Le harness envoie lui-même Alt+K après 900 ms : on attend qu'il ait fini
    // pour piloter l'ouverture sans être contredit.
    await sleep(1300);

    mkdirSync(SHOTS, { recursive: true });

    for (const [tab, file] of [
      ['account', 'chrome-compte.png'],
      ['sell', 'chrome-vente.png'],
      ['stat', 'chrome-stat.png']
    ]) {
      await evaluate(
        cdp,
        sessionId,
        `(() => {
           window.__kyaraPlus.setOpen(true);
           window.__kyaraPlus.setTab(${JSON.stringify(tab)});
           return true;
         })()`
      );
      await sleep(450);
      // Sécurité : le rendu peut refermer le panneau si un évènement du harness traîne.
      await evaluate(cdp, sessionId, 'window.__kyaraPlus.setOpen(true)');
      await waitFor(
        () =>
          evaluate(
            cdp,
            sessionId,
            `document.querySelector('#kyara-plus-root').shadowRoot.querySelector('#kp-view')?.innerText.length > 40`
          ),
        { label: `vue ${tab} rendue` }
      );
      await sleep(300);
      const rect = await evaluate(
        cdp,
        sessionId,
        `(() => {
           const panel = document.querySelector('#kyara-plus-root').shadowRoot.querySelector('.kp-panel');
           const r = panel.getBoundingClientRect();
           return { x: r.x, y: r.y, width: r.width, height: r.height };
         })()`
      );
      const shot = await cdp.send(
        'Page.captureScreenshot',
        {
          format: 'png',
          clip: {
            x: Math.max(0, rect.x - 10),
            y: Math.max(0, rect.y - 10),
            width: Math.min(rect.width + 20, 1600),
            height: Math.min(rect.height + 20, 1000),
            scale: 1
          }
        },
        sessionId
      );
      writeFileSync(join(SHOTS, file), Buffer.from(shot.data, 'base64'));
      check(`Onglet ${tab} rendu`, rect.width > 300 && rect.height > 400, `${file}`);
    }

    console.log('\n— Vente auto (harness) —');
    await evaluate(
      cdp,
      sessionId,
      `(() => {
         window.__kyaraPlus.setOpen(true);
         window.__kyaraPlus.setTab('sell');
         const root = document.querySelector('#kyara-plus-root').shadowRoot;
         root.querySelector('[data-act="sell-mode"][data-mode="auto"]')?.click();
         return true;
       })()`
    );
    await sleep(350);
    const saleText = await evaluate(
      cdp,
      sessionId,
      `document.querySelector('#kyara-plus-root').shadowRoot.querySelector('#kp-view')?.innerText || ''`
    );
    check(
      'Panneau Vente auto présent',
      saleText.toLowerCase().includes('vente auto') &&
        saleText.includes('doublons uniquement') &&
        saleText.toLowerCase().includes('stratégie'),
      `V=${saleText.toLowerCase().includes('vente auto')} D=${saleText.includes('doublons uniquement')} S=${saleText
        .toLowerCase()
        .includes('stratégie')}`
    );
    const listedInfo = await evaluate(
      cdp,
      sessionId,
      `(() => {
         const mine = window.__kyaraPlus.state.mine;
         const listings = Array.isArray(mine?.listings) ? mine.listings : Array.isArray(mine) ? mine : [];
         return {
           count: document.querySelector('#kyara-plus-root').shadowRoot.querySelectorAll('.kp-listed-card').length,
           mine: listings.length,
           active: listings.filter((l) => !l.status || l.status === 'active').length
         };
       })()`
    );
    check(
      'Cartes en vente affichées avec images',
      listedInfo.count > 0,
      `${listedInfo.count} carte(s) · mine=${listedInfo.mine} · active=${listedInfo.active}`
    );
    check(
      'Ventes actives : trois annonces visibles au démarrage',
      listedInfo.active === 3 && listedInfo.count === 3 && listedInfo.mine === 3,
      `${listedInfo.count} carte(s) · mine=${listedInfo.mine} · active=${listedInfo.active}`
    );
    const listedText = await evaluate(
      cdp,
      sessionId,
      `document.querySelector('#kyara-plus-root').shadowRoot.querySelector('.kp-listed')?.innerText || ''`
    );
    check(
      'Ventes actives : nom, quantité, prix et état',
      listedText.toLowerCase().includes('ventes actives') &&
        listedText.includes('×1') &&
        listedText.includes('◆') &&
        /en vente|enchère active|confirmation/i.test(listedText),
      listedText.replace(/\s+/g, ' ').slice(0, 220)
    );
    const listedShot = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId);
    writeFileSync(join(SHOTS, 'chrome-vente-auto-top.png'), Buffer.from(listedShot.data, 'base64'));
    const strategyValues = await evaluate(
      cdp,
      sessionId,
      `Array.from(document.querySelector('#kyara-plus-root').shadowRoot.querySelectorAll('[data-autosell-strategy] option')).map((o) => o.value)`
    );
    check(
      'Vente auto : trois stratégies',
      ['quick', 'balanced', 'max'].every((value) => strategyValues.includes(value)),
      strategyValues.join(',')
    );
    const autoUi = await evaluate(
      cdp,
      sessionId,
      `(() => {
         const root = document.querySelector('#kyara-plus-root').shadowRoot;
         return {
           min: Boolean(root.querySelector('[data-autosell-min-price]')),
           interval: Boolean(root.querySelector('[data-autosell-interval]')),
           max: Boolean(root.querySelector('[data-autosell-max]')),
           estimate: root.querySelector('.kp-autosell-estimate')?.innerText || '',
           detach: Boolean(root.querySelector('.kp-duel-detach')),
           detachAct: root.querySelector('.kp-duel-detach')?.getAttribute('data-act') || '',
           sound: Boolean(root.querySelector('#kp-sound-btn') && root.querySelector('#kp-sound-range')),
           delay: window.__kyaraPlus.state.settings.autoSellDelayMinSec,
           delayMax: window.__kyaraPlus.state.settings.autoSellDelayMaxSec,
           refreshMin: window.__kyaraPlus.state.settings.autoSellRefreshMinMin,
           refreshMax: window.__kyaraPlus.state.settings.autoSellRefreshMaxMin,
           order: Array.from(root.querySelectorAll('[data-autosell-order] option')).map((o) => o.value),
           duration: Array.from(root.querySelectorAll('[data-autosell-duration] option')).map((o) => o.value),
           mythic: Boolean(root.querySelector('[data-autosell-include-m]')),
           mythicText: root.querySelector('[data-autosell-include-m]')?.closest('label')?.innerText || '',
           rarity: root.querySelector('.kp-listed-card')?.getAttribute('style') || ''
         };
       })()`
    );
    check('Prix minimum / intervalle / max cycle supprimés', !autoUi.min && !autoUi.interval && !autoUi.max);
    check(
      'Estimation des gains affichée',
      autoUi.estimate.toLowerCase().includes('gain estimé') && autoUi.estimate.includes('◆'),
      autoUi.estimate
    );
    check('Délai anti-flag 5–60 s', autoUi.delay === 5 && autoUi.delayMax === 60, `${autoUi.delay}–${autoUi.delayMax} s`);
    check('Refresh aléatoire 7–10 min', autoUi.refreshMin === 7 && autoUi.refreshMax === 10, `${autoUi.refreshMin}–${autoUi.refreshMax} min`);
    check('Ordre de vente réglable', autoUi.order.includes('price_desc') && autoUi.order.includes('price_asc'), autoUi.order.join(','));
    check('Durée annonce 12/24/48 h', ['12', '24', '48'].every((h) => autoUi.duration.includes(h)), autoUi.duration.join(','));
    check(
      'Option Mythiques uniquement',
      autoUi.mythic === true && /mythiques/i.test(autoUi.mythicText) && !/M\/L/.test(autoUi.mythicText),
      autoUi.mythicText.replace(/\s+/g, ' ')
    );
    check('Bordure de rareté sur les cartes en vente', autoUi.rarity.includes('--rc:'), autoUi.rarity);
    check('Bouton Détacher Global disponible', autoUi.detach === true && autoUi.detachAct === 'panel-detach');
    check('Son global disponible', autoUi.sound === true);
    const soundState = await evaluate(
      cdp,
      sessionId,
      `(() => {
         const root = document.querySelector('#kyara-plus-root').shadowRoot;
         root.querySelector('#kp-sound-btn')?.click();
         const muted = window.__kyaraPlus.state.sound.muted;
         root.querySelector('#kp-sound-btn')?.click();
         const range = root.querySelector('#kp-sound-range');
         range.value = '25';
         range.dispatchEvent(new Event('input', { bubbles: true }));
         return { muted, volume: window.__kyaraPlus.state.sound.volume };
       })()`
    );
    check('Son global mute + volume', soundState.muted === true && Math.abs(soundState.volume - 0.25) < 0.001, JSON.stringify(soundState));

    await evaluate(
      cdp,
      sessionId,
      `(() => {
         const root = document.querySelector('#kyara-plus-root').shadowRoot;
         root.querySelector('.kp-listed-card')?.click();
         return true;
       })()`
    );
    await waitFor(
      () =>
        evaluate(
          cdp,
          sessionId,
          `(document.querySelector('#kyara-plus-root').shadowRoot.querySelector('#kp-modal-card')?.innerText || '').toLowerCase().includes('prix médian 7 j')`
        ),
      { label: 'fiche marché depuis une annonce', timeout: 20000 }
    );
    const detailText = await evaluate(
      cdp,
      sessionId,
      `document.querySelector('#kyara-plus-root').shadowRoot.querySelector('#kp-modal-card')?.innerText || ''`
    );
    check(
      'Fiche marché sans prix recommandé',
      detailText.toLowerCase().includes('prix médian 7 j') &&
        !detailText.toLowerCase().includes('prix de vente recommandé')
    );
    await evaluate(
      cdp,
      sessionId,
      `(() => {
         document.querySelector('#kyara-plus-root').shadowRoot.querySelector('[data-act="sell-detail-close"]')?.click();
         return true;
       })()`
    );
    await sleep(200);

    await evaluate(
      cdp,
      sessionId,
      `(() => {
         const root = document.querySelector('#kyara-plus-root').shadowRoot;
         root.querySelector('[data-act="autosell-preview"]')?.click();
         return true;
       })()`
    );
    await waitFor(
      () => evaluate(cdp, sessionId, 'Boolean(window.__kyaraPlus.state.autoSell.preview)'),
      { label: 'aperçu vente auto', timeout: 20000 }
    );
    const preview = await evaluate(
      cdp,
      sessionId,
      `(() => {
         const a = window.__kyaraPlus.state.autoSell;
         return { plan: a.preview?.plan?.length ?? 0, status: a.status };
       })()`
    );
    check('Aperçu vente auto sans POST', preview.plan > 0, `${preview.plan} annonce(s) · ${preview.status}`);

    // Aucun prix connu : le tri ne peut pas être fait, le démarrage doit être refusé.
    await evaluate(
      cdp,
      sessionId,
      `(() => {
         const state = window.__kyaraPlus.state;
         window.__kyaraNoPrices = true;
         state.prices = {};
         state.fixedLow = {};
         state.fixedHigh = {};
         state.auctionBuyout = {};
         state.lowest = {};
         state.autoSell.priceScanAt = 0;
         window.__kyaraPlus.render();
         const root = document.querySelector('#kyara-plus-root').shadowRoot;
         root.querySelector('[data-act="autosell-start"]')?.click();
         root.querySelector('[data-act="autosell-start"]')?.click();
         return true;
       })()`
    );
    await waitFor(
      () =>
        evaluate(
          cdp,
          sessionId,
          `(() => {
             const a = window.__kyaraPlus.state.autoSell;
             return a.starting === false && Boolean(a.lastError);
           })()`
        ),
      { label: 'refus du démarrage sans prix', timeout: 20000 }
    );
    const blockedStart = await evaluate(
      cdp,
      sessionId,
      `(() => {
         const a = window.__kyaraPlus.state.autoSell;
         return { running: a.running, armed: a.armed, error: a.lastError || '' };
       })()`
    );
    check(
      'Vente auto : démarrage refusé si le tri est impossible',
      blockedStart.running === false && blockedStart.armed === false && /tri impossible/i.test(blockedStart.error),
      JSON.stringify(blockedStart)
    );
    // Les prix seront relus normalement au démarrage réel.
    await evaluate(
      cdp,
      sessionId,
      `(() => {
         window.__kyaraNoPrices = false;
         window.__kyaraPlus.state.autoSell.priceScanAt = 0;
         document.getElementById('log').textContent = '';
         return true;
       })()`
    );

    // Tests uniquement : délai nul pour ne pas attendre 5–60 s entre les ventes.
    await evaluate(
      cdp,
      sessionId,
      `(() => {
         window.__kyaraPlus.state.settings.autoSellDelayMinSec = 0;
         window.__kyaraPlus.state.settings.autoSellDelayMaxSec = 0;
         window.__kyaraPlus.state.settings.autoSellRefreshMinMin = 0;
         window.__kyaraPlus.state.settings.autoSellRefreshMaxMin = 0;
         return true;
       })()`
    );
    await evaluate(
      cdp,
      sessionId,
      `(() => {
         const root = document.querySelector('#kyara-plus-root').shadowRoot;
         root.querySelector('[data-act="autosell-start"]')?.click();
         return true;
       })()`
    );
    const armed = await evaluate(cdp, sessionId, 'window.__kyaraPlus.state.autoSell.armed');
    check('Vente auto : confirmation demandée', armed === true);
    await evaluate(
      cdp,
      sessionId,
      `(() => {
         const root = document.querySelector('#kyara-plus-root').shadowRoot;
         root.querySelector('[data-act="autosell-start"]')?.click();
         return true;
       })()`
    );
    await waitFor(
      () => evaluate(cdp, sessionId, 'window.__kyaraPlus.state.autoSell.cycles >= 1'),
      { label: 'premier cycle de vente auto', timeout: 20000 }
    );
    const auto = await evaluate(
      cdp,
      sessionId,
      `(() => {
         const a = window.__kyaraPlus.state.autoSell;
         const out = {
           running: a.running,
           created: a.created,
           cycles: a.cycles,
           log: a.log.length,
           characterId: a.lastPlan?.[0]?.characterId,
           plan: (a.lastPlan || []).map((row) => String(row.characterId)),
           active: window.__kyaraPlus.autoSellActiveEntries().length,
           slots: window.__kyaraPlus.listingSlots()
         };
         const root = document.querySelector('#kyara-plus-root').shadowRoot;
         root.querySelector('[data-act="autosell-stop"]')?.click();
         return out;
       })()`
    );
    check('Vente auto : annonces créées', auto.created > 0, `${auto.created} annonce(s) · ${auto.cycles} cycle(s)`);
    check('Vente auto : identifiant API présent', Number.isFinite(Number(auto.characterId)), String(auto.characterId));
    check(
      'Vente auto : la carte la plus chère passe en premier',
      Number(auto.characterId) === 999001,
      `première=${auto.characterId} · plan=${auto.plan.join(',')}`
    );
    check(
      'Vente auto : les légendaires en double sont incluses',
      auto.plan.includes('999001'),
      auto.plan.join(',')
    );
    check(
      'Vente auto : les mythiques restent exclues par défaut',
      !auto.plan.includes('127691'),
      auto.plan.join(',')
    );
    check(
      'Vente auto : aucune annonce active existante relancée',
      !auto.plan.some((id) => ['21122', '45628', '999002'].includes(id)),
      auto.plan.join(',')
    );
    check(
      'Vente auto : les nouvelles annonces comptent dans les 10 places',
      auto.active === 3 + auto.created && auto.slots.active === auto.active,
      `${auto.active} active(s) · ${auto.slots.active}/${auto.slots.max}`
    );
    const autoApiLog = await evaluate(cdp, sessionId, `document.getElementById('log').textContent || ''`);
    const autoRequests = (autoApiLog.match(/API (?:GET|POST)/g) || []).length;
    const autoMarketScans = (autoApiLog.match(/API GET \/api\/market\/listings\?characterId=/g) || []).length;
    const maxApi = await evaluate(cdp, sessionId, `Number(window.__apiMaxActive) || 0`);
    check(
      'Vente auto : pas de scan marché carte par carte',
      autoMarketScans === 0 && autoRequests < 30,
      `${autoRequests} requête(s) · ${autoMarketScans} scan(s) par carte`
    );
    check(
      'Requêtes API sérialisées une par une',
      maxApi <= 1,
      `${maxApi} requête(s) simultanée(s) au maximum`
    );
    const sales = await evaluate(
      cdp,
      sessionId,
      `(() => {
         const root = document.querySelector('#kyara-plus-root').shadowRoot;
         const text = root.querySelector('#kp-view')?.innerText || '';
         const chart = root.querySelector('.kp-sales');
         return {
           count: window.__kyaraPlus.state.salesLog.length,
           auto: window.__kyaraPlus.state.salesLog.filter((e) => e.source === 'auto').length,
           chart: text.toLowerCase().includes('ventes') && text.toLowerCase().includes('net estimé'),
           ranges: Array.from(chart?.querySelectorAll('[data-sales-range] option') || []).map((o) => o.value),
           lines: chart?.querySelectorAll('.kp-sales-line').length || 0,
           legend: chart?.querySelector('.kp-sales-legend')?.innerText || '',
           labels: chart?.querySelector('.kp-sales-svg')?.textContent || ''
         };
       })()`
    );
    check('Ventes auto enregistrées', sales.auto > 0, `${sales.auto} auto · ${sales.count} total`);
    check('Graphique de ventes affiché', sales.chart === true);
    check(
      'Graphique : choix 1 jour / 7 jours / total',
      ['1d', '7d', 'total'].every((value) => sales.ranges.includes(value)),
      sales.ranges.join(',')
    );
    check(
      'Graphique : une seule courbe « Vente »',
      sales.lines === 1 && sales.legend.includes('Vente') && !/Auto|Manuelle/.test(sales.legend),
      `${sales.lines} courbe(s) · ${sales.legend.replace(/\s+/g, ' ')}`
    );
    await evaluate(
      cdp,
      sessionId,
      `(() => {
         const select = document.querySelector('#kyara-plus-root').shadowRoot.querySelector('[data-sales-range]');
         select.value = '1d';
         select.dispatchEvent(new Event('change', { bubbles: true }));
         return true;
       })()`
    );
    await sleep(250);
    const chartDay = await evaluate(
      cdp,
      sessionId,
      `(() => {
         const root = document.querySelector('#kyara-plus-root').shadowRoot;
         return {
           range: window.__kyaraPlus.state.settings.salesRange,
           labels: root.querySelector('.kp-sales-svg')?.textContent || '',
           lines: root.querySelectorAll('.kp-sales-line').length
         };
       })()`
    );
    check(
      'Graphique : période 1 jour, axe en heures et valeurs chakra',
      chartDay.range === '1d' &&
        chartDay.lines === 1 &&
        /\d{2} h/.test(chartDay.labels) &&
        chartDay.labels.includes('◆ 50') &&
        chartDay.labels.includes('◆ 100'),
      `${chartDay.range} · ${chartDay.labels.replace(/\s+/g, ' ').slice(0, 120)}`
    );
    await evaluate(
      cdp,
      sessionId,
      `(() => {
         const view = document.querySelector('#kyara-plus-root').shadowRoot.querySelector('#kp-view');
         if (view) view.scrollTop = view.scrollHeight;
         return true;
       })()`
    );
    const autoShot = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId);
    writeFileSync(join(SHOTS, 'chrome-vente-auto.png'), Buffer.from(autoShot.data, 'base64'));
    await waitFor(
      () => evaluate(cdp, sessionId, 'window.__kyaraPlus.state.autoSell.running === false'),
      { label: 'arrêt de la vente auto', timeout: 5000 }
    );

    await evaluate(cdp, sessionId, `window.__kyaraPlus.setTab('market')`);
    await waitFor(
      () => evaluate(cdp, sessionId, 'window.__kyaraPlus.state.marketView.items !== null'),
      { label: 'marché global chargé', timeout: 20000 }
    );
    const marketText = await evaluate(
      cdp,
      sessionId,
      `document.querySelector('#kyara-plus-root').shadowRoot.querySelector('#kp-view')?.innerText || ''`
    );
    check(
      'Marché global intégré à l’onglet Marché',
      marketText.toLowerCase().includes('marché global') &&
        marketText.toLowerCase().includes('recherche serveur')
    );
    const marketShot = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId);
    writeFileSync(join(SHOTS, 'chrome-marche.png'), Buffer.from(marketShot.data, 'base64'));
    await evaluate(cdp, sessionId, `window.__kyaraPlus.setTab('sell')`);
    const sellTextAfter = await evaluate(
      cdp,
      sessionId,
      `document.querySelector('#kyara-plus-root').shadowRoot.querySelector('#kp-view')?.innerText || ''`
    );
    check('Vente : plus de sous-onglet Marché global', !sellTextAfter.includes('Marché global'));

    await cdp.send(
      'Emulation.setDeviceMetricsOverride',
      { width: 420, height: 800, deviceScaleFactor: 1, mobile: false },
      sessionId
    );
    await sleep(350);
    const narrow = await evaluate(
      cdp,
      sessionId,
      `(() => {
         const root = document.querySelector('#kyara-plus-root').shadowRoot;
         const panel = root.querySelector('.kp-panel');
         const view = root.querySelector('#kp-view');
         const r = panel.getBoundingClientRect();
         return {
           width: r.width,
           viewport: window.innerWidth,
           overflow: view ? view.scrollWidth > view.clientWidth + 2 : false
         };
       })()`
    );
    check(
      'Panneau étroit sans débordement',
      narrow.width <= narrow.viewport && !narrow.overflow,
      `largeur ${Math.round(narrow.width)} / ${narrow.viewport}`
    );
    await cdp.send(
      'Emulation.setDeviceMetricsOverride',
      { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false },
      sessionId
    );

    check('Aucune exception JS pendant le rendu', cdp.exceptions.length === 0, cdp.exceptions.join(' | '));
  } finally {
    cdp?.ws.close();
    await closeChrome(proc);
  }
}

async function extensionPass() {
  console.log('\n— Extension Chrome réelle —');
  const ext = makeTestPackage();
  const { proc } = launchChrome({ name: 'ext', port: 9335 });
  let cdp = null;
  try {
    cdp = await connect(9335);

    /*
     * Chrome 137+ ignore `--load-extension` dans les builds de marque ; la voie
     * officielle pour charger une extension non empaquetée depuis un script est
     * la commande CDP `Extensions.loadUnpacked` (utilisée par Puppeteer).
     */
    const loaded = await cdp.send('Extensions.loadUnpacked', { path: ext });
    const id = loaded?.id;
    check('Extension chargée (Extensions.loadUnpacked)', Boolean(id), id);

    const sw = await waitFor(
      async () => {
        const { targetInfos } = await cdp.send('Target.getTargets');
        return targetInfos.find(
          (t) => t.type === 'service_worker' && t.url === `chrome-extension://${id}/background/background.js`
        );
      },
      { label: 'service worker de l’extension' }
    );

    const swSession = await attach(cdp, sw.targetId, { page: false });
    const info = await evaluate(
      cdp,
      swSession,
      `JSON.stringify({
         version: chrome.runtime.getManifest().version,
         worker: typeof self !== 'undefined' && self === globalThis
       })`
    );
    const manifest = JSON.parse(info);
    const expected = JSON.parse(readFileSync(join(ROOT, 'dist', 'chrome', 'manifest.json'), 'utf8')).version;
    check('Version du manifeste chargée', manifest.version === expected, `v${manifest.version} / attendu v${expected}`);
    check('Service worker MV3 actif', manifest.worker === true);

    /* Content script : deux panneaux attendus (harness de page + content script). */
    const { sessionId } = await openTab(cdp, HARNESS);
    const roots = await waitFor(
      () => evaluate(cdp, sessionId, `document.querySelectorAll('#kyara-plus-root').length`),
      { label: 'injection du content script' }
    );
    check('Content script injecté', roots >= 2, `${roots} panneau(x)`);

    const injected = await waitFor(
      async () => {
        const list = await evaluate(
          cdp,
          sessionId,
          `(() => {
             return [...document.querySelectorAll('#kyara-plus-root')].map((root) => {
               const tabs = root.shadowRoot?.querySelectorAll('#kp-tabs button').length ?? 0;
               const view = root.shadowRoot?.querySelector('#kp-view');
               return { tabs, view: view ? view.innerText.length : 0, shadow: Boolean(root.shadowRoot) };
             });
           })()`
        );
        return list.some((r) => r.tabs >= 8) ? list : false;
      },
      { label: 'onglets du panneau injecté' }
    );
    check('Panneau injecté avec ses onglets', true, JSON.stringify(injected));

    /* Popup */
    const { targetId: popupTarget } = await cdp.send('Target.createTarget', {
      url: `chrome-extension://${id}/popup/popup.html`
    });
    const popupSession = await attach(cdp, popupTarget);
    await sleep(800);
    const popup = await evaluate(
      cdp,
      popupSession,
      `JSON.stringify({
         version: document.getElementById('version')?.textContent,
         status: document.getElementById('status')?.textContent
       })`
    );
    const popupState = JSON.parse(popup);
    check('Popup ouverte avec la version', String(popupState.version ?? '').includes(expected), popup);

    const { targetId: panelTarget } = await cdp.send('Target.createTarget', {
      url: `chrome-extension://${id}/panel/panel.html#kyareeh-panel`
    });
    const panelSession = await attach(cdp, panelTarget);
    const panelMounted = await waitFor(
      () =>
        evaluate(
          cdp,
          panelSession,
          `(() => {
             const root = document.querySelector('#kyara-plus-root');
             const shadow = root?.shadowRoot;
             return Boolean(shadow?.querySelector('.kp-panel') && shadow.querySelectorAll('#kp-tabs button').length >= 8);
           })()`
        ),
      { label: 'fenêtre Global autonome', timeout: 15000 }
    );
    check('Fenêtre Global autonome montée', panelMounted === true);

    const reply = await evaluate(
      cdp,
      popupSession,
      `new Promise((resolve) => {
         const timer = setTimeout(() => resolve('timeout'), 3000);
         chrome.runtime.sendMessage({ type: 'kp-manifest-version' }, (res) => {
           clearTimeout(timer);
           resolve(JSON.stringify(res ?? null));
         });
       })`
    );
    check('Message au script de fond', reply !== 'timeout' && JSON.parse(reply)?.ok === true, reply);
  } finally {
    cdp?.ws.close();
    await closeChrome(proc);
  }
}

/* --- main ------------------------------------------------------------ */

try {
  console.log('Construction du paquet Chrome…');
  const build = spawnSync(process.execPath, [join(ROOT, 'scripts', 'build-chrome.mjs')], {
    cwd: ROOT,
    encoding: 'utf8'
  });
  if (build.status !== 0) {
    console.error(build.stdout, build.stderr);
    throw new Error('build-chrome.mjs a échoué');
  }
  if (!existsSync(CHROME)) throw new Error(`Chrome introuvable : ${CHROME}`);

  await startServer();
  await visualPass();
  await extensionPass();
} catch (err) {
  failures += 1;
  console.error(`\n✗ Erreur : ${err.message}`);
} finally {
  stopServer();
}

console.log(`\n${failures === 0 ? '✓' : '✗'} ${results.filter((r) => r.ok).length}/${results.length} contrôles — ${failures} échec(s)`);
process.exit(failures === 0 ? 0 : 1);
