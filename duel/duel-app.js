/* Kyara Duel — application autonome (chantier C, docs/DUEL-V2.md §3).
 *
 * Page d'extension `duel/duel.html`, affichée dans le panneau (iframe, `?embed=1`) — y compris
 * dans la fenêtre détachée du panneau complet (le « Détacher » est celui du panneau, pas du duel).
 * Consomme :
 *   - window.KYARA_DUEL_DATA   (content/duel-data.js)
 *   - window.KYARA_DUEL_RULES  (content/duel-rules.js)
 *   - window.KYARA_DUEL_ENGINE (content/duel-engine.js, API v2 : submit / pendingPlayers / viewFor)
 *   - window.KYARA_DUEL_NET    (content/duel-net.js, relais v2)
 *   - window.KYARA_DUEL_FX     (duel/duel-fx.js, effets ; facultatif : sans lui, aucun effet)
 *
 * L'interface ne recalcule aucune règle : les actions jouables viennent de `legalActions`
 * (ou du relais), le déroulé des événements du moteur. Toute donnée affichée passe par esc().
 * Hors extension (serveur de test local), le stockage retombe sur localStorage.
 */
(function () {
  'use strict';

  /* ------------------------------------------------------------------ */
  /* Environnement                                                       */
  /* ------------------------------------------------------------------ */

  const ext = (typeof browser !== 'undefined' && browser) || (typeof chrome !== 'undefined' && chrome) || null;
  const HAS_EXT_STORAGE = Boolean(ext && ext.storage && ext.storage.local);
  const PARAMS = new URLSearchParams(location.search);
  const EMBED = PARAMS.has('embed');
  const REDUCED = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

  const PREFS_KEY = 'kyareeh.duel.v1';
  const SOUND_KEY = 'kyareeh.sound.v1';
  const PROFILE_KEY = 'kyareeh.duel.profile';
  const SESSION_KEY = 'kyareeh.duel.session';
  const FALLBACK_STORE = 'kp-harness-store';

  const DECK_SIZE = 5;
  const LOG_MAX = 300;
  const SESSION_MAX_AGE = 6 * 3600 * 1000;

  /*
   * Adresse par défaut du relais de jeu (serveur autoritatif des salons en ligne,
   * dossier `relay/`). Le relais public est déployé sur kyareeh.duckdns.org
   * (Caddy en TLS devant `relay/server.mjs`) : le champ du salon est prérempli et
   * un joueur peut créer ou rejoindre une partie sans configuration. Laisser vide
   * pour revenir à une saisie manuelle.
   */
  const DEFAULT_RELAY = 'wss://kyareeh.duckdns.org';

  /** Le champ du salon est-il une adresse de relais exploitable ? */
  function relayConfigured(value = app.relay) {
    return /^wss?:\/\/\S+$/i.test(String(value || '').trim());
  }


  // Couleurs des types (§1.6) si le moteur ne fournit pas encore E.TYPES.
  const FALLBACK_TYPES = {
    Duelliste: { color: '#ff5a4e', label: 'Duelliste' },
    Mystique: { color: '#a66bff', label: 'Mystique' },
    Soutien: { color: '#3fd68a', label: 'Soutien' },
    Gardien: { color: '#4aa3ff', label: 'Gardien' },
    'Stratège': { color: '#ffc24a', label: 'Stratège' }
  };
  const NEUTRAL_COLOR = '#c9c2b4';

  const STATUS_LABELS = {
    poison: 'Poison',
    curse: 'Malédiction',
    weakness: 'Faiblesse',
    rage: 'Rage',
    regen: 'Régénération',
    haste: 'Hâte'
  };
  const END_REASONS = {
    ko: 'tous les champions adverses sont K.O.',
    rounds: 'limite de tours atteinte : victoire aux PV restants',
    forfeit: 'abandon',
    timeout: 'délai dépassé ou déconnexion prolongée'
  };
  const NET_STATUS = {
    connecting: 'connexion…',
    open: 'connecté',
    reconnecting: 'reconnexion…',
    closed: 'déconnecté'
  };

  /* ------------------------------------------------------------------ */
  /* Utilitaires                                                         */
  /* ------------------------------------------------------------------ */

  function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
  }

  function fmt(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n.toLocaleString('fr-FR') : '—';
  }

  function clone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
  }

  function safe(fn, fallback) {
    try {
      return fn();
    } catch {
      return fallback;
    }
  }

  function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function $(sel, root) {
    return (root || document).querySelector(sel);
  }

  function errText(err) {
    return String((err && err.message) || err || 'erreur inconnue');
  }

  /* ------------------------------------------------------------------ */
  /* Stockage : storage.local de l'extension, sinon localStorage (tests) */
  /* ------------------------------------------------------------------ */

  function readFallback() {
    try {
      return JSON.parse(localStorage.getItem(FALLBACK_STORE) || '{}') || {};
    } catch {
      return {};
    }
  }

  const store = {
    async get(key) {
      if (HAS_EXT_STORAGE) {
        try {
          const obj = await ext.storage.local.get(key);
          return obj ? obj[key] : undefined;
        } catch {
          return undefined;
        }
      }
      return readFallback()[key];
    },
    async set(key, value) {
      if (HAS_EXT_STORAGE) {
        try {
          await ext.storage.local.set({ [key]: value });
        } catch {
          /* quota ou contexte fermé */
        }
        return;
      }
      try {
        const obj = readFallback();
        obj[key] = value;
        localStorage.setItem(FALLBACK_STORE, JSON.stringify(obj));
      } catch {
        /* stockage indisponible */
      }
    },
    async remove(key) {
      if (HAS_EXT_STORAGE) {
        try {
          await ext.storage.local.remove(key);
        } catch {
          /* ignore */
        }
        return;
      }
      try {
        const obj = readFallback();
        delete obj[key];
        localStorage.setItem(FALLBACK_STORE, JSON.stringify(obj));
      } catch {
        /* ignore */
      }
    },
    onChange(cb) {
      if (HAS_EXT_STORAGE && ext.storage.onChanged) {
        try {
          ext.storage.onChanged.addListener((changes, area) => {
            if (area && area !== 'local') return;
            for (const key of Object.keys(changes || {})) cb(key, changes[key].newValue);
          });
        } catch {
          /* ignore */
        }
        return;
      }
      window.addEventListener('storage', (event) => {
        if (event.key !== FALLBACK_STORE) return;
        let before = {};
        let after = {};
        try {
          before = JSON.parse(event.oldValue || '{}') || {};
          after = JSON.parse(event.newValue || '{}') || {};
        } catch {
          return;
        }
        for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
          if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) cb(key, after[key]);
        }
      });
    }
  };

  /* ------------------------------------------------------------------ */
  /* Modules du duel                                                     */
  /* ------------------------------------------------------------------ */

  function dataApi() {
    return window.KYARA_DUEL_DATA || null;
  }

  /** Moteur v2 (choix simultanés) ; null si absent ou encore en v1. */
  function engine() {
    const E = window.KYARA_DUEL_ENGINE;
    return E && typeof E.createMatch === 'function' && typeof E.submit === 'function' && typeof E.pendingPlayers === 'function'
      ? E
      : null;
  }

  function engineIssue() {
    const E = window.KYARA_DUEL_ENGINE;
    if (!E) return 'Moteur du duel non chargé (content/duel-engine.js).';
    if (typeof E.submit !== 'function' || typeof E.pendingPlayers !== 'function') {
      return 'Moteur du duel en version 1 : cette interface attend le moteur v2 (choix simultanés).';
    }
    return '';
  }

  function netApi() {
    const N = window.KYARA_DUEL_NET;
    return N && typeof N.connect === 'function' ? N : null;
  }

  /* --- Effets : chaque appel devient un no-op si duel-fx.js manque. --- */
  let fx = null;

  function initFx() {
    const F = window.KYARA_DUEL_FX;
    if (!F || typeof F.create !== 'function') return;
    try {
      fx = F.create(document.getElementById('kd-app'), { muted: app.muted, volume: app.volume });
    } catch {
      fx = null;
    }
  }

  function fxCall(name, args) {
    if (!fx || typeof fx[name] !== 'function') return undefined;
    try {
      return fx[name](args);
    } catch {
      return undefined;
    }
  }

  function sound(name) {
    fxCall('sound', name);
  }

  /* ------------------------------------------------------------------ */
  /* Cartes, types, capacités                                            */
  /* ------------------------------------------------------------------ */

  let cardsCache = null;

  function cardIndex() {
    const data = dataApi();
    const src = data && data.champions;
    if (!Array.isArray(src)) return { src: null, list: [], byId: new Map() };
    if (cardsCache && cardsCache.src === src) return cardsCache;
    let list = null;
    const E = window.KYARA_DUEL_ENGINE;
    if (E && typeof E.mythics === 'function') {
      const ids = safe(() => new Set((E.mythics(data) || []).map((c) => String(c && c.id))), null);
      if (ids && ids.size) list = src.filter((c) => ids.has(String(c.id)));
    }
    if (!list) list = src.filter((c) => String(c && c.rarity).toUpperCase() === 'M');
    cardsCache = { src, list, byId: new Map(src.map((c) => [String(c.id), c])) };
    return cardsCache;
  }

  function cards() {
    return cardIndex().list;
  }

  function cardById(id) {
    return cardIndex().byId.get(String(id)) || null;
  }

  function isMythic(id) {
    return cards().some((c) => String(c.id) === String(id));
  }

  /** Identifiants au type d'origine des données (le moteur compare des ids numériques). */
  function deckIds(ids) {
    return ids.map((id) => (cardById(id) ? cardById(id).id : id));
  }

  function types() {
    const E = window.KYARA_DUEL_ENGINE;
    return (E && E.TYPES && typeof E.TYPES === 'object' && Object.keys(E.TYPES).length ? E.TYPES : FALLBACK_TYPES);
  }

  /** Type (rôle) d'un champion ou d'une carte : E.typeOf si possible, sinon le rôle normalisé. */
  function typeOf(champ) {
    if (!champ) return '';
    const E = window.KYARA_DUEL_ENGINE;
    if (E && typeof E.typeOf === 'function') {
      const t = safe(() => E.typeOf(champ), '');
      if (t) return String(t);
    }
    const role = String(champ.type || champ.role || (cardById(champ.id) || {}).role || '');
    return role === 'Gardienne' ? 'Gardien' : role;
  }

  function typeInfo(champ) {
    const key = typeOf(champ);
    const info = types()[key] || FALLBACK_TYPES[key] || null;
    return { key, label: (info && info.label) || key || '—', color: (info && info.color) || NEUTRAL_COLOR, info };
  }

  function kindLabel(kind) {
    return kind === 'support' ? 'Soutien' : kind === 'ultimate' ? 'Ultime' : 'Attaque';
  }

  function statusText(apply) {
    return Object.entries(apply || {})
      .map(([key, turns]) => {
        const label = (STATUS_LABELS[key] || key).toLowerCase();
        return key === 'haste' || turns === true ? label : `${label} ${turns}`;
      })
      .join(', ');
  }

  function effectText(move) {
    const parts = [];
    if (move.damage) parts.push(`${move.damage} dégâts`);
    if (move.randomDamage) parts.push(`${move.randomDamage[0]}–${move.randomDamage[1]} dégâts aléatoires`);
    if (move.bonusIfLow) parts.push(`+${move.bonusIfLow} dégâts sous 50 % PV`);
    if (move.heal) parts.push(`soin ${move.heal}`);
    if (move.guard) parts.push(`garde ${move.guard}`);
    if (move.buff) parts.push(`+${move.buff} dégâts préparés`);
    if (move.selfAtk) parts.push(`+${move.selfAtk} ATQ (lanceur)`);
    if (move.teamAtk) parts.push(`+${move.teamAtk} ATQ équipe`);
    if (move.healTeam) parts.push(`soin équipe ${move.healTeam}`);
    if (move.healTeamFull) parts.push('soins équipe complets');
    if (move.teamHp) parts.push(`−${move.teamHp} PV aux autres alliés`);
    if (move.recoil) parts.push(`−${move.recoil} PV (lanceur)`);
    if (move.apply) parts.push(`cible : ${statusText(move.apply)}`);
    if (move.selfApply) parts.push(`lanceur : ${statusText(move.selfApply)}`);
    if (move.cleanse) parts.push('dissipe poison, faiblesse et malédiction');
    if (move.sacrifice) parts.push('sacrifie l’allié le plus faible');
    if (move.skipFoe) parts.push('l’adversaire perd sa prochaine action');
    if (move.attackBlock) parts.push('annule la prochaine attaque subie');
    if (move.invincible) parts.push(`invulnérable ${move.invincible} tour(s)`);
    if (move.disableTurns) parts.push(`ne peut plus attaquer ${move.disableTurns} tour(s)`);
    if (move.saveLethal) parts.push('survit une fois à un coup létal');
    if (Array.isArray(move.instakill)) parts.push(`abat ${move.instakill.join(' / ')}`);
    if (move.reviveAlly) parts.push('ressuscite un allié tombé, puis succombe');
    if (move.extraTurn) parts.push('action bonus en fin de tour');
    return parts.join(', ');
  }

  function rulesNow() {
    const st = app.match && app.match.state;
    const E = window.KYARA_DUEL_ENGINE;
    return (st && st.rules) || (E && E.RULES) || {};
  }

  function ruleValue(key, fallback) {
    const v = rulesNow()[key];
    return v != null && Number.isFinite(Number(v)) ? Number(v) : fallback;
  }

  function moveCost(move) {
    if (move && move.cost != null && Number.isFinite(Number(move.cost))) return Number(move.cost);
    const kind = move && (move.kind === 'support' || move.kind === 'ultimate') ? move.kind : 'attack';
    return ruleValue(`${kind}Cost`, { attack: 0, support: 1, ultimate: 4 }[kind]);
  }

  function movesOf(champ) {
    if (champ && Array.isArray(champ.moves) && champ.moves.length) return champ.moves;
    if (champ && Array.isArray(champ.attacks) && champ.attacks.length) return champ.attacks;
    const card = champ ? cardById(champ.id) : null;
    return (card && card.attacks) || [];
  }

  /** Multiplicateur d'efficacité indicatif (table E.TYPES), 1 si inconnu. */
  function effectiveness(attacker, defender) {
    const E = window.KYARA_DUEL_ENGINE;
    if (E && typeof E.effectiveness === 'function') {
      const mult = safe(() => E.effectiveness(typeOf(attacker), typeOf(defender), rulesNow()), null);
      if (Number.isFinite(mult)) return mult;
    }
    const a = typeInfo(attacker).info;
    const d = typeOf(defender);
    if (!a || !d) return 1;
    if (Array.isArray(a.strong) && a.strong.includes(d)) return Number(a.strongMult) || 1.25;
    if (Array.isArray(a.weak) && a.weak.includes(d)) return Number(a.weakMult) || 0.8;
    return 1;
  }

  /* ------------------------------------------------------------------ */
  /* État de l'application                                               */
  /* ------------------------------------------------------------------ */

  const app = {
    screen: 'collection',
    deck: [],
    relay: '',
    relayError: '',
    code: '',
    query: '',
    series: 'all',
    type: 'all',
    ownedOnly: false,
    profile: null, // { name, owned: Set, at, test }
    muted: false,
    volume: 0.7,
    match: null,
    net: null,
    view: null, // état affiché (patché pendant la lecture des événements)
    playing: false,
    fast: false,
    logOpen: false,
    modal: null,
    toastTimer: null,
    chain: Promise.resolve()
  };

  function playerName() {
    return (app.profile && app.profile.name) || 'Joueur';
  }

  function ownedSet() {
    return (app.profile && app.profile.owned) || new Set();
  }

  async function loadPrefs() {
    const saved = await store.get(PREFS_KEY);
    app.relay = DEFAULT_RELAY;
    if (saved && typeof saved === 'object') {
      if (typeof saved.relay === 'string' && saved.relay.trim()) app.relay = saved.relay.trim();
      if (Array.isArray(saved.deck)) {
        app.deck = [...new Set(saved.deck.map(String))].filter((id) => isMythic(id)).slice(0, DECK_SIZE);
      }
      if (typeof saved.muted === 'boolean') app.muted = saved.muted;
      if (Number.isFinite(Number(saved.volume))) app.volume = Math.max(0, Math.min(1, Number(saved.volume)));
    }
    // Le son est piloté par la fenêtre Global ; l'ancien réglage ne sert que
    // de repli si la clé globale n'existe pas encore.
    const sound = await store.get(SOUND_KEY);
    if (sound && typeof sound === 'object') applySound(sound);
  }

  function applySound(raw) {
    if (!raw || typeof raw !== 'object') return;
    if (typeof raw.muted === 'boolean') app.muted = raw.muted;
    if (Number.isFinite(Number(raw.volume))) app.volume = Math.max(0, Math.min(1, Number(raw.volume)));
    fxCall('setMuted', app.muted);
    fxCall('setVolume', app.volume);
  }

  let persistTimer = null;

  function persistPrefs() {
    clearTimeout(persistTimer);
    persistTimer = setTimeout(async () => {
      // Fusion : d'autres champs éventuels de la clé sont conservés.
      const saved = (await store.get(PREFS_KEY)) || {};
      await store.set(PREFS_KEY, {
        ...(typeof saved === 'object' ? saved : {}),
        relay: app.relay,
        deck: app.deck,
        muted: app.muted,
        volume: app.volume
      });
    }, 300);
  }

  function applyProfile(raw) {
    if (raw && typeof raw === 'object' && Array.isArray(raw.owned)) {
      app.profile = {
        name: String(raw.name || '').trim() || 'Joueur',
        owned: new Set(raw.owned.map(String)),
        at: Number(raw.at) || null,
        test: false
      };
      return;
    }
    if (!HAS_EXT_STORAGE) {
      // Hors extension (serveur de test) : profil de test explicite, possède les 8 premières
      // Mythiques (comme le harness ?duel=1) pour pouvoir essayer le duel en ligne.
      app.profile = {
        name: 'Harness',
        owned: new Set(cards().slice(0, 8).map((c) => String(c.id))),
        at: null,
        test: true
      };
      return;
    }
    app.profile = null;
  }

  async function loadProfile() {
    applyProfile(await store.get(PROFILE_KEY));
  }

  /* ------------------------------------------------------------------ */
  /* Deck                                                                */
  /* ------------------------------------------------------------------ */

  function fillDeck(deck, { preferOwned = false } = {}) {
    const out = deck.filter((id) => isMythic(id)).slice(0, DECK_SIZE);
    const pool = cards().map((c) => String(c.id));
    const owned = preferOwned ? ownedSet() : new Set();
    const shuffle = (list) => {
      const copy = [...list];
      for (let i = copy.length - 1; i > 0; i -= 1) {
        const j = Math.floor(Math.random() * (i + 1));
        [copy[i], copy[j]] = [copy[j], copy[i]];
      }
      return copy;
    };
    for (const id of [...shuffle(pool.filter((id) => owned.has(id))), ...shuffle(pool.filter((id) => !owned.has(id)))]) {
      if (out.length >= DECK_SIZE) break;
      if (!out.includes(id)) out.push(id);
    }
    return out;
  }

  /** Raison pour laquelle le deck ne peut pas partir en ligne ('' si prêt). */
  function onlineDeckIssue() {
    if (!app.profile) return 'Ouvre kyara.games connecté avec le panneau Kyareeh+ : ta collection n’a pas encore été transmise.';
    if (app.deck.length !== DECK_SIZE) {
      return `Le deck en ligne doit contenir ${DECK_SIZE} Mythiques possédées (actuellement ${app.deck.length}/${DECK_SIZE}).`;
    }
    const owned = ownedSet();
    const missing = app.deck.filter((id) => !owned.has(id));
    if (missing.length) {
      return `Non possédée(s) : ${missing.map((id) => (cardById(id) || {}).name || `#${id}`).join(', ')}. Ces cartes ne servent qu’à l’entraînement.`;
    }
    const E = window.KYARA_DUEL_ENGINE;
    if (E && typeof E.validateDeck === 'function') {
      try {
        const check = E.validateDeck(dataApi(), deckIds(app.deck));
        if (check && check.ok === false) return String(check.error || 'Deck refusé par le moteur.');
      } catch (err) {
        return errText(err);
      }
    }
    return '';
  }

  /* ------------------------------------------------------------------ */
  /* Lecture de l'état d'un duel                                         */
  /* ------------------------------------------------------------------ */

  function isOver(match) {
    if (!match) return true;
    if (match.ended) return true;
    const st = match.state;
    if (!st) return false;
    return st.phase === 'ended' || (st.winner !== null && st.winner !== undefined);
  }

  function winnerOf(match) {
    if (match && match.ended && match.ended.winner != null) return match.ended.winner;
    return match && match.state ? match.state.winner ?? null : null;
  }

  function phaseOf(match) {
    if (isOver(match)) return 'ended';
    return (match && (match.phase || (match.state && match.state.phase))) || 'choose';
  }

  /** Joueurs qui doivent encore choisir. */
  function pendingOf(match) {
    if (!match || isOver(match)) return [];
    if (match.kind === 'online') {
      if (Array.isArray(match.pending)) return match.pending;
    }
    const E = engine();
    if (E && match.state) return safe(() => E.pendingPlayers(match.state), []) || [];
    return [];
  }

  function myChoiceNeeded(match) {
    return Boolean(match) && !app.playing && !match.submitted && pendingOf(match).includes(match.you);
  }

  function legalFor(match) {
    if (!match || !myChoiceNeeded(match)) return [];
    if (match.kind === 'online' && Array.isArray(match.legal) && match.legal.length) return match.legal;
    const E = engine();
    if (!E) return [];
    return safe(() => E.legalActions(match.state, match.you), []) || [];
  }

  function viewOf(match) {
    if (!match || !match.state) return null;
    const E = engine();
    if (E && typeof E.viewFor === 'function') {
      const v = safe(() => E.viewFor(match.state, match.you), null);
      if (v) return clone(v);
    }
    return clone(match.state);
  }

  function activeIndex(player) {
    const n = Number(player && player.active);
    if (Number.isInteger(n) && n >= 0) return n;
    const list = (player && player.champions) || [];
    const alive = list.findIndex((c) => c && c.alive !== false && Number(c.hp) > 0);
    return alive >= 0 ? alive : 0;
  }

  function champAt(view, side, index) {
    return (view && view.players && view.players[side] && view.players[side].champions && view.players[side].champions[index]) || null;
  }

  function isAlive(champ) {
    return Boolean(champ) && champ.alive !== false && Number(champ.hp) > 0;
  }

  function describe(event) {
    if (event == null) return '';
    if (typeof event === 'string') return event;
    const E = window.KYARA_DUEL_ENGINE;
    if (E && typeof E.describeEvent === 'function') {
      const text = safe(() => E.describeEvent(event), '');
      if (text) return String(text);
    }
    return String(event.text || event.message || '');
  }

  function pushLog(match, event, text) {
    if (!text) return;
    const type =
      typeof event === 'string'
        ? /^—/.test(text) ? 'round' : ''
        : String((event && event.type) || '').replace(/[^a-z]/gi, '').toLowerCase();
    match.log.push({ text, type });
    if (match.log.length > LOG_MAX) match.log.splice(0, match.log.length - LOG_MAX);
  }

  function seedLog(match) {
    if (match.log.length || !match.state || !Array.isArray(match.state.log)) return;
    for (const entry of match.state.log.slice(-LOG_MAX)) pushLog(match, entry, describe(entry));
  }

  /* ------------------------------------------------------------------ */
  /* Entraînement contre l'IA                                            */
  /* ------------------------------------------------------------------ */

  function newMatch(kind, state, extra) {
    return Object.assign(
      {
        kind,
        state,
        you: 0,
        log: [],
        sel: null, // { mode: 'target', move } | { mode: 'switch' }
        ended: null,
        error: '',
        submitted: false,
        foeChosen: false,
        pending: null,
        phase: null,
        legal: null,
        deadlineAt: null,
        forfeitArmed: false,
        filled: false
      },
      extra || {}
    );
  }

  function startPractice() {
    const E = engine();
    if (!E) {
      notify(engineIssue());
      return;
    }
    if (app.match && app.match.kind === 'online' && !isOver(app.match)) {
      notify('Un duel en ligne est en cours : termine-le ou abandonne-le d’abord.');
      return;
    }
    if (!cards().length) {
      notify('Données du duel indisponibles : content/duel-data.js n’est pas chargé.');
      return;
    }
    const mine = fillDeck(app.deck);
    const foe = fillDeck([]);
    let state;
    try {
      state = E.createMatch({
        data: dataApi(),
        seed: Math.floor(Math.random() * 0xffffffff) >>> 0,
        players: [
          { id: 'joueur', name: playerName(), deck: deckIds(mine) },
          { id: 'ia', name: 'IA', deck: deckIds(foe) }
        ]
      });
    } catch (err) {
      notify(`Impossible de lancer l’entraînement : ${errText(err)}`);
      return;
    }
    app.match = newMatch('practice', state, { filled: app.deck.length < DECK_SIZE });
    seedLog(app.match);
    app.view = viewOf(app.match);
    app.screen = 'combat';
    render();
    practiceAdvance(app.match);
  }

  /** Fait choisir l'IA tant qu'elle est attendue ; joue les tours résolus. */
  async function practiceAdvance(match) {
    const E = engine();
    if (!E || app.match !== match) return;
    for (let guard = 0; guard < 20; guard += 1) {
      if (app.match !== match || isOver(match)) break;
      const pending = pendingOf(match);
      if (!pending.includes(1)) break;
      let action = null;
      try {
        action = E.chooseAction(match.state, 1);
      } catch (err) {
        match.error = `L’IA n’a pas pu choisir (${errText(err)}) : elle passe.`;
      }
      let result;
      try {
        result = E.submit(match.state, 1, action || { type: 'pass' });
      } catch (err) {
        // Dernier recours : première action légale.
        const legal = safe(() => E.legalActions(match.state, 1), []) || [];
        try {
          result = E.submit(match.state, 1, legal[0] || { type: 'pass' });
        } catch (err2) {
          match.error = `L’IA ne peut pas jouer : ${errText(err2)}`;
          render();
          return;
        }
      }
      const before = app.view;
      match.state = (result && result.state) || match.state;
      if (result && result.resolved) await playTurn(match, before, result.events);
    }
    savePractice(match);
    render();
  }

  async function submitPractice(match, action) {
    const E = engine();
    let result;
    try {
      result = E.submit(match.state, match.you, action);
    } catch (err) {
      match.error = errText(err);
      render();
      return;
    }
    match.error = '';
    match.sel = null;
    const before = app.view;
    match.state = (result && result.state) || match.state;
    if (result && result.resolved) await playTurn(match, before, result.events);
    await practiceAdvance(match);
  }

  function savePractice(match) {
    if (!match || match.kind !== 'practice') return;
    if (isOver(match)) {
      store.remove(SESSION_KEY);
      return;
    }
    store.set(SESSION_KEY, {
      kind: 'practice',
      state: match.state,
      log: match.log.slice(-120),
      filled: match.filled,
      at: Date.now()
    });
  }

  async function restorePractice() {
    const saved = await store.get(SESSION_KEY);
    if (!saved || saved.kind !== 'practice' || !saved.state) return false;
    if (Date.now() - Number(saved.at || 0) > SESSION_MAX_AGE) {
      store.remove(SESSION_KEY);
      return false;
    }
    const E = engine();
    if (!E) return false;
    const match = newMatch('practice', saved.state, { filled: Boolean(saved.filled) });
    match.log = Array.isArray(saved.log) ? saved.log.filter((e) => e && typeof e.text === 'string') : [];
    if (isOver(match)) {
      store.remove(SESSION_KEY);
      return false;
    }
    app.match = match;
    app.view = viewOf(match);
    app.screen = 'combat';
    pushLog(match, null, '');
    return true;
  }

  /* ------------------------------------------------------------------ */
  /* En ligne (relais)                                                   */
  /* ------------------------------------------------------------------ */

  function netStatus(net) {
    if (!net) return 'closed';
    const status = String((net.client && net.client.status) || net.status || 'closed');
    return NET_STATUS[status] ? status : 'closed';
  }

  function closeNet() {
    const net = app.net;
    app.net = null;
    if (!net || !net.client) return;
    try {
      net.client.close();
    } catch {
      /* déjà fermé */
    }
  }

  function connect(intent) {
    const N = netApi();
    if (!N) {
      notify('Client réseau indisponible : content/duel-net.js n’est pas chargé.');
      return;
    }
    const relay = String(app.relay || '').trim();
    persistPrefs();
    if (!relayConfigured(relay)) {
      app.relayError = 'Aucun serveur de jeu configuré : saisis l’adresse wss:// du relais avant de créer ou de rejoindre un salon.';
      render();
      return;
    }
    app.relayError = '';
    if (intent.type === 'join' && !/^[A-Z]{5}$/.test(intent.code)) {
      notify('Le code du salon fait 5 lettres.');
      return;
    }
    const issue = onlineDeckIssue();
    if (issue) {
      notify(issue);
      return;
    }
    if (app.match && !isOver(app.match)) {
      notify('Un duel est en cours : termine-le ou abandonne-le d’abord.');
      return;
    }
    closeNet();
    const net = { client: null, status: 'connecting', relay, room: null, error: '', peer: '', intent, intentSent: false };
    app.net = net;
    try {
      net.client = N.connect(relay, { name: playerName(), deck: deckIds(app.deck), onEvent: (msg) => onNet(net, msg) });
    } catch (err) {
      net.status = 'closed';
      net.error = `Connexion impossible : ${errText(err)}`;
    }
    sendIntent(net);
    render();
  }

  function sendIntent(net) {
    if (!net || !net.client || !net.intent || net.intentSent) return;
    net.intentSent = true;
    try {
      if (net.intent.type === 'join') net.client.join(net.intent.code);
      else net.client.create();
    } catch (err) {
      net.error = `Envoi impossible : ${errText(err)}`;
    }
  }

  function onNet(net, msg) {
    if (app.net !== net || !msg || typeof msg !== 'object') return;
    const match = app.match && app.match.kind === 'online' && app.match.net === net ? app.match : null;
    switch (msg.t) {
      case 'welcome':
        net.error = '';
        sendIntent(net);
        break;
      case 'net':
        if (msg.status === 'open' && net.error && !net.room) net.error = '';
        if (msg.status !== 'closed') {
          tick();
          return;
        }
        if (!net.error) net.error = 'Connexion au relais perdue.';
        break;
      case 'room':
        net.room = {
          code: String(msg.code || ''),
          players: Array.isArray(msg.players) ? msg.players : [],
          status: String(msg.status || 'waiting')
        };
        if (net.room.status !== 'ended') net.rematchAsked = false;
        break;
      case 'state':
        // Les états sont joués dans l'ordre, après la fin de l'animation précédente.
        app.chain = app.chain.then(() => onNetState(net, msg)).catch(() => {});
        return;
      case 'chosen':
        if (match && Array.isArray(msg.pending)) match.pending = msg.pending.map(Number);
        if (match && msg.player !== match.you) {
          match.foeChosen = true;
          if (myChoiceNeeded(match)) sound('select');
        } else if (match && msg.player === match.you) {
          match.submitted = true;
        }
        if (app.screen === 'combat' && !app.playing) renderCommand();
        return;
      case 'end':
        app.chain = app.chain
          .then(() => {
            if (app.match && app.match.kind === 'online' && app.match.net === net) {
              const m = app.match;
              const wasOver = Boolean(m.ended);
              m.ended = { winner: msg.winner ?? null, reason: String(msg.reason || '') };
              m.deadlineAt = null;
              m.submitted = false;
              if (!wasOver) endSound(m);
            }
            if (net.room) net.room.status = 'ended';
            render();
          })
          .catch(() => {});
        return;
      case 'error':
        net.error = String(msg.message || msg.code || 'Erreur du relais.');
        if (match) {
          match.submitted = false;
          match.error = net.error;
        }
        break;
      case 'peer':
        net.peer = msg.status === 'left' ? 'left' : 'back';
        break;
      default:
        return;
    }
    render();
  }

  async function onNetState(net, msg) {
    if (app.net !== net) return;
    let match = app.match;
    const fresh = msg.state && (msg.state.winner === null || msg.state.winner === undefined) && msg.state.phase !== 'ended';
    if (!match || match.kind !== 'online' || match.net !== net || (fresh && isOver(match))) {
      match = newMatch('online', msg.state, { net });
      app.match = match;
      app.screen = 'combat';
      match.you = msg.you === 1 ? 1 : 0;
      if (!Array.isArray(msg.events) || !msg.events.length) seedLog(match);
      app.view = viewOf(match);
      render();
    }
    const before = app.view;
    match.you = msg.you === 1 ? 1 : 0;
    match.state = msg.state || match.state;
    match.seq = msg.seq;
    match.pending = Array.isArray(msg.pending) ? msg.pending.map(Number) : null;
    match.phase = msg.phase || null;
    match.legal = Array.isArray(msg.legal) ? msg.legal : null;
    // Reprise après coupure : le serveur renvoie mon choix déjà verrouillé et qui a choisi.
    match.submitted = Boolean(msg.choice);
    match.foeChosen = Array.isArray(msg.chosen) && msg.chosen.map(Number).includes(1 - match.you);
    match.sel = null;
    match.error = '';
    const left = Number(msg.deadline);
    match.deadlineAt = Number.isFinite(left) && left > 0 ? Date.now() + left : null;
    if (net.peer === 'back') net.peer = '';
    if (Array.isArray(msg.events) && msg.events.length) {
      await playTurn(match, before, msg.events);
    } else {
      app.view = viewOf(match);
      render();
    }
  }

  function rematch() {
    const net = app.net;
    const client = net && net.client;
    if (
      client &&
      typeof client.rematch === 'function' &&
      !net.left &&
      ((net.room && net.room.players) || []).length >= 2 &&
      net.room.status === 'ended' &&
      netStatus(net) !== 'closed'
    ) {
      try {
        client.rematch();
        net.rematchAsked = true;
        net.error = '';
        render();
        return;
      } catch {
        /* repli : nouveau salon */
      }
    }
    app.match = null;
    app.screen = 'salon';
    connect({ type: 'create' });
    render();
  }

  /* ------------------------------------------------------------------ */
  /* Actions du joueur                                                   */
  /* ------------------------------------------------------------------ */

  function play(action) {
    const match = app.match;
    if (!match || isOver(match) || app.playing || !myChoiceNeeded(match)) return;
    sound('select');
    if (match.kind === 'practice') {
      submitPractice(match, action);
      return;
    }
    const client = app.net && app.net.client;
    if (!client) {
      match.error = 'Connexion au relais perdue.';
      render();
      return;
    }
    try {
      client.act(action);
      match.submitted = true;
      match.sel = null;
      match.error = '';
    } catch (err) {
      match.error = `Envoi impossible : ${errText(err)}`;
    }
    render();
  }

  function forfeit() {
    const match = app.match;
    if (!match || isOver(match)) return;
    if (match.kind === 'online') {
      if (app.net) app.net.left = true;
      try {
        if (app.net && app.net.client) app.net.client.leave();
      } catch {
        /* connexion déjà fermée */
      }
      match.ended = { winner: 1 - match.you, reason: 'forfeit' };
      pushLog(match, { type: 'end' }, `${playerName()} abandonne le duel.`);
    } else {
      const E = engine();
      let done = false;
      if (E && typeof E.forfeit === 'function') {
        try {
          const result = E.forfeit(match.state, match.you, 'forfeit');
          match.state = (result && result.state) || match.state;
          for (const e of (result && result.events) || []) pushLog(match, e, describe(e));
          done = isOver(match);
        } catch {
          /* repli ci-dessous */
        }
      }
      if (!done) {
        match.ended = { winner: 1 - match.you, reason: 'forfeit' };
        pushLog(match, { type: 'end' }, `${playerName()} abandonne le duel.`);
      }
      store.remove(SESSION_KEY);
    }
    match.deadlineAt = null;
    match.submitted = false;
    app.view = viewOf(match);
    endSound(match);
    render();
  }

  function endSound(match) {
    const w = winnerOf(match);
    sound(w === match.you ? 'victory' : 'defeat');
  }

  /* ------------------------------------------------------------------ */
  /* Lecture animée d'un tour                                            */
  /* ------------------------------------------------------------------ */

  function speed() {
    return (app.fast ? 0.3 : 1) * (REDUCED ? 0.6 : 1);
  }

  function pause(ms) {
    return wait(Math.round(ms * speed()));
  }

  function champEl(side, index) {
    return document.querySelector(`[data-champ="${side}:${index}"]`);
  }

  function say(text) {
    const box = document.getElementById('kd-say-text');
    if (!box) return;
    box.textContent = text;
    box.classList.remove('is-new');
    void box.offsetWidth;
    box.classList.add('is-new');
  }

  function flashBanner(text, tone) {
    const el = document.getElementById('kd-banner');
    if (!el) return;
    el.textContent = text;
    el.className = `kd-banner is-on ${tone ? `is-${tone}` : ''}`;
    clearTimeout(flashBanner.timer);
    flashBanner.timer = setTimeout(() => {
      el.className = 'kd-banner';
    }, Math.max(500, 1100 * speed()));
  }

  /** Applique un événement au modèle affiché (pour animer les barres au fil du tour). */
  function patchView(view, e) {
    if (!view || !e || !Array.isArray(view.players)) return;
    const c = e.side != null && e.index != null ? champAt(view, e.side, e.index) : null;
    switch (e.type) {
      case 'damage':
        if (c) {
          if (e.hp != null) c.hp = Math.max(0, Number(e.hp));
          if (e.absorbed) c.guard = Math.max(0, Number(c.guard || 0) - Number(e.absorbed));
        }
        break;
      case 'heal':
      case 'revive':
        if (c && e.hp != null) {
          c.hp = Number(e.hp);
          c.alive = true;
        }
        break;
      case 'guard':
      case 'guardDecay':
        if (c && e.guard != null) c.guard = Number(e.guard);
        break;
      case 'atk':
        if (c && e.atkBonus != null) c.atkBonus = Number(e.atkBonus);
        break;
      case 'buff':
        if (c && e.buff != null) c.buff = Number(e.buff);
        break;
      case 'status':
        if (c && e.status) {
          c.statuses = c.statuses || {};
          c.statuses[e.status] = e.turns ?? true;
        }
        break;
      case 'expire':
        if (c && c.statuses && e.status) delete c.statuses[e.status];
        break;
      case 'cleanse':
        if (c && c.statuses) for (const k of e.removed || []) delete c.statuses[k];
        break;
      case 'dispel':
        if (c && c.statuses && e.status) {
          if (Number(e.left) > 0) c.statuses[e.status] = Number(e.left);
          else delete c.statuses[e.status];
        }
        break;
      case 'ko':
        if (c) {
          c.hp = 0;
          c.alive = false;
          c.guard = 0;
          c.statuses = {};
        }
        break;
      case 'switch':
        if (view.players[e.side] && e.to != null) view.players[e.side].active = Number(e.to);
        break;
      case 'chakra':
        if (e.player != null && view.players[e.player] && e.chakra != null) view.players[e.player].chakra = Number(e.chakra);
        break;
      case 'turn':
        if (e.turn != null) view.round = e.turn;
        view.turn = e.turn;
        break;
      case 'round':
        if (e.round != null) view.round = e.round;
        break;
      default:
        break;
    }
  }

  function eventColor(e, view) {
    if (e && typeof e.color === 'string') return e.color;
    const c = e && e.side != null && e.index != null ? champAt(view, e.side, e.index) : null;
    return c ? typeInfo(c).color : NEUTRAL_COLOR;
  }

  async function playTurn(match, before, events) {
    const list = Array.isArray(events) ? events : [];
    const final = viewOf(match);
    if (!list.length || app.screen !== 'combat' || !before) {
      for (const e of list) pushLog(match, e, describe(e));
      app.view = final;
      if (isOver(match)) endSound(match);
      render();
      return;
    }
    app.playing = true;
    app.fast = false;
    app.view = clone(before);
    renderCombat();
    const ctx = { color: NEUTRAL_COLOR, mult: 1, actor: null, lastText: '' };
    for (const e of list) {
      if (app.match !== match) return;
      const text = describe(e);
      pushLog(match, e, text);
      if (text) {
        say(text);
        appendLogLine(match.log[match.log.length - 1]);
      }
      try {
        await animateEvent(e, ctx, Boolean(text));
      } catch {
        /* un effet raté ne bloque jamais la partie */
      }
    }
    if (app.match !== match) return;
    app.view = final;
    app.playing = false;
    app.fast = false;
    if (isOver(match)) endSound(match);
    render();
  }

  async function animateEvent(e, ctx, hasText) {
    const view = app.view;
    if (!e || typeof e !== 'object') {
      if (hasText) await pause(500);
      return;
    }
    const el = e.side != null && e.index != null ? champEl(e.side, e.index) : null;
    switch (e.type) {
      case 'turn':
      case 'round': {
        patchView(view, e);
        const n = e.turn ?? e.round ?? '';
        const r = document.getElementById('kd-round');
        if (r) r.textContent = String(n);
        flashBanner(`Tour ${n}`, 'round');
        await pause(700);
        return;
      }
      case 'turnOrder':
        await pause(hasText ? 450 : 0);
        return;
      case 'move': {
        ctx.color = eventColor(e, view);
        ctx.actor = { side: e.side, index: e.index };
        ctx.mult = 1;
        if (el) el.classList.add('is-acting');
        if (e.kind === 'ultimate') {
          const champ = champAt(view, e.side, e.index);
          sound('ultimate');
          const shown = fxCall('ultimate', {
            name: e.moveName || '',
            champion: e.name || (champ && champ.name) || '',
            image: (champ && champ.image) || ((cardById(champ && champ.id) || {}).image) || '',
            color: ctx.color
          });
          if (shown && typeof shown.then === 'function') {
            await Promise.race([shown, wait(4000)]);
          } else {
            await pause(400);
          }
        }
        await pause(420);
        const target = e.target && e.target.side != null ? champEl(e.target.side, e.target.index) : null;
        if (target && target !== el) {
          fxCall('attack', { fromEl: el, toEl: target, color: ctx.color, kind: e.kind || 'attack' });
          await pause(380);
        }
        if (el) el.classList.remove('is-acting');
        return;
      }
      case 'effectiveness': {
        const mult = Number(e.mult) || 1;
        ctx.mult = mult;
        if (mult > 1) flashBanner('C’est très efficace !', 'strong');
        else if (mult < 1) flashBanner('Ce n’est pas très efficace…', 'weak');
        await pause(hasText ? 500 : 250);
        return;
      }
      case 'damage': {
        patchView(view, e);
        const amount = Number(e.amount) || 0;
        const source = e.source || 'move';
        const color = source === 'move' ? ctx.color : source === 'poison' ? '#9be15d' : source === 'curse' ? '#a66bff' : eventColor(e, view);
        const mult = source === 'move' ? Number(e.mult) || ctx.mult : 1;
        fxCall('hit', { el, color, amount, crit: Boolean(e.crit), effectiveness: mult });
        sound(e.crit || mult > 1 ? 'crit' : 'hit');
        refreshChamp(e.side, e.index);
        await pause(560);
        return;
      }
      case 'heal':
      case 'revive':
        patchView(view, e);
        fxCall('heal', { el, amount: Number(e.amount ?? e.hp) || 0 });
        sound('heal');
        if (e.type === 'revive') renderSide(e.side);
        else refreshChamp(e.side, e.index);
        await pause(520);
        return;
      case 'guard':
        patchView(view, e);
        fxCall('guard', { el, amount: Number(e.amount) || 0 });
        sound('guard');
        refreshChamp(e.side, e.index);
        await pause(480);
        return;
      case 'guardDecay':
      case 'atk':
      case 'buff':
      case 'expire':
      case 'cleanse':
      case 'dispel':
        patchView(view, e);
        refreshChamp(e.side, e.index);
        await pause(hasText ? 420 : 80);
        return;
      case 'status':
        patchView(view, e);
        fxCall('status', { el, status: e.status });
        sound('status');
        refreshChamp(e.side, e.index);
        await pause(520);
        return;
      case 'ko':
        sound('ko');
        await Promise.resolve(fxCall('ko', { el }));
        patchView(view, e);
        await pause(650);
        refreshChamp(e.side, e.index);
        return;
      case 'switch': {
        const from = e.from != null ? champEl(e.side, e.from) : el;
        sound('switch');
        if (from) {
          fxCall('switchOut', { el: from });
          await pause(420);
        }
        patchView(view, e);
        renderSide(e.side);
        const next = champEl(e.side, e.to);
        const champ = champAt(view, e.side, e.to);
        fxCall('switchIn', { el: next, color: champ ? typeInfo(champ).color : NEUTRAL_COLOR });
        await pause(560);
        return;
      }
      case 'blocked':
      case 'protect':
        fxCall('guard', { el, color: e.effect === 'disabled' ? '#93a4c3' : undefined });
        sound('guard');
        refreshChamp(e.side, e.index);
        await pause(hasText ? 520 : 150);
        return;
      case 'survive':
        fxCall('guard', { el, color: '#ffc24a' });
        sound('guard');
        await pause(520);
        return;
      case 'haste':
        fxCall('status', { el, status: 'haste' });
        sound('status');
        await pause(420);
        return;
      case 'chosen':
      case 'turnEnd':
        return;
      case 'chakra':
        patchView(view, e);
        if (Number(e.delta) > 0 && e.player === (app.match && app.match.you)) sound('chakra');
        refreshChakra(e.player);
        await pause(hasText ? 260 : 60);
        return;
      case 'phaseReplace':
        await pause(hasText ? 500 : 100);
        return;
      case 'end':
        await pause(600);
        return;
      default:
        if (e.side != null && e.index != null) {
          patchView(view, e);
          refreshChamp(e.side, e.index);
        }
        await pause(hasText ? 480 : 40);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Rendu : cadre                                                       */
  /* ------------------------------------------------------------------ */

  const ICONS = {
    sound:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9h4l5-4v14l-5-4H4z" fill="currentColor"/><path d="M16 8.5a5 5 0 0 1 0 7M18.5 6a8.5 8.5 0 0 1 0 12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
    mute:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9h4l5-4v14l-5-4H4z" fill="currentColor"/><path d="M16.5 9.5l5 5m0-5l-5 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>'
  };

  function renderTop() {
    const top = document.getElementById('kd-top');
    if (!top) return;
    const live = app.match && !isOver(app.match);
    const tabs = [
      ['collection', 'Collection'],
      ['salon', 'Salon'],
      ['combat', 'Combat'],
      ['regles', 'Règles']
    ]
      .map(
        ([id, label]) =>
          `<button class="kd-tab ${app.screen === id ? 'is-active' : ''}" type="button" data-act="screen" data-screen="${id}">${esc(label)}${
            id === 'combat' && live ? '<i class="kd-live" title="Duel en cours"></i>' : ''
          }</button>`
      )
      .join('');
    const profile = app.profile
      ? `<span class="kd-who" title="${app.profile.test ? 'Profil de test : page ouverte hors extension' : 'Profil transmis par le panneau Kyareeh+'}">${esc(app.profile.name)}${
          app.profile.test ? ' <em>test</em>' : ''
        }</span>`
      : '<span class="kd-who is-missing" title="Ouvre le panneau Kyareeh+ sur kyara.games pour transmettre ta collection">Profil absent</span>';
    top.innerHTML = `
      <div class="kd-brand"><span class="kd-mark" aria-hidden="true"></span><b>Kyara Duel</b></div>
      <nav class="kd-tabs">${tabs}</nav>
      <div class="kd-tools">
        ${profile}
      </div>`;
  }

  function render() {
    renderTop();
    const main = document.getElementById('kd-main');
    if (!main) return;
    document.body.dataset.screen = app.screen;
    if (app.screen === 'combat') {
      renderCombat();
    } else {
      const fn = { salon: viewSalon, regles: viewRules }[app.screen] || viewCollection;
      const scroll = main.scrollTop;
      main.innerHTML = fn();
      main.scrollTop = scroll;
    }
    renderModal();
  }

  function notify(message) {
    const el = document.getElementById('kd-toast');
    if (!el) return;
    el.textContent = message;
    el.hidden = false;
    clearTimeout(app.toastTimer);
    app.toastTimer = setTimeout(() => {
      el.hidden = true;
    }, 4200);
  }

  /* ------------------------------------------------------------------ */
  /* Rendu : collection et deck                                          */
  /* ------------------------------------------------------------------ */

  function typeBadge(champ, extraClass) {
    const t = typeInfo(champ);
    return `<span class="kd-type ${extraClass || ''}" style="--t:${esc(t.color)}">${esc(t.label)}</span>`;
  }

  function deckSlots() {
    const owned = ownedSet();
    return Array.from({ length: DECK_SIZE }, (_, i) => {
      const card = app.deck[i] ? cardById(app.deck[i]) : null;
      if (!card) return `<div class="kd-slot is-empty"><span>${i + 1}</span></div>`;
      const t = typeInfo(card);
      const unowned = !owned.has(String(card.id));
      return `<button class="kd-slot ${unowned ? 'is-unowned' : ''}" type="button" data-act="pick" data-id="${esc(card.id)}" style="--t:${esc(t.color)}" title="${esc(card.name)}${unowned ? ' : non possédée, entraînement uniquement' : ''} (retirer)">
          <img src="${esc(card.image)}" alt="">
          <span>${esc(card.name)}</span>
        </button>`;
    }).join('');
  }

  function viewCollection() {
    const all = cards();
    const owned = ownedSet();
    const query = String(app.query || '').trim().toLowerCase();
    const seriesList = [...new Set(all.map((c) => c.series).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    const typeList = [...new Set(all.map((c) => typeInfo(c).key).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    const filtered = all.filter((c) => {
      if (app.ownedOnly && !owned.has(String(c.id))) return false;
      if (app.series !== 'all' && c.series !== app.series) return false;
      if (app.type !== 'all' && typeInfo(c).key !== app.type) return false;
      if (query && !String(c.name).toLowerCase().includes(query) && !String(c.series || '').toLowerCase().includes(query)) return false;
      return true;
    });
    const ownedCount = all.filter((c) => owned.has(String(c.id))).length;
    const grid = filtered
      .map((c) => {
        const t = typeInfo(c);
        const mine = owned.has(String(c.id));
        const picked = app.deck.includes(String(c.id));
        return `<article class="kd-cc ${mine ? '' : 'is-unowned'} ${picked ? 'is-picked' : ''}" style="--t:${esc(t.color)}">
            <button class="kd-cc-art" type="button" data-act="card" data-id="${esc(c.id)}" title="Fiche de ${esc(c.name)}">
              <img src="${esc(c.image)}" alt="" loading="lazy">
              ${typeBadge(c, 'is-corner')}
            </button>
            <div class="kd-cc-body">
              <b title="${esc(c.name)}">${esc(c.name)}</b>
              <span class="kd-cc-stats"><span>${fmt(c.hp)} PV</span><span>ATQ ${fmt(c.atk)}</span>${c.speed != null ? `<span>VIT ${fmt(c.speed)}</span>` : ''}</span>
              ${mine ? '' : '<span class="kd-cc-lock">Non possédée</span>'}
            </div>
            <button class="kd-cc-pick" type="button" data-act="pick" data-id="${esc(c.id)}" aria-pressed="${picked}" title="${picked ? 'Retirer du deck' : 'Ajouter au deck'}" ${!picked && app.deck.length >= DECK_SIZE ? 'disabled' : ''}>${picked ? 'Dans le deck' : 'Ajouter'}</button>
          </article>`;
      })
      .join('');
    const unownedInDeck = app.deck.filter((id) => !owned.has(id)).length;
    const profileNote = !app.profile
      ? '<p class="kd-note is-warn">Collection inconnue : ouvre le panneau Kyareeh+ sur kyara.games (connecté) pour transmettre tes Mythiques. L’entraînement reste possible avec toutes les cartes.</p>'
      : app.profile.test
        ? '<p class="kd-note">Page ouverte hors extension : profil de test « Harness » (8 Mythiques simulées).</p>'
        : '';
    return `<section class="kd-screen kd-collection">
        <div class="kd-deckbar">
          <div class="kd-deckbar-head">
            <h2>Ton équipe</h2>
            <p>${fmt(app.deck.length)} / ${DECK_SIZE} Mythiques${unownedInDeck ? `, dont ${fmt(unownedInDeck)} non possédée(s) : entraînement uniquement` : ''}</p>
          </div>
          <div class="kd-slots">${deckSlots()}</div>
          <div class="kd-deckbar-actions">
            <button class="kd-btn" type="button" data-act="fill" ${app.deck.length >= DECK_SIZE || !all.length ? 'disabled' : ''} title="Complète avec tes Mythiques possédées en priorité">Compléter au hasard</button>
            <button class="kd-btn is-ghost" type="button" data-act="clear" ${app.deck.length ? '' : 'disabled'}>Vider</button>
          </div>
        </div>
        ${profileNote}
        <div class="kd-filters">
          <input type="search" data-role="query" placeholder="Rechercher un nom ou une série" value="${esc(app.query)}" aria-label="Rechercher">
          <select data-role="type" aria-label="Type">
            <option value="all">Tous les types</option>
            ${typeList.map((t) => `<option value="${esc(t)}" ${app.type === t ? 'selected' : ''}>${esc(t)}</option>`).join('')}
          </select>
          <select data-role="series" aria-label="Série">
            <option value="all">Toutes les séries</option>
            ${seriesList.map((s) => `<option value="${esc(s)}" ${app.series === s ? 'selected' : ''}>${esc(s)}</option>`).join('')}
          </select>
          <label class="kd-check"><input type="checkbox" data-role="owned" ${app.ownedOnly ? 'checked' : ''}> Possédées (${app.profile ? fmt(ownedCount) : '—'})</label>
        </div>
        <p class="kd-count">${all.length ? `${fmt(filtered.length)} Mythique(s) sur ${fmt(all.length)}` : 'Données du duel indisponibles (content/duel-data.js non chargé).'}</p>
        <div class="kd-grid">${grid || (all.length ? '<p class="kd-empty">Aucune Mythique ne correspond à ces filtres.</p>' : '')}</div>
      </section>`;
  }

  function cardModal(card) {
    const t = typeInfo(card);
    const moves = (card.attacks || [])
      .map((m) => {
        const cost = moveCost(m);
        return `<li class="kd-mv is-${esc(m.kind || 'attack')}">
            <div class="kd-mv-head"><b>${esc(m.name)}</b><span>${esc(kindLabel(m.kind))}, ${cost ? `${fmt(cost)} chakra` : 'gratuit'}</span></div>
            ${m.desc ? `<p>${esc(m.desc)}</p>` : ''}
            <small>${esc(effectText(m))}</small>
          </li>`;
      })
      .join('');
    return `<div class="kd-sheet" role="dialog" aria-modal="true" aria-label="${esc(card.name)}" style="--t:${esc(t.color)}">
        <button class="kd-iconbtn kd-sheet-close" type="button" data-act="close-modal" title="Fermer">✕</button>
        <div class="kd-sheet-art"><img src="${esc(card.image)}" alt=""></div>
        <div class="kd-sheet-body">
          <h3>${esc(card.name)}</h3>
          <p class="kd-sheet-sub">${typeBadge(card)} <span>${esc(card.series || '')}</span></p>
          <div class="kd-sheet-stats"><span><b>${fmt(card.hp)}</b> PV</span><span><b>${fmt(card.atk)}</b> ATQ</span>${card.speed != null ? `<span><b>${fmt(card.speed)}</b> vitesse</span>` : ''}</div>
          <ul class="kd-mvlist">${moves}</ul>
          ${card.passive ? `<div class="kd-passive"><b>${esc(card.passive.name || 'Passif')}</b><p>${esc(card.passive.desc || '')}</p></div>` : ''}
        </div>
      </div>`;
  }

  function renderModal() {
    const el = document.getElementById('kd-modal');
    if (!el) return;
    const card = app.modal ? cardById(app.modal) : null;
    if (!card) {
      el.hidden = true;
      el.innerHTML = '';
      return;
    }
    el.hidden = false;
    el.innerHTML = cardModal(card);
  }

  /* ------------------------------------------------------------------ */
  /* Rendu : salon                                                       */
  /* ------------------------------------------------------------------ */

  function viewSalon() {
    const E = engine();
    const N = netApi();
    const live = app.match && !isOver(app.match);
    const issue = onlineDeckIssue();
    const net = app.net;
    const resume = live
      ? `<div class="kd-resume"><span>Un duel ${app.match.kind === 'practice' ? 'd’entraînement' : 'en ligne'} est en cours.</span><button class="kd-btn is-primary" type="button" data-act="screen" data-screen="combat">Reprendre le combat</button></div>`
      : '';
    const practiceNote = !E
      ? `<p class="kd-note is-bad">${esc(engineIssue())} Entraînement indisponible.</p>`
      : app.deck.length < DECK_SIZE
        ? `<p class="kd-note">Ton équipe compte ${fmt(app.deck.length)}/${DECK_SIZE} Mythiques : elle sera complétée au hasard pour cette partie.</p>`
        : '<p class="kd-note">Toutes les Mythiques sont permises, possédées ou non. La partie se joue dans ton navigateur, sans relais.</p>';

    let room = '';
    if (net) {
      const status = netStatus(net);
      const players = ((net.room && net.room.players) || [])
        .map((p) => `<li><b>${esc((p && p.name) || '—')}</b><span class="${p && p.ready ? 'is-ok' : ''}">${p && p.ready ? 'prêt' : 'en attente'}</span></li>`)
        .join('');
      const roomStatus = { waiting: 'en attente d’un adversaire', playing: 'duel en cours', ended: 'terminé' }[net.room && net.room.status] || '';
      room = `<div class="kd-room">
          <div class="kd-room-line">
            <span>Relais : <b class="kd-netstatus" data-role="net-status" data-status="${esc(status)}">${esc(NET_STATUS[status])}</b></span>
            <button class="kd-btn is-ghost is-small" type="button" data-act="leave-room">Quitter le salon</button>
          </div>
          ${
            net.room && net.room.code
              ? `<div class="kd-code"><span>Code du salon</span><b>${esc(net.room.code)}</b><button class="kd-btn is-small" type="button" data-act="copy-code">Copier</button></div>
                 <p class="kd-note">Salon ${esc(roomStatus)}.</p>
                 <ul class="kd-players">${players}</ul>`
              : net.error
                ? ''
                : `<p class="kd-note">${net.intent && net.intent.type === 'join' ? `Connexion au salon ${esc(net.intent.code)}…` : 'Création du salon…'}</p>`
          }
          ${net.peer === 'left' ? '<p class="kd-note is-warn">Ton adversaire s’est déconnecté : il a 60 s pour revenir.</p>' : ''}
          ${net.error ? `<p class="kd-note is-bad">${esc(net.error)}</p>` : ''}
        </div>`;
    }

    return `<section class="kd-screen kd-salon">
        ${resume}
        <div class="kd-salon-grid">
          <article class="kd-panel is-team">
            <h2>Ton équipe</h2>
            <div class="kd-slots is-compact">${deckSlots()}</div>
            <div class="kd-row">
              <button class="kd-btn" type="button" data-act="screen" data-screen="collection">Modifier l’équipe</button>
              ${app.deck.length < DECK_SIZE ? '<button class="kd-btn is-ghost" type="button" data-act="fill">Compléter au hasard</button>' : ''}
            </div>
            <p class="kd-note ${issue ? 'is-warn' : 'is-ok'}">${issue ? `En ligne : ${esc(issue)}` : 'Équipe prête pour le duel en ligne.'}</p>
          </article>
          <article class="kd-panel is-practice">
            <h2>Entraînement</h2>
            <p class="kd-lede">Un duel contre l’IA, à ton rythme, sans minuteur.</p>
            ${practiceNote}
            <button class="kd-btn is-primary is-big" type="button" data-act="practice" ${E && !live ? '' : 'disabled'}>Affronter l’IA</button>
          </article>
          <article class="kd-panel is-online">
            <h2>En ligne</h2>
            <p class="kd-lede">Crée un salon et partage son code de 5 lettres, ou rejoins celui d’un ami.</p>
            ${room}
            <label class="kd-lbl">Adresse du relais
              <input data-role="relay" placeholder="wss://…" value="${esc(app.relay)}" spellcheck="false" autocomplete="off">
            </label>
            ${
              relayConfigured()
                ? ''
                : '<p class="kd-note is-warn">Aucun serveur de jeu configuré : le duel en ligne a besoin de l’adresse d’un relais <b>wss://…</b> (serveur du dépôt, dossier <code>relay/</code>). L’entraînement contre l’IA reste disponible.</p>'
            }
            ${app.relayError ? `<p class="kd-note is-bad">${esc(app.relayError)}</p>` : ''}
            <div class="kd-row">
              <button class="kd-btn is-primary" type="button" data-act="create" ${N && !live ? '' : 'disabled'}>Créer un salon</button>
              <input class="kd-codein" data-role="code" placeholder="CODE" maxlength="5" value="${esc(app.code)}" spellcheck="false" autocomplete="off" aria-label="Code du salon">
              <button class="kd-btn" type="button" data-act="join" ${N && !live ? '' : 'disabled'}>Rejoindre</button>
            </div>
            ${N ? '' : '<p class="kd-note is-bad">Client réseau non chargé (content/duel-net.js) : duel en ligne indisponible.</p>'}
          </article>
        </div>
      </section>`;
  }

  /* ------------------------------------------------------------------ */
  /* Rendu : combat                                                      */
  /* ------------------------------------------------------------------ */

  function hpClass(pct) {
    return pct > 50 ? 'is-high' : pct > 20 ? 'is-mid' : 'is-low';
  }

  function hpOf(champ) {
    const max = Math.max(1, Number((champ && (champ.maxHp ?? champ.hp)) || 1));
    const hp = Math.max(0, Number((champ && champ.hp) || 0));
    return { hp, max, pct: Math.max(0, Math.min(100, Math.round((hp / max) * 100))) };
  }

  function chipsHtml(champ) {
    if (!champ) return '';
    const out = [];
    if (Number(champ.guard) > 0) out.push(`<span class="kd-chip is-guard" title="Garde : absorbe les dégâts">Garde ${fmt(champ.guard)}</span>`);
    if (Number(champ.atkBonus) > 0) out.push(`<span class="kd-chip is-atk">+${fmt(champ.atkBonus)} ATQ</span>`);
    if (Number(champ.buff) > 0) out.push(`<span class="kd-chip is-buff">+${fmt(champ.buff)} préparés</span>`);
    for (const [key, value] of Object.entries(champ.statuses || {})) {
      if (!value) continue;
      const turns = typeof value === 'number' && key !== 'haste' ? ` ${fmt(value)}` : '';
      out.push(`<span class="kd-chip is-${esc(String(key).replace(/[^a-z]/gi, ''))}">${esc(STATUS_LABELS[key] || key)}${turns}</span>`);
    }
    if (Number(champ.invincible) > 0) out.push(`<span class="kd-chip is-guard">Invulnérable ${fmt(champ.invincible)}</span>`);
    if (champ.attackBlock) out.push('<span class="kd-chip is-guard">Contre prêt</span>');
    if (champ.saveLethal) out.push('<span class="kd-chip is-regen">Survie 1 PV</span>');
    if (Number(champ.disabled) > 0) out.push(`<span class="kd-chip is-skip">Sans attaque ${fmt(champ.disabled)}</span>`);
    if (champ.ultimateUsed) out.push('<span class="kd-chip is-ult">Ultime utilisé</span>');
    return out.join('');
  }

  function chakraHtml(player) {
    const max = ruleValue('maxChakra', 5);
    const chakra = Math.max(0, Number((player && player.chakra) || 0));
    const pips = Array.from({ length: Math.max(max, chakra) }, (_, i) => `<i class="${i < chakra ? 'is-on' : ''}"></i>`).join('');
    return `<span class="kd-pips" aria-hidden="true">${pips}</span><em>${fmt(chakra)}</em>`;
  }

  function targetSet() {
    const match = app.match;
    const sel = match && match.sel;
    if (!sel || sel.mode !== 'target') return new Set();
    return new Set(
      legalFor(match)
        .filter((a) => a && a.type === 'move' && a.move === sel.move && a.target)
        .map((a) => `${a.target.side}:${a.target.index}`)
    );
  }

  function benchHtml(view, side, targets) {
    const player = view.players[side] || {};
    const active = activeIndex(player);
    return (player.champions || [])
      .map((c, i) => {
        if (i === active) return '';
        const { pct } = hpOf(c);
        const alive = isAlive(c);
        const t = typeInfo(c);
        const key = `${side}:${i}`;
        const isTarget = targets.has(key);
        const image = c.image || (cardById(c.id) || {}).image || '';
        return `<button class="kd-thumb ${alive ? '' : 'is-ko'} ${isTarget ? 'is-target' : ''}" type="button" data-champ="${key}" data-act="${isTarget ? 'target' : 'info'}" data-side="${side}" data-index="${i}" data-id="${esc(c.id)}" style="--t:${esc(t.color)}" title="${esc(c.name || '')} : ${alive ? `${fmt(c.hp)} / ${fmt(hpOf(c).max)} PV` : 'K.O.'}">
            ${image ? `<img src="${esc(image)}" alt="">` : ''}
            <i class="kd-mini-hp"><b class="${hpClass(pct)}" style="width:${pct}%"></b></i>
            ${alive ? '' : '<span class="kd-ko-tag">K.O.</span>'}
          </button>`;
      })
      .join('');
  }

  function hudHtml(view, side) {
    const player = view.players[side] || {};
    const champ = champAt(view, side, activeIndex(player));
    const { hp, max, pct } = hpOf(champ);
    const mine = app.match && side === app.match.you;
    return `<div class="kd-plate">
        <div class="kd-plate-top">
          <b class="kd-name" title="${esc((champ && champ.name) || '')}">${esc((champ && champ.name) || '—')}</b>
          ${champ ? typeBadge(champ) : ''}
        </div>
        <div class="kd-hpbar" role="meter" aria-label="Points de vie" aria-valuemin="0" aria-valuemax="${max}" aria-valuenow="${hp}">
          <span class="kd-hp-label">PV</span>
          <span class="kd-hp-track"><i class="kd-hp-fill ${hpClass(pct)}" style="width:${pct}%"></i></span>
        </div>
        <div class="kd-plate-bottom">
          <span class="kd-hp-num">${fmt(hp)} / ${fmt(max)}</span>
          <span class="kd-chips">${chipsHtml(champ)}</span>
        </div>
      </div>
      <div class="kd-owner">
        <span class="kd-owner-name">${esc(player.name || (mine ? 'Toi' : 'Adversaire'))}${mine ? ' <small>(toi)</small>' : ''}</span>
        ${player.skipNext ? '<span class="kd-chip is-skip">Perd sa prochaine action</span>' : ''}
        <span class="kd-chakra" data-chakra="${side}" title="Chakra">${chakraHtml(player)}</span>
      </div>`;
  }

  function sideHtml(view, side, targets) {
    const player = view.players[side] || {};
    const index = activeIndex(player);
    const champ = champAt(view, side, index);
    const t = typeInfo(champ);
    const key = `${side}:${index}`;
    const isTarget = targets.has(key);
    const alive = isAlive(champ);
    const image = (champ && (champ.image || (cardById(champ.id) || {}).image)) || '';
    return `<div class="kd-hud" data-hud="${side}">${hudHtml(view, side)}</div>
      <div class="kd-bench" data-bench="${side}">${benchHtml(view, side, targets)}</div>
      <div class="kd-stage" style="--t:${esc(t.color)}">
        <div class="kd-seal" aria-hidden="true"></div>
        ${
          champ
            ? `<button class="kd-card ${alive ? '' : 'is-ko'} ${isTarget ? 'is-target' : ''}" type="button" data-champ="${key}" data-act="${isTarget ? 'target' : 'info'}" data-side="${side}" data-index="${index}" data-id="${esc(champ.id)}" style="--t:${esc(t.color)}" title="${esc(champ.name || '')}">
                ${image ? `<img src="${esc(image)}" alt="">` : '<span class="kd-card-blank"></span>'}
                <span class="kd-card-foot">${esc(champ.name || '')}</span>
              </button>`
            : ''
        }
      </div>`;
  }

  function renderSide(side) {
    const view = app.view;
    const el = document.querySelector(`.kd-side[data-side="${side}"]`);
    if (!el || !view || !view.players) return;
    el.innerHTML = sideHtml(view, side, app.playing ? new Set() : targetSet());
  }

  /** Mise à jour en place (les barres de PV glissent au lieu d'être recréées). */
  function refreshChamp(side, index) {
    const view = app.view;
    if (!view || !view.players || side == null || index == null) return;
    const player = view.players[side];
    const champ = champAt(view, side, index);
    if (!player || !champ) return;
    const { hp, max, pct } = hpOf(champ);
    if (activeIndex(player) === Number(index)) {
      const hud = document.querySelector(`[data-hud="${side}"]`);
      if (!hud) return;
      const fill = hud.querySelector('.kd-hp-fill');
      if (fill) {
        fill.style.width = `${pct}%`;
        fill.className = `kd-hp-fill ${hpClass(pct)}`;
      }
      const num = hud.querySelector('.kd-hp-num');
      if (num) num.textContent = `${fmt(hp)} / ${fmt(max)}`;
      const chips = hud.querySelector('.kd-chips');
      if (chips) chips.innerHTML = chipsHtml(champ);
      const meter = hud.querySelector('.kd-hpbar');
      if (meter) meter.setAttribute('aria-valuenow', String(hp));
      const card = champEl(side, index);
      if (card) card.classList.toggle('is-ko', !isAlive(champ));
    } else {
      const thumb = champEl(side, index);
      if (!thumb) return;
      const bar = thumb.querySelector('.kd-mini-hp b');
      if (bar) {
        bar.style.width = `${pct}%`;
        bar.className = hpClass(pct);
      }
      thumb.classList.toggle('is-ko', !isAlive(champ));
    }
  }

  function refreshChakra(side) {
    const view = app.view;
    const el = document.querySelector(`[data-chakra="${side}"]`);
    if (el && view && view.players && view.players[side]) el.innerHTML = chakraHtml(view.players[side]);
  }

  function endHtml(match) {
    const winner = winnerOf(match);
    const reasonKey = (match.ended && match.ended.reason) || (match.state && (match.state.endReason || match.state.reason)) || '';
    const lost = (winner === 0 || winner === 1) && winner !== match.you;
    let title = 'Match nul';
    let cls = 'is-draw';
    if (winner === match.you) {
      title = 'Victoire';
      cls = 'is-win';
    } else if (winner === 0 || winner === 1) {
      title = 'Défaite';
      cls = 'is-loss';
    }
    let why = END_REASONS[reasonKey] || (reasonKey ? String(reasonKey) : '');
    if (reasonKey === 'ko' && lost) why = 'tous tes champions sont K.O.';
    if (reasonKey === 'forfeit') why = lost ? 'tu as abandonné' : 'ton adversaire a abandonné';
    if (reasonKey === 'timeout' && winner === match.you) why = 'ton adversaire est absent depuis trop longtemps';
    return `<div class="kd-end ${cls}">
        <b>${esc(title)}</b>
        ${why ? `<span>${esc(why.charAt(0).toUpperCase() + why.slice(1).replace(/\.+$/, ''))}.</span>` : ''}
      </div>`;
  }

  function commandHtml(match) {
    const view = app.view;
    const you = match.you;
    const over = isOver(match);
    const phase = phaseOf(match);
    const me = view.players[you] || {};
    const active = champAt(view, you, activeIndex(me));
    const foeActive = champAt(view, 1 - you, activeIndex(view.players[1 - you] || {}));
    const error = match.error ? `<p class="kd-note is-bad">${esc(match.error)}</p>` : '';

    if (app.playing) {
      return `<div class="kd-say is-playing" data-act="speed" title="Clique pour accélérer">
          <p id="kd-say-text" class="is-new">${esc((match.log[match.log.length - 1] || {}).text || '…')}</p>
          <span class="kd-say-hint">${app.fast ? 'Accéléré' : 'Clic : accélérer'}</span>
        </div>`;
    }

    if (over) {
      const waiting = match.kind === 'online' && app.net && app.net.rematchAsked;
      return `<div class="kd-say"><p id="kd-say-text">${esc((match.log[match.log.length - 1] || {}).text || 'Duel terminé.')}</p></div>
        <div class="kd-menu is-end">
          <button class="kd-btn is-primary is-big" type="button" data-act="replay" ${waiting ? 'disabled' : ''}>${match.kind === 'online' ? (waiting ? 'Revanche demandée…' : 'Revanche') : 'Rejouer'}</button>
          <button class="kd-btn" type="button" data-act="lobby">Retour au salon</button>
        </div>`;
    }

    const issue = match.kind === 'practice' ? engineIssue() : '';
    if (issue) return `<div class="kd-say"><p id="kd-say-text">${esc(issue)}</p></div>`;

    const legal = legalFor(match);
    const switches = legal.filter((a) => a && a.type === 'switch');

    // Remplacement obligatoire après un K.O.
    if (phase === 'replace' && myChoiceNeeded(match)) {
      return `<div class="kd-say is-urgent"><p id="kd-say-text">${esc(active && !isAlive(active) ? `${active.name} est K.O. ` : '')}Qui envoies-tu au combat ?</p>${error}</div>
        <div class="kd-menu is-picker">${switchPicker(view, you, switches, false)}</div>`;
    }

    if (!myChoiceNeeded(match)) {
      const pending = pendingOf(match);
      let text = 'En attente de l’adversaire…';
      if (match.kind === 'practice') text = 'L’IA réfléchit…';
      else if (match.submitted && match.foeChosen) text = 'Les deux camps ont choisi : résolution…';
      else if (!match.submitted && !pending.includes(you) && phase === 'replace') text = 'Ton adversaire choisit son remplaçant…';
      return `<div class="kd-say is-waiting"><p id="kd-say-text">${esc(text)}</p>${
        match.kind === 'online' && match.foeChosen && !match.submitted ? '<span class="kd-say-hint">L’adversaire a choisi.</span>' : ''
      }${error}</div>`;
    }

    const sel = match.sel;
    if (sel && sel.mode === 'switch') {
      return `<div class="kd-say"><p id="kd-say-text">Qui remplace ${esc((active && active.name) || 'ton champion')} ?</p>${error}</div>
        <div class="kd-menu is-picker">${switchPicker(view, you, switches, true)}</div>`;
    }
    if (sel && sel.mode === 'target') {
      const move = movesOf(active)[sel.move] || {};
      return `<div class="kd-say"><p id="kd-say-text">${esc(move.name || 'Capacité')} : choisis une cible sur le terrain.</p>${error}</div>
        <div class="kd-menu is-picker"><button class="kd-btn is-ghost" type="button" data-act="cancel">Retour</button></div>`;
    }

    const chakra = Number(me.chakra || 0);
    const buttons = movesOf(active)
      .slice(0, 3)
      .map((move, k) => {
        const options = legal.filter((a) => a && a.type === 'move' && a.move === k);
        const ok = options.length > 0;
        const cost = moveCost(move);
        let why = '';
        if (!ok) {
          if (move.kind === 'ultimate' && active && active.ultimateUsed) why = 'Ultime déjà utilisé';
          else if (cost > chakra) why = 'Chakra insuffisant';
          else if (active && Number(active.disabled) > 0 && move.kind !== 'support') why = 'Ne peut plus attaquer';
          else why = 'Indisponible';
        }
        const offensive = Boolean(move.damage || move.randomDamage);
        const mult = offensive && foeActive ? effectiveness(active, foeActive) : 1;
        const eff = mult > 1 ? '<span class="kd-eff is-up">efficace</span>' : mult < 1 ? '<span class="kd-eff is-down">peu efficace</span>' : '';
        const costPips = cost ? `<span class="kd-cost" title="${fmt(cost)} chakra">${'<i></i>'.repeat(Math.min(cost, 8))}</span>` : '<span class="kd-cost is-free">gratuit</span>';
        return `<button class="kd-move is-${esc(move.kind || 'attack')}" type="button" data-act="move" data-move="${k}" ${ok ? '' : 'disabled'} title="${esc(move.desc || '')}">
            <span class="kd-move-top"><b>${esc(move.name || '—')}</b>${costPips}</span>
            <span class="kd-move-fx">${esc(effectText(move))}</span>
            <span class="kd-move-foot"><span>${esc(kindLabel(move.kind))}</span>${ok ? eff : `<em>${esc(why)}</em>`}<kbd>${k + 1}</kbd></span>
          </button>`;
      })
      .join('');
    const canSwitch = switches.length > 0;
    const canPass = legal.some((a) => a && a.type === 'pass');
    return `<div class="kd-say"><p id="kd-say-text">Que doit faire ${esc((active && active.name) || 'ton champion')} ?</p>${error}</div>
      <div class="kd-menu">
        <div class="kd-moves">
          ${buttons}
          <button class="kd-move is-switch" type="button" data-act="switch" ${canSwitch ? '' : 'disabled'}>
            <span class="kd-move-top"><b>Changer</b></span>
            <span class="kd-move-fx">${canSwitch ? 'Rappeler et envoyer un champion du banc (consomme le tour)' : 'Aucun champion disponible sur le banc'}</span>
            <span class="kd-move-foot"><span>Banc</span><kbd>C</kbd></span>
          </button>
        </div>
        ${canPass ? '<button class="kd-pass" type="button" data-act="pass">Passer le tour</button>' : ''}
      </div>`;
  }

  function switchPicker(view, side, switches, cancellable) {
    const allowed = new Map(switches.map((a) => [Number(a.to), a]));
    const player = view.players[side] || {};
    const active = activeIndex(player);
    const options = (player.champions || [])
      .map((c, i) => {
        if (i === active && isAlive(c)) return '';
        const ok = allowed.has(i);
        const { hp, max, pct } = hpOf(c);
        const t = typeInfo(c);
        const image = c.image || (cardById(c.id) || {}).image || '';
        return `<button class="kd-pick ${isAlive(c) ? '' : 'is-ko'}" type="button" data-act="do-switch" data-to="${i}" ${ok ? '' : 'disabled'} style="--t:${esc(t.color)}">
            ${image ? `<img src="${esc(image)}" alt="">` : ''}
            <span class="kd-pick-body">
              <b>${esc(c.name || '—')}</b>
              ${typeBadge(c)}
              <span class="kd-mini-hp is-wide"><b class="${hpClass(pct)}" style="width:${pct}%"></b></span>
              <small>${isAlive(c) ? `${fmt(hp)} / ${fmt(max)} PV` : 'K.O.'}</small>
            </span>
          </button>`;
      })
      .join('');
    return `<div class="kd-picks">${options}</div>${cancellable ? '<button class="kd-btn is-ghost is-small" type="button" data-act="cancel">Retour</button>' : ''}`;
  }

  function renderCombat() {
    const main = document.getElementById('kd-main');
    if (!main) return;
    const match = app.match;
    if (!match) {
      const issue = engineIssue();
      main.innerHTML = `<section class="kd-screen kd-nobattle">
          <div class="kd-nobattle-card">
            <h2>Aucun duel en cours</h2>
            <p>Lance un entraînement contre l’IA, ou rejoins un salon en ligne depuis le Salon.</p>
            <div class="kd-row is-center">
              <button class="kd-btn is-primary is-big" type="button" data-act="practice" ${issue ? 'disabled' : ''}>Affronter l’IA</button>
              <button class="kd-btn" type="button" data-act="screen" data-screen="salon">Aller au salon</button>
            </div>
            ${issue ? `<p class="kd-note is-bad">${esc(issue)}</p>` : ''}
          </div>
        </section>`;
      return;
    }
    if (!app.view || !Array.isArray(app.view.players)) app.view = viewOf(match) || { players: [] };
    const view = app.view;
    const you = match.you;
    const foe = 1 - you;
    const over = isOver(match);
    const targets = app.playing ? new Set() : targetSet();
    const maxRounds = ruleValue('maxTurns', ruleValue('maxRounds', 30));
    const phase = phaseOf(match);
    let timer = '';
    if (match.kind === 'online' && match.deadlineAt && !over) {
      const left = Math.max(0, Math.ceil((match.deadlineAt - Date.now()) / 1000));
      timer = `<span class="kd-timer ${left <= 10 ? 'is-urgent' : ''}" data-role="timer" title="${phase === 'replace' ? 'Remplaçant automatique à 0' : 'Passe automatique à 0'}">${fmt(left)} s</span>`;
    }
    const mode =
      match.kind === 'practice'
        ? '<span class="kd-mode">Entraînement</span>'
        : `<span class="kd-mode is-online">En ligne${app.net && app.net.room && app.net.room.code ? ` · ${esc(app.net.room.code)}` : ''}</span>`;
    const log = match.log.map((entry) => `<li class="${entry.type ? `is-${esc(entry.type)}` : ''}">${esc(entry.text)}</li>`).join('');
    const logScroll = (() => {
      const old = document.getElementById('kd-log-list');
      return old ? { top: old.scrollTop, bottom: old.scrollHeight - old.scrollTop - old.clientHeight < 24 } : null;
    })();

    main.innerHTML = `<section class="kd-battle ${app.logOpen ? 'has-log' : ''} ${app.playing ? 'is-playing' : ''}">
        <div class="kd-bar">
          <span class="kd-roundbox">Tour <b id="kd-round">${fmt(view.round ?? match.state.round ?? 0)}</b><small>/ ${fmt(maxRounds)}</small></span>
          ${mode}
          ${timer}
          ${match.filled ? '<span class="kd-mode is-muted" title="Ton équipe comptait moins de 5 Mythiques">Équipe complétée au hasard</span>' : ''}
          ${app.net && app.net.peer === 'left' && match.kind === 'online' && !over ? '<span class="kd-mode is-warn">Adversaire déconnecté (60 s pour revenir)</span>' : ''}
          <span class="kd-spacer"></span>
          <button class="kd-btn is-ghost is-small" type="button" data-act="log" aria-expanded="${app.logOpen}">Journal</button>
          ${over ? '' : `<button class="kd-btn is-danger is-small" type="button" data-act="forfeit">${match.forfeitArmed ? 'Confirmer l’abandon' : 'Abandonner'}</button>`}
        </div>
        <div class="kd-field" id="kd-field">
          <div class="kd-side is-foe" data-side="${foe}">${sideHtml(view, foe, targets)}</div>
          <div class="kd-side is-mine" data-side="${you}">${sideHtml(view, you, targets)}</div>
          <div class="kd-banner" id="kd-banner"></div>
          ${over && !app.playing ? endHtml(match) : ''}
        </div>
        <div class="kd-command" id="kd-command">${commandHtml(match)}</div>
        <aside class="kd-log" id="kd-log" ${app.logOpen ? '' : 'hidden'}>
          <div class="kd-log-head"><b>Journal</b><button class="kd-iconbtn" type="button" data-act="log" title="Fermer le journal">✕</button></div>
          <ol id="kd-log-list">${log || '<li class="is-empty">Le duel commence.</li>'}</ol>
        </aside>
      </section>`;
    const list = document.getElementById('kd-log-list');
    if (list) list.scrollTop = !logScroll || logScroll.bottom ? list.scrollHeight : logScroll.top;
  }

  function renderCommand() {
    const el = document.getElementById('kd-command');
    if (el && app.match && app.view) el.innerHTML = commandHtml(app.match);
  }

  function appendLogLine(entry) {
    const list = document.getElementById('kd-log-list');
    if (!list || !entry) return;
    const empty = list.querySelector('.is-empty');
    if (empty) empty.remove();
    const li = document.createElement('li');
    if (entry.type) li.className = `is-${entry.type}`;
    li.textContent = entry.text;
    const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 24;
    list.appendChild(li);
    if (atBottom) list.scrollTop = list.scrollHeight;
  }

  /* ------------------------------------------------------------------ */
  /* Rendu : règles                                                      */
  /* ------------------------------------------------------------------ */

  function ruleSections() {
    const R = window.KYARA_DUEL_RULES;
    const list = Array.isArray(R) ? R : R && Array.isArray(R.sections) ? R.sections : null;
    return list ? list.filter((s) => s && typeof s === 'object') : null;
  }

  function ruleParagraph(text) {
    const lines = String(text ?? '').split('\n');
    const inline = (value) => esc(value).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
    const isBullet = (line) => /^\s*[-•]\s+/.test(line);
    if (!lines.some(isBullet)) return `<p>${inline(String(text ?? ''))}</p>`;
    let html = '';
    let open = false;
    for (const line of lines) {
      if (isBullet(line)) {
        if (!open) html += '<ul>';
        open = true;
        html += `<li>${inline(line.replace(/^\s*[-•]\s+/, ''))}</li>`;
      } else if (line.trim()) {
        if (open) html += '</ul>';
        open = false;
        html += `<p>${inline(line)}</p>`;
      }
    }
    return open ? `${html}</ul>` : html;
  }

  function viewRules() {
    const sections = ruleSections();
    if (!sections || !sections.length) {
      return '<section class="kd-screen"><p class="kd-empty">Livre de règles indisponible : content/duel-rules.js n’est pas chargé.</p></section>';
    }
    const titleOf = (s, i) => String(s.titre ?? s.title ?? `Section ${i + 1}`);
    const toc = sections
      .map((s, i) => `<li><button type="button" data-act="rule-goto" data-index="${i}">${esc(titleOf(s, i))}</button></li>`)
      .join('');
    const body = sections
      .map((s, i) => {
        const paragraphs = Array.isArray(s.paragraphes) ? s.paragraphes : Array.isArray(s.paragraphs) ? s.paragraphs : [];
        return `<section class="kd-rule" id="kd-rule-${i}"><h3>${esc(titleOf(s, i))}</h3>${paragraphs.map(ruleParagraph).join('')}</section>`;
      })
      .join('');
    const typeTable = Object.entries(types())
      .map(([key, info]) => `<span class="kd-type" style="--t:${esc((info && info.color) || NEUTRAL_COLOR)}">${esc((info && info.label) || key)}</span>`)
      .join('');
    return `<section class="kd-screen kd-rules">
        <nav class="kd-toc" aria-label="Sommaire"><b>Sommaire</b><ol>${toc}</ol><div class="kd-toc-types">${typeTable}</div></nav>
        <div class="kd-rules-body">${body}</div>
      </section>`;
  }

  /* ------------------------------------------------------------------ */
  /* Événements                                                          */
  /* ------------------------------------------------------------------ */

  function chooseMove(k) {
    const match = app.match;
    if (!myChoiceNeeded(match)) return;
    const options = legalFor(match).filter((a) => a && a.type === 'move' && a.move === k);
    if (!options.length) return;
    if (options.length === 1) {
      play(options[0]);
      return;
    }
    // Plusieurs cibles possibles (soutien sur le banc, etc.) : on désigne sur le terrain.
    match.sel = { mode: 'target', move: k };
    sound('select');
    renderCombat();
  }

  function onClick(event) {
    const el = event.target.closest('[data-act]');
    if (!el) {
      if (event.target.id === 'kd-modal') {
        app.modal = null;
        renderModal();
      }
      return;
    }
    const act = el.getAttribute('data-act');
    const match = app.match;
    switch (act) {
      case 'screen': {
        const next = el.getAttribute('data-screen');
        if (['collection', 'salon', 'combat', 'regles'].includes(next) && next !== app.screen) {
          app.screen = next;
          const main = document.getElementById('kd-main');
          if (main) main.scrollTop = 0;
          render();
        }
        break;
      }
      case 'card':
      case 'info': {
        const id = el.getAttribute('data-id');
        if (id && cardById(id)) {
          app.modal = id;
          renderModal();
        }
        break;
      }
      case 'close-modal':
        app.modal = null;
        renderModal();
        break;
      case 'pick': {
        const id = String(el.getAttribute('data-id') || '');
        if (!isMythic(id)) break;
        if (app.deck.includes(id)) app.deck = app.deck.filter((x) => x !== id);
        else if (app.deck.length < DECK_SIZE) app.deck = [...app.deck, id];
        persistPrefs();
        render();
        break;
      }
      case 'fill':
        app.deck = fillDeck(app.deck, { preferOwned: true });
        persistPrefs();
        render();
        break;
      case 'clear':
        app.deck = [];
        persistPrefs();
        render();
        break;
      case 'practice':
        startPractice();
        break;
      case 'create':
        connect({ type: 'create' });
        break;
      case 'join': {
        const input = $('[data-role="code"]');
        if (input) app.code = String(input.value || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 5);
        connect({ type: 'join', code: app.code });
        break;
      }
      case 'copy-code': {
        const code = app.net && app.net.room && app.net.room.code;
        if (!code) break;
        Promise.resolve(navigator.clipboard && navigator.clipboard.writeText(code))
          .then(() => notify(`Code ${code} copié.`))
          .catch(() => notify(`Code du salon : ${code}`));
        break;
      }
      case 'leave-room':
        if (match && match.kind === 'online' && !isOver(match)) forfeit();
        else {
          try {
            if (app.net && app.net.client) app.net.client.leave();
          } catch {
            /* ignore */
          }
        }
        closeNet();
        render();
        break;
      case 'move':
        chooseMove(Number(el.getAttribute('data-move')));
        break;
      case 'target': {
        if (!match || !match.sel || match.sel.mode !== 'target') break;
        const side = Number(el.getAttribute('data-side'));
        const index = Number(el.getAttribute('data-index'));
        const action = legalFor(match).find(
          (a) => a && a.type === 'move' && a.move === match.sel.move && a.target && a.target.side === side && a.target.index === index
        );
        if (action) play(action);
        break;
      }
      case 'switch':
        if (!myChoiceNeeded(match)) break;
        match.sel = { mode: 'switch' };
        sound('select');
        renderCombat();
        break;
      case 'do-switch': {
        const to = Number(el.getAttribute('data-to'));
        const action = legalFor(match).find((a) => a && a.type === 'switch' && Number(a.to) === to);
        if (action) play(action);
        break;
      }
      case 'cancel':
        if (match) match.sel = null;
        renderCombat();
        break;
      case 'pass': {
        const action = legalFor(match).find((a) => a && a.type === 'pass');
        if (action) play(action);
        break;
      }
      case 'speed':
        if (app.playing) {
          app.fast = true;
          const hint = document.querySelector('.kd-say-hint');
          if (hint) hint.textContent = 'Accéléré';
        }
        break;
      case 'log':
        app.logOpen = !app.logOpen;
        renderCombat();
        break;
      case 'forfeit':
        if (!match || isOver(match)) break;
        if (!match.forfeitArmed) {
          match.forfeitArmed = true;
          renderCombat();
          setTimeout(() => {
            if (app.match === match && match.forfeitArmed && !isOver(match)) {
              match.forfeitArmed = false;
              if (app.screen === 'combat' && !app.playing) renderCombat();
            }
          }, 4000);
          break;
        }
        match.forfeitArmed = false;
        forfeit();
        break;
      case 'replay':
        if (match && match.kind === 'online') rematch();
        else startPractice();
        break;
      case 'lobby':
        if (match && match.kind === 'online') closeNet();
        if (match && match.kind === 'practice') store.remove(SESSION_KEY);
        app.match = null;
        app.view = null;
        app.screen = 'salon';
        render();
        break;
      case 'rule-goto': {
        const target = document.getElementById(`kd-rule-${Number(el.getAttribute('data-index')) || 0}`);
        if (target) target.scrollIntoView({ behavior: REDUCED ? 'auto' : 'smooth', block: 'start' });
        break;
      }
      default:
        break;
    }
  }

  function onInput(event) {
    const t = event.target;
    const role = t && t.getAttribute && t.getAttribute('data-role');
    if (role === 'query') {
      app.query = t.value;
      const pos = t.selectionStart;
      render();
      const again = $('[data-role="query"]');
      if (again) {
        again.focus();
        try {
          again.setSelectionRange(pos, pos);
        } catch {
          /* type search */
        }
      }
    } else if (role === 'relay') {
      app.relay = String(t.value || '').trim();
      if (relayConfigured()) app.relayError = '';
      persistPrefs();
    } else if (role === 'code') {
      const clean = String(t.value || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 5);
      if (clean !== t.value) t.value = clean;
      app.code = clean;
    }
  }

  function onChange(event) {
    const t = event.target;
    const role = t && t.getAttribute && t.getAttribute('data-role');
    if (role === 'series') app.series = t.value;
    else if (role === 'type') app.type = t.value;
    else if (role === 'owned') app.ownedOnly = Boolean(t.checked);
    else return;
    render();
  }

  function onKey(event) {
    if (event.key === 'Escape') {
      if (app.modal) {
        app.modal = null;
        renderModal();
        return;
      }
      if (app.match && app.match.sel) {
        app.match.sel = null;
        renderCombat();
      }
      return;
    }
    if (app.screen !== 'combat' || event.altKey || event.ctrlKey || event.metaKey) return;
    const tag = String((event.target && event.target.tagName) || '').toLowerCase();
    if (tag === 'input' || tag === 'select' || tag === 'textarea') return;
    if (app.playing && (event.key === ' ' || event.key === 'Enter')) {
      app.fast = true;
      event.preventDefault();
      return;
    }
    const match = app.match;
    if (!myChoiceNeeded(match) || phaseOf(match) !== 'choose' || match.sel) return;
    if (/^[1-3]$/.test(event.key)) chooseMove(Number(event.key) - 1);
    else if (event.key.toLowerCase() === 'c') {
      const btn = $('[data-act="switch"]:not([disabled])');
      if (btn) btn.click();
    }
  }

  function tick() {
    const match = app.match;
    const timer = $('[data-role="timer"]');
    if (timer && match && match.deadlineAt) {
      const left = Math.max(0, Math.ceil((match.deadlineAt - Date.now()) / 1000));
      timer.textContent = `${left} s`;
      timer.classList.toggle('is-urgent', left <= 10);
    }
    const status = $('[data-role="net-status"]');
    if (status && app.net) {
      const key = netStatus(app.net);
      status.textContent = NET_STATUS[key];
      status.dataset.status = key;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Démarrage                                                           */
  /* ------------------------------------------------------------------ */

  async function boot() {
    document.body.classList.toggle('is-embed', EMBED);
    document.body.classList.toggle('is-window', !EMBED);
    await Promise.all([loadPrefs(), loadProfile()]);
    initFx();
    const resumed = await restorePractice();
    store.onChange((key, value) => {
      if (key === PROFILE_KEY) {
        applyProfile(value);
        if (!app.playing) render();
        else renderTop();
      } else if (key === SOUND_KEY) {
        applySound(value);
      }
    });
    const root = document.getElementById('kd-app');
    root.addEventListener('click', onClick);
    root.addEventListener('input', onInput);
    root.addEventListener('change', onChange);
    document.addEventListener('keydown', onKey);
    setInterval(tick, 1000);
    // Sauvegarde de l'entraînement en cours (Détacher / Rattacher du panneau, rechargement).
    window.addEventListener('pagehide', () => savePractice(app.match));
    render();
    if (resumed) {
      notify('Partie d’entraînement reprise.');
      practiceAdvance(app.match);
    }
    if (EMBED && window.parent !== window) {
      try {
        window.parent.postMessage({ type: 'kp-duel-ready' }, '*');
      } catch {
        /* ignore */
      }
    }
  }

  // Accès de test (console, navigateur automatisé).
  window.__kyaraDuel = { app, render, startPractice, play, legalFor: () => legalFor(app.match), store };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
