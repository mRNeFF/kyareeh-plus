# Chantier B — relais v2 (choix simultanés) — note de reprise

## Fait
- `test/stub-duel-engine.cjs` réécrit à l'API v2 (submit / pendingPlayers / viewFor / phases).
- `relay/server.mjs` : protocole v2 relu en entier et jugé complet (phases choose/replace, `chosen`,
  `pending`, `legal`, délais par phase, auto-pass / premier remplaçant, reprise du choix verrouillé).

## En cours
- `content/duel-net.js` v2.

## Suite
- `test/verify-duel-relay.mjs` v2 (réécriture), `relay/README.md`.
- Vérifier le vrai moteur (A) : submit/pendingPlayers/viewFor présents ; `verify-duel-engine.mjs` encore v1 (applyAction).
  Notes moteur réel : viewFor remplace le choix adverse par `{type:'hidden'}` ; submit émet un événement `chosen`.
- verify-duel-relay.mjs v2 écrit, 171 contrôles OK contre le bouchon; duel-net.js v2 fait. Reste: README, test moteur réel.
- README v2 fait; test OK stub+réel (171). Reste: rapport final.
