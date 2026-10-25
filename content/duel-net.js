/* Kyara Duel — client réseau du relais, protocole v2 (chantier B, voir docs/DUEL-SPEC.md §4 et
 * docs/DUEL-V2.md §2). Script classique (aucune syntaxe de module) : il se charge aussi bien dans
 * un content script que dans une page d'extension (duel/duel.html, moz-extension://) ou sous Node.
 *
 * Expose window.KYARA_DUEL_NET (ou globalThis) et module.exports (tests Node).
 *
 *   const net = KYARA_DUEL_NET.connect(url, { name, deck, onEvent });
 *   net.create(); net.join('ABCDE'); net.act(action); net.rematch(); net.leave(); net.close();
 *   net.status   // 'connecting' | 'open' | 'reconnecting' | 'closed'
 *
 * Choix simultanés : à chaque phase (net.phase = 'choose' | 'replace' | 'ended'), chaque joueur
 * de net.pending range UN choix secret avec net.act(action) (une des net.legal). L'adversaire
 * n'apprend que « il a choisi » (message 'chosen', net.chosen = joueurs ayant verrouillé). Le tour
 * est résolu quand les deux ont choisi : un seul message 'state' porte alors tous les événements.
 *   net.pending        // joueurs (0|1) qui doivent encore choisir
 *   net.chosen         // joueurs attendus qui ont déjà verrouillé leur choix
 *   net.phase          // 'choose' | 'replace' | 'ended' | null
 *   net.choice         // mon choix verrouillé (null tant que je n'ai pas choisi)
 *   net.canAct()       // vrai si c'est à moi de choisir (je suis dans net.pending)
 *   net.opponentChosen()  // vrai si l'adversaire a verrouillé son choix
 *
 * onEvent(msg, net) reçoit chaque message du serveur tel quel ({ t: 'welcome' | 'room' | 'state' |
 * 'chosen' | 'end' | 'error' | 'peer' | 'pong', … }) ainsi que des événements locaux { t: 'net', status }
 * à chaque changement de net.status, et { t: 'error', code: 'session_taken', message } si la
 * session est reprise dans un autre onglet (pas de reconnexion automatique dans ce cas).
 *
 * Reconnexion automatique avec délai croissant : le jeton (en mémoire uniquement) permet de
 * reprendre sa place dans le salon pendant le délai de grâce du serveur. Les messages envoyés
 * pendant une coupure sont mis en file et partent dès la reconnexion.
 */
