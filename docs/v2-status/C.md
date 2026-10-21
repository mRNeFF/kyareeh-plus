# Chantier C — application duel détachable

Fichiers : `duel/duel.html`, `duel/duel-app.js`, `duel/duel.css`, `content/ui.js`, `content/ui.css`,
`background/background.js`, `manifest.json`, `test/harness.html`.

## Avancement

- [x] Lecture du contrat (DUEL-V2 §1–§5), AGENTS.md, ancienne interface duel de ui.js
- [x] `duel/duel.html`, `duel/duel-app.js` (complet, 2447 lignes, relu en reprise), `duel/duel.css` (écrit en reprise)
- [x] Test navigateur de l app seule (entraînement complet 760x900 et 1100x760, changement, remplacement après K.O., 0 erreur console)
- [x] ui.js : iframe persistante (#kp-duel-slot) + Détacher/Rattacher + publishDuelProfile ; ancienne interface retirée (-1000 lignes)
- [x] background.js : kp-duel-detach / kp-duel-attach (fenêtre unique, clé storage)
- [x] manifest.json : WAR duel/* + scripts duel ; content script = ui.js seul
- [x] harness : mocks sendMessage / onChanged / fenêtre
- [ ] Tests navigateur panneau + fenêtre

## Choix

- Profil : `storage.local['kyareeh.duel.profile'] = { name, owned, at }` (ids de toute la collection).
- Fenêtre détachée : clé `storage.local['kyareeh.duel.window'] = { id, at }` tenue par le fond.
- Partie d'entraînement persistée (`kyareeh.duel.session`) pour survivre à Détacher/Rattacher.
- Hors extension : stockage = `localStorage['kp-harness-store']` (même objet que le harness).
- Messages fond : `kp-duel-detach` (ouvre/focus), `kp-duel-attach` (ferme la fenêtre).

## État (reprise terminée)

- App : événements moteur v2 (`turn`, `blocked`, `protect`, `survive`, `haste`, `effectiveness` + `mult` sur `damage`),
  limite `maxTurns`, efficacité via `E.effectiveness`, reprise en ligne (`choice`, `chosen`).
- Panneau : `#kp-duel-slot` hors de `.kp-view` ; l'iframe survit au passage par +Tools. Bouton « Détacher » dans la
  rangée des modes ; `kyareeh.duel.window` tenu par le fond ; carte « Duel ouvert dans une fenêtre » + « Rattacher ».
- Vérifié (Playwright + Chromium) : entraînement complet, duel en ligne via relais local, harness panneau + fenêtre
  détachée + rattachement, onglets +Tools sans erreur, verify-analysis / verify-statglobal OK.
- Non vérifiable ici : chargement réel de l'iframe moz-extension dans kyara.games (CSP du site) → repli après 6 s.
