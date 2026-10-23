#!/usr/bin/env node
/*
 * Kyareeh+ — test de fumée du paquet Chrome.
 *
 * Ce que le script vérifie, dans un vrai Chrome (headless) :
 *   1. l'extension se charge sans erreur de manifeste (service worker présent) ;
 *   2. le service worker répond aux messages (version du manifeste) ;
 *   3. le content script s'injecte et monte le panneau dans un Shadow DOM ;
 *   4. la popup s'ouvre et affiche la version ;
 *   5. le panneau (mode harness, sans compte) rend chaque onglet sans exception JS ;
 *   6. « Détacher » : le panneau complet s'ouvre dans sa propre fenêtre (panel/panel.html),
 *      une seule instance, les données passent par le relais vers l'onglet du site, +Duel y
 *      charge l'application du duel, fermer le panneau de la page ne vide pas la fenêtre,
 *      « Rattacher » (depuis la fenêtre, depuis la page, ou fermeture manuelle) rend la main.
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
  // Le relais de la fenêtre détachée cherche un onglet kyara.games : dans la copie de test,
  // c'est l'onglet du serveur local (le paquet publié, lui, n'est pas modifié).
  manifest.host_permissions = [...new Set([...(manifest.host_permissions ?? []), local])];
  const bgPath = join(dir, 'background', 'background.js');
  const bg = readFileSync(bgPath, 'utf8');
  const patched = bg.replace("const KYARA_TABS = 'https://kyara.games/*';", `const KYARA_TABS = '${local}';`);
  if (patched === bg) throw new Error('background.js : KYARA_TABS introuvable (copie de test)');
  writeFileSync(bgPath, patched, 'utf8');
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
    const branding = await evaluate(
      cdp,
      sessionId,
      `(() => {
         const root = document.querySelector('#kyara-plus-root').shadowRoot;
         const logo = root.querySelector('.kp-logo img');
         const fab = root.querySelector('.kp-fab-logo');
         return {
           logo: Boolean(logo && logo.complete && logo.naturalWidth > 0),
           fab: Boolean(fab && fab.complete && fab.naturalWidth > 0),
           src: logo?.getAttribute('src') || ''
         };
       })()`
    );
    check(
      'Logo Kyareeh+ affiché dans l’en-tête et le bouton flottant',
      branding.logo && branding.fab,
      JSON.stringify(branding)
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
           detach: Boolean(root.querySelector('.kp-detach')),
           detachAct: root.querySelector('.kp-detach')?.getAttribute('data-act') || '',
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
    check('Ordre de vente réglable', autoUi.order.includes('score') && autoUi.order.includes('price_desc') && autoUi.order.includes('price_asc'), autoUi.order.join(','));
    check('Durée annonce 12/24/48 h', ['12', '24', '48'].every((h) => autoUi.duration.includes(h)), autoUi.duration.join(','));
    check(
      'Option Mythiques uniquement',
      autoUi.mythic === true && /mythiques/i.test(autoUi.mythicText) && !/M\/L/.test(autoUi.mythicText),
      autoUi.mythicText.replace(/\s+/g, ' ')
    );
    check('Bordure de rareté sur les cartes en vente', autoUi.rarity.includes('--rc:'), autoUi.rarity);
    check('Bouton Détacher Global disponible', autoUi.detach === true && autoUi.detachAct === 'panel-detach');
    check('Son global disponible', autoUi.sound === true);

    // Classement optimisé : la carte choisie doit être la plus liquide, pas la plus chère.
    await waitFor(
      () => evaluate(cdp, sessionId, `window.__kyaraPlus.autoSellRankedCandidates().length > 0`),
      { label: 'classement optimisé disponible', timeout: 15000 }
    );
    const optimized = await evaluate(
      cdp,
      sessionId,
      `(() => {
         const s = window.__kyaraPlus.state;
         s.settings.autoSellOrder = 'score';
         window.__kyaraPlus.render();
         const root = document.querySelector('#kyara-plus-root').shadowRoot;
         const pick = root.querySelector('.kp-autosell-pick');
         const ranked = window.__kyaraPlus.autoSellRankedCandidates();
         const first = ranked[0] || null;
         const dearest = ranked.reduce((best, row) => (Number(row.price) > Number(best?.price || 0) ? row : best), null);
         return {
           order: s.settings.autoSellOrder,
           hint: root.querySelector('.kp-autosell-hint')?.innerText || '',
           pick: pick?.innerText || '',
           count: ranked.length,
           first: first
             ? { id: String(first.id), price: Number(first.price), volume: first.volume7, status: first.volume7Status, score: first.rank?.score }
             : null,
           dearest: dearest ? { id: String(dearest.id), price: Number(dearest.price) } : null
         };
       })()`
    );
    check(
      'Vente auto : tri « Optimisé : prix + ventes sur 7 j » actif par défaut',
      optimized.order === 'score' && /ventes sur 7 j/i.test(optimized.hint),
      `${optimized.order} · ${optimized.hint.replace(/\s+/g, ' ').slice(0, 120)}`
    );
    check(
      'Vente auto : prochaine carte expliquée (prix, ventes 7 j, score)',
      /vente\(s\)\/7 j/i.test(optimized.pick) &&
        /score/i.test(optimized.pick) &&
        optimized.pick.includes('◆') &&
        /prochaine carte/i.test(optimized.pick),
      optimized.pick.replace(/\s+/g, ' ').slice(0, 240)
    );
    check(
      'Vente auto : l’ordre optimisé ne prend pas la carte la plus chère',
      Boolean(optimized.first) &&
        optimized.first.id !== optimized.dearest?.id &&
        Number(optimized.first.volume) > 0 &&
        optimized.first.score > 0,
      `premier=${optimized.first?.id} vol=${optimized.first?.volume} score=${optimized.first?.score} · plus chère=${optimized.dearest?.id}`
    );
    const priceOrder = await evaluate(
      cdp,
      sessionId,
      `(() => {
         const s = window.__kyaraPlus.state;
         s.settings.autoSellOrder = 'price_desc';
         const ranked = window.__kyaraPlus.autoSellRankedCandidates();
         const first = ranked[0] || null;
         s.settings.autoSellOrder = 'score';
         window.__kyaraPlus.render();
         return { first: first ? { id: String(first.id), price: Number(first.price) } : null };
       })()`
    );
    check(
      'Vente auto : tri par prix toujours disponible',
      priceOrder.first?.id === '999001',
      `premier=${priceOrder.first?.id} · ◆ ${priceOrder.first?.price}`
    );
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
         window.__kyaraNoListingId = true;
         window.__kyaraPriceTooLowOnce = true;
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
         window.__kyaraPlus.state.settings.autoSellStrategy = 'quick';
         window.__kyaraPlus.render();
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
           rankCount: a.rankCount,
           pickScore: a.lastPick?.rank?.score ?? null,
           pickVolume: a.lastPick?.volume7 ?? null,
           log: a.log.length,
           logText: a.log.map((entry) => entry.text).join(' | '),
           characterId: a.lastPlan?.[0]?.characterId,
           firstVolume: a.lastPlan?.[0]?.volume7 ?? null,
           firstScore: a.lastPlan?.[0]?.rank?.score ?? null,
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
      'Vente auto : la carte la plus liquide passe en premier',
      String(auto.characterId) !== '999001' && Number(auto.firstVolume) > 12 && Number(auto.firstScore) > 0,
      `première=${auto.characterId} · volume=${auto.firstVolume} · score=${auto.firstScore} · plan=${auto.plan.join(',')}`
    );
    check(
      'Vente auto : classement recalculé avant chaque vente',
      auto.rankCount >= auto.created && auto.created > 1,
      `${auto.rankCount} classement(s) pour ${auto.created} annonce(s)`
    );
    check(
      'Vente auto : la carte choisie porte son score et son volume 7 j',
      Number.isFinite(Number(auto.pickScore)) && Number.isFinite(Number(auto.pickVolume)),
      `score=${auto.pickScore} · volume=${auto.pickVolume}`
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
      'Vente auto : prix trop bas corrigé automatiquement',
      /refusé \(trop bas\)/.test(auto.logText) && /✓/.test(auto.logText),
      auto.logText.replace(/\s+/g, ' ').slice(-180)
    );
    check(
      'Vente auto : les nouvelles annonces comptent dans les 10 places',
      auto.active === 3 + auto.created && auto.slots.active === auto.active,
      `${auto.active} active(s) · ${auto.slots.active}/${auto.slots.max}`
    );

    // Démarrage volontaire à 10/10 : la boucle doit surveiller une vente.
    await evaluate(
      cdp,
      sessionId,
      `(() => {
         document.querySelector('#kyara-plus-root').shadowRoot.querySelector('[data-act="autosell-start"]')?.click();
         return true;
       })()`
    );
    await waitFor(
      () => evaluate(cdp, sessionId, `window.__kyaraPlus.state.autoSell.armed === true`),
      { label: 'armement à 10/10', timeout: 5000 }
    );
    await evaluate(
      cdp,
      sessionId,
      `(() => {
         document.querySelector('#kyara-plus-root').shadowRoot.querySelector('[data-act="autosell-start"]')?.click();
         return true;
       })()`
    );
    await waitFor(
      () => evaluate(cdp, sessionId, `window.__kyaraPlus.state.autoSell.running === true`),
      { label: 'démarrage à 10/10', timeout: 15000 }
    );
    await waitFor(
      () => evaluate(cdp, sessionId, `/File pleine/.test(window.__kyaraPlus.state.autoSell.status || '')`),
      { label: 'surveillance 10/10', timeout: 15000 }
    );
    const fullStart = await evaluate(
      cdp,
      sessionId,
      `(() => ({
         running: window.__kyaraPlus.state.autoSell.running,
         status: window.__kyaraPlus.state.autoSell.status || '',
         slots: window.__kyaraPlus.listingSlots()
       }))()`
    );
    check(
      'Vente auto : démarre même à 10/10 et surveille une vente',
      fullStart.running && fullStart.slots.remaining === 0 && /File pleine/.test(fullStart.status),
      `${fullStart.slots.active}/${fullStart.slots.max} · ${fullStart.status}`
    );
    await evaluate(
      cdp,
      sessionId,
      `(() => {
         document.querySelector('#kyara-plus-root').shadowRoot.querySelector('[data-act="autosell-stop"]')?.click();
         return true;
       })()`
    );
    await waitFor(
      () => evaluate(cdp, sessionId, `window.__kyaraPlus.state.autoSell.running === false`),
      { label: 'arrêt après test 10/10', timeout: 5000 }
    );
    const autoApiLog = await evaluate(cdp, sessionId, `document.getElementById('log').textContent || ''`);
    const autoRequests = (autoApiLog.match(/API (?:GET|POST)/g) || []).length;
    const autoMarketScans = (autoApiLog.match(/API GET \/api\/market\/listings\?characterId=/g) || []).length;
    const maxApi = await evaluate(cdp, sessionId, `Number(window.__apiMaxActive) || 0`);
    check(
      'Vente auto : scan ciblé ou cache, jamais l’inventaire complet',
      autoMarketScans <= 6 && autoRequests < 35,
      `${autoRequests} requête(s) · ${autoMarketScans} scan(s) ciblé(s)`
    );
    check(
      'Requêtes API sérialisées une par une',
      maxApi <= 1,
      `${maxApi} requête(s) simultanée(s) au maximum`
    );

    // Retrait explicite d'une vente active depuis sa fiche.
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
          `Boolean(document.querySelector('#kyara-plus-root').shadowRoot.querySelector('[data-act="listing-cancel"]'))`
        ),
      { label: 'bouton Retirer la vente', timeout: 20000 }
    );
    await evaluate(
      cdp,
      sessionId,
      `(() => {
         document.querySelector('#kyara-plus-root').shadowRoot.querySelector('[data-act="listing-cancel"]')?.click();
         return true;
       })()`
    );
    await waitFor(
      () =>
        evaluate(
          cdp,
          sessionId,
          `(document.querySelector('#kyara-plus-root').shadowRoot.querySelector('[data-act="listing-cancel"]')?.textContent || '').includes('Confirmer')`
        ),
      { label: 'confirmation du retrait', timeout: 10000 }
    );
    await evaluate(
      cdp,
      sessionId,
      `(() => {
         document.querySelector('#kyara-plus-root').shadowRoot.querySelector('[data-act="listing-cancel"]')?.click();
         return true;
       })()`
    );
    await waitFor(
      () =>
        evaluate(
          cdp,
          sessionId,
          `window.__kyaraPlus.autoSellActiveEntries().length < ${auto.active}`
        ),
      { label: 'retrait de la vente active', timeout: 20000 }
    );
    const removed = await evaluate(
      cdp,
      sessionId,
      `(() => ({
         active: window.__kyaraPlus.autoSellActiveEntries().length,
         modalClosed: document.querySelector('#kyara-plus-root').shadowRoot.querySelector('#kp-modal')?.hidden === true
       }))()`
    );
    check(
      'Vente active : retrait depuis la fiche',
      removed.active < auto.active,
      `${removed.active}/${auto.active} active(s) · modale fermée=${removed.modalClosed}`
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
           chart: text.toLowerCase().includes('profit réalisé') && text.toLowerCase().includes('ventes confirmées'),
           ranges: Array.from(chart?.querySelectorAll('[data-sales-range] option') || []).map((o) => o.value),
           lines: chart?.querySelectorAll('.kp-sales-line').length || 0,
           legend: chart?.querySelector('.kp-sales-legend')?.innerText || '',
           profit: chart?.querySelector('.kp-sales-kpis b')?.innerText || '',
           labels: chart?.querySelector('.kp-sales-svg')?.textContent || ''
         };
       })()`
    );
    // Une simple mise en vente ne doit créer aucune vente : le graphique reste à zéro.
    check(
      'Mise en vente sans vente confirmée : aucun point',
      sales.count === 0 && sales.auto === 0 && /◆ 0/.test(sales.profit),
      `${sales.auto} auto · ${sales.count} total · profit ${sales.profit}`
    );
    check('Graphique du profit réalisé affiché', sales.chart === true);
    check(
      'Graphique : choix 1 jour / 7 jours / total',
      ['1d', '7d', 'total'].every((value) => sales.ranges.includes(value)),
      sales.ranges.join(',')
    );
    check(
      'Graphique : une seule courbe « Profit réalisé »',
      sales.lines === 1 && sales.legend.includes('Profit réalisé') && !/Auto|Manuelle/.test(sales.legend),
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
    const hover = await evaluate(
      cdp,
      sessionId,
      `(() => {
         const root = document.querySelector('#kyara-plus-root').shadowRoot;
         const svg = root.querySelector('.kp-sales-svg');
         const rect = svg.getBoundingClientRect();
         svg.dispatchEvent(new PointerEvent('pointermove', {
           bubbles: true,
           clientX: rect.left + rect.width * 0.62,
           clientY: rect.top + rect.height * 0.5,
           pointerId: 1
         }));
         const tip = root.querySelector('.kp-sales-tip');
         const group = root.querySelector('.kp-sales-hover');
         return { text: tip?.textContent || '', visible: group?.style.display !== 'none' };
       })()`
    );
    check(
      'Graphique : valeur de la tranche horaire au survol, sans décimale',
      hover.visible && /◆/.test(hover.text) && /\d{2} h/.test(hover.text) && !hover.text.includes(','),
      hover.text
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

/* --- Détacher : le panneau complet dans sa propre fenêtre -------------- */

