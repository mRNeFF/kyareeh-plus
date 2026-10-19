// Vérifie les calculs de l'onglet Stat global (pools, classements, union de
// collections, cumuls). Le bloc est extrait de content/ui.js entre
// GLOBALSTATS:BEGIN / GLOBALSTATS:END : les fonctions y sont pures.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(join(ROOT, 'content/ui.js'), 'utf8');

const begin = source.indexOf('/* GLOBALSTATS:BEGIN');
const end = source.indexOf('/* GLOBALSTATS:END */');
if (begin < 0 || end < 0) {
  console.error('Marqueurs GLOBALSTATS:BEGIN / GLOBALSTATS:END introuvables dans content/ui.js');
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
    statBuildPool,
    statAssignRanks,
    statRank,
    statUnionCollections,
    statSumByRarity,
    statCatalogTotals,
    statOwnerIndex,
    statOwnerCount,
    statRarityCodes
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
  { id: 1, rarity: 'C' },
  { id: 2, rarity: 'C' },
  { id: 3, rarity: 'R' },
  { id: 4, rarity: 'M' },
  { id: 5, rarity: 'M' },
  { id: 6, rarity: 'H' },
  { id: 7, rarity: 'H' }
];
const rarityOf = (id) => CATALOG.find((card) => String(card.id) === String(id))?.rarity ?? '';

// --- 1. Normalisation ------------------------------------------------
check('rareté vide -> C', api.statRarityOf('') === 'C');
check('rareté normalisée', api.statRarityOf(' m ') === 'M');

const empty = api.statEmptyData();
check('structure vide', empty.totals.players === null && Object.keys(empty.profiles).length === 0);
check('profondeur par défaut', empty.depth === 50);

const normalized = api.statNormalizeData({
  at: 123,
  depth: 500,
  totals: { players: 105742, mythicOwners: 52022, catalogSize: 6736, listings: '42', listingsAt: 7 },
  profiles: {
    a: { pseudo: 'A', owned: 10, mythics: 2, heritage: 1, boostersOpened: 5, points: 3, byRarity: { m: 2, c: 8 }, at: 9 },
    broken: null
  },
  pools: { collection: ['a', 1, ''], mythics: ['b'] },
  catalog: { total: 6736, byRarity: { M: 300 } },
  collections: { a: { at: 5, ids: ['1', '2', '2', ''] } },
  failures: [{ id: 'x', pseudo: 'X', error: 'privé' }, null]
});
check('normalisation: profondeur bornée à 100', normalized.depth === 100);
check('normalisation: compte cassé ignoré', !normalized.profiles.broken);
check('normalisation: raretés en minuscules corrigées', normalized.profiles.a.byRarity.M === 2);
check('normalisation: champs numériques', normalized.totals.players === 105742 && normalized.totals.listings === 42);
check('normalisation: pool nettoyé', JSON.stringify(normalized.pools.collection) === JSON.stringify(['a', '1']));
check('normalisation: collection dédoublonnée', normalized.collections.a.ids.length === 2);
check('normalisation: échecs filtrés', normalized.failures.length === 1);
check('normalisation: catalogue conservé', normalized.catalog.byRarity.M === 300);

// --- 2. Pool analysé -------------------------------------------------
const ladders = {
  collection: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }, { id: 'e' }, { id: 'f' }, { id: 'g' }, { id: 'h' }],
  mythics: [{ id: 'b' }, { id: 'i' }, { id: 'c' }, { id: 'j' }],
  series: [{ id: 'k' }, { id: 'a' }, { id: 'l' }],
  achievements: [{ id: 'm' }, { id: 'n' }]
};
const pool = api.statBuildPool(ladders, 8);
check('pool: taille demandée', pool.length === 8, `obtenu ${pool.length}`);
check('pool: dédoublonné', new Set(pool).size === pool.length);
check('pool: une part de chaque classement', ['a', 'b', 'i', 'k', 'm'].every((id) => pool.includes(id)));
check('pool: quota respecté par classement', pool.filter((id) => ['k', 'l'].includes(id)).length <= 2);
check('pool: profondeur 1', api.statBuildPool(ladders, 1).length === 1);
check('pool: listes vides', api.statBuildPool({}, 8).length === 0);

