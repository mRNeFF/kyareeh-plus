// Vérifie le journal des ventes confirmées, le profit réalisé et la courbe
// cumulée (blocs AUTOSELL + SALES de content/ui.js).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(join(ROOT, 'content/ui.js'), 'utf8');

function block(name) {
  const begin = source.indexOf(`/* ${name}:BEGIN`);
  const end = source.indexOf(`/* ${name}:END */`);
  if (begin < 0 || end < 0) {
    console.error(`Marqueurs ${name}:BEGIN / ${name}:END introuvables dans content/ui.js`);
    process.exit(1);
  }
  return source.slice(begin, end);
}

// Le bloc SALES réutilise les helpers d'annonce du bloc AUTOSELL.
const api = new Function(`${block('AUTOSELL')}
${block('SALES')}
  return {
    salesFeeOf,
    salesTaxOf,
    salesProfitOf,
    salesLedgerTotals,
    salesChartSeries,
    salesListingSnapshot,
    salesTrackReconcile,
    salesMergeEntries
  };
`)();

let checks = 0;
let failures = 0;
function check(label, condition, detail = '') {
  checks += 1;
  if (condition) return;
  failures += 1;
  console.log(`ECHEC  ${label}${detail ? ` — ${detail}` : ''}`);
}

const RATES = { feePct: 2, feeMin: 1, taxPct: 5 };

/* --- 1. profit net : encaissé − frais − taxe --------------------------- */

const profit = api.salesProfitOf(100, RATES);
check('frais = 2 % du prix', profit.fees === 2, String(profit.fees));
check('taxe = 5 % du prix', profit.tax === 5, String(profit.tax));
check('profit net = 93', profit.net === 93, String(profit.net));
check('frais minimum respecté', api.salesFeeOf(1, RATES) === 1);
check('taxe nulle sur prix nul', api.salesTaxOf(0, RATES) === 0);
check('profit jamais négatif', api.salesProfitOf(2, { feePct: 50, feeMin: 10, taxPct: 50 }).net === 0);

/* --- 2. totaux du journal ---------------------------------------------- */

const ledger = [
  { id: 'a', at: new Date(2026, 9, 20, 10).getTime(), source: 'auto', name: 'A', gross: 108, fees: 3, tax: 6, net: 99, matched: true },
  { id: 'b', at: new Date(2026, 9, 20, 12).getTime(), source: 'manual', name: 'B', gross: 55, fees: 2, tax: 3, net: 50, matched: false },
  { id: 'c', at: new Date(2026, 9, 19, 12).getTime(), source: 'auto', name: 'C', gross: 27, fees: 1, tax: 2, net: 24, matched: false },
  { id: 'd', at: new Date(2026, 9, 10, 12).getTime(), source: 'manual', name: 'D', gross: 1000, fees: 20, tax: 50, net: 930, matched: false }
];
const totals = api.salesLedgerTotals(ledger);
check('total encaissé', totals.gross === 1190, String(totals.gross));
check('total frais', totals.fees === 26, String(totals.fees));
check('total taxe', totals.tax === 61, String(totals.tax));
check('profit total', totals.net === 1103, String(totals.net));
check('nombre de ventes', totals.count === 4, String(totals.count));
check('ventes immédiates', totals.matched === 1, String(totals.matched));
check('totaux vides', JSON.stringify(api.salesLedgerTotals([]).net) === '0');

/* --- 3. courbe du profit cumulé ---------------------------------------- */

const now = new Date(2026, 9, 20, 18, 30).getTime();
const day = api.salesChartSeries(ledger, now, '1d');
check('1 jour = 24 points horaires', day.points.length === 24, String(day.points.length));
check('1 jour : profit de la fenêtre', day.net === 149, String(day.net));
check('1 jour : deux ventes', day.count === 2, String(day.count));
check('1 jour : une vente immédiate', day.matched === 1, String(day.matched));
check('1 jour : cumul final', day.points[23].value === 149, String(day.points[23].value));
check('1 jour : le cumul ne redescend jamais', day.points.every((p, i) => !i || p.value >= day.points[i - 1].value));
check('1 jour : tranche 10 h à 99', day.points[15].value === 99, String(day.points[15].value));
check('1 jour : tranche 12 h cumulée à 149', day.points[17].value === 149, String(day.points[17].value));
check('1 jour : tranche sans vente stable', day.points[18].value === 149 && day.points[18].profit === 0);
check('1 jour : ventes détaillées dans la tranche', day.points[15].sales[0]?.name === 'A');
check('1 jour : profit détaillé par vente', day.points[15].sales[0]?.net === 99);
check('1 jour : la veille est exclue', day.points.every((p) => p.sales.every((s) => s.name !== 'C')));

