# Kyareeh+ — reprise du projet sous DeepSeek Harness

> Note d'analyse et de passation rédigée le **20 octobre 2026** après audit complet du dépôt local.
> Elle décrit **ce qui est vrai aujourd'hui**, l'architecture réelle du code, et **où ranger quoi**
> pour que la passation Cursor → DeepSeek Harness (DSH) tienne dans le temps.
>
> Répartition des rôles avec les autres fichiers :
> - `AGENTS.md` → **les règles** (conventions, API, pièges, carte du code). À respecter tel quel.
> - `README.md` → la doc **utilisateur/fonctionnelle**.
> - `BUILD.md` → la doc **AMO/reproductibilité**.
> - ce fichier → l'**état constaté**, l'architecture interne, l'environnement de dev et la
>   configuration DSH. C'est la note de reprise, pas une deuxième bible de conventions.

---

## 0. L'essentiel en dix lignes

- Projet : **Kyareeh+**, extension Firefox MV3 (`kyara-plus@axel.dev`) pour `kyara.games`.
- Dépôt réel : **`https://github.com/mRNeFF/kyareeh-plus`** (public, branche `master`).
  Le lien `mRNeFF/eeh-build` donné au moment de la passation renvoie **404** : ce n'est pas le dépôt.
- Clone local : `C:\Users\AXEL\Documents\deepseek-harness\default-workspace\kyara-plus`.
- État : version **1.0.1**, arbre propre, `HEAD = origin/master = 3262534`, tags `v1.0.0`/`v1.0.1`.
- Code : **un seul content script monolithique** (`content/ui.js`, 8 925 lignes) + un CSS injecté
  (3 330 lignes) + un service worker minimal + une popup. Aucune étape de build.
- Tests : 43 + 55 contrôles verts, 97 comparaisons de probabilités dont **1 écart connu et assumé**.
- Lint : **0 erreur, 12 avertissements** `UNSAFE_VAR_ASSIGNMENT` (attendus).
- Le projet a **3 jours** (premier commit le 17/10/2026, 46 commits) : tout est encore frais,
  les docs dérivent déjà légèrement du code (voir §9).

---

## 1. Produit, en une page

Extension de confort pour le site de cartes à collectionner **kyara.games**. Elle injecte un panneau
(Shadow DOM) sur le site et réutilise **la session déjà ouverte** : aucun identifiant stocké,
aucun serveur, aucune télémétrie. Seule requête sortante hors du site : la lecture du `manifest.json`
public du dépôt GitHub pour signaler une nouvelle version.

Ce que fait le panneau, par onglet :

| Onglet | Ce qu'il apporte | Fonction de vue |
|---|---|---|
| **Compte** | Valeur estimée en chakra, ressources (boosters, pity), top cartes, valeur par rareté, complétion par série, recherche d'un autre joueur avec valorisation exacte | `viewAccount()` |
| **Vente** | Toutes les cartes (pas seulement les doublons), filtres rareté/série/doublons, blocage de revente 48 h avec compte à rebours, sélection plafonnée aux places d'annonce, prix fixe ou enchère, 3 stratégies applicables au lot | `viewSell()` |
| **Marché** | Scan des annonces sous la médiane, annonces actives, marché global groupé par carte | `viewMarket()` |
| **%Drop** | Chasse à la carte : probabilité exacte par booster, boosters attendus, coût moyen, espérance de chakra | `viewCards()` |
| **Auto-Open** | Boucle d'ouverture (1 booster à la fois, délai aléatoire `T_max = (9 − B) × I + R`), watchdog, arrêt sur L/M, anti-AFK, journal, reprise après rechargement | `viewAuto()` |
| **Stat** | Jusqu'à 20 comptes suivis classés sur 10 métriques, import auto des amis (12 h), camembert, rangs ex æquo | `viewStat()` |
| **Réglages** | Cache des prix, délais, décote, type de vente, son, anti-AFK, mode simulation | `viewSettings()` |
| **Debug** | Version du code vs version chargée par Firefox, rechargement, journal des requêtes, diagnostic copiable | `viewDebug()` |

