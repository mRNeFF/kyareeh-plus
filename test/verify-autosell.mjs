// Vérifie la sélection pure de la vente auto des doublons.
// Le bloc AUTOSELL est extrait de content/ui.js : aucune dépendance DOM/réseau.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(join(ROOT, 'content/ui.js'), 'utf8');
const begin = source.indexOf('/* AUTOSELL:BEGIN');
const end = source.indexOf('/* AUTOSELL:END */');
if (begin < 0 || end < 0) {
  console.error('Marqueurs AUTOSELL:BEGIN / AUTOSELL:END introuvables dans content/ui.js');
  process.exit(1);
}

const api = new Function(`${source.slice(begin, end)}
  return {
    autoSellSpare,
    autoSellEligible,
    autoSellSelect,
    autoSellRank,
    autoSellVolumeInfo,
    autoSellBuildPlan,
    autoSellStrategyPrice,
    autoSellListingRows,
    autoSellHasListings,
    autoSellListingIsActive,
    autoSellListingQty,
    autoSellListingPrice,
    autoSellListingTotal,
    autoSellActiveQtyByKey,
    autoSellActiveQtyFor,
    autoSellRelistPrice,
    autoSellRelistCheck,
    autoSellRelistEnqueue
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

const row = (over = {}) => ({
  id: '1',
  name: 'Carte',
  rarity: 'C',
  qty: 2,
  listable: 2,
  lockedQty: 0,
  price: 10,
  pinned: false,
  sellBlock: null,
  block: null,
  ...over
});

check('doublon simple : garde 1 copie', api.autoSellSpare(row({ qty: 3, listable: 3 })) === 2);
check('copie unique : rien à vendre', api.autoSellSpare(row({ qty: 1, listable: 1 })) === 0);
check('listable limité : respecte le serveur', api.autoSellSpare(row({ qty: 5, listable: 2 })) === 2);
check('listable absent : retire les verrouillées', api.autoSellSpare(row({ qty: 5, listable: null, lockedQty: 2 })) === 3);
check('tout verrouillé : rien à vendre', api.autoSellSpare(row({ qty: 5, listable: 0 })) === 0);
check('copie déjà en vente réservée', api.autoSellSpare(row({ qty: 4, listable: 3 }), 1) === 2);
check('deux copies déjà en vente réservées', api.autoSellSpare(row({ qty: 5, listable: 4 }), 2) === 2);
check('dernière copie jamais vendue avec une annonce active', api.autoSellSpare(row({ qty: 2, listable: 1 }), 1) === 0);
check('quantité active supérieure au stock : zéro', api.autoSellSpare(row({ qty: 3, listable: 2 }), 9) === 0);

// Le prix unitaire prime : un lot de 2 × 12 ne doit jamais passer devant une carte à 20.
const base = [
  row({ id: 'ganyu', name: 'Ganyu', price: 12, qty: 3, listable: 2 }),
  row({ id: 'chere', name: 'Chère', price: 100, qty: 2, listable: 1 }),
  row({ id: 'moyenne', name: 'Moyenne', price: 50, qty: 2, listable: 1 })
];
const selected = api.autoSellSelect(base, {});
check('tri par prix unitaire, pas par total du lot', selected[0]?.id === 'chere' && selected[1]?.id === 'moyenne', selected.map((r) => r.id).join(','));
check(
  'un lot à 2 × 12 ne passe pas devant une carte à 20',
  api.autoSellSelect(
    [
      row({ id: 'lot', price: 12, qty: 3, listable: 2 }),
      row({ id: 'unite', price: 20, qty: 2, listable: 1 })
    ],
    {}
  )[0]?.id === 'unite'
);
check('autoQty exposé', selected[0]?.autoQty === 1, String(selected[0]?.autoQty));
const ascending = api.autoSellSelect(base, { order: 'price_asc' });
check('ordre croissant', ascending[0]?.id === 'ganyu' && ascending[2]?.id === 'chere', ascending.map((r) => r.id).join(','));

check('pinned exclu', api.autoSellSelect([row({ pinned: true })], {}).length === 0);
check('revente bloquée exclue', api.autoSellSelect([row({ sellBlock: 'resale_lock' })], {}).length === 0);
check('blocage générique exclu', api.autoSellSelect([row({ block: { reason: 'x' } })], {}).length === 0);
check('M exclue par défaut', api.autoSellSelect([row({ rarity: 'M' })], {}).length === 0);
check('L incluse automatiquement', api.autoSellSelect([row({ rarity: 'L' })], {}).length === 1);
check('M incluse si demandé', api.autoSellSelect([row({ rarity: 'M' })], { includeM: true }).length === 1);
check('prix nul exclu', api.autoSellSelect([row({ price: 0 })], {}).length === 0);
check('prix absent exclu', api.autoSellSelect([row({ price: null })], {}).length === 0);

// Ventes actives : lecture tolérante de la réponse, états et quantités.
const now = Date.now();
const mine = {
  listings: [
    { id: 'l1', characterId: 'ganyu', character: { name: 'Ganyu' }, status: 'active', qty: 2, price: 12 },
    { id: 'l2', characterId: 'chere', status: 'sold', qty: 1, price: 100 },
    { id: 'l3', characterId: 'expiree', status: 'active', price: 30, endsAt: new Date(now - 1000).toISOString() },
    { id: 'l4', characterId: 'attente', status: 'pending', price: 8 },
    { id: 'l5', characterId: 'sans-prix', status: 'active', qty: 3 }
  ]
};
check('réponse marché reconnue', api.autoSellHasListings(mine) === true);
check('réponse vide reconnue', api.autoSellHasListings({ listings: [] }) === true);
check('réponse sans liste refusée', api.autoSellHasListings({ buyOrders: [] }) === false);
check('liste extraite', api.autoSellListingRows(mine).length === 5);
check('annonce vendue inactive', api.autoSellListingIsActive(mine.listings[1], now) === false);
check('annonce expirée inactive', api.autoSellListingIsActive(mine.listings[2], now) === false);
check('annonce active', api.autoSellListingIsActive(mine.listings[0], now) === true);
check('annonce en attente considérée active', api.autoSellListingIsActive(mine.listings[3], now) === true);
check('quantité par défaut = 1', api.autoSellListingQty({}) === 1);
check('quantité lue', api.autoSellListingQty(mine.listings[0]) === 2);
check('prix unitaire lu', api.autoSellListingPrice(mine.listings[0]) === 12);
check('total calculé', api.autoSellListingTotal(mine.listings[0]) === 24);
const activeQty = api.autoSellActiveQtyByKey(mine.listings, now);
check('quantité active additionnée par carte', activeQty.byId.get('ganyu') === 2, String(activeQty.byId.get('ganyu')));
check(
  'quantité active retrouvée par id ou nom',
  api.autoSellActiveQtyFor({ id: 'ganyu', name: 'Ganyu' }, activeQty) === 2 &&
    api.autoSellActiveQtyFor({ id: 'inconnue', name: 'Ganyu' }, activeQty) === 0
);
const withoutId = api.autoSellActiveQtyByKey(
  [{ status: 'active', qty: 1, character: { name: 'Sans identifiant' } }],
  now
);
check(
  'nom utilisé seulement si l’annonce n’a pas d’identifiant',
  api.autoSellActiveQtyFor({ id: 'un-autre', name: 'Sans identifiant' }, withoutId) === 1
);
check('carte vendue non réservée', api.autoSellActiveQtyFor({ id: 'chere', name: 'Chère' }, activeQty) === 0);
check(
  'le stock vendable déduit les copies déjà en vente',
  api.autoSellSpare(
    { qty: 4, listable: 3, characterId: 'ganyu', name: 'Ganyu' },
    api.autoSellActiveQtyFor({ id: 'ganyu', name: 'Ganyu' }, activeQty)
  ) === 1
);

const withActive = [
  row({ id: 'ganyu', name: 'Ganyu', price: 100, qty: 4, listable: 3, activeQty: 1 }),
  row({ id: 'libre', name: 'Libre', price: 10 })
];
const quantityAware = api.autoSellSelect(withActive, {});
check(
  'une copie active ne bloque pas les autres exemplaires',
  quantityAware[0]?.id === 'ganyu' && quantityAware[0]?.autoQty === 2,
  quantityAware.map((r) => `${r.id}:${r.autoQty}`).join(',')
);
check(
  'prix connu requis pour le tri',
  api.autoSellEligible(row({ price: null }), { requirePrice: true }) === false &&
    api.autoSellEligible(row({ price: null }), { requirePrice: false }) === true
);

const candidates = [
  row({ id: 'a', name: 'A', price: 10, autoQty: 5 }),
  row({ id: 'b', name: 'B', price: 100, autoQty: 5 })
];
const plan = api.autoSellBuildPlan(candidates, { slots: 3 });
check('plan limité par les places', plan.reduce((n, r) => n + r.qty, 0) === 3);
check('plan limité à 10 places', api.autoSellBuildPlan(candidates, { slots: 99 }).reduce((n, r) => n + r.qty, 0) === 10);
check('plan limité par les places libres', api.autoSellBuildPlan(candidates, { slots: 2 }).reduce((n, r) => n + r.qty, 0) === 2);
check(
  'plan répartit sur plusieurs cartes',
  api.autoSellBuildPlan(
    [
      row({ id: 'a', price: 10, autoQty: 2 }),
      row({ id: 'b', price: 100, autoQty: 3 })
    ],
    { slots: 4 }
  ).length === 2
);
check('plan vide sans place', api.autoSellBuildPlan(candidates, { slots: 0 }).length === 0);

const rec = {
  quick: { price: 10 },
  balanced: { price: 20 },
  max: { price: 35 }
};
check('stratégie rapide', api.autoSellStrategyPrice(rec, 'quick') === 10);
check('stratégie équilibrée', api.autoSellStrategyPrice(rec, 'balanced') === 20);
check('stratégie maximale', api.autoSellStrategyPrice(rec, 'max') === 35);
check('prix estimé refusé', api.autoSellStrategyPrice({ ...rec, estimated: true }, 'max') === null);
check('prix absurde refusé', api.autoSellStrategyPrice({ max: { price: 0 } }, 'max') === null);

// --- Classement optimisé : prix + ventes sur 7 jours -------------------
const H = 3600 * 1000;
const scoredRow = (over) => row({ sales7dAt: now, ...over });

const example = api.autoSellSelect(
  [
    scoredRow({ id: 'e', name: 'E', price: 15, sales7d: 100 }),
    scoredRow({ id: 'x', name: 'X', price: 10, sales7d: 10000 })
  ],
  { order: 'score', now }
);
check(
  'optimisé : une carte chère peu demandée passe derrière une carte liquide',
  example[0]?.id === 'x',
  example.map((r) => `${r.id}:${r.rank?.score}`).join(',')
);
check(
  'optimisé : score, volume et rang exposés',
  Number.isFinite(example[0]?.rank?.score) &&
    example[0]?.volume7 === 10000 &&
    example[0]?.rank?.position === 1 &&
    example[1]?.rank?.position === 2,
  JSON.stringify(example[0]?.rank)
);
check(
  'optimisé : scores bornés à 0–100',
  example.every((r) => r.rank.score >= 0 && r.rank.score <= 100),
  example.map((r) => r.rank.score).join(',')
);
check(
  'optimisé : le prix départage une liquidité comparable',
  api.autoSellSelect(
    [
      scoredRow({ id: 'cher', name: 'Cher', price: 15, sales7d: 100 }),
      scoredRow({ id: 'moins', name: 'Moins', price: 14, sales7d: 100 })
    ],
    { order: 'score', now }
  )[0]?.id === 'cher'
);
check(
  'optimisé : faible volume rétrogradé malgré un prix très supérieur',
  api.autoSellSelect(
    [
      scoredRow({ id: 'chere-peu', name: 'Chère peu demandée', price: 5000, sales7d: 1 }),
      scoredRow({ id: 'moins-chere', name: 'Moins chère demandée', price: 4000, sales7d: 50 })
    ],
    { order: 'score', now }
  )[0]?.id === 'moins-chere'
);
check(
  'optimisé : volume inconnu = comportement conservateur',
  api.autoSellSelect(
    [
      scoredRow({ id: 'inconnu', name: 'Inconnu', price: 1000, sales7d: null }),
      scoredRow({ id: 'connu', name: 'Connu', price: 10, sales7d: 5 })
    ],
    { order: 'score', now }
  )[0]?.id === 'connu'
);
check(
  'optimisé : score plafonné à 30 sans volume exploitable',
  api.autoSellSelect(
    [scoredRow({ id: 'inconnu', name: 'Inconnu', price: 1000, sales7d: null })],
    { order: 'score', now }
  )[0]?.rank.score === 30
);
check(
  'optimisé : volume périmé ignoré',
  api.autoSellSelect(
    [
      scoredRow({ id: 'vieux', name: 'Vieux', price: 1000, sales7d: 9000, sales7dAt: now - 7 * 24 * H }),
      scoredRow({ id: 'frais', name: 'Frais', price: 10, sales7d: 5 })
    ],
    { order: 'score', now }
  )[0]?.id === 'frais'
);
check('volume 7 j absent', api.autoSellVolumeInfo({}, { now }).status === 'missing');
check(
  'volume 7 j sans date traité comme périmé',
  api.autoSellVolumeInfo({ sales7d: 12 }, { now }).status === 'stale'
);
check(
  'volume 7 j trop ancien marqué périmé',
  api.autoSellVolumeInfo({ sales7d: 12, sales7dAt: now - 7 * H }, { now }).status === 'stale'
);
check(
  'volume 7 j récent accepté',
  api.autoSellVolumeInfo({ sales7d: 12, sales7dAt: now - H }, { now }).status === 'ok'
);
const fallback = api.autoSellSelect(base, { order: 'score' });
check(
  'sans aucun volume connu : repli sur le prix',
  fallback[0]?.id === 'chere' && fallback[1]?.id === 'moyenne',
  fallback.map((r) => r.id).join(',')
);
check(
  'optimisé : filtres de sécurité conservés',
  api.autoSellSelect(
    [scoredRow({ id: 'p', pinned: true, sales7d: 10 }), scoredRow({ id: 'm', rarity: 'M', sales7d: 10 })],
    { order: 'score', now }
  ).length === 0
);
const quantityRank = api.autoSellSelect(
  [
    scoredRow({ id: 'lot2', name: 'Lot 2', price: 20, qty: 3, listable: 2, sales7d: 10 }),
    scoredRow({ id: 'lot1', name: 'Lot 1', price: 20, qty: 2, listable: 1, sales7d: 10 })
  ],
  { order: 'score', now }
);
check(
  'optimisé : à score égal, le lot le plus gros passe devant',
  quantityRank[0]?.id === 'lot2' && quantityRank[0]?.autoQty === 2,
  quantityRank.map((r) => `${r.id}:${r.autoQty}`).join(',')
);

// --- Remise en vente automatique d'une annonce revenue sans acheteur --------
// Le prix repart au plus bas autorisé (stratégie « Vente rapide »), jamais sous
// la valeur de recyclage ; une carte déjà au minimum garde exactement son prix.

const relistPrice = (over = {}) => api.autoSellRelistPrice(over);
check(
  'remise en vente : 1 chakra sous la vente la plus basse',
  relistPrice({ floor: 1, lowest: 10, median: 30, previous: 12 }) === 9,
  String(relistPrice({ floor: 1, lowest: 10, median: 30, previous: 12 }))
);
check(
  'remise en vente : jamais sous le plancher de recyclage',
  relistPrice({ floor: 10, lowest: 10, median: 10, previous: 10 }) === 10
);
check(
  'remise en vente : plancher relevé quand le marché est plus bas',
  relistPrice({ floor: 40, lowest: 39, median: 50, previous: 50 }) === 40
);
check(
  'remise en vente : déjà au minimum, remise au même prix',
  relistPrice({ floor: 1, lowest: 5, median: 9, previous: 4 }) === 4
);
check(
  'remise en vente : prix précédent sous le plancher ramené au plancher',
  relistPrice({ floor: 150, lowest: null, median: null, previous: 1 }) === 150
);
check(
  'remise en vente : sans concurrence, médiane',
  relistPrice({ floor: 1, lowest: null, median: 20, previous: null }) === 20
);
check('remise en vente : sans aucune donnée, plancher', relistPrice({ floor: 3 }) === 3);

const expired = { id: 'l-exp', reason: 'expirée', characterId: '1' };
const canRelist = (over = {}) =>
  api.autoSellRelistCheck({ dropped: expired, row: row(), spare: 1, slots: 5, includeM: false, now, ...over });

check('remise en vente : cas nominal accepté', canRelist().ok === true);
check(
  'remise en vente refusée après annulation manuelle',
  canRelist({ dropped: { ...expired, reason: 'annulée' } }).ok === false &&
    canRelist({ dropped: { ...expired, reason: 'annulée' } }).permanent === true
);
check(
  'remise en vente refusée si annonce retirée par l’utilisateur',
  canRelist({ dropped: { ...expired, manual: true } }).permanent === true
);
check('remise en vente refusée si la carte a quitté la collection', canRelist({ row: null }).permanent === true);
check(
  'remise en vente refusée sur la dernière copie',
  canRelist({ spare: api.autoSellSpare(row({ qty: 1, listable: 1 })) }).permanent === true
);
check(
  'remise en vente refusée si une annonce est déjà active pour la carte',
  canRelist({ spare: api.autoSellSpare(row({ qty: 2, listable: 1 }), 1) }).permanent === true
);
check(
  'remise en vente refusée si mythique exclue',
  canRelist({ row: row({ rarity: 'M' }) }).permanent === true
);
check(
  'remise en vente autorisée sur une mythique incluse',
  canRelist({ row: row({ rarity: 'M' }), includeM: true }).ok === true
);
check(
  'remise en vente refusée si revente bloquée',
  canRelist({ row: row({ sellBlock: 'resale_lock' }) }).permanent === true
);
check(
  'remise en vente reportée sans place libre',
  canRelist({ slots: 0 }).ok === false && canRelist({ slots: 0 }).permanent === false
);
check(
  'remise en vente reportée par le délai anti-boucle',
  canRelist({ lastAt: now - 1000 }).ok === false && canRelist({ lastAt: now - 1000 }).permanent === false
);
check('remise en vente autorisée après le délai anti-boucle', canRelist({ lastAt: now - 5 * 60000 }).ok === true);

let relistQueue = [];
relistQueue = api.autoSellRelistEnqueue(
  relistQueue,
  { characterId: '1', listingId: 'a', previousPrice: 10 },
  { now }
);
relistQueue = api.autoSellRelistEnqueue(
  relistQueue,
  { characterId: '1', listingId: 'b', previousPrice: 8 },
  { now: now + 1000 }
);
check(
  'file de remise en vente : une seule entrée par carte',
  relistQueue.length === 1 && relistQueue[0].listingId === 'b',
  JSON.stringify(relistQueue)
);
check('file de remise en vente : dernier prix connu conservé', relistQueue[0].previousPrice === 8);
check(
  'file de remise en vente : deux cartes distinctes',
  api.autoSellRelistEnqueue(relistQueue, { characterId: '2', listingId: 'c' }, { now }).length === 2
);
check(
  'file de remise en vente : entrée sans carte ignorée',
  api.autoSellRelistEnqueue([], { listingId: 'x' }).length === 0
);
check(
  'file de remise en vente : demande trop ancienne oubliée',
  api
    .autoSellRelistEnqueue([{ characterId: '9', at: now - 7 * 3600000 }], { characterId: '8' }, { now })
    .every((entry) => entry.characterId !== '9')
);

console.log(`${checks - failures}/${checks} contrôles OK`);
process.exit(failures ? 1 : 0);