const week = api.salesChartSeries(ledger, now, '7d');
check('7 jours = 168 points horaires', week.points.length === 168, String(week.points.length));
check('7 jours : profit de la fenêtre', week.net === 173, String(week.net));
check('7 jours : cumul final', week.points[167].value === 173, String(week.points[167].value));
check('7 jours : trois ventes', week.count === 3, String(week.count));
check('7 jours : une mise en vente hors fenêtre ne compte pas', week.points.every((p) => p.sales.every((s) => s.name !== 'D')));
check('courbe unique, plus de séries auto/manuel', week.points.every((p) => !('auto' in p) && !('manual' in p)));
check('frais et taxe de la fenêtre', week.fees === 6 && week.tax === 11);

const all = api.salesChartSeries(ledger, now, 'total');
check('total : départ à la première vente', all.points.length === 247, String(all.points.length));
check('total : profit complet', all.net === 1103, String(all.net));
check('total : cumul final', all.points[246].value === 1103, String(all.points[246].value));
check('total : quatre ventes', all.count === 4, String(all.count));
check('total : pas de division en jours', all.stepHours === 1, String(all.stepHours));

const zero = api.salesChartSeries([], now, '7d');
check('maximum minimal à 1', zero.max === 1);
check('courbe à zéro', zero.points.every((p) => p.value === 0));
check('bénéfice horaire nul sans vente', zero.maxProfit === 0 && zero.points.every((p) => p.profit === 0));
check('fenêtre vide sans vente', zero.count === 0 && zero.net === 0);

/* --- 3 bis. bénéfice par heure (et non cumul) --------------------------- */
// 58 chakra à 9 h, 187 à 10 h, 29 à 11 h : la courbe doit monter à 10 h puis
// redescendre à 11 h, alors que le cumul ne ferait que monter.
const spikes = [
  { id: 's1', at: new Date(2026, 9, 20, 9, 10).getTime(), net: 58, gross: 62, fees: 2, tax: 2 },
  { id: 's2', at: new Date(2026, 9, 20, 10, 20).getTime(), net: 187, gross: 200, fees: 4, tax: 9 },
  { id: 's3', at: new Date(2026, 9, 20, 11, 30).getTime(), net: 29, gross: 31, fees: 1, tax: 1 }
];
const perHour = api.salesChartSeries(spikes, now, '1d');
check(
  'bénéfice par heure : valeurs de chaque tranche',
  perHour.points[14].profit === 58 && perHour.points[15].profit === 187 && perHour.points[16].profit === 29,
  perHour.points
    .slice(13, 18)
    .map((p) => p.profit)
    .join(',')
);
check('bénéfice par heure : max sur une seule tranche', perHour.maxProfit === 187, String(perHour.maxProfit));
check(
  'bénéfice par heure : la courbe redescend après le pic',
  perHour.points[16].profit < perHour.points[15].profit &&
    perHour.points[15].profit > perHour.points[14].profit
);
check('bénéfice par heure : cumul conservé pour le total', perHour.points[23].value === 274, String(perHour.points[23].value));

const otherAccount = api.salesChartSeries(
  [
    { id: 'x', at: new Date(2026, 9, 20, 10).getTime(), accountId: 'moi', net: 10, gross: 11, fees: 1, tax: 0 },
    { id: 'y', at: new Date(2026, 9, 20, 11).getTime(), accountId: 'autre', net: 500, gross: 520, fees: 4, tax: 16 }
  ],
  now,
  '7d',
  { accountId: 'moi' }
);
check('compte : les ventes d’un autre compte sont exclues', otherAccount.net === 10, String(otherAccount.net));
check('compte : une seule vente comptée', otherAccount.count === 1, String(otherAccount.count));

