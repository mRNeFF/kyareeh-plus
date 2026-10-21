// Bouchon minimal du moteur de duel v2 (API du §1 de docs/DUEL-V2.md : choix simultanés).
// Sert uniquement aux tests du relais (DUEL_ENGINE=test/stub-duel-engine.cjs ou --stub) tant
// que le vrai moteur (content/duel-engine.js, chantier A) n'expose pas encore l'API v2.
//
// Règles volontairement simplifiées : un actif par camp, banc de 4 ; attaque = dégâts + ATQ
// sur l'actif adverse, soutien = soin d'un allié (banc compris), ultime une fois par champion ;
// changements résolus avant les capacités, capacités par vitesse décroissante ; après un K.O.,
// phase de remplacement. Les choix secrets sont rangés dans state.choices et retirés par viewFor.
'use strict';

const RULES = { chakraStart: 1, chakraPerTurn: 1, chakraMax: 5, costSupport: 1, costUltimate: 3, maxRounds: 40, deckSize: 5 };
const COST = { attack: 0, support: RULES.costSupport, ultimate: RULES.costUltimate };
const TYPES = {
  Duelliste: { color: '#ff5a4e', label: 'Duelliste', strong: ['Mystique'], weak: ['Gardien'] },
  Mystique: { color: '#a66bff', label: 'Mystique', strong: ['Gardien'], weak: ['Duelliste'] },
  Gardien: { color: '#4aa3ff', label: 'Gardien', strong: ['Duelliste'], weak: ['Mystique'] },
  Soutien: { color: '#3fd68a', label: 'Soutien', strong: [], weak: [] },
  'Stratège': { color: '#ffc24a', label: 'Stratège', strong: [], weak: [] }
};

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

function typeOf(c) {
  const role = c && c.role === 'Gardienne' ? 'Gardien' : c && c.role;
  return TYPES[role] ? role : 'Duelliste';
}

function validateDeck(data, ids) {
  if (!Array.isArray(ids) || ids.length !== RULES.deckSize) return { ok: false, error: 'Le deck doit contenir exactement 5 Mythiques.' };
  if (new Set(ids).size !== ids.length) return { ok: false, error: 'Le deck contient des doublons.' };
  const known = new Set(mythics(data).map((c) => c.id));
  const bad = ids.find((id) => !known.has(id));
  if (bad !== undefined) return { ok: false, error: `Carte inconnue ou non Mythique : ${bad}.` };
  return { ok: true };
}

function createMatch({ data, seed, players, rules }) {
  const byId = new Map(mythics(data).map((c) => [c.id, c]));
  return {
    v: 2, phase: 'choose', round: 1, winner: null, endReason: null, rng: seed >>> 0, log: [],
    rules: Object.assign({}, RULES, rules || {}),
    choices: [null, null],
    players: players.map((p) => ({
      id: p.id, name: p.name, chakra: RULES.chakraStart, active: 0,
      champions: p.deck.map((id) => {
        const c = byId.get(id);
        if (!c) throw new Error(`Carte inconnue : ${id}.`);
        const type = typeOf(c);
        return { id: c.id, name: c.name, image: c.image, type, color: TYPES[type].color, hp: c.hp, maxHp: c.hp, atk: c.atk,
          speed: c.speed || 0, alive: true, ultimateUsed: false,
          moves: c.attacks.map((m) => ({ name: m.name, kind: m.kind, cost: COST[m.kind] || 0, damage: m.damage, heal: m.heal })) };
      })
    }))
  };
}

function needsReplacement(state, p) {
  const me = state.players[p];
  return !me.champions[me.active].alive && me.champions.some((c) => c.alive);
}

function pendingPlayers(state) {
  if (!state || state.phase === 'ended') return [];
  return [0, 1].filter((p) => {
    if (state.choices[p]) return false;
    if (state.phase === 'replace') return needsReplacement(state, p);
    return true;
  });
}

