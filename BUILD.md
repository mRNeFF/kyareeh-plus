# Comment ce paquet est construit

Ce document accompagne le code source fourni à AMO pour la version publiée.
Il permet de reproduire **à l'identique** le fichier `.xpi` / `.zip` soumis.

## Résumé

- **Aucune étape de compilation.** Pas de transpileur, pas de bundler, pas de minification,
  pas d'obfuscation.
- Les fichiers JavaScript et CSS du paquet sont **exactement ceux du dépôt**, octet pour octet.
- Le seul outil utilisé est [`web-ext`](https://github.com/mozilla/web-ext), l'outil officiel
  de Mozilla, et uniquement pour **empaqueter** les fichiers dans un zip (et pour `lint`).

## Fichiers inclus dans le paquet

```
manifest.json
background/background.js
content/ui.js
content/ui.css
popup/popup.html
popup/popup.css
popup/popup.js
icons/icon-48.png
icons/icon-96.png
```

Exclus volontairement (voir `.web-ext-config.mjs`) : documentation, scripts de release,
tests, `node_modules`, artefacts de build.

## Reproduire le paquet

```bash
git clone https://github.com/mRNeFF/kyareeh-plus.git
cd kyareeh-plus
git checkout <le tag ou le commit de la version publiée>

npm install          # installe uniquement web-ext (outil d'empaquetage)
npm run build        # équivaut à : web-ext build --source-dir .
```

Le zip produit se trouve dans `web-ext-artifacts/kyareeh-plus-<version>.zip`.

Le `.xpi` signé par AMO est ce même zip, avec la signature ajoutée par Mozilla.

## Vérifier qu'aucun code n'est généré

```bash
# le JS livré est lisible : pas de ligne géante, pas de code machine
awk '{ if (length($0) > m) m = length($0) } END { print "ligne la plus longue :", m }' content/ui.js
```

Résultat attendu : environ 233 caractères (des gabarits HTML en `innerHTML`),
avec une moyenne d'environ 38 caractères par ligne.

## Correspondance exacte archive / paquet

Les 9 fichiers du paquet ont un **contenu identique, octet pour octet**, à ceux de
l'archive source. C'est garanti par `.gitattributes` (`* text=auto eol=lf`) : même sur un
Windows avec `core.autocrlf=true`, `git archive` exporte du LF, comme le zip livré.

Contrôle rapide des tailles (elles doivent être égales deux à deux) :

```
background/background.js   1541
content/ui.css            36460
content/ui.js            181581
icons/icon-48.png          1239
icons/icon-96.png          2000
manifest.json              1197
popup/popup.css            1980
popup/popup.html           1050
popup/popup.js             3552
```

## Notes pour le relecteur

- L'interface est construite en `innerHTML` dans un **Shadow DOM** fermé au style du site.
  Toute valeur issue du réseau passe par une fonction d'échappement (`esc()`) avant insertion.
  C'est ce qui produit les avertissements `UNSAFE_VAR_ASSIGNMENT` du linter : ils sont attendus.
- La seule requête sortante hors `kyara.games` est la lecture du `manifest.json` public du
  dépôt GitHub, pour indiquer à l'utilisateur qu'une nouvelle version existe. Aucune donnée
  n'est transmise.
- Aucun script distant n'est chargé : tout le code est dans le paquet.
