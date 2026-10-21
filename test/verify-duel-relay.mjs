// Vérifie le relais du duel (relay/server.mjs) et le client réseau (content/duel-net.js).
// Démarre des relais en mémoire sur des ports libres (minuteurs raccourcis) et un relais en
// processus enfant (`node relay/server.mjs`, healthcheck), puis joue des duels complets avec
// l'IA du moteur et provoque les cas d'erreur du protocole (docs/DUEL-SPEC.md §4).
//
// Moteur utilisé : DUEL_ENGINE si défini, sinon content/duel-engine.js s'il existe,
// sinon le bouchon test/stub-duel-engine.cjs. `--stub` force le bouchon.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import netModule from 'node:net';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createRelay, loadData, loadEngine } from '../relay/server.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REAL_ENGINE = path.join(ROOT, 'content', 'duel-engine.js');
const STUB_ENGINE = path.join(ROOT, 'test', 'stub-duel-engine.cjs');
const enginePath = process.env.DUEL_ENGINE
  ? path.resolve(process.env.DUEL_ENGINE)
  : process.argv.includes('--stub') || !fs.existsSync(REAL_ENGINE)
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
  console.log('ÉCHEC délai global dépassé (120 s)');
  process.exit(1);
}, 120_000);

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

class Raw {
  constructor(url) {
    this.inbox = [];
    this.waiters = [];
    this.latest = null;
    this.end = null;
    this.closeCode = null;
    this.ws = new WebSocket(url);
    this.ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.t === 'welcome') this.token = m.token;
      if (m.t === 'state') this.latest = m;
      if (m.t === 'end') this.end = m;
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
  close() {
    this.ws.close();
  }
}

async function client(url, name, deck) {
  const c = await new Raw(url).opened();
  if (name) {
    c.send({ t: 'hello', v: 1, name, deck });
    c.welcome = await c.wait('welcome');
  }
  return c;
}

async function startRelay(over = {}) {
  const relay = createRelay({ engine: E, data, log: false, ...over });
  const port = await relay.listen(0, '127.0.0.1');
  return { relay, url: `ws://127.0.0.1:${port}` };
}

/** Crée un salon à deux ; renvoie [siège0, siège1] et le code. */
async function pair(url) {
  const a = await client(url, 'Alice', deckA);
  const b = await client(url, 'Bruno', deckB);
  a.send({ t: 'create' });
  const room = await a.wait((m) => m.t === 'room' && m.status === 'waiting');
  b.send({ t: 'join', code: room.code });
  await a.wait((m) => m.t === 'state' && m.seq === 1);
  await b.wait((m) => m.t === 'state' && m.seq === 1);
  return { seats: [a, b], code: room.code };
}

/** Joue jusqu'à la fin avec chooseAction. hook(step, cur, seats) peut remplacer un siège. */
async function playOut(seats, hook) {
  let steps = 0;
  for (; steps < 2000; steps += 1) {
    const ok = await waitFor(() => (seats[0].end && seats[1].end) || (seats[0].latest && seats[1].latest && seats[0].latest.seq === seats[1].latest.seq && !seats[0].end));
    if (!ok) return { steps, stuck: true };
    if (seats[0].end && seats[1].end) break;
    const st = seats[0].latest;
    const cur = E.currentPlayer(st.state);
    if (cur !== 0 && cur !== 1) {
      await waitFor(() => seats[0].end && seats[1].end);
      break;
    }
    if (hook) await hook(steps, cur, seats, st);
    const now = seats[cur].latest;
    seats[cur].send({ t: 'action', seq: now.seq, action: E.chooseAction(now.state, cur) });
    await waitFor(() => seats[0].end || (seats[0].latest.seq > now.seq && seats[1].latest.seq > now.seq));
  }
  return { steps, stuck: false };
}

// ---------------------------------------------------------------------------
// 1. Processus enfant : node relay/server.mjs + healthcheck
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
  const port = await freePort();
  const child = spawn(process.execPath, ['relay/server.mjs'], {
    cwd: ROOT,
    // Minuteurs raccourcis par variables d'environnement (vérifie leur prise en compte).
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DUEL_ENGINE: enginePath, DUEL_LOG: '0', DUEL_TURN_MS: '300', DUEL_GRACE_MS: '400', DUEL_MAX_TIMEOUTS: '99' },
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
    check('processus : DUEL_TURN_MS appliqué (deadline ≤ 300 ms)', s0 && s0.deadline > 0 && s0.deadline <= 300, String(s0 && s0.deadline));
    const auto = await seats[0].wait((m) => m.t === 'state' && m.last && m.last.auto === true, 3000);
    check('processus : délai de tour → pass automatique', auto && auto.last.action.type === 'pass');
    seats[1].close();
    const end = await seats[0].wait('end', 3000);
    check('processus : DUEL_GRACE_MS appliqué (forfait après déconnexion)', end && end.reason === 'forfeit' && end.winner === 0, JSON.stringify(end));
    seats[0].close();
  }
  child.kill();
}