Deux contraintes produit structurent tout le reste :

1. **Aucune donnée inventée.** Une valeur indisponible s'affiche `—` avec son explication.
   C'est la règle n°1 du projet ; plusieurs refontes de l'onglet Stat viennent de là.
2. **Toujours préciser le périmètre** (« sur N comptes suivis », « depuis le … »). Le chakra est
   privé, le classement plafonne à 100 lignes, les séries du profil sont tronquées à 8 : toutes
   ces limites doivent être dites dans l'UI, pas contournées par une estimation silencieuse.

---

## 2. Architecture réelle du code

### 2.1 Vue d'ensemble

```
manifest.json            MV3, content_scripts sur https://kyara.games/*
background/background.js service worker : rechargement à chaud + version du manifeste
content/ui.js            TOUT le panneau (état, API, vues, calculs purs)  — 8 925 lignes
content/ui.css           styles du Shadow DOM (préfixe kp-)               — 3 330 lignes
popup/                   popup de la barre d'outils (recharger l'extension)
test/harness.html        faux site + fausse API (comptes, marché, packs, amis, ladder)
test/server.cjs          serveur statique local (port 8787)
test/verify-*.mjs        tests Node des blocs purs extraits de ui.js
scripts/release.mjs      bump + build + lint + commit/push + archive source (+ AMO)
.web-ext-config.mjs      liste d'exclusion du zip publié
```

### 2.2 Anatomie de `content/ui.js`

Le fichier est une **IIFE** (`(() => { … })()`) avec une garde `window.__kyaraPlusLoaded`.
Ordre réel des blocs :

1. **Constantes et helpers** : `VERSION` (lue depuis le manifeste, jamais recopiée), clés de
   stockage, `DEFAULT_SETTINGS`, tables `RARITY` / `DUPE_SORTS` / `DEAL_SORTS`, `fmt()`, `esc()`,
   `toNum()`, `ApiError`, `ERROR_HINTS`.
2. **`state`** : un objet unique (~80 champs) contenant compte, collection, prix, vues de vente,
   réglages, plan de vente en cours, journal de debug, état des comptes suivis.
3. **Montage** : `mount()` crée `<div id="kyara-plus-root">`, y attache un **Shadow DOM `open`**,
   charge `content/ui.css` via `runtime.getURL` (avec `FALLBACK_CSS` si échec), puis branche
   la délégation d'événements (`data-act` → `onClick`, `data-role` → `onInput`, `change`, `keydown`).
   Raccourci global **Alt+K**. Messages `kp-toggle` / `kp-reload` / `kp-status`.
4. **Version & mise à jour** : comparaison sémantique avec le `manifest.json` du dépôt GitHub,
   plus détection « manifeste périmé » (version disque ≠ version chargée par Firefox) — le bug
   historique qui faisait croire que le rechargement ne marchait pas.
5. **Accès données** : `boot()` (migration des réglages, montage, chargement, boucles),
   `loadData()`, `loadSelfProfile()`, `refreshLight()`, `autoRefreshTick()`.
6. **Prix** : `loadPrices()` par lots, cache `storage.local` (6 h par défaut), `priceOf()`,
   `netOf()` (taxe 5 % + dépôt 2 % min 1 ◆), `suggestPrice()`, `auctionStartPrice()`.
7. **Bloc `ANALYSIS:BEGIN … ANALYSIS:END`** : fonctions **pures** de tendance / volatilité /
   confiance / recommandations, extraites littéralement par `test/verify-analysis.mjs`.
8. **Bloc `STATS:BEGIN … STATS:END`** : fonctions pures de l'onglet Stat (`statSeriesProgress`,
   `statCollectionValue`, `statOwnerCounts`, `statAccountMetrics`, `statSortAccounts`, `statRankRows`),
   extraites par `test/verify-statglobal.mjs`.
