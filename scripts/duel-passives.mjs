#!/usr/bin/env node
// Convertit les passifs (texte libre) des champions du duel en données structurées `passiveFx`
// et réécrit content/duel-data.js en n'ajoutant QUE ce champ (reproductible, idempotent).
//
//   node scripts/duel-passives.mjs           -> réécrit content/duel-data.js
//   node scripts/duel-passives.mjs --check   -> vérifie seulement (code 1 si le fichier n'est pas à jour)
//
// Les 203 Mythiques (rarity 'M') sont obligatoires : le script échoue bruyamment (code 1) si un
// passif ne correspond à aucun modèle ni à la table explicite. Les 6 Légendaires présentes dans
// les données reçoivent aussi un `passiveFx` (hors périmètre v1, mais le moteur sait les jouer).
//
// ─── Schéma `passiveFx` ──────────────────────────────────────────────────────────────────────────
// passiveFx = { rules: [ règle, … ] }
// règle     = { when, effects: [ effet, … ], once?, perTurn?, hpAtMost?, ifLowHp? }
//   when :
//     'turnStart'    au début de chaque tour, SEULEMENT s'il est le champion actif (v2 : un banc ne joue pas)
//     'onSwitchIn'   (v2) quand il entre en jeu : changement volontaire ou remplacement après un K.O.
//                    (aucune donnée n'en utilise encore ; le moteur sait le jouer)
//     'onDamaged'    chaque fois qu'il encaisse un coup d'une capacité ennemie (≥ 1 dégât, garde comprise)
//     'onHit'        chaque fois qu'une de ses capacités touche un ennemi (non annulée)
//     'lowHp'        quand ses PV passent à 50 % ou moins de ses PV max
//     'hpAtMost'     quand ses PV passent à `hpAtMost` ou moins
//     'afterSupport' après qu'il a utilisé une capacité de soutien
//     'static'       effet permanent (modificateur ou règle d'initiative), jamais « déclenché »
//   once : true     -> une seule fois par duel (« une fois », « la première fois »)
//   perTurn : true  -> au plus une fois par tour de jeu (Akane)
//   ifLowHp : true  -> (turnStart) seulement si le champion est à 50 % de PV ou moins (Power)
// effet = { type, … } :
//   { type: 'heal', amount }                 le champion récupère `amount` PV
//   { type: 'guard', amount }                le champion gagne `amount` garde
//   { type: 'buff', amount }                 le champion prépare +`amount` dégâts
//   { type: 'atk', amount }                  +`amount` ATQ permanent pour le champion
//   { type: 'teamAtk', amount }              +`amount` ATQ permanent à chaque allié vivant (lui compris)
//   { type: 'status', status, turns }        statut sur lui-même (haste : turns = 1)
//   { type: 'foeStatus', status, turns }     statut sur un ennemi : la cible touchée (onHit)
//                                            ou le champion ACTIF adverse (turnStart, v2)
//   { type: 'dispel', turns }                retire `turns` tours à un de ses maux (poison,
//                                            malédiction, faiblesse : le plus long d'abord)
//   { type: 'healMostWounded', amount }      soigne l'allié vivant le plus blessé (PV max − PV)
//   { type: 'healBonus', amount }            (static) ses soins sont augmentés de `amount`
//   { type: 'initiative' }                   (static) son camp agit toujours en premier tant qu'il est l'actif
//   { type: 'initiative', foe, firstRound }  (static) face au champion actif nommé `foe`, son camp
//                                            agit en premier au tour 1
// Statuts : 'poison' | 'curse' | 'weakness' | 'rage' | 'regen' | 'haste'.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILE = join(ROOT, 'content/duel-data.js');
const PREFIX = 'window.KYARA_DUEL_DATA = ';

const STATUS = {
  'poison': 'poison',
  'faiblesse': 'weakness',
  'malédiction': 'curse',
  'rage': 'rage',
  'régénération': 'regen',
  'hâte': 'haste'
};