function legalActions(state, p) {
  if (!pendingPlayers(state).includes(p)) return [];
  const me = state.players[p];
  const out = [];
  const switches = me.champions.map((c, j) => (c.alive && j !== me.active ? { type: 'switch', to: j } : null)).filter(Boolean);
  if (state.phase === 'replace') return switches;
  const c = me.champions[me.active];
  c.moves.forEach((m, k) => {
    if (m.cost > me.chakra) return;
    if (m.kind === 'ultimate' && c.ultimateUsed) return;
    if (m.kind === 'support') {
      me.champions.forEach((t, i) => {
        if (t.alive) out.push({ type: 'move', move: k, target: { side: p, index: i } });
      });
    } else {
      out.push({ type: 'move', move: k });
    }
  });
  out.push(...switches, { type: 'pass' });
  return out;
}

function key(a) {
  if (!a || typeof a !== 'object') return '';
  return JSON.stringify([a.type, a.move, a.to, a.target ? a.target.side : null, a.target ? a.target.index : null]);
}

function who(s, side, index) {
  const c = s.players[side].champions[index];
  return { side, index, name: c.name, champType: c.type, color: c.color };
}

function doSwitch(s, ev, p, to) {
  const me = s.players[p];
  const from = me.active;
  me.active = to;
  ev.push({ ...who(s, p, to), type: 'switch', from, to });
}

function doMove(s, ev, p, action) {
  const me = s.players[p];
  const c = me.champions[me.active];
  if (!c.alive) return;
  const m = c.moves[action.move];
  me.chakra -= m.cost;
  if (m.kind === 'ultimate') c.ultimateUsed = true;
  if (m.kind === 'support') {
    const t = me.champions[action.target.index];
    if (!t.alive) return;
    const heal = Math.min(t.maxHp - t.hp, m.heal || 3);
    t.hp += heal;
    ev.push({ type: 'heal', ...who(s, p, action.target.index), amount: heal });
    return;
  }
  const foe = s.players[1 - p];
  const t = foe.champions[foe.active];
  if (!t.alive) return;
  const dmg = Math.max(1, (m.damage || 3) + c.atk);
  t.hp = Math.max(0, t.hp - dmg);
  ev.push({ type: 'damage', ...who(s, 1 - p, foe.active), amount: dmg });
  if (t.hp === 0) {
    t.alive = false;
    ev.push({ type: 'ko', ...who(s, 1 - p, foe.active) });
  }
}

function finish(s, ev, winner, reason) {
  s.winner = winner;
  s.endReason = reason;
  s.phase = 'ended';
  ev.push({ type: 'end', winner, reason });
}

function afterTurn(s, ev) {
  const dead = s.players.map((pl) => pl.champions.every((c) => !c.alive));
  if (dead[0] || dead[1]) return finish(s, ev, dead[0] && dead[1] ? 'draw' : dead[0] ? 1 : 0, 'ko');
  if (s.round > s.rules.maxRounds) {
    const pct = (pl) => pl.champions.reduce((n, c) => n + c.hp, 0) / pl.champions.reduce((n, c) => n + c.maxHp, 0);
    const a = pct(s.players[0]);
    const b = pct(s.players[1]);
    return finish(s, ev, a === b ? 'draw' : a > b ? 0 : 1, 'rounds');
  }
  const replace = [0, 1].filter((p) => needsReplacement(s, p));
  if (replace.length) {
    s.phase = 'replace';
    replace.forEach((p) => ev.push({ type: 'phaseReplace', player: p }));
  } else {
    s.phase = 'choose';
  }
  return undefined;
}