9. **Rendu** : `render()` → `renderUnsafe()` construit les onglets, la vue courante et le pied ;
   tout passe par des chaînes `innerHTML` échappées par `esc()`.
10. **Vues** : `viewAccount`, `viewSell`, `viewMarket`, `viewCards`, `viewAuto`, `viewStat`,
    `viewSettings`, `viewDebug`.
11. **Auto-Open** : `startAutoOpen()`, `autoOpenLoop()`, `autoRegenInfo()`, `autoDelayRange()`,
    watchdog `ensureAutoAlive()`, anti-AFK (`scanAfk`, `afkClick`), sons, journal persistant.
12. **Profil d'un autre joueur** : recherche `friends/search`, `loadProfile()`, repli documenté.

Règle d'or pour étendre : le code se modifie **par les mêmes points d'entrée** —
`data-act` + `case` dans `onClick`, `data-role` + `onInput`, nouvelle vue dans l'objet `fn`
de `renderView()`, nouvel appel réseau **uniquement** via `api()`.

### 2.3 Persistance

| Clé | Contenu | Portée |
|---|---|---|
| `kyaraplus.prices.v2` | cache des prix par carte | `storage.local` |
| `kyaraplus.settings.v2` | réglages fusionnés avec `DEFAULT_SETTINGS` | `storage.local` |
| `kyaraplus.characters.v1` | catalogue (6 736 cartes) | `storage.local` |
| `kyareeh.packavg.v1` | prix moyens par rareté (24 h) | `storage.local` |
| `kyareeh.packpools.v1` | pools réels des boosters | `storage.local` |
| `kyareeh.statboard.v1` | comptes suivis, index propriétaires, `friendsAt` | `storage.local` |
| `kyara_token`, `kyara_device`, `kyara_pass` | session du site (lecture seule côté extension) | `localStorage` de kyara.games |

Détail important : `boot()` **migre** les anciens réglages (suppression de `autoCount`,
`autoLoop`, `autoDelayMs`…, passage à `autoPacingV2`). Toute nouvelle option doit suivre ce schéma
sinon les profils existants gardent des valeurs mortes.

### 2.4 Flux de démarrage

`boot()` → version disque/manifeste → réglages + cache prix → `mount()` → `loadData()`
(`/api/me/bootstrap`, `/api/me/collection?lean=1`, `/api/config`, `/api/me/market/access`,
`/api/me/market`, puis `/api/me`) → `loadAutoLog()` → boucle de rafraîchissement →
anti-AFK → watchdog → vérification de version distante (2,5 s) → reprise éventuelle de
l'auto-open (1,5 s). Le panneau est conçu pour **survivre à un rechargement de page**.

---

## 3. API réellement utilisée

`AGENTS.md` §6 contient la table de référence et les pièges vérifiés (ladder à 100 lignes,
4 tris réels seulement, chakra privé, pas d'historique de ventes, `byRarity` = types distincts,
`series[]` tronqué à 8, 401 sans session sur `trades/owned` et `fair-play/prices`).
À compléter avec les endpoints présents dans le code mais absents de cette table :

- `GET /api/config` — configuration du site (dont `golden` pour le pack doré).
- `GET /api/me/market/access`, `GET /api/me/market` — accès et état du marché du compte.
- `GET /api/me/collection/prices?ids=…` — prix groupés de **ma** collection (lots de 500).
- `GET /api/market/prices/:id` — fiche prix d'une carte (médianes, série, dernières ventes).
- `GET /api/packs/:id/characters` — pool réel d'un booster.
- `GET /api/me/friends/search?q=` — recherche de n'importe quel joueur (utilisée aussi pour
  la valorisation d'un autre compte et pour ajouter un compte au classement).

Authentification : `credentials: 'include'` + `authorization: Bearer <kyara_token>` +
`x-device-id` (`kyara_device`, généré et conservé si absent) + `x-pass` (lu dans `kyara_pass`,
uniquement pour les écritures). Un seul wrapper `api()` journalise chaque requête dans Debug,
applique un timeout (`AbortSignal.timeout`) et traduit les codes d'erreur via `ERROR_HINTS`.

