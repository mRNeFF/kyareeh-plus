// Vérifie les cumuls purs du graphique de ventes (bloc SALES de content/ui.js).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(join(ROOT, 'content/ui.js'), 'utf8');
const begin = source.indexOf('/* SALES:BEGIN');
const end = source.indexOf('/* SALES:END */');
if (begin < 0 || end < 0) {
  console.error('Marqueurs SALES:BEGIN / SALES:END introuvables dans content/ui.js');
  process.exit(1);
}

const api = new Function(`${source.slice(begin, end)}
  return { salesTotals, salesChartSeries };
`)();

let checks = 0;
let failures = 0;
function check(label, condition, detail = '') {
  checks += 1;
  if (condition) return;
  failures += 1;
  console.log(`ECHEC  ${label}${detail ? ` — ${detail}` : ''}`);
}

const empty = api.salesTotals([]);
check('totaux vides', empty.net === 0 && empty.count === 0 && empty.matched === 0);

const log = [
  { at: new Date(2026, 9, 20, 10).getTime(), source: 'auto', net: 100, matched: true },
  { at: new Date(2026, 9, 20, 12).getTime(), source: 'manual', net: 50, matched: false },
  { at: new Date(2026, 9, 19, 12).getTime(), source: 'auto', net: 25, matched: false },
  { at: new Date(2026, 9, 10, 12).getTime(), source: 'manual', net: 999, matched: false }
];
const totals = api.salesTotals(log);
check('net total', totals.net === 1174, String(totals.net));
check('nombre total', totals.count === 4, String(totals.count));
check('ventes immédiates', totals.matched === 1, String(totals.matched));
check('répartition auto', totals.auto === 2 && totals.autoNet === 125, `${totals.auto}/${totals.autoNet}`);
check('répartition manuelle', totals.manual === 2 && totals.manualNet === 1049, `${totals.manual}/${totals.manualNet}`);

const model = api.salesChartSeries(log, new Date(2026, 9, 20, 18).getTime(), 7);
check('7 points', model.points.length === 7, String(model.points.length));
check('cumul auto du jour', model.points[6].auto === 125, String(model.points[6].auto));
check('cumul manuel du jour', model.points[6].manual === 50, String(model.points[6].manual));
check('entrée hors fenêtre exclue du graphe', model.points[6].manual !== 1049);
check('maximum positif', model.max === 125, String(model.max));

const zero = api.salesChartSeries([], Date.now(), 7);
check('maximum minimal à 1', zero.max === 1);
check('deux séries à zéro', zero.points.every((point) => point.auto === 0 && point.manual === 0));

console.log(`${checks - failures}/${checks} contrôles OK`);
process.exit(failures ? 1 : 0);
