/* Kyareeh+ — content script
 * Tableau de bord de compte, valorisation en chakra et vente assistée.
 * Tout passe par la session existante de l'utilisateur : aucun identifiant stocké.
 */
(() => {
  'use strict';

  if (window.__kyaraPlusLoaded) return;
  window.__kyaraPlusLoaded = true;

  const ext = globalThis.browser ?? globalThis.chrome;

  /* Le même code tourne sous Firefox et sous Chrome/Edge : le paquet Chrome est
   * dérivé de manifest.json par scripts/build-chrome.mjs. Seuls les libellés qui
   * nomment le navigateur ou sa page de gestion changent. */
  const IS_GECKO = /firefox\//i.test(navigator.userAgent);
  const BROWSER_NAME = IS_GECKO ? 'Firefox' : 'Chrome';
  const RELOAD_HINT = IS_GECKO
    ? 'Passe par about:debugging → « Recharger ».'
    : 'Ouvre chrome://extensions puis clique sur « Actualiser » pour Kyareeh+.';

  /** Source unique de vérité : le manifeste. Évite toute désynchronisation au bump. */
  const VERSION = (() => {
    try {
      return ext?.runtime?.getManifest?.().version || '0.0.0';
    } catch {
      return '0.0.0';
    }
  })();
  const PRICE_KEY = 'kyaraplus.prices.v2';
  const SETTINGS_KEY = 'kyaraplus.settings.v2';
  const CHARS_KEY = 'kyaraplus.characters.v1';
  const PACK_AVG_KEY = 'kyareeh.packavg.v1';
  const PACK_POOLS_KEY = 'kyareeh.packpools.v1';
  const STATS_KEY = 'kyareeh.statboard.v1';
  const SALES_KEY = 'kyareeh.sales.v1';
  const SALES_MAX = 2000;
  // Les comptes suivis sont relus au bout de 12 h (ou à la demande).
  const STAT_CACHE_MS = 12 * 3600 * 1000;
  const STAT_MAX_ACCOUNTS = 20;
  // Après un échec de lecture des amis, on ne réessaie pas avant 10 min.
  const STAT_FRIENDS_RETRY_MS = 10 * 60 * 1000;
  // Pause entre deux lectures de profil : évite de déclencher l'anti-abus du site.
  const STAT_REQUEST_GAP = 350;

  const DEFAULT_SETTINGS = {
    ttlH: 6,
    gapMs: 1200,
    maxBatch: 20,
    discountPct: 0,
    dryRun: false,
    autoPrices: true,
    saleType: 'fixed',
    auctionPct: 15,
    buyoutPct: 0,
    durationHours: 12,
    dupeSort: 'price_desc',
    dealsRarity: 'all',
    dealsSort: 'price_asc',
    dealsPages: 6,
    dealsMinPct: 10,
    dealsType: 'all',
    autoPackIds: [],
    autoPackPicked: false,
    autoMaxPerBoosterMin: 10,
    autoSound: true,
    antiAfk: true,
    autoAllowChakra: true,
    autoRefreshMin: 10,
    autoStopRare: false,
    // Vente automatique : uniquement les doublons, jamais la dernière copie.
    autoSellType: 'fixed',
    autoSellStrategy: 'balanced',
    autoSellMinPrice: 1,
    autoSellIntervalSec: 60,
    autoSellMaxPerCycle: 10,
    autoSellIncludeML: false,
    autoSellDryRun: false
  };

  // Tris acceptés par /api/market/listings (valeurs validées côté serveur).
  const DEAL_SORTS = [
    ['price_asc', 'Prix croissant'],
    ['price_desc', 'Prix décroissant'],
    ['newest', 'Plus récentes'],
    ['ending', 'Fin proche']
  ];

  const DUPE_SORTS = [
    ['price_desc', 'Prix unitaire ↓'],
    ['total_desc', 'Valeur du lot ↓'],
    ['copies_desc', 'Exemplaires ↓'],
    ['rarity_desc', 'Rareté ↓'],
    ['price_asc', 'Prix unitaire ↑'],
    ['name_asc', 'Nom A→Z']
  ];

  const RARITY = {
    C: { label: 'Commune', color: '#9aa4b2' },
    U: { label: 'Peu commune', color: '#4ade80' },
    R: { label: 'Rare', color: '#60a5fa' },
    E: { label: 'Épique', color: '#c084fc' },
    L: { label: 'Légendaire', color: '#fbbf24' },
    M: { label: 'Mythique', color: '#ff4d2e' },
    H: { label: 'Héritage', color: '#f472b6' }
  };

  const SERIES_COLORS = ['#ff8a6d', '#ffb020', '#4ade80', '#60a5fa', '#c084fc', '#f472b6', '#22d3ee', '#a3e635'];

  // Ordre officiel des raretés sur le site (du plus commun au plus rare).
  const RARITY_ORDER = ['C', 'U', 'R', 'E', 'L', 'M', 'H'];

  const nf = new Intl.NumberFormat('fr-FR');
  const fmt = (v) => (v == null || !Number.isFinite(Number(v)) ? '—' : nf.format(Math.round(Number(v))));

  /** Durée lisible : 45 s, 3 min 20 s, 12 min. */
  const fmtWait = (ms) => {
    const total = Math.max(0, Math.round(Number(ms) / 1000));
    if (total < 60) return `${total} s`;
    const min = Math.floor(total / 60);
    const sec = total % 60;
    return sec ? `${min} min ${sec} s` : `${min} min`;
  };
  const plural = (n, word, suffix = '') => `${fmt(n)} ${word}${Number(n) > 1 ? 's' : ''}${suffix}`;
  const esc = (s) =>
    String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const toNum = (v) => {
    // Attention : Number(null) vaut 0. On veut null pour « absent ».
    if (v == null || v === '') return null;
    const n = typeof v === 'string' ? Number.parseFloat(v.replace(',', '.')) : Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const nowTime = (at) =>
    new Date(Number.isFinite(Number(at)) && Number(at) > 0 ? Number(at) : Date.now()).toLocaleTimeString('fr-FR', {
      hour: '2-digit',
      minute: '2-digit'
    });

  class ApiError extends Error {
    constructor(status, message, code = null) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
      this.code = code;
    }
  }

  const ERROR_HINTS = {
    pass_required: 'Laissez-passer expiré : ouvre un booster sur le site, puis réessaie.',
    market_locked: "Le marché n'est pas encore débloqué sur ce compte.",
    not_listable: "Cette carte n'est pas listable (verrouillée ou déjà en vente).",
    invalid_price: 'Prix invalide.',
    too_many_listings: 'Limite d’annonces actives atteinte.',
    chakra: 'Pas assez de chakra pour les frais de dépôt.',
    rate_limited: 'Trop de requêtes : patiente quelques secondes.',
    guest_limit: 'Compte invité : connecte-toi avec Discord.',
    same_device: 'Action refusée depuis le même appareil.'
  };

  function friendlyError(err) {
    const code = err?.code || err?.message;
    return ERROR_HINTS[code] || code || 'Erreur inconnue';
  }

  const state = {
    mounted: false,
    open: false,
    ready: false,
    loading: false,
    error: null,
    user: null,
    collection: [],
    characters: new Map(),
    prices: {},
    config: null,
    access: null,
    mine: null,
    lowest: {},
    fixedLow: {},
    fixedHigh: {},
    auctionBuyout: {},
    buyOrders: {},
    marketLoaded: new Set(),
    marketScanned: new Set(),
    marketLoading: false,
    marketLimit: 24,
    // Onglet Vente : état séparé de l'ancien onglet Doublons.
    sellView: {
      mode: 'mine',
      query: '',
      rarity: 'all',
      series: 'all',
      sort: 'potential_desc',
      onlySellable: false,
      onlyDupes: false,
      limit: 40,
      method: 'balanced',
      detailId: null,
      detail: null,
      detailLoading: false,
      detailError: null,
      refreshing: false,
      lastRefresh: 0
    },
    // Onglet Marché : deux vues internes, sans doublon avec l'onglet Vente.
    marketMode: 'global',
    marketView: {
      query: '',
      rarity: 'all',
      type: 'all',
      sort: 'price_desc',
      items: null,
      total: 0,
      meta: null,
      loading: false,
      error: null,
      page: 1,
      expanded: new Set()
    },
    deals: null,
    dealsMeta: null,
    dealsError: null,
    dealsScanning: false,
    settings: { ...DEFAULT_SETTINGS },
    priceRun: { running: false, done: 0, total: 0, startedAt: 0 },
    lastSync: 0,
    tab: 'account',
    query: '',
    selected: new Set(),
    sell: null,
    // Journal local des annonces créées par Kyareeh+ (pas d'historique côté site).
    salesLog: [],
    salesLogLoaded: false,
    debug: [],
    bootKeys: [],
    notice: '',
    noticeTimer: null,
    version: VERSION,
    manifestVersion: null,
    diskVersion: null,
    manifestOutdated: false,
    update: { checking: false, version: null, error: null, checkedAt: 0 },
    selfProfile: null,
    selfProfileTried: null,
    packs: null,
    packsLoading: false,
    packsError: null,
    packAverages: null,
    packAveragesLoading: false,
    packPools: null,
    packPoolsLoading: false,
    packPoolProgress: null,
    packQuery: '',
    packTarget: null,
    packSearching: false,
    packState: null,
    packStateLoading: false,
    lastAutoRefresh: 0,
    lastAutoSync: 0,
    // Suivi de l'anti-AFK : dernier clic, délai tiré, nombre de réponses.
    antiAfk: { lastAt: 0, lastDelay: 0, clicks: 0, pendingAt: 0, pendingDelay: 0 },
    autoOpen: {
      running: false,
      stop: false,
      opened: 0,
      spent: 0,
      cardCount: 0,
      cards: [],
      best: [],
      counts: {},
      golden: 0,
      godPacks: 0,
      nextAt: 0,
      error: null,
      status: '',
      passNeeded: false,
      startedAt: 0,
      // Garde-fous : génération de boucle, échéance de réveil, dernier battement.
      gen: 0,
      wakeAt: 0,
      beatAt: 0,
      lastOpenAt: 0,
      restarts: 0,
      log: []
    },
    // Vente auto des doublons : pas de reprise après rechargement, par sécurité.
    autoSell: {
      armed: false,
      running: false,
      stop: false,
      gen: 0,
      cycles: 0,
      created: 0,
      matched: 0,
      errors: 0,
      status: '',
      startedAt: 0,
      beatAt: 0,
      nextAt: 0,
      lastError: null,
      preview: null,
      log: []
    },
    reloadArmed: false,
    reloadTimer: null,
    profile: {
      query: '',
      searching: false,
      results: null,
      loading: false,
      error: null,
      user: null,
      value: null,
      progress: null,
      view: 'self'
    },
    // Onglet Stat : classement de comptes suivis + état d'interface.
    stats: {
      data: statEmptyData(),
      ready: false,
      loading: false,
      error: null,
      syncing: false,
      progress: '',
      done: 0,
      total: 0,
      runId: 0,
      query: '',
      searching: false,
      results: null,
      searchError: null,
      friendsSyncing: false,
      friendsError: null,
      friendsReport: null,
      expanded: null
    }
  };

  /* ------------------------------------------------------------------ */
  /* DOM                                                                 */
  /* ------------------------------------------------------------------ */

  let host = null;
  let shadow = null;
  let ui = null;
  let cssLoaded = false;

  const FALLBACK_CSS = `
    :host{all:initial}
    .kp-fab{position:fixed;right:18px;bottom:18px;z-index:2147483000;padding:10px 14px;border-radius:999px;background:#ff4d2e;color:#fff;font:700 13px system-ui;cursor:pointer}
    .kp-panel{position:fixed;right:18px;bottom:74px;z-index:2147483000;width:400px;height:640px;background:#121318;color:#fff;font:13px system-ui;border:1px solid #2d303a;border-radius:16px;overflow:auto}
  `;

  function qs(sel) {
    return shadow ? shadow.querySelector(sel) : null;
  }

  async function mount() {
    if (state.mounted) return;
    host = document.createElement('div');
    host.id = 'kyara-plus-root';
    host.style.cssText = 'all: initial; position: static;';
    shadow = host.attachShadow({ mode: 'open' });

    let css = '';
    try {
      const res = await fetch(ext.runtime.getURL('content/ui.css'));
      css = await res.text();
      cssLoaded = true;
    } catch {
      css = FALLBACK_CSS;
    }

    shadow.innerHTML = `
      <style>${css}</style>
      <button class="kp-fab" type="button" data-act="toggle" title="Kyareeh+ (Alt+K)">
        <span class="kp-diamond">◆</span><span>Kyareeh+</span>
      </button>
      <section class="kp-panel" hidden aria-label="Kyareeh+">
        <header class="kp-head">
          <nav class="kp-modes" id="kp-modes"></nav>
          <div class="kp-brand">
            <span class="kp-logo">◆</span>
            <div><b>Kyareeh+</b><small>chakra &amp; doublons</small></div>
          </div>
          <div class="kp-head-actions">
            <button class="kp-icon-btn" type="button" data-act="refresh" title="Rafraîchir les données">⟳</button>
            <button class="kp-icon-btn" type="button" data-act="close" title="Fermer">✕</button>
          </div>
        </header>
        <div class="kp-stats" id="kp-stats"></div>
        <div class="kp-banner" id="kp-banner" hidden></div>
        <nav class="kp-tabs" id="kp-tabs"></nav>
        <div class="kp-view" id="kp-view"></div>
        <div class="kp-duel-slot" id="kp-duel-slot" hidden></div>
        <footer class="kp-foot" id="kp-foot"></footer>
      </section>
      <div class="kp-modal" id="kp-modal" hidden>
        <div class="kp-modal-card" id="kp-modal-card"></div>
      </div>
    `;

    document.documentElement.appendChild(host);
    ui = {
      fab: qs('.kp-fab'),
      panel: qs('.kp-panel'),
      stats: qs('#kp-stats'),
      banner: qs('#kp-banner'),
      modes: qs('#kp-modes'),
      tabs: qs('#kp-tabs'),
      view: qs('#kp-view'),
      slot: qs('#kp-duel-slot'),
      foot: qs('#kp-foot'),
      modal: qs('#kp-modal'),
      modalCard: qs('#kp-modal-card')
    };

    shadow.addEventListener('click', onClick);
    shadow.addEventListener('change', onChange);
    shadow.addEventListener('input', onInput);
    shadow.addEventListener('keydown', onKeyDown);

    document.addEventListener(
      'keydown',
      (e) => {
        if (e.altKey && !e.ctrlKey && !e.metaKey && String(e.key).toLowerCase() === 'k') {
          e.preventDefault();
          toggle();
        }
      },
      true
    );

    try {
      ext.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
        if (!msg || typeof msg !== 'object') return;
        if (msg.type === 'kp-toggle') {
          toggle();
          sendResponse({ ok: true, open: state.open });
        } else if (msg.type === 'kp-reload') {
          sendResponse({ ok: true });
          setTimeout(reloadExtension, 120);
        } else if (msg.type === 'kp-status') {          sendResponse({
            ok: true,
            ready: state.ready,
            version: state.version,
            user: state.user?.pseudo ?? null,
            value: computeStats(ownedRows()).total
          });
        }
      });
    } catch {
      /* extension reloaded */
    }

    state.mounted = true;
    render();
  }

  function toggle(force) {
    state.open = typeof force === 'boolean' ? force : !state.open;
    render();
  }

  function reloadExtension() {
    notify('Rechargement de l’extension…');

    const fail = (reason) => {
      notify(`${reason} ${RELOAD_HINT}`);
    };

    // runtime.reload() n'est pas disponible dans un content script : on passe par le fond,
    // qui rafraîchit aussi cet onglet avant de couper l'extension.
    // (Un location.reload() lancé d'ici ne s'exécuterait jamais : le contexte est détruit.)
    const ask = ext.runtime.sendMessage({ type: 'kp-reload-extension' });
    Promise.resolve(ask)
      .then((res) => {
        if (!res || !res.ok) throw new Error('refusé');
        // Le fond s'occupe du rechargement de l'onglet juste avant runtime.reload().
      })
      .catch(() => {
        // Repli : recharger la page d'abord, puis l'extension.
        try {
          location.reload();
          setTimeout(() => {
            try {
              ext.runtime.reload();
            } catch {
              /* ignore */
            }
          }, 300);
        } catch {
          fail('Rechargement automatique impossible.');
        }
      });
  }

  /* --- Mise à jour depuis GitHub ------------------------------------- */

  const UPDATE_REPO = 'mRNeFF/kyareeh-plus';
  const UPDATE_BRANCH = 'master';
  const UPDATE_ZIP = `https://github.com/${UPDATE_REPO}/archive/refs/heads/${UPDATE_BRANCH}.zip`;
  const UPDATE_PAGE = `https://github.com/${UPDATE_REPO}`;

  function versionParts(v) {
    return String(v || '0')
      .split('.')
      .map((n) => parseInt(n, 10) || 0);
  }

  /** true si `remote` est plus récent que `local`. */
  function isNewerVersion(remote, local) {
    const a = versionParts(remote);
    const b = versionParts(local);
    for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
      const x = a[i] ?? 0;
      const y = b[i] ?? 0;
      if (x !== y) return x > y;
    }
    return false;
  }

  /**
   * Relit le manifeste du dépôt pour savoir si une version plus récente existe.
   * Permet à quelqu'un qui n'a pas git de voir qu'il est en retard, et de récupérer
   * l'archive en un clic.
   */
  async function checkRemoteVersion(force = false) {
    const u = state.update;
    if (u.checking) return;
    if (!force && u.checkedAt && Date.now() - u.checkedAt < 30 * 60 * 1000) return;

    u.checking = true;
    u.error = null;
    render();
    try {
      const res = await fetch(
        `https://raw.githubusercontent.com/${UPDATE_REPO}/${UPDATE_BRANCH}/manifest.json?t=${Date.now()}`,
        { cache: 'no-store', credentials: 'omit' }
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      u.version = typeof json?.version === 'string' ? json.version : null;
      u.checkedAt = Date.now();
    } catch {
      u.error = 'Vérification impossible (pas de réseau, ou dépôt inaccessible).';
    } finally {
      u.checking = false;
      render();
    }
  }

  /**
   * Bouton unique « Mettre à jour et recharger » :
   *   1. relit la version publiée sur GitHub ;
   *   2. si le dossier local est déjà plus récent que ce que Firefox a en mémoire,
   *      on recharge directement (c'est le cas du dev qui vient de faire git pull) ;
   *   3. sinon on ouvre le téléchargement et on explique la marche à suivre.
   * Dans tous les cas la page est rafraîchie par le script de fond.
   */
  async function updateAndReload() {
    await checkRemoteVersion(true);

    const remote = state.update.version;
    const newerOnline = remote && isNewerVersion(remote, state.version);
    const staleInMemory = Boolean(state.diskVersion && state.manifestVersion && state.diskVersion !== state.manifestVersion);

    if (staleInMemory) {
      notify(`Fichiers v${state.diskVersion} en place : rechargement…`);
      reloadExtension();
      return;
    }

    if (newerOnline) {
      window.open(UPDATE_ZIP, '_blank', 'noopener');
      notify(`v${remote} téléchargée : décompresse dans le dossier, puis reclique ici.`);
      return;
    }

    notify('Tu es déjà à jour — rechargement de l’extension.');
    reloadExtension();
  }

  /** Version du manifeste réellement chargé par Firefox en mémoire. */
  function loadedVersion() {    try {
      return ext.runtime.getManifest().version || null;
    } catch {
      return null;
    }
  }

  /**
   * Version du manifest.json présent sur le disque.
   * On le relit directement (sans cache) : si Firefox a gardé un vieux manifeste
   * pour un add-on temporaire, c'est le seul moyen de voir l'écart.
   */
  async function readDiskVersion() {
    try {
      const url = ext.runtime.getURL('manifest.json');
      const res = await fetch(`${url}?t=${Date.now()}`, { cache: 'no-store' });
      if (!res.ok) return null;
      const json = await res.json();
      return typeof json?.version === 'string' ? json.version : null;
    } catch {
      return null;
    }
  }

  async function checkManifestVersion() {
    state.manifestVersion = loadedVersion();
    state.diskVersion = await readDiskVersion();
    state.manifestOutdated = Boolean(
      state.diskVersion && state.manifestVersion && state.diskVersion !== state.manifestVersion
    );
    render();
  }

  /* ------------------------------------------------------------------ */
  /* Storage                                                             */
  /* ------------------------------------------------------------------ */

  async function storageGet(key, fallback) {
    try {
      const obj = await ext.storage.local.get(key);
      return obj && obj[key] !== undefined ? obj[key] : fallback;
    } catch {
      return fallback;
    }
  }

  async function storageSet(key, value) {
    try {
      await ext.storage.local.set({ [key]: value });
    } catch {
      /* quota / context invalidated */
    }
  }

  let persistTimer = null;
  function persistPricesSoon() {
    if (persistTimer) return;
    persistTimer = setTimeout(() => {
      persistTimer = null;
      storageSet(PRICE_KEY, { savedAt: Date.now(), prices: state.prices });
    }, 1500);
  }

  async function persistSettings() {
    await storageSet(SETTINGS_KEY, state.settings);
  }

  /* ------------------------------------------------------------------ */
  /* API                                                                 */
  /* ------------------------------------------------------------------ */

  function pushDebug(entry) {
    state.debug.unshift({ at: new Date().toLocaleTimeString('fr-FR'), ...entry });
    if (state.debug.length > 80) state.debug.length = 80;
  }

  function pageStorageGet(key) {
    try {
      const value = window.localStorage.getItem(key);
      if (value != null) return value;
    } catch {
      /* storage inaccessible */
    }
    try {
      const ls = window.wrappedJSObject && window.wrappedJSObject.localStorage;
      return ls ? ls.getItem(key) : null;
    } catch {
      return null;
    }
  }

  function pageStorageSet(key, value) {
    try {
      window.localStorage.setItem(key, value);
    } catch {
      /* storage inaccessible */
    }
    try {
      const ls = window.wrappedJSObject && window.wrappedJSObject.localStorage;
      if (ls && ls.getItem(key) !== value) ls.setItem(key, value);
    } catch {
      /* ignore */
    }
  }

  function readAuthHeaders() {
    const headers = {};
    try {
      const token = pageStorageGet('kyara_token');
      if (token) headers.authorization = `Bearer ${token}`;
    } catch {
      /* ignore */
    }
    try {
      let device = pageStorageGet('kyara_device');
      if (!device) {
        device = typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
        pageStorageSet('kyara_device', device);
      }
      if (device) headers['x-device-id'] = device;
    } catch {
      /* ignore */
    }
    return headers;
  }

  function readPassHeader() {
    try {
      const pass = JSON.parse(pageStorageGet('kyara_pass') || 'null');
      if (pass && pass.pass && Number(pass.expiresAt) > Date.now()) return { 'x-pass': pass.pass };
    } catch {
      /* ignore */
    }
    return {};
  }

  async function api(path, options = {}) {
    const method = options.method || 'GET';
    const started = performance.now();
    const headers = { accept: 'application/json', ...readAuthHeaders() };
    if (method !== 'GET') Object.assign(headers, readPassHeader());
    if (options.body != null) headers['content-type'] = 'application/json';

    try {
      const res = await fetch(path, {
        method,
        credentials: 'include',
        cache: 'no-store',
        headers,
        body: options.body != null ? JSON.stringify(options.body) : undefined,
        signal: AbortSignal.timeout(options.timeout || 20000)
      });
      const text = await res.text();
      let data = null;
      if (text) {
        try {
          data = JSON.parse(text);
        } catch {
          data = text;
        }
      }
      const ms = Math.round(performance.now() - started);
      pushDebug({ method, path, status: res.status, ms, ok: res.ok });
      if (!res.ok) {
        let message = `HTTP ${res.status}`;
        let code = null;
        if (data && typeof data === 'object') {
          message = data.message || data.error || message;
          code =
            typeof data.code === 'string'
              ? data.code
              : typeof data.error === 'string'
                ? data.error
                : null;
        } else if (typeof data === 'string' && data.trim()) message = data.trim().slice(0, 180);
        throw new ApiError(res.status, message, code);
      }
      return data;
    } catch (err) {
      if (err instanceof ApiError) throw err;
      const ms = Math.round(performance.now() - started);
      const message = err?.name === 'TimeoutError' ? 'Délai dépassé' : err?.message || 'Erreur réseau';
      pushDebug({ method, path, status: 0, ms, ok: false, error: message });
      throw new ApiError(0, message);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Data loading                                                        */
  /* ------------------------------------------------------------------ */

  async function boot() {
    // Version du code présent sur le disque.
    state.version = VERSION;

    // Version du manifeste réellement chargé par Firefox en mémoire.
    state.manifestVersion = loadedVersion();

    // Si le manifeste du disque est plus récent que celui chargé, l'add-on
    // temporaire n'a pas été rechargé : Firefox garde le manifeste du chargement.
    state.diskVersion = await readDiskVersion();
    state.manifestOutdated = Boolean(
      state.diskVersion && state.manifestVersion && state.diskVersion !== state.manifestVersion
    );

    const saved = await storageGet(SETTINGS_KEY, {});
    state.settings = { ...DEFAULT_SETTINGS, ...(saved || {}) };
    for (const key of ['ttlH', 'gapMs', 'maxBatch', 'discountPct', 'auctionPct', 'buyoutPct', 'durationHours', 'dealsPages', 'dealsMinPct', 'autoMaxPerBoosterMin']) {
      const value = Number(state.settings[key]);
      state.settings[key] = Number.isFinite(value) ? value : DEFAULT_SETTINGS[key];
    }
    state.settings.dryRun = Boolean(state.settings.dryRun);
    state.settings.autoPrices = state.settings.autoPrices !== false;
    state.settings.saleType = state.settings.saleType === 'auction' ? 'auction' : 'fixed';
    state.settings.autoSellType = state.settings.autoSellType === 'auction' ? 'auction' : 'fixed';
    state.settings.autoSellStrategy = ['quick', 'balanced', 'max'].includes(state.settings.autoSellStrategy)
      ? state.settings.autoSellStrategy
      : 'balanced';
    state.settings.autoSellMinPrice = Math.max(1, Math.round(Number(state.settings.autoSellMinPrice) || 1));
    state.settings.autoSellIntervalSec = Math.min(
      3600,
      Math.max(30, Math.round(Number(state.settings.autoSellIntervalSec) || 60))
    );
    state.settings.autoSellMaxPerCycle = Math.min(
      10,
      Math.max(1, Math.round(Number(state.settings.autoSellMaxPerCycle) || 10))
    );
    state.settings.autoSellIncludeML = Boolean(state.settings.autoSellIncludeML);
    state.settings.autoSellDryRun = Boolean(state.settings.autoSellDryRun);
    state.settings.dealsRarity = String(state.settings.dealsRarity || 'all');
    state.settings.dupeSort = DUPE_SORTS.some(([value]) => value === state.settings.dupeSort) ? state.settings.dupeSort : 'price_desc';
    state.settings.dealsType = ['all', 'fixed', 'auction'].includes(state.settings.dealsType) ? state.settings.dealsType : 'all';
    state.settings.dealsSort = DEAL_SORTS.some(([value]) => value === state.settings.dealsSort) ? state.settings.dealsSort : 'price_asc';
    state.settings.dealsPages = Math.min(20, Math.max(1, Math.round(state.settings.dealsPages)));
    state.settings.dealsMinPct = Math.min(90, Math.max(0, Math.round(state.settings.dealsMinPct)));
    // Migration vers la formule T_max = (9 − B) × I + R : l'ancien réglage
    // « minutes par booster » n'a plus le même sens, on repart sur 10 min.
    if (!state.settings.autoPacingV2) {
      state.settings.autoPacingV2 = true;
      state.settings.autoMaxPerBoosterMin = DEFAULT_SETTINGS.autoMaxPerBoosterMin;
    }
    state.settings.autoMaxPerBoosterMin = Math.min(
      60,
      Math.max(1, Math.round(Number(state.settings.autoMaxPerBoosterMin ?? DEFAULT_SETTINGS.autoMaxPerBoosterMin)))
    );
    // Anciens réglages (quantité, boucle, pause fixe, variance, séries) : plus utilisés.
    for (const stale of [
      'autoCount',
      'autoLoop',
      'autoDelayMs',
      'autoJitterMs',
      'autoSeriesCount',
      'autoSeriesSec',
      'autoMaxDelaySec'
    ]) {
      delete state.settings[stale];
    }
    state.settings.autoRefreshMin = Math.min(
      120,
      Math.max(1, Math.round(state.settings.autoRefreshMin ?? DEFAULT_SETTINGS.autoRefreshMin))
    );
    // Sélection de boosters : tableau d'ids, avec reprise de l'ancien réglage unique.
    state.settings.autoPackIds = Array.isArray(state.settings.autoPackIds)
      ? state.settings.autoPackIds.map(String)
      : state.settings.autoPackId
        ? [String(state.settings.autoPackId)]
        : [];
    delete state.settings.autoPackId;
    state.settings.autoPackPicked = Boolean(state.settings.autoPackPicked);
    state.settings.autoSound = state.settings.autoSound !== false;
    state.settings.antiAfk = state.settings.antiAfk !== false;
    state.settings.autoAllowChakra = state.settings.autoAllowChakra !== false;
    state.settings.autoStopRare = Boolean(state.settings.autoStopRare);
    const cached = await storageGet(PRICE_KEY, {});
    if (cached && typeof cached === 'object') {
      state.prices = cached.prices && typeof cached.prices === 'object' ? cached.prices : cached;
    }
    await loadSalesLog();
    await mount();
    await loadData();
    await loadAutoLog();
    // L'onglet Stat est global : rien à collecter ici, il charge son analyse
    // à la première ouverture (ou après 12 h).
    startAutoRefreshLoop();
    installAntiAfk();
    startAutoWatchdog();
    // Vérifie une fois au démarrage si une version plus récente existe sur GitHub.
    setTimeout(() => checkRemoteVersion(), 2500);
    // Reprise de l'auto-open s'il tournait avant un rechargement de page.
    setTimeout(() => resumeAutoOpenIfNeeded(), 1500);
  }

  /** Vigile de la boucle : la relance si elle se tait alors qu'elle est active. */
  let autoWatchdogTimer = null;
  function startAutoWatchdog() {
    if (autoWatchdogTimer) return;
    autoWatchdogTimer = setInterval(() => {
      try {
        ensureAutoAlive();
        updateCountdownText();
      } catch {
        /* jamais bloquant */
      }
    }, 20000);
    // Au retour sur l'onglet (ou après une mise en veille), on vérifie tout de suite.
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) return;
      ensureAutoAlive();
    });
  }

  /** L'auto-open ne s'arrête que sur demande : on le relance après un rechargement. */
  async function resumeAutoOpenIfNeeded(attempt = 1) {
    if (state.autoOpen.running) return;
    const saved = await storageGet(AUTO_ACTIVE_KEY, null);
    if (!saved || !saved.at) return;
    // Trop vieux : on considère que la session est terminée.
    if (Date.now() - Number(saved.at) > 12 * 3600 * 1000) {
      await storageSet(AUTO_ACTIVE_KEY, { at: 0 });
      return;
    }
    if (!state.user) {
      // Compte pas encore chargé (réseau lent, 429 au démarrage) : on retente.
      if (attempt < 5) setTimeout(() => resumeAutoOpenIfNeeded(attempt + 1), 15000);
      return;
    }
    startAutoOpen({ resume: true });
  }

  async function loadCharacters() {
    const cached = await storageGet(CHARS_KEY, null);
    if (cached && Array.isArray(cached.items) && cached.at && Date.now() - cached.at < 24 * 3600 * 1000) {
      return cached.items;
    }
    const chars = await api('/api/characters', { timeout: 45000 }).catch(() => null);
    if (Array.isArray(chars)) {
      storageSet(CHARS_KEY, { at: Date.now(), items: chars });
      return chars;
    }
    return cached?.items ?? null;
  }

  async function loadData(opts = {}) {
    state.loading = true;
    state.error = null;
    render();

    try {
      const [boot, coll, chars, config, access, mine] = await Promise.all([
        api('/api/me/bootstrap').catch((e) => {
          if (e.status === 401) return null;
          throw e;
        }),
        api('/api/me/collection?lean=1').catch(() => null),
        loadCharacters(),
        api('/api/config').catch(() => null),
        api('/api/me/market/access').catch(() => null),
        api('/api/me/market').catch(() => null)
      ]);

      state.bootKeys = boot && typeof boot === 'object' ? Object.keys(boot) : [];
      state.user = boot?.me ?? null;

      if (!state.user) {
        try {
          state.user = await api('/api/me');
        } catch {
          state.user = null;
        }
      }

      if (Array.isArray(coll)) state.collection = coll;
      else if (Array.isArray(coll?.items)) state.collection = coll.items;
      else state.collection = [];
      publishDuelProfile();

      hydrateEmbeddedPrices();

      if (Array.isArray(chars)) {
        state.characters = new Map(chars.map((c) => [String(c.id), c]));
      } else if (Array.isArray(chars?.items)) {
        state.characters = new Map(chars.items.map((c) => [String(c.id), c]));
      }

      state.config = config;
      state.access = access;
      state.mine = mine;
      state.ready = true;
      state.lastSync = Date.now();

      const ids = new Set(state.collection.map((c) => String(c.characterId ?? c.id)));
      state.selected = new Set([...state.selected].filter((id) => ids.has(id)));

      if (!opts.keepPrices && state.user && state.settings.autoPrices) {
        schedulePriceRun();
      }

      // Profil public (rang, titre, points, avatar) : /api/me ne les renvoie pas.
      if (
        state.user?.id &&
        String(state.selfProfileTried) !== String(state.user.id) &&
        (!state.selfProfile || String(state.selfProfile.id) !== String(state.user.id))
      ) {
        loadSelfProfile();
      }
    } catch (err) {
      state.error = err instanceof ApiError ? friendlyError(err) : String(err?.message || err);
    } finally {
      state.loading = false;
      render();
      // Vérifie l'écart entre le manifeste du disque et celui gardé par Firefox.
      setTimeout(() => checkManifestVersion(), 0);
    }
  }

  async function loadSelfProfile() {
    const id = state.user?.id;
    if (!id) return;
    state.selfProfileTried = id;
    try {
      const data = await api(`/api/users/${encodeURIComponent(id)}`, { timeout: 20000 });
      if (data && typeof data === 'object') {
        state.selfProfile = data;
        render();
      }
    } catch {
      /* le header retombe sur /api/me */
    }
  }

  /**
   * Fusionne un patch de compte sans jamais écraser une valeur connue par `undefined`.
   * Certaines réponses d'API sont partielles : si `/api/me` omet `freePacks`, on garde
   * la dernière valeur au lieu de croire qu'il n'y a plus aucun booster offert.
   */
  function mergeUser(patch) {
    if (!patch || typeof patch !== 'object') return;
    const base = state.user && typeof state.user === 'object' ? state.user : {};
    const next = { ...base };
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined || value === null) continue;
      next[key] = value;
    }
    state.user = next;
  }

  async function refreshLight() {
    try {
      const [me, coll] = await Promise.all([
        api('/api/me').catch(() => null),
        api('/api/me/collection?lean=1').catch(() => null)
      ]);
      if (me) mergeUser(me);
      if (Array.isArray(coll)) {
        state.collection = coll;
        publishDuelProfile();
      }
      state.lastSync = Date.now();
      render();
    } catch {
      /* silencieux */
    }
  }

  /* Rafraîchissement périodique du compte : boosters, chakra, collection. */
  let autoRefreshTimer = null;

  async function autoRefreshTick(force = false) {
    if (state.loading) return;
    // On ne saute plus le tick quand l'onglet est en arrière-plan : c'est justement
    // la situation d'une nuit entière, et l'auto-open a besoin de voir arriver les boosters.
    if (!force && Date.now() - (state.lastAutoRefresh || 0) < 30 * 1000) return;
    try {
      const me = await api('/api/me', { timeout: 20000 }).catch(() => null);
      if (me && typeof me === 'object') mergeUser(me);
      await loadPackState(true).catch(() => {});
      await loadPacks(true).catch(() => {});
      state.lastAutoRefresh = Date.now();
      render();
    } catch {
      /* réseau : on retentera au prochain tick */
    }
  }

  function startAutoRefreshLoop() {
    if (autoRefreshTimer) clearInterval(autoRefreshTimer);
    const minutes = Math.min(
      120,
      Math.max(1, Math.round(Number(state.settings.autoRefreshMin) || AUTO_REFRESH_DEFAULT))
    );
    autoRefreshTimer = setInterval(() => autoRefreshTick(), minutes * 60000);
  }

  /* ------------------------------------------------------------------ */
  /* Pricing                                                             */
  /* ------------------------------------------------------------------ */

  function priceFresh(entry) {
    if (!entry || !entry.at) return false;
    const ttl = entry.failed ? 15 * 60 * 1000 : state.settings.ttlH * 3600 * 1000;
    return Date.now() - entry.at < ttl;
  }

  function priceOf(id) {
    const p = state.prices[String(id)];
    if (!p) return null;
    const v = p.m7 ?? p.m30;
    return v == null || Number(v) <= 0 ? null : Number(v);
  }

  function priceLow(id) {
    const p = state.prices[String(id)];
    const v = p?.m30 ?? p?.m7;
    return v == null || Number(v) <= 0 ? null : Number(v);
  }

  function schedulePriceRun() {
    if (state.priceRun.running) return;
    const ids = [...new Set(state.collection.map((c) => String(c.characterId ?? c.id)))];
    const missing = ids.filter((id) => !priceFresh(state.prices[id]));
    if (!missing.length) return;
    loadPrices(missing);
  }

  function parsePriceEntry(bag) {
    if (!bag || typeof bag !== 'object') return null;
    const src = bag.prices && typeof bag.prices === 'object' ? bag.prices : bag;
    return {
      m7: toNum(src.median7d ?? src.median7 ?? src.median),
      m30: toNum(src.median30d ?? src.median30),
      last: toNum(src.lastPrice),
      sales7d: toNum(src.sales7d),
      sales30d: toNum(src.sales30d),
      days: Array.isArray(src.days) ? src.days : null,
      lastSales: Array.isArray(src.lastSales) ? src.lastSales.slice(0, 20) : null,
      lastAt: src.lastAt ?? null,
      at: Date.now()
    };
  }

  /**
   * Fusionne une entrée de prix sans perdre l'historique déjà récupéré.
   * `/api/me/collection/prices` ne renvoie pas `days` ni `lastSales` : un simple
   * remplacement effacerait la série chargée par `/api/market/prices/:id`.
   */
  function mergePriceEntry(id, entry) {
    const key = String(id ?? '');
    if (!key) return;
    const prev = state.prices[key];
    if (!entry) {
      state.prices[key] = prev ?? { m7: null, m30: null, at: Date.now(), failed: true };
      return;
    }
    state.prices[key] = {
      ...(prev ?? {}),
      ...entry,
      days: entry.days ?? prev?.days ?? null,
      lastSales: entry.lastSales ?? prev?.lastSales ?? null
    };
  }

  async function loadPrices(ids, force = false) {
    if (state.priceRun.running) return;
    const list = [...new Set((force ? ids : ids.filter((id) => !priceFresh(state.prices[String(id)]))).map(String))];
    if (!list.length) return;

    state.priceRun = { running: true, done: 0, total: list.length, startedAt: Date.now() };
    render();

    for (let offset = 0; offset < list.length; offset += 500) {
      if (!state.priceRun.running) break;
      const chunk = list.slice(offset, offset + 500);
      let array = null;

      try {
        const data = await api(`/api/me/collection/prices?ids=${chunk.join(',')}`, { timeout: 45000 });
        if (Array.isArray(data)) array = data;
        else if (Array.isArray(data?.prices)) array = data.prices;
        else throw new ApiError(0, 'Réponse inattendue');
      } catch {
        array = null;
      }

      if (array) {
        chunk.forEach((id, index) => {
          mergePriceEntry(id, parsePriceEntry(array[index]));
        });
        state.priceRun.done += chunk.length;
      } else if (chunk.length <= 80) {
        for (const id of chunk) {
          if (!state.priceRun.running) break;
          try {
            const data = await api(`/api/market/prices/${encodeURIComponent(id)}`, { timeout: 15000 });
            mergePriceEntry(id, parsePriceEntry(data));
          } catch {
            mergePriceEntry(id, null);
          }
          state.priceRun.done += 1;
          await sleep(120);
        }
      } else {
        chunk.forEach((id) => {
          mergePriceEntry(id, null);
        });
        state.priceRun.done += chunk.length;
      }

      persistPricesSoon();
      render();
      await sleep(150);
    }

    state.priceRun.running = false;
    persistPricesSoon();
    render();
  }

  function hydrateEmbeddedPrices() {
    for (const item of state.collection) {
      const id = String(item.characterId ?? item.id ?? '');
      if (!id || !item.prices || state.prices[id]) continue;
      const entry = parsePriceEntry(item.prices);
      if (entry) state.prices[id] = entry;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Derived data                                                        */
  /* ------------------------------------------------------------------ */

  function getCfg() {
    const m = state.config?.market ?? state.config ?? {};
    const feePct = toNum(m.listingFeePct);
    const feeMin = toNum(m.listingFeeMin);
    const taxPct = toNum(m.saleTaxPct);
    const maxActive = toNum(m.maxActiveListings ?? m.maxListingsPerUser ?? m.listingsMax);
    const durations = Array.isArray(m.durationsHours) && m.durationsHours.length ? m.durationsHours : [12, 24, 48];
    return {
      feePct: feePct == null ? 2 : feePct,
      feeMin: feeMin == null ? 1 : feeMin,
      taxPct: taxPct == null ? 5 : taxPct,
      maxActive,
      durations
    };
  }
  function feeOf(price) {
    const cfg = getCfg();
    return Math.max(cfg.feeMin, Math.ceil((price * cfg.feePct) / 100));
  }

  function taxOf(price) {
    return Math.ceil((price * getCfg().taxPct) / 100);
  }

  function netOf(price) {
    return Math.max(0, price - taxOf(price) - feeOf(price));
  }

  function recycleOf(rarity) {
    const map = state.config?.recycle ?? {};
    const value = toNum(map[String(rarity || 'C').toUpperCase()]);
    return value == null ? 0 : value;
  }

  function rarityInfo(rarity) {
    return RARITY[String(rarity || 'C').toUpperCase()] ?? RARITY.C;
  }

  function imgSrc(c) {
    const raw = c?.image || c?.imageUrl || '';
    if (!raw || /^(javascript|data|blob):/i.test(raw)) return '/brand/cards/card-back.svg';
    if (/^https?:\/\//i.test(raw)) return raw;
    return raw.startsWith('/') ? raw : `/${raw}`;
  }

  function apiId(value) {
    const n = Number(value);
    return Number.isFinite(n) && String(n) === String(value) ? n : value;
  }

  function ownedRows() {
    const rows = [];
    for (const item of state.collection) {
      const rawId = item.characterId ?? item.id ?? item.character?.id;
      if (rawId == null) continue;
      const id = String(rawId);
      const ch = state.characters.get(id) ?? item.character ?? {};
      const qty = Math.max(1, Number(item.qty ?? item.quantity ?? 1));
      const listableRaw = item.listable ?? item.listableQty ?? item.sellable;
      const listable = listableRaw == null ? qty : Math.max(0, Number(listableRaw));
      // Champs officiels du site pour expliquer un blocage de revente.
      const lockedQty = Math.max(0, Number(item.locked ?? item.lockedQty ?? 0) || 0);
      const price = priceOf(id);
      rows.push({
        id,
        rawId,
        qty,
        listable,
        lockedQty,
        pinned: Boolean(item.pinned),
        sellBlock: item.sellBlock ?? null,
        resaleUntil: item.resaleUntil ?? item.sellBlockUntil ?? null,
        escrow: item.escrow ?? null,
        item,
        c: ch,
        name: ch.name ?? item.name ?? `Carte #${id}`,
        rarity: String(ch.rarity ?? item.rarity ?? 'C').toUpperCase(),
        series: ch.series ?? item.series ?? '',
        image: imgSrc(ch.image ? ch : item),
        price,
        low: priceLow(id)
      });
    }
    return rows;
  }

  function sellableOf(row) {
    if (!row || row.qty <= 1) return 0;
    return Math.max(0, Math.min(row.qty - 1, row.listable));
  }

  /**
   * Exemplaires réellement listables, **dernière copie incluse**.
   * `listable` vient du serveur : c'est lui qui décide (verrou de revente, annonce
   * déjà en ligne…). On ne force donc plus `qty - 1`, sinon une carte possédée en
   * un seul exemplaire ne serait jamais vendable depuis l'extension.
   * À défaut de `listable`, on retire les exemplaires verrouillés (`locked`).
   */
  function sellableAllOf(row) {
    if (!row) return 0;
    const qty = Math.max(0, Number(row.qty) || 0);
    const locked = Math.max(0, Number(row.lockedQty) || 0);
    const listable = row.listable == null ? qty - locked : Math.max(0, Number(row.listable));
    return Math.max(0, Math.min(qty, listable));
  }

  /** Toutes les cartes possédées, avec ce qui est vendable et ce qui ne l'est pas. */
  function sellRows() {
    return ownedRows().map((row) => {
      const sellable = sellableAllOf(row);
      return {
        ...row,
        sellable,
        locked: Math.max(0, row.qty - sellable),
        hasDupes: row.qty > 1,
        lastCopy: sellable >= row.qty && row.qty > 0,
        // Explication du blocage (revente différée, mise en vente, échange…).
        block: sellable > 0 ? null : sellBlockOfRow({ ...row, sellable })
      };
    });
  }

  /** Ligne de collection correspondant à un id de carte. */
  function sellRowOf(id) {
    const key = String(id ?? '');
    return sellRows().find((row) => String(row.id) === key) ?? null;
  }

  function duplicateRows() {
    return ownedRows()
      .map((r) => ({ ...r, sellable: sellableOf(r) }))
      .filter((r) => r.sellable > 0);
  }

  /* AUTOSELL:BEGIN — sélection pure des doublons, testée par verify-autosell.mjs */
  /**
   * Nombre d'exemplaires réellement « en trop » : on garde toujours une copie.
   * `listable` inclut la dernière copie ; on ne peut donc pas l'utiliser tel quel.
   */
  function autoSellSpare(row) {
    if (!row) return 0;
    const qty = Math.max(0, Number(row.qty) || 0);
    if (qty <= 1) return 0;
    const locked = Math.max(0, Number(row.lockedQty) || 0);
    const rawListable = row.listable == null ? qty - locked : Number(row.listable);
    const listable = Number.isFinite(rawListable) ? Math.max(0, rawListable) : qty - locked;
    return Math.max(0, Math.min(qty - 1, listable));
  }

  /**
   * Filtre les lignes de vente pour ne garder que les doublons sûrs.
   * `price` doit déjà être résolu par l'appelant (null = pas de prix connu).
   */
  function autoSellSelect(rows, options = {}) {
    const includeML = Boolean(options.includeML);
    const minPrice = Math.max(0, Number(options.minPrice) || 0);
    return (Array.isArray(rows) ? rows : [])
      .map((row) => ({ ...row, autoQty: autoSellSpare(row) }))
      .filter((row) => {
        if (!row || row.autoQty <= 0) return false;
        if (row.pinned) return false;
        if (row.sellBlock || row.block) return false;
        if (!includeML && ['M', 'L'].includes(String(row.rarity || '').toUpperCase())) return false;
        if (row.price == null || row.price === '') return false;
        const price = Number(row.price);
        if (!Number.isFinite(price) || price < minPrice) return false;
        return true;
      })
      .sort(
        (a, b) =>
          Number(b.price) * b.autoQty - Number(a.price) * a.autoQty ||
          Number(b.price) - Number(a.price) ||
          String(a.name ?? '').localeCompare(String(b.name ?? ''), 'fr')
      );
  }

  /** Prix d'une stratégie de vente, sans jamais retomber sur un prix inventé. */
  function autoSellStrategyPrice(rec, strategy = 'balanced') {
    if (!rec || rec.estimated) return null;
    const pick = rec[strategy] ?? rec.balanced;
    const price = Number(pick?.price);
    return Number.isFinite(price) && price > 0 ? Math.max(1, Math.round(price)) : null;
  }

  /** Répartit les places d'annonce disponibles, en commençant par les lots les plus values. */
  function autoSellBuildPlan(candidates, options = {}) {
    const slots = Math.max(0, Math.min(10, Math.round(Number(options.slots) || 0)));
    const maxPerCycle = Math.max(
      1,
      Math.min(slots || 10, Math.round(Number(options.maxPerCycle) || slots || 10))
    );
    let left = Math.min(slots, maxPerCycle);
    const plan = [];
    for (const row of Array.isArray(candidates) ? candidates : []) {
      if (left <= 0) break;
      const qty = Math.min(Math.max(0, Number(row.autoQty) || 0), left);
      if (qty <= 0) continue;
      plan.push({ ...row, qty });
      left -= qty;
    }
    return plan;
  }
  /* AUTOSELL:END */

  /* SALES:BEGIN — cumuls purs du graphique de ventes, testés par verify-sales-chart.mjs */
  function salesTotals(log) {
    const totals = { net: 0, count: 0, matched: 0, auto: 0, manual: 0, autoNet: 0, manualNet: 0 };
    for (const entry of Array.isArray(log) ? log : []) {
      const net = Math.max(0, Number(entry?.net) || 0);
      totals.net += net;
      totals.count += 1;
      if (entry?.source === 'auto') {
        totals.auto += 1;
        totals.autoNet += net;
      } else {
        totals.manual += 1;
        totals.manualNet += net;
      }
      if (entry?.matched) totals.matched += 1;
    }
    return totals;
  }

  /** Net cumulé par jour, sur les `days` derniers jours (auto et manuel séparés). */
  function salesChartSeries(log, now = Date.now(), days = 7) {
    const count = Math.max(2, Math.min(31, Math.round(Number(days) || 7)));
    const end = new Date(now);
    end.setHours(0, 0, 0, 0);
    const start = new Date(end);
    start.setDate(start.getDate() - (count - 1));

    const buckets = Array.from({ length: count }, (_, index) => {
      const date = new Date(start);
      date.setDate(start.getDate() + index);
      return { at: date.getTime(), auto: 0, manual: 0 };
    });

    for (const entry of Array.isArray(log) ? log : []) {
      const at = Number(entry?.at);
      if (!Number.isFinite(at) || at < start.getTime() || at > now) continue;
      const date = new Date(at);
      date.setHours(0, 0, 0, 0);
      const index = Math.round((date.getTime() - start.getTime()) / 86400000);
      if (index < 0 || index >= count) continue;
      const net = Math.max(0, Number(entry.net) || 0);
      buckets[index][entry.source === 'auto' ? 'auto' : 'manual'] += net;
    }

    let auto = 0;
    let manual = 0;
    const points = buckets.map((bucket) => {
      auto += bucket.auto;
      manual += bucket.manual;
      return { at: bucket.at, auto, manual };
    });
    const max = Math.max(1, ...points.map((point) => Math.max(point.auto, point.manual)));
    return { points, max };
  }
  /* SALES:END */

  /**
   * Prix auto : on réutilise exactement les trois stratégies de la vente manuelle.
   * Sans données de marché, on renvoie null : la vente auto n'invente pas de prix.
   */
  function autoSellPrice(row, strategy = state.settings.autoSellStrategy) {
    return autoSellStrategyPrice(rowRecommendation(row, row), strategy);
  }

  function filteredDupes() {
    const all = duplicateRows();
    const query = state.query.trim().toLowerCase();
    const rows = query ? all.filter((r) => `${r.name} ${r.series}`.toLowerCase().includes(query)) : all.slice();
    const sort = state.settings.dupeSort;

    const rarityRank = (code) => RARITY_ORDER.indexOf(String(code || 'C').toUpperCase());
    const valueOf = (row) => (row.price == null ? -1 : row.price);

    const comparators = {
      price_desc: (a, b) => valueOf(b) - valueOf(a) || b.sellable - a.sellable,
      price_asc: (a, b) => {
        // Les cartes sans prix restent en fin de liste.
        if (a.price == null && b.price == null) return a.name.localeCompare(b.name);
        if (a.price == null) return 1;
        if (b.price == null) return -1;
        return a.price - b.price || b.sellable - a.sellable;
      },
      copies_desc: (a, b) => b.sellable - a.sellable || valueOf(b) - valueOf(a),
      rarity_desc: (a, b) => rarityRank(b.rarity) - rarityRank(a.rarity) || valueOf(b) - valueOf(a),
      total_desc: (a, b) => valueOf(b) * b.qty - valueOf(a) * a.qty,
      name_asc: (a, b) => a.name.localeCompare(b.name, 'fr')
    };

    return rows.sort(comparators[sort] ?? comparators.price_desc);
  }

  /* ------------------------------------------------------------------ */
  /* Onglet Vente : filtres, tri, marché global, fiche                   */
  /* ------------------------------------------------------------------ */

  const SELL_SORTS = [
    ['potential_desc', 'Potentiel de vente ↓'],
    ['change_desc', 'Évolution ↓'],
    ['change_asc', 'Évolution ↑'],
    ['price_desc', 'Prix ↓'],
    ['price_asc', 'Prix ↑'],
    ['rarity_desc', 'Rareté ↓'],
    ['name_asc', 'Nom A→Z']
  ];

  const trendCache = new Map();
  const historyRequested = new Set();

  /**
   * Variation en % : série journalière quand elle est en cache, sinon médiane 7 j
   * comparée à la médiane 30 j (deux agrégats réels de l'API, pas une estimation).
   */
  function changePctOf(id) {
    const key = String(id ?? '');
    const entry = state.prices[key];
    if (!entry) return null;
    if (Array.isArray(entry.days) && entry.days.length >= 2) {
      const last = entry.days[entry.days.length - 1];
      const signature = `${entry.days.length}:${last?.day ?? ''}:${last?.median ?? ''}`;
      const cached = trendCache.get(key);
      if (cached && cached.signature === signature) return cached.value;
      const value = trendOf(priceSeries(entry)).changePct;
      trendCache.set(key, { signature, value });
      return value;
    }
    const m7 = toNum(entry.m7);
    const m30 = toNum(entry.m30);
    if (m7 != null && m30 != null && m30 > 0) return ((m7 - m30) / m30) * 100;
    return null;
  }

  /**
   * Récupère la série journalière (`days`) des cartes visibles, par petits lots.
   * `/api/me/collection/prices` ne la renvoie pas : seul `/api/market/prices/:id` l'a.
   * On limite volontairement le nombre d'appels pour ne pas taper l'API.
   */
  async function loadSellHistory(ids, limit = 8) {
    const todo = ids
      .map(String)
      .filter((id) => !historyRequested.has(id) && !Array.isArray(state.prices[id]?.days))
      .slice(0, limit);
    if (!todo.length) return;
    for (const id of todo) historyRequested.add(id);

    for (const id of todo) {
      try {
        const data = await api(`/api/market/prices/${encodeURIComponent(id)}`, { timeout: 15000 });
        mergePriceEntry(id, parsePriceEntry(data));
      } catch {
        /* on garde les agrégats déjà connus */
      }
      await sleep(140);
    }
    persistPricesSoon();
    render();
  }

  /** Valeur nette réalisable si la carte est vendue au prix médian. */
  function potentialOf(row) {
    if (row.price == null || row.sellable <= 0) return null;
    return netOf(Math.round(row.price)) * row.sellable;
  }

  /** Séries présentes dans la collection (pour le filtre). */
  function sellSeriesOptions() {
    const set = new Set();
    for (const row of sellRows()) if (row.series) set.add(row.series);
    return [...set].sort((a, b) => a.localeCompare(b, 'fr'));
  }

  function filteredSellRows(base = sellRows()) {
    const view = state.sellView;
    const query = view.query.trim().toLowerCase();
    let rows = base;

    if (query) {
      rows = rows.filter((row) => `${row.name} ${row.series}`.toLowerCase().includes(query));
    }
    if (view.rarity !== 'all') rows = rows.filter((row) => String(row.rarity) === view.rarity);
    if (view.series !== 'all') rows = rows.filter((row) => String(row.series) === view.series);
    if (view.onlySellable) rows = rows.filter((row) => row.sellable > 0);
    if (view.onlyDupes) rows = rows.filter((row) => row.qty > 1);

    const rarityRank = (code) => RARITY_ORDER.indexOf(String(code || 'C').toUpperCase());
    const valueOf = (row) => (row.price == null ? -1 : row.price);
    const changeOf = (row) => {
      const value = changePctOf(row.id);
      return value == null ? -Infinity : value;
    };

    const comparators = {
      price_desc: (a, b) => valueOf(b) - valueOf(a) || b.sellable - a.sellable,
      price_asc: (a, b) => {
        // Les cartes sans prix restent en fin de liste.
        if (a.price == null && b.price == null) return a.name.localeCompare(b.name, 'fr');
        if (a.price == null) return 1;
        if (b.price == null) return -1;
        return a.price - b.price || b.sellable - a.sellable;
      },
      rarity_desc: (a, b) => rarityRank(b.rarity) - rarityRank(a.rarity) || valueOf(b) - valueOf(a),
      name_asc: (a, b) => a.name.localeCompare(b.name, 'fr'),
      change_desc: (a, b) => changeOf(b) - changeOf(a) || valueOf(b) - valueOf(a),
      change_asc: (a, b) => changeOf(a) - changeOf(b) || valueOf(b) - valueOf(a),
      potential_desc: (a, b) => (potentialOf(b) ?? -1) - (potentialOf(a) ?? -1)
    };

    return rows.sort(comparators[view.sort] ?? comparators.potential_desc);
  }

  /**
   * Mode « Marché global » : filtrage fait par le serveur (q, rarity, series, type),
   * pagination réelle via `total`. Aucun scan complet de la place de marché.
   */
  async function loadSellMarket(append = false) {
    const view = state.marketView;
    if (view.loading) return;

    view.loading = true;
    view.error = null;
    if (!append) {
      view.page = 1;
      view.expanded.clear();
    }
    render();

    try {
      const params = new URLSearchParams();
      const query = view.query.trim();
      if (query) params.set('q', query);
      if (view.rarity !== 'all') params.set('rarity', view.rarity);
      if (view.type !== 'all') params.set('type', view.type);
      params.set('sort', view.sort);
      params.set('pageSize', '24');
      params.set('page', String(view.page));

      const data = await api(`/api/market/listings?${params.toString()}`, { timeout: 25000 });
      const items = Array.isArray(data?.items) ? data.items : Array.isArray(data) ? data : [];
      view.items = append ? [...(view.items ?? []), ...items] : items;
      view.total = toNum(data?.total) ?? view.items.length;
      view.meta = { at: Date.now(), query, rarity: view.rarity, type: view.type };
      view.page += 1;
    } catch (err) {
      view.error = friendlyError(err);
      if (!append) view.items = [];
    } finally {
      view.loading = false;
      render();
    }
  }

  /** Prix connus des cartes du marché (déjà embarqués dans la réponse). */
  function marketPriceOf(item) {
    const embedded = item?.prices ?? null;
    return toNum(embedded?.median7d ?? embedded?.median30d) ?? priceOf(item?.characterId ?? item?.character?.id);
  }

  /** Ouverture de la fiche détaillée : prix, concurrence, carnet d'achat. */
  async function openCardDetail(id) {
    const key = String(id ?? '');
    if (!key) return;
    const view = state.sellView;
    view.detailId = key;
    view.detail = null;
    view.detailError = null;
    view.detailLoading = true;
    render();

    const row = sellRowOf(key);
    const card = state.characters.get(key) ?? row?.c ?? null;

    const [prices, listings, book] = await Promise.all([
      api(`/api/market/prices/${encodeURIComponent(key)}`, { timeout: 20000 }).catch(() => null),
      api(`/api/market/listings?characterId=${encodeURIComponent(key)}&sort=price_asc&pageSize=20`, {
        timeout: 20000
      }).catch(() => null),
      api(`/api/market/buy-orders?characterId=${encodeURIComponent(key)}`, { timeout: 15000 }).catch(() => null)
    ]);

    if (view.detailId !== key) return;

    if (!prices && !listings) {
      view.detailLoading = false;
      view.detailError = 'Impossible de charger les données de marché de cette carte.';
      render();
      return;
    }

    if (prices) {
      mergePriceEntry(key, parsePriceEntry(prices));
    }
    // Alimente les caches communs : le plan de vente réutilisera exactement
    // le même prix fixe haut et le même achat immédiat que la fiche.
    if (listings || book) applyMarketSnapshot(key, listings, book);

    view.detail = analyzeCard({
      prices,
      listings,
      book,
      mine: row,
      card: {
        id: key,
        name: row?.name ?? card?.name ?? `Carte #${key}`,
        image: row?.image ?? imgSrc(card),
        rarity: row?.rarity ?? String(card?.rarity ?? 'C').toUpperCase(),
        series: row?.series ?? card?.series ?? '',
        floor: recycleFloor(row?.rarity ?? card?.rarity)
      }
    });
    view.detailLoading = false;
    view.lastRefresh = Date.now();
    render();
  }

  function closeCardDetail() {
    const view = state.sellView;
    view.detailId = null;
    view.detail = null;
    view.detailError = null;
    view.detailLoading = false;
    render();
  }

  /** Actualise prix + concurrence de la fiche ouverte, sans recharger la collection. */
  async function refreshSellData() {
    const view = state.sellView;
    if (view.refreshing) return;
    view.refreshing = true;
    render();
    try {
      if (view.detailId) {
        await openCardDetail(view.detailId);
      } else {
        const ids = [...new Set(state.collection.map((c) => String(c.characterId ?? c.id)))];
        await loadPrices(ids, true);
      }
      view.lastRefresh = Date.now();
    } finally {
      view.refreshing = false;
      render();
    }
  }

  let salesSaveTimer = null;

  /** Le site ne fournit aucun historique : on garde seulement ce que Kyareeh+ a créé. */
  async function loadSalesLog() {
    try {
      const saved = await storageGet(SALES_KEY, []);
      if (Array.isArray(saved)) {
        state.salesLog = saved
          .filter((entry) => entry && Number.isFinite(Number(entry.at)) && Number.isFinite(Number(entry.net)))
          .map((entry) => ({
            at: Number(entry.at),
            source: entry.source === 'auto' ? 'auto' : 'manual',
            name: String(entry.name ?? ''),
            rarity: String(entry.rarity ?? ''),
            price: Math.max(0, Math.round(Number(entry.price) || 0)),
            net: Math.max(0, Math.round(Number(entry.net) || 0)),
            matched: Boolean(entry.matched)
          }))
          .slice(-SALES_MAX);
      }
    } catch {
      /* pas de journal : le graphique reste vide */
    } finally {
      state.salesLogLoaded = true;
    }
  }

  function saveSalesSoon() {
    if (salesSaveTimer) clearTimeout(salesSaveTimer);
    salesSaveTimer = setTimeout(() => {
      salesSaveTimer = null;
      storageSet(SALES_KEY, state.salesLog.slice(-SALES_MAX)).catch(() => {});
    }, 700);
  }

  /** Enregistre une annonce réellement créée (jamais en simulation). */
  function recordSale(entry) {
    const price = Math.max(0, Math.round(Number(entry?.price) || 0));
    const net = Math.max(0, Math.round(Number(entry?.net) || 0));
    if (!price && !net) return;
    state.salesLog.push({
      at: Number(entry?.at) || Date.now(),
      source: entry?.source === 'auto' ? 'auto' : 'manual',
      name: String(entry?.name ?? ''),
      rarity: String(entry?.rarity ?? ''),
      price,
      net,
      matched: Boolean(entry?.matched)
    });
    if (state.salesLog.length > SALES_MAX) state.salesLog.splice(0, state.salesLog.length - SALES_MAX);
    saveSalesSoon();
  }

  function computeStats(rows) {
    let total = 0;
    let low = 0;
    let high = 0;
    let dupGross = 0;
    let dupNet = 0;
    let priced = 0;
    let count = 0;
    let totalCards = 0;
    let dupCopies = 0;
    let unpriced = 0;
    let recycleAll = 0;
    let dupRecycle = 0;

    for (const row of rows) {
      count += 1;
      totalCards += row.qty;
      recycleAll += recycleOf(row.rarity) * row.qty;
      const sellable = sellableOf(row);
      if (sellable > 0) {
        dupCopies += sellable;
        dupRecycle += recycleOf(row.rarity) * sellable;
      }
      if (row.price == null) {
        unpriced += 1;
        continue;
      }
      priced += 1;
      total += row.price * row.qty;
      low += (row.low ?? row.price) * row.qty;
      high += row.price * row.qty;

      if (sellable > 0) {
        dupGross += row.price * sellable;
        dupNet += netOf(row.price) * sellable;
      }
    }

    return {
      total,
      low: Math.min(low, total),
      high: Math.max(high, total),
      dupGross,
      dupNet,
      dupCopies,
      dupRecycle,
      recycleAll,
      priced,
      count,
      totalCards,
      unique: rows.length,
      unpriced
    };
  }

  function recycleFloor(rarity) {
    return Math.max(1, recycleOf(rarity));
  }

  function suggestPrice(id, rarity) {
    const key = String(id);
    const p = state.prices[key];
    const median = p?.m7 ?? p?.m30 ?? null;
    const low = state.lowest[key] ?? null;
    const bid = state.buyOrders[key]?.price ?? null;
    const floor = recycleFloor(rarity ?? state.characters.get(key)?.rarity);

    let base = median ?? low ?? floor;
    if (low != null && low > 1) base = Math.min(base, low - 1);
    if (bid != null && (median == null || bid >= median * 0.85)) base = bid;
    base = Math.max(floor, base);
    if (state.settings.discountPct) base = base * (1 - state.settings.discountPct / 100);
    return Math.max(1, Math.round(base));
  }

  /** Mise à prix d'une enchère : médiane (ou plus basse annonce) moins X %. */
  function auctionStartPrice(id, rarity, pct) {
    const key = String(id);
    const p = state.prices[key];
    const median = p?.m7 ?? p?.m30 ?? null;
    const low = state.lowest[key] ?? null;
    const floor = recycleFloor(rarity ?? state.characters.get(key)?.rarity);
    const base = median ?? low ?? floor;
    const share = Math.min(80, Math.max(0, Number(pct ?? state.settings.auctionPct))) / 100;
    return Math.max(floor, Math.round(base * (1 - share)));
  }

  /** Achat immédiat facultatif, en % au-dessus de la mise à prix (0 = désactivé). */
  function buyoutPriceFor(price, pct) {
    const share = Number(pct ?? 0);
    if (!Number.isFinite(share) || share <= 0) return null;
    return Math.max(price + 1, Math.round(price * (1 + share / 100)));
  }

  /* ------------------------------------------------------------------ */
  /* Analyse de marché (statistiques explicables)                        */
  /* ------------------------------------------------------------------ */

  /* ANALYSIS:BEGIN — bloc autonome, extrait par test/verify-analysis.mjs */
  const DAY_MS = 86400000;

  /**
   * Pourquoi une carte ne peut pas être mise en vente, et jusqu'à quand.
   * Reproduit les règles du site :
   *   sellBlock = 'resale_lock' + resaleUntil → revente bloquée 48 h après un achat/échange
   *   sellBlock = 'in_escrow'                 → déjà engagée (annonce, offre, échange)
   *   pinned                                  → mise de côté
   *   listable = 0 sans motif                 → aucun exemplaire libre
   * Renvoie null si la carte est vendable.
   */
  function sellBlockState(item, now = Date.now()) {
    if (!item) return null;
    const qty = Math.max(0, Number(item.qty) || 0);
    const listable = Number(item.listable);
    const free = Number.isFinite(listable) ? listable : qty - (Number(item.lockedQty) || 0);

    // Un exemplaire libre suffit : la carte reste vendable.
    if (qty <= 0 || free > 0) return null;

    const untilRaw = item.resaleUntil ?? item.sellBlockUntil ?? null;
    const until = untilRaw ? Date.parse(untilRaw) : NaN;
    const hasUntil = Number.isFinite(until);
    const hoursLeft = hasUntil ? Math.max(0, (until - now) / 3600000) : null;

    const base = { code: 'unavailable', reason: 'Aucun exemplaire disponible à la vente', until: hasUntil ? until : null, hoursLeft };

    if (item.pinned) {
      return { ...base, code: 'pinned', reason: 'Mise de côté (échange en cours)' };
    }
    if (item.sellBlock === 'resale_lock') {
      if (hasUntil) {
        return {
          ...base,
          code: 'resale_lock',
          reason: 'Revente bloquée 48 h après un achat ou un échange',
          hoursLeft
        };
      }
      return { ...base, code: 'resale_lock', reason: 'Revente temporairement bloquée' };
    }
    if (item.sellBlock === 'in_escrow') {
      const escrow = item.escrow ?? {};
      const reason = escrow.trades
        ? 'Engagée dans un échange'
        : escrow.offers
          ? 'Engagée dans une offre d’échange'
          : escrow.listings
            ? 'Déjà en vente'
            : 'Engagée sur le marché';
      return { ...base, code: 'in_escrow', reason };
    }
    if (qty > 0 && free <= 0) {
      return { ...base, code: 'all_engaged', reason: 'Tous les exemplaires sont déjà engagés' };
    }
    return base;
  }

  /** Blocage de revente d'une ligne de collection (données du site). */
  function sellBlockOfRow(row, now = Date.now()) {
    return sellBlockState(
      {
        qty: row?.qty,
        listable: row?.sellable ?? row?.listable,
        lockedQty: row?.lockedQty,
        pinned: row?.pinned,
        sellBlock: row?.sellBlock,
        resaleUntil: row?.resaleUntil,
        escrow: row?.escrow
      },
      now
    );
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  /** Pourcentage lisible en français, sans fausse précision. */
  function fmtPct(value, digits = 1) {
    if (value == null || !Number.isFinite(value)) return '—';
    const factor = 10 ** digits;
    const rounded = Math.round(value * factor) / factor;
    return `${String(rounded).replace('.', ',')} %`;
  }

  /** Série journalière propre : `[{ day, median, n }]` triée, sans trou ni zéro. */
  function priceSeries(prices) {
    const raw = Array.isArray(prices?.days) ? prices.days : [];
    const byDay = new Map();
    for (const point of raw) {
      const median = toNum(point?.median);
      const day = String(point?.day ?? '');
      if (!day || median == null || median <= 0) continue;
      byDay.set(day, { day, median, n: Math.max(0, toNum(point?.n) ?? 0) });
    }
    return [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));
  }

  /** Dernières ventes réelles, du plus récent au plus ancien. */
  function lastSalesOf(prices) {
    const raw = Array.isArray(prices?.lastSales) ? prices.lastSales : [];
    return raw
      .map((sale) => ({ price: toNum(sale?.price), at: sale?.at ?? null, source: sale?.source ?? '' }))
      .filter((sale) => sale.price != null && sale.price > 0);
  }

  /**
   * Tendance par régression linéaire sur le logarithme des médianes.
   * Renvoie une pente en %/jour, un R² et la variation totale sur la fenêtre.
   * Les 9 à 11 points fournis par l'API suffisent : on ne modélise rien de plus.
   */
  function trendOf(series) {
    if (series.length < 2) return { slopePct: null, r2: null, changePct: null, points: series.length };
    const base = Date.parse(`${series[0].day}T00:00:00Z`);
    const xs = [];
    const ys = [];
    for (const point of series) {
      const stamp = Date.parse(`${point.day}T00:00:00Z`);
      if (!Number.isFinite(stamp)) continue;
      xs.push((stamp - base) / DAY_MS);
      ys.push(Math.log(point.median));
    }
    if (xs.length < 2) return { slopePct: null, r2: null, changePct: null, points: series.length };

    const n = xs.length;
    const meanX = xs.reduce((a, b) => a + b, 0) / n;
    const meanY = ys.reduce((a, b) => a + b, 0) / n;
    let sxy = 0;
    let sxx = 0;
    for (let i = 0; i < n; i += 1) {
      sxy += (xs[i] - meanX) * (ys[i] - meanY);
      sxx += (xs[i] - meanX) ** 2;
    }
    const slope = sxx > 0 ? sxy / sxx : 0;

    let ssRes = 0;
    let ssTot = 0;
    for (let i = 0; i < n; i += 1) {
      const predicted = meanY + slope * (xs[i] - meanX);
      ssRes += (ys[i] - predicted) ** 2;
      ssTot += (ys[i] - meanY) ** 2;
    }
    const r2 = ssTot > 0 ? clamp(1 - ssRes / ssTot, 0, 1) : 0;

    const first = series[0].median;
    const last = series[series.length - 1].median;
    return {
      slopePct: (Math.exp(slope) - 1) * 100,
      slope,
      r2,
      changePct: first > 0 ? ((last - first) / first) * 100 : null,
      points: n
    };
  }

  /** Volatilité : écart-type des rendements log quotidiens, en %. */
  function volatilityOf(series) {
    if (series.length < 3) return null;
    const returns = [];
    for (let i = 1; i < series.length; i += 1) {
      const prev = series[i - 1].median;
      const next = series[i].median;
      if (prev > 0 && next > 0) returns.push(Math.log(next / prev));
    }
    if (returns.length < 2) return null;
    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance = returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (returns.length - 1);
    return Math.sqrt(variance) * 100;
  }

  /** Note de confiance 0–1, dérivée de la quantité de données réellement disponible. */
  function confidenceOf({ points, volume, r2, volatility }) {
    const coverage = clamp(points / 8, 0, 1);
    const liquidity = clamp(volume / 25, 0, 1);
    const fit = r2 == null ? 0 : clamp(r2 / 0.7, 0, 1);
    const stability = volatility == null ? 0.5 : clamp(1 - volatility / 25, 0, 1);
    const score = coverage * 0.3 + liquidity * 0.3 + fit * 0.25 + stability * 0.15;
    const level = score >= 0.68 ? 'high' : score >= 0.42 ? 'medium' : 'low';
    return { score, level };
  }

  /**
   * Analyse complète d'une carte : tout est calculé à partir des données renvoyées
   * par l'API. Quand une donnée manque, on renvoie `null` et l'interface l'affiche
   * comme indisponible — aucune valeur n'est inventée.
   */
  function analyzeCard({ prices = null, listings = null, book = null, card = null, mine = null } = {}) {
    const series = priceSeries(prices);
    const sales = lastSalesOf(prices);
    const trend = trendOf(series);
    const volatility = volatilityOf(series);

    const median7 = toNum(prices?.median7d);
    const median30 = toNum(prices?.median30d);
    const last = toNum(prices?.lastPrice) ?? (series.length ? series[series.length - 1].median : null);
    const median = median7 ?? median30 ?? last ?? null;

    const salePrices = sales.map((sale) => sale.price);
    const observedHigh = salePrices.length ? Math.max(...salePrices) : null;
    const observedLow = salePrices.length ? Math.min(...salePrices) : null;
    const seriesHigh = series.length ? Math.max(...series.map((p) => p.median)) : null;
    const seriesLow = series.length ? Math.min(...series.map((p) => p.median)) : null;

    const volume7 = toNum(prices?.sales7d) ?? null;
    const volume30 = toNum(prices?.sales30d) ?? null;
    const avgPerDay = series.length
      ? series.reduce((sum, point) => sum + point.n, 0) / series.length
      : null;

    // Variation : la série journalière est prioritaire, sinon 7 j vs 30 j.
    let changePct = trend.changePct;
    if (changePct == null && median7 != null && median30 != null && median30 > 0) {
      changePct = ((median7 - median30) / median30) * 100;
    }

    // Concurrence : annonces fixes des autres vendeurs + meilleur ordre d'achat.
    const items = Array.isArray(listings?.items) ? listings.items : Array.isArray(listings) ? listings : [];
    const rivals = items.filter((item) => !item.isMine);

    // Prix fixes : le plus bas sert de concurrence, le plus haut de plafond
    // réaliste pour la stratégie « Prix maximal ».
    const rivalFixed = rivals
      .filter((item) => String(item.type ?? 'fixed') === 'fixed')
      .map((item) => toNum(item.price))
      .filter((value) => value != null && value > 0)
      .sort((a, b) => a - b);

    // Enchères : `buyoutPrice` est l'achat immédiat ; la mise courante sert de
    // prix d'entrée quand aucun achat immédiat n'est proposé.
    const auctionItems = rivals.filter((item) => String(item.type) === 'auction');
    const rivalAuctions = auctionItems
      .map((item) => toNum(item.buyoutPrice) ?? toNum(item.minNextBid) ?? toNum(item.price))
      .filter((value) => value != null && value > 0)
      .sort((a, b) => a - b);
    const auctionBuyouts = auctionItems
      .map((item) => toNum(item.buyoutPrice))
      .filter((value) => value != null && value > 0)
      .sort((a, b) => a - b);

    const orders = Array.isArray(book) ? book : Array.isArray(book?.items) ? book.items : [];
    const bids = orders
      .filter((order) => !order.isMine)
      .map((order) => toNum(order?.price ?? order?.maxPrice))
      .filter((value) => value != null && value > 0)
      .sort((a, b) => b - a);

    const fixedLow = rivalFixed[0] ?? null;
    const fixedHigh = rivalFixed.length ? rivalFixed[rivalFixed.length - 1] : null;
    const auctionBuyout = auctionBuyouts[0] ?? null;
    const lowest = fixedLow ?? rivalAuctions[0] ?? null;
    const bestBid = bids[0] ?? null;
    const myListing = items.find((item) => item.isMine) ?? null;

    const confidence = confidenceOf({
      points: series.length,
      volume: volume7 ?? 0,
      r2: trend.r2,
      volatility
    });

    // Prévision à 7 jours : seulement si la série est exploitable.
    let forecast = null;
    if (series.length >= 4 && trend.slopePct != null && confidence.level !== 'low' && last != null && last > 0) {
      const raw = last * Math.exp((trend.slope ?? 0) * 7);
      const capped = clamp(raw, last * 0.7, last * 1.3);
      const band = clamp((volatility ?? 5) / 100, 0.02, 0.35);
      forecast = {
        days: 7,
        price: Math.max(1, Math.round(capped)),
        low: Math.max(1, Math.round(capped * (1 - band))),
        high: Math.max(1, Math.round(capped * (1 + band))),
        capped: raw !== capped
      };
    }

    const floor = card?.floor ?? null;
    const recommend = buildRecommendations({
      median,
      median7,
      median30,
      last,
      lowest,
      bestBid,
      observedHigh,
      fixedHigh,
      changePct,
      volatility,
      volume7,
      floor
    });

    return {
      card,
      mine,
      series,
      sales,
      trend,
      volatility,
      median,
      median7,
      median30,
      last,
      changePct,
      observedHigh,
      observedLow,
      seriesHigh,
      seriesLow,
      volume7,
      volume30,
      avgPerDay,
      lowest,
      fixedLow,
      fixedHigh,
      auctionBuyout,
      rivalFixed,
      rivalAuctions,
      bestBid,
      myListing,
      rivals: rivals.length,
      orderCount: bids.length,
      confidence,
      forecast,
      recommend,
      updatedAt: toNum(prices?.lastAt) ? prices.lastAt : null,
      insufficient: series.length < 2 && median == null
    };
  }

  /**
   * Trois prix de vente + justification chiffrée.
   * `net` applique les frais réels (dépôt + taxe) déjà utilisés par la vente assistée.
   */
  function buildRecommendations({
    median,
    median7,
    median30,
    last,
    lowest,
    bestBid,
    observedHigh,
    fixedHigh,
    changePct,
    volatility,
    volume7,
    floor
  }) {
    const base = median ?? median7 ?? median30 ?? last ?? null;
    if (base == null || base <= 0) return null;

    const min = Math.max(1, Math.round(floor ?? 1));
    const trend = Number.isFinite(changePct) ? changePct : 0;
    const vol = Number.isFinite(volatility) ? volatility : null;
    const safe = (value) => Math.max(min, Math.round(value));

    // 2) Équilibrée : médiane ajustée de la tendance, bornée à ±10 %.
    const adjust = clamp(trend / 100, -0.1, 0.1);
    let balancedRaw = base * (1 + adjust);
    if (lowest != null && lowest > 1) balancedRaw = Math.min(balancedRaw, Math.max(min, lowest));
    const balanced = safe(balancedRaw);

    // 1) Vente rapide : sous la moins chère, sinon −10 % vs médiane.
    //    Elle ne dépasse jamais l'équilibrée (les trois prix restent ordonnés).
    let quickRaw = base * 0.9;
    if (lowest != null && lowest > 1) quickRaw = Math.min(quickRaw, lowest - 1);
    if (bestBid != null && bestBid > min) quickRaw = Math.max(quickRaw, Math.min(bestBid, base));
    const quick = Math.min(balanced, safe(quickRaw));

    // 3) Prix maximal : plafond des annonces fixes quand il existe, sinon haut
    //    des ventes récentes. C'est le prix le plus haut réellement demandé,
    //    pas une majoration arbitraire de la médiane.
    //    Toujours ≥ équilibrée, sinon la stratégie n'aurait pas de sens.
    const fixedCeiling = fixedHigh != null && fixedHigh > 0 ? fixedHigh : null;
    let maxRaw = Math.max(balanced, fixedCeiling ?? base * (1.2 + Math.max(0, adjust)));
    if (fixedCeiling == null && observedHigh != null && observedHigh > balanced) {
      maxRaw = Math.min(maxRaw, observedHigh);
    }
    // Le plafond de sécurité ne doit jamais rabaisser le prix fixe observé.
    maxRaw = Math.min(maxRaw, Math.max(balanced, base * 1.6, fixedCeiling ?? 0));
    const max = Math.max(balanced, safe(maxRaw));

    const liquidity =
      volume7 == null ? null : volume7 >= 20 ? 'rapide' : volume7 >= 5 ? 'moyen' : 'lent';

    const reason = (price, extra) => {
      const chunks = [`médiane ◆ ${fmt(base)}`];
      if (lowest != null) chunks.push(`moins chère ◆ ${fmt(lowest)}`);
      if (bestBid != null) chunks.push(`meilleur ordre ◆ ${fmt(bestBid)}`);
      if (vol != null) chunks.push(`volatilité ${fmtPct(vol, 0)}`);
      if (volume7 != null) chunks.push(`${fmt(volume7)} vente(s)/7j`);
      if (extra) chunks.push(extra);
      return chunks.join(' · ');
    };

    return {
      quick: {
        id: 'quick',
        price: quick,
        net: netOf(quick),
        label: 'Vente rapide',
        delay: liquidity === 'lent' ? 'délai incertain' : 'le plus rapide',
        reason: reason(quick, quick < base ? `−${Math.round(((base - quick) / base) * 100)} % vs médiane` : null)
      },
      balanced: {
        id: 'balanced',
        price: balanced,
        net: netOf(balanced),
        label: 'Équilibrée',
        delay: liquidity ? `liquidité ${liquidity}` : null,
        reason: reason(
          balanced,
          Math.abs(adjust) >= 0.005
            ? `tendance ${trend >= 0 ? '+' : ''}${fmtPct(trend, 1)}`
            : 'au niveau du marché'
        )
      },
      max: {
        id: 'max',
        price: max,
        net: netOf(max),
        label: 'Prix maximal',
        delay: 'délai plus long',
        reason: reason(
          max,
          fixedHigh != null && fixedHigh >= balanced
            ? `prix fixe le plus haut ◆ ${fmt(fixedHigh)}`
            : observedHigh != null && observedHigh > base
              ? `plus haute vente ◆ ${fmt(observedHigh)}`
              : '+20 % vs médiane'
        )
      }
    };
  }
  /* ANALYSIS:END */

  /* ------------------------------------------------------------------ */
  /* Market info (lowest listing + best buy order)                       */
  /* ------------------------------------------------------------------ */

  const marketPending = new Map();

  /**
   * Applique une réponse marché aux caches partagés par la liste, la fiche et
   * le plan de vente. C'est ce qui garantit le même « prix maximal » partout.
   */
  function applyMarketSnapshot(key, listings, book) {
    const items = Array.isArray(listings?.items) ? listings.items : Array.isArray(listings) ? listings : [];
    const rivals = items.filter((item) => !item.isMine);

    if (listings != null) {
      const fixed = rivals
        .filter((item) => String(item.type ?? 'fixed') === 'fixed')
        .map((item) => toNum(item.price))
        .filter((value) => value != null && value > 0)
        .sort((a, b) => a - b);
      const buyouts = rivals
        .filter((item) => String(item.type) === 'auction')
        .map((item) => toNum(item.buyoutPrice))
        .filter((value) => value != null && value > 0)
        .sort((a, b) => a - b);
      const entries = rivals
        .map((item) =>
          String(item.type ?? 'fixed') === 'fixed' ? toNum(item.price) : toNum(item.buyoutPrice)
        )
        .filter((value) => value != null && value > 0)
        .sort((a, b) => a - b);

      if (fixed.length) {
        state.fixedLow[key] = fixed[0];
        state.fixedHigh[key] = fixed[fixed.length - 1];
      } else {
        delete state.fixedLow[key];
        delete state.fixedHigh[key];
      }
      if (buyouts.length) state.auctionBuyout[key] = buyouts[0];
      else delete state.auctionBuyout[key];
      if (entries.length) state.lowest[key] = entries[0];
      else delete state.lowest[key];

      const embedded = items.find((item) => item && item.prices)?.prices;
      if (embedded && !priceFresh(state.prices[key])) {
        mergePriceEntry(key, {
          m7: toNum(embedded.median7d),
          m30: toNum(embedded.median30d),
          sales7d: toNum(embedded.sales7d),
          sales30d: toNum(embedded.sales30d),
          at: Date.now()
        });
      }
      state.marketScanned.add(key);
      state.marketLoaded.add(key);
    }

    // Un échec partiel du carnet ne doit pas effacer un ordre déjà connu.
    if (book != null) {
      const orders = Array.isArray(book) ? book : Array.isArray(book?.items) ? book.items : Array.isArray(book?.orders) ? book.orders : [];
      const best = orders
        .filter((order) => !order.isMine)
        .filter((order) => !order.status || ['open', 'active', 'pending'].includes(String(order.status)))
        .map((order) => ({
          price: toNum(order.price ?? order.maxPrice ?? order.maxAmount),
          qty: toNum(order.qty ?? order.remaining ?? order.remainingQty)
        }))
        .filter((order) => order.price != null && order.price > 0)
        .sort((a, b) => b.price - a.price)[0];
      if (best) state.buyOrders[key] = best;
      else delete state.buyOrders[key];
    }
  }

  async function fetchMarketSnapshot(key) {
    const [listings, book] = await Promise.all([
      api(`/api/market/listings?characterId=${encodeURIComponent(key)}&sort=price_asc&pageSize=20`, {
        timeout: 15000
      }).catch(() => null),
      api(`/api/market/buy-orders?characterId=${encodeURIComponent(key)}`, { timeout: 12000 }).catch(() => null)
    ]);
    return { listings, book };
  }

  /**
   * Charge les instantanés manquants, deux cartes à la fois. Les appels
   * concurrents pour une même carte partagent la même promesse.
   */
  async function ensureMarketData(ids) {
    const unique = [...new Set(ids.map(String).filter(Boolean))];
    if (!unique.length) return;

    const existing = unique.map((id) => marketPending.get(id)).filter(Boolean);
    const todo = unique.filter((id) => !state.marketScanned.has(id) && !marketPending.has(id));
    if (!todo.length) {
      if (existing.length) await Promise.all(existing);
      return;
    }

    let cursor = 0;
    const worker = async () => {
      while (cursor < todo.length) {
        const key = todo[cursor++];
        const task = (async () => {
          try {
            const { listings, book } = await fetchMarketSnapshot(key);
            if (!listings && !book) throw new Error('marché indisponible');
            applyMarketSnapshot(key, listings, book);
          } catch {
            /* on retentera à la prochaine demande */
          } finally {
            state.marketLoaded.add(key);
            marketPending.delete(key);
          }
          await sleep(100);
        })();
        marketPending.set(key, task);
        await task;
      }
    };

    const jobs = [worker(), worker()];
    await Promise.all([...existing, ...jobs]);
  }

  async function loadMarketInfo(ids, limit = state.marketLimit) {
    if (state.marketLoading) return;
    const room = Math.max(0, limit - state.marketLoaded.size);
    const todo = ids
      .map(String)
      .filter((id) => !state.marketScanned.has(id))
      .slice(0, room);
    if (!todo.length) return;

    state.marketLoading = true;
    render();
    try {
      await ensureMarketData(todo);
    } finally {
      state.marketLoading = false;
      render();
    }
  }

  /* ------------------------------------------------------------------ */
  /* Market scan (bons plans)                                            */
  /* ------------------------------------------------------------------ */

  async function scanMarket() {
    if (state.dealsScanning) return;
    state.dealsScanning = true;
    state.dealsError = null;
    render();

    try {
      const sort = state.settings.dealsSort;
      const pages = Math.min(20, Math.max(1, Number(state.settings.dealsPages) || 6));
      const items = [];
      let truncated = false;

      for (let page = 1; page <= pages; page += 1) {
        // Le serveur plafonne pageSize à 50 : on parcourt plusieurs pages.
        const data = await api(
          `/api/market/listings?sort=${encodeURIComponent(sort)}&pageSize=50&page=${page}`,
          { timeout: 20000 }
        );
        const batch = Array.isArray(data?.items) ? data.items : [];
        items.push(...batch);
        if (batch.length < 50) break;
        if (page === pages) truncated = true;
      }

      const minPct = Number(state.settings.dealsMinPct) || 0;
      const typeFilter = state.settings.dealsType;
      const seen = new Set();
      const deals = [];
      let considered = 0;

      for (const item of items) {
        if (item.isMine) continue;

        const id = String(item.characterId ?? item.character?.id ?? '');
        if (!id) continue;

        const isAuction = String(item.type) === 'auction';
        if (typeFilter === 'fixed' && isAuction) continue;
        if (typeFilter === 'auction' && !isAuction) continue;

        // Prix d'entrée : prix fixe, sinon achat immédiat, sinon mise minimale.
        const buyout = toNum(item.buyoutPrice);
        const entry = isAuction ? buyout ?? toNum(item.minNextBid ?? item.currentBid ?? item.price) : toNum(item.price);
        if (entry == null || entry <= 0) continue;

        const embedded = item.prices ?? null;
        const median = toNum(embedded?.median7d ?? embedded?.median30d) ?? priceOf(id);
        if (median == null || median <= 0) continue;

        considered += 1;
        const saving = median - entry;
        const pct = Math.round((saving / median) * 100);
        if (pct < minPct || saving < 2) continue;

        const key = item.id ?? `${id}:${entry}`;
        if (seen.has(key)) continue;
        seen.add(key);

        deals.push({
          listingId: item.id ?? null,
          characterId: id,
          price: entry,
          median,
          saving,
          pct,
          type: item.type ?? 'fixed',
          viaBuyout: isAuction && buyout != null,
          rarity: String(item.character?.rarity ?? state.characters.get(id)?.rarity ?? 'C').toUpperCase(),
          sales7d: toNum(embedded?.sales7d),
          endsAt: item.endsAt ?? null,
          c: item.character ?? state.characters.get(id) ?? null
        });
      }

      deals.sort((a, b) => b.saving - a.saving || b.pct - a.pct);
      state.deals = deals.slice(0, 60);
      state.dealsMeta = { scanned: items.length, considered, truncated, sort, pages };
    } catch (err) {
      state.dealsError = friendlyError(err);
      notify(`Scan impossible : ${state.dealsError}`);
      state.deals = state.deals || [];
    } finally {
      state.dealsScanning = false;
      render();
    }
  }

  /* ------------------------------------------------------------------ */
  /* Sell flow                                                           */
  /* ------------------------------------------------------------------ */

  /**
   * Prépare une vente. `rows` peut venir de la sélection de l'onglet Vente ou d'une
   * fiche carte (`openCardDetail` → bouton vendre), avec un prix imposé optionnel.
   */
  async function prepareSell(rows, options = {}) {
    const source =
      Array.isArray(rows) && rows.length
        ? rows.filter((r) => r.sellable > 0)
        : filteredSellRows().filter((r) => state.selected.has(r.id) && r.sellable > 0);
    if (!source.length) return;

    const type = options.type === 'auction' ? 'auction' : options.type === 'fixed' ? 'fixed' : state.settings.saleType;
    const plan = source.map((r) => {
      const floor = recycleFloor(r.rarity);
      const preset = Number(options.price);
      // Une carte cochée = UNE annonce par défaut ; la quantité reste réglable ensuite.
      const maxQty = Math.max(1, Math.min(r.sellable, r.qty));
      const wanted = Math.round(Number(options.qty));
      return {
        characterId: apiId(r.rawId ?? r.id),
        id: String(r.id),
        name: r.name,
        image: r.image,
        rarity: r.rarity,
        qty: Number.isFinite(wanted) && wanted > 0 ? Math.min(maxQty, wanted) : 1,
        maxQty,
        totalQty: r.qty,
        median: priceOf(r.id),
        floor,
        price:
          Number.isFinite(preset) && preset > 0
            ? Math.max(floor, Math.round(preset))
            : type === 'auction'
              ? auctionStartPrice(r.id, r.rarity, state.settings.auctionPct)
              : suggestPrice(r.id, r.rarity)
      };
    });

    const sell = {
      plan,
      type,
      // Stratégie appliquée (vente rapide / équilibrée / maximale), null = prix auto.
      method: null,
      auctionPct: state.settings.auctionPct,
      buyoutPct: state.settings.buyoutPct,
      running: false,
      done: false,
      // Les prix maximaux ne sont affichés qu'une fois le marché lu, pour
      // éviter un premier chiffre différent de celui de la fiche.
      marketPending: true,
      // Vendre toutes les copies d'une carte (dont la dernière) demande une confirmation.
      confirmLastCopy: false,
      log: []
    };
    state.sell = sell;
    render();

    try {
      await ensureMarketData(plan.map((row) => String(row.id)));
    } catch {
      /* le plan reste utilisable avec les prix déjà en cache */
    } finally {
      if (state.sell === sell) {
        sell.marketPending = false;
        render();
      }
    }
  }

  function resetPlanPrices() {
    const sell = state.sell;
    if (!sell) return;
    sell.method = null;
    for (const row of sell.plan) {
      row.price =
        sell.type === 'auction'
          ? auctionStartPrice(row.characterId, row.rarity, sell.auctionPct)
          : suggestPrice(row.characterId, row.rarity);
    }
  }

  function sellTotals(plan) {
    let copies = 0;
    let gross = 0;
    let fees = 0;
    let tax = 0;
    for (const row of plan) {
      copies += row.qty;
      gross += row.price * row.qty;
      fees += feeOf(row.price) * row.qty;
      tax += taxOf(row.price) * row.qty;
    }
    return { copies, gross, fees, tax, net: Math.max(0, gross - fees - tax) };
  }

  function activeListings() {
    const mine = state.mine;
    const list = Array.isArray(mine?.listings) ? mine.listings : Array.isArray(mine) ? mine : [];
    return list.filter((l) => !l.status || l.status === 'active').length;
  }

  /**
   * Emplacements d'annonce restants. Le site plafonne les annonces actives
   * (10 par défaut) ; chaque exemplaire mis en vente occupe une place.
   */
  function listingSlots() {
    const cfg = getCfg();
    const fromApi =
      toNum(cfg.maxActive) ??
      toNum(state.access?.maxActiveListings) ??
      toNum(state.access?.maxActive) ??
      toNum(state.access?.limit) ??
      toNum(state.mine?.maxActiveListings) ??
      toNum(state.mine?.limit);
    // Le site ne renvoie pas toujours sa limite : 10 places par défaut.
    // Si l'API annonce moins, on garde malgré tout 10 (Axel veut pouvoir en préparer 10).
    const max = Math.max(LISTING_SLOTS_FALLBACK, fromApi ?? 0);
    const active = activeListings();
    return { max, active, remaining: Math.max(0, max - active) };
  }

  /** Nombre d'annonces prévues par la sélection : une par carte cochée. */
  function selectedCopies() {
    let copies = 0;
    for (const row of sellRows()) {
      if (state.selected.has(row.id) && row.sellable > 0) copies += 1;
    }
    return copies;
  }

  /** Cartes dont la vente emporterait la (les) dernière(s) copie(s) possédée(s). */
  function lastCopyRows(plan) {
    return plan.filter((row) => row.qty >= (row.totalQty ?? row.qty));
  }

  function sellBlocker(plan) {
    const t = sellTotals(plan);
    const chakra = toNum(state.user?.chakra) ?? 0;
    const { max, remaining } = listingSlots();
    const isAuction = state.sell?.type === 'auction';

    if (!plan.length) return 'Aucune carte sélectionnée.';

    const badQty = plan.find(
      (row) =>
        !Number.isInteger(row.qty) ||
        row.qty < 1 ||
        row.qty > Math.max(1, row.maxQty ?? row.qty)
    );
    if (badQty) {
      return `${badQty.name} : tu peux mettre en vente entre 1 et ${Math.max(1, badQty.maxQty ?? 1)} exemplaire(s).`;
    }

    const invalid = plan.find((row) => !Number.isInteger(row.price) || row.price < Math.max(1, row.floor ?? 1));
    if (invalid) {
      return `${invalid.name} : le prix doit être un entier supérieur ou égal à la valeur de recyclage (${fmt(invalid.floor ?? 1)} ◆).`;
    }
    if (isAuction && Number(state.sell?.buyoutPct) > 0) {
      const bad = plan.find((row) => buyoutPriceFor(row.price, state.sell.buyoutPct) == null);
      if (bad) return "L'achat immédiat doit rester supérieur à la mise à prix.";
    }
    if (t.copies > state.settings.maxBatch) {
      return `Lot limité à ${state.settings.maxBatch} annonces (tu en as ${t.copies}). Réduis la sélection ou augmente la limite dans Réglages.`;
    }
    // Limite d'annonces actives du site : c'est elle qui bloque en premier.
    if (t.copies > remaining) {
      return `Il te reste ${remaining} place(s) d'annonce sur ${max}. Décoche des cartes ou retire une annonce.`;
    }
    if (state.settings.dryRun) return '';
    if (t.fees > chakra) {
      return `Frais de dépôt : ${fmt(t.fees)} ◆, chakra disponible : ${fmt(chakra)} ◆.`;
    }
    if (state.access && state.access.allowed === false) {
      return "L'accès au marché n'est pas encore débloqué sur ce compte.";
    }
    // Dernière copie : autorisée, mais seulement après confirmation explicite.
    const lastCopies = lastCopyRows(plan);
    if (lastCopies.length && !state.sell?.confirmLastCopy) {
      const names = lastCopies.map((row) => row.name).slice(0, 3).join(', ');
      return `Tu vends toutes tes copies de ${names}${lastCopies.length > 3 ? '…' : ''} : ces cartes quitteront ta collection. Coche la confirmation pour continuer.`;
    }
    return '';
  }

  /**
   * Exécution commune aux ventes manuelle et automatique.
   * Ne touche ni au DOM ni à l'état de la boucle : l'appelant fournit `log` et
   * `shouldStop`. Retourne les compteurs réels (annonces créées, ventes immédiates).
   */
  async function runSalePlan(plan, options = {}) {
    const saleType = options.type === 'auction' ? 'auction' : 'fixed';
    const duration = Number(options.duration) > 0 ? Number(options.duration) : 12;
    const buyoutPct = Number(options.buyoutPct) || 0;
    const dryRun = Boolean(options.dryRun);
    const gapMs = Math.max(350, Number(options.gapMs) || 1200);
    const log = typeof options.log === 'function' ? options.log : () => {};
    const shouldStop = typeof options.shouldStop === 'function' ? options.shouldStop : () => false;
    const source = options.source === 'auto' ? 'auto' : 'manual';
    const result = { created: 0, matched: 0, errors: 0, simulated: 0, stopped: null };

    let consecutiveErrors = 0;
    for (const row of plan) {
      const qty = Math.max(1, Number(row.qty) || 1);
      for (let copy = 0; copy < qty; copy += 1) {
        if (shouldStop()) {
          result.stopped = 'user';
          return result;
        }

        const label =
          saleType === 'auction' ? `enchère dès ◆ ${fmt(row.price)}` : `prix fixe ◆ ${fmt(row.price)}`;
        if (dryRun) {
          log(`(simulation) ${row.name} · ${label}`, 'info');
          result.simulated += 1;
          await sleep(90);
          continue;
        }

        try {
          const buyout = saleType === 'auction' ? buyoutPriceFor(row.price, buyoutPct) : null;
          const posted = await api('/api/market/listings', {
            method: 'POST',
            timeout: 20000,
            body: {
              characterId: row.characterId,
              type: saleType,
              price: row.price,
              buyoutPrice: buyout,
              durationHours: duration
            }
          });
          result.created += 1;
          if (posted?.matched) result.matched += 1;
          recordSale({
            source,
            name: row.name,
            rarity: row.rarity,
            price: row.price,
            net: Math.max(0, Number(row.price) - feeOf(row.price) - taxOf(row.price)),
            matched: Boolean(posted?.matched)
          });
          log(`✓ ${row.name} · ${label}${posted?.matched ? ' · vendue immédiatement' : ''}`, 'ok');
          consecutiveErrors = 0;
        } catch (err) {
          result.errors += 1;
          consecutiveErrors += 1;
          log(`✗ ${row.name} · ${friendlyError(err)}`, 'err');
          const status = Number(err?.status);
          if (status === 401 || status === 403 || status === 429) {
            result.stopped = 'auth';
            return result;
          }
          if (consecutiveErrors >= 3) {
            result.stopped = 'errors';
            return result;
          }
        }

        await sleep(gapMs);
      }
    }
    return result;
  }

  async function executeSell() {
    if (!state.sell || state.sell.running) return;
    const sell = state.sell;
    const plan = sell.plan;
    const blocker = sellBlocker(plan);
    if (blocker) {
      notify(blocker);
      return;
    }

    sell.running = true;
    sell.done = false;
    sell.log = [];
    render();

    const cfg = getCfg();
    const duration = cfg.durations.includes(Number(state.settings.durationHours))
      ? Number(state.settings.durationHours)
      : cfg.durations[0] ?? 12;
    const saleType = sell.type === 'auction' ? 'auction' : 'fixed';
    const buyoutPct = Number(sell.buyoutPct) || 0;

    const log = (text, kind = 'info') => {
      sell.log.push({ text, kind });
      render();
    };

    const result = await runSalePlan(plan, {
      type: saleType,
      duration,
      buyoutPct,
      dryRun: state.settings.dryRun,
      gapMs: state.settings.gapMs,
      source: 'manual',
      log,
      shouldStop: () => !sell.running
    });

    sell.running = false;
    sell.done = true;
    if (result.stopped === 'errors') log('Arrêt après 3 erreurs consécutives.', 'err');
    else if (result.stopped === 'auth') log('Arrêt : session expirée ou limite API atteinte.', 'err');
    else if (result.stopped === 'user') log('Arrêt demandé.', 'info');
    log(
      `Terminé · ${fmt(result.created)} annonce(s)${result.matched ? ` · ${fmt(result.matched)} vente(s) immédiate(s)` : ''}${
        state.settings.dryRun ? ' (simulation)' : ''
      }.`,
      'info'
    );
    state.selected.clear();
    // La fiche ouverte n'est plus d'actualité : les copies vendues ont quitté la collection.
    state.sellView.detailId = null;
    state.sellView.detail = null;
    state.sellView.lastRefresh = Date.now();

    await loadData({ keepPrices: true });
  }

  /* ------------------------------------------------------------------ */
  /* Vente auto des doublons                                             */
  /* ------------------------------------------------------------------ */

  function autoSellLog(text, kind = 'info') {
    const a = state.autoSell;
    a.log.push({ text, kind });
    if (a.log.length > 180) a.log.shift();
    render();
  }

  /** Relit la collection et les annonces actives avant/après un cycle. */
  async function autoSellRefresh() {
    const [me, coll, mine] = await Promise.all([
      api('/api/me', { timeout: 20000 }).catch(() => null),
      api('/api/me/collection?lean=1', { timeout: 25000 }),
      api('/api/me/market', { timeout: 20000 }).catch(() => null)
    ]);
    const list = Array.isArray(coll) ? coll : Array.isArray(coll?.items) ? coll.items : null;
    if (!list) throw new Error('Collection illisible');
    if (me && typeof me === 'object') mergeUser(me);
    state.collection = list;
    if (mine && typeof mine === 'object') state.mine = mine;
    state.lastSync = Date.now();
    state.sellView.lastRefresh = Date.now();
  }

  function autoSellDuration() {
    const cfg = getCfg();
    return cfg.durations.includes(Number(state.settings.durationHours))
      ? Number(state.settings.durationHours)
      : cfg.durations[0] ?? 12;
  }

  /**
   * Un cycle : relit la collection, prix uniquement les doublons, respecte les
   * places d'annonce, puis crée les annonces. `preview` ne poste rien.
   */
  async function autoSellCycle({ dryRun = false, preview = false } = {}) {
    const a = state.autoSell;
    const s = state.settings;
    const type = s.autoSellType === 'auction' ? 'auction' : 'fixed';

    a.status = preview ? 'Calcul de l’aperçu…' : 'Lecture de la collection…';
    render();
    await autoSellRefresh();

    const slots = listingSlots();
    const all = sellRows();
    const duplicateIds = all.filter((row) => autoSellSpare(row) > 0).map((row) => String(row.id));
    const unscanned = duplicateIds.filter((id) => !state.marketScanned.has(id));
    if (unscanned.length) {
      a.status = `Lecture du marché (${Math.min(60, unscanned.length)}/${unscanned.length})…`;
      render();
      // Prix par petits lots : les cartes déjà lues restent en cache.
      await ensureMarketData(unscanned.slice(0, 60));
    }

    const priced = all.map((row) => ({
      ...row,
      characterId: apiId(row.rawId ?? row.id),
      price: autoSellPrice(row, s.autoSellStrategy),
      floor: recycleFloor(row.rarity)
    }));
    const candidates = autoSellSelect(priced, {
      includeML: Boolean(s.autoSellIncludeML),
      minPrice: Number(s.autoSellMinPrice) || 1
    });
    const plan = autoSellBuildPlan(candidates, {
      slots: slots.remaining,
      maxPerCycle: Number(s.autoSellMaxPerCycle) || 10
    });
    const withoutPrice = priced.filter(
      (row) =>
        autoSellSpare(row) > 0 &&
        row.price == null &&
        (s.autoSellIncludeML || !['M', 'L'].includes(String(row.rarity || '').toUpperCase()))
    ).length;

    if (preview) {
      a.preview = { at: Date.now(), plan, slots, candidates: candidates.length, withoutPrice };
      a.status = plan.length
        ? `Aperçu · ${fmt(plan.length)} annonce(s) prévue(s)`
        : slots.remaining <= 0
          ? 'Aucune place d’annonce libre'
          : 'Aucun doublon vendable';
      autoSellLog(
        `${a.status}${withoutPrice ? ` · ${fmt(withoutPrice)} doublon(s) sans prix ignoré(s)` : ''}`,
        plan.length ? 'info' : 'err'
      );
      render();
      return { plan, created: 0, matched: 0, errors: 0, simulated: 0, fatal: null, preview: true };
    }

    if (!plan.length) {
      a.cycles += 1;
      a.status =
        slots.remaining <= 0
          ? 'Aucune place d’annonce libre'
          : duplicateIds.length
            ? 'Aucun doublon avec un prix connu'
            : 'Aucun doublon';
      a.lastPlan = [];
      render();
      return { plan: [], created: 0, matched: 0, errors: 0, simulated: 0, fatal: null };
    }

    a.status = dryRun
      ? `Simulation de ${fmt(plan.length)} annonce(s)…`
      : `Mise en vente de ${fmt(plan.length)} annonce(s)…`;
    render();

    const result = await runSalePlan(plan, {
      type,
      duration: autoSellDuration(),
      buyoutPct: state.settings.buyoutPct,
      dryRun,
      gapMs: state.settings.gapMs,
      source: 'auto',
      log: autoSellLog,
      shouldStop: () => !a.running || a.stop
    });

    a.cycles += 1;
    a.created += result.created;
    a.matched += result.matched;
    a.errors += result.errors;
    a.lastPlan = plan;
    a.preview = null;

    if (!dryRun) {
      try {
        await autoSellRefresh();
      } catch {
        return { ...result, plan, fatal: 'Collection illisible après la vente : arrêt de la vente auto.' };
      }
    }

    if (result.stopped === 'errors') {
      return { ...result, plan, fatal: 'Arrêt après 3 erreurs consécutives.' };
    }
    if (result.stopped === 'auth') {
      return { ...result, plan, fatal: 'Session expirée ou limite API : arrêt de la vente auto.' };
    }
    return { ...result, plan, fatal: null };
  }

  function armAutoSell() {
    const a = state.autoSell;
    a.armed = true;
    a.status = 'Confirmation requise';
    render();
  }

  function disarmAutoSell() {
    const a = state.autoSell;
    a.armed = false;
    a.status = '';
    render();
  }

  async function autoSellPreview() {
    const a = state.autoSell;
    if (a.running) return;
    a.preview = null;
    a.status = 'Calcul de l’aperçu…';
    render();
    try {
      await autoSellCycle({ preview: true });
    } catch (err) {
      a.lastError = friendlyError(err);
      a.status = 'Aperçu impossible';
      autoSellLog(`Aperçu impossible · ${a.lastError}`, 'err');
    }
  }

  async function startAutoSell() {
    const a = state.autoSell;
    if (a.running) return;
    if (!state.user) {
      notify('Connecte-toi à Kyara pour lancer la vente auto.');
      return;
    }
    if (state.sell) {
      notify('Ferme la fenêtre de vente manuelle avant de lancer la vente auto.');
      return;
    }
    a.armed = false;
    a.running = true;
    a.stop = false;
    a.gen += 1;
    a.cycles = 0;
    a.created = 0;
    a.matched = 0;
    a.errors = 0;
    a.status = 'Démarrage…';
    a.startedAt = Date.now();
    a.beatAt = Date.now();
    a.nextAt = 0;
    a.lastError = null;
    a.preview = null;
    a.log = [];
    autoSellLog('Vente auto démarrée · doublons uniquement, dernière copie conservée');
    persistSettings();
    render();
    autoSellLoop().catch((err) => {
      a.running = false;
      a.stop = true;
      a.lastError = friendlyError(err);
      a.status = 'Erreur inattendue';
      autoSellLog(`Erreur inattendue · ${a.lastError}`, 'err');
      render();
    });
  }

  function stopAutoSell(reason = 'Vente auto arrêtée') {
    const a = state.autoSell;
    if (!a.running && !a.armed) return;
    a.armed = false;
    a.running = false;
    a.stop = true;
    a.gen += 1;
    a.nextAt = 0;
    a.status = reason;
    autoSellLog(reason);
    render();
  }

  async function autoSellWait(ms, alive) {
    const end = Date.now() + Math.max(0, ms);
    while (Date.now() < end) {
      if (!alive()) return;
      await sleep(Math.min(1000, end - Date.now()));
    }
  }

  async function autoSellLoop() {
    const a = state.autoSell;
    const gen = ++a.gen;
    const alive = () => a.running && !a.stop && a.gen === gen;
    while (alive()) {
      a.beatAt = Date.now();
      if (state.sell) {
        a.status = 'Vente manuelle ouverte · attente';
        a.nextAt = Date.now() + 15000;
        render();
        await autoSellWait(15000, alive);
        continue;
      }

      let result;
      try {
        result = await autoSellCycle({ dryRun: Boolean(state.settings.autoSellDryRun) });
      } catch (err) {
        a.lastError = friendlyError(err);
        a.running = false;
        a.stop = true;
        a.status = 'Erreur de lecture';
        autoSellLog(`Erreur · ${a.lastError}`, 'err');
        render();
        break;
      }
      if (!alive()) break;
      if (result.fatal) {
        a.running = false;
        a.stop = true;
        a.lastError = result.fatal;
        a.status = 'Arrêté';
        autoSellLog(result.fatal, 'err');
        render();
        break;
      }

      const interval = Math.min(
        3600,
        Math.max(30, Math.round(Number(state.settings.autoSellIntervalSec) || 60))
      ) * 1000;
      const idle = Math.max(interval, 5 * 60 * 1000);
      const wait = result.plan.length ? interval : idle;
      a.nextAt = Date.now() + wait;
      a.status = result.plan.length
        ? `Cycle ${a.cycles} · ${fmt(a.created)} annonce(s) · ${fmt(a.matched)} vente(s) immédiate(s)`
        : state.settings.autoSellDryRun
          ? 'Simulation · aucun doublon vendable'
          : 'Aucun doublon vendable · attente';
      render();
      await autoSellWait(wait, alive);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Render                                                              */
  /* ------------------------------------------------------------------ */

  function render() {
    // Le rendu ne doit jamais casser la boucle auto-open : on isole les erreurs.
    try {
      renderUnsafe();
    } catch (err) {
      pushDebug({ method: 'render', path: '', status: 0, ms: 0, ok: false, error: String(err?.message || err) });
    }
  }

  function renderUnsafe() {
    if (!state.mounted || !ui) return;
    ui.panel.hidden = !state.open;
    // Les onglets denses (Vente, Stat) gardent un peu plus de largeur.
    ui.panel.classList.toggle('is-wide', state.tab === 'sell' || state.tab === 'stat');
    // +Duel : l'application occupe toute la hauteur (pas de stats ni d'onglets au-dessus).
    ui.panel.classList.toggle('is-duel', duelState().mode === 'duel');
    ui.fab.classList.toggle('is-open', state.open);
    if (!state.open) {
      renderModal();
      return;
    }

    const view = ui.view;
    const tabAtRender = state.tab;
    const scrollTop = view.scrollTop;
    renderBanner();
    renderStats();
    renderTabs();
    renderView();
    renderFooter();
    renderModal();
    view.scrollTop = scrollTop;
    // Le contenu vient d'être remplacé : images et lignes peuvent encore changer
    // la hauteur après le rendu. On re-applique la position au frame suivant pour
    // éviter le retour en haut pendant une vente.
    if (scrollTop > 0) {
      requestAnimationFrame(() => {
        if (ui?.view === view && state.tab === tabAtRender && Math.abs(view.scrollTop - scrollTop) > 1) {
          view.scrollTop = scrollTop;
        }
      });
    }
  }

  function renderBanner() {
    if (!ui?.banner) return;

    // 1) Une version plus récente existe sur GitHub : information seule, sans
    //    bouton de téléchargement (la mise à jour se fait hors extension).
    const remote = state.update.version;
    if (remote && isNewerVersion(remote, state.version)) {
      ui.banner.hidden = false;
      ui.banner.classList.remove('is-stale');
      ui.banner.innerHTML = `
        <span class="kp-banner-text">
          Version <b>v${esc(remote)}</b> disponible (tu as v${esc(state.version)}).
        </span>
      `;
      return;
    }

    // 2) Le navigateur garde un manifeste plus ancien que le dossier (dev).
    if (state.manifestOutdated) {
      ui.banner.hidden = false;
      ui.banner.classList.add('is-stale');
      ui.banner.innerHTML = `
        <span class="kp-banner-text">
          Le dossier est en v${esc(state.version)} mais ${esc(BROWSER_NAME)} a chargé v${esc(state.manifestVersion ?? '?')}.
          ${
            IS_GECKO
              ? "Retire l'add-on dans <code>about:debugging</code>, puis recharge-le depuis le dossier."
              : 'Ouvre <code>chrome://extensions</code>, clique sur « Actualiser » pour Kyareeh+, puis recharge la page.'
          }
        </span>
        <button class="kp-btn is-primary" type="button" data-act="tab" data-tab="debug">Voir Debug</button>
      `;
      return;
    }

    ui.banner.hidden = true;
    ui.banner.innerHTML = '';
  }

  function renderStats() {
    if (!ui) return;

    // Vue d'un autre joueur : la bande haute suit le profil consulté.
    if (state.profile.view !== 'self') {
      const u = state.profile.user;
      const v = state.profile.value;
      ui.stats.innerHTML = `
        <div class="kp-metric"><span>Compte</span><b>${esc(u?.pseudo ?? 'Recherche…')}</b></div>
        <div class="kp-metric"><span>Valeur est.</span><b>◆ ${fmt(v?.total ?? 0)}</b></div>
        <div class="kp-metric"><span>Cartes</span><b>${fmt(u?.owned ?? 0)}</b></div>
      `;
      return;
    }

    if (!state.user) {
      ui.stats.innerHTML = '';
      return;
    }
    const stats = computeStats(ownedRows());
    const chakra = toNum(state.user.chakra);
    ui.stats.innerHTML = `
      <div class="kp-metric"><span>Valeur compte</span><b>◆ ${fmt(stats.total)}</b></div>
      <div class="kp-metric"><span>Chakra</span><b>${fmt(chakra)}</b></div>
      <div class="kp-metric"><span>Vendables</span><b>${fmt(stats.dupCopies)} <small>exemplaires</small></b></div>
    `;
  }

  /** Nombre de cartes réellement vendables, sans construire toutes les lignes. */
  function countSellableCards() {
    let count = 0;
    for (const item of state.collection) {
      const qty = Math.max(1, Number(item?.qty ?? item?.quantity ?? 1));
      const listableRaw = item?.listable ?? item?.listableQty ?? item?.sellable;
      const listable = listableRaw == null ? qty : Math.max(0, Number(listableRaw));
      if (Math.min(qty, listable) > 0) count += 1;
    }
    return count;
  }

  /* ------------------------------------------------------------------ */
  /* +Duel : application autonome intégrée (iframe) ou détachée          */
  /* ------------------------------------------------------------------ */
  // Le duel vit dans `duel/duel.html` (docs/DUEL-V2.md §3). Ici : le mode +Duel affiche cette
  // page dans une <iframe> (ressource web_accessible_resources), propose de la détacher dans
  // sa propre fenêtre (via le script de fond) et publie le profil du joueur (pseudo + cartes
  // possédées) dans storage.local, la page du duel n'ayant pas la session kyara.games.

  const DUEL_PROFILE_KEY = 'kyareeh.duel.profile';
  const DUEL_WINDOW_KEY = 'kyareeh.duel.window';
  const DUEL_PROFILE_REFRESH_MS = 5 * 60 * 1000;
  const DUEL_FRAME_TIMEOUT_MS = 6000;

  let duelProfileSig = '';
  let duelProfileAt = 0;
  let duelHostEl = null;
  let duelFrameEl = null;
  let duelFrameTimer = null;

  function duelState() {
    if (!state.__duel) {
      state.__duel = { mode: 'tools', detached: false, frameReady: false, frameFailed: false, busy: false };
    }
    return state.__duel;
  }

  function duelPlayerName() {
    const user = state.user ?? {};
    return String(user.pseudo ?? user.username ?? user.name ?? '').trim() || 'Joueur';
  }

  function duelOwnedIds() {
    const set = new Set();
    try {
      for (const row of ownedRows()) {
        const id = row?.id ?? row?.rawId;
        if (id != null) set.add(String(id));
      }
    } catch {
      /* pas connecté */
    }
    return set;
  }

  /**
   * Publie { name, owned, at } pour la page du duel. Appelé à chaque chargement de la
   * collection ; on n'écrit que si le contenu a changé (ou toutes les 5 minutes).
   */
  function publishDuelProfile() {
    if (!state.user || !Array.isArray(state.collection)) return;
    const name = duelPlayerName();
    const owned = [...duelOwnedIds()].sort();
    const sig = `${name}|${owned.join(',')}`;
    const now = Date.now();
    if (sig === duelProfileSig && now - duelProfileAt < DUEL_PROFILE_REFRESH_MS) return;
    duelProfileSig = sig;
    duelProfileAt = now;
    storageSet(DUEL_PROFILE_KEY, { name, owned, at: now });
  }

  function duelSendMessage(message) {
    try {
      return Promise.resolve(ext.runtime.sendMessage(message)).catch(() => null);
    } catch {
      return Promise.resolve(null);
    }
  }

  function duelApplyWindowKey(value) {
    const duel = duelState();
    const detached = Boolean(value && typeof value === 'object' && value.id != null);
    if (detached === duel.detached) return;
    duel.detached = detached;
    if (detached) destroyDuelFrame();
    render();
  }

  async function loadDuelWindowState() {
    duelApplyWindowKey(await storageGet(DUEL_WINDOW_KEY, null));
    try {
      ext.storage.onChanged.addListener((changes, area) => {
        if (area && area !== 'local') return;
        if (changes && changes[DUEL_WINDOW_KEY]) duelApplyWindowKey(changes[DUEL_WINDOW_KEY].newValue);
      });
    } catch {
      /* pas d'écoute possible : l'état se met à jour à chaque ouverture du mode */
    }
  }

  async function duelDetach() {
    const duel = duelState();
    if (duel.busy) return;
    duel.busy = true;
    // L'iframe est retirée d'abord : elle enregistre sa partie avant que la fenêtre ne s'ouvre.
    duel.detached = true;
    destroyDuelFrame();
    render();
    const res = await duelSendMessage({ type: 'kp-duel-detach' });
    duel.busy = false;
    if (!res || !res.ok) {
      duel.detached = false;
      notify('Impossible d’ouvrir la fenêtre du duel.');
    }
    render();
  }

  async function duelAttach() {
    const duel = duelState();
    if (duel.busy) return;
    duel.busy = true;
    const res = await duelSendMessage({ type: 'kp-duel-attach' });
    duel.busy = false;
    // Sans réponse du fond, on réaffiche quand même l'application dans le panneau.
    if (!res || res.ok !== false) duel.detached = false;
    render();
  }

  function destroyDuelFrame() {
    clearTimeout(duelFrameTimer);
    duelFrameTimer = null;
    if (duelHostEl?.parentNode) duelHostEl.remove();
    duelHostEl = null;
    duelFrameEl = null;
    const duel = duelState();
    duel.frameReady = false;
    duel.frameFailed = false;
  }

  function duelFrameOrigin() {
    try {
      return new URL(ext.runtime.getURL('duel/duel.html'), location.href).origin;
    } catch {
      return '';
    }
  }

  /** Élément persistant : l'iframe ne doit pas être recréée à chaque rendu du panneau. */
  function duelHost() {
    if (duelHostEl) return duelHostEl;
    const duel = duelState();
    duelHostEl = document.createElement('div');
    duelHostEl.className = 'kp-duel-host';
    duelFrameEl = document.createElement('iframe');
    duelFrameEl.className = 'kp-duel-frame';
    duelFrameEl.title = 'Kyara Duel';
    duelFrameEl.setAttribute('allow', 'autoplay');
    duelFrameEl.src = ext.runtime.getURL('duel/duel.html?embed=1');
    duelHostEl.appendChild(duelFrameEl);
    // Si la page du duel ne signale pas qu'elle est prête, on suggère la fenêtre détachée.
    duel.frameReady = false;
    duel.frameFailed = false;
    clearTimeout(duelFrameTimer);
    duelFrameTimer = setTimeout(() => {
      if (duel.frameReady || !duelHostEl) return;
      duel.frameFailed = true;
      const note = document.createElement('div');
      note.className = 'kp-duel-failed';
      note.innerHTML = `<b>Le duel intégré n’a pas répondu.</b>
        <span>La page peut bloquer l’affichage dans le panneau. Ouvre-le dans sa propre fenêtre.</span>
        <button class="kp-btn is-primary" type="button" data-act="duel-detach">Détacher le duel</button>`;
      duelHostEl.appendChild(note);
    }, DUEL_FRAME_TIMEOUT_MS);
    return duelHostEl;
  }

  function onDuelMessage(event) {
    const duel = state.__duel;
    if (!duel || !duelFrameEl || event.source !== duelFrameEl.contentWindow) return;
    if (event.origin !== duelFrameOrigin()) return;
    if (event.data && event.data.type === 'kp-duel-ready') {
      duel.frameReady = true;
      duel.frameFailed = false;
      duelHostEl?.querySelector('.kp-duel-failed')?.remove();
    }
  }

  function detachedCardHtml() {
    return `<div class="kp-duel-away">
        <div class="kp-duel-away-card">
          <span class="kp-duel-away-icon" aria-hidden="true">⧉</span>
          <b>Duel ouvert dans une fenêtre</b>
          <p>Le combat se joue dans sa propre fenêtre. Ferme-la, ou rattache-la ici pour reprendre dans le panneau.</p>
          <button class="kp-btn is-primary" type="button" data-act="duel-attach">Rattacher</button>
        </div>
      </div>`;
  }

  function renderModes() {
    if (!ui?.modes) return;
    const duel = duelState();
    const buttons = [
      ['tools', '+Tools'],
      ['duel', '+Duel']
    ]
      .map(
        ([id, label]) =>
          `<button class="kp-mode ${duel.mode === id ? 'is-active' : ''}" type="button" data-act="mode" data-mode="${id}">${label}</button>`
      )
      .join('');
    const detach =
      duel.mode === 'duel' && !duel.detached
        ? '<button class="kp-mode kp-duel-detach" type="button" data-act="duel-detach" title="Ouvrir le duel dans sa propre fenêtre">⧉ Détacher</button>'
        : '';
    ui.modes.innerHTML = buttons + detach;
  }


  function renderTabs() {
    if (!ui) return;
    renderModes();
    const duel = duelState();
    if (duel.mode === 'duel') {
      ui.tabs.innerHTML = '';
      return;
    }
    const sellable = countSellableCards();
    const tabs = [
      ['account', 'Compte'],
      ['sell', sellable ? `Vente (${sellable})` : 'Vente'],
      ['market', 'Marché'],
      ['cards', '%Drop'],
      ['auto', 'Auto-Open'],
      ['stat', 'Stat'],
      ['settings', 'Réglages'],
      ['debug', 'Debug']
    ];
    ui.tabs.innerHTML = tabs
      .map(
        ([id, label]) =>
          `<button class="kp-tab ${state.tab === id ? 'is-active' : ''}" type="button" data-act="tab" data-tab="${id}">${esc(label)}</button>`
      )
      .join('');
  }

  function renderFooter() {
    if (!ui) return;
    const busy = state.loading || state.priceRun.running || state.sell?.running;
    const bad = Boolean(state.error) || (state.user === null && state.ready);
    const dot = bad ? 'is-bad' : busy ? 'is-busy' : '';
    const msg = state.notice
      ? esc(state.notice)
      : state.error
        ? esc(state.error)
        : state.lastSync
          ? `Synchro ${nowTime()}`
          : 'Prêt';
    ui.foot.innerHTML = `
      <span><i class="kp-dot ${dot}"></i>${msg}</span>
      <span>v${esc(state.version)}${state.manifestOutdated ? ' · version en retard' : ''} · Alt+K</span>
    `;
  }

  function renderView() {
    if (!ui) return;
    const duel = duelState();
    // Mode +Duel : l'iframe vit dans son propre conteneur, jamais recréée tant que le mode change
    // (une partie en ligne survit à un passage par +Tools).
    if (duel.mode === 'duel') {
      ui.view.hidden = true;
      ui.slot.hidden = false;
      if (duel.detached) {
        destroyDuelFrame();
        ui.slot.innerHTML = detachedCardHtml();
      } else if (!duelHostEl) {
        ui.slot.replaceChildren(duelHost());
      }
      return;
    }
    ui.view.hidden = false;
    ui.slot.hidden = true;
    const fn = {
      account: viewAccount,
      sell: viewSell,
      market: viewMarket,
      cards: viewCards,
      auto: viewAuto,
      stat: viewStat,
      settings: viewSettings,
      debug: viewDebug
    }[state.tab] ?? viewAccount;
    ui.view.innerHTML = fn();
  }

  function loginHTML() {
    return `
      <div class="kp-empty">
        <b>Connecte-toi à Kyara</b>
        Kyareeh+ utilise ta session existante, sans jamais voir ton mot de passe.<br>
        Connecte-toi avec Discord sur kyara.games, puis clique sur « Rafraîchir ».
        <div style="margin-top:14px">
          <button class="kp-btn is-primary" type="button" data-act="open-site">Ouvrir kyara.games</button>
        </div>
      </div>`;
  }

  function errorHTML() {
    return `
      <div class="kp-empty">
        <b>Impossible de charger le compte</b>
        ${esc(state.error || 'Erreur inconnue')}
        <div style="margin-top:14px">
          <button class="kp-btn" type="button" data-act="refresh">Réessayer</button>
        </div>
      </div>`;
  }

  function titleLabel(value) {
    if (!value) return null;
    if (typeof value === 'string') return value;
    if (typeof value === 'object') return value.label ?? value.name ?? value.title ?? null;
    return null;
  }

  function selfProfileHead() {
    const me = state.user;
    if (!me) return '';
    const pub = state.selfProfile ?? {};
    const id = pub.id ?? me.id;

    const avatar = pub.avatar ?? me.avatar ?? me.discord?.avatar ?? null;
    const rankLabel = pub.rank?.label ?? titleLabel(me.rank) ?? null;
    const points = toNum(pub.rank?.points ?? pub.points ?? me.rank?.points ?? me.points);
    const title = titleLabel(pub.title) ?? titleLabel(me.title);
    const subtitle = [rankLabel, points != null ? `${fmt(points)} pts` : null].filter(Boolean).join(' · ');

    return `
      <div class="kp-profile-head">
        ${
          avatar
            ? `<img class="kp-avatar-lg" src="${esc(avatar)}" alt="" referrerpolicy="no-referrer" loading="lazy">`
            : `<div class="kp-avatar-lg kp-avatar-fallback">◆</div>`
        }
        <div class="kp-profile-id">
          <b>${esc(pub.pseudo ?? me.pseudo ?? 'Moi')}</b>
          <small>${esc(subtitle || '—')}</small>
          ${title ? `<span class="kp-title-badge">${esc(title)}</span>` : ''}
        </div>
        <a class="kp-link" href="https://kyara.games/profil/${encodeURIComponent(id ?? '')}" target="_blank" rel="noopener">Voir sur le site ↗</a>
      </div>
    `;
  }

  function viewAccount() {
    if (state.profile.view === 'other') return viewOtherAccount();
    if (state.profile.view === 'search') return viewProfileSearch();
    if (!state.user) return state.error ? errorHTML() : loginHTML();
    const rows = ownedRows();
    const stats = computeStats(rows);
    const dupeCount = duplicateRows().length;

    const top = rows
      .filter((r) => r.price != null)
      .sort((a, b) => b.price - a.price)
      .slice(0, 8);

    const byRarity = new Map();
    for (const row of rows) {
      const key = row.rarity;
      const cur = byRarity.get(key) ?? { value: 0, qty: 0, label: rarityInfo(key).label, color: rarityInfo(key).color };
      cur.value += (row.price ?? 0) * row.qty;
      cur.qty += row.qty;
      byRarity.set(key, cur);
    }
    const rarities = [...byRarity.entries()].sort((a, b) => b[1].value - a[1].value);
    const maxRarity = Math.max(1, ...rarities.map(([, v]) => v.value));

    const seriesTotals = new Map();
    for (const character of state.characters.values()) {
      const key = character?.series || 'Inconnue';
      seriesTotals.set(key, (seriesTotals.get(key) ?? 0) + 1);
    }
    const ownedBySeries = new Map();
    for (const row of rows) {
      const key = row.series || 'Inconnue';
      const set = ownedBySeries.get(key) ?? new Set();
      set.add(row.id);
      ownedBySeries.set(key, set);
    }
    const series = [...ownedBySeries.entries()]
      .map(([name, set]) => {
        const total = seriesTotals.get(name) ?? set.size;
        return { name, owned: set.size, total, pct: total ? Math.round((set.size / total) * 100) : 0 };
      })
      .filter((s) => s.total >= 5)
      .sort((a, b) => b.pct - a.pct || b.owned - a.owned)
      .slice(0, 8);

    const progressPct = state.priceRun.total ? Math.round((state.priceRun.done / state.priceRun.total) * 100) : 0;

    const booster = toNum(state.user.freePacks) ?? 0;
    const boosterMax = toNum(state.user.freePacksMax) ?? toNum(state.config?.freePacks?.max) ?? null;
    const bonus = toNum(state.user.bonusPacks) ?? 0;
    const pity = toNum(state.user.pity);
    const pityMax = toNum(state.config?.pity?.threshold);
    const accessOk = state.access?.allowed !== false;

    return `
      ${profileSearchBar()}
      ${selfProfileHead()}
      <div class="kp-hero" style="margin-top:10px">
        <div class="kp-hero-label">Valeur estimée du compte</div>
        <div class="kp-hero-value">◆ ${fmt(stats.total)}</div>
        <div class="kp-hero-sub">
          Fourchette ${fmt(stats.low)} – ${fmt(stats.high)} · ${stats.priced}/${stats.count} cartes valorisées
          ${stats.unpriced ? ` · ${stats.unpriced} sans prix` : ''}
        </div>
        ${
          state.priceRun.running
            ? `<div class="kp-progress">
                 <div class="kp-progress-bar"><i style="width:${progressPct}%"></i></div>
                 <div class="kp-progress-row"><span>Valorisation en cours…</span><span>${state.priceRun.done}/${state.priceRun.total}</span></div>
               </div>`
            : `<div class="kp-progress">
                 <div class="kp-progress-row">
                   <span>Médianes du marché · cache ${state.settings.ttlH} h</span>
                   <span class="kp-link" data-act="calc-prices">Recalculer</span>
                 </div>
               </div>`
        }
      </div>

      ${state.user.guest || state.user.isGuest ? `<div class="kp-alert" style="margin-top:10px">Compte invité : connecte-toi avec Discord pour débloquer le marché et la vente.</div>` : ''}
      ${state.user.ban ? `<div class="kp-alert is-bad" style="margin-top:10px">Compte en pause : ${esc(state.user.banReason ?? 'contacte le support')}</div>` : ''}

      <div class="kp-grid">
        <div class="kp-card-stat"><span>Doublons (brut)</span><b>◆ ${fmt(stats.dupGross)}</b><small>${plural(stats.dupCopies, 'exemplaire')} vendable${stats.dupCopies > 1 ? 's' : ''}</small></div>
        <div class="kp-card-stat"><span>Net si vendus</span><b>◆ ${fmt(stats.dupNet)}</b><small>après taxe ${getCfg().taxPct} % + frais</small></div>
        <div class="kp-card-stat"><span>Cartes</span><b>${fmt(stats.unique)} <small>/ ${fmt(stats.totalCards)}</small></b><small>uniques / total</small></div>
        <div class="kp-card-stat"><span>Chakra</span><b>${fmt(toNum(state.user.chakra))}</b><small>solde actuel</small></div>
      </div>

      <div class="kp-section">
        <div class="kp-section-title">Ressources <span class="kp-link" data-act="tab" data-tab="sell">${plural(dupeCount, 'doublon')} →</span></div>
        <div class="kp-chips">
          <span class="kp-chip"><em>Boosters</em> ${booster}${boosterMax != null ? ` / ${boosterMax}` : ''}</span>
          ${bonus ? `<span class="kp-chip"><em>Bonus</em> ${bonus}</span>` : ''}
          ${pity != null ? `<span class="kp-chip"><em>Pity</em> ${pity}${pityMax ? ` / ${pityMax}` : ''}</span>` : ''}
          <span class="kp-chip"><em>Marché</em> ${accessOk ? 'débloqué' : 'verrouillé'}</span>
          <span class="kp-chip"><em>Recyclage doublons</em> ◆ ${fmt(stats.dupRecycle)}</span>
          <span class="kp-chip"><em>Pseudo</em> ${esc(state.user.pseudo ?? '—')}</span>
        </div>
      </div>

      ${
        top.length
          ? `<div class="kp-section">
               <div class="kp-section-title">Top cartes</div>
               <div class="kp-top">
                 ${top
                   .map(
                     (r) => `
                   <div class="kp-top-card" data-act="open-card" data-id="${esc(r.id)}" title="${esc(r.name)} · ◆ ${fmt(r.price)}">
                     <img src="${esc(r.image)}" alt="${esc(r.name)}" loading="lazy">
                     <span>${esc(r.name)}</span>
                     <b>◆ ${fmt(r.price)}</b>
                   </div>`
                   )
                   .join('')}
               </div>
             </div>`
          : ''
      }

      ${
        rarities.length
          ? `<div class="kp-section">
               <div class="kp-section-title">Valeur par rareté</div>
               <div class="kp-bars">
                 ${rarities
                   .map(
                     ([key, v]) => `
                   <div class="kp-bar-row">
                     <span>${esc(v.label)} · ${v.qty}</span>
                     <div class="kp-bar"><i style="width:${Math.max(2, Math.round((v.value / maxRarity) * 100))}%;--kp-bar-color:${v.color}"></i></div>
                     <b>◆ ${fmt(v.value)}</b>
                   </div>`
                   )
                   .join('')}
               </div>
             </div>`
          : ''
      }

      ${
        series.length
          ? `<div class="kp-section">
               <div class="kp-section-title">Séries les plus complètes</div>
               <div class="kp-bars">
                 ${series
                   .map(
                     (s, index) => `
                   <div class="kp-bar-row">
                     <span title="${esc(s.name)}">${esc(s.name)}</span>
                     <div class="kp-bar"><i style="width:${Math.max(2, s.pct)}%;--kp-bar-color:${SERIES_COLORS[index % SERIES_COLORS.length]}"></i></div>
                     <b>${s.owned}/${s.total}</b>
                   </div>`
                   )
                   .join('')}
               </div>
             </div>`
          : ''
      }
    `;
  }

  /* ------------------------------------------------------------------ */
  /* Statistiques globales : calculs purs                                */
  /* ------------------------------------------------------------------ */
  /* Statistiques : classement de comptes suivis                        */
  /* ------------------------------------------------------------------ */

  /* STATS:BEGIN — bloc autonome, extrait par test/verify-statglobal.mjs.
   * Aucune fonction ici ne touche au DOM, au réseau ou au stockage.
   * Toutes les valeurs viennent de champs publics du site ; ce qui n'est pas
   * fourni reste `null` et s'affiche « — », jamais estimé. */

  function statRarityOf(value) {
    const code = String(value ?? '').trim().toUpperCase();
    return code || 'C';
  }

  function statEmptyData() {
    return {
      version: 1,
      at: 0,
      accounts: {},
      owners: {},
      ownerTotal: 0,
      sort: 'value',
      desc: true,
      friendsAt: 0,
      friendIds: []
    };
  }

  // Attention : Number(null) vaut 0. Une donnée absente doit rester absente,
  // sinon un rang ou une valeur inconnus seraient affichés comme « 0 ».
  const num = (value) => {
    if (value == null || value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? n : null;
  };

  /** Revalide un objet relu du stockage : une valeur absente reste absente. */
  function statNormalizeData(raw) {
    const source = raw && typeof raw === 'object' ? raw : {};
    const out = statEmptyData();
    out.at = Number(source.at) > 0 ? Number(source.at) : 0;
    out.sort = typeof source.sort === 'string' && source.sort ? source.sort : 'value';
    out.desc = source.desc !== false;
    out.ownerTotal = num(source.ownerTotal) ?? 0;
    out.friendsAt = Number(source.friendsAt) > 0 ? Number(source.friendsAt) : 0;
    out.friendIds = Array.isArray(source.friendIds)
      ? [...new Set(source.friendIds.map((id) => String(id ?? '')).filter(Boolean))]
      : [];

    for (const [id, entry] of Object.entries(source.accounts ?? {})) {
      if (!entry || typeof entry !== 'object') continue;
      const key = String(id);
      const isSelf = Boolean(entry.self) || entry.source === 'self';
      const fromFriend = !isSelf && entry.source === 'friend';
      const byRarity = {};
      for (const [code, value] of Object.entries(entry.byRarity ?? {})) {
        const n = num(value);
        if (n) byRarity[statRarityOf(code)] = n;
      }
      out.accounts[key] = {
        id: key,
        pseudo: String(entry.pseudo ?? 'Joueur'),
        avatar: typeof entry.avatar === 'string' ? entry.avatar : null,
        self: isSelf,
        source: isSelf ? 'self' : fromFriend ? 'friend' : 'manual',
        addedAt: Number(entry.addedAt) > 0 ? Number(entry.addedAt) : Date.now(),
        at: Number(entry.at) > 0 ? Number(entry.at) : 0,
        error: typeof entry.error === 'string' && entry.error ? entry.error : null,
        owned: num(entry.owned),
        doubles: num(entry.doubles),
        copies: num(entry.copies),
        boosters: num(entry.boosters),
        listings: num(entry.listings),
        rankPos: num(entry.rankPos),
        catalogSize: num(entry.catalogSize),
        byRarity,
        mythic: num(entry.mythic),
        legendary: num(entry.legendary),
        value: num(entry.value),
        valuePriced: num(entry.valuePriced) ?? 0,
        valueUnpriced: num(entry.valueUnpriced) ?? 0,
        valueAt: Number(entry.valueAt) > 0 ? Number(entry.valueAt) : 0,
        seriesFinished: num(entry.seriesFinished),
        seriesAlmost: num(entry.seriesAlmost),
        dupesValue: num(entry.dupesValue),
        collectionAt: Number(entry.collectionAt) > 0 ? Number(entry.collectionAt) : 0
      };
    }

    for (const [cardId, count] of Object.entries(source.owners ?? {})) {
      const n = num(count);
      if (n) out.owners[String(cardId)] = n;
    }

    return out;
  }

  /**
   * Avancement des séries : une série est « finie » quand toutes ses cartes du
   * catalogue sont possédées, « presque finie » quand il en manque 3 ou moins.
   * Les cartes possédées absentes du catalogue sont ignorées.
   */
  function statSeriesProgress(ownedIds, catalog) {
    const owned = ownedIds instanceof Set ? ownedIds : new Set((ownedIds ?? []).map(String));
    const bySeries = new Map();
    for (const card of Array.isArray(catalog) ? catalog : []) {
      const id = card?.id ?? card?.characterId;
      if (id == null) continue;
      const name = card?.series || 'Inconnue';
      const entry = bySeries.get(name) ?? { total: 0, owned: 0 };
      entry.total += 1;
      if (owned.has(String(id))) entry.owned += 1;
      bySeries.set(name, entry);
    }
    let finished = 0;
    let almost = 0;
    for (const entry of bySeries.values()) {
      if (!entry.total) continue;
      if (entry.owned >= entry.total) finished += 1;
      else if (entry.total - entry.owned <= 3) almost += 1;
    }
    return { finished, almost, series: bySeries.size };
  }

  /**
   * Valeur en chakra d'une collection : somme des prix officiels connus.
   * Une carte sans prix est comptée à part, jamais valorisée au hasard.
   */
  function statCollectionValue(ownedIds, prices) {
    const priceOf = (id) => {
      if (prices instanceof Map) return Number(prices.get(String(id)));
      return Number(prices?.[String(id)]);
    };
    let value = 0;
    let priced = 0;
    let unpriced = 0;
    for (const id of ownedIds ?? []) {
      const price = priceOf(id);
      if (Number.isFinite(price) && price > 0) {
        value += price;
        priced += 1;
      } else {
        unpriced += 1;
      }
    }
    return { value, priced, unpriced };
  }

  /** Union des cartes de plusieurs collections. */
  function statUnionIds(list) {
    const ids = new Set();
    for (const entry of Array.isArray(list) ? list : []) {
      for (const id of entry ?? []) {
        const key = String(id ?? '');
        if (key) ids.add(key);
      }
    }
    return ids;
  }

  /**
   * Compteur de propriétaires par carte, à partir des ids possédés.
   * Un compte qui possède plusieurs exemplaires ne compte qu'une fois : on
   * dédoublonne les ids à l'intérieur de chaque compte.
   */
  function statOwnerCounts(collections) {
    const counts = {};
    for (const ids of Object.values(collections ?? {})) {
      const seen = new Set();
      for (const cardId of ids ?? []) {
        const key = String(cardId ?? '');
        if (!key || seen.has(key)) continue;
        seen.add(key);
        counts[key] = (counts[key] ?? 0) + 1;
      }
    }
    return counts;
  }

  /**
   * Fabrique les métriques d'un compte. `profile` = réponse de /api/users/:id,
   * `ids` = cartes possédées (ou null si illisible), `prices` = prix officiels.
   */
  function statAccountMetrics(profile, ids, prices, catalog) {
    const owned = num(profile?.owned);
    const doubles = num(profile?.doublesCount);
    const collection = Array.isArray(ids) ? ids : null;
    const progress = collection ? statSeriesProgress(collection, catalog) : null;
    const valued = collection ? statCollectionValue(collection, prices) : null;
    const byRarity = {};
    for (const [code, value] of Object.entries(profile?.byRarity ?? {})) {
      const n = num(value);
      if (n != null) byRarity[statRarityOf(code)] = n;
    }
    return {
      owned,
      doubles,
      // Le site publie les exemplaires en double : total = différents + doubles.
      copies: owned != null && doubles != null ? owned + doubles : null,
      boosters: num(profile?.boostersOpened),
      listings: Array.isArray(profile?.listings) ? profile.listings.length : num(profile?.listings),
      catalogSize: num(profile?.catalogSize),
      byRarity: Object.keys(byRarity).length ? byRarity : null,
      mythic: byRarity.M ?? null,
      legendary: byRarity.L ?? null,
      value: valued ? valued.value : null,
      valuePriced: valued ? valued.priced : 0,
      valueUnpriced: valued ? valued.unpriced : 0,
      seriesFinished: progress ? progress.finished : null,
      seriesAlmost: progress ? progress.almost : null
    };
  }

  /** Colonnes du tableau : `null` en tête = tri décroissant par défaut. */
  const STAT_COLUMNS = [
    { key: 'boosters', label: 'Boost.', title: 'Boosters ouverts', unit: '' },
    { key: 'value', label: 'Valeur', title: 'Valeur chakra des cartes', unit: '◆' },
    { key: 'rankPos', label: 'Rang', title: 'Classement global (collection)', unit: '#', asc: true },
    { key: 'owned', label: 'Cartes', title: 'Cartes différentes', unit: '' },
    { key: 'copies', label: 'Ex.', title: 'Exemplaires possédés', unit: '' },
    { key: 'seriesFinished', label: 'Séries', title: 'Séries terminées', unit: '' },
    { key: 'legendary', label: 'L', title: 'Légendaires différentes', unit: '' },
    { key: 'mythic', label: 'M', title: 'Mythiques différentes', unit: '' },
    { key: 'listings', label: 'Ann.', title: 'Annonces actives', unit: '' },
    { key: 'catalogPct', label: 'Cat.', title: 'Complétion du catalogue', unit: '%' }
  ];

  /** Valeur d'une ligne pour une colonne (les colonnes calculées vivent ici). */
  function statColumnValue(account, key) {
    if (!account) return null;
    if (key === 'catalogPct') {
      if (account.owned == null || !account.catalogSize) return null;
      return Math.round((account.owned / account.catalogSize) * 1000) / 10;
    }
    const value = account[key];
    return value == null ? null : Number(value);
  }

  /**
   * Tri des comptes. Les valeurs absentes passent toujours en dernier, dans les
   * deux sens : un compte dont la collection est illisible ne peut pas être
   * classé sur la valeur.
   */
  function statSortAccounts(accounts, key, desc = true) {
    const column = STAT_COLUMNS.find((item) => item.key === key) ?? STAT_COLUMNS[0];
    // `desc` vient de l'interface : décroissant par défaut. Les colonnes dont le
    // plus petit est le meilleur (rang) inversent ce sens naturellement.
    const ascending = column.asc ? desc : !desc;
    const rows = (Array.isArray(accounts) ? accounts : []).slice();
    rows.sort((a, b) => {
      const va = statColumnValue(a, column.key);
      const vb = statColumnValue(b, column.key);
      if (va == null && vb == null) return String(a.pseudo).localeCompare(String(b.pseudo), 'fr');
      if (va == null) return 1;
      if (vb == null) return -1;
      if (va !== vb) return ascending ? va - vb : vb - va;
      return String(a.pseudo).localeCompare(String(b.pseudo), 'fr');
    });
    return rows;
  }

  /**
   * Rang de chaque ligne pour un tri donné, ex æquo compris (1, 1, 3).
   * Le tri est refait ici avec le même comparateur : l'ordre affiché et les
   * rangs ne peuvent pas diverger. Les comptes non classables n'ont pas de rang.
   */
  function statRankRows(rows, key, desc = true) {
    const column = STAT_COLUMNS.find((item) => item.key === key) ?? STAT_COLUMNS[0];
    const ordered = statSortAccounts(rows, column.key, desc);
    const out = [];
    let previous = null;
    let rank = 0;
    ordered.forEach((row, index) => {
      const value = statColumnValue(row, column.key);
      if (value == null) {
        out.push({ id: String(row.id), rank: null });
        return;
      }
      if (previous === null || value !== previous) {
        rank = index + 1;
        previous = value;
      }
      out.push({ id: String(row.id), rank });
    });
    return out;
  }

  /* STATS:END */

  /* ------------------------------------------------------------------ */
  /* Statistiques : collecte et stockage                                 */
  /* ------------------------------------------------------------------ */

  let statPersistTimer = null;
  // Horodatage de la dernière tentative de lecture des amis (succès ou échec).
  let statFriendsAttemptAt = 0;

  function statBoardData() {
    if (!state.stats.data || typeof state.stats.data !== 'object') state.stats.data = statEmptyData();
    return state.stats.data;
  }

  function persistStatsSoon() {
    if (statPersistTimer) return;
    statPersistTimer = setTimeout(() => {
      statPersistTimer = null;
      persistStatsNow();
    }, 1200);
  }

  function persistStatsNow() {
    return storageSet(STATS_KEY, statBoardData());
  }

  /** Liste des comptes suivis, triés pour l'affichage. */
  function statRows() {
    const data = statBoardData();
    const rows = Object.values(data.accounts ?? {});
    return statSortAccounts(rows, data.sort, data.desc);
  }

  /** Catalogue minimal (id + série + rareté) pour les calculs locaux. */
  function statCatalog() {
    return [...state.characters.values()].map((card) => ({
      id: card.id,
      series: card.series ?? '',
      rarity: card.rarity ?? ''
    }));
  }

  /**
   * Rang global du compte dans le classement collection du site.
   * Le serveur répond même au-delà du top 100 ; on identifie le compte par id.
   */
  async function statSiteRank(account) {
    const pseudo = String(account?.pseudo ?? '').trim();
    if (!pseudo) return null;
    try {
      const payload = await api(`/api/leaderboard/ladder?by=collection&q=${encodeURIComponent(pseudo)}`, {
        timeout: 20000
      });
      // `found[]` est la forme documentée, mais on tolère les enveloppes voisines
      // pour ne pas perdre le rang si le site change de forme.
      const list = [payload?.found, payload?.rows, payload?.results, payload?.users].find(Array.isArray) ?? [];
      const idOf = (row) => row?.id ?? row?.userId ?? row?.user?.id ?? row?.player?.id ?? null;
      const nameOf = (row) => row?.pseudo ?? row?.name ?? row?.user?.pseudo ?? row?.player?.pseudo ?? '';
      const hit =
        list.find((row) => idOf(row) != null && String(idOf(row)) === String(account.id)) ??
        list.find((row) => String(nameOf(row)).toLowerCase() === pseudo.toLowerCase()) ??
        null;
      return toNum(
        hit?.pos ?? hit?.position ?? hit?.rankPos ?? hit?.user?.pos ?? hit?.player?.pos
      );
    } catch {
      return null;
    }
  }

  /** Relit un compte et met à jour ses métriques (le tout persiste ensuite). */
  async function statSyncAccount(account, prices, catalog) {
    const data = statBoardData();
    const entry = data.accounts[String(account.id)];
    if (!entry) return;
    try {
      const user = await api(`/api/users/${encodeURIComponent(account.id)}`, { timeout: 20000 });
      if (!user || typeof user !== 'object') throw new Error('profil vide');
      entry.pseudo = String(user.pseudo ?? user.name ?? entry.pseudo);
      entry.avatar = typeof user.avatar === 'string' ? user.avatar : entry.avatar ?? null;
      const metrics = statAccountMetrics(user, account.__ids ?? null, prices, catalog);
      Object.assign(entry, metrics);
      entry.error = null;
      entry.at = Date.now();
      if (account.__ids) entry.collectionAt = Date.now();
      return user;
    } catch (err) {
      entry.error = friendlyError(err);
      entry.at = Date.now();
      return null;
    }
  }

  /**
   * Analyse complète : profils publics, cartes possédées, rang global, puis
   * valorisation en chakra (prix officiels demandés une seule fois).
   */
  async function syncStatAccounts(force = false) {
    if (state.stats.syncing) return;
    const data = statBoardData();
    const accounts = Object.values(data.accounts ?? {});
    if (!accounts.length) {
      notify('Ajoute d’abord un compte à suivre.');
      return;
    }

    const runId = (state.stats.runId ?? 0) + 1;
    state.stats.runId = runId;
    state.stats.syncing = true;
    state.stats.error = null;
    state.stats.progress = 'Lecture des profils…';
    state.stats.done = 0;
    state.stats.total = accounts.length;
    if (state.tab === 'stat') render();

    const alive = () => state.stats.runId === runId;
    const catalog = statCatalog();

    try {
      // 1) Profils publics + cartes possédées + rang global.
      const collections = {};
      for (const account of accounts) {
        if (!alive()) return;
        const id = String(account.id);
        state.stats.progress = `Profil de ${account.pseudo}…`;
        if (state.tab === 'stat') renderStatsProgress();

        let ids = null;
        try {
          ids = await fetchOwnedIds(id);
        } catch {
          ids = null;
        }
        collections[id] = ids;
        account.__ids = ids;

        await statSyncAccount(account, null, catalog);
        // Le rang est indépendant du profil : même si /api/users échoue, le
        // classement public reste lisible et doit s'afficher.
        const rank = await statSiteRank(account);
        const entry = data.accounts[id];
        if (entry && rank != null) entry.rankPos = rank;
        state.stats.done += 1;
        if (state.tab === 'stat') renderStatsProgress();
        await sleep(STAT_REQUEST_GAP);
      }

      if (!alive()) return;

      // 2) Prix officiels : une seule passe pour l'union des cartes.
      const union = statUnionIds(Object.values(collections));
      let prices = new Map();
      if (union.size) {
        state.stats.progress = `Prix officiels… 0/${union.size}`;
        if (state.tab === 'stat') renderStatsProgress();
        prices = await fetchFairPrices([...union], (done, total) => {
          state.stats.progress = `Prix officiels… ${done}/${total}`;
          if (state.tab === 'stat') renderStatsProgress();
        });
      }

      if (!alive()) return;

      // 3) Métriques finales (valeur incluse) et index des propriétaires.
      for (const account of accounts) {
        const id = String(account.id);
        const entry = data.accounts[id];
        if (!entry || entry.error) continue;
        const ids = collections[id];
        if (!ids) continue;
        const valued = statCollectionValue(ids, prices);
        entry.value = valued.value;
        entry.valuePriced = valued.priced;
        entry.valueUnpriced = valued.unpriced;
        entry.valueAt = Date.now();
        // Doublons valorisables seulement pour le compte connecté : le site ne
        // publie pas les quantités des autres comptes.
        if (entry.self) entry.dupesValue = statsSelfDupesValue(prices);
      }

      data.owners = statOwnerCounts(collections);
      data.ownerTotal = Object.values(collections).filter((ids) => Array.isArray(ids)).length;
      data.at = Date.now();
      state.stats.ready = true;
      await persistStatsNow();
    } catch (err) {
      state.stats.error = friendlyError(err);
      persistStatsSoon();
    } finally {
      if (state.stats.runId === runId) {
        state.stats.syncing = false;
        state.stats.progress = '';
        state.stats.done = 0;
        state.stats.total = 0;
      }
      if (state.tab === 'stat') render();
    }
  }

  /** Valeur des exemplaires en double du compte connecté (collection locale). */
  function statsSelfDupesValue(prices) {
    let total = 0;
    for (const row of ownedRows()) {
      const spare = Math.max(0, row.qty - 1);
      if (!spare) continue;
      const price = Number(prices.get(String(row.id)) ?? 0);
      if (Number.isFinite(price) && price > 0) total += price * spare;
    }
    return total;
  }

  /** Rendu partiel pendant la synchro : seule la zone data est reconstruite. */
  function renderStatsProgress() {
    const body = shadow?.querySelector('[data-stat-body]');
    if (body) body.innerHTML = statBodyHTML();
  }

  async function loadStats() {
    if (state.stats.loading) return;
    state.stats.loading = true;
    try {
      const saved = await storageGet(STATS_KEY, null);
      state.stats.data = statNormalizeData(saved);
      state.stats.ready = true;
      state.stats.error = null;
    } catch (err) {
      state.stats.error = friendlyError(err);
    } finally {
      state.stats.loading = false;
      if (state.tab === 'stat') render();
    }
    const data = statBoardData();
    const stale = !data.at || Date.now() - data.at > STAT_CACHE_MS;
    if (Object.keys(data.accounts ?? {}).length && stale) syncStatAccounts(false);
  }

  /** Le compte connecté est toujours suivi (non supprimable). */
  function statEnsureSelf() {
    const user = state.user;
    if (!user?.id) return;
    const data = statBoardData();
    const id = String(user.id);
    const existing = data.accounts[id];
    const entry = existing ?? (data.accounts[id] = { id, addedAt: Date.now(), byRarity: {} });
    const pseudo = user.pseudo ?? entry.pseudo ?? 'Moi';
    const avatar = user.avatar ?? entry.avatar ?? null;
    // Évite une écriture de stockage à chaque render de l'onglet Stat.
    const changed =
      !existing ||
      entry.self !== true ||
      entry.source !== 'self' ||
      entry.pseudo !== pseudo ||
      entry.avatar !== avatar;
    entry.self = true;
    entry.source = 'self';
    entry.pseudo = pseudo;
    entry.avatar = avatar;
    if (changed) persistStatsSoon();
  }

  /**
   * Liste d'amis du compte connecté. L'endpoint du site (`/api/me/friends`)
   * renvoie un objet `{ friends: [...], incoming: [...], max }` ; on accepte
   * aussi un tableau direct et les enveloppes `users` / `items` / `found`.
   */
  async function fetchFriendList() {
    const payload = await api('/api/me/friends', { timeout: 20000 });
    const list = Array.isArray(payload)
      ? payload
      : Array.isArray(payload?.friends)
        ? payload.friends
        : Array.isArray(payload?.users)
          ? payload.users
          : Array.isArray(payload?.items)
            ? payload.items
            : Array.isArray(payload?.found)
              ? payload.found
              : [];
    const seen = new Set();
    const out = [];
    for (const raw of list) {
      const hit = normalizeFriendHit(raw);
      const id = hit.id == null ? '' : String(hit.id);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push({ id, pseudo: hit.pseudo, avatar: hit.avatar, pos: hit.pos });
    }
    return out;
  }

  /**
   * Importe la liste d'amis dans le classement. Le compte connecté et les
   * ajouts manuels restent prioritaires : aucun d'eux n'est retiré, et les
   * amis ne remplissent que les places restantes (STAT_MAX_ACCOUNTS).
   */
  async function syncFriendsIntoStats({ manual = false } = {}) {
    if (state.stats.friendsSyncing) return;
    if (!state.user?.id) {
      state.stats.friendsError = 'Connecte-toi à kyara.games pour lire ta liste d’amis.';
      if (state.tab === 'stat') render();
      return;
    }

    state.stats.friendsSyncing = true;
    state.stats.friendsError = null;
    statFriendsAttemptAt = Date.now();
    if (state.tab === 'stat') render();

    let imported = 0;
    let ignored = 0;
    try {
      const friends = await fetchFriendList();
      const data = statBoardData();
      data.friendsAt = Date.now();
      data.friendIds = friends.map((friend) => friend.id);
      let total = Object.keys(data.accounts ?? {}).length;

      for (const friend of friends) {
        // Déjà suivi (moi, ajout manuel ou ami déjà importé) : on n'y touche pas.
        if (data.accounts[friend.id]) {
          ignored += 1;
          continue;
        }
        if (total >= STAT_MAX_ACCOUNTS) {
          ignored += 1;
          continue;
        }
        data.accounts[friend.id] = {
          id: friend.id,
          pseudo: friend.pseudo ?? 'Joueur',
          avatar: friend.avatar ?? null,
          self: false,
          source: 'friend',
          addedAt: Date.now(),
          at: 0,
          rankPos: toNum(friend.pos) ?? null,
          byRarity: {}
        };
        total += 1;
        imported += 1;
      }

      state.stats.friendsReport = `${fmt(imported)} ami(s) importé(s) · ${fmt(ignored)} ignoré(s)`;
      await persistStatsNow();
      // Les nouveaux amis n'ont pas encore de métriques : on relance la lecture.
      if (imported && !state.stats.syncing) {
        await syncStatAccounts(false);
      } else if (manual) {
        notify(state.stats.friendsReport);
      }
    } catch (err) {
      state.stats.friendsError = `Liste d’amis inaccessible : ${friendlyError(err)}`;
      state.stats.friendsReport = null;
      if (manual) notify(state.stats.friendsError);
    } finally {
      state.stats.friendsSyncing = false;
      if (state.tab === 'stat') render();
    }
  }

  /** Import automatique au plus une fois par 12 h (et 10 min après un échec). */
  function maybeSyncFriends() {
    if (!state.user?.id || !state.stats.ready || state.stats.loading) return;
    if (state.stats.friendsSyncing) return;
    const data = statBoardData();
    if (data.friendsAt && Date.now() - data.friendsAt <= STAT_CACHE_MS) return;
    if (Date.now() - statFriendsAttemptAt < STAT_FRIENDS_RETRY_MS) return;
    statFriendsAttemptAt = Date.now();
    void syncFriendsIntoStats();
  }

  async function statsAddAccount(hit) {
    if (!hit?.id) return;
    const data = statBoardData();
    const id = String(hit.id);
    if (data.accounts[id]) {
      notify(`${hit.pseudo ?? 'Ce compte'} est déjà suivi.`);
      return;
    }
    if (Object.keys(data.accounts).length >= STAT_MAX_ACCOUNTS) {
      notify(`Limite de ${STAT_MAX_ACCOUNTS} comptes atteinte.`);
      return;
    }
    data.accounts[id] = {
      id,
      pseudo: hit.pseudo ?? 'Joueur',
      avatar: hit.avatar ?? null,
      self: false,
      source: 'manual',
      addedAt: Date.now(),
      at: 0,
      rankPos: toNum(hit.pos) ?? null,
      byRarity: {}
    };
    state.stats.query = '';
    state.stats.results = null;
    state.stats.searching = false;
    await persistStatsNow();
    render();
    await syncStatAccounts(true);
  }

  function statsRemoveAccount(id) {
    const data = statBoardData();
    const entry = data.accounts[String(id)];
    if (!entry) return;
    if (entry.self) {
      notify('Le compte connecté ne peut pas être retiré.');
      return;
    }
    delete data.accounts[String(id)];
    persistStatsNow();
    render();
  }

  let statSearchTimer = null;

  function scheduleStatSearch() {
    if (statSearchTimer) clearTimeout(statSearchTimer);
    statSearchTimer = setTimeout(() => {
      statSearchTimer = null;
      runStatSearch();
    }, 350);
  }

  /** Recherche de compte : même endpoint que l'onglet Compte. */
  async function runStatSearch() {
    const query = String(state.stats.query ?? '').trim();
    if (query.length < 2) {
      state.stats.results = null;
      state.stats.searchError = null;
      if (state.tab === 'stat') render();
      return;
    }
    state.stats.searching = true;
    state.stats.searchError = null;
    if (state.tab === 'stat') render();
    try {
      const results = await searchFriendsByPseudo(query);
      state.stats.results = results.slice(0, 8);
      if (!state.stats.results.length) state.stats.searchError = `Aucun joueur nommé « ${query} ».`;
    } catch (err) {
      state.stats.results = null;
      state.stats.searchError = friendlyError(err);
    } finally {
      state.stats.searching = false;
      if (state.tab === 'stat') render();
    }
  }

  /** Propriétaires connus d'une carte, parmi les comptes suivis. */
  function statsOwnerStats(cardId) {
    if (!state.stats.ready) return null;
    const data = statBoardData();
    const total = Number(data.ownerTotal) || 0;
    if (!total) return null;
    return { count: Number(data.owners?.[String(cardId)]) || 0, total };
  }

  /** Pastille « N poss. » : relative aux comptes suivis, jamais au site entier. */
  function ownerPill(cardId, compact = true) {
    const info = statsOwnerStats(cardId);
    if (!info) return '';
    const label = compact ? `${fmt(info.count)} poss.` : `${fmt(info.count)} propriétaire${info.count > 1 ? 's' : ''}`;
    const title =
      info.count > 0
        ? `${fmt(info.count)} des ${fmt(info.total)} comptes suivis possèdent cette carte`
        : `Aucun des ${fmt(info.total)} comptes suivis ne possède cette carte`;
    return `<span class="kp-owner-pill ${info.count ? '' : 'is-none'}" title="${esc(title)}">${label}</span>`;
  }

  /* ------------------------------------------------------------------ */
  /* Statistiques : rendu                                                */
  /* ------------------------------------------------------------------ */

  function statDate(ts) {
    if (!(Number(ts) > 0)) return 'jamais';
    try {
      return new Date(Number(ts)).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: '2-digit' });
    } catch {
      return '—';
    }
  }

  function statCell(account, column) {
    const value = statColumnValue(account, column.key);
    if (value == null) return '<span class="kp-stat-na">—</span>';
    if (column.key === 'rankPos') return `#${fmt(value)}`;
    if (column.key === 'catalogPct') return `${value.toLocaleString('fr-FR')} %`;
    if (column.key === 'value') return `◆ ${fmt(value)}`;
    return fmt(value);
  }

  function statSearchBlock() {
    const results = state.stats.results;
    const data = statBoardData();
    return `
      <div class="kp-stat-search">
        <input class="kp-input" type="search" data-role="stat-account-search" placeholder="Ajouter un compte par pseudo…"
          value="${esc(state.stats.query ?? '')}" autocomplete="off" spellcheck="false">
        <button class="kp-btn is-primary" type="button" data-act="stat-search" ${
          state.stats.searching ? 'disabled' : ''
        }>${state.stats.searching ? '…' : 'Chercher'}</button>
      </div>
      ${state.stats.searchError ? `<div class="kp-hint is-bad">${esc(state.stats.searchError)}</div>` : ''}
      ${
        Array.isArray(results) && results.length
          ? `<div class="kp-stat-results">${results
              .map((hit) => {
                const followed = Boolean(data.accounts[String(hit.id)]);
                return `
                <div class="kp-stat-result">
                  <img src="${esc(hit.avatar || '/brand/favicon/icon-192.png')}" alt="" loading="lazy">
                  <div>
                    <b>${esc(hit.pseudo)}</b>
                    <small>${hit.owned != null ? `${fmt(hit.owned)} carte(s)` : 'collection inconnue'}${
                      hit.pos != null ? ` · rang #${fmt(hit.pos)}` : ''
                    }</small>
                  </div>
                  <button class="kp-btn" type="button" data-act="stat-add" data-id="${esc(hit.id)}" ${
                    followed ? 'disabled' : ''
                  }>${followed ? 'Suivi' : 'Ajouter'}</button>
                </div>`;
              })
              .join('')}</div>`
          : ''
      }`;
  }

  // 50 teintes maximum, réparties par angle d'or pour rester distinctes même
  // quand la liste de comptes suivis est pleine (20 comptes aujourd'hui).
  const STAT_PIE_COLORS = Array.from({ length: 50 }, (_, index) => {
    const hue = Math.round((index * 137.508) % 360);
    return `hsl(${hue}, 78%, ${index % 2 ? 62 : 56}%)`;
  });

  /** Valeur lisible d'une part de camembert. */
  function statPieMetric(column, value) {
    if (value == null) return '—';
    if (column.key === 'value') return `◆ ${fmt(value)}`;
    if (column.key === 'catalogPct') return `${Number(value).toLocaleString('fr-FR')} %`;
    if (column.key === 'rankPos') return `#${fmt(value)}`;
    return fmt(value);
  }

  /**
   * Le rang et la complétion ne s'additionnent pas : on les montre par tranches.
   * Les autres critères sont additifs et peuvent être lus comme une part du total.
   */
  function statPieBuckets(key, rows) {
    const defs =
      key === 'rankPos'
        ? [
            ['Top 100', (value) => value != null && value <= 100],
            ['101 – 1 000', (value) => value != null && value > 100 && value <= 1000],
            ['1 001 – 10 000', (value) => value != null && value > 1000 && value <= 10000],
            ['> 10 000', (value) => value != null && value > 10000],
            ['Non classé', (value) => value == null]
          ]
        : key === 'catalogPct'
          ? [
              ['≥ 80 %', (value) => value != null && value >= 80],
              ['50 – 79 %', (value) => value != null && value >= 50 && value < 80],
              ['20 – 49 %', (value) => value != null && value >= 20 && value < 50],
              ['< 20 %', (value) => value != null && value < 20],
              ['Non calculable', (value) => value == null]
            ]
          : null;
    if (!defs) return null;

    const total = rows.length;
    const values = rows.map((row) => statColumnValue(row, key));
    return defs
      .map(([label, test], index) => {
        const count = values.filter(test).length;
        return {
          label,
          value: count,
          display: `${fmt(count)} compte${count > 1 ? 's' : ''}`,
          pct: total ? (count / total) * 100 : 0,
          color: STAT_PIE_COLORS[index % STAT_PIE_COLORS.length]
        };
      })
      .filter((slice) => slice.value > 0);
  }

  function statPieSlices(rows, key) {
    const column = STAT_COLUMNS.find((item) => item.key === key) ?? STAT_COLUMNS[0];
    const buckets = statPieBuckets(column.key, rows);
    if (buckets) {
      return {
        column,
        slices: buckets,
        mode: 'buckets',
        note: 'Chaque compte suivi est compté dans une seule tranche.',
        empty: false
      };
    }

    // Tous les comptes suivis sont affichés, même ceux à 0 ou sans donnée :
    // ils restent dans la légende avec 0 %. Aucun regroupement « Autres ».
    const entries = rows
      .map((row) => ({ row, value: statColumnValue(row, column.key) }))
      .sort((a, b) => (b.value ?? -1) - (a.value ?? -1));
    const total = entries.reduce((sum, entry) => sum + (entry.value > 0 ? entry.value : 0), 0);
    const slices = entries.map((entry, index) => ({
      label: entry.row.pseudo,
      value: entry.value ?? 0,
      display: entry.value == null ? '—' : statPieMetric(column, entry.value),
      pct: total && entry.value > 0 ? (entry.value / total) * 100 : 0,
      color: STAT_PIE_COLORS[index % STAT_PIE_COLORS.length]
    }));

    return {
      column,
      slices,
      mode: 'accounts',
      total,
      note: total
        ? 'Tous les comptes suivis sont listés ; les parts à 0 % restent visibles dans la légende.'
        : 'Aucune valeur positive pour ce critère : les comptes restent listés ci-dessous.',
      empty: !total
    };
  }

  function statPieHTML(rows, key) {
    const data = statPieSlices(rows, key);
    if (!data.slices.length) {
      return `<aside class="kp-stat-chart">
        <div class="kp-stat-chart-head"><b>${esc(data.column.title)}</b><small>sur ${fmt(rows.length)} compte(s)</small></div>
        <div class="kp-stat-chart-empty">Aucune valeur disponible pour ce critère.</div>
      </aside>`;
    }

    const noValue = data.mode === 'accounts' && data.empty;
    let cursor = 0;
    const stops = noValue
      ? ['#2d303a 0% 100%']
      : data.slices.map((slice, index) => {
          const start = cursor;
          cursor += slice.pct;
          // Une part à 0 % ne doit pas produire un cheveu de couleur.
          const end = slice.pct <= 0 ? start : index === data.slices.length - 1 ? 100 : cursor;
          return `${slice.color} ${start.toFixed(2)}% ${end.toFixed(2)}%`;
        });

    return `<aside class="kp-stat-chart">
      <div class="kp-stat-chart-head">
        <b>${esc(data.column.title)}</b>
        <small>${data.mode === 'buckets' ? 'Répartition' : 'Tous les comptes'} · ${fmt(rows.length)} suivi(s)</small>
      </div>
      <div class="kp-stat-pie-wrap ${noValue ? 'is-empty' : ''}">
        <div class="kp-stat-pie" style="background:conic-gradient(${stops.join(
          ','
        )})" role="img" aria-label="${esc(`Répartition de ${data.column.title}`)}"></div>
      </div>
      <div class="kp-stat-legend">
        ${data.slices
          .map(
            (slice) => `<div class="kp-stat-legend-row" title="${esc(
              `${slice.label} · ${slice.display} · ${slice.pct.toFixed(1).replace('.', ',')} %`
            )}">
              <i style="--c:${slice.color}"></i>
              <span>${esc(slice.label)}</span>
              <b>${esc(slice.display)}</b>
              <small>${slice.pct.toFixed(1).replace('.', ',')} %</small>
            </div>`
          )
          .join('')}
      </div>
      <div class="kp-stat-chart-note">${esc(data.note)}</div>
    </aside>`;
  }

  function statTable() {
    const data = statBoardData();
    const rows = statRows();
    const column = STAT_COLUMNS.find((item) => item.key === data.sort) ?? STAT_COLUMNS[0];
    if (!rows.length) {
      return `<div class="kp-empty"><b>Aucun compte suivi</b>Ajoute un compte avec la recherche ci-dessus pour commencer le classement.</div>`;
    }

    const ranks = new Map(statRankRows(rows, column.key, data.desc).map((row) => [row.id, row.rank]));
    const descending = column.asc ? !data.desc : data.desc;
    const head = `<th class="is-active">
      <button type="button" data-act="stat-sort" data-key="${column.key}" title="${esc(column.title)}">
        ${column.label}<i>${descending ? '▾' : '▴'}</i>
      </button>
    </th>`;

    const body = rows
      .map((row) => {
        const rank = ranks.get(String(row.id));
        const expanded = state.stats.expanded === String(row.id);
        const siteRank = toNum(row.rankPos);
        const siteBadge =
          siteRank != null && column.key !== 'rankPos'
            ? `<small class="kp-stat-site">site #${fmt(siteRank)}</small>`
            : '';
        return `
          <tr class="kp-stat-tr ${expanded ? 'is-expanded' : ''}" data-act="stat-expand" data-id="${esc(row.id)}"${
            row.error ? ' title="' + esc(row.error) + '"' : ''
          }>
            <td class="kp-stat-idx">${rank == null ? '·' : `#${rank}`}</td>
            <td class="kp-stat-who">
              <img src="${esc(row.avatar || '/brand/favicon/icon-192.png')}" alt="" loading="lazy">
              <span>${esc(row.pseudo)}${row.self ? '<em>moi</em>' : row.source === 'friend' ? '<em class="is-friend">ami</em>' : ''}${siteBadge}</span>
            </td>
            <td class="is-active">${statCell(row, column)}</td>
          </tr>
          ${
            expanded
              ? `<tr class="kp-stat-detail"><td colspan="3">${statDetail(row)}</td></tr>`
              : ''
          }`;
      })
      .join('');

    return `
      <div class="kp-stat-scroll">
        <table class="kp-stat-table">
          <thead><tr><th class="kp-stat-idx" title="Rang dans le critère choisi">#</th><th class="kp-stat-who">Compte</th>${head}</tr></thead>
          <tbody>${body}</tbody>
        </table>
      </div>`;
  }

  /** Petite moyenne : une décimale quand elle vaut moins de 10 chakras. */
  function statAvg(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return '—';
    if (n > 0 && n < 10) return n.toFixed(1).replace('.', ',');
    return fmt(Math.round(n));
  }

  /** Détail d'un compte : métriques non affichées dans le tableau. */
  function statDetail(row) {
    const pairs = [
      [
        'Origine',
        row.self ? 'compte connecté' : row.source === 'friend' ? 'liste d’amis' : 'ajout manuel',
        false
      ],
      ['Rang global (site)', row.rankPos == null ? '—' : `#${fmt(row.rankPos)}`, row.rankPos == null],
      ['Valeur des doublons', row.dupesValue == null ? 'non publié' : `◆ ${fmt(row.dupesValue)}`, row.dupesValue == null],
      [
        'Valeur moyenne par carte',
        row.value != null && row.owned ? `◆ ${statAvg(row.value / row.owned)}` : '—',
        row.value == null
      ],
      ['Séries presque finies (≤ 3)', row.seriesAlmost == null ? '—' : fmt(row.seriesAlmost), row.seriesAlmost == null],
      [
        'Complétion du catalogue',
        row.owned != null && row.catalogSize ? `${Math.round((row.owned / row.catalogSize) * 100)} %` : '—',
        !row.catalogSize
      ],
      [
        'Cartes valorisées',
        row.value == null ? '—' : `${fmt(row.valuePriced)}${row.valueUnpriced ? ` · ${fmt(row.valueUnpriced)} sans prix` : ''}`,
        row.value == null
      ],
      ['Valeur mesurée le', row.valueAt ? statDate(row.valueAt) : '—', !row.valueAt]
    ];
    return `
      <div class="kp-stat-detail-grid">
        ${pairs
          .map(
            ([label, value, muted]) =>
              `<div class="${muted ? 'is-muted' : ''}"><span>${esc(label)}</span><b>${esc(value)}</b></div>`
          )
          .join('')}
        <div class="kp-stat-detail-actions">
          <button class="kp-btn" type="button" data-act="stat-resync" data-id="${esc(row.id)}">Relire ce compte</button>
          ${
            row.self
              ? ''
              : `<button class="kp-btn is-ghost" type="button" data-act="stat-remove" data-id="${esc(row.id)}">Retirer</button>`
          }
        </div>
        ${row.error ? `<div class="kp-hint is-bad">${esc(row.error)}</div>` : ''}
        ${row.valueUnpriced ? `<div class="kp-hint">${fmt(row.valueUnpriced)} carte(s) sans prix officiel : elles ne sont pas comptées dans la valeur.</div>` : ''}
      </div>`;
  }

  function statBodyHTML() {
    const data = statBoardData();
    const rows = Object.values(data.accounts ?? {});
    const column = STAT_COLUMNS.find((item) => item.key === data.sort) ?? STAT_COLUMNS[0];
    const failed = rows.filter((row) => row.error);
    const valued = rows.filter((row) => row.value != null);
    const totalValue = valued.reduce((sum, row) => sum + (row.value ?? 0), 0);
    const totalCards = rows.reduce((sum, row) => sum + (row.owned ?? 0), 0);
    const progress = state.stats.total
      ? ` ${fmt(state.stats.done)}/${fmt(state.stats.total)}`
      : '';

    return `
      <div class="kp-grid">
        <div class="kp-card-stat"><span>Comptes</span><b>${fmt(rows.length)}</b><small>${fmt(
          data.ownerTotal
        )} collection(s) lue(s)</small></div>
        <div class="kp-card-stat"><span>Valeur cumulée</span><b>◆ ${fmt(totalValue)}</b><small>${fmt(
          valued.length
        )} compte(s) valorisé(s)</small></div>
        <div class="kp-card-stat"><span>Cartes différentes</span><b>${fmt(totalCards)}</b><small>somme des comptes</small></div>
      </div>
      ${
        state.stats.syncing
          ? `<div class="kp-hint" data-stat-progress>${esc(state.stats.progress ?? 'Synchro…')}${progress}</div>`
          : `<div class="kp-hint" data-stat-progress>${
              data.at ? `Mesure du ${statDate(data.at)} · clique un compte pour le détail` : 'Aucune mesure'
            }</div>`
      }
      ${state.stats.syncing ? '<div class="kp-progress"><div class="kp-progress-bar"><i style="width:' + (state.stats.total ? Math.round((state.stats.done / state.stats.total) * 100) : 0) + '%"></i></div></div>' : ''}
      ${
        rows.length
          ? `<div class="kp-stat-controls">
               <label class="kp-stat-pick">
                 <span>Critère comparé</span>
                 <select class="kp-select" data-stat-metric>
                   ${STAT_COLUMNS.map(
                     (item) =>
                       `<option value="${item.key}" ${item.key === column.key ? 'selected' : ''}>${esc(item.title)}</option>`
                   ).join('')}
                 </select>
               </label>
               <button class="kp-btn" type="button" data-act="stat-sort-dir" title="Inverser le sens du classement">
                 Sens : ${(column.asc ? !data.desc : data.desc) ? '↓' : '↑'}
               </button>
             </div>
             <div class="kp-stat-layout">
               <div class="kp-stat-table-col">${statTable()}</div>
               ${statPieHTML(rows, column.key)}
             </div>`
          : statTable()
      }
      ${
        failed.length
          ? `<div class="kp-hint is-bad">${fmt(failed.length)} compte(s) en erreur : ${esc(
              failed.map((row) => row.pseudo).join(', ')
            )}</div>`
          : ''
      }
    `;
  }

  function viewStat() {
    if (state.stats.loading) {
      return '<div class="kp-empty"><span class="kp-spinner"></span> Chargement…</div>';
    }
    if (!state.stats.ready) {
      loadStats();
      // On ne touche pas aux données tant que le stockage n'a pas répondu :
      // sinon le compte « moi » est ajouté puis écrasé par la lecture.
      if (state.stats.loading) {
        return '<div class="kp-empty"><span class="kp-spinner"></span> Chargement…</div>';
      }
    }
    statEnsureSelf();

    // Un compte jamais lu (ou fraîchement ajouté) est mesuré dès l'ouverture.
    const pending = Object.values(statBoardData().accounts ?? {}).some((row) => !row.at);
    if (pending && !state.stats.syncing && !state.stats.loading) syncStatAccounts(false);

    // Liste d'amis jamais lue (ou vieille de plus de 12 h) : import en fond.
    maybeSyncFriends();

    const data = statBoardData();
    const friendNote = state.stats.friendsReport
      ? `${state.stats.friendsReport}${data.friendsAt ? ` · amis lus le ${statDate(data.friendsAt)}` : ''}`
      : data.friendsAt
        ? `Amis lus le ${statDate(data.friendsAt)}`
        : '';

    return `
      <div class="kp-stat-head">
        <div>
          <b>Classement</b>
          <small>${fmt(Object.keys(data.accounts ?? {}).length)} compte(s) suivi(s)</small>
        </div>
        <div class="kp-stat-head-actions">
          <button class="kp-btn" type="button" data-act="stat-friends" ${
            state.stats.friendsSyncing ? 'disabled' : ''
          }>${state.stats.friendsSyncing ? 'Import…' : 'Importer mes amis'}</button>
          <button class="kp-btn" type="button" data-act="stat-refresh" ${state.stats.syncing ? 'disabled' : ''}>${
            state.stats.syncing ? 'Synchro…' : 'Actualiser'
          }</button>
        </div>
      </div>
      ${state.stats.friendsError ? `<div class="kp-hint is-bad">${esc(state.stats.friendsError)}</div>` : ''}
      ${friendNote ? `<div class="kp-hint" data-stat-friends-note>${esc(friendNote)}</div>` : ''}
      ${statSearchBlock()}
      ${state.stats.error ? `<div class="kp-alert is-bad">${esc(state.stats.error)}</div>` : ''}
      <div data-stat-body>${statBodyHTML()}</div>
    `;
  }

  /* ------------------------------------------------------------------ */
  /* Onglet Vente : rendu                                                */
  /* ------------------------------------------------------------------ */

  function pctLabel(value) {
    if (value == null || !Number.isFinite(value)) return null;
    const rounded = Math.round(value * 10) / 10;
    return `${rounded >= 0 ? '+' : ''}${String(rounded).replace('.', ',')} %`;
  }

  function deltaChip(value) {
    if (value == null || !Number.isFinite(value)) return '';
    const dir = value > 0.5 ? 'is-up' : value < -0.5 ? 'is-down' : 'is-flat';
    return `<span class="kp-delta ${dir}">${pctLabel(value)}</span>`;
  }

  /** Mini-courbe SVG, sans dépendance : utilisée dans les listes. */
  function sparkline(values, { width = 62, height = 20, color = '#60a5fa' } = {}) {
    const clean = (values ?? []).map(Number).filter((v) => Number.isFinite(v));
    if (clean.length < 2) return '<span class="kp-spark-empty">—</span>';
    const min = Math.min(...clean);
    const max = Math.max(...clean);
    const span = max - min || 1;
    const step = width / (clean.length - 1);
    const points = clean
      .map((value, i) => `${(i * step).toFixed(1)},${(height - 2 - ((value - min) / span) * (height - 4)).toFixed(1)}`)
      .join(' ');
    return `<svg class="kp-spark" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" aria-hidden="true">
      <polyline points="${points}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"></polyline>
    </svg>`;
  }

  /** Graphique d'évolution plus lisible pour la fiche. */
  function priceChart(analysis) {
    const series = analysis?.series ?? [];
    if (series.length < 2) {
      return `<div class="kp-chart-empty">Historique journalier indisponible pour cette carte (l'API n'a pas encore assez de ventes).</div>`;
    }
    const w = 420;
    const h = 128;
    const padL = 6;
    const padR = 6;
    const padT = 10;
    const padB = 16;
    const innerW = w - padL - padR;
    const innerH = h - padT - padB;
    const values = series.map((point) => point.median);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = max - min || 1;
    const step = innerW / (series.length - 1);
    const coords = values.map((value, i) => [
      padL + i * step,
      padT + innerH - ((value - min) / span) * innerH
    ]);
    const line = coords.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
    const area = `${line} L${coords[coords.length - 1][0].toFixed(1)} ${padT + innerH} L${padL} ${padT + innerH} Z`;
    const rising = values[values.length - 1] >= values[0];
    const color = rising ? '#4ade80' : '#ff6b6b';
    const gradientId = `kpGrad${Math.random().toString(36).slice(2, 8)}`;
    const first = series[0];
    const lastPoint = series[series.length - 1];

    return `<svg class="kp-chart" viewBox="0 0 ${w} ${h}" role="img" aria-label="Évolution du prix médian">
      <defs>
        <linearGradient id="${gradientId}" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="${color}" stop-opacity="0.34"></stop>
          <stop offset="100%" stop-color="${color}" stop-opacity="0"></stop>
        </linearGradient>
      </defs>
      <line x1="${padL}" y1="${padT + innerH}" x2="${w - padR}" y2="${padT + innerH}" stroke="rgba(255,255,255,0.10)"></line>
      <line x1="${padL}" y1="${padT}" x2="${w - padR}" y2="${padT}" stroke="rgba(255,255,255,0.06)"></line>
      <path d="${area}" fill="url(#${gradientId})"></path>
      <path d="${line}" fill="none" stroke="${color}" stroke-width="1.9" stroke-linejoin="round" stroke-linecap="round"></path>
      <circle cx="${coords[coords.length - 1][0].toFixed(1)}" cy="${coords[coords.length - 1][1].toFixed(1)}" r="3" fill="${color}"></circle>
      <text x="${padL}" y="${h - 3}" class="kp-chart-label">${esc(first.day.slice(5))} · ◆ ${fmt(first.median)}</text>
      <text x="${w - padR}" y="${h - 3}" text-anchor="end" class="kp-chart-label">${esc(lastPoint.day.slice(5))} · ◆ ${fmt(lastPoint.median)}</text>
    </svg>`;
  }

  function sellModeSwitch() {
    const view = state.sellView;
    const owned = state.collection.length;
    const dupes = state.collection.filter((item) => Number(item.qty ?? item.quantity ?? 1) > 1).length;
    return `
      <div class="kp-seg kp-seg-lg" role="tablist" aria-label="Vente">
        <button class="kp-seg-btn ${view.mode === 'mine' ? 'is-active' : ''}" type="button" role="tab" aria-selected="${view.mode === 'mine'}" data-act="sell-mode" data-mode="mine">
          Mes cartes <small>${fmt(owned)}</small>
        </button>
        <button class="kp-seg-btn ${view.mode === 'auto' ? 'is-active' : ''}" type="button" role="tab" aria-selected="${view.mode === 'auto'}" data-act="sell-mode" data-mode="auto">
          Vente auto <small>${fmt(dupes)} doublon(s)</small>
        </button>
      </div>`;
  }

  function sellRarityChips(counts, withCounts = true) {
    const view = state.sellView;
    const total = withCounts ? counts?.all ?? 0 : null;
    return `<div class="kp-rarities ${view.rarity !== 'all' ? 'is-focus' : ''}">
      <button class="kp-rchip ${view.rarity === 'all' ? 'is-active' : ''}" type="button" data-act="sell-rarity" data-rarity="all">Toutes ${total != null ? `<em>${fmt(total)}</em>` : ''}</button>
      ${RARITY_ORDER.map((code) => {
        const info = rarityInfo(code);
        // En mode marché, les compteurs ne concernent que la page affichée : on les masque.
        const count = withCounts ? counts?.[code] ?? 0 : null;
        return `<button class="kp-rchip ${view.rarity === code ? 'is-active' : ''}" type="button" data-act="sell-rarity" data-rarity="${code}" style="--rc:${info.color}" ${count === 0 ? 'disabled' : ''}>
          ${esc(info.label)} ${count != null ? `<em>${fmt(count)}</em>` : ''}
        </button>`;
      }).join('')}
    </div>`;
  }

  function sellToolbar() {
    const view = state.sellView;
    return `
      <div class="kp-toolbar kp-toolbar-search">
        <input class="kp-input" type="search" data-role="sell-search" autocomplete="off"
          placeholder="Filtrer ma collection…" value="${esc(view.query)}">
        <button class="kp-btn ${view.refreshing ? '' : 'is-primary'}" type="button" data-act="sell-refresh" ${view.refreshing ? 'disabled' : ''}>
          ${view.refreshing ? '<span class="kp-spinner"></span> Actualisation…' : 'Actualiser les prix'}
        </button>
      </div>`;
  }

  function sellFilters(seriesOptions) {
    const view = state.sellView;
    return `
      <div class="kp-filters">
        <label class="kp-filter">
          <span>Trier</span>
          <select class="kp-select" data-sell-sort>
            ${SELL_SORTS.map(
              ([value, label]) => `<option value="${value}" ${view.sort === value ? 'selected' : ''}>${label}</option>`
            ).join('')}
          </select>
        </label>
        <label class="kp-filter">
          <span>Série</span>
          <select class="kp-select" data-sell-series>
            <option value="all">Toutes</option>
            ${seriesOptions
              .map(
                (name) => `<option value="${esc(name)}" ${view.series === name ? 'selected' : ''}>${esc(name)}</option>`
              )
              .join('')}
          </select>
        </label>
      </div>
      <div class="kp-sell-toggles">
        <label class="kp-check">
          <input type="checkbox" data-sell-only-sellable ${view.onlySellable ? 'checked' : ''}>
          <span>Seulement les cartes vendables</span>
        </label>
        <label class="kp-check">
          <input type="checkbox" data-sell-only-dupes ${view.onlyDupes ? 'checked' : ''}>
          <span>Doublons <small>plus d'un exemplaire</small></span>
        </label>
      </div>`;
  }

  /** Durée lisible pour un verrou de revente. */
  function fmtLockDelay(ms) {
    const total = Math.max(0, Number(ms) || 0);
    const hours = Math.floor(total / 3600000);
    const minutes = Math.round((total % 3600000) / 60000);
    if (hours >= 24) {
      const days = Math.floor(hours / 24);
      const rest = hours % 24;
      return `${days} j${rest ? ` ${rest} h` : ''}`;
    }
    if (hours >= 1) return `${hours} h${minutes ? ` ${minutes} min` : ''}`;
    return `${Math.max(1, minutes)} min`;
  }

  /** Badge + explication d'une carte non vendable (grisée mais lisible). */
  function lockBadge(row) {
    const block = row.block;
    if (!block) return '';
    const until = block.until && block.until > Date.now() ? ` · encore ${fmtLockDelay(block.until - Date.now())}` : '';
    return `<span class="kp-lock-badge" title="${esc(block.reason)}" data-lock-reason="${esc(block.reason)}"${
      block.until ? ` data-lock-until="${Number(block.until)}"` : ''
    }><span class="kp-lock-ico">🔒</span><span class="kp-lock-text">${esc(block.reason)}${esc(until)}</span></span>`;
  }

  /**
   * Met à jour les décomptes de verrou sans reconstruire le panneau.
   * Quand un verrou expire, on relit la collection (throttlé) pour que le serveur
   * confirme que la carte est de nouveau vendable.
   */
  let lockReloadAt = 0;
  function updateLockBadges() {
    const nodes = shadow ? shadow.querySelectorAll('.kp-lock-badge[data-lock-until]') : [];    let expired = false;
    for (const node of nodes) {
      const until = Number(node.getAttribute('data-lock-until'));
      const reason = node.getAttribute('data-lock-reason') || '';
      if (!Number.isFinite(until)) continue;
      const left = until - Date.now();
      if (left <= 0) {
        expired = true;
        continue;
      }
      const text = node.querySelector('.kp-lock-text');
      if (text) text.textContent = `${reason} · encore ${fmtLockDelay(left)}`;
    }
    if (expired && Date.now() - lockReloadAt > 60000) {
      lockReloadAt = Date.now();
      loadData({ keepPrices: true });
    }
  }

  function sellOwnedRow(row) {
    const locked = Boolean(row.block);
    const view = state.sellView;
    const checked = state.selected.has(row.id) && !locked;
    const info = rarityInfo(row.rarity);
    const price = state.prices[row.id];
    const days = Array.isArray(price?.days) ? price.days.map((point) => toNum(point?.median)).filter((v) => v != null) : [];
    const change = changePctOf(row.id);
    const lowest = state.lowest[row.id];
    const bid = state.buyOrders[row.id];
    const slotsLeft = listingSlots().remaining;
    const blocked = !locked && !checked && selectedCopies() + 1 > slotsLeft;
    const isDupe = row.qty > 1;

    return `
      <div class="kp-sell-row ${checked ? 'is-selected' : ''} ${blocked ? 'is-disabled' : ''} ${
        locked ? 'is-locked' : ''
      } ${isDupe && !locked ? 'is-dupe' : ''}"
           data-act="sell-detail" data-id="${esc(row.id)}" title="${
             locked ? esc(row.block.reason) : `Ouvrir la fiche de ${esc(row.name)}`
           }">
        <input type="checkbox" data-sel="${esc(row.id)}" ${checked ? 'checked' : ''} ${
          blocked || locked ? 'disabled' : ''
        } aria-label="Sélectionner ${esc(row.name)}" ${locked ? 'title="Carte non vendable"' : ''}>
        <div class="kp-sell-thumb">
          <img src="${esc(row.image)}" alt="" loading="lazy">
          ${isDupe ? `<span class="kp-dupe-count" title="${fmt(row.qty)} exemplaires">×${fmt(row.qty)}</span>` : ''}
        </div>
        <div class="kp-sell-main">
          <div class="kp-row-name">
            ${esc(row.name)}
            ${isDupe ? '<span class="kp-dupe-tag">doublon</span>' : ''}
          </div>
          <div class="kp-row-meta">
            <span class="kp-rar" style="--rc:${info.color}">${esc(info.label)}</span>
            ${fmt(row.qty)} exemplaire${row.qty > 1 ? 's' : ''}${
              row.sellable > 0
                ? ` · ${fmt(row.sellable)} vendable${row.sellable > 1 ? 's' : ''}`
                : ` · ${fmt(row.qty)} bloquée${row.qty > 1 ? 's' : ''}`
            }
            ${price?.sales7d != null ? ` · ${fmt(price.sales7d)} vente(s)/7j` : ''}
            ${ownerPill(row.id)}
          </div>
          ${lockBadge(row)}
        </div>
        <div class="kp-sell-trend">
          ${sparkline(days, { color: (change ?? 0) >= 0 ? '#4ade80' : '#ff6b6b' })}
          ${deltaChip(change)}
        </div>
        <div class="kp-sell-price">
          <b>${row.price != null ? `◆ ${fmt(row.price)}` : '—'}</b>
          <small>${bid ? `ordre ◆ ${fmt(bid.price)}` : lowest != null ? `min ◆ ${fmt(lowest)}` : 'pas d’annonce'}</small>
        </div>
      </div>`;
  }

  /**
   * Prix d'entrée d'une annonce : le prix fixe pour une vente directe, la mise
   * courante (ou la prochaine mise) pour une enchère. L'achat immédiat d'une
   * enchère est un prix distinct, affiché à part.
   */
  function marketItemPrice(item) {
    return marketItemIsAuction(item)
      ? toNum(item?.minNextBid) ?? toNum(item?.price) ?? toNum(item?.buyoutPrice)
      : toNum(item?.price) ?? toNum(item?.buyoutPrice);
  }

  function marketItemIsAuction(item) {
    return String(item?.type) === 'auction';
  }

  /**
   * Regroupe les annonces par carte : une carte = une ligne. Le serveur renvoie
   * plusieurs ventes pour la même carte ; on garde la moins chère en prix fixe et
   * la moins chère en enchère, le reste allant dans le dépliant.
   */
  function groupMarketItems(items, sort = 'price_desc') {
    const groups = new Map();
    for (const item of items) {
      const id = String(item?.characterId ?? item?.character?.id ?? '');
      if (!id) continue;
      let group = groups.get(id);
      if (!group) {
        group = {
          id,
          card: item?.character ?? state.characters.get(id) ?? null,
          items: [],
          order: groups.size,
          bestFixed: null,
          bestAuction: null,
          best: null
        };
        groups.set(id, group);
      }
      group.items.push(item);

      const price = marketItemPrice(item);
      if (price == null || price <= 0) continue;
      const entry = { price, item };
      if (marketItemIsAuction(item)) {
        if (!group.bestAuction || price < group.bestAuction.price) group.bestAuction = entry;
      } else if (!group.bestFixed || price < group.bestFixed.price) {
        group.bestFixed = entry;
      }
    }

    for (const group of groups.values()) {
      const candidates = [group.bestFixed, group.bestAuction].filter(Boolean);
      group.best = candidates.sort((a, b) => a.price - b.price)[0] ?? null;
      group.items.sort((a, b) => (marketItemPrice(a) ?? Infinity) - (marketItemPrice(b) ?? Infinity));
    }

    const list = [...groups.values()];
    if (sort === 'newest' || sort === 'ending') {
      // Le serveur a déjà renvoyé les annonces dans l'ordre demandé : on conserve
      // l'ordre d'apparition des cartes au lieu de retrier par prix.
      return list.sort((a, b) => a.order - b.order);
    }
    const asc = sort === 'price_asc' || sort === 'change_asc';
    // Le tri du serveur est conservé à l'intérieur de chaque groupe ; entre cartes,
    // on ordonne sur la meilleure offre de façon cohérente avec le tri demandé.
    list.sort((a, b) => {
      const pa = a.best?.price ?? marketPriceOf(a.items[0]) ?? -1;
      const pb = b.best?.price ?? marketPriceOf(b.items[0]) ?? -1;
      return asc ? pa - pb || a.order - b.order : pb - pa || a.order - b.order;
    });
    return list;
  }

  /** Délai lisible avant la fin d'une annonce (enchères surtout). */
  function listingTimeLeft(item) {
    const raw = item?.endsAt ?? item?.expiresAt ?? null;
    if (!raw) return '';
    const end = Date.parse(raw);
    if (!Number.isFinite(end)) return '';
    const ms = end - Date.now();
    if (ms <= 0) return 'terminée';
    const totalMin = Math.round(ms / 60000);
    const hours = Math.floor(totalMin / 60);
    const minutes = totalMin % 60;
    if (hours >= 24) return `${Math.floor(hours / 24)} j ${hours % 24} h`;
    return hours > 0 ? `${hours} h ${String(minutes).padStart(2, '0')} min` : `${minutes} min`;
  }

  /** Une annonce isolée, affichée dans le dépliant d'une carte. */
  function sellMarketListing(item) {
    const isAuction = marketItemIsAuction(item);
    const price = marketItemPrice(item);
    const buyout = toNum(item?.buyoutPrice);
    const bid = toNum(item?.currentBid ?? item?.bid);
    const seller = item?.seller?.pseudo ?? item?.seller?.name ?? '';
    const left = listingTimeLeft(item);
    return `
      <div class="kp-mkt-listing ${isAuction ? 'is-auction' : 'is-fixed'}">
        <span class="kp-mkt-type">${isAuction ? 'Enchère' : 'Prix fixe'}</span>
        <b>◆ ${fmt(price)}</b>
        <span class="kp-mkt-seller">${seller ? esc(seller) : '—'}</span>
        <span class="kp-mkt-ends">${
          isAuction && bid != null ? `mise ◆ ${fmt(bid)}${left ? ' · ' : ''}` : ''
        }${left ? esc(left) : ''}</span>
        <button class="kp-mkt-open" type="button" data-act="open-listing" data-listing="${esc(
          item?.id ?? ''
        )}" data-type="${isAuction ? 'auction' : 'fixed'}" title="Ouvrir cette annonce sur kyara.games ↗">↗</button>
      </div>`;
  }

  /** Ligne « carte » du marché global : meilleure offre + dépliant des autres ventes. */
  function sellMarketRow(group, ownedMap) {
    const id = group.id;
    const card = group.card ?? state.characters.get(id) ?? null;
    const info = rarityInfo(card?.rarity);
    const owned = ownedMap?.get(id) ?? null;
    const median = marketPriceOf(group.items[0]);
    const embedded = group.items[0]?.prices ?? null;
    const change =
      embedded?.median7d != null && embedded?.median30d != null && embedded.median30d > 0
        ? ((embedded.median7d - embedded.median30d) / embedded.median30d) * 100
        : changePctOf(id);

    const count = group.items.length;
    const expanded = state.marketView.expanded.has(id);
    const cheapest = group.best;
    const price = cheapest?.price ?? null;
    const bestType = cheapest ? (marketItemIsAuction(cheapest.item) ? 'enchère' : 'fixe') : '';

    // Meilleure enchère : on affiche aussi son achat immédiat quand il existe.
    const auctionBuyout = toNum(group.bestAuction?.item?.buyoutPrice);

    return `
      <div class="kp-mkt-group ${expanded ? 'is-open' : ''}">
        <div class="kp-sell-row kp-is-clickable" data-act="sell-detail" data-id="${esc(id)}" title="Voir la fiche de ${esc(
          card?.name ?? 'cette carte'
        )}">
          <span class="kp-sell-owned">${owned ? `×${fmt(owned.qty)}` : '+'}</span>
          <img src="${esc(imgSrc(card))}" alt="" loading="lazy">
          <div class="kp-sell-main">
            <div class="kp-row-name">
              ${esc(card?.name ?? `Carte #${id}`)}
              ${count > 1 ? `<span class="kp-mkt-count">${fmt(count)} ventes</span>` : ''}
            </div>
            <div class="kp-row-meta">
              <span class="kp-rar" style="--rc:${info.color}">${esc(info.label)}</span>
              ${
                group.bestFixed && group.bestAuction
                  ? `fixe ◆ ${fmt(group.bestFixed.price)} · enchère dès ◆ ${fmt(group.bestAuction.price)}${
                      auctionBuyout != null ? ` (achat immédiat ◆ ${fmt(auctionBuyout)})` : ''
                    }`
                  : group.bestAuction
                    ? `enchère dès ◆ ${fmt(group.bestAuction.price)}${
                        auctionBuyout != null ? ` · achat immédiat ◆ ${fmt(auctionBuyout)}` : ''
                      }`
                    : group.bestFixed
                      ? `prix fixe ◆ ${fmt(group.bestFixed.price)}`
                      : 'aucun prix'
              }
              ${owned ? '' : ' · pas dans ta collection'}
              ${ownerPill(id)}
            </div>
          </div>
          <div class="kp-sell-trend">${deltaChip(change)}</div>
          <div class="kp-sell-price">
            <b>◆ ${fmt(price)}</b>
            <small>${bestType ? `le moins cher · ${bestType}` : '—'}${median != null ? ` · méd. ◆ ${fmt(median)}` : ''}</small>
          </div>
        </div>
        ${
          count > 1
            ? `<button class="kp-mkt-toggle" type="button" data-act="market-expand" data-id="${esc(id)}" ${
                expanded ? 'aria-expanded="true"' : 'aria-expanded="false"'
              }>
                 <span class="kp-mkt-caret">${expanded ? '▾' : '▸'}</span>
                 ${expanded ? 'Masquer' : 'Voir'} les ${fmt(count)} ventes
               </button>
               ${expanded ? `<div class="kp-mkt-sublist">${group.items.map(sellMarketListing).join('')}</div>` : ''}`
            : ''
        }
      </div>`;
  }

  function sellSelectionBar(rows) {
    const selected = rows.filter((row) => state.selected.has(row.id));
    const copies = selected.length;
    const totals = sellTotals(selected.map((row) => ({ qty: 1, price: row.price ?? 1 })));
    const slots = listingSlots();
    return `
      <div class="kp-sellbar">
        <div class="kp-sellbar-info">
          <b>${selected.length} carte(s) · ◆ ${fmt(totals.net)} net estimé</b>
          <span>${copies} annonce(s) · ${slots.remaining} place(s) libre(s) · frais ◆ ${fmt(totals.fees)}</span>
        </div>
        <button class="kp-btn is-primary" type="button" data-act="prepare-sell" ${selected.length ? '' : 'disabled'}>Préparer la vente</button>
      </div>`;
  }

  function autoSellPanel(all, slots) {
    const a = state.autoSell;
    const s = state.settings;
    const dupes = all.filter((row) => row.qty > 1).length;
    const spare = all.reduce((sum, row) => sum + autoSellSpare(row), 0);
    const withoutPrice = all.filter(
      (row) =>
        autoSellSpare(row) > 0 &&
        (s.autoSellIncludeML || !['M', 'L'].includes(String(row.rarity || '').toUpperCase())) &&
        autoSellPrice(row, s.autoSellStrategy) == null
    ).length;
    const mlSpare = all
      .filter((row) => ['M', 'L'].includes(String(row.rarity || '').toUpperCase()))
      .reduce((sum, row) => sum + autoSellSpare(row), 0);
    const stateLabel = a.running
      ? 'en cours'
      : a.armed
        ? 'à confirmer'
        : 'arrêtée';
    const log = a.log.slice(-8);
    return `
      <section class="kp-autosell ${a.running ? 'is-running' : ''} ${a.armed ? 'is-armed' : ''}">
        <div class="kp-autosell-head">
          <div class="kp-autosell-title">
            <span class="kp-autosell-dot"></span>
            <b>Vente auto</b>
            <small>doublons uniquement · dernière copie conservée</small>
          </div>
          <span class="kp-autosell-state">${stateLabel}</span>
        </div>
        <div class="kp-autosell-stats">
          <span><b>${fmt(dupes)}</b> carte(s) en double</span>
          <span><b>${fmt(spare)}</b> exemplaire(s) en trop</span>
          <span><b>${fmt(spare - (s.autoSellIncludeML ? 0 : mlSpare))}</b> éligible(s)</span>
          <span><b>${slots.remaining}</b> place(s) libre(s)</span>
        </div>
        ${
          a.status
            ? `<div class="kp-autosell-status">${esc(a.status)}${
                a.nextAt && a.running ? ` · prochain cycle ${nowTime(a.nextAt)}` : ''
              }</div>`
            : ''
        }
        <div class="kp-autosell-grid">
          <label>
            <span>Type</span>
            <select class="kp-select" data-autosell-type ${a.running ? 'disabled' : ''}>
              <option value="fixed" ${s.autoSellType === 'fixed' ? 'selected' : ''}>Prix fixe</option>
              <option value="auction" ${s.autoSellType === 'auction' ? 'selected' : ''}>Enchère</option>
            </select>
          </label>
          <label>
            <span>Stratégie</span>
            <select class="kp-select" data-autosell-strategy ${a.running ? 'disabled' : ''}>
              <option value="quick" ${s.autoSellStrategy === 'quick' ? 'selected' : ''}>Vente rapide</option>
              <option value="balanced" ${s.autoSellStrategy === 'balanced' ? 'selected' : ''}>Équilibrée</option>
              <option value="max" ${s.autoSellStrategy === 'max' ? 'selected' : ''}>Prix maximal</option>
            </select>
          </label>
          <label>
            <span>Prix min</span>
            <input class="kp-input" type="number" min="1" step="1" data-autosell-min-price
              value="${Math.max(1, Number(s.autoSellMinPrice) || 1)}" ${a.running ? 'disabled' : ''}>
          </label>
          <label>
            <span>Intervalle (s)</span>
            <input class="kp-input" type="number" min="30" max="3600" step="10" data-autosell-interval
              value="${Math.min(3600, Math.max(30, Number(s.autoSellIntervalSec) || 60))}" ${a.running ? 'disabled' : ''}>
          </label>
          <label>
            <span>Max / cycle</span>
            <input class="kp-input" type="number" min="1" max="10" step="1" data-autosell-max
              value="${Math.min(10, Math.max(1, Number(s.autoSellMaxPerCycle) || 10))}" ${a.running ? 'disabled' : ''}>
          </label>
        </div>
        <div class="kp-autosell-opts">
          <label class="kp-check">
            <input type="checkbox" data-autosell-include-ml ${s.autoSellIncludeML ? 'checked' : ''} ${a.running ? 'disabled' : ''}>
            Inclure M/L <em>${s.autoSellIncludeML ? '· dangereux' : '· exclues par défaut'}</em>
          </label>
          <label class="kp-check">
            <input type="checkbox" data-autosell-dryrun ${s.autoSellDryRun ? 'checked' : ''} ${a.running ? 'disabled' : ''}>
            Simulation
          </label>
          <span class="kp-autosell-note">${fmt(withoutPrice)} sans prix · ${fmt(mlSpare)} M/L</span>
        </div>
        <div class="kp-autosell-actions">
          <button class="kp-btn" type="button" data-act="autosell-preview" ${a.running ? 'disabled' : ''}>Aperçu</button>
          <button class="kp-btn ${a.armed ? 'is-primary' : ''}" type="button" data-act="autosell-start" ${a.running ? 'disabled' : ''}>
            ${a.armed ? 'Confirmer le démarrage' : 'Démarrer'}
          </button>
          <button class="kp-btn" type="button" data-act="autosell-stop" ${a.running ? '' : 'disabled'}>Arrêter</button>
          ${a.armed ? '<button class="kp-btn" type="button" data-act="autosell-cancel">Annuler</button>' : ''}
        </div>
        ${
          a.armed
            ? `<div class="kp-autosell-confirm">
                 <b>Confirmer la vente auto ?</b>
                 <span>${fmt(spare)} exemplaire(s) en trop · ${slots.remaining} place(s) libre(s) · ${
                   s.autoSellIncludeML ? 'M/L incluses' : 'M/L exclues'
                 } · dernière copie conservée.</span>
               </div>`
            : ''
        }
        ${
          a.preview
            ? `<div class="kp-autosell-preview">
                 <b>Aperçu · ${fmt(a.preview.plan.length)} annonce(s)</b>
                 ${
                   a.preview.plan.length
                     ? a.preview.plan
                         .slice(0, 10)
                         .map(
                           (row) =>
                             `<div><span>${esc(row.name)} × ${row.qty}</span><b>◆ ${fmt(row.price)}</b></div>`
                         )
                         .join('')
                     : '<div>Aucune annonce à préparer.</div>'
                 }
                 ${a.preview.withoutPrice ? `<small>${fmt(a.preview.withoutPrice)} doublon(s) sans prix ignoré(s).</small>` : ''}
               </div>`
            : ''
        }
        ${
          log.length
            ? `<div class="kp-autosell-log">${log
                .map((entry) => `<div class="${entry.kind === 'err' ? 'is-bad' : entry.kind === 'ok' ? 'is-good' : ''}">${esc(entry.text)}</div>`)
                .join('')}</div>`
            : ''
        }
      </section>`;
  }

  function salesChart() {
    const totals = salesTotals(state.salesLog);
    const model = salesChartSeries(state.salesLog);
    const { points, max } = model;
    const W = 720;
    const H = 210;
    const pad = { l: 44, r: 14, t: 14, b: 26 };
    const x = (index) => pad.l + (index / Math.max(1, points.length - 1)) * (W - pad.l - pad.r);
    const y = (value) => H - pad.b - (value / max) * (H - pad.t - pad.b);
    const line = (key) =>
      points.map((point, index) => `${index ? 'L' : 'M'}${x(index).toFixed(1)} ${y(point[key]).toFixed(1)}`).join(' ');
    const grid = [0, 0.5, 1]
      .map((ratio) => {
        const value = max * ratio;
        const gy = y(value);
        const label = Number.isInteger(value) ? fmt(value) : value.toFixed(1).replace('.', ',');
        return `<line class="kp-sales-grid" x1="${pad.l}" y1="${gy.toFixed(1)}" x2="${W - pad.r}" y2="${gy.toFixed(
          1
        )}"></line><text class="kp-sales-axis" x="${pad.l - 7}" y="${(gy + 3).toFixed(1)}" text-anchor="end">◆ ${label}</text>`;
      })
      .join('');
    const xLabels = points
      .map((point, index) => {
        const date = new Date(point.at).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' });
        return `<text class="kp-sales-axis" x="${x(index).toFixed(1)}" y="${H - 7}" text-anchor="middle">${esc(
          date
        )}</text>`;
      })
      .join('');
    return `
      <section class="kp-sales">
        <div class="kp-sales-head">
          <b>Ventes</b>
          <span>7 jours · via Kyareeh+</span>
        </div>
        <div class="kp-sales-kpis">
          <span><b>◆ ${fmt(totals.net)}</b><small>net estimé</small></span>
          <span><b>${fmt(totals.count)}</b><small>ventes</small></span>
          <span><b>${fmt(totals.matched)}</b><small>immédiates</small></span>
        </div>
        <svg class="kp-sales-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="Net des ventes par jour">
          ${grid}
          <path class="kp-sales-line is-auto" d="${line('auto')}"></path>
          <path class="kp-sales-line is-manual" d="${line('manual')}"></path>
          <circle class="kp-sales-dot is-auto" cx="${x(points.length - 1).toFixed(1)}" cy="${y(
            points[points.length - 1].auto
          ).toFixed(1)}" r="3"></circle>
          <circle class="kp-sales-dot is-manual" cx="${x(points.length - 1).toFixed(1)}" cy="${y(
            points[points.length - 1].manual
          ).toFixed(1)}" r="3"></circle>
          ${xLabels}
        </svg>
        <div class="kp-sales-legend">
          <span><i class="is-auto"></i>Auto <b>◆ ${fmt(totals.autoNet)}</b></span>
          <span><i class="is-manual"></i>Manuelle <b>◆ ${fmt(totals.manualNet)}</b></span>
        </div>
        <div class="kp-sales-note">Net estimé des annonces créées via Kyareeh+.</div>
      </section>`;
  }

  function viewSell() {
    if (!state.user) return loginHTML();
    const view = state.sellView;
    const slots = listingSlots();
    const all = sellRows();

    if (view.mode === 'auto') {
      return `
        ${sellModeSwitch()}
        <div class="kp-hint">Doublons uniquement · une copie conservée.</div>
        ${autoSellPanel(all, slots)}
        ${salesChart()}`;
    }

    const rows = filteredSellRows(all);
    const sellableCopies = all.reduce((sum, row) => sum + row.sellable, 0);
    const priced = rows.filter((row) => row.price != null);
    const counts = { all: all.length };
    for (const row of all) counts[row.rarity] = (counts[row.rarity] ?? 0) + 1;

    if (!all.length) {
      return `${sellModeSwitch()}${salesChart()}<div class="kp-empty"><b>Collection vide</b>Le site n'a renvoyé aucune carte pour ce compte.</div>`;
    }

    // Prix marché des lignes affichées uniquement, par petits lots.
    if (rows.length) {
      loadMarketInfo(rows.slice(0, 24).map((row) => row.id), Math.min(24, state.marketLimit));
      loadSellHistory(rows.slice(0, 10).map((row) => row.id), 8);
    }

    const visible = rows.slice(0, view.limit);

    return `
      ${sellModeSwitch()}
      ${sellToolbar()}
      ${sellFilters(sellSeriesOptions())}
      ${sellRarityChips(counts)}
      <div class="kp-hint">
        ${
          rows.length === all.length
            ? `${fmt(all.length)} carte(s)`
            : `${fmt(rows.length)} / ${fmt(all.length)} carte(s) affichée(s)`
        }
        · ${fmt(all.filter((row) => row.qty > 1).length)} doublon(s)
        · ${fmt(sellableCopies)} exemplaire(s) vendable(s) · ${fmt(priced.length)} valorisée(s)
        · ${slots.remaining} place(s) d'annonce libre(s)
        ${state.marketLoading ? ' <span class="kp-spinner"></span>' : ''}
        ${view.lastRefresh ? ` · actualisé ${nowTime(view.lastRefresh)}` : ''}
      </div>
      <div class="kp-sell-list">${visible.map(sellOwnedRow).join('')}</div>
      ${
        rows.length > visible.length
          ? `<div class="kp-toolbar"><button class="kp-btn" type="button" data-act="sell-more-rows">Afficher plus (${fmt(rows.length - visible.length)})</button></div>`
          : ''
      }
      ${salesChart()}
      ${sellSelectionBar(rows)}`;
  }

  function marketModeSwitch() {
    const mode = state.marketMode === 'deals' ? 'deals' : 'global';
    return `
      <div class="kp-seg kp-seg-lg" role="tablist" aria-label="Marché">
        <button class="kp-seg-btn ${mode === 'global' ? 'is-active' : ''}" type="button" role="tab" aria-selected="${mode === 'global'}" data-act="market-mode" data-mode="global">
          Marché global
        </button>
        <button class="kp-seg-btn ${mode === 'deals' ? 'is-active' : ''}" type="button" role="tab" aria-selected="${mode === 'deals'}" data-act="market-mode" data-mode="deals">
          Bons plans
        </button>
      </div>`;
  }

  function marketGlobalToolbar() {
    const view = state.marketView;
    return `
      <div class="kp-toolbar kp-toolbar-search">
        <input class="kp-input" type="search" data-role="market-search" autocomplete="off"
          placeholder="Chercher une carte sur le marché…" value="${esc(view.query)}">
        <button class="kp-btn ${view.loading ? '' : 'is-primary'}" type="button" data-act="market-refresh" ${view.loading ? 'disabled' : ''}>
          ${view.loading ? '<span class="kp-spinner"></span> Recherche…' : 'Actualiser le marché'}
        </button>
      </div>
      <div class="kp-hint">Recherche serveur · pagination réelle.</div>`;
  }

  function marketGlobalFilters() {
    const view = state.marketView;
    return `
      <div class="kp-filters">
        <label class="kp-filter">
          <span>Tri</span>
          <select class="kp-select" data-market-sort>
            ${DEAL_SORTS.map(
              ([value, label]) => `<option value="${value}" ${view.sort === value ? 'selected' : ''}>${label}</option>`
            ).join('')}
          </select>
        </label>
        <label class="kp-filter">
          <span>Type</span>
          <select class="kp-select" data-market-type>
            ${[
              ['all', 'Tout'],
              ['fixed', 'Prix fixe'],
              ['auction', 'Enchères']
            ]
              .map(([value, label]) => `<option value="${value}" ${view.type === value ? 'selected' : ''}>${label}</option>`)
              .join('')}
          </select>
        </label>
      </div>
      <div class="kp-rarities ${view.rarity !== 'all' ? 'is-focus' : ''}">
        <button class="kp-rchip ${view.rarity === 'all' ? 'is-active' : ''}" type="button" data-act="market-rarity" data-rarity="all">Toutes</button>
        ${RARITY_ORDER.map((code) => {
          const info = rarityInfo(code);
          return `<button class="kp-rchip ${view.rarity === code ? 'is-active' : ''}" type="button" data-act="market-rarity" data-rarity="${code}" style="--rc:${info.color}">${esc(
            info.label
          )}</button>`;
        }).join('')}
      </div>`;
  }

  function marketGlobalBlock() {
    const view = state.marketView;
    const items = view.items ?? [];
    const ownedMap = new Map(sellRows().map((row) => [String(row.id), row]));
    const groups = groupMarketItems(items, view.sort);
    const hasQuery = Boolean(view.query.trim()) || view.rarity !== 'all' || view.type !== 'all';
    return `
      ${marketGlobalToolbar()}
      ${marketGlobalFilters()}
      ${
        view.items === null
          ? '<div class="kp-empty"><span class="kp-spinner"></span> Chargement du marché…</div>'
          : view.loading && !items.length
            ? '<div class="kp-empty"><span class="kp-spinner"></span> Recherche sur le marché…</div>'
            : view.error
            ? `<div class="kp-empty"><b>Recherche impossible</b>${esc(view.error)}</div>`
            : !items.length
              ? `<div class="kp-empty"><b>Aucun résultat</b>${
                  hasQuery ? 'Aucune annonce ne correspond à ces filtres.' : 'Lance une recherche pour interroger le marché.'
                }</div>`
              : `<div class="kp-hint">${fmt(items.length)} annonce(s) sur ${fmt(view.total)} · ${fmt(
                  groups.length
                )} carte(s) distincte(s) · prix le plus bas par carte${
                  view.meta?.at ? ` · actualisé ${nowTime(view.meta.at)}` : ''
                }</div>
                 <div class="kp-sell-list">${groups.map((group) => sellMarketRow(group, ownedMap)).join('')}</div>
                 ${
                   items.length < view.total
                     ? `<div class="kp-toolbar"><button class="kp-btn" type="button" data-act="market-more" ${view.loading ? 'disabled' : ''}>Afficher plus</button></div>`
                     : ''
                 }`
      }`;
  }

  function marketMyListings() {
    const mineAll = Array.isArray(state.mine?.listings)
      ? state.mine.listings
      : Array.isArray(state.mine)
        ? state.mine
        : [];
    const mine = mineAll.filter((l) => !l.status || l.status === 'active');
    const mineOther = mineAll.length - mine.length;
    if (!mine.length) return '';
    return `<div class="kp-section">
      <div class="kp-section-title">Mes annonces actives (${mine.length})${
        mineOther > 0 ? `<span>+${mineOther} terminée(s)</span>` : ''
      }</div>
      <div class="kp-table">
        ${mine
          .slice(0, 20)
          .map((l) => {
            const card = l.character ?? state.characters.get(String(l.characterId)) ?? null;
            const end = l.endsAt ? new Date(l.endsAt) : null;
            const hoursLeft =
              end && Number.isFinite(end.getTime()) ? Math.max(0, Math.round((end.getTime() - Date.now()) / 3600000)) : null;
            return `
              <div class="kp-row kp-is-clickable" data-act="open-listing" data-listing="${esc(l.id ?? '')}" data-type="${esc(
                l.type ?? 'fixed'
              )}" data-name="${esc(card?.name ?? '')}" title="Ouvrir cette vente sur kyara.games ›">
                <span></span>
                <img src="${esc(imgSrc(card))}" alt="" loading="lazy">
                <div class="kp-row-main">
                  <div class="kp-row-name">${esc(card?.name ?? `Carte #${l.characterId ?? '?'}`)}</div>
                  <div class="kp-row-meta">${l.type === 'auction' ? 'enchère' : 'prix fixe'}${
                    l.type === 'auction' && l.bidCount ? ` · ${l.bidCount} mise(s)` : ''
                  }${hoursLeft != null ? ` · ${hoursLeft} h restantes` : ''}</div>
                </div>
                <div class="kp-row-price"><b>◆ ${fmt(l.finalPrice ?? l.currentBid ?? l.price)}</b></div>
              </div>`;
          })
          .join('')}
      </div>
    </div>`;
  }

  function dealsMarketBlock() {
    const deals = state.deals ?? [];
    const filter = String(state.settings.dealsRarity || 'all');
    const typeFilter = String(state.settings.dealsType || 'all');
    const visible = deals.filter(
      (d) =>
        (filter === 'all' || String(d.rarity || 'C') === filter) &&
        (typeFilter === 'all' || String(d.type || 'fixed') === typeFilter)
    );
    const counts = new Map();
    for (const d of deals) {
      const key = String(d.rarity || 'C');
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const rarityBar = [
      `<button class="kp-rchip ${filter === 'all' ? 'is-active' : ''}" type="button" data-act="deals-rarity" data-rarity="all">Toutes <em>${deals.length}</em></button>`,
      ...RARITY_ORDER.map((code) => {
        const info = rarityInfo(code);
        const n = counts.get(code) ?? 0;
        return `<button class="kp-rchip ${filter === code ? 'is-active' : ''}" type="button" data-act="deals-rarity" data-rarity="${code}" style="--rc:${info.color}" ${
          n ? '' : 'disabled'
        }>${esc(info.label)} <em>${n}</em></button>`;
      })
    ].join('');
    const meta = state.dealsMeta;
    return `
      <div class="kp-toolbar">
        <button class="kp-btn is-primary" type="button" data-act="scan-market" ${state.dealsScanning ? 'disabled' : ''}>
          ${state.dealsScanning ? '<span class="kp-spinner"></span> Scan…' : 'Scanner les bons plans'}
        </button>
      </div>
      <div class="kp-filters">
        <label class="kp-filter">
          <span>Tri</span>
          <select class="kp-select" data-setting="dealsSort">
            ${DEAL_SORTS.map(
              ([value, label]) => `<option value="${value}" ${state.settings.dealsSort === value ? 'selected' : ''}>${label}</option>`
            ).join('')}
          </select>
        </label>
        <label class="kp-filter">
          <span>Pages</span>
          <input class="kp-input" type="number" min="1" max="20" step="1" data-setting="dealsPages" value="${state.settings.dealsPages}">
        </label>
        <label class="kp-filter">
          <span>Seuil %</span>
          <input class="kp-input" type="number" min="0" max="90" step="1" data-setting="dealsMinPct" value="${state.settings.dealsMinPct}">
        </label>
      </div>
      <div class="kp-rarities ${typeFilter !== 'all' ? 'is-focus' : ''}">
        ${[
          ['all', 'Tout'],
          ['fixed', 'Prix fixe'],
          ['auction', 'Enchères']
        ]
          .map(
            ([value, label]) =>
              `<button class="kp-rchip ${typeFilter === value ? 'is-active' : ''}" type="button" data-act="deals-type" data-type="${value}" style="--rc:#8b93a5">${label}</button>`
          )
          .join('')}
      </div>
      <div class="kp-hint">
        ${
          meta
            ? `${fmt(meta.scanned)} annonces lues · ${fmt(meta.considered)} comparables${meta.truncated ? ' · limite de pages atteinte' : ''}`
            : 'Choisis un tri puis lance le scan.'
        }
        ${state.dealsError ? ` · <span style="color:var(--kp-bad)">${esc(state.dealsError)}</span>` : ''}
      </div>
      ${deals.length ? `<div class="kp-rarities ${filter !== 'all' ? 'is-focus' : ''}">${rarityBar}</div>` : ''}
      ${
        state.deals === null
          ? `<div class="kp-empty"><b>Aucun scan</b>Lance un scan pour voir les annonces sous la médiane.</div>`
          : visible.length
            ? `<div class="kp-table">
                 ${visible
                   .slice(0, 40)
                   .map((d) => {
                     const card = d.c ?? state.characters.get(d.characterId) ?? null;
                     const ri = rarityInfo(card?.rarity);
                     return `
                     <div class="kp-deal" data-act="open-listing" data-listing="${esc(d.listingId ?? '')}" data-type="${esc(d.type)}" data-name="${esc(card?.name ?? '')}" title="Ouvrir cette vente sur kyara.games ›">
                       <img src="${esc(imgSrc(card))}" alt="" loading="lazy">
                       <div>
                         <div class="kp-deal-name">${esc(card?.name ?? `Carte #${d.characterId}`)}</div>
                         <div class="kp-deal-meta">${esc(ri.label)} · méd. ◆ ${fmt(d.median)}${
                           d.type === 'auction' ? ' · achat imm.' : ''
                         }${d.sales7d != null ? ` · ${d.sales7d}/7j` : ''}</div>
                       </div>
                       <div class="kp-deal-price">
                         <b>◆ ${fmt(d.price)}</b>
                         <small>-${d.pct} % · ${fmt(d.saving)} ◆</small>
                         <span class="kp-deal-open">ouvrir ↗</span>
                       </div>
                     </div>`;
                   })
                   .join('')}
               </div>`
            : `<div class="kp-empty"><b>${
                deals.length ? 'Aucune annonce dans cette rareté' : 'Rien sous la médiane'
              }</b>${deals.length ? 'Change de filtre ou relance un scan.' : 'Les annonces actuelles sont au prix du marché (ou au-dessus).'}</div>`
      }`;
  }

  function viewMarket() {
    if (!state.user) return loginHTML();
    const mode = state.marketMode === 'deals' ? 'deals' : 'global';
    if (mode === 'global' && state.marketView.items === null && !state.marketView.loading) {
      setTimeout(() => {
        if (state.tab === 'market' && state.marketMode === 'global' && !state.marketView.loading) {
          loadSellMarket(false);
        }
      }, 0);
    }
    return `${marketModeSwitch()}${mode === 'global' ? marketGlobalBlock() : dealsMarketBlock()}${marketMyListings()}`;
  }

  /* ------------------------------------------------------------------ */
  /* Boosters & espérance                                                */
  /* ------------------------------------------------------------------ */

  async function loadPacks(force = false) {
    if (state.packsLoading) return;
    if (state.packs && !force) return;
    state.packsLoading = true;
    render();
    try {
      const data = await api('/api/packs', { timeout: 25000 });
      const list = Array.isArray(data) ? data : Array.isArray(data?.packs) ? data.packs : [];
      state.packs = list.filter((p) => p && p.rates);
      // Première visite : on coche le premier booster achetable par défaut.
      if (!state.settings.autoPackPicked && !(state.settings.autoPackIds ?? []).length) {
        const first = state.packs.find((pack) => !pack.grantOnly);
        if (first) state.settings.autoPackIds = [String(first.id)];
      }
    } catch (err) {
      state.packsError = friendlyError(err);
      state.packs = state.packs || [];
    } finally {
      state.packsLoading = false;
      render();
    }
  }

  /** Moyenne des prix réels par rareté, par échantillonnage du catalogue. */
  async function computePackAverages(force = false) {
    if (state.packAveragesLoading) return;
    if (state.packAverages && !force) return;

    if (!state.packAverages && !force) {
      const cached = await storageGet(PACK_AVG_KEY, null);
      if (cached && cached.at && Array.isArray(cached.items) && Date.now() - cached.at < 24 * 3600 * 1000) {
        state.packAverages = cached.items;
        render();
        return;
      }
    }

    state.packAveragesLoading = true;
    render();

    try {
      const buckets = new Map(RARITY_ORDER.map((code) => [code, []]));
      for (const [id, card] of state.characters) {
        const rarity = String(card?.rarity ?? '').toUpperCase();
        if (buckets.has(rarity)) buckets.get(rarity).push(id);
      }

      const sampleIds = [];
      for (const [, ids] of buckets) {
        // Échantillon aléatoire : évite de ne prendre que les premières entrées du catalogue.
        for (let i = ids.length - 1; i > 0; i -= 1) {
          const j = Math.floor(Math.random() * (i + 1));
          [ids[i], ids[j]] = [ids[j], ids[i]];
        }
        sampleIds.push(...ids.slice(0, 50));
      }

      const prices = await fetchFairPrices(sampleIds);
      const rows = [];
      for (const [code, ids] of buckets) {
        const values = ids
          .slice(0, 50)
          .map((id) => prices.get(id))
          .filter((v) => v != null && v > 0);
        if (!values.length) continue;
        const sum = values.reduce((a, b) => a + b, 0);
        rows.push({
          rarity: code,
          avg: sum / values.length,
          sample: values.length
        });
      }

      state.packAverages = rows;
      storageSet(PACK_AVG_KEY, { at: Date.now(), items: rows });
    } catch (err) {
      state.packsError = friendlyError(err);
    } finally {
      state.packAveragesLoading = false;
      render();
    }
  }

  function avgPriceOf(rarity) {
    const row = (state.packAverages ?? []).find((r) => r.rarity === String(rarity).toUpperCase());
    return row ? row.avg : null;
  }

  /**
   * Ce que rapporte un booster en moyenne.
   * Principe : chaque carte tirée a une chance par rareté ; on multiplie ces chances
   * par le prix moyen d'une carte de cette rareté, puis on additionne.
   */
  function packEV(pack) {
    const rates = pack?.rates;
    if (!rates || !state.packAverages?.length) return null;

    /** Cartes attendues + valeur attendue, rareté par rareté, pour une liste de slots. */
    const breakdownFor = (slots) => {
      const rows = new Map();
      for (const slot of slots ?? []) {
        const pct = slot?.pct ?? {};
        for (const [rarity, share] of Object.entries(pct)) {
          const chance = Number(share) / 100;
          if (!Number.isFinite(chance) || chance <= 0) continue;
          const avg = avgPriceOf(rarity);
          const row = rows.get(rarity) ?? { rarity, cards: 0, avg: avg ?? null };
          row.cards += chance;
          rows.set(rarity, row);
        }
      }
      const list = [...rows.values()]
        .map((row) => ({ ...row, contribution: row.avg == null ? 0 : row.cards * row.avg }))
        .sort((a, b) => b.contribution - a.contribution);
      return { list, total: list.reduce((sum, row) => sum + row.contribution, 0) };
    };

    const normal = breakdownFor(rates.slots);
    const goldenSlots = pack.goldenEligible ? rates.golden?.slots ?? null : null;
    const goldenEvery = Math.max(1, toNum(state.config?.golden?.every) ?? 10);
    const goldenChance = goldenSlots ? 1 / goldenEvery : 0;
    const golden = goldenSlots ? breakdownFor(goldenSlots) : normal;
    const ev = normal.total * (1 - goldenChance) + golden.total * goldenChance;
    const price = toNum(pack.chakraPrice);

    return {
      ev,
      evNormal: normal.total,
      evGolden: golden.total,
      price,
      ratio: price && price > 0 ? ev / price : null,
      goldenChance,
      goldenEvery,
      breakdown: normal.list,
      goldenBreakdown: golden.list,
      slots: rates.slots?.length ?? 0
    };
  }

  /** Pool exact d'un booster : la liste des cartes qu'il peut réellement tirer. */
  async function loadPackPools(force = false) {
    if (state.packPoolsLoading) return;
    if (state.packPools && !force) return;
    if (!state.packs?.length) return;

    if (!state.packPools && !force) {
      const cached = await storageGet(PACK_POOLS_KEY, null);
      if (cached && cached.byPack && cached.at && Date.now() - cached.at < 24 * 3600 * 1000) {
        state.packPools = buildPoolIndex(cached.byPack);
        render();
        return;
      }
    }

    state.packPoolsLoading = true;
    state.packPoolProgress = { done: 0, total: state.packs.length };
    render();

    const byPack = {};
    let cursor = 0;
    const list = state.packs.map((p) => p.id);

    const worker = async () => {
      while (cursor < list.length) {
        const id = list[cursor++];
        try {
          const data = await api(`/api/packs/${encodeURIComponent(id)}/characters`, { timeout: 30000 });
          const ids = Array.isArray(data)
            ? data
            : Array.isArray(data?.characters)
              ? data.characters
              : Array.isArray(data?.items)
                ? data.items
                : [];
          byPack[id] = ids.map((entry) => (entry && typeof entry === 'object' ? entry.id : entry)).filter((v) => v != null);
        } catch {
          byPack[id] = null;
        }
        state.packPoolProgress = { done: (state.packPoolProgress?.done ?? 0) + 1, total: list.length };
        render();
      }
    };

    await Promise.all([worker(), worker()]);
    state.packPools = buildPoolIndex(byPack);
    state.packPoolsLoading = false;
    state.packPoolProgress = null;
    storageSet(PACK_POOLS_KEY, { at: Date.now(), byPack });
    render();
  }

  function buildPoolIndex(byPack) {
    const out = new Map();
    for (const [packId, ids] of Object.entries(byPack)) {
      if (!Array.isArray(ids)) {
        out.set(packId, null);
        continue;
      }
      const set = new Set(ids.map(String));
      const counts = {};
      for (const id of set) {
        const rarity = String(state.characters.get(id)?.rarity ?? '').toUpperCase();
        if (rarity) counts[rarity] = (counts[rarity] ?? 0) + 1;
      }
      out.set(packId, { set, counts, size: set.size });
    }
    return out;
  }

  /**
   * Probabilité par booster d'obtenir précisément `card` dans `pack`.
   * Modèle : pour chaque slot, la rareté tombe avec pct/100 ; la carte est ensuite
   * tirée uniformément dans le pool de cette rareté. Les vedettes (rateUp) captent
   * `share` des tirages de leurs raretés. Le pack doré (1 booster sur N) est intégré.
   */
  function packCardChance(pack, card) {
    if (!pack || !card) return null;
    const rarity = String(card.rarity ?? '').toUpperCase();
    if (!rarity) return null;

    const pool = state.packPools?.get(String(pack.id));
    const officialPoolSize = toNum(pack.rates?.poolSize);
    // Une liste dont la taille ne correspond pas au poolSize annoncé est périmée :
    // on ne s'en sert pas pour exclure une carte (faux négatifs).
    const trustedPool =
      pool && (officialPoolSize == null || Math.abs(pool.size - officialPoolSize) <= Math.max(2, officialPoolSize * 0.01));

    if (trustedPool && !pool.set.has(String(card.id))) {
      return { p: 0, pNormal: 0, inPool: false, poolCount: 0, featured: false, trusted: true };
    }

    const poolCount = toNum(pack.rates?.cardsByRarity?.[rarity]) ?? pool?.counts?.[rarity] ?? 0;
    if (!poolCount) return { p: 0, pNormal: 0, inPool: true, poolCount: 0, featured: false, trusted: false };

    const featuredIds = (pack.rateUp?.characterIds ?? []).map(String);
    const featuredRarities = (pack.rateUp?.rarities ?? []).map(String);
    const featured = featuredIds.includes(String(card.id)) && featuredRarities.includes(rarity);
    const share = featuredRarities.length ? Math.min(1, Math.max(0, toNum(pack.rateUp?.share) ?? 0)) : 0;
    const featuredCount = featured
      ? Math.max(
          1,
          featuredIds.filter((id) => String(state.characters.get(id)?.rarity ?? '').toUpperCase() === rarity).length
        )
      : 0;

    // Espérance de cartes de cette rareté par booster, pour une liste de slots donnée.
    const expected = (slots) => {
      let total = 0;
      for (const slot of slots ?? []) {
        const pct = toNum(slot?.pct?.[rarity]);
        if (pct == null || pct <= 0) continue;
        total += pct / 100;
      }
      return total;
    };

    const chanceFor = (slots) => {
      const n = expected(slots);
      if (!n) return 0;
      if (!featuredRarities.includes(rarity)) return n / poolCount;
      const general = ((1 - share) * n) / poolCount;
      const featuredPart = featured ? (share * n) / featuredCount : 0;
      return general + featuredPart;
    };

    const pNormal = chanceFor(pack.rates?.slots);
    const goldenSlots = pack.goldenEligible ? pack.rates?.golden?.slots : null;
    const goldenEvery = Math.max(1, toNum(state.config?.golden?.every) ?? 10);
    const goldenChance = goldenSlots ? 1 / goldenEvery : 0;
    const pGolden = goldenSlots ? chanceFor(goldenSlots) : pNormal;
    const p = pNormal * (1 - goldenChance) + pGolden * goldenChance;

    return {
      p,
      pNormal,
      pGolden,
      inPool: true,
      poolCount,
      featured,
      share,
      goldenChance,
      trusted: Boolean(trustedPool),
      expectedPerBooster: p > 0 ? 1 / p : null
    };
  }

  function formatCards(n) {
    if (!Number.isFinite(n) || n <= 0) return '0 carte';
    if (n < 0.01) return '< 0.01 carte';
    if (n < 1) return `${n.toFixed(2)} carte`;
    if (n < 2) return `${n.toFixed(2)} cartes`;
    return `${n.toFixed(2)} cartes`;
  }

  function formatPct(value) {    if (value == null || !Number.isFinite(value)) return '—';
    if (value <= 0) return '0 %';
    if (value >= 10) return `${Math.round(value * 10) / 10} %`;
    if (value >= 1) return `${Math.round(value * 100) / 100} %`;
    if (value >= 0.1) return `${Math.round(value * 1000) / 1000} %`;
    if (value >= 0.01) return `${Math.round(value * 10000) / 10000} %`;
    const s = value.toFixed(5);
    return `${s.replace(/0+$/, '').replace(/\.$/, '')} %`;
  }

  function packName(pack) {
    return pack?.name ?? pack?.id ?? 'Booster';
  }


  function viewCards() {
    if (!state.user) return loginHTML();

    if (!state.packs && !state.packsLoading) loadPacks();
    if (!state.packAverages && !state.packAveragesLoading) computePackAverages();
    if (!state.packPools && !state.packPoolsLoading && state.packs?.length) loadPackPools();

    const packs = state.packs ?? [];
    const averages = state.packAverages ?? [];
    const target = state.packTarget;
    const query = state.packQuery.trim().toLowerCase();
    const poolsReady = Boolean(state.packPools);

    const suggestions =
      query.length >= 2 && !target
        ? [...state.characters.values()]
            .filter((card) => String(card?.name ?? '').toLowerCase().includes(query))
            .slice(0, 8)
        : [];

    // --- Chasse à la carte : probabilités exactes sur tous les boosters ---
    const chase = target
      ? packs
          .map((pack) => ({ pack, chance: packCardChance(pack, target.card) }))
          .filter((row) => row.chance)
          .sort((a, b) => {
            // Les boosters accessibles d'abord, du plus probable au moins probable.
            if (a.pack.grantOnly !== b.pack.grantOnly) return a.pack.grantOnly ? 1 : -1;
            return b.chance.p - a.chance.p;
          })
      : [];

    const reachable = chase.filter((row) => row.chance.p > 0);
    const best = reachable[0] ?? null;
    const affordable = reachable.filter((row) => {
      const price = toNum(row.pack.chakraPrice);
      return price != null && price > 0;
    });
    const bestPaid = affordable[0] ?? best;

    // --- Espérance par booster ---
    const evRows = packs
      .map((pack) => ({
        pack,
        ev: packEV(pack),
        pool: state.packPools?.get(String(pack.id)) ?? null
      }))
      .sort((a, b) => {
        if (a.pack.grantOnly !== b.pack.grantOnly) return a.pack.grantOnly ? 1 : -1;
        return (b.ev?.ratio ?? -1) - (a.ev?.ratio ?? -1);
      });

    const chaseRow = ({ pack, chance }) => {
      const price = toNum(pack.chakraPrice);
      const expected = chance.expectedPerBooster;
      const cost = price != null && price > 0 && expected != null ? price * expected : null;
      const tags = [];
      if (chance.featured) tags.push(`<span class="kp-tag is-hot">vedette ${Math.round((chance.share ?? 0) * 100)} %</span>`);
      if (!chance.inPool) tags.push('<span class="kp-tag">hors pool</span>');
      if (pack.grantOnly) tags.push('<span class="kp-tag">récompense</span>');
      if (pack.schedule) tags.push('<span class="kp-tag">limité</span>');

      const goldenDiff = chance.pNormal > 0 && Math.abs(chance.p - chance.pNormal) / chance.pNormal > 0.02;

      return `
        <div class="kp-pack ${chance.p > 0 ? '' : 'is-dim'}">
          <div class="kp-pack-head">
            <b style="color:${esc(pack.color ?? '#f3f4f7')}">${esc(packName(pack))}</b>
            <span class="kp-pack-price">${chance.p > 0 ? formatPct(chance.p * 100) : '—'}</span>
          </div>
          <div class="kp-pack-meta">
            <span>${price != null && price > 0 ? `◆ ${fmt(price)}` : pack.usesFreePacks ? 'gratuit' : '—'}</span>
            ${expected != null ? `<span>≈ ${fmt(expected)} boosters</span>` : ''}
            ${cost != null ? `<span>coût ◆ ${fmt(cost)}</span>` : ''}
            ${chance.poolCount ? `<span>pool ${fmt(chance.poolCount)}</span>` : ''}
            ${goldenDiff ? `<span title="hors pack doré">hors golden ${formatPct(chance.pNormal * 100)}</span>` : ''}
            ${tags.join('')}
          </div>
        </div>`;
    };

    return `
      <div class="kp-section" style="margin-top:0">
        <div class="kp-section-title">Chasse à la carte</div>
        <div class="kp-searchbar">
          <input class="kp-input" type="search" data-role="pack-search" placeholder="Nom de la carte…" value="${esc(state.packQuery)}" autocomplete="off">
          ${target ? `<button class="kp-btn is-ghost" type="button" data-act="pack-target-clear">✕</button>` : ''}
        </div>

        ${
          suggestions.length && !target
            ? `<div class="kp-table" style="margin-top:8px">
                 ${suggestions
                   .map((card) => {
                     const info = rarityInfo(card.rarity);
                     return `
                   <div class="kp-row" data-act="pack-target" data-id="${esc(card.id)}">
                     <span></span>
                     <img src="${esc(imgSrc(card))}" alt="" loading="lazy">
                     <div class="kp-row-main">
                       <div class="kp-row-name">${esc(card.name)}</div>
                       <div class="kp-row-meta"><span class="kp-rar" style="--rc:${info.color}">${esc(info.label)}</span> ${esc(card.series ?? '')}</div>
                     </div>
                     <div class="kp-row-price"><b>${target && String(target.id) === String(card.id) ? '✓' : ''}</b></div>
                   </div>`;
                   })
                   .join('')}
               </div>`
            : ''
        }

        ${
          !target
            ? `<div class="kp-hint" style="margin-top:8px">Choisis une carte pour voir sa probabilité exacte sur <b>tous</b> les boosters.</div>`
            : !poolsReady
              ? `<div class="kp-empty"><span class="kp-spinner"></span> Chargement des pools de boosters… ${
                  state.packPoolProgress ? `${state.packPoolProgress.done}/${state.packPoolProgress.total}` : ''
                }</div>`
              : `<div class="kp-profile-head" style="margin-top:10px">
                   <img class="kp-avatar-lg" src="${esc(imgSrc(target.card))}" alt="" loading="lazy" style="object-fit:cover;border-radius:8px">
                   <div class="kp-profile-id">
                     <b>${esc(target.card.name)}</b>
                     <small>${esc(rarityInfo(target.card.rarity).label)}${target.card.series ? ` · ${esc(target.card.series)}` : ''}</small>
                   </div>
                   ${target.card.id ? `<a class="kp-link" href="https://kyara.games/wiki/${encodeURIComponent(target.card.id)}" target="_blank" rel="noopener">Fiche ↗</a>` : ''}
                 </div>

                 <div class="kp-hero" style="margin-top:8px">
                   <div class="kp-hero-label">Meilleure chance par booster</div>
                   <div class="kp-hero-value">${best ? formatPct(best.chance.p * 100) : '0 %'}</div>
                   <div class="kp-hero-sub">
                     ${
                       best
                         ? `${esc(packName(best.pack))} · ≈ ${fmt(best.chance.expectedPerBooster)} boosters en moyenne<br>
                            au moins une sur 100 boosters : ${formatPct((1 - Math.pow(1 - best.chance.p, 100)) * 100)}`
                         : 'Cette carte ne sort d’aucun booster actuellement.'
                     }
                     ${
                       bestPaid && bestPaid !== best && bestPaid.chance.expectedPerBooster
                         ? `<br>meilleur achetable : ${esc(packName(bestPaid.pack))} · coût moyen ◆ ${fmt(
                             (toNum(bestPaid.pack.chakraPrice) ?? 0) * bestPaid.chance.expectedPerBooster
                           )}`
                         : ''
                     }
                   </div>
                 </div>

                 <div class="kp-section-title" style="margin-top:12px">Tous les boosters (${chase.length})</div>
                 <div class="kp-table">${chase.map(chaseRow).join('')}</div>`
        }
      </div>

      <div class="kp-section" style="margin-top:16px">
        <div class="kp-section-title">Combien rapporte un booster ?</div>

        <div class="kp-explain">
          <p>
            Un booster te donne <b>quelques cartes au hasard</b>. On calcule ce qu'elles valent en moyenne :
            pour chaque rareté, on multiplie le <b>nombre de cartes attendu</b> par le <b>prix moyen du marché</b>
            d'une carte de cette rareté, puis on additionne.
          </p>
          <p>
            Le <b>retour</b> compare cette valeur au prix du booster. <b>100 %</b> = tu récupères ta mise.
            En dessous, tu es perdant en moyenne — ce qui est normal : les boosters sont faits pour la collection, pas pour le profit.
          </p>
        </div>

        <div class="kp-toolbar" style="margin-top:10px">
          <button class="kp-btn" type="button" data-act="packs-averages" ${state.packAveragesLoading ? 'disabled' : ''}>
            ${state.packAveragesLoading ? '<span class="kp-spinner"></span> Calcul…' : 'Recalculer les prix moyens'}
          </button>
          <button class="kp-btn" type="button" data-act="packs-refresh" ${
            state.packsLoading || state.packPoolsLoading ? 'disabled' : ''
          }>Rafraîchir les boosters</button>
        </div>

        ${state.packsError ? `<div class="kp-alert is-bad" style="margin:8px 0">${esc(state.packsError)}</div>` : ''}

        ${
          averages.length
            ? `<div class="kp-explain-sub">Prix moyen d'une carte, par rareté (échantillon de 50 cartes réelles)</div>
               <div class="kp-chips" style="margin:6px 0 10px">
                 ${averages
                   .map((row) => {
                     const info = rarityInfo(row.rarity);
                     return `<span class="kp-chip" style="--rc:${info.color}"><em>${esc(info.label)}</em> ◆ ${fmt(row.avg)}</span>`;
                   })
                   .join('')}
               </div>`
            : ''
        }

        ${
          evRows.length
            ? `<div class="kp-table">
                 ${evRows
                   .map(({ pack, ev }) => {
                     const price = ev?.price ?? toNum(pack.chakraPrice);
                     const free = !price || price <= 0;
                     const gain = ev?.ratio != null && ev.ratio >= 1;
                     const lostPct = ev?.ratio != null ? Math.round((1 - ev.ratio) * 100) : null;
                     const gainPct = ev?.ratio != null && ev.ratio >= 1 ? Math.round((ev.ratio - 1) * 100) : null;
                     const tags = [];
                     if (pack.grantOnly) tags.push('<span class="kp-tag">récompense</span>');
                     if (pack.schedule) tags.push('<span class="kp-tag">limité</span>');

                     const detailRows = (ev?.breakdown ?? [])
                       .map(
                         (row) => `
                       <div class="kp-ev-row">
                         <span style="color:${rarityInfo(row.rarity).color}">${esc(rarityInfo(row.rarity).label)}</span>
                         <span>${formatCards(row.cards)}</span>
                         <span>${row.avg == null ? '?' : `× ◆ ${fmt(row.avg)}`}</span>
                         <b>${row.avg == null ? '—' : `◆ ${fmt(row.contribution)}`}</b>
                       </div>`
                       )
                       .join('');

                     const missingPrices = (ev?.breakdown ?? []).filter((row) => row.avg == null).length;

                     return `
                   <div class="kp-pack ${ev ? '' : 'is-dim'}">
                     <div class="kp-pack-head">
                       <b style="color:${esc(pack.color ?? '#f3f4f7')}">${esc(packName(pack))}</b>
                       <span class="kp-pack-price">${free ? (pack.usesFreePacks ? 'gratuit' : '—') : `◆ ${fmt(price)}`}</span>
                     </div>

                     <div class="kp-ev-main">
                       <span>tu récupères <b>◆ ${ev ? fmt(ev.ev) : '—'}</b></span>
                       ${
                         free
                           ? `<span class="kp-pill is-good">que du gain</span>`
                           : ev?.ratio != null
                             ? gain
                               ? `<span class="kp-pill is-good">+${gainPct} % de retour</span>`
                               : `<span class="kp-pill is-bad">−${lostPct} % de retour</span>`
                             : ''
                       }
                       ${tags.join('')}
                     </div>

                     ${
                       ev
                         ? `<div class="kp-ev-sentence">
                              ${ev.slots || '?'} cartes par booster · si tu en ouvres 100, tu récupères en moyenne
                              ◆ ${fmt(ev.ev * 100)}${free ? '' : ` pour ◆ ${fmt(price * 100)} dépensés`}.
                            </div>`
                         : ''
                     }

                     ${
                       ev
                         ? `<details class="kp-ev-detail">
                              <summary>Voir le détail du calcul</summary>
                              <div class="kp-ev-row is-head">
                                <span>Rareté</span><span>Cartes attendues</span><span>Prix moyen</span><span>Valeur</span>
                              </div>
                              ${detailRows}
                              <div class="kp-ev-row is-total">
                                <span>Total hors doré</span><span></span><span></span><b>◆ ${fmt(ev.evNormal)}</b>
                              </div>
                              <p class="kp-ev-note">
                                ${
                                  ev.goldenChance > 0
                                    ? `<b>Booster doré :</b> 1 sur ${ev.goldenEvery} est doré (meilleurs taux, valeur ◆ ${fmt(
                                        ev.evGolden
                                      )}). La moyenne affichée (◆ ${fmt(ev.ev)}) mélange les deux cas.`
                                    : 'Ce booster n’a pas de version dorée.'
                                }
                                ${missingPrices ? `<br>« ? » = aucune vente récente pour cette rareté : elle n’est pas comptée.` : ''}
                              </p>
                            </details>`
                         : ''
                     }
                   </div>`;
                   })
                   .join('')}
               </div>`
            : `<div class="kp-empty">${
                state.packsLoading || state.packAveragesLoading
                  ? '<span class="kp-spinner"></span> Calcul en cours…'
                  : 'Aucun booster chargé.'
              }</div>`
        }
      </div>
    `;
  }

  /* ------------------------------------------------------------------ */
  /* Auto-Open                                                           */
  /* ------------------------------------------------------------------ */

  const AUTO_IDLE_WAIT = 30000;
  const AUTO_IDLE_MAX = 5 * 60 * 1000;
  const AUTO_STALL_GRACE = 2 * 60 * 1000;
  const AUTO_ACTIVE_KEY = 'kyareeh.autoactive.v1';
  const AUTO_LOG_KEY = 'kyareeh.autolog.v1';
  const AUTO_REFRESH_DEFAULT = 10;
  const LISTING_SLOTS_FALLBACK = 10;

  /** Boosters cochés, dans l'ordre du serveur. */
  function autoSelectedPacks() {
    const packs = (state.packs ?? []).filter((pack) => pack && !pack.grantOnly);
    const ids = (state.settings.autoPackIds ?? []).map(String);
    return packs.filter((pack) => ids.includes(String(pack.id)));
  }

  async function loadPackState(force = false) {
    if (state.packStateLoading) return;
    if (state.packState && !force) return;
    state.packStateLoading = true;
    try {
      const data = await api('/api/me/packs', { timeout: 20000 });
      state.packState = data && typeof data === 'object' ? data : {};
    } catch {
      state.packState = state.packState ?? {};
    } finally {
      state.packStateLoading = false;
    }
    render();
  }

  /**
   * Combien de boosters de ce type le compte peut ouvrir maintenant.
   * `allowChakra = false` interdit la dépense : seuls les dons et les boosters offerts comptent.
   */
  function autoAvailability(pack, allowChakra = state.settings.autoAllowChakra !== false) {
    const price = Math.max(0, toNum(pack?.chakraPrice) ?? 0);
    const grants = Math.max(0, toNum(state.packState?.grants?.[String(pack?.id)]) ?? 0);
    const free = pack?.usesFreePacks
      ? Math.max(0, toNum(state.user?.freePacks) ?? 0) + Math.max(0, toNum(state.user?.bonusPacks) ?? 0)
      : 0;
    const chakra = Math.max(0, toNum(state.user?.chakra) ?? 0);
    const paid = allowChakra && price > 0 ? Math.floor(chakra / price) : 0;
    let total = grants + free + paid;

    // Limite quotidienne éventuelle du booster.
    const limitLeft = toNum(state.packState?.limits?.[String(pack?.id)]?.left);
    if (limitLeft != null) total = Math.min(total, grants + Math.max(0, limitLeft));

    return { price, grants, free, chakra, paid, total, limitLeft };
  }

  /**
   * Plan d'ouverture sur une sélection : dons par booster, puis boosters offerts (pool partagé),
   * puis chakra sur les boosters les moins chers.
   * `requested = 0` signifie « tout ce qui est possible ».
   */
  function autoPlan(packs, requested, allowChakra = state.settings.autoAllowChakra !== false) {
    const rows = packs.map((pack) => {
      const avail = autoAvailability(pack, allowChakra);
      return {
        price: avail.price,
        grants: avail.grants,
        freeEligible: pack.usesFreePacks === true,
        paidCap: avail.paid,
        limitLeft: avail.limitLeft
      };
    });

    const freePool = rows.some((row) => row.freeEligible)
      ? Math.max(0, toNum(state.user?.freePacks) ?? 0) + Math.max(0, toNum(state.user?.bonusPacks) ?? 0)
      : 0;

    let left = Math.max(0, Math.round(Number(requested) || 0)) || Infinity;
    let grants = 0;
    let free = 0;
    let paid = 0;
    let chakra = 0;

    for (const row of rows) {
      const use = Math.min(left, row.grants);
      grants += use;
      left -= use;
    }

    const freeUse = Math.min(left, freePool);
    free += freeUse;
    left -= freeUse;

    let chakraLeft = Math.max(0, toNum(state.user?.chakra) ?? 0);
    if (allowChakra) {
      const affordable = rows.filter((row) => row.paidCap > 0).sort((x, y) => x.price - y.price);
      for (const row of affordable) {
        if (left <= 0) break;
        const capped = row.limitLeft == null ? Infinity : Math.max(0, row.limitLeft - row.grants);
        const use = Math.min(left, row.paidCap, capped, Math.floor(chakraLeft / row.price));
        if (use <= 0) continue;
        paid += use;
        left -= use;
        chakra += use * row.price;
        chakraLeft -= use * row.price;
      }
    }

    return {
      total: grants + free + paid,
      grants,
      free,
      paid,
      chakra,
      missing: Number.isFinite(left) ? Math.max(0, left) : 0
    };
  }

  function autoPoolTotal(packs, allowChakra = state.settings.autoAllowChakra !== false) {
    return autoPlan(packs, 0, allowChakra).total;
  }

  /** Répartition du coût de n ouvertures : dons, gratuits, puis chakra (si autorisé). */
  function autoCost(pack, n, allowChakra = state.settings.autoAllowChakra !== false) {
    let left = Math.max(0, Math.round(n));
    const grants = Math.max(0, toNum(state.packState?.grants?.[String(pack?.id)]) ?? 0);
    const grantUse = Math.min(left, grants);
    left -= grantUse;

    let freeUse = 0;
    let bonusUse = 0;
    if (pack?.usesFreePacks) {
      const free = Math.max(0, toNum(state.user?.freePacks) ?? 0);
      freeUse = Math.min(left, free);
      left -= freeUse;
      const bonus = Math.max(0, toNum(state.user?.bonusPacks) ?? 0);
      bonusUse = Math.min(left, bonus);
      left -= bonusUse;
    }

    const price = Math.max(0, toNum(pack?.chakraPrice) ?? 0);
    const paid = allowChakra ? left : 0;
    return { grants: grantUse, free: freeUse, bonus: bonusUse, paid, chakra: paid * price, short: left - paid };
  }

  /** Tire au hasard un booster parmi ceux qui ont encore des ouvertures possibles. */
  function pickAutoPack(packs) {
    const ready = packs.filter((pack) => autoAvailability(pack).total > 0);
    if (!ready.length) return null;
    return ready[Math.floor(Math.random() * ready.length)];
  }

  /**
   * Cadence des ouvertures — formule d'Axel :
   *
   *   T_max = (9 − B) × I + R
   *
   *   B = boosters actuellement dans la jauge (freePacks)
   *   I = intervalle de régénération du jeu (10 min)
   *   R = temps réel restant avant le prochain booster (nextFreeAt de /api/me)
   *
   * Le délai tiré est un nombre ENTIER de minutes entre 1 et T_max.
   * Ouvrir un booster ne remet pas le chrono à zéro : R vient toujours du serveur.
   *
   *   B=2, R=10 → T_max = 80 min
   *   B=9, R=10 → T_max = 10 min
   *   B=10      → ouverture immédiate
   */
  const AUTO_SOFT_CAP = 9;
  const AUTO_STACK_FALLBACK = 10;
  const AUTO_REGEN_FALLBACK_MIN = 10;

  function autoStackMax() {
    const fromUser = toNum(state.user?.freePacksMax);
    const fromCfg = toNum(state.config?.freePacks?.max);
    return Math.max(1, Math.round(fromUser ?? fromCfg ?? AUTO_STACK_FALLBACK));
  }

  /** État réel de la jauge : B, son maximum et R (minutes avant le prochain gain). */
  function autoRegenInfo() {
    const max = autoStackMax();
    const boosters = Math.min(max, Math.max(0, toNum(state.user?.freePacks) ?? 0));
    const raw =
      state.user?.nextFreeAt ??
      state.user?.nextFreePackAt ??
      state.user?.freePackAt ??
      state.user?.nextFree ??
      null;
    const stamp = raw ? Date.parse(raw) : NaN;
    const hasStamp = Number.isFinite(stamp);

    // R = temps réel restant. Le serveur peut renvoyer une date déjà passée
    // (gain imminent, latence) : on considère alors R = 0.
    const remainingMin = hasStamp ? Math.max(0, (stamp - Date.now()) / 60000) : AUTO_REGEN_FALLBACK_MIN;

    return {
      boosters,
      max,
      remainingMin,
      nextAt: hasStamp ? stamp : 0,
      source: hasStamp ? 'api' : 'estimé'
    };
  }

  /** Bornes du délai : entier de minutes entre 1 et T_max, ou 0 pour ouvrir tout de suite. */
  function autoDelayRange(regen = autoRegenInfo()) {
    const intervalMin = Math.min(60, Math.max(1, Number(state.settings.autoMaxPerBoosterMin) || AUTO_REGEN_FALLBACK_MIN));
    const boosters = regen.boosters;
    const remainingMin = Math.max(0, regen.remainingMin);
    const slots = Math.max(0, AUTO_SOFT_CAP - boosters);
    const rawMax = slots * intervalMin + remainingMin;
    const maxMin = Math.floor(rawMax);

    // Jauge pleine, ou T_max sous la minute : on ouvre sans attendre.
    const immediate = boosters >= regen.max || maxMin < 1;

    return {
      min: 60000,
      max: immediate ? 0 : maxMin * 60000,
      maxMin,
      boosters,
      maxBoosters: regen.max,
      remainingMin,
      slots,
      intervalMin,
      immediate,
      source: regen.source,
      formula: `(9 − ${boosters}) × ${intervalMin} + ${Math.round(remainingMin * 10) / 10}`
    };
  }

  /** Délai tiré au hasard : un entier de minutes entre 1 et T_max. */
  function autoDelay(regen = autoRegenInfo()) {
    const range = autoDelayRange(regen);
    if (range.immediate) return 0;
    return (1 + Math.floor(Math.random() * range.maxMin)) * 60000;
  }

  /* --- Anti-AFK ------------------------------------------------------ */

  const AFK_MIN_DELAY = 2000;
  const AFK_MAX_DELAY = 60000;
  // Si la boîte est toujours là malgré le clic, on retente au bout de 2 min.
  const AFK_RETRY_MS = 2 * 60 * 1000;

  // Texte de la boîte de présence du site : « Tu es toujours là ? ».
  const AFK_TITLE_RE =
    /(tu\s+es\s+toujours\s+l[àa]|es[-\s]?tu\s+(toujours\s+)?l[àa]|toujours\s+l[àa]\s*\?|still\s+(there|here)\??|are\s+you\s+(still\s+)?(there|here))/i;
  const AFK_CONTEXT_RE =
    /(toujours\s+l[àa]|still\s+(there|here)|are\s+you\s+(still\s+)?(there|here)|anti[-\s]?afk|inactivit[ée]|absence)/i;
  // Libellés de confirmation acceptés (« Je suis là » sur le site).
  const AFK_LABEL_RE =
    /^(oui|yes|okay|ok|je\s+suis\s+(toujours\s+)?l[àa]|toujours\s+l[àa]|pr[ée]sent(e)?|me\s+voil[àa]|i\s*'?\s*m\s+here)(?![a-zà-ÿ])/i;

  let afkTimer = null;
  let afkScanTimer = null;
  let afkObserver = null;
  let afkLastScan = 0;
  let afkHandledEl = null;
  let afkHandledAt = 0;

  function isShown(el) {
    if (!el || !el.isConnected) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return false;
    const style = window.getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity || 1) > 0.05;
  }

  function afkLabelOf(btn) {
    return String(btn?.innerText || btn?.value || btn?.getAttribute?.('aria-label') || '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /** Conteneur de la boîte de présence, repéré par son texte. */
  function findAfkContainer() {
    const nodes = document.querySelectorAll(
      '[role="dialog"], [aria-modal="true"], [class*="modal" i], [class*="dialog" i], [class*="overlay" i], [class*="popup" i], [class*="gate" i]'
    );
    for (const node of nodes) {
      if (host && (host === node || host.contains(node))) continue;
      if (!isShown(node)) continue;
      const text = String(node.innerText || '').slice(0, 600);
      if (!text) continue;
      // Soit le titre exact, soit un texte de présence avec une question.
      if (AFK_TITLE_RE.test(text) || (AFK_CONTEXT_RE.test(text) && text.includes('?'))) return node;
    }
    return null;
  }

  /** Bouton de confirmation dans une boîte donnée (repli : premier bouton visible). */
  function afkConfirmIn(root) {
    const buttons = root.querySelectorAll('button, [role="button"], input[type="button"], input[type="submit"]');
    let fallback = null;
    for (const btn of buttons) {
      if (host && host.contains(btn)) continue;
      if (!isShown(btn) || btn.disabled) continue;
      if (AFK_LABEL_RE.test(afkLabelOf(btn))) return btn;
      if (!fallback) fallback = btn;
    }
    return fallback;
  }

  /**
   * Cherche le bouton de confirmation anti-AFK.
   * 1) boîte de présence détectée par son texte → son bouton ;
   * 2) sinon, bouton dont le libellé correspond ET dont un ancêtre parle de présence.
   */
  function findAfkButton() {
    const container = findAfkContainer();
    if (container) {
      const btn = afkConfirmIn(container);
      if (btn) return btn;
    }

    const buttons = document.querySelectorAll(
      'button, [role="button"], input[type="button"], input[type="submit"], a[class*="btn"], a[class*="button"]'
    );
    for (const btn of buttons) {
      if (host && (host === btn || host.contains(btn))) continue;
      if (!isShown(btn) || btn.disabled) continue;
      if (!AFK_LABEL_RE.test(afkLabelOf(btn))) continue;

      // Remonte jusqu'à 8 ancêtres pour lire le texte de la boîte.
      let node = btn;
      for (let i = 0; i < 8 && node; i += 1) {
        node = node.parentElement;
        if (!node) break;
        const text = String(node.innerText || '');
        if (text.length > 2000) break;
        if (AFK_CONTEXT_RE.test(text)) return btn;
      }
    }
    return null;
  }

  function afkClick(target) {
    if (!target || !target.isConnected) return false;
    try {
      target.scrollIntoView({ block: 'center', inline: 'center' });
    } catch {
      /* ignore */
    }
    try {
      target.click();
    } catch {
      return false;
    }
    return true;
  }

  /** Clic « complet » pour les composants qui écoutent les évènements souris. */
  function afkMouseClick(target) {
    if (!target || !target.isConnected) return false;
    const options = { bubbles: true, cancelable: true, view: window, button: 0 };
    try {
      target.dispatchEvent(new MouseEvent('pointerdown', options));
      target.dispatchEvent(new MouseEvent('mousedown', options));
      target.dispatchEvent(new MouseEvent('pointerup', options));
      target.dispatchEvent(new MouseEvent('mouseup', options));
      return true;
    } catch {
      return false;
    }
  }

  function scheduleAfkConfirm() {
    if (state.settings.antiAfk === false) return;
    if (afkTimer) return;

    const target = findAfkButton();
    if (!target) {
      // La boîte a disparu : on autorise la prochaine détection.
      afkHandledEl = null;
      return;
    }

    // Même boîte déjà traitée : on ne répond pas une deuxième fois trop vite.
    if (target === afkHandledEl && Date.now() - afkHandledAt < AFK_RETRY_MS) return;

    const delay = Math.round(AFK_MIN_DELAY + Math.random() * (AFK_MAX_DELAY - AFK_MIN_DELAY));
    afkHandledEl = target;
    afkHandledAt = Date.now();
    state.antiAfk = { ...(state.antiAfk ?? {}), pendingAt: Date.now(), pendingDelay: delay };
    autoLog(`anti-AFK détecté : réponse dans ${Math.round(delay / 1000)} s`);
    notify(`Anti-AFK détecté : réponse dans ${Math.round(delay / 1000)} s.`);

    afkTimer = setTimeout(() => {
      afkTimer = null;
      // La boîte a pu être reconstruite entre-temps : on relit l'élément.
      const live = findAfkButton();
      const node = live ?? (target.isConnected ? target : null);
      const label = afkLabelOf(node) || 'Je suis là';
      const clicked = node ? afkClick(node) : false;

      if (clicked) {
        state.antiAfk = {
          ...(state.antiAfk ?? {}),
          lastAt: Date.now(),
          lastDelay: delay,
          clicks: (state.antiAfk?.clicks ?? 0) + 1,
          pendingAt: 0
        };
        autoLog(`anti-AFK : « ${label.slice(0, 24)} » cliqué (délai ${Math.round(delay / 1000)} s)`);
        notify(`Anti-AFK : « ${label.slice(0, 24)} » cliqué.`);
      } else {
        autoLog('anti-AFK : la boîte a disparu avant la réponse');
        notify('Anti-AFK : la boîte a disparu avant la réponse.');
      }

      // Le site peut ignorer un clic synthétique : on vérifie et on retente une fois.
      setTimeout(() => {
        if (!findAfkContainer()) return;
        const again = findAfkButton();
        if (!again) return;
        afkMouseClick(again);
        autoLog('anti-AFK : toujours affiché, seconde tentative en évènements souris');
      }, 1500);

      render();
      // Un nouveau contrôle peut arriver plus tard.
      setTimeout(() => {
        afkHandledEl = null;
        scanAfk();
      }, 4000);
    }, delay);

    render();
  }

  function scanAfk() {
    if (state.settings.antiAfk === false) return;
    if (afkTimer) return;
    // Le DOM du site bouge beaucoup : on limite les scans à un par seconde.
    const now = Date.now();
    if (now - afkLastScan < 1000) return;
    afkLastScan = now;
    scheduleAfkConfirm();
  }

  function installAntiAfk() {
    if (afkObserver) return;
    try {
      afkObserver = new MutationObserver(() => scanAfk());
      afkObserver.observe(document.documentElement, { childList: true, subtree: true });
    } catch {
      /* document pas prêt : le scan périodique suffit */
    }
    // Filet de sécurité : certains contrôles apparaissent sans mutation exploitable.
    if (!afkScanTimer) afkScanTimer = setInterval(scanAfk, 3000);
  }

  /* --- Son ---------------------------------------------------------- */

  let audioCtx = null;

  function primeAudio() {
    if (state.settings.autoSound === false) return;
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      audioCtx = audioCtx || new Ctx();
      if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
    } catch {
      /* audio indisponible */
    }
  }

  function playOpenSound(tier = 0) {
    if (state.settings.autoSound === false) return;
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      audioCtx = audioCtx || new Ctx();
      if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});

      // Un petit carillon : une note simple, ou un arpège pour les hautes raretés.
      const notes = tier >= 2 ? [784, 1046, 1318] : tier >= 1 ? [698, 932] : [620];
      const now = audioCtx.currentTime;
      notes.forEach((freq, index) => {
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        const start = now + index * 0.07;
        osc.type = tier >= 1 ? 'triangle' : 'sine';
        osc.frequency.setValueAtTime(freq, start);
        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.exponentialRampToValueAtTime(0.07, start + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.16);
        osc.connect(gain).connect(audioCtx.destination);
        osc.start(start);
        osc.stop(start + 0.18);
      });
    } catch {
      /* audio indisponible : on continue sans bruit */
    }
  }

  /** Niveau sonore d'un tirage : 0 = commun, 1 = rare/épique, 2 = légendaire et plus. */
  function pulledTier(cards) {
    let top = -1;
    for (const card of cards) top = Math.max(top, RARITY_ORDER.indexOf(card.rarity));
    if (top >= RARITY_ORDER.indexOf('L')) return 2;
    if (top >= RARITY_ORDER.indexOf('R')) return 1;
    return 0;
  }

  /** Applique localement ce que le serveur vient de consommer. */
  function consumeAutoCost(pack, cost) {
    if (state.packState?.grants && typeof state.packState.grants === 'object') {
      const key = String(pack?.id);
      state.packState.grants[key] = Math.max(0, (toNum(state.packState.grants[key]) ?? 0) - cost.grants);
    }
    if (cost.free || cost.bonus) {
      state.user = {
        ...(state.user ?? {}),
        freePacks: Math.max(0, (toNum(state.user?.freePacks) ?? 0) - cost.free),
        bonusPacks: Math.max(0, (toNum(state.user?.bonusPacks) ?? 0) - cost.bonus)
      };
    }
    if (cost.chakra) {
      state.user = { ...(state.user ?? {}), chakra: Math.max(0, (toNum(state.user?.chakra) ?? 0) - cost.chakra) };
    }
  }

  function autoCard(raw) {
    const card = raw?.character ?? raw?.card ?? raw;
    const id = card?.id ?? card?.characterId ?? raw?.characterId ?? raw?.id ?? '';
    const known = state.characters.get(String(id)) ?? {};
    return {
      id: String(id),
      name: card?.name ?? known.name ?? `Carte #${id || '?'}`,
      rarity: String(card?.rarity ?? known.rarity ?? 'C').toUpperCase(),
      image: card?.image ?? known.image ?? '',
      series: card?.series ?? known.series ?? ''
    };
  }

  // Cartes mémorisées dans « Meilleures trouvailles » (Épique et au-dessus).
  const BEST_MIN_RARITY = 'E';
  const BEST_KEEP = 80;

  /**
   * Mémorise les belles cartes dans un pool qui ne dépend plus des 60 dernières.
   * Avant, `best` était recalculé à partir de `a.cards` (limité à 60) : après une
   * longue session, une Mythique tirée plus tôt disparaissait de l'affichage.
   */
  function trackBestCards(pulled) {
    const a = state.autoOpen;
    if (!Array.isArray(a.bestAll)) a.bestAll = [];
    const minRank = RARITY_ORDER.indexOf(BEST_MIN_RARITY);
    for (const card of pulled) {
      if (RARITY_ORDER.indexOf(card.rarity) < minRank) continue;
      const key = `${card.id}:${card.rarity}`;
      const known = a.bestAll.find((entry) => `${entry.id}:${entry.rarity}` === key);
      if (known) known.qty = (known.qty ?? 1) + 1;
      else a.bestAll.push({ ...card, qty: 1, at: Date.now() });
    }
    // On garde les plus rares si le pool devient trop gros.
    if (a.bestAll.length > BEST_KEEP) {
      a.bestAll = [...a.bestAll]
        .sort((x, y) => RARITY_ORDER.indexOf(y.rarity) - RARITY_ORDER.indexOf(x.rarity))
        .slice(0, BEST_KEEP);
    }
    a.best = [...a.bestAll]
      .sort(
        (x, y) =>
          RARITY_ORDER.indexOf(y.rarity) - RARITY_ORDER.indexOf(x.rarity) ||
          (y.at ?? 0) - (x.at ?? 0)
      )
      .slice(0, 8);
  }

  function recordAutoResults(pack, results, cost, requested) {
    const a = state.autoOpen;
    a.opened += results.length || requested;
    a.spent += cost.chakra;
    consumeAutoCost(pack, cost);

    const pulled = [];
    for (const result of results) {
      if (result?.golden) a.golden += 1;
      if (result?.godPack) a.godPacks += 1;
      const list = Array.isArray(result?.cards) ? result.cards : [];
      for (const raw of list) pulled.push(autoCard(raw));
    }

    a.cardCount += pulled.length;
    for (const card of pulled) a.counts[card.rarity] = (a.counts[card.rarity] ?? 0) + 1;

    if (pulled.length) {
      a.cards = [...pulled.slice().reverse(), ...a.cards].slice(0, 60);
      trackBestCards(pulled);
    }

    if (state.settings.autoStopRare && pulled.length) {
      const top = pulled.reduce((rank, card) => Math.max(rank, RARITY_ORDER.indexOf(card.rarity)), -1);
      if (top >= RARITY_ORDER.indexOf('L')) {
        const found = pulled.find((card) => RARITY_ORDER.indexOf(card.rarity) === top);
        a.stop = true;
        a.status = `Arrêté : ${rarityInfo(found?.rarity).label} trouvée — ${found?.name ?? 'carte'} !`;
      }
    }

    return pulled;
  }

  /* --- Journal de la boucle ----------------------------------------- */

  let autoLogTimer = null;
  let autoPersistTimer = null;

  /**
   * Trace horodatée de tout ce que fait l'auto-open (ouvertures, attentes, erreurs,
   * relances). Persistée dans le stockage de l'extension pour pouvoir comprendre
   * après coup pourquoi la boucle s'est arrêtée pendant la nuit.
   */
  function autoLog(message) {
    const a = state.autoOpen;
    const entry = { t: Date.now(), m: String(message) };
    a.log = [...(a.log ?? []), entry].slice(-80);
    if (autoLogTimer) return;
    autoLogTimer = setTimeout(() => {
      autoLogTimer = null;
      storageGet(AUTO_LOG_KEY, []).then((saved) => {
        const list = Array.isArray(saved) ? saved : [];
        const seen = new Set(list.map((e) => `${e.t}:${e.m}`));
        const fresh = (state.autoOpen.log ?? []).filter((e) => !seen.has(`${e.t}:${e.m}`));
        storageSet(AUTO_LOG_KEY, [...list, ...fresh].slice(-250));
      });
    }, 2000);
  }

  function fmtClock(ts) {
    try {
      return new Date(ts).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    } catch {
      return '--:--:--';
    }
  }

  /** Sauvegarde les compteurs et le drapeau de reprise (throttlé). */
  function persistAutoSoon() {
    if (autoPersistTimer) return;
    autoPersistTimer = setTimeout(() => {
      autoPersistTimer = null;
      const a = state.autoOpen;
      const alive = a.running && !a.stop;
      storageSet(
        AUTO_ACTIVE_KEY,
        alive
          ? {
              at: Date.now(),
              opened: a.opened,
              spent: a.spent,
              cardCount: a.cardCount,
              lastOpenAt: a.lastOpenAt || 0
            }
          : { at: 0 }
      );
    }, 1500);
  }

  async function loadAutoLog() {
    const saved = await storageGet(AUTO_LOG_KEY, []);
    if (Array.isArray(saved)) state.autoOpen.log = saved.slice(-80);
  }

  /** Dormir, mais se réveiller tout de suite si l'utilisateur clique sur « Arrêter ». */
  let autoSleepCancel = null;
  function autoSleep(ms) {
    return new Promise((resolve) => {
      const a = state.autoOpen;
      if (a.stop) {
        resolve();
        return;
      }
      let done = false;
      const end = Date.now() + Math.max(0, ms);
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (autoSleepCancel === finish) autoSleepCancel = null;
        a.wakeAt = 0;
        resolve();
      };
      const timer = setTimeout(finish, Math.max(0, ms));
      autoSleepCancel = finish;
      // Le watchdog compare cette échéance : si elle est dépassée sans réveil,
      // c'est que les timers de l'onglet ont été gelés et on relance la boucle.
      a.wakeAt = end;
    });
  }

  /** Met à jour uniquement le compteur affiché, sans reconstruire le panneau. */
  function updateCountdownText() {
    const el = qs('[data-countdown]');
    if (!el) return;
    const a = state.autoOpen;
    el.textContent = a.nextAt ? fmtWait(Math.max(0, a.nextAt - Date.now())) : '';
  }

  function autoStoppedText(stopped) {
    const code = String(stopped?.code ?? stopped?.reason ?? '');
    const map = {
      guest_limit: 'compte invité : connecte-toi avec Discord',
      no_funds: 'chakra insuffisant',
      insufficient_chakra: 'chakra insuffisant',
      rate_limited: 'trop de requêtes',
      limit: 'limite atteinte',
      daily_limit: 'limite quotidienne atteinte',
      no_packs: 'plus de boosters disponibles',
      pass_required: 'laissez-passer expiré'
    };
    return map[code] || code || 'raison inconnue';
  }

  async function startAutoOpen(opts = {}) {
    const a = state.autoOpen;
    if (a.running) return;

    if (!state.packs?.length) await loadPacks();

    // Aucune sélection : on prend le premier booster achetable (utile au redémarrage).
    if (!autoSelectedPacks().length && (state.packs ?? []).length && !state.settings.autoPackPicked) {
      const first = state.packs.find((pack) => pack && !pack.grantOnly);
      if (first) state.settings.autoPackIds = [String(first.id)];
    }

    await loadPackState(true).catch(() => {});
    // On relit le compte juste avant : le chakra et les boosters gratuits ont pu bouger.
    try {
      const me = await api('/api/me', { timeout: 15000 });
      if (me && typeof me === 'object') mergeUser(me);
    } catch {
      /* on garde les valeurs connues */
    }

    // Compteurs repris d'une session interrompue par un rechargement de page.
    let saved = null;
    if (opts.resume) {
      saved = await storageGet(AUTO_ACTIVE_KEY, null);
      if (saved && !(Number(saved.at) > 0 && Date.now() - Number(saved.at) < 12 * 3600 * 1000)) saved = null;
    }

    Object.assign(a, {
      running: true,
      stop: false,
      opened: Number(saved?.opened) || 0,
      spent: Number(saved?.spent) || 0,
      cardCount: Number(saved?.cardCount) || 0,
      cards: [],
      best: [],
      bestAll: [],
      counts: {},
      golden: 0,
      godPacks: 0,
      error: null,
      passNeeded: false,
      status: opts.resume ? 'Reprise de l’auto-open…' : 'Auto-open activé · en attente de boosters…',
      startedAt: Date.now(),
      beatAt: Date.now(),
      wakeAt: 0,
      lastOpenAt: Number(saved?.lastOpenAt) || 0,
      nextGapMs: 0,
      nextAt: 0
    });
    autoLog(opts.resume ? 'reprise après rechargement' : 'auto-open démarré');
    // Le drapeau permet de reprendre après un rechargement de page.
    persistAutoSoon();
    await persistSettings();
    render();

    await autoOpenLoop();
  }

  /**
   * Cœur de l'auto-open. Rien ne doit pouvoir en sortir par une exception :
   * tout le corps est protégé, et un watchdog relance la boucle si elle se tait.
   */
  async function autoOpenLoop() {
    const a = state.autoOpen;
    const gen = ++a.gen;
    const alive = () => !a.stop && a.gen === gen;
    let rateHits = 0;
    let idleStep = 0;
    let idleReason = '';
    const allowChakra = state.settings.autoAllowChakra !== false;
    while (alive()) {
      a.beatAt = Date.now();
      try {
        // Étape 4 : après une attente, on relit l'état réel (B et R) avant de décider.
        await autoSyncIfStale();
        if (!alive()) break;
        const packs = autoSelectedPacks();
        if (!packs.length) {
          // Aucune sélection : on ne s'arrête pas, on réessaie (le compte peut changer).
          a.status = 'En attente : aucun booster sélectionné';
          render();
          await autoSleep(AUTO_IDLE_WAIT);
          if (!alive()) break;
          await loadPacks(true).catch(() => {});
          continue;
        }

        const pack = pickAutoPack(packs);
        if (!pack) {
          // Plus rien à ouvrir : on patiente et on re-vérifie le compte régulièrement.
          idleStep = Math.min(idleStep + 1, 5);
          const wait = Math.min(AUTO_IDLE_MAX, AUTO_IDLE_WAIT * idleStep);
          // Décompte des ressources pour que le statut explique le blocage.
          let grants = 0;
          let free = 0;
          for (const item of packs) {
            grants += Math.max(0, toNum(state.packState?.grants?.[String(item.id)]) ?? 0);
            if (item.usesFreePacks) {
              free += Math.max(0, toNum(state.user?.freePacks) ?? 0) + Math.max(0, toNum(state.user?.bonusPacks) ?? 0);
            }
          }
          const chakra = Math.max(0, toNum(state.user?.chakra) ?? 0);
          const reason = `dons ${grants} · offerts ${free} · chakra ${chakra}`;
          a.status = `En attente de boosters (${reason}) · ${a.opened} ouvert(s)`;
          if (reason !== idleReason) {
            idleReason = reason;
            autoLog(`en attente : ${reason}${allowChakra ? '' : ' (chakra non autorisé)'}`);
          }
          render();
          await autoSleep(wait);
          if (!alive()) break;
          await refreshAutoAccount();
          continue;
        }

        const cost = autoCost(pack, 1, allowChakra);

        let data;
        try {
          data = await api(`/api/packs/${encodeURIComponent(pack.id)}/open-many`, {
            method: 'POST',
            body: { count: 1, maxChakra: cost.chakra },
            timeout: 45000
          });
        } catch (err) {
          const code = err?.code ?? (err?.message === 'pass_required' ? 'pass_required' : null);
          if (code === 'pass_required') {
            a.passNeeded = true;
            a.status = 'Laissez-passer expiré : ouvre un booster une fois sur le site, puis relance.';
            autoLog('laissez-passer expiré : boucle en pause');
            break;
          }
          if (code === 'insufficient_chakra' || code === 'no_funds') {
            // Pas d'arrêt : le chakra revient avec le temps, on patiente.
            a.status = `En attente de chakra… ${a.opened} ouvert(s)`;
            autoLog('chakra insuffisant : attente');
            render();
            await autoSleep(AUTO_IDLE_WAIT);
            if (!alive()) break;
            await refreshAutoAccount();
            continue;
          }
          if (code === 'rate_limited' || err?.status === 429) {
            rateHits = Math.min(rateHits + 1, 5);
            const wait = Math.min(10 * 60 * 1000, 4000 * 2 ** rateHits);
            a.status = `Trop de requêtes : pause ${Math.round(wait / 1000)} s…`;
            autoLog(`limite de requêtes (${rateHits}) : pause ${Math.round(wait / 1000)} s`);
            render();
            await autoSleep(wait);
            continue;
          }
          // Erreur réseau / 5xx : on ne s'arrête pas, on retente.
          const msg = friendlyError(err);
          a.status = `Erreur : ${msg} · nouvelle tentative dans 1 min`;
          autoLog(`échec d'ouverture : ${msg}`);
          render();
          await autoSleep(60000);
          continue;
        }

        const results = Array.isArray(data?.results) ? data.results : [];
        if (!results.length) {
          const why = data?.stopped ? autoStoppedText(data.stopped) : 'réponse vide';
          a.status = `En attente : ${why} · ${a.opened} ouvert(s)`;
          autoLog(`aucune carte renvoyée (${why})`);
          render();
          await autoSleep(AUTO_IDLE_WAIT);
          if (!alive()) break;
          await refreshAutoAccount();
          continue;
        }

        const pulled = recordAutoResults(pack, results, cost, 1);
        if (data?.user && typeof data.user === 'object') mergeUser(data.user);
        rateHits = 0;
        idleStep = 0;
        a.lastOpenAt = Date.now();
        persistAutoSoon();

        autoLog(
          `ouvert ${packName(pack)} → ${pulled.length} carte(s)` +
            (pulled.length ? ` : ${pulled.map((c) => `${c.name} (${c.rarity})`).slice(0, 4).join(', ')}` : '')
        );

        // Un bruit par booster ouvert, plus riche si une belle carte tombe.
        try {
          playOpenSound(pulledTier(pulled));
        } catch {
          /* audio indisponible : on continue */
        }

        if (data?.stopped) {
          // Le serveur signale une limite : on continue de veiller, sans rien ouvrir.
          const why = autoStoppedText(data.stopped);
          autoLog(`serveur : ${why} — attente`);
          a.status = `En attente : ${why} · ${a.opened} ouvert(s)`;
          render();
          await autoSleep(AUTO_IDLE_WAIT);
          if (!alive()) break;
          await refreshAutoAccount();
          continue;
        }

        a.status = `Ouverture… ${a.opened} · ${packName(pack)}`;
        render();
      } catch (err) {
        // Filet de sécurité : aucune exception ne doit tuer la boucle.
        const msg = friendlyError(err);
        autoLog(`erreur interne : ${msg}`);
        a.status = `Reprise après erreur : ${msg}`;
        try {
          render();
        } catch {
          /* rendu déjà protégé */
        }
        await autoSleep(15000);
        continue;
      }

      if (!a.stop && a.gen === gen) {
        // Étape 4 : l'état réel a pu changer pendant l'attente/ouverture.
        // On relit le compte (throttlé) pour avoir le vrai B et le vrai R.
        await autoSyncIfStale().catch(() => {});
        if (!alive()) break;

        const regen = autoRegenInfo();
        const range = autoDelayRange(regen);
        const delay = autoDelay(regen);
        a.nextGapMs = delay;
        a.status = range.immediate
          ? `Ouverture… ${a.opened} · jauge ${range.boosters}/${range.maxBoosters} : ouverture immédiate`
          : `Ouverture… ${a.opened} · prochain dans ${fmtWait(delay)} (max ${fmtWait(range.max)} = T_max = ${range.formula})`;
        autoLog(
          range.immediate
            ? `jauge ${range.boosters}/${range.maxBoosters} : ouverture immédiate`
            : `délai ${Math.round(delay / 60000)} min (T_max ${range.maxMin} min = ${range.formula}, R ${
                Math.round(range.remainingMin * 10) / 10
              } min, source ${range.source})`
        );
        // Le compte à rebours doit exister avant le rendu, sinon le bloc n'apparaît pas.
        a.nextAt = delay ? Date.now() + delay : 0;
        render();
        if (delay) await autoSleep(delay);
        a.nextAt = 0;
        a.nextGapMs = 0;
      }
    }

    // Une boucle plus récente (watchdog) a pris le relais : on ne touche à rien.
    if (a.gen !== gen) return;

    a.running = false;
    // Le drapeau de reprise ne survit qu'à un rechargement de page, pas à un arrêt.
    await storageSet(AUTO_ACTIVE_KEY, { at: 0 });
    if (a.stop) {
      a.status = `Arrêté : ${a.opened} booster(s), ${a.cardCount} carte(s) pour ◆ ${fmt(a.spent)}.`;
    } else if (!a.error) {
      a.status = `Terminé : ${a.opened} booster(s), ${a.cardCount} carte(s) pour ◆ ${fmt(a.spent)}.`;
    }
    autoLog(a.status);
    render();
    notify(a.status);
    refreshLight();
  }

  /** Relit le compte et les boosters sans jamais casser la boucle. */
  async function refreshAutoAccount() {
    try {
      const me = await api('/api/me', { timeout: 15000 });
      if (me && typeof me === 'object') mergeUser(me);
    } catch {
      /* on réessaiera */
    }
    state.lastAutoSync = Date.now();
    await loadPackState(true).catch(() => {});
    await loadPacks(true).catch(() => {});
  }

  /** Évite de marteler l'API : une synchro au plus toutes les 45 s. */
  async function autoSyncIfStale(maxAgeMs = 45000) {
    if (Date.now() - (state.lastAutoSync || 0) < maxAgeMs) return;
    await refreshAutoAccount();
  }

  /**
   * Watchdog : si la boucle est déclarée active mais qu'elle ne s'est pas réveillée
   * à l'heure prévue (timer gelé, onglet suspendu, exception avalée), on la relance.
   */
  function ensureAutoAlive() {
    const a = state.autoOpen;
    if (!a.running || a.stop) return;
    const now = Date.now();
    const overdue = a.wakeAt ? now - a.wakeAt : now - (a.beatAt || a.startedAt || now);
    if (overdue < AUTO_STALL_GRACE) return;

    a.restarts = (a.restarts ?? 0) + 1;
    autoLog(`boucle silencieuse depuis ${fmtWait(overdue)} : relance automatique`);
    a.status = 'Relance automatique de la boucle…';
    a.gen += 1; // invalide l'ancienne boucle
    a.wakeAt = 0;
    if (autoSleepCancel) autoSleepCancel();
    render();
    autoOpenLoop();
  }

  function stopAutoOpen() {
    const a = state.autoOpen;
    if (!a.running) return;
    a.stop = true;
    a.status = 'Arrêt demandé…';
    autoLog('arrêt demandé');
    if (autoSleepCancel) autoSleepCancel();
    render();
  }

  /** Coût estimé de n ouvertures réparties sur une sélection (offerts d'abord, puis le moins cher). */
  function autoEstimateCost(packs, n, allowChakra = state.settings.autoAllowChakra !== false) {
    return autoPlan(packs, n, allowChakra);
  }

  function viewAuto() {
    if (!state.user) return loginHTML();
    if (!state.packs && !state.packsLoading) loadPacks();
    if (!state.packState && !state.packStateLoading) loadPackState();

    const a = state.autoOpen;
    const packs = (state.packs ?? []).filter((pack) => pack && !pack.grantOnly);
    const selected = autoSelectedPacks();
    const selectedIds = new Set(selected.map((pack) => String(pack.id)));
    const allowChakra = state.settings.autoAllowChakra !== false;

    const total = autoPoolTotal(selected, allowChakra);
    const estimate = autoEstimateCost(selected, total, allowChakra);
    const perBoosterMin = Math.min(60, Math.max(1, Number(state.settings.autoMaxPerBoosterMin) || 10));
    const regen = autoRegenInfo();
    const delayRange = autoDelayRange(regen);
    const maxLabel = delayRange.immediate ? 'immédiat' : fmtWait(delayRange.max);
    const refreshMin = Math.min(120, Math.max(1, Math.round(Number(state.settings.autoRefreshMin) || 10)));
    const passPack = selected[0] ?? packs[0] ?? null;

    const packButton = (pack) => {
      const left = autoAvailability(pack, allowChakra);
      const price = toNum(pack.chakraPrice);
      const isActive = selectedIds.has(String(pack.id));
      return `
        <button class="kp-autopack ${isActive ? 'is-active' : ''}" type="button" data-act="auto-pack" data-id="${esc(pack.id)}" style="--rc:${esc(pack.color ?? '#ff4d2e')}" role="checkbox" aria-checked="${isActive}">
          <span class="kp-autopack-tick">${isActive ? '✓' : '+'}</span>
          <span class="kp-autopack-name">${esc(packName(pack))}</span>
          <span class="kp-autopack-meta">${price != null && price > 0 ? `◆ ${fmt(price)}` : pack.usesFreePacks ? 'gratuit' : '—'}</span>
          <span class="kp-autopack-count">${left.total > 0 ? `${fmt(left.total)} possible(s)` : 'indisponible'}</span>
        </button>`;
    };

    return `
      <div class="kp-section" style="margin-top:0">
        <div class="kp-section-title">Auto-Open <span>${
          a.running ? 'en cours' : a.opened ? 'dernière session' : 'prêt'
        }</span></div>

        <div class="kp-explain">
          <p>
            L'extension ouvre les boosters à ta place, <b>un par un</b>, en tirant au hasard parmi ceux que tu coches.
            Elle consomme d'abord les <b>boosters offerts</b>, puis — si tu l'autorises — ton <b>chakra</b>.
          </p>
          <p>
            La boucle <b>ne s'arrête jamais toute seule</b> : sans booster ouvrable elle reste en attente et
            reprend dès qu'un booster apparaît. Seul le bouton <b>Arrêter</b> la coupe.
          </p>
        </div>

        <div class="kp-explain-sub">Boosters à ouvrir <span class="kp-explain-count">${selected.length} sélectionné(s)</span></div>
        ${
          packs.length
            ? `<div class="kp-auto-packs">${packs.map(packButton).join('')}</div>`
            : `<div class="kp-empty">${state.packsLoading ? '<span class="kp-spinner"></span> Chargement…' : 'Aucun booster disponible.'}</div>`
        }
        ${
          selected.length > 1
            ? `<div class="kp-hint">Plusieurs boosters cochés : l'ouverture choisit au hasard à chaque fois.</div>`
            : ''
        }

        <div class="kp-explain-sub">Rythme</div>
        <div class="kp-filters">
          <label class="kp-filter">
            <span>Intervalle de régénération (min)</span>
            <input class="kp-input" type="number" min="1" max="60" step="1" data-setting="autoMaxPerBoosterMin" value="${perBoosterMin}">
          </label>
          <label class="kp-filter">
            <span>Rafraîchir (min)</span>
            <input class="kp-input" type="number" min="1" max="120" step="1" data-setting="autoRefreshMin" value="${refreshMin}">
          </label>
        </div>
        <div class="kp-hint">
          Formule : <b>T_max = (9 − B) × ${perBoosterMin} + R</b>, où
          <b>B</b> = boosters dans la jauge (${delayRange.boosters}/${delayRange.maxBoosters}) et
          <b>R</b> = temps réel avant le prochain gain (${Math.round(delayRange.remainingMin)} min, ${delayRange.source}).
          Il ouvre dans <b>${maxLabel}</b> au plus tard, avec un délai entier tiré au hasard entre 1 min et T_max.
          Jauge pleine (${delayRange.maxBoosters}/${delayRange.maxBoosters}) → ouverture immédiate.
          Jusqu'à ce que tu cliques sur <b>Arrêter</b>. Compte rafraîchi toutes les ${refreshMin} min.
        </div>

        <div class="kp-auto-checks">
          <label class="kp-check">
            <input type="checkbox" data-setting="autoAllowChakra" ${allowChakra ? 'checked' : ''}>
            <span>Utiliser mon chakra <small>sinon seulement les boosters offerts</small></span>
          </label>
          <label class="kp-check">
            <input type="checkbox" data-setting="autoSound" ${state.settings.autoSound !== false ? 'checked' : ''}>
            <span>Bruit à chaque booster <small>carillon, plus aigu sur une belle carte</small></span>
          </label>
          <label class="kp-check">
            <input type="checkbox" data-setting="autoStopRare" ${state.settings.autoStopRare ? 'checked' : ''}>
            <span>S'arrêter sur Légendaire / Mythique</span>
          </label>
        </div>

        ${
          selected.length
            ? `<div class="kp-auto-summary">
                 <div><span>Ouvrables</span><b>${fmt(total)}</b></div>
                 <div><span>Offerts</span><b>${fmt(estimate.grants + estimate.free)}</b></div>
                 <div><span>Chakra max</span><b>◆ ${fmt(estimate.chakra)}</b></div>
               </div>
               ${
                 estimate.missing > 0
                   ? `<div class="kp-hint" style="color:var(--kp-bad)">${fmt(
                       estimate.missing
                     )} booster(s) de la sélection ne sont pas ouvrables (chakra bloqué ou limite atteinte).</div>`
                   : ''
               }`
            : `<div class="kp-hint">Aucun booster sélectionné : l'auto-open démarre quand même et attend qu'un booster soit ouvrable. Il ne s'arrête que sur <b>Arrêter</b>.</div>`
        }

        <div class="kp-toolbar" style="margin-top:10px">
          ${
            a.running
              ? `<button class="kp-btn is-ghost" type="button" data-act="auto-stop">Arrêter</button>`
              : `<button class="kp-btn is-primary" type="button" data-act="auto-start">Démarrer</button>`
          }
          <button class="kp-btn" type="button" data-act="auto-refresh" ${a.running ? 'disabled' : ''}>Rafraîchir</button>
          <button class="kp-btn is-ghost" type="button" data-act="auto-sound-test" title="Tester le son">♪</button>
        </div>

        ${
          a.running || a.opened
            ? `<div class="kp-auto-progress">
                 <div class="kp-progress ${a.running ? 'is-loop' : ''}"><i style="width:${
                   a.running ? 100 : 0
                 }%"></i></div>
                 <div class="kp-hint">${esc(a.status)}</div>
                 ${
                   a.nextAt
                     ? `<div class="kp-auto-countdown"><span data-countdown>${fmtWait(a.nextAt - Date.now())}</span> avant le prochain booster</div>`
                     : ''
                 }
               </div>`
            : a.status
              ? `<div class="kp-hint">${esc(a.status)}</div>`
              : ''
        }

        ${
          a.passNeeded && passPack
            ? `<div class="kp-alert is-bad" style="margin-top:10px">
                 <b>Laissez-passer expiré</b><br>
                 Le site exige un laissez-passer pour ouvrir des boosters. Ouvre <b>un</b> booster à la main,
                 reviens ici, puis relance l'auto-open.
                 <div class="kp-toolbar" style="margin-top:6px">
                   <a class="kp-btn" href="https://kyara.games/ouvrir/${encodeURIComponent(passPack.id)}" target="_blank" rel="noopener">Ouvrir sur le site ↗</a>
                 </div>
               </div>`
            : ''
        }
        ${a.error ? `<div class="kp-alert is-bad" style="margin-top:8px">${esc(a.error)}</div>` : ''}

        ${
          a.opened
            ? `<div class="kp-auto-metrics">
                 <div><span>Ouverts</span><b>${fmt(a.opened)}</b></div>
                 <div><span>Cartes</span><b>${fmt(a.cardCount)}</b></div>
                 <div><span>Chakra dépensé</span><b>◆ ${fmt(a.spent)}</b></div>
               </div>
               <div class="kp-chips" style="margin:8px 0">
                 ${RARITY_ORDER.filter((code) => a.counts?.[code])
                   .reverse()
                   .map((code) => {
                     const info = rarityInfo(code);
                     return `<span class="kp-chip" style="--rc:${info.color}"><em>${esc(info.label)}</em> ${fmt(a.counts[code])}</span>`;
                   })
                   .join('')}
                 ${a.golden ? `<span class="kp-chip"><em>Dorés</em> ${fmt(a.golden)}</span>` : ''}
                 ${a.godPacks ? `<span class="kp-chip"><em>God packs</em> ${fmt(a.godPacks)}</span>` : ''}
               </div>`
            : ''
        }

        ${
          a.best.length
            ? `<div class="kp-explain-sub">Meilleures trouvailles <span class="kp-explain-count">${
                a.bestAll?.length ?? a.best.length
              } carte(s) Épique et +</span></div>
               <div class="kp-best-cards">
                 ${a.best
                   .map((card) => {
                     const info = rarityInfo(card.rarity);
                     const top = RARITY_ORDER.indexOf(card.rarity) >= RARITY_ORDER.indexOf('L');
                     return `
                   <div class="kp-best-card ${top ? 'is-top' : ''}" style="--rc:${info.color}" data-act="open-card" data-id="${esc(
                       card.id
                     )}" title="${esc(card.name)} · ${esc(info.label)}${
                       (card.qty ?? 1) > 1 ? ` ×${card.qty}` : ''
                     }">
                     <img src="${esc(imgSrc(card))}" alt="${esc(card.name)}" loading="lazy">
                     ${(card.qty ?? 1) > 1 ? `<span class="kp-best-qty">×${fmt(card.qty)}</span>` : ''}
                     <b>${esc(info.label)}</b>
                     <small>${esc(card.name)}</small>
                   </div>`;
                   })
                   .join('')}
               </div>`
            : ''
        }

        ${
          a.cards.length
            ? `<div class="kp-explain-sub">Dernières cartes</div>
               <div class="kp-auto-cards">
                 ${a.cards
                   .slice(0, 30)
                   .map(
                     (card) => `
                   <img src="${esc(imgSrc(card))}" alt="${esc(card.name)}" title="${esc(card.name)} · ${esc(
                     rarityInfo(card.rarity).label
                   )}" loading="lazy" style="--rc:${rarityInfo(card.rarity).color}" data-act="open-card" data-id="${esc(card.id)}">`
                   )
                   .join('')}
               </div>`
            : ''
        }

        <div class="kp-explain-sub" style="margin-top:14px">
          Journal
          <span class="kp-explain-count">${a.restarts ? `${a.restarts} relance(s) auto` : 'cette session'}</span>
        </div>
        <div class="kp-hint">
          Chaque ouverture, attente, erreur et relance est horodatée ici. C'est ce journal qui dit
          pourquoi la boucle s'est tue pendant la nuit.
        </div>
        <div class="kp-auto-log">
          ${
            (a.log ?? []).length
              ? a.log
                  .slice(-40)
                  .reverse()
                  .map((entry) => `<div><i>${fmtClock(entry.t)}</i><span>${esc(entry.m)}</span></div>`)
                  .join('')
              : '<div><i>—</i><span>Aucun évènement enregistré.</span></div>'
          }
        </div>
        <div class="kp-toolbar" style="margin-top:6px">
          <button class="kp-btn is-ghost" type="button" data-act="auto-log-copy">Copier le journal</button>
          <button class="kp-btn is-ghost" type="button" data-act="auto-log-clear">Vider</button>
        </div>
      </div>
    `;
  }

  function viewSettings() {
    const cfg = getCfg();
    return `
      <div class="kp-settings">
        <label class="kp-field">
          <span>Cache des prix<small>Durée avant de redemander les médianes</small></span>
          <select class="kp-select" data-setting="ttlH">
            ${[1, 6, 12, 24, 72].map((h) => `<option value="${h}" ${state.settings.ttlH === h ? 'selected' : ''}>${h} h</option>`).join('')}
          </select>
        </label>
        <label class="kp-field">
          <span>Délai entre ventes<small>Plus haut = plus sûr vis-à-vis de l’anti-cheat</small></span>
          <input class="kp-input" type="number" min="400" step="100" data-setting="gapMs" value="${state.settings.gapMs}">
        </label>
        <label class="kp-field">
          <span>Annonces max / lot<small>Garde-fou sur la vente en masse</small></span>
          <input class="kp-input" type="number" min="1" max="60" data-setting="maxBatch" value="${state.settings.maxBatch}">
        </label>
        <label class="kp-field">
          <span>Décote appliquée<small>Prix proposé = médiane − X %</small></span>
          <input class="kp-input" type="number" min="0" max="30" step="1" data-setting="discountPct" value="${state.settings.discountPct}">
        </label>
        <label class="kp-field">
          <span>Type de vente<small>Appliqué par défaut au prochain lot</small></span>
          <select class="kp-select" data-setting="saleType">
            <option value="fixed" ${state.settings.saleType === 'fixed' ? 'selected' : ''}>Prix fixe</option>
            <option value="auction" ${state.settings.saleType === 'auction' ? 'selected' : ''}>Enchère</option>
          </select>
        </label>
        <label class="kp-field">
          <span>Mise à prix<small>Enchère : médiane − X %</small></span>
          <input class="kp-input" type="number" min="0" max="80" step="1" data-setting="auctionPct" value="${state.settings.auctionPct}">
        </label>
        <label class="kp-field">
          <span>Achat immédiat<small>Enchère : + X % · 0 = désactivé</small></span>
          <input class="kp-input" type="number" min="0" max="300" step="5" data-setting="buyoutPct" value="${state.settings.buyoutPct}">
        </label>
        <label class="kp-field">
          <span>Durée par défaut<small>Prix fixe et enchère</small></span>
          <select class="kp-select" data-setting="durationHours">
            ${cfg.durations
              .map((h) => `<option value="${h}" ${Number(state.settings.durationHours) === Number(h) ? 'selected' : ''}>${h} h</option>`)
              .join('')}
          </select>
        </label>
        <label class="kp-toggle">
          <span>Mode simulation<small>Affiche le plan sans créer d’annonce</small></span>
          <input type="checkbox" data-setting="dryRun" ${state.settings.dryRun ? 'checked' : ''}>
        </label>
        <label class="kp-toggle">
          <span>Valorisation automatique<small>Calcule les prix manquants à l’ouverture</small></span>
          <input type="checkbox" data-setting="autoPrices" ${state.settings.autoPrices ? 'checked' : ''}>
        </label>

        <div class="kp-section-title" style="margin-top:14px">Présence</div>
        <label class="kp-field">
          <span>Répondre à l'anti-AFK<small>Clique « Je suis là » tout seul, délai aléatoire de 2 s à 1 min</small></span>
          <input type="checkbox" data-setting="antiAfk" ${state.settings.antiAfk !== false ? 'checked' : ''}>
        </label>
        <div class="kp-hint">
          Surveille l'apparition de la boîte « Tu es toujours là ? » sur le site et clique sur
          <b>Je suis là</b> après un délai tiré au hasard entre <b>2 s</b> et <b>1 min</b>, pour ne pas
          répondre instantanément comme un robot. Si la boîte reste affichée, une seconde tentative est
          faite en évènements souris.
        </div>
        <div class="kp-chips" style="margin:6px 0">
          <span class="kp-chip"><em>État</em> ${state.settings.antiAfk !== false ? 'actif' : 'désactivé'}</span>
          <span class="kp-chip"><em>Réponses</em> ${fmt(state.antiAfk?.clicks ?? 0)}</span>
          ${
            state.antiAfk?.lastAt
              ? `<span class="kp-chip"><em>Dernier clic</em> ${nowTime(state.antiAfk.lastAt)} · délai ${Math.round(
                  (state.antiAfk.lastDelay ?? 0) / 1000
                )} s</span>`
              : ''
          }
          ${
            state.antiAfk?.pendingAt
              ? `<span class="kp-chip"><em>En attente</em> ${Math.max(
                  0,
                  Math.round((state.antiAfk.pendingDelay - (Date.now() - state.antiAfk.pendingAt)) / 1000)
                )} s</span>`
              : ''
          }
        </div>
        <div class="kp-alert">
          Frais actuels : dépôt ${cfg.feePct} % (min ${cfg.feeMin} ◆) · taxe de vente ${cfg.taxPct} %.
          Limite : ${listingSlots().max} annonces actives (${listingSlots().active} en ligne, ${listingSlots().remaining} libre(s)).
          Les frais de dépôt ne sont pas remboursés si la carte ne se vend pas.
        </div>

        <div class="kp-toolbar">
          <button class="kp-btn" type="button" data-act="clear-cache">Vider le cache</button>
          <button class="kp-btn" type="button" data-act="calc-prices">Tout recalculer</button>
          <button class="kp-btn" type="button" data-act="export-json">Export JSON</button>
        </div>
      </div>
    `;
  }

  function viewDebug() {
    const counts = state.collection.length;
    const pricedIds = Object.keys(state.prices).filter((id) => priceOf(id) != null).length;
    return `
      <div class="kp-settings">
        <div class="kp-card-stat"><span>Session</span><b>${esc(state.user?.pseudo ?? 'invité')}</b><small>id ${esc(state.user?.id ?? '—')} · ${counts} entrées collection</small></div>
        <div class="kp-card-stat"><span>Prix en cache</span><b>${pricedIds}</b><small>${Object.keys(state.prices).length} entrées · TTL ${state.settings.ttlH} h</small></div>
        <div class="kp-card-stat"><span>Bootstrap</span><b>${esc(state.bootKeys.join(', ') || '—')}</b><small>clés renvoyées par /api/me/bootstrap</small></div>
        <div class="kp-card-stat"><span>Version du code</span><b>v${esc(state.version)}</b><small>manifeste du dossier</small></div>
        <div class="kp-card-stat"><span>Version dans ${esc(BROWSER_NAME)}</span><b>v${esc(state.manifestVersion ?? '—')}</b><small>${
          state.manifestVersion
            ? state.manifestOutdated
              ? 'en retard sur le dossier'
              : 'extension actuellement chargée'
            : 'version chargée indisponible'
        }</small></div>
        <div class="kp-toolbar">
          ${
            state.reloadArmed
              ? `<button class="kp-btn is-primary" type="button" data-act="reload-ext">Confirmer le rechargement</button>
                 <button class="kp-btn is-ghost" type="button" data-act="reload-cancel">Annuler</button>`
              : `<button class="kp-btn" type="button" data-act="reload-ext">Recharger l'extension</button>`
          }
        </div>
        <div class="kp-toolbar">
          <button class="kp-btn" type="button" data-act="copy-diag">Copier le diagnostic</button>
          <button class="kp-btn" type="button" data-act="refresh">Rafraîchir</button>
        </div>
        <div class="kp-section-title">Requêtes récentes</div>
        <div class="kp-debug">${esc(
          state.debug
            .map(
              (d) =>
                `${d.at} ${String(d.method).padEnd(4)} ${d.status || 'ERR'} ${d.ms}ms ${d.path}${d.error ? ` — ${d.error}` : ''}`
            )
            .join('\n') || 'Aucune requête.'
        )}</div>
      </div>
    `;
  }

  /* ------------------------------------------------------------------ */
  /* Profil d'un autre joueur                                            */
  /* ------------------------------------------------------------------ */

  /** Médiane des médianes par rareté, calculée sur les cartes déjà valorisées. */
  function rarityAverages() {
    const buckets = new Map();
    for (const [id, entry] of Object.entries(state.prices)) {
      const value = entry?.m7 ?? entry?.m30;
      if (value == null || value <= 0) continue;
      const rarity = String(state.characters.get(String(id))?.rarity ?? '').toUpperCase();
      if (!rarity) continue;
      const list = buckets.get(rarity) ?? [];
      list.push(Number(value));
      buckets.set(rarity, list);
    }
    const out = new Map();
    for (const [rarity, list] of buckets) {
      list.sort((a, b) => a - b);
      const mid = Math.floor(list.length / 2);
      out.set(rarity, {
        median: list.length % 2 ? list[mid] : (list[mid - 1] + list[mid]) / 2,
        sample: list.length
      });
    }
    return out;
  }

  /** Liste réelle des cartes possédées par un joueur (endpoint public d'échange). */
  async function fetchOwnedIds(id) {
    const data = await api(`/api/trades/owned/${encodeURIComponent(id)}`, { timeout: 25000 }).catch(() => null);
    if (!data) return null;
    const list = Array.isArray(data) ? data : Array.isArray(data.ids) ? data.ids : Array.isArray(data.cards) ? data.cards : null;
    if (!list) return null;
    const ids = [];
    for (const entry of list) {
      const value =
        entry && typeof entry === 'object' ? entry.characterId ?? entry.id ?? entry.cardId : entry;
      if (value != null) ids.push(String(value));
    }
    return ids.length ? [...new Set(ids)] : null;
  }

  /** Prix officiels « fair-play » pour une liste d'ids (par lots de 200, comme le site). */
  async function fetchFairPrices(ids, onProgress) {
    const out = new Map();
    const total = ids.length;
    let done = 0;
    for (let i = 0; i < ids.length; i += 200) {
      const chunk = ids.slice(i, i + 200);
      const data = await api(`/api/fair-play/prices?ids=${chunk.join(',')}`, { timeout: 25000 }).catch(() => null);
      if (data && typeof data === 'object') {
        if (Array.isArray(data)) {
          chunk.forEach((id, index) => {
            const raw = data[index];
            const value = toNum(raw && typeof raw === 'object' ? raw.price ?? raw.value : raw);
            if (value != null) out.set(id, value);
          });
        } else {
          for (const [key, raw] of Object.entries(data)) {
            const value = toNum(raw && typeof raw === 'object' ? raw.price ?? raw.value : raw);
            if (value != null) out.set(String(key), value);
          }
        }
      }
      done += chunk.length;
      if (onProgress) onProgress(done, total);
    }
    return out;
  }

  let searchTimer = null;
  let searchSeq = 0;

  /**
   * Normalise un résultat de /api/me/friends/search.
   * Le serveur renvoie des objets joueur avec un `status` de relation
   * ('none' | 'outgoing' | 'incoming' | 'friends' | 'blocked').
   */
  function normalizeFriendHit(raw) {
    const u = raw?.user ?? raw?.player ?? raw ?? {};
    return {
      id: u?.id ?? raw?.id ?? null,
      pseudo: u?.pseudo ?? u?.name ?? '?',
      avatar: u?.avatar ?? u?.avatarUrl ?? null,
      rank: u?.rank ?? null,
      owned: toNum(u?.owned ?? u?.collectionSize ?? u?.cards),
      mythics: toNum(u?.mythics),
      points: toNum(u?.points),
      pos: toNum(u?.pos ?? u?.position),
      status: typeof raw?.status === 'string' ? raw.status : null
    };
  }

  /**
   * Recherche par pseudo via l'endpoint que le site utilise lui-même
   * (`/api/me/friends/search`). Contrairement au classement — qui ne renvoie
   * que les 10 plus grosses collections correspondant à la saisie — il trouve
   * n'importe quel joueur, même avec une petite collection.
   */
  async function searchFriendsByPseudo(query) {
    const data = await api(`/api/me/friends/search?q=${encodeURIComponent(query)}`, { timeout: 20000 });
    const list = Array.isArray(data)
      ? data
      : Array.isArray(data?.users)
        ? data.users
        : Array.isArray(data?.items)
          ? data.items
          : Array.isArray(data?.found)
            ? data.found
            : Array.isArray(data?.results)
              ? data.results
              : [];
    return list.map(normalizeFriendHit).filter((row) => row.id);
  }

  async function runProfileSearch(query) {
    const cleaned = String(query ?? '').trim();
    if (!cleaned) return;

    const seq = ++searchSeq;
    if (searchTimer) {
      clearTimeout(searchTimer);
      searchTimer = null;
    }

    if (state.profile.view !== 'search') {
      state.profile.view = 'search';
      state.profile.user = null;
      state.profile.value = null;
      state.profile.results = null;
      state.profile.error = null;
      state.profile.searching = true;
      render();
      focusProfileSearch();
    } else {
      state.profile.searching = true;
      patchProfileResults();
    }

    // 1) Recherche par pseudo (complète). 2) Repli sur le classement si indisponible.
    let found = [];
    let friendSearchFailed = false;
    try {
      found = await searchFriendsByPseudo(cleaned);
    } catch {
      friendSearchFailed = true;
    }
    if (seq !== searchSeq) return;

    if (!found.length) {
      try {
        const data = await api(
          `/api/leaderboard/ladder?by=collection&q=${encodeURIComponent(cleaned)}`,
          { timeout: 20000 }
        );
        if (seq !== searchSeq) return;
        const ladder = Array.isArray(data?.found) ? data.found : [];
        const known = new Set(found.map((row) => String(row.id)));
        found = [...found, ...ladder.map(normalizeFriendHit).filter((row) => row.id && !known.has(String(row.id)))];
      } catch (err) {
        if (seq !== searchSeq) return;
        state.profile.error = friendSearchFailed ? friendlyError(err) : null;
      }
    }

    // Correspondance exacte d'abord, puis préfixe, puis le reste.
    const needle = cleaned.toLowerCase();
    const weight = (row) => {
      const name = String(row.pseudo ?? '').toLowerCase();
      if (name === needle) return 0;
      if (name.startsWith(needle)) return 1;
      if (name.includes(needle)) return 2;
      return 3;
    };
    found.sort((a, b) => weight(a) - weight(b) || (b.owned ?? 0) - (a.owned ?? 0));

    state.profile.results = found.slice(0, 12);
    if (!found.length) {
      state.profile.error = `Aucun joueur nommé « ${cleaned} ».`;
    } else {
      state.profile.error = null;
    }

    if (seq === searchSeq) {
      state.profile.searching = false;
      patchProfileResults();
    }
  }

  function searchProfile() {
    return runProfileSearch(state.profile.query);
  }

  function scheduleProfileSearch() {
    const query = state.profile.query.trim();
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = null;

    if (query.length < 2) {
      if (state.profile.view === 'search') {
        state.profile.results = null;
        state.profile.error = null;
        state.profile.searching = false;
        patchProfileResults();
      }
      return;
    }

    searchTimer = setTimeout(() => runProfileSearch(query), 300);
  }

  function resetProfile() {
    searchSeq += 1;
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = null;
    state.profile.view = 'self';
    state.profile.user = null;
    state.profile.value = null;
    state.profile.results = null;
    state.profile.error = null;
    state.profile.loading = false;
    state.profile.searching = false;
    render();
  }

  async function loadProfile(id) {
    if (!id) return;
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = null;

    state.profile.view = 'other';
    state.profile.loading = true;
    state.profile.error = null;
    state.profile.user = null;
    state.profile.value = null;
    state.profile.progress = { done: 0, total: 0 };
    render();

    try {
      const stub = (state.profile.results ?? []).find((r) => String(r.id) === String(id)) ?? null;
      const user = await api(`/api/users/${encodeURIComponent(id)}`, { timeout: 20000 }).catch((err) => {
        if (err.status === 400 || err.status === 404) return null;
        throw err;
      });

      state.profile.user = user ? { ...(stub || {}), ...user } : stub;
      if (!user) state.profile.error = 'Profil introuvable ou privé : seules les infos publiques sont affichées.';

      const best = Array.isArray(user?.best) ? user.best.slice(0, 8) : [];

      // 1) Valorisation exacte : on récupère les cartes réellement possédées,
      //    puis les prix officiels via /fair-play/prices.
      const ownedIds = await fetchOwnedIds(id);
      let value = null;

      if (ownedIds && ownedIds.length) {
        state.profile.progress = { done: 0, total: ownedIds.length };
        render();

        const prices = await fetchFairPrices(ownedIds, (done, total) => {
          state.profile.progress = { done, total };
          if (done % 400 === 0 || done === total) render();
        });

        const byRarity = {};
        const rarityValue = {};
        let total = 0;
        let priced = 0;
        let unknown = 0;

        for (const cardId of ownedIds) {
          const rarity = String(state.characters.get(cardId)?.rarity ?? '').toUpperCase();
          if (rarity) byRarity[rarity] = (byRarity[rarity] ?? 0) + 1;
          const price = prices.get(cardId);
          if (price == null || price <= 0) {
            unknown += 1;
            continue;
          }
          total += price;
          priced += 1;
          if (rarity) rarityValue[rarity] = (rarityValue[rarity] ?? 0) + price;
        }

        value = {
          exact: true,
          total,
          priced,
          unknown,
          uniques: ownedIds.length,
          byRarity,
          rarityValue,
          prices,
          hasCollection: true
        };
      }

      // 2) Repli : estimation par rareté si la liste n'est pas accessible.
      if (!value && user?.byRarity) {
        const averages = rarityAverages();
        let estimate = 0;
        let unknown = 0;
        let sample = 0;
        const rarityValue = {};
        for (const [code, count] of Object.entries(user.byRarity)) {
          const quantity = Number(count) || 0;
          if (!quantity) continue;
          const avg = averages.get(String(code).toUpperCase());
          if (!avg) {
            unknown += quantity;
            continue;
          }
          sample += avg.sample;
          estimate += avg.median * quantity;
          rarityValue[String(code).toUpperCase()] = avg.median * quantity;
        }
        value = {
          exact: false,
          total: estimate,
          priced: 0,
          unknown,
          uniques: Object.values(user.byRarity).reduce((sum, n) => sum + (Number(n) || 0), 0),
          byRarity: user.byRarity,
          rarityValue,
          sample,
          hasCollection: true
        };
      }

      // 3) Prix exacts des meilleures cartes (affichage).
      if (best.length) {
        const missing = best.map((c) => String(c.id)).filter((cardId) => !value?.prices?.has(cardId) && !priceFresh(state.prices[cardId]));
        if (missing.length) await loadPrices(missing).catch(() => null);
      }

      let bestValue = 0;
      const bestRows = best.map((card) => {
        const price = value?.prices?.get(String(card.id)) ?? priceOf(card.id);
        if (price != null) bestValue += price;
        return { card, price };
      });

      if (!value) {
        value = {
          exact: false,
          total: bestValue,
          priced: 0,
          unknown: 0,
          uniques: null,
          byRarity: null,
          hasCollection: false
        };
      }

      value.best = bestRows;
      value.bestValue = bestValue;
      value.private = Boolean(user?.locked?.includes('collection'));
      state.profile.value = value;
    } catch (err) {
      state.profile.error = friendlyError(err);
    } finally {
      state.profile.loading = false;
      state.profile.progress = null;
      render();
    }
  }

  function profileSearchBar() {
    const p = state.profile;
    return `
      <div class="kp-searchbar">
        <input class="kp-input" type="search" data-role="profile-search" placeholder="Pseudo d'un joueur…" value="${esc(p.query)}" aria-label="Rechercher un compte" autocomplete="off" spellcheck="false">
        <button class="kp-btn is-primary" type="button" data-act="profile-search" ${p.searching ? 'disabled' : ''}>${
          p.searching ? '…' : 'Chercher'
        }</button>
      </div>`;
  }

  function relationTag(status) {
    const map = {
      friends: ['ami', 'is-good'],
      outgoing: ['demande envoyée', 'is-warn'],
      incoming: ['demande reçue', 'is-warn'],
      blocked: ['bloqué', 'is-bad'],
      none: ['', '']
    };
    const [label, cls] = map[String(status ?? 'none')] ?? ['', ''];
    return label ? `<span class="kp-rel ${cls}">${esc(label)}</span>` : '';
  }

  function profileResultsTable(results) {
    return `
      <div class="kp-table">
        ${results
          .map((r) => {
            const meta = [];
            if (r.rank?.label) meta.push(esc(r.rank.label));
            if (r.owned != null) meta.push(`${fmt(r.owned)} cartes`);
            if (r.mythics != null) meta.push(`${fmt(r.mythics)} mythique(s)`);
            const right =
              r.pos != null
                ? `<b>#${fmt(r.pos)}</b>${r.points != null ? `<small>${fmt(r.points)} pts</small>` : ''}`
                : r.points != null
                  ? `<b>${fmt(r.points)}</b><small>pts</small>`
                  : `<b>›</b>`;
            return `
          <div class="kp-row" data-act="profile-open" data-id="${esc(r.id)}" data-pseudo="${esc(r.pseudo)}">
            <span></span>
            <img class="kp-avatar" src="${esc(r.avatar || '/brand/favicon/icon-192.png')}" alt="" loading="lazy">
            <div class="kp-row-main">
              <div class="kp-row-name">${esc(r.pseudo)} ${relationTag(r.status)}</div>
              <div class="kp-row-meta">${meta.length ? meta.join(' · ') : 'ouvrir le profil'}</div>
            </div>
            <div class="kp-row-price">${right}</div>
          </div>`;
          })
          .join('')}
      </div>`;
  }

  function profileResultsHTML() {
    const p = state.profile;
    const results = Array.isArray(p.results) ? p.results : null;

    if (p.searching && !results) {
      return `<div class="kp-empty"><span class="kp-spinner"></span> Recherche…</div>`;
    }

    if (p.error && (!results || !results.length)) {
      return `<div class="kp-alert is-bad" style="margin-top:10px">${esc(p.error)}</div>`;
    }

    if (results && results.length) {
      return `
        <div class="kp-section-title" style="margin-top:12px">
          ${results.length > 1 ? `${results.length} joueurs trouvés` : '1 joueur trouvé'}
          ${p.searching ? '<span class="kp-spinner"></span>' : ''}
        </div>
        ${profileResultsTable(results)}`;
    }

    if (results) {
      return `<div class="kp-empty"><b>Aucun résultat</b>Essaie une autre orthographe (le pseudo exact marche toujours).</div>`;
    }

    return `<div class="kp-empty"><b>Cherche un joueur</b>Les comptes s'affichent au fur et à mesure de la saisie.</div>`;
  }

  function patchProfileResults() {
    if (!shadow) return;
    const box = qs('#kp-results');
    if (!box) {
      render();
      return;
    }
    box.innerHTML = profileResultsHTML();
  }

  function focusProfileSearch() {
    const input = qs('[data-role="profile-search"]');
    if (!input) return;
    try {
      input.focus();
      const end = input.value.length;
      input.setSelectionRange(end, end);
    } catch {
      /* ignore */
    }
  }

  function viewProfileSearch() {
    return `
      <div class="kp-navbar">
        <button class="kp-back" type="button" data-act="profile-back">← Mon compte</button>
        <span>Recherche de compte</span>
      </div>

      ${profileSearchBar()}
      <div id="kp-results">${profileResultsHTML()}</div>
    `;
  }

  function viewOtherAccount() {
    const p = state.profile;
    const u = p.user;
    const v = p.value;

    const nav = `
      <div class="kp-navbar">
        <button class="kp-back" type="button" data-act="profile-back">← Mon compte</button>
        <span>Profil</span>
      </div>
      ${profileSearchBar()}
    `;

    if (p.loading) {
      return `${nav}<div class="kp-empty"><span class="kp-spinner"></span> Chargement du profil…</div>`;
    }

    if (!u) {
      return `
        ${nav}
        <div class="kp-empty">
          <b>Profil indisponible</b>
          ${esc(p.error || 'Ce joueur est introuvable.')}
        </div>`;
    }

    const rarityRows = v?.byRarity
      ? (() => {
          const codes = RARITY_ORDER.filter((code) => Number(v.byRarity[code]) > 0);
          const maxValue = Math.max(1, ...codes.map((code) => Number(v.rarityValue?.[code]) || 0));
          const totalCount = Math.max(1, ...codes.map((code) => Number(v.byRarity[code]) || 0));
          const exact = Boolean(v.exact && v.rarityValue);
          return codes.map((code) => {
            const info = rarityInfo(code);
            const count = Number(v.byRarity[code]);
            const value = Number(v.rarityValue?.[code]) || 0;
            const ratio = exact ? value / maxValue : count / totalCount;
            return `
              <div class="kp-bar-row">
                <span>${esc(info.label)} · ${fmt(count)}</span>
                <div class="kp-bar"><i style="width:${Math.max(2, Math.round(ratio * 100))}%;--kp-bar-color:${info.color}"></i></div>
                <b>${value > 0 ? `◆ ${fmt(value)}` : '—'}</b>
              </div>`;
          });
        })()
      : [];

    return `
      ${nav}

      <div class="kp-profile-head">
        <img class="kp-avatar-lg" src="${esc(u.avatar || '/brand/favicon/icon-192.png')}" alt="" loading="lazy">
        <div class="kp-profile-id">
          <b>${esc(u.pseudo ?? 'Joueur')}</b>
          <small>${esc(u.rank?.label ?? '—')}${u.points != null ? ` · ${fmt(u.points)} pts` : ''}</small>
        </div>
        <a class="kp-link" href="https://kyara.games/profil/${encodeURIComponent(u.id ?? '')}" target="_blank" rel="noopener">Voir sur le site ↗</a>
      </div>

      <div class="kp-hero" style="margin-top:10px">
        <div class="kp-hero-label">Valeur du compte</div>
        <div class="kp-hero-value">◆ ${fmt(v?.total ?? 0)}</div>
        <div class="kp-hero-sub">
          ${
            p.progress && p.progress.total
              ? `Valorisation en cours… ${fmt(p.progress.done)}/${fmt(p.progress.total)}`
              : v?.exact
                ? `${fmt(v.uniques)} cartes uniques · ${fmt(v.priced)} avec prix${v.unknown ? ` · ${fmt(v.unknown)} sans prix` : ''}`
                : v?.hasCollection
                  ? `Estimation par rareté${v.unknown ? ` · ${fmt(v.unknown)} carte(s) sans référence` : ''}`
                  : 'Collection privée : seules les infos publiques sont disponibles.'
          }
        </div>
        ${
          p.progress && p.progress.total
            ? `<div class="kp-progress">
                 <div class="kp-progress-bar"><i style="width:${Math.round((p.progress.done / p.progress.total) * 100)}%"></i></div>
               </div>`
            : ''
        }
      </div>

      <div class="kp-chips" style="margin-top:8px">
        <span class="kp-chip"><em>Rang</em> ${esc(u.rank?.label ?? '—')}</span>
        ${u.pos != null || u.position != null ? `<span class="kp-chip"><em>Classement</em> #${fmt(u.pos ?? u.position)}</span>` : ''}
        ${u.points != null ? `<span class="kp-chip"><em>Points</em> ${fmt(u.points)}</span>` : ''}
        ${v?.uniques != null ? `<span class="kp-chip"><em>Cartes uniques</em> ${fmt(v.uniques)}</span>` : ''}
        ${v?.bestValue ? `<span class="kp-chip"><em>Top 8</em> ◆ ${fmt(v.bestValue)}</span>` : ''}
        ${u.mythics != null ? `<span class="kp-chip"><em>Mythiques</em> ${fmt(u.mythics)}</span>` : ''}
        <span class="kp-chip"><em>Source</em> ${v?.exact ? 'prix du jeu' : 'estimation'}</span>
      </div>

      ${rarityRows.length ? `<div class="kp-section-title" style="margin-top:14px">Répartition par rareté${
        v?.exact ? '' : ' (estimée)'
      }</div><div class="kp-bars">${rarityRows.join('')}</div>` : ''}

      ${
        v?.best?.length
          ? `<div class="kp-section-title" style="margin-top:14px">Ses plus belles cartes</div>
             <div class="kp-top">
               ${v.best
                 .map(
                   (row) => `
                 <div class="kp-top-card" data-act="open-card" data-id="${esc(row.card.id)}" title="${esc(row.card.name)}">
                   <img src="${esc(imgSrc(row.card))}" alt="${esc(row.card.name)}" loading="lazy">
                   <span>${esc(row.card.name)}</span>
                   <b>${row.price != null ? `◆ ${fmt(row.price)}` : '—'}</b>
                 </div>`
                 )
                 .join('')}
             </div>`
          : ''
      }

      ${p.error ? `<div class="kp-alert" style="margin-top:12px">${esc(p.error)}</div>` : ''}
    `;
  }

  /* ------------------------------------------------------------------ */
  /* Modal                                                               */
  /* ------------------------------------------------------------------ */

  /* ------------------------------------------------------------------ */
  /* Fiche carte (onglet Vente)                                          */
  /* ------------------------------------------------------------------ */

  const CONFIDENCE_LABEL = { low: 'Faible', medium: 'Moyenne', high: 'Élevée' };

  function statTile(label, value, hint = '') {
    return `<div class="kp-stat-tile"><span>${esc(label)}</span><b>${value}</b>${hint ? `<small>${hint}</small>` : ''}</div>`;
  }

  function renderSellDetail() {
    const view = state.sellView;
    const analysis = view.detail;

    if (view.detailLoading && !analysis) {
      return `
        <div class="kp-modal-head">
          <b>Fiche carte</b>
          <button class="kp-icon-btn" type="button" data-act="sell-detail-close">✕</button>
        </div>
        <div class="kp-modal-body"><div class="kp-empty"><span class="kp-spinner"></span> Chargement des données de marché…</div></div>`;
    }

    if (view.detailError && !analysis) {
      return `
        <div class="kp-modal-head">
          <b>Fiche carte</b>
          <button class="kp-icon-btn" type="button" data-act="sell-detail-close">✕</button>
        </div>
        <div class="kp-modal-body">
          <div class="kp-alert is-bad">${esc(view.detailError)}</div>
          <div class="kp-toolbar"><button class="kp-btn" type="button" data-act="sell-detail-retry" data-id="${esc(view.detailId ?? '')}">Réessayer</button></div>
        </div>`;
    }

    if (!analysis) return '';

    const card = analysis.card;
    const info = rarityInfo(card.rarity);
    const trend = analysis.trend;
    const conf = analysis.confidence;
    const owned = analysis.mine;
    const change = analysis.changePct;
    const dir = change == null ? 'is-flat' : change > 0.5 ? 'is-up' : change < -0.5 ? 'is-down' : 'is-flat';

    const trendText =
      trend.slopePct == null
        ? 'Série trop courte pour une tendance'
        : Math.abs(trend.slopePct) < 0.05
          ? 'Stable'
          : `${trend.slopePct > 0 ? 'Haussière' : 'Baissière'} · ${pctLabel(trend.slopePct)}/jour`;

    const forecast = analysis.forecast;
    const rec = analysis.recommend;
    const owners = statsOwnerStats(card.id);

    return `
      <div class="kp-modal-head">
        <div class="kp-detail-head">
          <img src="${esc(card.image)}" alt="">
          <div>
            <b>${esc(card.name)}</b>
            <small>${esc(info.label)}${card.series ? ` · ${esc(card.series)}` : ''}${
              owned ? ` · ${fmt(owned.qty)} en collection (${fmt(owned.sellable)} vendable${owned.sellable > 1 ? 's' : ''})` : ' · pas dans ta collection'
            }</small>
          </div>
        </div>
        <button class="kp-icon-btn" type="button" data-act="sell-detail-close">✕</button>
      </div>

      <div class="kp-modal-body">
        <div class="kp-price-hero ${dir}">
          <div>
            <span>Prix médian 7 j</span>
            <b>◆ ${analysis.median7 != null ? fmt(analysis.median7) : analysis.median != null ? fmt(analysis.median) : '—'}</b>
          </div>
          <div class="kp-price-hero-side">
            ${deltaChip(change)}
            <small>${change == null ? 'évolution indisponible' : 'sur la période disponible'}</small>
          </div>
        </div>

        ${priceChart(analysis)}

        ${
          owners
            ? `<div class="kp-stat-facts">
                 <span><em>Propriétaires (comptes suivis)</em> ${fmt(owners.count)} / ${fmt(owners.total)}</span>
                 <span><em>Exemplaires connus</em> ${fmt(owners.qty)}</span>
               </div>`
            : ''
        }

        <div class="kp-stat-grid">
          ${statTile('Dernière vente', analysis.last != null ? `◆ ${fmt(analysis.last)}` : '—', analysis.updatedAt ? `le ${esc(String(analysis.updatedAt).slice(0, 10))}` : '')}
          ${statTile('Médiane 30 j', analysis.median30 != null ? `◆ ${fmt(analysis.median30)}` : '—')}
          ${statTile('Plus haut observé', analysis.observedHigh != null ? `◆ ${fmt(analysis.observedHigh)}` : '—', analysis.observedHigh != null ? '20 dernières ventes' : 'aucune vente')}
          ${statTile('Plus bas observé', analysis.observedLow != null ? `◆ ${fmt(analysis.observedLow)}` : '—')}
          ${statTile('Volatilité', analysis.volatility != null ? fmtPct(analysis.volatility) : '—', 'écart-type quotidien')}
          ${statTile('Ventes 7 j', analysis.volume7 != null ? fmt(analysis.volume7) : '—', analysis.avgPerDay != null ? `${Math.round(analysis.avgPerDay * 10) / 10}/jour` : '')}
          ${statTile('Concurrence', fmt(analysis.rivals), analysis.lowest != null ? `dès ◆ ${fmt(analysis.lowest)}` : 'aucune annonce')}
          ${statTile('Achat immédiat (enchère)', analysis.auctionBuyout != null ? `◆ ${fmt(analysis.auctionBuyout)}` : '—', analysis.auctionBuyout != null ? 'enchère au plus bas' : 'aucune enchère disponible')}
          ${statTile(
            'Prix fixe le plus haut',
            analysis.fixedHigh != null ? `◆ ${fmt(analysis.fixedHigh)}` : '—',
            analysis.fixedHigh != null ? `${fmt(analysis.rivalFixed?.length ?? 0)} annonce(s) fixe(s)` : 'aucune annonce fixe'
          )}
          ${statTile('Meilleur ordre', analysis.bestBid != null ? `◆ ${fmt(analysis.bestBid)}` : '—', analysis.orderCount ? `${analysis.orderCount} ordre(s)` : '')}
        </div>

        <div class="kp-analysis">
          <div class="kp-analysis-row">
            <span>Tendance</span>
            <b class="${dir}">${esc(trendText)}</b>
          </div>
          <div class="kp-analysis-row">
            <span>Confiance de l'estimation</span>
            <b class="kp-conf is-${conf.level}">${CONFIDENCE_LABEL[conf.level]} · ${Math.round(conf.score * 100)} %</b>
          </div>
          ${
            forecast
              ? `<div class="kp-analysis-row">
                   <span>Projection à 7 jours</span>
                   <b>◆ ${fmt(forecast.price)} <small>(◆ ${fmt(forecast.low)} – ◆ ${fmt(forecast.high)})</small></b>
                 </div>
                 <div class="kp-hint">Estimation statistique, pas une garantie : elle prolonge la tendance des ${trend.points} jours disponibles.</div>`
              : `<div class="kp-hint">Pas de projection chiffrée : trop peu de points ou confiance insuffisante. La tendance reste affichée telle quelle.</div>`
          }
        </div>

        ${
          rec
            ? `<div class="kp-explain-sub">Prix de vente recommandé</div>
               <div class="kp-reco-list">
                 ${['quick', 'balanced', 'max']
                   .map((key) => {
                     const option = rec[key];
                     return `
                     <div class="kp-reco is-${key}">
                       <div class="kp-reco-head">
                         <b>${esc(option.label)}</b>
                         <span>◆ ${fmt(option.price)} <small>net ◆ ${fmt(option.net)}</small></span>
                       </div>
                       <div class="kp-reco-reason">${esc(option.reason)}</div>
                       ${
                         owned && owned.sellable > 0
                           ? `<div class="kp-reco-actions">
                                <button class="kp-btn is-primary" type="button" data-act="sell-card" data-id="${esc(card.id)}" data-price="${option.price}" data-type="fixed">Vendre à ce prix</button>
                                <button class="kp-btn" type="button" data-act="sell-card" data-id="${esc(card.id)}" data-price="${option.price}" data-type="auction">Enchère</button>
                              </div>`
                           : owned
                             ? `<div class="kp-hint">Non vendable pour l'instant : ${esc(owned.block?.reason ?? 'aucun exemplaire libre')}.</div>`
                             : `<div class="kp-hint">Carte absente de ta collection : prix indicatif pour un achat.</div>`
                       }
                     </div>`;
                   })
                   .join('')}
               </div>`
            : `<div class="kp-hint">Pas assez de données pour recommander un prix.</div>`
        }

        ${
          owned?.block
            ? `<div class="kp-alert is-warn" style="margin-top:10px">
                 <b>Carte non vendable pour le moment</b><br>
                 ${esc(owned.block.reason)}${
                   owned.block.until && owned.block.until > Date.now()
                     ? ` · disponible dans ${esc(fmtLockDelay(owned.block.until - Date.now()))} (${esc(
                         new Date(owned.block.until).toLocaleString('fr-FR', {
                           day: '2-digit',
                           month: '2-digit',
                           hour: '2-digit',
                           minute: '2-digit'
                         })
                       )})`
                     : ''
                 }
               </div>`
            : ''
        }

        ${
          analysis.myListing
            ? `<div class="kp-alert" style="margin-top:10px">Tu as déjà une annonce sur cette carte (${esc(
                analysis.myListing.type === 'auction' ? 'enchère' : 'prix fixe'
              )} · ◆ ${fmt(analysis.myListing.buyoutPrice ?? analysis.myListing.currentBid ?? analysis.myListing.price)}).</div>`
            : ''
        }

        <div class="kp-hint">Dernière actualisation : ${esc(
          analysis.updatedAt ? String(analysis.updatedAt).slice(0, 16).replace('T', ' ') : 'inconnue'
        )} · historique limité aux ${analysis.series.length} jour(s) fournis par l'API Kyara.</div>
      </div>

      <div class="kp-modal-foot">
        <button class="kp-btn is-ghost" type="button" data-act="sell-detail-close">Fermer</button>
        <button class="kp-btn" type="button" data-act="sell-detail-refresh" ${view.detailLoading ? 'disabled' : ''}>${
          view.detailLoading ? '<span class="kp-spinner"></span> Actualisation…' : 'Actualiser'
        }</button>
      </div>`;
  }

  const SELL_STRATEGIES = ['quick', 'balanced', 'max'];

  /**
   * Recommandation d'une carte du plan : fiche ouverte en priorité, sinon cache
   * des prix, sinon repli sur le prix estimé (aucune donnée de marché).
   */
  function rowRecommendation(row, mineRow = null) {
    const key = String(row.id);
    const cached = state.prices[key];
    const detail = state.sellView.detail;
    let analysis = null;
    if (detail?.recommend && String(detail.card?.id) === key) analysis = detail;
    if (!analysis && cached) {
      // On rejoue le marché à partir des mêmes caches que la fiche : sans le
      // prix fixe haut, le « Prix maximal » du plan retombait sur le prix bas.
      const marketItems = [];
      const fixedLow = state.fixedLow[key];
      const fixedHigh = state.fixedHigh[key];
      const auctionBuyout = state.auctionBuyout[key];
      if (fixedLow != null) marketItems.push({ type: 'fixed', price: fixedLow });
      if (fixedHigh != null && fixedHigh !== fixedLow) {
        marketItems.push({ type: 'fixed', price: fixedHigh });
      }
      if (auctionBuyout != null) {
        marketItems.push({ type: 'auction', price: auctionBuyout, buyoutPrice: auctionBuyout });
      }
      // Compatibilité avec un cache plus ancien (avant fixedHigh).
      if (!marketItems.length && state.lowest[key] != null) {
        marketItems.push({ type: 'fixed', price: state.lowest[key] });
      }

      analysis = analyzeCard({
        prices: {
          median7d: cached.m7,
          median30d: cached.m30,
          lastPrice: cached.last,
          sales7d: cached.sales7d,
          sales30d: cached.sales30d,
          days: cached.days,
          lastSales: cached.lastSales,
          lastAt: cached.lastAt
        },
        card: { id: key, name: row.name, rarity: row.rarity, floor: row.floor },
        mine: mineRow ?? sellRowOf(key),
        listings: marketItems.length ? { items: marketItems } : null,
        book: state.buyOrders[key] ? { bids: [{ price: state.buyOrders[key].price }] } : null
      });
    }
    if (analysis?.recommend) return { ...analysis.recommend, estimated: false };

    // Pas de données de marché : les trois stratégies gardent le prix estimé.
    const floor = Math.max(1, Math.round(row.floor ?? 1));
    const price = Math.max(floor, Math.round(row.price ?? row.median ?? floor));
    const stub = (id, label) => ({
      id,
      label,
      price,
      net: netOf(price),
      estimated: true,
      reason: 'aucune donnée de marché — prix estimé conservé'
    });
    return {
      quick: stub('quick', 'Vente rapide'),
      balanced: stub('balanced', 'Équilibrée'),
      max: stub('max', 'Prix maximal'),
      estimated: true
    };
  }

  /**
   * Prix recommandés pour tout le plan : chaque carte garde ses propres prix,
   * on additionne les trois stratégies sur l'ensemble de la sélection.
   * Avant, ces boutons n'apparaissaient qu'avec une seule carte sélectionnée.
   */
  function planRecommendations(plan = state.sell?.plan ?? []) {
    if (!plan.length) return null;
    const rows = new Map();
    const totals = { quick: 0, balanced: 0, max: 0 };
    const nets = { quick: 0, balanced: 0, max: 0 };
    let priced = 0;
    for (const row of plan) {
      const rec = rowRecommendation(row);
      if (!rec) continue;
      rows.set(String(row.id), rec);
      if (!rec.estimated) priced += 1;
      const qty = Math.max(1, Number(row.qty) || 1);
      for (const key of SELL_STRATEGIES) {
        totals[key] += rec[key].price * qty;
        nets[key] += rec[key].net * qty;
      }
    }
    if (!rows.size) return null;
    return { rows, totals, nets, priced, total: plan.length };
  }

  /** Ligne d'explication sous les trois stratégies (carte seule ou lot). */
  function sellStrategyHint(rec, plan) {
    const isAuction = state.sell?.type === 'auction';
    const entries = plan
      .map((row) => ({ row, rec: rec.rows.get(String(row.id)) }))
      .filter((entry) => entry.rec);
    const priced = entries.filter((entry) => !entry.rec.estimated);
    // Carte la plus chère servie en exemple (elle pèse le plus dans le total).
    const pick = [...(priced.length ? priced : entries)].sort(
      (a, b) => b.rec.balanced.price - a.rec.balanced.price
    )[0];
    const chunks = [];
    if (plan.length > 1) chunks.push(`appliqué aux ${fmt(plan.length)} cartes`);
    if (pick && !pick.rec.estimated) {
      chunks.push(plan.length === 1 ? pick.rec.balanced.reason : `${pick.row.name} : ${pick.rec.balanced.reason}`);
    }
    if (!priced.length) chunks.push('aucune donnée de marché : les prix estimés sont conservés');
    else if (rec.priced < rec.total) {
      chunks.push(
        `${fmt(rec.total - rec.priced)} carte(s) sans données gardent leur prix estimé`
      );
    }
    if (plan.length > 1 && isAuction) chunks.push('la stratégie fixe la mise à prix de chaque enchère');
    return chunks.join(' · ');
  }

  function renderModal() {
    if (!ui) return;

    const kind = !state.sell && state.sellView.detailId ? 'detail' : state.sell ? 'sell' : 'closed';
    const kindKey = kind === 'detail' ? `detail:${state.sellView.detailId ?? ''}` : kind;
    // Même modale = on garde la position de lecture. Sinon (ouverture d'une
    // fiche, changement de vente), on repart naturellement du haut.
    let keepScroll = null;
    if (ui.modalCard.dataset.kind === kindKey) {
      const body = ui.modalCard.querySelector('.kp-modal-body');
      if (body) {
        keepScroll = {
          top: body.scrollTop,
          atBottom: body.scrollHeight - body.scrollTop - body.clientHeight < 32
        };
      }
    }
    const restoreScroll = () => {
      const body = ui.modalCard.querySelector('.kp-modal-body');
      if (!body || !keepScroll) return;
      body.scrollTop = keepScroll.atBottom ? body.scrollHeight : keepScroll.top;
    };

    // Fiche carte ouverte : elle prend la modale tant qu'aucune vente n'est préparée.
    if (!state.sell && state.sellView.detailId) {
      ui.modal.hidden = false;
      ui.modalCard.classList.add('is-wide');
      ui.modalCard.innerHTML = renderSellDetail();
      ui.modalCard.dataset.kind = kindKey;
      restoreScroll();
      return;
    }

    if (!state.sell) {
      ui.modal.hidden = true;
      ui.modalCard.classList.remove('is-wide');
      ui.modalCard.innerHTML = '';
      ui.modalCard.dataset.kind = 'closed';
      return;
    }

    ui.modalCard.classList.toggle('is-wide', state.sell.plan.length === 1);

    const plan = state.sell.plan;
    const isAuction = state.sell.type === 'auction';
    const totals = sellTotals(plan);
    const blocker = sellBlocker(plan);
    const chakra = toNum(state.user?.chakra) ?? 0;
    const running = state.sell.running;
    const done = state.sell.done;
    const buyouts = isAuction
      ? plan.map((row) => buyoutPriceFor(row.price, state.sell.buyoutPct)).filter((value) => value != null)
      : [];
    const buyoutPreview = buyouts.length
      ? { min: Math.min(...buyouts), max: Math.max(...buyouts) }
      : null;
    const durations = getCfg().durations;
    const lastCopies = lastCopyRows(plan);
    const planRec = planRecommendations(plan);

    ui.modal.hidden = false;
    ui.modalCard.innerHTML = `
      <div class="kp-modal-head">
        <b>${isAuction ? 'Mise en enchère' : 'Vente assistée'} · ${plan.length} carte(s)</b>
        <button class="kp-icon-btn" type="button" data-act="sell-close" ${running ? 'disabled' : ''}>✕</button>
      </div>
      <div class="kp-modal-body">
        <div class="kp-seg">
          <button class="kp-seg-btn ${isAuction ? '' : 'is-active'}" type="button" data-act="sell-type" data-type="fixed" ${running ? 'disabled' : ''}>Prix fixe</button>
          <button class="kp-seg-btn ${isAuction ? 'is-active' : ''}" type="button" data-act="sell-type" data-type="auction" ${running ? 'disabled' : ''}>Enchère</button>
        </div>

        <div class="kp-opt-row">
          <div>Durée de l'annonce<small>${
            isAuction ? 'L’enchère se termine à la fin du compte à rebours' : 'La carte reste en vente pendant ce temps'
          }</small></div>
          <select class="kp-select" data-sell-duration ${running ? 'disabled' : ''}>
            ${durations
              .map((h) => `<option value="${h}" ${Number(state.settings.durationHours) === Number(h) ? 'selected' : ''}>${h} h</option>`)
              .join('')}
          </select>
        </div>

        ${
          isAuction
            ? `<div class="kp-opt-row">
                 <div>Mise à prix sous la médiane<small>Ex. ${state.sell.auctionPct} % : une carte à 100 ◆ démarre à ${Math.max(1, 100 - state.sell.auctionPct)} ◆</small></div>
                 <input type="number" min="0" max="80" step="1" value="${state.sell.auctionPct}" data-sell-auction-pct ${running ? 'disabled' : ''}>
               </div>
               <div class="kp-opt-row">
                 <div>Achat immédiat<small>0 = aucun · ${
                   buyoutPreview != null
                     ? buyoutPreview.min === buyoutPreview.max
                       ? `soit ◆ ${fmt(buyoutPreview.max)}`
                       : `soit ◆ ${fmt(buyoutPreview.min)} – ◆ ${fmt(buyoutPreview.max)}`
                     : 'désactivé'
                 }</small></div>
                 <input type="number" min="0" max="300" step="5" value="${state.sell.buyoutPct}" data-sell-buyout-pct ${running ? 'disabled' : ''}>
               </div>`
            : ''
        }

        <div class="kp-summary">
          <div><span>${isAuction ? 'Mise à prix' : 'Brut'}</span><b>◆ ${fmt(totals.gross)}</b></div>
          <div><span>${isAuction ? 'Net si adjugé' : 'Net estimé'}</span><b>◆ ${fmt(totals.net)}</b></div>
          <div><span>Frais de dépôt</span><b>◆ ${fmt(totals.fees)}</b></div>
          <div><span>Taxe de vente</span><b>◆ ${fmt(totals.tax)}</b></div>
        </div>

        <div class="kp-hint">${totals.copies} ${isAuction ? 'enchère(s)' : 'annonce(s)'} · durée ${
          Number(state.settings.durationHours)
        } h · chakra dispo ◆ ${fmt(chakra)} · ${esc(
          state.settings.dryRun ? 'mode simulation' : `délai ${state.settings.gapMs} ms`
        )}${isAuction ? ' · le prix final dépend des enchérisseurs' : ''}</div>

        ${
          state.sell.marketPending
            ? `<div class="kp-hint"><span class="kp-spinner"></span> Lecture des prix fixes hauts et des achats immédiats…</div>`
            : planRec
              ? `<div class="kp-explain-sub">Prix recommandé <span class="kp-explain-count">${
                  plan.length > 1 ? `${fmt(plan.length)} cartes · ` : ''
                }${planRec.priced < planRec.total ? `${fmt(planRec.priced)}/${fmt(planRec.total)} valorisée(s)` : 'données marché'}</span></div>
                 <div class="kp-strategy-row">
                   ${SELL_STRATEGIES.map((key) => {
                     const option = planRec.rows.get(String(plan[0]?.id))?.[key];
                     const active = state.sell.method === key;
                     return `<button class="kp-strategy ${active ? 'is-active' : ''}" type="button" data-act="sell-strategy" data-strategy="${key}" ${running ? 'disabled' : ''}>
                         <b>${esc(option?.label ?? key)}</b>
                         <span>◆ ${fmt(planRec.totals[key])} <small>net ◆ ${fmt(planRec.nets[key])}</small></span>
                       </button>`;
                   }).join('')}
                 </div>
                 <div class="kp-hint">${esc(sellStrategyHint(planRec, plan))}</div>`
              : ''
        }

        ${
          lastCopies.length
            ? `<div class="kp-alert is-bad" style="margin-top:8px">
                 <b>Tu vends ta dernière copie</b><br>
                 ${esc(lastCopies.map((row) => row.name).join(', '))} quittera${lastCopies.length > 1 ? 'ont' : ''} définitivement ta collection.
                 <label class="kp-check" style="margin-top:6px">
                   <input type="checkbox" data-sell-confirm-lastcopy ${state.sell.confirmLastCopy ? 'checked' : ''} ${running ? 'disabled' : ''}>
                   <span>Je confirme vouloir vendre toutes mes copies</span>
                 </label>
               </div>`
            : ''
        }

        ${blocker ? `<div class="kp-alert is-bad">${esc(blocker)}</div>` : ''}

        <div class="kp-plan">
          ${plan
            .map(
              (row) => `
            <div class="kp-plan-row">
              <div class="kp-name">${esc(row.name)} <small>${
                (row.maxQty ?? 1) > 1 ? `${row.maxQty} vendable(s)` : 'seule copie'
              }${row.median != null ? ` · méd. ◆ ${fmt(row.median)}` : ''}</small></div>
              <input type="number" min="1" max="${Math.max(1, row.maxQty ?? 1)}" step="1" value="${row.qty}"
                data-sell-qty="${esc(row.characterId)}" title="Nombre d'exemplaires à mettre en vente" ${running ? 'disabled' : ''}>
              <input type="number" min="${Math.max(1, row.floor ?? 1)}" step="1" value="${row.price}" data-sell-price="${esc(row.characterId)}" ${running ? 'disabled' : ''}>
              <div class="kp-net">◆ ${fmt(netOf(row.price) * row.qty)}</div>
            </div>`
            )
            .join('')}
        </div>

        ${state.sell.log.length ? `<div class="kp-log">${state.sell.log.map((l) => `<div class="is-${l.kind}">${esc(l.text)}</div>`).join('')}</div>` : ''}
      </div>
      <div class="kp-modal-foot">
        <button class="kp-btn is-ghost" type="button" data-act="sell-close" ${running ? 'disabled' : ''}>Annuler</button>
        ${
          running
            ? `<button class="kp-btn is-danger" type="button" data-act="sell-stop">Arrêter</button>`
            : done
              ? `<button class="kp-btn is-primary" type="button" data-act="sell-close">Fermer</button>`
              : `<button class="kp-btn is-primary" type="button" data-act="sell-run" ${blocker ? 'disabled' : ''}>${
                  isAuction ? `Mettre ${totals.copies} enchère(s)` : `Vendre ${totals.copies} annonce(s)`
                }</button>`
        }
      </div>
    `;
    ui.modalCard.dataset.kind = kindKey;
    restoreScroll();
  }

  /* ------------------------------------------------------------------ */
  /* Events                                                              */
  /* ------------------------------------------------------------------ */

  function notify(message) {
    state.notice = message;
    if (state.noticeTimer) clearTimeout(state.noticeTimer);
    state.noticeTimer = setTimeout(() => {
      state.notice = '';
      state.noticeTimer = null;
      render();
    }, 5000);
    render();
  }

  function onClick(event) {
    const target = event.target;
    if (!target || typeof target.closest !== 'function') return;
    const el = target.closest('[data-act]');
    if (!el || !shadow.contains(el)) return;
    const act = el.getAttribute('data-act');

    // La ligne Vente est cliquable, mais la case à cocher ne doit pas ouvrir la fiche.
    if (act === 'sell-detail' && target.closest('input[data-sel]')) return;

    switch (act) {
      case 'mode': {
        const duel = duelState();
        duel.mode = el.getAttribute('data-mode') === 'duel' ? 'duel' : 'tools';
        render();
        break;
      }
      case 'duel-detach':
        duelDetach();
        break;
      case 'duel-attach':
        duelAttach();
        break;
      case 'toggle':
        toggle();
        break;
      case 'close':
        toggle(false);
        break;
      case 'refresh':
        loadData();
        break;
      case 'reload-ext': {
        if (!state.reloadArmed) {
          state.reloadArmed = true;
          if (state.reloadTimer) clearTimeout(state.reloadTimer);
          state.reloadTimer = setTimeout(() => {
            state.reloadArmed = false;
            state.reloadTimer = null;
            render();
          }, 8000);
          render();
          break;
        }
        if (state.reloadTimer) clearTimeout(state.reloadTimer);
        state.reloadTimer = null;
        state.reloadArmed = false;
        reloadExtension();
        break;
      }
      case 'reload-cancel':
        if (state.reloadTimer) clearTimeout(state.reloadTimer);
        state.reloadTimer = null;
        state.reloadArmed = false;
        render();
        break;
      case 'tab':
        state.tab = el.getAttribute('data-tab') || 'account';
        if (state.tab === 'account') {
          state.profile.view = 'self';
          state.profile.error = null;
        }
        if (state.tab === 'sell') {
          state.sellView.query = '';
        }
        if (
          state.tab === 'market' &&
          state.marketMode === 'global' &&
          state.marketView.items === null &&
          !state.marketView.loading
        ) {
          loadSellMarket(false);
        }
        render();
        break;
      case 'open-site':
        window.open('https://kyara.games/', '_blank', 'noopener');
        break;
      case 'open-card': {
        const id = el.getAttribute('data-id');
        if (id) window.open(`https://kyara.games/wiki/${encodeURIComponent(id)}`, '_blank', 'noopener');
        break;
      }
      case 'open-listing': {
        // Ouvre le marché du site directement sur cette annonce :
        // `annonce` = identifiant de la vente (le site ouvre sa fiche), `q` = repli si elle a disparu.
        const listing = el.getAttribute('data-listing');
        const type = el.getAttribute('data-type');
        const name = el.getAttribute('data-name');
        const params = new URLSearchParams();
        params.set('onglet', type === 'auction' ? 'encheres' : 'acheter');
        if (listing) params.set('annonce', listing);
        if (name) params.set('q', name);
        window.open(`https://kyara.games/marche?${params.toString()}`, '_blank', 'noopener');
        break;
      }
      case 'calc-prices': {
        if (state.priceRun.running) return;
        const ids = [...new Set(state.collection.map((c) => String(c.characterId ?? c.id)))];
        loadPrices(ids, true);
        break;
      }
      case 'sell-mode': {
        const mode = el.getAttribute('data-mode') === 'auto' ? 'auto' : 'mine';
        if (state.sellView.mode === mode) break;
        state.sellView.mode = mode;
        state.sellView.limit = 40;
        render();
        break;
      }
      case 'sell-rarity': {
        state.sellView.rarity = el.getAttribute('data-rarity') || 'all';
        state.sellView.limit = 40;
        render();
        break;
      }
      case 'sell-refresh':
        if (state.tab === 'market' && state.marketMode === 'global') loadSellMarket(false);
        else refreshSellData();
        break;
      case 'market-mode':
        state.marketMode = el.getAttribute('data-mode') === 'deals' ? 'deals' : 'global';
        render();
        if (state.marketMode === 'global' && state.marketView.items === null) loadSellMarket(false);
        break;
      case 'market-refresh':
        loadSellMarket(false);
        break;
      case 'market-more':
        loadSellMarket(true);
        break;
      case 'market-rarity':
        state.marketView.rarity = el.getAttribute('data-rarity') || 'all';
        loadSellMarket(false);
        break;
      case 'sell-more-rows':
        state.sellView.limit += 40;
        render();
        break;
      case 'sell-detail': {
        const id = el.getAttribute('data-id');
        if (id) openCardDetail(id);
        break;
      }
      case 'market-expand': {
        const id = el.getAttribute('data-id');
        if (!id) break;
        const set = state.marketView.expanded;
        if (set.has(id)) set.delete(id);
        else set.add(id);
        render();
        break;
      }
      case 'sell-detail-close':
        closeCardDetail();
        break;
      case 'sell-detail-refresh':
      case 'sell-detail-retry': {
        const id = el.getAttribute('data-id') || state.sellView.detailId;
        if (id) openCardDetail(id);
        break;
      }
      case 'sell-card': {
        const id = el.getAttribute('data-id');
        const row = sellRowOf(id);
        if (!row) {
          notify('Carte introuvable dans la collection.');
          break;
        }
        if (row.sellable < 1) {
          notify(`Non vendable : ${row.block?.reason ?? 'aucun exemplaire libre'}.`);
          break;
        }
        const price = Number(el.getAttribute('data-price'));
        const type = el.getAttribute('data-type');
        prepareSell([row], { price: Number.isFinite(price) ? price : undefined, type });
        break;
      }
      case 'sell-strategy': {
        if (!state.sell || state.sell.running) break;
        const key = el.getAttribute('data-strategy');
        if (!SELL_STRATEGIES.includes(key)) break;
        const rec = planRecommendations(state.sell.plan);
        if (!rec) break;
        // Chaque carte prend son propre prix : la stratégie s'applique à tout le lot.
        for (const row of state.sell.plan) {
          const option = rec.rows.get(String(row.id))?.[key];
          if (!option) continue;
          row.price = Math.max(Math.round(row.floor ?? 1), Math.round(option.price));
        }
        state.sell.method = key;
        render();
        break;
      }
      case 'select-all': {
        // Une carte = une annonce : on remplit les places libres, sans dépasser la limite.
        const { remaining } = listingSlots();
        const list = filteredSellRows();
        state.selected.clear();
        for (const row of list) {
          if (row.sellable < 1) continue;
          if (state.selected.size >= remaining) break;
          state.selected.add(row.id);
        }
        render();
        break;
      }
      case 'select-none':
        state.selected.clear();
        render();
        break;
      case 'load-market-more':
        state.marketLimit += 24;
        render();
        break;
      case 'prepare-sell':
        prepareSell();
        break;
      case 'sell-close':
        if (state.sell?.running) return;
        state.sell = null;
        render();
        break;
      case 'sell-run':
        executeSell();
        break;
      case 'sell-type': {
        if (!state.sell || state.sell.running) break;
        const type = el.getAttribute('data-type') === 'auction' ? 'auction' : 'fixed';
        if (state.sell.type === type) break;
        state.sell.type = type;
        state.settings.saleType = type;
        persistSettings();
        resetPlanPrices();
        render();
        break;
      }
      case 'sell-stop':
        if (state.sell) {
          state.sell.running = false;
          state.sell.log.push({ text: 'Arrêt demandé…', kind: 'info' });
          render();
        }
        break;
      case 'autosell-preview':
        autoSellPreview();
        break;
      case 'autosell-start':
        if (state.autoSell.armed) startAutoSell();
        else armAutoSell();
        break;
      case 'autosell-cancel':
        disarmAutoSell();
        break;
      case 'autosell-stop':
        stopAutoSell();
        break;
      case 'scan-market':
        scanMarket();
        break;
      case 'deals-rarity': {
        const rarity = el.getAttribute('data-rarity') || 'all';
        state.settings.dealsRarity = rarity;
        persistSettings();
        render();
        break;
      }
      case 'deals-type': {
        const type = el.getAttribute('data-type') || 'all';
        state.settings.dealsType = type;
        persistSettings();
        render();
        break;
      }
      case 'auto-pack': {
        const id = el.getAttribute('data-id');
        if (!id) return;
        const key = String(id);
        const current = (state.settings.autoPackIds ?? []).map(String);
        state.settings.autoPackIds = current.includes(key)
          ? current.filter((value) => value !== key)
          : [...current, key];
        state.settings.autoPackPicked = true;
        persistSettings();
        render();
        break;
      }
      case 'auto-start':
        primeAudio();
        startAutoOpen();
        break;
      case 'auto-stop':
        stopAutoOpen();
        break;
      case 'auto-refresh':
        loadPackState(true);
        autoRefreshTick(true);
        break;
      case 'auto-sound-test':
        primeAudio();
        playOpenSound(2);
        notify('Son de test joué.');
        break;
      case 'auto-log-copy': {
        const lines = (state.autoOpen.log ?? []).map((e) => `${fmtClock(e.t)}  ${e.m}`);
        const text = lines.length ? lines.join('\n') : 'Aucun évènement.';
        copyText(text).then((ok) => notify(ok ? 'Journal copié.' : 'Copie refusée.'));
        break;
      }
      case 'auto-log-clear':
        state.autoOpen.log = [];
        state.autoOpen.restarts = 0;
        storageSet(AUTO_LOG_KEY, []);
        notify('Journal vidé.');
        render();
        break;
      case 'update-check':
        checkRemoteVersion(true);
        break;
      case 'update-now':
        updateAndReload();
        break;
      case 'anti-afk-test': {
        if (state.settings.antiAfk === false) {
          notify('Anti-AFK désactivé : coche « Répondre à l’anti-AFK ».');
          break;
        }
        const target = findAfkButton();
        if (target) {
          notify(`Anti-AFK : bouton détecté (« ${afkLabelOf(target).slice(0, 24) || 'sans texte'} »).`);
          scanAfk();
        } else {
          notify('Anti-AFK actif : aucune boîte « toujours là ? » détectée pour le moment.');
        }
        render();
        break;
      }
      case 'update-download':
        window.open(UPDATE_ZIP, '_blank', 'noopener');
        notify('Archive téléchargée : remplace les fichiers du dossier, puis recharge l’extension.');
        break;
      case 'update-repo':
        window.open(UPDATE_PAGE, '_blank', 'noopener');
        break;
      case 'packs-refresh':
        loadPacks(true);
        loadPackPools(true);
        break;
      case 'packs-averages':
        computePackAverages(true);
        break;
      case 'pack-target': {
        const id = el.getAttribute('data-id');
        const card = state.characters.get(String(id)) ?? null;
        state.packTarget = card ? { id: String(id), card } : null;
        state.packQuery = '';
        render();
        break;
      }
      case 'pack-target-clear':
        state.packTarget = null;
        state.packQuery = '';
        render();
        break;
      case 'profile-search':
        searchProfile();
        break;
      case 'stat-refresh':
        syncStatAccounts(true);
        break;
      case 'stat-friends':
        syncFriendsIntoStats({ manual: true });
        break;
      case 'stat-search':
        runStatSearch();
        break;
      case 'stat-add': {
        const hit = (state.stats.results ?? []).find((row) => String(row.id) === String(el.getAttribute('data-id')));
        if (hit) statsAddAccount(hit);
        break;
      }
      case 'stat-remove':
        statsRemoveAccount(el.getAttribute('data-id'));
        break;
      case 'stat-sort': {
        const data = statBoardData();
        const key = el.getAttribute('data-key') || 'value';
        if (data.sort === key) data.desc = !data.desc;
        else {
          data.sort = key;
          data.desc = true;
        }
        persistStatsSoon();
        render();
        break;
      }
      case 'stat-sort-dir': {
        const data = statBoardData();
        data.desc = !data.desc;
        persistStatsSoon();
        render();
        break;
      }
      case 'stat-expand': {
        const id = el.getAttribute('data-id');
        state.stats.expanded = state.stats.expanded === id ? null : id;
        render();
        break;
      }
      case 'stat-resync': {
        const id = String(el.getAttribute('data-id') ?? '');
        const data = statBoardData();
        if (data.accounts[id]) {
          state.stats.expanded = id;
          syncStatAccounts(true);
        }
        break;
      }
      case 'profile-open':
        state.profile.query = el.getAttribute('data-pseudo') || state.profile.query;
        loadProfile(el.getAttribute('data-id'));
        break;
      case 'profile-back':
        resetProfile();
        break;
      case 'clear-cache':
        state.prices = {};
        state.lowest = {};
        state.fixedLow = {};
        state.fixedHigh = {};
        state.auctionBuyout = {};
        state.buyOrders = {};
        state.marketLoaded.clear();
        state.marketScanned.clear();
        marketPending.clear();
        storageSet(PRICE_KEY, { savedAt: 0, prices: {} });
        notify('Cache des prix vidé.');
        break;
      case 'export-json': {
        const rows = ownedRows().map((r) => ({
          id: r.id,
          name: r.name,
          rarity: r.rarity,
          series: r.series,
          qty: r.qty,
          listable: r.listable,
          price: r.price,
          value: r.price == null ? null : r.price * r.qty
        }));
        const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), user: state.user?.pseudo, rows }, null, 2)], {
          type: 'application/json'
        });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'kyara-collection.json';
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 2000);
        notify('Export téléchargé.');
        break;
      }
      case 'copy-diag': {
        const diag = {
          version: VERSION,
          user: state.user ? { id: state.user.id, pseudo: state.user.pseudo } : null,
          bootKeys: state.bootKeys,
          collection: state.collection.slice(0, 2),
          prices: Object.entries(state.prices).slice(0, 2),
          config: state.config,
          access: state.access,
          requests: state.debug.slice(0, 25)
        };
        copyText(JSON.stringify(diag, null, 2));
        notify('Diagnostic copié.');
        break;
      }
      default:
        break;
    }
  }

  function onChange(event) {
    const target = event.target;
    if (!target || typeof target.closest !== 'function') return;
    const checkbox = target.closest('input[data-sel]');
    if (checkbox) {
      const id = checkbox.getAttribute('data-sel');
      if (!checkbox.checked) {
        state.selected.delete(id);
        render();
        return;
      }

      // Une place par carte cochée (une annonce par défaut).
      const row = sellRowOf(id);
      const { remaining } = listingSlots();
      const already = selectedCopies();
      const need = 1;

      if (!row || row.sellable < 1) {
        notify(`Non vendable : ${row?.block?.reason ?? 'carte introuvable dans la collection'}.`);
        render();
        return;
      }

      if (already + need > remaining) {
        const free = Math.max(0, remaining - already);
        notify(
          free > 0
            ? `Il te reste ${free} place(s) d'annonce : retire une annonce ou décoche une carte.`
            : `Limite d'annonces actives atteinte (${listingSlots().active}/${listingSlots().max}). Retire une annonce ou décoche une carte.`
        );
        render();
        return;
      }

      state.selected.add(id);
      render();
      return;
    }

    // --- Onglet Stat : critère comparé ---
    const statMetric = target.closest('[data-stat-metric]');
    if (statMetric) {
      const data = statBoardData();
      const key = String(statMetric.value);
      if (STAT_COLUMNS.some((column) => column.key === key)) {
        data.sort = key;
        data.desc = true;
        persistStatsSoon();
        render();
      }
      return;
    }

    // --- Onglet Vente : filtres et options ---
    const sellSort = target.closest('[data-sell-sort]');
    if (sellSort) {
      state.sellView.sort = String(sellSort.value);
      state.sellView.limit = 40;
      render();
      return;
    }

    // --- Onglet Marché : recherche globale ---
    const marketSort = target.closest('[data-market-sort]');
    if (marketSort) {
      state.marketView.sort = String(marketSort.value) || 'price_desc';
      loadSellMarket(false);
      return;
    }

    const marketType = target.closest('[data-market-type]');
    if (marketType) {
      state.marketView.type = String(marketType.value) || 'all';
      loadSellMarket(false);
      return;
    }

    const sellSeries = target.closest('[data-sell-series]');
    if (sellSeries) {
      state.sellView.series = String(sellSeries.value) || 'all';
      state.sellView.limit = 40;
      render();
      return;
    }

    const sellOnlySellable = target.closest('[data-sell-only-sellable]');
    if (sellOnlySellable) {
      state.sellView.onlySellable = Boolean(sellOnlySellable.checked);
      state.sellView.limit = 40;
      render();
      return;
    }

    const sellOnlyDupes = target.closest('[data-sell-only-dupes]');
    if (sellOnlyDupes) {
      state.sellView.onlyDupes = Boolean(sellOnlyDupes.checked);
      state.sellView.limit = 40;
      render();
      return;
    }

    const confirmLastCopy = target.closest('[data-sell-confirm-lastcopy]');
    if (confirmLastCopy && state.sell) {
      state.sell.confirmLastCopy = Boolean(confirmLastCopy.checked);
      render();
      return;
    }

    // --- Vente auto : réglages (jamais modifiables pendant la boucle) ---
    const autoType = target.closest('[data-autosell-type]');
    const autoStrategy = target.closest('[data-autosell-strategy]');
    const autoMin = target.closest('[data-autosell-min-price]');
    const autoInterval = target.closest('[data-autosell-interval]');
    const autoMax = target.closest('[data-autosell-max]');
    const autoIncludeML = target.closest('[data-autosell-include-ml]');
    const autoDryRun = target.closest('[data-autosell-dryrun]');
    if (autoType || autoStrategy || autoMin || autoInterval || autoMax || autoIncludeML || autoDryRun) {
      if (state.autoSell.running) return;
      state.autoSell.armed = false;
      if (autoType) state.settings.autoSellType = autoType.value === 'auction' ? 'auction' : 'fixed';
      if (autoStrategy) {
        state.settings.autoSellStrategy = ['quick', 'balanced', 'max'].includes(autoStrategy.value)
          ? autoStrategy.value
          : 'balanced';
      }
      if (autoMin) state.settings.autoSellMinPrice = Math.max(1, Math.round(Number(autoMin.value) || 1));
      if (autoInterval) {
        state.settings.autoSellIntervalSec = Math.min(
          3600,
          Math.max(30, Math.round(Number(autoInterval.value) || 60))
        );
      }
      if (autoMax) {
        state.settings.autoSellMaxPerCycle = Math.min(
          10,
          Math.max(1, Math.round(Number(autoMax.value) || 10))
        );
      }
      if (autoIncludeML) state.settings.autoSellIncludeML = Boolean(autoIncludeML.checked);
      if (autoDryRun) state.settings.autoSellDryRun = Boolean(autoDryRun.checked);
      persistSettings();
      render();
      return;
    }

    const setting = target.closest('[data-setting]');
    if (setting) {
      const key = setting.getAttribute('data-setting');
      let value;
      if (setting.type === 'checkbox') value = setting.checked;
      else if (
        key === 'saleType' ||
        key === 'durationHours' ||
        key === 'dealsRarity' ||
        key === 'dealsSort' ||
        key === 'dealsType' ||
        key === 'dupeSort'
      ) {
        value = String(setting.value);
      } else value = Number(setting.value);
      if (typeof value === 'number' && !Number.isFinite(value)) return;
      state.settings[key] = key === 'durationHours' ? Number(value) : value;
      if (key === 'dealsPages') state.settings.dealsPages = Math.min(20, Math.max(1, Math.round(Number(value) || 6)));
      if (key === 'dealsMinPct') state.settings.dealsMinPct = Math.min(90, Math.max(0, Math.round(Number(value) || 0)));
      if (key === 'autoMaxPerBoosterMin') {
        state.settings.autoMaxPerBoosterMin = Math.min(60, Math.max(1, Math.round(Number(value) || 10)));
      }
      if (key === 'autoRefreshMin') state.settings.autoRefreshMin = Math.min(120, Math.max(1, Math.round(Number(value) || 10)));
      persistSettings();
      if (key === 'ttlH') schedulePriceRun();
      if (key === 'autoRefreshMin') startAutoRefreshLoop();
      if (key === 'antiAfk' && state.settings.antiAfk !== false) scanAfk();
      if (key === 'dealsSort' || key === 'dealsPages' || key === 'dealsMinPct') {
        // Ces réglages changent la requête : on relance le scan si un scan a déjà eu lieu.
        if (state.deals !== null) scanMarket();
      }
      render();
      return;
    }

    const auctionPctInput = target.closest('[data-sell-auction-pct]');
    if (auctionPctInput && state.sell) {
      const pct = Math.min(80, Math.max(0, Math.round(Number(auctionPctInput.value) || 0)));
      state.sell.auctionPct = pct;
      state.settings.auctionPct = pct;
      persistSettings();
      resetPlanPrices();
      render();
      return;
    }

    const buyoutPctInput = target.closest('[data-sell-buyout-pct]');
    if (buyoutPctInput && state.sell) {
      const pct = Math.min(300, Math.max(0, Math.round(Number(buyoutPctInput.value) || 0)));
      state.sell.buyoutPct = pct;
      state.settings.buyoutPct = pct;
      persistSettings();
      render();
      return;
    }

    const durationInput = target.closest('[data-sell-duration]');
    if (durationInput) {
      const hours = Number(durationInput.value);
      if (Number.isFinite(hours) && hours > 0) {
        state.settings.durationHours = hours;
        persistSettings();
        renderModal();
      }
      return;
    }

    const priceInput = target.closest('[data-sell-price]');
    if (priceInput && state.sell) {
      const id = priceInput.getAttribute('data-sell-price');
      const row = state.sell.plan.find((r) => String(r.characterId) === String(id));
      if (row) {
        row.price = Math.max(1, Math.round(Number(priceInput.value) || 1));
        // Prix saisi à la main : plus aucune stratégie n'est « active ».
        if (state.sell.method) state.sell.method = null;
        renderModal();
      }
      return;
    }

    const qtyInput = target.closest('[data-sell-qty]');
    if (qtyInput && state.sell) {
      const id = qtyInput.getAttribute('data-sell-qty');
      const row = state.sell.plan.find((r) => String(r.characterId) === String(id));
      if (row) {
        const maxQty = Math.max(1, row.maxQty ?? 1);
        const value = Math.round(Number(qtyInput.value));
        row.qty = Number.isFinite(value) ? Math.min(maxQty, Math.max(1, value)) : 1;
        // Changer la quantité peut retirer la « dernière copie » : la confirmation repart de zéro.
        if (state.sell) state.sell.confirmLastCopy = false;
        renderModal();
      }
    }
  }

  function onKeyDown(event) {
    if (event.key !== 'Enter') return;
    const target = event.target;
    if (!target || typeof target.closest !== 'function') return;
    if (target.closest('[data-role="profile-search"]')) {
      event.preventDefault();
      const results = state.profile.results;
      if (Array.isArray(results) && results.length === 1) {
        loadProfile(results[0].id);
        return;
      }
      searchProfile();
      return;
    }
    if (target.closest('[data-role="stat-account-search"]')) {
      event.preventDefault();
      const results = state.stats.results;
      if (Array.isArray(results) && results.length === 1) {
        statsAddAccount(results[0]);
        return;
      }
      runStatSearch();
    }
  }

  function onInput(event) {
    const target = event.target;
    if (!target || typeof target.closest !== 'function') return;


    const packSearch = target.closest('[data-role="pack-search"]');
    if (packSearch) {
      state.packQuery = packSearch.value;
      // Retaper une recherche relance la chasse : on quitte la carte sélectionnée.
      if (state.packTarget && state.packQuery.trim()) state.packTarget = null;
      render();
      const again = qs('[data-role="pack-search"]');
      if (again) {
        again.focus();
        try {
          again.setSelectionRange(again.value.length, again.value.length);
        } catch {
          /* ignore */
        }
      }
      return;
    }

    const profileSearch = target.closest('[data-role="profile-search"]');
    if (profileSearch) {
      state.profile.query = profileSearch.value;
      scheduleProfileSearch();
      return;
    }

    const statSearch = target.closest('[data-role="stat-account-search"]');
    if (statSearch) {
      state.stats.query = statSearch.value;
      scheduleStatSearch();
      return;
    }

    const marketSearch = target.closest('[data-role="market-search"]');
    if (marketSearch) {
      state.marketView.query = marketSearch.value;
      render();
      const again = qs('[data-role="market-search"]');
      if (again) {
        again.focus();
        try {
          again.setSelectionRange(again.value.length, again.value.length);
        } catch {
          /* type=search may not support it */
        }
      }
      // Requête serveur différée : on ne tape pas l'API à chaque lettre.
      if (sellSearchTimer) clearTimeout(sellSearchTimer);
      sellSearchTimer = setTimeout(() => {
        sellSearchTimer = null;
        loadSellMarket(false);
      }, 400);
      return;
    }

    const search = target.closest('[data-role="sell-search"]');
    if (!search) return;
    state.sellView.query = search.value;
    state.sellView.limit = 40;
    // Le champ est reconstruit à chaque rendu : on restaure le focus et le curseur.
    const restoreFocus = () => {
      const again = qs('[data-role="sell-search"]');
      if (!again) return;
      again.focus();
      const pos = again.value.length;
      try {
        again.setSelectionRange(pos, pos);
      } catch {
        /* type=search may not support it */
      }
    };

    // Collection : filtrage local différé, pour rester fluide sur une grosse collection.
    if (sellRenderTimer) clearTimeout(sellRenderTimer);
    sellRenderTimer = setTimeout(() => {
      sellRenderTimer = null;
      render();
      restoreFocus();
    }, 160);
  }

  let sellSearchTimer = null;
  let sellRenderTimer = null;

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
        return true;
      } catch {
        return false;
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* Start                                                               */
  /* ------------------------------------------------------------------ */

  // Hook de développement, utilisé par le harness local uniquement.
  // Le content script ne s'exécute en production que sur kyara.games.
  if (location.hostname === '127.0.0.1' || location.hostname === 'localhost') {
    window.__kyaraPlus = {
      state,
      render,
      setOpen: (open) => {
        state.open = Boolean(open);
        render();
      },
      setTab: (tab) => {
        state.tab = tab;
        render();
      },
      prepareSell,
      executeSell,
      loadData,
      scanMarket,
      loadPrices,
      listingSlots,
      selectedCopies,
      filteredDupes,
      searchProfile,
      loadProfile,
      resetProfile,
      autoRefreshTick,
      checkRemoteVersion,
      updateAndReload,
      resumeAutoOpenIfNeeded,
      scanAfk,
      findAfkButton,
      findAfkContainer,
      afkConfirmIn,
      afkLabelOf,
      autoDelay,
      autoDelayRange,
      autoRegenInfo,
      startAutoOpen,
      stopAutoOpen,
      ensureAutoAlive,
      autoLog,
      autoSellPreview,
      autoSellCycle,
      startAutoSell,
      stopAutoSell,
      armAutoSell,
      disarmAutoSell,
      autoSellPanel,
      loadAutoLog,
      trackBestCards,
      recordAutoResults,
      refreshAutoAccount,
      mergeUser,
      sellRows,
      sellRowOf,
      sellBlockState,
      updateLockBadges,
      prepareSell,
      // Statistiques globales (utile pour les tests du harness)
      loadStats,
      syncStatAccounts,
      statsAddAccount,
      statsRemoveAccount,
      statRows,
      statSortAccounts,
      statRankRows,
      statSeriesProgress,
      statCollectionValue,
      statAccountMetrics,
      statOwnerCounts,
      // +Duel
      duelState,
      publishDuelProfile
    };
  }

  boot();
  loadDuelWindowState();
  window.addEventListener('message', onDuelMessage);

  // Compte à rebours de l'auto-open : on ne touche qu'au texte, pas au panneau entier.
  setInterval(() => {
    if (state.autoOpen.nextAt) updateCountdownText();
  }, 1000);

  // Verrous de revente : on rafraîchit les décomptes affichés, sans re-rendu complet.
  setInterval(() => {
    if (state.open && state.tab === 'sell') updateLockBadges();
  }, 30000);

  setInterval(() => {
    if (
      state.open &&
      state.user &&
      !state.loading &&
      !state.priceRun.running &&
      !state.sell?.running &&
      !state.autoOpen.running
    ) {
      refreshLight();
    }
  }, 90000);

  console.info(`[Kyareeh+] v${VERSION} chargé`);
})();