// Passifs uniques : traduits à la main. `desc` doit correspondre exactement au texte des données,
// sinon le script échoue (le texte a changé : relire la traduction).
const UNIQUE_BY_NAME = {
  'Rem': {
    desc: 'La première fois qu’elle tombe à 12 PV ou moins, elle gagne 7 de garde.',
    fx: { rules: [{ when: 'hpAtMost', hpAtMost: 12, once: true, effects: [{ type: 'guard', amount: 7 }] }] }
  },
  'Roxy Migurdia': {
    desc: 'Quand elle utilise un soutien, elle récupère aussi 2 PV.',
    fx: { rules: [{ when: 'afterSupport', effects: [{ type: 'heal', amount: 2 }] }] }
  },
  'Nami': {
    desc: 'Ses attaques infligent Faiblesse 1 en plus de leurs effets.',
    fx: { rules: [{ when: 'onHit', effects: [{ type: 'foeStatus', status: 'weakness', turns: 1 }] }] }
  },
  'Aqua': {
    desc: 'Tous ses soins sont augmentés de 1.',
    fx: { rules: [{ when: 'static', effects: [{ type: 'healBonus', amount: 1 }] }] }
  },
  'Subaru Natsuki': {
    desc: 'Il revit : ouvre toujours le tour, même face à plus rapide. Régénération 2 en début de tour.',
    fx: {
      rules: [
        { when: 'static', effects: [{ type: 'initiative' }] },
        { when: 'turnStart', effects: [{ type: 'status', status: 'regen', turns: 2 }] }
      ]
    }
  },
  // Légendaires (hors périmètre v1).
  'Ram': {
    desc: 'Face à Rem, son équipe commence toujours le duel, quoi qu’il arrive.',
    fx: { rules: [{ when: 'static', effects: [{ type: 'initiative', foe: 'Rem', firstRound: true }] }] }
  },
  'Sylphiette': {
    desc: 'Au début de chacun de ses tours, elle gagne 1 de garde.',
    fx: { rules: [{ when: 'turnStart', effects: [{ type: 'guard', amount: 1 }] }] }
  },
  'Doflamingo Donquixote': {
    desc: 'Ses attaques infligent aussi Malédiction 1.',
    fx: { rules: [{ when: 'onHit', effects: [{ type: 'foeStatus', status: 'curse', turns: 1 }] }] }
  },
  'Ai Hoshino': {
    desc: 'Au début de son tour, elle soigne de 2 PV l’allié vivant le plus blessé.',
    fx: { rules: [{ when: 'turnStart', effects: [{ type: 'healMostWounded', amount: 2 }] }] }
  },
  'Akane Kurokawa': {
    desc: 'La première fois qu’elle subit des dégâts dans un tour, elle gagne Rage 1.',
    fx: { rules: [{ when: 'onDamaged', perTurn: true, effects: [{ type: 'status', status: 'rage', turns: 1 }] }] }
  },
  'Coco': {
    desc: 'Au début de son tour, elle retire 1 tour à un poison, une faiblesse ou une malédiction.',
    fx: { rules: [{ when: 'turnStart', effects: [{ type: 'dispel', turns: 1 }] }] }
  }
};

const APOS = '[’\']';

// Traduit la proposition d'effet (« gagne 3 garde », « inflige Poison 1 »…) en effet structuré.
function parseEffect(text, context) {
  const t = text.trim();
  let m;
  if ((m = t.match(/^récupère (\d+) PV$/))) return { type: 'heal', amount: Number(m[1]) };
  if ((m = t.match(/^gagne (\d+) garde$/))) return { type: 'guard', amount: Number(m[1]) };
  if ((m = t.match(/^prépare \+(\d+) dégâts?$/))) return { type: 'buff', amount: Number(m[1]) };
  if ((m = t.match(/^gagne \+(\d+) ATQ permanent$/))) return { type: 'atk', amount: Number(m[1]) };
  if ((m = t.match(new RegExp(`^donne \\+(\\d+) ATQ à toute l${APOS}équipe$`)))) return { type: 'teamAtk', amount: Number(m[1]) };
  if ((m = t.match(/^gagne Hâte$/))) return { type: 'status', status: 'haste', turns: 1 };
  if ((m = t.match(/^gagne (Rage|Régénération) (\d+)$/))) return { type: 'status', status: STATUS[m[1].toLowerCase()], turns: Number(m[2]) };
  if ((m = t.match(/^inflige (Poison|Faiblesse|Malédiction) (\d+)$/))) return { type: 'foeStatus', status: STATUS[m[1].toLowerCase()], turns: Number(m[2]) };
  if ((m = t.match(new RegExp(`^dissipe (\\d+) tours? d${APOS}un mal$`)))) return { type: 'dispel', turns: Number(m[1]) };
  throw new Error(`effet de passif non reconnu « ${t} » (${context})`);
}

// Modèles des passifs courants.
const TEMPLATES = [
  {
    re: /^Au début de son tour, sous 50 % de PV, (?:il|elle) (.+)\.$/,
    build: (m, ctx) => ({ when: 'turnStart', ifLowHp: true, effects: [parseEffect(m[1], ctx)] })
  },
  {
    re: /^Au début de son tour, (.+)\.$/,
    build: (m, ctx) => ({ when: 'turnStart', effects: [parseEffect(m[1], ctx)] })
  },
  {
    re: new RegExp(`^Chaque fois qu${APOS}(?:il|elle) encaisse, (.+)\\.$`),
    build: (m, ctx) => ({ when: 'onDamaged', effects: [parseEffect(m[1], ctx)] })
  },
  {
    re: /^Sous 50 % de PV \(une fois\), (.+)\.$/,
    build: (m, ctx) => ({ when: 'lowHp', once: true, effects: [parseEffect(m[1], ctx)] })
  },
  {
    re: new RegExp(`^La première fois qu${APOS}(?:il|elle) passe sous 50 % de PV, (?:il|elle) (.+)\\.$`),
    build: (m, ctx) => ({ when: 'lowHp', once: true, effects: [parseEffect(m[1], ctx)] })
  },
  {
    re: /^Quand (?:il|elle) touche, (inflige .+)\.$/,
    build: (m, ctx) => ({ when: 'onHit', effects: [parseEffect(m[1], ctx)] })
  }
];