const emptyTotal = api.salesChartSeries([], now, 'total');
check('total vide = un point', emptyTotal.points.length === 1);
check('total vide à zéro', emptyTotal.points[0].value === 0 && emptyTotal.max === 1);

/* --- 4. confirmation d'une vente (relecture des annonces) --------------- */

const t0 = new Date(2026, 9, 23, 12, 0, 0).getTime();
const iso = (ms) => new Date(ms).toISOString();
const track = [
  // A : encore active.
  { id: 'l1', characterId: 1, name: 'A', rarity: 'R', type: 'fixed', price: 100, createdAt: t0 - 3 * 3600e3, endsAt: t0 + 5 * 3600e3, lastSeenAt: t0 - 3600e3 },
  // B : disparue avant échéance, identifiant serveur → vendue.
  { id: 'l2', characterId: 2, name: 'B', rarity: 'U', type: 'fixed', price: 100, createdAt: t0 - 3 * 3600e3, endsAt: t0 + 2 * 3600e3, lastSeenAt: t0 - 600e3 },
  // C : disparue après échéance, prix fixe → expirée.
  { id: 'l3', characterId: 3, name: 'C', rarity: 'C', type: 'fixed', price: 100, createdAt: t0 - 5 * 3600e3, endsAt: t0 - 3600e3, lastSeenAt: t0 - 2 * 3600e3 },
  // D : annulée, encore listée.
  { id: 'l4', characterId: 4, name: 'D', rarity: 'C', type: 'fixed', price: 100, createdAt: t0 - 3 * 3600e3, endsAt: t0 + 5 * 3600e3 },
  // E : statut vendu, prix encaissé 200.
  { id: 'l5', characterId: 5, name: 'E', rarity: 'E', type: 'fixed', price: 100, createdAt: t0 - 3 * 3600e3, endsAt: t0 + 5 * 3600e3 },
  // F : enchère terminée avec une offre → adjugée au meilleur prix.
  { id: 'l6', characterId: 6, name: 'F', rarity: 'E', type: 'auction', price: 50, bid: 80, bids: 1, createdAt: t0 - 6 * 3600e3, endsAt: t0 - 3600e3 },
  // G : enchère terminée sans offre → expirée.
  { id: 'l7', characterId: 7, name: 'G', rarity: 'C', type: 'auction', price: 50, createdAt: t0 - 6 * 3600e3, endsAt: t0 - 3600e3 },
  // H : créée à l'instant, le site ne l'a pas encore indexée → en attente.
  { id: 'l8', characterId: 8, name: 'H', rarity: 'C', type: 'fixed', price: 100, createdAt: t0 - 10e3, endsAt: t0 + 10 * 3600e3 },
  // I : identifiant local jamais vu, disparue avant échéance → on attend.
  { id: 'local-1', characterId: 9, name: 'I', rarity: 'C', type: 'fixed', price: 70, createdAt: t0 - 3 * 3600e3, endsAt: t0 + 3600e3, lastSeenAt: 0 },
  // J : identifiant serveur jamais relu mais disparue avant échéance → vendue.
  { id: 'l10', characterId: 42, name: 'J', rarity: 'R', type: 'fixed', price: 100, createdAt: t0 - 3 * 3600e3, endsAt: t0 + 5 * 3600e3, lastSeenAt: 0 },
  // K : identifiant local reconnu par carte + prix → devient serveur.
  { id: 'local-2', characterId: 55, name: 'K', rarity: 'C', type: 'fixed', price: 60, createdAt: t0 - 3 * 3600e3, endsAt: t0 + 5 * 3600e3, lastSeenAt: 0 }
];
const listings = [
  { id: 'l1', characterId: 1, type: 'fixed', price: 100, status: 'active', endsAt: iso(t0 + 5 * 3600e3) },
  { id: 'l4', characterId: 4, type: 'fixed', price: 100, status: 'cancelled', endsAt: iso(t0 + 5 * 3600e3) },
  { id: 'l5', characterId: 5, type: 'fixed', price: 200, status: 'sold', endsAt: iso(t0 + 5 * 3600e3) },
  { id: 'srv-55', characterId: 55, type: 'fixed', price: 60, status: 'active', endsAt: iso(t0 + 5 * 3600e3) }
];
const reconciled = api.salesTrackReconcile(track, listings, t0, { rates: RATES, graceMs: 90e3 });
check('relecture : quatre ventes confirmées', reconciled.sales.length === 4, String(reconciled.sales.length));
check('relecture : annonce active conservée', reconciled.keep.some((e) => e.id === 'l1'));
check('relecture : annonce récente en attente', reconciled.keep.some((e) => e.id === 'l8'));
check('relecture : identifiant local non vu conservé', reconciled.keep.some((e) => e.id === 'local-1'));
check('relecture : identifiant local adopté', reconciled.keep.some((e) => e.id === 'srv-55'));
check('relecture : annulation ignorée', reconciled.dropped.some((e) => e.id === 'l4'));
check('relecture : expiration ignorée', reconciled.dropped.some((e) => e.id === 'l3'));
check('relecture : enchère sans offre ignorée', reconciled.dropped.some((e) => e.id === 'l7'));

