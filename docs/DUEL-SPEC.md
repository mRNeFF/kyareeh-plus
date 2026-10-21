# Kyara Duel — spécification v1 (Mythiques)

Document de référence pour construire le duel multijoueur **dans l'extension** (mode `+Duel`).
Trois chantiers travaillent en parallèle sur des fichiers **disjoints** ; ce document est leur
contrat commun. Toute divergence se règle ici, pas dans le code.

Conventions du dépôt (voir `AGENTS.md`) : tout en **français** (UI, commentaires, messages),
aucune donnée inventée, `esc()` sur toute interpolation dans le HTML, préfixe CSS `kp-`,
Shadow DOM, pas d'étape de build (fichiers JS chargés tels quels).

---

## 1. Périmètre v1

- **Seules les cartes Mythiques (`rarity === 'M'`) jouent** (203 champions dans
  `content/duel-data.js`). Les Légendaires et les cartes « support » de l'ancien mode sont ignorées.
- Format : **arène 5 contre 5**, 1 contre 1 joueur, tours alternés.
- Deck : **5 Mythiques distinctes**. En ligne, le client n'autorise que des cartes possédées
  (collection du compte) ; le serveur vérifie seulement que ce sont 5 Mythiques distinctes connues.
- Modes : **En ligne** (salon à code de 5 lettres via le relais WebSocket) et **Entraînement**
  contre l'IA, 100 % local (aucun serveur), avec n'importe quelles Mythiques.

## 2. Règles (proposition initiale — le chantier moteur l'ajuste par simulation)

Les valeurs marquées *(réglable)* sont des constantes globales du moteur (`RULES`), à régler
par simulation IA contre IA. **On ne modifie pas les chiffres des cartes** pour équilibrer.

### 2.1 Mise en place
- Chaque camp aligne ses 5 champions, PV pleins (`hp`), garde 0, aucun statut.
- **Manches** : à chaque manche, chaque joueur joue **un tour** (une action).
- **Initiative** : le camp dont le champion vivant le plus rapide (`speed`) est le plus rapide
  joue en premier dans la manche ; égalité → tirage avec la graine du match.
  Exceptions des données : Subaru vivant → son camp ouvre toujours la manche ; Ram face à Rem →
  son camp ouvre la première manche.

### 2.2 Tour d'un joueur
1. Le joueur gagne **1 chakra** *(réglable)*, plafond **5** *(réglable)*. Départ : 1 *(réglable)*.
2. Il choisit **un champion vivant** qui peut agir, **une de ses 3 capacités**, et une cible si besoin.
   - Attaque (`kind: attack`) : coût **0** chakra.
   - Soutien (`kind: support`) : coût **1** *(réglable)*.
   - Ultime (`kind: ultimate`) : coût **3** *(réglable)*, **une fois par champion et par duel**.
3. Il peut aussi **passer** (action `pass`). Délai de tour en ligne : **60 s**, sinon `pass` automatique.

### 2.3 Ciblage
- Cible **ennemie** obligatoire si la capacité a `damage`, `randomDamage`, `apply`, `skipFoe`
  ou `instakill`.
- Sinon, si elle a `heal`, `guard` ou `cleanse` : cible **alliée** au choix (soi compris).
  Si elle a une cible ennemie, `heal`/`guard`/`cleanse` s'appliquent au lanceur.
- `selfApply`, `buff`, `selfAtk`, `recoil`, `attackBlock`, `saveLethal`, `invincible`,
  `disableTurns` → le lanceur. `teamAtk`, `healTeam`, `healTeamFull`, `teamHp` → l'équipe (§2.5).

### 2.4 Dégâts
`dégâts = move.damage + atk + bonusATQ + dégâtsPréparés + rage − faiblesse + bonusIfLow`
- `atk` : ATQ de base de la carte ; `bonusATQ` : bonus permanents (`selfAtk`, `teamAtk`, passifs),
  plafonnés à **+6** *(réglable)*.
- `dégâtsPréparés` (`buff`) : consommés par la prochaine capacité **qui inflige des dégâts**.
- `bonusIfLow` : ajouté si le lanceur est à 50 % de ses PV ou moins.
- **Garde** absorbe d'abord ; le reste retire des PV. PV jamais négatifs.
- **Hâte** : la prochaine capacité à dégâts frappe **deux fois** (deux calculs), puis disparaît.
- Une capacité sans `damage` (soutien pur) n'inflige rien, même avec ATQ.

