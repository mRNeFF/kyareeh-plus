// Vérifie le nouvel état « prêt » et la mise déclarative du relais du duel.
// Aucun transfert réel : le relais ne relaie que des conditions et des acceptations.
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRelay, loadData, loadEngine } from '../relay/server.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const E = loadEngine(path.join(ROOT, 'content', 'duel-engine.js'));
const data = loadData();
const mythics = data.champions.filter((c) => c.rarity === 'M');
const deckA = mythics.slice(0, 5).map((c) => c.id);
const deckB = mythics.slice(5, 10).map((c) => c.id);

let checks = 0;
let failures = 0;
function check(label, ok, detail = '') {
  checks += 1;
  if (!ok) {
    failures += 1;
    console.log(`ECHEC ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

class Raw {
  constructor(url) {
    this.inbox = [];
    this.waiters = [];
    this.ws = new WebSocket(url);
    this.ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      this.inbox.push(m);
      this.flush();
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
    this.ws.send(JSON.stringify(o));
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
  c.send({ t: 'hello', v: 2, name, deck });
  await c.wait('welcome');
  return c;
}

const relay = createRelay({ engine: E, data, log: false, chooseMs: 5_000 });
const port = await relay.listen(0, '127.0.0.1');
const url = `ws://127.0.0.1:${port}`;

try {
  const a = await client(url, 'Alice', deckA);
  const b = await client(url, 'Bruno', deckB);

  a.send({ t: 'create', bet: { enabled: true, amount: 0, cardId: '1' } });
  check('mise : montant 0 refusé', Boolean(await a.err('bet_invalid')));
  a.send({ t: 'create', bet: { enabled: true, amount: 500 } });
  check('mise : contrepartie absente refusée', Boolean(await a.err('bet_invalid')));

  a.send({ t: 'create', bet: { enabled: true, amount: 500, cardId: '42', cardName: 'Roxy Migurdia', cardRarity: 'M' } });
  const created = await a.wait((m) => m.t === 'room' && m.code);
  check('mise : salon créé avec la mise', created && created.bet && created.bet.amount === 500 && created.bet.cardName === 'Roxy Migurdia', JSON.stringify(created && created.bet));
  check('mise : créateur = conditions acceptées', JSON.stringify(created.betAck) === '[true,false]', JSON.stringify(created.betAck));
  check('mise : contrepartie du créateur enregistrée', created.bet.stakes?.creator?.cardId === '42', JSON.stringify(created.bet.stakes));
  check('prêt : créateur par défaut = pas prêt', created.players[0].ready === false);

  a.send({ t: 'ready', ready: true });
  check('prêt : créateur prêt sans adversaire', Boolean(await a.wait((m) => m.t === 'room' && m.players[0].ready)));

  b.send({ t: 'join', code: created.code });
  const joined = await b.wait((m) => m.t === 'room' && m.players.length === 2);
  check('prêt : le nouvel arrivant est pas prêt', joined && joined.players.find((p) => p.seat === 1).ready === false);
  check('mise : le nouvel arrivant n’a pas accepté', joined && joined.betAck[1] === false);
  await a.wait((m) => m.t === 'room' && m.players.length === 2);

  b.send({ t: 'ready', ready: true });
  check('prêt : impossible d’être prêt sans accepter la mise', Boolean(await b.err('bet_not_accepted')));

  b.send({ t: 'bet-accept', stake: { amount: 500, cardId: '43', cardName: 'Mina', cardRarity: 'R' } });
  const accepted = await b.wait((m) => m.t === 'room' && m.betAck[1] === true);
  check('mise : acceptation diffusée aux deux joueurs', Boolean(accepted));
  check('mise : contrepartie de l’adversaire enregistrée', accepted?.bet?.stakes?.joiner?.cardId === '43', JSON.stringify(accepted?.bet?.stakes));
  b.send({ t: 'ready', ready: true });

  const playingA = await a.wait((m) => m.t === 'room' && m.status === 'playing');
  const playingB = await b.wait((m) => m.t === 'room' && m.status === 'playing');
  check('prêt : les deux prêts + mise acceptée → duel lancé', Boolean(playingA && playingB));
  check('prêt : l’état est synchronisé entre les joueurs', JSON.stringify(playingA.players.map((p) => p.ready)) === JSON.stringify(playingB.players.map((p) => p.ready)));
  check('mise : aucun transfert, le relais ne renvoie que les conditions', playingA.bet && playingA.bet.enabled && playingA.bet.mode === 'test');

  // Mise réelle : les deux contreparties doivent être présentes avant le départ.
  const c = await client(url, 'Chloé', deckA);
  const d = await client(url, 'Dina', deckB);
  c.send({
    t: 'create',
    bet: {
      enabled: true,
      mode: 'real',
      amount: 700,
      cardId: '100',
      cardName: 'Carte C',
      cardRarity: 'E',
      creator: { amount: 700, cardId: '100', cardName: 'Carte C', cardRarity: 'E' }
    }
  });
  const roomC = await c.wait((m) => m.t === 'room' && m.code);
  check('mise réelle : mode conservé', roomC?.bet?.mode === 'real');
  d.send({ t: 'join', code: roomC.code });
  await d.wait((m) => m.t === 'room' && m.players.length === 2);
  c.send({ t: 'ready', ready: true });
  d.send({ t: 'bet-accept', stake: { amount: 700, cardId: '101', cardName: 'Carte D', cardRarity: 'R' } });
  d.send({ t: 'ready', ready: true });
  const playingC = await c.wait((m) => m.t === 'room' && m.status === 'playing');
  check('mise réelle : les deux contreparties sont diffusées', playingC?.bet?.stakes?.creator?.cardId === '100' && playingC?.bet?.stakes?.joiner?.cardId === '101', JSON.stringify(playingC?.bet?.stakes));
  c.close();
  d.close();

  a.close();
  b.close();
  await new Promise((resolve) => setTimeout(resolve, 400));
} finally {
  await relay.close();
  await new Promise((resolve) => setTimeout(resolve, 300));
}

console.log(`${checks - failures}/${checks} contrôles OK`);
process.exit(failures ? 1 : 0);
