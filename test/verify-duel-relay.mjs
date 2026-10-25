// Vérifie le relais du duel v2 (relay/server.mjs) et le client réseau (content/duel-net.js).
// Démarre des relais en mémoire sur des ports libres (minuteurs raccourcis) et un relais en
// processus enfant (`node relay/server.mjs`, healthcheck), puis joue des duels complets avec
// l'IA du moteur et provoque les cas d'erreur du protocole v2 (docs/DUEL-SPEC.md §4,
// docs/DUEL-V2.md §2) : choix simultanés secrets, message `chosen`, phase de remplacement,
// délais par phase, reconnexion en plein choix, abandon, revanche, version de protocole.
//
// Moteur utilisé : DUEL_ENGINE si défini, sinon content/duel-engine.js s'il expose l'API v2,
// sinon le bouchon test/stub-duel-engine.cjs. `--stub` force le bouchon.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import netModule from 'node:net';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { configFromEnv, createRelay, engineMissing, loadData, loadEngine } from '../relay/server.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REAL_ENGINE = path.join(ROOT, 'content', 'duel-engine.js');
const STUB_ENGINE = path.join(ROOT, 'test', 'stub-duel-engine.cjs');

function realEngineIsV2() {
  if (!fs.existsSync(REAL_ENGINE)) return false;
  try {
    const mod = createRequire(import.meta.url)(REAL_ENGINE);
    return engineMissing(mod).length === 0;
  } catch {
    return false;
  }
}

const enginePath = process.env.DUEL_ENGINE
  ? path.resolve(process.env.DUEL_ENGINE)
  : process.argv.includes('--stub') || !realEngineIsV2()
    ? STUB_ENGINE
    : REAL_ENGINE;

const E = loadEngine(enginePath);
const data = loadData();
const NET = createRequire(import.meta.url)('../content/duel-net.js');
console.log(`Moteur : ${path.relative(ROOT, enginePath)}`);