---

## 4. Build, release, AMO

- **Aucune compilation** : les 9 fichiers du zip sont les fichiers du dépôt, octet pour octet.
  `.gitattributes` force LF, ce qui garantit l'égalité archive ↔ zip même sous Windows.
- `npm run build` → `web-ext build`, nom de zip **écrit en dur dans `package.json`** et réécrit
  automatiquement par `scripts/release.mjs` au bump. Ne jamais bumper seulement le manifeste.
- `npm run release -- 1.0.1` : bump `manifest.json` + `package.json` + `README.md`
  (`Fonctionnalités (v…)`) → build → `web-ext lint` (bloque si erreur) → `git add -A` →
  commit `Release vX` → push → archive source `git archive` → upload AMO **si**
  `WEB_EXT_API_KEY` + `WEB_EXT_API_SECRET` sont présents, sinon instructions manuelles.
- `.githooks/post-commit` pousse automatiquement la branche courante (silencieux, non bloquant).
  Un clone neuf doit faire une fois : `git config core.hooksPath .githooks`.
- Publier sur AMO en **« On this site »** (listé) : c'est le seul moyen d'avoir des mises à jour
  automatiques, `update_url` étant interdit par Mozilla (`MANIFEST_UPDATE_URL`).
- `web-ext-artifacts/` est gitignoré : les zips 1.0.0/1.0.1 (+ archives source) sont locaux.

### Piège de packaging à connaître

`.web-ext-config.mjs` fonctionne par **liste d'exclusion** : tout fichier à la racine qui n'y est
pas listé **part dans le zip AMO**. C'est pourquoi cette note (`REPRISE-DSH.md`) et un éventuel
`AGENTS.local.md` y ont été ajoutés. Toute nouvelle doc racine doit suivre, sinon elle est publiée.

---

## 5. Environnement de dev constaté (machine d'Axel)

| Élément | Valeur |
|---|---|
| OS / shell | Windows, **PowerShell 7** (`pwsh`) |
| Node | v24.19.0 (`C:\Program Files\nodejs`) |
| Git | 2.55.0.windows.5, identité `mRNeFF` configurée **dans le dépôt** |
| Credential GitHub | `!gh auth git-credential` (config locale du dépôt) |
| DSH | `DSH_HOME=C:\Users\AXEL\.dsh`, profil `desktop`, workspace `…\deepseek-harness\default-workspace` |
| Firefox | extension chargée via `npm run start` (web-ext) ou `about:debugging` |

**Piège PowerShell vérifié** : l'ExecutionPolicy bloque les shims `.ps1`.
`npm run …` et `npx …` échouent avec « Impossible de charger npm.ps1 ».
Contournements, sans toucher à la politique système :

```powershell
npm.cmd run verify:analysis
node node_modules/web-ext/bin/web-ext.js lint --source-dir .
node --check content/ui.js
```

Le harness local (aucun compte requis) :

```powershell
node test/server.cjs   # http://127.0.0.1:8787/test/harness.html
# window.__kyaraPlus : setOpen, setTab, state, render, fonctions clés
```

---

## 6. Où enregistrer quoi dans DSH (la partie passation)

### 6.1 Comment DSH charge le contexte

DSH charge une **chaîne d'instructions** au premier tour, puis la met à jour quand une opération
fichier atteint un dossier plus profond (il ne surveille pas les fichiers en continu) :

1. **Global utilisateur** : `C:\Users\AXEL\.dsh\AGENTS.md`, puis `C:\Users\AXEL\.agents\AGENTS.md`.
2. **Projet** : du **root du projet** (marqué par `.git`) jusqu'au dossier de travail, du plus
   large au plus précis. Fichiers candidats : `AGENTS.md`, `CLAUDE.md` (+ overlays
   `AGENTS.local.md`, `CLAUDE.local.md`).
3. Budget par défaut : **65 536 octets** pour l'ensemble ; les fichiers larges sont retirés
   avant que le plus précis ne soit tronqué.
