#!/usr/bin/env node
// Ajout des Légendaires au duel : contrôle des lots et fusion dans content/duel-data.js.
//
//   node scripts/duel-legendaires.mjs check <lot.json> […]   -> contrôle chaque lot (code 1 si un échec)
//   node scripts/duel-legendaires.mjs merge <lot.json> […]   -> contrôle, puis insère ou remplace les
//                                                               champions (par id) et régénère passiveFx
//
// Un lot est un tableau JSON de champions au format de content/duel-data.js, SANS `passiveFx`
// (déduit du texte du passif par scripts/duel-passives.mjs). Contrat complet : docs/LEGENDAIRES.md.
//
// Les bornes ne sont pas inventées : pour chaque champ d'une capacité (dégâts, garde, soin, statut…)
// et chaque effet de passif, une Légendaire ne peut pas dépasser le maximum déjà présent chez les
// 203 Mythiques, ni utiliser une mécanique qu'aucune Mythique n'utilise (exceptions listées).
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { passiveFxOf, validatePassiveFx } from './duel-passives.mjs';
import { checkChampions } from '../test/verify-duel-data.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILE = join(ROOT, 'content/duel-data.js');
const PREFIX = 'window.KYARA_DUEL_DATA = ';

const TYPES = ['Duelliste', 'Mystique', 'Gardien', 'Gardienne', 'Soutien', 'Stratège'];
const KINDS = ['attack', 'support', 'ultimate'];
const NUMERIC = ['damage', 'heal', 'healTeam', 'guard', 'buff', 'selfAtk', 'teamAtk', 'teamHp', 'recoil', 'bonusIfLow'];
const FLAGS = ['cleanse', 'skipFoe', 'attackBlock'];
// Mécaniques rares des Mythiques, réservées (cibles nommées, résurrection, tour bonus…).
const FORBIDDEN = ['instakill', 'sacrifice', 'reviveAlly', 'healTeamFull', 'extraTurn', 'invincible', 'disableTurns', 'saveLethal'];
const ALLOWED_KEYS = new Set(['kind', 'name', 'desc', ...NUMERIC, ...FLAGS, 'randomDamage', 'apply', 'selfApply']);
const CARD_KEYS = new Set(['id', 'name', 'rarity', 'rarityLabel', 'series', 'role', 'hp', 'atk', 'image', 'passive', 'attacks', 'aura', 'speed']);

function readData() {
  const src = readFileSync(FILE, 'utf8');
  const nl = src.indexOf('\n');
  const body = src.slice(nl + 1).replace(/\n$/, '');
  if (!body.startsWith(PREFIX) || !body.endsWith(';')) throw new Error('format inattendu de content/duel-data.js');
  return { header: src.slice(0, nl), data: JSON.parse(body.slice(PREFIX.length, -1)) };
}

/** Bornes observées chez les Mythiques : max par (type de capacité, champ), statuts, passifs. */
function boundsFrom(mythics) {
  const max = {};
  const status = {};
  const passive = {};
  const bump = (obj, key, v) => {
    obj[key] = Math.max(obj[key] ?? 0, v);
  };
  for (const c of mythics) {
    bump(max, 'hp', c.hp);
    bump(max, 'atk', c.atk);
    for (const m of c.attacks) {
      for (const k of NUMERIC) if (typeof m[k] === 'number') bump(max, `${m.kind}.${k}`, m[k]);
      for (const k of FLAGS) if (m[k] === true) max[`${m.kind}.${k}`] = 1;
      if (Array.isArray(m.randomDamage)) bump(max, `${m.kind}.randomDamage`, m.randomDamage[1]);
      for (const side of ['apply', 'selfApply']) for (const [s, n] of Object.entries(m[side] ?? {})) bump(status, `${m.kind}.${side}.${s}`, n);
    }
    for (const r of c.passiveFx?.rules ?? []) {
      for (const e of r.effects) {
        const key = `${r.when}${r.ifLowHp ? '(bas)' : ''}${r.once ? '(1x)' : ''}:${e.type}${e.status ? `.${e.status}` : ''}`;
        bump(passive, key, e.amount ?? e.turns ?? 1);
      }
    }
  }
  const minHp = Math.min(...mythics.map((c) => c.hp));
  return { max, status, passive, minHp };
}

