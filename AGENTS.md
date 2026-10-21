# AGENTS.md — Kyareeh+ (contexte de reprise)

Ce fichier est destiné à l'agent IA qui reprend le projet dans un autre environnement
(Cursor, DeepSeek harness, Claude Code, etc.). Lis-le en entier avant de modifier quoi que ce soit.

## 1. Le projet en une phrase

Extension **Firefox et Chrome / Edge (Manifest V3, un seul code)** nommée **Kyareeh+**
(`kyara-plus@axel.dev`) qui ajoute un panneau de contrôle à [kyara.games](https://kyara.games) :
tableau de bord du compte, valorisation en chakra, vente assistée, marché, chasses de cartes,
auto-open de boosters et statistiques.

- Version actuelle : **2.0.1** (`manifest.json` + `package.json` doivent rester synchronisés)
- Dépôt : `https://github.com/mRNeFF/kyareeh-plus` (branche `master`)
- Auteur / utilisateur : **Axel** — parle-lui en **français**, réponses concises et concrètes.
- Dernier commit de référence : `4ca978a`

## 2. Démarrage rapide

```bash
npm install                 # web-ext en devDependency (61 Mo, non versionné)
npm run start               # lance Firefox avec l'extension chargée
npm run lint                # web-ext lint -> doit rester à 0 erreur
npm run build:chrome        # manifeste Chrome dérivé + zip (dist/chrome)
npm run verify:chrome       # 11 contrôles dans un Chrome headless réel
node test/verify-analysis.mjs    # 43 contrôles
node test/verify-statglobal.mjs  # 55 contrôles
node test/verify-duel-data.mjs   # cohérence des champions du duel (textes ↔ chiffres, pronoms, doublons)
node test/verify-duel-engine.mjs # règles du moteur de duel
node test/verify-duel-relay.mjs  # relais : partie complète en ligne, erreurs, reconnexion
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
| `content/ui.js` (~9 200 lignes) | **Tout le panneau** : état, appels API, vues, événements, calculs purs. |
| `content/ui.css` (~3 300 lignes) | Styles injectés dans un Shadow DOM (préfixe `kp-`). |
| `background/background.js` | Service worker minimal (messages popup ↔ onglet). |
| `popup/` | Popup de la barre d'outils (recharger l'extension). |
| `test/harness.html` | Faux site + fausse API (comptes, marché, packs, amis, classements). |
| `test/server.cjs` | Serveur statique local pour le harness. |
| `test/verify-*.mjs` | Tests Node des blocs purs extraits de `ui.js`. |
| `test/chrome-smoke.mjs` | Charge le paquet Chrome dans un Chrome headless (CDP) et vérifie worker, content script, popup, rendu. |
| `scripts/release.mjs` | Bump + build + lint + commit/push (+ upload AMO si clés API). |
| `scripts/build-chrome.mjs` | Manifeste Chrome **dérivé** de `manifest.json` + zip (aucun code transformé). |
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
| `GET /api/market/listings?…`, `POST` | Marché, création d'annonce. |
| `GET /api/market/buy-orders?characterId=` | Carnet d'achat. |

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

## 7. État des onglets

| Onglet | Contenu |
|---|---|
| **Compte** | Valeur du compte, ressources, top cartes, valeur par rareté, séries complètes, recherche d'un autre joueur (valorisation exacte). |
| **Vente** | Toutes les cartes, filtres rareté/série/**Doublons**, tri, prix potentiel, blocage de revente 48 h avec compte à rebours, sélection plafonnée aux places d'annonce (10), prix fixe/enchère, 3 stratégies applicables à tout le lot, pastille « N poss. ». |
| **Marché** | Scan des annonces sous la médiane (tri, pages, seuil de remise), annonces actives, marché global groupé par carte avec dépliant des ventes. |
| **%Drop** | Chasse à la carte : probabilité exacte par booster, boosters attendus, coût moyen, espérance de chakra. |
| **Auto-Open** | Boucle d'ouverture avec `T_max = (9 − B) × I + R`, watchdog, arrêt sur L/M, anti-AFK, journal horodaté, reprise après rechargement. |
| **Stat** | Classement de comptes suivis (recherche manuelle + import auto des amis) sur 10 métriques. Menu déroulant du critère, tableau réduit à ce critère, camembert à droite avec tous les comptes et 50 couleurs max, rangs ex æquo, rang site sous le pseudo, détail par compte. |
| **Réglages** | Cache des prix, délais, décote, type de vente, sound, anti-AFK. Plus de boutons de mise à jour. |
| **Debug** | Version du code, version chargée par le navigateur, rechargement de l'extension, requêtes récentes, clés du bootstrap, diagnostic copiable. |

## 8. Limites connues / dette

- `content/ui.js` est un monolithe (~9 200 lignes). Toute nouvelle vue l'agrandit : extraire un
  module serait utile mais risqué sans tests de non-régression UI.
- 12 avertissements `web-ext lint` (`UNSAFE_VAR_ASSIGNMENT` sur `innerHTML`) : inhérents au rendu
  par chaînes ; à traiter seulement si on migre vers du DOM construit.
- L'onglet Stat dépend de `trades/owned` + `fair-play/prices` : si le site change ces endpoints,
  la valeur et les séries resteront vides (« — »), par choix assumé.
- Le harness simule l'API : une forme de réponse réelle inattendue (ex. `/api/me/friends`)
  ne se verrait qu'en production.
- `verify-odds.mjs` a **1 écart préexistant** (`season-2026-fall R`), antérieur à la 1.0.0.
- **Paquet Chrome** : manifeste dérivé (`scripts/build-chrome.mjs`), aucun code transformé.
  `icons/icon-128.png` est un agrandissement LANCZOS de `icon-96.png` (pas d'original plus
  grand) : à remplacer si un logo source réapparaît. Depuis Chrome 137, `--load-extension`
  est ignoré dans les builds de marque ; `test/chrome-smoke.mjs` charge donc l'extension via
  CDP `Extensions.loadUnpacked` et travaille sur une copie autorisant `127.0.0.1:8787`.
- Les textes qui nomment le navigateur ou sa page de réglages passent par `IS_GECKO` /
  `BROWSER_NAME` dans `ui.js` (et `popup.js`) : ne pas réintroduire « Firefox » en dur.

## 9. Pistes proposées, non développées

- Export CSV des classements Stat.
- Historique (snapshots) de la valeur d'un compte suivi.
- Analyse « chance » : mythiques obtenues vs boosters ouverts.
- Cartes les plus / moins répandues parmi les comptes suivis.
- Découpage de `ui.js` en modules (state / api / vues) avec tests.

## 10. Fichiers annexes

- `affiche-sondage-kyara.png` : affiche humoristique hors extension (ne doit jamais partir dans le `.zip` AMO).
- `BUILD.md`, `PRIVACY.md` : notes de publication et de confidentialité.
