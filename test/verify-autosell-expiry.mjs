// Vérifie le retrait automatique des annonces trop anciennes de la vente auto :
// calcul du délai, décision de retrait, conservation de la carte, protection
// après une vente effective, réintégration en fin de classement et anti-boucle.
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
    autoSellExpireDelayMs,
    autoSellExpireSettings,
    autoSellExpireLabel,
    autoSellListingStartAt,
    autoSellOriginOf,
    autoSellExpiryCheck,
    autoSellExpiredListings,
    autoSellReturnAdd,
    autoSellReturnClear,
    autoSellReturnReady,
    autoSellApplyReturns,
    autoSellExpiryReturnsSanitize,
    autoSellExpiryHistorySanitize,
    autoSellListingIsActive,
    autoSellSpare,
    AUTOSELL_RETURN_COOLDOWN_MS,
    AUTOSELL_EXPIRE_MAX_MS
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

const now = Date.parse('2026-10-23T12:00:00.000Z');
const HOUR = 3600000;
const MINUTE = 60000;

const listing = (over = {}) => ({
  id: 'l1',
  characterId: '42',
  character: { id: '42', name: 'Ganyu', rarity: 'R' },
  status: 'active',
  type: 'fixed',
  price: 50,
  qty: 1,
  createdAt: new Date(now - 3 * HOUR).toISOString(),
  ...over
});

const track = (over = {}) => ({
  id: 'l1',
  characterId: '42',
  name: 'Ganyu',
  rarity: 'R',
  price: 50,
  source: 'auto',
  createdAt: now - 3 * HOUR,
  endsAt: now + 9 * HOUR,
  ...over
});

/* --- 1. Calcul du délai -------------------------------------------------- */

check('délai désactivé : zéro', api.autoSellExpireDelayMs({ enabled: false, value: 2, unit: 'h' }) === 0);
check(
  '90 minutes en millisecondes',
  api.autoSellExpireDelayMs({ enabled: true, value: 90, unit: 'min' }) === 90 * MINUTE,
  String(api.autoSellExpireDelayMs({ enabled: true, value: 90, unit: 'min' }))
);
check('2 heures en millisecondes', api.autoSellExpireDelayMs({ enabled: true, value: 2, unit: 'h' }) === 2 * HOUR);
check(
  'unité inconnue : heures par défaut',
  api.autoSellExpireDelayMs({ enabled: true, value: 2, unit: 'jours' }) === 2 * HOUR
);
check('valeur nulle : pas de retrait', api.autoSellExpireDelayMs({ enabled: true, value: 0, unit: 'h' }) === 0);
check('valeur négative : pas de retrait', api.autoSellExpireDelayMs({ enabled: true, value: -3, unit: 'h' }) === 0);
check(
  'valeur illisible : pas de retrait',
  api.autoSellExpireDelayMs({ enabled: true, value: 'abc', unit: 'h' }) === 0
);
check(
  'durée plafonnée à 30 jours',
  api.autoSellExpireDelayMs({ enabled: true, value: 999999, unit: 'min' }) === api.AUTOSELL_EXPIRE_MAX_MS
);
check('durée minimale : 1 minute', api.autoSellExpireDelayMs({ enabled: true, value: 1, unit: 'min' }) === MINUTE);

const defaults = api.autoSellExpireSettings({});
check('réglage absent : 72 heures', defaults.value === 72 && defaults.unit === 'h' && defaults.enabled === false);
check('valeur zéro ramenée à 1', api.autoSellExpireSettings({ value: 0, unit: 'h' }).value === 1);
check(
  'valeur en minutes plafonnée à 30 jours',
  api.autoSellExpireSettings({ value: 999999, unit: 'min' }).value === 43200,
  String(api.autoSellExpireSettings({ value: 999999, unit: 'min' }).value)
);
check('unité inconnue normalisée en heures', api.autoSellExpireSettings({ unit: 'x' }).unit === 'h');
check('activation conservée', api.autoSellExpireSettings({ enabled: true }).enabled === true);

