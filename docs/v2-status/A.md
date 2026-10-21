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
- Règles ajoutées (E.RULES) pour tenir les objectifs : `dyingStrike` = 1, `guardDecayPct` = 100,
  `fatigueTurn` = 18 / `fatigueDamage` = 3 (épuisement anti-impasse), `speedBand` = 1 / `speedLuck` = 0 (neutres,
  disponibles si besoin). Aucun chiffre de carte modifié.
- Livre de règles v2 complet (`content/duel-rules.js`, 17 sections) + `docs/REGLES-DUEL.md` régénéré.
- `test/verify-duel-engine.mjs` : 457 contrôles, 0 échec (≈ 25 s) : chargement, decks, mise en place, choix
  simultanés, viewFor, légales, ordre/vitesse/égalités/priorités, retargeting, types (25 couples),
  dégâts, chaque champ d'effet (+ couverture des champs des données), statuts/banc/épuisement, K.O./remplacement,
  fins de duel, 203 passifs (déclencheurs réels), IA, déterminisme/JSON/immuabilité, journal, livre, fuzz.
- `test/sim-duel.mjs` v2 (workers, déterministe quel que soit le nombre de workers, par type, hors 30–70 %).
- Simulation 12 000 duels (graine 1, règles finales) : 15,4 tours, camp 0 = 49,4 %, limite 0,0 %, Mythiques 36,3–67,5 %, 18,9 % d'actions = changements. Tous les objectifs tenus.

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
