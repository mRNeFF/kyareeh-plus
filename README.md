# Kyareeh+

Extension Firefox pour [kyara.games](https://kyara.games) : tableau de bord de compte, valorisation de la collection en chakra, vente assistée et mise en enchère des doublons.

> Projet de fan, non affilié à Kyara. À utiliser dans le respect des règles du jeu.

## Fonctionnalités (v0.9.9)

- **Valeur estimée du compte en chakra** : somme des cartes au prix médian du marché, avec fourchette basse/haute et pourcentage de cartes valorisées.
- **En-tête de profil** : avatar Discord, pseudo, titre, rang et points, lien direct vers ta page sur kyara.games.
- **Valeur des doublons** : brut, net après taxe de vente (5 %) et frais de dépôt (2 %, min 1 ◆), plus la valeur de recyclage.
- **Top cartes**, **répartition de la valeur par rareté** et **complétion par série**.
- **Ressources** : chakra, boosters gratuits / max, bonus, pity, accès au marché.
- **Onglet Doublons** : tri (prix unitaire, valeur du lot, exemplaires, rareté, nom), quantité, exemplaires vendables, prix médian, annonce la plus basse, meilleur ordre d'achat, liquidité (ventes 7 j), valeur de recyclage. La sélection est plafonnée aux **places d'annonce libres** du site (5 par défaut, moins les annonces actives) : les lignes qui ne rentrent plus sont désactivées et un compteur `sélection / places` reste visible. Le bouton **Remplir** complète automatiquement les places libres dans l'ordre de tri.
- **Vente assistée** : sélection → aperçu du brut / frais / taxe / net → **durée de l'annonce (12 h par défaut, 12/24/48)** → validation → création des annonces, avec délai configurable, arrêt d'urgence et mode simulation.
- **Mise en enchère** : au lieu du prix fixe, mise à prix calculée à *médiane − X %* (réglable par lot, 15 % par défaut), avec achat immédiat facultatif à *+ Y %*.
- **Marché** : scan configurable (tri prix croissant/décroissant/plus récentes/fin proche, jusqu'à 20 pages de 50 annonces, seuil de remise réglable, filtre prix fixe/enchères), classé par économie réelle par rapport à la médiane 7 jours.
- **Cartes (nouvel onglet)** : en tête, la *chasse à la carte* — probabilité exacte par booster, pour **tous** les boosters disponibles (pool réel, vedettes et pack doré inclus), nombre de boosters attendus, coût moyen et chance d'au moins une sur 100 boosters. Une fois la carte choisie, seule cette carte reste affichée. En dessous, l'espérance de chakra par booster (retour en %) et les prix moyens par rareté.
- **Mes annonces** : seules les annonces actives sont listées, avec type, mises et temps restant.
- **Auto-Open (nouvel onglet)** : coche **un ou plusieurs** boosters — l'ouverture en tire un **au hasard** à chaque fois, **un booster à la fois**, puis attend un délai aléatoire entre **10 s** et **« minutes par booster » × 9** (10 min par défaut, donc 1 h 30 max) avant le suivant. Ça continue **jusqu'à ce que tu cliques sur Arrêter**, en attendant les boosters suivants quand il n'y en a plus. Il consomme d'abord les boosters offerts (dons, gratuits, bonus), puis le chakra **seulement si tu l'autorises**. Compte à rebours en direct avant le prochain booster. Autres options : **bruit à chaque booster** (carillon, plus aigu sur une Légendaire/Mythique, désactivable), arrêt automatique sur Légendaire/Mythique, et **rafraîchissement automatique du compte** (10 min par défaut) pour voir arriver de nouveaux boosters. Suivi en direct : boosters ouverts, cartes, chakra dépensé, répartition par rareté, meilleures trouvailles et dernier tirage. Si le laissez-passer du site a expiré, un bouton ouvre la page du booster pour le renouveler.
- **Valeur d'un autre compte** : recherche instantanée au fil de la saisie, puis page dédiée avec valeur exacte (prix du jeu), répartition par rareté, plus belles cartes, et bouton **← Mon compte**.
- **Réglages** : cache des prix, délai entre ventes, taille max du lot, décote, type de vente, pourcentages, mode simulation.
- **Mise à jour** : bouton **Recharger l'extension** dans les Réglages (et dans la popup) qui relit le dossier local et rafraîchit la page — aucun téléchargement.
- **Debug** : journal des requêtes, clés renvoyées par l'API, diagnostic copiable.

## Installation (Firefox)

1. Ouvre `about:debugging#/runtime/this-firefox`.
2. Clique sur **Charger un module complémentaire temporaire…**.
3. Sélectionne le fichier `manifest.json` de ce dossier.
4. Va sur `https://kyara.games`, connecte-toi avec Discord.
5. Un bouton **◆ Kyareeh+** apparaît en bas à droite. Raccourci : `Alt+K`.

L'add-on temporaire disparaît au redémarrage de Firefox. Pour une installation permanente, il faut signer le `.xpi` sur [addons.mozilla.org](https://addons.mozilla.org/developers/) (gratuit, en non listé) :

```bash
npx web-ext build
# puis upload du .zip de web-ext-artifacts/ sur AMO
```

## Mettre à jour

L'extension est chargée **directement depuis ce dossier** : il n'y a rien à retélécharger ni à réinstaller.

1. Récupère les changements (`git pull`, ou une modification faite sur cette machine).
2. Ouvre le panneau Kyareeh+ → onglet **Réglages** → **Recharger l'extension** → **Confirmer**.
   (ou icône de la barre d'outils → **Mettre à jour l'extension**)
3. La page se rafraîchit et le nouveau code est actif.

Le bouton envoie un message au **script de fond** (`background/background.js`), seul contexte autorisé à appeler `runtime.reload()`, puis rafraîchit l'onglet.

### Si la version ne change pas

Le panneau affiche trois versions dans les Réglages : **version du code** (celle du manifeste chargé), **manifeste sur le disque** (relu directement dans `manifest.json`, sans cache) et **manifeste chargé par Firefox**. Un bandeau s'affiche dès que le fichier du dossier est plus récent que ce que Firefox a en mémoire.

C'est le symptôme d'un add-on jamais rechargé : Firefox relit le JS à chaque page, mais garde le manifeste du chargement. Dans ce cas, le bouton ne peut pas fonctionner (le manifeste périmé n'a pas encore de script de fond). Il faut le faire une fois à la main :

1. `about:debugging#/runtime/this-firefox`
2. Repère l'entrée Kyareeh+ (ou Kyara+)
3. Clique sur **Recharger** — si l'erreur persiste, clique sur **Retirer**, puis **Charger un module complémentaire temporaire…** et sélectionne à nouveau `manifest.json`
4. `F5` sur kyara.games

Une fois le manifeste à jour, le bouton reprend le relai pour toutes les versions suivantes.

Chaque commit de ce dépôt est poussé automatiquement sur GitHub via le hook `.githooks/post-commit` (`core.hooksPath` est déjà configuré localement). Un clone neuf doit l'activer une fois :

```bash
git config core.hooksPath .githooks
```

## Utilisation

- **Compte** : vue d'ensemble, valorisation, ressources, top cartes.
- **Doublons** : coche les cartes à vendre. « Préparer la vente » ouvre l'aperçu. Tu peux modifier chaque prix avant de confirmer.
- **Marché** : « Scanner les bons plans » compare les annonces actives à la médiane 7 jours.
- **Réglages** : commence en **mode simulation** pour vérifier le plan sans créer d'annonce.

### Comment les prix sont calculés

L'extension interroge l'endpoint groupé `GET /api/me/collection/prices?ids=…` (par lots de 500) et récupère `median7d` / `median30d` pour chaque carte possédée. Les résultats sont mis en cache (`storage.local`, 6 h par défaut). La valeur du compte est la somme `quantité × médiane`. Les cartes sans prix sont exclues et comptées à part.

Prix de vente proposé (prix fixe) :

1. le meilleur ordre d'achat s'il est à moins de 15 % sous la médiane (vente immédiate) ;
2. sinon le plus bas prix d'annonce moins 1 ◆ ;
3. sinon la médiane ;
4. plancher = valeur de recyclage de la rareté.

Mise à prix d'une enchère : `médiane × (1 − X %)`, jamais sous la valeur de recyclage. L'achat immédiat facultatif vaut `mise à prix × (1 + Y %)`.

### Valeur d'un autre compte

La recherche est **instantanée** : dès 2 caractères, `GET /api/leaderboard/ladder?by=collection&q=pseudo` est interrogé (debounce 300 ms) et les comptes s'affichent au fil de la saisie. Un clic ouvre le profil en pleine page.

La valorisation est **exacte**, pas estimée :

1. `GET /api/trades/owned/:id` donne la liste des cartes réellement possédées (ids uniques) ;
2. les prix officiels sont récupérés par lots de 200 via `GET /api/fair-play/prices?ids=…`, l'endpoint utilisé par le site pour estimer un échange ;
3. la valeur est la somme des prix, et la répartition par rareté est recalculée à partir du catalogue — elle s'additionne exactement au total.

Si la liste n'est pas accessible (profil restreint, endpoint modifié), l'extension retombe sur une **estimation** par rareté (médiane des médianes du cache), clairement libellée « estimée », avec le nombre de cartes sans référence.

### Espérance des boosters

`GET /api/packs` renvoie, pour chaque booster, la composition des slots (`rates.slots[].pct`) et les taux par carte (`rates.perBooster`). L'espérance vaut :

\[ EV = (1 - p_{golden}) \times \sum_{slots} \sum_{rareté} pct \times prixMoyen_{rareté} + p_{golden} \times EV_{golden} \]

Les prix moyens par rareté sont obtenus par échantillonnage : 50 cartes tirées au hasard par rareté dans le catalogue, valorisées via `GET /api/fair-play/prices` (2 requêtes), puis mises en cache 24 h. Le « retour » affiché est \(EV / prix\) : au-dessus de 100 %, le booster rapporte en moyenne plus qu'il ne coûte.

La chasse à la carte utilise `rates.perBooster[rareté].perCardPct` : probabilité par booster, nombre de boosters attendus et coût moyen pour la carte visée.

### Probabilité exacte d'une carte précise

Pour un booster donné, `GET /api/packs/:id/characters` donne le **pool réel** (liste d'ids), et `rates.cardsByRarity` le dénominateur officiel. La probabilité par booster d'obtenir une carte de rareté \(r\) vaut :

\[ p = \frac{1}{N} \sum_{slots} \frac{pct_{slot}(r)}{100} \]

où \(N\) est le nombre de cartes de rareté \(r\) dans le pool. Pour une **vedette** (`rateUp`), elle capte une fraction `share` des tirages de ses raretés :

\[ p = \sum_{slots} \frac{pct_{slot}(r)}{100} \times \left( \frac{share}{N_{vedettes}} + \frac{1-share}{N} \right) \]

Le **pack doré** (1 booster sur `config.golden.every`) est mélangé : `p = (1 - 1/every) × p_normal + (1/every) × p_golden`. La ligne affiche aussi la valeur hors golden pour comparaison directe avec le site.

Validation : `npm run verify:odds` compare la formule aux `perBooster.perCardPct` officiels sur les 18 boosters et 6 raretés. **96 des 97 valeurs correspondent au chiffre près.** Le seul écart (`season-2026-fall`, rareté R) vient du serveur lui-même : son `perCardPct` (7,43 %) est incompatible avec son propre `cardsByRarity` (20 cartes pour une espérance de 1,52), qui donnerait 7,60 %.## Sécurité et limites

- Aucune donnée ne quitte le navigateur. Aucun mot de passe ni token n'est stocké.
- Les requêtes utilisent la session existante du site. L'extension relit à chaque appel le jeton `kyara_token` déjà présent dans le `localStorage` de kyara.games et le renvoie dans l'en-tête `Authorization`, comme le fait le site lui-même. Elle ne l'écrit jamais, ne le conserve pas et ne l'envoie qu'à `kyara.games`. L'identifiant d'appareil `kyara_device` est transmis de la même façon pour rester cohérent avec l'anti-cheat du site.
- L'API utilisée est l'API interne du site : elle peut changer sans préavis, auquel cas une mise à jour de l'extension sera nécessaire.
- Les frais affichés correspondent aux valeurs publiques du site (2 % de dépôt, min 1 ◆ ; 5 % de taxe). Si Kyara les modifie, les montants « net » seront légèrement faux.
- **Anti-cheat** : la vente en masse reste un envoi répété de requêtes. Garde un délai raisonnable (1,2 s par défaut), limite les lots et n'enchaîne pas les ventes en boucle. Le mode assisté demande une validation humaine à chaque lot.
- L'extension ne contourne pas les limites du site (emplacements d'annonces, accès au marché, comptes invités).

## Développement

```bash
npm install          # optionnel, pour web-ext
npm run start        # lance Firefox avec l'extension
npm run lint
npm run build
```

Structure :

```
manifest.json
content/
  ui.js       # panneau, chargement des données, moteur de prix, vente
  ui.css      # styles injectés dans le Shadow DOM
popup/        # popup de la barre d'outils
icons/
```

Le panneau est monté dans un Shadow DOM pour ne pas entrer en conflit avec le CSS du site.

## Feuille de route

- v0.2 : historique de valeur du compte (snapshots quotidiens), alerte wishlist sous un prix, valeur d'un trade entrant/sortant.
- v0.3 : signature AMO, export CSV, mini-graphes de prix par carte.
