# Kyara Duel — ajout des Légendaires

Les 200 Légendaires les plus populaires de kyara.games (`/api/characters`, rareté `L`, triées par
`favourites`) rejoignent les 203 Mythiques dans le duel. Les 6 Légendaires déjà présentes (Ram,
Sylphiette, Doflamingo, Ai Hoshino, Akane Kurokawa, Coco) deviennent jouables elles aussi.
Conventions : `AGENTS.md` (français partout, aucune donnée inventée côté jeu : id, nom, série,
image et aura viennent de l'API).

## 1. Format d'un champion

Un lot est un tableau JSON. Chaque champion :

```json
{
  "id": 63351, "name": "Akame", "rarity": "L", "rarityLabel": "Légendaire",
  "series": "Akame ga Kill!", "role": "Duelliste", "hp": 18, "atk": 3,
  "image": "https://s4.anilist.co/…png", "aura": 72, "speed": 72,
  "passive": { "id": "p_akame", "name": "Murasame", "desc": "Quand elle touche, inflige Poison 1." },
  "attacks": [
    { "kind": "attack", "name": "Murasame : coup unique", "desc": "Une entaille maudite : poison 2 tours.", "damage": 8, "apply": { "poison": 2 } },
    { "kind": "support", "name": "Assassin de Night Raid", "desc": "Elle disparaît dans l’ombre : garde 4 et Hâte.", "guard": 4, "selfApply": { "haste": 1 } },
    { "kind": "ultimate", "name": "Little Pepper", "desc": "Le Teigu brûle sa vie : 13 dégâts ; Akame perd 6 PV.", "damage": 13, "recoil": 6 }
  ]
}
```

- `id`, `name`, `series`, `image`, `aura` : copiés tels quels de l'API. `speed` = `aura`.
- `passiveFx` n'est **pas** écrit à la main : `scripts/duel-passives.mjs` le déduit du texte du passif.
- Contrôle : `node scripts/duel-legendaires.mjs check <lot.json>` ; fusion : `… merge <lot.json> […]`.

## 2. Type (champ `role`)

Le rôle est le type du duel. Il suit le personnage :

| Type | Pour qui | Couleur |
|---|---|---|
| Duelliste | combattants au corps à corps, bretteurs, bagarreurs, sportifs offensifs | rouge |
| Mystique | magie, pouvoirs, alters à distance, esprits, armes à feu, poison | violet |
| Gardien | protecteurs, boucliers, colosses, tanks, défenseurs | bleu |
| Soutien | soigneurs, idoles, musiciens, cuisiniers, cœurs de l'équipe | vert |
| Stratège | génies, manipulateurs, tacticiens, joueurs, détectives | jaune |

Efficacité : Duelliste ▶ Mystique ▶ Gardien ▶ Duelliste (×1,25 / ×0,8) ; Stratège ▶ Soutien (×1,15),
Soutien ▶ Stratège (×0,9). Les Mythiques comptent 92 Duellistes et seulement 7 Gardiens : pour
les Légendaires, viser au plus ~35 % de Duellistes et au moins ~15 % de Gardiens, sans trahir le
personnage.

## 3. Chiffres

Les plafonds sont vérifiés par l'outil (maximum déjà atteint par une Mythique). Les repères
ci-dessous sont les **moyennes** des Mythiques : une carte équilibrée s'en écarte peu.

| Type | PV | Attaque (dégâts) | Soutien | Ultime |
|---|---|---|---|---|
| Duelliste | 18–21 | 8–10 (+ recul 0–2) | garde 4 + Hâte ou Rage, ou soin 4 | 10–14 dégâts, recul 4–6 |
| Mystique | 17–19 | 6–9 + statut (faiblesse, malédiction, poison) | garde 4, ou soin 4 + dissipation, ou +2 dégâts préparés | 8–12 dégâts + statut, ou +3 ATQ équipe ; recul 4–6 |
| Gardien | 19–22 | 7–10 | garde 5–6 (+ soin 4 possible) | +3 ATQ et +4 PV à l'équipe, recul 3 ; ou 10–12 dégâts |
| Soutien | 17–19 | 5–8 + statut | soin 5 (+ dissipation ou garde 3) | +4 PV et +3 ATQ à l'équipe, recul 3–4 ; ou l'adversaire saute son tour, recul 8–10 |
| Stratège | 17–19 | 6–9 + faiblesse ou malédiction | garde 3 + 2–3 dégâts préparés | +3 à +4 ATQ équipe et 2–6 dégâts, recul 4–5 ; ou saut de tour, recul 8 |

- `atk` vaut 3 (Soutien : 1 à 3). Les PV sont le premier bouton d'équilibrage.
- Une capacité forte se paie : recul (`recoil`), coût en PV de l'équipe (`teamHp`), statut sur soi.
- Équilibrage final : simulation IA contre IA (`node test/sim-duel.mjs`), chaque champion entre
  30 et 70 % de victoires ; le coordinateur ajuste ensuite (PV d'abord, puis chiffres + texte).

## 4. Mécaniques autorisées (champs d'une capacité)

| Champ | Effet |
|---|---|
| `damage` | dégâts à l'actif adverse (+ ATQ du lanceur) |
| `randomDamage: [a, b]` | dégâts aléatoires (ultime seulement) |
| `bonusIfLow` | dégâts en plus si le lanceur est à 50 % de PV ou moins (attaque) |
| `apply: { statut: tours }` | statut sur la cible : `weakness` (−4 dégâts), `curse` / `poison` (1 dégât par tour) |
| `selfApply: { statut: tours }` | statut sur soi : `rage` (+2 dégâts), `regen` (+4 PV par tour), `haste` (1 : la prochaine attaque frappe deux fois, 2e coup à 35 %) |
| `guard`, `heal`, `cleanse: true` | garde / soin / dissipation des maux, sur soi ou un allié du banc (soutien) |
| `buff` | dégâts préparés pour la prochaine attaque |
| `selfAtk`, `teamAtk` | ATQ permanente pour soi / pour toute l'équipe |
| `healTeam` | soin de toute l'équipe, banc compris |
| `teamHp` | chaque allié (hors lanceur) perd des PV |
| `recoil` | le lanceur perd des PV |
| `skipFoe: true` | l'adversaire perd sa prochaine action (ultime) |
| `attackBlock: true` | annule la prochaine capacité ennemie qui le vise (soutien) |

Réservés aux Mythiques (refusés par l'outil) : `instakill`, `sacrifice`, `reviveAlly`,
`healTeamFull`, `extraTurn`, `invincible`, `disableTurns`, `saveLethal`.
Une ultime qui ne fait que buffer l'équipe garde `"damage": 1` (convention des Mythiques).

## 5. Passif : un des modèles exacts

Le texte doit suivre **mot pour mot** un de ces modèles (`il` ou `elle` selon le personnage) :

- `Au début de son tour, <effet>.`
- `Au début de son tour, sous 50 % de PV, il <effet>.`
- `Chaque fois qu’il encaisse, <effet>.`
- `Sous 50 % de PV (une fois), <effet>.`
- `La première fois qu’il passe sous 50 % de PV, il <effet>.`
- `Quand il touche, inflige <Poison|Faiblesse|Malédiction> N.`

`<effet>` : `récupère N PV` · `gagne N garde` · `prépare +N dégâts` · `gagne +N ATQ permanent` ·
`donne +N ATQ à toute l’équipe` · `gagne Hâte` · `gagne Rage N` · `gagne Régénération N` ·
`inflige Poison N` · `inflige Faiblesse N` · `inflige Malédiction N` · `dissipe N tours d’un mal`.

Repères : début de tour → soin 1–2, garde 1–3, +1–2 dégâts préparés, dissipation 1–2 ;
« quand il encaisse » → garde 2–3 ou Rage 1–2 ; sous 50 % (une fois) → garde 5–7, +2 ATQ, Hâte ;
« quand il touche » → statut 1. Pas de `+N ATQ permanent` en début de tour au-delà de 1.

## 6. Textes (vérifiés par `test/verify-duel-data.mjs`)

- Français, apostrophe typographique `’`. Nom de capacité ≤ 30 caractères, description ≤ 95.
- Les capacités reprennent les **vraies techniques, armes ou répliques** du personnage (noms
  d'origine ou traductions françaises usuelles : « Rasengan », « Gomu Gomu », « Za Warudo »…).
  Pour un personnage sans pouvoirs, ses gestes et traits connus (guitare, cuisine, shogi…).
- Tout chiffre écrit correspond aux données : « N dégâts » = `damage`, « garde N », « soin N »,
  « perd / paie N PV » = `recoil`, « +N ATQ à l’équipe » = `teamAtk`, « +N PV à l’équipe » ou
  « soigne l’équipe de N PV » = `healTeam`, « chaque allié perd N PV » = `teamHp`,
  « +N dégâts préparés » = `buff`, « poison / faiblesse / malédiction / rage / régénération N ».
- Nommer un statut (poison, faiblesse, malédiction, hâte, régénération) implique qu'il soit dans
  les données ; « dissipe » implique `cleanse` ; « saute son tour » implique `skipFoe`.
- Pronoms (il / elle) cohérents avec le personnage, entre passif et capacités.
- Noms de capacités uniques dans la carte ; le nom du passif diffère des capacités.
