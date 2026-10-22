# Kyareeh+ — paquet Chrome / Edge

Le même code sert Firefox et Chrome/Edge : `content/`, `background/`, `popup/` et `icons/`
sont **identiques** dans les deux paquets. Seul le manifeste diffère, et il est **généré**
par `scripts/build-chrome.mjs` à partir de `manifest.json` (source de vérité unique).

## Ce que le script change

| `manifest.json` (Firefox) | `dist/chrome/manifest.json` |
|---|---|
| `"background": { "scripts": ["background/background.js"] }` | `"background": { "service_worker": "background/background.js" }` |
| `browser_specific_settings.gecko` (id AMO, `strict_min_version`, `data_collection_permissions`) | supprimé (clés Firefox, inconnues de Chrome) |
| — | `"minimum_chrome_version": "116"` |
| icônes 16/32/48/96 | icônes 16/32/48/96 **+ 128** (obligatoire pour la fiche Chrome Web Store) |

Rien d'autre n'est modifié : pas de transpilation, pas de minification, pas de bundler.
`background/background.js` utilise déjà `globalThis.browser ?? globalThis.chrome`, et le
content script n'appelle aucune API spécifique à Firefox.

> Limite connue : `icons/icon-128.png` est un agrandissement LANCZOS de `icon-96.png`
> (aucun original plus grand n'existe dans le dépôt). Remplacer le fichier par un vrai
> 128 px si un logo source est retrouvé.

## Construire

PowerShell 7 bloque les shims `.ps1` sur cette machine : utiliser `npm.cmd`.

```powershell
npm.cmd run build:chrome
```

Sorties :

```
dist/chrome/                                    extension décompressée (mode développeur)
web-ext-artifacts/kyareeh-plus-<version>-chrome.zip   paquet à téléverser
```

`dist/` et `web-ext-artifacts/` sont gitignorés. Le zip ne contient que les 13 fichiers
de l'extension (manifeste, `background/`, `content/`, `popup/`, `icons/`).

## Tester dans Chrome

### À la main (mode développeur)

1. `chrome://extensions` → active **Mode développeur**.
2. **Charger l'extension non empaquetée** → choisis `dist/chrome`.
3. Va sur `https://kyara.games`, connecte-toi, puis `Alt+K` ou le bouton **◆ Kyareeh+**.
4. La popup de la barre d'outils affiche la version et le bouton de rechargement.

### Automatiquement

```powershell
npm.cmd run verify:chrome
```

`test/chrome-smoke.mjs` lance un Chrome **headless** et vérifie, dans un vrai moteur Chromium :

1. chargement de l'extension et de son service worker MV3 ;
2. réponse du script de fond (`kp-manifest-version`) ;
3. injection du content script sur une page de test (Shadow DOM + 8 onglets) ;
4. ouverture de la popup et affichage de la version ;
5. rendu des onglets Compte / Vente / Stat du harness, sans exception JS
   (captures dans `../_shots/chrome-*.png`) ;
6. **Détacher** (fenêtre `panel/panel.html`) : une seule fenêtre, panneau plein écran, données
   du compte relayées par l'onglet du site, +Duel chargé dans la fenêtre, fermer le panneau de
   la page sans vider la fenêtre, Rattacher (fenêtre, page, fermeture manuelle), message clair
   sans onglet du site.

Deux détails d'implémentation, appris à l'exécution :

- depuis Chrome 137, `--load-extension` est **ignoré** dans les builds de marque ; le test
  charge l'extension via la commande CDP `Extensions.loadUnpacked` (celle qu'utilise Puppeteer) ;
- le content script n'étant autorisé que sur `https://kyara.games/*`, le test travaille sur une
  **copie** du paquet qui ajoute `http://127.0.0.1:8787/*` à ses correspondances. Le paquet
  publié n'est jamais modifié ;
- pour le relais de la fenêtre détachée (qui cherche un onglet `https://kyara.games/*`), la
  copie de test remplace aussi ce motif par l'onglet local et simule les `/api/…` par CDP
  (`Fetch.fulfillRequest`) ;
- le paquet doit contenir `panel/` **et** `duel/` (pages d'extension ouvertes par le code, donc
  absentes du manifeste) : `build-chrome.mjs` échoue si `panel/panel.html` ou `duel/duel.html`
  manque.

## Visuels de la fiche (captures, icône, bannières)

Tous les visuels demandés par le Chrome Web Store sont générés depuis le harness local
(données fictives, aucun compte réel) :

```powershell
node scripts/store-shots.mjs     # 5 captures 1280×800 + panneaux recadrés
python scripts/store-promo.py    # icône 128, vignette 440×280, bannière 1400×560
```

Sortie par défaut : `../_shots/store/` (hors dépôt, donc jamais dans un paquet).

