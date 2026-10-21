# Relais du duel Kyara

Serveur WebSocket **autoritatif** du mode `+Duel` de Kyareeh+ (voir `docs/DUEL-SPEC.md` §4).
Il exécute le moteur `content/duel-engine.js` avec les données `content/duel-data.js`, lus
directement depuis le dépôt : les clients n'envoient que des intentions, chaque action est
validée par le moteur puis l'état est diffusé aux deux joueurs avec un numéro `seq` croissant.

Une seule dépendance : [`ws`](https://github.com/websockets/ws). Node 20 ou plus récent.

## Lancer en local

Depuis la **racine du dépôt** (le serveur lit `../content/*`) :

```bash
npm ci --prefix relay          # installe ws dans relay/node_modules (non versionné)
node relay/server.mjs          # écoute sur le port 8080
```

Sous Windows, utiliser `npm.cmd ci --prefix relay` si les scripts PowerShell sont bloqués.

- Vérification : `http://localhost:8080/` répond `ok`.
- Dans le panneau (onglet **Duel**), adresse du relais : `ws://localhost:8080`.
- Test complet (serveur + client navigateur, deux joueurs, cas d'erreur) :

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
| `DUEL_TURN_MS` | `60000` | Délai d'un tour ; à expiration, le serveur joue `pass` à la place du joueur. |
| `DUEL_MAX_TIMEOUTS` | `3` | Tours expirés **d'affilée** avant défaite `timeout`. |
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

## Protocole (résumé)

Messages JSON `{ t: type, … }`, conformes au §4 de la spécification ; les ajouts sont en *italique*.

Client → serveur : `hello { v: 1, name, deck }`, `create`, `join { code }`,
`action { seq, action }`, `rejoin { code, token }`, `leave`, `ping`, *`rematch`*.
`create`, `join` et *`rematch`* acceptent aussi *`name` / `deck`* (mise à jour du profil).

Serveur → client :

- `welcome { clientId, token, v, rejoined? }`
- `room { code, status, players[{ name, ready, seat, online }], you }`
- `state { seq, you, state, events, deadline, legal, last }` — `deadline` = ms restantes (null hors
  duel), *`legal`* = actions légales du destinataire (vide si ce n'est pas son tour),
  *`last`* = `{ player, action, auto }` (auto = joué par le serveur), ou
  `{ player, action: null, auto: true, forfeit }` pour un abandon.
- `end { winner, reason, you }` — `reason` : `ko`, `rounds`, `forfeit` (départ ou absence > délai
  de grâce), `timeout` (`DUEL_MAX_TIMEOUTS` tours expirés d'affilée).
- `error { code, message }` — message en français. Codes : `bad_json`, `bad_message`, `unknown_type`,
  `too_large`, `rate_limited`, `version`, `hello_required`, `deck_invalid`, `unknown_room`,
  `room_full`, `already_in_room`, `not_in_room`, `not_playing`, `not_your_turn`, `stale_seq`
  (+ `seq` courant, suivi d'un `state` à jour), `illegal_action`, `rejoin_failed`, `room_expired`,
  `server_full`, `engine_error`, `server_error`.
- `peer { status: 'left' | 'back' }`, `pong`.

Après un départ (`leave` ou délai de grâce dépassé), le joueur restant retrouve le salon **en
attente sous le même code** : un nouvel adversaire peut le rejoindre.
