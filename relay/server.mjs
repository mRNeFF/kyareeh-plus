// Relais WebSocket autoritatif du duel Kyara (mode +Duel de Kyareeh+), protocole v2.
// Voir docs/DUEL-SPEC.md §4 (protocole v1) et docs/DUEL-V2.md §2 (choix simultanés).
// Le serveur exécute le moteur (content/duel-engine.js) : les clients n'envoient que des
// intentions. À chaque tour, chaque joueur attendu (E.pendingPlayers) range un choix secret
// (E.submit) ; l'adversaire n'apprend que « il a choisi » (message `chosen`). Quand tous les
// choix sont là, le moteur résout le tour et l'état est diffusé aux deux joueurs (toujours
// via E.viewFor, jamais l'état brut) avec un numéro de séquence (seq) croissant.
//
// Lancement depuis la racine du dépôt : `node relay/server.mjs` (voir relay/README.md).
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocketServer } from 'ws';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
export const PROTOCOL = 2;
// 5 lettres majuscules, sans I ni O (confusion avec 1 et 0).
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
export const ENGINE_API = ['validateDeck', 'createMatch', 'pendingPlayers', 'legalActions', 'submit', 'viewFor', 'chooseAction', 'describeEvent'];

export const DEFAULTS = {
  port: 8080,
  host: undefined, // interface d'écoute (défaut : toutes)
  chooseMs: 45_000, // délai de la phase de choix avant `pass` automatique
  replaceMs: 20_000, // délai de la phase de remplacement avant premier remplaçant vivant automatique
  graceMs: 60_000, // délai de reconnexion avant défaite par abandon
  idleMs: 10 * 60_000, // salon fermé après 10 min sans message de ses joueurs
  sweepMs: 30_000, // fréquence du ménage des salons inactifs
  heartbeatMs: 30_000, // ping WebSocket pour détecter les connexions mortes
  maxMessage: 8 * 1024, // taille maximale d'un message client (octets)
  rateBurst: 20, // débit par client : rafale maximale…
  ratePerSec: 10, // …puis messages par seconde
  maxTimeouts: 3, // tours expirés d'affilée avant défaite « timeout »
  maxRooms: 2000,
  origins: [], // liste blanche d'origines (vide = toutes)
  enginePath: path.join(ROOT, 'content', 'duel-engine.js'),
  dataPath: path.join(ROOT, 'content', 'duel-data.js'),
  rules: undefined, // surcharge partielle de E.RULES passée à createMatch (tests)
  log: true
};

/** Lit la configuration depuis les variables d'environnement (DUEL_*, PORT). */
export function configFromEnv(env = process.env) {
  const num = (key, def) => (env[key] !== undefined && env[key] !== '' && Number.isFinite(Number(env[key])) ? Number(env[key]) : def);
  const file = (key, def) => (env[key] ? path.resolve(env[key]) : def);
  return {
    ...DEFAULTS,
    port: num('PORT', DEFAULTS.port),
    host: env.HOST || undefined,
    // DUEL_TURN_MS (v1) reste accepté comme ancien nom du délai de choix.
    chooseMs: num('DUEL_CHOOSE_MS', num('DUEL_TURN_MS', DEFAULTS.chooseMs)),
    replaceMs: num('DUEL_REPLACE_MS', DEFAULTS.replaceMs),
    graceMs: num('DUEL_GRACE_MS', DEFAULTS.graceMs),
    idleMs: num('DUEL_IDLE_MS', DEFAULTS.idleMs),
    sweepMs: num('DUEL_SWEEP_MS', DEFAULTS.sweepMs),
    heartbeatMs: num('DUEL_HEARTBEAT_MS', DEFAULTS.heartbeatMs),
    maxMessage: num('DUEL_MAX_MESSAGE', DEFAULTS.maxMessage),
    rateBurst: num('DUEL_RATE_BURST', DEFAULTS.rateBurst),
    ratePerSec: num('DUEL_RATE_PER_SEC', DEFAULTS.ratePerSec),
    maxTimeouts: num('DUEL_MAX_TIMEOUTS', DEFAULTS.maxTimeouts),
    maxRooms: num('DUEL_MAX_ROOMS', DEFAULTS.maxRooms),
    origins: (env.DUEL_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean),
    enginePath: file('DUEL_ENGINE', DEFAULTS.enginePath),
    dataPath: file('DUEL_DATA', DEFAULTS.dataPath),
    log: env.DUEL_LOG !== '0'
  };
}

// ---------------------------------------------------------------------------
// Chargement des données et du moteur depuis le disque
// ---------------------------------------------------------------------------

/** Lit content/duel-data.js : JSON après `window.KYARA_DUEL_DATA = ` (repli : exécution isolée). */
export function loadData(file = DEFAULTS.dataPath) {
  const src = fs.readFileSync(file, 'utf8');
  const marker = 'window.KYARA_DUEL_DATA = ';
  const at = src.indexOf(marker);
  if (at >= 0) {
    const body = src.slice(at + marker.length).trim().replace(/;\s*$/, '');
    try {
      return JSON.parse(body);
    } catch {
      // Le fichier contient autre chose qu'un JSON pur : on l'exécute dans un bac à sable.
    }
  }
  const sandbox = { window: {} };
  vm.runInNewContext(src, sandbox, { filename: file, timeout: 5000 });
  if (!sandbox.window.KYARA_DUEL_DATA) throw new Error(`Données du duel introuvables dans ${file}.`);
  return sandbox.window.KYARA_DUEL_DATA;
}