check('libellé 1 minute', api.autoSellExpireLabel(MINUTE) === '1 min');
check('libellé 1 h 30', api.autoSellExpireLabel(90 * MINUTE) === '1 h 30 min');
check('libellé 3 jours', api.autoSellExpireLabel(72 * HOUR) === '3 j');
check('libellé vide', api.autoSellExpireLabel(0) === '—');

/* --- 2. Date réelle de mise en vente ------------------------------------- */

check(
  'date lue depuis createdAt',
  api.autoSellListingStartAt(listing(), {}) === now - 3 * HOUR,
  String(api.autoSellListingStartAt(listing(), {}))
);
check(
  'date en secondes convertie',
  api.autoSellListingStartAt({ listedAt: Math.round((now - HOUR) / 1000) }, {}) === now - HOUR
);
check(
  'date en millisecondes conservée',
  api.autoSellListingStartAt({ publishedAt: now - 2 * HOUR }, {}) === now - 2 * HOUR
);
check(
  'repli sur la trace locale',
  api.autoSellListingStartAt(listing({ createdAt: null }), { trackAt: now - HOUR }) === now - HOUR
);
check('date inconnue : null', api.autoSellListingStartAt({ id: 'x' }, {}) === null);

/* --- 3. Origine : jamais les annonces manuelles ------------------------- */

check('annonce auto reconnue par identifiant', api.autoSellOriginOf(listing(), [track()]).auto === true);
check(
  'annonce manuelle reconnue et protégée',
  api.autoSellOriginOf(listing(), [track({ source: 'manual' })]).auto === false
);
check('sans trace : origine inconnue', api.autoSellOriginOf(listing(), []).auto === false);
check(
  'rapprochement unique par carte et prix',
  api.autoSellOriginOf(listing({ id: 'autre' }), [track({ id: 'local-1' })]).auto === true
);
check(
  'un identifiant serveur inconnu du suivi n’est jamais attribué',
  api.autoSellOriginOf(listing({ id: 'autre' }), [track({ id: 'serveur-1' })]).auto === false
);
check(
  'deux traces identiques : aucune attribution',
  api
    .autoSellOriginOf(listing({ id: 'autre' }), [track({ id: 'local-1' }), track({ id: 'local-2' })])
    .auto === false
);

/* --- 4. Décision de retrait --------------------------------------------- */

const twoHours = 2 * HOUR;
check(
  'annonce de 3 h retirée avec un seuil de 2 h',
  api.autoSellExpiryCheck(listing(), { now, maxAgeMs: twoHours, auto: true }).due === true
);
check(
  'âge calculé depuis la mise en vente',
  api.autoSellExpiryCheck(listing(), { now, maxAgeMs: twoHours, auto: true }).ageMs === 3 * HOUR
);
check(
  'annonce de 1 h conservée',
  api.autoSellExpiryCheck(listing({ createdAt: new Date(now - HOUR).toISOString() }), {
    now,
    maxAgeMs: twoHours,
    auto: true
  }).due === false
);
check(
  'seuil atteint exactement : retrait',
  api.autoSellExpiryCheck(listing({ createdAt: new Date(now - twoHours).toISOString() }), {
    now,
    maxAgeMs: twoHours,
    auto: true
  }).due === true
);
check(
  'fonctionnalité désactivée : aucun retrait',
  api.autoSellExpiryCheck(listing(), { now, maxAgeMs: 0, auto: true }).due === false
);
check(
  'annonce manuelle jamais retirée',
  api.autoSellExpiryCheck(listing(), { now, maxAgeMs: twoHours, auto: false }).due === false &&
    api.autoSellExpiryCheck(listing(), { now, maxAgeMs: twoHours, auto: false }).reason === 'annonce manuelle'
);
check(
  'carte déjà vendue : aucun retrait',
  api.autoSellExpiryCheck(listing({ status: 'sold', soldAt: new Date(now - HOUR).toISOString() }), {
    now,
    maxAgeMs: twoHours,
    auto: true
  }).due === false
);
check(
  'annonce expirée : aucun retrait',
  api.autoSellExpiryCheck(listing({ endsAt: new Date(now - MINUTE).toISOString() }), {
    now,
    maxAgeMs: twoHours,
    auto: true
  }).due === false
);
check(
  'date inconnue : aucun retrait (jamais de date inventée)',
  api.autoSellExpiryCheck(listing({ createdAt: null }), { now, maxAgeMs: twoHours, auto: true }).due === false
);
check(
  'enchère avec offre : retrait refusé',
  api.autoSellExpiryCheck(listing({ type: 'auction', currentBid: 60, bidCount: 1 }), {
    now,
    maxAgeMs: twoHours,
    auto: true
  }).due === false
);
check(
  'mise à prix sans offre : retrait possible',
  api.autoSellExpiryCheck(listing({ type: 'auction', currentBid: 50 }), {
    now,
    maxAgeMs: twoHours,
    auto: true
  }).due === true
);

