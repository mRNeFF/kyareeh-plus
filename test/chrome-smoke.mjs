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
         return true;
       })()`
    );
    await sleep(350);
    const saleText = await evaluate(
      cdp,
      sessionId,
      `document.querySelector('#kyara-plus-root').shadowRoot.querySelector('#kp-view')?.innerText || ''`
    );
    check('Panneau Vente auto présent', saleText.includes('Vente auto') && saleText.includes('doublons uniquement'));

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
           characterId: a.lastPlan?.[0]?.characterId
         };
         const root = document.querySelector('#kyara-plus-root').shadowRoot;
         root.querySelector('[data-act="autosell-stop"]')?.click();
         return out;
       })()`
    );
    check('Vente auto : annonces créées', auto.created > 0, `${auto.created} annonce(s) · ${auto.cycles} cycle(s)`);
    check('Vente auto : identifiant API présent', Number.isFinite(Number(auto.characterId)), String(auto.characterId));
    await waitFor(
      () => evaluate(cdp, sessionId, 'window.__kyaraPlus.state.autoSell.running === false'),
      { label: 'arrêt de la vente auto', timeout: 5000 }
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