### 2.5 Effets (champs des capacités)
| Champ | Effet |
|---|---|
| `damage`, `randomDamage [a,b]` | dégâts de base (aléatoire = graine du match) |
| `heal` / `healTeam` / `healTeamFull` | soin cible / tous les alliés vivants / PV max |
| `guard` | garde (cumulable, plafond 20 *(réglable)*) |
| `buff` | dégâts préparés du lanceur |
| `selfAtk` / `teamAtk` | +ATQ permanent lanceur / alliés vivants |
| `teamHp` | chaque **autre** allié vivant perd N PV (minimum 1 PV) |
| `recoil` | le lanceur perd N PV, **ne peut pas en mourir** (minimum 1 PV) |
| `apply {status: n}` / `selfApply` | statut sur la cible ennemie / sur le lanceur |
| `cleanse` | retire poison, faiblesse et malédiction de la cible |
| `bonusIfLow` | voir §2.4 |
| `skipFoe` | le joueur adverse saute son prochain tour |
| `sacrifice` | met KO l'allié vivant le plus faible (hors lanceur) avant l'effet |
| `attackBlock` | annule entièrement la prochaine capacité ennemie qui toucherait le lanceur |
| `saveLethal` | le lanceur survit une fois à un coup létal avec 1 PV |
| `invincible N` | le lanceur ne subit aucun dégât pendant N manches |
| `disableTurns N` | le lanceur ne peut plus utiliser attaque/ultime pendant N de ses tours |
| `instakill [noms]` | si la cible porte un de ces noms, elle est mise KO |
| `reviveAlly` | ranime l'allié tombé le plus récent à 50 % PV, puis le lanceur tombe |
| `extraTurn` | le joueur rejoue immédiatement (pas de nouveau chakra) |

### 2.6 Statuts (durée en manches, décrémentée en fin de manche)
- **Poison N** : −2 PV *(réglable)* en fin de manche.
- **Malédiction N** : −1 PV en fin de manche et **aucun soin/régénération reçu**.
- **Faiblesse N** : −2 dégâts *(réglable)* à chaque coup infligé.
- **Rage N** : +2 dégâts *(réglable)* à chaque coup infligé.
- **Régénération N** : +2 PV *(réglable)* en fin de manche.
- **Hâte** : voir §2.4 (pas de durée, consommée).
Réappliquer un statut garde la durée la plus longue.

### 2.7 Passifs
Les passifs sont aujourd'hui du **texte libre**. Le chantier moteur les convertit en données
structurées `passiveFx` (déclencheur + effet), ajoutées à chaque Mythique de `duel-data.js`
par un script **reproductible** (`scripts/duel-passives.mjs`), avec traitement explicite des
passifs uniques (Rem, Roxy, Nami, Doflamingo, Subaru, Ram…). **Les 203 Mythiques doivent être
couverts** ; un test échoue sinon. Déclencheurs attendus : début de tour, quand il encaisse,
quand il touche, sous 50 % PV (une fois), première fois sous un seuil, après un soutien, etc.

### 2.8 Fin du duel
- Victoire : les 5 champions adverses KO.
- Limite : **30 manches** → victoire au plus grand total de PV restants en % ; égalité → nul.
- Abandon ou déconnexion > 60 s → défaite du joueur absent.

---

## 3. Moteur — `content/duel-engine.js` (chantier A)

Fichier **pur** : aucun DOM, réseau, stockage, `Date.now()` ni `Math.random()`.
Chargé à la fois comme content script (expose `window.KYARA_DUEL_ENGINE`) et par Node
(le relais) : en-tête UMD minimal, sans dépendance.

```js
const E = window.KYARA_DUEL_ENGINE; // ou require/import côté Node

E.RULES                                   // constantes réglables (§2)
E.mythics(data) -> champion[]             // Mythiques jouables de KYARA_DUEL_DATA
E.validateDeck(data, ids) -> { ok, error? }   // 5 Mythiques distinctes connues
E.createMatch({ data, seed, players: [{ id, name, deck: [ids x5] }, …x2] }) -> state
E.legalActions(state, playerIndex) -> action[]
E.applyAction(state, playerIndex, action) -> { state, events }   // ne mute pas l'entrée
E.currentPlayer(state) -> 0 | 1 | null      // null si terminé
E.chooseAction(state, playerIndex) -> action // IA (déterministe à partir de la graine)
E.describeEvent(event) -> string             // ligne de journal en français
```

