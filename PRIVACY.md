# Politique de confidentialité — Kyareeh+

Dernière mise à jour : 17 octobre 2026

Kyareeh+ est une extension Firefox non officielle, sans affiliation avec Kyara.
Elle fonctionne **entièrement dans ton navigateur** : aucun serveur de l'auteur
n'existe, aucune donnée n'est envoyée à l'auteur ni à un tiers.

## Données traitées

- **Session Kyara** : l'extension lit le jeton de connexion déjà présent dans le
  `localStorage` de `kyara.games` et le renvoie **uniquement** à `kyara.games`,
  dans les requêtes que tu déclenches. Ce jeton n'est ni copié, ni stocké, ni
  transmis ailleurs.
- **Données de jeu** : collection, prix du marché, boosters, profil. Elles sont
  lues depuis l'API de Kyara et conservées dans le stockage local de l'extension
  (`browser.storage.local`) pour éviter de tout redemander à chaque ouverture.
- **Préférences** : réglages de l'interface (tri, délais, options d'auto-open).

## Données transmises à des tiers

Aucune, sauf :

- **GitHub** (`raw.githubusercontent.com`) : l'extension lit un fichier
  `manifest.json` public pour savoir si une nouvelle version existe. Aucune
  donnée personnelle n'est envoyée, la requête est anonyme (sans cookies).

## Absence de collecte

L'extension ne collecte pas de données analytiques, ne suit pas la navigation,
n'affiche pas de publicité et ne revend rien.

## Suppression

Désinstaller l'extension supprime ses données locales. Les données de jeu
restent, elles, sur ton compte Kyara.

## Contact

Ouvre une issue sur le dépôt : https://github.com/mRNeFF/kyareeh-plus/issues