function resolve(s, ev) {
  const choices = s.choices;
  s.choices = [null, null];
  if (s.phase === 'replace') {
    [0, 1].forEach((p) => choices[p] && doSwitch(s, ev, p, choices[p].to));
    s.phase = 'choose';
    return;
  }
  [0, 1].forEach((p) => choices[p].type === 'switch' && doSwitch(s, ev, p, choices[p].to));
  const sp = (p) => s.players[p].champions[s.players[p].active].speed;
  const order = sp(0) === sp(1) ? (rand(s) < 0.5 ? [0, 1] : [1, 0]) : sp(0) > sp(1) ? [0, 1] : [1, 0];
  ev.push({ type: 'turnOrder', order });
  order.forEach((p) => {
    if (choices[p].type === 'move') doMove(s, ev, p, choices[p]);
    else if (choices[p].type === 'pass') ev.push({ type: 'pass', player: p });
  });
  s.round += 1;
  s.players.forEach((pl) => { pl.chakra = Math.min(RULES.chakraMax, pl.chakra + RULES.chakraPerTurn); });
  ev.push({ type: 'round', round: s.round });
  afterTurn(s, ev);
}

function submit(input, p, action) {
  if (!input || input.phase === 'ended') throw new Error('Le duel est terminé.');
  if (!pendingPlayers(input).includes(p)) throw new Error('Ce joueur n’a pas de choix à faire.');
  const legal = legalActions(input, p).find((a) => key(a) === key(action));
  if (!legal) throw new Error('Action illégale.');
  const state = clone(input);
  state.choices[p] = clone(legal);
  const events = [];
  const resolved = pendingPlayers(state).length === 0;
  if (resolved) resolve(state, events);
  state.log.push(...events.map(describeEvent));
  return { state, events, resolved };
}

function viewFor(state, p) {
  const v = clone(state);
  v.choices[1 - p] = null;
  return v;
}

/** IA : remplace par le premier vivant ; change si l'actif est bas et un équipier en forme ; sinon ultime > attaque. */
function chooseAction(state, p) {
  const legal = legalActions(state, p);
  if (!legal.length) return { type: 'pass' };
  if (state.phase === 'replace') return legal[0];
  const me = state.players[p];
  const act = me.champions[me.active];
  const fresh = legal.find((a) => a.type === 'switch' && me.champions[a.to].hp >= me.champions[a.to].maxHp * 0.6);
  if (act.hp <= act.maxHp * 0.4 && fresh) return fresh;
  const kind = (a) => act.moves[a.move].kind;
  return legal.find((a) => a.type === 'move' && kind(a) === 'ultimate') ||
    legal.find((a) => a.type === 'move' && kind(a) === 'attack') || legal[legal.length - 1];
}

function forfeit(input, p, reason) {
  const state = clone(input);
  const events = [{ type: 'forfeit', player: p, reason: reason || 'forfeit' }];
  state.choices = [null, null];
  finish(state, events, 1 - p, reason || 'forfeit');
  return { state, events };
}

function describeEvent(e) {
  switch (e.type) {
    case 'damage': return `${e.name} subit ${e.amount} dégâts.`;
    case 'heal': return `${e.name} récupère ${e.amount} PV.`;
    case 'ko': return `${e.name} est K.O.`;
    case 'switch': return `${e.name} entre en jeu.`;
    case 'phaseReplace': return `Le joueur ${e.player + 1} choisit un remplaçant.`;
    case 'turnOrder': return `Ordre : joueur ${e.order[0] + 1} puis joueur ${e.order[1] + 1}.`;
    case 'round': return `Tour ${e.round}.`;
    case 'pass': return `Le joueur ${e.player + 1} passe.`;
    case 'forfeit': return `Le joueur ${e.player + 1} abandonne.`;
    case 'end': return e.winner === 'draw' ? 'Match nul.' : `Victoire du joueur ${e.winner + 1}.`;
    default: return String(e.type);
  }
}

module.exports = {
  version: 'stub-2', RULES, TYPES, mythics, validateDeck, createMatch, pendingPlayers, legalActions, submit, viewFor,
  chooseAction, forfeit, describeEvent, typeOf
};