4. Le contenu est dédupliqué : un `CLAUDE.md` identique à `AGENTS.md` n'est pas répété.

Conséquence pratique : **`AGENTS.md` est le bon véhicule**. Pas besoin de coller le contexte dans
le prompt à chaque session ; il suffit qu'il soit à jour.

### 6.2 Répartition recommandée

| Emplacement | Rôle | Versionné ? | État |
|---|---|---|---|
| `C:\Users\AXEL\.dsh\AGENTS.md` | Préférences **globales** (langue, OS, pièges pwsh, workspace, index des projets) | hors dépôt | **créé** |
| `kyara-plus\AGENTS.md` | Contexte **projet** : conventions, API, pièges, carte du code | oui | existait déjà |
| `kyara-plus\REPRISE-DSH.md` | **Cette note** : état constaté, architecture, audit, écarts | oui | **créé** |
| `kyara-plus\AGENTS.local.md` | Surcharges **machine** (chemins absolus, clés locales) | à exclure de git | non créé (voir §6.4) |
| `~\.dsh\profiles\desktop\cordis.patch.yml` | Config DSH (plugins, UI), pas du projet | hors dépôt | existant |
| `~\.dsh\sessions\…` | Transcripts des sessions DSH | hors dépôt | ne pas sauvegarder dans le repo |
| Variables `WEB_EXT_API_KEY` / `WEB_EXT_API_SECRET` | Envoi AMO | **jamais** dans le repo | à définir au besoin |

### 6.3 Ce qui ne doit PAS aller dans `AGENTS.md`

