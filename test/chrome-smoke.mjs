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
      ['recycle', 'chrome-recyclage.png'],
      ['completion', 'chrome-completion.png'],
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

    console.log('\n— Recyclage ciblé (harness) —');
    await evaluate(
      cdp,
      sessionId,
      `(() => { window.__kyaraPlus.setOpen(true); window.__kyaraPlus.setTab('recycle'); return true; })()`
    );
    await sleep(450);
    // Le recyclage détruit des exemplaires du harness : on photographie la
    // collection pour la restaurer avant les tests de vente auto.
    const recycleCollection = await evaluate(cdp, sessionId, 'JSON.stringify(window.__marketState.collection)');
    const recycleChakra = await evaluate(cdp, sessionId, 'window.__chakra ?? 12345');
    const recycleBefore = await evaluate(
      cdp,
      sessionId,
      `(() => {
         const root = document.querySelector('#kyara-plus-root').shadowRoot;
         return {
           rows: root.querySelectorAll('.kp-recycle-row').length,
           dimmed: root.querySelectorAll('.kp-recycle-row.is-locked').length,
           chakra: Number(window.__kyaraPlus.state.user?.chakra) || 0
         };
       })()`
    );
    check('recyclage : des doublons sont listés', recycleBefore.rows > 0, `${recycleBefore.rows} ligne(s)`);
    check('recyclage : les cartes bloquées sont grisées', recycleBefore.dimmed >= 1, `${recycleBefore.dimmed}`);

    await evaluate(
      cdp,
      sessionId,
      `(() => {
         const root = document.querySelector('#kyara-plus-root').shadowRoot;
         root.querySelector('[data-act="recycle-select-all"]')?.click();
         return true;
       })()`
    );
    await sleep(250);
    const recycleSelected = await evaluate(cdp, sessionId, 'window.__kyaraPlus.state.recycle.selection.size');
    check('recyclage : sélection remplie', recycleSelected >= 1, `${recycleSelected} carte(s)`);

    await evaluate(
      cdp,
      sessionId,
      `(() => {
         const root = document.querySelector('#kyara-plus-root').shadowRoot;
         root.querySelector('[data-act="recycle-start"]')?.click();
         return true;
       })()`
    );
    await sleep(250);
    const recyclePreview = await evaluate(
      cdp,
      sessionId,
      `(() => {
         const root = document.querySelector('#kyara-plus-root').shadowRoot;
         return {
           open: Boolean(window.__kyaraPlus.state.recycle.open),
           rows: root.querySelectorAll('#kp-modal-card .kp-plan-row').length,
           label: root.querySelector('[data-act="recycle-run"]')?.textContent?.trim() || ''
         };
       })()`
    );
    check(
      'recyclage : aperçu ouvert',
      recyclePreview.open && recyclePreview.rows === recycleSelected,
      `${recyclePreview.rows}/${recycleSelected}`
    );
    check('recyclage : bouton de confirmation', /Recycler/.test(recyclePreview.label), recyclePreview.label);

    await evaluate(
      cdp,
      sessionId,
      `(() => {
         const root = document.querySelector('#kyara-plus-root').shadowRoot;
         root.querySelector('[data-act="recycle-run"]')?.click();
         return true;
       })()`
    );
    await waitFor(() => evaluate(cdp, sessionId, '(window.__recycled || []).length > 0'), {
      label: 'POST recycle',
      timeout: 20000
    });
    await waitFor(() => evaluate(cdp, sessionId, 'window.__kyaraPlus.state.recycle.done === true'), {
      label: 'fin du recyclage',
      timeout: 30000
    });
    const recycleAfter = await evaluate(
      cdp,
      sessionId,
      `(() => ({
         calls: (window.__recycled || []).length,
         copies: (window.__recycled || []).reduce((sum, call) => sum + Number(call.qty || 0), 0),
         chakra: Number(window.__kyaraPlus.state.user?.chakra) || 0,
         selection: window.__kyaraPlus.state.recycle.selection.size
       }))()`
    );
    check('recyclage : une requête par carte', recycleAfter.calls >= 1, `${recycleAfter.calls} appel(s)`);
    check(
      'recyclage : chakra crédité',
      recycleAfter.chakra > recycleBefore.chakra,
      `${recycleBefore.chakra} → ${recycleAfter.chakra}`
    );
    check('recyclage : sélection vidée', recycleAfter.selection === 0);

    // Referme l'aperçu pour ne pas masquer les écrans suivants.
    await evaluate(
      cdp,
      sessionId,
      `(() => {
         const root = document.querySelector('#kyara-plus-root').shadowRoot;
         root.querySelector('[data-act="recycle-close"]')?.click();
         return true;
       })()`
    );
    await sleep(200);

    // Restaure l'inventaire simulé (les tests de vente auto comptent sur ses quantités).
    await evaluate(
      cdp,
      sessionId,
      `(() => {
         const saved = ${recycleCollection};
         window.__marketState.collection.length = 0;
         for (const row of saved) window.__marketState.collection.push(row);
         window.__chakra = ${JSON.stringify(recycleChakra)};
         window.__recycled = [];
         const state = window.__kyaraPlus.state;
         state.collection = window.__marketState.collection.map((row) => ({ ...row }));
         if (state.user) state.user.chakra = window.__chakra;
         window.__kyaraPlus.render();
         return true;
       })()`
    );
    await sleep(200);

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
           estimate: root.querySelector('.kp-autosell-summary')?.innerText || '',
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
      /estim/i.test(autoUi.estimate) && autoUi.estimate.includes('◆'),
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
      optimized.order === 'score' && /ventes?.*7 j/i.test(optimized.pick),
      `${optimized.order} · ${optimized.pick.replace(/\s+/g, ' ').slice(0, 120)}`
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
    const slots9 = await evaluate(
      cdp,
      sessionId,
      `(() => {
         const p = window.__kyaraPlus;
         p.state.settings.autoSellMaxActive = 9;
         const s = p.autoSellSlots();
         p.state.settings.autoSellMaxActive = 10;
         return s;
       })()`
    );
    check(
      'Limite 9/10 : la 10e place reste libre, les annonces actives comptent',
      slots9.max === 9 && slots9.active === 9 && slots9.remaining === 0,
      JSON.stringify(slots9)
    );
    const sales = await evaluate(
      cdp,
      sessionId,
      `(() => {
         const p = window.__kyaraPlus;
         p.state.tab = 'sell';
         p.state.sellView.mode = 'auto';
         p.state.settings.salesRange = '7d';
         p.render();
         const root = document.querySelector('#kyara-plus-root').shadowRoot;
         const text = root.querySelector('#kp-view')?.innerText || '';
         const chart = root.querySelector('.kp-sales');
         return {
           count: p.state.salesLog.length,
           auto: p.state.salesLog.filter((e) => e.source === 'auto').length,
           chart: text.toLowerCase().includes('profit net des ventes auto') && text.toLowerCase().includes('vente'),
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
    check('Graphique du bénéfice par heure affiché', sales.chart === true);
    check(
      'Graphique : choix 1 jour / 7 jours / total',
      ['1d', '7d', 'total'].every((value) => sales.ranges.includes(value)),
      sales.ranges.join(',')
    );
    check(
      'Graphique : une seule courbe « Gain de l’heure »',
      sales.lines === 1 && /Gain de l/.test(sales.legend) && !/Auto|Manuelle/.test(sales.legend),
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
        chartDay.labels.includes('◆ 50'),
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

    // La courbe doit refléter le bénéfice de CHAQUE heure : elle monte quand une
    // heure rapporte plus, redescend quand la suivante rapporte moins.
    // 58 ◆ à H-3, 187 ◆ à H-2, 29 ◆ à H-1.
    const curve = await evaluate(
      cdp,
      sessionId,
      `(() => {
         const kp = window.__kyaraPlus;
         const now = Date.now();
         const accountId = kp.state.user?.id ?? null;
         kp.state.salesLog = [
           { id: 't1', at: now - 3 * 3600e3, source: 'auto', net: 58, gross: 62, fees: 2, tax: 2, accountId },
           { id: 't2', at: now - 2 * 3600e3, source: 'auto', net: 187, gross: 200, fees: 4, tax: 9, accountId },
           { id: 't3', at: now - 1 * 3600e3, source: 'auto', net: 29, gross: 31, fees: 1, tax: 1, accountId }
         ];
         kp.state.settings.salesRange = '1d';
         kp.render();
         const root = document.querySelector('#kyara-plus-root').shadowRoot;
         const path = root.querySelector('.kp-sales-line');
         const d = path ? path.getAttribute('d') || '' : '';
         const ys = [...d.matchAll(/[ML]([\\d.]+) ([\\d.]+)/g)].map((m) => Number(m[2]));
         const minY = Math.min(...ys);
         const peak = ys.indexOf(minY);
         const out = {
           points: ys.length,
           distinct: new Set(ys).size,
           peak,
           before: ys[peak - 1],
           after: ys[peak + 1],
           title: root.querySelector('.kp-sales-head b')?.innerText || ''
         };
         // On remet l'état de départ (aucune vente confirmée dans le harness).
         kp.state.salesLog = [];
         kp.render();
         return out;
       })()`
    );
    check(
      'Graphique : bénéfice par heure, la courbe monte puis redescend',
      curve.points === 24 &&
        curve.distinct >= 3 &&
        Number.isFinite(curve.before) &&
        Number.isFinite(curve.after) &&
        curve.before > curve.peak &&
        curve.after > curve.peak,
      JSON.stringify(curve)
    );
    check(
      'Graphique : intitulé « Profit des ventes automatiques »',
      /profit des ventes automatiques/i.test(curve.title),
      curve.title
    );

    // — Remise en vente automatique d'une annonce revenue sans acheteur —
    // Simulation : l'annonce expire (elle quitte le marché), l'échéance est
    // dépassée et la copie redevient listable. Le cycle de vente auto doit la
    // remettre en ligne tout seul, au prix le plus bas autorisé.
    const relistSetup = await evaluate(
      cdp,
      sessionId,
      `(async () => {
         const kp = window.__kyaraPlus;
         const state = kp.state;
         const collection = (window.__marketState && window.__marketState.collection) || [];
         const entries = kp
           .autoSellActiveEntries()
           .filter((listing) => !listing.pending && listing.characterId && listing.status !== 'expired');
         const target = entries[0];
         if (!target) return { ok: false, reason: 'aucune annonce active' };
         const listingId = String(target.id);
         const characterId = String(target.characterId);
         // Toutes les annonces de cette carte expirent : une seule reste suivie.
         const dropIds = new Set([
           listingId,
           ...entries
             .filter((listing) => String(listing.characterId) === characterId)
             .map((listing) => String(listing.id))
         ]);
         const market = window.__marketState || {};
         if (Array.isArray(market.listings)) {
           market.listings = market.listings.filter((listing) => !dropIds.has(String(listing.id)));
         }
         const row = collection.find((item) => String(item.characterId) === characterId);
         if (row) {
           row.qty = Math.max(2, Number(row.qty || 1));
           row.listable = 1;
         }
         const track =
           state.salesTrack.find((entry) => String(entry.id) === listingId) ||
           state.salesTrack.find((entry) => String(entry.characterId) === characterId);
         if (!track) return { ok: false, reason: 'annonce non suivie' };
         state.salesTrack = [track];
         state.autoSell.pendingListings = [];
         // Annonce ancienne et expirée : le site l'a retirée sans acheteur.
         track.createdAt = Date.now() - 3600000;
         track.at = track.createdAt;
         track.endsAt = Date.now() - 60000;
         window.__relist = {
           listingId,
           characterId,
           previous: Number(target.price) || null,
           rarity: target.character?.rarity || null
         };
         // Relecture des annonces puis un cycle complet, comme le ferait la boucle.
         state.autoSell.stop = false;
         state.autoSell.starting = true;
         try {
           await kp.autoSellRefresh();
         } catch (err) {
           state.autoSell.starting = false;
           return { ok: false, reason: 'refresh: ' + (err && err.message ? err.message : String(err)) };
         }
         state.autoSell.starting = false;
         const queued = state.autoSell.relist.queue.length;
         state.autoSell.running = true;
         state.autoSell.stop = false;
         let result = null;
         let failure = null;
         try {
           result = await kp.autoSellCycle();
         } catch (err) {
           failure = err && err.message ? err.message : String(err);
         }
         state.autoSell.running = false;
         state.autoSell.stop = true;
         return {
           ok: queued > 0,
           queued,
           failure,
           result: result ? { created: result.created, error: result.error, fatal: result.fatal } : null,
           count: state.autoSell.relist.count,
           last: state.autoSell.relist.last,
           log: state.autoSell.log.map((entry) => entry.text).slice(-4)
         };
       })()`
    );
    check(
      'Remise en vente : annonce expirée détectée et mise en file',
      relistSetup.ok === true,
      JSON.stringify(relistSetup)
    );
    const relist = await evaluate(
      cdp,
      sessionId,
      `(() => {
         const kp = window.__kyaraPlus;
         const a = kp.state.autoSell;
         const active = kp.autoSellActiveEntries();
         const rarity = window.__relist?.rarity;
         return {
           count: a.relist.count,
           price: Number(a.relist.last?.price) || null,
           previous: window.__relist?.previous ?? null,
           floor: Number(kp.state.config?.recycle?.[rarity] ?? 1),
           active: active.length,
           max: kp.listingSlots().max,
           sameCard: active.filter(
             (l) => String(l.characterId) === String(window.__relist?.characterId)
           ).length,
           queue: a.relist.queue.length,
           logText: a.log.map((entry) => entry.text).join(' | '),
           panel:
             document.querySelector('#kyara-plus-root').shadowRoot.querySelector('.kp-autosell-relist')
               ?.innerText || ''
         };
       })()`
    );
    check('Remise en vente auto : la carte repart toute seule', relistSetup.count === 1, JSON.stringify(relistSetup));
    check(
      'Remise en vente auto : jamais sous le plancher de recyclage',
      relist.price >= relist.floor && relist.price > 0,
      `${relist.price} / plancher ${relist.floor}`
    );
    check(
      'Remise en vente auto : pas plus cher que l’annonce expirée',
      relist.previous == null || relist.price <= relist.previous,
      `${relist.price} vs ${relist.previous}`
    );
    check(
      'Remise en vente auto : une seule annonce pour la carte',
      relist.sameCard === 1,
      `${relist.sameCard} annonce(s)`
    );
    check(
      'Remise en vente auto : limite de 10 respectée',
      relist.active <= relist.max,
      `${relist.active}/${relist.max}`
    );
    check(
      'Remise en vente auto : journal explicite et prix affiché',
      /remise en vente auto/.test(relist.logText) && /◆/.test(relist.logText),
      relist.logText.replace(/\s+/g, ' ').slice(-120)
    );
    check(
      'Remise en vente auto : encart visible dans le panneau',
      /remise en vente auto/i.test(relist.panel) && /◆/.test(relist.panel),
      relist.panel
    );
    check('Remise en vente auto : file vidée après traitement', relist.queue === 0, String(relist.queue));

    const relistStopped = await evaluate(
      cdp,
      sessionId,
      `(() => {
         const a = window.__kyaraPlus.state.autoSell;
         a.running = true;
         document.querySelector('#kyara-plus-root').shadowRoot.querySelector('[data-act="autosell-stop"]')?.click();
         return { running: a.running, queue: a.relist.queue.length };
       })()`
    );
    check(
      'Remise en vente auto : l’arrêt de la vente auto vide la file',
      relistStopped.running === false && relistStopped.queue === 0,
      JSON.stringify(relistStopped)
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

    // — Retrait automatique d'une annonce restée trop longtemps en vente —
    const expiry = await evaluate(
      cdp,
      sessionId,
      `(async () => {
         const kp = window.__kyaraPlus;
         const state = kp.state;
         const market = window.__marketState || {};
         const listings = Array.isArray(market.listings) ? market.listings : [];
         const collection = Array.isArray(market.collection) ? market.collection : [];
         const settings = state.settings;
         const saved = {
           enabled: settings.autoSellExpireEnabled,
           value: settings.autoSellExpireValue,
           unit: settings.autoSellExpireUnit
         };
         settings.autoSellExpireEnabled = true;
         settings.autoSellExpireValue = 1;
         settings.autoSellExpireUnit = 'min';

         const actives = kp.autoSellActiveEntries().filter((l) => l.characterId && !l.pending);
         const target = actives[0];
         if (!target) return { ok: false, reason: 'aucune annonce active' };
         const targetId = String(target.id);
         const targetCard = String(target.characterId);
         // Deuxième annonce, sans aucune trace d'origine : annonce manuelle.
         const manual = actives.find((l) => String(l.characterId) !== targetCard) || null;
         const manualId = manual ? String(manual.id) : null;
         const old = new Date(Date.now() - 2 * 3600000).toISOString();
         for (const listing of listings) {
           if (String(listing.id) === targetId || (manualId && String(listing.id) === manualId)) {
             listing.createdAt = old;
           }
         }
         // Seule la cible est suivie comme créée par la vente auto.
         state.salesTrack = [
           {
             id: targetId,
             characterId: targetCard,
             name: target.character?.name || '',
             rarity: target.character?.rarity || '',
             price: Number(target.price) || null,
             source: 'auto',
             createdAt: Date.now() - 2 * 3600000,
             endsAt: Date.now() + 3600000
           }
         ];
         const rowBefore = collection.find((item) => String(item.characterId) === targetCard);
         const qtyBefore = Number(rowBefore?.qty);
         const activeBefore = kp.listingSlots().active;

         state.autoSell.stop = false;
         state.autoSell.running = true;
         let result = null;
         let failure = null;
         try {
           await kp.autoSellRefresh();
           result = await kp.autoSellPurgeExpired({ refresh: true });
         } catch (err) {
           failure = err && err.message ? err.message : String(err);
         }
         state.autoSell.running = false;
         state.autoSell.stop = true;

         // Nouvelle lecture : l'exemplaire doit être revenu dans le pool.
         state.autoSell.running = true;
         try {
           await kp.autoSellRefresh();
         } catch (err) {
           failure = failure || (err && err.message ? err.message : String(err));
         }
         state.autoSell.running = false;
         state.autoSell.stop = true;
         const poolRow =
           state.collection.find((item) => String(item.characterId ?? item.id) === targetCard) || null;
         const listableAfter = Number(poolRow?.listable);

         const marketIds = (window.__marketState?.listings || []).map((l) => String(l.id));
         const rowAfter = (window.__marketState?.collection || []).find(
           (item) => String(item.characterId) === targetCard
         );
         const returned =
           state.autoSell.expiry.returns.find((entry) => String(entry.characterId) === targetCard) || null;
         // Tout de suite après le retrait, la carte ne doit pas être resélectionnable.
         const appearsNow = kp
           .autoSellRankedCandidates()
           .some((row) => String(row.id) === targetCard);
         // Délai anti-boucle écoulé : elle réapparaît, en toute fin de classement.
         if (returned) returned.at = Date.now() - 11 * 60000;
         const rankedLater = kp.autoSellRankedCandidates();
         const lastRow = rankedLater[rankedLater.length - 1] || null;
         state.sellView.mode = 'auto';
         state.tab = 'sell';
         state.open = true;
         kp.render();
         const root = document.querySelector('#kyara-plus-root').shadowRoot;
         const expiryPanel = root.querySelector('.kp-expiry')?.innerText || '';
         const note = root.querySelector('.kp-autosell-expire-note')?.innerText || '';
         const logText = state.autoSell.log.map((entry) => entry.text).join(' | ');
         settings.autoSellExpireEnabled = saved.enabled;
         settings.autoSellExpireValue = saved.value;
         settings.autoSellExpireUnit = saved.unit;
         return {
           ok: true,
           failure,
           removed: result ? result.removed : null,
           targetId,
           targetCard,
           manualId,
           removedFromServer: !marketIds.includes(targetId),
           manualStillThere: manualId ? marketIds.includes(manualId) : null,
           qtyBefore,
           qtyAfter: Number(rowAfter?.qty),
           inventoryHasCard: Boolean(rowAfter) && Number(rowAfter?.qty) >= 1,
           listableAfter,
           returned: returned ? { at: returned.at, name: returned.name } : null,
           activeBefore,
           activeAfter: kp.listingSlots().active,
           appearsNow,
           lastId: lastRow ? String(lastRow.id) : null,
           lastExpired: Boolean(lastRow?.expiredReturn),
           history: state.autoSell.expiry.history.map((entry) => entry.kind),
           logText,
           expiryPanel,
           note
         };
       })()`
    );
    check('Retrait auto : aucune erreur pendant le retrait', expiry.ok === true && expiry.failure === null, JSON.stringify(expiry.failure));
    check(
      'Retrait auto : annonce trop ancienne retirée des ventes actives',
      expiry.removed === 1 && expiry.removedFromServer === true,
      `removed=${expiry.removed} · serveur=${expiry.removedFromServer}`
    );
    check(
      'Retrait auto : annonce manuelle jamais retirée',
      Boolean(expiry.manualId) && expiry.manualStillThere === true,
      `manuelle=${expiry.manualId} · présente=${expiry.manualStillThere}`
    );
    check(
      'Retrait auto : carte et quantité conservées dans l’inventaire',
      expiry.inventoryHasCard === true && expiry.qtyAfter === expiry.qtyBefore,
      `qty ${expiry.qtyBefore} → ${expiry.qtyAfter}`
    );
    check(
      'Retrait auto : carte de retour dans le pool disponible',
      Number.isFinite(expiry.listableAfter) && expiry.listableAfter > 0,
      `listable=${expiry.listableAfter}`
    );
    check(
      'Retrait auto : place d’annonce libérée',
      expiry.activeAfter === expiry.activeBefore - 1,
      `${expiry.activeBefore} → ${expiry.activeAfter}`
    );
    check(
      'Retrait auto : pas de resélection immédiate',
      expiry.appearsNow === false,
      String(expiry.appearsNow)
    );
    check(
      'Retrait auto : statut « retour après expiration » classé en fin de file',
      expiry.lastId === expiry.targetCard && expiry.lastExpired === true,
      `dernière=${expiry.lastId} · statut=${expiry.lastExpired}`
    );
    check(
      'Retrait auto : journal horodaté et encart dans le panneau',
      expiry.history.includes('remove') &&
        /retirée après/i.test(expiry.logText) &&
        /retrait auto/i.test(expiry.note) &&
        /retraits automatiques/i.test(expiry.expiryPanel),
      `${expiry.note.replace(/\s+/g, ' ')} | ${expiry.expiryPanel.replace(/\s+/g, ' ').slice(0, 120)}`
    );

    // — Option « recycler les cartes retirées après expiration » —
    const recycleExpiry = await evaluate(
      cdp,
      sessionId,
      `(async () => {
         const kp = window.__kyaraPlus;
         const state = kp.state;
         const settings = state.settings;
         const optionWasOff = settings.autoSellRecycleExpired === false;
         const saved = settings.autoSellRecycleExpired;
         const savedExpire = {
           enabled: settings.autoSellExpireEnabled,
           value: settings.autoSellExpireValue,
           unit: settings.autoSellExpireUnit
         };
         const callsBefore = (window.__recycled || []).length;
         const market = window.__marketState || {};
         const collection = Array.isArray(market.collection) ? market.collection : [];
         const previousCard = ${JSON.stringify(expiry.targetCard)};
         const actives = kp.autoSellActiveEntries().filter((l) => l.characterId && !l.pending);
         // Cible : une autre annonce. On force une carte à 4 exemplaires dont
         // 1 seul est engagé par l'annonce, pour un scénario déterministe :
         // après le retrait, 3 exemplaires sont recyclables et l'annonce en
         // contient 2 — le recyclage doit porter exactement sur 2.
         const qty = 2;
         const pick = actives.find((l) => String(l.characterId) !== previousCard) || null;
         if (!pick) return { ok: false, reason: 'aucune annonce disponible' };
         const targetId = String(pick.id);
         const cardId = String(pick.characterId);
         let targetRow = collection.find((r) => String(r.characterId) === cardId) || null;
         if (!targetRow) return { ok: false, reason: 'carte absente du harness' };
         targetRow.qty = 4;
         targetRow.locked = 2;
         targetRow.listable = 2;
         pick.qty = qty;
         pick.createdAt = new Date(Date.now() - 3 * 3600000).toISOString();
         for (const l of market.listings) {
           if (String(l.id) === targetId) {
             l.createdAt = new Date(Date.now() - 3 * 3600000).toISOString();
             l.qty = qty;
           }
         }
         state.salesTrack = [
           ...state.salesTrack,
           {
             id: targetId,
             characterId: cardId,
             name: pick.character?.name || '',
             rarity: pick.character?.rarity || '',
             price: Number(pick.price) || null,
             source: 'auto',
             createdAt: Date.now() - 3 * 3600000,
             endsAt: Date.now() + 3600000
           }
         ];
         const qtyBefore = Number((collection.find((r) => String(r.characterId) === cardId) || {}).qty);
         settings.autoSellExpireEnabled = true;
         settings.autoSellExpireValue = 1;
         settings.autoSellExpireUnit = 'min';
         settings.autoSellRecycleExpired = true;
         kp.render();
         const root = document.querySelector('#kyara-plus-root').shadowRoot;
         const box = root.querySelector('[data-autosell-recycle-expired]');
         const boxChecked = Boolean(box && box.checked);
         state.autoSell.expiry.locks = {};
         state.autoSell.stop = false;
         state.autoSell.running = true;
         let result = null;
         let failure = null;
         try {
           await kp.autoSellRefresh();
           result = await kp.autoSellPurgeExpired({ refresh: true });
         } catch (err) {
           failure = err && err.message ? err.message : String(err);
         }
         state.autoSell.running = false;
         state.autoSell.stop = true;
         const calls = (window.__recycled || []).slice(callsBefore);
         const rowAfter = (window.__marketState.collection || []).find((r) => String(r.characterId) === cardId);
         const entry =
           state.autoSell.expiry.history
             .filter((h) => h.kind === 'remove' && String(h.characterId) === cardId)
             .pop() || null;
         const inReturns = state.autoSell.expiry.returns.some((r) => String(r.characterId) === cardId);
         const logText = state.autoSell.log.map((e) => e.text).join(' | ');
         const rowNow = state.collection.find((r) => String(r.characterId ?? r.id) === cardId) || null;
         const listingsForCard = (window.__marketState.listings || []).filter(
           (l) => String(l.characterId) === cardId
         ).length;
         settings.autoSellRecycleExpired = saved;
         settings.autoSellExpireEnabled = savedExpire.enabled;
         settings.autoSellExpireValue = savedExpire.value;
         settings.autoSellExpireUnit = savedExpire.unit;
         kp.render();
         return {
           ok: true,
           failure,
           optionWasOff,
           boxChecked,
           removed: result ? result.removed : null,
           recycledCalls: calls.length,
           recycledQty: calls.reduce((sum, call) => sum + Number(call.qty || 0), 0),
           listingQty: qty,
           qtyBefore,
           qtyAfter: Number(rowAfter?.qty),
           listableNow: Number(rowNow?.listable),
           qtyNow: Number(rowNow?.qty),
           listingsForCard,
           outcome: entry ? entry.outcome : null,
           entryQty: entry ? entry.recycledQty : null,
           inReturns,
           logText
         };
       })()`
    );
    check('Recyclage auto : option décochée par défaut', recycleExpiry.ok === true && recycleExpiry.optionWasOff === true, JSON.stringify(recycleExpiry.failure || recycleExpiry.reason));
    check('Recyclage auto : case visible et cochée', recycleExpiry.boxChecked === true);
    check('Recyclage auto : aucune erreur', recycleExpiry.ok === true && recycleExpiry.failure === null, JSON.stringify(recycleExpiry.failure));
    check(
      'Recyclage auto : la carte expirée est recyclée',
      recycleExpiry.recycledCalls === 1 && recycleExpiry.recycledQty === recycleExpiry.listingQty,
      `appels=${recycleExpiry.recycledCalls} · qty=${recycleExpiry.recycledQty}/${recycleExpiry.listingQty} · listable=${recycleExpiry.listableNow} · annonces=${recycleExpiry.listingsForCard}`
    );
    check(
      'Recyclage auto : quantité exacte retirée de l’inventaire',
      recycleExpiry.qtyAfter === recycleExpiry.qtyBefore - recycleExpiry.recycledQty,
      `qty ${recycleExpiry.qtyBefore} → ${recycleExpiry.qtyAfter}`
    );
    check(
      'Recyclage auto : la carte ne revient pas dans le pool',
      recycleExpiry.inReturns === false && recycleExpiry.outcome === 'recycle',
      `retour=${recycleExpiry.inReturns} · statut=${recycleExpiry.outcome}`
    );
    check(
      'Recyclage auto : journal et historique explicites',
      /recyclée/i.test(recycleExpiry.logText) && recycleExpiry.entryQty === recycleExpiry.listingQty,
      recycleExpiry.logText.slice(-160)
    );
    await evaluate(
      cdp,
      sessionId,
      `(() => {
         const a = window.__kyaraPlus.state.autoSell;
         a.expiry.returns = [];
         a.expiry.history = [];
         a.expiry.locks = {};
         window.__kyaraPlus.render();
         return true;
       })()`
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
        marketText.toLowerCase().includes('bons plans')
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

    console.log('\n— Completion : séries incomplètes et achat (harness) —');
    await evaluate(
      cdp,
      sessionId,
      `(() => { window.__kyaraPlus.setOpen(true); window.__kyaraPlus.setTab('completion'); return true; })()`
    );
    await sleep(600);
    const completionList = await evaluate(
      cdp,
      sessionId,
      `(() => {
         const root = document.querySelector('#kyara-plus-root').shadowRoot;
         return {
           series: [...root.querySelectorAll('.kp-cplt-row')].map((el) => el.getAttribute('data-series')),
           rows: root.querySelectorAll('.kp-cplt-row').length,
           scan: Boolean(root.querySelector('[data-act="completion-scan"]')),
           stats: root.querySelectorAll('.kp-card-stat').length
         };
       })()`
    );
    check(
      'completion : seules les séries incomplètes sont listées',
      completionList.rows === 2 && completionList.series.includes('Naruto') && completionList.series.includes('ONE PIECE'),
      JSON.stringify(completionList.series)
    );
    check('completion : aucune série complète ni série d’une carte', !completionList.series.includes('Test'), JSON.stringify(completionList.series));
    check('completion : vue d’ensemble présente', completionList.stats === 4, `${completionList.stats} encart(s)`);
    check('completion : bouton de relecture du marché', completionList.scan);

    // Relecture du marché : deux séries, une requête par série.
    await evaluate(
      cdp,
      sessionId,
      `(() => {
         const root = document.querySelector('#kyara-plus-root').shadowRoot;
         root.querySelector('[data-act="completion-scan"]').click();
         return true;
       })()`
    );
    await waitFor(
      () =>
        evaluate(
          cdp,
          sessionId,
          `(() => {
             const root = document.querySelector('#kyara-plus-root').shadowRoot;
             return root.querySelector('.kp-cplt-row[data-series="Naruto"]')?.classList.contains('has-dispo') === true;
           })()`
        ),
      { label: 'marché de complétion relu' }
    );
    const narutoRow = await evaluate(
      cdp,
      sessionId,
      `(() => {
         const root = document.querySelector('#kyara-plus-root').shadowRoot;
         const row = root.querySelector('.kp-cplt-row[data-series="Naruto"]');
         return { text: row?.innerText || '', market: row?.querySelector('.kp-cplt-market')?.innerText || '' };
       })()`
    );
    check(
      'completion : manquants en vente et coût affichés',
      /2 en vente/.test(narutoRow.market) && /52/.test(narutoRow.market),
      narutoRow.market.replace(/\n/g, ' ')
    );

    // Fiche série : 4 manquantes, 2 disponibles déjà cochées.
    await evaluate(
      cdp,
      sessionId,
      `(() => {
         const root = document.querySelector('#kyara-plus-root').shadowRoot;
         root.querySelector('.kp-cplt-row[data-series="Naruto"] [data-act="completion-open"]').click();
         return true;
       })()`
    );
    await waitFor(
      () =>
        evaluate(
          cdp,
          sessionId,
          `!document.querySelector('#kyara-plus-root').shadowRoot.querySelector('#kp-modal').hidden`
        ),
      { label: 'fiche de série ouverte' }
    );
    const detail = await evaluate(
      cdp,
      sessionId,
      `(() => {
         const root = document.querySelector('#kyara-plus-root').shadowRoot;
         const card = root.querySelector('#kp-modal-card');
         return {
           cards: card.querySelectorAll('.kp-cplt-card').length,
           checked: card.querySelectorAll('input[data-completion-pick]:checked').length,
           disabled: card.querySelectorAll('input[data-completion-pick]:disabled').length,
           button: card.querySelector('[data-act="completion-start"]')?.textContent.trim() || ''
         };
       })()`
    );
    check('completion : les 4 manquants sont listés', detail.cards === 4, `${detail.cards} carte(s)`);
    check('completion : 2 cartes disponibles cochées', detail.checked === 2, `${detail.checked} cochée(s)`);
    check('completion : 2 cartes introuvables désactivées', detail.disabled === 2, `${detail.disabled} désactivée(s)`);
    check('completion : total du panier annoncé', /2 cartes/.test(detail.button) && /52/.test(detail.button), detail.button);

    // Panier puis achat réel : le harness débite le chakra et ajoute les cartes.
    await evaluate(
      cdp,
      sessionId,
      `(() => {
         const root = document.querySelector('#kyara-plus-root').shadowRoot;
         root.querySelector('[data-act="completion-start"]').click();
         return true;
       })()`
    );
    await sleep(500);
    const plan = await evaluate(
      cdp,
      sessionId,
      `(() => {
         const root = document.querySelector('#kyara-plus-root').shadowRoot;
         const card = root.querySelector('#kp-modal-card');
         return { rows: card.querySelectorAll('.kp-plan-row').length, buy: card.querySelector('[data-act="completion-buy"]')?.textContent.trim() || '' };
       })()`
    );
    check('completion : panier de 2 lignes', plan.rows === 2, `${plan.rows} ligne(s)`);
    check('completion : confirmation explicite', /Acheter 2 cartes/.test(plan.buy) && /52/.test(plan.buy), plan.buy);

    await evaluate(
      cdp,
      sessionId,
      `(() => { window.__chakra = 1000; return true; })()`
    );
    await evaluate(
      cdp,
      sessionId,
      `(() => {
         const root = document.querySelector('#kyara-plus-root').shadowRoot;
         root.querySelector('[data-act="completion-buy"]').click();
         return true;
       })()`
    );
    await waitFor(
      () => evaluate(cdp, sessionId, 'window.__bought?.length === 2'),
      { label: 'deux achats de complétion' }
    );
    const bought = await evaluate(
      cdp,
      sessionId,
      `(() => ({
         bought: window.__bought,
         chakra: window.__chakra,
         owned: window.__marketState.collection.filter((r) => [770001, 770002].includes(Number(r.characterId))).map((r) => Number(r.characterId)),
         others: window.__otherListings.length
       }))()`
    );
    check(
      'completion : achat réel débité (2 cartes, ◆ 52)',
      bought.chakra === 948 && bought.bought.reduce((sum, b) => sum + b.price, 0) === 52,
      JSON.stringify({ chakra: bought.chakra, prix: bought.bought.map((b) => b.price) })
    );
    check(
      'completion : cartes ajoutées à la collection',
      bought.owned.length === 2 && bought.owned.includes(770001) && bought.owned.includes(770002),
      JSON.stringify(bought.owned)
    );
    check('completion : annonces achetées retirées du marché', bought.others === 1, `${bought.others} autre(s) annonce(s)`);
    await evaluate(
      cdp,
      sessionId,
      `(() => {
         const root = document.querySelector('#kyara-plus-root').shadowRoot;
         root.querySelector('[data-act="completion-plan-close"]')?.click();
         return true;
       })()`
    );
    await sleep(400);
    // La collection est relue en fin de lot (plusieurs requêtes) : on attend la
    // mise à jour plutôt que de lire un rendu intermédiaire.
    await waitFor(
      () =>
        evaluate(
          cdp,
          sessionId,
          `(() => {
             const root = document.querySelector('#kyara-plus-root').shadowRoot;
             const row = root.querySelector('.kp-cplt-row[data-series="Naruto"]');
             return /4\\/6/.test(row?.innerText || '');
           })()`
        ),
      { label: 'progression relue après achat', timeout: 20000 }
    );
    const completionAfter = await evaluate(
      cdp,
      sessionId,
      `(() => {
         const root = document.querySelector('#kyara-plus-root').shadowRoot;
         const row = root.querySelector('.kp-cplt-row[data-series="Naruto"]');
         return { series: [...root.querySelectorAll('.kp-cplt-row')].map((el) => el.getAttribute('data-series')), text: row?.innerText || '' };
       })()`
    );
    check(
      'completion : progression relue après achat (4/6, plus rien en vente)',
      /4\/6/.test(completionAfter.text) && /2 manquantes/.test(completionAfter.text),
      completionAfter.text.replace(/\n/g, ' | ')
    );
    check(
      'completion : la série reste incomplète tant qu’il manque des cartes',
      completionAfter.series.includes('Naruto'),
      JSON.stringify(completionAfter.series)
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
        `(() => { const r = ${ROOT_JS}; const txt = (r?.querySelector('#kp-stats')?.innerText || '') + ' ' + (r?.querySelector('#kp-view')?.innerText || ''); return Boolean(r?.querySelector('.kp-panel') && r.querySelectorAll('#kp-tabs button').length >= 8 && /777/.test(txt)); })()`
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
