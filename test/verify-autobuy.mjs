// Vérifie la logique pure de l'onglet Auto-Achat (objectif Éveil) :
// statut Renaissance, déficits par rareté, lignes manquantes, filtres, tris,
// file d'achats, plafonds, garde-fous et progression après achat.
// Les blocs COMPLETION et AUTOBUY sont extraits de content/ui.js.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(join(ROOT, 'content/ui.js'), 'utf8');
const begin = source.indexOf('/* COMPLETION:BEGIN');
const end = source.indexOf('/* AUTOBUY:END */');
if (begin < 0 || end < 0) {
  console.error('Marqueurs COMPLETION:BEGIN / AUTOBUY:END introuvables dans content/ui.js');
  process.exit(1);
}

const api = new Function(`${source.slice(begin, end)}
  return {
    AUTOBUY_SORTS,
    AUTOBUY_SORT_KEYS,
    AUTOBUY_CARD_REQUIREMENTS,
    AUTOBUY_PLAN_MAX,
    completionIndex,
    completionOwnedMap,
    completionProgress,
    autobuyStatusFrom,
    autobuyDeriveStatus,
    autobuyStatusPurchase,
    autobuyListingOffer,
    autobuyMergeOffers,
    autobuyBuildRows,
    autobuyFilterRows,
    autobuySortRows,
    autobuyEstimateCost,
    autobuyPlan,
    autobuyGuard,
    autobuyBuyOutcome,
    autobuyFailureText
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
const iso = (day) => new Date(`2026-10-0${day}T12:00:00.000Z`).toISOString();

/* ------------------------------------------------------------------ */
/* 1. Statut Renaissance : rien d’inventé                              */
/* ------------------------------------------------------------------ */

const statusRaw = {
  level: 0,
  next: 1,
  renown: 500,
  eligible: false,
  requirements: [
    { key: 'C', have: 3, need: 5, ok: false },
    { key: 'U', have: 1, need: 3, ok: false },
    { key: 'R', have: 2, need: 2, ok: true },
    { key: 'E', have: 0, need: 2, ok: false },
    { key: 'legendaries', have: 0, need: 2, ok: false },
    { key: 'mythics', have: 0, need: 1, ok: false },
    { key: 'boosters', have: 10, need: 50, ok: false },
    { key: 'wait', have: 2, need: 7, ok: false },
    { key: 'discord', have: 1, need: 0, ok: true },
    { key: 'escrow', have: 0, need: 0, ok: false }
  ]
};

const status = api.autobuyStatusFrom(statusRaw);
check('statut : actif', status.active === true);
check('statut : 10 prérequis', status.requirements.length === 10, String(status.requirements.length));
check('statut : pourcentage officiel 34 %', status.pct === 34, String(status.pct));
check('statut : conditions remplies 2/10', status.conditionsMet === 2 && status.conditionsTotal === 10);
check('statut : déficit total 9', status.remaining === 9, String(status.remaining));
check('statut : déficit C = 2', status.gaps.C.gap === 2);
check('statut : déficit U = 2', status.gaps.U.gap === 2);
check('statut : R complet', status.gaps.R.gap === 0);
check('statut : E = 2', status.gaps.E.gap === 2);
check('statut : L = 2', status.gaps.L.gap === 2);
check('statut : M = 1', status.gaps.M.gap === 1);
check('statut : gain C = 100/(10×5)', Math.abs(status.gaps.C.gainPct - 2) < 1e-9, String(status.gaps.C.gainPct));
check('statut : gain M = 100/(10×1)', Math.abs(status.gaps.M.gainPct - 10) < 1e-9, String(status.gaps.M.gainPct));
check('statut : libellé légendaires', status.gaps.L.label === 'Légendaires différentes');
check('statut : libellé autres', status.requirements.find((r) => r.key === 'boosters').label === 'Boosters ouverts dans ce cycle');

const empty = api.autobuyStatusFrom({ requirements: [] });
check('statut vide : inactif', empty.active === false);
check('statut vide : pourcentage nul', empty.pct === null);
check('statut vide : déficit inconnu', empty.remaining === null);
check('statut null : inactif', api.autobuyStatusFrom(null).active === false);

/* Progression immédiate après achat simulé. */
const afterC = api.autobuyStatusPurchase(status, 'C', 1);
check('achat C : have +1', afterC.gaps.C.have === 4);
check('achat C : déficit 1', afterC.gaps.C.gap === 1);
check('achat C : total restant 8', afterC.remaining === 8);
check('achat C : progression monte', afterC.pct > status.pct);
const afterC2 = api.autobuyStatusPurchase(afterC, 'C', 5);
check('achat C : plafonné au besoin', afterC2.gaps.C.have === 5 && afterC2.gaps.C.gap === 0);
check('achat C : ok devient vrai', afterC2.gaps.C.ok === true);
const afterR = api.autobuyStatusPurchase(status, 'R', 3);
check('achat R complet : aucun changement de déficit', afterR.gaps.R.gap === 0 && afterR.remaining === status.remaining);
check('statut d’origine non muté', status.gaps.C.have === 3);

/* ------------------------------------------------------------------ */
/* 2. Catalogue, possession et lignes manquantes                       */
/* ------------------------------------------------------------------ */

const catalog = [
  { id: 1, name: 'Alpha un', series: 'Alpha', rarity: 'C' },
  { id: 2, name: 'Alpha deux', series: 'Alpha', rarity: 'U' },
  { id: 3, name: 'Alpha trois', series: 'Alpha', rarity: 'C' },
  { id: 4, name: 'Alpha quatre', series: 'Alpha', rarity: 'U' },
  { id: 5, name: 'Beta cinq', series: 'Beta', rarity: 'L' },
  { id: 6, name: 'Beta six', series: 'Beta', rarity: 'R' },
  { id: 7, name: 'Beta sept', series: 'Beta', rarity: 'E' },
  { id: 8, name: 'Beta huit', series: 'Beta', rarity: 'C' },
  { id: 9, name: 'Gamma neuf', series: 'Gamma', rarity: 'M' },
  { id: 10, name: 'Gamma dix', series: 'Gamma', rarity: 'E' },
  { id: 11, name: 'Gamma onze', series: 'Gamma', rarity: 'L' },
  { id: 12, name: 'Gamma douze', series: 'Gamma', rarity: 'U' }
];
const collection = [
  { characterId: 1, qty: 2 },
  { characterId: 2, qty: 1 }
];
const index = api.completionIndex(catalog);
const progress = api.completionProgress(index, collection, { minSize: 0 });

const offers = new Map();
const addOffer = (characterId, listingId, price, options = {}) => {
  const list = offers.get(String(characterId)) ?? [];
  list.push({
    listingId,
    characterId: String(characterId),
    price,
    auction: false,
    seller: options.seller ?? 'vendeur',
    endsAt: options.endsAt ?? new Date(NOW + 6 * 3600e3).toISOString(),
    createdAt: options.createdAt ?? iso(1),
    sales7d: options.sales7d ?? null
  });
  offers.set(String(characterId), list);
};
addOffer(1, 'own-1', 1);          // possédée : ne doit jamais apparaître
addOffer(3, 'l-3', 10, { sales7d: 4, createdAt: iso(1) });
addOffer(4, 'l-4', 30, { sales7d: 10, createdAt: iso(3) });
addOffer(5, 'l-5', 100, { sales7d: 2, createdAt: iso(2) });
addOffer(6, 'l-6', 5, { sales7d: 1 });   // R sans déficit
addOffer(7, 'l-7', 12, { sales7d: 1, createdAt: iso(4) });
addOffer(9, 'l-9', 500, { sales7d: 0, createdAt: iso(5) });

const rows = api.autobuyBuildRows({ index, progress, owned: api.completionOwnedMap(collection), status, offers });
check('lignes : 10 cartes manquantes', rows.length === 10, String(rows.length));
check('lignes : la carte possédée est exclue', !rows.some((row) => row.id === '1'));
check('lignes : carte manquante disponible présente', rows.find((row) => row.id === '3')?.best?.listingId === 'l-3');
check('lignes : déficit C sur carte C', rows.find((row) => row.id === '3')?.useful === true);
check('lignes : rareté complète = non utile', rows.find((row) => row.id === '6')?.useful === false);
check('lignes : gain Éveil par carte', Math.abs(rows.find((row) => row.id === '9').gainPct - 10) < 1e-9);
check('lignes : ventes 7 j lues', rows.find((row) => row.id === '4')?.sales7d === 10);
check('lignes : date d’annonce conservée', rows.find((row) => row.id === '3')?.createdAt === iso(1));
check('lignes : série complétée à 50 %', rows.find((row) => row.id === '3')?.seriesPct === 50);
check('lignes : sans annonce = prix null', rows.find((row) => row.id === '8')?.price === null);
check('lignes : offres multiples conservées', rows.find((row) => row.id === '3')?.count === 1);

/* ------------------------------------------------------------------ */
/* 3. Filtres                                                         */
/* ------------------------------------------------------------------ */

const hasStatus = true;
const baseFilter = { query: '', rarity: 'all', series: '', maxPrice: 0, dispoOnly: false, incompleteOnly: false, hideL: false, hideM: false, eveilOnly: true };
const filtered = api.autobuyFilterRows(rows, baseFilter, { hasStatus });
check('filtre : Éveil uniquement garde 9 cartes', filtered.length === 9, String(filtered.length));
check('filtre : rareté complète exclue', !filtered.some((row) => row.id === '6'));
check('filtre : disponible uniquement', api.autobuyFilterRows(rows, { ...baseFilter, dispoOnly: true }, { hasStatus }).length === 5);
check('filtre : rareté M', api.autobuyFilterRows(rows, { ...baseFilter, rarity: 'M' }, { hasStatus }).length === 1);
check('filtre : prix max', api.autobuyFilterRows(rows, { ...baseFilter, maxPrice: 15 }, { hasStatus }).length === 2);
check('filtre : masquer légendaires', !api.autobuyFilterRows(rows, { ...baseFilter, hideL: true }, { hasStatus }).some((row) => row.rarity === 'L'));
check('filtre : masquer mythiques', api.autobuyFilterRows(rows, { ...baseFilter, hideM: true }, { hasStatus }).length === 8);
check('filtre : série exacte', api.autobuyFilterRows(rows, { ...baseFilter, series: 'Beta' }, { hasStatus }).length === 3);
check('filtre : recherche par nom', api.autobuyFilterRows(rows, { ...baseFilter, query: 'Gamma' }, { hasStatus }).length === 4);
check('filtre : sans statut, le filtre Éveil est inactif', api.autobuyFilterRows(rows, baseFilter, { hasStatus: false }).length === 10);

/* ------------------------------------------------------------------ */
/* 4. Tris                                                            */
/* ------------------------------------------------------------------ */

const ids = (list) => list.map((row) => row.id);
const withOffers = filtered.filter((row) => row.best);
const eveil = api.autobuySortRows(withOffers, 'eveil', { hasStatus });
check(
  'tri Priorité Éveil : M, E, L, U, C',
  JSON.stringify(ids(eveil)) === JSON.stringify(['9', '7', '5', '4', '3']),
  JSON.stringify(ids(eveil))
);
check('tri Prix croissant', JSON.stringify(ids(api.autobuySortRows(withOffers, 'price_asc', { hasStatus }))) === JSON.stringify(['3', '7', '4', '5', '9']));
check('tri Prix décroissant', JSON.stringify(ids(api.autobuySortRows(withOffers, 'price_desc', { hasStatus }))) === JSON.stringify(['9', '5', '4', '7', '3']));
check('tri Rareté : M,L,E,U,C', JSON.stringify(ids(api.autobuySortRows(withOffers, 'rarity', { hasStatus }))) === JSON.stringify(['9', '5', '7', '4', '3']));
check('tri Ventes 7 j', JSON.stringify(ids(api.autobuySortRows(withOffers, 'sales_desc', { hasStatus }))) === JSON.stringify(['4', '3', '5', '7', '9']));
check('tri Date d’apparition', JSON.stringify(ids(api.autobuySortRows(withOffers, 'newest', { hasStatus }))) === JSON.stringify(['9', '7', '4', '5', '3']));
check('tri Série', JSON.stringify(ids(api.autobuySortRows(withOffers, 'series', { hasStatus }))) === JSON.stringify(['4', '3', '5', '7', '9']));
check('tri Complétion série : Alpha d’abord', api.autobuySortRows(withOffers, 'series_pct', { hasStatus })[0].series === 'Alpha');
check('tri Rapport progression/prix : E d’abord', api.autobuySortRows(withOffers, 'ratio', { hasStatus })[0].id === '7');
check('tri inconnu : repli sur Éveil', api.autobuySortRows(withOffers, 'inconnu', { hasStatus })[0].id === '9');
const noStatusSorted = api.autobuySortRows(rows, 'eveil', { hasStatus: false });
check('sans statut : repli sur complétion de série', noStatusSorted[0].series === 'Alpha', noStatusSorted[0].series);

/* ------------------------------------------------------------------ */
/* 5. Coût estimé                                                     */
/* ------------------------------------------------------------------ */

const estimate = api.autobuyEstimateCost(rows, status);
check('coût : 5 cartes connues', estimate.count === 5, String(estimate.count));
check('coût : total 652', estimate.total === 652, String(estimate.total));
check('coût : déficit voulu 9', estimate.wanted === 9);
check('coût : 4 manquantes sans annonce', estimate.partial === 4);
const estimateE = api.autobuyEstimateCost(filtered.filter((row) => row.rarity === 'E'), status);
check('coût filtré : E seulement', estimateE.count === 1 && estimateE.total === 12 && estimateE.wanted === 2 && estimateE.partial === 1);
const estimatePrep = api.autobuyEstimateCost(rows, null);
check('coût préparation : 6 cartes avec annonce', estimatePrep.count === 6, String(estimatePrep.count));
check('coût préparation : total 657', estimatePrep.total === 657, String(estimatePrep.total));

/* ------------------------------------------------------------------ */
/* 6. File d’achats et plafonds                                       */
/* ------------------------------------------------------------------ */

const queue = api.autobuyPlan(eveil, { status });
check('file : 5 cartes', queue.count === 5, String(queue.count));
check('file : une seule fois par carte', new Set(queue.items.map((item) => item.characterId)).size === queue.count);
check('file : total 652', queue.total === 652);
check('file : déficit restant 4', queue.gapsLeft === 4);
check('file : raison vide si tout passe', queue.reason === null || queue.reason === 'limit', String(queue.reason));

const capped = api.autobuyPlan(eveil, { status, cap: 150 });
check('plafond : total ≤ 150', capped.total <= 150, String(capped.total));
check('plafond : la carte à 500 est écartée', !capped.items.some((item) => item.characterId === '9'));
check('plafond : 3 cartes achetables', capped.count === 3, String(capped.count));
check('plafond : arrêt motivé', capped.reason === 'cap', String(capped.reason));

const unit = api.autobuyPlan(eveil, { status, maxUnit: 50 });
check('prix unitaire : aucun au-dessus de 50', unit.items.every((item) => item.price <= 50));
check('prix unitaire : 3 cartes', unit.count === 3, String(unit.count));

const chakra = api.autobuyPlan(eveil, { status, chakra: 20 });
check('chakra : total ≤ 20', chakra.total <= 20, String(chakra.total));
check('chakra : une seule carte à 12', chakra.count === 1 && chakra.total === 12);
check('chakra : arrêt motivé', chakra.reason === 'chakra', String(chakra.reason));

const limited = api.autobuyPlan(eveil, { status, maxItems: 2 });
check('limite de file : 2 cartes', limited.count === 2);
check('limite de file : raison limit', limited.reason === 'limit');

const doneStatus = api.autobuyStatusFrom({
  requirements: status.requirements.map((req) => ({ ...req, have: req.need, ok: true }))
});
check('file terminée : déficit nul', doneStatus.remaining === 0);
const doneQueue = api.autobuyPlan(eveil, { status: doneStatus });
check('file terminée : aucune carte', doneQueue.count === 0 && doneQueue.reason === 'empty');

/* ------------------------------------------------------------------ */
/* 7. Garde-fous d’achat                                              */
/* ------------------------------------------------------------------ */

const item = { characterId: '3', listingId: 'l-3', price: 10 };
const active = {
  id: 'l-3',
  characterId: '3',
  type: 'fixed',
  price: 10,
  status: 'active',
  endsAt: new Date(NOW + 3600e3).toISOString(),
  seller: { id: 'other', pseudo: 'Autre' }
};
check('garde-fou : annonce active acceptée', api.autobuyGuard(item, active, { now: NOW, userId: 'me' }).ok === true);
check('garde-fou : annonce absente', api.autobuyGuard(item, null, { now: NOW }).code === 'listing_closed');
check('garde-fou : annonce vendue', api.autobuyGuard(item, { ...active, status: 'sold' }, { now: NOW }).code === 'listing_closed');
check('garde-fou : annonce expirée', api.autobuyGuard(item, { ...active, endsAt: new Date(NOW - 1000).toISOString() }, { now: NOW }).code === 'listing_closed');
check('garde-fou : notre annonce', api.autobuyGuard(item, { ...active, isMine: true }, { now: NOW }).code === 'own_listing');
check('garde-fou : vendeur = soi', api.autobuyGuard(item, { ...active, seller: { id: 'me' } }, { now: NOW, userId: 'me' }).code === 'own_listing');
check('garde-fou : mauvaise carte', api.autobuyGuard(item, { ...active, characterId: '4' }, { now: NOW }).code === 'wrong_card');
check('garde-fou : prix monté', api.autobuyGuard(item, { ...active, price: 12 }, { now: NOW }).code === 'price_changed');
check('garde-fou : prix baissé accepté', api.autobuyGuard(item, { ...active, price: 8 }, { now: NOW }).price === 8);
check('garde-fou : plafond unitaire', api.autobuyGuard(item, { ...active, price: 10 }, { now: NOW, maxUnit: 9 }).code === 'unit_cap');
check('garde-fou : enchère avec achat immédiat', api.autobuyGuard(item, { ...active, type: 'auction', price: 1, buyoutPrice: 10 }, { now: NOW }).ok === true);
check('garde-fou : enchère sans achat immédiat', api.autobuyGuard(item, { ...active, type: 'auction', price: 1 }, { now: NOW }).code === 'listing_closed');
check('garde-fou : mauvais identifiant d’annonce ignoré', api.autobuyGuard(item, { ...active, id: 'autre' }, { now: NOW }).ok === true);

check('erreur chakra : arrêt', api.autobuyBuyOutcome('chakra') === 'stop');
check('erreur annonce fermée : carte ignorée', api.autobuyBuyOutcome('listing_closed') === 'skip');
check('erreur prix changé : carte ignorée', api.autobuyBuyOutcome('price_changed') === 'skip');
check('erreur inconnue : arrêt prudent', api.autobuyBuyOutcome('boom') === 'error');
check('texte lisible : plafond', api.autobuyFailureText('unit_cap', { price: 12 }).includes('12'));

/* ------------------------------------------------------------------ */
/* 8. Fusion d’annonces                                               */
/* ------------------------------------------------------------------ */

const listings = [
  { id: 'a', characterId: 3, type: 'fixed', price: 12, status: 'active', createdAt: iso(2), prices: { sales7d: 3 }, seller: { id: 'x', pseudo: 'X' } },
  { id: 'b', characterId: 3, type: 'fixed', price: 8, status: 'active', createdAt: iso(3), prices: { sales7d: 7 }, seller: { id: 'y', pseudo: 'Y' } },
  { id: 'a', characterId: 3, type: 'fixed', price: 12, status: 'active', createdAt: iso(2) },
  { id: 'c', characterId: 4, type: 'auction', price: 2, status: 'active' },
  { id: 'd', characterId: 4, type: 'auction', price: 2, buyoutPrice: 20, status: 'active', seller: { id: 'z', pseudo: 'Z' } },
  { id: 'e', characterId: 5, type: 'fixed', price: 10, status: 'sold' },
  { id: 'f', characterId: 5, type: 'fixed', price: 10, status: 'active', isMine: true },
  { id: 'g', characterId: 6, type: 'fixed', price: 10, status: 'active', seller: { id: 'me', pseudo: 'Moi' } },
  { id: 'h', characterId: 7, type: 'fixed', price: 10, status: 'active', endsAt: new Date(NOW - 5000).toISOString() }
];
const merged = api.autobuyMergeOffers(new Map(), listings, { now: NOW, includeAuctions: true, userId: 'me' });
check('fusion : carte 3 groupée', merged.get('3')?.length === 2);
check('fusion : doublon d’annonce ignoré', new Set((merged.get('3') ?? []).map((offer) => offer.listingId)).size === 2);
check('fusion : moins chère d’abord', merged.get('3')?.[0].price === 8);
check('fusion : ventes 7 j conservées', merged.get('3')?.[0].sales7d === 7);
check('fusion : enchère sans achat immédiat exclue', !(merged.get('4') ?? []).some((offer) => offer.listingId === 'c'));
check('fusion : enchère avec achat immédiat retenue', (merged.get('4') ?? []).some((offer) => offer.listingId === 'd'));
check('fusion : annonce vendue exclue', !merged.has('5'));
check('fusion : notre annonce exclue', !merged.has('6'));
check('fusion : annonce expirée exclue', !merged.has('7'));

/* ------------------------------------------------------------------ */
/* 9. Stabilité des filtres et tris                                    */
/* ------------------------------------------------------------------ */

const shuffled = [...rows].sort(() => 0.5 - Math.random());
const a1 = ids(api.autobuySortRows(api.autobuyFilterRows(rows, baseFilter, { hasStatus }), 'eveil', { hasStatus }));
const a2 = ids(api.autobuySortRows(api.autobuyFilterRows(shuffled, baseFilter, { hasStatus }), 'eveil', { hasStatus }));
check('tri stable : même ordre après mélange', JSON.stringify(a1) === JSON.stringify(a2));
check('liste des tris : Priorité Éveil recommandée en premier', api.AUTOBUY_SORTS[0][0] === 'eveil' && api.AUTOBUY_SORTS[0][1].includes('recommandé'));
check('liste des tris : 9 modes', api.AUTOBUY_SORTS.length === 9);
check('liste des tris : ventes 7 j présente', api.AUTOBUY_SORT_KEYS.includes('sales_desc'));
check('liste des tris : complétion de série présente', api.AUTOBUY_SORT_KEYS.includes('series_pct'));
check('liste des tris : date d’apparition présente', api.AUTOBUY_SORT_KEYS.includes('newest'));

/* ------------------------------------------------------------------ */

console.log(`Contrôles : ${checks} · échecs : ${failures}`);
process.exit(failures ? 1 : 0);
