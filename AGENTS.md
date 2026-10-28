# AGENTS.md — Kyareeh+ (contexte de reprise)

Ce fichier est destiné à l'agent IA qui reprend le projet dans un autre environnement
(Cursor, DeepSeek harness, Claude Code, etc.). Lis-le en entier avant de modifier quoi que ce soit.

## 1. Le projet en une phrase

Extension **Firefox et Chrome / Edge (Manifest V3, un seul code)** nommée **Kyareeh+**
(`kyara-plus@axel.dev`) qui ajoute un panneau de contrôle à [kyara.games](https://kyara.games) :
tableau de bord du compte, valorisation en chakra, vente assistée, marché, chasses de cartes,
auto-open de boosters et statistiques.

- Version actuelle : **2.9.1** (`manifest.json` + `package.json` doivent rester synchronisés)
- Dépôt : `https://github.com/mRNeFF/kyareeh-plus` (branche `master`)
- Auteur / utilisateur : **Axel** — parle-lui en **français**, réponses concises et concrètes.
- Dernier commit de référence : `9ed5384`

## 2. Démarrage rapide

```bash
npm install                 # web-ext en devDependency (61 Mo, non versionné)
npm run start               # lance Firefox avec l'extension chargée
npm run lint                # web-ext lint -> doit rester à 0 erreur
npm run build:chrome        # manifeste Chrome dérivé + zip (dist/chrome)
npm run verify:chrome       # 155 contrôles dans un Chrome headless réel
node test/verify-analysis.mjs    # 53 contrôles
node test/verify-autosell.mjs    # 133 contrôles (sélection pure + stratégies + ordre + ventes actives + classement optimisé + remise en vente + tableau 2 + règlement de mise)
node test/verify-autosell-expiry.mjs # 81 contrôles (délai configurable, retrait, carte conservée, vente protégée, retour en fin de file, anti-boucle)
node test/verify-recycle.mjs     # 62 contrôles (exemplaires recyclables, verrou/engagés, plan, totaux, décision après expiration)
node test/verify-sales-chart.mjs # 92 contrôles (profit net, ventes confirmées, source auto/manual, bénéfice par heure, cumul 1 j / 7 j / total, dédoublonnage)
node test/verify-statglobal.mjs  # 55 contrôles
node test/verify-completion.mjs  # 142 contrôles (séries, progression, marché des manquants, panier, garde-fous d'achat)
node test/verify-autobuy.mjs     # 117 contrôles (statut Renaissance, déficits, filtres, 9 tris, file, plafonds, garde-fous, marché)
node scripts/autobuy-shots.mjs   # 43 contrôles navigateur + captures de l'onglet Auto-Achat (hors dépôt)
node test/verify-duel-data.mjs   # cohérence des champions du duel (textes ↔ chiffres, pronoms, doublons)
node test/verify-duel-engine.mjs # règles du moteur de duel
node test/verify-duel-relay.mjs  # relais : partie complète en ligne, erreurs, reconnexion
node test/verify-duel-bet.mjs    # relais : prêt + mise test/réelle (contreparties, aucun transfert côté relais)
node test/sim-duel.mjs 2000      # équilibrage : duels IA contre IA
node test/verify-odds.mjs        # ~97 comparaisons (1 écart "season-2026-fall R" PRÉEXISTANT, ne pas s'alarmer)
```

Chargement manuel Firefox : `about:debugging#/runtime/this-firefox` → *Charger un module temporaire* →
`manifest.json`. Chargement Chrome : `chrome://extensions` → mode développeur →
*Charger l'extension non empaquetée* → `dist/chrome`. Le panneau s'ouvre avec **Alt+K** ou le bouton flottant.

Harness de test local (API du site simulée, aucun compte requis) :

```bash
node test/server.cjs        # http://127.0.0.1:8787/test/harness.html
```

Il expose `window.__kyaraPlus` (`setOpen`, `setTab`, `state`, `render`, fonctions clés) pour piloter
l'extension depuis la console ou un navigateur automatisé.

## 3. Carte du code

| Fichier | Rôle |
|---|---|
| `content/ui.js` (~19 000 lignes) | **Tout le panneau** : état, appels API, vues, événements, calculs purs. |
| `content/ui.css` (~5 500 lignes) | Styles injectés dans un Shadow DOM (préfixe `kp-`). |
| `content/duel-data.js` | Champions du duel (données + `passiveFx` générés par `scripts/duel-passives.mjs`). |
| `content/duel-engine.js` | Moteur du duel, **pur** (aucun DOM/réseau/aléa hors graine), partagé par l'extension et le relais. |
| `content/duel-rules.js` | Livre de règles affiché dans l'onglet Règles (copie : `docs/REGLES-DUEL.md`). |
| `content/duel-net.js` | Client WebSocket du relais (protocole v2, reconnexion par jeton). |
| `duel/` | Application du duel (page d'extension) : `duel-app.js`, `duel.css`, `duel-fx.js` (sons/particules/ultime), `fx-demo.html`. Intégrée au panneau par iframe (aussi dans la fenêtre détachée du panneau) ; pas de détachement propre. |
| `panel/` | Fenêtre **détachée** (`panel.html`, `panel.css`, `panel-boot.js`) : le panneau complet (+Tools et +Duel) dans sa propre fenêtre ; monte `content/ui.js` sans site web (`IS_PANEL`) et relaie les appels `/api/…` vers un onglet kyara.games ouvert. La mise en page plein écran est dans `content/ui.css` (`.kp-panel.is-window`) : le panneau est en Shadow DOM, `panel.css` ne l'atteint pas. |
| `relay/` | Serveur Node autoritatif des salons en ligne (Railway). Exclu du zip AMO. |
| `docs/DUEL-SPEC.md`, `docs/DUEL-V2.md` | Contrats du duel (v1, puis v2 : combat 1 contre 1, application détachable, effets). |
| `docs/AUTO-ACHAT-EVEIL.md` | Règles vérifiées de l'Éveil et de la Renaissance, hypothèses, limites et sécurité de l'onglet Auto-Achat. |
| `background/background.js` | Service worker minimal (messages popup ↔ onglet). |
| `popup/` | Popup de la barre d'outils (recharger l'extension). |
| `test/harness.html` | Faux site + fausse API (comptes, marché, packs, amis, classements). |
| `test/server.cjs` | Serveur statique local pour le harness. |
| `test/verify-*.mjs` | Tests Node des blocs purs extraits de `ui.js`. |
| `test/chrome-smoke.mjs` | Charge le paquet Chrome dans un Chrome headless (CDP) et vérifie worker, content script, popup, rendu. |
| `scripts/release.mjs` | Bump + build + lint + commit/push (+ upload AMO si clés API). |
| `scripts/build-chrome.mjs` | Manifeste Chrome **dérivé** de `manifest.json` + zip (aucun code transformé). |
| `scripts/store-shots.mjs` | Captures 1280×800 pour la fiche Chrome (harness, Chrome headless). Sortie hors dépôt : `../_shots/store`. |
| `scripts/store-promo.py` | Icône 128, vignette 440×280 et bannière 1400×560 (Pillow), à partir des captures. |
| `.web-ext-config.mjs` | Fichiers exclus du `.zip` publié. |
| `README.md` | Documentation utilisateur (fonctionnalités, installation, AMO, Chrome). |
| `CHROME.md` | Portage Chrome/Edge : build, test, publication Chrome Web Store. |

## 4. Conventions à ne pas casser

1. **Tout est en français** : libellés, messages, commentaires, commits.
2. **Aucune donnée inventée.** Une valeur indisponible s'affiche `—` avec l'explication.
   C'est la règle la plus importante du projet : les stats ont déjà été refaites plusieurs fois
   parce qu'un chiffre était faux ou présenté comme global alors qu'il était partiel.
3. **Toujours préciser le périmètre** d'une statistique (« sur N comptes suivis », « depuis le… »).
4. **Shadow DOM** : ne jamais viser le DOM du site par classe CSS ; les sélecteurs du panneau
   passent par `shadow.querySelector` ou le helper `qs()`.
5. **Échappement** : toute interpolation de données distantes passe par `esc()` ; les nombres par `fmt()`.
6. **Blocs purs testables** : les calculs sont isolés entre marqueurs de commentaire
   `/* ANALYSIS:BEGIN … ANALYSIS:END */` et `/* STATS:BEGIN … STATS:END */`.
   Les tests Node extraient littéralement ces blocs → **ne jamais y mettre de DOM, de réseau ou de stockage**.
7. **Version** : bumper `manifest.json`, `package.json` **et** le nom du zip dans `scripts.build`.
   Le manifeste Chrome n'est jamais édité à la main : il est régénéré par `scripts/build-chrome.mjs`.
8. **Avant de livrer** : `node --check content/ui.js`, les tests `verify-*.mjs`, `web-ext lint`,
   puis commit + push. Toute modification du manifeste ou du background exige aussi
   `npm run verify:chrome`.
9. Ne jamais supprimer une fonctionnalité existante sans accord explicite.

## 5. Comment étendre

- **Nouvel onglet** : ajouter `['id', 'Libellé']` dans le tableau `tabs` de `renderTabs()`, la vue dans
  l'objet `fn` de `renderView()`, puis une fonction `viewXxx()`. Un panneau large s'obtient via
  `ui.panel.classList.toggle('is-wide', …)` dans `render()`.
- **Nouvelle action** : `<button data-act="mon-action">` + un `case 'mon-action'` dans `onClick()`.
  Pour un champ texte : `data-role="…"` dans `onInput()` ; pour une case/select : `onChange()`.
- **Nouvel appel API** : passer par `api(path, { timeout, body, method })` (ajoute les en-têtes
  d'auth de la session du site et journalise dans l'onglet Debug). Ne jamais utiliser `fetch` direct.
- **Nouvel état** : déclarer dans l'objet `state` en haut de `ui.js`, persister avec `storageGet`/`storageSet`.

## 6. API Kyara — ce qui est réellement disponible

Tout passe par la session du navigateur (`credentials: 'include'` + `authorization: Bearer`
lu depuis `localStorage.kyara_token` + `x-pass` pour les écritures).

| Endpoint | Usage |
|---|---|
| `GET /api/me/bootstrap`, `/api/me` | Compte courant : pseudo, chakra, boosters offerts, pity. |
| `GET /api/me/collection?lean=1` | Collection du compte : `qty`, `listable`, `locked`, `sellBlock`, `resaleUntil`, `pinned`. |
| `GET /api/me/packs` | Grants et limites par booster (**possédés**, pas ouverts). |
| `GET /api/characters` | Catalogue complet (6 736 cartes : id, nom, rareté, série, image). Cache 24 h. |
| `GET /api/packs` | Boosters : prix, `rates` (slots, perBooster), `usesFreePacks`, `grantOnly`. |
| `POST /api/packs/:id/open-many` | Ouverture (auto-open). |
| `GET /api/me/friends`, `?q=` search | Liste d'amis / recherche de n'importe quel joueur. |
| `GET /api/users/:id` | Profil public : `owned`, `mythics`, `heritage`, `boostersOpened`, `doublesCount`, `byRarity`, `series[]`, `listings`, `buyOrders`, `blisters`, `catalogSize`. **Pas de chakra.** |
| `GET /api/trades/owned/:id` | Ids des cartes possédées (session requise). |
| `GET /api/fair-play/prices?ids=` | Prix officiels par lots de 200 (session requise). |
| `GET /api/leaderboard/ladder?by=&q=` | Classement public. |
| `GET /api/market/listings?…`, `POST` | Marché, création d'annonce. Filtres serveur réels : `q`, `rarity`, `series`, `type`, `minPrice`, `maxPrice`, `buyNow`, `sort` (`price_asc`/`price_desc`/`newest`/`ending`), `page`, `pageSize` (**50 max**, au-delà → 400), `characterId`, et **`missing=1`** / `wished=1` (cartes manquantes / liste de souhaits, session requise). |
| `GET /api/market/listings/:id` | Une annonce seule (contrôle de fraîcheur avant achat). |
| `POST /api/market/listings/:id/buy` | **Achat immédiat** d'une annonce (corps vide, en-tête `x-pass`), réponse `{ user, listing }` ; le client du site relit ensuite l'annonce et la collection. |
| `GET /api/characters/heritage` | 660 cartes « héritage », **hors** `/api/characters` et **exclues** de l'onglet Completion (aucune annonce constatée). |
| `GET /api/characters/news` | Dernière révision du catalogue (`removed`, `heritage`, `before`, `after`, `series[]`) : le catalogue bouge. |
| `POST /api/me/collection/:id/recycle` | Recyclage d'exemplaires (`{ qty }`), **une carte à la fois** ; réponse `{ user, entry, gained }`. |
| `GET /api/market/buy-orders?characterId=` | Carnet d'achat. |
| `GET /api/me/renaissance` | Statut de la prochaine Renaissance : `level`, `next`, `eligible`, `requirements[]` (`key`, `have`, `need`, `ok`). **503** tant que `renaissanceOpen` est faux dans `/api/config`. |
| `POST /api/me/renaissance` | Renaissance (`{ confirm: 'RENAISSANCE' }`) — action irréversible, **jamais appelée** par l'extension. |
| `GET /api/eveil/catalog`, `/api/eveil/market` | Catalogue et marché Éveil : `{ revealAt, cards[] }` / annonces `{ eveilId, serial, price, total }`. Vides avant `eveilRevealAt`. |
| `GET /api/me/eveil`, `/api/me/eveil/chance` | Copies Éveil possédées et chance de tirage (session). |
| `POST /api/eveil/cards/:id/buy` | Achat d'une copie Éveil (`{ price }`), réservé aux comptes ayant fait une Renaissance. |

**Échange / don (vérifié dans les chunks du site et les règles publiques, 25/10/2026)** :
il n'existe **aucun endpoint de don unilatéral**. Un échange est une proposition avec **séquestre**
(ce que tu donnes est mis de côté), **48 h max** pour répondre, **taxe de 5 % sur le chakra reçu**,
et une carte reçue/achetée est **bloquée à la revente 48 h** (`sellBlock: 'resale_lock'`).
Les règles disent qu'« un échange équilibré passe toujours, mais les gros dons d'un joueur à un
autre sont bloqués dès l'échange » et « la différence est un don, limité entre deux joueurs et par
joueur qui reçoit ». **La capture du 25/10/2026 confirme un plafond cumulé de 3 000 ◆ par paire sur
48 h** : un don de 294 ◆ affiche « encore 2 706 ◆ de dons possibles entre vous sur 48 h après cet
échange ». Ce n'est pas « un don toutes les 48 h », c'est une **fenêtre glissante de 48 h** avec un
plafond par paire **et** par joueur qui reçoit. Le site expose ces restes via
`GET /api/fair-play/with/:id` (`giveLeft`, `giveBalanceLeft`, `theirReceivedLeft`, `pairDays`,
`receivedDays`) et crée le don avec `POST /api/trades`
(`{ toUserId, give:{cards,chakra}, want:{cards,chakra} }`), puis `POST /api/trades/:id/accept`.
Le panneau Kyareeh+ utilise ces endpoints pour le règlement **réel optionnel** de la mise ; le
relais, lui, ne transporte que les conditions et les identifiants, jamais de chakra ni de carte.

### Pièges découverts (vérifiés sur l'API réelle)

- `ladder` renvoie **100 lignes maximum** ; `limit`, `page`, `offset`, `fields` sont **ignorés**.
- Seuls **4 tris** sont réels : `collection`, `mythics`, `series`, `achievements`. Tout autre
  `by=` (`heritage`, `chakra`, `boosters`…) **retombe silencieusement sur `collection`**.
  Vérification faite : 100 identifiants identiques → ne pas s'y fier.
- `ladder?q=pseudo` renvoie aussi `found[]` avec `pos`, **au-delà du top 100** (testé pos 306/337).
- **Le chakra est privé** : absent des profils publics et du ladder. Impossible à agréger.
- **Aucun historique de ventes** (`/api/me/sales`, `/history`, `/transactions` → 404).
  Seul le nombre d'annonces actives est disponible.
- **Aucune origine de carte** (pack vs marché) : zéro occurrence de `obtainedFrom`,
  `fromPack`, `fromMarket` dans les 123 chunks du site. Seul `sellBlock: 'resale_lock'`
  indique un achat/échange **de moins de 48 h**.
- `byRarity` compte des **types distincts** (la somme égale `owned`).
  Exemplaires totaux = `owned + doublesCount`.
- `series[]` du profil est **tronqué à 8 entrées** → recalculer depuis le catalogue.
- `/api/trades/owned/:id` et `/api/fair-play/prices` renvoient **401 sans session**.
- **Recyclage** : `POST /api/me/collection/:id/recycle` `{ qty }` ne prend **qu'une carte à la fois** (pas de lot par ids). Le site **conserve 1 exemplaire** de chaque carte et bloque le recyclage d'une carte `pinned` (verrou de carte). Attention : **`locked` n'est pas un verrou utilisateur**, c'est le nombre d'exemplaires **déjà en vente** (« N en vente » sur le site) ; il diminue quand une annonce est retirée. Décider d'un recyclage sur un `locked` lu avant le retrait fait refuser à tort : il faut le décrémenter de la quantité retirée (corrigé en 2.6.1). Plafond retenu : `qty − max(locked, qty − listable) − 1`.

## 7. État des onglets

| Onglet | Contenu |
|---|---|
| **Compte** | Valeur du compte, ressources, top cartes, valeur par rareté, séries complètes, recherche d'un autre joueur (valorisation exacte). |
| **Vente** | Deux sous-onglets : **Mes cartes** (filtres rareté/série/**Doublons**, tri, prix potentiel, blocage de revente 48 h, sélection plafonnée à 10 places (manuel), prix fixe/enchère, 3 stratégies, pastille « N poss. ») et **Vente auto** (section **Ventes actives** : nom, quantité, prix unitaire/total, état et temps restant, bordure de rareté, cliquable vers la fiche marché sans prix recommandé, relue au démarrage, après une vente immédiate et en fin de cycle ; doublons uniquement, dernière copie conservée, **exemplaires déjà en vente réservés**, **Mythiques exclues par défaut**, **Légendaires en double incluses automatiquement**, stratégie rapide/équilibrée/max, **ordre « Optimisé : prix + ventes sur 7 j » par défaut** (score 0–100 = 70 % liquidité log-normalisée sur les ventes 7 j + 30 % prix, recalculé avant chaque vente, volumes relus au plus toutes les 5 min, absence de volume ou volume de plus de 6 h ⇒ score plafonné à 30 et mention explicite) ou **plus cher → moins cher / inverse sur le prix unitaire**, encart **« Prochaine carte »** (prix, ventes 7 j, score, raison du choix, carte suivante) et aperçu détaillé par carte, **durée 12/24/48 h**, **estimation des gains**, délai anti-flag 5–60 s, **refresh aléatoire 7–10 min**, aperçu + confirmation, refus explicite si le tri est impossible, prix trop bas : en vente rapide, alignement immédiat sur le prix le plus bas, sinon réessai à la hausse, remplissage plafonné à 8 s par annonce et surveillance d'une place libre toutes les 30 s, démarrage possible même à 10/10 puis surveillance toutes les 5 s, **remise en vente automatique** d'une annonce revenue sans acheteur — expiration détectée à la relecture ou par la surveillance d'échéance, carte remise en ligne **au prix plancher du tableau 2** (prix fixe le plus bas réellement pratiqué, relevé du 23/10/2026 : C 3, U 3, R 5, E 15, L 100, M 815 chakra), jamais sous la valeur de recyclage, **même prix** si la carte y était déjà (ou moins cher), file vidée à l'arrêt et **annulation manuelle jamais relancée**, une seule annonce par carte, journal `↻`, encart et pastille ↻, carte conservée + erreur explicite si la remise en vente échoue, **retrait des annonces trop anciennes** (option « Retirer les annonces après », durée X + minutes/heures de 1 min à 30 jours, désactivable et **persistée** ; seules les annonces créées par la vente auto sont retirées, carte et quantité exactes conservées, pool et emplacement libérés, statut interne « retour après expiration » classé **en fin de file**, délai anti-boucle de 10 min, temps écoulé affiché, encart horodaté et journal persistant `kyareeh.autosellexpiry.v1`), **recyclage automatique des cartes retirées** (option décochée par défaut et **persistée** : cochée, la carte retirée part au recyclage au lieu du pool — quantité exacte de l'annonce, 1 copie conservée, cartes verrouillées/engagées et Mythiques exclues ; repli motivé en fin de file si le recyclage est refusé), arrêt d'urgence). Les prix manquants sont lus **en un lot** (`/api/me/collection/prices`) ; en **Vente rapide**, un seul instantané marché est lu pour la carte choisie : elle se place **1 chakra sous** la vente fixe/achat immédiat la plus basse (médiane si aucune), et **au même prix** si le site répond `price_too_low`, jamais tout l'inventaire. En bas, **graphique local du profit des ventes automatiques** (gain de chaque tranche, pas un cumul : la courbe monte et redescend selon les ventes de l'heure) avec menu **1 jour / 7 jours / Total**, **infobulle au survol** et pastilles sur les tranches vendues. **Seules les ventes `source: 'auto'` sont comptées** : les ventes manuelles restent dans le journal (`kyareeh.sales.v2`) mais sont exclues de la courbe ; une entrée sans source est `unknown` et exclue (jamais reclassée en manuel). **Limite d'annonces simultanées de la vente auto : 1–10, persistée (`autoSellMaxActive`), places déjà occupées comprises** ; à 9, la boucle s'arrête à 9 et laisse un emplacement libre. Le clic sur une carte en vente ouvre sa fiche avec **Retirer la vente** (double clic de confirmation). Profit = encaissé − frais − taxe ; **coût d'acquisition non fourni par le site, jamais inventé** ; ventes comptées **une seule fois** par annonce et historique recalculé à chaque chargement (clés `kyareeh.sales.v2` / `kyareeh.salestrack.v1`). |
| **Recyclage** | Sélection ciblée des doublons : recherche, filtres rareté/série, tri par valeur de recyclage / doublons / prix / ventes 7 j / rareté / nom, compteur − / + par carte (1 → `qty − locked − 1`), bandeau total et **aperçu** avant confirmation. Les cartes **verrouillées** (`pinned`), les exemplaires **engagés** (`listable`) et les uniques sont exclus ; **L/M décochées par défaut**. Relecture de la collection juste avant l'action (rien n'est recyclé si une quantité a changé), un `POST …/recycle` par carte, progression/arrêt/journal, chakra réellement crédité. |
| **Marché** | Deux vues internes : **Marché global** (recherche serveur, une ligne par carte, prix fixe/enchère le plus bas, achat immédiat, dépliant des ventes) et **Bons plans** (scan sous la médiane, tri, pages, seuil). Mes annonces actives en bas. |
| **Completion** | **Séries incomplètes uniquement** (catalogue `/api/characters`, **héritage exclu**). Vue d'ensemble (séries complètes/incomplètes, cartes manquantes, manquants en vente), barre de progression globale, liste des séries avec progression, manquants, nombre d'annonces et coût connu ; filtres recherche / **taille minimale** / **manquants en vente** / **enchères**, 6 tris. **Filtre de raretés** : boutons « Légendaire » / « Mythique » qui retirent la rareté de toute l'analyse (total de série, manquants, pourcentage, compteurs et marché) — l'inventaire n'est jamais modifié ; persistant (`kyareeh.completion.v1`) et état vide explicite quand toutes les manquantes restantes sont masquées. **Rafraîchir une série** : bouton `↻ Rafraîchir` par ligne, une requête par page (3 max) sur cette seule série, purge puis fusion du cache (une annonce vendue/annulée/expirée disparaît immédiatement), heure de dernière lecture, note « annonce disparue », erreur discrète, anti-spam de 5 s par série. **Fiche série** : cartes manquantes avec prix d'achat immédiat, nombre d'annonces, case à cocher. **Panier** : total, **plafond de budget persisté**, comparaison au chakra, confirmation explicite puis **achat réel** (`POST /api/market/listings/:id/buy`) carte par carte — annonce relue juste avant (état, échéance, prix, propriétaire), hausse de prix = carte écartée, `chakra`/`rate_limited`/`pass_required` = arrêt du lot, collection relue une fois en fin de lot. **Enchères décochées par défaut** : seules celles avec achat immédiat sont achetables. Marché relu **à la demande**, série par série, sur les **150 annonces les moins chères** (`series=…&missing=1&sort=price_asc`, 3 pages max) ; aucune lecture en arrière-plan. Bloc pur `/* COMPLETION:BEGIN … END */` testé par `test/verify-completion.mjs`. |
| **Auto-Achat** | File d'achats **orientée Éveil** : lit `/api/me/renaissance` et cible les prérequis de rareté (cartes différentes C/U/R/E, L/M), seuls achetables. Affiche cartes manquantes, progression officielle (`—` si la Renaissance est fermée), cartes restantes, coût estimé, annonces par carte (prix fixe ; enchères avec achat immédiat en option) et manquants sans annonce connue. Filtres rareté/série/prix max/disponibles/séries incomplètes/masquer L-M/nécessaires à l'Éveil ; **9 tris** dont **Priorité Éveil** (gain `100/(conditions × need)` par carte). File **une carte à la fois** : annonce relue et classement recalculé avant chaque achat, prix monté/annonce disparue = carte ignorée, **plafond de budget** et **prix unitaire** persistés (`kyareeh.autobuy.v1`), **Arrêter** permanent, **achats réels** avec **4 s entre deux cartes**, confirmation explicite avant la file, journal horodaté. Aucune lecture en arrière-plan ; la Renaissance n'est jamais déclenchée par l'extension. Bloc pur `/* AUTOBUY:BEGIN … END */` testé par `test/verify-autobuy.mjs` ; captures et scénarios par `scripts/autobuy-shots.mjs`. |
| **%Drop** | Chasse à la carte : probabilité exacte par booster, boosters attendus, coût moyen, espérance de chakra. |
| **Auto-Open** | Boucle d'ouverture avec `T_max = (9 − B) × I + R`, watchdog, arrêt sur L/M, anti-AFK, journal horodaté, reprise après rechargement. |
| **Stat** | Classement de comptes suivis (recherche manuelle + import auto des amis) sur 10 métriques. Menu déroulant du critère, tableau réduit à ce critère, camembert à droite avec tous les comptes et 50 couleurs max, rangs ex æquo, rang site sous le pseudo, détail par compte. |
| **Réglages** | **Sommaire fixe + catégories** : **Vente** (type, décote, mise à prix, achat immédiat, durée, annonces max/lot, délai entre ventes, **délais vente auto min/max 5–300 s**, **refresh 1–60 min**), **Prix & cache** (TTL, valorisation auto, frais), **Présence** (anti-AFK), **Données & outils**. Tous les réglages existants sont conservés ; la limite d'annonces simultanées se règle dans **Vente auto** (lien depuis le sommaire). Le **son global** (volume + mute) est dans l’en-tête. |
| **+Duel** | Application du duel en iframe ou fenêtre détachée. Le **son est piloté par la fenêtre Global** (clé `kyareeh.sound.v1`, synchro par `storage.onChanged`). **Salon : switch Prêt / Pas prêt** (défaut **Pas prêt**, rouge ; état synchronisé par le relais ; le duel ne démarre que si les deux sont prêts). **Mise** : case « Activer la mise », montant, contrepartie = **dernier doublon du classement vente auto**, conditions acceptées par l'adversaire, **chaque joueur fournit sa propre contrepartie**, états (confirmation, échange, prêt, en cours, terminé, annulé, litige). **Règlement réel optionnel** (`bet.mode = 'real'`) : à la fin, le perdant crée une proposition `POST /api/trades` (chakra + sa carte, rien demandé en retour), le gagnant l'accepte après contrôle exact ; plafond de dons du site vérifié via `/api/fair-play/with/:id`. Par défaut la mise reste en **mode test**, sans transfert. Le relais ne transporte que les conditions et identifiants, jamais de chakra/carte. L’en-tête Global est permanent et synchronisé entre les onglets (`kyareeh.ui.v1`) ; il n’y a qu’**un** bouton **Détacher** (+Tools comme +Duel) : il ouvre `panel/panel.html` dans une fenêtre unique (registre `kyareeh.panel.window` tenu par le fond ; messages `kp-panel-detach` / `kp-panel-attach` / `kp-panel-state`). Les données de la fenêtre passent par un relais background vers un onglet kyara.games ouvert (`no_kyara_tab` / `kyara_tab_unready` si aucun). Tant que la fenêtre existe, la page n’affiche qu’une carte « ouvert dans une fenêtre — Afficher / Rattacher » et ne fait plus tourner de boucle (relectures, reprise Auto-Open) ; l’anti-AFK reste dans l’onglet. La fenêtre ne lit ni n’écrit l’état d’ouverture partagé (`kyareeh.ui.v1`) : sinon fermer le panneau de la page la vidait. À la fermeture de la fenêtre, la page resynchronise réglages/prix/journaux et reprend l’Auto-Open. |
| **Debug** | **Plus d'onglet dans la barre** : accessible par le bouton **Debug** de l'en-tête, **entre le réglage du son et Refresh**, avec un bouton **Retour**. Version du code, version chargée par le navigateur, rechargement de l'extension, requêtes récentes, clés du bootstrap, diagnostic copiable. |

## 8. Limites connues / dette

- `content/ui.js` est un monolithe (~19 000 lignes). Toute nouvelle vue l'agrandit : extraire un
  module serait utile mais risqué sans tests de non-régression UI.
- 30 avertissements `web-ext lint` : `UNSAFE_VAR_ASSIGNMENT` sur `innerHTML` dans `content/ui.js`
  et `duel/duel-app.js`, plus un `INLINE_SCRIPT` dans `duel/fx-demo.html` ; inhérents au rendu
  par chaînes ; à traiter seulement si on migre vers du DOM construit.
- L'onglet Stat dépend de `trades/owned` + `fair-play/prices` : si le site change ces endpoints,
  la valeur et les séries resteront vides (« — »), par choix assumé.
- Le harness simule l'API : une forme de réponse réelle inattendue (ex. `/api/me/friends`)
  ne se verrait qu'en production.
- `verify-odds.mjs` a **1 écart préexistant** (`season-2026-fall R`), antérieur à la 1.0.0 ;
  le 25/10/2026 un second écart **`daily R`** est apparu avec les taux live du site (hors-golden
  20,098 % contre 19,006 % officiel). Ne pas « corriger » la formule pour les faire disparaître.
- **Anti-rafale** : toutes les requêtes `/api/…` passent par une file dans `content/ui.js` (une seule à la fois, 350 ms minimum entre deux départs). La vente auto lit les prix manquants en un lot et ne scanne plus tout l'inventaire ; en **Vente rapide**, elle lit un seul instantané marché pour la carte choisie. En **mode optimisé**, les prix/volumes 7 j des doublons sont relus en un lot dès qu'ils ont plus de 5 min, au plus une fois par minute. Elle ne relit collection + ventes actives qu'après une vente immédiate et une fois en fin de cycle, pas après chaque mise en vente.
- **Paquet Chrome** : manifeste dérivé (`scripts/build-chrome.mjs`), aucun code transformé.
  `icons/icon-*.png` et `icons/logo.svg` viennent du logo fourni par Axel (dégradé teal, tronc/feuilles) ;
  l'icône 128 est incluse dans le manifeste. Depuis Chrome 137, `--load-extension`
  est ignoré dans les builds de marque ; `test/chrome-smoke.mjs` charge donc l'extension via
  CDP `Extensions.loadUnpacked` et travaille sur une copie autorisant `127.0.0.1:8787`.
- Les textes qui nomment le navigateur ou sa page de réglages passent par `IS_GECKO` /
  `BROWSER_NAME` dans `ui.js` (et `popup.js`) : ne pas réintroduire « Firefox » en dur.
- **Éveil / Renaissance (27/10/2026)** : `renaissanceOpen: false` et `/api/eveil/catalog` vide
  jusqu'au **3 novembre 2026, 21:00 Paris** (`eveilRevealAt`). L'onglet Auto-Achat affiche donc
  `—` et un mode préparation ; aucune règle de Renaissance n'est inventée. Le marché Éveil
  (`/api/eveil/market`, achat par `POST /api/eveil/cards/:id/buy`) n'est **pas** encore automatisé :
  données absentes et limite « une carte Éveil par paire et par mois ». Voir `docs/AUTO-ACHAT-EVEIL.md`.

## 9. Pistes proposées, non développées

- Export CSV des classements Stat.
- Historique (snapshots) de la valeur d'un compte suivi.
- Analyse « chance » : mythiques obtenues vs boosters ouverts.
- Cartes les plus / moins répandues parmi les comptes suivis.
- Découpage de `ui.js` en modules (state / api / vues) avec tests.

## 10. Fichiers annexes

- `affiche-sondage-kyara.png` : affiche humoristique hors extension (ne doit jamais partir dans le `.zip` AMO).
- `BUILD.md`, `PRIVACY.md` : notes de publication et de confidentialité.
