#!/usr/bin/env node
/*
 * Kyareeh+ — captures d'écran pour la fiche Chrome Web Store.
 *
 * Ouvre le harness local (API simulée, aucun compte) dans un Chrome headless,
 * masque les éléments de la page de test, nettoie les artefacts de version
 * (le harness n'a pas de manifeste) et capture cinq onglets en 1280 × 800,
 * le format demandé par le Chrome Web Store.
 *
 * Aucune donnée réelle n'apparaît : le harness utilise un compte et un marché
 * fictifs, codés dans test/harness.html.
 *
 * Sortie par défaut : ../_shots/store (hors dépôt, jamais publiée).
 *
 * Usage :
 *   node scripts/store-shots.mjs
 *   node scripts/store-shots.mjs --out "C:\chemin\captures"
 */

import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHROME =
  process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const HARNESS = 'http://127.0.0.1:8787/test/harness.html';
const TMP = process.env.TEMP || process.env.TMP || ROOT;

const outIdx = process.argv.indexOf('--out');
const OUT = outIdx > -1 && process.argv[outIdx + 1] ? resolve(process.argv[outIdx + 1]) : resolve(ROOT, '..', '_shots', 'store');

const TABS = [
  ['account', 'screenshot-1-compte.png'],
  ['duel', 'screenshot-2-duel.png'],
  ['market', 'screenshot-3-marche.png'],
  ['cards', 'screenshot-4-drop.png'],
  ['stat', 'screenshot-5-stat.png']
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function check(state, label, detail = '') {
  console.log(`  ${state === 'ok' ? '✓' : '·'} ${label}${detail ? ` (${detail})` : ''}`);
}

async function waitFor(fn, { timeout = 15000, interval = 150, label = 'condition' } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    try {
      const value = await fn();
      if (value) return value;
    } catch {
      /* on réessaie */
    }
    await sleep(interval);
  }
  throw new Error(`Délai dépassé : ${label}`);
}

function killTree(pid) {
  if (pid) spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
}

async function connect(port) {
  let info = null;
  await waitFor(
    async () => {
      info = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
      return Boolean(info?.webSocketDebuggerUrl);
    },
    { label: 'Chrome CDP' }
  );
  const ws = new WebSocket(info.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });
  let nextId = 0;
  const pending = new Map();
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (!msg.id || !pending.has(msg.id)) return;
    const { resolve: res, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(msg.error.message));
    else res(msg.result);
  };
  const send = (method, params = {}, sessionId) =>
    new Promise((res, rej) => {
      const id = ++nextId;
      pending.set(id, { resolve: res, reject: rej });
      ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  return { ws, send };
}

async function evaluate(cdp, sessionId, expression) {
  const { result, exceptionDetails } = await cdp.send(
    'Runtime.evaluate',
    { expression, awaitPromise: true, returnByValue: true },
    sessionId
  );
  if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || 'erreur JS');
  return result?.value;
}

