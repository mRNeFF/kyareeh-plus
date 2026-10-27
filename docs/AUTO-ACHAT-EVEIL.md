# Auto-Achat orienté Éveil — règles, hypothèses et limites

> Rédigé le **27 octobre 2026** après lecture du code du site (`_app/immutable`), de
> `/api/config`, de `/api/eveil/catalog`, de `/api/eveil/market` et du code de l'extension.
> Ce document accompagne l'onglet **Auto-Achat** (v2.9.0) et sert de référence pour ne
> jamais présenter une donnée inventée.

## 1. Ce qu'est réellement l'Éveil

L'Éveil **n'est pas une liste de personnages à réunir**. Les textes du site sont explicites :

- « Certaines cartes cachent une forme éveillée. Personne ne sait lesquelles : on le découvre
  quand l'une d'elles se transforme à l'ouverture d'un booster. »
- « Chaque carte Éveil est numérotée et n'existe qu'en nombre limité pour tout le jeu. »
- « Après ta première Renaissance, chaque booster que tu ouvres a une petite chance de contenir
  une carte Éveil : numérotée, et en nombre limité pour tout le jeu. »

Conséquences vérifiées :

1. Aucun personnage, aucune série et aucune variante ne peut être ciblé pour « atteindre l'Éveil ».
2. L'Éveil est un **tirage aléatoire** ; le seul déterminant achetable est l'accès au tirage.
3. Cet accès exige **au moins une Renaissance** (plus un compte relié à Discord et de confiance
   pour les cartes Éveil tirées dans les boosters).
4. Les cartes Éveil peuvent ensuite être achetées sur un **marché Éveil séparé** (prix fixe proche
   du prix habituel ±20 %), mais ce marché est vide tant que la révélation n'a pas eu lieu.

### État constaté le 27/10/2026

| Donnée | Valeur | Source |
|---|---|---|
| `renaissanceOpen` | `false` | `GET /api/config` |
| `eveilOpen` | `true` | `GET /api/config` |
| `eveilRevealAt` | `2026-11-03T20:00:00.000Z` (3 nov. 2026, 21:00 Paris) | `GET /api/config` |
| `/api/eveil/catalog` | `{ revealAt, cards: [] }` | endpoint public |
| `/api/eveil/market` | `[]` | endpoint public |
| `/api/me/renaissance` | `503` sans ouverture | endpoint session |

**Donc, à cette date, aucune progression vers l'Éveil n'est calculable officiellement.**
L'onglet l'affiche `—` et propose un mode **préparation** explicitement non officiel.

## 2. La Renaissance, seul levier achetable

`GET /api/me/renaissance` renvoie un statut dont les prérequis sont fournis par le serveur :

```json
{
  "enabled": true,
  "level": 0,
  "next": 1,
  "renown": 812,
  "eligible": false,
  "waitUntil": null,
  "requirements": [
    { "key": "C", "have": 5, "need": 8, "ok": false },
    { "key": "legendaries", "have": 1, "need": 2, "ok": false },
    { "key": "boosters", "have": 12, "need": 50, "ok": false },
    { "key": "discord", "have": 1, "need": 0, "ok": true }
  ]
}
```

Clés observées dans le code du site :

| Clé | Libellé | Achetable ? |
|---|---|---|
| `C`, `U`, `R`, `E` | Communes, Peu communes, Rares, Épiques | **oui**, cartes différentes |
| `legendaries` | Légendaires différentes | **oui**, cartes différentes |
| `mythics` | Mythiques différentes | **oui**, cartes différentes |
| `boosters` | Boosters ouverts dans ce cycle | non (ouvrir des boosters) |
| `wait` | Jours depuis la dernière Renaissance | non (attendre) |
| `escrow` | Aucune carte en vente ni en échange | non (retirer ses annonces) |
| `discord` | Compte relié à Discord | non (lier le compte) |
| `trust` | Compte de confiance | non (comportement du compte) |
| `ban` | Pas de bannissement en cours | non (équipe du site) |

### Hypothèses explicites

- **Cartes différentes** : le site parle de « Légendaires différentes », de « Mythiques
  différentes » et d'un album qui « repart à zéro » pour C/U/R/E. L'onglet compte donc **une
  carte possédée par identifiant**, jamais les exemplaires. Aucun doublon n'est acheté.
- **Séries et variantes** : elles n'apparaissent dans aucun prérequis. Elles ne comptent pas.
- **Cartes Héritage** : elles sont hors `/api/characters` et hors des prérequis ; l'onglet les
  exclut, comme l'onglet Completion.
- **`need` et `have`** : lus tels quels sur le serveur, jamais recalculés à partir du catalogue.
  Si le serveur ne publie rien, l'onglet affiche `—`.
- **Pourcentage officiel** : reproduit la formule du site — une condition `ok` vaut 1, les
  conditions de compte non remplies valent 0, les autres valent `min(1, have / need)` ; moyenne
  sur **toutes** les conditions, arrondie à l'entier.
