#!/usr/bin/env node
/*
 * Kyareeh+ — paquet Chrome / Edge (Chrome Web Store, Edge Add-ons).
 *
 * Pourquoi un script : `manifest.json` est le manifeste **Firefox** (source de
 * vérité unique, lue par web-ext et par scripts/release.mjs). Chrome refuse en
 * MV3 la clé `background.scripts` et n'a que faire de `browser_specific_settings`
 * ou de `data_collection_permissions`. Plutôt que de maintenir deux manifestes à
 * la main (et de les désynchroniser au bump de version), celui de Chrome est
 * **dérivé** ici à chaque build :
 *
 *   background.scripts        -> background.service_worker
 *   browser_specific_settings -> supprimé (clé Firefox / AMO)
 *   + minimum_chrome_version
 *   + icône 128 (obligatoire pour la fiche Chrome Web Store)
 *
 * Le code (content/, background/, popup/, panel/, duel/) est copié **à l'identique** : aucun
 * transpileur, aucune minification, exactement comme le paquet AMO.
 *
 * Sorties :
 *   dist/chrome/                              -> extension décompressée (mode développeur)
 *   web-ext-artifacts/kyareeh-plus-<v>-chrome.zip -> paquet à téléverser
 *
 * Usage :
 *   node scripts/build-chrome.mjs            (build + zip)
 *   node scripts/build-chrome.mjs --no-zip   (dossier seul)
 */

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST_ROOT = join(ROOT, 'dist');
const DIST = join(DIST_ROOT, 'chrome');
const ARTIFACTS = join(ROOT, 'web-ext-artifacts');
const MIN_CHROME = '116';

/** Dossiers copiés tels quels dans le paquet (mêmes fichiers que le zip AMO). */
const COPY_DIRS = ['background', 'content', 'popup', 'icons', 'panel', 'duel'];

function fail(message) {
  console.error(`\n✗ ${message}\n`);
  process.exit(1);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/* --- 1. manifeste Chrome dérivé -------------------------------------- */

const source = readJson(join(ROOT, 'manifest.json'));

if (source.manifest_version !== 3) fail('manifest.json doit être en Manifest V3.');
if (!source.background?.scripts?.length) fail('manifest.json : background.scripts introuvable.');

const manifest = structuredClone(source);

delete manifest.browser_specific_settings;
manifest.background = { service_worker: 'background/background.js' };
manifest.minimum_chrome_version = MIN_CHROME;

if (existsSync(join(ROOT, 'icons', 'icon-128.png'))) {
  manifest.icons = { ...manifest.icons, 128: 'icons/icon-128.png' };
}

/* --- 2. validations Chrome Web Store --------------------------------- */

const version = String(manifest.version ?? '');
if (!/^\d+(\.\d+){1,3}$/.test(version)) fail(`Version Chrome invalide : "${version}".`);
if (String(manifest.name ?? '').length > 75) fail('Nom > 75 caractères (limite Chrome Web Store).');
if (String(manifest.description ?? '').length > 132) {
  fail(`Description > 132 caractères (${String(manifest.description).length}).`);
}
if (!manifest.icons) fail('manifest.icons manquant.');

/* --- 3. copie du code ------------------------------------------------ */

mkdirSync(DIST_ROOT, { recursive: true });
rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });

for (const dir of COPY_DIRS) {
  const from = join(ROOT, dir);
  if (!existsSync(from)) fail(`Dossier manquant : ${dir}`);
  cpSync(from, join(DIST, dir), { recursive: true });
}

writeFileSync(join(DIST, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

/* Toutes les ressources déclarées doivent exister dans le paquet. */
const referenced = [
  manifest.background.service_worker,
  manifest.action?.default_popup,
  // Pages d'extension ouvertes par le code (fenêtre détachée, iframe du duel) : hors manifeste.
  'panel/panel.html',
  'duel/duel.html',
  ...(manifest.content_scripts ?? []).flatMap((cs) => cs.js ?? []),
  ...Object.values(manifest.icons ?? {}),
  ...(manifest.web_accessible_resources ?? []).flatMap((war) =>
    (war.resources ?? []).filter((r) => !r.includes('*'))
  )
].filter(Boolean);

for (const file of new Set(referenced)) {
  if (!existsSync(join(DIST, file))) fail(`Ressource déclarée absente du paquet : ${file}`);
}

/* --- 4. zip (implémentation locale, aucune dépendance) ---------------- */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(date) {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  };
}

function listFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full));
    else if (entry.isFile()) out.push(full);
  }
  return out.sort();
}

function writeZip(sourceDir, outFile) {
  const parts = [];
  const central = [];
  let offset = 0;

  for (const file of listFiles(sourceDir)) {
    const name = Buffer.from(relative(sourceDir, file).split(sep).join('/'), 'utf8');
    const data = readFileSync(file);
    const packed = deflateRawSync(data, { level: 9 });
    const crc = crc32(data);
    const { time, date } = dosDateTime(statSync(file).mtime);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // noms UTF-8
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    parts.push(local, name, packed);

    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(0x0800, 8);
    header.writeUInt16LE(8, 10);
    header.writeUInt16LE(time, 12);
    header.writeUInt16LE(date, 14);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(packed.length, 20);
    header.writeUInt32LE(data.length, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt16LE(0, 30); // extra
    header.writeUInt16LE(0, 32); // commentaire
    header.writeUInt16LE(0, 34); // disque
    header.writeUInt16LE(0, 36); // attributs internes
    header.writeUInt32LE(0, 38); // attributs externes
    header.writeUInt32LE(offset, 42);
    central.push(header, name);

    offset += local.length + name.length + packed.length;
  }

  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(central.length / 2, 8);
  end.writeUInt16LE(central.length / 2, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  writeFileSync(outFile, Buffer.concat([...parts, centralBuf, end]));
}

/* --- 5. sortie ------------------------------------------------------- */

const files = listFiles(DIST).length;
console.log(`\n✓ Chrome : ${files} fichier(s) → ${relative(ROOT, DIST)}`);
console.log(`  manifeste : MV${manifest.manifest_version}, service worker, Chrome ≥ ${MIN_CHROME}`);
console.log(`  version   : ${version}`);

if (!process.argv.includes('--no-zip')) {
  mkdirSync(ARTIFACTS, { recursive: true });
  const zip = join(ARTIFACTS, `kyareeh-plus-${version}-chrome.zip`);
  writeZip(DIST, zip);
  const size = (statSync(zip).size / 1024).toFixed(0);
  console.log(`  zip       : ${relative(ROOT, zip)} (${size} Ko)`);
}

console.log(`
Pour tester : chrome://extensions → mode développeur → « Charger l'extension non empaquetée » → dist/chrome
Pour publier : https://chrome.google.com/webstore/devconsole → « Nouvel élément » → le zip ci-dessus.
`);