| Fichier | Format | Usage |
|---|---|---|
| `screenshot-1-compte.png` | 1280 × 800 | compte, valeur, ressources |
| `screenshot-2-duel.png` | 1280 × 800 | duel : entraînement contre l'IA (plein écran) |
| `screenshot-3-marche.png` | 1280 × 800 | marché global et annonces |
| `screenshot-4-drop.png` | 1280 × 800 | %Drop, espérance par booster |
| `screenshot-5-stat.png` | 1280 × 800 | classement des comptes suivis |
| `icon-128.png` | 128 × 128 | icône de la fiche (96 px d'illustration + 16 px de marge transparente, règle Chrome) |
| `promo-440x280.png` | 440 × 280 | petite vignette promotionnelle |
| `promo-1400x560.png` | 1400 × 560 | bannière marquee |
| `description.md` | texte | nom, description courte (106/132), description détaillée, notes relecteur |

Le script de captures neutralise les éléments du harness, aligne la version affichée sur
celle du manifeste et remplace les illustrations de cartes mortes par une vignette neutre.
Les données montrées sont celles de `test/harness.html`, pas celles d'un compte réel.

La fiche met en avant les **duels** : la capture 2 est une partie d'entraînement contre l'IA,
et l'onglet **Auto-Open** est masqué dans les autres captures (aucune autre modification de
l'interface). Les textes de `description.md` ne mentionnent ni l'auto-open ni la vente auto.

## Publier sur le Chrome Web Store

1. Compte développeur : <https://chrome.google.com/webstore/devconsole> (5 USD, une fois).
2. **Nouvel élément** → téléverse `web-ext-artifacts/kyareeh-plus-<version>-chrome.zip`.
3. Remplis la fiche :
   - **Nom** : `Kyareeh+ (beta)` (≤ 75 caractères, déjà dans le manifeste).
   - **Description courte** : celle du manifeste (≤ 132 caractères) — variantes dans
     `../_shots/store/description.md`.
   - **Description détaillée** : `../_shots/store/description.md` (section « Description détaillée »).
   - **Catégorie** : Outils (ou Jeux et loisirs).
   - **Langue** : français.
   - **Icône de la fiche** : `../_shots/store/icon-128.png`.
   - **Captures** : `../_shots/store/screenshot-1-compte.png`, `screenshot-2-duel.png`,
     `screenshot-3-marche.png`, `screenshot-4-drop.png`, `screenshot-5-stat.png` (1280 × 800).
   - **Vignette et bannière** : `promo-440x280.png` et `promo-1400x560.png`.
   - **Politique de confidentialité** : publier `PRIVACY.md` sur une URL publique
     (page GitHub suffit) — obligatoire dès qu'une permission sensible est demandée.
4. Onglet **Confidentialité** :
   - usage des permissions : `storage` (cache local des prix/catalogue), `activeTab`
     (lire l'onglet kyara.games pour la popup), hôtes `kyara.games` et
     `raw.githubusercontent.com` (session du site + vérification de version) ;
   - **code distant** : non — l'extension télécharge un `manifest.json` de version, jamais
     du code ; tout le JS est dans le paquet ;
   - **collecte de données** : aucune (tout reste dans le navigateur).
5. Soumettre. La validation prend de quelques heures à quelques jours ; les mises à jour
   suivantes sont automatiques via le Store (pas d'`update_url`).

### Edge Add-ons

Le même zip est accepté tel quel sur <https://partner.microsoft.com/dashboard/microsoftedge/>.

## Différences de comportement Firefox / Chrome

- **Mise à jour** : Chrome Web Store met à jour automatiquement l'extension publiée. Le
  bouton « Recharger l'extension » (Debug / popup) ne sert qu'au **développement** avec
  `dist/chrome` chargé en mode développeur.
- **Textes** : le panneau affiche « Version dans Chrome » et renvoie vers
  `chrome://extensions` (au lieu d'`about:debugging`) grâce à une détection `navigator.userAgent`.
- **Service worker** : `background/background.js` est le même fichier, mais Chrome peut
  l'arrêter après ~30 s d'inactivité. Le rechargement (message → `tabs.reload` →
  `runtime.reload`) tient en ~350 ms, donc reste dans la fenêtre de vie du worker.

## Limites à connaître avant publication

- L'auto-open et la vente en masse sont des **envois répétés** : les garde-fous (délais,
  lots bornés, validation humaine, mode simulation) sont des exigences produit, pas des
  options. Un relecteur Chrome peut demander des explications ; les décrire dans les notes.
- L'extension dépend d'une **API interne non documentée** de kyara.games : une casse côté
  site cassera une vue sans prévenir (même comportement que sur Firefox).
- `content/ui.js` est un monolithe rendu par `innerHTML` échappé (`esc()`). Les
  avertissements de linter Firefox sont attendus ; Chrome n'a pas d'équivalent.
