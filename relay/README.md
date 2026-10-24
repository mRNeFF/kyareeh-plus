# Relais du duel Kyara

Serveur WebSocket **autoritatif** du duel de Kyareeh+ (voir `docs/DUEL-SPEC.md` §4 pour le
protocole de base et `docs/DUEL-V2.md` §2 pour les choix simultanés). Il exécute le moteur
`content/duel-engine.js` avec les données `content/duel-data.js`, lus directement depuis le dépôt :
les clients n'envoient que des intentions, chaque choix est validé par le moteur.

**Protocole v2 (`v: 2`)** : le combat est « à la Pokémon ». À chaque tour, les **deux** joueurs
rangent en secret un choix (capacité, changement ou passer) ; l'adversaire apprend seulement
« il a choisi » (message `chosen`). Quand les deux choix sont là, le moteur résout le tour et **tous
ses événements** partent aux deux joueurs dans un seul message `state` (`seq` croissant). Après un
K.O., une phase de **remplacement** demande un champion du banc au(x) joueur(s) concerné(s). Un
client v1 reçoit l'erreur `version` à son `hello`.

Une seule dépendance : [`ws`](https://github.com/websockets/ws). Node 20 ou plus récent.

> **Adresse côté extension.** Le paquet ne contient **aucune adresse de relais par défaut** :
> le joueur la saisit dans l'écran **Salon** (champ « Adresse du relais »), et elle est
> conservée dans ses préférences. Pour figer une adresse publique, renseigner la constante
> `DEFAULT_RELAY` en tête de `duel/duel-app.js` (par exemple `wss://<service>.up.railway.app`)
> puis reconstruire : le champ est alors prérempli. Tant qu'aucun relais n'est déployé, le
> salon affiche « Aucun serveur de jeu configuré » ; l'entraînement contre l'IA reste local.

## Lancer en local

Depuis la **racine du dépôt** (le serveur lit `../content/*`) :

```bash
npm ci --prefix relay          # installe ws dans relay/node_modules (non versionné)
node relay/server.mjs          # écoute sur le port 8080
```

Sous Windows, utiliser `npm.cmd ci --prefix relay` si les scripts PowerShell sont bloqués.

- Vérification : `http://localhost:8080/` répond `ok`.
- Dans l'application duel (écran Salon), adresse du relais : `ws://localhost:8080`.
- Test complet (serveur + client, choix simultanés, remplacement, délais, reconnexion, erreurs) :

```bash
node test/verify-duel-relay.mjs          # vrai moteur (content/duel-engine.js)
node test/verify-duel-relay.mjs --stub   # bouchon test/stub-duel-engine.cjs
```

Le test affiche `Contrôles : N · échecs : M` et sort en code 1 au moindre échec.

## Variables d'environnement

| Variable | Défaut | Rôle |
|---|---|---|
| `PORT` | `8080` | Port d'écoute (fourni par Railway). |
| `HOST` | toutes les interfaces | Interface d'écoute. |
| `DUEL_CHOOSE_MS` | `45000` | Délai de la phase de choix ; à expiration, le serveur joue `pass` pour chaque joueur en retard (`DUEL_TURN_MS`, nom v1, reste accepté). |
| `DUEL_REPLACE_MS` | `20000` | Délai de la phase de remplacement après un K.O. ; à expiration, le serveur envoie le **premier champion vivant du banc** (plus petit index). |
| `DUEL_MAX_TIMEOUTS` | `3` | Délais expirés **d'affilée** (choix joués par le serveur) avant défaite `timeout`. Un vrai choix remet le compteur à zéro. |
| `DUEL_GRACE_MS` | `60000` | Délai de reconnexion (jeton) avant défaite `forfeit`. |
| `DUEL_IDLE_MS` | `600000` | Salon fermé après 10 min sans message de ses joueurs (le `ping` ne compte pas). |
| `DUEL_SWEEP_MS` | `30000` | Fréquence du ménage des salons inactifs. |
| `DUEL_HEARTBEAT_MS` | `30000` | Ping WebSocket pour couper les connexions mortes. |
| `DUEL_MAX_MESSAGE` | `8192` | Taille maximale d'un message client (octets) ; au-delà de 4× la connexion est coupée. |
| `DUEL_RATE_BURST` / `DUEL_RATE_PER_SEC` | `20` / `10` | Débit par connexion (seau à jetons). |
| `DUEL_MAX_ROOMS` | `2000` | Nombre maximal de salons simultanés. |
| `DUEL_ORIGINS` | vide (toutes) | Liste blanche d'en-têtes `Origin`, séparés par des virgules. |
| `DUEL_ENGINE` / `DUEL_DATA` | `content/…` | Autre moteur ou autres données (tests). |
| `DUEL_LOG` | `1` | `0` coupe le journal console. |

## Déployer sur Railway

1. **New Project → Deploy from GitHub repo**, choisir le dépôt `kyareeh-plus` (branche voulue).
2. Dans les réglages du service :
   - **Root Directory** : laisser la **racine du dépôt** (`/`), car le serveur lit `content/duel-engine.js`
     et `content/duel-data.js`.
   - **Config-as-code** : *Railway Config File* = `/relay/railway.json`. Ce fichier règle tout seul
     la construction (`npm ci --prefix relay --omit=dev`), le démarrage (`node relay/server.mjs`)
     et le healthcheck (`GET /`).
   - À défaut, saisir à la main : *Build Command* `npm ci --prefix relay --omit=dev`,
     *Start Command* `node relay/server.mjs`, *Healthcheck Path* `/`.
3. Ne pas définir `PORT` : Railway l'injecte. Les autres variables ci-dessus sont facultatives.
4. **Settings → Networking → Generate Domain**. L'adresse à saisir dans le panneau est
   `wss://<le-domaine>.up.railway.app` (Railway termine le TLS ; pas de port à préciser).

Le relais garde tout en mémoire : un redémarrage ou un redéploiement ferme les salons en cours.
Une seule instance suffit (ne pas activer plusieurs réplicas : les salons ne sont pas partagés).

## Protocole v2 (résumé)

Messages JSON `{ t: type, … }`. Fonctions du moteur utilisées (§1 de `docs/DUEL-V2.md`) :
`createMatch`, `pendingPlayers`, `legalActions`, `submit`, `viewFor`, `chooseAction`, `forfeit`,
`describeEvent`, `validateDeck`. Le relais refuse de démarrer avec un moteur v1.

Client → serveur :

| `t` | Contenu |
|---|---|
| `hello` | `v: 2, name, deck: [ids]` — toute autre version → erreur `version` |
| `create` / `join` | — / `code` ; peuvent porter `name` / `deck` |
| `action` | `seq, action` — **un seul choix par phase**, parmi `state.legal` : `{type:'move', move, target?}`, `{type:'switch', to}`, `{type:'pass'}`. En phase `replace` : seulement `{type:'switch', to}`. |
| `rematch` | revanche (les deux joueurs l'envoient) ; peut porter `name` / `deck` |
| `rejoin` | `code, token` — reprise de place pendant le délai de grâce |
| `leave` / `ping` | — |

Serveur → client :

- `welcome { clientId, token, v, rejoined? }`
- `room { code, status: 'waiting'|'playing'|'ended', you, players[{ seat, name, online, ready }] }`
- `state { seq, you, phase, pending, chosen, choice, state, events, deadline, timer, legal, last }`
  - `phase` : `'choose'` (les deux choisissent), `'replace'` (remplacement après K.O.), `'ended'` ;
  - `pending` : joueurs (`0|1`) qui doivent encore choisir ; `chosen` : joueurs attendus qui ont déjà verrouillé ;
  - `choice` : **mon** choix verrouillé de la phase (`null` sinon), ce qui permet de le retrouver après
    une reconnexion ; jamais celui de l'adversaire ;
  - `state` : toujours `E.viewFor(état, you)` (le choix secret adverse n'y figure pas) ;
  - `events` : tous les événements du tour résolu (vide pour un état renvoyé tel quel : début de
    duel, reprise, `stale_seq`). Ils contiennent aussi les événements `chosen` du moteur (à ignorer côté UI) ;
  - `deadline` : ms restantes de la **phase** (`null` hors duel) ; `timer` : durée totale de la phase (jauge) ;
  - `legal` : actions légales du destinataire (vide s'il n'est pas dans `pending`) ;
  - `last` : `{ phase, actions: [a0, a1], auto: [bool, bool] }` du tour qui vient d'être résolu (les
    deux choix sont révélés *après* la résolution ; `auto` = joué par le serveur à l'expiration), ou
    `{ player, actions: [null,null], auto: [false,false], forfeit }` pour un abandon.
- `chosen { seq, player, pending, chosen, auto }` : un joueur vient de verrouiller son choix (le tour
  n'est pas résolu, `seq` ne change pas). **Seul l'auteur reçoit en plus `action`** (son propre choix) ;
  l'adversaire sait *que* l'autre a choisi, pas *quoi*.
- `end { winner, reason, you }` — `reason` : `ko`, `rounds`, `forfeit` (départ ou absence au-delà du
  délai de grâce), `timeout` (`DUEL_MAX_TIMEOUTS` délais d'affilée).
- `error { code, message }` — message en français. Codes : `bad_json`, `bad_message`, `unknown_type`,
  `too_large`, `rate_limited`, `version` (+ `expected`), `hello_required`, `deck_invalid`, `unknown_room`,
  `room_full`, `already_in_room`, `not_in_room`, `not_playing`, `not_your_turn` (rien à choisir pour
  vous dans cette phase), `already_chosen` (choix déjà verrouillé : il ne se change pas), `stale_seq`
  (+ `seq` courant, suivi d'un `state` à jour), `illegal_action`, `rejoin_failed`, `room_expired`,
  `server_full`, `engine_error`, `server_error`.
- `peer { status: 'left' | 'back' }`, `pong`.

Déroulé d'un tour : `state` (phase `choose`, `pending: [0,1]`) → chacun envoie `action` → le premier
reçoit `chosen` (avec son action) et l'autre `chosen` sans action → dès que le second choisit, un
unique `state` (`seq + 1`, événements du tour, `last`) part aux deux. Si un champion tombe, ce `state`
porte `phase: 'replace'` et `pending: [joueur K.O.]` ; l'autre joueur n'a rien à envoyer.

Reconnexion : `rejoin` renvoie `room` puis `state` (avec `choice` si le choix était déjà verrouillé, et
le `deadline` restant). Le minuteur de phase continue pendant la coupure ; à son terme, le choix
manquant est joué par le serveur.

Après un départ (`leave` ou délai de grâce dépassé), le joueur restant retrouve le salon **en
attente sous le même code** : un nouvel adversaire peut le rejoindre.

## Client (`content/duel-net.js`)

Script classique (pas de module), utilisable dans une page d'extension (`duel/duel.html`), un content
script ou Node (`require`). `KYARA_DUEL_NET.connect(url, { name, deck, onEvent })` renvoie `net` :
`create()`, `join(code)`, `act(action)`, `rematch()`, `leave()`, `setProfile({ name, deck })`, `close()`,
`canAct()`, `opponentChosen()`, `timeLeft()` et l'état suivi : `status`, `code`, `room`, `you`, `seq`,
`state`, `phase`, `pending`, `chosen`, `choice`, `legal`, `deadlineAt`, `phaseMs`, `last`, `ended`.
Reconnexion automatique (jeton en mémoire) avec file d'envoi pendant la coupure.

Débit : le relais tolère 20 messages en rafale puis 10 par seconde et par connexion ; un joueur humain
n'approche jamais cette limite, mais un bot qui joue instantanément doit s'espacer (ou relever
`DUEL_RATE_BURST` / `DUEL_RATE_PER_SEC`).
