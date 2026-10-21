# Kyara Duel v2 — combat « à la Pokémon », application détachable, effets

Plan **et** contrat des chantiers v2 (branche `duel-v2`, partie de `duel-natif`). Remplace, pour
le combat, les §2–§5 de `docs/DUEL-SPEC.md` ; le reste de DUEL-SPEC (périmètre Mythiques,
conventions, relais autoritatif) reste valable. Conventions : `AGENTS.md` (français partout,
`esc()`, aucune donnée inventée, aucun chiffre de carte modifié pour équilibrer).

## 0. État d'avancement (à tenir à jour par le coordinateur)

| Chantier | Statut |
|---|---|
| A — moteur v2 + règles + équilibrage | à faire |
| B — relais v2 (choix simultanés) | à faire |
| C — application duel détachable | à faire |
| D — effets (sons, particules, carte d'ultime) | à faire |
| Intégration + test navigateur | à faire |

Reprise : lire ce fichier, `git log duel-v2`, puis relancer les chantiers non terminés.

---

## 1. Boucle de jeu (chantier A)

**Équipe de 5 Mythiques, un seul champion actif de chaque côté, banc de 4.**

1. **Choix simultanés** : à chaque tour, les deux joueurs choisissent en secret une action :
   - **Capacité** du champion actif (attaque / soutien / ultime, coûts en chakra comme v1) ;
   - **Changement** : rappeler l'actif et envoyer un champion du banc vivant ;
   - **Passer** (toujours légal ; aussi l'action par défaut à l'expiration du délai).
2. **Résolution** : d'abord les changements (les deux camps), puis les capacités par
   **vitesse** décroissante (`speed` + modificateurs), égalité → graine. Priorités spéciales
   reprises des données (Subaru : son camp agit d'abord ; Ram face à Rem au premier tour).
   Si l'actif ciblé a été remplacé avant la résolution, la capacité frappe le **nouvel actif**.
3. **K.O.** : quand l'actif tombe, son joueur choisit un remplaçant (**phase de remplacement**,
   gratuite, sans coût de tour) avant le tour suivant. Le camp sans remplaçant perd.
4. **Chakra** (conservé) : +1 par tour aux deux joueurs, départ et plafond réglables ;
   attaque 0, soutien 1, ultime ≈ 4 (une fois par champion). Changer est **gratuit** mais
   consomme le tour (réglable : `switchCost`).
5. **Banc** : les statuts continuent de s'écouler ; poison/malédiction/régénération ne
   s'appliquent qu'à l'actif (réglable). `teamAtk`, `healTeam`, `healTeamFull`, `teamHp`
   touchent tout le camp, banc compris. Les soutiens à cible alliée peuvent viser un
   allié du banc (soin/garde/dissipation) — c'est l'intérêt tactique du banc.
6. **Types = rôles**, avec une petite table d'efficacité (réglable, peut être neutralisée si la
   simulation la rend déséquilibrée) :
   Duelliste ▶ Mystique ▶ Gardien ▶ Duelliste (×1,25 / ×0,8) ; Stratège ▶ Soutien ▶ Stratège
   faible (×1,15 / ×0,9) ; le reste neutre. `Gardienne` = `Gardien`.
   Couleurs (utilisées par les effets) : Duelliste `#ff5a4e`, Mystique `#a66bff`,
   Soutien `#3fd68a`, Gardien `#4aa3ff`, Stratège `#ffc24a`.
7. Effets spéciaux v1 réinterprétés en 1 contre 1 : `skipFoe` → l'adversaire perd sa
   prochaine action ; `extraTurn` → action bonus résolue à la fin du tour ; `sacrifice`,
   `reviveAlly`, `instakill`, `attackBlock`, `saveLethal`, `invincible`, `disableTurns`
   comme v1 en visant l'actif/le banc de façon cohérente. Nouveau déclencheur de passif
   **à l'entrée en jeu** (`onSwitchIn`) si utile ; les passifs « début de tour » ne jouent que
   pour l'actif.
8. Fin : tous les champions adverses K.O. ; limite de tours réglable → % de PV restants.

**Objectifs d'équilibrage** (simulation IA contre IA, plusieurs graines, ≥ 12 000 duels) :
durée moyenne 12–25 tours, aucun avantage de camp (45–55 %), < 3 % de duels à la limite,
**chaque Mythique entre 30 et 70 %** de victoires, et des changements réellement utilisés par
l'IA (part des actions « changement » rapportée). Seules les constantes de `E.RULES` bougent.

### API moteur v2 (`content/duel-engine.js`, toujours pur, UMD)

```js
E.RULES, E.TYPES               // { Duelliste: { color, label, strong: [...], weak: [...] }, … }
E.mythics(data), E.validateDeck(data, ids)
E.createMatch({ data, seed, players: [{ id, name, deck }, …], rules? }) -> state
// state.phase : 'choose' (les deux choisissent) | 'replace' (remplacement après K.O.) | 'ended'
E.pendingPlayers(state) -> [0|1]          // qui doit encore choisir
E.legalActions(state, player) -> action[] // { type:'move', move:k, target?:{side,index} } |
                                          // { type:'switch', to:j } | { type:'pass' }
E.submit(state, player, action) -> { state, events, resolved }  // range le choix ; résout le tour
                                          // quand tous les choix attendus sont là (resolved=true)
E.viewFor(state, player) -> state         // copie sans le choix secret adverse (pour le réseau)
E.chooseAction(state, player) -> action   // IA : sait changer (type défavorable, PV bas, K.O.)
E.forfeit(state, player, reason), E.describeEvent(event), E.typeOf(champion)
```
`state.players[i] = { …, active: j, champions[5] }`. Événements v1 conservés + `switch`
{side, from, to}, `phaseReplace` {player}, `effectiveness` {mult}, `turnOrder` {order}, avec
`side/index/name/type/color` sur les événements de champion (pour les effets).

