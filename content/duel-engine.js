// Kyara Duel — moteur de règles v2 (combat « à la Pokémon » : un champion actif par camp,
// banc de 4, changements, choix simultanés et secrets, chakra conservé).
// Fichier PUR : aucun DOM, réseau, stockage, horloge ni Math.random. L'état est un objet JSON
// simple ; aucune fonction ne modifie son entrée. Le hasard vient d'un PRNG (mulberry32) dont
// l'état vit dans state.rng : même graine + mêmes choix = même duel.
// Chargement : page/content script (window.KYARA_DUEL_ENGINE) ou Node (require / import par défaut).
// Règles complètes : content/duel-rules.js (window.KYARA_DUEL_RULES) et docs/REGLES-DUEL.md.
// Contrat : docs/DUEL-V2.md §1.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.KYARA_DUEL_ENGINE = api;
  else if (root) root.KYARA_DUEL_ENGINE = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // ─── Constantes réglables ─────────────────────────────────────────────────────────────────
  // Copiées dans state.rules à la création du duel : un duel en cours garde ses règles.
  // Seules ces constantes servent à équilibrer (jamais les chiffres des cartes).
  const RULES = Object.freeze({
    deckSize: 5,
    startChakra: 1,        // chakra au début du duel (avant le gain du premier tour)
    chakraPerTurn: 1,      // gagné par les deux joueurs au début de chaque tour
    maxChakra: 5,
    attackCost: 0,
    supportCost: 1,
    ultimateCost: 4,       // et une seule fois par champion et par duel
    switchCost: 0,         // chakra payé pour changer d'actif (le changement consomme toujours l'action)
    atkBonusCap: 3,        // plafond des bonus d'ATQ permanents
    guardCap: 20,
    guardDecayPct: 100,    // % de garde perdue par l'actif au début de chaque tour (arrondi au supérieur)
    benchGuardDecayPct: 0, // idem pour les champions du banc
    buffCap: 3,            // plafond des dégâts préparés
    poisonDamage: 1,       // PV perdus en fin de tour
    curseDamage: 1,
    weaknessMalus: 4,      // dégâts en moins par coup infligé
    rageBonus: 2,          // dégâts en plus par coup infligé
    regenHeal: 4,          // PV rendus en fin de tour
    benchDots: 0,          // 1 : poison, malédiction et régénération frappent aussi le banc
    hasteSecondHitPct: 35, // Hâte : le 2e coup inflige ce % des dégâts d'un coup normal (arrondi)
    damagePct: 100,        // multiplicateur global (%) des dégâts des capacités
    typeChart: 1,          // 0 : table des types neutralisée (tout à ×1)
    typeStrong: 1.25,      // Duelliste ▶ Mystique ▶ Gardien ▶ Duelliste
    typeWeak: 0.8,         // sens inverse du triangle
    typeStrongMinor: 1.15, // Stratège ▶ Soutien
    typeWeakMinor: 0.9,    // Soutien ▷ Stratège
    lowHpPct: 50,          // « sous 50 % de PV » = PV ≤ 50 % des PV max
    reviveHpPct: 50,
    fatigueTurn: 18,       // dès ce tour (0 = désactivé), les deux actifs s'épuisent en fin de tour
    fatigueDamage: 3,      // PV perdus au premier tour d'épuisement, multipliés par 2, 3… les tours suivants
    dyingStrike: 1,        // 1 : un champion mis K.O. avant d'agir joue quand même sa capacité (dernier souffle)
    speedBand: 1,          // la vitesse est comparée par paliers de N points (1 = exacte)
    speedLuck: 0,          // % de tours où l'ordre des capacités est tiré au sort malgré la vitesse
    maxTurns: 40,          // limite de tours → victoire au % de PV restants
    chooseSeconds: 45,     // délai de choix en ligne (appliqué par le relais)
    replaceSeconds: 20,    // délai de remplacement en ligne
    turnSeconds: 45,       // alias v1 de chooseSeconds
    logSize: 200           // lignes de journal conservées dans l'état
  });

  const STATUS_KEYS = ['poison', 'curse', 'weakness', 'rage', 'regen', 'haste'];
  const MALUS = ['curse', 'poison', 'weakness'];
  const STATUS_LABELS = {
    poison: 'Poison',
    curse: 'Malédiction',
    weakness: 'Faiblesse',
    rage: 'Rage',
    regen: 'Régénération',
    haste: 'Hâte'
  };
  const KIND_LABELS = { attack: 'Attaque', support: 'Soutien', ultimate: 'Ultime' };

  // ─── Types (= rôles des cartes) ───────────────────────────────────────────────────────────
  // strong : types que ses capacités frappent plus fort ; weak : types qu'elles frappent moins fort.
  const TYPES = Object.freeze({
    Duelliste: Object.freeze({ label: 'Duelliste', color: '#ff5a4e', strong: Object.freeze(['Mystique']), weak: Object.freeze(['Gardien']) }),
    Mystique: Object.freeze({ label: 'Mystique', color: '#a66bff', strong: Object.freeze(['Gardien']), weak: Object.freeze(['Duelliste']) }),
    Gardien: Object.freeze({ label: 'Gardien', color: '#4aa3ff', strong: Object.freeze(['Duelliste']), weak: Object.freeze(['Mystique']) }),
    Stratège: Object.freeze({ label: 'Stratège', color: '#ffc24a', strong: Object.freeze(['Soutien']), weak: Object.freeze([]) }),
    Soutien: Object.freeze({ label: 'Soutien', color: '#3fd68a', strong: Object.freeze([]), weak: Object.freeze(['Stratège']) })
  });
  // Paires du « petit » rapport de force (Stratège / Soutien) : multiplicateurs mineurs.
  const MINOR = new Set(['Stratège>Soutien', 'Soutien>Stratège']);
  const NEUTRAL_COLOR = '#c8c8d0';

  function typeOf(champion) {
    const raw = String((champion && (champion.type || champion.role)) || '').trim();
    if (raw === 'Gardienne') return 'Gardien';
    return TYPES[raw] ? raw : '';
  }

  function colorOfType(type) {
    return TYPES[type] ? TYPES[type].color : NEUTRAL_COLOR;
  }

  function effectiveness(attType, defType, rules) {
    const r = rules || RULES;
    if (!r.typeChart || !TYPES[attType] || !TYPES[defType]) return 1;
    const minor = MINOR.has(`${attType}>${defType}`);
    if (TYPES[attType].strong.includes(defType)) return minor ? r.typeStrongMinor : r.typeStrong;
    if (TYPES[attType].weak.includes(defType)) return minor ? r.typeWeakMinor : r.typeWeak;
    return 1;
  }

  // ─── PRNG ─────────────────────────────────────────────────────────────────────────────────
  function seedOf(seed) {
    if (typeof seed === 'number' && Number.isFinite(seed)) return seed >>> 0;
    const text = String(seed ?? '');
    let h = 2166136261;
    for (let i = 0; i < text.length; i += 1) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  function mulberry(value) {
    let t = (value + 0x6D2B79F5) >>> 0;
    const next = t;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return { next, out: ((t ^ (t >>> 14)) >>> 0) / 4294967296 };
  }

  function rand(s) {
    const r = mulberry(s.rng);
    s.rng = r.next;
    return r.out;
  }

  function randInt(s, a, b) {
    return a + Math.floor(rand(s) * (b - a + 1));
  }

  // ─── Données ──────────────────────────────────────────────────────────────────────────────
  function mythics(data) {
    return (data?.champions ?? []).filter((c) => c && c.rarity === 'M' && Array.isArray(c.attacks) && c.attacks.length === 3);
  }

  function validateDeck(data, ids) {
    if (!Array.isArray(ids)) return { ok: false, error: 'Deck invalide : liste de champions attendue.' };
    if (ids.length !== RULES.deckSize) return { ok: false, error: `Deck invalide : il faut exactement ${RULES.deckSize} Mythiques (${ids.length} reçues).` };
    const pool = new Map(mythics(data).map((c) => [Number(c.id), c]));
    const seen = new Set();
    for (const raw of ids) {
      const id = Number(raw);
      if (!pool.has(id)) return { ok: false, error: `Deck invalide : ${raw} n’est pas une Mythique connue.` };
      if (seen.has(id)) return { ok: false, error: `Deck invalide : ${pool.get(id).name} est en double.` };
      seen.add(id);
    }
    return { ok: true };
  }

  function costOf(rules, kind) {
    if (kind === 'ultimate') return rules.ultimateCost;
    if (kind === 'support') return rules.supportCost;
    return rules.attackCost;
  }

  function hasKeys(obj) {
    return !!obj && typeof obj === 'object' && Object.keys(obj).length > 0;
  }

  // 'enemy' (l'actif adverse) | 'ally' (un allié vivant, banc compris) | 'none'.
  function targetMode(move) {
    if (!move) return 'none';
    if ((move.damage ?? 0) > 0 || Array.isArray(move.randomDamage) || hasKeys(move.apply) || move.skipFoe === true || (Array.isArray(move.instakill) && move.instakill.length)) return 'enemy';
    if ((move.heal ?? 0) > 0 || (move.guard ?? 0) > 0 || move.cleanse === true) return 'ally';
    return 'none';
  }

  function dealsDamage(move) {
    return (move.damage ?? 0) > 0 || Array.isArray(move.randomDamage);
  }

  const MOVE_FIELDS = ['damage', 'randomDamage', 'heal', 'healTeam', 'healTeamFull', 'guard', 'buff', 'selfAtk', 'teamAtk',
    'teamHp', 'recoil', 'apply', 'selfApply', 'cleanse', 'bonusIfLow', 'skipFoe', 'sacrifice', 'attackBlock', 'saveLethal',
    'invincible', 'disableTurns', 'instakill', 'reviveAlly', 'extraTurn'];

  function buildChampion(card, rules) {
    const moves = card.attacks.map((m) => {
      const move = { kind: m.kind, name: m.name, desc: m.desc ?? '', cost: costOf(rules, m.kind) };
      for (const k of MOVE_FIELDS) {
        const v = m[k];
        if (v === undefined || v === null || v === false || v === 0) continue;
        move[k] = typeof v === 'object' ? JSON.parse(JSON.stringify(v)) : v;
      }
      move.targeting = targetMode(move);
      return move;
    });
    const type = typeOf(card);
    return {
      id: card.id,
      name: card.name,
      image: card.image ?? '',
      series: card.series ?? '',
      role: card.role ?? '',
      type,
      color: colorOfType(type),
      hp: card.hp,
      maxHp: card.hp,
      atk: card.atk,
      speed: card.speed ?? 0,
      atkBonus: 0,
      guard: 0,
      buff: 0,
      statuses: {},
      ultimateUsed: false,
      alive: true,
      disabled: 0,
      disabledFresh: false,
      invincible: 0,
      attackBlock: false,
      saveLethal: false,
      koOrder: 0,
      fired: [],
      lastDamagedTurn: -1,
      passive: { name: card.passive?.name ?? '', desc: card.passive?.desc ?? '' },
      passiveFx: card.passiveFx ? JSON.parse(JSON.stringify(card.passiveFx)) : { rules: [] },
      moves
    };
  }

  // ─── Création ─────────────────────────────────────────────────────────────────────────────
  // L'ordre du deck est l'alignement : le premier champion entre en jeu, les 4 autres forment le banc.
  function createMatch(opts) {
    const { data, seed, players } = opts ?? {};
    if (!Array.isArray(players) || players.length !== 2) throw new Error('Il faut exactement 2 joueurs.');
    const rules = Object.assign({}, RULES, opts.rules ?? {});
    const byId = new Map(mythics(data).map((c) => [Number(c.id), c]));
    const s = {
      v: 2,
      rules,
      seed: seedOf(seed),
      rng: seedOf(seed),
      turn: 0,
      round: 0,
      phase: 'choose',
      need: [false, false],
      choices: [null, null],
      bonus: false,
      order: [0, 1],
      acted: [false, false],
      cancel: [false, false],
      seq: 0,
      koCount: 0,
      winner: null,
      endReason: null,
      players: players.map((p, i) => {
        const check = validateDeck(data, p?.deck);
        if (!check.ok) throw new Error(`Joueur ${i + 1} : ${check.error}`);
        return {
          id: p.id ?? `j${i + 1}`,
          name: String(p.name ?? `Joueur ${i + 1}`),
          chakra: rules.startChakra,
          active: 0,
          skipNext: false,
          extra: false,
          champions: p.deck.map((id) => buildChampion(byId.get(Number(id)), rules))
        };
      }),
      log: [],
      lastEvents: []
    };
    const ev = [];
    for (let side = 0; side < 2; side += 1) {
      const c = s.players[side].champions[0];
      emit(s, ev, c, 'switch', { player: side, playerName: s.players[side].name, from: null, to: 0, fromName: null, lead: true });
    }
    for (let side = 0; side < 2; side += 1) firePassive(s, ev, s.players[side].champions[0], 'onSwitchIn', {});
    startTurn(s, ev);
    finishTransition(s, ev);
    return s;
  }

  // ─── Lecture ──────────────────────────────────────────────────────────────────────────────
  function isOver(state) {
    return !state || state.phase === 'ended' || (state.winner !== null && state.winner !== undefined);
  }

  function pendingPlayers(state) {
    if (isOver(state) || !Array.isArray(state.need)) return [];
    return [0, 1].filter((i) => state.need[i] && !state.choices[i]);
  }

  function isLow(s, c) {
    return c.hp * 100 <= c.maxHp * s.rules.lowHpPct;
  }

  function activeOf(s, side) {
    const pl = s.players[side];
    return pl.champions[pl.active];
  }

  // Actions possibles pour le joueur p dans la phase courante, sans regarder s'il a déjà choisi.
  function legalFor(s, p) {
    if (isOver(s) || !s.need[p]) return [];
    const me = s.players[p];
    const out = [];
    if (s.phase === 'replace') {
      me.champions.forEach((c, j) => {
        if (c.alive && j !== me.active) out.push({ type: 'switch', to: j });
      });
      return out;
    }
    if (me.skipNext) return [{ type: 'pass' }];
    const c = me.champions[me.active];
    const foeSide = 1 - p;
    const foeActive = activeOf(s, foeSide);
    if (c && c.alive) {
      c.moves.forEach((m, k) => {
        if (me.chakra < m.cost) return;
        if (m.kind === 'ultimate' && c.ultimateUsed) return;
        if (c.disabled > 0 && m.kind !== 'support') return;
        if (m.sacrifice && !me.champions.some((x, i) => i !== me.active && x.alive)) return;
        if (m.targeting === 'enemy') {
          if (foeActive && foeActive.alive) out.push({ type: 'move', move: k, target: { side: foeSide, index: s.players[foeSide].active } });
        } else if (m.targeting === 'ally') {
          me.champions.forEach((t, i) => {
            if (t.alive) out.push({ type: 'move', move: k, target: { side: p, index: i } });
          });
        } else {
          out.push({ type: 'move', move: k });
        }
      });
    }
    if (me.chakra >= s.rules.switchCost) {
      me.champions.forEach((t, j) => {
        if (t.alive && j !== me.active) out.push({ type: 'switch', to: j });
      });
    }
    out.push({ type: 'pass' });
    return out;
  }

  function legalActions(state, player) {
    if (!pendingPlayers(state).includes(player)) return [];
    return legalFor(state, player);
  }

  function actionKey(a) {
    if (!a || typeof a !== 'object') return '';
    if (a.type === 'pass') return 'pass';
    if (a.type === 'switch') return `switch:${a.to}`;
    if (a.type !== 'move') return '';
    const t = a.target;
    return `move:${a.move}${t ? `:${t.side}:${t.index}` : ''}`;
  }

  // ─── Événements ───────────────────────────────────────────────────────────────────────────
  function sideIndex(s, c) {
    for (let side = 0; side < 2; side += 1) {
      const index = s.players[side].champions.indexOf(c);
      if (index >= 0) return { side, index };
    }
    return { side: -1, index: -1 };
  }

  // Champs communs des événements de champion : side, index, name, champType, color.
  function tag(s, side, index) {
    const c = s.players[side].champions[index];
    return { side, index, name: c.name, champType: c.type, color: c.color };
  }

  function emit(s, ev, c, type, extra) {
    const pos = sideIndex(s, c);
    ev.push(Object.assign({ type, side: pos.side, index: pos.index, name: c.name, champType: c.type, color: c.color }, extra));
  }

  // ─── Primitives d'effets ──────────────────────────────────────────────────────────────────
  function ko(s, ev, c, cause) {
    if (!c.alive) return;
    c.alive = false;
    c.hp = 0;
    c.guard = 0;
    c.buff = 0;
    c.atkBonus = 0;
    c.statuses = {};
    c.attackBlock = false;
    c.saveLethal = false;
    c.invincible = 0;
    c.disabled = 0;
    c.disabledFresh = false;
    s.koCount += 1;
    c.koOrder = s.koCount;
    const pos = sideIndex(s, c);
    emit(s, ev, c, 'ko', { cause, active: pos.side >= 0 && s.players[pos.side].active === pos.index });
  }

  function healBonusOf(c) {
    let bonus = 0;
    for (const r of c.passiveFx.rules) {
      if (r.when !== 'static') continue;
      for (const e of r.effects) if (e.type === 'healBonus') bonus += e.amount;
    }
    return bonus;
  }

  function heal(s, ev, c, amount, source) {
    if (!c.alive || amount <= 0) return 0;
    if ((c.statuses.curse ?? 0) > 0) {
      emit(s, ev, c, 'blocked', { by: 'curse', what: 'heal' });
      return 0;
    }
    const gain = Math.min(amount, c.maxHp - c.hp);
    if (gain <= 0) return 0;
    c.hp += gain;
    emit(s, ev, c, 'heal', { amount: gain, hp: c.hp, source });
    return gain;
  }

  function addGuard(s, ev, c, amount, source) {
    if (!c.alive || amount <= 0) return;
    const next = Math.min(s.rules.guardCap, c.guard + amount);
    const gain = next - c.guard;
    if (gain <= 0) return;
    c.guard = next;
    emit(s, ev, c, 'guard', { amount: gain, guard: c.guard, source });
  }

  function addAtk(s, ev, c, amount, source) {
    if (!c.alive || amount <= 0) return;
    const next = Math.min(s.rules.atkBonusCap, c.atkBonus + amount);
    const gain = next - c.atkBonus;
    if (gain <= 0) return;
    c.atkBonus = next;
    emit(s, ev, c, 'atk', { amount: gain, atkBonus: c.atkBonus, source });
  }

  function addBuff(s, ev, c, amount, source) {
    if (!c.alive || amount <= 0) return;
    const next = Math.min(s.rules.buffCap, c.buff + amount);
    const gain = next - c.buff;
    if (gain <= 0) return;
    c.buff = next;
    emit(s, ev, c, 'buff', { amount: gain, buff: c.buff, source });
  }

  function applyStatus(s, ev, c, status, turns, source) {
    if (!c.alive || !STATUS_KEYS.includes(status) || !(turns > 0)) return;
    const n = status === 'haste' ? 1 : turns;
    c.statuses[status] = Math.max(c.statuses[status] ?? 0, n);
    emit(s, ev, c, 'status', { status, turns: c.statuses[status], source });
  }

  function cleanse(s, ev, c) {
    if (!c.alive) return;
    const removed = MALUS.filter((k) => (c.statuses[k] ?? 0) > 0);
    for (const k of removed) delete c.statuses[k];
    emit(s, ev, c, 'cleanse', { removed });
  }

  function dispel(s, ev, c, turns) {
    if (!c.alive) return;
    let pick = null;
    for (const k of MALUS) {
      if ((c.statuses[k] ?? 0) > 0 && (!pick || c.statuses[k] > c.statuses[pick])) pick = k;
    }
    if (!pick) return;
    const removed = Math.min(turns, c.statuses[pick]);
    c.statuses[pick] -= removed;
    if (c.statuses[pick] <= 0) delete c.statuses[pick];
    emit(s, ev, c, 'dispel', { status: pick, turns: removed, left: c.statuses[pick] ?? 0 });
  }

  // Perte de PV « coût » (contrecoup, effort d'équipe) : ignore garde et invulnérabilité, jamais mortelle.
  function payHp(s, ev, c, amount, source) {
    if (!c.alive || amount <= 0) return;
    const lost = Math.min(amount, c.hp - 1);
    if (lost <= 0) return;
    c.hp -= lost;
    emit(s, ev, c, 'damage', { amount: lost, absorbed: 0, hp: c.hp, source });
    hpTriggers(s, ev, c);
  }

  // Dégâts subis. source : 'move' (capacité ennemie) | 'poison' | 'curse'.
  function takeDamage(s, ev, c, amount, source, extra) {
    if (!c.alive) return;
    if (c.invincible > 0) {
      emit(s, ev, c, 'blocked', { by: 'invincible', what: source });
      return;
    }
    let rest = Math.max(0, amount);
    let absorbed = 0;
    if (source === 'move') {
      absorbed = Math.min(c.guard, rest);
      c.guard -= absorbed;
      rest -= absorbed;
    }
    if (rest >= c.hp && c.saveLethal) {
      rest = c.hp - 1;
      c.saveLethal = false;
      emit(s, ev, c, 'survive', {});
    }
    c.hp -= rest;
    emit(s, ev, c, 'damage', Object.assign({ amount: rest, absorbed, hp: Math.max(0, c.hp), source }, extra || {}));
    if (c.hp <= 0) {
      ko(s, ev, c, source === 'move' ? 'damage' : source);
      return;
    }
    hpTriggers(s, ev, c);
    if (source === 'move' && amount > 0) firePassive(s, ev, c, 'onDamaged', {});
  }

  // ─── Passifs ──────────────────────────────────────────────────────────────────────────────
  function hpTriggers(s, ev, c) {
    if (!c.alive) return;
    if (isLow(s, c)) firePassive(s, ev, c, 'lowHp', {});
    firePassive(s, ev, c, 'hpAtMost', {});
  }

  function mostWoundedAlly(s, c) {
    const pos = sideIndex(s, c);
    let best = null;
    for (const t of s.players[pos.side].champions) {
      if (t.alive && t.maxHp - t.hp > 0 && (!best || t.maxHp - t.hp > best.maxHp - best.hp)) best = t;
    }
    return best;
  }

  function firePassive(s, ev, c, when, ctx) {
    const rules = c.passiveFx.rules;
    for (let i = 0; i < rules.length; i += 1) {
      const r = rules[i];
      if (r.when !== when || !c.alive) continue;
      if (r.once && c.fired.includes(i)) continue;
      if (when === 'hpAtMost' && !(c.hp <= r.hpAtMost)) continue;
      if (r.ifLowHp && !isLow(s, c)) continue;
      if (r.perTurn) {
        if (c.lastDamagedTurn === s.turn) continue;
        c.lastDamagedTurn = s.turn;
      }
      if (r.once) c.fired.push(i);
      emit(s, ev, c, 'passive', { passive: c.passive.name, when });
      for (const e of r.effects) passiveEffect(s, ev, c, e, ctx);
    }
  }

  function passiveEffect(s, ev, c, e, ctx) {
    switch (e.type) {
      case 'heal': heal(s, ev, c, e.amount, 'passive'); break;
      case 'guard': addGuard(s, ev, c, e.amount, 'passive'); break;
      case 'buff': addBuff(s, ev, c, e.amount, 'passive'); break;
      case 'atk': addAtk(s, ev, c, e.amount, 'passive'); break;
      case 'teamAtk': {
        const pos = sideIndex(s, c);
        for (const a of s.players[pos.side].champions) addAtk(s, ev, a, e.amount, 'passive');
        break;
      }
      case 'status': applyStatus(s, ev, c, e.status, e.turns, 'passive'); break;
      case 'foeStatus': {
        // Cible : l'ennemi touché (« quand il touche ») ou l'actif adverse (début de tour).
        const pos = sideIndex(s, c);
        const t = 'target' in ctx ? ctx.target : activeOf(s, 1 - pos.side);
        if (t && t.alive) applyStatus(s, ev, t, e.status, e.turns, 'passive');
        break;
      }
      case 'dispel': dispel(s, ev, c, e.turns); break;
      case 'healMostWounded': {
        const t = mostWoundedAlly(s, c);
        if (t) heal(s, ev, t, e.amount, 'passive');
        break;
      }
      default: break; // healBonus / initiative : effets permanents lus ailleurs.
    }
  }

  function hasInitiativeFx(c, test) {
    return c.passiveFx.rules.some((r) => r.when === 'static' && r.effects.some((e) => e.type === 'initiative' && test(e)));
  }

  // ─── Ordre d'action ───────────────────────────────────────────────────────────────────────
  // Champion qui sera actif au moment des capacités : le remplaçant d'un changement choisi,
  // sinon l'actif en place.
  function nextActive(s, side, acts) {
    const pl = s.players[side];
    const a = acts && acts[side];
    return a && a.type === 'switch' && pl.champions[a.to] ? pl.champions[a.to] : pl.champions[pl.active];
  }

  // Priorité (Ram face à Rem au 1er tour, puis Subaru), seulement quand le champion concerné est
  // l'actif ; puis vitesse de l'actif ; puis graine. Renvoie { order, reason, speeds, by? }.
  function priorityOf(s, side, acts) {
    const me = nextActive(s, side, acts);
    const foe = nextActive(s, 1 - side, acts);
    if (me && me.alive) {
      if (s.turn === 1 && hasInitiativeFx(me, (e) => e.foe && e.firstRound && foe && foe.name === e.foe)) return { level: 2, reason: 'ram', by: me.name };
      if (hasInitiativeFx(me, (e) => !e.foe)) return { level: 1, reason: 'subaru', by: me.name };
    }
    return { level: 0 };
  }

  function computeOrder(s, players, acts) {
    const speeds = [0, 1].map((side) => {
      const c = nextActive(s, side, acts);
      return c ? c.speed : 0;
    });
    if (players.length < 2) return { order: players.slice(), reason: 'single', speeds };
    const pr = [priorityOf(s, 0, acts), priorityOf(s, 1, acts)];
    if (pr[0].level !== pr[1].level) {
      const first = pr[0].level > pr[1].level ? 0 : 1;
      return { order: [first, 1 - first], reason: pr[first].reason, by: pr[first].by, speeds };
    }
    const band = Math.max(1, s.rules.speedBand | 0);
    const rank = speeds.map((v) => Math.floor(v / band));
    if (rank[0] !== rank[1] && s.rules.speedLuck > 0 && rand(s) * 100 < s.rules.speedLuck) {
      const first = rand(s) < 0.5 ? 0 : 1;
      return { order: [first, 1 - first], reason: 'luck', speeds };
    }
    if (rank[0] !== rank[1]) {
      const first = rank[0] > rank[1] ? 0 : 1;
      return { order: [first, 1 - first], reason: 'speed', speeds };
    }
    const first = rand(s) < 0.5 ? 0 : 1;
    return { order: [first, 1 - first], reason: 'tie', speeds };
  }

  // ─── Déroulement d'un tour ────────────────────────────────────────────────────────────────
  function startTurn(s, ev) {
    s.turn += 1;
    s.round = s.turn;
    s.phase = 'choose';
    s.bonus = false;
    s.need = [true, true];
    s.choices = [null, null];
    ev.push({ type: 'turn', turn: s.turn });
    for (let side = 0; side < 2; side += 1) {
      const pl = s.players[side];
      pl.champions.forEach((c, j) => {
        const pct = j === pl.active ? s.rules.guardDecayPct : s.rules.benchGuardDecayPct;
        if (!c.alive || c.guard <= 0 || !(pct > 0)) return;
        const lost = Math.min(c.guard, Math.ceil((c.guard * pct) / 100));
        c.guard -= lost;
        emit(s, ev, c, 'guardDecay', { amount: lost, guard: c.guard });
      });
    }
    for (let side = 0; side < 2; side += 1) {
      const pl = s.players[side];
      const before = pl.chakra;
      pl.chakra = Math.min(s.rules.maxChakra, pl.chakra + s.rules.chakraPerTurn);
      ev.push({ type: 'chakra', player: side, playerName: pl.name, delta: pl.chakra - before, chakra: pl.chakra });
    }
    for (let side = 0; side < 2; side += 1) firePassive(s, ev, activeOf(s, side), 'turnStart', {});
  }

  function doSwitch(s, ev, p, to, forced) {
    const pl = s.players[p];
    const from = pl.active;
    const out = pl.champions[from];
    if (!forced && s.rules.switchCost > 0) {
      pl.chakra -= s.rules.switchCost;
      ev.push({ type: 'chakra', player: p, playerName: pl.name, delta: -s.rules.switchCost, chakra: pl.chakra });
    }
    pl.active = to;
    const inc = pl.champions[to];
    emit(s, ev, inc, 'switch', { player: p, playerName: pl.name, from, to, fromName: out ? out.name : null, forced: !!forced });
    firePassive(s, ev, inc, 'onSwitchIn', {});
  }

  // Résout les actions choisies (tour normal ou action bonus « rejoue »).
  function resolveChoices(s, ev) {
    const players = [0, 1].filter((i) => s.need[i]);
    const acts = [null, null];
    for (const p of players) acts[p] = s.choices[p];
    s.acted = [false, false];
    s.cancel = [false, false];
    s.need = [false, false];
    s.choices = [null, null];
    const wasBonus = s.bonus;
    s.bonus = false;
    // Action perdue (« sautera sa prochaine action ») : consommée ici.
    for (const p of players) {
      if (s.players[p].skipNext) {
        s.players[p].skipNext = false;
        acts[p] = { type: 'skip' };
      }
    }
    const info = computeOrder(s, players, acts);
    s.order = info.order.length === 2 ? info.order : [info.order[0] ?? 0, 1 - (info.order[0] ?? 0)];
    ev.push(Object.assign({ type: 'turnOrder', turn: s.turn, order: info.order, reason: info.reason, speeds: info.speeds, bonus: wasBonus,
      kinds: info.order.map((p) => acts[p].type) }, info.by ? { by: info.by } : {}));
    // 1. Changements (les deux camps), dans l'ordre d'action.
    for (const p of info.order) {
      if (acts[p].type !== 'switch') continue;
      doSwitch(s, ev, p, acts[p].to, false);
      s.acted[p] = true;
    }
    // 2. Capacités et passes, par vitesse.
    for (const p of info.order) {
      if (s.winner !== null) break;
      const a = acts[p];
      if (a.type === 'switch') continue;
      const pl = s.players[p];
      if (a.type === 'skip') {
        ev.push({ type: 'skip', player: p, playerName: pl.name });
      } else if (s.cancel[p]) {
        ev.push({ type: 'skip', player: p, playerName: pl.name, now: true });
      } else if (a.type === 'pass') {
        ev.push({ type: 'pass', player: p, playerName: pl.name });
      } else {
        const c = activeOf(s, p);
        if (!c.alive && !(s.rules.dyingStrike && a.type === 'move')) {
          emit(s, ev, c, 'fail', { player: p, playerName: pl.name, reason: 'ko', moveName: c.moves[a.move].name });
        } else {
          resolveMove(s, ev, p, a, !c.alive);
        }
      }
      s.acted[p] = true;
      checkEnd(s, ev);
    }
    if (s.winner !== null) return;
    // 3. Action bonus (« rejoue ») avant la fin du tour.
    const extra = [0, 1].filter((p) => s.players[p].extra);
    for (const p of [0, 1]) s.players[p].extra = false;
    const bonus = extra.filter((p) => activeOf(s, p).alive);
    if (bonus.length) {
      s.phase = 'choose';
      s.bonus = true;
      s.need = [bonus.includes(0), bonus.includes(1)];
      for (const p of bonus) ev.push({ type: 'extraTurn', player: p, playerName: s.players[p].name });
      return;
    }
    endOfTurn(s, ev);
  }

  function endOfTurn(s, ev) {
    const order = s.order;
    for (const side of order) {
      const pl = s.players[side];
      pl.champions.forEach((c, j) => {
        if (!c.alive || (j !== pl.active && !s.rules.benchDots)) return;
        if ((c.statuses.poison ?? 0) > 0) takeDamage(s, ev, c, s.rules.poisonDamage, 'poison');
        if (c.alive && (c.statuses.curse ?? 0) > 0) takeDamage(s, ev, c, s.rules.curseDamage, 'curse');
        if (c.alive && (c.statuses.regen ?? 0) > 0) heal(s, ev, c, s.rules.regenHeal, 'regen');
      });
    }
    for (const side of order) {
      for (const c of s.players[side].champions) {
        if (!c.alive) continue;
        for (const k of STATUS_KEYS) {
          if (k === 'haste' || !(c.statuses[k] > 0)) continue;
          c.statuses[k] -= 1;
          if (c.statuses[k] <= 0) {
            delete c.statuses[k];
            emit(s, ev, c, 'expire', { status: k });
          }
        }
        if (c.invincible > 0) {
          c.invincible -= 1;
          if (c.invincible === 0) emit(s, ev, c, 'expire', { status: 'invincible' });
        }
        if (c.disabled > 0) {
          if (c.disabledFresh) c.disabledFresh = false;
          else {
            c.disabled -= 1;
            if (c.disabled === 0) emit(s, ev, c, 'expire', { status: 'disabled' });
          }
        }
      }
    }
    if (s.rules.fatigueTurn > 0 && s.turn >= s.rules.fatigueTurn) {
      const amount = s.rules.fatigueDamage * (s.turn - s.rules.fatigueTurn + 1);
      ev.push({ type: 'fatigue', turn: s.turn, amount });
      for (const side of order) {
        const c = activeOf(s, side);
        if (c.alive) takeDamage(s, ev, c, amount, 'fatigue');
      }
    }
    ev.push({ type: 'turnEnd', turn: s.turn });
    checkEnd(s, ev);
    if (s.winner !== null) return;
    if (s.turn >= s.rules.maxTurns) {
      const pct = hpPct(s);
      const cmp = pct[0].hp * pct[1].max - pct[1].hp * pct[0].max;
      finish(s, ev, cmp > 0 ? 0 : cmp < 0 ? 1 : 'draw', 'rounds');
      return;
    }
    const need = [0, 1].map((p) => !activeOf(s, p).alive);
    if (need[0] || need[1]) {
      s.phase = 'replace';
      s.need = need;
      s.choices = [null, null];
      for (const p of [0, 1]) if (need[p]) ev.push({ type: 'phaseReplace', player: p, playerName: s.players[p].name });
      return;
    }
    startTurn(s, ev);
  }

  function resolveReplace(s, ev) {
    const players = [0, 1].filter((i) => s.need[i]);
    const acts = players.map((p) => [p, s.choices[p]]);
    s.need = [false, false];
    s.choices = [null, null];
    for (const [p, a] of acts) doSwitch(s, ev, p, a.to, true);
    startTurn(s, ev);
  }

  function hpPct(s) {
    return s.players.map((p) => p.champions.reduce((acc, c) => ({ hp: acc.hp + (c.alive ? c.hp : 0), max: acc.max + c.maxHp }), { hp: 0, max: 0 }));
  }

  function checkEnd(s, ev) {
    if (s.winner !== null) return;
    const alive = s.players.map((p) => p.champions.some((c) => c.alive));
    if (alive[0] && alive[1]) return;
    finish(s, ev, !alive[0] && !alive[1] ? 'draw' : alive[0] ? 0 : 1, 'ko');
  }

  function finish(s, ev, winner, reason) {
    s.winner = winner;
    s.endReason = reason;
    s.phase = 'ended';
    s.need = [false, false];
    s.choices = [null, null];
    s.bonus = false;
    const pct = hpPct(s).map((x) => (x.max ? Math.round((x.hp * 1000) / x.max) / 10 : 0));
    ev.push({ type: 'end', winner, reason, hpPct: pct, names: s.players.map((p) => p.name), turn: s.turn });
  }

  // ─── Résolution d'une capacité (ordre fixe, documenté dans les règles) ────────────────────
  function resolveMove(s, ev, p, action, dying) {
    const me = s.players[p];
    const ai = me.active;
    const c = me.champions[ai];
    const m = c.moves[action.move];
    const foeSide = 1 - p;
    let target = null;
    let retarget = false;
    if (m.targeting === 'enemy') {
      const fi = s.players[foeSide].active;
      const t = s.players[foeSide].champions[fi];
      if (!t || !t.alive) {
        emit(s, ev, c, 'fail', { player: p, playerName: me.name, reason: 'noTarget', moveName: m.name });
        return;
      }
      retarget = !!action.target && action.target.index !== fi;
      target = t;
    } else if (m.targeting === 'ally') {
      let idx = action.target ? action.target.index : ai;
      if (!me.champions[idx] || !me.champions[idx].alive) idx = ai;
      target = me.champions[idx];
    }

    // 1. Coût.
    if (m.cost > 0) {
      me.chakra -= m.cost;
      ev.push({ type: 'chakra', player: p, playerName: me.name, delta: -m.cost, chakra: me.chakra });
    }
    if (m.kind === 'ultimate') c.ultimateUsed = true;
    const tpos = target ? sideIndex(s, target) : null;
    ev.push(Object.assign({
      type: 'move', player: p, playerName: me.name, move: action.move, moveName: m.name, kind: m.kind, cost: m.cost,
      target: target ? tag(s, tpos.side, tpos.index) : null, retarget, dying: !!dying
    }, tag(s, p, ai)));

    // 2. Annulation par « annule la prochaine attaque ».
    if (m.targeting === 'enemy' && target.attackBlock) {
      target.attackBlock = false;
      emit(s, ev, target, 'blocked', { by: 'attackBlock', what: 'move', moveName: m.name });
      return;
    }

    // 3. Sacrifice (allié vivant le plus faible, hors lanceur : forcément sur le banc).
    if (m.sacrifice) {
      let weakest = null;
      me.champions.forEach((x) => {
        if (x !== c && x.alive && (!weakest || x.hp < weakest.hp)) weakest = x;
      });
      if (weakest) ko(s, ev, weakest, 'sacrifice');
    }

    // 4. Effets sur l'actif adverse.
    if (m.targeting === 'enemy') {
      if (dealsDamage(m)) {
        const hits = (c.statuses.haste ?? 0) > 0 ? 2 : 1;
        if (hits === 2) {
          delete c.statuses.haste;
          emit(s, ev, c, 'haste', {});
        }
        const mult = effectiveness(c.type, target.type, s.rules);
        if (mult !== 1) {
          emit(s, ev, target, 'effectiveness', { mult, attacker: tag(s, p, ai), label: mult > 1 ? 'strong' : 'weak' });
        }
        let prepared = c.buff;
        c.buff = 0;
        for (let h = 0; h < hits && target.alive; h += 1) {
          const base = Array.isArray(m.randomDamage) ? randInt(s, m.randomDamage[0], m.randomDamage[1]) : m.damage;
          let dmg = base + c.atk + c.atkBonus + prepared;
          prepared = 0;
          if ((c.statuses.rage ?? 0) > 0) dmg += s.rules.rageBonus;
          if ((c.statuses.weakness ?? 0) > 0) dmg -= s.rules.weaknessMalus;
          if (m.bonusIfLow && isLow(s, c)) dmg += m.bonusIfLow;
          dmg = Math.max(0, dmg);
          dmg = Math.round((dmg * mult * s.rules.damagePct) / 100);
          if (h === 1) dmg = Math.round((dmg * s.rules.hasteSecondHitPct) / 100);
          const extra = { mult };
          if (hits === 2) extra.hit = h + 1;
          takeDamage(s, ev, target, dmg, 'move', extra);
        }
      }
      if (Array.isArray(m.instakill) && target.alive && m.instakill.includes(target.name)) ko(s, ev, target, 'instakill');
      if (m.apply && target.alive) for (const [k, n] of Object.entries(m.apply)) applyStatus(s, ev, target, k, n, 'move');
      if (m.skipFoe) {
        const foe = s.players[foeSide];
        const now = !s.acted[foeSide] && !s.cancel[foeSide] && s.order.indexOf(foeSide) > s.order.indexOf(p) && pendingAction(s, foeSide);
        if (now) s.cancel[foeSide] = true;
        else foe.skipNext = true;
        ev.push({ type: 'skipNext', player: foeSide, playerName: foe.name, now });
      }
      firePassive(s, ev, c, 'onHit', { target: target.alive ? target : null });
    }

    // 5. Soin / garde / dissipation : allié choisi (banc compris), ou le lanceur.
    const recv = m.targeting === 'ally' ? target : c;
    const bonus = healBonusOf(c);
    if (m.heal) heal(s, ev, recv, m.heal + bonus, 'move');
    if (m.guard) addGuard(s, ev, recv, m.guard, 'move');
    if (m.cleanse) cleanse(s, ev, recv);

    // 6. Lanceur et équipe (banc compris).
    if (m.buff) addBuff(s, ev, c, m.buff, 'move');
    if (m.selfAtk) addAtk(s, ev, c, m.selfAtk, 'move');
    if (m.teamAtk) for (const a of me.champions) addAtk(s, ev, a, m.teamAtk, 'move');
    if (m.healTeam) for (const a of me.champions) heal(s, ev, a, m.healTeam + bonus, 'move');
    if (m.healTeamFull) for (const a of me.champions) if (a.alive) heal(s, ev, a, a.maxHp - a.hp, 'move');
    if (m.teamHp) for (const a of me.champions) if (a !== c) payHp(s, ev, a, m.teamHp, 'teamHp');
    if (m.recoil) payHp(s, ev, c, m.recoil, 'recoil');
    if (m.selfApply) for (const [k, n] of Object.entries(m.selfApply)) applyStatus(s, ev, c, k, n, 'move');
    if (m.saveLethal) {
      c.saveLethal = true;
      emit(s, ev, c, 'protect', { effect: 'saveLethal' });
    }
    if (m.invincible) {
      c.invincible = Math.max(c.invincible, m.invincible);
      emit(s, ev, c, 'protect', { effect: 'invincible', turns: c.invincible });
    }
    if (m.attackBlock) {
      c.attackBlock = true;
      emit(s, ev, c, 'protect', { effect: 'attackBlock' });
    }
    if (m.disableTurns) {
      c.disabled = m.disableTurns;
      c.disabledFresh = true;
      emit(s, ev, c, 'protect', { effect: 'disabled', turns: m.disableTurns });
    }
    if (m.kind === 'support') firePassive(s, ev, c, 'afterSupport', {});

    // 7. Résurrection (sur le banc) puis chute du lanceur.
    if (m.reviveAlly) {
      let fallen = null;
      for (const a of me.champions) if (a !== c && !a.alive && (!fallen || a.koOrder > fallen.koOrder)) fallen = a;
      if (fallen) {
        fallen.alive = true;
        fallen.hp = Math.max(1, Math.ceil((fallen.maxHp * s.rules.reviveHpPct) / 100));
        fallen.koOrder = 0;
        emit(s, ev, fallen, 'revive', { hp: fallen.hp });
        ko(s, ev, c, 'revive');
      }
    }

    // 8. Action bonus en fin de tour.
    if (m.extraTurn) me.extra = true;
  }

  // Le joueur a-t-il encore une action à résoudre ce tour-ci ?
  function pendingAction(s, p) {
    return !s.acted[p];
  }

  function finishTransition(s, ev) {
    s.lastEvents = ev;
    for (const e of ev) {
      const line = describeEvent(e);
      if (line) s.log.push(line);
    }
    if (s.log.length > s.rules.logSize) s.log.splice(0, s.log.length - s.rules.logSize);
  }

  function clone(state) {
    return JSON.parse(JSON.stringify(state));
  }

  // ─── Soumission d'un choix ────────────────────────────────────────────────────────────────
  // Range le choix du joueur ; quand tous les choix attendus sont là, résout le tour (ou le
  // remplacement). Renvoie { state, events, resolved }. Ne modifie jamais `state`.
  function submit(state, player, action) {
    if (!state || !Array.isArray(state.players)) throw new Error('État de duel invalide.');
    if (isOver(state)) throw new Error('Le duel est terminé.');
    if (player !== 0 && player !== 1) throw new Error('Joueur inconnu.');
    if (!state.need[player]) throw new Error(state.phase === 'replace' ? 'Tu n’as pas de remplaçant à choisir.' : 'Tu n’as rien à choisir maintenant.');
    if (state.choices[player]) throw new Error('Ton choix est déjà fait pour ce tour.');
    const key = actionKey(action);
    const legal = legalFor(state, player).find((a) => actionKey(a) === key);
    if (!key || !legal) {
      throw new Error(state.phase === 'replace'
        ? 'Remplaçant invalide : choisis un champion vivant de ton banc.'
        : 'Action illégale : capacité indisponible, chakra insuffisant, cible ou changement invalide.');
    }
    const s = clone(state);
    const ev = [];
    s.choices[player] = JSON.parse(JSON.stringify(legal));
    ev.push({ type: 'chosen', player, playerName: s.players[player].name, phase: s.phase });
    const resolved = pendingPlayers(s).length === 0;
    if (resolved) {
      if (s.phase === 'replace') resolveReplace(s, ev);
      else resolveChoices(s, ev);
    }
    s.seq += 1;
    finishTransition(s, ev);
    return { state: s, events: ev, resolved };
  }

  // Copie de l'état pour le joueur `player` : le choix secret de l'adversaire est masqué
  // (remplacé par { type: 'hidden' } s'il a déjà choisi).
  function viewFor(state, player) {
    const s = clone(state);
    if (Array.isArray(s.choices)) {
      for (const p of [0, 1]) {
        if (p !== player && s.choices[p]) s.choices[p] = { type: 'hidden' };
      }
    }
    return s;
  }

  // Abandon (ou absence prolongée) : défaite immédiate du joueur.
  function forfeit(state, playerIndex, reason) {
    if (isOver(state)) throw new Error('Le duel est terminé.');
    if (playerIndex !== 0 && playerIndex !== 1) throw new Error('Joueur inconnu.');
    const s = clone(state);
    const ev = [];
    const why = reason === 'timeout' ? 'timeout' : 'forfeit';
    ev.push({ type: 'forfeit', player: playerIndex, playerName: s.players[playerIndex].name, reason: why });
    finish(s, ev, 1 - playerIndex, why);
    s.seq += 1;
    finishTransition(s, ev);
    return { state: s, events: ev, resolved: true };
  }

  // ─── IA ───────────────────────────────────────────────────────────────────────────────────
  // Prévision à un tour : l'IA devine le choix adverse (meilleure réponse à son attaque par
  // défaut), puis simule chacune de ses actions contre cette prévision et contre l'attaque la
  // plus forte de l'adversaire. L'évaluation compte le matériel (PV, garde, bonus…) et le
  // rapport de force entre actifs (dégâts attendus, type, vitesse, menace de K.O.) : c'est ce
  // terme qui la fait changer d'actif. Elle ne lit jamais le choix secret adverse, ne fait pas
  // avancer state.rng et simule avec une graine brouillée (pas de lecture de l'avenir).
  function cloneChamp(c) {
    const o = Object.assign({}, c);
    o.statuses = Object.assign({}, c.statuses);
    o.fired = c.fired.slice();
    return o;
  }

  function fastClone(s) {
    const o = Object.assign({}, s);
    o.players = s.players.map((p) => Object.assign({}, p, { champions: p.champions.map(cloneChamp) }));
    o.need = s.need.slice();
    o.choices = s.choices.slice();
    o.acted = s.acted.slice();
    o.cancel = s.cancel.slice();
    o.order = s.order.slice();
    o.log = [];
    o.lastEvents = [];
    return o;
  }

  const AI = {
    base: 12,          // valeur d'un champion vivant, hors PV
    hp: 1,
    guard: 0.55,
    atk: 1.6,
    buff: 0.5,
    chakra: 0.9,
    ultimate: 3,
    matchup: 1.0,      // poids du rapport de force entre actifs
    threat: 0.45       // part de la valeur d'un actif menacé de K.O. au prochain tour
  };

  function champWorth(s, c) {
    if (!c.alive) return 0;
    const st = c.statuses;
    let v = AI.base + c.hp * AI.hp + Math.min(c.hp, 10) * 0.5;
    v += c.guard * AI.guard;
    v += (c.atk + c.atkBonus) * AI.atk;
    v += c.buff * AI.buff;
    v += (st.rage ?? 0) * 1.5 + (st.regen ?? 0) * 1.5 + (st.haste ? 6 : 0);
    v -= (st.poison ?? 0) * s.rules.poisonDamage * 0.8 + (st.curse ?? 0) * 1.5 + (st.weakness ?? 0) * 1.5;
    v += c.invincible * 5 + (c.attackBlock ? 7 : 0) + (c.saveLethal ? 6 : 0);
    v -= c.disabled * 3;
    if (!c.ultimateUsed) v += AI.ultimate;
    return v;
  }

  // Dégâts qu'un champion peut infliger à un autre au prochain tour (meilleure capacité jouable).
  function estDamage(s, att, def, chakra) {
    if (!att.alive || !def.alive) return 0;
    let best = 0;
    const mult = effectiveness(att.type, def.type, s.rules);
    for (const m of att.moves) {
      if (!dealsDamage(m)) continue;
      if (m.kind === 'ultimate' && att.ultimateUsed) continue;
      if (m.cost > chakra) continue;
      if (att.disabled > 1 && m.kind !== 'support') continue;
      const base = Array.isArray(m.randomDamage) ? (m.randomDamage[0] + m.randomDamage[1]) / 2 : m.damage;
      let d = base + att.atk + att.atkBonus + att.buff;
      if ((att.statuses.rage ?? 0) > 1) d += s.rules.rageBonus;
      if ((att.statuses.weakness ?? 0) > 1) d -= s.rules.weaknessMalus;
      if (m.bonusIfLow && isLow(s, att)) d += m.bonusIfLow;
      d = Math.max(0, d) * mult * s.rules.damagePct / 100;
      if (att.statuses.haste) d *= 1 + s.rules.hasteSecondHitPct / 100;
      if (d > best) best = d;
    }
    return best;
  }

  // Rapport de force de mon champion `mine` contre l'actif adverse `foe` (point de vue de `side`).
  function pairScore(s, side, mine, foe) {
    const myCh = Math.min(s.rules.maxChakra, s.players[side].chakra + s.rules.chakraPerTurn);
    const foeCh = Math.min(s.rules.maxChakra, s.players[1 - side].chakra + s.rules.chakraPerTurn);
    const myD = estDamage(s, mine, foe, myCh);
    const foeD = estDamage(s, foe, mine, foeCh);
    const myEff = mine.hp + mine.guard * (1 - s.rules.guardDecayPct / 100) + (mine.invincible > 1 ? 99 : 0);
    const foeEff = foe.hp + foe.guard * (1 - s.rules.guardDecayPct / 100) + (foe.invincible > 1 ? 99 : 0);
    let v = Math.min(myD, foeEff) - Math.min(foeD, myEff);
    const faster = mine.speed > foe.speed;
    const iKill = myD >= foeEff;
    const heKills = foeD >= myEff;
    if (heKills && !(iKill && faster)) v -= AI.threat * champWorth(s, mine);
    if (iKill && !(heKills && !faster)) v += AI.threat * champWorth(s, foe);
    return v;
  }

  function matchup(s, p) {
    const me = s.players[p];
    const foe = s.players[1 - p];
    const mine = me.champions[me.active].alive ? [me.champions[me.active]] : me.champions.filter((c) => c.alive);
    const theirs = foe.champions[foe.active].alive ? [foe.champions[foe.active]] : foe.champions.filter((c) => c.alive);
    if (!mine.length || !theirs.length) return 0;
    let best = -Infinity;
    for (const a of mine) {
      let worst = Infinity;
      for (const b of theirs) worst = Math.min(worst, pairScore(s, p, a, b));
      best = Math.max(best, worst);
    }
    return best;
  }

  function evaluate(s, p) {
    if (s.winner === p) return 1e6;
    if (s.winner === 1 - p) return -1e6;
    if (s.winner === 'draw') return 0;
    let v = 0;
    for (let side = 0; side < 2; side += 1) {
      const pl = s.players[side];
      let x = pl.chakra * AI.chakra - (pl.skipNext ? 8 : 0) + (s.bonus && s.need[side] ? 8 : 0);
      for (const c of pl.champions) x += champWorth(s, c);
      v += side === p ? x : -x;
    }
    return v + AI.matchup * matchup(s, p);
  }

  function simulate(base, acts) {
    const s = fastClone(base);
    s.choices = acts.slice();
    try {
      resolveChoices(s, []);
    } catch (err) {
      return null;
    }
    return s;
  }

  // Attaque « par défaut » : la capacité qui inflige le plus de dégâts à l'actif adverse.
  function rawBestAttack(s, p, acts) {
    let best = null;
    let bestD = -1;
    const c = activeOf(s, p);
    const foe = activeOf(s, 1 - p);
    for (const a of acts) {
      if (a.type !== 'move') continue;
      const m = c.moves[a.move];
      if (!dealsDamage(m) || !foe.alive) continue;
      const base = Array.isArray(m.randomDamage) ? (m.randomDamage[0] + m.randomDamage[1]) / 2 : m.damage;
      const d = (base + (m.bonusIfLow && isLow(s, c) ? m.bonusIfLow : 0)) * effectiveness(c.type, foe.type, s.rules) - m.cost * 0.5;
      if (d > bestD) {
        bestD = d;
        best = a;
      }
    }
    return best ?? { type: 'pass' };
  }

  function noiseOf(rng, i) {
    return mulberry((rng ^ Math.imul(i + 1, 0x9E3779B1)) >>> 0).out * 0.05;
  }

  function chooseAction(state, playerIndex) {
    const p = playerIndex;
    if (isOver(state) || !state.need?.[p] || state.choices?.[p]) return { type: 'pass' };
    const acts = legalFor(state, p);
    if (!acts.length) return { type: 'pass' };
    if (acts.length === 1) return JSON.parse(JSON.stringify(acts[0]));
    const base = fastClone(state);
    base.rng = mulberry((state.rng ^ 0x5bd1e995) >>> 0).next; // graine brouillée : l'IA ne lit pas l'avenir
    base.choices = [null, null];
    let best = acts[acts.length - 1];
    let bestScore = -Infinity;
    if (state.phase === 'replace') {
      acts.forEach((a, i) => {
        const s = fastClone(base);
        s.players[p].active = a.to;
        const score = evaluate(s, p) + noiseOf(state.rng, i);
        if (score > bestScore) {
          bestScore = score;
          best = a;
        }
      });
      return JSON.parse(JSON.stringify(best));
    }
    const f = 1 - p;
    let scenarios;
    if (base.need[f]) {
      const foeActs = legalFor(base, f);
      const mine = rawBestAttack(base, p, acts);
      let pred = foeActs[foeActs.length - 1];
      let predScore = -Infinity;
      foeActs.forEach((fa, i) => {
        const pair = [null, null];
        pair[p] = mine;
        pair[f] = fa;
        const s = simulate(base, pair);
        if (!s) return;
        const sc = evaluate(s, f) + noiseOf(state.rng ^ 0x1234567, i);
        if (sc > predScore) {
          predScore = sc;
          pred = fa;
        }
      });
      const strike = rawBestAttack(base, f, foeActs);
      scenarios = actionKey(strike) === actionKey(pred) ? [[pred, 1]] : [[pred, 0.6], [strike, 0.4]];
    } else {
      scenarios = [[null, 1]];
    }
    acts.forEach((a, i) => {
      let score = 0;
      for (const [fa, w] of scenarios) {
        const pair = [null, null];
        pair[p] = a;
        pair[f] = fa;
        const s = simulate(base, pair);
        score += w * (s ? evaluate(s, p) : -1e7);
      }
      score += noiseOf(state.rng, i);
      if (score > bestScore) {
        bestScore = score;
        best = a;
      }
    });
    return JSON.parse(JSON.stringify(best));
  }

  // ─── Journal ──────────────────────────────────────────────────────────────────────────────
  function statusText(status, turns) {
    const label = STATUS_LABELS[status] ?? status;
    if (status === 'haste' || !turns) return label;
    return `${label} ${turns}`;
  }

  const SOURCES = { poison: 'du poison', curse: 'de la malédiction', fatigue: 'd’épuisement', recoil: 'en contrecoup', teamHp: 'pour l’effort de l’équipe' };

  function describeEvent(e) {
    if (!e || typeof e !== 'object') return '';
    switch (e.type) {
      case 'turn': return `— Tour ${e.turn} —`;
      case 'turnOrder': {
        if (e.reason === 'single' || !e.order || e.order.length < 2) return '';
        const why = e.reason === 'subaru' ? ` (${e.by ?? 'Subaru'} : son camp agit toujours d’abord)`
          : e.reason === 'ram' ? ` (${e.by ?? 'Ram'} face à Rem)`
            : e.reason === 'tie' ? ' (égalité de vitesse, tirage au sort)' : e.reason === 'luck' ? ' (tirage au sort)' : ' (actif le plus rapide)';
        return `Ordre d’action : joueur ${e.order[0] + 1} d’abord${why}.`;
      }
      case 'chosen': return '';
      case 'chakra': if (e.delta === 0) return `${e.playerName} est au plafond de chakra (${e.chakra}).`;
        return e.delta > 0 ? `${e.playerName} gagne ${e.delta} chakra (${e.chakra}).` : `${e.playerName} dépense ${-e.delta} chakra (${e.chakra} restant).`;
      case 'switch':
        if (e.lead) return `${e.playerName} envoie ${e.name}.`;
        if (e.forced) return `${e.playerName} envoie ${e.name} pour remplacer ${e.fromName}.`;
        return `${e.playerName} rappelle ${e.fromName} et envoie ${e.name}.`;
      case 'phaseReplace': return `${e.playerName} doit choisir un remplaçant.`;
      case 'skip': return e.now ? `${e.playerName} perd son action de ce tour.` : `${e.playerName} perd son action.`;
      case 'skipNext': return e.now ? `${e.playerName} perd son action de ce tour !` : `${e.playerName} perdra sa prochaine action.`;
      case 'pass': return `${e.playerName} passe.`;
      case 'fail': return e.reason === 'ko' ? `${e.name} est KO : ${e.moveName} n’a pas lieu.` : `${e.moveName} échoue : aucune cible.`;
      case 'move': return `${e.name} utilise ${e.moveName}${e.target ? ` sur ${e.target.name}` : ''}${e.retarget ? ' (nouvel actif)' : ''}.`;
      case 'effectiveness': return e.mult > 1 ? `C’est efficace contre ${e.name} (×${e.mult}).` : `Ce n’est pas très efficace contre ${e.name} (×${e.mult}).`;
      case 'damage': {
        const abs = e.absorbed ? ` (${e.absorbed} absorbé${e.absorbed > 1 ? 's' : ''} par la garde)` : '';
        const hit = e.hit ? ` [coup ${e.hit}]` : '';
        if (e.source === 'move') return `${e.name} subit ${e.amount} dégât${e.amount > 1 ? 's' : ''}${abs}${hit} — ${e.hp} PV.`;
        return `${e.name} perd ${e.amount} PV${SOURCES[e.source] ? ` ${SOURCES[e.source]}` : ''} — ${e.hp} PV.`;
      }
      case 'heal': return `${e.name} récupère ${e.amount} PV${e.source === 'regen' ? ' (régénération)' : ''} — ${e.hp} PV.`;
      case 'guardDecay': return `${e.name} perd ${e.amount} garde (${e.guard}).`;
      case 'guard': return `${e.name} gagne ${e.amount} garde (${e.guard}).`;
      case 'buff': return `${e.name} prépare +${e.amount} dégâts (${e.buff}).`;
      case 'atk': return `${e.name} gagne +${e.amount} ATQ (bonus ${e.atkBonus}).`;
      case 'status': return `${e.name} : ${statusText(e.status, e.turns)}.`;
      case 'expire':
        if (e.status === 'invincible') return `${e.name} n’est plus invulnérable.`;
        if (e.status === 'disabled') return `${e.name} peut de nouveau attaquer.`;
        return `${e.name} : fin de ${STATUS_LABELS[e.status] ?? e.status}.`;
      case 'cleanse': return e.removed?.length ? `Dissipation sur ${e.name} : ${e.removed.map((k) => STATUS_LABELS[k]).join(', ')}.` : `${e.name} : aucun mal à dissiper.`;
      case 'dispel': return `${e.name} dissipe ${e.turns} tour${e.turns > 1 ? 's' : ''} de ${STATUS_LABELS[e.status] ?? e.status}.`;
      case 'haste': return `${e.name} frappe deux fois (Hâte).`;
      case 'blocked':
        if (e.by === 'attackBlock') return `${e.name} annule ${e.moveName ?? 'la capacité'} !`;
        if (e.by === 'invincible') return `${e.name} est invulnérable : aucun dégât.`;
        if (e.by === 'curse') return `Malédiction : ${e.name} ne reçoit aucun soin.`;
        return '';
      case 'protect':
        if (e.effect === 'saveLethal') return `${e.name} survivra au prochain coup létal.`;
        if (e.effect === 'invincible') return `${e.name} est invulnérable pendant ${e.turns} tour${e.turns > 1 ? 's' : ''}.`;
        if (e.effect === 'attackBlock') return `Protection de ${e.name} : la prochaine capacité ennemie qui le vise sera annulée.`;
        if (e.effect === 'disabled') return `${e.name} ne pourra plus attaquer pendant ${e.turns} tour${e.turns > 1 ? 's' : ''}.`;
        return '';
      case 'survive': return `${e.name} survit avec 1 PV !`;
      case 'passive': return `Passif de ${e.name} : ${e.passive}.`;
      case 'ko': {
        const why = { instakill: ' (abattu)', sacrifice: ' (sacrifié)', revive: ' (se sacrifie)', poison: ' (poison)', curse: ' (malédiction)', fatigue: ' (épuisement)' }[e.cause] ?? '';
        return `${e.name} est KO${why}.`;
      }
      case 'revive': return `${e.name} revient sur le banc avec ${e.hp} PV.`;
      case 'extraTurn': return `${e.playerName} obtient une action bonus avant la fin du tour.`;
      case 'fatigue': return `Épuisement : les deux champions actifs perdent ${e.amount} PV.`;
      case 'turnEnd': return '';
      case 'forfeit': return e.reason === 'timeout' ? `${e.playerName} est absent trop longtemps.` : `${e.playerName} abandonne.`;
      case 'end': {
        const why = { ko: 'tous les champions adverses sont KO', rounds: `limite de tours (PV restants : ${e.hpPct?.[0]} % contre ${e.hpPct?.[1]} %)`, forfeit: 'abandon', timeout: 'absence' }[e.reason] ?? e.reason;
        if (e.winner === 'draw') return `Match nul — ${why}.`;
        return `Victoire de ${e.names?.[e.winner] ?? `Joueur ${e.winner + 1}`} — ${why}.`;
      }
      default: return '';
    }
  }

  return {
    version: 2,
    RULES,
    TYPES,
    STATUS_LABELS,
    KIND_LABELS,
    mythics,
    validateDeck,
    createMatch,
    pendingPlayers,
    legalActions,
    submit,
    viewFor,
    chooseAction,
    forfeit,
    describeEvent,
    typeOf,
    effectiveness,
    targetMode,
    actionKey
  };
});