let checks = 0;
let failures = 0;
function check(label, ok, detail = '') {
  checks += 1;
  if (!ok) {
    failures += 1;
    console.log(`ÉCHEC ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

const guard = setTimeout(() => {
  console.log('ÉCHEC délai global dépassé (180 s)');
  process.exit(1);
}, 180_000);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred, ms = 3000) {
  const t0 = Date.now();
  for (;;) {
    const v = pred();
    if (v) return v;
    if (Date.now() - t0 > ms) return null;
    await sleep(5);
  }
}

const mythics = data.champions.filter((c) => c.rarity === 'M');
const deckA = mythics.slice(0, 5).map((c) => c.id);
const deckB = mythics.slice(5, 10).map((c) => c.id);
const notMythic = data.champions.find((c) => c.rarity !== 'M');

// ---------------------------------------------------------------------------
// Client brut (WebSocket global de Node)
// ---------------------------------------------------------------------------

/** Tous les clients bruts créés : sert à vérifier, à la fin, qu'aucun choix secret n'a fuité. */
const allRaws = [];

class Raw {
  constructor(url) {
    this.inbox = []; // messages pas encore consommés par wait()
    this.log = []; // tous les messages reçus, dans l'ordre (jamais consommés)
    this.waiters = [];
    this.latest = null; // dernier message `state`
    this.pending = []; // joueurs qui doivent encore choisir (state / chosen)
    this.end = null;
    this.closeCode = null;
    this.ws = new WebSocket(url);
    allRaws.push(this);
    this.ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.t === 'welcome') this.token = m.token;
      if (m.t === 'state') {
        this.latest = m;
        this.pending = m.pending;
      }
      if (m.t === 'chosen') this.pending = m.pending;
      if (m.t === 'end') {
        this.end = m;
        this.pending = [];
      }
      this.log.push(m);
      this.inbox.push(m);
      this.flush();
    };
    this.ws.onclose = (ev) => {
      this.closeCode = ev.code;
    };
  }
  opened() {
    return new Promise((resolve, reject) => {
      if (this.ws.readyState === 1) return resolve(this);
      this.ws.addEventListener('open', () => resolve(this));
      this.ws.addEventListener('error', () => reject(new Error('connexion impossible')));
    });
  }
  send(o) {
    this.ws.send(typeof o === 'string' ? o : JSON.stringify(o));
  }
  flush() {
    this.waiters = this.waiters.filter((w) => {
      const i = this.inbox.findIndex(w.pred);
      if (i < 0) return true;
      clearTimeout(w.timer);
      w.resolve(this.inbox.splice(i, 1)[0]);
      return false;
    });
  }
  /** Attend (et consomme) le premier message qui correspond ; null après `ms`. */
  wait(pred, ms = 3000) {
    const p = typeof pred === 'string' ? (m) => m.t === pred : pred;
    return new Promise((resolve) => {
      const w = { pred: p, resolve };
      w.timer = setTimeout(() => {
        this.waiters = this.waiters.filter((x) => x !== w);
        resolve(null);
      }, ms);
      this.waiters.push(w);
      this.flush();
    });
  }
  err(code, ms) {
    return this.wait((m) => m.t === 'error' && m.code === code, ms);
  }
  /** Envoie une action du protocole avec le seq du dernier état connu. */
  act(action, seq = this.latest && this.latest.seq) {
    this.send({ t: 'action', seq, action });
  }
  close() {
    this.ws.close();
  }
}

async function client(url, name, deck) {
  const c = await new Raw(url).opened();
  if (name) {
    c.send({ t: 'hello', v: 2, name, deck });
    c.welcome = await c.wait('welcome');
  }
  return c;
}

async function startRelay(over = {}) {
  const relay = createRelay({ engine: E, data, log: false, ...over });
  const port = await relay.listen(0, '127.0.0.1');
  return { relay, url: `ws://127.0.0.1:${port}` };
}

/** Crée un salon à deux, puis les deux joueurs se déclarent prêts ; renvoie les sièges. */
async function pair(url) {
  const a = await client(url, 'Alice', deckA);
  const b = await client(url, 'Bruno', deckB);
  a.send({ t: 'create' });
  const room = await a.wait((m) => m.t === 'room' && m.status === 'waiting');
  b.send({ t: 'join', code: room.code });
  await a.wait((m) => m.t === 'room' && m.status === 'waiting' && m.players.length === 2);
  await b.wait((m) => m.t === 'room' && m.status === 'waiting' && m.players.length === 2);
  a.send({ t: 'ready', ready: true });
  b.send({ t: 'ready', ready: true });
  await a.wait((m) => m.t === 'state' && m.seq === 1);
  await b.wait((m) => m.t === 'state' && m.seq === 1);
  return { seats: [a, b], code: room.code };
}

const bothEnded = (seats) => Boolean(seats[0].end && seats[1].end);
const sameSeq = (seats) => Boolean(seats[0].latest && seats[1].latest && seats[0].latest.seq === seats[1].latest.seq);
const samePending = (seats) => JSON.stringify(seats[0].pending) === JSON.stringify(seats[1].pending);

/**
 * Joue avec chooseAction : à chaque étape, tous les joueurs en attente choisissent « en même temps ».
 * `pick(step, seat, st)` peut imposer une action ; `hook(step, seats)` peut réagir avant les choix
 * (et remplacer un siège après reconnexion) ; `until(seats, step)` arrête la partie avant la fin.
 */
async function playOut(seats, { pick, hook, until } = {}) {
  let steps = 0;
  for (; steps < 800; steps += 1) {
    const ok = await waitFor(() => bothEnded(seats) || (sameSeq(seats) && samePending(seats)));
    if (!ok) return { steps, stuck: true };
    if (bothEnded(seats)) break;
    if (seats[0].latest.phase === 'ended') {
      await waitFor(() => bothEnded(seats));
      break;
    }
    if (until && until(seats, steps)) return { steps, stuck: false, stopped: true };
    if (hook) await hook(steps, seats);
    const seq = seats[0].latest.seq;
    const todo = seats[0].pending.filter((p) => !seats[p].locked || seats[p].locked !== seq);
    for (const p of todo) {
      const st = seats[p].latest;
      const action = (pick && pick(steps, p, st)) || E.chooseAction(st.state, p);
      seats[p].act(action, st.seq);
      seats[p].locked = seq;
    }
    await waitFor(() => bothEnded(seats) || (seats[0].latest.seq > seq && seats[1].latest.seq > seq));
  }
  return { steps, stuck: false };
}

// ---------------------------------------------------------------------------
// 1. Processus enfant : node relay/server.mjs + healthcheck + variables d'environnement
// ---------------------------------------------------------------------------

async function freePort() {
  return new Promise((resolve) => {
    const s = netModule.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

async function testChildProcess() {
  const cfg = configFromEnv({ DUEL_CHOOSE_MS: '111', DUEL_REPLACE_MS: '222', DUEL_TURN_MS: '999' });
  check('env : DUEL_CHOOSE_MS / DUEL_REPLACE_MS lus', cfg.chooseMs === 111 && cfg.replaceMs === 222, `${cfg.chooseMs}/${cfg.replaceMs}`);
  const def = configFromEnv({});
  check('env : délais par défaut 45 s (choix) et 20 s (remplacement)', def.chooseMs === 45_000 && def.replaceMs === 20_000, `${def.chooseMs}/${def.replaceMs}`);
  check('env : ancien DUEL_TURN_MS accepté pour le choix', configFromEnv({ DUEL_TURN_MS: '999' }).chooseMs === 999);

  const port = await freePort();
  const child = spawn(process.execPath, ['relay/server.mjs'], {
    cwd: ROOT,
    // Minuteurs raccourcis par variables d'environnement (vérifie leur prise en compte).
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DUEL_ENGINE: enginePath, DUEL_LOG: '0', DUEL_CHOOSE_MS: '300', DUEL_REPLACE_MS: '200', DUEL_GRACE_MS: '400', DUEL_MAX_TIMEOUTS: '99' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  let health = null;
  const t0 = Date.now();
  while (!health && Date.now() - t0 < 8000) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`);
      health = { status: res.status, text: await res.text() };
    } catch {
      await sleep(100);
    }
  }
  check('processus : GET / répond 200 « ok »', health && health.status === 200 && health.text === 'ok', JSON.stringify(health) + out);
  if (health) {
    const res = await fetch(`http://127.0.0.1:${port}/inconnu`);
    check('processus : autre chemin → 404', res.status === 404);
    const c = await client(`ws://127.0.0.1:${port}`, 'Enfant', deckA);
    check('processus : hello → welcome avec jeton', c.welcome && typeof c.welcome.token === 'string' && c.welcome.token.length >= 32);
    c.close();
    const { seats } = await pair(`ws://127.0.0.1:${port}`);
    const s0 = seats[0].latest;
    check('processus : DUEL_CHOOSE_MS appliqué (deadline ≤ 300 ms)', s0 && s0.deadline > 0 && s0.deadline <= 300, String(s0 && s0.deadline));
    const auto = await seats[0].wait((m) => m.t === 'state' && m.last && m.last.auto && m.last.auto[0] === true, 3000);
    check('processus : délai de choix → pass automatique des deux joueurs', auto && auto.last.actions.every((a) => a && a.type === 'pass'), JSON.stringify(auto && auto.last));
    seats[1].close();
    const end = await seats[0].wait('end', 3000);
    check('processus : DUEL_GRACE_MS appliqué (forfait après déconnexion)', end && end.reason === 'forfeit' && end.winner === 0, JSON.stringify(end));
    seats[0].close();
  }
  child.kill();
}

// ---------------------------------------------------------------------------
// 2. Protocole, erreurs, choix simultanés secrets
// ---------------------------------------------------------------------------

async function testRobustness() {
  const { relay, url } = await startRelay({ chooseMs: 30_000, graceMs: 5000, maxMessage: 8192 });

  // Robustesse des messages
  const x = await client(url);
  x.send({ t: 'create' });
  check('create sans hello → hello_required', await x.err('hello_required'));
  x.send('pas du json{');
  const bj = await x.err('bad_json');
  check('JSON invalide → bad_json avec message français', bj && typeof bj.message === 'string' && bj.message.includes('invalide'), JSON.stringify(bj));
  x.send('[1,2]');
  check('tableau → bad_message', await x.err('bad_message'));
  x.send({ t: 'nimporte' });
  check('type inconnu → unknown_type', await x.err('unknown_type'));
  x.send({ t: 'ping', pad: 'x'.repeat(9000) });
  check('message > 8 Kio → too_large', await x.err('too_large'));
  x.send({ t: 'ping' });
  check('connexion toujours ouverte après les erreurs (pong)', await x.wait('pong'));
  check('aucune erreur en trop', (await x.wait('error', 50)) === null);
  x.send({ t: 'ping', pad: 'x'.repeat(40_000) });
  check('message > 4 × limite → connexion coupée', await waitFor(() => x.closeCode !== null, 2000), String(x.closeCode));

  // Version du protocole
  const v = await client(url);
  v.send({ t: 'hello', v: 1, name: 'Ancien', deck: deckA });
  const v1 = await v.err('version');
  check('hello v1 → erreur version (attendue : 2)', v1 && v1.expected === 2 && /2/.test(v1.message), JSON.stringify(v1));
  v.send({ t: 'hello', v: 3, name: 'Futur', deck: deckA });
  check('hello v3 → erreur version', await v.err('version'));
  v.send({ t: 'hello', name: 'Sans version', deck: deckA });
  check('hello sans v → erreur version', await v.err('version'));
  v.send({ t: 'create' });
  check('après une version refusée, create → hello_required', await v.err('hello_required'));
  v.send({ t: 'hello', v: 2, name: 'Moderne', deck: deckA });
  const vw = await v.wait('welcome');
  check('hello v2 → welcome (v: 2)', vw && vw.v === 2 && typeof vw.token === 'string');
  v.close();

  // Débit
  const r = await client(url, 'Bavard', deckA);
  for (let i = 0; i < 80; i += 1) r.send({ t: 'ping' });
  check('rafale de 80 messages → rate_limited', await r.err('rate_limited'));
  await sleep(50);
  const pongs = r.inbox.filter((m) => m.t === 'pong').length;
  check('rafale : au plus ~20 messages traités', pongs <= 25, `${pongs} pong`);
  await sleep(1200);
  r.inbox.length = 0;
  r.send({ t: 'ping' });
  check('débit rétabli après une pause', await r.wait('pong'));
  r.close();

  // Decks invalides
  const d = await client(url, 'Tricheur', null);
  d.send({ t: 'create' });
  check('create sans deck → deck_invalid', await d.err('deck_invalid'));
  d.send({ t: 'create', deck: deckA.slice(0, 4) });
  const e4 = await d.err('deck_invalid');
  check('deck de 4 cartes → deck_invalid (message français)', e4 && /[a-zé]/i.test(e4.message || ''), JSON.stringify(e4));
  d.send({ t: 'create', deck: [deckA[0], deckA[0], deckA[1], deckA[2], deckA[3]] });
  check('deck avec doublon → deck_invalid', await d.err('deck_invalid'));
  if (notMythic) {
    d.send({ t: 'create', deck: [notMythic.id, ...deckA.slice(0, 4)] });
    check('deck avec une non-Mythique → deck_invalid', await d.err('deck_invalid'));
  }
  d.send({ t: 'create', deck: [999999999, ...deckA.slice(0, 4)] });
  check('deck avec une carte inconnue → deck_invalid', await d.err('deck_invalid'));
  d.send({ t: 'join', code: 'ZZZZZ' });
  check('code inconnu → unknown_room', await d.err('unknown_room'));
  d.send({ t: 'join', code: 'abc' });
  check('code mal formé → unknown_room', await d.err('unknown_room'));
  d.send({ t: 'action', seq: 1, action: { type: 'pass' } });
  check('action hors salon → not_in_room', await d.err('not_in_room'));
  d.send({ t: 'rejoin', code: 'ABCDE', token: 'faux' });
  check('rejoin avec jeton inconnu → rejoin_failed', await d.err('rejoin_failed'));

  // Salon en attente : pas d'action possible
  const a = await client(url, 'Alice', deckA);
  const b = await client(url, 'Bruno', deckB);
  a.send({ t: 'create' });
  const room = await a.wait((m) => m.t === 'room');
  check('create → room waiting, code de 5 lettres sans I/O', room && room.status === 'waiting' && /^[A-HJ-NP-Z]{5}$/.test(room.code), JSON.stringify(room));
  a.send({ t: 'action', seq: 0, action: { type: 'pass' } });
  check('action dans un salon en attente → not_playing', await a.err('not_playing'));
  b.send({ t: 'join', code: room.code.toLowerCase() });
  const wa = await a.wait((m) => m.t === 'room' && m.status === 'waiting' && m.players.length === 2);
  const wb = await b.wait((m) => m.t === 'room' && m.status === 'waiting' && m.players.length === 2);
  check('join (minuscules acceptées) → salon en attente, deux joueurs', wa && wb && wb.you === 1, JSON.stringify(wb));
  check('room : noms des joueurs', wa && wa.players.map((p) => p.name).join(',') === 'Alice,Bruno');
  check('room : les deux joueurs sont « pas prêt » par défaut', wa.players.every((p) => p.ready === false));
  a.send({ t: 'ready', ready: true });
  const half = await a.wait((m) => m.t === 'room' && m.players.some((p) => p.seat === 0 && p.ready));
  check('un seul joueur prêt → le duel ne démarre pas', half && half.status === 'waiting');
  b.send({ t: 'ready', ready: true });
  const ra = await a.wait((m) => m.t === 'room' && m.status === 'playing');
  const rb = await b.wait((m) => m.t === 'room' && m.status === 'playing');
  check('les deux joueurs prêts → room playing pour les deux', ra && rb && ra.players.length === 2, JSON.stringify(rb));
  const sa = await a.wait('state');
  const sb = await b.wait('state');
  check('state initial seq 1 avec you 0/1', sa && sb && sa.seq === 1 && sb.seq === 1 && sa.you === 0 && sb.you === 1);
  check('state v2 : phase « choose », pending = les deux joueurs', sa.phase === 'choose' && sa.pending.length === 2 && sb.pending.length === 2, JSON.stringify([sa.phase, sa.pending]));
  check('state v2 : chosen vide et choice nul au départ', sa.chosen.length === 0 && sa.choice === null && sb.choice === null);
  check('state : deadline ≤ délai de choix', sa.deadline > 0 && sa.deadline <= 30_000, String(sa.deadline));
  check('state : état JSON du moteur (2 joueurs, 5 champions)', sa.state.players.length === 2 && sa.state.players.every((p) => p.champions.length === 5));
  check('state : legal fourni aux DEUX joueurs (choix simultanés)', sa.legal.length > 0 && sb.legal.length > 0);
  check('state : legal contient pass et au moins un changement', sa.legal.some((x) => x.type === 'pass') && sa.legal.some((x) => x.type === 'switch'));
  const c = await client(url, 'Chloé', deckA);
  c.send({ t: 'join', code: room.code });
  check('3e joueur → room_full', await c.err('room_full'));
  c.close();

  // Actions illégales / périmées
  const seats = [a, b];
  a.act({ type: 'move', actor: 99, move: 0, target: { side: 0, index: 0 } }, 0);
  const stale = await a.err('stale_seq');
  check('mauvais seq → stale_seq (avec seq courant)', stale && stale.seq === 1, JSON.stringify(stale));
  check('mauvais seq → état renvoyé', await a.wait((m) => m.t === 'state' && m.seq === 1));
  a.act({ type: 'move', actor: 99, move: 99, target: { side: 0, index: 0 } });
  check('capacité inexistante → illegal_action', await a.err('illegal_action'));
  a.act({ type: 'switch', to: 9 });
  check('changement vers un banc inexistant → illegal_action', await a.err('illegal_action'));
  const activeA = sa.state.players[0].active;
  a.act({ type: 'switch', to: activeA });
  check('changement vers le champion déjà actif → illegal_action', await a.err('illegal_action'));
  a.act({ type: 'tricher' });
  check('type d’action inconnu → illegal_action', await a.err('illegal_action'));
  a.act('n’importe quoi');
  check('action non objet → illegal_action', await a.err('illegal_action'));
  a.send({ t: 'action', seq: 1 });
  check('action absente → illegal_action', await a.err('illegal_action'));
  check('aucune action refusée n’a avancé le duel', seats[0].latest.seq === 1 && seats[1].latest.seq === 1 && !a.log.some((m) => m.t === 'chosen'));

  // --- Choix secret : A verrouille, B ne doit rien apprendre -----------------------------------
  const secret = sa.legal.find((x) => x.type === 'switch' && x.to === 3) || sa.legal.find((x) => x.type === 'switch');
  b.inbox.length = 0;
  a.inbox.length = 0;
  const mark = b.log.length;
  a.act(secret);
  const ca = await a.wait('chosen');
  check('chosen : l’auteur reçoit son propre choix', ca && ca.player === 0 && ca.action && ca.action.type === 'switch' && ca.action.to === secret.to, JSON.stringify(ca));
  check('chosen : pending ne contient plus que B, chosen = [A]', ca && JSON.stringify(ca.pending) === '[1]' && JSON.stringify(ca.chosen) === '[0]', JSON.stringify(ca));
  const cb = await b.wait('chosen');
  check('chosen : l’adversaire est prévenu (player 0)', cb && cb.player === 0 && JSON.stringify(cb.pending) === '[1]' && JSON.stringify(cb.chosen) === '[0]', JSON.stringify(cb));
  check('chosen : l’adversaire ne reçoit NI action NI choix', cb && !('action' in cb) && !('choice' in cb) && !JSON.stringify(cb).includes('"switch"'), JSON.stringify(cb));
  await sleep(150);
  const seen = b.log.slice(mark);
  check('secret : seul `chosen` parvient à B avant la résolution (pas d’état, pas d’événement)', seen.length === 1 && seen[0].t === 'chosen', seen.map((m) => m.t).join(','));
  check('chosen : le tour n’est pas résolu (seq inchangé)', a.latest.seq === 1 && b.latest.seq === 1);
  a.act(secret);
  check('un choix verrouillé ne se change pas → already_chosen', await a.err('already_chosen'));
  a.act({ type: 'pass' });
  check('second choix différent → already_chosen aussi', await a.err('already_chosen'));
  // B redemande l'état (seq périmé volontaire) : le choix de A ne doit pas y figurer.
  b.act({ type: 'pass' }, 0);
  await b.err('stale_seq');
  const resent = await b.wait((m) => m.t === 'state' && m.seq === 1);
  const flat = JSON.stringify({ ...resent, legal: undefined });
  check('secret : l’état renvoyé à B ne contient aucun changement (type switch)', resent && !flat.includes('"type":"switch"'), flat.slice(0, 200));
  check('secret : state.choices[A] masqué dans la vue de B (null ou hidden)', resent && (!resent.state.choices || !resent.state.choices[0] || resent.state.choices[0].type === 'hidden'), JSON.stringify(resent && resent.state.choices));
  check('secret : B voit chosen = [A], son propre choix est vide', resent && JSON.stringify(resent.chosen) === '[0]' && resent.choice === null && JSON.stringify(resent.pending) === '[1]');
  check('secret : B garde ses actions légales', resent && resent.legal.length > 0);

  // Reconnexion de A (choix verrouillé) : le choix est conservé, A n'a plus rien à choisir.
  const tokenA = a.token;
  a.close();
  check('coupure de A → B reçoit peer left', await b.wait((m) => m.t === 'peer' && m.status === 'left'));
  const a2 = await new Raw(url).opened();
  a2.send({ t: 'rejoin', code: room.code, token: tokenA });
  const w2 = await a2.wait('welcome');
  check('rejoin → welcome (même jeton, rejoined)', w2 && w2.token === tokenA && w2.rejoined === true, JSON.stringify(w2));
  const rs = await a2.wait('state');
  check('rejoin en plein choix : choix conservé (state.choice)', rs && rs.choice && rs.choice.type === 'switch' && rs.choice.to === secret.to, JSON.stringify(rs && rs.choice));
  check('rejoin en plein choix : A n’est plus pending, plus de legal', rs && JSON.stringify(rs.pending) === '[1]' && JSON.stringify(rs.chosen) === '[0]' && rs.legal.length === 0, JSON.stringify(rs && [rs.pending, rs.legal.length]));
  check('rejoin en plein choix : même seq, deadline renvoyée', rs && rs.seq === 1 && rs.deadline > 0);
  check('rejoin → B reçoit peer back', await b.wait((m) => m.t === 'peer' && m.status === 'back'));
  seats[0] = a2;

  // Reconnexion de B (pas encore verrouillé) : il choisit ensuite normalement.
  const tokenB = b.token;
  b.close();
  await a2.wait((m) => m.t === 'peer' && m.status === 'left');
  const b2 = await new Raw(url).opened();
  b2.send({ t: 'rejoin', code: room.code, token: tokenB });
  await b2.wait('welcome');
  const rsb = await b2.wait('state');
  check('rejoin de B : pending = [B], chosen = [A], choice nul', rsb && JSON.stringify(rsb.pending) === '[1]' && JSON.stringify(rsb.chosen) === '[0]' && rsb.choice === null, JSON.stringify(rsb && [rsb.pending, rsb.chosen, rsb.choice]));
  check('rejoin de B : legal complet', rsb && rsb.legal.length > 0);
  check('rejoin de B : la vue ne contient toujours pas le choix de A', rsb && !JSON.stringify({ ...rsb, legal: undefined }).includes('"type":"switch"'));
  seats[1] = b2;

  // B choisit à son tour : le tour est résolu, un seul `state` part à chacun, avec tous les événements.
  a2.inbox.length = 0;
  b2.inbox.length = 0;
  const bAction = rsb.legal.find((x) => x.type === 'pass') || rsb.legal[0];
  b2.act(bAction);
  const ra2 = await a2.wait((m) => m.t === 'state' && m.seq === 2);
  const rb2 = await b2.wait((m) => m.t === 'state' && m.seq === 2);
  check('résolution : state seq 2 envoyé aux deux joueurs', ra2 && rb2);
  check('résolution : last.actions révèle les deux choix (après coup)', ra2 && ra2.last.actions[0].type === 'switch' && ra2.last.actions[0].to === secret.to && ra2.last.actions[1].type === bAction.type, JSON.stringify(ra2 && ra2.last));
  check('résolution : last.auto = [false, false], last.phase = choose', ra2 && ra2.last.auto.every((x) => x === false) && ra2.last.phase === 'choose');
  check('résolution : événements identiques pour les deux joueurs', ra2 && rb2 && JSON.stringify(ra2.events) === JSON.stringify(rb2.events) && ra2.events.length > 0);
  check('résolution : le changement apparaît dans les événements', ra2 && ra2.events.some((e) => e.type === 'switch'), ra2 && ra2.events.map((e) => e.type).join(','));
  check('résolution : nouvelle phase, deux joueurs à nouveau en attente, chosen vide', ra2 && ra2.phase === 'choose' && ra2.pending.length === 2 && ra2.chosen.length === 0 && ra2.choice === null);
  check('résolution : le champion actif de A a changé', ra2 && ra2.state.players[0].active === secret.to, String(ra2 && ra2.state.players[0].active));
  check('résolution : un seul state par joueur pour ce tour', a2.log.filter((m) => m.t === 'state' && m.seq === 2).length === 1 && b2.log.filter((m) => m.t === 'state' && m.seq === 2).length === 1);

  // Hors tour / hors phase : B a choisi, il ne peut plus rejouer ; un tour plus tard A n'a pas choisi.
  const choiceB2 = rb2.legal.find((x) => x.type === 'pass');
  b2.act(choiceB2);
  await b2.wait('chosen');
  b2.act(choiceB2);
  check('rejouer après avoir choisi → already_chosen', await b2.err('already_chosen'));

  // Abandon en plein choix
  a2.inbox.length = 0;
  b2.inbox.length = 0;
  a2.send({ t: 'leave' });
  const fst = await b2.wait((m) => m.t === 'state' && m.state.winner === 1);
  check('leave en plein choix → état final diffusé (winner, last.forfeit)', fst && fst.seq === 3 && fst.phase === 'ended' && fst.last && fst.last.forfeit === 'forfeit' && fst.legal.length === 0 && fst.deadline === null && fst.pending.length === 0, JSON.stringify(fst && [fst.seq, fst.phase, fst.last]));
  if (typeof E.forfeit === 'function') check('leave : événement forfeit du moteur diffusé', fst && fst.events.some((e) => e.type === 'forfeit'));
  const fend = await b2.wait('end');
  check('leave en plein duel → défaite par forfait (adversaire)', fend && fend.reason === 'forfeit' && fend.winner === 1, JSON.stringify(fend));
  const lend = await a2.wait('end');
  check('leave → le partant reçoit aussi end', lend && lend.reason === 'forfeit' && lend.winner === 1);
  const wroom = await b2.wait((m) => m.t === 'room' && m.status === 'waiting');
  check('après départ → salon de nouveau en attente (même code)', wroom && wroom.code === room.code && wroom.players.length === 1 && wroom.you === 0);
  check('le partant ne reçoit plus les nouvelles du salon', (await a2.wait((m) => m.t === 'room', 200)) === null);
  a2.close();
  b2.close();
  x.close();
  d.close();
  await relay.close();
}

// ---------------------------------------------------------------------------
// 3. Duel complet : changements, remplacement après K.O., revanche
// ---------------------------------------------------------------------------

async function testFullMatch() {
  const { relay, url } = await startRelay({ chooseMs: 30_000, replaceMs: 30_000, graceMs: 5000 });
  const { seats, code } = await pair(url);

  const sawReplace = { done: false, checks: [] };
  let reconnected = false;
  const forced = { 0: null, 1: null }; // changements imposés
  const result = await playOut(seats, {
    // Aux étapes 2 (A) et 4 (B), un changement volontaire ; à l'étape 5, les deux changent en même temps.
    pick(step, p, st) {
      if (st.phase !== 'choose') return null;
      const want = (step === 2 && p === 0) || (step === 4 && p === 1) || step === 5;
      if (!want) return null;
      const sw = st.legal.find((a) => a.type === 'switch');
      if (sw) forced[p] = (forced[p] || 0) + 1;
      return sw || null;
    },
    async hook(step, s) {
      const st = s[0].latest;
      if (st.phase === 'replace' && !sawReplace.done) {
        sawReplace.done = true;
        const pend = st.pending;
        const other = [0, 1].find((p) => !pend.includes(p));
        const koed = pend[0];
        sawReplace.checks.push(['replace : au moins un joueur attendu', pend.length >= 1]);
        sawReplace.checks.push(['replace : le champion actif du joueur attendu est K.O.', pend.every((p) => !st.state.players[p].champions[st.state.players[p].active].alive)]);
        sawReplace.checks.push(['replace : legal = uniquement des changements vers un vivant', pend.every((p) => s[p].latest.legal.length > 0 && s[p].latest.legal.every((a) => a.type === 'switch' && st.state.players[p].champions[a.to].alive))]);
        sawReplace.checks.push(['replace : delai de remplacement dans la deadline', st.deadline > 0 && st.deadline <= 30_000]);
        // Action de capacité / passer refusée pendant le remplacement.
        s[koed].act({ type: 'pass' });
        sawReplace.checks.push(['replace : pass refusé (illegal_action)', Boolean(await s[koed].err('illegal_action'))]);
        s[koed].act({ type: 'move', move: 0, target: { side: 1 - koed, index: 0 } });
        sawReplace.checks.push(['replace : capacité refusée (illegal_action)', Boolean(await s[koed].err('illegal_action'))]);
        const dead = st.state.players[koed].champions.findIndex((c) => !c.alive);
        s[koed].act({ type: 'switch', to: dead });
        sawReplace.checks.push(['replace : changement vers un K.O. refusé', Boolean(await s[koed].err('illegal_action'))]);
        if (other !== undefined) {
          s[other].act({ type: 'pass' });
          sawReplace.checks.push(['replace : l’autre joueur n’a rien à choisir (not_your_turn)', Boolean(await s[other].err('not_your_turn'))]);
          sawReplace.checks.push(['replace : l’autre joueur a un legal vide', s[other].latest.legal.length === 0]);
        }
      }
      // Coupure puis reconnexion d'un joueur qui a déjà verrouillé son choix, en plein duel.
      if (step === 8 && !reconnected && st.phase === 'choose' && st.pending.length === 2) {
        reconnected = true;
        const victim = s[0];
        const other = s[1];
        const seq = victim.latest.seq;
        const action = E.chooseAction(victim.latest.state, 0);
        victim.act(action);
        victim.locked = seq;
        await victim.wait('chosen');
        const token = victim.token;
        other.inbox.length = 0;
        victim.close();
        check('plein duel : coupure → l’adversaire reçoit peer left', await other.wait((m) => m.t === 'peer' && m.status === 'left'));
        const back = await new Raw(url).opened();
        back.send({ t: 'rejoin', code, token });
        await back.wait('welcome');
        const rs = await back.wait('state');
        check('plein duel : reconnexion → choix conservé et A non attendu', rs && rs.seq === seq && rs.choice && rs.choice.type === action.type && !rs.pending.includes(0));
        check('plein duel : reconnexion → l’adversaire reçoit peer back', await other.wait((m) => m.t === 'peer' && m.status === 'back'));
        back.locked = seq;
        s[0] = back;
      }
    }
  });

  check('duel complet sans blocage', !result.stuck, `bloqué à l’étape ${result.steps}`);
  check('reconnexion effectuée en cours de duel', reconnected);
  check('changements volontaires joués', forced[0] >= 1 && forced[1] >= 1, JSON.stringify(forced));
  check('phase de remplacement rencontrée après un K.O.', sawReplace.done);
  for (const [label, ok] of sawReplace.checks) check(label, ok);
  const [ea, eb] = [seats[0].end, seats[1].end];
  check('fin : message end pour les deux joueurs', ea && eb);
  const final = seats[0].latest.state;
  check('fin : vainqueur cohérent avec l’état', ea && ea.winner === final.winner && eb.winner === final.winner, `${ea && ea.winner} / ${final.winner}`);
  check('fin : raison ko ou rounds', ea && (ea.reason === 'ko' || ea.reason === 'rounds'), ea && ea.reason);
  check('fin : phase ended, personne en attente', seats[0].latest.phase === 'ended' && seats[0].latest.pending.length === 0 && E.pendingPlayers(final).length === 0);
  const allMsgs = [...seats[0].log, ...seats[1].log].filter((m) => m.t === 'state');
  check('fin : événements typés diffusés', allMsgs.some((m) => Array.isArray(m.events) && m.events.length > 0));
  check('duel : événements « switch » et « ko » vus', allMsgs.some((m) => m.events.some((e) => e.type === 'switch')) && allMsgs.some((m) => m.events.some((e) => e.type === 'ko')));
  check('duel : phases choose et replace toutes deux annoncées', allMsgs.some((m) => m.phase === 'choose') && allMsgs.some((m) => m.phase === 'replace'));
  check('duel : seq strictement croissant, identique pour les deux joueurs', (() => {
    const seqs = (r) => r.log.filter((m) => m.t === 'state' && m.events.length).map((m) => m.seq);
    return seqs(seats[1]).every((q, i, arr) => i === 0 || q > arr[i - 1]);
  })());
  const lines = allMsgs.flatMap((m) => m.events).map((e) => E.describeEvent(e));
  check('describeEvent sur les événements reçus → texte (au moins un non vide, jamais d’exception)', lines.every((l) => typeof l === 'string') && lines.some((l) => l.length > 0), String(lines.length));
  console.log(`Duel complet : ${result.steps} étapes, ${final.round} tours, vainqueur ${ea && ea.winner} (${ea && ea.reason})`);
  seats[0].act({ type: 'pass' });
  check('action après la fin → not_playing', await seats[0].err('not_playing'));

  // Revanche
  seats[0].end = seats[1].end = null;
  seats[0].send({ t: 'rematch' });
  const half = await seats[1].wait((m) => m.t === 'room' && m.status === 'ended' && m.players.some((p) => p.ready));
  check('revanche demandée par un joueur → room (ready)', half);
  seats[1].send({ t: 'rematch' });
  const re0 = await seats[0].wait((m) => m.t === 'state' && m.seq === 1);
  check('revanche acceptée → nouveau duel seq 1, phase choose', re0 && re0.state.winner === null && re0.phase === 'choose' && re0.pending.length === 2 && re0.legal.length > 0);
  const re1 = await seats[1].wait((m) => m.t === 'state' && m.seq === 1);
  check('revanche : les deux joueurs ont une vue de départ', re1 && re1.chosen.length === 0);
  const again = await playOut(seats, { until: (s, step) => step >= 3 });
  check('revanche : le nouveau duel se joue', !again.stuck && again.stopped);

  // Revanche refusée à un tiers / hors fin de duel
  seats[0].send({ t: 'rematch' });
  check('rematch en plein duel → not_playing', await seats[0].err('not_playing'));
  seats.forEach((s) => s.close());
  await relay.close();
}

// ---------------------------------------------------------------------------
// 4. Minuteurs : délai de choix, délai de remplacement, forfait, salon inactif
// ---------------------------------------------------------------------------

async function testTimers() {
  // Personne ne joue : pass automatique des deux, puis défaite « timeout » au 3e délai d'affilée.
  {
    const { relay, url } = await startRelay({ chooseMs: 200, replaceMs: 30_000, graceMs: 5000, maxTimeouts: 3 });
    const { seats } = await pair(url);
    const t0 = Date.now();
    const auto = await seats[0].wait((m) => m.t === 'state' && m.last && m.last.auto, 3000);
    const dt = Date.now() - t0;
    check('délai de choix → state avec les deux pass automatiques', auto && auto.seq === 2 && auto.last.actions.every((a) => a && a.type === 'pass') && auto.last.auto.every(Boolean), JSON.stringify(auto && auto.last));
    check('délai de choix respecté (≈ 200 ms, ni trop tôt ni trop tard)', dt >= 150 && dt < 1500, `${dt} ms`);
    check('délai de choix : la deadline repart à zéro pour le tour suivant', auto && auto.deadline > 0 && auto.deadline <= 200 && auto.pending.length === 2);
    const end = await seats[1].wait('end', 4000);
    check('délais répétés (3) → fin « timeout »', end && end.reason === 'timeout' && (end.winner === 0 || end.winner === 1), JSON.stringify(end));
    seats.forEach((s) => s.close());
    await relay.close();
  }
  // Un seul joueur joue : l'autre reçoit un pass automatique, le joueur actif garde son vrai choix.
  {
    const { relay, url } = await startRelay({ chooseMs: 300, graceMs: 5000, maxTimeouts: 3 });
    const { seats } = await pair(url);
    const st = seats[0].latest;
    const mv = st.legal.find((a) => a.type === 'move') || st.legal[0];
    seats[0].act(mv);
    const ch = await seats[1].wait('chosen');
    check('délai partiel : l’adversaire voit chosen avant l’expiration', ch && ch.player === 0 && ch.auto === false);
    const res = await seats[1].wait((m) => m.t === 'state' && m.seq === 2, 3000);
    check('délai partiel : choix réel de A + pass automatique de B', res && res.last.auto[0] === false && res.last.auto[1] === true && res.last.actions[0].type === mv.type && res.last.actions[1].type === 'pass', JSON.stringify(res && res.last));
    check('délai partiel : les deux joueurs reçoivent le même tour', (await seats[0].wait((m) => m.t === 'state' && m.seq === 2)) !== null);
    // B vient de perdre un tour (compteur 1). Il joue normalement (compteur remis à 0), puis perd
    // deux tours de suite (compteur 2 < 3) : sans remise à zéro, il aurait été battu (1 + 2 = 3).
    const turn = async (bPlays) => {
      const cur = seats[0].latest;
      seats[0].act(cur.legal.find((x) => x.type === 'pass'), cur.seq);
      if (bPlays) seats[1].act(seats[1].latest.legal.find((x) => x.type === 'pass'), seats[1].latest.seq);
      await seats[0].wait((m) => m.t === 'state' && m.seq === cur.seq + 1, 2000);
    };
    await turn(true);
    await turn(false);
    await turn(false);
    check('délais non consécutifs → pas de défaite (compteur remis à zéro par un vrai choix)', !seats[0].end && !seats[1].end);
    seats.forEach((s) => s.close());
    await relay.close();
  }
  // Délai de remplacement : premier remplaçant vivant automatique.
  {
    const { relay, url } = await startRelay({ chooseMs: 30_000, replaceMs: 250, graceMs: 5000, maxTimeouts: 3 });
    const { seats } = await pair(url);
    const reached = await playOut(seats, { until: (s) => s[0].latest.phase === 'replace' });
    check('délai de remplacement : phase replace atteinte', reached.stopped, `étape ${reached.steps}`);
    if (reached.stopped) {
      const st = seats[0].latest;
      check('délai de remplacement : deadline ≤ 250 ms (et non 30 s)', st.deadline > 0 && st.deadline <= 250, String(st.deadline));
      const pend = st.pending.slice();
      const expectTo = Object.fromEntries(pend.map((p) => {
        const me = st.state.players[p];
        return [p, me.champions.findIndex((c, j) => c.alive && j !== me.active)];
      }));
      const nxt = await seats[0].wait((m) => m.t === 'state' && m.seq > st.seq, 3000);
      check('délai de remplacement : state suivant avec choix automatique', nxt && nxt.last.phase === 'replace' && pend.every((p) => nxt.last.auto[p] === true), JSON.stringify(nxt && nxt.last));
      check('délai de remplacement : premier champion vivant du banc', nxt && pend.every((p) => nxt.last.actions[p] && nxt.last.actions[p].type === 'switch' && nxt.last.actions[p].to === expectTo[p]), JSON.stringify([nxt && nxt.last.actions, expectTo]));
      check('délai de remplacement : retour en phase choose avec deux joueurs en attente', nxt && nxt.phase === 'choose' && nxt.pending.length === 2 && nxt.events.some((e) => e.type === 'switch'));
      check('délai de remplacement : le champion remplaçant est actif et vivant', nxt && pend.every((p) => nxt.state.players[p].active === expectTo[p] && nxt.state.players[p].champions[expectTo[p]].alive));
    }
    seats.forEach((s) => s.close());
    await relay.close();
  }
  // Remplacement : le joueur attendu agit avant le délai, l'autre n'est pas attendu.
  {
    const { relay, url } = await startRelay({ chooseMs: 30_000, replaceMs: 30_000, graceMs: 5000 });
    const { seats } = await pair(url);
    const reached = await playOut(seats, { until: (s) => s[0].latest.phase === 'replace' });
    if (reached.stopped) {
      const st = seats[0].latest;
      const p = st.pending[0];
      const to = st.legal.length ? st.legal[0].to : seats[p].latest.legal[0].to;
      const pick = seats[p].latest.legal.find((a) => a.to === to) || seats[p].latest.legal[0];
      seats[p].act(pick);
      if (st.pending.length === 1) {
        const nxt = await seats[1 - p].wait((m) => m.t === 'state' && m.seq > st.seq);
        check('remplacement choisi : state suivant en phase choose, seul le K.O. a changé', nxt && nxt.phase === 'choose' && nxt.last.actions[p].type === 'switch' && nxt.last.auto[p] === false, JSON.stringify(nxt && nxt.last));
      } else {
        check('remplacement double : chosen diffusé à l’autre', await seats[1 - p].wait('chosen'));
      }
    } else check('remplacement choisi : phase replace atteinte', false);
    seats.forEach((s) => s.close());
    await relay.close();
  }
  // Forfait après déconnexion prolongée.
  {
    const { relay, url } = await startRelay({ chooseMs: 30_000, graceMs: 300 });
    const { seats } = await pair(url);
    seats[0].act({ type: 'pass' });
    await seats[0].wait('chosen');
    seats[0].close();
    check('déconnexion → peer left', await seats[1].wait((m) => m.t === 'peer' && m.status === 'left'));
    const end = await seats[1].wait('end', 3000);
    check('déconnexion > délai de grâce (même après avoir choisi) → forfait', end && end.reason === 'forfeit' && end.winner === 1, JSON.stringify(end));
    seats[1].close();
    await relay.close();
  }
  // Salon inactif
  {
    const { relay, url } = await startRelay({ idleMs: 300, sweepMs: 50 });
    const a = await client(url, 'Dormeur', deckA);
    a.send({ t: 'create' });
    const room = await a.wait('room');
    const keepalive = setInterval(() => a.send({ t: 'ping' }), 50);
    check('salon inactif (malgré le keepalive) → room_expired', await a.err('room_expired', 3000));
    clearInterval(keepalive);
    const b = await client(url, 'Retard', deckB);
    b.send({ t: 'join', code: room.code });
    check('salon expiré → unknown_room', await b.err('unknown_room'));
    a.close();
    b.close();
    await relay.close();
  }
}

// ---------------------------------------------------------------------------
// 5. Client navigateur content/duel-net.js (WebSocket global de Node)
// ---------------------------------------------------------------------------

async function testNetClient() {
  check('net : version de protocole 2', NET.PROTOCOL === 2);
  // Débit relevé : deux clients automatiques (IA instantanée) jouent bien plus vite qu'un humain.
  const { relay, url } = await startRelay({ chooseMs: 30_000, replaceMs: 30_000, graceMs: 5000, rateBurst: 400, ratePerSec: 200 });
  let dropped = false;
  let queuedWhileDown = false;
  let sawOpponentChosen = false;
  let sawPhase = new Set();

  function makeNet(name, deck, victim) {
    const rec = { events: [], statuses: [], acted: 0, errors: [], chosenEvents: 0 };
    const play = (net) => {
      const st = net.state;
      if (!st || net.ended || !net.canAct() || !net.legal.length || rec.acted === net.seq) return false;
      rec.acted = net.seq;
      net.act(E.chooseAction(st, net.you));
      return true;
    };
    rec.net = NET.connect(url, {
      name,
      deck,
      pingMs: 150,
      backoffMinMs: 100,
      onEvent(msg, net) {
        rec.events.push(msg);
        if (msg.t === 'net') rec.statuses.push(msg.status);
        if (msg.t === 'error') rec.errors.push(msg.code);
        if (msg.t === 'chosen') {
          rec.chosenEvents += 1;
          if (net.opponentChosen()) sawOpponentChosen = true;
        }
        if (msg.t === 'net' && msg.status === 'reconnecting' && victim) {
          // Coupure pendant notre choix : l'action part dans la file d'envoi.
          if (play(net)) queuedWhileDown = true;
        }
        if (msg.t !== 'state') return;
        if (net.phase) sawPhase.add(net.phase);
        if (msg.seq === 1) rec.first = { phase: net.phase, pending: net.pending.length, canAct: net.canAct(), legal: net.legal.length, left: net.timeLeft(), phaseMs: net.phaseMs };
        if (victim && !dropped && msg.seq >= 4 && net.canAct()) {
          dropped = true;
          const s = [...relay.sessions.values()].find((x) => x.id === net.clientId);
          if (s && s.ws) s.ws.terminate();
          return;
        }
        setTimeout(() => play(net), 0);
      }
    });
    return rec;
  }

  const A = makeNet('Ana', deckA, true);
  check('net : statut initial connecting', A.net.status === 'connecting');
  check('net : champs v2 initiaux (phase, pending, chosen, choice)', A.net.phase === null && Array.isArray(A.net.pending) && Array.isArray(A.net.chosen) && A.net.choice === null && A.net.canAct() === false);
  A.net.create(); // mis en file avant l'ouverture
  const roomA = await waitFor(() => A.events.find((m) => m.t === 'room'));
  check('net : create mis en file puis envoyé → room', roomA && roomA.status === 'waiting' && A.net.code === roomA.code);
  check('net : welcome → jeton mémorisé', typeof A.net.token === 'string' && A.net.clientId);
  check('net : statut open', A.net.status === 'open' && A.statuses.includes('open'));
  const B = makeNet('Ben', deckB, false);
  B.net.join(roomA.code);
  await waitFor(() => B.net.status === 'open' && B.net.room && B.net.room.code === roomA.code);
  A.net.ready(true);
  B.net.ready(true);
  const first = await waitFor(() => A.first && B.first);
  check('net : état initial → phase choose, pending [0,1], canAct pour les deux', first && [A.first, B.first].every((f) => f.phase === 'choose' && f.pending === 2 && f.canAct && f.legal > 0), JSON.stringify([A.first, B.first]));
  check('net : timeLeft et phaseMs renseignés', first && A.first.left > 0 && A.first.phaseMs === 30_000, JSON.stringify(A.first));
  const done = await waitFor(() => A.net.ended && B.net.ended, 40_000);
  check('net : duel complet joué jusqu’à end', done, `seq ${A.net.seq}/${B.net.seq}`);
  check('net : coupure provoquée côté serveur', dropped);
  check('net : statuts reconnecting → open', A.statuses.join(',').includes('reconnecting,open'), A.statuses.join(','));
  check('net : action envoyée pendant la coupure (file d’envoi)', queuedWhileDown);
  check('net : aucune erreur de protocole', A.errors.length === 0 && B.errors.length === 0, [...A.errors, ...B.errors].join(','));
  check('net : end identique des deux côtés', A.net.ended && B.net.ended && A.net.ended.winner === B.net.ended.winner);
  check('net : messages chosen reçus, opponentChosen() vrai à l’arrivée d’un chosen adverse', A.chosenEvents + B.chosenEvents > 0 && sawOpponentChosen, `${A.chosenEvents}/${B.chosenEvents}`);
  check('net : phases choose et replace observées', sawPhase.has('choose') && sawPhase.has('replace'), [...sawPhase].join(','));
  check('net : état final (phase ended, pending vide, legal vide, timeLeft nul)', A.net.state && A.net.seq > 1 && A.net.phase === 'ended' && A.net.pending.length === 0 && A.net.legal.length === 0 && A.net.timeLeft() === null && !A.net.canAct());
  check('net : last mémorise le dernier tour résolu', A.net.last && Array.isArray(A.net.last.actions));
  B.net.leave();
  check('net : leave efface le salon local et la phase', B.net.code === null && B.net.state === null && B.net.phase === null && B.net.pending.length === 0);
  check('net : l’autre joueur voit le départ (peer left)', await waitFor(() => A.events.some((m) => m.t === 'peer' && m.status === 'left')));
  A.net.close();
  B.net.close();
  check('net : close → statut closed', A.net.status === 'closed' && B.net.status === 'closed');
  await sleep(300);
  check('net : pas de reconnexion après close', A.statuses[A.statuses.length - 1] === 'closed');

  // Le client suit un choix verrouillé : net.choice, net.chosen, net.pending, net.canAct().
  {
    const rec1 = { ev: [] };
    const n1 = NET.connect(url, { name: 'Un', deck: deckA, pingMs: 80, onEvent: (m) => rec1.ev.push(m) });
    const n2 = NET.connect(url, { name: 'Deux', deck: deckB });
    n1.create();
    const rm = await waitFor(() => rec1.ev.find((m) => m.t === 'room'));
    check('net : keepalive (pong reçu)', await waitFor(() => rec1.ev.some((m) => m.t === 'pong'), 2000));
    n2.join(rm.code);
    await waitFor(() => n2.room && n2.room.code === rm.code);
    n1.ready(true);
    n2.ready(true);
    await waitFor(() => n1.state && n2.state && n1.seq === 1 && n2.seq === 1);
    const act = n1.legal.find((a) => a.type === 'move') || n1.legal[0];
    n1.act(act);
    await waitFor(() => n1.choice);
    check('net : après act, choice = mon action, canAct faux, legal vide', n1.choice && n1.choice.type === act.type && !n1.canAct() && n1.legal.length === 0 && n1.chosen.includes(n1.you), JSON.stringify([n1.choice, n1.chosen, n1.pending]));
    await waitFor(() => n2.opponentChosen());
    check('net : l’adversaire voit opponentChosen() sans connaître le choix', n2.opponentChosen() && n2.choice === null && n2.canAct());
    n2.act(n2.legal.find((a) => a.type === 'pass'));
    await waitFor(() => n1.seq === 2 && n2.seq === 2);
    check('net : après résolution, choice effacé et les deux peuvent rechoisir', n1.choice === null && n2.choice === null && n1.canAct() && n2.canAct() && n1.chosen.length === 0);
    n1.close();
    n2.close();
  }

  // Session reprise dans un autre « onglet » : l'ancien client s'arrête au lieu de la reprendre en boucle.
  const C = makeNet('Cléo', deckA, false);
  C.net.create();
  const roomC = await waitFor(() => C.events.find((m) => m.t === 'room'));
  const thief = await new Raw(url).opened();
  thief.send({ t: 'rejoin', code: roomC && roomC.code, token: C.net.token });
  check('net : rejoin depuis ailleurs → welcome pour le nouvel onglet', await thief.wait('welcome'));
  check('net : ancien onglet → erreur session_taken puis closed', await waitFor(() => C.errors.includes('session_taken') && C.net.status === 'closed'), C.statuses.join(','));
  await sleep(300);
  check('net : ancien onglet ne se reconnecte pas', C.statuses[C.statuses.length - 1] === 'closed' && thief.closeCode === null);
  thief.close();
  await relay.close();
}

// ---------------------------------------------------------------------------
// Exécution
// ---------------------------------------------------------------------------

await testChildProcess();
await testRobustness();
await testFullMatch();
await testTimers();
await testNetClient();

// Bilan global du secret : sur TOUTES les connexions de ce test, jamais le choix adverse en clair.
{
  let leaks = 0;
  let inspected = 0;
  for (const raw of allRaws) {
    let you = null;
    for (const m of raw.log) {
      if (m.t === 'state') {
        you = m.you;
        inspected += 1;
        const c = m.state && m.state.choices;
        const other = c && c[1 - m.you];
        if (other && other.type !== 'hidden') leaks += 1;
        if (m.choice && m.choice.player !== undefined) leaks += 1;
      }
      if (m.t === 'chosen' && you !== null && m.player !== you && ('action' in m || 'choice' in m)) leaks += 1;
    }
  }
  check(`secret : aucune fuite du choix adverse dans ${inspected} états reçus`, inspected > 50 && leaks === 0, `${leaks} fuite(s)`);
}

clearTimeout(guard);
console.log(`Contrôles : ${checks} · échecs : ${failures}`);
process.exit(failures ? 1 : 0);