/* --- 5. Sélection des annonces à retirer -------------------------------- */

const listings = [
  listing({ id: 'l1', characterId: '42' }),
  listing({
    id: 'l2',
    characterId: '43',
    character: { id: '43', name: 'Bennett', rarity: 'C' },
    createdAt: new Date(now - 5 * HOUR).toISOString()
  }),
  listing({ id: 'manuelle', characterId: '44', character: { id: '44', name: 'Manuelle', rarity: 'C' } }),
  listing({
    id: 'vendue',
    characterId: '45',
    character: { id: '45', name: 'Vendue', rarity: 'E' },
    status: 'sold'
  })
];
const tracked = [
  track(),
  track({ id: 'l2', characterId: '43', name: 'Bennett' }),
  track({ id: 'vendue', characterId: '45', name: 'Vendue' }),
  track({ id: 'manuelle', characterId: '44', name: 'Manuelle', source: 'manual' })
];
const due = api.autoSellExpiredListings(listings, { now, maxAgeMs: twoHours, track: tracked });
check('deux annonces automatiques trop anciennes', due.length === 2, due.map((item) => item.id).join(','));
check('annonce manuelle exclue', due.every((item) => item.id !== 'manuelle'));
check('annonce vendue exclue', due.every((item) => item.id !== 'vendue'));
check('tri par date de mise en vente', due[0]?.id === 'l2' && due[1]?.id === 'l1');
check('quantité et prix conservés dans la décision', due[1]?.price === 50);
check('nom de la carte conservé', due[1]?.name === 'Ganyu');
check(
  'une annonce déjà en cours de retrait est écartée',
  api
    .autoSellExpiredListings(listings, {
      now,
      maxAgeMs: twoHours,
      track: tracked,
      skipIds: new Set(['l1'])
    })
    .every((item) => item.id !== 'l1')
);
check(
  'aucun doublon dans la liste à retirer',
  api
    .autoSellExpiredListings([listing(), listing({ listingId: undefined, id: 'l1' })], {
      now,
      maxAgeMs: twoHours,
      track: [track()]
    })
    .length === 1
);
check(
  'une annonce vendue entre-temps est protégée au dernier contrôle',
  api.autoSellExpiredListings([listing({ status: 'sold' })], { now, maxAgeMs: twoHours, track: [track()] }).length === 0
);

/* --- 6. Conservation de la carte et de sa quantité ---------------------- */

const row = { id: '42', qty: 3, listable: 2, lockedQty: 0 };
const spareBefore = api.autoSellSpare(row, 1);
const spareAfter = api.autoSellSpare(row, 0);
check('un exemplaire en vente réserve sa place', spareBefore === 1, String(spareBefore));
check('après retrait, l’exemplaire revient au pool', spareAfter === 2, String(spareAfter));
check('la quantité de la carte ne change pas', row.qty === 3);
check(
  'la dernière copie reste conservée même après retrait',
  api.autoSellSpare({ id: 'x', qty: 1, listable: 1 }, 0) === 0
);

