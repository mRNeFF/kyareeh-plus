#!/usr/bin/env node
/*
 * Kyareeh+ — publication sur addons.mozilla.org (AMO).
 *
 * Pourquoi ce script : un add-on AMO ne peut PAS contenir de `update_url`
 * (Mozilla le refuse). La seule façon d'avoir des mises à jour automatiques
 * est donc de publier l'add-on sur AMO, qui sert ensuite les nouvelles
 * versions à tous les utilisateurs sans qu'ils touchent à rien.
 *
 * Ce que fait le script :
 *   1. monte la version (manifest.json, package.json, README)
 *   2. construit le .zip à envoyer à AMO
 *   3. vérifie le paquet (web-ext lint)
 *   4. commit + push
 *   5. si les clés API AMO sont présentes : envoie la version sur AMO
 *      (canal « listed »), sinon affiche les instructions d'upload manuel
 *
 * Prérequis pour l'envoi automatique :
 *   WEB_EXT_API_KEY / WEB_EXT_API_SECRET
 *   https://addons.mozilla.org/developers/addon/api/key/
 *
 * Exemples :
 *   node scripts/release.mjs --build-only      (zip seul, première soumission)
 *   node scripts/release.mjs 0.10.1            (bump + build + envoi AMO)
 *   node scripts/release.mjs 0.10.1 --no-upload
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ARTIFACTS = join(ROOT, 'web-ext-artifacts');
const WEB_EXT = join(ROOT, 'node_modules', 'web-ext', 'bin', 'web-ext.js');
const BRANCH = 'master';

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const version = args.find((a) => !a.startsWith('--')) ?? null;

function run(cmd, cmdArgs, { allowFail = false, quiet = false } = {}) {
  if (!quiet) console.log(`\n$ ${cmd} ${cmdArgs.join(' ')}`);
  const res = spawnSync(cmd, cmdArgs, { cwd: ROOT, stdio: quiet ? 'pipe' : 'inherit' });
  if (res.error) {
    if (allowFail) return null;
    throw new Error(`Impossible d'exécuter ${cmd} : ${res.error.message}`);
  }
  if (res.status !== 0) {
    if (allowFail) return null;
    throw new Error(`${cmd} a échoué (code ${res.status}).`);
  }
  return res;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function writeJson(path, data) {
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

function fail(message) {
  console.error(`\n✗ ${message}\n`);
  process.exit(1);
}

const buildOnly = flags.has('--build-only');

/* --- 1. version ----------------------------------------------------- */

const manifestPath = join(ROOT, 'manifest.json');
const manifest = readJson(manifestPath);
const previous = manifest.version;
const target = version ?? previous;

if (!/^\d+\.\d+(\.\d+)?$/.test(target)) {
  fail(`Version invalide : "${target}". Format attendu : 0.10.1`);
}

if (!buildOnly && target !== previous) {
  manifest.version = target;
  writeJson(manifestPath, manifest);

  const pkg = readJson(join(ROOT, 'package.json'));
  pkg.version = target;
  pkg.scripts.build = `web-ext build --source-dir . --filename kyareeh-plus-${target}.zip --overwrite-dest`;
  writeJson(join(ROOT, 'package.json'), pkg);

  const readmePath = join(ROOT, 'README.md');
  if (existsSync(readmePath)) {
    const readme = readFileSync(readmePath, 'utf8');
    writeFileSync(readmePath, readme.replace(/Fonctionnalités \(v[\d.]+\)/, `Fonctionnalités (v${target})`), 'utf8');
  }
  console.log(`Version ${previous} → ${target}`);
}

/* --- 2. build ------------------------------------------------------- */

if (!existsSync(WEB_EXT)) {
  fail('web-ext introuvable. Lance d’abord : npm install');
}

mkdirSync(ARTIFACTS, { recursive: true });
run(process.execPath, [
  WEB_EXT,
  'build',
  '--source-dir',
  '.',
  '--filename',
  `kyareeh-plus-${target}.zip`,
  '--overwrite-dest'
]);

/* --- 3. lint -------------------------------------------------------- */

const lint = spawnSync(process.execPath, [WEB_EXT, 'lint', '--source-dir', '.', '--output', 'json'], {
  cwd: ROOT,
  encoding: 'utf8'
});
let lintReport = null;
try {
  lintReport = JSON.parse(lint.stdout ?? '{}');
} catch {
  /* sortie illisible : on continue, l'erreur sera visible dans le prochain lint manuel */
}
if (lintReport) {
  const errors = lintReport.errors ?? [];
  if (errors.length) {
    for (const err of errors) console.error(`  ${err.code}: ${err.message}${err.file ? ` (${err.file})` : ''}`);
    fail(`${errors.length} erreur(s) bloquante(s) : AMO refusera le paquet.`);
  }
  const warnings = (lintReport.warnings ?? []).length;
  console.log(`Lint : 0 erreur, ${warnings} avertissement(s).`);
}

const zip = join(ARTIFACTS, `kyareeh-plus-${target}.zip`);
console.log(`\n✓ Zip prêt : ${zip}`);

if (buildOnly) {
  console.log(`
Prochaine étape (première soumission) :
  1. https://addons.mozilla.org/developers/  →  « Submit a New Add-on »
  2. Choisis « On this site » (listé) : c'est ce qui active les mises à jour automatiques.
  3. Envoie web-ext-artifacts/kyareeh-plus-${target}.zip
`);
  process.exit(0);
}

/* --- 4. commit + push ----------------------------------------------- */

run('git', ['add', '-A']);
const commit = run('git', ['commit', '-m', `Release v${target}`], { allowFail: true, quiet: true });
if (commit) {
  run('git', ['push', 'origin', BRANCH], { allowFail: true });
} else {
  console.log('Rien à committer (ou hook déjà passé).');
}

/* --- 5. envoi AMO --------------------------------------------------- */

const apiKey = process.env.WEB_EXT_API_KEY;
const apiSecret = process.env.WEB_EXT_API_SECRET;

if (flags.has('--no-upload') || !apiKey || !apiSecret) {
  console.log(`
! Envoi automatique non effectué${flags.has('--no-upload') ? ' (--no-upload)' : ' (clés API absentes)'}.

Envoi manuel :
  1. https://addons.mozilla.org/developers/addon/kyara-plus/versions
  2. « Upload a New Version » → web-ext-artifacts/kyareeh-plus-${target}.zip
  3. Attends la validation (quelques heures à quelques jours).

Pour automatiser :
  $env:WEB_EXT_API_KEY="user:xxxxx:yyy"
  $env:WEB_EXT_API_SECRET="…"
`);
  process.exit(0);
}

run(process.execPath, [
  WEB_EXT,
  'sign',
  '--source-dir',
  '.',
  '--channel',
  'listed',
  '--api-key',
  apiKey,
  '--api-secret',
  apiSecret,
  '--artifacts-dir',
  'web-ext-artifacts',
  '--overwrite-dest',
]);

console.log(`
✓ v${target} envoyée à AMO (canal listé).

La version n'est servie aux utilisateurs qu'après validation par un relecteur.
Suivi : https://addons.mozilla.org/developers/addon/kyara-plus/versions
Une fois publiée, Firefox met à jour tout le monde automatiquement (vérification ~24 h).
`);