async function main() {
  mkdirSync(OUT, { recursive: true });

  const server = spawn(process.execPath, [join(ROOT, 'test', 'server.cjs')], { cwd: ROOT, stdio: 'ignore' });
  const profile = join(TMP, 'kp-store-shots');
  rmSync(profile, { recursive: true, force: true });
  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      '--remote-debugging-port=9336',
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--hide-scrollbars',
      '--window-size=1280,800',
      'about:blank'
    ],
    { stdio: 'ignore' }
  );

  let cdp = null;
  try {
    cdp = await connect(9336);
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    await cdp.send('Runtime.enable', {}, sessionId);
    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Emulation.setDeviceMetricsOverride',
      { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false }, sessionId);
    await cdp.send('Page.navigate', { url: HARNESS }, sessionId);

    await waitFor(() => evaluate(cdp, sessionId, 'document.readyState === "complete"'), {
      label: 'chargement du harness'
    });
    await waitFor(() => evaluate(cdp, sessionId, 'Boolean(window.__kyaraPlus)'), { label: 'hook' });
    await waitFor(() => evaluate(cdp, sessionId, 'window.__kyaraPlus.state.ready === true'), {
      label: 'données du harness'
    });
    await sleep(1400); // laisse passer l'Alt+K automatique du harness

    /* Nettoie la page de test : on ne garde que le panneau, sur un fond neutre. */
    await evaluate(
      cdp,
      sessionId,
      `(() => {
         document.querySelectorAll('body > *').forEach((el) => {
           if (el.id !== 'kyara-plus-root') el.remove();
         });
         document.body.style.cssText =
           'margin:0;height:100vh;background:radial-gradient(1200px 700px at 25% 10%, #1b1e29 0%, #0b0c10 55%, #06070a 100%);';
         document.documentElement.style.background = '#0b0c10';
         return true;
       })()`
    );

    /* Le harness n'a pas de manifeste : on aligne les versions affichées. */
    await evaluate(
      cdp,
      sessionId,
      `(() => {
         const p = window.__kyaraPlus;
         const s = p.state;
         s.version = '2.3.2';
         s.manifestVersion = '2.3.2';
         s.manifestOutdated = false;
         s.update.version = null;
         s.update.error = null;
         s.update.checkedAt = Date.now();
         p.setOpen(true);
         p.render();
         const root = document.querySelector('#kyara-plus-root');
         const fab = root.shadowRoot.querySelector('.kp-fab');
         if (fab) fab.style.display = 'none';
         const panel = root.shadowRoot.querySelector('.kp-panel');
         panel.style.right = 'auto';
         panel.style.left = '50%';
         panel.style.transform = 'translateX(-50%)';
         panel.style.bottom = '24px';
         return true;
       })()`
    );

    for (const [tab, name] of TABS) {
      if (tab === 'duel') {
        /* Le duel est une application dans une iframe : on lance un entraînement
         * contre l'IA (aucun réseau, aucun salon à créer) pour une capture pleine. */
        const doc = `document.querySelector('#kyara-plus-root').shadowRoot.querySelector('iframe').contentDocument`;
        const clickInDuel = (selector) =>
          evaluate(
            cdp,
            sessionId,
            `(() => {
               const d = ${doc};
               const b = d && d.querySelector(${JSON.stringify(selector)});
               if (!b) return 'absent';
               if (b.disabled) return 'disabled';
               b.click();
               return 'ok';
             })()`
          );

        await evaluate(
          cdp,
          sessionId,
          `(() => {
             const b = document.querySelector('#kyara-plus-root').shadowRoot.querySelector('[data-act="mode"][data-mode="duel"]');
             if (b) b.click();
             return true;
           })()`
        );
        await waitFor(
          () => evaluate(cdp, sessionId, `Boolean(${doc}?.body?.innerText.includes('COLLECTION'))`),
          { label: 'application du duel' }
        );

        check(await clickInDuel('[data-act="fill"]'), 'Compléter l’équipe', 'remplissage auto');
        await sleep(700);
        await clickInDuel('[data-act="screen"][data-screen="salon"]');
        await sleep(700);
        check(await clickInDuel('[data-act="practice"]'), 'Lancer l’entraînement', 'contre l’IA');
        await waitFor(
          () => evaluate(cdp, sessionId, `Boolean(${doc}?.body?.innerText.includes('TOUR'))`),
          { timeout: 15000, label: 'combat du duel' }
        );
        await sleep(1800);
      } else {
        await evaluate(cdp, sessionId, `window.__kyaraPlus.setTab(${JSON.stringify(tab)})`);
        await sleep(500);
        await evaluate(cdp, sessionId, 'window.__kyaraPlus.setOpen(true)');
        await waitFor(
          () => evaluate(
            cdp,
            sessionId,
            `(() => {
               const view = document.querySelector('#kyara-plus-root').shadowRoot.querySelector('#kp-view');
               if (!view || view.innerText.length < 120) return false;
               if (/Calcul en cours|Chargement du march|Recherche…/i.test(view.innerText)) return false;
               return true;
             })()`
          ),
          { timeout: 20000, label: `vue ${tab}` }
        );
        await sleep(900);
      }

      /* Certaines illustrations du harness pointent vers des URLs mortes :
       * on les remplace par une vignette neutre pour éviter les icônes cassées. */
      await evaluate(
        cdp,
        sessionId,
        `(() => {
           const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="128">' +
             '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">' +
             '<stop offset="0" stop-color="#2a2e3a"/><stop offset="1" stop-color="#15171f"/></linearGradient></defs>' +
             '<rect width="96" height="128" fill="url(#g)"/>' +
             '<text x="48" y="76" font-family="Segoe UI, sans-serif" font-size="40" fill="#ff8a6d" text-anchor="middle">◆</text></svg>';
           const ph = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
           const imgs = [...document.querySelectorAll('#kyara-plus-root')]
             .flatMap((root) => [...root.shadowRoot.querySelectorAll('img')]);
           for (const img of imgs) {
             if (img.complete && img.naturalWidth === 0) img.src = ph;
           }
           return imgs.length;
         })()`
      );
      await sleep(400);

      /* Laisse les illustrations restantes finir de charger. */
      await waitFor(
        () => evaluate(
          cdp,
          sessionId,
          `(() => {
             const imgs = [...document.querySelectorAll('#kyara-plus-root')]
               .flatMap((root) => [...root.shadowRoot.querySelectorAll('img')]);
             return imgs.every((img) => img.complete && img.naturalWidth > 0);
           })()`
        ),
        { timeout: 12000, label: `images de ${tab}` }
      ).catch(() => {});

      /* La fiche met en avant les duels : on retire l'onglet Auto-Open de la
       * barre pour la capture (aucune autre modification de l'interface). */
      await evaluate(
        cdp,
        sessionId,
        `(() => {
           const b = document.querySelector('#kyara-plus-root').shadowRoot.querySelector('#kp-tabs button[data-tab="auto"]');
           if (b) b.style.display = 'none';
           return true;
         })()`
      );
      await sleep(150);

      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId);
      const file = join(OUT, name);
      writeFileSync(file, Buffer.from(shot.data, 'base64'));

      /* Variante recadrée sur le panneau : sert aux visuels promotionnels. */
      const rect = await evaluate(
        cdp,
        sessionId,
        `(() => {
           const panel = document.querySelector('#kyara-plus-root').shadowRoot.querySelector('.kp-panel');
           const r = panel.getBoundingClientRect();
           return { x: r.x, y: r.y, width: r.width, height: r.height };
         })()`
      );
      const cropped = await cdp.send(
        'Page.captureScreenshot',
        {
          format: 'png',
          clip: {
            x: Math.floor(rect.x),
            y: Math.floor(rect.y),
            width: Math.ceil(rect.width),
            height: Math.ceil(rect.height),
            scale: 1
          }
        },
        sessionId
      );
      writeFileSync(join(OUT, name.replace(/^screenshot-/, 'panel-')), Buffer.from(cropped.data, 'base64'));
      console.log(`✓ ${tab.padEnd(8)} → ${file}`);

      if (tab === 'duel') {
        await evaluate(
          cdp,
          sessionId,
          `(() => {
             const b = document.querySelector('#kyara-plus-root').shadowRoot.querySelector('[data-act="mode"][data-mode="tools"]');
             if (b) b.click();
             return true;
           })()`
        );
        await sleep(600);
      }
    }
  } finally {
    cdp?.ws.close();
    killTree(chrome.pid);
    killTree(server.pid);
    await sleep(400);
    killTree(chrome.pid);
    killTree(server.pid);
  }
}

main().catch((err) => {
  console.error(`\n✗ ${err.message}`);
  process.exit(1);
});
