// Simulation IA contre IA du duel v2 (content/duel-engine.js) avec des decks aléatoires de Mythiques.
//   node test/sim-duel.mjs [N=2000] [--seed=1] [--workers=8] [--rule=nom=valeur …] [--all] [--json]
// Rapporte : durée moyenne (tours), victoires du camp 0 (aucun avantage attendu : 45–55 %), nuls,
// duels arrivés à la limite de tours, part des changements dans les actions (choix « changer »
// sur toutes les actions de tour, remplacements forcés exclus), taux de victoire par type,
// champions sur/sous-performants (taux de victoire de leur camp) et liste de ceux hors de
// la plage 30–70 %. Rapporte aussi la corrélation vitesse / taux de victoire par Mythique (0 = la vitesse ne décide pas).
// Déterministe : même N et même graine → mêmes chiffres, quel que soit le nombre de workers
// (le deck et la graine d'un duel ne dépendent que de la graine de base et de son numéro).
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { cpus } from 'node:os';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const E = require('../content/duel-engine.js');
const src = readFileSync(new URL('../content/duel-data.js', import.meta.url), 'utf8');
const data = JSON.parse(src.slice(src.indexOf('{'), src.lastIndexOf('}') + 1));
const pool = E.mythics(data);
const ids = pool.map((c) => c.id);
const typeById = new Map(pool.map((c) => [c.id, E.typeOf(c)]));
const speedById = new Map(pool.map((c) => [c.id, Number(c.speed) || 0]));