/* --- 7. File de retour après expiration --------------------------------- */

const at = now;
let returns = [];
returns = api.autoSellReturnAdd(returns, { characterId: '42', listingId: 'auto-1', name: 'Ganyu', at }, { now: at });
check('une carte retirée entre dans la file', returns.length === 1 && returns[0].characterId === '42');
returns = api.autoSellReturnAdd(returns, { characterId: '42', listingId: 'auto-1b', name: 'Ganyu', at: at + 1000 }, {
  now: at + 1000
});
check('une seule entrée par carte', returns.length === 1);
check('la date la plus récente gagne', returns[0].at === at + 1000);
check(
  'entrée trop ancienne oubliée',
  api.autoSellReturnAdd([{ characterId: '9', at: now - 25 * HOUR }], { characterId: '8', at: now }, { now }).every(
    (entry) => entry.characterId !== '9'
  )
);
check(
  'retrait de la file après resélection',
  api.autoSellReturnClear(returns, '42').length === 0
);
check(
  'délai anti-boucle non écoulé',
  api.autoSellReturnReady({ at }, at + MINUTE, api.AUTOSELL_RETURN_COOLDOWN_MS) === false
);
check(
  'délai anti-boucle écoulé',
  api.autoSellReturnReady({ at }, at + api.AUTOSELL_RETURN_COOLDOWN_MS, api.AUTOSELL_RETURN_COOLDOWN_MS) === true
);

/* --- 8. Réintégration en fin de classement ------------------------------ */

const ranked = [
  { id: 'chere', characterId: '1', name: 'Chère', rank: { score: 95 } },
  { id: 'moyenne', characterId: '2', name: 'Moyenne', rank: { score: 60 } },
  { id: 'revient', characterId: '3', name: 'Revient', rank: { score: 99 } }
];
const returned = [{ characterId: '3', at: now - 20 * MINUTE, name: 'Revient' }];
const applied = api.autoSellApplyReturns(ranked, returned, { now });
check('la carte revenue passe en dernier malgré son meilleur score', applied.rows[2]?.id === 'revient');
check('les autres cartes gardent leur ordre', applied.rows[0]?.id === 'chere' && applied.rows[1]?.id === 'moyenne');
check('statut interne « retour après expiration »', applied.rows[2]?.expiredReturn === true);
check('date de retrait conservée', applied.rows[2]?.returnedAt === now - 20 * MINUTE);

const several = api.autoSellApplyReturns(
  [
    { id: 'a', characterId: '1', name: 'Alpha' },
    { id: 'b', characterId: '2', name: 'Bêta' },
    { id: 'c', characterId: '3', name: 'Gamma' }
  ],
  [
    { characterId: '3', at: now - 15 * MINUTE },
    { characterId: '1', at: now - 30 * MINUTE },
    { characterId: '2', at: now - 20 * MINUTE }
  ],
  { now }
);
check('plusieurs retours : ordre stable par date de retrait', several.rows.map((r) => r.id).join(',') === 'a,b,c');

const held = api.autoSellApplyReturns([{ id: 'x', characterId: '9', name: 'Retour' }], [
  { characterId: '9', at: now - MINUTE }
], { now });
check('carte encore en délai anti-boucle : non resélectionnée', held.rows.length === 0);
check('carte en attente comptée', held.heldBack === 1);
const ready = api.autoSellApplyReturns([{ id: 'x', characterId: '9', name: 'Retour' }], [
  { characterId: '9', at: now - api.AUTOSELL_RETURN_COOLDOWN_MS - 1 }
], { now });
check('carte éligible après le délai', ready.rows.length === 1 && ready.rows[0].expiredReturn === true);