/** Charge le moteur (UMD : module.exports, ou window.KYARA_DUEL_ENGINE dans un bac à sable). */
export function loadEngine(file = DEFAULTS.enginePath) {
  file = path.resolve(file);
  if (!fs.existsSync(file)) throw new Error(`Moteur du duel introuvable : ${file}.`);
  let engine = null;
  let requireError = null;
  try {
    const mod = createRequire(import.meta.url)(file);
    engine = mod && typeof mod.createMatch === 'function' ? mod : mod && mod.default;
  } catch (err) {
    requireError = err;
    engine = null;
  }
  if (!engine || typeof engine.createMatch !== 'function') {
    const sandbox = { window: {}, console };
    sandbox.globalThis = sandbox;
    try {
      vm.runInNewContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: file, timeout: 5000 });
    } catch (err) {
      throw new Error(`Moteur du duel illisible (${file}) : ${(requireError || err).message}`);
    }
    engine = sandbox.window.KYARA_DUEL_ENGINE || sandbox.KYARA_DUEL_ENGINE;
  }
  const missing = engineMissing(engine);
  if (missing.length) throw new Error(`Moteur incomplet ou antérieur à la v2 (${file}) : il manque ${missing.join(', ')}.`);
  return engine;
}

/** Fonctions de l'API v2 absentes d'un moteur (liste vide = moteur utilisable). */
export function engineMissing(engine) {
  return ENGINE_API.filter((name) => !engine || typeof engine[name] !== 'function');
}

// ---------------------------------------------------------------------------
// Petits utilitaires
// ---------------------------------------------------------------------------

function newCode(exists) {
  for (;;) {
    let code = '';
    for (let i = 0; i < 5; i += 1) code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
    if (!exists(code)) return code;
  }
}

function normCode(code) {
  return typeof code === 'string' ? code.trim().toUpperCase() : '';
}

function cleanName(name) {
  const s = typeof name === 'string' ? name.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 24) : '';
  return s || 'Joueur';
}

function cleanDeck(deck) {
  if (!Array.isArray(deck)) return null;
  return deck.slice(0, 10).map((id) => (typeof id === 'string' && /^\d+$/.test(id) ? Number(id) : id));
}

/** Identifiant Kyara du joueur (le relais ne connaît pas sa session). */
function cleanUserId(value) {
  if (value == null) return null;
  const s = String(value).trim().slice(0, 64);
  return s || null;
}

/** Contrepartie d'un joueur : montant + carte. Aucun transfert ici. */
function cleanStake(raw, expectedAmount = null) {
  if (!raw || typeof raw !== 'object') return null;
  const amount = Number(raw.amount ?? expectedAmount);
  if (!Number.isInteger(amount) || amount < 1 || amount > 1e9) return null;
  if (expectedAmount != null && amount !== Number(expectedAmount)) return null;
  const cardId = typeof raw.cardId === 'string' || Number.isFinite(Number(raw.cardId))
    ? String(raw.cardId).trim().slice(0, 64)
    : '';
  if (!cardId) return null;
  const cardName = typeof raw.cardName === 'string'
    ? raw.cardName.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 80)
    : '';
  const cardRarity = typeof raw.cardRarity === 'string' ? raw.cardRarity.trim().slice(0, 4) : '';
  return { amount, cardId, cardName, cardRarity };
}

/**
 * Mise d'un salon : une **déclaration** du créateur, jamais un transfert.
 * Le relais ne manipule ni chakra ni carte : il relaie des conditions que
 * l'adversaire doit accepter. Aucun appel au site n'est fait ici, et aucune
 * règle de don n'est codée en dur (le plafond ci-dessous est une simple garde
 * de protocole contre les valeurs absurdes).
 */
function cleanBet(raw) {
  if (!raw || typeof raw !== 'object' || !raw.enabled) return null;
  const amount = Number(raw.amount);
  if (!Number.isInteger(amount) || amount < 1 || amount > 1e9) return null;
  const cardId = typeof raw.cardId === 'string' || Number.isFinite(Number(raw.cardId))
    ? String(raw.cardId).trim().slice(0, 64)
    : '';
  if (!cardId) return null;
  const cardName = typeof raw.cardName === 'string'
    ? raw.cardName.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 80)
    : '';
  const cardRarity = typeof raw.cardRarity === 'string' ? raw.cardRarity.trim().slice(0, 4) : '';
  const creator = cleanStake(raw.creator ?? { amount, cardId, cardName, cardRarity }, amount);
  if (!creator) return null;
  return {
    enabled: true,
    mode: raw.mode === 'real' ? 'real' : 'test',
    amount,
    cardId,
    cardName,
    cardRarity,
    stakes: { creator, joiner: null },
    createdAt: Date.now()
  };
}