// --- 3. Rangs et classements -----------------------------------------
const ranks = api.statAssignRanks([{ value: 5 }, { value: 5 }, { value: 3 }, { value: 1 }]);
check('rangs avec ex æquo', JSON.stringify(ranks.map((row) => row.rank)) === JSON.stringify([1, 1, 3, 4]));

const ranking = api.statRank([
  { id: 'a', pseudo: 'Zoé', value: 3 },
  { id: 'b', pseudo: 'Ana', value: 7 },
  { id: 'c', pseudo: 'Bob', value: 0 },
  { id: 'd', pseudo: 'Eve', value: 3 }
]);
check('classement: zéros exclus', ranking.length === 3);
check('classement: ordre décroissant', ranking[0].id === 'b' && ranking[0].value === 7);
check('classement: ex æquo', ranking[1].rank === 2 && ranking[2].rank === 2);
check('classement: tri alphabétique à égalité', ranking[1].pseudo === 'Eve' && ranking[2].pseudo === 'Zoé');
check('classement vide', api.statRank([]).length === 0);
check('classement: valeurs absentes', api.statRank([{ id: 'a', value: null }]).length === 0);

// --- 4. Union des collections ----------------------------------------
const union = api.statUnionCollections(
  [
    ['1', '2', '4'],
    ['1', '4', '5'],
    null,
    ['6']
  ],
  rarityOf
);
check('union: total dédoublonné', union.total === 5, `obtenu ${union.total}`);
check('union: raretés', union.byRarity.C === 2 && union.byRarity.M === 2 && union.byRarity.H === 1);
check('union: comptage des collections', union.available === 3 && union.missing === 1);
check('union vide', api.statUnionCollections([], rarityOf).total === 0);

// --- 5. Cumul par joueur ---------------------------------------------
const sum = api.statSumByRarity([
  { byRarity: { C: 3, M: 2 } },
  { byRarity: { C: 1, M: 1, H: 1 } },
  { byRarity: null }
]);
check('cumul: total', sum.total === 8, `obtenu ${sum.total}`);
check('cumul: par rareté', sum.byRarity.C === 4 && sum.byRarity.M === 3 && sum.byRarity.H === 1);
check('cumul: joueurs comptés', sum.players === 2);
check('cumul vide', api.statSumByRarity([]).total === 0);

// --- 6. Catalogue et propriétaires -----------------------------------
const catalog = api.statCatalogTotals(CATALOG);
check('catalogue: total', catalog.total === 7);
check('catalogue: raretés', catalog.byRarity.C === 2 && catalog.byRarity.M === 2 && catalog.byRarity.H === 2);
check('catalogue vide', api.statCatalogTotals([]).total === 0);

const owners = api.statOwnerIndex({
  a: { ids: ['4', '1'] },
  b: { ids: ['4', '5', '4'] },
  c: { ids: ['4'] },
  vide: { ids: [] }
});
check('propriétaires: 3 joueurs pour #4', api.statOwnerCount(owners, '4') === 3);
check('propriétaires: compte unique par joueur', owners['4'].length === 3);
check('propriétaires: carte inconnue', api.statOwnerCount(owners, '99') === 0);
check('propriétaires: carte à un seul joueur', api.statOwnerCount(owners, '5') === 1);

// --- 7. Raretés affichées --------------------------------------------
const codes = api.statRarityCodes({ M: 2 }, { X: 1 });
check('codes: ordre officiel respecté', codes[0] === 'C' && codes.includes('H'));
check('codes: rareté inconnue ajoutée', codes.includes('X'));

// --- 8. Cohérence union / cumul --------------------------------------
const profiles = [
  { byRarity: { C: 2, M: 1 }, owned: 3 },
  { byRarity: { C: 2, M: 1 }, owned: 3 }
];
const both = api.statSumByRarity(profiles);
check('cumul >= union quand tous les joueurs partagent les mêmes types', both.total === 6);
check('union <= cumul', api.statUnionCollections([['1', '2', '3'], ['1', '2', '3']], rarityOf).total <= both.total);

console.log(`\nContrôles : ${checks} · échecs : ${failures}`);
process.exit(failures ? 1 : 0);