function checkBatch(list, bounds, existing, label) {
  const errors = [];
  const err = (who, msg) => errors.push(`${label} · ${who} : ${msg}`);
  if (!Array.isArray(list)) return [`${label} : un lot doit être un tableau JSON de champions`];
  const seen = new Set();
  for (const c of list) {
    const who = c?.name ?? JSON.stringify(c).slice(0, 40);
    if (!c || typeof c !== 'object') {
      err(who, 'champion invalide');
      continue;
    }
    for (const k of Object.keys(c)) if (!CARD_KEYS.has(k)) err(who, `champ inconnu « ${k} » (passiveFx est généré, pas écrit à la main)`);
    if (!Number.isInteger(c.id)) err(who, 'id entier attendu (identifiant kyara.games)');
    if (seen.has(c.id)) err(who, 'id en double dans le lot');
    seen.add(c.id);
    const prev = existing.get(c.id);
    if (prev && prev.rarity !== 'L') err(who, `id ${c.id} déjà pris par ${prev.name} (${prev.rarity})`);
    if (c.rarity !== 'L' || c.rarityLabel !== 'Légendaire') err(who, 'rarity « L » et rarityLabel « Légendaire » attendus');
    for (const k of ['name', 'series', 'image']) if (typeof c[k] !== 'string' || !c[k].trim()) err(who, `${k} manquant`);
    if (!TYPES.includes(c.role)) err(who, `rôle inconnu « ${c.role} » (${TYPES.join(', ')})`);
    if (!Number.isInteger(c.hp) || c.hp < bounds.minHp - 2 || c.hp > bounds.max.hp) err(who, `PV ${c.hp} hors bornes ${bounds.minHp - 2}–${bounds.max.hp}`);
    if (!Number.isInteger(c.atk) || c.atk < 1 || c.atk > bounds.max.atk) err(who, `ATQ ${c.atk} hors bornes 1–${bounds.max.atk}`);
    if (!Number.isInteger(c.aura) || c.speed !== c.aura) err(who, 'speed doit être égal à aura (valeur kyara.games)');

    // Passif : texte reconnu par un modèle de scripts/duel-passives.mjs, valeurs bornées.
    try {
      const fx = passiveFxOf(c);
      const bad = validatePassiveFx(fx);
      if (bad) err(who, `passif : ${bad}`);
      for (const r of fx.rules) {
        for (const e of r.effects) {
          const key = `${r.when}${r.ifLowHp ? '(bas)' : ''}${r.once ? '(1x)' : ''}:${e.type}${e.status ? `.${e.status}` : ''}`;
          const limit = bounds.passive[key];
          const v = e.amount ?? e.turns ?? 1;
          if (limit === undefined) err(who, `passif : combinaison « ${key} » absente des Mythiques`);
          else if (v > limit) err(who, `passif : ${key} = ${v} > ${limit} (max Mythique)`);
        }
      }
    } catch (e) {
      err(who, `passif : ${e.message}`);
    }
    if (typeof c.passive?.name !== 'string' || !c.passive.name.trim()) err(who, 'passive.name manquant');
    if (String(c.passive?.desc ?? '').length > 95) err(who, 'texte du passif trop long (95 max)');
    for (const k of Object.keys(c.passive ?? {})) if (!['id', 'name', 'desc'].includes(k)) err(who, `passive.${k} inattendu (seulement id, name, desc)`);

    // Capacités : attaque, soutien, ultime, dans cet ordre.
    const moves = Array.isArray(c.attacks) ? c.attacks : [];
    if (moves.map((m) => m?.kind).join() !== KINDS.join()) err(who, 'attacks = [attack, support, ultimate] dans cet ordre');
    for (const m of moves) {
      if (!m) continue;
      const mw = `${who} · ${m.name}`;
      for (const k of Object.keys(m)) {
        if (FORBIDDEN.includes(k)) err(mw, `mécanique réservée « ${k} »`);
        else if (!ALLOWED_KEYS.has(k)) err(mw, `champ inconnu « ${k} »`);
      }
      if (String(m.name ?? '').length > 30) err(mw, 'nom trop long (30 max)');
      if (String(m.desc ?? '').length > 95) err(mw, 'description trop longue (95 max)');
      for (const k of NUMERIC) {
        if (m[k] === undefined) continue;
        const limit = bounds.max[`${m.kind}.${k}`];
        if (!Number.isInteger(m[k]) || m[k] < 0) err(mw, `${k} entier positif attendu`);
        else if (limit === undefined) err(mw, `${k} sur un ${m.kind} : aucune Mythique ne le fait`);
        else if (m[k] > limit) err(mw, `${k} = ${m[k]} > ${limit} (max Mythique pour ${m.kind})`);
      }
      for (const k of FLAGS) {
        if (m[k] === undefined || m[k] === false) continue;
        if (m[k] !== true) err(mw, `${k} doit valoir true`);
        else if (!bounds.max[`${m.kind}.${k}`]) err(mw, `${k} sur un ${m.kind} : aucune Mythique ne le fait`);
      }
      if (m.randomDamage !== undefined) {
        const r = m.randomDamage;
        const limit = bounds.max[`${m.kind}.randomDamage`];
        if (!Array.isArray(r) || r.length !== 2 || !(r[0] < r[1])) err(mw, 'randomDamage = [min, max]');
        else if (limit === undefined || r[1] > limit) err(mw, `randomDamage hors bornes (max ${limit ?? 'aucun'})`);
      }
      for (const side of ['apply', 'selfApply']) {
        for (const [s, n] of Object.entries(m[side] ?? {})) {
          const limit = bounds.status[`${m.kind}.${side}.${s}`];
          if (limit === undefined) err(mw, `${side}.${s} sur un ${m.kind} : aucune Mythique ne le fait`);
          else if (!Number.isInteger(n) || n < 1 || n > limit) err(mw, `${side}.${s} = ${n} hors bornes 1–${limit}`);
        }
      }
      if (m.kind === 'attack' && !(m.damage > 0 || m.randomDamage)) err(mw, 'une attaque inflige des dégâts');
      if (m.kind === 'support' && m.damage) err(mw, 'un soutien n’inflige pas de dégâts');
    }

    // Cohérence texte ↔ chiffres (mêmes règles que test/verify-duel-data.mjs).
    checkChampions([c], (lbl, ok, detail) => {
      if (!ok) errors.push(`${label} · ${lbl}${detail ? ` — ${detail}` : ''}`);
    });
  }
  return errors;
}