/** Forme canonique d'une action : seuls les champs du protocole comptent. */
function canonical(a) {
  if (!a || typeof a !== 'object' || typeof a.type !== 'string') return '';
  if (a.type === 'move') {
    const t = a.target && typeof a.target === 'object' ? { side: a.target.side, index: a.target.index } : null;
    return JSON.stringify({ type: 'move', actor: a.actor, move: a.move, target: t });
  }
  if (a.type === 'switch') return JSON.stringify({ type: 'switch', to: a.to });
  return JSON.stringify({ type: a.type });
}

// ---------------------------------------------------------------------------
// Relais
// ---------------------------------------------------------------------------

export function createRelay(options = {}) {
  const cfg = { ...DEFAULTS, ...options };
  const E = options.engine || loadEngine(cfg.enginePath);
  const data = options.data || loadData(cfg.dataPath);
  const log = (...args) => cfg.log && console.log(new Date().toISOString(), ...args);

  /** token → session (un joueur, qui survit aux coupures de connexion). */
  const sessions = new Map();
  /** code → salon */
  const rooms = new Map();

  // --- envoi ---------------------------------------------------------------

  function send(ws, msg) {
    if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  }
  function fail(ws, code, message, extra) {
    send(ws, { t: 'error', code, message, ...extra });
  }
  function sendRoom(room, i) {
    const s = room.seats[i];
    if (!s) return;
    send(s.ws, {
      t: 'room',
      code: room.code,
      status: room.status,
      you: i,
      players: room.seats.map((p, seat) => (p ? {
        seat,
        name: p.name,
        userId: p.userId ?? null,
        online: Boolean(p.ws),
        ready: Boolean(room.ready && room.ready[seat]) || (room.status === 'ended' && Boolean(room.rematch[seat]))
      } : null)).filter(Boolean),
      // Mise déclarative (mode test) et acceptations : le relais ne transfère rien.
      bet: room.bet || null,
      betAck: Array.isArray(room.betAck) ? room.betAck.slice() : [false, false]
    });
  }
  function broadcastRoom(room) {
    room.seats.forEach((_, i) => sendRoom(room, i));
  }
  /** Joueurs qui doivent encore choisir (vide hors duel). */
  function pendingOf(room) {
    if (room.status !== 'playing' || !room.match) return [];
    try {
      const p = E.pendingPlayers(room.match);
      return Array.isArray(p) ? p.filter((x) => x === 0 || x === 1) : [];
    } catch {
      return [];
    }
  }
  function phaseOf(room) {
    if (!room.match) return null;
    if (room.status === 'ended') return 'ended';
    return typeof room.match.phase === 'string' ? room.match.phase : 'choose';
  }
  /** Joueurs attendus dans la phase courante qui ont déjà verrouillé leur choix. */
  function chosenOf(room, pending = pendingOf(room)) {
    return room.status === 'playing' ? room.expected.filter((p) => !pending.includes(p)) : [];
  }
  function legalFor(room, i, pending) {
    if (!pending.includes(i)) return [];
    try {
      const legal = E.legalActions(room.match, i);
      return Array.isArray(legal) ? legal : [];
    } catch {
      return [];
    }
  }
  function sendState(room, i, events, last) {
    const s = room.seats[i];
    if (!s || !room.match) return;
    // Toujours la vue du destinataire : le choix secret adverse n'en sort jamais.
    let view;
    try {
      view = E.viewFor(room.match, i);
    } catch (err) {
      log('viewFor a échoué', err);
      fail(s.ws, 'engine_error', 'Le moteur n’a pas pu produire l’état du duel.');
      return;
    }
    const pending = pendingOf(room);
    const playing = room.status === 'playing';
    send(s.ws, {
      t: 'state',
      seq: room.seq,
      you: i,
      phase: phaseOf(room),
      pending,
      chosen: chosenOf(room, pending),
      choice: playing ? room.choices[i] : null,
      state: view,
      events: events || [],
      deadline: playing ? Math.max(0, room.deadlineAt - Date.now()) : null,
      timer: playing ? room.phaseMs : null,
      legal: playing ? legalFor(room, i, pending) : [],
      last: last || null
    });
  }
  function broadcastState(room, events, last) {
    room.seats.forEach((_, i) => sendState(room, i, events, last));
  }
  /** Annonce qu'un joueur a verrouillé son choix ; seul l'auteur reçoit l'action (la sienne). */
  function broadcastChosen(room, player) {
    const pending = pendingOf(room);
    const chosen = chosenOf(room, pending);
    room.seats.forEach((s, i) => {
      if (!s) return;
      const msg = { t: 'chosen', seq: room.seq, player, pending, chosen, auto: room.auto[player] };
      if (i === player) msg.action = room.choices[player];
      send(s.ws, msg);
    });
  }
  function sendEnd(room, i) {
    const s = room.seats[i];
    if (s && room.result) send(s.ws, { t: 'end', winner: room.result.winner, reason: room.result.reason, you: i });
  }
  function notifyPeer(room, seat, status) {
    const other = room.seats[1 - seat];
    if (other) send(other.ws, { t: 'peer', status });
  }

  // --- cycle de vie d'un duel ---------------------------------------------

  function clearTurn(room) {
    clearTimeout(room.turnTimer);
    room.turnTimer = null;
  }

  /** Ouvre une phase (choix ou remplacement) : joueurs attendus, choix vidés, minuteur propre à la phase. */
  function startPhase(room) {
    clearTurn(room);
    room.choices = [null, null];
    room.auto = [false, false];
    room.held = [];
    if (room.status !== 'playing') return;
    room.expected = pendingOf(room);
    room.phaseMs = phaseOf(room) === 'replace' ? cfg.replaceMs : cfg.chooseMs;
    room.deadlineAt = Date.now() + room.phaseMs;
    const seq = room.seq;
    room.turnTimer = setTimeout(() => onTurnTimeout(room, seq), room.phaseMs);
    if (!room.expected.length) log(`salon ${room.code} : aucun joueur attendu en phase ${phaseOf(room)} (moteur ?)`);
  }

  function startMatch(room) {
    const players = room.seats.map((s) => ({ id: s.id, name: s.name, deck: s.deck }));
    let match;
    try {
      match = E.createMatch({ data, seed: crypto.randomInt(0, 2 ** 32), players, ...(cfg.rules ? { rules: cfg.rules } : {}) });
    } catch (err) {
      room.seats.forEach((s) => s && fail(s.ws, 'engine_error', `Impossible de lancer le duel : ${err.message}`));
      return;
    }
    room.match = match;
    room.seq = 1;
    room.status = 'playing';
    room.ready = [false, false];
    room.result = null;
    room.timeouts = [0, 0];
    room.rematch = [false, false];
    log(`duel lancé ${room.code} : ${players[0].name} contre ${players[1].name}`);
    broadcastRoom(room);
    startPhase(room);
    broadcastState(room, [], null);
  }

  /**
   * Démarre le duel uniquement quand les deux sièges sont prêts et, si une mise
   * est proposée, quand les deux l'ont acceptée. Sinon, diffuse simplement le
   * salon pour synchroniser les états.
   */
  function tryStart(room) {
    if (room.status !== 'waiting' || !room.seats.every(Boolean)) return false;
    if (!room.ready[0] || !room.ready[1]) return false;
    if (room.bet && !(room.betAck[0] && room.betAck[1])) return false;
    // Une mise réelle exige les deux contreparties (montant + personnage).
    if (room.bet && room.bet.mode === 'real' && (!room.bet.stakes?.creator || !room.bet.stakes?.joiner)) return false;
    startMatch(room);
    return true;
  }

  function isOver(state) {
    return !state || state.phase === 'ended' || (state.winner !== null && state.winner !== undefined);
  }

  function inferReason(state, winner) {
    if (state && (state.endReason === 'ko' || state.endReason === 'rounds')) return state.endReason;
    if (winner === 'draw') return 'rounds';
    const loser = state && state.players && state.players[1 - winner];
    return loser && loser.champions.every((c) => !c.alive) ? 'ko' : 'rounds';
  }

  function finish(room, winner, reason) {
    clearTurn(room);
    room.status = 'ended';
    room.result = { winner, reason };
    room.rematch = [false, false];
    log(`duel terminé ${room.code} : vainqueur ${winner}, raison ${reason}`);
    room.seats.forEach((_, i) => sendEnd(room, i));
    broadcastRoom(room);
  }

  /** Défaite immédiate du siège `loser` (abandon, déconnexion prolongée, délais répétés). */
  function forfeit(room, loser, reason = 'forfeit') {
    if (room.status !== 'playing') return;
    let events = [];
    if (typeof E.forfeit === 'function') {
      // Le moteur sait clore un duel par abandon (événements « forfeit » + « end » pour le journal).
      try {
        const res = E.forfeit(room.match, loser, reason);
        room.match = res.state;
        events = res.events || [];
      } catch {
        room.match = { ...room.match, winner: 1 - loser, endReason: reason, phase: 'ended' };
      }
    } else {
      room.match = { ...room.match, winner: 1 - loser, endReason: reason, phase: 'ended' };
    }
    room.seq += 1;
    clearTurn(room);
    room.status = 'ended';
    room.choices = [null, null];
    room.held = [];
    broadcastState(room, events, { player: loser, actions: [null, null], auto: [false, false], forfeit: reason });
    finish(room, 1 - loser, reason);
  }

  /**
   * Range le choix (déjà reconnu légal) du siège `seat`. Si c'était le dernier choix attendu, le
   * moteur résout le tour : les événements partent aux deux joueurs dans un seul message `state`.
   * Sinon, seul un `chosen` est diffusé. Renvoie true, ou l'erreur du moteur s'il refuse.
   */
  function submitChoice(room, seat, action, auto) {
    const phase = phaseOf(room);
    let res;
    try {
      res = E.submit(room.match, seat, action);
    } catch (err) {
      return err;
    }
    if (!res || !res.state) return new Error('réponse du moteur invalide');
    room.match = res.state;
    room.choices[seat] = action;
    room.auto[seat] = Boolean(auto);
    if (!auto) room.timeouts[seat] = 0;
    const events = Array.isArray(res.events) ? res.events : [];
    const resolved = typeof res.resolved === 'boolean' ? res.resolved : isOver(res.state) || pendingOf(room).length === 0;
    if (!resolved) {
      // Par prudence, d'éventuels événements d'un choix non résolu attendent la résolution (ils pourraient le trahir).
      room.held.push(...events);
      broadcastChosen(room, seat);
      return true;
    }
    const all = [...room.held, ...events];
    const last = { phase, actions: room.choices.slice(), auto: room.auto.slice() };
    room.seq += 1;
    if (isOver(res.state)) {
      clearTurn(room);
      room.status = 'ended';
      broadcastState(room, all, last);
      const winner = res.state.winner;
      finish(room, winner === null || winner === undefined ? 'draw' : winner, inferReason(res.state, winner));
    } else {
      startPhase(room);
      broadcastState(room, all, last);
    }
    return true;
  }

  /** Choix joué par le serveur à l'expiration : `pass`, ou premier remplaçant vivant (plus petit index). */
  function autoAction(room, p) {
    const legal = legalFor(room, p, [p]);
    if (phaseOf(room) === 'replace') {
      const sw = legal.filter((a) => a.type === 'switch').sort((a, b) => a.to - b.to)[0];
      if (sw) return sw;
    }
    return legal.find((a) => a.type === 'pass') || legal.find((a) => a.type === 'switch') || null;
  }

  function onTurnTimeout(room, seq) {
    if (room.status !== 'playing' || room.seq !== seq) return;
    room.turnTimer = null;
    const late = pendingOf(room);
    for (const p of late) {
      room.timeouts[p] += 1;
      if (room.timeouts[p] >= cfg.maxTimeouts) {
        forfeit(room, p, 'timeout');
        return;
      }
    }
    for (const p of late) {
      if (room.status !== 'playing' || room.seq !== seq) return;
      const choice = autoAction(room, p);
      if (choice && submitChoice(room, p, choice, true) === true) continue;
      // Le moteur refuse le choix par défaut (cas imprévu) : on laisse l'IA choisir à sa place.
      try {
        if (submitChoice(room, p, E.chooseAction(room.match, p), true) === true) continue;
      } catch {
        // ignoré : défaite ci-dessous
      }
      forfeit(room, p, 'timeout');
      return;
    }
  }

  // --- salons ----------------------------------------------------------------

  function deleteRoom(room) {
    clearTurn(room);
    rooms.delete(room.code);
    room.seats.forEach((s) => {
      if (s) {
        s.room = null;
        s.seat = null;
      }
    });
  }

  /** Retire un joueur de son salon (après un éventuel abandon). */
  function removeFromRoom(s) {
    const room = s.room;
    if (!room) return;
    const seat = s.seat;
    const wasPlaying = room.status === 'playing';
    room.seats[seat] = null;
    s.room = null;
    s.seat = null;
    if (wasPlaying) {
      // Le partant reçoit sa défaite, mais plus les nouvelles du salon qu'il quitte.
      forfeit(room, seat);
      send(s.ws, { t: 'end', winner: 1 - seat, reason: 'forfeit', you: seat });
    }
    if (!room.seats.some(Boolean)) {
      deleteRoom(room);
      return;
    }
    // Le joueur restant retrouve un salon en attente, sous le même code.
    const rest = room.seats.find(Boolean);
    room.seats = [rest, null];
    rest.seat = 0;
    room.status = 'waiting';
    // Le joueur restant repart de zéro : pas prêt, et aucune mise héritée du créateur parti.
    room.ready = [false, false];
    room.bet = null;
    room.betAck = [false, false];
    room.match = null;
    room.result = null;
    room.seq = 0;
    room.rematch = [false, false];
    room.expected = [];
    room.choices = [null, null];
    room.auto = [false, false];
    room.held = [];
    send(rest.ws, { t: 'peer', status: 'left' });
    broadcastRoom(room);
  }

  function checkDeck(ws, s) {
    if (!s.deck) {
      fail(ws, 'deck_invalid', 'Aucun deck fourni : choisissez 5 Mythiques.');
      return false;
    }
    let res;
    try {
      res = E.validateDeck(data, s.deck);
    } catch (err) {
      res = { ok: false, error: err.message };
    }
    if (!res || !res.ok) {
      fail(ws, 'deck_invalid', (res && res.error) || 'Deck invalide.');
      return false;
    }
    return true;
  }

  /** Avant de créer/rejoindre : on quitte un salon terminé ou en attente ; refus en plein duel. */
  function freeFromRoom(ws, s) {
    if (!s.room) return true;
    if (s.room.status === 'playing') {
      fail(ws, 'already_in_room', 'Vous êtes déjà en duel : abandonnez ou terminez-le d’abord.');
      return false;
    }
    removeFromRoom(s);
    return true;
  }

  function applyProfile(s, msg) {
    if (msg.name !== undefined) s.name = cleanName(msg.name);
    if (msg.userId !== undefined) s.userId = cleanUserId(msg.userId);
    if (msg.deck !== undefined) s.deck = cleanDeck(msg.deck);
  }

  // --- messages ------------------------------------------------------------

  const handlers = {
    hello(ws, msg) {
      if (msg.v !== PROTOCOL) {
        fail(ws, 'version', `Version du protocole non prise en charge (reçue : ${String(msg.v).slice(0, 8)}, attendue : ${PROTOCOL}). Mettez à jour l’extension.`, { expected: PROTOCOL });
        return;
      }
      let s = ws.session;
      if (!s) {
        s = { id: `c_${crypto.randomBytes(6).toString('hex')}`, token: crypto.randomBytes(24).toString('hex'), name: 'Joueur', userId: null, deck: null, ws, room: null, seat: null, graceTimer: null };
        sessions.set(s.token, s);
        ws.session = s;
      }
      // En plein duel, le deck engagé ne change plus.
      if (s.room && s.room.status === 'playing') applyProfile(s, { name: msg.name });
      else {
        // Dans un salon (en attente ou terminé), un nouveau deck doit rester valide : sinon on garde l'ancien.
        const prev = s.deck;
        applyProfile(s, msg);
        if (s.room && msg.deck !== undefined && !checkDeck(ws, s)) s.deck = prev;
      }
      send(ws, { t: 'welcome', clientId: s.id, token: s.token, v: PROTOCOL });
    },

    create(ws, msg, s) {
      if (!freeFromRoom(ws, s)) return;
      applyProfile(s, msg);
      if (!checkDeck(ws, s)) return;
      if (rooms.size >= cfg.maxRooms) {
        fail(ws, 'server_full', 'Le relais est saturé : réessayez dans quelques minutes.');
        return;
      }
      let bet = null;
      if (msg.bet != null) {
        bet = cleanBet(msg.bet);
        if (!bet) {
          fail(ws, 'bet_invalid', 'Mise invalide : montant entier ≥ 1 et contrepartie obligatoires.');
          return;
        }
      }
      const room = {
        code: newCode((c) => rooms.has(c)),
        seats: [s, null],
        status: 'waiting',
        // État prêt / pas prêt de chaque siège : le duel ne démarre que si les deux sont prêts.
        ready: [false, false],
        // Mise déclarative du créateur (aucun transfert) + acceptation par siège.
        bet,
        betAck: [Boolean(bet), false],
        match: null,
        seq: 0,
        result: null,
        deadlineAt: 0,
        phaseMs: 0,
        turnTimer: null,
        expected: [], // joueurs attendus dans la phase courante
        choices: [null, null], // choix verrouillés de la phase courante (chacun ne voit que le sien)
        auto: [false, false], // choix joués par le serveur (délai expiré)
        held: [], // événements retenus jusqu'à la résolution du tour
        timeouts: [0, 0],
        rematch: [false, false],
        lastActivity: Date.now()
      };
      rooms.set(room.code, room);
      s.room = room;
      s.seat = 0;
      log(`salon créé ${room.code} par ${s.name}`);
      broadcastRoom(room);
    },

    join(ws, msg, s) {
      const code = normCode(msg.code);
      const room = rooms.get(code);
      if (!room) {
        fail(ws, 'unknown_room', code ? `Salon introuvable : ${code}.` : 'Code de salon manquant.');
        return;
      }
      if (s.room === room) {
        sendRoom(room, s.seat);
        if (room.match) sendState(room, s.seat, [], null);
        return;
      }
      if (room.seats.every(Boolean)) {
        fail(ws, 'room_full', `Le salon ${code} est complet.`);
        return;
      }
      if (room.status !== 'waiting') {
        fail(ws, 'room_full', `Le salon ${code} n’accepte plus de joueurs.`);
        return;
      }
      if (!freeFromRoom(ws, s)) return;
      applyProfile(s, msg);
      if (!checkDeck(ws, s)) return;
      const seat = room.seats[0] ? 1 : 0;
      room.seats[seat] = s;
      room.ready[seat] = false;
      room.betAck[seat] = false;
      s.room = room;
      s.seat = seat;
      room.lastActivity = Date.now();
      log(`${s.name} rejoint ${room.code}`);
      // Le duel ne démarre plus à l'arrivée : chaque joueur doit se déclarer prêt.
      if (!tryStart(room)) broadcastRoom(room);
    },

    ready(ws, msg, s) {
      const room = s.room;
      if (!room) {
        fail(ws, 'not_in_room', 'Vous n’êtes dans aucun salon.');
        return;
      }
      if (room.status !== 'waiting') {
        fail(ws, 'not_waiting', 'Le salon n’est plus en attente : impossible de changer l’état prêt.');
        return;
      }
      const ready = Boolean(msg.ready);
      if (ready && room.bet && !room.betAck[s.seat]) {
        fail(ws, 'bet_not_accepted', 'Acceptez d’abord les conditions de la mise.');
        return;
      }
      room.ready[s.seat] = ready;
      log(`${s.name} ${ready ? 'prêt' : 'pas prêt'} dans ${room.code}`);
      if (!tryStart(room)) broadcastRoom(room);
    },

    'bet-accept'(ws, msg, s) {
      const room = s.room;
      if (!room) {
        fail(ws, 'not_in_room', 'Vous n’êtes dans aucun salon.');
        return;
      }
      if (room.status !== 'waiting') {
        fail(ws, 'not_waiting', 'La mise ne peut plus être acceptée.');
        return;
      }
      if (!room.bet) {
        fail(ws, 'no_bet', 'Aucune mise n’est proposée dans ce salon.');
        return;
      }
      const stake = cleanStake(msg.stake, room.bet.amount);
      if (!stake) {
        fail(
          ws,
          'bet_invalid_stake',
          'Contrepartie invalide : chaque joueur doit fournir un montant identique et un personnage.'
        );
        return;
      }
      room.bet.stakes = {
        ...(room.bet.stakes || {}),
        creator: room.bet.stakes?.creator ?? null,
        joiner: stake
      };
      room.betAck[s.seat] = true;
      log(`${s.name} accepte la mise de ${room.code}`);
      if (!tryStart(room)) broadcastRoom(room);
    },

    action(ws, msg, s) {
      const room = s.room;
      if (!room) {
        fail(ws, 'not_in_room', 'Vous n’êtes dans aucun salon.');
        return;
      }
      if (room.status !== 'playing') {
        fail(ws, 'not_playing', 'Aucun duel en cours dans ce salon.');
        return;
      }
      if (msg.seq !== room.seq) {
        fail(ws, 'stale_seq', 'État périmé : action ignorée. Voici l’état à jour.', { seq: room.seq });
        sendState(room, s.seat, [], null);
        return;
      }
      const pending = pendingOf(room);
      if (!pending.includes(s.seat)) {
        if (room.expected.includes(s.seat)) fail(ws, 'already_chosen', 'Votre choix est déjà verrouillé pour ce tour.');
        else if (phaseOf(room) === 'replace') fail(ws, 'not_your_turn', 'L’adversaire choisit son remplaçant : rien à choisir pour vous.');
        else fail(ws, 'not_your_turn', 'Rien à choisir pour vous dans cette phase.');
        return;
      }
      const wanted = canonical(msg.action);
      const action = wanted && legalFor(room, s.seat, pending).find((a) => canonical(a) === wanted);
      if (!action) {
        fail(ws, 'illegal_action', phaseOf(room) === 'replace'
          ? 'Action illégale : choisissez un remplaçant vivant sur le banc.'
          : 'Action illégale : elle ne figure pas parmi les actions autorisées.');
        return;
      }
      const res = submitChoice(room, s.seat, action, false);
      if (res !== true) fail(ws, 'illegal_action', `Action refusée par le moteur : ${res.message}`);
    },

    rematch(ws, msg, s) {
      const room = s.room;
      if (!room || room.status !== 'ended' || !room.seats.every(Boolean)) {
        fail(ws, 'not_playing', 'Revanche impossible : il faut un duel terminé et deux joueurs.');
        return;
      }
      // Le deck a pu changer (hello entre deux duels) : on le revérifie avant d'accepter.
      applyProfile(s, msg);
      if (!checkDeck(ws, s)) return;
      room.rematch[s.seat] = true;
      if (room.rematch.every(Boolean)) startMatch(room);
      else broadcastRoom(room);
    },

    rejoin(ws, msg) {
      const s = sessions.get(typeof msg.token === 'string' ? msg.token : '');
      const code = normCode(msg.code);
      if (!s || !s.room || (code && s.room.code !== code)) {
        fail(ws, 'rejoin_failed', 'Reconnexion impossible : la session a expiré ou le salon est fermé.');
        return;
      }
      if (ws.session && ws.session !== s) {
        if (ws.session.room) {
          fail(ws, 'already_in_room', 'Cette connexion est déjà dans un autre salon.');
          return;
        }
        sessions.delete(ws.session.token);
      }
      if (s.ws && s.ws !== ws) {
        const old = s.ws;
        old.session = null;
        old.close(4000, 'Session reprise ailleurs');
      }
      clearTimeout(s.graceTimer);
      s.graceTimer = null;
      s.ws = ws;
      ws.session = s;
      const room = s.room;
      room.lastActivity = Date.now();
      log(`${s.name} revient dans ${room.code}`);
      send(ws, { t: 'welcome', clientId: s.id, token: s.token, v: PROTOCOL, rejoined: true });
      broadcastRoom(room);
      if (room.match) sendState(room, s.seat, [], null);
      if (room.status === 'ended') sendEnd(room, s.seat);
      notifyPeer(room, s.seat, 'back');
    },

    leave(ws, msg, s) {
      if (s.room) {
        log(`${s.name} quitte ${s.room.code}`);
        removeFromRoom(s);
      }
    },

    ping(ws) {
      send(ws, { t: 'pong' });
    }
  };

  const NEEDS_SESSION = new Set(['create', 'join', 'ready', 'bet-accept', 'action', 'rematch', 'leave']);

  function onMessage(ws, raw, isBinary) {
    // Débit : seau à jetons par connexion.
    const now = Date.now();
    const b = ws.bucket;
    b.tokens = Math.min(cfg.rateBurst, b.tokens + ((now - b.last) / 1000) * cfg.ratePerSec);
    b.last = now;
    if (b.tokens < 1) {
      b.strikes += 1;
      if (now - b.warnedAt > 1000) {
        b.warnedAt = now;
        fail(ws, 'rate_limited', 'Trop de messages : ralentissez.');
      }
      if (b.strikes > cfg.rateBurst * 10) ws.close(1008, 'Débit excessif');
      return;
    }
    b.tokens -= 1;
    b.strikes = 0;

    if (isBinary) {
      fail(ws, 'bad_message', 'Message binaire refusé : JSON attendu.');
      return;
    }
    if (raw.length > cfg.maxMessage) {
      fail(ws, 'too_large', `Message trop volumineux (maximum ${cfg.maxMessage} octets).`);
      return;
    }
    let msg;
    try {
      msg = JSON.parse(raw.toString('utf8'));
    } catch {
      fail(ws, 'bad_json', 'Message illisible : JSON invalide.');
      return;
    }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg) || typeof msg.t !== 'string') {
      fail(ws, 'bad_message', 'Message invalide : champ « t » manquant.');
      return;
    }
    const handler = Object.hasOwn(handlers, msg.t) ? handlers[msg.t] : null;
    if (!handler) {
      fail(ws, 'unknown_type', `Type de message inconnu : ${String(msg.t).slice(0, 32)}.`);
      return;
    }
    const s = ws.session;
    if (NEEDS_SESSION.has(msg.t) && !s) {
      fail(ws, 'hello_required', 'Présentez-vous d’abord (message hello).');
      return;
    }
    // Le keepalive (ping) ne compte pas comme activité : un salon oublié dans un onglet ouvert expire.
    if (s && s.room && msg.t !== 'ping') s.room.lastActivity = now;
    try {
      handler(ws, msg, s);
    } catch (err) {
      log('erreur interne', err);
      fail(ws, 'server_error', 'Erreur interne du relais.');
    }
  }

  function onClose(ws) {
    const s = ws.session;
    if (!s || s.ws !== ws) return;
    s.ws = null;
    if (!s.room) {
      sessions.delete(s.token);
      return;
    }
    const room = s.room;
    log(`${s.name} déconnecté de ${room.code} (délai de grâce ${cfg.graceMs} ms)`);
    notifyPeer(room, s.seat, 'left');
    broadcastRoom(room);
    s.graceTimer = setTimeout(() => {
      s.graceTimer = null;
      if (s.ws) return;
      if (s.room) removeFromRoom(s);
      sessions.delete(s.token);
    }, cfg.graceMs);
  }

  // --- HTTP + WebSocket ----------------------------------------------------

  const server = http.createServer((req, res) => {
    const url = (req.url || '/').split('?')[0];
    if ((req.method === 'GET' || req.method === 'HEAD') && url === '/') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      res.end(req.method === 'HEAD' ? undefined : 'ok');
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('introuvable');
  });

  const wss = new WebSocketServer({
    server,
    // Plafond dur (la connexion est coupée au-delà) ; le plafond « poli » est vérifié dans onMessage.
    maxPayload: cfg.maxMessage * 4,
    verifyClient: cfg.origins.length ? (info) => cfg.origins.includes(info.origin) : undefined
  });

  wss.on('connection', (ws) => {
    ws.session = null;
    ws.isAlive = true;
    ws.bucket = { tokens: cfg.rateBurst, last: Date.now(), strikes: 0, warnedAt: 0 };
    ws.on('pong', () => {
      ws.isAlive = true;
    });
    ws.on('message', (raw, isBinary) => onMessage(ws, raw, isBinary));
    ws.on('close', () => onClose(ws));
    ws.on('error', () => {});
  });

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, cfg.heartbeatMs);

  const sweep = setInterval(() => {
    const now = Date.now();
    for (const room of [...rooms.values()]) {
      if (now - room.lastActivity < cfg.idleMs) continue;
      log(`salon ${room.code} fermé (inactif)`);
      for (const s of room.seats) {
        if (!s) continue;
        fail(s.ws, 'room_expired', 'Salon fermé après une longue inactivité.');
        if (!s.ws) {
          clearTimeout(s.graceTimer);
          sessions.delete(s.token);
        }
      }
      deleteRoom(room);
    }
  }, cfg.sweepMs);

  return {
    config: cfg,
    engine: E,
    data,
    server,
    wss,
    rooms,
    sessions,
    /** Démarre l'écoute ; résout avec le port effectif (0 = port libre). */
    listen(port = cfg.port, host = cfg.host) {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => resolve(server.address().port));
      });
    },
    /** Arrête tout (minuteurs, connexions, serveur HTTP). */
    close() {
      clearInterval(heartbeat);
      clearInterval(sweep);
      for (const room of rooms.values()) clearTurn(room);
      for (const s of sessions.values()) clearTimeout(s.graceTimer);
      for (const ws of wss.clients) ws.terminate();
      return new Promise((resolve) => wss.close(() => server.close(() => resolve())));
    }
  };
}

// ---------------------------------------------------------------------------
// Lancement direct : node relay/server.mjs
// ---------------------------------------------------------------------------

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href.toLowerCase() === import.meta.url.toLowerCase();
if (isMain) {
  const cfg = configFromEnv();
  let relay;
  try {
    relay = createRelay(cfg);
  } catch (err) {
    console.error(`Démarrage impossible : ${err.message}`);
    process.exit(1);
  }
  const port = await relay.listen(cfg.port);
  console.log(`Relais du duel Kyara à l'écoute sur le port ${port} (moteur : ${path.relative(ROOT, cfg.enginePath)})`);
  const stop = () => relay.close().then(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
