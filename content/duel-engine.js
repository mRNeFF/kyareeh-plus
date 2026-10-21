// Kyara Duel — moteur de règles (arène 5 contre 5, Mythiques).
// Fichier PUR : aucun DOM, réseau, stockage, horloge ni Math.random. L'état est un objet JSON
// simple ; applyAction ne modifie jamais son entrée. Le hasard vient d'un PRNG (mulberry32)
// dont l'état vit dans state.rng.
// Chargement : content script (window.KYARA_DUEL_ENGINE) ou Node (require / import par défaut).
// Règles complètes : content/duel-rules.js (window.KYARA_DUEL_RULES) et docs/REGLES-DUEL.md.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.KYARA_DUEL_ENGINE = api;
  else if (root) root.KYARA_DUEL_ENGINE = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // ─── Constantes réglables (§2 de la spécification) ─────────────────────────────────────────
  // Copiées dans state.rules à la création du duel : un duel en cours garde ses règles.
  const RULES = Object.freeze({
    deckSize: 5,
    startChakra: 1,      // chakra au début du duel (avant le gain du premier tour)
    chakraPerTurn: 1,    // gagné au début de chaque tour joué
    maxChakra: 5,
    attackCost: 0,
    supportCost: 1,
    ultimateCost: 4,     // et une seule fois par champion et par duel
    atkBonusCap: 3,      // plafond des bonus d'ATQ permanents
    guardCap: 20,
    guardDecayPct: 100,  // % de garde perdue au début de chaque tour de son camp (arrondi au supérieur)
    secondPlayerGuard: 6, // garde de départ des champions du camp qui joue en second dans la 1re manche
    buffCap: 3,          // plafond des dégâts préparés
    poisonDamage: 1,     // PV perdus en fin de manche
    curseDamage: 1,
    weaknessMalus: 4,    // dégâts en moins par coup infligé
    rageBonus: 2,        // dégâts en plus par coup infligé
    regenHeal: 4,        // PV rendus en fin de manche
    hasteSecondHitPct: 35, // Hâte : le 2e coup inflige ce % des dégâts d'un coup normal (arrondi)
    lowHpPct: 50,        // « sous 50 % de PV » = PV ≤ 50 % des PV max
    reviveHpPct: 50,
    maxRounds: 30,
    turnSeconds: 60,     // délai de tour en ligne (appliqué par le relais)
    logSize: 120         // lignes de journal conservées dans l'état
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

  // 'enemy' | 'ally' | 'none' (§2.3).
  function targetMode(move) {
    if (!move) return 'none';
    if ((move.damage ?? 0) > 0 || Array.isArray(move.randomDamage) || hasKeys(move.apply) || move.skipFoe === true || (Array.isArray(move.instakill) && move.instakill.length)) return 'enemy';
    if ((move.heal ?? 0) > 0 || (move.guard ?? 0) > 0 || move.cleanse === true) return 'ally';
    return 'none';
  }

  function dealsDamage(move) {
    return (move.damage ?? 0) > 0 || Array.isArray(move.randomDamage);
  }

  function hasKeys(obj) {
    return !!obj && typeof obj === 'object' && Object.keys(obj).length > 0;
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
    return {
      id: card.id,
      name: card.name,
      image: card.image ?? '',
      series: card.series ?? '',
      role: card.role ?? '',
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
  function createMatch(opts) {
    const { data, seed, players } = opts ?? {};
    if (!Array.isArray(players) || players.length !== 2) throw new Error('Il faut exactement 2 joueurs.');
    const rules = Object.assign({}, RULES, opts.rules ?? {});
    const byId = new Map(mythics(data).map((c) => [Number(c.id), c]));
    const s = {
      v: 1,
      rules,
      seed: seedOf(seed),
      rng: seedOf(seed),
      round: 0,
      turn: 0,
      first: 0,
      half: 0,
      turnSeq: 0,
      seq: 0,
      koCount: 0,
      extraTurn: false,
      winner: null,
      endReason: null,
      players: players.map((p, i) => {
        const check = validateDeck(data, p?.deck);
        if (!check.ok) throw new Error(`Joueur ${i + 1} : ${check.error}`);
        return {
          id: p.id ?? `j${i + 1}`,
          name: String(p.name ?? `Joueur ${i + 1}`),
          chakra: rules.startChakra,
          skipNext: false,
          champions: p.deck.map((id) => buildChampion(byId.get(Number(id)), rules))
        };
      }),
      log: [],
      lastEvents: []
    };
    const ev = [];
    startRound(s, ev);
    finishTransition(s, ev);
    return s;
  }

  // ─── Lecture ──────────────────────────────────────────────────────────────────────────────
  function currentPlayer(state) {
    if (!state || state.winner !== null && state.winner !== undefined) return null;
    return state.turn;
  }

  function isLow(s, c) {
    return c.hp * 100 <= c.maxHp * s.rules.lowHpPct;
  }

  function legalActions(state, playerIndex) {
    if (currentPlayer(state) !== playerIndex) return [];
    const me = state.players[playerIndex];
    const foeSide = 1 - playerIndex;
    const foe = state.players[foeSide];
    const out = [];
    me.champions.forEach((c, j) => {
      if (!c.alive) return;
      c.moves.forEach((m, k) => {
        if (me.chakra < m.cost) return;
        if (m.kind === 'ultimate' && c.ultimateUsed) return;
        if (c.disabled > 0 && m.kind !== 'support') return;
        if (m.sacrifice && !me.champions.some((x, i) => i !== j && x.alive)) return;
        if (m.targeting === 'enemy') {
          foe.champions.forEach((t, i) => {
            if (t.alive) out.push({ type: 'move', actor: j, move: k, target: { side: foeSide, index: i } });
          });
        } else if (m.targeting === 'ally') {
          me.champions.forEach((t, i) => {
            if (t.alive) out.push({ type: 'move', actor: j, move: k, target: { side: playerIndex, index: i } });
          });
        } else {
          out.push({ type: 'move', actor: j, move: k });
        }
      });
    });
    out.push({ type: 'pass' });
    return out;
  }

  function actionKey(a) {
    if (!a || typeof a !== 'object') return '';
    if (a.type === 'pass') return 'pass';
    if (a.type !== 'move') return '';
    const t = a.target;
    return `move:${a.actor}:${a.move}${t ? `:${t.side}:${t.index}` : ''}`;
  }

  // ─── Événements ───────────────────────────────────────────────────────────────────────────
  function who(s, side, index) {
    const c = s.players[side].champions[index];
    return { side, index, name: c.name };
  }

  function sideIndex(s, c) {
    for (let side = 0; side < 2; side += 1) {
      const index = s.players[side].champions.indexOf(c);
      if (index >= 0) return { side, index };
    }
    return { side: -1, index: -1 };
  }

  function emit(s, ev, c, type, extra) {
    const pos = sideIndex(s, c);
    ev.push(Object.assign({ type, side: pos.side, index: pos.index, name: c.name }, extra));
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
    emit(s, ev, c, 'ko', { cause });
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

  // Perte de PV « coût » (recul, sacrifice d'équipe) : ignore garde et invincibilité, jamais mortelle.
  function payHp(s, ev, c, amount, source) {
    if (!c.alive || amount <= 0) return;
    const lost = Math.min(amount, c.hp - 1);
    if (lost <= 0) return;
    c.hp -= lost;
    emit(s, ev, c, 'damage', { amount: lost, absorbed: 0, hp: c.hp, source });
    hpTriggers(s, ev, c);
  }

  // Dégâts subis. source : 'move' (capacité ennemie) | 'poison' | 'curse'.
  function takeDamage(s, ev, c, amount, source, hit) {
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
    emit(s, ev, c, 'damage', Object.assign({ amount: rest, absorbed, hp: Math.max(0, c.hp), source }, hit ? { hit } : {}));
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

  function strongestFoe(s, c) {
    const pos = sideIndex(s, c);
    let best = null;
    for (const t of s.players[1 - pos.side].champions) {
      if (t.alive && (!best || t.hp > best.hp)) best = t;
    }
    return best;
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
        if (c.lastDamagedTurn === s.turnSeq) continue;
        c.lastDamagedTurn = s.turnSeq;
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
        const t = 'target' in ctx ? ctx.target : strongestFoe(s, c);
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

  // ─── Déroulement ──────────────────────────────────────────────────────────────────────────
  function initiative(s) {
    const alive = s.players.map((p) => p.champions.filter((c) => c.alive));
    if (s.round === 1) {
      const ram = alive.map((list, side) => list.some((c) => hasInitiativeFx(c, (e) => e.foe && e.firstRound
        && alive[1 - side].some((x) => x.name === e.foe))));
      if (ram[0] !== ram[1]) return { first: ram[0] ? 0 : 1, reason: 'ram' };
    }
    const subaru = alive.map((list) => list.some((c) => hasInitiativeFx(c, (e) => !e.foe)));
    if (subaru[0] !== subaru[1]) return { first: subaru[0] ? 0 : 1, reason: 'subaru' };
    const speed = alive.map((list) => Math.max(0, ...list.map((c) => c.speed)));
    if (speed[0] !== speed[1]) return { first: speed[0] > speed[1] ? 0 : 1, reason: 'speed', speed };
    return { first: rand(s) < 0.5 ? 0 : 1, reason: 'tie', speed };
  }

  function startRound(s, ev) {
    s.round += 1;
    const init = initiative(s);
    s.first = init.first;
    s.half = 0;
    const lead = init.reason === 'ram' || init.reason === 'subaru'
      ? s.players[init.first].champions.find((c) => c.alive && hasInitiativeFx(c, init.reason === 'ram' ? (e) => !!e.foe : (e) => !e.foe))
      : null;
    ev.push(Object.assign({ type: 'round', round: s.round, first: s.first, playerName: s.players[s.first].name, reason: init.reason },
      lead ? { by: lead.name } : {}));
    if (s.round === 1 && s.rules.secondPlayerGuard > 0) {
      for (const c of s.players[1 - s.first].champions) addGuard(s, ev, c, s.rules.secondPlayerGuard, 'rule');
    }
    startTurn(s, ev, s.first);
  }

  function startTurn(s, ev, p) {
    s.turn = p;
    s.turnSeq += 1;
    s.extraTurn = false;
    const pl = s.players[p];
    ev.push({ type: 'turn', player: p, playerName: pl.name, round: s.round, extra: false });
    if (s.rules.guardDecayPct > 0) {
      for (const c of pl.champions) {
        if (!c.alive || c.guard <= 0) continue;
        const lost = Math.ceil((c.guard * s.rules.guardDecayPct) / 100);
        c.guard -= lost;
        emit(s, ev, c, 'guardDecay', { amount: lost, guard: c.guard });
      }
    }
    if (pl.skipNext) {
      pl.skipNext = false;
      ev.push({ type: 'skip', player: p, playerName: pl.name });
      endTurn(s, ev, p);
      advance(s, ev);
      return;
    }
    const before = pl.chakra;
    pl.chakra = Math.min(s.rules.maxChakra, pl.chakra + s.rules.chakraPerTurn);
    ev.push({ type: 'chakra', player: p, playerName: pl.name, delta: pl.chakra - before, chakra: pl.chakra });
    for (const c of pl.champions) firePassive(s, ev, c, 'turnStart', {});
  }

  function endTurn(s, ev, p) {
    for (const c of s.players[p].champions) {
      if (c.disabled > 0) {
        if (c.disabledFresh) c.disabledFresh = false;
        else c.disabled -= 1;
      }
    }
  }

  function endRound(s, ev) {
    const order = [s.first, 1 - s.first];
    for (const side of order) {
      for (const c of s.players[side].champions) {
        if (!c.alive) continue;
        if ((c.statuses.poison ?? 0) > 0) takeDamage(s, ev, c, s.rules.poisonDamage, 'poison');
        if (c.alive && (c.statuses.curse ?? 0) > 0) takeDamage(s, ev, c, s.rules.curseDamage, 'curse');
        if (c.alive && (c.statuses.regen ?? 0) > 0) heal(s, ev, c, s.rules.regenHeal, 'regen');
      }
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
      }
    }
    ev.push({ type: 'roundEnd', round: s.round });
  }

  function advance(s, ev) {
    if (s.winner !== null) return;
    if (s.half === 0) {
      s.half = 1;
      startTurn(s, ev, 1 - s.first);
      return;
    }
    endRound(s, ev);
    checkEnd(s, ev);
    if (s.winner !== null) return;
    if (s.round >= s.rules.maxRounds) {
      const pct = hpPct(s);
      const cmp = pct[0].hp * pct[1].max - pct[1].hp * pct[0].max;
      finish(s, ev, cmp > 0 ? 0 : cmp < 0 ? 1 : 'draw', 'rounds');
      return;
    }
    startRound(s, ev);
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
    const pct = hpPct(s).map((x) => (x.max ? Math.round((x.hp * 1000) / x.max) / 10 : 0));
    ev.push({ type: 'end', winner, reason, hpPct: pct, names: s.players.map((p) => p.name) });
  }

  // ─── Résolution d'une capacité (ordre fixe, documenté dans les règles) ────────────────────
  function resolveMove(s, ev, p, action) {
    const me = s.players[p];
    const c = me.champions[action.actor];
    const m = c.moves[action.move];
    const target = action.target ? s.players[action.target.side].champions[action.target.index] : null;

    // 1. Coût.
    if (m.cost > 0) {
      me.chakra -= m.cost;
      ev.push({ type: 'chakra', player: p, playerName: me.name, delta: -m.cost, chakra: me.chakra });
    }
    if (m.kind === 'ultimate') c.ultimateUsed = true;
    ev.push({
      type: 'move', player: p, playerName: me.name, actor: action.actor, side: p, index: action.actor, name: c.name,
      move: action.move, moveName: m.name, kind: m.kind, cost: m.cost,
      target: target ? { side: action.target.side, index: action.target.index, name: target.name } : null
    });

    // 2. Annulation par « annule la prochaine attaque ».
    if (m.targeting === 'enemy' && target.attackBlock) {
      target.attackBlock = false;
      emit(s, ev, target, 'blocked', { by: 'attackBlock', what: 'move', moveName: m.name });
      return;
    }

    // 3. Sacrifice.
    if (m.sacrifice) {
      let weakest = null;
      me.champions.forEach((x) => {
        if (x !== c && x.alive && (!weakest || x.hp < weakest.hp)) weakest = x;
      });
      if (weakest) ko(s, ev, weakest, 'sacrifice');
    }

    // 4. Effets sur la cible ennemie.
    if (m.targeting === 'enemy') {
      if (dealsDamage(m)) {
        const hits = (c.statuses.haste ?? 0) > 0 ? 2 : 1;
        if (hits === 2) {
          delete c.statuses.haste;
          emit(s, ev, c, 'haste', {});
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
          if (h === 1) dmg = Math.round((dmg * s.rules.hasteSecondHitPct) / 100);
          takeDamage(s, ev, target, dmg, 'move', hits === 2 ? h + 1 : 0);
        }
      }
      if (Array.isArray(m.instakill) && target.alive && m.instakill.includes(target.name)) ko(s, ev, target, 'instakill');
      if (m.apply && target.alive) for (const [k, n] of Object.entries(m.apply)) applyStatus(s, ev, target, k, n, 'move');
      if (m.skipFoe) {
        const foe = s.players[1 - p];
        foe.skipNext = true;
        ev.push({ type: 'skipNext', player: 1 - p, playerName: foe.name });
      }
      firePassive(s, ev, c, 'onHit', { target: target.alive ? target : null });
    }

    // 5. Soin / garde / dissipation : cible alliée choisie, ou le lanceur.
    const recv = m.targeting === 'ally' ? target : c;
    const bonus = healBonusOf(c);
    if (m.heal) heal(s, ev, recv, m.heal + bonus, 'move');
    if (m.guard) addGuard(s, ev, recv, m.guard, 'move');
    if (m.cleanse) cleanse(s, ev, recv);

    // 6. Lanceur et équipe.
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

    // 7. Résurrection puis chute du lanceur.
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

    // 8. Tour supplémentaire.
    if (m.extraTurn) s.extraTurn = true;
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

  // Cœur commun à applyAction et à l'IA (pas de validation, mute `s`).
  function step(s, p, action, ev) {
    if (action.type === 'pass') {
      ev.push({ type: 'pass', player: p, playerName: s.players[p].name });
    } else {
      resolveMove(s, ev, p, action);
    }
    checkEnd(s, ev);
    if (s.winner !== null) return;
    if (s.extraTurn) {
      s.extraTurn = false;
      ev.push({ type: 'extraTurn', player: p, playerName: s.players[p].name });
      ev.push({ type: 'turn', player: p, playerName: s.players[p].name, round: s.round, extra: true });
      return;
    }
    endTurn(s, ev, p);
    advance(s, ev);
  }

  function applyAction(state, playerIndex, action) {
    if (!state || !Array.isArray(state.players)) throw new Error('État de duel invalide.');
    if (state.winner !== null && state.winner !== undefined) throw new Error('Le duel est terminé.');
    if (playerIndex !== 0 && playerIndex !== 1) throw new Error('Joueur inconnu.');
    if (state.turn !== playerIndex) throw new Error('Ce n’est pas ton tour.');
    const key = actionKey(action);
    const legal = legalActions(state, playerIndex).find((a) => actionKey(a) === key);
    if (!key || !legal) throw new Error('Action illégale : capacité indisponible, chakra insuffisant ou cible invalide.');
    const s = clone(state);
    const ev = [];
    step(s, playerIndex, legal, ev);
    s.seq += 1;
    finishTransition(s, ev);
    return { state: s, events: ev };
  }

  // Abandon (ou absence prolongée) : défaite immédiate du joueur. Ajout au contrat du §3.
  function forfeit(state, playerIndex, reason) {
    if (!state || (state.winner !== null && state.winner !== undefined)) throw new Error('Le duel est terminé.');
    if (playerIndex !== 0 && playerIndex !== 1) throw new Error('Joueur inconnu.');
    const s = clone(state);
    const ev = [];
    ev.push({ type: 'forfeit', player: playerIndex, playerName: s.players[playerIndex].name, reason: reason === 'timeout' ? 'timeout' : 'forfeit' });
    finish(s, ev, 1 - playerIndex, reason === 'timeout' ? 'timeout' : 'forfeit');
    s.seq += 1;
    finishTransition(s, ev);
    return { state: s, events: ev };
  }

  // ─── IA ───────────────────────────────────────────────────────────────────────────────────
  // Glouton à un coup : simule chaque action légale et garde la meilleure évaluation.
  // Déterministe : départage avec un hachage de state.rng (sans faire avancer le PRNG).
  function champValue(s, c) {
    if (!c.alive) return 0;
    const st = c.statuses;
    let v = 14 + c.hp + Math.min(c.hp, 12) * 0.6;
    v += c.guard * 0.7;
    v += (c.atk + c.atkBonus) * 1.6;
    v += c.buff * 0.5;
    v += (st.rage ?? 0) * 1.6 + (st.regen ?? 0) * 1.5 + (st.haste ? 7 : 0);
    v -= (st.poison ?? 0) * s.rules.poisonDamage * 0.9 + (st.curse ?? 0) * 1.6 + (st.weakness ?? 0) * 1.2;
    v += c.invincible * 5 + (c.attackBlock ? 7 : 0) + (c.saveLethal ? 6 : 0);
    v -= c.disabled * 3;
    if (!c.ultimateUsed) v += 3;
    return v;
  }

  function evaluate(s, p) {
    if (s.winner === p) return 1e6;
    if (s.winner === 1 - p) return -1e6;
    if (s.winner === 'draw') return 0;
    let v = 0;
    for (let side = 0; side < 2; side += 1) {
      const pl = s.players[side];
      let x = pl.chakra * 1.2 - (pl.skipNext ? 9 : 0);
      for (const c of pl.champions) x += champValue(s, c);
      v += side === p ? x : -x;
    }
    return v;
  }

  function chooseAction(state, playerIndex) {
    const acts = legalActions(state, playerIndex);
    if (!acts.length) return { type: 'pass' };
    const base = Object.assign({}, state, { log: [], lastEvents: [] });
    let best = acts[acts.length - 1];
    let bestScore = -Infinity;
    acts.forEach((a, i) => {
      const s = clone(base);
      try {
        step(s, playerIndex, a, []);
      } catch (err) {
        return;
      }
      const noise = mulberry((state.rng ^ Math.imul(i + 1, 0x9E3779B1)) >>> 0).out * 0.05;
      const score = evaluate(s, playerIndex) + noise;
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

  const SOURCES = { poison: 'du poison', curse: 'de la malédiction', recoil: 'en contrecoup', teamHp: 'pour l’effort de l’équipe' };

  function describeEvent(e) {
    if (!e || typeof e !== 'object') return '';
    switch (e.type) {
      case 'round': {
        const why = e.reason === 'subaru' ? ` (${e.by ?? 'Subaru'} ouvre toujours la manche)`
          : e.reason === 'ram' ? ` (${e.by ?? 'Ram'} face à Rem)`
            : e.reason === 'tie' ? ' (égalité de vitesse, tirage au sort)' : ' (champion le plus rapide)';
        return `— Manche ${e.round} — ${e.playerName} commence${why}.`;
      }
      case 'turn': return e.extra ? `${e.playerName} rejoue immédiatement.` : `Tour de ${e.playerName}.`;
      case 'chakra': if (e.delta === 0) return `${e.playerName} est au plafond de chakra (${e.chakra}).`;
        return e.delta > 0 ? `${e.playerName} gagne ${e.delta} chakra (${e.chakra}).` : `${e.playerName} dépense ${-e.delta} chakra (${e.chakra} restant).`;
      case 'skip': return `${e.playerName} saute son tour.`;
      case 'skipNext': return `${e.playerName} sautera son prochain tour.`;
      case 'pass': return `${e.playerName} passe.`;
      case 'move': return `${e.name} utilise ${e.moveName}${e.target ? ` sur ${e.target.name}` : ''}.`;
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
      case 'expire': return e.status === 'invincible' ? `${e.name} n’est plus invulnérable.` : `${e.name} : fin de ${STATUS_LABELS[e.status] ?? e.status}.`;
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
        if (e.effect === 'invincible') return `${e.name} est invulnérable pendant ${e.turns} manche${e.turns > 1 ? 's' : ''}.`;
        if (e.effect === 'attackBlock') return `Protection de ${e.name} : la prochaine capacité ennemie dirigée sur ce champion sera annulée.`;
        if (e.effect === 'disabled') return `${e.name} ne pourra plus attaquer pendant ${e.turns} tour${e.turns > 1 ? 's' : ''}.`;
        return '';
      case 'survive': return `${e.name} survit avec 1 PV !`;
      case 'passive': return `Passif de ${e.name} : ${e.passive}.`;
      case 'ko': {
        const why = { instakill: ' (abattu)', sacrifice: ' (sacrifié)', revive: ' (se sacrifie)', poison: ' (poison)', curse: ' (malédiction)' }[e.cause] ?? '';
        return `${e.name} est KO${why}.`;
      }
      case 'revive': return `${e.name} revient au combat avec ${e.hp} PV.`;
      case 'extraTurn': return `${e.playerName} obtient un tour supplémentaire.`;
      case 'roundEnd': return '';
      case 'forfeit': return e.reason === 'timeout' ? `${e.playerName} est absent trop longtemps.` : `${e.playerName} abandonne.`;
      case 'end': {
        const why = { ko: 'tous les champions adverses sont KO', rounds: `limite de manches (PV restants : ${e.hpPct?.[0]} % contre ${e.hpPct?.[1]} %)`, forfeit: 'abandon', timeout: 'absence' }[e.reason] ?? e.reason;
        if (e.winner === 'draw') return `Match nul — ${why}.`;
        return `Victoire de ${e.names?.[e.winner] ?? `Joueur ${e.winner + 1}`} — ${why}.`;
      }
      default: return '';
    }
  }

  return {
    version: 1,
    RULES,
    STATUS_LABELS,
    KIND_LABELS,
    mythics,
    validateDeck,
    createMatch,
    legalActions,
    applyAction,
    currentPlayer,
    chooseAction,
    describeEvent,
    forfeit,
    targetMode
  };
});
