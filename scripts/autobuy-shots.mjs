#!/usr/bin/env node
/*
 * Kyareeh+ — vérifications et captures de l'onglet Auto-Achat.
 *
 * Démarre le harness local (API simulée), pilote un Chrome headless par CDP,
 * joue les scénarios de l'onglet (règles fermées, lecture marché, filtres,
 * tris, simulation, arrêt, achat réel plafonné, persistance) et écrit les
 * captures dans ../_shots/autobuy.
 *
 * Aucune donnée réelle : le compte et le marché viennent de test/harness.html.
 *
 * Usage : node scripts/autobuy-shots.mjs
 */

import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, '..', '_shots', 'autobuy');
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const HARNESS = 'http://127.0.0.1:8787/test/harness.html';
const PORT = 9350;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let checks = 0;
let failures = 0;
function check(label, condition, detail = '') {
  checks += 1;
  console.log(`  ${condition ? 'OK  ' : 'ECHEC'} ${label}${detail ? ` (${detail})` : ''}`);
  if (!condition) failures += 1;
}

async function connect() {
  let info = null;
  for (let i = 0; i < 120; i += 1) {
    try {
      info = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
      if (info?.webSocketDebuggerUrl) break;
    } catch {
      /* on réessaie */
    }
    await sleep(200);
  }
  if (!info?.webSocketDebuggerUrl) throw new Error('Chrome CDP indisponible');
  const ws = new WebSocket(info.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });
  let nextId = 0;
  const pending = new Map();
  const logs = [];
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { res, rej } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) rej(new Error(msg.error.message));
      else res(msg.result);
      return;
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      logs.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
    }
  };
  const send = (method, params = {}, sessionId) =>
    new Promise((res, rej) => {
      const id = ++nextId;
      pending.set(id, { res, rej });
      ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  return { ws, send, logs };
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  let server = null;
  try {
    await fetch(HARNESS);
  } catch {
    server = spawn(process.execPath, [join(ROOT, 'test', 'server.cjs')], { cwd: ROOT, stdio: 'ignore' });
    for (let i = 0; i < 40; i += 1) {
      try {
        await fetch(HARNESS);
        break;
      } catch {
        await sleep(200);
      }
    }
  }

  const profile = join(process.env.TEMP || process.env.TMP || ROOT, 'kp-autobuy-shots');
  rmSync(profile, { recursive: true, force: true });
  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--hide-scrollbars',
      '--window-size=1280,900',
      'about:blank'
    ],
    { stdio: 'ignore' }
  );

  const cdp = await connect();
  const { send, logs } = cdp;

  async function newPage(url) {
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    await send('Runtime.enable', {}, sessionId);
    await send('Page.enable', {}, sessionId);
    await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId);
    await send('Page.navigate', { url }, sessionId);
    const ev = (expression) =>
      send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId).then((r) => {
        if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'erreur JS');
        return r.result?.value;
      });
    for (let i = 0; i < 100; i += 1) {
      try {
        if (await ev('Boolean(window.__kyaraPlus && window.__kyaraPlus.state.ready)')) break;
      } catch {
        /* on réessaie */
      }
      await sleep(200);
    }
    await sleep(1600);
    return { targetId, sessionId, ev };
  }

  async function shot(page, name) {
    const result = await send('Page.captureScreenshot', { format: 'png' }, page.sessionId);
    writeFileSync(join(OUT, name), Buffer.from(result.data, 'base64'));
    console.log(`  capture ${name}`);
  }

  async function cleanPage(page) {
    await page.ev(`(() => {
      document.querySelectorAll('body > *').forEach((el) => { if (el.id !== 'kyara-plus-root') el.remove(); });
      document.body.style.cssText =
        'margin:0;height:100vh;background:radial-gradient(1200px 700px at 25% 10%, #1b1e29 0%, #0b0c10 55%, #06070a 100%);';
      document.documentElement.style.background = '#0b0c10';
      const s = window.__kyaraPlus.state;
      s.version = '2.9.0';
      s.manifestVersion = '2.9.0';
      s.manifestOutdated = false;
      s.update.version = null;
      s.update.error = null;
      return true;
    })()`);
    await sleep(200);
  }

  async function openTab(page, tab = 'autobuy') {
    await page.ev(`(() => {
      const p = window.__kyaraPlus;
      p.setOpen(true);
      p.setTab('${tab}');
      p.render();
      return true;
    })()`);
    await sleep(1200);
  }

  async function scrollModalBottom(page) {
    await page.ev(`(() => {
      const body = document.querySelector('#kyara-plus-root').shadowRoot.querySelector('.kp-modal-body');
      if (body) body.scrollTop = body.scrollHeight;
      return Boolean(body);
    })()`);
    await sleep(350);
  }

  async function scroll(page, top) {
    await page.ev(`(() => {
      const root = document.querySelector('#kyara-plus-root').shadowRoot;
      const v = root.querySelector('#kp-view');
      // Les vignettes sont en lazy-loading : on force leur chargement pour la capture.
      root.querySelectorAll('.kp-autobuy-list img').forEach((img) => { img.loading = 'eager'; });
      v.scrollTop = ${Number(top) || 0};
      return v.scrollTop;
    })()`);
    await sleep(700);
  }

  try {
    /* ------------------------------------------------------------------ */
    /* 1. Renaissance fermée : aucun chiffre inventé                       */
    /* ------------------------------------------------------------------ */
    console.log('\n1. Préparation (règles fermées)');
    const closed = await newPage(`${HARNESS}?rnclosed=1`);
    await cleanPage(closed);
    await openTab(closed);
    check('config Renaissance fermée', (await closed.ev('window.__kyaraPlus.state.config.renaissanceOpen')) === false);
    check('statut absent', (await closed.ev('window.__kyaraPlus.state.autobuy.status')) === null);
    const closedError = await closed.ev('window.__kyaraPlus.state.autobuy.statusError');
    check('message de règles indisponibles', String(closedError).includes('pas encore ouverte'));
    const closedText = await closed.ev(
      "document.querySelector('#kyara-plus-root').shadowRoot.querySelector('#kp-view').textContent"
    );
    check('progression affichée —', closedText.includes('Progression Éveil') && closedText.includes('—'));
    check('aucun pourcentage officiel', !closedText.includes('Progression Éveil50 %'));
    await shot(closed, '01-preparation-regles-fermees.png');
    await send('Target.closeTarget', { targetId: closed.targetId }).catch(() => null);

    /* ------------------------------------------------------------------ */
    /* 2. Vue d'ensemble, marché, filtres et tris                          */
    /* ------------------------------------------------------------------ */
    console.log('\n2. Marché, filtres et tris');
    const page = await newPage(HARNESS);
    await cleanPage(page);
    await openTab(page);
    check('statut Renaissance actif', (await page.ev('window.__kyaraPlus.state.autobuy.status?.active')) === true);
    check('progression 50 %', (await page.ev('window.__kyaraPlus.state.autobuy.status?.pct')) === 50);
    check('13 cartes encore nécessaires', (await page.ev('window.__kyaraPlus.state.autobuy.status?.remaining')) === 13);

    await page.ev(
      "document.querySelector('#kyara-plus-root').shadowRoot.querySelector('[data-act=\"autobuy-refresh\"]').click(); true"
    );
    for (let i = 0; i < 50; i += 1) {
      if (!(await page.ev('window.__kyaraPlus.state.autobuy.scan.running'))) break;
      await sleep(250);
    }
    check('lecture du marché terminée', (await page.ev('window.__kyaraPlus.state.autobuy.scan.running')) === false);
    check('12 cartes avec annonce', (await page.ev('window.__kyaraPlus.state.autobuy.market.size')) === 12);
    check('aucune erreur de lecture', (await page.ev('window.__kyaraPlus.state.autobuy.scan.error')) === '');

    const rows = await page.ev(
      "window.__kyaraPlus.autobuyRebuild().rows.map((r) => ({ id: r.id, price: r.price, rarity: r.rarity, useful: r.useful }))"
    );
    check('carte manquante disponible présente', rows.some((row) => row.id === '770010' && row.price === 6));
    check('carte possédée absente', !rows.some((row) => row.id === '10668'));
    check('annonce vendue ignorée', !rows.some((row) => row.id === '770003' && row.price === 55));
    check('annonce expirée ignorée', !rows.some((row) => row.id === '770004' && row.price != null));
    check('notre annonce ignorée', !rows.some((row) => row.id === '770001' && row.price === 1));
    await shot(page, '02-auto-achat-vue-ensemble.png');

    await scroll(page, 470);
    await shot(page, '03-filtres-et-tris.png');

    // Tri prix croissant.
    await page.ev(`(() => {
      const s = document.querySelector('#kyara-plus-root').shadowRoot.querySelector('[data-autobuy-sort]');
      s.value = 'price_asc';
      s.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    await sleep(500);
    const asc = await page.ev(
      "window.__kyaraPlus.autobuyRebuild().sorted.filter((r) => r.best).map((r) => r.price)"
    );
    check('tri prix croissant réellement ordonné', asc.every((value, i) => i === 0 || value >= asc[i - 1]), JSON.stringify(asc));
    await scroll(page, 470);
    await shot(page, '04-tri-prix-croissant.png');

    // Filtre rareté + retour au tri Priorité Éveil.
    await page.ev(`(() => {
      const root = document.querySelector('#kyara-plus-root').shadowRoot;
      const s = root.querySelector('[data-autobuy-sort]');
      s.value = 'eveil';
      s.dispatchEvent(new Event('change', { bubbles: true }));
      root.querySelector('[data-act="autobuy-rarity"][data-rarity="E"]').click();
      return true;
    })()`);
    await sleep(500);
    const rarityRows = await page.ev("window.__kyaraPlus.autobuyRebuild().sorted.map((r) => r.rarity)");
    check('filtre rareté É appliqué', rarityRows.length > 0 && rarityRows.every((value) => value === 'E'), JSON.stringify(rarityRows));
    await shot(page, '05-filtre-rarete-epique.png');

    // Dépliant des annonces (première carte).
    await page.ev(`(() => {
      const root = document.querySelector('#kyara-plus-root').shadowRoot;
      const toggle = root.querySelector('.kp-autobuy-list .kp-mkt-toggle');
      if (toggle) toggle.click();
      return Boolean(toggle);
    })()`);
    await sleep(400);
    await shot(page, '06-annonces-disponibles.png');

    /* ------------------------------------------------------------------ */
    /* 3. Confirmation, simulation, arrêt                                  */
    /* ------------------------------------------------------------------ */
    console.log('\n3. Confirmation, simulation et arrêt');
    await page.ev(`(() => {
      const a = window.__kyaraPlus.state.autobuy;
      Object.assign(a.filter, { rarity: 'all', sort: 'eveil', maxPrice: 0, hideL: false, dispoOnly: false, series: '', query: '' });
      a.budgetCap = 0;
      a.maxUnit = 0;
      a.dryRun = true;
      window.__kyaraPlus.render();
      return true;
    })()`);
    await sleep(400);
    await page.ev(
      "document.querySelector('#kyara-plus-root').shadowRoot.querySelector('[data-act=\"autobuy-start\"]').click(); true"
    );
    await sleep(600);
    const modalText = await page.ev(
      "document.querySelector('#kyara-plus-root').shadowRoot.querySelector('.kp-modal')?.textContent || ''"
    );
    check('confirmation : nombre de cartes', modalText.includes('Cartes prévues'));
    check('confirmation : coût estimé', modalText.includes('Coût estimé'));
    check('confirmation : budget max', modalText.includes('Budget max'));
    check('confirmation : prix unitaire max', modalText.includes('Prix unitaire max'));
    check('confirmation : simulation', modalText.includes('Simulation'));
    await shot(page, '07-confirmation-budget.png');

    // Achat réel : plafond obligatoire et confirmation explicite.
    await page.ev(`(() => {
      const a = window.__kyaraPlus.state.autobuy;
      a.dryRun = false;
      a.budgetCap = 100;
      a.maxUnit = 50;
      a.plan.confirmReal = false;
      window.__kyaraPlus.render();
      return true;
    })()`);
    await sleep(500);
    const realModal = await page.ev(
      "document.querySelector('#kyara-plus-root').shadowRoot.querySelector('.kp-modal')?.textContent || ''"
    );
    check('achat réel : case de confirmation présente', realModal.includes('Je confirme vouloir dépenser'));
    const confirmDisabled = await page.ev(
      "document.querySelector('#kyara-plus-root').shadowRoot.querySelector('[data-act=\"autobuy-confirm\"]')?.disabled"
    );
    check('achat réel bloqué sans confirmation', confirmDisabled === true);
    await shot(page, '08-confirmation-achat-reel.png');

    // Retour simulation pour ne pas dépenser dans ce scénario.
    await page.ev(`(() => {
      const a = window.__kyaraPlus.state.autobuy;
      a.dryRun = true;
      a.budgetCap = 0;
      a.maxUnit = 0;
      a.plan.confirmReal = false;
      window.__kyaraPlus.render();
      return true;
    })()`);
    await sleep(500);
    await page.ev(
      "document.querySelector('#kyara-plus-root').shadowRoot.querySelector('[data-act=\"autobuy-confirm\"]').click(); true"
    );
    for (let i = 0; i < 50; i += 1) {
      if (!(await page.ev('window.__kyaraPlus.state.autobuy.plan.running'))) break;
      await sleep(250);
    }
    const sim = await page.ev(`(() => {
      const p = window.__kyaraPlus.state.autobuy.plan;
      return { bought: p.bought, spent: p.spent, stopped: p.stopped, finished: p.finished, log: window.__kyaraPlus.state.autobuy.log.length };
    })()`);
    check('simulation : cartes achetées', sim.bought > 0, String(sim.bought));
    const simChakra = await page.ev('window.__kyaraPlus.state.user.chakra');
    const simReal = await page.ev('Boolean(window.__bought)');
    check(
      'simulation : aucune dépense réelle',
      sim.spent > 0 && Number(simChakra) === 12345 && simReal === false,
      `chakra=${simChakra}`
    );
    check('simulation : journal alimenté', sim.log >= sim.bought, String(sim.log));
    check('simulation : terminée', sim.finished === true);
    await scrollModalBottom(page);
    await shot(page, '09-journal-simulation.png');

    // Arrêt immédiat : nouvelle file, puis clic sur Arrêter.
    await page.ev(`(() => {
      const root = document.querySelector('#kyara-plus-root').shadowRoot;
      root.querySelector('[data-act="autobuy-close"]')?.click();
      return true;
    })()`);
    await sleep(400);
    await page.ev(`(() => {
      const a = window.__kyaraPlus.state.autobuy;
      a.dryRun = true;
      a.budgetCap = 0;
      a.maxUnit = 0;
      window.__kyaraPlus.render();
      window.__kyaraPlus.autobuyPrepare();
      return true;
    })()`);
    await sleep(500);
    await page.ev(
      "document.querySelector('#kyara-plus-root').shadowRoot.querySelector('[data-act=\"autobuy-confirm\"]').click(); true"
    );
    await sleep(1200);
    await page.ev(
      "document.querySelector('#kyara-plus-root').shadowRoot.querySelector('[data-act=\"autobuy-stop\"]').click(); true"
    );
    for (let i = 0; i < 40; i += 1) {
      if (!(await page.ev('window.__kyaraPlus.state.autobuy.plan.running'))) break;
      await sleep(200);
    }
    const stopped = await page.ev(`(() => {
      const p = window.__kyaraPlus.state.autobuy.plan;
      return { bought: p.bought, stopped: p.stopped, running: p.running, finished: p.finished };
    })()`);
    check('arrêt : file stoppée', stopped.running === false && stopped.finished === true);
    check('arrêt : raison manuelle', stopped.stopped === 'stop', String(stopped.stopped));
    check('arrêt : achats partiels', stopped.bought < 11, String(stopped.bought));
    await page.ev(`(() => {
      const root = document.querySelector('#kyara-plus-root').shadowRoot;
      const body = root.querySelector('.kp-modal-body');
      if (body) body.scrollTop = 0;
      const log = root.querySelector('.kp-modal .kp-log');
      if (log) log.scrollTop = log.scrollHeight;
      return true;
    })()`);
    await sleep(250);
    await shot(page, '10-arret-immediat.png');

    /* ------------------------------------------------------------------ */
    /* 4. Persistance des filtres et du tri                                */
    /* ------------------------------------------------------------------ */
    console.log('\n4. Persistance');
    await page.ev(`(async () => {
      const a = window.__kyaraPlus.state.autobuy;
      a.plan.open = false;
      a.filter.sort = 'price_asc';
      a.filter.maxPrice = 50;
      a.filter.hideL = true;
      a.budgetCap = 500;
      a.maxUnit = 100;
      window.__kyaraPlus.render();
      await window.__kyaraPlus.persistAutobuyNow();
      return true;
    })()`);
    await sleep(1200);
    await send('Page.reload', {}, page.sessionId);
    await sleep(1500);
    for (let i = 0; i < 60; i += 1) {
      try {
        if (await page.ev('Boolean(window.__kyaraPlus && window.__kyaraPlus.state.ready)')) break;
      } catch {
        /* on réessaie */
      }
      await sleep(250);
    }
    await sleep(1200);
    const persisted = await page.ev(`(() => {
      const a = window.__kyaraPlus.state.autobuy;
      return { sort: a.filter.sort, maxPrice: a.filter.maxPrice, hideL: a.filter.hideL, cap: a.budgetCap, unit: a.maxUnit };
    })()`);
    check('tri persisté', persisted.sort === 'price_asc', persisted.sort);
    check('prix max persisté', persisted.maxPrice === 50, String(persisted.maxPrice));
    check('rareté masquée persistée', persisted.hideL === true);
    check('plafond persisté', persisted.cap === 500, String(persisted.cap));
    check('prix unitaire persisté', persisted.unit === 100, String(persisted.unit));

    /* ------------------------------------------------------------------ */
    /* 5. Achat réel plafonné                                              */
    /* ------------------------------------------------------------------ */
    console.log('\n5. Achat réel plafonné');
    const real = await newPage(HARNESS);
    await cleanPage(real);
    await openTab(real);
    await real.ev(
      "document.querySelector('#kyara-plus-root').shadowRoot.querySelector('[data-act=\"autobuy-refresh\"]').click(); true"
    );
    for (let i = 0; i < 50; i += 1) {
      if (!(await real.ev('window.__kyaraPlus.state.autobuy.scan.running'))) break;
      await sleep(250);
    }
    await real.ev(`(() => {
      const a = window.__kyaraPlus.state.autobuy;
      a.dryRun = false;
      a.budgetCap = 100;
      a.maxUnit = 50;
      a.plan.confirmReal = false;
      a.log = [];
      a.totalSpent = 0;
      window.__kyaraPlus.render();
      window.__kyaraPlus.autobuyPrepare();
      return true;
    })()`);
    await sleep(600);
    await real.ev(`(() => {
      const c = document.querySelector('#kyara-plus-root').shadowRoot.querySelector('[data-autobuy-real-confirm]');
      if (!c) return false;
      c.checked = true;
      c.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    await sleep(300);
    await real.ev(
      "document.querySelector('#kyara-plus-root').shadowRoot.querySelector('[data-act=\"autobuy-confirm\"]').click(); true"
    );
    await sleep(2600);
    await shot(real, '12-execution-en-cours.png');
    for (let i = 0; i < 140; i += 1) {
      if (await real.ev('window.__kyaraPlus.state.autobuy.plan.finished')) break;
      await sleep(250);
    }
    const bought = (await real.ev('window.__bought || []')) ?? [];
    const spent = bought.reduce((sum, item) => sum + Number(item.price || 0), 0);
    const chakraLeft = await real.ev('window.__chakra');
    const boughtIds = bought.map((item) => String(item.characterId));
    check('achat réel : au moins une carte', bought.length > 0, String(bought.length));
    check('achat réel : plafond respecté', spent <= 100, `${spent} ≤ 100`);
    check('achat réel : prix unitaire respecté', bought.every((item) => Number(item.price) <= 50));
    check('achat réel : aucun doublon', new Set(boughtIds).size === boughtIds.length);
    check('achat réel : chakra débité', Number(chakraLeft) === 12345 - spent, `${chakraLeft} = 12345 - ${spent}`);
    check('achat réel : pas de carte déjà possédée', !boughtIds.some((id) => ['10668', '21122', '282077', '127691', '999001', '999002', '45627', '45628'].includes(id)));
    const pctAfter = await real.ev('window.__kyaraPlus.state.autobuy.status?.pct');
    check('achat réel : progression mise à jour', Number(pctAfter) > 50, String(pctAfter));
    await shot(real, '11-achat-reel-budget.png');

    console.log(`\nContrôles : ${checks} · échecs : ${failures}`);
    if (logs.length) console.log('Erreurs JS :', logs.slice(-5));
    if (failures) process.exitCode = 1;
  } finally {
    spawnSync('taskkill', ['/PID', String(chrome.pid), '/T', '/F'], { stdio: 'ignore' });
    if (server) server.kill();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
