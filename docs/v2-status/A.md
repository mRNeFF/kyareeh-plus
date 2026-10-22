# Chantier A — moteur v2, règles, équilibrage

Fichiers : `content/duel-engine.js`, `content/duel-rules.js`, `docs/REGLES-DUEL.md`,
`scripts/duel-passives.mjs` (en-tête + déclencheur `onSwitchIn` accepté), `test/verify-duel-engine.mjs`,
`test/sim-duel.mjs`. (`content/duel-data.js` inchangé : `passiveFx` toujours à jour.)

## Fait (tout le périmètre A)
- Moteur v2 complet, API §1 exacte (createMatch, phase choose/replace/ended, pendingPlayers, legalActions,
  submit → {state, events, resolved}, viewFor, chooseAction, forfeit, describeEvent, typeOf, TYPES, RULES).
  Pur, UMD, déterministe, JSON, entrées jamais mutées. API v1 (applyAction/currentPlayer) supprimée.
- Revue/corrections par rapport au premier jet : ordre d'action calculé avec la vitesse du champion qui
  SERA actif (après changement) ; priorités Subaru/Ram seulement si le champion est actif.
- Règles ajoutées (E.RULES) pour tenir les objectifs : `guardDecayPct` = 100,
  `fatigueTurn` = 18 / `fatigueDamage` = 3 (épuisement anti-impasse), `speedBand` = 1 / `speedLuck` = 0 (neutres,
  disponibles si besoin). Aucun chiffre de carte modifié.
- Livre de règles v2 complet (`content/duel-rules.js`, 17 sections) + `docs/REGLES-DUEL.md` régénéré.
- `test/verify-duel-engine.mjs` : 457 contrôles, 0 échec (≈ 25 s) : chargement, decks, mise en place, choix
  simultanés, viewFor, légales, ordre/vitesse/égalités/priorités, retargeting, types (25 couples),
  dégâts, chaque champ d'effet (+ couverture des champs des données), statuts/banc/épuisement, K.O./remplacement,
  fins de duel, 203 passifs (déclencheurs réels), IA, déterminisme/JSON/immuabilité, journal, livre, fuzz.
- `test/sim-duel.mjs` v2 (workers, déterministe quel que soit le nombre de workers, par type, hors 30–70 %).
- Simulation initiale (avec dyingStrike, historique) : 12 000 duels, 15,4 tours, camp 0 = 49,4 %, Mythiques 36,3–67,5 %. Remplacée par la révision ci-dessous.

## Reste
- Rien côté A. À l'intégration : relancer `node test/verify-duel-engine.mjs`, `node test/sim-duel.mjs 12000`.

## Ajouts à l'API (au-delà de DUEL-V2 §1)
- Événements de champion : `side, index, name, champType, color` (le champ `type` est déjà le type
  d'événement ; le type de rôle du champion est donc `champType`). Champions de l'état : `type`, `color`.
- Événements : `turn` {turn}, `chosen` {player, phase}, `chakra` {player, delta, chakra}, `guardDecay`,
  `passive` {passive, when}, `turnOrder` {order, reason: speed|tie|subaru|ram|luck|single, speeds, kinds, bonus, by?},
  `switch` {player, from, to, fromName, lead?, forced?}, `phaseReplace` {player}, `move` {player, move, moveName,
  kind, cost, target, retarget, dying}, `effectiveness` {mult, attacker, label}, `fail` {reason: ko|noTarget},
  `damage` {amount, absorbed, hp, source, mult?, hit?}, `heal`, `guard`, `atk`, `buff`, `status`, `expire`, `cleanse`,
  `dispel`, `haste`, `blocked` {by}, `protect` {effect}, `survive`, `ko` {cause, active}, `revive`, `skip`/`skipNext`
  {player, now}, `pass`, `extraTurn`, `fatigue` {turn, amount}, `turnEnd`, `forfeit`, `end` {winner, reason, hpPct, names, turn}.
- `state` : `phase`, `need[]`, `choices[]` (`{type:'hidden'}` pour l'adversaire dans viewFor), `bonus` (action bonus
  « rejoue »), `turn` (= `round`), `rules`, `lastEvents`, `log`.
- `E.effectiveness(att, def, rules)`, `E.actionKey`, `E.targetMode`, `E.STATUS_LABELS`, `E.KIND_LABELS`.

## Révision « un K.O. n'agit plus » (branche duel-fixes)
Plainte de jeu : un champion mis K.O. avant d'agir jouait quand même sa capacité (`dyingStrike` = 1, « dernier souffle »).
- **Supprimé** : la règle `dyingStrike` n'existe plus (ni dans `E.RULES`, ni dans le livre de règles). Un champion K.O. avant
  d'agir voit sa capacité annulée : événement `fail {reason:'ko'}` (« X est KO : Y n'a pas lieu »), aucun chakra dépensé, Hâte non
  consommée, pas d'action bonus (`extraTurn`) ; vaut aussi pour les actions bonus (seconde passe de `resolveChoices`).
  L'événement `move` n'a plus le champ `dying`.
- **Rééquilibrage** (sans dyingStrike la vitesse corrélait à ≈ 0,83 avec le taux de victoire par Mythique, Kurisu/Guts/Killua/Levi
  > 70 %) : nouvelle règle `lateGuard` = 5 — le champion qui agit EN SECOND (vitesse, égalité tirée, tirage ou priorité Subaru)
  gagne 5 garde avant que le premier ne frappe, s'il a choisi une capacité (pas s'il passe ou change). Événement `guard`
  avec `source: 'late'`, ligne de journal dédiée. `speedBand` / `speedLuck` restent neutres (essayés : trop peu efficaces à eux seuls,
  corrélation ≈ 0,7, et ils rendent l'initiative imprévisible pour les joueurs). Une réduction des dégâts du premier coup (essayée,
  70 %) corrèle encore à 0,54 et reste moins lisible : abandonnée.
- `test/sim-duel.mjs` : affiche maintenant la corrélation (Pearson) vitesse / taux de victoire par Mythique et la vitesse dans les classements.
- `test/verify-duel-engine.mjs` : tests du K.O. qui n'agit pas (actif frappé par plus rapide, Hâte, extraTurn, doubles actions bonus,
  changement, 12 duels IA complets) et de `lateGuard` ; les duels de test fixent `lateGuard: 0` par défaut.
- Chiffres (12 000 duels, graines 1 et 2 de 6 000, `node test/sim-duel.mjs 6000 --seed=N`) :
  | | sans compensation (`lateGuard`=0) | final (`lateGuard`=5) |
  |---|---|---|
  | tours moyens | 14,6 | 17,9 |
  | camp 0 | 50,1 % | 49,3 % (48,2 / 50,4) |
  | limite de 40 tours | 0 % | 0 % |
  | nuls (épuisement simultané) | 1,6 % | 4,3 % |
  | changements / actions | 26,7 % | 23,8 % |
  | corrélation vitesse / victoire | 0,87 | 0,34 |
  | victoire moyenne par tranche de vitesse (72-74 / 75-77 / 78-81 / 82+) | 42,6 / 48,1 / 57,5 / 68,3 % | 48,6 / 48,7 / 52,3 / 54,1 % |
  | Mythiques hors 30–70 % | 10 (max 78,4 % Guts) | 0 (de 37,4 % Kazuto à 65,9 % Guts) |
  À surveiller : Gardien ≈ 56 % en moyenne de type (les autres 47–51 %), nuls en hausse.