- **`state` est un objet JSON simple** (sérialisable tel quel sur le réseau), avec au moins :
  `round`, `turn` (`0|1`), `players[i] = { id, name, chakra, skipNext, champions[] }`,
  `champions[j] = { id, name, image, hp, maxHp, atk, atkBonus, guard, buff, statuses{},
  ultimateUsed, alive, … }`, `winner` (`0|1|'draw'|null`), `rng` (état du PRNG), `log[]`.
- **`action`** : `{ type: 'move', actor: j, move: k, target?: { side: 0|1, index: j } }`
  ou `{ type: 'pass' }`. `applyAction` rejette (exception `Error` avec message français)
  toute action absente de `legalActions`.
- **`events`** : liste typée (`damage`, `heal`, `status`, `ko`, `revive`, `skip`, `chakra`,
  `round`, `turn`, `end`, …) pour animer l'UI et alimenter le journal.
- PRNG : mulberry32 (ou équivalent) dont l'état vit dans `state.rng`.

Livrables A : moteur, `passiveFx` dans les données + `scripts/duel-passives.mjs`,
`test/verify-duel-engine.mjs` (règles unitaires + tous les champs du §2.5 + 203 passifs),
`test/sim-duel.mjs` (N duels IA contre IA : durée moyenne, taux de victoire du premier joueur,
duels > 30 manches, champions sur/sous-performants), et **le livre de règles**
`content/duel-rules.js` (`window.KYARA_DUEL_RULES` : sections `{ id, titre, paragraphes[] }`
en français, fidèle au moteur final) + copie lisible `docs/REGLES-DUEL.md`.

---

## 4. Relais et protocole — `relay/` + `content/duel-net.js` (chantier B)

Serveur Node **autoritatif** : il exécute le moteur, valide chaque action, diffuse l'état.
Les clients n'envoient que des intentions.

- `relay/server.mjs` (+ `relay/package.json`, dépendance `ws`). Lit `../content/duel-data.js`
  et `../content/duel-engine.js` depuis le disque. `PORT` par variable d'environnement
  (Railway). `GET /` → `ok` (healthcheck). Démarrage depuis la racine : `node relay/server.mjs`.
- Salons : code de **5 lettres majuscules** (sans I/O ambigus), 2 joueurs, expiration après
  10 min d'inactivité. Reconnexion avec un **jeton** pendant 60 s. Délai de tour 60 s
  → `pass` automatique. Limites : taille de message, débit par client.

Messages JSON `{ t: type, … }` :

| Sens | `t` | Contenu |
|---|---|---|
| C→S | `hello` | `v: 1, name, deck: [ids]` |
| C→S | `create` / `join` | — / `code` |
| C→S | `action` | `seq, action` (seq = numéro d'état connu) |
| C→S | `rejoin` | `code, token` |
| C→S | `leave` / `ping` | — |
| S→C | `welcome` | `clientId, token` |
| S→C | `room` | `code, players[{name, ready}], status: 'waiting'\|'playing'\|'ended'` |
| S→C | `state` | `seq, you: 0\|1, state, events, deadline` (ms restantes) |
| S→C | `end` | `winner, reason: 'ko'\|'rounds'\|'forfeit'\|'timeout'` |
| S→C | `error` | `code, message` (français) |
| S→C | `peer` | `status: 'left'\|'back'` |
| S→C | `pong` | — |

**Client** `content/duel-net.js` → `window.KYARA_DUEL_NET` :

```js
const net = KYARA_DUEL_NET.connect(url, { name, deck, onEvent });  // onEvent(msg) pour chaque message serveur
net.create(); net.join(code); net.act(action); net.leave(); net.close();
net.status // 'connecting' | 'open' | 'closed' | 'reconnecting'
```
Reconnexion automatique (jeton conservé en mémoire), file d'envoi pendant la reconnexion.

Livrables B : serveur, client, `relay/README.md` (lancer en local, déployer sur Railway),
`test/verify-duel-relay.mjs` : démarre le serveur sur un port libre, deux clients Node jouent
un duel complet avec `chooseAction`, plus les cas d'erreur (code inconnu, salon plein, action
illégale, mauvais `seq`, deck invalide, reconnexion, délai de tour).

---