export function passiveFxOf(card) {
  const desc = String(card.passive?.desc ?? '').trim();
  const ctx = `${card.name} : « ${desc} »`;
  const unique = UNIQUE_BY_NAME[card.name];
  if (unique) {
    if (unique.desc !== desc) throw new Error(`passif unique modifié dans les données, relire la traduction (${ctx})`);
    return structuredClone(unique.fx);
  }
  for (const tpl of TEMPLATES) {
    const m = desc.match(tpl.re);
    if (m) return { rules: [tpl.build(m, ctx)] };
  }
  throw new Error(`passif non reconnu (${ctx})`);
}

const KNOWN_WHEN = new Set(['turnStart', 'onSwitchIn', 'onDamaged', 'onHit', 'lowHp', 'hpAtMost', 'afterSupport', 'static']);
const KNOWN_TYPES = new Set(['heal', 'guard', 'buff', 'atk', 'teamAtk', 'status', 'foeStatus', 'dispel', 'healMostWounded', 'healBonus', 'initiative']);
const KNOWN_STATUS = new Set(Object.values(STATUS));

// Validation partagée avec les tests (structure seulement).
export function validatePassiveFx(fx) {
  if (!fx || !Array.isArray(fx.rules) || !fx.rules.length) return 'rules[] vide';
  for (const r of fx.rules) {
    if (!KNOWN_WHEN.has(r.when)) return `déclencheur inconnu ${r.when}`;
    if (!Array.isArray(r.effects) || !r.effects.length) return 'effects[] vide';
    for (const e of r.effects) {
      if (!KNOWN_TYPES.has(e.type)) return `effet inconnu ${e.type}`;
      if (['status', 'foeStatus'].includes(e.type) && (!KNOWN_STATUS.has(e.status) || !(e.turns > 0))) return `statut invalide ${e.status}`;
      if (['heal', 'guard', 'buff', 'atk', 'teamAtk', 'healMostWounded', 'healBonus'].includes(e.type) && !(e.amount > 0)) return `montant invalide pour ${e.type}`;
      if (e.type === 'dispel' && !(e.turns > 0)) return 'dissipation invalide';
    }
  }
  return null;
}

function main() {
  const src = readFileSync(FILE, 'utf8');
  const nl = src.indexOf('\n');
  const header = src.slice(0, nl);
  const body = src.slice(nl + 1).replace(/\n$/, '');
  if (!header.startsWith('//') || !body.startsWith(PREFIX) || !body.endsWith(';')) {
    throw new Error('format inattendu de content/duel-data.js (commentaire, préfixe ou « ; » final)');
  }
  const data = JSON.parse(body.slice(PREFIX.length, -1));
  const errors = [];
  let mythics = 0;
  data.champions = data.champions.map((card) => {
    let fx;
    try {
      fx = passiveFxOf(card);
      const bad = validatePassiveFx(fx);
      if (bad) throw new Error(`${card.name} : ${bad}`);
    } catch (err) {
      errors.push(err.message);
      return card;
    }
    if (card.rarity === 'M') mythics += 1;
    // Insère passiveFx juste après passive, sans toucher aux autres champs.
    const out = {};
    for (const [k, v] of Object.entries(card)) {
      if (k === 'passiveFx') continue;
      out[k] = v;
      if (k === 'passive') out.passiveFx = fx;
    }
    if (!('passiveFx' in out)) out.passiveFx = fx;
    return out;
  });
  if (errors.length) {
    console.error(`ÉCHEC : ${errors.length} passif(s) non traduit(s) :\n- ${errors.join('\n- ')}`);
    process.exit(1);
  }
  const expected = data.champions.filter((c) => c.rarity === 'M').length;
  if (mythics !== expected) {
    console.error(`ÉCHEC : ${mythics}/${expected} Mythiques traduites.`);
    process.exit(1);
  }
  const next = `${header}\n${PREFIX}${JSON.stringify(data)};\n`;
  if (process.argv.includes('--check')) {
    if (next !== src) {
      console.error('content/duel-data.js n’est pas à jour : lancer node scripts/duel-passives.mjs');
      process.exit(1);
    }
    console.log(`passiveFx à jour : ${data.champions.length} champions (${mythics} Mythiques).`);
    return;
  }
  if (next === src) {
    console.log(`Aucun changement : ${data.champions.length} champions (${mythics} Mythiques) déjà à jour.`);
    return;
  }
  writeFileSync(FILE, next);
  console.log(`content/duel-data.js réécrit : passiveFx pour ${data.champions.length} champions (${mythics} Mythiques).`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