// ---------------------------------------------------------------------------
// 2. Protocole, erreurs et duel complet (clients bruts)
// ---------------------------------------------------------------------------

async function testProtocol() {
  const { relay, url } = await startRelay({ turnMs: 30_000, graceMs: 5000, maxMessage: 8192 });

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
  x.send({ t: 'hello', v: 2, name: 'Futur' });
  check('version 2 → version', await x.err('version'));
  x.send({ t: 'ping', pad: 'x'.repeat(9000) });
  check('message > 8 Kio → too_large', await x.err('too_large'));
  x.send({ t: 'ping' });
  check('connexion toujours ouverte après les erreurs (pong)', await x.wait('pong'));
  check('aucune erreur en trop', (await x.wait('error', 50)) === null);
  x.send({ t: 'ping', pad: 'x'.repeat(40_000) });
  check('message > 4 × limite → connexion coupée', await waitFor(() => x.closeCode !== null, 2000), String(x.closeCode));

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

  // Salon et début de duel
  const a = await client(url, 'Alice', deckA);
  const b = await client(url, 'Bruno', deckB);
  a.send({ t: 'create' });
  const room = await a.wait((m) => m.t === 'room');
  check('create → room waiting, code de 5 lettres sans I/O', room && room.status === 'waiting' && /^[A-HJ-NP-Z]{5}$/.test(room.code), JSON.stringify(room));
  b.send({ t: 'join', code: room.code.toLowerCase() });
  const ra = await a.wait((m) => m.t === 'room' && m.status === 'playing');
  const rb = await b.wait((m) => m.t === 'room' && m.status === 'playing');
  check('join (minuscules acceptées) → room playing pour les deux', ra && rb && ra.players.length === 2 && rb.you === 1, JSON.stringify(rb));
  check('room : noms des joueurs', ra && ra.players.map((p) => p.name).join(',') === 'Alice,Bruno');
  const sa = await a.wait('state');
  const sb = await b.wait('state');
  check('state initial seq 1 avec you 0/1', sa && sb && sa.seq === 1 && sb.seq === 1 && sa.you === 0 && sb.you === 1);
  check('state : deadline ≤ délai de tour', sa && sa.deadline > 0 && sa.deadline <= 30_000, String(sa && sa.deadline));
  check('state : état JSON du moteur (2 joueurs, 5 champions)', sa && sa.state.players.length === 2 && sa.state.players.every((p) => p.champions.length === 5));
  const cur0 = E.currentPlayer(sa.state);
  const seats = [a, b];
  check('state : legal fourni au joueur courant uniquement', sa && seats[cur0].latest.legal.length > 0 && seats[1 - cur0].latest.legal.length === 0);

  const c = await client(url, 'Chloé', deckA);
  c.send({ t: 'join', code: room.code });
  check('3e joueur → room_full', await c.err('room_full'));
  c.close();

  // Erreurs pendant le duel
  const st = sa.state;
  const good = E.chooseAction(st, cur0);
  seats[1 - cur0].send({ t: 'action', seq: 1, action: good });
  check('jouer hors de son tour → not_your_turn', await seats[1 - cur0].err('not_your_turn'));
  seats[cur0].send({ t: 'action', seq: 0, action: good });
  const stale = await seats[cur0].err('stale_seq');
  check('mauvais seq → stale_seq (avec seq courant)', stale && stale.seq === 1, JSON.stringify(stale));
  check('mauvais seq → état renvoyé', await seats[cur0].wait((m) => m.t === 'state' && m.seq === 1));
  seats[cur0].send({ t: 'action', seq: 1, action: { type: 'move', actor: 99, move: 0, target: { side: 0, index: 0 } } });
  check('action illégale → illegal_action', await seats[cur0].err('illegal_action'));
  seats[cur0].send({ t: 'action', seq: 1, action: 'n’importe quoi' });
  check('action non objet → illegal_action', await seats[cur0].err('illegal_action'));
  check('aucune action refusée n’a avancé le duel', seats[0].latest.seq === 1 && seats[1].latest.seq === 1);

  // Duel complet, avec une coupure / reconnexion au milieu
  let reconnected = false;
  const result = await playOut(seats, async (step, cur, s) => {
    if (step !== 6) return;
    const victim = s[cur];
    const other = s[1 - cur];
    const token = victim.token;
    other.inbox.length = 0;
    victim.close();
    check('coupure → l’adversaire reçoit peer left', await other.wait((m) => m.t === 'peer' && m.status === 'left'));
    const back = await new Raw(url).opened();
    back.send({ t: 'rejoin', code: room.code, token });
    const w = await back.wait('welcome');
    check('rejoin → welcome (même jeton, rejoined)', w && w.token === token && w.rejoined === true, JSON.stringify(w));
    const rs = await back.wait('state');
    check('rejoin → état courant renvoyé', rs && rs.seq === victim.latest.seq && rs.you === cur);
    check('rejoin → l’adversaire reçoit peer back', await other.wait((m) => m.t === 'peer' && m.status === 'back'));
    s[cur] = back;
    reconnected = true;
  });
  check('duel complet sans blocage', !result.stuck, `bloqué à l’étape ${result.steps}`);
  check('reconnexion effectuée en cours de duel', reconnected);
  const [ea, eb] = [seats[0].end, seats[1].end];
  check('fin : message end pour les deux joueurs', ea && eb);
  const final = seats[0].latest.state;
  check('fin : vainqueur cohérent avec l’état', ea && ea.winner === final.winner && eb.winner === final.winner, `${ea && ea.winner} / ${final.winner}`);
  check('fin : raison ko ou rounds', ea && (ea.reason === 'ko' || ea.reason === 'rounds'), ea && ea.reason);
  check('fin : currentPlayer null', E.currentPlayer(final) === null);
  check('fin : events typés diffusés', seats[0].inbox.some((m) => m.t === 'state' && Array.isArray(m.events) && m.events.length > 0));
  const desc = E.describeEvent((seats[0].latest.events || [])[0] || { type: 'end', winner: final.winner });
  check('describeEvent sur un événement reçu → texte', typeof desc === 'string' && desc.length > 0);
  console.log(`Duel complet : ${result.steps} actions, ${final.round} manches, vainqueur ${ea && ea.winner} (${ea && ea.reason})`);
  seats[0].send({ t: 'action', seq: seats[0].latest.seq, action: { type: 'pass' } });
  check('action après la fin → not_playing', await seats[0].err('not_playing'));

  // Revanche puis abandon
  seats[0].end = seats[1].end = null;
  seats[0].send({ t: 'rematch' });
  const half = await seats[1].wait((m) => m.t === 'room' && m.status === 'ended' && m.players.some((p) => p.ready));
  check('revanche demandée par un joueur → room (ready)', half);
  seats[1].send({ t: 'rematch' });
  const re0 = await seats[0].wait((m) => m.t === 'state' && m.seq === 1);
  check('revanche acceptée → nouveau duel seq 1', re0 && re0.state.winner === null);
  seats[0].inbox.length = 0;
  seats[1].inbox.length = 0;
  seats[0].send({ t: 'leave' });
  const fst = await seats[1].wait((m) => m.t === 'state' && m.state.winner === 1);
  check('leave en plein duel → état final diffusé (winner, last.forfeit)', fst && fst.seq === 2 && fst.last && fst.last.forfeit === 'forfeit' && fst.legal.length === 0 && fst.deadline === null, JSON.stringify(fst && fst.last));
  if (typeof E.forfeit === 'function') check('leave : événement forfeit du moteur diffusé', fst && fst.events.some((e) => e.type === 'forfeit'));
  const fend = await seats[1].wait('end');
  check('leave en plein duel → défaite par forfait (adversaire)', fend && fend.reason === 'forfeit' && fend.winner === 1, JSON.stringify(fend));
  const lend = await seats[0].wait('end');
  check('leave → le partant reçoit aussi end', lend && lend.reason === 'forfeit' && lend.winner === 1);
  const wroom = await seats[1].wait((m) => m.t === 'room' && m.status === 'waiting');
  check('après départ → salon de nouveau en attente (même code)', wroom && wroom.code === room.code && wroom.players.length === 1 && wroom.you === 0);
  const late = await seats[0].wait((m) => m.t === 'room', 200);
  check('le partant ne reçoit plus les nouvelles du salon', late === null);
  seats[0].close();
  seats[1].close();
  x.close();
  d.close();
  await relay.close();
}

