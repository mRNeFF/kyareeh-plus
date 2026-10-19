// Vérifie les calculs de l'onglet Stat (collections, classements, propriétaires,
// ouvertures). Le bloc est extrait de content/ui.js entre STATS:BEGIN / STATS:END :
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

const prelude = `
  const RARITY_ORDER = ['C', 'U', 'R', 'E', 'L', 'M', 'H'];
`;

const block = source.slice(begin, end);
const factory = new Function(`${prelude}
  ${block}
  return {
    statRarityOf,
    statEmptyData,
    statNormalizeData,
    statAssignRanks,
    statRankAccounts,
    statOwnerIndex,
    statOwnerCount,
    statSummary,
    statCatalogTotals,
    statMissingTotals,
    statOpeningsRank,
    statOpeningsByAccount,
    statAggregateOpenings
  };
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

const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// --- Données de test -------------------------------------------------
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

const accounts = [
  {
    id: 'a',
    pseudo: 'Axel',
    self: true,
    collection: { cards: { 1: 3, 4: 2, 6: 1 }, qtyKnown: true }
  },
  {
    id: 'b',
    pseudo: 'Béa',
    collection: { cards: { 1: 1, 4: 1, 5: 1 }, qtyKnown: false }
  },
  {
    id: 'c',
    pseudo: 'Cid',
    collection: { cards: { 4: 1, 6: 2, 7: 1 }, qtyKnown: false }
  },
  { id: 'd', pseudo: 'Dee', collection: null }
];

// Reproduit le calcul de `statsDerived` : raretés déduites du catalogue.
function derive(list) {
  return list.map((account) => {
    if (!account.collection) return account;
    const byRarity = {};
    const qtyByRarity = {};
    for (const [cardId, qty] of Object.entries(account.collection.cards ?? {})) {
      const code = rarityOf(cardId) || 'C';
      byRarity[code] = (byRarity[code] ?? 0) + 1;
      qtyByRarity[code] = (qtyByRarity[code] ?? 0) + (Number(qty) || 1);
    }
    return { ...account, collection: { ...account.collection, byRarity, qtyByRarity } };
  });
}

const derivedAccounts = derive(accounts);

// --- 1. Raretés -------------------------------------------------------
check('rareté vide -> C', api.statRarityOf('') === 'C');
check('rareté normalisée', api.statRarityOf(' m ') === 'M');

// --- 2. Données vides et normalisation --------------------------------
const empty = api.statEmptyData();
check('structure vide', empty.openings.total === 0 && Object.keys(empty.accounts).length === 0);
check('version', empty.version === 1);

const normalized = api.statNormalizeData({
  since: 123,
  accounts: {
    a: {
      pseudo: 'Axel',
      self: true,
      collection: { at: 10, cards: { 1: 2, 3: '4', 9: 0 }, qtyKnown: true },
      chakra: { value: 42, at: 5 }
    },
    broken: null
  },
  openings: {
    total: 3,
    byPack: { p1: { name: 'Pack 1', count: 2 }, p2: { count: 0 } },
    byRarity: { m: 4, x: 0 },
    byAccount: { a: { pseudo: 'Axel', total: 3, byPack: { p1: { count: 3 } }, byRarity: { M: 4 } } }
  },
  recent: [{ ts: 1, accountId: 'a', packId: 'p1', count: 1 }, null, { ts: 2 }]
});
check('normalisation: compte cassé ignoré', !normalized.accounts.broken);
check('normalisation: unique recalculé', normalized.accounts.a.collection.unique === 2);
check('normalisation: quantité invalide ignorée', normalized.accounts.a.collection.qty === 6);
check('normalisation: rareté en minuscules corrigée', normalized.openings.byRarity.M === 4 && !normalized.openings.byRarity.x);
check('normalisation: events null filtrés', normalized.recent.length === 2);
check('normalisation: since conservé', normalized.since === 123);

// --- 3. Bilan des cartes ---------------------------------------------
const summary = api.statSummary(accounts, rarityOf);
check('unique global dédoublonné', summary.unique === 5, `obtenu ${summary.unique}`);
check('exemplaires cumulés', summary.qty === 13, `obtenu ${summary.qty}`);
check('quantités partielles signalées', summary.qtyKnown === false);
check('Mythique: 2 différentes', summary.byRarity.M.unique === 2);
check('Mythique: 5 exemplaires', summary.byRarity.M.qty === 5, `obtenu ${summary.byRarity.M.qty}`);
check('Héritage: 2 différentes', summary.byRarity.H.unique === 2);
check('Héritage: 4 exemplaires', summary.byRarity.H.qty === 4);

// --- 4. Propriétaires -------------------------------------------------
const index = api.statOwnerIndex(accounts);
check('propriétaires Mythique #4', api.statOwnerCount(index, 4) === 3);
check('Mythique #5: un seul', api.statOwnerCount(index, 5) === 1);
check('carte inconnue', api.statOwnerCount(index, 999) === 0);
check('exemplaires connus #1 (Axel 3 + Béa 1)', index[1].qty === 4);
check('compte multiple compté une fois', index[4].owners.length === 3);
check('index ne contient pas les comptes sans collection', !index[999]);

// --- 5. Classements ---------------------------------------------------
const myth = api.statRankAccounts(derivedAccounts, 'M', 'unique');
check('classement Mythique: 3 lignes', myth.length === 3);
check('classement Mythique: Béa en tête', myth[0].pseudo === 'Béa' && myth[0].value === 2 && myth[0].rank === 1);
check('classement: ex æquo ensuite', myth[1].rank === 2 && myth[2].rank === 2);
check('classement: tri alphabétique à égalité', myth[1].pseudo === 'Axel' && myth[2].pseudo === 'Cid');
check('classement: valeur du second', myth[1].value === 1);

const mythQty = api.statRankAccounts(derivedAccounts, 'M', 'qty');
check('classement exemplaires: Axel 2', mythQty[0].pseudo === 'Axel' && mythQty[0].value === 2);
check('classement exemplaires: comptes sans quantités exclus', mythQty.length === 1);

const heritage = api.statRankAccounts(derivedAccounts, 'H', 'unique');
check('classement Héritage: Axel et Cid', heritage.length === 2 && heritage[0].value === 2);

const ranks = api.statAssignRanks([
  { value: 5 },
  { value: 5 },
  { value: 3 },
  { value: 1 }
]);
check('rangs avec ex æquo', eq(ranks.map((r) => r.rank), [1, 1, 3, 4]));

// --- 6. Catalogue et manquantes --------------------------------------
const catalogTotals = api.statCatalogTotals(CATALOG);
check('catalogue total', catalogTotals.total === 7);
check('catalogue Mythique', catalogTotals.byRarity.M === 2);
check('catalogue Héritage', catalogTotals.byRarity.H === 2);

const ownedIds = new Set(Object.keys(index));
const missingAll = api.statMissingTotals(CATALOG, ownedIds, 'all');
check('manquantes toutes raretés', missingAll.total === 2);
check('manquante = carte #2 (Commune) et #3 (Rare)', missingAll.byRarity.C === 1 && missingAll.byRarity.R === 1);

const missingH = api.statMissingTotals(CATALOG, ownedIds, 'H');
check('manquantes Héritage', missingH.total === 0);

// --- 7. Ouvertures ----------------------------------------------------
const byPack = {
  p1: { name: 'Pack Alpha', count: 7 },
  p2: { name: 'Pack Beta', count: 7 },
  p3: { name: 'Pack Gamma', count: 2 },
  p4: { name: 'Pack Vide', count: 0 }
};
const packRank = api.statOpeningsRank(byPack);
check('classement boosters: 3 lignes', packRank.length === 3);
check('classement boosters: ex æquo 1', packRank[0].rank === 1 && packRank[1].rank === 1);
check('classement boosters: 3e rang', packRank[2].rank === 3);
check('classement boosters: tri alpha à égalité', packRank[0].name === 'Pack Alpha');
check('classement boosters: zéro exclu', !packRank.some((row) => row.name === 'Pack Vide'));

const accountRank = api.statOpeningsByAccount({
  a: { pseudo: 'Axel', total: 5, byPack: { p1: { count: 5 } } },
  b: { pseudo: 'Béa', total: 5, byPack: { p2: { count: 5 } } },
  c: { pseudo: 'Cid', total: 2, byPack: {} }
});
check('classement comptes: ex æquo', accountRank[0].rank === 1 && accountRank[1].rank === 1);
check('classement comptes: 3e rang', accountRank[2].rank === 3);
check('classement comptes: répartition conservée', accountRank[0].byPack.p1.count === 5);

// --- 8. Agrégats d'ouvertures dérivés des comptes ---------------------
const aggregated = api.statAggregateOpenings({
  a: { total: 3, byPack: { p1: { name: 'Alpha', count: 2 }, p2: { name: 'Beta', count: 1 } }, byRarity: { M: 1, C: 2 } },
  b: { total: 2, byPack: { p1: { name: 'Alpha', count: 2 } }, byRarity: { C: 2 } },
  vide: { total: 0, byPack: { p1: { count: 9 } }, byRarity: {} }
});
check('agrégat: total', aggregated.total === 5);
check('agrégat: par booster', aggregated.byPack.p1.count === 4 && aggregated.byPack.p2.count === 1);
check('agrégat: raretés', aggregated.byRarity.C === 4 && aggregated.byRarity.M === 1);
check('agrégat: compte vide ignoré', Object.keys(aggregated.byPack).length === 2);
check('agrégat: entrée vide', api.statAggregateOpenings({}).total === 0);

const rebuilt = api.statNormalizeData({
  accounts: { a: { pseudo: 'Axel' } },
  openings: {
    total: 99,
    byPack: { faux: { count: 99 } },
    byAccount: { a: { pseudo: 'Axel', total: 2, byPack: { p1: { name: 'Alpha', count: 2 } }, byRarity: { M: 2 } } }
  }
});
check('normalisation: totaux recalculés depuis les comptes', rebuilt.openings.total === 2 && !rebuilt.openings.byPack.faux);
check('normalisation: raretés du compte conservées', rebuilt.openings.byRarity.M === 2);

// --- 9. Cas limites ---------------------------------------------------
const noCollection = api.statSummary([{ id: 'x', collection: null }], rarityOf);
check('aucune collection -> zéro', noCollection.unique === 0 && noCollection.qty === 0);
check('aucune collection -> quantités "connues" (vides)', noCollection.qtyKnown === true);

const unknownCatalog = api.statSummary(accounts, () => '');
check('rareté inconnue classée en C', (unknownCatalog.byRarity.C?.unique ?? 0) === 5);

check('index vide sûr', Object.keys(api.statOwnerIndex([])).length === 0);
check('classement vide sûr', api.statRankAccounts([], 'M', 'unique').length === 0);
check('rangs vides sûrs', api.statAssignRanks([]).length === 0);

console.log(`\nContrôles : ${checks} · échecs : ${failures}`);
process.exit(failures ? 1 : 0);