- des chemins absolus de la machine (ils changent ; et ils n'ont pas leur place dans un dépôt public) ;
- l'état d'une session (« j'étais en train de… ») : ça se périme en une heure ;
- des secrets ou des identifiants ;
- la doc fonctionnelle détaillée (c'est `README.md`) ni les procédures AMO (c'est `BUILD.md`).

### 6.4 Note sur `AGENTS.local.md`

DSH le charge en overlay, mais **`.gitignore` ne l'exclut pas** aujourd'hui
(`node_modules/`, `web-ext-artifacts/`, `*.xpi`, `.DS_Store`, `Thumbs.db`). Si tu l'utilises,
ajoute-le à `.gitignore` **et** à `.web-ext-config.mjs`. Sinon il finira commité et/ou publié.

---

## 7. Vérifications reproductibles (état au 20/10/2026)

```powershell
cd C:\Users\AXEL\Documents\deepseek-harness\default-workspace\kyara-plus

node --check content/ui.js          # syntaxe
node test/verify-analysis.mjs       # Contrôles : 43 · échecs : 0
node test/verify-statglobal.mjs     # Contrôles : 55 · échecs : 0
node test/verify-odds.mjs           # Comparaisons : 97 · écarts : 1 (season-2026-fall R)
node node_modules/web-ext/bin/web-ext.js lint --source-dir . --output json
                                    # errors 0 / warnings 12 (UNSAFE_VAR_ASSIGNMENT)
git status --short --branch         # ## master...origin/master, arbre propre
git log -1 --format='%h %s'         # 3262534 Release v1.0.1
git ls-remote --heads origin        # 3262534… refs/heads/master
```

L'écart `season-2026-fall` / rareté R est **connu et documenté** : le `perCardPct` du serveur
(7,43 %) est incompatible avec son propre `cardsByRarity` (20 cartes → 7,60 %). Ce n'est pas un
bug de l'extension ; ne pas « corriger » la formule pour le faire disparaître.

---

## 8. Dettes et risques (au-delà de `AGENTS.md` §8)

1. **Monolithe** : `ui.js` fait 8 925 lignes et grossit à chaque onglet. Aucun test d'UI.
   Un découpage (state / api / vues) serait sain mais risqué : à faire avec un harnais de
   non-régression, pas à l'occasion d'une feature.
2. **Rendu par chaînes** : 12 avertissements `UNSAFE_VAR_ASSIGNMENT` inhérents à `innerHTML`.
   La sécurité tient à `esc()` appliqué à **toute** donnée distante. Une seule interpolation
   oubliée crée une faille XSS dans le Shadow DOM.
3. **Dépendance à une API interne non documentée** : tout changement de forme casse silencieusement
   une vue (le harness simule l'API, il ne détecte pas une dérive de production).
4. **Anti-cheat / CGU** : l'auto-open et la vente en masse sont des envois répétés. Les garde-fous
   (délai 1,2 s, lots bornés, validation humaine, mode simulation) sont des exigences produit,
   pas des options.
5. **Quota de stockage** : l'onglet Stat ne conserve pas les collections complètes
   (`kyareeh.statboard.v1` = index compact). Ne pas ajouter de cache lourd sans mesurer.
6. **Pas de CI** : la qualité repose sur les trois scripts et la discipline de release.
   Candidat évident pour un workflow GitHub Actions (lint + verify + build).
7. **Projet très jeune** (3 jours) : la doc a été écrite plus vite que le code n'a évolué,
   d'où les écarts du §9.

---

## 9. Écarts documentation ↔ réalité relevés

| Fichier | Affirmation | Réalité | Action suggérée |
|---|---|---|---|
| `BUILD.md` | Tailles des 9 fichiers : `ui.js 181581`, `ui.css 36460`… | `ui.js 346110`, `ui.css 61401` (valeurs de la 1.0.0) | Mettre à jour, ou dater la section « contrôle des tailles » |
| `BUILD.md` | Correspondance archive/paquet | Toujours vraie (LF forcé) | garder |
| `AGENTS.md` | « Dernier commit de référence : `150960f` » | HEAD = `3262534` (2 commits de release plus loin) | Retirer la référence ou la faire vivre |
| `AGENTS.md` | « ~8 800 lignes » / « ~8 600 » | 8 925 | Cosmétique |
| `README.md` | Section « Utilisation » parle encore de l'onglet **Doublons** | L'onglet s'appelle **Vente** depuis la 0.15 | Aligner les 4 lignes |
| `.web-ext-config.mjs` | Ignore `updates.json` | Ce fichier n'existe pas (résidu) | Inoffensif |
| `AGENTS.md` §6 | Table API | 6 endpoints utilisés n'y figurent pas (§3 ci-dessus) | Compléter |

Aucun de ces écarts n'affecte le comportement de l'extension ; ils affectent la **confiance**
dans la doc, qui est justement le support de la passation.

---

## 10. Feuille de route de reprise (ordre conseillé)

1. **Lire** `AGENTS.md` en entier, puis ce fichier. Ne rien modifier avant.
2. **Vérifier** l'état avec les commandes du §7 (2 minutes).
3. **Charger** l'extension (`npm.cmd run start` ou `about:debugging`) et ouvrir le harness.
4. **Corriger la doc** (§9) : c'est peu risqué et ça fiabilise les prochaines sessions.
5. **Ajouter un workflow CI** minimal (lint + 3 verify) : le meilleur rapport valeur/risque.
6. Ensuite seulement, les pistes de `AGENTS.md` §9 (export CSV, snapshots de valeur, analyse
   « chance », découpage de `ui.js`).

### Critères de « prêt à livrer » (rappel)

`node --check content/ui.js` → 3 `verify-*.mjs` → `web-ext lint` (0 erreur) → version bump
cohérent (`manifest.json` + `package.json` + nom du zip) → `README` à jour → commit + push.

---

## 11. Conventions de travail avec Axel

- **Français**, réponses concises et concrètes ; pas de reformulation de la demande.
- Dire **ce qui est vérifié** et **ce qui est supposé** — c'est la culture du projet.
- Ne jamais supprimer une fonctionnalité sans accord explicite.
- Toute statistique affichée doit porter son périmètre et ses trous.
- Sur ce dépôt : ne pas réécrire l'historique publié, ne pas committer d'artefacts
  (`web-ext-artifacts/` est gitignoré, le hook pousse à chaque commit).
