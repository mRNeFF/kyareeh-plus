// Simulation IA contre IA du duel (content/duel-engine.js) avec des decks aléatoires de Mythiques.
//   node test/sim-duel.mjs [N=2000] [--seed=1] [--rule=nom=valeur …]
// Rapporte : durée moyenne (manches), taux de victoire du premier joueur, nuls, duels arrivés à la
// limite de manches, et champions sur/sous-performants (taux de victoire de leur camp).
// Entièrement déterministe : même N et même graine → mêmes chiffres.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const E = require('../content/duel-engine.js');
const src = readFileSync(new URL('../content/duel-data.js', import.meta.url), 'utf8');
const data = JSON.parse(src.slice(src.indexOf('{'), src.lastIndexOf('}') + 1));

const args = process.argv.slice(2);
const N = Number(args.find((a) => /^\d+$/.test(a)) ?? 2000);
const baseSeed = Number(args.find((a) => a.startsWith('--seed='))?.slice(7) ?? 1);
const rules = {};
for (const a of args.filter((x) => x.startsWith('--rule='))) {
  const [k, v] = a.slice(7).split('=');
  if (!(k in E.RULES)) throw new Error(`Règle inconnue : ${k}`);
  rules[k] = Number(v);
}

// PRNG du simulateur (indépendant de celui des duels).
let simRng = baseSeed >>> 0;
function rnd() {
  let t = (simRng = (simRng + 0x6D2B79F5) >>> 0);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const pool = E.mythics(data).map((c) => c.id);
function deck() {
  const ids = pool.slice();
  for (let i = ids.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rnd() * (i + 1));
    [ids[i], ids[j]] = [ids[j], ids[i]];
  }
  return ids.slice(0, 5);
}

const stats = { rounds: 0, firstWins: 0, draws: 0, limit: 0, decided: 0, actions: 0, reasons: {} };
const byChamp = new Map();
const roundHist = new Map();
const t0 = process.hrtime.bigint();

for (let g = 0; g < N; g += 1) {
  const decks = [deck(), deck()];
  let s = E.createMatch({ data, seed: `sim-${baseSeed}-${g}`, rules, players: [{ name: 'IA 1', deck: decks[0] }, { name: 'IA 2', deck: decks[1] }] });
  const first = s.first;
  let guard = 0;
  while (E.currentPlayer(s) !== null) {
    const p = E.currentPlayer(s);
    s = E.applyAction(s, p, E.chooseAction(s, p)).state;
    stats.actions += 1;
    if ((guard += 1) > 2000) throw new Error(`Duel ${g} sans fin`);
  }
  stats.rounds += s.round;
  roundHist.set(s.round, (roundHist.get(s.round) ?? 0) + 1);
  stats.reasons[s.endReason] = (stats.reasons[s.endReason] ?? 0) + 1;
  if (s.endReason === 'rounds') stats.limit += 1;
  if (s.winner === 'draw') stats.draws += 1;
  else {
    stats.decided += 1;
    if (s.winner === first) stats.firstWins += 1;
  }
  decks.forEach((d, side) => {
    for (const id of d) {
      const e = byChamp.get(id) ?? { games: 0, wins: 0 };
      e.games += 1;
      if (s.winner === side) e.wins += 1;
      else if (s.winner === 'draw') e.wins += 0.5;
      byChamp.set(id, e);
    }
  });
}

const ms = Number(process.hrtime.bigint() - t0) / 1e6;
const names = new Map(E.mythics(data).map((c) => [c.id, c.name]));
const pct = (a, b) => (b ? ((100 * a) / b).toFixed(1) : '—');
const ranked = [...byChamp.entries()].filter(([, e]) => e.games >= 10)
  .map(([id, e]) => ({ name: names.get(id), games: e.games, rate: e.wins / e.games }))
  .sort((a, b) => b.rate - a.rate);

console.log(`Duels simulés : ${N} (graine ${baseSeed}${Object.keys(rules).length ? `, règles ${JSON.stringify(rules)}` : ''}) en ${(ms / 1000).toFixed(1)} s`);
console.log(`Manches en moyenne : ${(stats.rounds / N).toFixed(2)} · actions par duel : ${(stats.actions / N).toFixed(1)}`);
const hist = [...roundHist.entries()].sort((a, b) => a[0] - b[0]).map(([r, n]) => `${r}:${n}`).join(' ');
console.log(`Répartition des manches : ${hist}`);
console.log(`Victoires du premier joueur : ${pct(stats.firstWins, stats.decided)} % (sur ${stats.decided} duels décidés)`);
console.log(`Nuls : ${stats.draws} (${pct(stats.draws, N)} %) · limite de ${E.RULES.maxRounds} manches atteinte : ${stats.limit} (${pct(stats.limit, N)} %)`);
console.log(`Fins : ${JSON.stringify(stats.reasons)}`);
console.log(`Champions les plus performants (≥ 10 duels) :`);
for (const r of ranked.slice(0, 10)) console.log(`  ${(r.rate * 100).toFixed(1).padStart(5)} %  ${r.name} (${r.games})`);
console.log(`Champions les moins performants :`);
for (const r of ranked.slice(-10).reverse()) console.log(`  ${(r.rate * 100).toFixed(1).padStart(5)} %  ${r.name} (${r.games})`);
