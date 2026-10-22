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

const now = new Date(2026, 9, 20, 18, 30).getTime();
const day = api.salesChartSeries(log, now, '1d');
check('1 jour = 24 points horaires', day.points.length === 24, String(day.points.length));
check('1 jour : net de la fenêtre', day.net === 150, String(day.net));
check('1 jour : deux ventes', day.count === 2, String(day.count));
check('1 jour : cumul final', day.points[23].value === 150, String(day.points[23].value));
check('1 jour : maximum', day.max === 150, String(day.max));
check('1 jour : entrée de la veille exclue', day.points[23].value !== 175);

const week = api.salesChartSeries(log, now, '7d');
check('7 jours = 168 points horaires', week.points.length === 168, String(week.points.length));
check('7 jours : net de la fenêtre', week.net === 175, String(week.net));
check('7 jours : cumul final', week.points[167].value === 175, String(week.points[167].value));
check('7 jours : maximum', week.max === 175, String(week.max));
check(
  'courbe unique, plus de séries auto/manuel',
  week.points.every((point) => !('auto' in point) && !('manual' in point))
);

const all = api.salesChartSeries(log, now, 'total');
check('total : départ à la première vente', all.points.length === 247, String(all.points.length));
check('total : net complet', all.net === 1174, String(all.net));
check('total : cumul final', all.points[all.points.length - 1].value === 1174, String(all.points[all.points.length - 1].value));
check('total : maximum', all.max === 1174, String(all.max));
check('total : quatre ventes', all.count === 4, String(all.count));
check('total : pas de division en jours', all.stepHours === 1, String(all.stepHours));

const zero = api.salesChartSeries([], now, '7d');
check('maximum minimal à 1', zero.max === 1);
check('courbe à zéro', zero.points.every((point) => point.value === 0));
check('fenêtre vide sans vente', zero.count === 0 && zero.net === 0);

const emptyTotal = api.salesChartSeries([], now, 'total');
check('total vide = un point', emptyTotal.points.length === 1);
check('total vide à zéro', emptyTotal.points[0].value === 0 && emptyTotal.max === 1);

console.log(`${checks - failures}/${checks} contrôles OK`);
process.exit(failures ? 1 : 0);