## 5. Interface — `content/ui.js` + `content/ui.css` (chantier C)

Le mode `+Duel` existe déjà (`duelState()`, `viewDuelCollection()`, `viewDuelRooms()`,
`renderTabs()`, cas `duel-*` dans `onClick`). On l'étend **sans toucher au mode +Tools**.

Onglets du mode `+Duel` : **Collection · Duel · Combat · Règles**.
- **Collection** : n'affiche que les Mythiques (filtre ajouté), deck de 5 inchangé.
- **Duel** (salon) : adresse du relais persistée (`storageSet`), Créer / Rejoindre (code),
  état du salon, bouton **Entraînement contre l'IA** (local, sans relais). Le deck en ligne doit
  être complet et composé de cartes possédées ; l'entraînement accepte n'importe quelles
  Mythiques et peut compléter le deck au hasard.
- **Combat** : deux rangées de 5 champions (image, nom, barre de PV, garde, statuts avec durée,
  ultime utilisé, KO grisé), chakra des deux joueurs, manche, à qui de jouer, minuteur en ligne.
  Pendant son tour : choisir un champion → une capacité (coût, désactivée si illégale, effets via
  `duelEffectText`) → une cible (surlignée), ou Passer. Journal des événements
  (`describeEvent`). Fin de duel : vainqueur, raison, Rejouer / Retour au salon. Abandonner.
- **Règles** : rendu de `window.KYARA_DUEL_RULES` (sommaire + sections).
- Actions légales = **uniquement** `legalActions` du moteur ; l'UI ne recalcule aucune règle.
- Entraînement : l'IA joue via `chooseAction` après un court délai (600 ms).

Livrables C : intégration UI, styles, `manifest.json` (ordre des scripts :
`duel-data.js`, `duel-rules.js`, `duel-engine.js`, `duel-net.js`, `ui.js`), `test/harness.html`
(charge les mêmes scripts) et la vérification dans le harness.

---

## 6. Répartition des fichiers (ne pas toucher aux fichiers d'un autre chantier)

| Chantier | Fichiers |
|---|---|
| A — moteur & règles | `content/duel-engine.js`, `content/duel-rules.js`, `content/duel-data.js` (ajout `passiveFx` uniquement, par script), `scripts/duel-passives.mjs`, `test/verify-duel-engine.mjs`, `test/sim-duel.mjs`, `docs/REGLES-DUEL.md` |
| B — relais & réseau | `relay/**`, `content/duel-net.js`, `test/verify-duel-relay.mjs` |
| C — interface | `content/ui.js`, `content/ui.css`, `manifest.json`, `test/harness.html` |
| Intégration | `docs/DUEL-SPEC.md`, `.web-ext-config.mjs`, `package.json`, `README.md`, `AGENTS.md` |

Les chantiers B et C codent contre les API des §3 et §4 avant que A ait fini ; si un fichier
d'un autre chantier n'existe pas encore, ils utilisent un bouchon **dans leurs propres fichiers
de test** et le signalent dans leur compte rendu.

---

## 7. Ajouts faits pendant la réalisation

- **Moteur** : `E.forfeit(state, player, 'forfeit'|'timeout')`, `E.targetMode(move)`,
  `E.STATUS_LABELS`, `E.KIND_LABELS`, `E.version` ; `createMatch` accepte `rules` (surcharge
  partielle de `E.RULES`, recopiée dans `state.rules`). Chaque capacité de l'état porte `cost`
  et `targeting` (`'enemy'|'ally'|'none'`). Passifs : `passiveFx = { rules: [{ when, effects, … }] }`
  (schéma documenté en tête de `scripts/duel-passives.mjs`). L'IA (`chooseAction`) ne fait
  jamais avancer `state.rng`. Le détail des décisions de règles est dans `content/duel-rules.js`.
- **Protocole** : message `rematch` ; `create`/`join`/`rematch` peuvent porter `name`/`deck` ;
  `state` porte `legal` (actions légales du destinataire) et `last` ; `room` porte `you` et
  `players[].seat/online` ; `end` porte `you`. Trois délais de tour consécutifs → défaite
  (`timeout`). Codes d'erreur listés dans `relay/README.md`.
- **Client** : `net.rematch()`, `net.setProfile()`, `net.timeLeft()`, évènement local
  `{ t: 'net', status }`, erreur locale `session_taken` (duel repris dans un autre onglet).