(function () {
  'use strict';

  var PROTOCOL = 2;
  var DEFAULTS = {
    pingMs: 20000, // keepalive applicatif
    deadMs: 50000, // sans aucun message du serveur depuis ce délai : connexion jugée morte
    backoffMinMs: 500,
    backoffMaxMs: 10000,
    maxRetries: 40, // ≈ 6 min de tentatives avant d'abandonner (status 'closed')
    queueMax: 50
  };

  function connect(url, options) {
    var opts = options || {};
    var WS = opts.WebSocket || (typeof WebSocket !== 'undefined' ? WebSocket : null);
    if (!WS) throw new Error('WebSocket indisponible dans cet environnement.');
    var cfg = {};
    Object.keys(DEFAULTS).forEach(function (k) {
      cfg[k] = typeof opts[k] === 'number' ? opts[k] : DEFAULTS[k];
    });

    var ws = null;
    var queue = [];
    var retries = 0;
    var reconnectTimer = null;
    var pingTimer = null;
    var lastSeen = 0;
    var closedByUser = false;
    var profile = { name: opts.name, userId: opts.userId, deck: opts.deck };

    var net = {
      url: url,
      status: 'connecting',
      clientId: null,
      token: null,
      code: null, // code du salon courant
      room: null, // dernier message 'room'
      you: null, // 0 | 1 dans le duel courant
      seq: null, // numéro du dernier état reçu
      state: null, // dernier état du moteur (vue du joueur : le choix adverse est masqué)
      phase: null, // 'choose' | 'replace' | 'ended'
      pending: [], // joueurs qui doivent encore choisir dans cette phase
      chosen: [], // joueurs attendus qui ont déjà verrouillé leur choix
      choice: null, // mon choix verrouillé de la phase courante
      legal: [], // actions légales pour moi dans cet état (fournies par le serveur)
      deadlineAt: null, // horodatage local de fin de la phase courante
      phaseMs: null, // durée totale de la phase courante (pour une jauge)
      ended: null, // dernier message 'end'
      last: null, // résumé du dernier tour résolu ({ phase, actions[2], auto[2] })

      create: function (extra) {
        send(merge({ t: 'create' }, extra));
      },
      join: function (code, extra) {
        send(merge({ t: 'join', code: String(code || '').trim().toUpperCase() }, extra));
      },
      act: function (action) {
        send({ t: 'action', seq: net.seq, action: action });
      },
      rematch: function () {
        send({ t: 'rematch' });
      },
      /** Se déclarer prêt / pas prêt (synchronisé par le relais). */
      ready: function (value) {
        send({ t: 'ready', ready: Boolean(value) });
      },
      /** Accepter les conditions de la mise proposée par le créateur. */
      betAccept: function (stake) {
        send(stake ? { t: 'bet-accept', stake } : { t: 'bet-accept' });
      },
      leave: function () {
        send({ t: 'leave' });
        resetRoom();
      },
      /** Met à jour pseudo et/ou deck (renvoie un hello au serveur). */
      setProfile: function (p) {
        if (p && p.name !== undefined) profile.name = p.name;
        if (p && p.userId !== undefined) profile.userId = p.userId;
        if (p && p.deck !== undefined) profile.deck = p.deck;
        send(hello());
      },
      /** Vrai si je dois encore choisir (action ou remplaçant). */
      canAct: function () {
        return net.you !== null && net.pending.indexOf(net.you) >= 0;
      },
      /** Vrai si l'adversaire a verrouillé son choix (on ne sait pas lequel). */
      opponentChosen: function () {
        return net.you !== null && net.chosen.indexOf(1 - net.you) >= 0;
      },
      /** Millisecondes restantes de la phase courante (null hors duel). */
      timeLeft: function () {
        return net.deadlineAt === null ? null : Math.max(0, net.deadlineAt - Date.now());
      },
      /** Fermeture définitive (pas de reconnexion). Le serveur garde la place pendant le délai de grâce. */
      close: function () {
        closedByUser = true;
        clearTimeout(reconnectTimer);
        stopPing();
        queue = [];
        if (ws) {
          var old = ws;
          ws = null;
          detach(old);
          try {
            old.close(1000);
          } catch (e) {
            /* déjà fermé */
          }
        }
        setStatus('closed');
      }
    };

    function merge(a, b) {
      if (b && typeof b === 'object') Object.keys(b).forEach(function (k) {
        a[k] = b[k];
      });
      return a;
    }

    function hello() {
      return { t: 'hello', v: PROTOCOL, name: profile.name, userId: profile.userId, deck: profile.deck };
    }

    function resetRoom() {
      net.code = null;
      net.room = null;
      net.you = null;
      net.seq = null;
      net.state = null;
      clearPhase();
      net.last = null;
      net.ended = null;
    }

    function clearPhase() {
      net.phase = null;
      net.pending = [];
      net.chosen = [];
      net.choice = null;
      net.legal = [];
      net.deadlineAt = null;
      net.phaseMs = null;
    }

    function emit(msg) {
      if (typeof opts.onEvent !== 'function') return;
      try {
        opts.onEvent(msg, net);
      } catch (e) {
        if (typeof console !== 'undefined') console.error('[Kyara Duel] onEvent :', e);
      }
    }

    function setStatus(s) {
      if (net.status === s) return;
      net.status = s;
      emit({ t: 'net', status: s });
    }

    function isOpen() {
      return ws && ws.readyState === 1;
    }

    function rawSend(msg) {
      ws.send(JSON.stringify(msg));
    }

    function send(msg) {
      if (closedByUser) return;
      if (isOpen() && net.status === 'open') {
        rawSend(msg);
        return;
      }
      queue.push(msg);
      if (queue.length > cfg.queueMax) queue.shift();
    }

    function detach(sock) {
      sock.onopen = sock.onmessage = sock.onclose = sock.onerror = null;
    }

    function stopPing() {
      clearInterval(pingTimer);
      pingTimer = null;
    }

    function open() {
      reconnectTimer = null;
      if (closedByUser) return;
      var sock;
      try {
        sock = new WS(url);
      } catch (e) {
        scheduleReconnect();
        return;
      }
      ws = sock;
      sock.onopen = function () {
        retries = 0;
        lastSeen = Date.now();
        // Reprise de place dans le salon si possible, sinon simple présentation.
        rawSend(net.token && net.code ? { t: 'rejoin', code: net.code, token: net.token } : hello());
        var pending = queue;
        queue = [];
        pending.forEach(rawSend);
        setStatus('open');
        stopPing();
        pingTimer = setInterval(function () {
          if (Date.now() - lastSeen > cfg.deadMs) {
            drop();
            return;
          }
          if (isOpen()) rawSend({ t: 'ping' });
        }, cfg.pingMs);
      };
      sock.onmessage = function (ev) {
        lastSeen = Date.now();
        var msg;
        try {
          msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
        } catch (e) {
          return;
        }
        if (!msg || typeof msg.t !== 'string') return;
        track(msg);
        emit(msg);
      };
      sock.onclose = function (ev) {
        if (ws !== sock) return;
        if (ev && ev.code === 4000) {
          // Session reprise depuis un autre onglet : se reconnecter la lui volerait en boucle.
          emit({ t: 'error', code: 'session_taken', message: 'Ce duel a été repris dans un autre onglet.' });
          closedByUser = true;
          queue = [];
        }
        drop();
      };
      sock.onerror = function () {
        /* onclose suit toujours */
      };
    }

    /** Abandonne la connexion courante et planifie une reconnexion. */
    function drop() {
      stopPing();
      if (ws) {
        var old = ws;
        ws = null;
        detach(old);
        try {
          old.close();
        } catch (e) {
          /* déjà fermé */
        }
      }
      if (closedByUser) setStatus('closed');
      else scheduleReconnect();
    }

    function scheduleReconnect() {
      if (closedByUser || reconnectTimer) return;
      if (retries >= cfg.maxRetries) {
        setStatus('closed');
        return;
      }
      setStatus('reconnecting');
      var base = Math.min(cfg.backoffMaxMs, cfg.backoffMinMs * Math.pow(2, retries));
      retries += 1;
      reconnectTimer = setTimeout(open, Math.round(base * (0.75 + Math.random() * 0.5)));
    }

    /** Garde en mémoire ce que l'UI a besoin de relire (salon, état, jeton). */
    function track(msg) {
      switch (msg.t) {
        case 'welcome':
          net.clientId = msg.clientId;
          net.token = msg.token;
          break;
        case 'room':
          net.code = msg.code;
          net.room = msg;
          if (typeof msg.you === 'number') net.you = msg.you;
          if (msg.status === 'playing') net.ended = null;
          if (msg.status === 'waiting') {
            net.state = null;
            net.seq = null;
            clearPhase();
            net.last = null;
            net.ended = null;
          }
          break;
        case 'state':
          net.seq = msg.seq;
          net.you = msg.you;
          net.state = msg.state;
          net.phase = msg.phase || null;
          net.pending = msg.pending || [];
          net.chosen = msg.chosen || [];
          net.choice = msg.choice || null;
          net.legal = msg.legal || [];
          net.deadlineAt = typeof msg.deadline === 'number' ? Date.now() + msg.deadline : null;
          net.phaseMs = typeof msg.timer === 'number' ? msg.timer : null;
          if (msg.last) net.last = msg.last;
          break;
        case 'chosen':
          // Un joueur a verrouillé son choix. Le mien me revient avec l'action ; celui de l'adversaire sans.
          if (typeof msg.seq === 'number' && msg.seq !== net.seq) break; // message périmé
          net.pending = msg.pending || [];
          net.chosen = msg.chosen || [];
          if (msg.player === net.you) {
            net.choice = msg.action || net.choice;
            net.legal = [];
          }
          break;
        case 'end':
          net.ended = msg;
          net.phase = 'ended';
          net.pending = [];
          net.choice = null;
          net.deadlineAt = null;
          net.legal = [];
          break;
        case 'error':
          if (msg.code === 'rejoin_failed') {
            // Place perdue (délai de grâce dépassé, salon fermé) : nouvelle session propre.
            resetRoom();
            net.token = null;
            if (isOpen()) rawSend(hello());
          } else if (msg.code === 'room_expired') {
            resetRoom();
          }
          break;
        default:
          break;
      }
    }

    open();
    return net;
  }

  var api = { connect: connect, PROTOCOL: PROTOCOL };
  var root = typeof window !== 'undefined' ? window : typeof self !== 'undefined' ? self : typeof globalThis !== 'undefined' ? globalThis : null;
  if (root) root.KYARA_DUEL_NET = api;
  if (typeof module !== 'undefined' && module && module.exports) module.exports = api;
})();
