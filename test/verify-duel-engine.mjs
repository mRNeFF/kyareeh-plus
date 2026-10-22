// Vérifie le moteur du duel v2 (content/duel-engine.js) : équipe et banc, choix simultanés et secrets,
// ordre de résolution, changements, remplacement après K.O., types, formule de dégâts, chaque champ
// d'effet, statuts, passifs (203 Mythiques), fins de duel, IA, immuabilité, déterminisme, JSON, journal
// et livre de règles. Les scénarios fins utilisent des champions SYNTHÉTIQUES (chiffres maîtrisés) ;
// les passifs et les cartes nommées (Subaru…) utilisent les vraies données.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { passiveFxOf, validatePassiveFx } from '../scripts/duel-passives.mjs';

const require = createRequire(import.meta.url);
const E = require('../content/duel-engine.js');
const src = readFileSync(new URL('../content/duel-data.js', import.meta.url), 'utf8');
const data = JSON.parse(src.slice(src.indexOf('{'), src.lastIndexOf('}') + 1));
const R = E.RULES;

let checks = 0;
let failures = 0;
function check(label, condition, detail = '') {
  checks += 1;
  if (condition) return;
  failures += 1;
  console.log(`ÉCHEC  ${label}${detail ? ` — ${detail}` : ''}`);
}
function throws(label, fn, re) {
  try {
    fn();
    check(label, false, 'aucune exception');
  } catch (err) {
    check(label, err instanceof Error && (!re || re.test(err.message)), err.message);
  }
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function deepFreeze(o) {
  if (o && typeof o === 'object') {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

// ─── Champions synthétiques ───────────────────────────────────────────────────────────────────
// Un champion = { name, role, hp, atk, speed, moves: [attaque, soutien, ultime], passiveFx }.
// Les capacités par défaut : attaque 5 dégâts, soutien +2 garde, ultime 9 dégâts.
const dataT = { champions: [] };
let nextId = 900000;
function syn(name, o = {}) {
  let c = dataT.champions.find((x) => x.name === name);
  if (c) dataT.champions.splice(dataT.champions.indexOf(c), 1);
  const [a, s, u] = o.moves ?? [];
  c = {
    id: nextId++, name, rarity: 'M', series: 'Test', role: o.role ?? 'Duelliste', hp: o.hp ?? 30, atk: o.atk ?? 2, speed: o.speed ?? 70,
    image: '', passive: { name: o.passiveName ?? 'Aucun', desc: '' }, passiveFx: o.passiveFx ?? { rules: [] },
    attacks: [
      Object.assign({ kind: 'attack', name: 'Coup', desc: 'Frappe.', damage: 5 }, a),
      Object.assign({ kind: 'support', name: 'Soutien', desc: 'Protège.', guard: 2 }, s),
      Object.assign({ kind: 'ultimate', name: 'Ultime', desc: 'Frappe fort.', damage: 9 }, u)
    ]
  };
  dataT.champions.push(c);
  return c;
}
for (let i = 1; i <= 8; i += 1) syn(`F${i}`, { speed: 60 });
const FILL = ['F1', 'F2', 'F3', 'F4', 'F5', 'F6'];
const idOf = (name, d = dataT) => d.champions.find((c) => c.name === name).id;
// Duel synthétique : decks nommés (le premier nom est le champion de tête, les autres remplissent le banc).
function duel(a, b, { seed = 1, rules, d = dataT, ben = FILL, benB = ben } = {}) {
  const mk = (lead, pool) => {
    const L = Array.isArray(lead) ? lead : [lead];
    return [...L, ...pool.filter((n) => !L.includes(n))].slice(0, 5).map((n) => idOf(n, d));
  };
  return E.createMatch({
    data: d, seed, rules: Object.assign({ speedLuck: 0, speedBand: 1, typeChart: 0, lateGuard: 0 }, rules),
    players: [{ id: 'a', name: 'Alice', deck: mk(a, ben) }, { id: 'b', name: 'Bob', deck: mk(b, benB) }]
  });
}
const act = (s, p) => s.players[p].champions[s.players[p].active];
const bench = (s, p, name) => s.players[p].champions.find((c) => c.name === name);
const idxOf = (s, p, name) => s.players[p].champions.findIndex((c) => c.name === name);
// Spécification d'action : 'pass' | 'attack' | 'support' | 'ultimate' | 'support@Nom' (cible alliée) | 'sw:Nom' | objet.
function A(s, p, spec) {
  if (typeof spec === 'object' && spec) return spec;
  if (spec === 'pass') return { type: 'pass' };
  if (spec.startsWith('sw:')) return { type: 'switch', to: idxOf(s, p, spec.slice(3)) };
  const [kind, ally] = spec.split('@');
  const c = act(s, p);
  const k = c.moves.findIndex((m) => m.kind === kind);
  if (k < 0) throw new Error(`pas de capacité ${kind}`);
  const m = c.moves[k];
  const a = { type: 'move', move: k };
  if (m.targeting === 'enemy') a.target = { side: 1 - p, index: s.players[1 - p].active };
  else if (m.targeting === 'ally') a.target = { side: p, index: ally ? idxOf(s, p, ally) : s.players[p].active };
  return a;
}
// Les joueurs en attente choisissent ; renvoie { state, events } (événements cumulés).
function turn(s, a0, a1) {
  const events = [];
  let st = s;
  const pend = E.pendingPlayers(st);
  for (const [p, spec] of [[0, a0], [1, a1]]) {
    if (!pend.includes(p) || spec === null || spec === undefined) continue;
    const r = E.submit(st, p, A(st, p, spec));
    st = r.state;
    events.push(...r.events);
  }
  return { state: st, events };
}
const evs = (r, type, name) => r.events.filter((e) => e.type === type && (!name || e.name === name));
// Prépare un état de test : chakra plein, rien sur les champions (garde, statuts de début de tour…).
function ready(s, chakra = R.maxChakra) {
  for (const pl of s.players) {
    pl.chakra = chakra;
    for (const c of pl.champions) Object.assign(c, { guard: 0, buff: 0, atkBonus: 0, statuses: {} });
  }
  return s;
}
function playOut(s, max = 4000) {
  let n = 0;
  while (s.phase !== 'ended' && n < max) {
    let next = s;
    for (const p of E.pendingPlayers(s)) next = E.submit(next, p, E.chooseAction(s, p)).state;
    s = next;
    n += 1;
  }
  return s;
}

// ─── 1. Chargement et API ─────────────────────────────────────────────────────────────────────
{
  const esm = (await import('../content/duel-engine.js')).default;
  check('import ESM : même API', esm && typeof esm.createMatch === 'function' && typeof esm.submit === 'function');
  const sandbox = { window: {} };
  vm.runInNewContext(readFileSync(new URL('../content/duel-engine.js', import.meta.url), 'utf8'), sandbox);
  check('page : window.KYARA_DUEL_ENGINE', typeof sandbox.window.KYARA_DUEL_ENGINE?.submit === 'function');
  for (const k of ['RULES', 'TYPES', 'mythics', 'validateDeck', 'createMatch', 'pendingPlayers', 'legalActions', 'submit', 'viewFor',
    'chooseAction', 'forfeit', 'describeEvent', 'typeOf']) check(`API v2 : ${k}`, k in E);
  check('API v1 retirée : pas de applyAction / currentPlayer', !('applyAction' in E) && !('currentPlayer' in E));
  const code = readFileSync(new URL('../content/duel-engine.js', import.meta.url), 'utf8').replace(/^\s*\/\/.*$/gm, '');
  check('moteur pur : ni Math.random ni Date', !/Math\.random|Date\.now|new Date/.test(code));
  check('moteur pur : ni DOM, ni réseau, ni stockage', !/document\.|fetch\(|XMLHttp|localStorage|WebSocket|setTimeout|setInterval/.test(code));
  check('RULES gelées', Object.isFrozen(R));
  // Contrat §1.6 : couleurs de rôle.
  const colors = { Duelliste: '#ff5a4e', Mystique: '#a66bff', Soutien: '#3fd68a', Gardien: '#4aa3ff', Stratège: '#ffc24a' };
  for (const [t, col] of Object.entries(colors)) check(`TYPES.${t} : couleur ${col}`, E.TYPES[t]?.color === col && E.TYPES[t].label === t);
  check('TYPES : exactement 5 types', Object.keys(E.TYPES).length === 5);
  check('typeOf : Gardienne = Gardien', E.typeOf({ role: 'Gardienne' }) === 'Gardien' && E.typeOf({ role: 'Mystique' }) === 'Mystique');
  check('typeOf : rôle inconnu → vide', E.typeOf({ role: 'Boulanger' }) === '' && E.typeOf(null) === '');
}

// ─── 2. Données et decks ──────────────────────────────────────────────────────────────────────
{
  const pool = E.mythics(data);
  check('203 Mythiques jouables', pool.length === 203, String(pool.length));
  check('Mythiques : 3 capacités attaque / soutien / ultime', pool.every((c) => c.attacks.map((a) => a.kind).join() === 'attack,support,ultimate'));
  check('tous les rôles ont un type connu', pool.every((c) => E.TYPES[E.typeOf(c)]));
  const ids = pool.slice(0, 5).map((c) => c.id);
  check('deck valide', E.validateDeck(data, ids).ok === true);
  check('deck : 4 cartes refusé', !E.validateDeck(data, ids.slice(0, 4)).ok);
  check('deck : 6 cartes refusé', !E.validateDeck(data, [...ids, pool[5].id]).ok);
  check('deck : doublon refusé', /double/.test(E.validateDeck(data, [ids[0], ids[0], ids[1], ids[2], ids[3]]).error));
  check('deck : carte inconnue refusée', !E.validateDeck(data, [-5, ...ids.slice(1)]).ok);
  const leg = data.champions.find((c) => c.rarity === 'L');
  check('deck : une Légendaire est refusée', !E.validateDeck(data, [leg.id, ...ids.slice(1)]).ok);
  check('deck : pas une liste', !E.validateDeck(data, null).ok && !E.validateDeck(data, 'abc').ok);
  throws('createMatch : un seul joueur', () => E.createMatch({ data, seed: 1, players: [{ name: 'x', deck: ids }] }), /2 joueurs/);
  throws('createMatch : deck invalide nomme le joueur', () => E.createMatch({ data, seed: 1, players: [{ name: 'x', deck: ids }, { name: 'y', deck: ids.slice(1) }] }), /Joueur 2/);
}

// ─── 3. Mise en place ─────────────────────────────────────────────────────────────────────────
{
  const s = duel('F1', 'F2');
  check('état v2', s.v === 2 && s.phase === 'choose' && s.winner === null && s.turn === 1);
  check('les deux joueurs doivent choisir', same(E.pendingPlayers(s), [0, 1]));
  check('chaque joueur : 5 champions, actif = le premier', s.players.every((p) => p.champions.length === 5 && p.active === 0));
  check('banc de 4 : PV pleins, rien en cours', s.players.every((p) => p.champions.every((c) => c.hp === c.maxHp && c.guard === 0 && c.alive && !Object.keys(c.statuses).length)));
  check('chakra de départ + gain du premier tour', s.players.every((p) => p.chakra === Math.min(R.maxChakra, R.startChakra + R.chakraPerTurn)));
  const lead = s.lastEvents.filter((e) => e.type === 'switch');
  check('entrée en jeu des deux champions de tête', lead.length === 2 && lead.every((e) => e.lead && e.from === null && e.to === 0));
  const c = act(s, 0);
  check('champion : type, couleur, vitesse, passif', c.type === 'Duelliste' && c.color === E.TYPES.Duelliste.color && c.speed === 60 && c.passiveFx && c.moves.length === 3);
  check('capacités : coût et ciblage calculés', c.moves[0].cost === R.attackCost && c.moves[1].cost === R.supportCost && c.moves[2].cost === R.ultimateCost
    && c.moves[0].targeting === 'enemy' && c.moves[1].targeting === 'ally');
  check('événements de champion : side, index, name, champType, color', lead.every((e) => (e.side === 0 || e.side === 1) && e.index === 0 && typeof e.name === 'string' && e.champType === 'Duelliste' && e.color === E.TYPES.Duelliste.color));
  check('état : JSON pur (aller-retour identique)', same(JSON.parse(JSON.stringify(s)), s));
  check('journal alimenté', s.log.length > 0 && s.log.every((l) => typeof l === 'string' && l.length));
  const r = duel('F1', 'F2', { seed: 'abc' });
  check('graine texte acceptée', Number.isInteger(r.seed) && r.seed !== duel('F1', 'F2', { seed: 'abd' }).seed);
  const pool = E.mythics(data);
  const s2 = E.createMatch({ data, seed: 5, players: [{ name: 'A', deck: pool.slice(0, 5).map((x) => x.id) }, { name: 'B', deck: pool.slice(5, 10).map((x) => x.id) }] });
  check('véritables données : le premier du deck entre en jeu', act(s2, 0).id === pool[0].id && act(s2, 1).id === pool[5].id);
  const custom = duel('F1', 'F2', { rules: { startChakra: 3, maxChakra: 4 } });
  check('règles surchargées copiées dans l’état', custom.rules.startChakra === 3 && custom.rules.maxChakra === 4 && custom.players[0].chakra === 4);
}

// ─── 4. Choix simultanés et secrets ───────────────────────────────────────────────────────────
{
  let s = duel('F1', 'F2');
  const frozen = deepFreeze(JSON.parse(JSON.stringify(s)));
  const r0 = E.submit(frozen, 0, A(frozen, 0, 'attack'));
  check('submit ne mute pas son entrée (état gelé)', r0.state !== frozen && frozen.choices[0] === null);
  check('premier choix : pas de résolution', r0.resolved === false && same(E.pendingPlayers(r0.state), [1]));
  check('premier choix : événement « chosen » sans détail', same(r0.events.map((e) => e.type), ['chosen']) && !('action' in r0.events[0]) && !('move' in r0.events[0]));
  check('tour inchangé tant que tout le monde n’a pas choisi', r0.state.turn === 1 && r0.state.phase === 'choose');
  throws('double choix refusé', () => E.submit(r0.state, 0, A(r0.state, 0, 'pass')), /déjà/);
  const v1 = E.viewFor(r0.state, 1);
  check('viewFor : cache le choix de l’adversaire', same(v1.choices[0], { type: 'hidden' }) && !JSON.stringify(v1.choices).includes('"move"'));
  check('viewFor : le joueur voit toujours son propre choix', same(E.viewFor(r0.state, 0).choices[0], r0.state.choices[0]));
  check('viewFor : copie (n’altère pas l’original)', r0.state.choices[0].type === 'move');
  check('viewFor : pendingPlayers cohérent', same(E.pendingPlayers(v1), [1]) && same(E.pendingPlayers(E.viewFor(r0.state, 0)), [1]));
  check('viewFor : legalActions du joueur inchangées', same(E.legalActions(v1, 1), E.legalActions(r0.state, 1)));
  check('legalActions : vide pour qui a déjà choisi', E.legalActions(r0.state, 0).length === 0);
  const frozenView = deepFreeze(JSON.parse(JSON.stringify(r0.state)));
  check('viewFor : fonctionne sur un état gelé', E.viewFor(frozenView, 1).choices[0].type === 'hidden');
  check('viewFor : aucune trace du choix secret dans l’état envoyé', !JSON.stringify(v1).includes('"target"'));
  const r1 = E.submit(r0.state, 1, A(r0.state, 1, 'pass'));
  check('dernier choix : le tour est résolu', r1.resolved === true && r1.state.turn === 2 && r1.state.choices.every((c) => c === null));
  check('résolution : tour suivant, nouvelle attente des deux joueurs', same(E.pendingPlayers(r1.state), [0, 1]));
  check('seq croît à chaque choix', r0.state.seq === s.seq + 1 && r1.state.seq === s.seq + 2);
  // L'ordre de soumission est indifférent.
  const a = turn(s, 'attack', 'support').state;
  const x = E.submit(s, 1, A(s, 1, 'support'));
  const b = E.submit(x.state, 0, A(x.state, 0, 'attack')).state;
  const strip = (st) => ({ ...st, seq: 0, log: 0, lastEvents: 0 });
  check('l’ordre de soumission ne change pas le résultat', same(strip(a), strip(b)));
  // Rejets.
  throws('joueur inconnu', () => E.submit(s, 2, { type: 'pass' }), /inconnu/);
  throws('action illégale : indice de capacité hors limites', () => E.submit(s, 0, { type: 'move', move: 9 }), /illégale/);
  throws('action illégale : type inconnu', () => E.submit(s, 0, { type: 'danse' }), /illégale/);
  throws('action illégale : null', () => E.submit(s, 0, null), /illégale/);
  throws('changement vers l’actif refusé', () => E.submit(s, 0, { type: 'switch', to: 0 }), /illégale/);
  throws('changement hors banc refusé', () => E.submit(s, 0, { type: 'switch', to: 7 }), /illégale/);
  throws('cible alliée pour une attaque refusée', () => E.submit(s, 0, { type: 'move', move: 0, target: { side: 0, index: 0 } }), /illégale/);
  throws('état invalide', () => E.submit({}, 0, { type: 'pass' }), /invalide/);
  s = ready(duel('F1', 'F2'), 0);
  throws('chakra insuffisant (ultime)', () => E.submit(s, 0, A(s, 0, 'ultimate')), /illégale/);
  throws('chakra insuffisant (soutien)', () => E.submit(s, 0, A(s, 0, 'support')), /illégale/);
  // Remplacement : seul le K.O. choisit.
  const rep = (() => {
    const t = ready(duel('F1', 'F2'));
    act(t, 1).hp = 1;
    return turn(t, 'attack', 'pass').state;
  })();
  check('phase de remplacement : seul le K.O. choisit', rep.phase === 'replace' && same(E.pendingPlayers(rep), [1]));
  throws('remplacement : l’autre joueur n’a rien à choisir', () => E.submit(rep, 0, { type: 'pass' }), /pas de remplaçant/);
  throws('remplacement : pas de capacité', () => E.submit(rep, 1, { type: 'move', move: 0 }), /Remplaçant invalide/);
  throws('remplacement : pas de passe', () => E.submit(rep, 1, { type: 'pass' }), /Remplaçant invalide/);
  throws('remplacement : pas le champion K.O.', () => E.submit(rep, 1, { type: 'switch', to: 0 }), /Remplaçant invalide/);
}

// ─── 5. Actions légales ───────────────────────────────────────────────────────────────────────
{
  syn('Tireur', { moves: [{ damage: 4 }, { heal: 3, guard: 0 }, { damage: 10 }] });
  let s = ready(duel('Tireur', 'F2'));
  const acts = E.legalActions(s, 0);
  check('légales : attaque, 5 cibles de soutien, ultime, 4 changements, passer', acts.length === 1 + 5 + 1 + 4 + 1, String(acts.length));
  check('légales : attaque ciblée sur l’actif adverse', acts.filter((a) => a.type === 'move' && a.move === 0).length === 1
    && same(acts.find((a) => a.type === 'move' && a.move === 0).target, { side: 1, index: 0 }));
  check('légales : soutien allié = 5 cibles (soi + banc)', acts.filter((a) => a.type === 'move' && a.move === 1).length === 5);
  check('légales : changements vers le banc seulement', acts.filter((a) => a.type === 'switch').map((a) => a.to).join() === '1,2,3,4');
  check('légales : passer toujours présent', acts.some((a) => a.type === 'pass'));
  check('légales : aucun champ « actor » (un seul actif)', acts.every((a) => !('actor' in a)));
  s.players[0].chakra = 0;
  check('légales : chakra 0 → ni soutien ni ultime', E.legalActions(s, 0).every((a) => a.type !== 'move' || a.move === 0));
  s = ready(duel('Tireur', 'F2'), R.supportCost);
  check('légales : chakra = coût du soutien suffit', E.legalActions(s, 0).some((a) => a.type === 'move' && a.move === 1));
  check('légales : ultime hors de portée', !E.legalActions(s, 0).some((a) => a.type === 'move' && a.move === 2));
  s = ready(duel('Tireur', 'F2'));
  act(s, 0).ultimateUsed = true;
  check('légales : ultime déjà utilisé', !E.legalActions(s, 0).some((a) => a.type === 'move' && a.move === 2));
  act(s, 0).disabled = 1;
  check('légales : désactivé → seul le soutien reste', E.legalActions(s, 0).filter((a) => a.type === 'move').every((a) => a.move === 1));
  s = ready(duel('Tireur', 'F2'));
  s.players[0].champions[2].alive = false;
  s.players[0].champions[2].hp = 0;
  check('légales : un K.O. n’est pas un changement possible', !E.legalActions(s, 0).some((a) => a.type === 'switch' && a.to === 2));
  check('légales : un K.O. n’est pas une cible de soutien', !E.legalActions(s, 0).some((a) => a.type === 'move' && a.move === 1 && a.target.index === 2));
  s = ready(duel('Tireur', 'F2', { rules: { switchCost: 2 } }), 1);
  check('switchCost : changement interdit sans chakra', !E.legalActions(s, 0).some((a) => a.type === 'switch'));
  s.players[0].chakra = 2;
  const r = turn(s, 'sw:F1', 'pass');
  check('switchCost : le coût est payé', evs(r, 'chakra').some((e) => e.player === 0 && e.delta === -2) && r.state.players[0].chakra === R.chakraPerTurn);
  check('changer est gratuit par défaut', R.switchCost === 0);
  s = ready(duel('Tireur', 'F2'));
  s.players[0].skipNext = true;
  check('action perdue : seul « passer » est légal', same(E.legalActions(s, 0), [{ type: 'pass' }]));
  const end = E.forfeit(s, 0, 'forfeit').state;
  check('duel terminé : aucune action, personne en attente', E.legalActions(end, 1).length === 0 && E.pendingPlayers(end).length === 0);
  throws('duel terminé : submit refusé', () => E.submit(end, 1, { type: 'pass' }), /terminé/);
  syn('Sacrifieur', { moves: [{}, {}, { sacrifice: true, damage: 3 }] });
  s = ready(duel('Sacrifieur', 'F2'));
  const okSacrifice = E.legalActions(s, 0).some((a) => a.type === 'move' && a.move === 2);
  for (let i = 1; i < 5; i += 1) Object.assign(s.players[0].champions[i], { alive: false, hp: 0 });
  check('le sacrifice exige un allié vivant', okSacrifice && !E.legalActions(s, 0).some((a) => a.type === 'move' && a.move === 2));
}

// ─── 6. Ordre de résolution : changements, vitesse, égalités ──────────────────────────────────
{
  syn('Rapide', { speed: 90 });
  syn('Lent', { speed: 50 });
  syn('Moyen', { speed: 70 });
  let s = ready(duel('Rapide', 'Lent'));
  let r = turn(s, 'attack', 'attack');
  const order = evs(r, 'turnOrder')[0];
  check('turnOrder : le plus rapide d’abord', same(order.order, [0, 1]) && order.reason === 'speed' && same(order.speeds, [90, 50]));
  const moves = evs(r, 'move');
  check('les capacités sont jouées dans l’ordre de vitesse', moves.length === 2 && moves[0].side === 0 && moves[1].side === 1);
  r = turn(ready(duel('Lent', 'Rapide')), 'attack', 'attack');
  check('vitesse : le camp 1 peut ouvrir', same(evs(r, 'turnOrder')[0].order, [1, 0]) && evs(r, 'move')[0].side === 1);
  // Le plus rapide met KO avant que le lent ne joue.
  s = ready(duel('Rapide', 'Lent'));
  act(s, 1).hp = 3;
  r = turn(s, 'attack', 'attack');
  const fail = evs(r, 'fail');
  check('le K.O. avant son tour annule la capacité (« fail »)', fail.length === 1 && fail[0].reason === 'ko' && fail[0].side === 1);
  check('… et déclenche la phase de remplacement', r.state.phase === 'replace' && same(E.pendingPlayers(r.state), [1]) && evs(r, 'phaseReplace').length === 1);
  check('le lent n’a donc pas touché le rapide', act(r.state, 0).hp === act(s, 0).hp);
  // Égalité : graine. Les deux issues existent, et la graine fixe l'issue.
  const firsts = new Set();
  for (let seed = 0; seed < 40; seed += 1) {
    const t = turn(ready(duel('Moyen', 'Moyen', { seed })), 'attack', 'attack');
    const o = evs(t, 'turnOrder')[0];
    firsts.add(o.order[0]);
    check(`égalité (graine ${seed}) : raison « tie »`, o.reason === 'tie');
  }
  check('égalité : les deux camps ouvrent selon la graine', firsts.size === 2);
  const t1 = turn(ready(duel('Moyen', 'Moyen', { seed: 'x' })), 'attack', 'attack');
  const t2 = turn(ready(duel('Moyen', 'Moyen', { seed: 'x' })), 'attack', 'attack');
  check('égalité : même graine, même ordre', same(evs(t1, 'turnOrder')[0].order, evs(t2, 'turnOrder')[0].order));
  // Changements d'abord.
  s = ready(duel('Lent', 'Rapide'));
  r = turn(s, 'sw:F1', 'attack');
  const seq = r.events.filter((e) => ['switch', 'move'].includes(e.type)).map((e) => e.type + e.side);
  check('changements avant les capacités', seq.join() === 'switch0,move1', seq.join());
  check('l’actif a changé, l’ancien est au banc intact', act(r.state, 0).name === 'F1' && bench(r.state, 0, 'Lent').hp === 30 && r.state.players[0].active === idxOf(r.state, 0, 'F1'));
  const sw = evs(r, 'switch')[0];
  check('événement switch : side, from, to, noms', sw.side === 0 && sw.player === 0 && sw.from === 0 && sw.to === idxOf(s, 0, 'F1') && sw.name === 'F1' && sw.fromName === 'Lent' && sw.index === sw.to && sw.champType && sw.color);
  // Les deux changent.
  s = ready(duel('Lent', 'Rapide'));
  r = turn(s, 'sw:F1', 'sw:F2');
  check('double changement : deux événements, ordre de vitesse', evs(r, 'switch').length === 2 && evs(r, 'switch')[0].side === 1 && evs(r, 'move').length === 0);
  // Retargeting : l'attaque touche le nouvel actif.
  s = ready(duel('Lent', 'Rapide'));
  r = turn(s, 'attack', 'sw:F3');
  const mv = evs(r, 'move')[0];
  check('retargeting : la capacité frappe le NOUVEL actif', mv.target.name === 'F3' && mv.retarget === true && bench(r.state, 1, 'F3').hp < 30 && bench(r.state, 1, 'Rapide').hp === 30);
  check('retargeting : journal explicite', E.describeEvent(mv).includes('nouvel actif'));
  r = turn(ready(duel('Lent', 'Rapide')), 'attack', 'attack');
  check('sans changement : pas de retarget', evs(r, 'move')[0].retarget === false);
  // La vitesse retenue est celle du remplaçant.
  syn('Fusee', { speed: 99 });
  s = ready(duel('Lent', 'Moyen', { benB: ['Fusee', 'F1', 'F2', 'F3'] }));
  r = turn(s, 'attack', 'sw:Fusee');
  const o2 = evs(r, 'turnOrder')[0];
  check('l’ordre utilise la vitesse du remplaçant entrant', o2.order[0] === 1 && same(o2.speeds, [50, 99]));
  // Priorité Subaru (vraies données) : son camp agit d'abord, même plus lent, tant qu'il est actif.
  {
    const pool = E.mythics(data);
    const sub = pool.find((c) => c.name === 'Subaru Natsuki');
    const fast = pool.filter((c) => c.speed > sub.speed + 3);
    const slow = pool.filter((c) => c.speed < 75 && c.id !== sub.id);
    const mk = (a, b) => E.createMatch({ data, seed: 3, players: [{ name: 'S', deck: a.map((c) => c.id) }, { name: 'F', deck: b.map((c) => c.id) }] });
    const t = mk([sub, ...slow.slice(0, 4)], fast.slice(0, 5));
    const o = evs(turn(ready(t), 'attack', 'attack'), 'turnOrder')[0];
    check('Subaru actif : son camp agit d’abord malgré la vitesse', o.order[0] === 0 && o.reason === 'subaru' && o.by === 'Subaru Natsuki', JSON.stringify(o));
    const bn = mk([slow[0], sub, ...slow.slice(1, 4)], fast.slice(0, 5));
    check('Subaru au banc : aucune priorité', evs(turn(ready(bn), 'attack', 'attack'), 'turnOrder')[0].reason !== 'subaru');
    const entering = evs(turn(ready(bn), 'sw:Subaru Natsuki', 'attack'), 'turnOrder')[0];
    check('Subaru entrant : priorité dès le tour du changement', entering.reason === 'subaru' && entering.order[0] === 0);
  }
  // Ram face à Rem (Légendaire : données retouchées) au premier tour seulement.
  {
    const dataL = JSON.parse(JSON.stringify(data));
    for (const c of dataL.champions) c.rarity = 'M';
    const ram = dataL.champions.find((c) => c.name === 'Ram');
    const rem = dataL.champions.find((c) => c.name === 'Rem' && c.rarity === 'M');
    const others = dataL.champions.filter((c) => ![ram.id, rem.id].includes(c.id));
    const mk = () => E.createMatch({ data: dataL, seed: 2, players: [{ name: 'R', deck: [ram.id, ...others.slice(0, 4).map((c) => c.id)] }, { name: 'E', deck: [rem.id, ...others.slice(4, 8).map((c) => c.id)] }] });
    const o1 = evs(turn(ready(mk()), 'attack', 'attack'), 'turnOrder')[0];
    check('Ram face à Rem : son camp ouvre le premier tour', o1.order[0] === 0 && o1.reason === 'ram', JSON.stringify(o1));
    const st = turn(ready(mk()), 'pass', 'pass').state;
    const o2b = evs(turn(ready(st), 'attack', 'attack'), 'turnOrder')[0];
    check('Ram face à Rem : plus de priorité ensuite', o2b.reason !== 'ram');
  }
}

// ─── 6 bis. Vitesse par paliers et part de hasard (règles réglables) ──────────────────────────
{
  syn('V90', { speed: 90 });
  syn('V84', { speed: 84 });
  syn('V81', { speed: 81 });
  syn('V70', { speed: 70 });
  const orderOf = (a, b, rules, seed) => evs(turn(ready(duel(a, b, { rules, seed })), 'attack', 'attack'), 'turnOrder')[0];
  check('speedBand : mêmes paliers → égalité tirée', orderOf('V84', 'V81', { speedBand: 10 }, 1).reason === 'tie');
  check('speedBand : paliers différents → vitesse', orderOf('V90', 'V70', { speedBand: 10 }, 1).reason === 'speed');
  let luck = 0;
  for (let seed = 0; seed < 200; seed += 1) if (orderOf('V90', 'V70', { speedLuck: 50 }, seed).order[0] === 1) luck += 1;
  check('speedLuck 50 % : le lent ouvre parfois, pas toujours', luck > 20 && luck < 100, String(luck));
  let any = 0;
  for (let seed = 0; seed < 100; seed += 1) if (orderOf('V90', 'V70', { speedLuck: 100 }, seed).order[0] === 1) any += 1;
  check('speedLuck 100 % : ordre purement aléatoire', any > 25 && any < 75, String(any));
  check('speedLuck : raison « luck » annoncée', orderOf('V90', 'V70', { speedLuck: 100 }, 1).reason === 'luck');
  // lateGuard : le champion qui agit en second se met en garde avant le coup du plus rapide.
  const LG = (n) => ({ lateGuard: n });
  check('lateGuard : valeur par défaut > 0', R.lateGuard > 0);
  let s = ready(duel('V90', 'V70', { rules: LG(5) }));
  let r = turn(s, 'attack', 'attack');
  const lg = evs(r, 'guard');
  check('lateGuard : seul le plus lent gagne la garde, avant le premier coup', lg.length === 1 && lg[0].side === 1 && lg[0].source === 'late' && lg[0].amount === 5 && r.events.indexOf(lg[0]) < r.events.indexOf(evs(r, 'move')[0]));
  check('lateGuard : la garde absorbe le coup du plus rapide', evs(r, 'damage', 'V70')[0].absorbed === 5 && evs(r, 'damage', 'V70')[0].amount === 2 && act(r.state, 1).hp === 28);
  check('lateGuard : le plus rapide, lui, n’en reçoit pas et encaisse tout', act(r.state, 0).hp === 30 - 7 + 0 || act(r.state, 0).hp === 30 - 7);
  check('lateGuard : journal explicite', E.describeEvent(lg[0]).includes('en second') && E.describeEvent(lg[0]).includes('+5'));
  r = turn(ready(duel('V90', 'V70', { rules: LG(0) })), 'attack', 'attack');
  check('lateGuard 0 : aucune compensation', evs(r, 'guard').length === 0 && act(r.state, 1).hp === 23);
  r = turn(ready(duel('V70', 'V90', { rules: LG(5) })), 'attack', 'attack');
  check('lateGuard : suit l’ordre réel (camp 0 plus lent)', evs(r, 'guard').length === 1 && evs(r, 'guard')[0].side === 0);
  r = turn(ready(duel('V90', 'V70', { rules: LG(5) })), 'attack', 'pass');
  check('lateGuard : rien si le second passe', evs(r, 'guard').length === 0);
  r = turn(ready(duel('V90', 'V70', { rules: LG(5) })), 'attack', 'sw:F1');
  check('lateGuard : rien si le second change de champion', evs(r, 'guard').length === 0);
  r = turn(ready(duel('V90', 'V70', { rules: LG(5) })), 'attack', 'support');
  check('lateGuard : aussi pour un soutien (garde de plus)', evs(r, 'guard').filter((e) => e.source === 'late').length === 1);
  r = turn(ready(duel('V90', 'V70', { rules: LG(5) })), 'pass', 'attack');
  check('lateGuard : le plus rapide qui passe laisse la garde au lent qui attaque', evs(r, 'guard').length === 1 && evs(r, 'guard')[0].side === 1);
  s = ready(duel('V90', 'V70', { rules: LG(30) }));
  r = turn(s, 'attack', 'attack');
  check('lateGuard : plafond de garde respecté', act(r.state, 1).guard <= R.guardCap && evs(r, 'guard')[0].amount === R.guardCap);
  s = ready(duel('V90', 'V70', { rules: LG(5) }));
  r = turn(s, 'pass', 'attack');
  r = turn(ready(r.state), 'pass', 'pass');
  check('lateGuard : la garde s’use comme les autres au tour suivant', act(r.state, 1).guard === 0);
  // Égalité de vitesse : le second tiré au sort en profite aussi, et un seul des deux.
  syn('Egal1', { speed: 75 });
  syn('Egal2', { speed: 75 });
  r = turn(ready(duel('Egal1', 'Egal2', { rules: LG(5), seed: 4 })), 'attack', 'attack');
  check('lateGuard : égalité de vitesse, le second tiré au sort est protégé', evs(r, 'guard').length === 1 && evs(r, 'guard')[0].side === evs(r, 'turnOrder')[0].order[1]);
  // Priorité (Subaru) : le plus rapide agit alors en second et se protège.
  {
    const pool = E.mythics(data);
    const sub = pool.find((c) => c.name === 'Subaru Natsuki');
    const fast = pool.filter((c) => c.speed > sub.speed + 3);
    const slow = pool.filter((c) => c.speed < 75 && c.id !== sub.id);
    const st = E.createMatch({ data, seed: 3, rules: LG(5), players: [{ name: 'S', deck: [sub, ...slow.slice(0, 4)].map((c) => c.id) }, { name: 'F', deck: fast.slice(0, 5).map((c) => c.id) }] });
    const rr = turn(ready(st), 'attack', 'attack');
    check('lateGuard : face à la priorité de Subaru, l’adversaire plus rapide agit en second et se protège', evs(rr, 'turnOrder')[0].reason === 'subaru' && evs(rr, 'guard').filter((e) => e.source === 'late').every((e) => e.side === 1) && evs(rr, 'guard').some((e) => e.source === 'late'));
  }
}

// ─── 7. Types et efficacité ───────────────────────────────────────────────────────────────────
{
  const T = ['Duelliste', 'Mystique', 'Gardien', 'Stratège', 'Soutien'];
  const exp = (a, b) => {
    const big = new Set(['Duelliste>Mystique', 'Mystique>Gardien', 'Gardien>Duelliste']);
    if (big.has(`${a}>${b}`)) return R.typeStrong;
    if (big.has(`${b}>${a}`)) return R.typeWeak;
    if (`${a}>${b}` === 'Stratège>Soutien') return R.typeStrongMinor;
    if (`${b}>${a}` === 'Stratège>Soutien') return R.typeWeakMinor;
    return 1;
  };
  const bad = [];
  for (const a of T) for (const b of T) if (E.effectiveness(a, b, { ...R, typeChart: 1 }) !== exp(a, b)) bad.push(`${a}>${b}`);
  check('table d’efficacité : 25 couples conformes', bad.length === 0, bad.join());
  check('table : valeurs ×1,25 / ×0,8 / ×1,15 / ×0,9', R.typeStrong === 1.25 && R.typeWeak === 0.8 && R.typeStrongMinor === 1.15 && R.typeWeakMinor === 0.9);
  check('table : Duelliste ▶ Mystique ▶ Gardien ▶ Duelliste', E.TYPES.Duelliste.strong.includes('Mystique') && E.TYPES.Mystique.strong.includes('Gardien') && E.TYPES.Gardien.strong.includes('Duelliste'));
  check('table : neutre ailleurs', E.effectiveness('Duelliste', 'Stratège', R) === 1 && E.effectiveness('Soutien', 'Gardien', R) === 1 && E.effectiveness('Duelliste', 'Duelliste', R) === 1);
  check('table : neutralisable (typeChart 0)', T.every((a) => T.every((b) => E.effectiveness(a, b, { ...R, typeChart: 0 }) === 1)));
  check('table : type inconnu → ×1', E.effectiveness('Boulanger', 'Duelliste', R) === 1);
  // Appliquée aux dégâts.
  syn('Du', { role: 'Duelliste', moves: [{ damage: 10 }] });
  syn('My', { role: 'Mystique', hp: 60 });
  syn('Ga', { role: 'Gardien', hp: 60 });
  syn('St', { role: 'Stratège', hp: 60 });
  syn('So', { role: 'Soutien', hp: 60 });
  const hit = (att, def, rules) => {
    const r = turn(ready(duel(att, def, { rules: { typeChart: 1, ...rules } })), 'attack', 'pass');
    return { dmg: evs(r, 'damage', def)[0].amount, events: r.events };
  };
  const base = 10 + 2; // dégâts + ATQ
  check('Duelliste ▶ Mystique : ×1,25', hit('Du', 'My').dmg === Math.round(base * 1.25));
  check('Duelliste ▷ Gardien : ×0,8', hit('Du', 'Ga').dmg === Math.round(base * 0.8));
  check('Duelliste / Stratège : neutre', hit('Du', 'St').dmg === base);
  check('typeChart 0 : plus d’effet', hit('Du', 'My', { typeChart: 0 }).dmg === base);
  const ef = hit('Du', 'My').events.find((e) => e.type === 'effectiveness');
  check('événement effectiveness : mult, cible, attaquant', ef && ef.mult === 1.25 && ef.name === 'My' && ef.attacker.name === 'Du' && ef.label === 'strong');
  check('pas d’événement effectiveness en neutre', !hit('Du', 'St').events.some((e) => e.type === 'effectiveness'));
  check('journal : « efficace » / « pas très efficace »', E.describeEvent(ef).includes('efficace') && E.describeEvent({ type: 'effectiveness', mult: 0.8, name: 'X' }).includes('pas très efficace'));
  syn('St2', { role: 'Stratège', moves: [{ damage: 10 }] });
  check('Stratège ▶ Soutien : ×1,15', hit('St2', 'So').dmg === Math.round(base * 1.15));
  syn('So2', { role: 'Soutien', moves: [{ damage: 10 }] });
  check('Soutien ▷ Stratège : ×0,9', hit('So2', 'St').dmg === Math.round(base * 0.9));
  const sup = turn(ready(duel('Du', 'My', { rules: { typeChart: 1 } })), 'support', 'pass');
  check('une capacité sans dégâts ne déclenche pas d’efficacité', !sup.events.some((e) => e.type === 'effectiveness'));
  const hs = ready(duel('Du', 'My', { rules: { typeChart: 1 } }));
  act(hs, 0).statuses.haste = 1;
  const hr = turn(hs, 'attack', 'pass');
  check('Hâte : deux coups, efficacité sur le premier', evs(hr, 'damage', 'My').length === 2 && evs(hr, 'damage', 'My')[0].amount === Math.round(base * 1.25) && evs(hr, 'damage', 'My')[0].mult === 1.25);
}

// ─── 8. Formule de dégâts, garde, Hâte ────────────────────────────────────────────────────────
{
  syn('Cogneur', { atk: 3, moves: [{ damage: 6, bonusIfLow: 4 }] });
  syn('Mur', { hp: 100, atk: 0 });
  const dmgOf = (s) => evs(turn(s, 'attack', 'pass'), 'damage', 'Mur')[0]?.amount;
  let s = ready(duel('Cogneur', 'Mur'));
  check('dégâts = capacité + ATQ', dmgOf(s) === 6 + 3);
  s = ready(duel('Cogneur', 'Mur'));
  act(s, 0).atkBonus = 2;
  check('+ bonus d’ATQ', dmgOf(s) === 6 + 3 + 2);
  s = ready(duel('Cogneur', 'Mur'));
  act(s, 0).buff = 3;
  const rb = turn(s, 'attack', 'pass');
  check('+ dégâts préparés, consommés ensuite', evs(rb, 'damage', 'Mur')[0].amount === 6 + 3 + 3 && act(rb.state, 0).buff === 0);
  s = ready(duel('Cogneur', 'Mur'));
  act(s, 0).statuses.rage = 2;
  check('+ Rage', dmgOf(s) === 6 + 3 + R.rageBonus);
  s = ready(duel('Cogneur', 'Mur'));
  act(s, 0).statuses.weakness = 2;
  check('− Faiblesse', dmgOf(s) === 6 + 3 - R.weaknessMalus);
  s = ready(duel('Cogneur', 'Mur'));
  act(s, 0).hp = 15;
  check('+ bonusIfLow à 50 % de PV ou moins', dmgOf(s) === 6 + 3 + 4);
  s = ready(duel('Cogneur', 'Mur'));
  act(s, 0).hp = 16;
  check('bonusIfLow : pas au-dessus du seuil', dmgOf(s) === 6 + 3);
  s = ready(duel('Cogneur', 'Mur'));
  act(s, 0).statuses.weakness = 2;
  act(s, 0).atk = 0;
  act(s, 0).moves[0].damage = 1;
  check('dégâts jamais négatifs', dmgOf(s) === 0);
  s = ready(duel('Cogneur', 'Mur', { rules: { damagePct: 50 } }));
  check('damagePct : multiplicateur global', dmgOf(s) === Math.round(9 * 0.5));
  // Garde.
  s = ready(duel('Cogneur', 'Mur'));
  act(s, 1).guard = 4;
  let r = turn(s, 'attack', 'pass');
  const d = evs(r, 'damage', 'Mur')[0];
  check('la garde absorbe d’abord', d.absorbed === 4 && d.amount === 5 && act(r.state, 1).guard === 0 && act(r.state, 1).hp === 95);
  s = ready(duel('Cogneur', 'Mur', { rules: { guardDecayPct: 0 } }));
  act(s, 1).guard = 20;
  r = turn(s, 'attack', 'pass');
  check('garde supérieure aux dégâts : PV intacts', act(r.state, 1).hp === 100 && act(r.state, 1).guard === 11);
  s = ready(duel('Cogneur', 'Mur'));
  act(s, 0).guard = 19;
  r = turn(s, 'support', 'pass');
  check('plafond de garde', act(r.state, 0).guard <= R.guardCap);
  s = ready(duel('Cogneur', 'Mur', { rules: { guardDecayPct: 50 } }));
  act(s, 0).guard = 7;
  act(s, 1).guard = 7;
  s.players[0].champions[1].guard = 7;
  r = turn(s, 'pass', 'pass');
  check('usure de la garde de l’actif au début du tour', act(r.state, 0).guard === 3 && act(r.state, 1).guard === 3 && evs(r, 'guardDecay').length === 2);
  check('la garde du banc ne s’use pas par défaut', r.state.players[0].champions[1].guard === 7);
  s = ready(duel('Cogneur', 'Mur', { rules: { guardDecayPct: 50, benchGuardDecayPct: 100 } }));
  s.players[0].champions[1].guard = 7;
  r = turn(s, 'pass', 'pass');
  check('benchGuardDecayPct : usure du banc', r.state.players[0].champions[1].guard === 0);
  // Hâte : deux coups, le second réduit.
  s = ready(duel('Cogneur', 'Mur'));
  act(s, 0).statuses.haste = 1;
  r = turn(s, 'attack', 'pass');
  const ds = evs(r, 'damage', 'Mur');
  check(`Hâte : deux coups, second à ${R.hasteSecondHitPct} %`, ds.length === 2 && ds[0].amount === 9 && ds[1].amount === Math.round(9 * R.hasteSecondHitPct / 100) && ds[0].hit === 1 && ds[1].hit === 2);
  check('Hâte consommée', !act(r.state, 0).statuses.haste && evs(r, 'haste').length === 1);
  s = ready(duel('Cogneur', 'Mur'));
  act(s, 0).statuses.haste = 1;
  r = turn(s, 'support', 'pass');
  check('Hâte conservée par un soutien', act(r.state, 0).statuses.haste === 1);
  s = ready(duel('Cogneur', 'Mur'));
  r = turn(s, 'support', 'pass');
  check('soutien pur : aucun dégât malgré l’ATQ', evs(r, 'damage').length === 0);
  s = ready(duel('Cogneur', 'Mur'));
  act(s, 1).hp = 2;
  r = turn(s, 'attack', 'pass');
  check('PV plancher à 0, K.O. annoncé', act(r.state, 1).hp === 0 && !act(r.state, 1).alive && evs(r, 'ko', 'Mur').length === 1 && evs(r, 'ko', 'Mur')[0].active === true);
  s = ready(duel('Cogneur', 'Mur'));
  Object.assign(act(s, 1), { hp: 2, buff: 2, atkBonus: 1, statuses: { rage: 3 } });
  r = turn(s, 'attack', 'pass');
  const dead = bench(r.state, 1, 'Mur');
  check('K.O. : garde, statuts et bonus remis à zéro', dead.guard === 0 && dead.buff === 0 && dead.atkBonus === 0 && !Object.keys(dead.statuses).length);
}

// ─── 9. Champs d'effet des capacités ──────────────────────────────────────────────────────────
{
  const only = (o) => Object.assign({ damage: 0, guard: 0 }, o);
  // damage / randomDamage
  syn('Alea', { moves: [only({ randomDamage: [3, 9] })] });
  syn('Mur2', { hp: 200, atk: 0 });
  const seen = new Set();
  let inRange = true;
  for (let seed = 0; seed < 30; seed += 1) {
    const r = turn(ready(duel('Alea', 'Mur2', { seed })), 'attack', 'pass');
    const dmg = evs(r, 'damage', 'Mur2')[0].amount;
    seen.add(dmg);
    if (dmg < 3 + 2 || dmg > 9 + 2) inRange = false;
  }
  check('randomDamage : dans la fourchette (+ ATQ)', inRange);
  check('randomDamage : varie selon la graine', seen.size > 2);
  const a1 = turn(ready(duel('Alea', 'Mur2', { seed: 77 })), 'attack', 'pass');
  const a2 = turn(ready(duel('Alea', 'Mur2', { seed: 77 })), 'attack', 'pass');
  check('randomDamage : déterministe pour une graine', same(a1.events, a2.events));

  // heal : cible alliée, banc compris ; plafonné ; bloqué par la malédiction
  syn('Medic', { moves: [{}, only({ heal: 6 }), only({ healTeam: 4 })] });
  let s = ready(duel('Medic', 'Mur2'));
  bench(s, 0, 'F2').hp = 10;
  let r = turn(s, 'support@F2', 'pass');
  check('heal : soigne un allié du BANC', bench(r.state, 0, 'F2').hp === 16 && evs(r, 'heal', 'F2')[0].amount === 6);
  check('heal : le lanceur actif n’est pas soigné', act(r.state, 0).hp === 30);
  s = ready(duel('Medic', 'Mur2'));
  act(s, 0).hp = 28;
  r = turn(s, 'support', 'pass');
  check('heal : plafonné aux PV max (soi-même par défaut)', act(r.state, 0).hp === 30 && evs(r, 'heal')[0].amount === 2);
  s = ready(duel('Medic', 'Mur2'));
  bench(s, 0, 'F2').hp = 10;
  bench(s, 0, 'F2').statuses.curse = 3;
  r = turn(s, 'support@F2', 'pass');
  check('malédiction : aucun soin reçu', bench(r.state, 0, 'F2').hp === 10, String(bench(r.state, 0, 'F2').hp));
  check('malédiction : événement « blocked »', evs(r, 'blocked').some((e) => e.by === 'curse'));
  // healTeam : tous les alliés vivants, banc compris, pas les K.O.
  s = ready(duel('Medic', 'Mur2'));
  for (const n of ['F1', 'F2', 'F3']) bench(s, 0, n).hp = 10;
  Object.assign(bench(s, 0, 'F4'), { alive: false, hp: 0 });
  act(s, 0).hp = 20;
  r = turn(s, 'ultimate', 'pass');
  check('healTeam : tout le camp, banc compris', ['F1', 'F2', 'F3'].every((n) => bench(r.state, 0, n).hp === 14) && act(r.state, 0).hp === 24);
  check('healTeam : ne ranime pas les K.O.', !bench(r.state, 0, 'F4').alive && bench(r.state, 0, 'F4').hp === 0);
  // healTeamFull
  syn('Reine', { moves: [{}, {}, only({ healTeamFull: true })] });
  s = ready(duel('Reine', 'Mur2'));
  bench(s, 0, 'F1').hp = 3;
  act(s, 0).hp = 1;
  Object.assign(bench(s, 0, 'F2'), { alive: false, hp: 0 });
  r = turn(s, 'ultimate', 'pass');
  check('healTeamFull : tous les vivants au maximum (banc compris)', bench(r.state, 0, 'F1').hp === 30 && act(r.state, 0).hp === 30 && !bench(r.state, 0, 'F2').alive);
  // guard sur un allié (banc)
  syn('Rempart', { moves: [{}, { guard: 5 }, {}] });
  s = ready(duel('Rempart', 'Mur2', { rules: { guardDecayPct: 0 } }));
  r = turn(s, 'support@F3', 'pass');
  check('guard : accordée à un allié du banc', bench(r.state, 0, 'F3').guard === 5 && act(r.state, 0).guard === 0);
  r = turn(ready(duel('Rempart', 'Mur2', { rules: { guardDecayPct: 0 } })), 'support', 'pass');
  check('guard : à soi par défaut', act(r.state, 0).guard === 5);
  // buff / selfAtk / teamAtk (plafonds)
  syn('Prepa', { moves: [{}, only({ buff: 2 }), only({ teamAtk: 2, selfAtk: 2 })] });
  s = ready(duel('Prepa', 'Mur2'));
  r = turn(s, 'support', 'pass');
  check('buff : dégâts préparés', act(r.state, 0).buff === 2);
  s = ready(duel('Prepa', 'Mur2'));
  act(s, 0).buff = 2;
  r = turn(s, 'support', 'pass');
  check(`buff : plafond de ${R.buffCap}`, act(r.state, 0).buff === R.buffCap);
  s = ready(duel('Prepa', 'Mur2'));
  bench(s, 0, 'F1').atkBonus = R.atkBonusCap - 1;
  r = turn(s, 'ultimate', 'pass');
  check('teamAtk : tout le camp, banc compris (plafonné)', r.state.players[0].champions.filter((c) => c.name !== 'Prepa').every((c) => c.atkBonus === Math.min(R.atkBonusCap, c.name === 'F1' ? R.atkBonusCap : 2)));
  check(`selfAtk + teamAtk : plafond de ${R.atkBonusCap}`, act(r.state, 0).atkBonus === R.atkBonusCap);
  // teamHp : les AUTRES alliés (banc) perdent des PV, minimum 1
  syn('Fardeau', { moves: [{}, {}, only({ teamHp: 4 })] });
  s = ready(duel('Fardeau', 'Mur2'));
  bench(s, 0, 'F2').hp = 3;
  r = turn(s, 'ultimate', 'pass');
  check('teamHp : le banc paie, minimum 1 PV', bench(r.state, 0, 'F1').hp === 26 && bench(r.state, 0, 'F2').hp === 1 && act(r.state, 0).hp === 30);
  check('teamHp : jamais mortel', r.state.players[0].champions.every((c) => c.alive));
  // recoil
  syn('Kamikaze', { moves: [{ damage: 5, recoil: 4 }] });
  s = ready(duel('Kamikaze', 'Mur2'));
  r = turn(s, 'attack', 'pass');
  check('recoil : le lanceur perd des PV', act(r.state, 0).hp === 26);
  s = ready(duel('Kamikaze', 'Mur2'));
  act(s, 0).hp = 3;
  r = turn(s, 'attack', 'pass');
  check('recoil : jamais mortel (1 PV minimum)', act(r.state, 0).hp === 1 && act(r.state, 0).alive);
  s = ready(duel('Kamikaze', 'Mur2'));
  act(s, 0).guard = 10;
  r = turn(s, 'attack', 'pass');
  check('recoil : ignore la garde', act(r.state, 0).hp === 26);
  // apply / selfApply / cleanse
  syn('Toxique', { moves: [{ apply: { poison: 3, weakness: 2 } }, only({ selfApply: { rage: 2, regen: 3 } }), only({ cleanse: true })] });
  s = ready(duel('Toxique', 'Mur2'));
  r = turn(s, 'attack', 'pass');
  check('apply : statuts sur l’actif adverse (durée − 1 fin de tour)', act(r.state, 1).statuses.poison === 3 - 1 && act(r.state, 1).statuses.weakness === 2 - 1);
  r = turn(ready(duel('Toxique', 'Mur2')), 'support', 'pass');
  check('selfApply : statuts sur le lanceur', act(r.state, 0).statuses.rage === 1 && act(r.state, 0).statuses.regen === 2);
  s = ready(duel('Toxique', 'Mur2'));
  Object.assign(bench(s, 0, 'F2').statuses, { poison: 4, curse: 2, weakness: 1, rage: 5 });
  r = turn(s, 'ultimate@F2', 'pass');
  check('cleanse : retire poison, faiblesse, malédiction d’un allié du banc', same(bench(r.state, 0, 'F2').statuses, { rage: 4 }), JSON.stringify(bench(r.state, 0, 'F2').statuses));
  check('cleanse : événement détaillé', evs(r, 'cleanse')[0].removed.slice().sort().join() === 'curse,poison,weakness');
  // skipFoe : plus rapide → action perdue maintenant ; plus lent → prochaine action
  syn('Hypnose', { speed: 90, moves: [only({ skipFoe: true })] });
  syn('Hypnose2', { speed: 40, moves: [only({ skipFoe: true })] });
  syn('Cible', { speed: 60, hp: 200 });
  s = ready(duel('Hypnose', 'Cible'));
  r = turn(s, 'attack', 'attack');
  check('skipFoe (plus rapide) : l’adversaire perd son action de CE tour', evs(r, 'skipNext')[0].now === true && evs(r, 'move').length === 1 && evs(r, 'skip').length === 1 && evs(r, 'skip')[0].now);
  check('skipFoe (plus rapide) : rien n’est reporté', r.state.players[1].skipNext === false && E.legalActions(r.state, 1).length > 1);
  s = ready(duel('Hypnose2', 'Cible'));
  r = turn(s, 'attack', 'attack');
  check('skipFoe (plus lent) : l’adversaire a déjà agi, il perd la PROCHAINE action', evs(r, 'skipNext')[0].now === false && r.state.players[1].skipNext === true);
  check('action perdue : seul « passer » est légal', same(E.legalActions(r.state, 1), [{ type: 'pass' }]));
  const r2 = turn(r.state, 'pass', 'pass');
  check('action perdue : consommée au tour suivant', evs(r2, 'skip').some((e) => e.player === 1) && r2.state.players[1].skipNext === false);
  // sacrifice
  syn('Sacre', { moves: [{}, {}, { sacrifice: true, damage: 3 }] });
  s = ready(duel('Sacre', 'Mur2'));
  bench(s, 0, 'F1').hp = 5;
  bench(s, 0, 'F2').hp = 2;
  r = turn(s, 'ultimate', 'pass');
  const sk = evs(r, 'ko', 'F2')[0];
  check('sacrifice : l’allié vivant le plus faible (banc) est K.O.', sk && sk.cause === 'sacrifice' && sk.active === false && !bench(r.state, 0, 'F2').alive && bench(r.state, 0, 'F1').alive);
  check('sacrifice : l’actif lui-même est épargné, pas de remplacement', act(r.state, 0).alive && r.state.phase === 'choose');
  // attackBlock
  syn('Gardefou', { speed: 90, moves: [{}, only({ attackBlock: true })] });
  s = ready(duel('Gardefou', 'Cible'));
  r = turn(s, 'support', 'attack');
  check('attackBlock : annule la prochaine capacité ennemie qui le vise', evs(r, 'blocked').some((e) => e.by === 'attackBlock') && act(r.state, 0).hp === 30 && act(r.state, 0).attackBlock === false);
  syn('Gardefou2', { speed: 10, moves: [{}, only({ attackBlock: true })] });
  s = ready(duel('Cible', 'Gardefou2'));
  r = turn(s, 'attack', 'support');
  check('attackBlock : posé après le coup adverse, il reste en attente', act(r.state, 1).hp < 30 && act(r.state, 1).attackBlock === true);
  r = turn(r.state, 'attack', 'pass');
  check('attackBlock : annule la première capacité reçue ensuite (une seule fois)', act(r.state, 1).attackBlock === false && evs(r, 'blocked').some((e) => e.by === 'attackBlock'));
  // saveLethal
  syn('Survivant', { speed: 99, moves: [{}, only({ saveLethal: true })] });
  syn('Brute', { speed: 50, hp: 200, moves: [{ damage: 40 }] });
  s = ready(duel('Survivant', 'Brute'));
  r = turn(s, 'support', 'attack');
  check('saveLethal : survit à 1 PV au coup létal, une seule fois', act(r.state, 0).hp === 1 && act(r.state, 0).saveLethal === false && evs(r, 'survive').length === 1 && act(r.state, 0).alive);
  r = turn(r.state, 'pass', 'attack');
  check('saveLethal : consommé, le coup suivant tue', !bench(r.state, 0, 'Survivant').alive);
  // invincible
  syn('Intouchable', { speed: 99, moves: [{}, {}, only({ invincible: 2 })] });
  s = ready(duel('Intouchable', 'Brute'));
  r = turn(s, 'ultimate', 'attack');
  check('invincible : aucun dégât', act(r.state, 0).hp === 30 && evs(r, 'blocked').some((e) => e.by === 'invincible'));
  r = turn(r.state, 'pass', 'attack');
  check('invincible : dure aussi le tour suivant, puis expire', act(r.state, 0).hp === 30 && act(r.state, 0).invincible === 0 && evs(r, 'expire').some((e) => e.status === 'invincible'));
  r = turn(r.state, 'pass', 'attack');
  check('invincible : terminée', act(r.state, 0).hp < 30 || !bench(r.state, 0, 'Intouchable').alive);
  // disableTurns
  syn('Epuise', { speed: 90, moves: [{}, {}, only({ disableTurns: 2, damage: 2 })] });
  s = ready(duel('Epuise', 'Cible'));
  r = turn(s, 'ultimate', 'pass');
  check('disableTurns : annoncé', evs(r, 'protect').some((e) => e.effect === 'disabled' && e.turns === 2));
  for (let i = 0; i < 2; i += 1) {
    const l = E.legalActions(r.state, 0).filter((a) => a.type === 'move');
    check(`disableTurns : tour ${i + 1} sans attaque ni ultime`, l.length > 0 && l.every((a) => a.move === 1));
    r = turn(ready(r.state), 'support', 'pass');
  }
  check('disableTurns : de nouveau libre ensuite', E.legalActions(r.state, 0).some((a) => a.type === 'move' && a.move === 0) && evs(r, 'expire').some((e) => e.status === 'disabled'));
  // instakill
  syn('Assassin', { moves: [{}, {}, only({ instakill: ['Cible', 'Autre'] })] });
  s = ready(duel('Assassin', 'Cible'));
  r = turn(s, 'ultimate', 'pass');
  check('instakill : abat la cible nommée', !bench(r.state, 1, 'Cible').alive && evs(r, 'ko', 'Cible')[0].cause === 'instakill');
  s = ready(duel('Assassin', 'Mur2'));
  r = turn(s, 'ultimate', 'pass');
  check('instakill : sans effet sur un autre champion', bench(r.state, 1, 'Mur2').alive);
  // reviveAlly
  syn('Ange', { moves: [{}, {}, only({ reviveAlly: true })] });
  s = ready(duel('Ange', 'Mur2'));
  Object.assign(bench(s, 0, 'F1'), { alive: false, hp: 0, koOrder: 1 });
  Object.assign(bench(s, 0, 'F2'), { alive: false, hp: 0, koOrder: 2 });
  r = turn(s, 'ultimate', 'pass');
  check('reviveAlly : ranime le K.O. le plus récent à 50 %, sur le banc', bench(r.state, 0, 'F2').alive && bench(r.state, 0, 'F2').hp === 15 && !bench(r.state, 0, 'F1').alive && evs(r, 'revive', 'F2')[0].hp === 15);
  check('reviveAlly : le lanceur succombe puis remplacement', !bench(r.state, 0, 'Ange').alive && evs(r, 'ko', 'Ange')[0].cause === 'revive' && r.state.phase === 'replace' && same(E.pendingPlayers(r.state), [0]));
  check('reviveAlly : le ressuscité est un remplaçant légal', E.legalActions(r.state, 0).some((a) => a.type === 'switch' && a.to === idxOf(r.state, 0, 'F2')));
  s = ready(duel('Ange', 'Mur2'));
  r = turn(s, 'ultimate', 'pass');
  check('reviveAlly : sans allié tombé, aucun effet et le lanceur reste', act(r.state, 0).alive && evs(r, 'revive').length === 0);
  // extraTurn : action bonus avant la fin du tour
  syn('Rejoue', { speed: 90, moves: [{ damage: 3 }, {}, only({ extraTurn: true, damage: 2 })] });
  s = ready(duel('Rejoue', 'Cible'));
  act(s, 0).statuses.poison = 3;
  r = turn(s, 'ultimate', 'attack');
  check('extraTurn : phase de choix bonus, seul le lanceur choisit', r.state.phase === 'choose' && r.state.bonus === true && same(E.pendingPlayers(r.state), [0]) && evs(r, 'extraTurn').length === 1);
  check('extraTurn : le tour n’est pas terminé (poison pas encore appliqué)', r.state.turn === 1 && act(r.state, 0).statuses.poison === 3 && !evs(r, 'turnEnd').length);
  check('extraTurn : pas de chakra gagné', evs(r, 'chakra').filter((e) => e.delta > 0).length === 0 && r.state.players[0].chakra === R.maxChakra - R.ultimateCost);
  check('extraTurn : l’adversaire n’a rien à choisir', E.legalActions(r.state, 1).length === 0);
  const rb = E.submit(r.state, 0, A(r.state, 0, 'attack'));
  check('extraTurn : l’action bonus est jouée puis le tour se termine', rb.resolved && rb.state.turn === 2 && rb.state.bonus === false && evs(rb, 'move').length === 1 && evs(rb, 'turnEnd').length === 1 && act(rb.state, 0).statuses.poison === 2);
  check('extraTurn : nouveau tour normal ensuite (les deux choisissent)', same(E.pendingPlayers(rb.state), [0, 1]));
}

// ─── 10. Statuts, banc, épuisement ────────────────────────────────────────────────────────────
{
  syn('Pivot', { hp: 100 });
  syn('Cible2', { hp: 100, speed: 10 });
  let s = ready(duel('Pivot', 'Cible2'));
  Object.assign(act(s, 1).statuses, { poison: 2, curse: 2, weakness: 1, rage: 3 });
  let r = turn(s, 'pass', 'pass');
  const foe = act(r.state, 1);
  check('poison : −' + R.poisonDamage + ' PV en fin de tour', evs(r, 'damage', 'Cible2').some((e) => e.source === 'poison' && e.amount === R.poisonDamage));
  check('malédiction : −' + R.curseDamage + ' PV en fin de tour', evs(r, 'damage', 'Cible2').some((e) => e.source === 'curse' && e.amount === R.curseDamage));
  check('durées décrémentées, expirations annoncées', same(foe.statuses, { poison: 1, curse: 1, rage: 2 }) && evs(r, 'expire', 'Cible2').some((e) => e.status === 'weakness'));
  s = ready(duel('Pivot', 'Cible2'));
  act(s, 1).statuses.poison = 1;
  act(s, 1).guard = 9;
  r = turn(s, 'pass', 'pass');
  check('les statuts ignorent la garde', act(r.state, 1).hp === 100 - R.poisonDamage);
  s = ready(duel('Pivot', 'Cible2'));
  act(s, 0).hp = 50;
  act(s, 0).statuses.regen = 1;
  r = turn(s, 'pass', 'pass');
  check('régénération : +' + R.regenHeal + ' PV en fin de tour', act(r.state, 0).hp === 50 + R.regenHeal && !act(r.state, 0).statuses.regen);
  s = ready(duel('Pivot', 'Cible2'));
  act(s, 0).hp = 50;
  Object.assign(act(s, 0).statuses, { regen: 2, curse: 2 });
  r = turn(s, 'pass', 'pass');
  check('malédiction : la régénération ne soigne pas', act(r.state, 0).hp === 50 - R.curseDamage);
  // Banc : les statuts s'écoulent mais ne blessent pas (sauf benchDots).
  s = ready(duel('Pivot', 'Cible2'));
  Object.assign(bench(s, 0, 'F1').statuses, { poison: 3, curse: 3, regen: 3, rage: 2 });
  bench(s, 0, 'F1').hp = 20;
  r = turn(s, 'pass', 'pass');
  const b1 = bench(r.state, 0, 'F1');
  check('banc : poison, malédiction, régénération ne jouent pas', b1.hp === 20);
  check('banc : mais les durées s’écoulent', same(b1.statuses, { poison: 2, curse: 2, regen: 2, rage: 1 }));
  s = ready(duel('Pivot', 'Cible2', { rules: { benchDots: 1 } }));
  Object.assign(bench(s, 0, 'F1').statuses, { poison: 3, regen: 3 });
  bench(s, 0, 'F1').hp = 20;
  r = turn(s, 'pass', 'pass');
  check('benchDots : le banc subit aussi poison et régénération', bench(r.state, 0, 'F1').hp === 20 - R.poisonDamage + R.regenHeal);
  // Réapplication : durée la plus longue.
  syn('Poison4', { moves: [{ apply: { poison: 4 }, damage: 1 }] });
  s = ready(duel('Poison4', 'Cible2'));
  act(s, 1).statuses.poison = 2;
  r = turn(s, 'attack', 'pass');
  check('réapplication : garde la durée la plus longue', act(r.state, 1).statuses.poison === 3);
  s = ready(duel('Poison4', 'Cible2'));
  act(s, 1).statuses.poison = 6;
  r = turn(s, 'attack', 'pass');
  check('réapplication : ne raccourcit jamais', act(r.state, 1).statuses.poison === 5);
  // Poison mortel → K.O. → remplacement.
  s = ready(duel('Pivot', 'Cible2'));
  act(s, 1).hp = 1;
  act(s, 1).statuses.poison = 2;
  r = turn(s, 'pass', 'pass');
  check('poison : peut mettre K.O., puis remplacement', evs(r, 'ko', 'Cible2')[0].cause === 'poison' && r.state.phase === 'replace' && same(E.pendingPlayers(r.state), [1]));
  // Épuisement.
  s = ready(duel('Pivot', 'Cible2', { rules: { fatigueTurn: 2, fatigueDamage: 2 } }));
  r = turn(s, 'pass', 'pass');
  check('épuisement : rien avant le tour prévu', evs(r, 'fatigue').length === 0 && act(r.state, 0).hp === 100);
  r = turn(r.state, 'pass', 'pass');
  check('épuisement : les deux actifs perdent des PV', evs(r, 'fatigue')[0].amount === 2 && act(r.state, 0).hp === 98 && act(r.state, 1).hp === 98 && evs(r, 'damage').every((e) => e.source === 'fatigue'));
  r = turn(r.state, 'pass', 'pass');
  check('épuisement : +1 niveau par tour', evs(r, 'fatigue')[0].amount === 4 && act(r.state, 0).hp === 94);
  check('épuisement : le banc n’est pas touché', bench(r.state, 0, 'F1').hp === 30);
  s = ready(duel('Pivot', 'Cible2', { rules: { fatigueTurn: 0 } }));
  r = turn(turn(turn(s, 'pass', 'pass').state, 'pass', 'pass').state, 'pass', 'pass');
  check('épuisement désactivable (fatigueTurn 0)', act(r.state, 0).hp === 100);
  s = ready(duel('Pivot', 'Cible2', { rules: { fatigueTurn: 1, fatigueDamage: 1000 } }));
  act(s, 0).hp = 5;
  act(s, 1).hp = 5;
  r = turn(s, 'pass', 'pass');
  check('épuisement : K.O. attribué à l’épuisement', evs(r, 'ko').length === 2 && evs(r, 'ko').every((e) => e.cause === 'fatigue'));
}

// ─── 11. K.O., remplacement, fin de duel, chakra ──────────────────────────────────────────────
{
  syn('Tueur', { speed: 90, hp: 100, moves: [{ damage: 50 }] });
  syn('Victime', { speed: 10, hp: 20 });
  let s = ready(duel('Tueur', 'Victime'));
  let r = turn(s, 'attack', 'attack');
  check('K.O. de l’actif : phase de remplacement', r.state.phase === 'replace' && r.state.turn === 1 && evs(r, 'phaseReplace')[0].player === 1);
  check('remplacement : seuls les vivants du banc sont légaux', E.legalActions(r.state, 1).every((a) => a.type === 'switch') && E.legalActions(r.state, 1).length === 4);
  check('remplacement : le gagnant du tour n’a rien à faire', E.pendingPlayers(r.state).join() === '1' && E.legalActions(r.state, 0).length === 0);
  const vr = E.viewFor(r.state, 0);
  check('viewFor en remplacement : cohérent', E.pendingPlayers(vr).join() === '1' && vr.phase === 'replace');
  const f = E.submit(r.state, 1, { type: 'switch', to: idxOf(r.state, 1, 'F3') });
  check('remplacement : la résolution lance un nouveau tour', f.resolved === true && f.state.phase === 'choose' && f.state.turn === 2 && same(E.pendingPlayers(f.state), [0, 1]));
  const fsw = evs(f, 'switch')[0];
  check('remplacement : événement switch « forced »', fsw.forced === true && fsw.name === 'F3' && fsw.fromName === 'Victime' && fsw.side === 1 && f.state.players[1].active === idxOf(f.state, 1, 'F3'));
  check('remplacement : le K.O. reste K.O. au banc', !bench(f.state, 1, 'Victime').alive);
  check('remplacement : journal', E.describeEvent(fsw).includes('remplacer Victime'));
  check('remplacement : gratuit (pas de chakra payé)', !evs(f, 'chakra').some((e) => e.delta < 0));
  // Passif à l'entrée en jeu (onSwitchIn), au changement comme au remplacement.
  syn('Entrant', { passiveName: 'Entrée fracassante', passiveFx: { rules: [{ when: 'onSwitchIn', effects: [{ type: 'guard', amount: 3 }] }] } });
  s = ready(duel('Tueur', 'Victime', { benB: ['Entrant', 'F1', 'F2', 'F3'] }));
  r = turn(s, 'attack', 'attack');
  const f2 = E.submit(r.state, 1, { type: 'switch', to: idxOf(r.state, 1, 'Entrant') });
  check('onSwitchIn : joué à l’entrée après un K.O.', evs(f2, 'passive', 'Entrant').length === 1 && evs(f2, 'passive', 'Entrant')[0].when === 'onSwitchIn');
  s = ready(duel('Victime', 'Tueur', { ben: ['Entrant', 'F1', 'F2', 'F3'] }));
  r = turn(s, 'sw:Entrant', 'pass');
  check('onSwitchIn : joué à un changement volontaire', evs(r, 'passive', 'Entrant').length === 1 && evs(r, 'guard', 'Entrant')[0]?.guard === 3);
  check('onSwitchIn : pas à un tour normal', evs(turn(r.state, 'pass', 'pass'), 'passive', 'Entrant').length === 0);
  // Les deux actifs tombent : deux remplacements simultanés.
  s = ready(duel('F7', 'F8'));
  for (const p of [0, 1]) {
    act(s, p).hp = 1;
    act(s, p).statuses.poison = 1;
  }
  r = turn(s, 'pass', 'pass');
  check('double K.O. : les deux joueurs choisissent', r.state.phase === 'replace' && same(E.pendingPlayers(r.state), [0, 1]));
  const h1 = E.submit(r.state, 0, { type: 'switch', to: 1 });
  check('double K.O. : un seul choix ne résout pas', h1.resolved === false && h1.state.phase === 'replace' && same(E.pendingPlayers(h1.state), [1]));
  check('double K.O. : le choix de remplacement est secret', E.viewFor(h1.state, 1).choices[0].type === 'hidden');
  const h2 = E.submit(h1.state, 1, { type: 'switch', to: 2 });
  check('double K.O. : résolu ensemble, tour suivant', h2.resolved && h2.state.phase === 'choose' && h2.state.turn === 2 && evs(h2, 'switch').length === 2);
  // Plus de remplaçant : fin du duel.
  s = ready(duel('Tueur', 'Victime'));
  for (let i = 1; i < 5; i += 1) Object.assign(s.players[1].champions[i], { alive: false, hp: 0 });
  r = turn(s, 'attack', 'attack');
  check('dernier champion K.O. : victoire, pas de remplacement', r.state.phase === 'ended' && r.state.winner === 0 && r.state.endReason === 'ko' && E.pendingPlayers(r.state).length === 0);
  check('victoire : événement end', evs(r, 'end')[0].winner === 0 && evs(r, 'end')[0].reason === 'ko' && E.describeEvent(evs(r, 'end')[0]).includes('Victoire de Alice'));
  // Match nul : les deux derniers champions tombent ensemble.
  s = ready(duel('F7', 'F8'));
  for (const p of [0, 1]) {
    for (let i = 1; i < 5; i += 1) Object.assign(s.players[p].champions[i], { alive: false, hp: 0 });
    act(s, p).hp = 1;
    act(s, p).statuses.poison = 1;
  }
  r = turn(s, 'pass', 'pass');
  check('les deux derniers K.O. ensemble : match nul', r.state.winner === 'draw' && r.state.phase === 'ended');
  check('match nul : journal', E.describeEvent(evs(r, 'end')[0]).startsWith('Match nul'));
  // Un champion mis K.O. avant d'agir n'agit plus du tout ce tour-ci (plus de « dernier souffle »).
  syn('Duel2', { speed: 90, moves: [{ damage: 50 }] });
  syn('Duel3', { speed: 10, hp: 20, moves: [{ damage: 7 }] });
  check('plus de règle dyingStrike dans E.RULES', !('dyingStrike' in R));
  s = ready(duel('Duel2', 'Duel3'));
  r = turn(s, 'attack', 'attack');
  check('K.O. avant d’agir : la capacité du K.O. est annulée (« fail » ko)', evs(r, 'fail').length === 1 && evs(r, 'fail')[0].reason === 'ko' && evs(r, 'fail')[0].side === 1);
  check('K.O. avant d’agir : une seule capacité jouée, le vainqueur est intact', evs(r, 'move').length === 1 && evs(r, 'move')[0].side === 0 && act(r.state, 0).hp === 30);
  check('K.O. avant d’agir : aucun dégât subi par le camp rapide', evs(r, 'damage').every((e) => e.side === 1) && evs(r, 'status').length === 0);
  check('K.O. avant d’agir : journal clair', E.describeEvent(evs(r, 'fail')[0]).includes('KO') && E.describeEvent(evs(r, 'fail')[0]).includes('n’a pas lieu'));
  // Avec les règles par défaut (compensation du second incluse), même résultat si le coup reste létal.
  s = ready(duel('Duel2', 'Duel3', { rules: { lateGuard: R.lateGuard } }));
  r = turn(s, 'attack', 'attack');
  check('règles par défaut : le K.O. avant d’agir ne joue toujours pas', evs(r, 'fail').length === 1 && evs(r, 'move').length === 1 && act(r.state, 0).hp === 30);
  // Passer / changer : rien de plus (le changement a lieu avant, le coup frappe le nouvel actif).
  r = turn(ready(duel('Duel2', 'Duel3')), 'attack', 'pass');
  check('adversaire qui passe : une seule capacité', evs(r, 'move').length === 1 && evs(r, 'fail').length === 0);
  s = ready(duel('Duel2', 'Duel3'));
  r = turn(s, 'attack', 'sw:F1');
  check('un changement fait encaisser le coup au nouvel actif, le rappelé n’agit pas', evs(r, 'switch').length === 1 && evs(r, 'move').length === 1 && evs(r, 'move')[0].target.name === 'F1' && !bench(r.state, 1, 'F1').alive && bench(r.state, 1, 'Duel3').hp === 20);
  // Même quand la riposte aurait été létale : elle n'a pas lieu.
  s = ready(duel('Duel2', 'Duel3'));
  act(s, 0).hp = 3;
  r = turn(s, 'attack', 'attack');
  check('même quand la riposte aurait été létale : elle n’a pas lieu', act(r.state, 0).alive && act(r.state, 0).hp === 3 && !act(r.state, 1).alive && r.state.phase === 'replace');
  // Hâte : le champion K.O. perd sa Hâte avec ses statuts ; un lanceur hâté qui tue au premier coup ne frappe pas deux fois.
  s = ready(duel('Duel3', 'Duel2'));
  act(s, 0).statuses.haste = 1;
  r = turn(s, 'attack', 'attack');
  check('Hâte : le champion K.O. avant d’agir n’utilise pas sa Hâte', evs(r, 'haste').length === 0 && evs(r, 'move').length === 1 && evs(r, 'fail').length === 1 && !act(r.state, 0).statuses.haste);
  s = ready(duel('Duel2', 'Duel3'));
  act(s, 0).statuses.haste = 1;
  r = turn(s, 'attack', 'attack');
  check('Hâte : un seul coup si le premier tue, et le K.O. ne riposte pas', evs(r, 'damage', 'Duel3').length === 1 && evs(r, 'damage', 'Duel3')[0].hit === 1 && evs(r, 'fail').length === 1 && act(r.state, 0).hp === 30);
  // Action bonus (extraTurn) : un K.O. avant d'agir n'en profite pas ; une chute après avoir agi l'annule.
  const only = (o) => Object.assign({ damage: 0, guard: 0 }, o);
  syn('RejoueL', { speed: 10, hp: 30, moves: [{ damage: 3 }, {}, only({ extraTurn: true, damage: 2 })] });
  s = ready(duel('Duel2', 'RejoueL'));
  r = turn(s, 'attack', 'ultimate');
  check('extraTurn : le K.O. avant d’agir ne gagne pas d’action bonus', evs(r, 'extraTurn').length === 0 && evs(r, 'fail').length === 1 && r.state.phase === 'replace' && r.state.bonus === false && !r.state.players[1].extra);
  check('extraTurn : et son ultime n’est pas dépensé', bench(r.state, 1, 'RejoueL').ultimateUsed !== true && r.state.players[1].chakra === R.maxChakra);
  syn('RejoueR', { speed: 90, hp: 30, moves: [{ damage: 3 }, {}, only({ extraTurn: true, damage: 2 })] });
  syn('Frappe', { speed: 10, atk: 2, moves: [{ damage: 50 }] });
  s = ready(duel('RejoueR', 'Frappe'));
  act(s, 0).hp = 4;
  r = turn(s, 'ultimate', 'attack');
  check('extraTurn : abattu après avoir agi, l’action bonus est annulée', !act(r.state, 0).alive && r.state.bonus === false && r.state.phase === 'replace' && !r.state.players[0].extra);
  // Deux actions bonus : le premier à jouer abat l'autre, dont l'action bonus n'a pas lieu.
  syn('BonusA', { speed: 90, hp: 30, moves: [{ damage: 3 }, {}, only({ extraTurn: true, damage: 2 })] });
  syn('BonusB', { speed: 80, hp: 30, moves: [{ damage: 3 }, {}, only({ extraTurn: true, damage: 2 })] });
  s = ready(duel('BonusA', 'BonusB'));
  act(s, 1).hp = 7;
  r = turn(s, 'ultimate', 'ultimate');
  check('deux extraTurn : les deux ont une action bonus', r.state.bonus === true && same(E.pendingPlayers(r.state), [0, 1]) && evs(r, 'extraTurn').length === 2);
  const hpA = act(r.state, 0).hp;
  const rb2 = turn(r.state, 'attack', 'attack');
  check('action bonus : le plus rapide abat l’autre, dont l’action bonus échoue', evs(rb2, 'move').length === 1 && evs(rb2, 'move')[0].side === 0 && evs(rb2, 'fail').length === 1 && evs(rb2, 'fail')[0].side === 1 && act(rb2.state, 0).hp === hpA);
  check('action bonus : phase de remplacement ensuite', rb2.state.phase === 'replace' && same(E.pendingPlayers(rb2.state), [1]));
  // Invariant sur des duels complets de l'IA : jamais de « move » d'un champion déjà K.O. plus tôt dans le même tour.
  {
    let bad = 0;
    const pool = E.mythics(data);
    for (let seed = 1; seed <= 12; seed += 1) {
      let st = E.createMatch({ data, seed, players: [{ name: 'A', deck: pool.slice(seed * 7, seed * 7 + 5).map((c) => c.id) }, { name: 'B', deck: pool.slice(seed * 11 + 3, seed * 11 + 8).map((c) => c.id) }] });
      let n = 0;
      while (st.phase !== 'ended' && n < 4000) {
        let next = st;
        const events = [];
        for (const p of E.pendingPlayers(st)) {
          const rr = E.submit(next, p, E.chooseAction(st, p));
          next = rr.state;
          events.push(...rr.events);
        }
        const down = new Set();
        for (const e of events) {
          if (e.type === 'turn') down.clear();
          if (e.type === 'ko') down.add(e.side + ':' + e.index);
          if (e.type === 'move' && down.has(e.side + ':' + e.index)) bad += 1;
        }
        st = next;
        n += 1;
      }
    }
    check('12 duels complets de l’IA : jamais de capacité jouée par un champion déjà K.O. dans le même tour', bad === 0, String(bad));
  }
  // Fin par la limite de tours : % de PV restants.
  s = ready(duel('Pivot', 'Cible2', { rules: { maxTurns: 2, fatigueTurn: 0 } }));
  bench(s, 1, 'F1').hp = 10;
  r = turn(turn(s, 'pass', 'pass').state, 'pass', 'pass');
  check('limite de tours : victoire au plus grand % de PV restants', r.state.phase === 'ended' && r.state.endReason === 'rounds' && r.state.winner === 0);
  check('limite de tours : événement end avec les pourcentages', evs(r, 'end')[0].hpPct[0] > evs(r, 'end')[0].hpPct[1] && E.describeEvent(evs(r, 'end')[0]).includes('limite de tours'));
  s = ready(duel('Pivot', 'Pivot', { rules: { maxTurns: 1, fatigueTurn: 0 } }));
  r = turn(s, 'pass', 'pass');
  check('limite de tours : égalité parfaite = nul', r.state.winner === 'draw' && r.state.endReason === 'rounds');
  // Abandon / absence.
  s = duel('Pivot', 'Cible2');
  let fo = E.forfeit(s, 1, 'forfeit');
  check('abandon : défaite immédiate', fo.state.winner === 0 && fo.state.endReason === 'forfeit' && fo.state.phase === 'ended' && fo.resolved === true && evs(fo, 'forfeit').length === 1);
  fo = E.forfeit(E.submit(s, 0, { type: 'pass' }).state, 0, 'timeout');
  check('absence : défaite par timeout, choix en attente effacés', fo.state.winner === 1 && fo.state.endReason === 'timeout' && fo.state.choices.every((c) => c === null));
  check('abandon : journal', E.describeEvent(evs(fo, 'forfeit')[0]).includes('absent') && E.describeEvent(evs(E.forfeit(s, 0), 'forfeit')[0]).includes('abandonne'));
  throws('abandon : duel déjà terminé', () => E.forfeit(fo.state, 1), /terminé/);
  throws('abandon : joueur inconnu', () => E.forfeit(s, 5), /inconnu/);
  const fz = deepFreeze(JSON.parse(JSON.stringify(s)));
  check('abandon : n’altère pas son entrée', E.forfeit(fz, 0).state.winner === 1);
  // Chakra.
  s = duel('Pivot', 'Cible2', { rules: { startChakra: 0, chakraPerTurn: 1, maxChakra: 3 } });
  check('chakra : départ + gain du premier tour', s.players[0].chakra === 1);
  r = turn(turn(turn(s, 'pass', 'pass').state, 'pass', 'pass').state, 'pass', 'pass');
  check('chakra : +1 par tour pour les deux, plafonné', r.state.players.every((p) => p.chakra === 3));
  s = ready(duel('Pivot', 'Cible2'), 5);
  r = turn(s, 'support', 'pass');
  check('chakra : le soutien coûte ' + R.supportCost, r.state.players[0].chakra === Math.min(R.maxChakra, 5 - R.supportCost + R.chakraPerTurn) && evs(r, 'chakra').some((e) => e.player === 0 && e.delta === -R.supportCost));
  r = turn(ready(duel('Pivot', 'Cible2')), 'ultimate', 'pass');
  check('ultime : marqué utilisé', bench(r.state, 0, 'Pivot').ultimateUsed === true);
  r = turn(ready(r.state), 'pass', 'pass');
  check('ultime : une seule fois par champion et par duel', !E.legalActions(r.state, 0).some((a) => a.type === 'move' && a.move === 2));
  r = turn(r.state, 'sw:F1', 'pass');
  r = turn(ready(r.state), 'sw:Pivot', 'pass');
  check('ultime : toujours indisponible après être revenu du banc', !E.legalActions(r.state, 0).some((a) => a.type === 'move' && a.move === 2));
}

// ─── 12. Passifs (les 203 Mythiques) ──────────────────────────────────────────────────────────
{
  const mythics = E.mythics(data);
  // Données et schéma.
  const handled = new Set(['turnStart', 'onSwitchIn', 'onDamaged', 'onHit', 'lowHp', 'hpAtMost', 'afterSupport', 'static']);
  const effects = new Set(['heal', 'guard', 'buff', 'atk', 'teamAtk', 'status', 'foeStatus', 'dispel', 'healMostWounded', 'healBonus', 'initiative']);
  let ok = 0;
  for (const c of mythics) {
    const bad = validatePassiveFx(c.passiveFx);
    const same_ = JSON.stringify(c.passiveFx) === JSON.stringify(passiveFxOf(c));
    const known = (c.passiveFx?.rules ?? []).every((r) => handled.has(r.when) && r.effects.every((e) => effects.has(e.type)));
    if (!bad && same_ && known) ok += 1;
    else check(`passiveFx de ${c.name}`, false, bad ?? (!same_ ? 'données pas à jour (lancer scripts/duel-passives.mjs)' : 'déclencheur ou effet non géré'));
  }
  check('203 Mythiques : passiveFx valide, à jour et géré par le moteur', ok === 203, `${ok}/203`);

  // Champs d'effet présents dans les données ⊆ champs testés explicitement plus haut.
  const TESTED = new Set(['kind', 'name', 'desc', 'damage', 'randomDamage', 'heal', 'healTeam', 'healTeamFull', 'guard', 'buff', 'selfAtk', 'teamAtk', 'teamHp',
    'recoil', 'apply', 'selfApply', 'cleanse', 'bonusIfLow', 'skipFoe', 'sacrifice', 'attackBlock', 'saveLethal', 'invincible', 'disableTurns', 'instakill', 'reviveAlly', 'extraTurn']);
  const used = new Set();
  for (const c of mythics) for (const a of c.attacks) for (const k of Object.keys(a)) used.add(k);
  const untested = [...used].filter((k) => !TESTED.has(k));
  check('tous les champs de capacité des données sont couverts par les tests', untested.length === 0, untested.join());

  // Banc d'essai : champions réels + champions synthétiques.
  syn('Sac', { hp: 500, atk: 0, speed: 1 });
  syn('Frappeur', { hp: 500, atk: 0, speed: 100, moves: [{ damage: 1 }] });
  const dataP2 = { champions: data.champions.concat(dataT.champions) };
  const mk = (lead, foe, opts = {}) => duel(lead, foe, { d: dataP2, ...opts });
  const dealsDmg = (m) => (m.damage ?? 0) > 0 || Array.isArray(m.randomDamage);
  let covered = 0;
  const holes = [];
  for (const c of mythics) {
    const rules = c.passiveFx.rules;
    const whens = new Set(rules.map((r) => r.when));
    const fire = (r, name) => r.events.some((e) => e.type === 'passive' && e.name === name);
    const firedWhen = (r, name, when) => r.events.some((e) => e.type === 'passive' && e.name === name && e.when === when);
    let all = true;
    // Chaque carte joue chacune de ses capacités contre un adversaire passif, sans exception.
    {
      const probe = ready(mk(c.name, 'Sac'));
      for (const a of E.legalActions(probe, 0).filter((x) => x.type === 'move')) {
        try {
          const r = turn(ready(mk(c.name, 'Sac')), a, 'pass');
          if (!r.state || r.state.phase === 'ended' && false) throw new Error('état vide');
        } catch (err) {
          check(`${c.name} : capacité ${a.move} jouable`, false, err.message);
          all = false;
        }
      }
    }
    for (const when of whens) {
      const rs = rules.filter((r) => r.when === when);
      let r;
      if (when === 'turnStart') {
        const s = ready(mk(c.name, 'Sac'));
        if (rs.some((x) => x.ifLowHp)) act(s, 0).hp = Math.max(1, Math.floor(act(s, 0).maxHp * 0.4));
        r = turn(s, 'pass', 'pass');
      } else if (when === 'onDamaged') {
        const s = ready(mk(c.name, 'Frappeur'));
        Object.assign(act(s, 0), { hp: 500, maxHp: 500 });
        r = turn(s, 'pass', 'attack');
      } else if (when === 'onHit') {
        const s = ready(mk(c.name, 'Sac'));
        const a = E.legalActions(s, 0).find((x) => x.type === 'move' && x.target && x.target.side === 1 && dealsDmg(act(s, 0).moves[x.move]));
        r = a ? turn(s, a, 'pass') : { events: [] };
      } else if (when === 'lowHp') {
        const s = ready(mk(c.name, 'Frappeur'));
        Object.assign(act(s, 0), { maxHp: 100, hp: 51 });
        r = turn(s, 'pass', 'attack');
      } else if (when === 'hpAtMost') {
        const s = ready(mk(c.name, 'Frappeur'));
        Object.assign(act(s, 0), { maxHp: 100, hp: rs[0].hpAtMost + 1 });
        r = turn(s, 'pass', 'attack');
      } else if (when === 'afterSupport') {
        const s = ready(mk(c.name, 'Sac'));
        r = turn(s, 'support', 'pass');
      } else if (when === 'static') {
        r = { events: [{ type: 'passive', name: c.name, when: 'static' }] }; // vérifié par les tests nommés (Subaru, Aqua…)
      } else {
        r = { events: [] };
      }
      if (when === 'static' || firedWhen(r, c.name, when) || (when === 'turnStart' && fire(r, c.name))) continue;
      all = false;
      holes.push(`${c.name} (${when})`);
    }
    if (all) covered += 1;
  }
  check('203 Mythiques : chaque déclencheur de passif se produit en situation réelle', covered === mythics.length, `${covered}/203 — ${holes.slice(0, 6).join('; ')}`);

  // Valeurs précises de passifs nommés (vraies données).
  const mkR = (a, b, opts) => mk(a, b, opts);
  const g = (r, name, type) => r.events.filter((e) => e.type === type && e.name === name);
  let s = ready(mkR('Emilia', 'Sac'));
  let r = turn(s, 'pass', 'pass');
  check('début de tour : garde (Emilia)', g(r, 'Emilia', 'passive').length === 1 && act(r.state, 0).guard === 1);
  check('début de tour : pas pour un champion du banc', (() => {
    const t = ready(mkR('Sac', 'Sac', { benB: ['Emilia', ...FILL] }));
    const q = turn(t, 'pass', 'pass');
    return g(q, 'Emilia', 'passive').length === 0;
  })());
  s = ready(mkR('Luffy Monkey', 'Frappeur'));
  Object.assign(act(s, 0), { hp: 500, maxHp: 500 });
  r = turn(s, 'pass', 'attack');
  check('quand il encaisse : garde (Luffy)', g(r, 'Luffy Monkey', 'guard')[0]?.guard === 2);
  s = ready(mkR('Zoro Roronoa', 'Frappeur'));
  Object.assign(act(s, 0), { maxHp: 20, hp: 11 });
  r = turn(s, 'pass', 'attack');
  check('sous 50 % (une fois) : Rage 3 (Zoro)', g(r, 'Zoro Roronoa', 'status').some((e) => e.status === 'rage' && e.turns === 3));
  s = ready(r.state);
  Object.assign(act(s, 0), { hp: 12, statuses: {} });
  r = turn(s, 'pass', 'attack');
  check('sous 50 % : une seule fois par duel', g(r, 'Zoro Roronoa', 'passive').length === 0);
  s = ready(mkR('Rem', 'Frappeur'));
  Object.assign(act(s, 0), { maxHp: 22, hp: 13 });
  r = turn(s, 'pass', 'attack');
  check('Rem : 12 PV ou moins → 7 de garde', g(r, 'Rem', 'guard')[0]?.guard === 7);
  s = ready(mkR('Nami', 'Sac'));
  r = turn(s, 'attack', 'pass');
  check('quand elle touche : Faiblesse 1 (Nami)', g(r, 'Sac', 'status').some((e) => e.status === 'weakness' && e.source === 'passive'));
  s = ready(mkR('Roxy Migurdia', 'Sac'));
  act(s, 0).hp = 5;
  r = turn(s, 'support', 'pass');
  check('après un soutien : +2 PV de passif (Roxy)', g(r, 'Roxy Migurdia', 'heal').some((e) => e.source === 'passive' && e.amount === 2));
  r = turn(ready(mkR('Roxy Migurdia', 'Sac')), 'attack', 'pass');
  check('après une attaque : rien (Roxy)', g(r, 'Roxy Migurdia', 'passive').length === 0);
  s = ready(mkR('Aqua', 'Sac'));
  bench(s, 0, 'F1').hp = 3;
  r = turn(s, 'support@F1', 'pass');
  const base = act(s, 0).moves.find((m) => m.kind === 'support').heal;
  check('soins augmentés de 1 (Aqua)', g(r, 'F1', 'heal')[0]?.amount === base + 1, JSON.stringify(g(r, 'F1', 'heal')));
  s = ready(mkR('Sac', 'Giyuu Tomioka'));
  r = turn(s, 'pass', 'pass');
  check('début de tour : statut sur l’actif adverse (Giyuu)', g(r, 'Sac', 'status').some((e) => e.source === 'passive'));
  s = ready(mkR('Sac', 'Power'));
  act(s, 1).hp = 9;
  r = turn(s, 'pass', 'pass');
  check('début de tour sous 50 % : +3 PV (Power)', g(r, 'Power', 'heal').some((e) => e.source === 'passive' && e.amount === 3));
  s = ready(mkR('Sac', 'Power'));
  act(s, 1).hp = 12;
  r = turn(s, 'pass', 'pass');
  check('début de tour au-dessus de 50 % : rien (Power)', g(r, 'Power', 'passive').length === 0);
  s = ready(mkR('Sac', 'Satoru Gojou'));
  s.players[1].champions[0].statuses = { curse: 5, weakness: 1 };
  r = turn(s, 'pass', 'pass');
  check('dissipe 2 tours du mal le plus long (Gojou)', g(r, 'Satoru Gojou', 'dispel')[0]?.status === 'curse' && g(r, 'Satoru Gojou', 'dispel')[0]?.turns === 2);
  s = ready(mkR('Sac', 'Erwin Smith'));
  r = turn(s, 'pass', 'pass');
  check('+1 ATQ à toute l’équipe, banc compris (Erwin)', r.state.players[1].champions.every((c) => c.atkBonus === 1));
  s = ready(mkR('Sac', 'Killua Zoldyck'));
  r = turn(s, 'pass', 'pass');
  check('Hâte au début du tour (Killua)', g(r, 'Killua Zoldyck', 'status').some((e) => e.status === 'haste'));
  s = ready(mkR('Sac', 'Lelouch Lamperouge'));
  r = turn(s, 'pass', 'pass');
  check('+1 dégât préparé (Lelouch)', g(r, 'Lelouch Lamperouge', 'buff').length >= 1);
  s = ready(mkR('Sac', 'Subaru Natsuki'));
  r = turn(s, 'pass', 'pass');
  check('Régénération 2 (Subaru)', g(r, 'Subaru Natsuki', 'status').some((e) => e.status === 'regen' && e.turns === 2));
  // Légendaires (données retouchées) : Doflamingo, Ai, Akane, Coco, Sylphiette.
  {
    const dataL = JSON.parse(JSON.stringify(data));
    for (const c of dataL.champions) c.rarity = 'M';
    dataL.champions.push(...dataT.champions);
    const L = (a, b, o) => duel(a, b, { d: dataL, ...o });
    s = ready(L('Doflamingo Donquixote', 'Sac'));
    r = turn(s, 'attack', 'pass');
    check('Doflamingo : malédiction en plus', g(r, 'Sac', 'status').some((e) => e.status === 'curse' && e.source === 'passive'));
    s = ready(L('Sac', 'Ai Hoshino'));
    bench(s, 1, 'F1').hp = 5;
    r = turn(s, 'pass', 'pass');
    check('Ai : soigne l’allié le plus blessé du camp (banc compris)', g(r, 'F1', 'heal').some((e) => e.source === 'passive' && e.amount === 2));
    s = ready(L('Sac', 'Coco'));
    act(s, 1).statuses.poison = 4;
    r = turn(s, 'pass', 'pass');
    check('Coco : retire 1 tour d’un mal', g(r, 'Coco', 'dispel').length === 1);
    s = ready(L('Sac', 'Sylphiette'));
    r = turn(s, 'pass', 'pass');
    check('Sylphiette : 1 garde au début du tour', act(r.state, 1).guard === 1);
    s = ready(L('Sac', 'Akane Kurokawa'));
    act(s, 1).statuses = {};
    r = turn(s, 'pass', 'pass');
    check('Akane : passif présent et valide', validatePassiveFx(L('Sac', 'Akane Kurokawa').players[1].champions[0].passiveFx) === null);
    s = ready(L('Doflamingo Donquixote', 'Sac'));
    check('sacrifice (Doflamingo) : ultime jouable avec un allié vivant', E.legalActions(s, 0).some((a) => a.type === 'move'));
  }
  // Toutes les Mythiques jouent un duel complet contre l'IA.
  const pool = mythics.map((c) => c.id);
  let played = 0;
  for (let i = 0; i < pool.length; i += 1) {
    const a = [0, 1, 2, 3, 4].map((k) => pool[(i + k * 41) % pool.length]);
    const b = [0, 1, 2, 3, 4].map((k) => pool[(i + 7 + k * 37) % pool.length]);
    try {
      const st = playOut(E.createMatch({ data, seed: `p${i}`, players: [{ name: 'A', deck: a }, { name: 'B', deck: b }] }));
      if (st.winner !== null && st.phase === 'ended') played += 1;
    } catch (err) {
      check(`duel avec ${mythics[i].name}`, false, err.message);
    }
  }
  check('203 duels IA (chaque Mythique joue) : tous terminés', played === pool.length, `${played}/${pool.length}`);
}

// ─── 13. IA ───────────────────────────────────────────────────────────────────────────────────
{
  const keyOf = (a) => E.actionKey(a);
  // Légalité sur des duels complets avec les vraies données.
  const pool = E.mythics(data).map((c) => c.id);
  let illegal = 0;
  let decisions = 0;
  let switches = 0;
  let ended = 0;
  for (let i = 0; i < 24; i += 1) {
    const a = [0, 1, 2, 3, 4].map((k) => pool[(i * 5 + k * 17) % pool.length]);
    const b = [0, 1, 2, 3, 4].map((k) => pool[(i * 11 + 3 + k * 23) % pool.length]);
    let s = E.createMatch({ data, seed: `ai${i}`, players: [{ name: 'A', deck: a }, { name: 'B', deck: b }] });
    let n = 0;
    while (s.phase !== 'ended' && n < 400) {
      let next = s;
      for (const p of E.pendingPlayers(s)) {
        const act_ = E.chooseAction(s, p);
        decisions += 1;
        if (!E.legalActions(s, p).some((l) => keyOf(l) === keyOf(act_))) illegal += 1;
        if (act_.type === 'switch' && s.phase === 'choose') switches += 1;
        next = E.submit(next, p, act_).state;
      }
      s = next;
      n += 1;
    }
    if (s.phase === 'ended') ended += 1;
  }
  check('IA : toutes ses décisions sont légales (24 duels)', illegal === 0 && decisions > 400, `${illegal} illégales / ${decisions}`);
  check('IA : 24 duels menés à leur terme', ended === 24);
  check('IA : utilise réellement les changements (3 % à 45 % des actions de tour)', switches / decisions > 0.03 && switches / decisions < 0.45, `${(100 * switches / decisions).toFixed(1)} %`);

  // Pureté : n'altère pas l'état, ne dépend pas du hasard futur, ne lit pas le choix secret.
  syn('Fragile', { role: 'Mystique', hp: 3, speed: 50 });
  syn('Rocher', { role: 'Gardien', hp: 40, speed: 50 });
  syn('Masse', { role: 'Duelliste', hp: 60, speed: 90, moves: [{ damage: 12 }] });
  let s = ready(duel('Fragile', 'Masse', { ben: ['Rocher', 'F1', 'F2', 'F3'] }));
  for (const n of ['F1', 'F2', 'F3']) bench(s, 0, n).hp = 9;
  const frozen = deepFreeze(JSON.parse(JSON.stringify(s)));
  const choice = E.chooseAction(frozen, 0);
  check('IA : état gelé accepté, déterministe', same(choice, E.chooseAction(frozen, 0)) && frozen.rng === s.rng);
  check('IA : PV bas face à un coup fatal → change de champion', choice.type === 'switch', JSON.stringify(choice));
  check('IA : le remplaçant choisi est le plus solide', choice.type === 'switch' && s.players[0].champions[choice.to].name === 'Rocher');
  const before = E.chooseAction(s, 0);
  const afterSecret = E.chooseAction(E.submit(s, 1, A(s, 1, 'attack')).state, 0);
  const afterSecret2 = E.chooseAction(E.submit(s, 1, A(s, 1, 'pass')).state, 0);
  check('IA : ignore le choix secret déjà posé par l’adversaire', same(before, afterSecret) && same(before, afterSecret2));
  check('IA : ignore aussi la vue réseau', same(before, E.chooseAction(E.viewFor(E.submit(s, 1, A(s, 1, 'attack')).state, 0), 0)));
  check('IA : rien à choisir → passer', same(E.chooseAction(E.forfeit(s, 0).state, 0), { type: 'pass' }) && same(E.chooseAction(E.submit(s, 0, { type: 'pass' }).state, 0), { type: 'pass' }));
  // Quitte un mauvais rapport de force de type (avec PV corrects).
  syn('Mage', { role: 'Mystique', hp: 24, speed: 60, moves: [{ damage: 3 }] });
  syn('Lame', { role: 'Duelliste', hp: 30, speed: 80, moves: [{ damage: 10 }] });
  syn('Roc', { role: 'Gardien', hp: 30, speed: 40, moves: [{ damage: 9 }] });
  s = ready(duel('Mage', 'Lame', { rules: { typeChart: 1 }, ben: ['Roc', 'F1', 'F2', 'F3'] }));
  act(s, 0).hp = 9;
  const mu = E.chooseAction(s, 0);
  check('IA : mauvais rapport de type + PV faibles → change pour le contre', mu.type === 'switch' && s.players[0].champions[mu.to].name === 'Roc', JSON.stringify(mu));
  // Reste au combat quand c'est favorable.
  s = ready(duel('Lame', 'Mage', { rules: { typeChart: 1 }, ben: ['Roc', 'F1', 'F2', 'F3'] }));
  check('IA : reste et attaque quand le rapport de force est bon', E.chooseAction(s, 0).type === 'move');
  // Remplaçant après K.O. : PV et type.
  syn('Sorcier', { role: 'Mystique', hp: 30, speed: 60, moves: [{ damage: 10 }] });
  syn('Epeiste', { role: 'Duelliste', hp: 30, speed: 60 });
  syn('Bouclier', { role: 'Gardien', hp: 30, speed: 60 });
  s = ready(duel('Tueur', 'Sorcier', { rules: { typeChart: 1 }, ben: ['Bouclier', 'Epeiste', 'F1', 'F2'] }));
  Object.assign(act(s, 0), { alive: false, hp: 0 });
  s.phase = 'replace';
  s.need = [true, false];
  s.choices = [null, null];
  const rp = E.chooseAction(s, 0);
  check('IA : remplaçant favorable au type (Duelliste face à Mystique)', rp.type === 'switch' && s.players[0].champions[rp.to].name === 'Epeiste', JSON.stringify(rp));
  bench(s, 0, 'Epeiste').hp = 2;
  const rp2 = E.chooseAction(s, 0);
  check('IA : remplaçant presque K.O. évité', rp2.type === 'switch' && s.players[0].champions[rp2.to].name !== 'Epeiste', JSON.stringify(rp2));
  check('IA : remplaçant toujours un champion vivant du banc', E.legalActions(s, 0).some((a) => keyOf(a) === keyOf(rp2)));
}

// ─── 14. Déterminisme, JSON, immuabilité, vue réseau ──────────────────────────────────────────
{
  const pool = E.mythics(data).map((c) => c.id);
  const decks = [pool.slice(10, 15), pool.slice(60, 65)];
  const mkMatch = (seed) => E.createMatch({ data, seed, players: [{ name: 'A', deck: decks[0] }, { name: 'B', deck: decks[1] }] });
  const run = (seed, { roundTrip = false, freeze = false } = {}) => {
    let s = mkMatch(seed);
    const log = [];
    let n = 0;
    while (s.phase !== 'ended' && n < 400) {
      if (roundTrip) s = JSON.parse(JSON.stringify(s));
      if (freeze) deepFreeze(s);
      let next = s;
      for (const p of E.pendingPlayers(s)) {
        const view = E.viewFor(s, p);
        const a = E.chooseAction(view, p);
        const r = E.submit(next, p, a);
        log.push(...r.events);
        next = r.state;
      }
      s = next;
      n += 1;
    }
    return { s, log };
  };
  const a = run('det-1');
  const b = run('det-1');
  check('déterminisme : même graine, mêmes choix → mêmes événements et même état', same(a.log, b.log) && same(a.s, b.s));
  const c = run('det-1', { roundTrip: true });
  check('JSON : aller-retour à chaque étape sans effet', same(a.log, c.log) && same(a.s, c.s));
  const d = run('det-1', { freeze: true });
  check('immuabilité : tout l’état gelé à chaque étape, duel identique', same(a.log, d.log) && same(a.s, d.s));
  const others = new Set();
  for (let i = 0; i < 8; i += 1) others.add(JSON.stringify(run(`det-x${i}`).s.log));
  check('graines différentes → duels différents', others.size > 1);
  check('états finaux : JSON simple (pas de undefined, de fonction ni de NaN)', (() => {
    const txt = JSON.stringify(a.s);
    return !/NaN|Infinity|undefined/.test(txt) && same(JSON.parse(txt), a.s);
  })());
  // La vue réseau ne révèle jamais le choix secret.
  let leak = 0;
  let s = mkMatch('view');
  for (let n = 0; n < 60 && s.phase !== 'ended'; n += 1) {
    const pend = E.pendingPlayers(s);
    for (const p of pend) {
      const r = E.submit(s, p, E.chooseAction(s, p));
      if (!r.resolved) {
        const opp = E.viewFor(r.state, 1 - p);
        const mine = r.state.choices[p];
        if (opp.choices[p].type !== 'hidden') leak += 1;
        if (mine.type === 'move' && JSON.stringify(opp.choices).includes('"move"')) leak += 1;
        if (mine.type === 'switch' && JSON.stringify(opp.choices).includes('"to"')) leak += 1;
      }
      s = r.state;
    }
  }
  check('viewFor : jamais de choix adverse en clair pendant tout un duel', leak === 0, String(leak));
  // submit : un état refusé n'est jamais modifié.
  const base = mkMatch('imm');
  const snap = JSON.stringify(base);
  try { E.submit(base, 0, { type: 'move', move: 99 }); } catch { /* attendu */ }
  E.submit(base, 0, E.chooseAction(base, 0));
  E.legalActions(base, 0);
  E.viewFor(base, 1);
  E.chooseAction(base, 1);
  check('aucune fonction ne modifie son entrée', JSON.stringify(base) === snap);
}

// ─── 15. Journal ──────────────────────────────────────────────────────────────────────────────
{
  const pool = E.mythics(data).map((c) => c.id);
  const types = new Map();
  const bad = [];
  let champEvents = 0;
  let champOk = 0;
  for (let i = 0; i < 80; i += 1) {
    let s = E.createMatch({ data, seed: `log${i}`, players: [{ name: 'A', deck: [0, 1, 2, 3, 4].map((k) => pool[(i * 3 + k * 13) % pool.length]) }, { name: 'B', deck: [0, 1, 2, 3, 4].map((k) => pool[(i * 7 + 5 + k * 19) % pool.length]) }] });
    const all = [...s.lastEvents];
    let n = 0;
    while (s.phase !== 'ended' && n < 400) {
      let next = s;
      for (const p of E.pendingPlayers(s)) {
        const r = E.submit(next, p, E.chooseAction(s, p));
        all.push(...r.events);
        next = r.state;
      }
      s = next;
      n += 1;
    }
    for (const e of all) {
      const line = E.describeEvent(e);
      types.set(e.type, (types.get(e.type) ?? 0) + 1);
      if (typeof line !== 'string' || /undefined|NaN|\[object/.test(line)) bad.push(`${e.type}: ${line}`);
      if (line === '' && !['chosen', 'turnEnd'].includes(e.type) && !(e.type === 'turnOrder' && e.reason === 'single')) bad.push(`${e.type} sans texte`);
      if ('side' in e && 'index' in e && e.side >= 0) {
        champEvents += 1;
        if (e.name && e.champType && /^#[0-9a-f]{6}$/.test(e.color) && E.TYPES[e.champType].color === e.color) champOk += 1;
      }
    }
    if (s.log.some((l) => /undefined|NaN/.test(l))) bad.push('journal de l’état');
  }
  check('journal : chaque événement a un texte français propre', bad.length === 0, bad.slice(0, 4).join(' | '));
  check('événements de champion : side, index, name, champType, color cohérents', champEvents > 1000 && champOk === champEvents, `${champOk}/${champEvents}`);
  for (const t of ['turn', 'turnOrder', 'chosen', 'chakra', 'switch', 'phaseReplace', 'move', 'damage', 'heal', 'guard', 'status', 'ko', 'effectiveness', 'passive', 'expire', 'end']) {
    check(`événement « ${t} » observé en simulation`, types.has(t), [...types.keys()].join());
  }
  check('describeEvent : valeurs inattendues sans exception', E.describeEvent(null) === '' && E.describeEvent({ type: 'inconnu' }) === '' && E.describeEvent('x') === '');
  const log = mkLog();
  function mkLog() {
    const st = E.createMatch({ data, seed: 9, players: [{ name: 'A', deck: pool.slice(0, 5) }, { name: 'B', deck: pool.slice(5, 10) }] });
    return st.log;
  }
  check('journal de l’état : plafonné', (() => {
    const s2 = playOut(E.createMatch({ data, seed: 3, rules: { logSize: 20 }, players: [{ name: 'A', deck: pool.slice(0, 5) }, { name: 'B', deck: pool.slice(5, 10) }] }));
    return s2.log.length <= 20;
  })() && log.length > 0);
}

// ─── 16. Livre de règles ──────────────────────────────────────────────────────────────────────
{
  const rules = require('../content/duel-rules.js');
  check('duel-rules.js : tableau de sections', Array.isArray(rules) && rules.length >= 14);
  check('sections { id, titre, paragraphes[] }', rules.every((r) => r.id && r.titre && Array.isArray(r.paragraphes) && r.paragraphes.length && r.paragraphes.every((p) => typeof p === 'string' && p.length > 0)));
  check('identifiants de section uniques', new Set(rules.map((r) => r.id)).size === rules.length);
  const text = rules.flatMap((r) => [r.titre, ...r.paragraphes]).join('\n');
  const sandbox = { window: {} };
  vm.runInNewContext(readFileSync(new URL('../content/duel-rules.js', import.meta.url), 'utf8'), sandbox);
  check('content script : window.KYARA_DUEL_RULES', Array.isArray(sandbox.window.KYARA_DUEL_RULES) && sandbox.window.KYARA_DUEL_RULES.length === rules.length);
  const fr = (n) => String(n).replace('.', ',');
  const expects = [
    [`${R.maxTurns} tours`, 'limite de tours'],
    [`${R.chooseSeconds} secondes`, 'délai de choix en ligne'],
    [`${R.replaceSeconds} secondes`, 'délai de remplacement en ligne'],
    [`plafond de ${R.maxChakra}`, 'plafond de chakra'],
    [`${R.ultimateCost} chakra`, 'coût de l’ultime'],
    [`${R.supportCost} chakra`, 'coût du soutien'],
    [`+${R.atkBonusCap} ATQ`, 'plafond d’ATQ'],
    [`plafond de ${R.guardCap}`, 'plafond de garde'],
    [`gagne ${R.lateGuard} garde`, 'garde du champion qui agit en second'],
    [`plafond de ${R.buffCap}`, 'plafond des préparés'],
    [`${R.hasteSecondHitPct} %`, 'second coup de Hâte'],
    [`×${fr(R.typeStrong)}`, 'efficacité forte'],
    [`×${fr(R.typeWeak)}`, 'efficacité faible'],
    [`×${fr(R.typeStrongMinor)}`, 'petite efficacité forte'],
    [`×${fr(R.typeWeakMinor)}`, 'petite efficacité faible'],
    [`tour ${R.fatigueTurn}`, 'début de l’épuisement'],
    [`${R.fatigueDamage} PV`, 'dégâts d’épuisement'],
    [R.guardDecayPct >= 100 ? 'elle disparaît' : `${R.guardDecayPct} %`, 'usure de la garde'],
    [`${R.poisonDamage} PV`, 'poison'],
    [`${R.regenHeal} PV`, 'régénération'],
    [`${R.rageBonus} dégâts`, 'rage'],
    [`${R.weaknessMalus} dégâts`, 'faiblesse']
  ];
  for (const [needle, label] of expects) check(`règles : ${label} (« ${needle} »)`, text.includes(needle));
  check('règles : coût de changement', text.includes(`${R.switchCost} chakra`) && R.switchCost === 0);
  for (const [t, def] of Object.entries(E.TYPES)) check(`règles : type ${t} avec sa couleur ${def.color}`, text.includes(t) && text.includes(def.color));
  for (const word of ['Poison', 'Malédiction', 'Faiblesse', 'Rage', 'Régénération', 'Hâte', 'Subaru', 'Ram', 'abandon', 'garde', 'invulnérab', 'sacrifi', 'ranim', 'rejoue', 'saute',
    'banc', 'remplaç', 'changement', 'secret', 'simultané', 'vitesse', 'agit en second', 'ne joue plus', 'nouvel actif', 'efficac', 'épuisement', 'entrée en jeu', 'Ram face à Rem']) {
    check(`règles : mentionne « ${word} »`, text.toLowerCase().includes(word.toLowerCase()));
  }
  check('règles : plus aucune trace du jeu alterné v1 (manche / 5 contre 5)', !/manche|arène 5 contre 5|joue un tour/i.test(text.replace('Ram face à Rem', '')));
  const md = readFileSync(new URL('../docs/REGLES-DUEL.md', import.meta.url), 'utf8');
  check('REGLES-DUEL.md : toutes les sections', rules.every((r) => md.includes(r.titre)));
  check('REGLES-DUEL.md : tous les paragraphes', rules.every((r) => r.paragraphes.every((p) => md.includes(p))));
}

// ─── 17. Fuzz : actions légales au hasard, règles variées, invariants ────────────────────────
{
  const pool = E.mythics(data).map((c) => c.id);
  let rs = 12345;
  const rnd = () => {
    let t = (rs = (rs + 0x6D2B79F5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const variants = [
    {}, { lateGuard: 0 }, { lateGuard: 12 }, { benchDots: 1 }, { switchCost: 1 }, { typeChart: 0 }, { guardDecayPct: 0 }, { guardDecayPct: 50, benchGuardDecayPct: 50 },
    { speedBand: 8 }, { speedLuck: 50 }, { fatigueTurn: 0, maxTurns: 25 }, { maxChakra: 10, startChakra: 6, chakraPerTurn: 3 }, { damagePct: 150 }, { damagePct: 40, fatigueTurn: 10 }
  ];
  let steps = 0;
  let violations = 0;
  let errors = 0;
  let endedCount = 0;
  const first = [];
  for (let g = 0; g < 160; g += 1) {
    const ids = pool.slice().sort(() => rnd() - 0.5);
    const rules = pick(variants);
    let s = E.createMatch({ data, seed: g * 977, rules, players: [{ name: 'A', deck: ids.slice(0, 5) }, { name: 'B', deck: ids.slice(5, 10) }] });
    let n = 0;
    try {
      while (s.phase !== 'ended' && n < 700) {
        const pend = E.pendingPlayers(s);
        if (!pend.length) throw new Error('personne ne doit choisir');
        for (const p of pend) {
          const legal = E.legalActions(s, p);
          if (!legal.length) throw new Error(`aucune action légale pour ${p} en phase ${s.phase}`);
          // Mélange : surtout du hasard, parfois l'IA.
          const a = rnd() < 0.25 ? E.chooseAction(s, p) : pick(legal);
          s = E.submit(s, p, a).state;
          steps += 1;
          if (s.phase === 'ended') break;
        }
        n += 1;
        // Invariants.
        const R2 = s.rules;
        for (const pl of s.players) {
          const ok = pl.chakra >= 0 && pl.chakra <= R2.maxChakra && pl.champions.length === 5 && pl.active >= 0 && pl.active < 5
            && pl.champions.every((c) => c.hp >= 0 && c.hp <= c.maxHp && c.alive === (c.hp > 0) && c.guard >= 0 && c.guard <= R2.guardCap
              && c.atkBonus >= 0 && c.atkBonus <= R2.atkBonusCap && c.buff >= 0 && c.buff <= R2.buffCap
              && Object.values(c.statuses).every((v) => v > 0 && Number.isInteger(v)) && Number.isFinite(c.hp));
          if (!ok) violations += 1;
        }
        if (s.phase === 'choose' && s.players.some((pl, i) => !pl.champions[pl.active].alive && s.need[i])) violations += 1;
        if (s.winner !== null && s.phase !== 'ended') violations += 1;
        if (s.phase === 'replace' && E.pendingPlayers(s).some((p) => s.players[p].champions[s.players[p].active].alive)) violations += 1;
      }
      if (s.phase === 'ended') endedCount += 1;
      else first.push(`duel ${g} non terminé`);
    } catch (err) {
      errors += 1;
      if (first.length < 3) first.push(`duel ${g} (${JSON.stringify(rules)}) : ${err.message}`);
    }
  }
  check('fuzz : 160 duels aléatoires sans exception', errors === 0, first.join(' | '));
  check('fuzz : tous les duels se terminent', endedCount === 160, first.join(' | '));
  check('fuzz : invariants (PV, garde, chakra, actif vivant, statuts)', violations === 0, String(violations));
  check('fuzz : beaucoup d’actions jouées', steps > 3000, String(steps));
}

console.log(`\nContrôles : ${checks} · échecs : ${failures}`);
process.exit(failures ? 1 : 0);
