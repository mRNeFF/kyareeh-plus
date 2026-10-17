# Kyareeh+

Extension Firefox pour [kyara.games](https://kyara.games) : tableau de bord de compte, valorisation de la collection en chakra, vente assistée et mise en enchère des doublons.

> Projet de fan, non affilié à Kyara. À utiliser dans le respect des règles du jeu.

## Fonctionnalités (v0.3.0)

- **Valeur estimée du compte en chakra** : somme des cartes au prix médian du marché, avec fourchette basse/haute et pourcentage de cartes valorisées.
- **Valeur des doublons** : brut, net après taxe de vente (5 %) et frais de dépôt (2 %, min 1 ◆), plus la valeur de recyclage.
- **Top cartes**, **répartition de la valeur par rareté** et **complétion par série**.
- **Ressources** : chakra, boosters gratuits / max, bonus, pity, accès au marché.
- **Onglet Doublons** : quantité, exemplaires vendables, prix médian, annonce la plus basse, meilleur ordre d'achat, liquidité (ventes 7 j), valeur de recyclage.
- **Vente assistée** : sélection → aperçu du brut / frais / taxe / net → validation → création des annonces, avec délai configurable, arrêt d'urgence et mode simulation.
- **Mise en enchère** : au lieu du prix fixe, mise à prix calculée à *médiane − X %* (réglable par lot, 15 % par défaut), avec achat immédiat facultatif à *+ Y %*.
- **Marché** : scan des 150 annonces les plus basses, classées par économie réelle par rapport à la médiane 7 jours.
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
3. La page se rafraîchit et le nouveau code est actif. La version affichée dans le pied du panneau change.

Le bouton appelle `runtime.reload()` puis recharge l'onglet, ce qui réinjecte le content script. Aucune action dans `about:debugging` n'est nécessaire.

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

## Sécurité et limites

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