function main() {
  const [cmd, ...files] = process.argv.slice(2);
  if (!['check', 'merge'].includes(cmd) || !files.length) {
    console.error('usage : node scripts/duel-legendaires.mjs check|merge <lot.json> […]');
    process.exit(2);
  }
  const { header, data } = readData();
  const mythics = data.champions.filter((c) => c.rarity === 'M');
  const bounds = boundsFrom(mythics);
  const existing = new Map(data.champions.map((c) => [Number(c.id), c]));
  const lots = files.map((f) => ({ f, list: JSON.parse(readFileSync(f, 'utf8')) }));
  const errors = lots.flatMap(({ f, list }) => checkBatch(list, bounds, existing, f.split(/[\\/]/).pop()));
  // Doublons entre lots.
  const ids = new Map();
  for (const { f, list } of lots) for (const c of list) {
    if (ids.has(c.id)) errors.push(`${c.name} : id ${c.id} présent dans ${ids.get(c.id)} et ${f}`);
    ids.set(c.id, f);
  }
  const total = lots.reduce((n, l) => n + l.list.length, 0);
  if (errors.length) {
    console.error(`ÉCHEC : ${errors.length} problème(s) sur ${total} champion(s) :\n- ${errors.join('\n- ')}`);
    process.exit(1);
  }
  if (cmd === 'check') {
    console.log(`OK : ${total} champion(s) conformes.`);
    return;
  }
  const incoming = lots.flatMap((l) => l.list);
  const byId = new Map(incoming.map((c) => [c.id, c]));
  let replaced = 0;
  data.champions = data.champions.map((c) => {
    const next = byId.get(Number(c.id));
    if (!next) return c;
    byId.delete(Number(c.id));
    replaced += 1;
    return next;
  });
  data.champions.push(...byId.values());
  writeFileSync(FILE, `${header}\n${PREFIX}${JSON.stringify(data)};\n`);
  execFileSync(process.execPath, [join(ROOT, 'scripts/duel-passives.mjs')], { stdio: 'inherit' });
  console.log(`Fusion : ${byId.size} ajouté(s), ${replaced} remplacé(s) ; ${data.champions.length} champions au total.`);
}

main();
