// Vérifie la sélection pure du recyclage ciblé et de ses garde-fous.
// Le bloc RECYCLE est extrait de content/ui.js : aucune dépendance DOM/réseau.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(join(ROOT, 'content/ui.js'), 'utf8');
const begin = source.indexOf('/* RECYCLE:BEGIN');
const end = source.indexOf('/* RECYCLE:END */');
if (begin < 0 || end < 0) {
  console.error('Marqueurs RECYCLE:BEGIN / RECYCLE:END introuvables dans content/ui.js');
  process.exit(1);
}

const api = new Function(`${source.slice(begin, end)}
  return {
    RECYCLE_KEEP_COPIES,
    recycleBlockedCopies,
    recycleSpareOf,
    recycleBlockOf,
    recycleQtyOf,
    recycleBuildPlan,
    recycleTotals
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
  rawId: 1,
  name: 'Carte',
  rarity: 'C',
  qty: 2,
  listable: 2,
  lockedQty: 0,
  pinned: false,
  ...over
});

/* --- exemplaires recyclables ---------------------------------------- */
check('une copie conservée', api.RECYCLE_KEEP_COPIES === 1);
check('doublon simple : 1 en trop', api.recycleSpareOf(row({ qty: 2 })) === 1);
check('triple : 2 en trop', api.recycleSpareOf(row({ qty: 3, listable: 3 })) === 2);
check('carte unique : rien à recycler', api.recycleSpareOf(row({ qty: 1, listable: 1 })) === 0);
check('carte absente : zéro', api.recycleSpareOf(null) === 0);
check('verrouillée : zéro', api.recycleSpareOf(row({ qty: 5, listable: 5, pinned: true })) === 0);
check('exemplaires verrouillés exclus', api.recycleSpareOf(row({ qty: 5, listable: 5, lockedQty: 2 })) === 2);
check('verrou + engagés : le plus contraignant gagne', api.recycleSpareOf(row({ qty: 5, listable: 3, lockedQty: 2 })) === 2);
check('exemplaires engagés exclus (listable)', api.recycleSpareOf(row({ qty: 4, listable: 2 })) === 1);
check('tout engagé : zéro', api.recycleSpareOf(row({ qty: 4, listable: 0 })) === 0);
check('listable absent : seuls les verrouillés sont retirés', api.recycleSpareOf(row({ qty: 5, listable: null, lockedQty: 1 })) === 3);
check('listable incohérent : borné à la quantité', api.recycleSpareOf(row({ qty: 2, listable: 9 })) === 1);
check('quantité négative : zéro', api.recycleSpareOf(row({ qty: -3 })) === 0);

/* --- motifs de blocage ---------------------------------------------- */
check('carte unique expliquée', /Seul exemplaire/.test(api.recycleBlockOf(row({ qty: 1 })) || ''));
check('carte verrouillée expliquée', /Verrouillée/.test(api.recycleBlockOf(row({ pinned: true })) || ''));
check('exemplaires engagés expliqués', /engagés/.test(api.recycleBlockOf(row({ qty: 3, listable: 0 })) || ''));
check('verrou expliqué', /verrouillé/.test(api.recycleBlockOf(row({ qty: 4, listable: 4, lockedQty: 3 })) || ''));
check('mythique exclue par défaut', /Mythique exclue/.test(api.recycleBlockOf(row({ rarity: 'M', qty: 3 })) || ''));
check('légendaire exclue par défaut', /Légendaire exclue/.test(api.recycleBlockOf(row({ rarity: 'L', qty: 3 })) || ''));
check(
  'mythique autorisée avec l’option',
  api.recycleBlockOf(row({ rarity: 'M', qty: 3 }), { includeML: true }) == null
);
check('carte normale : aucun blocage', api.recycleBlockOf(row({ qty: 3 })) == null);

/* --- quantité retenue ----------------------------------------------- */
check('quantité bornée au maximum', api.recycleQtyOf(row({ qty: 4, listable: 4 }), 9) === 3);
check('quantité zéro acceptée', api.recycleQtyOf(row({ qty: 4 }), 0) === 0);
check('quantité négative ramenée à zéro', api.recycleQtyOf(row({ qty: 4 }), -2) === 0);
check('quantité décimale arrondie vers le bas', api.recycleQtyOf(row({ qty: 4, listable: 4 }), 2.9) === 2);
check('carte bloquée : zéro', api.recycleQtyOf(row({ pinned: true, qty: 4 }), 3) === 0);

/* --- plan de recyclage ---------------------------------------------- */
const RATES = { C: 1, U: 1, R: 3, E: 10, L: 40, M: 150 };
const rows = [
  row({ id: 'a', rawId: 11, name: 'Alpha', rarity: 'R', qty: 4, listable: 4 }),
  row({ id: 'b', rawId: 22, name: 'Beta', rarity: 'C', qty: 2, listable: 2 }),
  row({ id: 'c', rawId: 33, name: 'Gamma', rarity: 'E', qty: 1, listable: 1 }),
  row({ id: 'd', rawId: 44, name: 'Delta', rarity: 'C', qty: 5, listable: 5, pinned: true })
];

const selection = new Map([
  ['a', 2],
  ['b', 1],
  ['c', 1],
  ['d', 3]
]);
const plan = api.recycleBuildPlan(rows, selection, RATES);
check('plan : les cartes sans exemplaire en trop sont écartées', plan.every((line) => line.id !== 'c' && line.id !== 'd'));
check('plan : deux cartes retenues', plan.length === 2, `reçu ${plan.length}`);
check('plan : quantité et identifiant conservés', plan[0].id === 'a' && plan[0].qty === 2);
check('plan : valeur unitaire du barème', plan[0].unit === 3);
check('plan : total de la ligne', plan[0].total === 6);
check('plan : prix par carte (C)', plan[1].unit === 1 && plan[1].total === 1);
check('plan : quantité bornée', api.recycleBuildPlan([row({ id: 'x', qty: 4, listable: 4 })], new Map([['x', 9]]), RATES)[0].qty === 3);
check('plan : sélection objet acceptée', api.recycleBuildPlan(rows, { a: 1 }, RATES)[0].qty === 1);
check('plan : sélection vide', api.recycleBuildPlan(rows, new Map(), RATES).length === 0);
check('plan : barème inconnu = 0 (aucune invention)', api.recycleBuildPlan([row({ id: 'z', qty: 3 })], new Map([['z', 2]]), {})[0].total === 0);
check('plan : rawId conservé pour l’API', api.recycleBuildPlan([row({ id: 'k', rawId: 777, qty: 3 })], new Map([['k', 1]]), RATES)[0].characterId === 777);

/* --- totaux ---------------------------------------------------------- */
const totals = api.recycleTotals(plan);
check('totaux : cartes', totals.cards === 2);
check('totaux : exemplaires', totals.copies === 3);
check('totaux : chakra', totals.chakra === 7);
check('totaux : plan vide', api.recycleTotals([]).chakra === 0 && api.recycleTotals(null).cards === 0);

/* --- scénario de bout en bout (sans réseau) ------------------------- */
// 5 cartes possédées, 1 verrouillée, 1 engagée : on ne peut recycler que 2.
const owned = [
  row({ id: '1', qty: 5, listable: 3, lockedQty: 0 }),
  row({ id: '2', qty: 2, listable: 1 }),
  row({ id: '3', qty: 1, listable: 1 }),
  row({ id: '4', qty: 4, listable: 4, pinned: true }),
  row({ id: '5', qty: 3, listable: 3, rarity: 'L' })
];
const selectable = owned.filter((item) => !api.recycleBlockOf(item));
const full = api.recycleBuildPlan(
  selectable,
  new Map(selectable.map((item) => [item.id, 99])),
  RATES
);
check('scénario : seule la carte au plus gros stock reste', selectable.length === 1, `reçu ${selectable.length}`);
check('scénario : 2 exemplaires au total', api.recycleTotals(full).copies === 2);
check(
  'scénario : la légendaire reste exclue',
  full.every((line) => line.rarity !== 'L')
);

console.log(`${checks - failures}/${checks} contrôles OK`);
process.exit(failures ? 1 : 0);
