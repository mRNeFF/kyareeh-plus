// Vérifie la cohérence des champions du duel (content/duel-data.js) :
// textes ↔ chiffres réels, noms en double, pronoms, textes tronqués.
// Ne juge pas l'équilibrage : seulement ce que la fiche carte affirme.
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../content/duel-data.js', import.meta.url), 'utf8');
const data = JSON.parse(src.slice(src.indexOf('{'), src.lastIndexOf('}') + 1));

let checks = 0;
let failures = 0;
function check(label, ok, detail = '') {
  checks += 1;
  if (!ok) {
    failures += 1;
    console.log(`ÉCHEC ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

const STATUS_WORDS = [
  ['weakness', /faiblesse\s*\(?(\d+)|affaiblit\s*\((\d+)/gi],
  ['curse', /malédiction\s*\(?(\d+)|maudit\w*\s*\(?(\d+)/gi],
  ['poison', /poison\s*\(?(\d+)|empoisonne\w*\s*\((\d+)/gi],
  ['rage', /rage\s*\(?(\d+)/gi],
  ['regen', /régénération\s*\(?(\d+)/gi]
];

const MENTIONS = [
  ['weakness', /faiblesse|affaibli|engourdit/i],
  ['curse', /malédiction|maudissent|qui maudit|maudit la/i],
  ['poison', /poison|empoisonn/i],
  ['haste', /(?<![a-zà-ÿ])hâte(?![a-zà-ÿ])/i],
  ['regen', /régénération/i]
];

function statusValues(move, key) {
  return [move.apply?.[key], move.selfApply?.[key]].filter((v) => v != null);
}

function numbers(text, re) {
  return [...text.matchAll(re)].map((m) => Number(m.slice(1).find((g) => g != null)));
}

function checkMove(card, move) {
  const label = `${card.name} · ${move.name}`;
  const text = String(move.desc ?? '');
  check(`${label} : description présente`, text.trim().length > 0);
  if (!text) return;

  // Dégâts annoncés (hors « +N dégâts » préparés et « N à M dégâts » aléatoires).
  const range = text.match(/(\d+)\s*à\s*(\d+)\s*dégâts/);
  if (range) {
    check(`${label} : dégâts aléatoires`, `${move.randomDamage}` === `${range[1]},${range[2]}`, `texte ${range[1]}–${range[2]}, données ${move.randomDamage}`);
  } else {
    const dmg = text.match(/(?<![+\d])(\d+)\s*dégâts?(?!\s*préparés)/);
    if (dmg) check(`${label} : dégâts`, Number(dmg[1]) === (move.damage ?? 0), `texte ${dmg[1]}, données ${move.damage ?? 0}`);
  }

  const teamAtk = text.match(/\+(\d+) ATQ(?: et \+\d+ PV)? à (?:toute )?(?:l’équipe|tous)|l’équipe de \d+ PV et \+(\d+) ATQ/);
  if (teamAtk) {
    const value = Number(teamAtk[1] ?? teamAtk[2]);
    check(`${label} : ATQ équipe`, value === (move.teamAtk ?? 0), `texte ${value}, données ${move.teamAtk ?? 0}`);
  }

  const selfAtk = text.match(/\+(\d+) ATQ pour (?:elle|lui)/);
  if (selfAtk) check(`${label} : ATQ perso`, Number(selfAtk[1]) === (move.selfAtk ?? 0), `texte ${selfAtk[1]}, données ${move.selfAtk ?? 0}`);

  const healTeam = text.match(/\+(\d+) PV à l’équipe|[Ss]oigne (?:toute )?l’équipe de (\d+) PV/);
  if (healTeam) {
    const value = Number(healTeam[1] ?? healTeam[2]);
    check(`${label} : soin équipe`, value === (move.healTeam ?? 0), `texte ${value}, données ${move.healTeam ?? 0}`);
  }

  const teamHp = text.match(/(?:chaque allié|allié) perd (\d+) PV/);
  if (teamHp) check(`${label} : PV équipe`, Number(teamHp[1]) === (move.teamHp ?? 0), `texte ${teamHp[1]}, données ${move.teamHp ?? 0}`);

  const recoil = text.replace(/(?:chaque allié|allié) perd \d+ PV/, '').match(/(?:perd|paie|encaisse|consume \() ?(\d+) PV/);
  if (recoil) check(`${label} : PV perdus`, Number(recoil[1]) === (move.recoil ?? 0), `texte ${recoil[1]}, données ${move.recoil ?? 0}`);

  const heal = text.match(/(?<!équipe )\b[Ss]oin (\d+)/);
  if (heal) check(`${label} : soin`, Number(heal[1]) === (move.heal ?? 0), `texte ${heal[1]}, données ${move.heal ?? 0}`);

  const guard = text.match(/\b(?:garde|[Bb]ouclier) (\d+)|protège \((\d+)\)/);
  if (guard) {
    const value = Number(guard[1] ?? guard[2]);
    check(`${label} : garde`, value === (move.guard ?? 0), `texte ${value}, données ${move.guard ?? 0}`);
  }

  const buff = text.match(/\+(\d+) dégâts? préparés|[Pp]répare \+(\d+) dégâts?|\+(\d+) dégâts? et (?:rage|hâte)/);
  if (buff) {
    const value = Number(buff[1] ?? buff[2] ?? buff[3]);
    check(`${label} : dégâts préparés`, value === (move.buff ?? 0), `texte ${value}, données ${move.buff ?? 0}`);
  }

  for (const [key, re] of STATUS_WORDS) {
    for (const value of numbers(text, re)) {
      check(`${label} : ${key} ${value}`, statusValues(move, key).includes(value), `données ${JSON.stringify(statusValues(move, key))}`);
    }
  }
  // Une dissipation nomme les maux qu'elle retire : ce ne sont pas des effets infligés.
  const effects = move.cleanse ? text.replace(/dissip.*$/i, '') : text;
  for (const [key, re] of MENTIONS) {
    if (re.test(effects)) check(`${label} : ${key} annoncé`, statusValues(move, key).length > 0, 'absent des données');
  }
  if (/saute son (?:prochain )?tour/.test(text)) check(`${label} : tour sauté`, move.skipFoe === true);
  if (/dissip/i.test(text)) check(`${label} : dissipation`, move.cleanse === true);
}

// Genre déduit des textes d'attaques (« elle perd », « Il se protège »…),
// sauf pour les championnes dont les attaques n'ont aucun pronom.
const FEMININE = new Set(['Rem', 'Roxy Migurdia', 'Nami', 'Ram', 'Akane Kurokawa', 'Emilia', 'Maomao']);
function gender(card) {
  if (FEMININE.has(card.name)) return 'F';
  const text = (card.attacks ?? []).map((m) => m.desc ?? '').join(' ');
  const f = (text.match(/\b[Ee]lle\b/g) ?? []).length;
  const m = (text.replace(/s’il est en face/g, '').match(/\b[Ii]l\b|\blui\b/g) ?? []).length;
  return f > m ? 'F' : m > f ? 'M' : null;
}

for (const card of data.champions) {
  const name = card.name;
  check(`${name} : passif complet`, /[.!…]$/.test(String(card.passive?.desc ?? '').trim()), JSON.stringify(card.passive?.desc));
  check(`${name} : 3 attaques`, card.attacks?.length === 3);

  const moveNames = (card.attacks ?? []).map((m) => m.name);
  check(`${name} : noms d'attaque uniques`, new Set(moveNames).size === moveNames.length, moveNames.join(' / '));
  check(`${name} : passif ≠ attaque`, !moveNames.includes(card.passive?.name), card.passive?.name);

  const g = gender(card);
  const passive = String(card.passive?.desc ?? '').replace(/quoi qu’il/g, '');
  if (g === 'F') check(`${name} : pronom du passif`, !/\b[Ii]l\b/.test(passive), passive);
  if (g === 'M') check(`${name} : pronom du passif`, !/\b[Ee]lle\b/.test(passive), passive);

  for (const move of card.attacks ?? []) checkMove(card, move);
}

console.log(`\nChampions : ${data.champions.length} · contrôles : ${checks} · échecs : ${failures}`);
process.exit(failures ? 1 : 0);