/** Fenêtres/onglets qui affichent panel/panel.html. */
async function panelPages(cdp, id) {
  const { targetInfos } = await cdp.send('Target.getTargets');
  return targetInfos.filter((t) => t.type === 'page' && t.url.startsWith(`chrome-extension://${id}/panel/panel.html`));
}

const ROOT_JS = `document.querySelector('#kyara-plus-root').shadowRoot`;

async function detachPass(cdp, id) {
  console.log('\n— Détacher : panneau complet dans sa fenêtre —');

  /* Onglet « site » : une page servie par le serveur local, sans le harness (un seul panneau :
   * celui du content script). Les requêtes /api/ du content script sont simulées par CDP. */
  const API = {
    '/api/me/bootstrap': { me: { id: 4242, pseudo: 'Testeur', chakra: 777, freePacks: 0 } },
    '/api/me': { id: 4242, pseudo: 'Testeur', chakra: 777, freePacks: 0 },
    '/api/me/collection': [],
    '/api/characters': [],
    '/api/config': {}
  };
  const apiHits = [];
  const { targetId: siteTarget } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const site = await attach(cdp, siteTarget);
  await cdp.send('Fetch.enable', { patterns: [{ urlPattern: 'http://127.0.0.1:8787/api/*' }] }, site);
  const onPaused = (msg) => {
    if (msg.method !== 'Fetch.requestPaused' || msg.sessionId !== site) return;
    const { requestId, request } = msg.params;
    const path = new URL(request.url).pathname;
    apiHits.push(path);
    const body = API[path];
    cdp
      .send(
        'Fetch.fulfillRequest',
        {
          requestId,
          responseCode: body === undefined ? 404 : 200,
          responseHeaders: [{ name: 'content-type', value: 'application/json' }],
          body: Buffer.from(JSON.stringify(body === undefined ? { error: 'not_found' } : body)).toString('base64')
        },
        site
      )
      .catch(() => {});
  };
  cdp.listeners.add(onPaused);
  await cdp.send('Page.navigate', { url: 'http://127.0.0.1:8787/duel/fx-demo.html' }, site);
  await waitFor(() => evaluate(cdp, site, `Boolean(${ROOT_JS}?.querySelector('.kp-panel'))`), {
    label: 'panneau du content script (page du site)'
  });
  const siteJs = (expr) => evaluate(cdp, site, expr);
  // Le panneau peut déjà être ouvert (état partagé kyareeh.ui.v1) : on ne bascule que s'il est fermé.
  const openSitePanel = () =>
    siteJs(`(() => { const r = ${ROOT_JS}; if (r.querySelector('.kp-panel').hidden) r.querySelector('.kp-fab').click(); return true; })()`);
  await openSitePanel();

  const before = await siteJs(
    `(() => { const r = ${ROOT_JS}; return { open: !r.querySelector('.kp-panel').hidden, detach: r.querySelectorAll('[data-act="panel-detach"]').length }; })()`
  );
  check('Page : un seul bouton « Détacher » dans l’en-tête', before.open && before.detach === 1, JSON.stringify(before));

  const winTargetOf = async () => (await panelPages(cdp, id))[0];
  const detach = async () => {
    await siteJs(`${ROOT_JS}.querySelector('[data-act="panel-detach"]').click(); true`);
    return waitFor(winTargetOf, { label: 'fenêtre détachée', timeout: 15000 });
  };
  const siteAway = (away) =>
    waitFor(
      async () => {
        const st = await siteJs(
          `(() => { const r = ${ROOT_JS}; const a = r.querySelector('#kp-away'); return { away: !a.hidden, text: a.innerText, modes: r.querySelector('#kp-modes').hidden, view: r.querySelector('#kp-view').hidden, detach: r.querySelectorAll('[data-act="panel-detach"]').length }; })()`
        );
        return st.away === away ? st : false;
      },
      { label: away ? 'page : carte « ouvert dans une fenêtre »' : 'page : panneau repris', timeout: 12000 }
    );

  /* 1. Détacher */
  const win = await detach();
  const winSession = await attach(cdp, win.targetId);
  const winJs = (expr) => evaluate(cdp, winSession, expr);
  const hostWin = await cdp.send('Browser.getWindowForTarget', { targetId: win.targetId });
  const siteWin = await cdp.send('Browser.getWindowForTarget', { targetId: siteTarget });
  check('Détacher ouvre panel/panel.html dans une fenêtre à part', hostWin.windowId !== siteWin.windowId, win.url);

  await waitFor(
    () =>
      winJs(
        `(() => { const r = ${ROOT_JS}; return Boolean(r?.querySelector('.kp-panel') && r.querySelectorAll('#kp-tabs button').length >= 8 && /777/.test(r.querySelector('#kp-stats')?.innerText || '')); })()`
      ),
    { label: 'fenêtre : panneau monté avec les données du compte', timeout: 25000 }
  );
  check('Fenêtre : les données du compte passent par le relais', apiHits.includes('/api/me/bootstrap'), apiHits.slice(0, 4).join(' '));

  const layout = await winJs(
    `(() => { const r = ${ROOT_JS}; const p = r.querySelector('.kp-panel'); const b = p.getBoundingClientRect();
       return { hidden: p.hidden, x: Math.round(b.left), y: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height), vw: innerWidth, vh: innerHeight,
                fab: getComputedStyle(r.querySelector('.kp-fab')).display,
                zoom: Number.parseFloat(p.style.zoom) || 1,
                acts: [...r.querySelectorAll('#kp-modes [data-act]')].map((b) => b.dataset.act).join(',') }; })()`
  );
  check(
    'Fenêtre : le panneau remplit toute la fenêtre, sans bouton flottant',
    !layout.hidden && layout.x === 0 && layout.y === 0 && Math.abs(layout.w - layout.vw) <= 1 && Math.abs(layout.h - layout.vh) <= 1 && layout.fab === 'none',
    JSON.stringify(layout)
  );
  check('Fenêtre : « Rattacher » remplace « Détacher »', layout.acts === 'mode,mode,panel-attach', layout.acts);
  check(
    'Fenêtre : polices agrandies proportionnellement',
    layout.zoom > 1,
    `zoom=${layout.zoom}`
  );

  const away = await siteAway(true);
  check(
    'Page : carte « Kyareeh+ est ouvert dans une fenêtre » (Afficher / Rattacher)',
    /ouvert dans une fenêtre/.test(away.text) && /Afficher/.test(away.text) && /Rattacher/.test(away.text) && away.modes && away.view,
    away.text.replace(/\s+/g, ' ').slice(0, 90)
  );

  /* 2. Une seule fenêtre : double envoi + « Afficher » */
  const twice = JSON.parse(
    await winJs(
      `Promise.all([1, 2].map(() => chrome.runtime.sendMessage({ type: 'kp-panel-detach' }))).then((r) => JSON.stringify(r))`
    )
  );
  await siteJs(`${ROOT_JS}.querySelector('[data-act="panel-focus"]').click(); true`);
  await sleep(700);
  const count = (await panelPages(cdp, id)).length;
  check(
    'Une seule instance : Détacher/Afficher remet la fenêtre au premier plan',
    count === 1 && twice.every((r) => r.ok && r.reused),
    `${count} fenêtre(s), ${JSON.stringify(twice)}`
  );

  /* 3. La panne d'origine : fermer le panneau de la page vidait la fenêtre (clé kyareeh.ui.v1) */
  await siteJs(`${ROOT_JS}.querySelector('[data-act="close"]').click(); true`);
  await sleep(1200);
  const stillOpen = await winJs(
    `!${ROOT_JS}.querySelector('.kp-panel').hidden && ${ROOT_JS}.querySelector('.kp-panel').getBoundingClientRect().width > 300`
  );
  check('Fermer le panneau de la page ne vide pas la fenêtre', stillOpen === true);
  await openSitePanel();

  /* 4. +Duel dans la fenêtre */
  await winJs(`${ROOT_JS}.querySelector('[data-act="mode"][data-mode="duel"]').click(); true`);
  const duel = await waitFor(
    async () => {
      const st = await winJs(
        `(() => { const f = ${ROOT_JS}.querySelector('.kp-duel-frame'); if (!f) return false; const d = f.contentDocument;
           if (!d) return { src: f.src, tabs: 0, main: '' };
           return { src: f.src, tabs: d.querySelectorAll('.kd-tab').length, main: d.getElementById('kd-main')?.innerText || '',
                    api: Boolean(f.contentWindow.__kyaraDuel) }; })()`
      );
      return st && st.tabs >= 4 && st.api ? st : false;
    },
    { label: '+Duel dans la fenêtre', timeout: 20000 }
  );
  check(
    '+Duel : l’application du duel se charge dans la fenêtre',
    duel.src.startsWith(`chrome-extension://${id}/duel/duel.html`) && !/Chargement du duel/.test(duel.main),
    `${duel.tabs} onglets · ${duel.src}`
  );
  const profile = await waitFor(
    async () => {
      const who = await winJs(`${ROOT_JS}.querySelector('.kp-duel-frame').contentDocument.querySelector('.kd-who')?.innerText || ''`);
      return /Testeur/.test(who) ? who : false;
    },
    { label: 'profil du duel (storage.local)', timeout: 15000 }
  ).catch(() => '');
  check('+Duel : le profil du joueur est lu depuis le stockage', /Testeur/.test(profile), profile);
  await sleep(6500); // plus que le délai « le duel n’a pas répondu »
  const duelOk = await winJs(
    `(() => { const f = ${ROOT_JS}.querySelector('.kp-duel-frame'); return { failed: Boolean(${ROOT_JS}.querySelector('.kp-duel-failed')), extra: /Détacher|Rattacher/.test(f.contentDocument.body.innerText) }; })()`
  );
  check('+Duel : prêt (pas d’avertissement) et sans second « Détacher »', !duelOk.failed && !duelOk.extra, JSON.stringify(duelOk));

  /* 5. Rattacher depuis la fenêtre */
  await winJs(`${ROOT_JS}.querySelector('[data-act="panel-attach"]').click(); true`).catch(() => {});
  await waitFor(async () => (await panelPages(cdp, id)).length === 0, { label: 'fermeture de la fenêtre (Rattacher)', timeout: 12000 });
  const back = await siteAway(false);
  check('Rattacher (depuis la fenêtre) : la fenêtre se ferme, la page reprend le panneau', !back.modes && !back.view && back.detach === 1);

  /* 6. Rattacher depuis la page */
  await detach();
  await siteAway(true);
  await siteJs(`${ROOT_JS}.querySelector('[data-act="panel-attach"]').click(); true`);
  await waitFor(async () => (await panelPages(cdp, id)).length === 0, { label: 'fermeture de la fenêtre (Rattacher, page)', timeout: 12000 });
  await siteAway(false);
  check('Rattacher (depuis la page) : la fenêtre se ferme', true);

  /* 7. Fermeture manuelle de la fenêtre */
  const manual = await detach();
  await siteAway(true);
  await cdp.send('Target.closeTarget', { targetId: manual.targetId });
  await siteAway(false);
  check('Fermeture manuelle de la fenêtre : la page reprend le panneau', (await panelPages(cdp, id)).length === 0);

  /* 8. Fenêtre sans onglet du site : message clair en français */
  const last = await detach();
  const lastSession = await attach(cdp, last.targetId);
  await waitFor(() => evaluate(cdp, lastSession, `Boolean(${ROOT_JS}?.querySelector('#kp-tabs button'))`), {
    label: 'fenêtre (sans site)',
    timeout: 15000
  });
  // Tous les onglets « site » (le harness des étapes précédentes aussi) sont fermés.
  const { targetInfos } = await cdp.send('Target.getTargets');
  for (const t of targetInfos.filter((x) => x.type === 'page' && x.url.startsWith('http://127.0.0.1:8787/'))) {
    await cdp.send('Target.closeTarget', { targetId: t.targetId });
  }
  await sleep(500);
  await evaluate(cdp, lastSession, `${ROOT_JS}.querySelector('[data-act="refresh"]').click(); true`);
  const noTab = await waitFor(
    async () => {
      const text = await evaluate(cdp, lastSession, `${ROOT_JS}.querySelector('#kp-banner').innerText`);
      return /Aucun onglet kyara\.games/.test(text) ? text : false;
    },
    { label: 'message « aucun onglet kyara.games »', timeout: 15000 }
  ).catch(async () =>
    `introuvable — bannière « ${await evaluate(cdp, lastSession, `${ROOT_JS}.querySelector('#kp-banner').innerText`)} », pied « ${await evaluate(cdp, lastSession, `${ROOT_JS}.querySelector('#kp-foot').innerText`)} »`
  );
  check('Sans onglet kyara.games : message clair dans la fenêtre', /Aucun onglet kyara\.games ouvert/.test(noTab), noTab.replace(/\s+/g, ' ').slice(0, 110));
  await cdp.send('Target.closeTarget', { targetId: last.targetId });
  await waitFor(async () => (await panelPages(cdp, id)).length === 0, { label: 'nettoyage', timeout: 8000 });
  cdp.listeners.delete(onPaused);
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
      async () => {
        const count = await evaluate(cdp, sessionId, `document.querySelectorAll('#kyara-plus-root').length`);
        return count >= 2 ? count : false;
      },
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
    check('Page panel.html montée hors du site (onglet)', panelMounted === true);
    await cdp.send('Target.closeTarget', { targetId: panelTarget });

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

    await detachPass(cdp, id);
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