function mulberry(seed) {
  let a = seed >>> 0;
  return () => {
    let t = (a = (a + 0x6D2B79F5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function deckFrom(rnd) {
  const a = ids.slice();
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, 5);
}

function playRange(from, to, baseSeed, rules) {
  const acc = { games: 0, turns: 0, wins0: 0, draws: 0, decided: 0, limit: 0, choose: 0, switches: 0, replaces: 0, reasons: {}, hist: {}, byChamp: {}, byType: {}, lead: {} };
  for (let g = from; g < to; g += 1) {
    const rnd = mulberry((baseSeed * 1000003 + g * 7919 + 17) >>> 0);
    const decks = [deckFrom(rnd), deckFrom(rnd)];
    let s = E.createMatch({ data, seed: `sim-${baseSeed}-${g}`, rules, players: [{ name: 'IA 1', deck: decks[0] }, { name: 'IA 2', deck: decks[1] }] });
    let guard = 0;
    while (s.phase !== 'ended') {
      const pend = E.pendingPlayers(s);
      if (!pend.length) throw new Error(`Duel ${g} bloqué (phase ${s.phase})`);
      const forced = s.phase === 'replace';
      let next = s;
      for (const p of pend) {
        const a = E.chooseAction(s, p);
        if (forced) acc.replaces += 1;
        else {
          acc.choose += 1;
          if (a.type === 'switch') acc.switches += 1;
        }
        next = E.submit(next, p, a).state;
      }
      s = next;
      if ((guard += 1) > 4000) throw new Error(`Duel ${g} sans fin`);
    }
    acc.games += 1;
    acc.turns += s.turn;
    acc.hist[s.turn] = (acc.hist[s.turn] ?? 0) + 1;
    acc.reasons[s.endReason] = (acc.reasons[s.endReason] ?? 0) + 1;
    if (s.endReason === 'rounds') acc.limit += 1;
    if (s.winner === 'draw') acc.draws += 1;
    else {
      acc.decided += 1;
      if (s.winner === 0) acc.wins0 += 1;
    }
    decks.forEach((d, side) => {
      const w = s.winner === side ? 1 : s.winner === 'draw' ? 0.5 : 0;
      d.forEach((id, slot) => {
        const e = (acc.byChamp[id] ??= { games: 0, wins: 0 });
        e.games += 1;
        e.wins += w;
        const t = typeById.get(id) || '?';
        const et = (acc.byType[t] ??= { games: 0, wins: 0 });
        et.games += 1;
        et.wins += w;
        if (slot === 0) {
          const el = (acc.lead[t] ??= { games: 0, wins: 0 });
          el.games += 1;
          el.wins += w;
        }
      });
    });
  }
  return acc;
}

function merge(list) {
  const out = {};
  const add = (dst, srcObj) => {
    for (const [k, v] of Object.entries(srcObj)) {
      if (typeof v === 'number') dst[k] = (dst[k] ?? 0) + v;
      else add((dst[k] ??= {}), v);
    }
  };
  for (const a of list) add(out, a);
  return out;
}

if (!isMainThread) {
  const { from, to, baseSeed, rules } = workerData;
  parentPort.postMessage(playRange(from, to, baseSeed, rules));
} else {
  const args = process.argv.slice(2);
  const N = Number(args.find((a) => /^\d+$/.test(a)) ?? 2000);
  const baseSeed = Number(args.find((a) => a.startsWith('--seed='))?.slice(7) ?? 1);
  const workers = Math.max(1, Math.min(Number(args.find((a) => a.startsWith('--workers='))?.slice(10) ?? Math.min(12, cpus().length)), N));
  const rules = {};
  for (const a of args.filter((x) => x.startsWith('--rule='))) {
    const [k, v] = a.slice(7).split('=');
    if (!(k in E.RULES)) throw new Error(`Règle inconnue : ${k}`);
    rules[k] = Number(v);
  }
  const t0 = process.hrtime.bigint();
  const chunk = Math.ceil(N / workers);
  const jobs = [];
  for (let w = 0; w < workers; w += 1) {
    const from = w * chunk;
    const to = Math.min(N, from + chunk);
    if (from >= to) continue;
    jobs.push(new Promise((resolve, reject) => {
      const wk = new Worker(fileURLToPath(import.meta.url), { workerData: { from, to, baseSeed, rules } });
      wk.once('message', resolve);
      wk.once('error', reject);
    }));
  }
  const res = merge(await Promise.all(jobs));
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  const names = new Map(pool.map((c) => [c.id, c.name]));
  const pct = (a, b) => (b ? ((100 * a) / b).toFixed(1) : '—');
  const ranked = Object.entries(res.byChamp).filter(([, e]) => e.games >= 10)
    .map(([id, e]) => ({ id: Number(id), name: names.get(Number(id)), type: typeById.get(Number(id)), speed: speedById.get(Number(id)), games: e.games, rate: e.wins / e.games }))
    .sort((a, b) => b.rate - a.rate);
  // Corrélation de Pearson entre la vitesse d'un Mythique et son taux de victoire (0 = la vitesse ne compte pas).
  const mean = (a) => a.reduce((x, y) => x + y, 0) / (a.length || 1);
  const mx = mean(ranked.map((r) => r.speed));
  const my = mean(ranked.map((r) => r.rate));
  let sxy = 0; let sxx = 0; let syy = 0;
  for (const r of ranked) { sxy += (r.speed - mx) * (r.rate - my); sxx += (r.speed - mx) ** 2; syy += (r.rate - my) ** 2; }
  const speedCorr = sxx && syy ? sxy / Math.sqrt(sxx * syy) : 0;
  const summary = {
    speedCorr,
    duels: res.games,
    avgTurns: res.turns / res.games,
    side0Pct: res.decided ? (100 * res.wins0) / res.decided : null,
    drawPct: (100 * (res.draws ?? 0)) / res.games,
    limitPct: (100 * (res.limit ?? 0)) / res.games,
    switchSharePct: res.choose ? (100 * (res.switches ?? 0)) / res.choose : 0,
    chooseActions: res.choose,
    forcedReplacements: res.replaces,
    outOfRange: ranked.filter((r) => r.rate < 0.3 || r.rate > 0.7).map((r) => `${r.name} ${(r.rate * 100).toFixed(1)} %`),
    byType: Object.fromEntries(Object.entries(res.byType).map(([t, e]) => [t, { games: e.games, pct: (100 * e.wins) / e.games }]))
  };
  if (args.includes('--json')) {
    console.log(JSON.stringify({ summary, ranked, rules }));
  } else {
    console.log(`Duels simulés : ${N} (graine ${baseSeed}${Object.keys(rules).length ? `, règles ${JSON.stringify(rules)}` : ''}) en ${(ms / 1000).toFixed(1)} s sur ${jobs.length} workers`);
    console.log(`Tours en moyenne : ${summary.avgTurns.toFixed(2)} (objectif 12–25)`);
    const hist = Object.entries(res.hist).sort((a, b) => a[0] - b[0]).map(([r, n]) => `${r}:${n}`).join(' ');
    console.log(`Répartition des tours : ${hist}`);
    console.log(`Corrélation vitesse / taux de victoire (par Mythique) : ${speedCorr.toFixed(2)} (0 = la vitesse ne décide pas)`);
    console.log(`Victoires du camp 0 : ${pct(res.wins0, res.decided)} % (sur ${res.decided} duels décidés ; objectif 45–55)`);
    console.log(`Nuls : ${res.draws ?? 0} (${pct(res.draws ?? 0, res.games)} %) · limite de ${E.RULES.maxTurns} tours atteinte : ${res.limit ?? 0} (${pct(res.limit ?? 0, res.games)} % ; objectif < 3)`);
    console.log(`Fins : ${JSON.stringify(res.reasons)}`);
    console.log(`Actions de tour : ${res.choose} dont changements ${res.switches ?? 0} (${summary.switchSharePct.toFixed(1)} %) · remplacements forcés après K.O. : ${res.replaces ?? 0}`);
    console.log('Victoires par type (champions alignés, tous rangs confondus) :');
    for (const [t, e] of Object.entries(res.byType).sort((a, b) => b[1].wins / b[1].games - a[1].wins / a[1].games)) {
      const lead = res.lead[t];
      console.log(`  ${t.padEnd(10)} ${((100 * e.wins) / e.games).toFixed(1).padStart(5)} %  (${e.games} présences${lead ? `, en tête d’équipe : ${((100 * lead.wins) / lead.games).toFixed(1)} % sur ${lead.games}` : ''})`);
    }
    if (args.includes('--all')) {
      console.log('Tous les champions :');
      for (const r of ranked) console.log(`  ${(r.rate * 100).toFixed(1).padStart(5)} %  ${r.name} [${r.type}] v${r.speed} (${r.games})`);
    } else {
      console.log('Champions les plus performants (≥ 10 duels) :');
      for (const r of ranked.slice(0, 10)) console.log(`  ${(r.rate * 100).toFixed(1).padStart(5)} %  ${r.name} [${r.type}] v${r.speed} (${r.games})`);
      console.log('Champions les moins performants :');
      for (const r of ranked.slice(-10).reverse()) console.log(`  ${(r.rate * 100).toFixed(1).padStart(5)} %  ${r.name} [${r.type}] v${r.speed} (${r.games})`);
    }
    console.log(`Champions hors de 30–70 % : ${summary.outOfRange.length}${summary.outOfRange.length ? ` — ${summary.outOfRange.join(' ; ')}` : ''}`);
  }
}