## 2. Relais v2 (chantier B)

Même serveur, même protocole v1 avec : `state` envoyé via `E.viewFor` (jamais le choix secret
adverse), champ `pending` (qui doit choisir), `phase`. `action` = soumission du choix du tour
(ou du remplaçant) ; message `chosen` {player} pour signaler que l'adversaire a choisi (sans
dire quoi). Délai par phase (choix 45 s, remplacement 20 s, réglables) → `pass` / premier
remplaçant vivant automatique. Version de protocole `v: 2`.

## 3. Application duel détachable (chantier C)

Le duel quitte `content/ui.js` et devient une **page d'extension autonome** :
`duel/duel.html`, `duel/duel-app.js`, `duel/duel.css`, chargeant `content/duel-data.js`,
`duel-rules.js`, `duel-engine.js`, `duel-net.js`, `duel/duel-fx.js`.

- **Intégrée** : le mode +Duel du panneau affiche cette page dans une `<iframe>`
  (ressource `web_accessible_resources`), à pleine hauteur du panneau.
- **Détachée** : bouton « Détacher » → le script de fond ouvre `duel/duel.html` dans sa propre
  fenêtre (`windows.create`, type `popup`, ~1100×760). Dans la fenêtre : bouton « Rattacher »
  (ferme la fenêtre). Une seule instance à la fois.
- **Profil** : la page n'a pas la session kyara.games. Le content script publie dans
  `storage.local` (`kyareeh.duel.profile` = `{ name, owned: [ids], at }`) à chaque chargement
  de la collection ; la page lit cette clé (et écoute `storage.onChanged`). Deck et adresse du
  relais restent dans `kyareeh.duel.v1`.
- **Écrans** : Collection/Deck, Salon (entraînement IA, en ligne), **Combat**, Règles.
- **Combat façon Pokémon** : terrain avec l'actif adverse en haut à droite et le sien en bas
  à gauche (grandes cartes, PV, garde, statuts, type coloré), banc de 4 en vignettes de chaque
  côté (PV, K.O.), barre de chakra, menu d'actions (4 boutons : 3 capacités + Changer ;
  Passer discret), écran de remplacement après K.O., « En attente de l'adversaire… », minuteur,
  journal dépliable. Les événements d'un tour sont **joués en séquence** (file d'animations),
  chacun appelant le module d'effets.
- `content/ui.js` : on retire l'ancienne interface de duel (rendu combat/salon/collection) au
  profit de l'iframe + bouton Détacher ; on garde la publication du profil. Mode +Tools intact.

## 4. Effets (chantier D) — `duel/duel-fx.js`

Module autonome sans dépendance, `window.KYARA_DUEL_FX` :

```js
const fx = KYARA_DUEL_FX.create(rootEl, { muted, volume })   // couche canvas + overlay
fx.attack({ fromEl, toEl, color, kind })   // projectile/traînée de particules de la couleur du type
fx.hit({ el, color, amount, crit, effectiveness })  // éclats, secousse, chiffre flottant
fx.heal({ el, amount }), fx.guard({ el, amount }), fx.status({ el, status }), fx.ko({ el })
fx.switchOut({ el }), fx.switchIn({ el, color })
fx.ultimate({ name, champion, image, color }) -> Promise  // carte clignotante plein écran :
     // image du personnage, nom de l'ultime, nom du champion, flash + rayons couleur du type, ~1,6 s, clic pour passer
fx.sound(name)        // sons synthétisés WebAudio (aucun fichier) : hit, crit, heal, guard,
     // status, ko, switch, ultimate, chakra, select, victory, defeat
fx.setMuted(b), fx.setVolume(v), fx.destroy()
```
Respecte `prefers-reduced-motion` (effets réduits). Tout est en canvas/CSS, 60 i/s, aucun
fichier binaire ajouté. Page de démo `duel/fx-demo.html` pour tester chaque effet.

## 5. Répartition des fichiers

| Chantier | Fichiers |
|---|---|
| A | `content/duel-engine.js`, `content/duel-rules.js`, `docs/REGLES-DUEL.md`, `scripts/duel-passives.mjs` (+ `passiveFx` de `duel-data.js` si nouveau déclencheur), `test/verify-duel-engine.mjs`, `test/sim-duel.mjs` |
| B | `relay/**`, `content/duel-net.js`, `test/verify-duel-relay.mjs`, `test/stub-duel-engine.cjs` |
| C | `duel/duel.html`, `duel/duel-app.js`, `duel/duel.css`, `content/ui.js`, `content/ui.css`, `background/background.js`, `manifest.json`, `test/harness.html` |
| D | `duel/duel-fx.js`, `duel/fx-demo.html` |
| Coordinateur | `docs/**` (sauf REGLES-DUEL.md), `README.md`, `AGENTS.md`, `package.json`, `.web-ext-config.mjs` |

B et C codent contre l'API du §1 avant que A ait fini (bouchon dans leurs propres fichiers de
test si besoin) ; C consomme `KYARA_DUEL_FX` du §4. Aucun chantier ne fait de commit : le
coordinateur commite.