const saleB = reconciled.sales.find((sale) => sale.listingId === 'l2');
check('vente B : profit net', saleB && saleB.net === 93, String(saleB?.net));
check('vente B : brut et frais', saleB && saleB.gross === 100 && saleB.fees === 2 && saleB.tax === 5);
check('vente B : une seule ligne par annonce', reconciled.sales.filter((s) => s.listingId === 'l2').length === 1);
check('vente B : nom conservé', saleB && saleB.name === 'B');
check('vente B : datée de la confirmation', saleB && saleB.at === t0);
check('vente E : prix réellement encaissé', reconciled.sales.find((s) => s.listingId === 'l5')?.net === 186);
check('vente F : adjugée au meilleur prix', reconciled.sales.find((s) => s.listingId === 'l6')?.gross === 80);
check('vente F : datée de la fin', reconciled.sales.find((s) => s.listingId === 'l6')?.at === t0 - 3600e3);
check('vente J : identifiant serveur confirmé', reconciled.sales.find((s) => s.listingId === 'l10')?.net === 93);
check('aucune vente inventée pour une annulation', !reconciled.sales.some((s) => s.listingId === 'l4'));
check('aucune vente inventée pour une expiration', !reconciled.sales.some((s) => s.listingId === 'l3' || s.listingId === 'l7'));
check('aucune vente pour une annonce active', !reconciled.sales.some((s) => s.listingId === 'l1'));

// Le suivi d'un autre compte n'est jamais converti en vente depuis ce compte.
const guarded = api.salesTrackReconcile(
  [{ id: 'l1', characterId: 1, name: 'A', type: 'fixed', price: 100, accountId: 'autre', createdAt: t0 - 3 * 3600e3, endsAt: t0 + 5 * 3600e3 }],
  [],
  t0,
  { rates: RATES, graceMs: 90e3, accountId: 'moi' }
);
check('compte : suivi d’un autre compte conservé', guarded.keep.length === 1 && guarded.sales.length === 0);

const second = api.salesTrackReconcile(track, [], t0, { rates: RATES, graceMs: 90e3 });
check('seconde relecture : pas de doublon d’identifiant', second.keep.concat(second.sales).length <= track.length + 1);
check('seconde relecture : expire sans vente', second.sales.every((s) => s.net > 0));

/* --- 5. fusion sans doublon -------------------------------------------- */

const merged = api.salesMergeEntries([{ id: 'x', at: 2, net: 10 }], [
  { id: 'x', at: 2, net: 10 },
  { id: 'y', at: 1, net: 20 },
  { id: 'y', at: 1, net: 20 }
]);
check('fusion : un seul ajout', merged.added.length === 1, String(merged.added.length));
check('fusion : journal trié', merged.log.map((e) => e.id).join(',') === 'y,x');

console.log(`${checks - failures}/${checks} contrôles OK`);
process.exit(failures ? 1 : 0);
