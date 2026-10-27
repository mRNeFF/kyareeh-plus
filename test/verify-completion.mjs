// Vérifie la logique pure de l'onglet Completion : séries, progression,
// marché des manquants, panier et garde-fous d'achat.
// Le bloc COMPLETION est extrait de content/ui.js : aucune dépendance DOM/réseau.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(join(ROOT, 'content/ui.js'), 'utf8');
const begin = source.indexOf('/* COMPLETION:BEGIN');
const end = source.indexOf('/* COMPLETION:END */');
if (begin < 0 || end < 0) {
  console.error('Marqueurs COMPLETION:BEGIN / COMPLETION:END introuvables dans content/ui.js');
  process.exit(1);
}

const api = new Function(`${source.slice(begin, end)}
  return {
    COMPLETION_DEFAULT_MIN,
    COMPLETION_UNKNOWN_SERIES,
    COMPLETION_SORTS,
    COMPLETION_SORT_KEYS,
    COMPLETION_STOP_CODES,
    completionSeriesKey,
    completionRarityFilter,
    completionIndex,
    completionOwnedMap,
    completionProgress,
    completionListingOffer,
    completionMarket,
    completionMergeMarket,
    completionApplyMarket,
    completionSortRows,
    completionPlan,
    completionBuyOutcome,
    completionBuyGuard,
    completionSeriesOfCard
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

const NOW = Date.parse('2026-10-27T12:00:00.000Z');
const inHours = (h) => new Date(NOW + h * 3600e3).toISOString();

/* ------------------------------------------------------------------ */
/* 1. Clé de série                                                     */
/* ------------------------------------------------------------------ */

check('clé : espaces normalisés', api.completionSeriesKey('  ONE   PIECE ') === 'ONE PIECE');
check('clé : casse conservée', api.completionSeriesKey('Naruto') === 'Naruto');
check('clé : vide → sans série', api.completionSeriesKey('   ') === api.COMPLETION_UNKNOWN_SERIES);
check('clé : null → sans série', api.completionSeriesKey(null) === api.COMPLETION_UNKNOWN_SERIES);
check('clé : accents conservés (NFC)', api.completionSeriesKey('Shōjo') === 'Shōjo');

/* ------------------------------------------------------------------ */
/* 2. Index du catalogue                                               */
/* ------------------------------------------------------------------ */

const catalog = [
  { id: 1, name: 'A', series: 'Naruto', rarity: 'C' },
  { id: 2, name: 'B', series: 'Naruto', rarity: 'U' },
  { id: 3, name: 'C', series: 'Naruto', rarity: 'R' },
  { id: 4, name: 'D', series: 'Naruto', rarity: 'E' },
  { id: 5, name: 'E', series: 'Naruto', rarity: 'L' },
  { id: 10, name: 'F', series: 'ONE PIECE', rarity: 'C' },
  { id: 11, name: 'G', series: 'ONE PIECE', rarity: 'M' },
  { id: 12, name: 'H', series: '  ONE  PIECE ', rarity: 'C' },
  { id: 20, name: 'I', series: '', rarity: 'C' },
  { id: 21, name: 'J', series: 'Solo', rarity: 'C' },
  { id: '22', name: 'K', series: 'Solo', rarity: 'C' },
  { id: 22, name: 'K bis', series: 'Solo', rarity: 'C' },
  { name: 'sans id', series: 'Solo', rarity: 'C' },
  { id: null, series: 'Solo', rarity: 'C' }
];

const index = api.completionIndex(catalog);
check('index : cartes retenues', index.cards === 11, `cards=${index.cards}`);
check('index : séries distinctes', index.series.size === 4, `series=${index.series.size}`);
check('index : Naruto = 5 cartes', index.series.get('Naruto').total === 5);
check('index : ONE PIECE = 3 cartes (libellé normalisé)', index.series.get('ONE PIECE').total === 3);
check('index : doublon d’id ignoré', index.series.get('Solo').total === 2);
check('index : carte sans id ignorée', !index.byCard.has('undefined'));
check('index : série vide regroupée', index.series.has(api.COMPLETION_UNKNOWN_SERIES));
check('index : raretés comptées', index.series.get('Naruto').byRarity.R === 1);
check('index : carte non suivie → null', api.completionSeriesOfCard(index, 999) === null);
check('index : série d’une carte', api.completionSeriesOfCard(index, 10) === 'ONE PIECE');

/* ------------------------------------------------------------------ */
/* 3. Quantités possédées                                              */
/* ------------------------------------------------------------------ */

const fromArray = api.completionOwnedMap([
  { characterId: 1, qty: 2 },
  { characterId: '2', qty: 1 },
  { characterId: 3, qty: 0 },
  { characterId: 4 }
]);
check('owned : array qty conservée', fromArray.get('1') === 2);
check('owned : array id texte', fromArray.get('2') === 1);
check('owned : qty 0 ignorée', fromArray.get('3') === 0);
check('owned : qty absent vaut 1', fromArray.get('4') === 1);

const fromMap = api.completionOwnedMap(new Map([['5', 3]]));
check('owned : Map acceptée', fromMap.get('5') === 3);

const fromObject = api.completionOwnedMap({ 6: 2 });
check('owned : objet accepté', fromObject.get('6') === 2);

check('owned : négatif ramené à 0', api.completionOwnedMap({ 7: -4 }).get('7') === 0);

/* ------------------------------------------------------------------ */
/* 4. Progression par série                                            */
/* ------------------------------------------------------------------ */

// Possédées : Naruto 1,2 (3 non possédée malgré qty 0), ONE PIECE 10 et 12, Solo 21 et 22.
const owned = [
  { characterId: 1, qty: 3 },
  { characterId: 2, qty: 1 },
  { characterId: 3, qty: 0 },
  { characterId: 10, qty: 1 },
  { characterId: 12, qty: 1 },
  { characterId: 21, qty: 1 },
  { characterId: 22, qty: 1 }
];

const progress = api.completionProgress(index, owned, { minSize: 2 });
const naruto = progress.rows.find((row) => row.name === 'Naruto');
const onePiece = progress.rows.find((row) => row.name === 'ONE PIECE');
const solo = progress.rows.find((row) => row.name === 'Solo');
const unknown = progress.rows.find((row) => row.name === api.COMPLETION_UNKNOWN_SERIES);

check('progression : Naruto possédées', naruto.owned === 2, `owned=${naruto.owned}`);
check('progression : Naruto manquantes', naruto.missing === 3, `missing=${naruto.missing}`);
check('progression : Naruto pourcentage', naruto.pct === 40, `pct=${naruto.pct}`);
check('progression : manquantes listées', naruto.missingIds.join(',') === '3,4,5');
check('progression : doublons non comptés', naruto.copies === 4, `copies=${naruto.copies}`);
check('progression : ONE PIECE incomplète (12 possédée, 11 manquante)', onePiece.missing === 1 && onePiece.owned === 2);
check('progression : série sans série comptée', unknown.owned === 0 && unknown.missing === 1);
check('progression : total des cartes', progress.totals.cards === 11);
check('progression : cartes possédées distinctes', progress.totals.owned === 6, `owned=${progress.totals.owned}`);
check('progression : séries complètes', progress.totals.complete === 1, `complete=${progress.totals.complete}`);
check('progression : séries incomplètes', progress.totals.incomplete === 3);
check('progression : visible à minSize 2 = Naruto + ONE PIECE', progress.visible.length === 2);
check('progression : Solo (2 cartes) visible à minSize 2', Boolean(solo));
check('progression : aucune série complète dans visible', progress.visible.every((row) => row.missing > 0));
check('progression : série complète (Solo) exclue de visible', !progress.visible.some((row) => row.name === 'Solo'));

const progressMin5 = api.completionProgress(index, owned, { minSize: 5 });
check('progression : minSize 5 ne garde que Naruto', progressMin5.visible.length === 1 && progressMin5.visible[0].name === 'Naruto');
check('progression : minSize par défaut', api.completionProgress(index, owned).totals.minSize === api.COMPLETION_DEFAULT_MIN);
check('progression : minSize 0 garde tout', api.completionProgress(index, owned, { minSize: 0 }).visible.length === 3);

const empty = api.completionProgress(api.completionIndex([]), []);
check('progression : catalogue vide → 0 série', empty.totals.series === 0 && empty.rows.length === 0);
check('progression : catalogue vide → 0 %', empty.totals.cards === 0);

/* ------------------------------------------------------------------ */
/* 5. Annonces achetables                                             */
/* ------------------------------------------------------------------ */

const fixedOk = { id: 'l1', characterId: 3, type: 'fixed', price: 40, status: 'active', endsAt: inHours(5), seller: { pseudo: 'X' } };
const auctionNoBuyout = { id: 'l2', characterId: 3, type: 'auction', price: 10, buyoutPrice: null, status: 'active', endsAt: inHours(5) };
const auctionBuyout = { id: 'l3', characterId: 3, type: 'auction', price: 10, buyoutPrice: 25, status: 'active', endsAt: inHours(5) };
const mine = { id: 'l4', characterId: 3, type: 'fixed', price: 1, status: 'active', isMine: true };
const sold = { id: 'l5', characterId: 3, type: 'fixed', price: 1, status: 'sold' };
const expired = { id: 'l6', characterId: 3, type: 'fixed', price: 1, status: 'active', endsAt: new Date(NOW - 1000).toISOString() };

check('offre : prix fixe accepté', api.completionListingOffer(fixedOk, { now: NOW })?.price === 40);
check('offre : enchère sans achat immédiat refusée', api.completionListingOffer(auctionNoBuyout, { now: NOW }) === null);
check(
  'offre : enchère avec achat immédiat acceptée quand l’option est active',
  api.completionListingOffer(auctionBuyout, { now: NOW, includeAuctions: true })?.price === 25
);
check(
  'offre : enchère exclue par défaut même avec achat immédiat',
  api.completionListingOffer(auctionBuyout, { now: NOW }) === null
);
check('offre : notre propre annonce exclue', api.completionListingOffer(mine, { now: NOW }) === null);
check('offre : annonce vendue exclue', api.completionListingOffer(sold, { now: NOW }) === null);
check('offre : annonce expirée exclue', api.completionListingOffer(expired, { now: NOW }) === null);
check('offre : vendeur repris', api.completionListingOffer(fixedOk, { now: NOW })?.seller === 'X');
check('offre : identifiant de carte texte', api.completionListingOffer(fixedOk, { now: NOW })?.characterId === '3');

const market = api.completionMarket([fixedOk, auctionBuyout, mine, sold, expired, { ...fixedOk, id: 'l7', price: 55 }], {
  now: NOW,
  includeAuctions: true
});
const entry3 = market.get('3');
check('marché : une entrée par carte', market.size === 1);
check('marché : meilleur prix retenu', entry3.best.price === 25, `best=${entry3.best.price}`);
check('marché : annonces comptées', entry3.count === 3, `count=${entry3.count}`);
check('marché : enchères comptées', entry3.auctions === 1);
check('marché : aucune entrée pour une carte inconnue', market.get('99') === undefined);

const merged = api.completionMergeMarket(new Map(), [fixedOk], { now: NOW });
api.completionMergeMarket(merged, [{ ...fixedOk, id: 'l8', price: 12 }], { now: NOW });
check('marché : fusion garde le meilleur prix', merged.get('3').best.price === 12);
check('marché : fusion additionne les annonces', merged.get('3').count === 2);

/* ------------------------------------------------------------------ */
/* 6. Application du marché aux séries                                */
/* ------------------------------------------------------------------ */

api.completionApplyMarket(progress.rows, market);
check('application : Naruto a 1 manquant disponible', naruto.dispo === 1, `dispo=${naruto.dispo}`);
check('application : coût connu de Naruto', naruto.cost === 25, `cost=${naruto.cost}`);
check('application : coût limité au connu', naruto.costKnown === 1);
check('application : manquant le moins cher', naruto.cheapest === 25);
check('application : série sans annonce → 0', solo.dispo === 0 && solo.cost === 0);
check('application : ids disponibles listés', naruto.dispoIds.join(',') === '3');
check('application : total inchangé après marché', naruto.missing === 3);

const fixedOnly = api.completionApplyMarket(
  api.completionProgress(index, owned, { minSize: 2 }).rows,
  api.completionMarket([fixedOk, auctionBuyout], { now: NOW })
);
const narutoFixed = fixedOnly.find((row) => row.name === 'Naruto');
check('application : enchère exclue du coût', narutoFixed.dispo === 1 && narutoFixed.cost === 40);

/* ------------------------------------------------------------------ */
/* 7. Tris                                                            */
/* ------------------------------------------------------------------ */

const sortable = [
  { name: 'B', missing: 4, pct: 20, dispo: 1, cost: 100, costKnown: 1, cheapest: 100 },
  { name: 'A', missing: 2, pct: 60, dispo: 2, cost: 500, costKnown: 2, cheapest: 40 },
  { name: 'C', missing: 9, pct: 10, dispo: 0, cost: 0, costKnown: 0, cheapest: null }
];

check('tri : plus proche', api.completionSortRows(sortable, 'closest')[0].name === 'A');
check('tri : manquants décroissants', api.completionSortRows(sortable, 'missing_desc')[0].name === 'C');
check('tri : moins cher', api.completionSortRows(sortable, 'cheapest')[0].name === 'A');
check('tri : moins cher → sans annonce en dernier', api.completionSortRows(sortable, 'cheapest')[2].name === 'C');
check('tri : coût croissant', api.completionSortRows(sortable, 'cost_asc')[0].name === 'B');
check('tri : rapport complétion/prix', api.completionSortRows(sortable, 'ratio')[0].name === 'B');
check('tri : nom', api.completionSortRows(sortable, 'name')[0].name === 'A');
check('tri : clé inconnue → plus proche', api.completionSortRows(sortable, 'nope')[0].name === 'A');
check('tri : ne modifie pas la source', sortable[0].name === 'B');
check('tri : 6 tris proposés', api.COMPLETION_SORTS.length === 6);
check('tri : clés cohérentes', api.COMPLETION_SORT_KEYS.every((key) => key.length > 0));

/* ------------------------------------------------------------------ */
/* 8. Panier et garde-fous                                            */
/* ------------------------------------------------------------------ */

const plan = api.completionPlan(
  [
    { characterId: '3', listingId: 'l3', price: 25, name: 'C' },
    { characterId: '4', listingId: 'l1', price: 40.4, name: 'D' },
    { characterId: '3', listingId: 'l9', price: 10, name: 'C bis' },
    { characterId: '5', listingId: '', price: 12, name: 'E' },
    { characterId: '6', listingId: 'l8', price: 0, name: 'F' }
  ],
  { cap: 1000, chakra: 5000 }
);
check('panier : une carte = une annonce', plan.count === 2, `count=${plan.count}`);
check('panier : total arrondi', plan.total === 65, `total=${plan.total}`);
check('panier : prix arrondi par ligne', plan.items[1].price === 40);
check('panier : sans annonce ignorée', !plan.items.some((item) => item.name === 'E'));
check('panier : prix nul ignoré', !plan.items.some((item) => item.name === 'F'));
check('panier : aucun blocage', plan.blocker === null);

const emptyPlan = api.completionPlan([], {});
check('panier vide : bloqué', emptyPlan.blocker?.code === 'empty');
check('panier vide : total 0', emptyPlan.total === 0);

const overCap = api.completionPlan([{ characterId: '3', listingId: 'l3', price: 25 }], { cap: 10 });
check('plafond : dépassement signalé', overCap.blocker?.code === 'cap' && overCap.overCap === true);

const overBalance = api.completionPlan([{ characterId: '3', listingId: 'l3', price: 25 }], { chakra: 10 });
check('solde : dépassement signalé', overBalance.blocker?.code === 'chakra' && overBalance.overBalance === true);

const exactBalance = api.completionPlan([{ characterId: '3', listingId: 'l3', price: 25 }], { chakra: 25 });
check('solde : montant exact accepté', exactBalance.blocker === null);

const noCap = api.completionPlan([{ characterId: '3', listingId: 'l3', price: 9999 }], { cap: 0, chakra: 20000 });
check('plafond 0 = aucun plafond', noCap.blocker === null);

/* ------------------------------------------------------------------ */
/* 9. Décision après une erreur d'achat                               */
/* ------------------------------------------------------------------ */

check('erreur : chakra arrête le lot', api.completionBuyOutcome('chakra') === 'stop');
check('erreur : rate_limited arrête le lot', api.completionBuyOutcome('rate_limited') === 'stop');
check('erreur : pass_required arrête le lot', api.completionBuyOutcome('pass_required') === 'stop');
check('erreur : annonce terminée = carte ignorée', api.completionBuyOutcome('listing_closed') === 'skip');
check('erreur : notre annonce = carte ignorée', api.completionBuyOutcome('own_listing') === 'skip');
check('erreur : inconnue = erreur simple', api.completionBuyOutcome('weird_code') === 'error');
check('erreur : aucune = ok', api.completionBuyOutcome('') === 'ok');
check('erreur : liste des arrêts', api.COMPLETION_STOP_CODES.includes('market_locked'));

/* ------------------------------------------------------------------ */
/* 10. Contrôle juste avant l'achat                                   */
/* ------------------------------------------------------------------ */

const item = { characterId: '3', listingId: 'l1', price: 40 };

check('achat : annonce valide', api.completionBuyGuard(item, fixedOk, { now: NOW }).ok === true);
check('achat : prix réel renvoyé', api.completionBuyGuard(item, fixedOk, { now: NOW }).price === 40);
check('achat : annonce absente refusée', api.completionBuyGuard(item, null, { now: NOW }).code === 'listing_closed');
check('achat : annonce vendue refusée', api.completionBuyGuard(item, sold, { now: NOW }).code === 'listing_closed');
check('achat : annonce expirée refusée', api.completionBuyGuard(item, expired, { now: NOW }).code === 'listing_closed');
check('achat : notre annonce refusée', api.completionBuyGuard(item, mine, { now: NOW }).code === 'own_listing');

const raised = api.completionBuyGuard(item, { ...fixedOk, price: 180 }, { now: NOW });
check('achat : hausse de prix détectée', raised.ok === false && raised.code === 'price_changed');
check('achat : prix de la hausse renvoyé', raised.price === 180 && raised.expected === 40);

const lowered = api.completionBuyGuard(item, { ...fixedOk, price: 30 }, { now: NOW });
check('achat : baisse de prix acceptée', lowered.ok === true && lowered.price === 30);

const auctionBuy = api.completionBuyGuard({ ...item, price: 25 }, auctionBuyout, { now: NOW });
check('achat : enchère avec achat immédiat', auctionBuy.ok === true && auctionBuy.price === 25 && auctionBuy.auction === true);
check(
  'achat : enchère sans achat immédiat refusée',
  api.completionBuyGuard(item, auctionNoBuyout, { now: NOW }).code === 'listing_closed'
);
check(
  'achat : échéance dépassée malgré status actif',
  api.completionBuyGuard(item, { ...fixedOk, endsAt: new Date(NOW - 1).toISOString() }, { now: NOW }).code ===
    'listing_closed'
);
check(
  'achat : prix abaissé non bloquant',
  api.completionBuyGuard({ ...item, price: 40 }, { ...fixedOk, price: 39 }, { now: NOW }).ok === true
);

/* ------------------------------------------------------------------ */
/* 11. Filtre de raretés (masquer L / M de l'analyse)                 */
/* ------------------------------------------------------------------ */

// Catalogue dédié : Naruto a 3 C + 1 L + 1 M ; une série « Que du L » et
// une série « L possédée » pour vérifier les cas limites.
const catalogRare = [
  { id: 1, name: 'A', series: 'Naruto', rarity: 'C' },
  { id: 2, name: 'B', series: 'Naruto', rarity: 'C' },
  { id: 3, name: 'C', series: 'Naruto', rarity: 'C' },
  { id: 4, name: 'D', series: 'Naruto', rarity: 'L' },
  { id: 5, name: 'E', series: 'Naruto', rarity: 'M' },
  { id: 10, name: 'F', series: 'Que du L', rarity: 'L' },
  { id: 11, name: 'G', series: 'Que du L', rarity: 'L' },
  { id: 12, name: 'H', series: 'L possédée', rarity: 'L' },
  { id: 13, name: 'I', series: 'L possédée', rarity: 'C' }
];
const indexRare = api.completionIndex(catalogRare);
const ownedRare = [{ characterId: 1, qty: 1 }, { characterId: 4, qty: 1 }, { characterId: 12, qty: 1 }];

check('filtre : normalisation casse/espaces', api.completionRarityFilter([' l ', 'M', '', null]).size === 2);
check('filtre : liste vide', api.completionRarityFilter().size === 0);

const noFilter = api.completionProgress(indexRare, ownedRare, { minSize: 1 });
const narutoAll = noFilter.rows.find((row) => row.name === 'Naruto');
check('sans filtre : Naruto 5 cartes, 2 possédées', narutoAll.total === 5 && narutoAll.owned === 2);
check('sans filtre : Naruto 3 manquantes', narutoAll.missing === 3);
check('sans filtre : rien de masqué', noFilter.totals.hiddenCards === 0 && noFilter.totals.hideRarities.length === 0);

const onlyL = api.completionProgress(indexRare, ownedRare, { minSize: 1, hideRarities: ['L'] });
const narutoL = onlyL.rows.find((row) => row.name === 'Naruto');
check('L masquées : Naruto 4 cartes', narutoL.total === 4, `total=${narutoL.total}`);
check('L masquées : Naruto 3 manquantes', narutoL.missing === 3, `missing=${narutoL.missing}`);
check('L masquées : cartes L hors missingIds', !narutoL.missingIds.includes('4'));
check('L masquées : manquante M toujours comptée', narutoL.missingIds.includes('5'));
check('L masquées : pourcentage recalculé', narutoL.pct === 25, `pct=${narutoL.pct}`);
check('L masquées : compteur par série', narutoL.hiddenTotal === 1 && narutoL.hiddenMissing === 0);
check('L masquées : total masqué global', onlyL.totals.hiddenCards === 4, `hidden=${onlyL.totals.hiddenCards}`);
check(
  'L masquées : manquantes masquées comptées',
  onlyL.totals.hiddenMissing === 2,
  `hiddenMissing=${onlyL.totals.hiddenMissing}`
);
check('L masquées : compteur par rareté', onlyL.totals.hiddenByRarity.L === 4);
check('L masquées : périmètre exposé', onlyL.totals.hideRarities.join(',') === 'L');
check(
  'L masquées : série entièrement masquée exclue',
  !onlyL.rows.some((row) => row.name === 'Que du L'),
  JSON.stringify(onlyL.rows.map((row) => row.name))
);
check('L masquées : Naruto compte dans le total des cartes', onlyL.totals.cards === 5, `cards=${onlyL.totals.cards}`);
check(
  'L masquées : carte L possédée retirée du total de sa série',
  onlyL.rows.find((row) => row.name === 'L possédée')?.total === 1
);
check('L masquées : cartes possédées recalculées hors L', onlyL.totals.owned === 1, `owned=${onlyL.totals.owned}`);
check('L masquées : taille catalogue conservée', onlyL.rows.find((row) => row.name === 'Naruto')?.catalogTotal === 5);
check(
  'L masquées : une série reste visible malgré le seuil de taille',
  api
    .completionProgress(indexRare, ownedRare, { minSize: 5, hideRarities: ['L'] })
    .visible.some((row) => row.name === 'Naruto'),
  'Naruto (5 au catalogue, 4 visibles) doit rester listée'
);

const both = api.completionProgress(indexRare, ownedRare, { minSize: 1, hideRarities: ['L', 'M'] });
const narutoLM = both.rows.find((row) => row.name === 'Naruto');
check('L+M masquées : Naruto 3 cartes', narutoLM.total === 3, `total=${narutoLM.total}`);
check('L+M masquées : Naruto 2 manquantes', narutoLM.missing === 2);
check('L+M masquées : pourcentage 33,3', narutoLM.pct === 33.3, `pct=${narutoLM.pct}`);
check('L+M masquées : plus aucune manquante L ni M', !narutoLM.missingIds.includes('4') && !narutoLM.missingIds.includes('5'));
check('L+M masquées : périmètre ordonné', both.totals.hideRarities.join(',') === 'L,M');
check('L+M masquées : masquage par rareté ventilé', both.totals.hiddenByRarity.L === 4 && both.totals.hiddenByRarity.M === 1);

// Toutes les manquantes restantes sont masquées : cas de l'état vide.
const onlyHiddenMissing = api.completionProgress(
  api.completionIndex([
    { id: 1, name: 'A', series: 'Solo', rarity: 'C' },
    { id: 2, name: 'B', series: 'Solo', rarity: 'L' }
  ]),
  [{ characterId: 1, qty: 1 }],
  { minSize: 1, hideRarities: ['L'] }
);
check('état vide : série complète après masquage', onlyHiddenMissing.totals.missing === 0);
check('état vide : manquantes masquées comptées', onlyHiddenMissing.totals.hiddenMissing === 1);
check('état vide : aucune série incomplète', onlyHiddenMissing.totals.incomplete === 0);

// Une carte masquée n'est jamais proposée à l'achat : le marché ne la voit pas.
api.completionApplyMarket(
  both.rows,
  api.completionMarket(
    [
      { id: 'x1', characterId: 4, type: 'fixed', price: 100, status: 'active', endsAt: inHours(4) },
      { id: 'x2', characterId: 2, type: 'fixed', price: 7, status: 'active', endsAt: inHours(4) }
    ],
    { now: NOW }
  )
);
check('marché : annonce d’une carte masquée ignorée', narutoLM.dispo === 1 && narutoLM.dispoIds.join(',') === '2');
check('marché : coût limité aux cartes visibles', narutoLM.cost === 7);

console.log(`${checks} contrôles · ${failures} échec(s)`);
if (failures) process.exit(1);
