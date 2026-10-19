// Vérifie le moteur d'analyse de l'onglet Vente (tendance, volatilité, confiance, prix).
// Le bloc est extrait de content/ui.js entre les marqueurs ANALYSIS:BEGIN/END :
// les fonctions y sont pures, donc testables hors navigateur.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(join(ROOT, 'content/ui.js'), 'utf8');

const begin = source.indexOf('/* ANALYSIS:BEGIN');
const end = source.indexOf('/* ANALYSIS:END */');
if (begin < 0 || end < 0) {
  console.error('Marqueurs ANALYSIS:BEGIN / ANALYSIS:END introuvables dans content/ui.js');
  process.exit(1);
}

// Dépendances externes au bloc : on fournit des équivalents minimaux.
const prelude = `
  const toNum = (value) => {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  };
  const fmt = (value) => String(Math.round(Number(value) || 0)).replace(/\\B(?=(\\d{3})+(?!\\d))/g, ' ');
  const netOf = (price) => Math.max(0, price - Math.ceil(price * 0.05) - Math.max(1, Math.ceil(price * 0.02)));
`;

const block = source.slice(begin, end);
const factory = new Function(`${prelude}
  ${block}
  return { priceSeries, trendOf, volatilityOf, confidenceOf, analyzeCard, buildRecommendations, sellBlockState, netOf };
`);

const api = factory();

let checks = 0;
let failures = 0;

function check(label, condition, detail = '') {
  checks += 1;
  if (condition) return;
  failures += 1;
  console.log(`ECHEC  ${label}${detail ? ` — ${detail}` : ''}`);
}

function near(a, b, tolerance = 0.01) {
  return a != null && b != null && Math.abs(a - b) <= tolerance;
}

function series(medians, startDay = '2026-10-01') {
  const base = Date.parse(`${startDay}T00:00:00Z`);
  return medians.map((median, index) => ({
    day: new Date(base + index * 86400000).toISOString().slice(0, 10),
    median,
    n: 5
  }));
}

function prices(medians, extra = {}) {
  const days = series(medians);
  return {
    median7d: medians[medians.length - 1],
    median30d: medians[0],
    sales7d: 12,
    sales30d: 40,
    lastPrice: medians[medians.length - 1],
    lastAt: '2026-10-18T12:00:00.000Z',
    days,
    lastSales: medians.map((median) => ({ price: median, at: '2026-10-18T12:00:00.000Z', source: 'listing' })),
    ...extra
  };
}

/* --- 1. Série nettoyée ------------------------------------------------- */

const cleaned = api.priceSeries({
  days: [
    { day: '2026-10-02', median: 0, n: 1 },
    { day: '2026-10-01', median: 10, n: 2 },
    { day: '2026-10-03', median: null, n: 0 },
    { day: '2026-10-04', median: 20, n: 3 }
  ]
});
check('priceSeries retire les zéros et trie', cleaned.length === 2 && cleaned[0].median === 10 && cleaned[1].median === 20);

/* --- 2. Tendance ------------------------------------------------------ */

const flat = api.trendOf(api.priceSeries(prices([100, 100, 100, 100])));
check('série plate : pente nulle', near(flat.slopePct, 0), `slope=${flat.slopePct}`);
check('série plate : variation nulle', near(flat.changePct, 0), `change=${flat.changePct}`);

const up = api.trendOf(api.priceSeries(prices([100, 110, 121, 133.1])));
check('hausse de 10 %/jour', near(up.slopePct, 10, 0.6), `slope=${up.slopePct}`);
check('hausse : R² proche de 1', up.r2 > 0.99, `r2=${up.r2}`);
check('hausse : variation totale +33 %', near(up.changePct, 33.1, 0.6), `change=${up.changePct}`);

const down = api.trendOf(api.priceSeries(prices([200, 180, 162])));
check('baisse détectée', down.slopePct < -9 && down.slopePct > -11, `slope=${down.slopePct}`);

const single = api.trendOf(api.priceSeries(prices([50])));
check('un seul point : pas de tendance', single.slopePct === null && single.changePct === null);

/* --- 3. Volatilité ---------------------------------------------------- */

const stable = api.volatilityOf(api.priceSeries(prices([100, 100, 100, 100])));
check('volatilité nulle sur série plate', stable != null && stable < 0.001, `vol=${stable}`);

const jumpy = api.volatilityOf(api.priceSeries(prices([100, 150, 90, 140])));
check('volatilité élevée sur série instable', jumpy != null && jumpy > 20, `vol=${jumpy}`);

const tooShort = api.volatilityOf(api.priceSeries(prices([100, 110])));
check('volatilité indisponible avec 2 points', tooShort === null);

/* --- 4. Confiance ----------------------------------------------------- */

const lowConf = api.confidenceOf({ points: 2, volume: 0, r2: 0, volatility: 40 });
check('confiance faible', lowConf.level === 'low', JSON.stringify(lowConf));

const highConf = api.confidenceOf({ points: 10, volume: 30, r2: 0.95, volatility: 1 });
check('confiance élevée', highConf.level === 'high', JSON.stringify(highConf));

/* --- 5. Analyse complète --------------------------------------------- */

