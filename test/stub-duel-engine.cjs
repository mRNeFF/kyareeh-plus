// Bouchon minimal du moteur de duel (API du §3 de docs/DUEL-SPEC.md).
// Sert uniquement aux tests du relais (DUEL_ENGINE=test/stub-duel-engine.cjs) tant que
// le vrai moteur (content/duel-engine.js, chantier A) n'existe pas ou est incomplet.
// Règles volontairement simplifiées : attaque = dégâts + ATQ, soutien = soin, ultime une fois.
'use strict';

const RULES = { chakraStart: 1, chakraPerTurn: 1, chakraMax: 5, costSupport: 1, costUltimate: 3, maxRounds: 30, deckSize: 5 };
const COST = { attack: 0, support: RULES.costSupport, ultimate: RULES.costUltimate };

function clone(o) { return JSON.parse(JSON.stringify(o)); }

function rand(state) {
  // mulberry32, état dans state.rng
  let t = (state.rng = (state.rng + 0x6d2b79f5) >>> 0);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

function mythics(data) {
  return (data && Array.isArray(data.champions) ? data.champions : []).filter((c) => c.rarity === 'M');
}

function validateDeck(data, ids) {
  if (!Array.isArray(ids) || ids.length !== RULES.deckSize) return { ok: false, error: 'Le deck doit contenir exactement 5 Mythiques.' };
  if (new Set(ids).size !== ids.length) return { ok: false, error: 'Le deck contient des doublons.' };
  const known = new Set(mythics(data).map((c) => c.id));
  const bad = ids.find((id) => !known.has(id));
  if (bad !== undefined) return { ok: false, error: `Carte inconnue ou non Mythique : ${bad}.` };
  return { ok: true };
}

function createMatch({ data, seed, players }) {
  const byId = new Map(mythics(data).map((c) => [c.id, c]));
  const state = {
    round: 1, turn: 0, winner: null, rng: seed >>> 0, log: [], turnsInRound: 0,
    players: players.map((p) => ({
      id: p.id, name: p.name, chakra: RULES.chakraStart, skipNext: false,
      champions: p.deck.map((id) => {
        const c = byId.get(id);
        if (!c) throw new Error(`Carte inconnue : ${id}.`);
        return { id: c.id, name: c.name, image: c.image, hp: c.hp, maxHp: c.hp, atk: c.atk, atkBonus: 0, guard: 0, buff: 0,
          statuses: {}, ultimateUsed: false, alive: true, moves: c.attacks };
      })
    }))
  };
  const fastest = (p) => Math.max(...state.players[p].champions.map((c) => byId.get(c.id).speed || 0));
  state.turn = fastest(0) === fastest(1) ? (rand(state) < 0.5 ? 0 : 1) : fastest(0) > fastest(1) ? 0 : 1;
  return state;
}

function currentPlayer(state) { return state.winner === null ? state.turn : null; }

function legalActions(state, p) {
  if (currentPlayer(state) !== p) return [];
  const out = [{ type: 'pass' }];
  const me = state.players[p];
  me.champions.forEach((c, j) => {
    if (!c.alive) return;
    c.moves.forEach((m, k) => {
      if ((COST[m.kind] || 0) > me.chakra) return;
      if (m.kind === 'ultimate' && c.ultimateUsed) return;
      const side = m.kind === 'support' ? p : 1 - p;
      state.players[side].champions.forEach((t, i) => {
        if (t.alive) out.push({ type: 'move', actor: j, move: k, target: { side, index: i } });
      });
    });
  });
  return out;
}

function same(a, b) {
  return a.type === b.type && a.actor === b.actor && a.move === b.move &&
    (a.target ? a.target.side : null) === (b.target ? b.target.side : null) &&
    (a.target ? a.target.index : null) === (b.target ? b.target.index : null);
}

function applyAction(input, p, action) {
  if (!action || !legalActions(input, p).some((a) => same(a, action))) throw new Error('Action illégale.');
  const state = clone(input);
  const events = [];
  const me = state.players[p];
  if (action.type === 'move') {
    const c = me.champions[action.actor];
    const m = c.moves[action.move];
    me.chakra -= COST[m.kind] || 0;
    if (m.kind === 'ultimate') c.ultimateUsed = true;
    const t = state.players[action.target.side].champions[action.target.index];
    if (m.kind === 'support') {
      const heal = Math.min(t.maxHp - t.hp, m.heal || 3);
      t.hp += heal;
      events.push({ type: 'heal', side: action.target.side, index: action.target.index, amount: heal, name: t.name });
    } else {
      const dmg = Math.max(1, (m.damage || 3) + c.atk);
      t.hp = Math.max(0, t.hp - dmg);
      events.push({ type: 'damage', side: action.target.side, index: action.target.index, amount: dmg, name: t.name });
      if (t.hp === 0) { t.alive = false; events.push({ type: 'ko', side: action.target.side, index: action.target.index, name: t.name }); }
    }
  } else {
    events.push({ type: 'pass', player: p });
  }
  const foe = state.players[1 - p];
  if (foe.champions.every((c) => !c.alive)) {
    state.winner = p;
  } else {
    state.turnsInRound += 1;
    if (state.turnsInRound >= 2) {
      state.turnsInRound = 0;
      state.round += 1;
      events.push({ type: 'round', round: state.round });
      if (state.round > RULES.maxRounds) {
        const pct = (pl) => pl.champions.reduce((s, c) => s + c.hp, 0) / pl.champions.reduce((s, c) => s + c.maxHp, 0);
        const a = pct(state.players[0]);
        const b = pct(state.players[1]);
        state.winner = a === b ? 'draw' : a > b ? 0 : 1;
      }
    }
    if (state.winner === null) {
      state.turn = 1 - p;
      const next = state.players[state.turn];
      next.chakra = Math.min(RULES.chakraMax, next.chakra + RULES.chakraPerTurn);
      events.push({ type: 'turn', player: state.turn });
    }
  }
  if (state.winner !== null) events.push({ type: 'end', winner: state.winner });
  state.log.push(...events.map(describeEvent));
  return { state, events };
}

function chooseAction(state, p) {
  const legal = legalActions(state, p);
  const moves = legal.filter((a) => a.type === 'move' && a.target.side !== p);
  if (!moves.length) return legal[0] || { type: 'pass' };
  const s = clone(state);
  return moves[Math.floor(rand(s) * moves.length)];
}

function describeEvent(e) {
  switch (e.type) {
    case 'damage': return `${e.name} subit ${e.amount} dégâts.`;
    case 'heal': return `${e.name} récupère ${e.amount} PV.`;
    case 'ko': return `${e.name} est KO.`;
    case 'round': return `Manche ${e.round}.`;
    case 'turn': return `Au tour du joueur ${e.player + 1}.`;
    case 'pass': return `Le joueur ${e.player + 1} passe.`;
    case 'end': return e.winner === 'draw' ? 'Match nul.' : `Victoire du joueur ${e.winner + 1}.`;
    default: return String(e.type);
  }
}

module.exports = { RULES, mythics, validateDeck, createMatch, legalActions, applyAction, currentPlayer, chooseAction, describeEvent };