// ---------------------------------------------------------------------------
// 3. Minuteurs : délai de tour, forfait après déconnexion, salon inactif
// ---------------------------------------------------------------------------

async function testTimers() {
  {
    const { relay, url } = await startRelay({ turnMs: 250, graceMs: 5000, maxTimeouts: 2 });
    const { seats } = await pair(url);
    const first = E.currentPlayer(seats[0].latest.state);
    const auto = await seats[0].wait((m) => m.t === 'state' && m.last && m.last.auto === true, 3000);
    check('délai de tour → pass automatique (last.auto)', auto && auto.last.player === first && auto.last.action.type === 'pass', JSON.stringify(auto && auto.last));
    const end = await seats[1].wait('end', 4000);
    check('délais répétés → fin « timeout »', end && end.reason === 'timeout' && (end.winner === 0 || end.winner === 1), JSON.stringify(end));
    seats.forEach((s) => s.close());
    await relay.close();
  }
  {
    const { relay, url } = await startRelay({ turnMs: 30_000, graceMs: 300 });
    const { seats } = await pair(url);
    seats[0].close();
    check('déconnexion → peer left', await seats[1].wait((m) => m.t === 'peer' && m.status === 'left'));
    const end = await seats[1].wait('end', 3000);
    check('déconnexion > délai de grâce → forfait', end && end.reason === 'forfeit' && end.winner === 1, JSON.stringify(end));
    seats[1].close();
    await relay.close();
  }
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
// 4. Client navigateur content/duel-net.js (WebSocket global de Node)
// ---------------------------------------------------------------------------

async function testNetClient() {
  const { relay, url } = await startRelay({ turnMs: 30_000, graceMs: 5000 });
  let dropped = false;
  let queuedWhileDown = false;

  function makeNet(name, deck, victim) {
    const rec = { events: [], statuses: [], acted: 0, errors: [] };
    const play = (net) => {
      const st = net.state;
      if (!st || net.ended || st.winner !== null || E.currentPlayer(st) !== net.you || rec.acted === net.seq) return false;
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
        if (msg.t === 'net' && msg.status === 'reconnecting' && victim) {
          // Coupure pendant notre tour : l'action part dans la file d'envoi.
          if (play(net)) queuedWhileDown = true;
        }
        if (msg.t !== 'state') return;
        if (victim && !dropped && msg.seq >= 4 && E.currentPlayer(msg.state) === msg.you) {
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
  A.net.create(); // mis en file avant l'ouverture
  const roomA = await waitFor(() => A.events.find((m) => m.t === 'room'));
  check('net : create mis en file puis envoyé → room', roomA && roomA.status === 'waiting' && A.net.code === roomA.code);
  check('net : welcome → jeton mémorisé', typeof A.net.token === 'string' && A.net.clientId);
  check('net : statut open', A.net.status === 'open' && A.statuses.includes('open'));
  const B = makeNet('Ben', deckB, false);
  B.net.join(roomA.code);
  const done = await waitFor(() => A.net.ended && B.net.ended, 30_000);
  check('net : duel complet joué jusqu’à end', done, `seq ${A.net.seq}/${B.net.seq}`);
  check('net : coupure provoquée côté serveur', dropped);
  check('net : statuts reconnecting → open', A.statuses.join(',').includes('reconnecting,open'), A.statuses.join(','));
  check('net : action envoyée pendant la coupure (file d’envoi)', queuedWhileDown);
  check('net : aucune erreur de protocole', A.errors.length === 0 && B.errors.length === 0, [...A.errors, ...B.errors].join(','));
  check('net : end identique des deux côtés', A.net.ended && B.net.ended && A.net.ended.winner === B.net.ended.winner);
  check('net : keepalive (pong reçu)', A.events.some((m) => m.t === 'pong'));
  check('net : état final mémorisé (state, seq, legal vide)', A.net.state && A.net.seq > 1 && A.net.legal.length === 0 && A.net.timeLeft() === null);
  B.net.leave();
  check('net : leave efface le salon local', B.net.code === null && B.net.state === null);
  check('net : l’autre joueur voit le départ (peer left)', await waitFor(() => A.events.some((m) => m.t === 'peer' && m.status === 'left')));
  A.net.close();
  B.net.close();
  check('net : close → statut closed', A.net.status === 'closed' && B.net.status === 'closed');
  await sleep(300);
  check('net : pas de reconnexion après close', A.statuses[A.statuses.length - 1] === 'closed');

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

await testChildProcess();
await testProtocol();
await testTimers();
await testNetClient();

clearTimeout(guard);
console.log(`Contrôles : ${checks} · échecs : ${failures}`);
process.exit(failures ? 1 : 0);