const analysis = api.analyzeCard({
  prices: prices([100, 110, 121, 133], {
    lastSales: [
      { price: 140, at: '2026-10-18T10:00:00.000Z', source: 'listing' },
      { price: 90, at: '2026-10-17T10:00:00.000Z', source: 'auction' }
    ]
  }),
  listings: {
    items: [
      { type: 'fixed', price: 150, isMine: false },
      { type: 'fixed', price: 170, isMine: false },
      { type: 'auction', price: 120, buyoutPrice: 160, isMine: false }
    ]
  },
  book: [{ price: 130 }, { price: 110 }],
  card: { id: '1', name: 'Test', rarity: 'L', floor: 40 },
  mine: { qty: 2, sellable: 1 }
});

check('médiane retenue', analysis.median === 133, `median=${analysis.median}`);
check('plus haute vente observée', analysis.observedHigh === 140);
check('plus basse vente observée', analysis.observedLow === 90);
check(
  'moins chère annonce fixe',
  analysis.lowest === 150 &&
    analysis.fixedLow === 150 &&
    analysis.fixedHigh === 170 &&
    analysis.auctionBuyout === 160,
  `lowest=${analysis.lowest} fixedLow=${analysis.fixedLow} fixedHigh=${analysis.fixedHigh} buyout=${analysis.auctionBuyout}`
);
check('meilleur ordre d’achat', analysis.bestBid === 130, `bid=${analysis.bestBid}`);
check('nombre de concurrents', analysis.rivals === 3, `rivals=${analysis.rivals}`);
check('projection fournie', analysis.forecast != null);
check('projection bornée à +30 %', analysis.forecast.price <= Math.round(133 * 1.3), JSON.stringify(analysis.forecast));

/* --- 6. Prix recommandés --------------------------------------------- */

const reco = analysis.recommend;
check('trois stratégies', Boolean(reco?.quick && reco.balanced && reco.max));
check(
  'vente rapide ≤ équilibrée ≤ maximale',
  reco.quick.price <= reco.balanced.price &&
    reco.balanced.price <= reco.max.price &&
    reco.max.price === 170,
  `quick=${reco.quick.price} balanced=${reco.balanced.price} max=${reco.max.price}`
);
check('prix ≥ plancher de recyclage', reco.quick.price >= 40 && reco.balanced.price >= 40 && reco.max.price >= 40);
check('vente rapide sous la concurrence', reco.quick.price < 150, `quick=${reco.quick.price}`);
check('justification chiffrée', /médiane/.test(reco.balanced.reason) && /vente/.test(reco.balanced.reason));
check('net après frais', reco.balanced.net < reco.balanced.price);

/* --- 7. Cas sans données --------------------------------------------- */

const empty = api.analyzeCard({ prices: null, listings: null, book: null, card: { id: '2' } });
check('aucune donnée : analyse vide', empty.insufficient === true && empty.median === null && empty.recommend === null);
check('aucune donnée : pas de projection', empty.forecast === null);

const noSeries = api.analyzeCard({
  prices: { median7d: 50, median30d: 80, sales7d: 0, lastSales: [] },
  card: { id: '3', floor: 1 }
});
check('sans série mais avec médianes', noSeries.insufficient === false && noSeries.median === 50);
check('variation de repli 7 j vs 30 j', near(noSeries.changePct, -37.5, 0.1), `change=${noSeries.changePct}`);
check('projection refusée sans série', noSeries.forecast === null);

/* --- 8. Verrous de revente -------------------------------------------- */

const NOW = Date.parse('2026-10-19T00:00:00.000Z');

const free = api.sellBlockState({ qty: 2, listable: 1 }, NOW);
check('un exemplaire libre : pas de blocage', free === null);

const resale = api.sellBlockState(
  { qty: 2, listable: 0, locked: 2, sellBlock: 'resale_lock', resaleUntil: '2026-10-20T02:00:00.000Z' },
  NOW
);
check('revente différée détectée', resale?.code === 'resale_lock');
check('échéance conservée', resale?.until === Date.parse('2026-10-20T02:00:00.000Z'));
check('heures restantes calculées', near(resale?.hoursLeft, 26, 0.01), `h=${resale?.hoursLeft}`);
check('motif explicite 48 h', /48 h/.test(resale?.reason ?? ''));

const escrow = api.sellBlockState({ qty: 1, listable: 0, sellBlock: 'in_escrow', escrow: { listings: 1 } }, NOW);
check('mise en vente détectée', escrow?.code === 'in_escrow' && escrow?.reason === 'Déjà en vente');

const escrowTrade = api.sellBlockState({ qty: 1, listable: 0, sellBlock: 'in_escrow', escrow: { trades: 1 } }, NOW);
check('échange détecté', escrowTrade?.reason === 'Engagée dans un échange');

const pinned = api.sellBlockState({ qty: 1, listable: 0, pinned: true }, NOW);
check('mise de côté détectée', pinned?.code === 'pinned');

const engaged = api.sellBlockState({ qty: 2, listable: 0, locked: 2 }, NOW);
check('sans motif : tous engagés', engaged?.code === 'all_engaged');

const partial = api.sellBlockState({ qty: 3, listable: 0, locked: 1 }, NOW);
check('listable prime sur locked', partial?.code === 'all_engaged');

const emptyCard = api.sellBlockState(null, NOW);
check('carte absente', emptyCard === null);

console.log(`\nContrôles : ${checks} · échecs : ${failures}`);
process.exit(failures ? 1 : 0);