- **Progression par carte** : `100 / (nombre_de_conditions × need)` points de pourcentage.
  C'est ce qui rend une Mythique (need 1) prioritaire sur une Commune (need 300).
- **Achat** : `POST /api/market/listings/:id/buy` avec le prix relu juste avant. Une carte achetée
  est bloquée à la revente 48 h par le site (`sellBlock: 'resale_lock'`), ce qui est sans effet
  sur la progression.

## 3. Ce que l'onglet fait — et ne fait pas

### Fait

- Lit `/api/config`, puis `/api/me/renaissance` (une fois, et à la demande).
- Lit le marché des cartes manquantes par rareté (`missing=1`, `sort=price_asc`, 50 par page,
  4 pages max par rareté), prix fixe par défaut, enchères avec achat immédiat en option.
- Affiche **toutes** les cartes manquantes du catalogue, y compris celles sans annonce connue.
  L'absence est formulée « non vue dans les annonces lues », jamais « absente du marché ».
- Classe, filtre, chiffre le coût, propose une file d'achats **une carte à la fois**, avec
  relecture de l'annonce et recalcul du classement avant chaque achat.
- Plafond de dépense et prix unitaire maximum **persistés**, bouton **Arrêter** permanent.
- Mode **simulation par défaut** ; le mode réel exige une case de confirmation supplémentaire.
- Journal horodaté des achats, erreurs et cartes ignorées, persisté (80 entrées).

### Ne fait pas

- **Ne déclenche jamais la Renaissance** : action irréversible, elle reste sur le site.
- **N'achète pas les cartes Éveil** sur `/api/eveil/market` : le marché est vide jusqu'au
  3 novembre 2026 et les règles d'achat (une carte par paire et par mois, prix fixe) méritent
  un onglet dédié testé séparément.
- **Ne lit pas en arrière-plan** : le marché n'est relu qu'au clic sur « Relire le marché ».
- **N'invente pas** de progression quand la Renaissance est fermée : `—` + mode préparation.

## 4. Sécurité d'achat

1. Une seule action d'achat à la fois ; `running` et `starting` verrouillent les doubles clics.
2. Avant chaque achat : carte non possédée, annonce active, échéance future, pas notre annonce,
   identifiant de carte identique, prix non augmenté, prix unitaire et plafond respectés.
3. Prix modifié, annonce disparue ou notre propre annonce : carte **ignorée**, file poursuivie.
   `chakra`, `rate_limited`, `pass_required`, `market_locked`, `guest_limit` : **arrêt**.
4. Une erreur inconnue arrête la file (aucune dépense à l'aveugle).
5. Le total dépensé est affiché en permanence : bandeau d'exécution, confirmation, journal,
   pied de l'onglet. Le cumul de l'onglet est persisté.
6. La simulation n'écrit ni chakra, ni collection réelle ; elle met à jour une progression
   simulée séparée pour vérifier le comportement.

## 5. Limites techniques

- **Règles non publiées** : tant que `renaissanceOpen` est faux, le serveur ne renvoie pas les
  `need`. Impossible de calculer la progression exacte ; l'onglet le dit.
- **Lecture partielle du marché** : 4 pages de 50 annonces par rareté au maximum. Une carte
  manquante peut être en vente plus cher, ou plus loin dans la liste, sans être vue. Le libellé
  de l'interface est volontairement prudent.
- **Pas d'historique de ventes global** : `sales7d` vient de `prices` embarqué dans l'annonce ;
  s'il manque, le tri place la carte en fin de liste sans inventer de volume.
- **Prix d'achat** : le site peut refuser un prix devenu obsolète (`cost_changed`), ou imposer
  une limite de débit. La file s'arrête ou ignore la carte selon le code.
- **Harnais** : les règles et le marché sont simulés ; une dérive de production ne serait visible
  qu'avec une session réelle.

## 6. Vérifications

- `node test/verify-autobuy.mjs` : 117 contrôles purs (statut, déficits, filtres, tris, file,
  plafonds, garde-fous, fusion d'annonces).
- `node scripts/autobuy-shots.mjs` : 44 contrôles navigateur (lecture du marché, simulation,
  achat réel avec plafond, arrêt immédiat, persistance des filtres/tri après navigation et
  rechargement) + 12 captures dans `../_shots/autobuy`.
- `node test/verify-completion.mjs`, `verify-autosell.mjs`, `verify-recycle.mjs`,
  `verify-analysis.mjs` : aucune régression.

## 7. Piste suivante (après le 3 novembre 2026)

Quand `/api/eveil/catalog` et `/api/eveil/market` seront peuplés :

1. lire le catalogue Éveil et `/api/me/eveil` ;
2. identifier les `eveilId` non possédés ;
3. acheter la copie la moins chère avec `POST /api/eveil/cards/:id/buy` (prix relu) ;
4. respecter la limite « une carte Éveil par paire et par mois » et le plafond de chakra ;
5. ne jamais acheter deux fois le même `eveilId`.

Cette partie n'est pas dans la v2.9.0 : elle dépend de données qui n'existent pas encore.