const afterClear = api.autoSellApplyReturns(ranked, api.autoSellReturnClear(returned, '3'), { now });
check('après remise en vente, la carte retrouve son rang', afterClear.rows[2]?.id === 'revient' && !afterClear.rows[2]?.expiredReturn);
check('aucune carte retenue quand la file est vide', afterClear.heldBack === 0);

/* --- 9. Journal persistant ---------------------------------------------- */

const sanitizedReturns = api.autoSellExpiryReturnsSanitize([
  { characterId: 42, listingId: 'l1', name: 'Ganyu', at: now, ageMs: 3 * HOUR, thresholdMs: 2 * HOUR },
  { characterId: '', at: now },
  null
]);
check('file persistée relue', sanitizedReturns.length === 1 && sanitizedReturns[0].characterId === '42');
check('seuil conservé dans la file', sanitizedReturns[0].thresholdMs === 2 * HOUR);

const sanitizedHistory = api.autoSellExpiryHistorySanitize([
  { kind: 'remove', at: now, name: 'Ganyu', ageMs: 3 * HOUR, thresholdMs: 2 * HOUR },
  { kind: 'relist', at: now + MINUTE, name: 'Ganyu', price: 50 },
  { kind: 'autre', at: now + 2 * MINUTE },
  { at: 0 }
]);
check('journal relu et trié', sanitizedHistory.length === 3, String(sanitizedHistory.length));
check('retrait identifié', sanitizedHistory[0].kind === 'remove');
check('remise en vente identifiée', sanitizedHistory[1].kind === 'relist');
check('type inconnu ramené à un retrait', sanitizedHistory[2].kind === 'remove');

/* --- 10. Anti-boucle : retrait puis remise en vente --------------------- */

const maxAgeMs = 2 * HOUR;
let clock = now;
let listedAt = now;
let listed = true;
let loopReturns = [];
let removals = 0;
let relists = 0;
let lastRemovalAt = 0;
let shortestGap = Infinity;
let relistedTooSoon = false;
for (let step = 0; step < 24 * 60; step += 1) {
  clock += MINUTE;
  if (listed) {
    const live = listing({
      id: 'boucle',
      createdAt: new Date(listedAt).toISOString(),
      endsAt: new Date(listedAt + 48 * HOUR).toISOString()
    });
    const candidates = api.autoSellExpiredListings([live], {
      now: clock,
      maxAgeMs,
      track: [track({ id: 'boucle', createdAt: listedAt })]
    });
    if (candidates.length) {
      removals += 1;
      if (lastRemovalAt) shortestGap = Math.min(shortestGap, clock - lastRemovalAt);
      lastRemovalAt = clock;
      listed = false;
      loopReturns = api.autoSellReturnAdd(
        loopReturns,
        { characterId: '42', listingId: 'boucle', name: 'Ganyu', at: clock },
        { now: clock }
      );
    }
  }
  // La boucle de vente tente de resélectionner la carte à chaque minute, mais
  // une carte déjà en vente n'est pas un candidat.
  if (!listed) {
    const pick = api.autoSellApplyReturns([{ id: '42', characterId: '42', name: 'Ganyu' }], loopReturns, { now: clock });
    if (pick.rows.length) {
      relists += 1;
      if (lastRemovalAt && clock - lastRemovalAt < api.AUTOSELL_RETURN_COOLDOWN_MS) relistedTooSoon = true;
      listedAt = clock;
      listed = true;
      loopReturns = api.autoSellReturnClear(loopReturns, '42');
    }
  }
}
check('la carte est bien retirée plusieurs fois sur 24 h', removals >= 5, String(removals));
check('la carte est remise en vente après chaque retrait', relists >= 5, String(relists));
check('aucune remise en vente dans le délai anti-boucle', relistedTooSoon === false);
check(
  'deux retraits successifs espacés d’au moins le seuil',
  shortestGap >= maxAgeMs,
  String(shortestGap)
);
check('aucune boucle infinie : pas de retrait à chaque minute', removals < 20, String(removals));

console.log(`${checks - failures}/${checks} contrôles OK`);
process.exit(failures ? 1 : 0);
