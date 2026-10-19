// Vérifie les calculs de l'onglet Stat (classement de comptes suivis).
// Le bloc est extrait de content/ui.js entre STATS:BEGIN / STATS:END :
// les fonctions y sont pures, donc testables hors navigateur.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(join(ROOT, 'content/ui.js'), 'utf8');

const begin = source.indexOf('/* STATS:BEGIN');
const end = source.indexOf('/* STATS:END */');
if (begin < 0 || end < 0) {
  console.error('Marqueurs STATS:BEGIN / STATS:END introuvables dans content/ui.js');
  process.exit(1);
}

const prelude = `const RARITY_ORDER = ['C', 'U', 'R', 'E', 'L', 'M', 'H'];`;
const block = source.slice(begin, end);
const api = new Function(`${prelude}
  ${block}
  return {
    statRarityOf,
    statEmptyData,
    statNormalizeData,
    statSeriesProgress,
    statCollectionValue,
    statUnionIds,
    statOwnerCounts,
    statAccountMetrics,
    statColumnValue,
    statSortAccounts,
    statRankRows,
    STAT_COLUMNS
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

const CATALOG = [
  { id: 1, series: 'A', rarity: 'C' },
  { id: 2, series: 'A', rarity: 'R' },
  { id: 3, series: 'B', rarity: 'C' },
  { id: 4, series: 'B', rarity: 'M' },
  { id: 5, series: 'B', rarity: 'L' },
  { id: 6, series: 'C', rarity: 'M' },
  { id: 7, series: 'C', rarity: 'H' },
  { id: 8, series: 'C', rarity: 'C' }
];

// --- 1. Normalisation -------------------------------------------------
check('rareté vide -> C', api.statRarityOf('') === 'C');
check('rareté normalisée', api.statRarityOf(' m ') === 'M');

const empty = api.statEmptyData();
check('structure vide', Object.keys(empty.accounts).length === 0 && empty.ownerTotal === 0);
check('tri par défaut', empty.sort === 'value' && empty.desc === true);

const normalized = api.statNormalizeData({
  at: 123,
  sort: 'mythic',
  desc: false,
  ownerTotal: 3,
  friendsAt: 456,
  friendIds: ['7', '7', '', '8'],
  accounts: {
    a: {
      pseudo: 'A',
      owned: 10,
      doubles: 4,
      copies: 14,
      boosters: 50,
      byRarity: { m: 3, l: 2 },
      value: 1000,
      rankPos: 12,
      seriesFinished: 2
    },
    me: { pseudo: 'Moi', self: true },
    ami: { pseudo: 'Ami', source: 'friend' },
    broken: null
  },
  owners: { 4: 2, 9: 0 }
});
check('normalisation: compte cassé ignoré', !normalized.accounts.broken);
check('normalisation: raretés corrigées', normalized.accounts.a.byRarity.M === 3);
check('normalisation: champs conservés', normalized.accounts.a.value === 1000 && normalized.accounts.a.copies === 14);
check('normalisation: tri relu', normalized.sort === 'mythic' && normalized.desc === false);
check('normalisation: propriétaires positifs seulement', normalized.owners['4'] === 2 && !normalized.owners['9']);
check('normalisation: ownerTotal', normalized.ownerTotal === 3);
check('normalisation: amis relus', normalized.friendsAt === 456 && normalized.friendIds.join(',') === '7,8');
check(
  'normalisation: origine des comptes',
  normalized.accounts.me.source === 'self' &&
    normalized.accounts.ami.source === 'friend' &&
    normalized.accounts.a.source === 'manual'
);

const nulls = api.statNormalizeData({ accounts: { a: { pseudo: 'A', rankPos: null, owned: null, value: '' } } });
check('normalisation: null reste absent (pas 0)', nulls.accounts.a.rankPos === null && nulls.accounts.a.owned === null);
check('normalisation: chaîne vide reste absente', nulls.accounts.a.value === null);

// --- 2. Séries --------------------------------------------------------
const series = api.statSeriesProgress(['1', '2', '3', '4', '5'], CATALOG);
// A (1,2) et B (3,4,5) sont complètes ; C n'a aucune carte.
check('séries: A et B finies', series.finished === 2, `obtenu ${series.finished}`);
check('séries: C presque finie (3 manquantes)', series.almost === 1, `obtenu ${series.almost}`);
check('séries: total', series.series === 3);
check('séries: vide', api.statSeriesProgress([], CATALOG).finished === 0);
check('séries: catalogue vide', api.statSeriesProgress(['1'], []).series === 0);
check('séries: ids inconnus ignorés', api.statSeriesProgress(['999'], CATALOG).finished === 0);

const almostEdge = api.statSeriesProgress(['3', '4', '5', '6', '7'], CATALOG);
// A manque 2 cartes et C en manque 1 : les deux sont « presque finies ».
check('séries: presque finies comptées', almostEdge.almost === 2 && almostEdge.finished === 1, JSON.stringify(almostEdge));

// --- 3. Valeur --------------------------------------------------------
const prices = new Map([
  ['1', 10],
  ['2', 25],
  ['3', 5]
]);
const value = api.statCollectionValue(['1', '2', '3'], prices);
check('valeur: total', value.value === 40, `obtenu ${value.value}`);
check('valeur: cartes valorisées', value.priced === 3);
check('valeur: carte sans prix', api.statCollectionValue(['1', '999'], prices).unpriced === 1);
check('valeur: prix nul ignoré', api.statCollectionValue(['1'], { 1: 0 }).unpriced === 1);
check('valeur: objet simple', api.statCollectionValue(['1'], { 1: 10 }).value === 10);
check('valeur: vide', api.statCollectionValue([], prices).value === 0);

// --- 4. Union et propriétaires ---------------------------------------
const union = api.statUnionIds([['1', '2'], ['2', '3'], null]);
check('union: dédoublonnée', union.size === 3);
check('union: vide', api.statUnionIds([null, []]).size === 0);

const owners = api.statOwnerCounts({ a: ['1', '2'], b: ['2', '2'], c: ['3'] });
check('propriétaires: carte 2 = 2 comptes', owners['2'] === 2);
check('propriétaires: carte 1 = 1 compte', owners['1'] === 1);
check('propriétaires: aucun doublon de compte', Object.values(owners).every((n) => n <= 3));

// --- 5. Métriques d'un compte ----------------------------------------
const profile = {
  owned: 8,
  doublesCount: 3,
  boostersOpened: 120,
  byRarity: { C: 3, R: 2, M: 2, L: 1 },
  catalogSize: 6736,
  listings: [{ id: 'x' }, { id: 'y' }]
};
const metrics = api.statAccountMetrics(profile, ['1', '2', '3', '4', '5'], prices, CATALOG);
check('métriques: cartes différentes', metrics.owned === 8);
check('métriques: exemplaires = différents + doubles', metrics.copies === 11);
check('métriques: boosters', metrics.boosters === 120);
check('métriques: mythiques', metrics.mythic === 2);
check('métriques: légendaires', metrics.legendary === 1);
check('métriques: valeur', metrics.value === 40);
check('métriques: séries finies', metrics.seriesFinished === 2);
check('métriques: annonces actives', metrics.listings === 2);
check('métriques: complétion catalogue', api.statColumnValue({ owned: 8, catalogSize: 6736 }, 'catalogPct') === 0.1);

const noCollection = api.statAccountMetrics(profile, null, prices, CATALOG);
check('métriques: collection illisible => valeur nulle', noCollection.value === null);
check('métriques: collection illisible => séries nulles', noCollection.seriesFinished === null);
check('métriques: cartes restent connues', noCollection.owned === 8);
check('métriques: profil vide', api.statAccountMetrics(null, null, prices, CATALOG).owned === null);
check('métriques: copies sans doubles', api.statAccountMetrics({ owned: 5 }, null, prices, []).copies === null);

// --- 6. Tri et rangs --------------------------------------------------
const rows = [
  { id: 'a', pseudo: 'Zed', value: 100, owned: 10, rankPos: 50, mythic: 2 },
  { id: 'b', pseudo: 'Amy', value: 300, owned: 5, rankPos: 10, mythic: 9 },
  { id: 'c', pseudo: 'Bob', value: null, owned: 20, rankPos: null, mythic: 2 },
  { id: 'd', pseudo: 'Cat', value: 300, owned: 15, rankPos: 3, mythic: 2 }
];
const byValue = api.statSortAccounts(rows, 'value', true);
check('tri valeur: ordre', byValue.map((r) => r.id).join('') === 'bdac', byValue.map((r) => r.id).join(''));
check('tri valeur: valeurs nulles en dernier', byValue[3].id === 'c');
const byRank = api.statSortAccounts(rows, 'rankPos', true);
check('tri rang: le plus petit rang d’abord', byRank[0].id === 'd' && byRank[1].id === 'b');
const byOwnedAsc = api.statSortAccounts(rows, 'owned', false);
check('tri cartes croissant', byOwnedAsc[0].id === 'b');

const ranks = api.statRankRows(byValue, 'value');
check('rangs: ex æquo', ranks[0].rank === 1 && ranks[1].rank === 1 && ranks[2].rank === 3, JSON.stringify(ranks));
check('rangs: non classable sans valeur', ranks[3].rank === null);

check('colonnes: 10 métriques', api.STAT_COLUMNS.length === 10);
check('colonnes: clés uniques', new Set(api.STAT_COLUMNS.map((c) => c.key)).size === 10);
check('colonne inconnue ignorée', api.statColumnValue({ value: 5 }, 'nope') == null);

console.log(`\nContrôles : ${checks} · échecs : ${failures}`);
process.exit(failures ? 1 : 0);
