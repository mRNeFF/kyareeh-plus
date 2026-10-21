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
  return { autoSellSpare, autoSellSelect, autoSellBuildPlan };
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

const base = [
  row({ id: 'a', name: 'A', price: 10 }),
  row({ id: 'b', name: 'B', price: 100 }),
  row({ id: 'c', name: 'C', price: 50 })
];
const selected = api.autoSellSelect(base, { minPrice: 1 });
check('tri par valeur du lot', selected[0]?.id === 'b' && selected[1]?.id === 'c', selected.map((r) => r.id).join(','));
check('autoQty exposé', selected[0]?.autoQty === 1);

check('pinned exclu', api.autoSellSelect([row({ pinned: true })], {}).length === 0);
check('revente bloquée exclue', api.autoSellSelect([row({ sellBlock: 'resale_lock' })], {}).length === 0);
check('blocage générique exclu', api.autoSellSelect([row({ block: { reason: 'x' } })], {}).length === 0);
check('M exclue par défaut', api.autoSellSelect([row({ rarity: 'M' })], {}).length === 0);
check('L exclue par défaut', api.autoSellSelect([row({ rarity: 'L' })], {}).length === 0);
check('M incluse si demandé', api.autoSellSelect([row({ rarity: 'M' })], { includeML: true }).length === 1);
check('prix sous le plancher exclu', api.autoSellSelect([row({ price: 2 })], { minPrice: 3 }).length === 0);
check('prix absent exclu', api.autoSellSelect([row({ price: null })], {}).length === 0);

const candidates = [
  row({ id: 'a', name: 'A', price: 10, autoQty: 5 }),
  row({ id: 'b', name: 'B', price: 100, autoQty: 5 })
];
const plan = api.autoSellBuildPlan(candidates, { slots: 4, maxPerCycle: 3 });
check('plan limité par max/cycle', plan.reduce((n, r) => n + r.qty, 0) === 3);
check('plan limité par les places', api.autoSellBuildPlan(candidates, { slots: 2, maxPerCycle: 10 }).reduce((n, r) => n + r.qty, 0) === 2);
check(
  'plan répartit sur plusieurs cartes',
  api.autoSellBuildPlan(
    [
      row({ id: 'a', price: 10, autoQty: 2 }),
      row({ id: 'b', price: 100, autoQty: 3 })
    ],
    { slots: 4, maxPerCycle: 4 }
  ).length === 2
);
check('plan vide sans place', api.autoSellBuildPlan(candidates, { slots: 0, maxPerCycle: 10 }).length === 0);

console.log(`${checks - failures}/${checks} contrôles OK`);
process.exit(failures ? 1 : 0);
