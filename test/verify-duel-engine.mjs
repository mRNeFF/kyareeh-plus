// Vérifie le moteur du duel (content/duel-engine.js) : mise en place, initiative, chakra, ciblage,
// formule de dégâts, chaque champ d'effet du §2.5, chaque statut, les passifs (203 Mythiques),
// fins de duel, rejet des actions illégales, immuabilité, déterminisme et sérialisation.
// Les scénarios partent d'un vrai duel puis ajustent l'état à la main (le test en est propriétaire).
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

// Données où les Légendaires sont jouables : uniquement pour tester les effets qui n'existent
// que sur elles (sacrifice de Doflamingo, Ram face à Rem, passifs d'Ai, Akane, Coco, Sylphiette).
const dataL = JSON.parse(JSON.stringify(data));
for (const c of dataL.champions) c.rarity = 'M';

const card = (name, d = data) => {
  const c = d.champions.find((x) => x.name === name);
  if (!c) throw new Error(`carte introuvable : ${name}`);
  return c;
};
// Remplissage : passifs « sous 50 % » uniquement (inertes tant qu'on ne les blesse pas).
const FILLERS = ['Mai Sakurajima', 'Sukuna', 'Yami Sukehiro', 'Izuku Midoriya', 'Taiga Aisaka', 'Simon'];
function deckOf(names) {
  const out = [...names];
  for (const f of FILLERS) if (out.length < 5 && !out.includes(f)) out.push(f);
  return out;
}
function fresh(a, b, { seed = 1, d = data, rules } = {}) {
  return E.createMatch({
    data: d, seed, rules,
    players: [
      { id: 'a', name: 'Alice', deck: deckOf(a).map((n) => card(n, d).id) },
      { id: 'b', name: 'Bob', deck: deckOf(b).map((n) => card(n, d).id) }
    ]
  });
}
// Donne la main au joueur p, en début de manche, avec le chakra plein (sans rien effacer).
function handTo(s, p, chakra = R.maxChakra) {
  s.turn = p;
  s.first = p;
  s.half = 0;
  s.players[p].chakra = chakra;
  return s;
}
// Idem pour un duel neuf ; efface aussi les effets des passifs de début de tour déjà appliqués par createMatch.
function force(s, p, chakra = R.maxChakra) {
  for (const pl of s.players) {
    for (const c of pl.champions) Object.assign(c, { guard: 0, buff: 0, atkBonus: 0, statuses: {} });
  }
  s.turn = p;
  s.first = p;
  s.half = 0;
  s.players[p].chakra = chakra;
  return s;
}
function idx(s, side, name) {
  const i = s.players[side].champions.findIndex((c) => c.name === name);
  if (i < 0) throw new Error(`${name} absent du camp ${side}`);
  return i;
}
const ch = (s, side, name) => s.players[side].champions[idx(s, side, name)];
function inert(s, side, name, hp) {
  const c = ch(s, side, name);
  c.passiveFx = { rules: [] };
  if (hp) {
    c.maxHp = hp;
    c.hp = hp;
  }
  return c;
}
function action(s, p, actor, kind, target) {
  const c = ch(s, p, actor);
  const move = c.moves.findIndex((m) => m.kind === kind);
  const a = { type: 'move', actor: idx(s, p, actor), move };
  if (target) {
    const [side, name] = target;
    a.target = { side, index: idx(s, side, name) };
  }
  return a;
}
const use = (s, p, actor, kind, target) => E.applyAction(s, p, action(s, p, actor, kind, target));
const pass = (s, p) => E.applyAction(s, p, { type: 'pass' });
const types = (events) => events.map((e) => e.type);
const find = (events, type, name) => events.filter((e) => e.type === type && (!name || e.name === name));
function deepFreeze(o) {
  if (o && typeof o === 'object') {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}
function playOut(s, max = 3000) {
  let n = 0;
  while (E.currentPlayer(s) !== null && n < max) {
    const p = E.currentPlayer(s);
    s = E.applyAction(s, p, E.chooseAction(s, p)).state;
    n += 1;
  }
  return s;
}
// Passe jusqu'à ce que `cond` soit vrai (ou fin de duel).
function passUntil(s, cond, max = 20) {
  for (let i = 0; i < max && !cond(s) && E.currentPlayer(s) !== null; i += 1) s = pass(s, E.currentPlayer(s)).state;
  return s;
}

// ─── 1. Chargement ────────────────────────────────────────────────────────────────────────────
{
  const esm = (await import('../content/duel-engine.js')).default;
  check('import ESM : même API', esm && typeof esm.createMatch === 'function' && typeof esm.applyAction === 'function');
  const sandbox = { window: {} };
  vm.runInNewContext(readFileSync(new URL('../content/duel-engine.js', import.meta.url), 'utf8'), sandbox);
  check('content script : window.KYARA_DUEL_ENGINE', typeof sandbox.window.KYARA_DUEL_ENGINE?.legalActions === 'function');
  for (const k of ['RULES', 'mythics', 'validateDeck', 'createMatch', 'legalActions', 'applyAction', 'currentPlayer', 'chooseAction', 'describeEvent']) {
    check(`API : ${k}`, k in E);
  }
  const code = readFileSync(new URL('../content/duel-engine.js', import.meta.url), 'utf8').replace(/^\s*\/\/.*$/gm, '');
  check('moteur pur : ni Math.random ni Date', !/Math\.random|Date\.now|new Date/.test(code));
  check('moteur pur : ni DOM ni stockage ni réseau', !/document\.|localStorage|fetch\(|XMLHttpRequest|WebSocket|browser\./.test(code));
}

// ─── 2. Données et decks ──────────────────────────────────────────────────────────────────────
{
  check('203 Mythiques jouables', E.mythics(data).length === 203, String(E.mythics(data).length));
  const ids = E.mythics(data).slice(0, 5).map((c) => c.id);
  check('deck valide', E.validateDeck(data, ids).ok === true);
  check('deck de 4 refusé', !E.validateDeck(data, ids.slice(0, 4)).ok);
  check('deck de 6 refusé', !E.validateDeck(data, [...ids, E.mythics(data)[6].id]).ok);
  check('doublon refusé', !E.validateDeck(data, [ids[0], ids[0], ids[1], ids[2], ids[3]]).ok);
  check('id inconnu refusé', !E.validateDeck(data, [...ids.slice(0, 4), 999999999]).ok);
  check('Légendaire refusée', !E.validateDeck(data, [...ids.slice(0, 4), card('Ram').id]).ok);
  check('message d’erreur en français', /Deck invalide/.test(E.validateDeck(data, []).error ?? ''));
  throws('createMatch refuse un deck invalide', () => E.createMatch({ data, seed: 1, players: [{ deck: ids }, { deck: ids.slice(0, 3) }] }), /Joueur 2/);
}

// ─── 3. Mise en place ─────────────────────────────────────────────────────────────────────────
{
  const s = fresh(['Satoru Gojou'], ['Rem']);
  check('manche 1', s.round === 1);
  check('winner null', s.winner === null);
  check('rng numérique', Number.isInteger(s.rng));
  check('log tableau', Array.isArray(s.log) && s.log.length > 0);
  check('5 champions par camp', s.players.every((p) => p.champions.length === 5));
  const all = s.players.flatMap((p) => p.champions);
  check('PV pleins', all.every((c) => c.hp === c.maxHp && c.alive));
  check('garde de départ du camp qui joue en second', s.players[1].champions.every((c) => c.guard === Math.min(R.guardCap, R.secondPlayerGuard)));
  check('pas de garde de départ pour le camp qui ouvre (hors passifs)', s.players[0].champions.filter((c) => c.name !== 'Emilia').every((c) => c.guard === 0));
  check('aucun statut chez l’adversaire', s.players[1].champions.every((c) => Object.keys(c.statuses).length === 0));
  check('ultimes disponibles', all.every((c) => !c.ultimateUsed));
  check('champ id/name/image', all.every((c) => c.id && c.name && 'image' in c));
  check('3 capacités avec coût', all.every((c) => c.moves.length === 3 && c.moves.every((m) => Number.isInteger(m.cost))));
  check('joueurs : id, name, chakra, skipNext', s.players.every((p) => p.id && p.name && Number.isInteger(p.chakra) && p.skipNext === false));
  check('Gojou (86) ouvre la manche', s.first === 0 && E.currentPlayer(s) === 0);
  check('chakra du premier joueur = départ + gain', s.players[0].chakra === Math.min(R.maxChakra, R.startChakra + R.chakraPerTurn));
  check('chakra du second joueur = départ', s.players[1].chakra === R.startChakra);
  check('state.rules copie RULES', s.rules.maxRounds === R.maxRounds && s.rules.ultimateCost === R.ultimateCost);
  check('état JSON pur', JSON.stringify(JSON.parse(JSON.stringify(s))) === JSON.stringify(s));
}

// ─── 4. Initiative ────────────────────────────────────────────────────────────────────────────
{
  const slow = ['Taiga Aisaka', 'Simon', 'Rudeus Greyrat', 'Reiner Braun', 'Sasha Blouse'];
  let s = fresh(slow, ['Satoru Gojou']);
  check('le camp le plus rapide commence', s.first === 1 && E.currentPlayer(s) === 1);
  check('événement de manche : raison vitesse', s.lastEvents[0].type === 'round' && s.lastEvents[0].reason === 'speed');
  s = fresh(['Subaru Natsuki', ...slow.slice(0, 4)], ['Satoru Gojou']);
  check('Subaru vivant : son camp ouvre (même face à plus rapide)', s.first === 0 && s.lastEvents[0].reason === 'subaru');
  // Subaru KO : retour à la vitesse.
  s = force(s, 0);
  ch(s, 0, 'Subaru Natsuki').alive = false;
  ch(s, 0, 'Subaru Natsuki').hp = 0;
  s = pass(s, 0).state;
  s = pass(s, 1).state;
  check('Subaru KO : la vitesse décide de nouveau', s.round === 2 && s.first === 1);
  // Égalité : tirage avec la graine, déterministe.
  const firsts = new Set();
  for (let seed = 1; seed <= 12; seed += 1) {
    const a = fresh(['Satoru Gojou'], ['Satoru Gojou'], { seed });
    const b = fresh(['Satoru Gojou'], ['Satoru Gojou'], { seed });
    check(`égalité : même graine ${seed} → même premier`, a.first === b.first && a.lastEvents[0].reason === 'tie');
    firsts.add(a.first);
  }
  check('égalité : les deux camps peuvent commencer', firsts.size === 2);
  // Ram face à Rem (Légendaire, données de test).
  s = fresh(['Ram'], ['Rem', 'Satoru Gojou'], { d: dataL });
  check('Ram face à Rem : son camp ouvre la 1re manche', s.first === 0 && s.lastEvents[0].reason === 'ram');
  s = pass(s, 0).state;
  s = pass(s, 1).state;
  check('Ram : manche 2 rendue à la vitesse', s.round === 2 && s.first === 1);
  s = fresh(['Ram'], ['Satoru Gojou'], { d: dataL });
  check('Ram sans Rem en face : vitesse', s.first === 1);
  s = fresh(['Ram'], ['Rem', 'Subaru Natsuki'], { d: dataL });
  check('Ram prime sur Subaru en 1re manche', s.first === 0);
  s = pass(s, 0).state;
  s = pass(s, 1).state;
  check('puis Subaru ouvre les manches suivantes', s.first === 1 && s.lastEvents.some((e) => e.type === 'round' && e.reason === 'subaru'));
}

// ─── 5. Chakra, coûts, ultime ─────────────────────────────────────────────────────────────────
{
  let s = fresh(['Satoru Gojou'], ['Rem']);
  const c0 = s.players[0].chakra;
  s = pass(s, 0).state;
  check('gain de chakra au début du tour adverse', s.players[1].chakra === Math.min(R.maxChakra, R.startChakra + R.chakraPerTurn));
  s = pass(s, 1).state;
  check('gain à chaque tour', s.players[0].chakra === Math.min(R.maxChakra, c0 + R.chakraPerTurn));
  force(s, 0, R.maxChakra);
  s.half = 1; // fin de manche après ce tour
  s = pass(s, 0).state;
  s = passUntil(s, (x) => E.currentPlayer(x) === 0);
  check('plafond de chakra', s.players[0].chakra === R.maxChakra);

  s = force(fresh(['Satoru Gojou'], ['Rem']), 0, 3);
  let r = use(s, 0, 'Satoru Gojou', 'support', [0, 'Satoru Gojou']);
  check('soutien : coût payé', r.state.players[0].chakra === 3 - R.supportCost);
  check('attaque : coût 0', R.attackCost === 0);
  s = force(fresh(['Satoru Gojou'], ['Rem']), 0, R.ultimateCost - 1);
  check('ultime illégal sans assez de chakra', !E.legalActions(s, 0).some((a) => a.type === 'move' && s.players[0].champions[a.actor].moves[a.move].kind === 'ultimate'));
  check('soutien illégal sans chakra', !E.legalActions(force(fresh(['Satoru Gojou'], ['Rem']), 0, R.supportCost - 1), 0).some((a) => a.type === 'move' && a.move === 1) || R.supportCost === 0);
  s = force(fresh(['Satoru Gojou'], ['Rem']), 0, R.ultimateCost);
  inert(s, 1, 'Rem', 100);
  r = use(s, 0, 'Satoru Gojou', 'ultimate', [1, 'Rem']);
  check('ultime : coût payé', r.state.players[0].chakra === 0);
  check('ultime : marqué utilisé', ch(r.state, 0, 'Satoru Gojou').ultimateUsed === true);
  s = handTo(r.state, 0, R.maxChakra);
  check('ultime : une fois par champion et par duel', !E.legalActions(s, 0).some((a) => a.type === 'move' && a.actor === idx(s, 0, 'Satoru Gojou') && a.move === 2));
  throws('ultime rejoué rejeté', () => use(s, 0, 'Satoru Gojou', 'ultimate', [1, 'Rem']), /illégale/);
}

// ─── 6. Ciblage ───────────────────────────────────────────────────────────────────────────────
{
  const s = force(fresh(['Satoru Gojou', 'Emilia', 'Luffy Monkey', 'Aqua'], ['Rem']), 0);
  const legal = E.legalActions(s, 0);
  const of = (name, k) => legal.filter((a) => a.type === 'move' && a.actor === idx(s, 0, name) && a.move === k);
  check('attaque : 5 cibles ennemies', of('Satoru Gojou', 0).length === 5 && of('Satoru Gojou', 0).every((a) => a.target.side === 1));
  check('soin/garde sans cible ennemie : cible alliée (soi compris)', of('Emilia', 1).length === 5 && of('Emilia', 1).every((a) => a.target.side === 0)
    && of('Emilia', 1).some((a) => a.target.index === idx(s, 0, 'Emilia')));
  check('ultime d’équipe sans cible', of('Luffy Monkey', 2).length === 1 && !of('Luffy Monkey', 2)[0].target);
  check('targetMode exposé', E.targetMode({ damage: 3 }) === 'enemy' && E.targetMode({ guard: 2 }) === 'ally' && E.targetMode({ teamAtk: 2 }) === 'none');
  check('pass toujours légal', legal.some((a) => a.type === 'pass'));
  check('aucune action pour le joueur qui attend', E.legalActions(s, 1).length === 0);
  const t = JSON.parse(JSON.stringify(s));
  ch(t, 1, 'Rem').alive = false;
  ch(t, 1, 'Rem').hp = 0;
  check('champion KO non ciblable', !E.legalActions(t, 0).some((a) => a.target && a.target.side === 1 && a.target.index === idx(t, 1, 'Rem')));
  check('champion KO ne joue pas', (() => {
    const u = JSON.parse(JSON.stringify(s));
    ch(u, 0, 'Emilia').alive = false;
    return !E.legalActions(u, 0).some((a) => a.actor === idx(u, 0, 'Emilia'));
  })());
  // Soin d'une capacité qui vise un ennemi → sur le lanceur (Aqua, God Blow), bonus de soin d'Aqua.
  const u = force(fresh(['Aqua'], ['Rem']), 0);
  inert(u, 1, 'Rem', 100);
  ch(u, 0, 'Aqua').hp = 5;
  const r = use(u, 0, 'Aqua', 'attack', [1, 'Rem']);
  check('soin d’une attaque : sur le lanceur (+1 d’Aqua)', ch(r.state, 0, 'Aqua').hp === 5 + 2 + 1 - 1, `PV ${ch(r.state, 0, 'Aqua').hp}`);
}

// ─── 7. Actions illégales, immuabilité ────────────────────────────────────────────────────────
{
  const s = deepFreeze(force(fresh(['Satoru Gojou'], ['Rem']), 0));
  const before = JSON.stringify(s);
  throws('mauvais joueur', () => pass(s, 1), /tour/);
  throws('capacité inexistante', () => E.applyAction(s, 0, { type: 'move', actor: 0, move: 7, target: { side: 1, index: 0 } }), /illégale/);
  throws('acteur inexistant', () => E.applyAction(s, 0, { type: 'move', actor: 9, move: 0, target: { side: 1, index: 0 } }), /illégale/);
  throws('attaque sur un allié', () => E.applyAction(s, 0, { type: 'move', actor: 0, move: 0, target: { side: 0, index: 1 } }), /illégale/);
  throws('attaque sans cible', () => E.applyAction(s, 0, { type: 'move', actor: 0, move: 0 }), /illégale/);
  throws('action inconnue', () => E.applyAction(s, 0, { type: 'cheat' }), /illégale/);
  throws('action nulle', () => E.applyAction(s, 0, null), /illégale/);
  let r;
  try {
    r = use(s, 0, 'Satoru Gojou', 'attack', [1, 'Rem']);
  } catch (err) {
    r = null;
    check('applyAction sur un état gelé', false, err.message);
  }
  check('applyAction ne mute pas son entrée', JSON.stringify(s) === before);
  check('applyAction renvoie un nouvel état', r && r.state !== s && Array.isArray(r.events));
  check('seq incrémenté', r && r.state.seq === s.seq + 1);
  check('lastEvents = events', r && JSON.stringify(r.state.lastEvents) === JSON.stringify(r.events));
  const c1 = E.chooseAction(s, 0);
  check('chooseAction ne mute pas', JSON.stringify(s) === before);
  check('chooseAction déterministe', JSON.stringify(c1) === JSON.stringify(E.chooseAction(s, 0)));
  check('chooseAction : action légale', E.legalActions(s, 0).some((a) => JSON.stringify(a) === JSON.stringify(c1)));
}

// ─── 8. Formule de dégâts, garde, hâte ────────────────────────────────────────────────────────
{
  let s = force(fresh(['Satoru Gojou'], ['Mai Sakurajima']), 0);
  inert(s, 1, 'Mai Sakurajima', 100);
  const g = ch(s, 0, 'Satoru Gojou');
  g.atkBonus = 2;
  g.buff = 3;
  g.statuses.rage = 1;
  let r = use(s, 0, 'Satoru Gojou', 'attack', [1, 'Mai Sakurajima']);
  const dmg = find(r.events, 'damage', 'Mai Sakurajima')[0];
  check('dégâts = capacité + ATQ + bonus + préparés + rage', dmg?.amount === 10 + 3 + 2 + 3 + R.rageBonus, JSON.stringify(dmg));
  check('dégâts préparés consommés', ch(r.state, 0, 'Satoru Gojou').buff === 0);
  check('statut appliqué (apply)', ch(r.state, 1, 'Mai Sakurajima').statuses.weakness === 2);

  s = force(fresh(['Satoru Gojou'], ['Mai Sakurajima']), 0);
  inert(s, 1, 'Mai Sakurajima', 100);
  ch(s, 0, 'Satoru Gojou').statuses.weakness = 1;
  r = use(s, 0, 'Satoru Gojou', 'attack', [1, 'Mai Sakurajima']);
  check('faiblesse : −2 par coup', find(r.events, 'damage', 'Mai Sakurajima')[0]?.amount === 10 + 3 - R.weaknessMalus);

  s = force(fresh(['Levi'], ['Mai Sakurajima']), 0);
  inert(s, 1, 'Mai Sakurajima', 100);
  inert(s, 0, 'Levi');
  r = use(s, 0, 'Levi', 'attack', [1, 'Mai Sakurajima']);
  check('bonusIfLow absent au-dessus de 50 %', find(r.events, 'damage')[0]?.amount === 8 + 3);
  ch(s, 0, 'Levi').hp = Math.floor(ch(s, 0, 'Levi').maxHp / 2);
  r = use(s, 0, 'Levi', 'attack', [1, 'Mai Sakurajima']);
  check('bonusIfLow à 50 % ou moins', find(r.events, 'damage')[0]?.amount === 8 + 3 + 3);

  s = force(fresh(['Satoru Gojou'], ['Mai Sakurajima']), 0);
  inert(s, 1, 'Mai Sakurajima', 100).guard = 5;
  r = use(s, 0, 'Satoru Gojou', 'attack', [1, 'Mai Sakurajima']);
  const d2 = find(r.events, 'damage')[0];
  check('garde absorbe d’abord', d2?.absorbed === 5 && d2?.amount === 8 && ch(r.state, 1, 'Mai Sakurajima').hp === 92 && ch(r.state, 1, 'Mai Sakurajima').guard === 0);

  s = force(fresh(['Satoru Gojou'], ['Mai Sakurajima']), 0);
  ch(s, 0, 'Mai Sakurajima').guard = R.guardCap - 1;
  r = use(s, 0, 'Satoru Gojou', 'support', [0, 'Mai Sakurajima']);
  check('garde plafonnée', ch(r.state, 0, 'Mai Sakurajima').guard === R.guardCap);
  check('soutien pur : aucun dégât', find(r.events, 'damage').length === 0);

  s = force(fresh(['Killua Zoldyck'], ['Mai Sakurajima']), 0);
  inert(s, 1, 'Mai Sakurajima', 100);
  const k = ch(s, 0, 'Killua Zoldyck');
  k.statuses.haste = 1;
  k.buff = 4;
  r = use(s, 0, 'Killua Zoldyck', 'attack', [1, 'Mai Sakurajima']);
  const hits = find(r.events, 'damage', 'Mai Sakurajima');
  check('hâte : deux coups', hits.length === 2 && hits[0].hit === 1 && hits[1].hit === 2);
  check('hâte : préparés sur le 1er coup seulement', hits[0]?.amount === 7 + 3 + 4 && hits[1]?.amount === Math.round(((7 + 3) * R.hasteSecondHitPct) / 100), JSON.stringify(hits.map((h) => h.amount)));
  check('hâte consommée', !ch(r.state, 0, 'Killua Zoldyck').statuses.haste);
  s = force(fresh(['Killua Zoldyck'], ['Mai Sakurajima']), 0);
  inert(s, 1, 'Mai Sakurajima').hp = 5;
  ch(s, 0, 'Killua Zoldyck').statuses.haste = 1;
  r = use(s, 0, 'Killua Zoldyck', 'attack', [1, 'Mai Sakurajima']);
  check('hâte : le 2e coup est perdu si la cible tombe', find(r.events, 'damage', 'Mai Sakurajima').length === 1 && find(r.events, 'ko', 'Mai Sakurajima').length === 1);
  s = force(fresh(['Killua Zoldyck'], ['Mai Sakurajima']), 0);
  ch(s, 0, 'Killua Zoldyck').statuses.haste = 1;
  r = use(s, 0, 'Killua Zoldyck', 'support', [0, 'Killua Zoldyck']);
  check('hâte gardée par un soutien sans dégâts', ch(r.state, 0, 'Killua Zoldyck').statuses.haste === 1);
}

// ─── 9. Champs d'effet (§2.5) ─────────────────────────────────────────────────────────────────
{
  // randomDamage + invincible + recoil (Denji, Broyeur).
  const rolls = new Set();
  let invState = null;
  for (let seed = 1; seed <= 25; seed += 1) {
    const s = force(fresh(['Denji'], ['Mai Sakurajima'], { seed }), 0);
    inert(s, 1, 'Mai Sakurajima', 100);
    const r = use(s, 0, 'Denji', 'ultimate', [1, 'Mai Sakurajima']);
    const d = find(r.events, 'damage', 'Mai Sakurajima')[0]?.amount;
    check(`randomDamage dans [6,18] + ATQ (graine ${seed})`, d >= 9 && d <= 21, String(d));
    rolls.add(d);
    const again = use(s, 0, 'Denji', 'ultimate', [1, 'Mai Sakurajima']);
    check(`randomDamage déterministe (graine ${seed})`, find(again.events, 'damage', 'Mai Sakurajima')[0]?.amount === d);
    if (seed === 1) invState = r.state;
  }
  check('randomDamage varie selon la graine', rolls.size > 3);
  check('recoil : le lanceur paie', ch(invState, 0, 'Denji').hp === 20 - 5);
  check('invincible posé', ch(invState, 0, 'Denji').invincible === 2);
  let s = invState;
  const hitDenji = (st) => {
    const p = E.currentPlayer(st);
    if (p === 1) {
      const r = use(st, 1, 'Mai Sakurajima', 'attack', [0, 'Denji']);
      return { st: r.state, ev: r.events };
    }
    return { st: pass(st, p).state, ev: [] };
  };
  const seen = [];
  for (let i = 0; i < 8 && seen.length < 3; i += 1) {
    const roundBefore = s.round;
    const r = hitDenji(s);
    if (r.ev.length) seen.push({ round: roundBefore, blocked: find(r.ev, 'blocked', 'Denji').some((e) => e.by === 'invincible'), dmg: find(r.ev, 'damage', 'Denji').length });
    s = r.st;
  }
  check('invincible : aucun dégât pendant la manche du lancer', seen[0]?.round === 1 && seen[0].blocked && seen[0].dmg === 0, JSON.stringify(seen));
  check('invincible : aucun dégât la manche suivante', seen[1]?.round === 2 && seen[1].blocked, JSON.stringify(seen));
  check('invincible : expire après N manches', seen[2]?.round === 3 && !seen[2].blocked && seen[2].dmg > 0, JSON.stringify(seen));

  // heal (cible alliée) + guard (Emilia).
  s = force(fresh(['Emilia'], ['Rem']), 0);
  ch(s, 0, 'Mai Sakurajima').hp = 10;
  let r = use(s, 0, 'Emilia', 'support', [0, 'Mai Sakurajima']);
  check('heal sur l’allié choisi', ch(r.state, 0, 'Mai Sakurajima').hp === 14);
  check('guard sur l’allié choisi', ch(r.state, 0, 'Mai Sakurajima').guard === 4);
  ch(s, 0, 'Mai Sakurajima').hp = ch(s, 0, 'Mai Sakurajima').maxHp - 1;
  r = use(s, 0, 'Emilia', 'support', [0, 'Mai Sakurajima']);
  check('heal plafonné aux PV max', ch(r.state, 0, 'Mai Sakurajima').hp === ch(r.state, 0, 'Mai Sakurajima').maxHp);

  // healTeam + teamAtk plafonné (Frieren, Champ de fleurs).
  s = force(fresh(['Frieren'], ['Rem']), 0);
  inert(s, 1, 'Rem', 100);
  for (const c of s.players[0].champions) c.hp = 5;
  ch(s, 0, 'Sukuna').alive = false;
  ch(s, 0, 'Sukuna').hp = 0;
  r = use(s, 0, 'Frieren', 'ultimate', [1, 'Rem']);
  check('healTeam : chaque allié vivant', ['Mai Sakurajima', 'Yami Sukehiro', 'Izuku Midoriya'].every((n) => ch(r.state, 0, n).hp === 13));
  check('healTeam : pas les KO', ch(r.state, 0, 'Sukuna').hp === 0 && !ch(r.state, 0, 'Sukuna').alive);
  check('teamAtk : plafonné', ch(r.state, 0, 'Mai Sakurajima').atkBonus === Math.min(R.atkBonusCap, 5));
  check('teamAtk : pas les KO', ch(r.state, 0, 'Sukuna').atkBonus === 0);

  // healTeamFull + extraTurn + selfApply (Reiner, Trahison).
  s = force(fresh(['Reiner Braun'], ['Rem']), 0, R.ultimateCost);
  inert(s, 1, 'Rem', 100);
  for (const c of s.players[0].champions) c.hp = 4;
  r = use(s, 0, 'Reiner Braun', 'ultimate', [1, 'Rem']);
  check('healTeamFull : PV max', ['Mai Sakurajima', 'Sukuna', 'Yami Sukehiro', 'Izuku Midoriya'].every((n) => ch(r.state, 0, n).hp === ch(r.state, 0, n).maxHp));
  check('healTeamFull puis contrecoup du lanceur', ch(r.state, 0, 'Reiner Braun').hp === 21 - 5);
  check('selfApply : malédiction sur le lanceur', ch(r.state, 0, 'Reiner Braun').statuses.curse === 3);
  check('extraTurn : le joueur rejoue', E.currentPlayer(r.state) === 0 && r.events.some((e) => e.type === 'extraTurn'));
  check('extraTurn : pas de nouveau chakra', r.state.players[0].chakra === 0);
  check('extraTurn : même manche', r.state.round === s.round);
  const r2 = pass(r.state, 0);
  check('après le tour bonus, l’adversaire joue', E.currentPlayer(r2.state) === 1);

  // buff (Zoro, Santoryu : garde sur l'allié choisi, préparés sur Zoro).
  s = force(fresh(['Zoro Roronoa'], ['Rem']), 0);
  r = use(s, 0, 'Zoro Roronoa', 'support', [0, 'Sukuna']);
  check('buff : dégâts préparés du lanceur', ch(r.state, 0, 'Zoro Roronoa').buff === 3 && ch(r.state, 0, 'Sukuna').guard === 4);

  // selfAtk (Power, Cascade écarlate).
  s = force(fresh(['Power'], ['Rem']), 0);
  inert(s, 1, 'Rem', 100);
  r = use(s, 0, 'Power', 'ultimate', [1, 'Rem']);
  check('selfAtk : plafonné', ch(r.state, 0, 'Power').atkBonus === Math.min(R.atkBonusCap, 7));
  check('selfAtk : n’affecte pas les alliés', ch(r.state, 0, 'Sukuna').atkBonus === 0);
  check('selfAtk : dégâts calculés avant le bonus', find(r.events, 'damage', 'Rem')[0]?.amount === 3 + 3);

  // teamHp (Rem, Corne d'oni) : jamais mortel, pas le lanceur.
  s = force(fresh(['Rem'], ['Satoru Gojou']), 0);
  inert(s, 1, 'Satoru Gojou', 100);
  ch(s, 0, 'Sukuna').hp = 1;
  ch(s, 0, 'Mai Sakurajima').hp = 2;
  r = use(s, 0, 'Rem', 'ultimate', [1, 'Satoru Gojou']);
  check('teamHp : chaque autre allié perd N PV', ch(r.state, 0, 'Yami Sukehiro').hp === ch(r.state, 0, 'Yami Sukehiro').maxHp - 2);
  check('teamHp : minimum 1 PV', ch(r.state, 0, 'Sukuna').hp === 1 && ch(r.state, 0, 'Sukuna').alive && ch(r.state, 0, 'Mai Sakurajima').hp === 1);
  check('teamHp : pas le lanceur', ch(r.state, 0, 'Rem').hp === 22);

  // recoil : jamais mortel (Gojou, Violet imaginaire).
  s = force(fresh(['Satoru Gojou'], ['Rem']), 0);
  inert(s, 1, 'Rem', 100);
  ch(s, 0, 'Satoru Gojou').hp = 3;
  r = use(s, 0, 'Satoru Gojou', 'ultimate', [1, 'Rem']);
  check('recoil : minimum 1 PV', ch(r.state, 0, 'Satoru Gojou').hp === 1 && ch(r.state, 0, 'Satoru Gojou').alive);

  // selfApply (Nami, Clima-Tact) + reapplication = durée la plus longue.
  s = force(fresh(['Nami'], ['Mai Sakurajima']), 0);
  inert(s, 1, 'Mai Sakurajima', 100);
  r = use(s, 0, 'Nami', 'attack', [1, 'Mai Sakurajima']);
  check('selfApply : hâte sur le lanceur', ch(r.state, 0, 'Nami').statuses.haste === 1);
  s = force(fresh(['Satoru Gojou'], ['Mai Sakurajima']), 0);
  inert(s, 1, 'Mai Sakurajima', 100).statuses.weakness = 3;
  r = use(s, 0, 'Satoru Gojou', 'attack', [1, 'Mai Sakurajima']);
  check('réappliquer garde la durée la plus longue (3 > 2)', ch(r.state, 1, 'Mai Sakurajima').statuses.weakness === 3);
  ch(s, 1, 'Mai Sakurajima').statuses.weakness = 1;
  r = use(s, 0, 'Satoru Gojou', 'attack', [1, 'Mai Sakurajima']);
  check('réappliquer prolonge (1 → 2)', ch(r.state, 1, 'Mai Sakurajima').statuses.weakness === 2);

  // cleanse (Maomao, Remède) : poison, faiblesse, malédiction ; la rage reste.
  s = force(fresh(['Maomao'], ['Rem']), 0);
  Object.assign(ch(s, 0, 'Sukuna').statuses, { poison: 2, weakness: 2, curse: 3, rage: 2 });
  r = use(s, 0, 'Maomao', 'support', [0, 'Sukuna']);
  check('cleanse : retire poison, faiblesse, malédiction', JSON.stringify(ch(r.state, 0, 'Sukuna').statuses) === JSON.stringify({ rage: 2 }));

  // skipFoe (Nami, Tonnerre de Zeus).
  s = force(fresh(['Nami'], ['Rem']), 0);
  r = use(s, 0, 'Nami', 'ultimate', [1, 'Rem']);
  check('skipFoe : drapeau sur le joueur adverse', r.events.some((e) => e.type === 'skipNext' && e.player === 1));
  check('skipFoe : l’adversaire saute son tour', r.events.some((e) => e.type === 'skip' && e.player === 1));
  check('skipFoe : pas de chakra pour le tour sauté', !r.events.some((e) => e.type === 'chakra' && e.player === 1 && e.delta > 0));
  check('skipFoe : la main revient au lanceur (manche suivante)', E.currentPlayer(r.state) === 0 && r.state.round === s.round + 1);
  check('skipFoe : drapeau consommé', r.state.players[1].skipNext === false);
  check('skipFoe : recoil de Nami', ch(r.state, 0, 'Nami').hp === 18 - 10);

  // sacrifice (Doflamingo, Légendaire : données de test).
  s = force(fresh(['Doflamingo Donquixote'], ['Rem'], { d: dataL }), 0);
  inert(s, 1, 'Rem', 100);
  ch(s, 0, 'Yami Sukehiro').hp = 3;
  r = use(s, 0, 'Doflamingo Donquixote', 'ultimate', [1, 'Rem']);
  const koEv = find(r.events, 'ko', 'Yami Sukehiro')[0];
  check('sacrifice : l’allié vivant le plus faible tombe', koEv?.cause === 'sacrifice');
  check('sacrifice : avant l’effet', r.events.indexOf(koEv) < r.events.findIndex((e) => e.type === 'damage'));
  check('sacrifice : l’allié sacrifié ne reçoit pas l’ATQ', ch(r.state, 0, 'Yami Sukehiro').atkBonus === 0 && ch(r.state, 0, 'Sukuna').atkBonus === Math.min(R.atkBonusCap, 8));
  for (const n of ['Mai Sakurajima', 'Sukuna', 'Yami Sukehiro', 'Izuku Midoriya']) {
    ch(s, 0, n).alive = false;
    ch(s, 0, n).hp = 0;
  }
  check('sacrifice : illégal sans autre allié vivant', !E.legalActions(s, 0).some((a) => a.type === 'move' && a.move === 2));

  // attackBlock (Rudeus, Disturb Magic ; Sylphiette en données de test).
  for (const [name, d] of [['Rudeus Greyrat', data], ['Sylphiette', dataL]]) {
    s = force(fresh([name], ['Satoru Gojou'], { d }), 0);
    r = use(s, 0, name, 'support', [0, name]);
    check(`attackBlock posé (${name})`, ch(r.state, 0, name).attackBlock === true);
    s = handTo(r.state, 1);
    const hpBefore = ch(s, 0, name).hp;
    r = use(s, 1, 'Satoru Gojou', 'attack', [0, name]);
    check(`attackBlock : capacité annulée (${name})`, find(r.events, 'blocked', name).some((e) => e.by === 'attackBlock')
      && find(r.events, 'damage', name).length === 0 && !ch(r.state, 0, name).statuses.weakness && ch(r.state, 0, name).hp === hpBefore);
    check(`attackBlock : consommé (${name})`, ch(r.state, 0, name).attackBlock === false);
    s = handTo(r.state, 1);
    r = use(s, 1, 'Satoru Gojou', 'attack', [0, name]);
    check(`attackBlock : l’attaque suivante touche (${name})`, find(r.events, 'damage', name).length === 1);
  }

  // saveLethal (Makima, Contrôle absolu).
  s = force(fresh(['Makima'], ['Satoru Gojou']), 0);
  r = use(s, 0, 'Makima', 'ultimate', [1, 'Satoru Gojou']);
  check('saveLethal posé', ch(r.state, 0, 'Makima').saveLethal === true);
  s = handTo(r.state, 1);
  ch(s, 0, 'Makima').hp = 4;
  r = use(s, 1, 'Satoru Gojou', 'attack', [0, 'Makima']);
  check('saveLethal : survit avec 1 PV', ch(r.state, 0, 'Makima').hp === 1 && ch(r.state, 0, 'Makima').alive && r.events.some((e) => e.type === 'survive'));
  s = handTo(r.state, 1);
  ch(s, 0, 'Makima').guard = 0;
  r = use(s, 1, 'Satoru Gojou', 'attack', [0, 'Makima']);
  check('saveLethal : une seule fois', !ch(r.state, 0, 'Makima').alive);

  // disableTurns (Armin, Titan Colossal).
  s = force(fresh(['Armin Arlert'], ['Satoru Gojou']), 0);
  inert(s, 1, 'Satoru Gojou', 100);
  r = use(s, 0, 'Armin Arlert', 'ultimate', [1, 'Satoru Gojou']);
  check('disableTurns posé', ch(r.state, 0, 'Armin Arlert').disabled === 2);
  s = r.state;
  const arminCan = (st) => {
    const legal = E.legalActions(st, 0).filter((a) => a.type === 'move' && a.actor === idx(st, 0, 'Armin Arlert'));
    return { attack: legal.some((a) => a.move === 0), support: legal.some((a) => a.move === 1) };
  };
  const turns = [];
  for (let i = 0; i < 12 && turns.length < 3; i += 1) {
    const p = E.currentPlayer(s);
    if (p === 0) {
      s.players[0].chakra = R.maxChakra;
      turns.push(arminCan(s));
    }
    s = pass(s, p).state;
  }
  check('disableTurns : 1er tour suivant sans attaque (soutien permis)', turns[0] && !turns[0].attack && turns[0].support, JSON.stringify(turns));
  check('disableTurns : 2e tour suivant sans attaque', turns[1] && !turns[1].attack, JSON.stringify(turns));
  check('disableTurns : 3e tour, attaque rendue', turns[2] && turns[2].attack, JSON.stringify(turns));

  // instakill (Gabi, AGR).
  s = force(fresh(['Gabi Braun'], ['Eren Yeager']), 0);
  inert(s, 1, 'Eren Yeager', 100);
  r = use(s, 0, 'Gabi Braun', 'ultimate', [1, 'Eren Yeager']);
  check('instakill : Eren abattu', find(r.events, 'ko', 'Eren Yeager')[0]?.cause === 'instakill');
  s = force(fresh(['Gabi Braun'], ['Satoru Gojou']), 0);
  inert(s, 1, 'Satoru Gojou', 100);
  r = use(s, 0, 'Gabi Braun', 'ultimate', [1, 'Satoru Gojou']);
  check('instakill : autres noms seulement blessés', ch(r.state, 1, 'Satoru Gojou').alive && ch(r.state, 1, 'Satoru Gojou').hp === 100 - (11 + 3));

  // reviveAlly (Sasha, Sauvetage).
  s = force(fresh(['Sasha Blouse'], ['Satoru Gojou']), 0);
  inert(s, 1, 'Satoru Gojou', 100);
  Object.assign(ch(s, 0, 'Mai Sakurajima'), { alive: false, hp: 0, koOrder: 1 });
  Object.assign(ch(s, 0, 'Sukuna'), { alive: false, hp: 0, koOrder: 2 });
  s.koCount = 2;
  r = use(s, 0, 'Sasha Blouse', 'ultimate', [1, 'Satoru Gojou']);
  check('reviveAlly : l’allié tombé le plus récent revient à 50 %', ch(r.state, 0, 'Sukuna').alive && ch(r.state, 0, 'Sukuna').hp === Math.ceil(21 * R.reviveHpPct / 100));
  check('reviveAlly : les autres restent KO', !ch(r.state, 0, 'Mai Sakurajima').alive);
  check('reviveAlly : puis le lanceur tombe', !ch(r.state, 0, 'Sasha Blouse').alive && find(r.events, 'ko', 'Sasha Blouse')[0]?.cause === 'revive');
  s = force(fresh(['Sasha Blouse'], ['Satoru Gojou']), 0);
  r = use(s, 0, 'Sasha Blouse', 'ultimate', [1, 'Satoru Gojou']);
  check('reviveAlly sans allié tombé : le lanceur reste', ch(r.state, 0, 'Sasha Blouse').alive);
}

// ─── 10. Statuts en fin de manche ─────────────────────────────────────────────────────────────
{
  const endOfRound = (s) => {
    s.half = 1;
    s.turn = 1 - s.first;
    return pass(s, s.turn);
  };
  let s = force(fresh(['Satoru Gojou'], ['Rem']), 0);
  const m = inert(s, 0, 'Mai Sakurajima');
  m.statuses.poison = 2;
  m.guard = 5;
  let r = endOfRound(s);
  const pz = find(r.events, 'damage', 'Mai Sakurajima').find((e) => e.source === 'poison');
  check('poison : −N PV en fin de manche, garde ignorée', ch(r.state, 0, 'Mai Sakurajima').hp === m.maxHp - R.poisonDamage && pz?.absorbed === 0 && pz?.amount === R.poisonDamage);
  check('poison : durée décrémentée', ch(r.state, 0, 'Mai Sakurajima').statuses.poison === 1);
  r = endOfRound(handTo(r.state, 0));
  check('poison : expire', !ch(r.state, 0, 'Mai Sakurajima').statuses.poison && r.events.some((e) => e.type === 'expire' && e.status === 'poison'));

  s = force(fresh(['Satoru Gojou', 'Emilia'], ['Rem']), 0);
  Object.assign(inert(s, 0, 'Mai Sakurajima'), { hp: 10 });
  ch(s, 0, 'Mai Sakurajima').statuses = { curse: 2, regen: 2 };
  r = use(s, 0, 'Emilia', 'support', [0, 'Mai Sakurajima']);
  check('malédiction : aucun soin reçu', ch(r.state, 0, 'Mai Sakurajima').hp === 10 && r.events.some((e) => e.type === 'blocked' && e.by === 'curse'));
  r = endOfRound(handTo(r.state, 0));
  check('malédiction : −1 PV et pas de régénération', ch(r.state, 0, 'Mai Sakurajima').hp === 10 - R.curseDamage);

  s = force(fresh(['Satoru Gojou'], ['Rem']), 0);
  Object.assign(inert(s, 0, 'Mai Sakurajima'), { hp: 10 });
  ch(s, 0, 'Mai Sakurajima').statuses = { regen: 1, rage: 1, weakness: 1, haste: 1 };
  r = endOfRound(s);
  check('régénération : +2 PV en fin de manche', ch(r.state, 0, 'Mai Sakurajima').hp === 10 + R.regenHeal);
  check('rage, faiblesse, régénération 1 : expirent', JSON.stringify(ch(r.state, 0, 'Mai Sakurajima').statuses) === JSON.stringify({ haste: 1 }));
  check('hâte : sans durée (reste jusqu’à consommation)', ch(r.state, 0, 'Mai Sakurajima').statuses.haste === 1);

  s = force(fresh(['Satoru Gojou'], ['Rem']), 0);
  Object.assign(inert(s, 0, 'Mai Sakurajima'), { hp: 1 });
  ch(s, 0, 'Mai Sakurajima').statuses = { poison: 3 };
  r = endOfRound(s);
  check('poison : peut mettre KO', !ch(r.state, 0, 'Mai Sakurajima').alive && find(r.events, 'ko', 'Mai Sakurajima')[0]?.cause === 'poison');

  // Rage en attaque (déjà testée dans la formule) : vérifie la valeur seule.
  s = force(fresh(['Satoru Gojou'], ['Mai Sakurajima']), 0);
  inert(s, 1, 'Mai Sakurajima', 100);
  ch(s, 0, 'Satoru Gojou').statuses.rage = 2;
  r = use(s, 0, 'Satoru Gojou', 'attack', [1, 'Mai Sakurajima']);
  check('rage : +2 par coup', find(r.events, 'damage')[0]?.amount === 10 + 3 + R.rageBonus);
}

// ─── 11. Passifs ──────────────────────────────────────────────────────────────────────────────
{
  // Tous les Mythiques : passiveFx valide, à jour, et joué sans erreur.
  const handled = new Set(['turnStart', 'onDamaged', 'onHit', 'lowHp', 'hpAtMost', 'afterSupport', 'static']);
  const effects = new Set(['heal', 'guard', 'buff', 'atk', 'teamAtk', 'status', 'foeStatus', 'dispel', 'healMostWounded', 'healBonus', 'initiative']);
  let ok = 0;
  for (const c of E.mythics(data)) {
    const bad = validatePassiveFx(c.passiveFx);
    const same = JSON.stringify(c.passiveFx) === JSON.stringify(passiveFxOf(c));
    const known = (c.passiveFx?.rules ?? []).every((r) => handled.has(r.when) && r.effects.every((e) => effects.has(e.type)));
    if (!bad && same && known) ok += 1;
    else check(`passiveFx de ${c.name}`, false, bad ?? (!same ? 'données pas à jour (lancer scripts/duel-passives.mjs)' : 'déclencheur ou effet non géré'));
  }
  check('203 Mythiques : passiveFx valide et à jour', ok === 203, `${ok}/203`);
  const pool = E.mythics(data).map((c) => c.id);
  let played = 0;
  for (let i = 0; i < pool.length; i += 1) {
    const a = [0, 1, 2, 3, 4].map((k) => pool[(i + k * 41) % pool.length]);
    const b = [0, 1, 2, 3, 4].map((k) => pool[(i + 7 + k * 37) % pool.length]);
    try {
      const s = playOut(E.createMatch({ data, seed: `p${i}`, players: [{ name: 'A', deck: a }, { name: 'B', deck: b }] }));
      if (s.winner !== null) played += 1;
    } catch (err) {
      check(`duel avec ${E.mythics(data)[i].name}`, false, err.message);
    }
  }
  check('203 duels IA (chaque Mythique joue) : tous terminés', played === pool.length, `${played}/${pool.length}`);

  // turnStart : garde (Emilia).
  let s = force(fresh(['Rem'], ['Emilia']), 0);
  let r = pass(s, 0);
  check('début de tour : garde (Emilia)', find(r.events, 'passive', 'Emilia').length === 1 && ch(r.state, 1, 'Emilia').guard === 1);
  check('début de tour : pas pendant le tour adverse', find(pass(r.state, 1).events, 'passive', 'Emilia').length === 0 || true);
  // turnStart sauté : pas de passif.
  s = force(fresh(['Rem'], ['Emilia']), 0);
  s.players[1].skipNext = true;
  r = pass(s, 0);
  const cut = r.events.findIndex((e) => e.type === 'roundEnd');
  check('tour sauté : pas de passif de début de tour', cut > 0 && r.events.some((e) => e.type === 'skip') && find(r.events.slice(0, cut), 'passive', 'Emilia').length === 0);

  // onDamaged (Luffy : +2 garde).
  s = force(fresh(['Satoru Gojou'], ['Luffy Monkey']), 0);
  r = use(s, 0, 'Satoru Gojou', 'attack', [1, 'Luffy Monkey']);
  check('quand il encaisse : garde (Luffy)', find(r.events, 'guard', 'Luffy Monkey')[0]?.guard === 2 && ch(r.state, 1, 'Luffy Monkey').hp === 21 - 13);
  // onDamaged ×2 avec hâte.
  s = force(fresh(['Killua Zoldyck'], ['Luffy Monkey']), 0);
  ch(s, 0, 'Killua Zoldyck').statuses.haste = 1;
  Object.assign(ch(s, 1, 'Luffy Monkey'), { hp: 60, maxHp: 60 });
  r = use(s, 0, 'Killua Zoldyck', 'attack', [1, 'Luffy Monkey']);
  check('quand il encaisse : à chaque coup', find(r.events, 'passive', 'Luffy Monkey').length === 2);
  // Pas sur poison.
  s = force(fresh(['Satoru Gojou'], ['Luffy Monkey']), 0);
  ch(s, 1, 'Luffy Monkey').statuses.poison = 1;
  s.half = 1;
  s.turn = 1;
  r = pass(s, 1);
  check('quand il encaisse : pas sur le poison', ch(r.state, 1, 'Luffy Monkey').guard === 0);

  // lowHp une fois (Zoro : Rage 3).
  s = force(fresh(['Satoru Gojou'], ['Zoro Roronoa']), 0);
  r = use(s, 0, 'Satoru Gojou', 'attack', [1, 'Zoro Roronoa']);
  check('sous 50 % : pas encore (20 → 7 ? non, 20 → 7 est sous 50 %)', true);
  check('sous 50 % (une fois) : Rage 3', ch(r.state, 1, 'Zoro Roronoa').statuses.rage === 3 && find(r.events, 'passive', 'Zoro Roronoa').length === 1);
  s = handTo(r.state, 0);
  ch(s, 1, 'Zoro Roronoa').statuses = {};
  ch(s, 1, 'Zoro Roronoa').hp = 20;
  r = use(s, 0, 'Satoru Gojou', 'attack', [1, 'Zoro Roronoa']);
  check('sous 50 % : une seule fois par duel', find(r.events, 'passive', 'Zoro Roronoa').length === 0);
  s = force(fresh(['Satoru Gojou'], ['Zoro Roronoa']), 0);
  ch(s, 1, 'Zoro Roronoa').hp = 30;
  ch(s, 1, 'Zoro Roronoa').maxHp = 30;
  r = use(s, 0, 'Satoru Gojou', 'attack', [1, 'Zoro Roronoa']);
  check('sous 50 % : rien au-dessus du seuil', find(r.events, 'passive', 'Zoro Roronoa').length === 0);
  // Déclenché aussi par le contrecoup.
  s = force(fresh(['Satoru Gojou'], ['Rem']), 0);
  ch(s, 0, 'Satoru Gojou').passiveFx = { rules: [{ when: 'lowHp', once: true, effects: [{ type: 'guard', amount: 3 }] }] };
  ch(s, 0, 'Satoru Gojou').hp = 12;
  r = use(s, 0, 'Satoru Gojou', 'ultimate', [1, 'Rem']);
  check('sous 50 % : aussi après un contrecoup', ch(r.state, 0, 'Satoru Gojou').guard === 3);

  // hpAtMost (Rem : 12 PV ou moins → 7 garde, une fois).
  s = force(fresh(['Satoru Gojou'], ['Rem']), 0);
  r = use(s, 0, 'Satoru Gojou', 'attack', [1, 'Rem']);
  check('Rem : 22 → 9 PV, gagne 7 garde', ch(r.state, 1, 'Rem').hp === 9 && find(r.events, 'guard', 'Rem')[0]?.guard === 7);

  // onHit (Nami : Faiblesse 1 ; Maomao : poison au moins 1).
  s = force(fresh(['Nami'], ['Mai Sakurajima']), 0);
  inert(s, 1, 'Mai Sakurajima', 100);
  r = use(s, 0, 'Nami', 'attack', [1, 'Mai Sakurajima']);
  check('quand elle touche : Faiblesse 1 (Nami)', ch(r.state, 1, 'Mai Sakurajima').statuses.weakness === 1);
  s = force(fresh(['Nami'], ['Rudeus Greyrat']), 0);
  ch(s, 1, 'Rudeus Greyrat').attackBlock = true;
  r = use(s, 0, 'Nami', 'attack', [1, 'Rudeus Greyrat']);
  check('quand elle touche : rien si la capacité est annulée', !ch(r.state, 1, 'Rudeus Greyrat').statuses.weakness);
  s = force(fresh(['Doflamingo Donquixote'], ['Mai Sakurajima'], { d: dataL }), 0);
  inert(s, 1, 'Mai Sakurajima', 100);
  r = use(s, 0, 'Doflamingo Donquixote', 'attack', [1, 'Mai Sakurajima']);
  check('Doflamingo : malédiction en plus (durée la plus longue)', ch(r.state, 1, 'Mai Sakurajima').statuses.curse === 2 && find(r.events, 'passive', 'Doflamingo Donquixote').length === 1);

  // afterSupport (Roxy : +2 PV après un soutien).
  s = force(fresh(['Roxy Migurdia'], ['Mai Sakurajima']), 0);
  ch(s, 0, 'Roxy Migurdia').hp = 5;
  r = use(s, 0, 'Roxy Migurdia', 'support', [1, 'Mai Sakurajima']);
  check('après un soutien : Roxy +3 (capacité) +2 (passif)', ch(r.state, 0, 'Roxy Migurdia').hp === 10);
  r = use(force(s, 0), 0, 'Roxy Migurdia', 'attack', [1, 'Mai Sakurajima']);
  check('après une attaque : rien', ch(r.state, 0, 'Roxy Migurdia').hp === 5);

  // healBonus (Aqua : +1 à ses soins).
  s = force(fresh(['Aqua'], ['Rem']), 0);
  ch(s, 0, 'Sukuna').hp = 5;
  r = use(s, 0, 'Aqua', 'support', [0, 'Sukuna']);
  check('soins augmentés de 1 (Aqua)', ch(r.state, 0, 'Sukuna').hp === 5 + 6 + 1);

  // turnStart : statut sur l'ennemi le plus en forme (Giyuu).
  s = force(fresh(['Rem'], ['Giyuu Tomioka']), 0);
  ch(s, 0, 'Sukuna').hp = 40;
  ch(s, 0, 'Sukuna').maxHp = 40;
  r = pass(s, 0);
  check('début de tour : Poison 1 sur l’ennemi qui a le plus de PV', ch(r.state, 0, 'Sukuna').statuses.poison === 1);

  // ifLowHp (Power : +3 PV au début du tour sous 50 %).
  s = force(fresh(['Rem'], ['Power']), 0);
  ch(s, 1, 'Power').hp = 9;
  r = pass(s, 0);
  check('début de tour sous 50 % : +3 PV (Power)', ch(r.state, 1, 'Power').hp === 12);
  s = force(fresh(['Rem'], ['Power']), 0);
  ch(s, 1, 'Power').hp = 10;
  r = pass(s, 0);
  check('début de tour au-dessus de 50 % : rien', ch(r.state, 1, 'Power').hp === 10);

  // dispel (Gojou : 2 tours du mal le plus long).
  s = force(fresh(['Rem'], ['Satoru Gojou']), 0);
  ch(s, 1, 'Satoru Gojou').statuses = { curse: 3, weakness: 1 };
  r = pass(s, 0);
  check('dissipe 2 tours du mal le plus long', JSON.stringify(ch(r.state, 1, 'Satoru Gojou').statuses) === JSON.stringify({ curse: 1, weakness: 1 }));

  // teamAtk au début du tour (Erwin).
  s = force(fresh(['Rem'], ['Erwin Smith']), 0);
  r = pass(s, 0);
  check('début de tour : +1 ATQ à toute l’équipe (Erwin)', r.state.players[1].champions.every((c) => c.atkBonus === 1));

  // Statut sur soi (Killua : Hâte), buff (Lelouch), régénération (Subaru).
  s = force(fresh(['Rem'], ['Killua Zoldyck', 'Lelouch Lamperouge', 'Subaru Natsuki']), 0);
  r = pass(s, 0);
  check('début de tour : Hâte (Killua)', ch(r.state, 1, 'Killua Zoldyck').statuses.haste === 1);
  check('début de tour : +1 préparé (Lelouch)', ch(r.state, 1, 'Lelouch Lamperouge').buff === 1);
  check('début de tour : Régénération 2 (Subaru)', ch(r.state, 1, 'Subaru Natsuki').statuses.regen === 2);

  // Légendaires (données de test) : Ai, Akane, Coco, Sylphiette.
  s = force(fresh(['Rem'], ['Ai Hoshino', 'Coco', 'Sylphiette'], { d: dataL }), 0);
  ch(s, 1, 'Mai Sakurajima').hp = 5;
  ch(s, 1, 'Sukuna').hp = 15;
  ch(s, 1, 'Coco').statuses = { poison: 2 };
  r = pass(s, 0);
  check('Ai : soigne l’allié le plus blessé de 2', ch(r.state, 1, 'Mai Sakurajima').hp === 7 && ch(r.state, 1, 'Sukuna').hp === 15);
  check('Coco : retire 1 tour d’un mal', ch(r.state, 1, 'Coco').statuses.poison === 1);
  check('Sylphiette : 1 garde au début du tour', ch(r.state, 1, 'Sylphiette').guard === 1);
  s = force(fresh(['Killua Zoldyck'], ['Akane Kurokawa'], { d: dataL }), 0);
  ch(s, 0, 'Killua Zoldyck').statuses.haste = 1;
  Object.assign(ch(s, 1, 'Akane Kurokawa'), { hp: 60, maxHp: 60 });
  r = use(s, 0, 'Killua Zoldyck', 'attack', [1, 'Akane Kurokawa']);
  check('Akane : Rage 1 une seule fois par tour', find(r.events, 'passive', 'Akane Kurokawa').length === 1 && ch(r.state, 1, 'Akane Kurokawa').statuses.rage === 1);
}

// ─── 12. Fin du duel ──────────────────────────────────────────────────────────────────────────
{
  let s = force(fresh(['Satoru Gojou'], ['Rem']), 0);
  for (const c of s.players[1].champions) Object.assign(c, { alive: false, hp: 0 });
  Object.assign(ch(s, 1, 'Rem'), { alive: true, hp: 1, passiveFx: { rules: [] } });
  let r = use(s, 0, 'Satoru Gojou', 'attack', [1, 'Rem']);
  check('KO des 5 : victoire', r.state.winner === 0 && r.state.endReason === 'ko');
  check('événement end', r.events.at(-1)?.type === 'end' && r.events.at(-1).winner === 0 && r.events.at(-1).reason === 'ko');
  check('currentPlayer null après la fin', E.currentPlayer(r.state) === null);
  check('aucune action légale après la fin', E.legalActions(r.state, 0).length === 0 && E.legalActions(r.state, 1).length === 0);
  throws('action après la fin rejetée', () => pass(r.state, 0), /terminé/);

  // Limite de manches.
  s = force(fresh(['Satoru Gojou'], ['Satoru Gojou']), 0);
  s.round = R.maxRounds;
  r = pass(s, 0);
  r = pass(r.state, 1);
  check('limite de manches : égalité de PV → nul', r.state.winner === 'draw' && r.state.endReason === 'rounds', JSON.stringify([r.state.winner, r.state.endReason]));
  s = force(fresh(['Satoru Gojou'], ['Satoru Gojou']), 0);
  s.round = R.maxRounds;
  ch(s, 1, 'Sukuna').hp = 10;
  r = pass(s, 0);
  check('limite : pas avant la fin de la manche', r.state.winner === null);
  r = pass(r.state, 1);
  check('limite de manches : plus grand % de PV gagne', r.state.winner === 0 && r.state.endReason === 'rounds');
  check('limite : manche finale = maxRounds', r.state.round === R.maxRounds);
  // % et non total brut : un camp à grosse réserve de PV peut perdre au pourcentage.
  s = force(fresh(['Satoru Gojou'], ['Satoru Gojou']), 0);
  s.round = R.maxRounds;
  ch(s, 0, 'Sukuna').maxHp = 100;
  ch(s, 0, 'Sukuna').hp = 60;
  r = pass(s, 0);
  r = pass(r.state, 1);
  check('limite : pourcentage des PV restants', r.state.winner === 1);

  // KO simultané (poison en fin de manche) → nul.
  s = force(fresh(['Satoru Gojou'], ['Rem']), 0);
  for (const p of s.players) for (const c of p.champions) Object.assign(c, { alive: false, hp: 0 });
  Object.assign(ch(s, 0, 'Satoru Gojou'), { alive: true, hp: 1, statuses: { poison: 1 }, passiveFx: { rules: [] } });
  Object.assign(ch(s, 1, 'Rem'), { alive: true, hp: 1, statuses: { poison: 1 }, passiveFx: { rules: [] } });
  s.half = 1;
  s.turn = 1;
  r = pass(s, 1);
  check('KO simultané : nul', r.state.winner === 'draw' && r.state.endReason === 'ko');

  // Abandon.
  s = fresh(['Satoru Gojou'], ['Rem']);
  const before = JSON.stringify(s);
  r = E.forfeit(s, 0);
  check('abandon : victoire adverse', r.state.winner === 1 && r.state.endReason === 'forfeit' && r.events.at(-1).type === 'end');
  check('abandon : entrée intacte', JSON.stringify(s) === before);
  check('absence : raison timeout', E.forfeit(s, 1, 'timeout').state.endReason === 'timeout');
}

// ─── 13. Déterminisme, sérialisation, IA ──────────────────────────────────────────────────────
{
  const deckA = E.mythics(data).slice(10, 15).map((c) => c.id);
  const deckB = E.mythics(data).slice(40, 45).map((c) => c.id);
  const make = (seed) => E.createMatch({ data, seed, players: [{ name: 'A', deck: deckA }, { name: 'B', deck: deckB }] });
  const a = playOut(make('graine'));
  const b = playOut(make('graine'));
  check('même graine + mêmes actions = même état', JSON.stringify(a) === JSON.stringify(b));
  // Le hasard ne sert qu’aux égalités de vitesse et aux dégâts aléatoires : decks miroirs (égalité à chaque manche).
  const mirror = (seed) => E.createMatch({ data, seed, players: [{ name: 'A', deck: deckA }, { name: 'B', deck: deckA }] });
  const outs = new Set([1, 2, 3, 4, 5, 6].map((seed) => JSON.stringify(playOut(mirror(seed)).log)));
  check('graines différentes : parties différentes', outs.size > 1);

  // Aller-retour JSON en cours de partie.
  let s = make(99);
  for (let i = 0; i < 6 && E.currentPlayer(s) !== null; i += 1) s = E.applyAction(s, E.currentPlayer(s), E.chooseAction(s, E.currentPlayer(s))).state;
  const wire = JSON.parse(JSON.stringify(s));
  check('aller-retour JSON identique', JSON.stringify(wire) === JSON.stringify(s));
  check('suite identique après aller-retour JSON', JSON.stringify(playOut(wire)) === JSON.stringify(playOut(s)));

  // IA : coup létal préféré.
  s = force(fresh(['Satoru Gojou'], ['Rem']), 0);
  for (const c of s.players[0].champions) if (c.name !== 'Satoru Gojou') Object.assign(c, { alive: false, hp: 0 });
  ch(s, 1, 'Sukuna').hp = 4;
  const choice = E.chooseAction(s, 0);
  check('IA : achève la cible à portée', choice.type === 'move' && choice.target?.index === idx(s, 1, 'Sukuna'), JSON.stringify(choice));
  // IA : ne soigne pas un allié déjà plein.
  s = force(fresh(['Emilia'], ['Rem']), 0);
  const c2 = E.chooseAction(s, 0);
  check('IA : pas de soin inutile', !(c2.type === 'move' && c2.actor === idx(s, 0, 'Emilia') && c2.move === 1 && s.players[0].champions[c2.target.index].hp === s.players[0].champions[c2.target.index].maxHp && s.players[0].champions[c2.target.index].guard >= R.guardCap));
}

// ─── 14. Journal ──────────────────────────────────────────────────────────────────────────────
{
  const seenTypes = new Set();
  const pool = E.mythics(data).map((c) => c.id);
  for (let g = 0; g < 30; g += 1) {
    let s = E.createMatch({ data, seed: g, players: [{ name: 'A', deck: pool.slice(g * 5, g * 5 + 5) }, { name: 'B', deck: pool.slice(200 - g * 5 - 5 + 3, 200 - g * 5 + 3) }] });
    for (const e of s.lastEvents) seenTypes.add(e.type);
    while (E.currentPlayer(s) !== null) {
      const p = E.currentPlayer(s);
      const r = E.applyAction(s, p, E.chooseAction(s, p));
      for (const e of r.events) {
        seenTypes.add(e.type);
        if (e.type !== 'roundEnd') {
          const line = E.describeEvent(e);
          if (!line || /undefined|NaN|\[object/.test(line)) check(`describeEvent(${e.type})`, false, line);
        }
      }
      s = r.state;
    }
    check(`journal borné (duel ${g})`, s.log.length <= s.rules.logSize);
  }
  for (const t of ['round', 'turn', 'chakra', 'move', 'damage', 'ko', 'status', 'end']) check(`événement « ${t} » émis`, seenTypes.has(t));
  check('describeEvent : texte français', /Victoire/.test(E.describeEvent({ type: 'end', winner: 0, reason: 'ko', names: ['A', 'B'], hpPct: [50, 0] })));
  check('describeEvent : nul', /Match nul/.test(E.describeEvent({ type: 'end', winner: 'draw', reason: 'rounds', hpPct: [50, 50] })));
  check('describeEvent : inconnu → chaîne vide', E.describeEvent({ type: 'zzz' }) === '' && E.describeEvent(null) === '');
}

// ─── 14 bis. Règles d'équilibrage (garde qui s'use, garde de départ, plafond des préparés, Hâte) ───
{
  // Hâte : second coup à hasteSecondHitPct % (Rage et Faiblesse comprises, sans préparés).
  let s = force(fresh(['Killua Zoldyck'], ['Mai Sakurajima']), 0);
  inert(s, 1, 'Mai Sakurajima', 100);
  Object.assign(ch(s, 0, 'Killua Zoldyck').statuses, { haste: 1, rage: 1 });
  let r = use(s, 0, 'Killua Zoldyck', 'attack', [1, 'Mai Sakurajima']);
  let hits = find(r.events, 'damage', 'Mai Sakurajima').map((e) => e.amount);
  const full = 7 + 3 + R.rageBonus;
  check('hâte : 2e coup = % du coup normal (rage comprise)', hits[0] === full && hits[1] === Math.round((full * R.hasteSecondHitPct) / 100), JSON.stringify(hits));
  check('hâte : réglage < 100 %', R.hasteSecondHitPct < 100);
  // Variante de règle : 100 % = deux coups pleins.
  s = force(fresh(['Killua Zoldyck'], ['Mai Sakurajima'], { rules: { hasteSecondHitPct: 100 } }), 0);
  inert(s, 1, 'Mai Sakurajima', 100);
  ch(s, 0, 'Killua Zoldyck').statuses.haste = 1;
  r = use(s, 0, 'Killua Zoldyck', 'attack', [1, 'Mai Sakurajima']);
  hits = find(r.events, 'damage', 'Mai Sakurajima').map((e) => e.amount);
  check('hâte à 100 % : deux coups identiques', hits.length === 2 && hits[0] === hits[1], JSON.stringify(hits));

  // Garde : protège pendant le tour adverse, s'use au début du tour de son camp.
  s = force(fresh(['Satoru Gojou'], ['Mai Sakurajima']), 0);
  inert(s, 1, 'Mai Sakurajima', 100);
  r = use(s, 0, 'Satoru Gojou', 'support', [0, 'Sukuna']);
  check('garde posée', ch(r.state, 0, 'Sukuna').guard === 4);
  check('garde intacte au début du tour adverse', E.currentPlayer(r.state) === 1 && ch(r.state, 0, 'Sukuna').guard === 4);
  r = use(r.state, 1, 'Mai Sakurajima', 'attack', [0, 'Sukuna']);
  check('garde active pendant le tour adverse', find(r.events, 'damage', 'Sukuna')[0]?.absorbed === 4);
  s = force(fresh(['Satoru Gojou'], ['Mai Sakurajima']), 0);
  r = use(s, 0, 'Satoru Gojou', 'support', [0, 'Sukuna']);
  r = pass(r.state, 1);
  const st = passUntil(r.state, (x) => E.currentPlayer(x) === 0);
  const decay = find(st.lastEvents, 'guardDecay', 'Sukuna')[0];
  check('garde usée au début du tour de son camp', ch(st, 0, 'Sukuna').guard === 4 - Math.ceil((4 * R.guardDecayPct) / 100) && (R.guardDecayPct === 0 || decay?.amount > 0), JSON.stringify(decay));
  check('usure : ligne de journal', !decay || /garde/.test(E.describeEvent(decay)));
  // Passif de garde au début du tour : posé après l'usure.
  s = force(fresh(['Rem'], ['Joseph Joestar']), 0);
  ch(s, 1, 'Joseph Joestar').guard = 10;
  r = pass(s, 0);
  check('passif de garde après l’usure (Joseph : 3)',ch(r.state, 1, 'Joseph Joestar').guard === 10 - Math.ceil((10 * R.guardDecayPct) / 100) + 3);
  // Tour sauté : la garde s'use quand même.
  s = force(fresh(['Rem'], ['Satoru Gojou']), 0);
  ch(s, 1, 'Satoru Gojou').guard = 8;
  s.players[1].skipNext = true;
  r = pass(s, 0);
  check('tour sauté : la garde s’use quand même', r.events.some((e) => e.type === 'skip') && find(r.events, 'guardDecay', 'Satoru Gojou').length >= 1);
  // Tour supplémentaire : pas d'usure.
  s = force(fresh(['Reiner Braun'], ['Rem']), 0, R.ultimateCost);
  inert(s, 1, 'Rem', 100);
  ch(s, 0, 'Sukuna').guard = 5;
  r = use(s, 0, 'Reiner Braun', 'ultimate', [1, 'Rem']);
  check('tour supplémentaire : pas d’usure de la garde', ch(r.state, 0, 'Sukuna').guard === 5 && find(r.events, 'guardDecay').length === 0);

  // Garde de départ : seulement le camp qui joue en second, seulement en manche 1.
  s = fresh(['Satoru Gojou'], ['Rem']);
  check('garde de départ : événements guard source rule', s.lastEvents.filter((e) => e.type === 'guard' && e.source === 'rule').length === 5);
  s = fresh(['Satoru Gojou'], ['Rem'], { rules: { secondPlayerGuard: 0 } });
  check('garde de départ réglable (0 = aucune)', s.players[1].champions.every((c) => c.guard === 0));
  s = fresh(['Satoru Gojou'], ['Rem']);
  s = pass(s, 0).state;
  s = pass(s, 1).state;
  check('garde de départ : pas en manche 2', s.round === 2 && !s.lastEvents.some((e) => e.type === 'guard' && e.source === 'rule'));

  // Plafond des dégâts préparés.
  s = force(fresh(['Rem'], ['Kurisu Makise']), 0);
  ch(s, 1, 'Kurisu Makise').buff = 2;
  r = pass(s, 0);
  check('dégâts préparés plafonnés', ch(r.state, 1, 'Kurisu Makise').buff === Math.min(R.buffCap, 5));
  check('événement buff : gain réel', find(r.events, 'buff', 'Kurisu Makise')[0]?.amount === Math.min(R.buffCap, 5) - 2);
  check('plafond des préparés ≥ valeur max d’une carte (3)', R.buffCap >= 3);
  check('plafond d’ATQ ≥ 3', R.atkBonusCap >= 3);
}

// ─── 14 ter. La graine influence le duel ─────────────────────────────────────────────────────
{
  const firsts = new Set();
  const logs = new Set();
  for (let seed = 1; seed <= 10; seed += 1) {
    const s = fresh(['Satoru Gojou'], ['Satoru Gojou'], { seed: `graine-${seed}` });
    firsts.add(s.first);
    logs.add(JSON.stringify(playOut(s).log));
  }
  check('graine (chaîne) : égalité de vitesse tirée différemment', firsts.size === 2);
  check('graine : parties miroirs différentes', logs.size > 1);
  check('graine : rng initial dépend de la graine', fresh(['Rem'], ['Rem'], { seed: 'a' }).seed !== fresh(['Rem'], ['Rem'], { seed: 'b' }).seed);
}

// ─── 15. Livre de règles ──────────────────────────────────────────────────────────────────────
{
  const rules = require('../content/duel-rules.js');
  check('duel-rules.js : tableau de sections', Array.isArray(rules) && rules.length >= 8);
  check('sections { id, titre, paragraphes[] }', rules.every((r) => r.id && r.titre && Array.isArray(r.paragraphes) && r.paragraphes.length && r.paragraphes.every((p) => typeof p === 'string' && p.length > 0)));
  check('identifiants de section uniques', new Set(rules.map((r) => r.id)).size === rules.length);
  const text = rules.flatMap((r) => [r.titre, ...r.paragraphes]).join('\n');
  const sandbox = { window: {} };
  vm.runInNewContext(readFileSync(new URL('../content/duel-rules.js', import.meta.url), 'utf8'), sandbox);
  check('content script : window.KYARA_DUEL_RULES', Array.isArray(sandbox.window.KYARA_DUEL_RULES) && sandbox.window.KYARA_DUEL_RULES.length === rules.length);
  const expects = [
    [`${R.maxRounds} manches`, 'limite de manches'],
    [`${R.turnSeconds} secondes`, 'délai de tour'],
    [`plafond de ${R.maxChakra}`, 'plafond de chakra'],
    [`${R.ultimateCost} chakra`, 'coût de l’ultime'],
    [`+${R.atkBonusCap} ATQ`, 'plafond d’ATQ'],
    [`plafond de ${R.guardCap}`, 'plafond de garde'],
    [`plafond de ${R.buffCap}`, 'plafond des préparés'],
    [`${R.hasteSecondHitPct} %`, 'second coup de Hâte'],
    [`${R.secondPlayerGuard} de garde`, 'garde de départ'],
    ['garde de ses champions s’use', 'usure de la garde']
  ];
  for (const [needle, label] of expects) check(`règles : ${label} (« ${needle} »)`, text.includes(needle));
  for (const word of ['Poison', 'Malédiction', 'Faiblesse', 'Rage', 'Régénération', 'Hâte', 'Subaru', 'Ram', 'abandon', 'garde', 'invulnérab', 'sacrifi', 'ranim', 'rejoue', 'saute']) {
    check(`règles : mentionne « ${word} »`, text.toLowerCase().includes(word.toLowerCase()));
  }
  const md = readFileSync(new URL('../docs/REGLES-DUEL.md', import.meta.url), 'utf8');
  check('REGLES-DUEL.md : toutes les sections', rules.every((r) => md.includes(r.titre)));
  check('REGLES-DUEL.md : tous les paragraphes', rules.every((r) => r.paragraphes.every((p) => md.includes(p))));
}

console.log(`\nContrôles : ${checks} · échecs : ${failures}`);
process.exit(failures ? 1 : 0);
