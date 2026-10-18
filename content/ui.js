/* Kyareeh+ — content script
 * Tableau de bord de compte, valorisation en chakra et vente assistée.
 * Tout passe par la session existante de l'utilisateur : aucun identifiant stocké.
 */
(() => {
  'use strict';

  if (window.__kyaraPlusLoaded) return;
  window.__kyaraPlusLoaded = true;

  const ext = globalThis.browser ?? globalThis.chrome;

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
    autoStopRare: false
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
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));  const toNum = (v) => {
    // Attention : Number(null) vaut 0. On veut null pour « absent ».
    if (v == null || v === '') return null;
    const n = typeof v === 'string' ? Number.parseFloat(v.replace(',', '.')) : Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const nowTime = () =>
    new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });

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
    buyOrders: {},
    marketLoaded: new Set(),
    marketLoading: false,
    marketLimit: 24,
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
      tabs: qs('#kp-tabs'),
      view: qs('#kp-view'),
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
      notify(`${reason} Passe par about:debugging → « Recharger ».`);
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
    state.settings.dealsRarity = String(state.settings.dealsRarity || 'all');
    state.settings.dupeSort = DUPE_SORTS.some(([value]) => value === state.settings.dupeSort) ? state.settings.dupeSort : 'price_desc';
    state.settings.dealsType = ['all', 'fixed', 'auction'].includes(state.settings.dealsType) ? state.settings.dealsType : 'all';
    state.settings.dealsSort = DEAL_SORTS.some(([value]) => value === state.settings.dealsSort) ? state.settings.dealsSort : 'price_asc';
    state.settings.dealsPages = Math.min(20, Math.max(1, Math.round(state.settings.dealsPages)));
    state.settings.dealsMinPct = Math.min(90, Math.max(0, Math.round(state.settings.dealsMinPct)));
    state.settings.autoMaxPerBoosterMin = Math.min(
      60,
      Math.max(0.2, Number(state.settings.autoMaxPerBoosterMin ?? DEFAULT_SETTINGS.autoMaxPerBoosterMin))
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
    await mount();
    await loadData();
    await loadAutoLog();
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
      if (Array.isArray(coll)) state.collection = coll;
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
      at: Date.now()
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
          state.prices[id] = parsePriceEntry(array[index]) ?? { m7: null, m30: null, at: Date.now() };
        });
        state.priceRun.done += chunk.length;
      } else if (chunk.length <= 80) {
        for (const id of chunk) {
          if (!state.priceRun.running) break;
          try {
            const data = await api(`/api/market/prices/${encodeURIComponent(id)}`, { timeout: 15000 });
            state.prices[id] = parsePriceEntry(data) ?? { m7: null, m30: null, at: Date.now() };
          } catch {
            state.prices[id] = { m7: null, m30: null, at: Date.now(), failed: true };
          }
          state.priceRun.done += 1;
          await sleep(120);
        }
      } else {
        chunk.forEach((id) => {
          state.prices[id] = { m7: null, m30: null, at: Date.now(), failed: true };
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
      const price = priceOf(id);
      rows.push({
        id,
        rawId,
        qty,
        listable,
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

  function duplicateRows() {
    return ownedRows()
      .map((r) => ({ ...r, sellable: sellableOf(r) }))
      .filter((r) => r.sellable > 0);
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
  /* Market info (lowest listing + best buy order)                       */
  /* ------------------------------------------------------------------ */

  async function loadMarketInfo(ids, limit = state.marketLimit) {
    if (state.marketLoading) return;
    const room = Math.max(0, limit - state.marketLoaded.size);
    const todo = ids.map(String).filter((id) => !state.marketLoaded.has(id)).slice(0, room);
    if (!todo.length) return;

    state.marketLoading = true;
    render();

    let cursor = 0;
    const worker = async () => {
      while (cursor < todo.length) {
        const id = todo[cursor++];
        const key = String(id);
        try {
          const [listings, book] = await Promise.all([
            api(`/api/market/listings?characterId=${encodeURIComponent(key)}&sort=price_asc&pageSize=20`, {
              timeout: 15000
            }).catch(() => null),
            api(`/api/market/buy-orders?characterId=${encodeURIComponent(key)}`, { timeout: 12000 }).catch(() => null)
          ]);

          const items = Array.isArray(listings?.items) ? listings.items : Array.isArray(listings) ? listings : [];
          const prices = items
            .filter((it) => !it.isMine)
            .map((it) => (String(it.type) === 'fixed' ? toNum(it.price) : toNum(it.buyoutPrice)))
            .filter((v) => v != null && v > 0);
          if (prices.length) state.lowest[key] = Math.min(...prices);

          const embedded = items.find((it) => it && it.prices)?.prices;
          if (embedded && !priceFresh(state.prices[key])) {
            state.prices[key] = {
              m7: toNum(embedded.median7d),
              m30: toNum(embedded.median30d),
              sales7d: toNum(embedded.sales7d),
              sales30d: toNum(embedded.sales30d),
              at: Date.now()
            };
          }

          const orders = Array.isArray(book) ? book : Array.isArray(book?.items) ? book.items : Array.isArray(book?.orders) ? book.orders : [];
          const best = orders
            .filter((o) => !o.isMine)
            .filter((o) => !o.status || ['open', 'active', 'pending'].includes(String(o.status)))
            .map((o) => ({ price: toNum(o.price ?? o.maxPrice ?? o.maxAmount), qty: toNum(o.qty ?? o.remaining ?? o.remainingQty) }))
            .filter((o) => o.price != null && o.price > 0)
            .sort((a, b) => b.price - a.price)[0];
          if (best) state.buyOrders[key] = best;
        } catch {
          /* ignore */
        }
        state.marketLoaded.add(key);
        await sleep(100);
      }
    };

    await Promise.all([worker(), worker()]);
    state.marketLoading = false;
    render();
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

  function prepareSell() {
    const rows = filteredDupes().filter((r) => state.selected.has(r.id) && r.sellable > 0);
    if (!rows.length) return;

    const type = state.settings.saleType;
    const plan = rows.map((r) => ({
      characterId: apiId(r.rawId ?? r.id),
      name: r.name,
      image: r.image,
      rarity: r.rarity,
      qty: r.sellable,
      median: priceOf(r.id),
      floor: recycleFloor(r.rarity),
      price: type === 'auction' ? auctionStartPrice(r.id, r.rarity, state.settings.auctionPct) : suggestPrice(r.id, r.rarity)
    }));

    state.sell = {
      plan,
      type,
      auctionPct: state.settings.auctionPct,
      buyoutPct: state.settings.buyoutPct,
      running: false,
      done: false,
      log: []
    };
    render();
  }

  function resetPlanPrices() {
    const sell = state.sell;
    if (!sell) return;
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

  /** Nombre d'exemplaires déjà cochés (chaque copie = une annonce). */
  function selectedCopies() {
    let copies = 0;
    for (const row of duplicateRows()) {
      if (state.selected.has(row.id)) copies += row.sellable;
    }
    return copies;
  }

  function sellBlocker(plan) {
    const t = sellTotals(plan);
    const chakra = toNum(state.user?.chakra) ?? 0;
    const { max, remaining } = listingSlots();
    const isAuction = state.sell?.type === 'auction';

    if (!plan.length) return 'Aucune carte sélectionnée.';

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
    return '';
  }

  async function executeSell() {
    if (!state.sell || state.sell.running) return;
    const plan = state.sell.plan;
    const blocker = sellBlocker(plan);
    if (blocker) {
      notify(blocker);
      return;
    }

    state.sell.running = true;
    state.sell.done = false;
    state.sell.log = [];
    render();

    const cfg = getCfg();
    const duration = cfg.durations.includes(Number(state.settings.durationHours))
      ? Number(state.settings.durationHours)
      : cfg.durations[0] ?? 12;
    const saleType = state.sell.type === 'auction' ? 'auction' : 'fixed';
    const buyoutPct = Number(state.sell.buyoutPct) || 0;
    let consecutiveErrors = 0;

    const log = (text, kind = 'info') => {
      state.sell.log.push({ text, kind });
      render();
    };

    for (const row of plan) {
      for (let copy = 0; copy < row.qty; copy += 1) {
        if (!state.sell.running) break;

        if (state.settings.dryRun) {
          const label = saleType === 'auction' ? `enchère dès ◆ ${fmt(row.price)}` : `prix fixe ◆ ${fmt(row.price)}`;
          log(`(simulation) ${row.name} · ${label}`, 'info');
          await sleep(90);
          continue;
        }

        try {
          const buyout = saleType === 'auction' ? buyoutPriceFor(row.price, buyoutPct) : null;
          const result = await api('/api/market/listings', {
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
          const label = saleType === 'auction' ? `enchère dès ◆ ${fmt(row.price)}` : `prix fixe ◆ ${fmt(row.price)}`;
          log(`✓ ${row.name} · ${label}${result?.matched ? ' · vendue immédiatement' : ''}`, 'ok');
          consecutiveErrors = 0;
        } catch (err) {
          log(`✗ ${row.name} · ${friendlyError(err)}`, 'err');
          consecutiveErrors += 1;
          if (consecutiveErrors >= 3) {
            log('Arrêt après 3 erreurs consécutives.', 'err');
            state.sell.running = false;
          }
        }

        await sleep(Math.max(350, state.settings.gapMs));
      }
      if (!state.sell.running) break;
    }

    state.sell.running = false;
    state.sell.done = true;
    log('Terminé.', 'info');
    state.selected.clear();

    await loadData({ keepPrices: true });
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
    ui.fab.classList.toggle('is-open', state.open);
    if (!state.open) {
      renderModal();
      return;
    }

    const view = ui.view;
    const scrollTop = view.scrollTop;
    renderBanner();
    renderStats();
    renderTabs();
    renderView();
    renderFooter();
    renderModal();
    view.scrollTop = scrollTop;
  }

  function renderBanner() {
    if (!ui?.banner) return;

    // 1) Une version plus récente existe sur GitHub.
    const remote = state.update.version;
    if (remote && isNewerVersion(remote, state.version)) {
      ui.banner.hidden = false;
      ui.banner.classList.remove('is-stale');
      ui.banner.innerHTML = `
        <span class="kp-banner-text">
          Version <b>v${esc(remote)}</b> disponible (tu as v${esc(state.version)}).
        </span>
        <button class="kp-btn is-primary" type="button" data-act="update-download">Télécharger</button>
        <button class="kp-btn is-ghost" type="button" data-act="tab" data-tab="settings">Comment ?</button>
      `;
      return;
    }

    // 2) Firefox garde un manifeste plus ancien que le dossier.
    if (state.manifestOutdated) {
      ui.banner.hidden = false;
      ui.banner.classList.add('is-stale');
      ui.banner.innerHTML = `
        <span class="kp-banner-text">
          Le dossier est en v${esc(state.version)} mais Firefox a chargé v${esc(state.manifestVersion ?? '?')}.
          Retire l'add-on dans <code>about:debugging</code>, puis recharge-le depuis le dossier.
        </span>
        <button class="kp-btn is-primary" type="button" data-act="tab" data-tab="settings">Voir les Réglages</button>
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
      <div class="kp-metric"><span>Doublons</span><b>${fmt(stats.dupCopies)} <small>vendables</small></b></div>
    `;
  }

  function renderTabs() {
    if (!ui) return;
    const dupes = duplicateRows().length;
    const tabs = [
      ['account', 'Compte'],
      ['dupes', dupes ? `Doublons (${dupes})` : 'Doublons'],
      ['market', 'Marché'],
      ['cards', 'Cartes'],
      ['auto', 'Auto-Open'],
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
      <span>v${esc(state.version)}${state.manifestOutdated ? ' · maj dispo' : ''} · Alt+K</span>
    `;
  }

  function renderView() {
    if (!ui) return;
    const fn = {
      account: viewAccount,
      dupes: viewDupes,
      market: viewMarket,
      cards: viewCards,
      auto: viewAuto,
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
        <div class="kp-section-title">Ressources <span class="kp-link" data-act="tab" data-tab="dupes">${plural(dupeCount, 'doublon')} →</span></div>
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

  function viewDupes() {
    if (!state.user) return loginHTML();
    const all = duplicateRows();
    const rows = filteredDupes();

    if (!all.length) {
      return `<div class="kp-empty"><b>Aucun doublon</b>Ta collection ne contient pas encore de carte en double.</div>`;
    }

    if (rows.length) loadMarketInfo(rows.map((r) => r.id), state.marketLimit);

    const slots = listingSlots();
    const usedCopies = selectedCopies();
    const freeSlots = Math.max(0, slots.remaining - usedCopies);
    const selected = rows.filter((r) => state.selected.has(r.id));
    const totals = sellTotals(
      selected.map((r) => ({ qty: r.sellable, price: suggestPrice(r.id, r.rarity) }))
    );
    const full = usedCopies >= slots.remaining;

    return `
      <div class="kp-toolbar">
        <input class="kp-input" type="search" data-role="dupe-search" placeholder="Filtrer une carte…" value="${esc(state.query)}">
        <button class="kp-mini-btn" type="button" data-act="select-all" title="Remplit les places libres dans l'ordre de tri">Remplir</button>
        <button class="kp-mini-btn" type="button" data-act="select-none">Rien</button>
      </div>

      <label class="kp-filter" style="margin-bottom:8px">
        <span>Trier</span>
        <select class="kp-select" data-setting="dupeSort">
          ${DUPE_SORTS.map(
            ([value, label]) => `<option value="${value}" ${state.settings.dupeSort === value ? 'selected' : ''}>${label}</option>`
          ).join('')}
        </select>
      </label>

      <div class="kp-slots ${full ? 'is-full' : ''}">
        <b>${usedCopies} / ${slots.remaining}</b>
        annonce(s) sélectionnée(s) · ${freeSlots} place(s) libre(s) sur ${slots.max}
        ${slots.active ? `<small>(${slots.active} annonce(s) active(s) déjà en ligne)</small>` : ''}
      </div>

      <div class="kp-hint">${rows.length} carte(s) · ${rows.reduce((s, r) => s + r.sellable, 0)} exemplaire(s) vendable(s) ${state.marketLoading ? '<span class="kp-spinner"></span>' : ''}
        ${!state.marketLoading && state.marketLoaded.size < rows.length ? ` · <span class="kp-link" data-act="load-market-more">charger plus de prix marché</span>` : ''}
      </div>
      <div class="kp-table">
        ${rows
          .map((r) => {
            const checked = state.selected.has(r.id);
            const ri = rarityInfo(r.rarity);
            const bid = state.buyOrders[r.id];
            const lowest = state.lowest[r.id];
            const pp = state.prices[r.id];
            const disabled = !checked && full;
            return `
              <label class="kp-row ${checked ? 'is-selected' : ''} ${disabled ? 'is-disabled' : ''}">
                <input type="checkbox" data-sel="${esc(r.id)}" ${checked ? 'checked' : ''} ${disabled ? 'disabled' : ''}>
                <img src="${esc(r.image)}" alt="" loading="lazy">
                <div class="kp-row-main">
                  <div class="kp-row-name">${esc(r.name)}</div>
                  <div class="kp-row-meta">
                    <span class="kp-rar" style="--rc:${ri.color}">${esc(ri.label)}</span>
                    ×${r.qty} · ${r.sellable} vendable${r.sellable > 1 ? 's' : ''}${pp?.sales7d != null ? ` · ${pp.sales7d} vente(s)/7j` : ''} · ♻ ${recycleOf(r.rarity)}
                  </div>
                </div>
                <div class="kp-row-price">
                  <b>${r.price != null ? `◆ ${fmt(r.price)}` : '—'}</b>
                  <small class="${bid ? 'is-good' : ''}">${
                    bid
                      ? `achat imm. ◆ ${fmt(bid.price)}`
                      : lowest != null
                        ? `plus bas ◆ ${fmt(lowest)}`
                        : 'pas d’annonce'
                  }</small>
                </div>
              </label>`;
          })
          .join('')}
      </div>
      <div class="kp-sellbar">
        <div class="kp-sellbar-info">
          <b>${selected.length} carte(s) · ◆ ${fmt(totals.net)} net</b>
          <span>${totals.copies} annonce(s) · frais ◆ ${fmt(totals.fees)}</span>
        </div>
        <button class="kp-btn is-primary" type="button" data-act="prepare-sell" ${selected.length ? '' : 'disabled'}>Préparer la vente</button>
      </div>
    `;
  }

  function viewMarket() {
    if (!state.user) return loginHTML();
    const deals = state.deals ?? [];
    const filter = String(state.settings.dealsRarity || 'all');
    const typeFilter = String(state.settings.dealsType || 'all');
    const visible = deals.filter(
      (d) =>
        (filter === 'all' || String(d.rarity || 'C') === filter) &&
        (typeFilter === 'all' || String(d.type || 'fixed') === typeFilter)
    );

    const mineAll = Array.isArray(state.mine?.listings)
      ? state.mine.listings
      : Array.isArray(state.mine)
        ? state.mine
        : [];
    const mine = mineAll.filter((l) => !l.status || l.status === 'active');
    const mineOther = mineAll.length - mine.length;

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
      }

      ${
        mine.length
          ? `<div class="kp-section">
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
                   <div class="kp-row kp-is-clickable" data-act="open-listing" data-listing="${esc(l.id ?? '')}" data-type="${esc(l.type ?? 'fixed')}" data-name="${esc(card?.name ?? '')}" title="Ouvrir cette vente sur kyara.games ›">
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
             </div>`
          : ''
      }
    `;
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

  const AUTO_MIN_GAP = 10000;
  const AUTO_REMAINING_CAP = 9;
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
   * Cadence des ouvertures.
   *
   * Formule (celle d'Axel) : minimum 10 s, maximum
   *   « minutes par booster » × (places restantes avant le plafond de 9 boosters).
   *
   * Le maximum dépend donc du STOCK, pas du nombre déjà ouvert :
   *   8 boosters en stock → 1 place avant 9 → max 10 min
   *   6 boosters en stock → 3 places        → max 30 min
   *   0 booster en stock  → 9 places        → max 90 min
   *
   * Plus le stock est plein, plus on ouvre vite : ça évite de laisser la jauge
   * se remplir et de « gaspiller » des boosters.
   */
  function autoDelayRange(stock = 0) {
    const perBoosterMs =
      Math.min(60, Math.max(0.2, Number(state.settings.autoMaxPerBoosterMin) || 10)) * 60000;
    const inStock = Math.max(0, Math.min(AUTO_REMAINING_CAP, Math.round(Number(stock) || 0)));
    const slots = Math.max(1, AUTO_REMAINING_CAP - inStock);
    const max = Math.max(AUTO_MIN_GAP, perBoosterMs * slots);
    return { min: AUTO_MIN_GAP, max, perBoosterMs, stock: inStock, slots };
  }

  /** Délai aléatoire avant le prochain booster, à partir du stock ouvrable actuel. */
  function autoDelay(stock = 0) {
    const { min, max } = autoDelayRange(stock);
    return Math.round(min + Math.random() * (max - min));
  }

  /** Stock ouvrable maintenant, tous boosters sélectionnés confondus. */
  function autoStock() {
    return autoPoolTotal(autoSelectedPacks(), state.settings.autoAllowChakra !== false);
  }

  /* --- Anti-AFK ------------------------------------------------------ */

  const AFK_MIN_DELAY = 2000;
  const AFK_MAX_DELAY = 60000;
  let afkTimer = null;
  let afkScanTimer = null;
  let afkObserver = null;
  let afkLastScan = 0;
  const afkSeen = new WeakSet();

  /** Vrai si le libellé ressemble à une confirmation de présence. */
  function isAfkConfirmLabel(label) {
    const t = String(label ?? '').trim().toLowerCase();
    if (!t) return false;
    return /^(oui|yes|ok|je suis (toujours )?l[àa]|toujours l[àa])/.test(t);
  }

  /**
   * Cherche le bouton « Oui » du contrôle anti-AFK.
   * Le site peut changer ses classes : on ne se fie donc pas à un sélecteur précis,
   * on remonte les ancêtres du bouton et on regarde le texte affiché.
   */
  function findAfkButton() {
    const buttons = document.querySelectorAll(
      'button, [role="button"], input[type="button"], input[type="submit"], a[class*="btn"], a[class*="button"]'
    );
    for (const btn of buttons) {
      if (host && (host === btn || host.contains(btn))) continue;
      const label = btn.innerText || btn.value || btn.getAttribute('aria-label') || '';
      if (!isAfkConfirmLabel(label)) continue;

      // Remonte jusqu'à 6 ancêtres pour lire le texte de la boîte de dialogue.
      let node = btn;
      let context = '';
      for (let i = 0; i < 6 && node; i += 1) {
        node = node.parentElement;
        if (!node) break;
        const text = node.innerText || '';
        if (text.length > 1200) break;
        context = text;
        if (/toujours|still there|are you (still )?there|inactif|absent|anti[- ]?afk/i.test(text)) return btn;
      }
      void context;
    }
    return null;
  }

  function scheduleAfkConfirm() {
    if (state.settings.antiAfk === false) return;
    if (afkTimer) return;

    const btn = findAfkButton();
    if (!btn || afkSeen.has(btn)) return;
    afkSeen.add(btn);

    const delay = Math.round(AFK_MIN_DELAY + Math.random() * (AFK_MAX_DELAY - AFK_MIN_DELAY));
    notify(`Anti-AFK détecté : réponse dans ${Math.round(delay / 1000)} s.`);

    afkTimer = setTimeout(() => {
      afkTimer = null;
      try {
        // La boîte a pu être reconstruite entre-temps : on relit l'élément.
        const target = btn.isConnected ? btn : findAfkButton();
        if (target && target.isConnected) {
          target.click();
          notify(`Anti-AFK : « ${(target.innerText || 'Oui').trim().slice(0, 20)} » cliqué.`);
        } else {
          notify('Anti-AFK : la boîte a disparu avant la réponse.');
        }
      } catch {
        /* ignore */
      }
      // Un nouveau contrôle peut arriver plus tard.
      setTimeout(() => scheduleAfkConfirm(), 4000);
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
      a.best = [...a.cards]
        .sort((x, y) => RARITY_ORDER.indexOf(y.rarity) - RARITY_ORDER.indexOf(x.rarity))
        .slice(0, 8);
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
        // Minimum 10 s ; maximum = « minutes par booster » × places avant le plafond de 9.
        const stock = autoStock();
        const delay = autoDelay(stock);
        a.nextGapMs = delay;
        const range = autoDelayRange(stock);
        const perMin = Math.round((range.perBoosterMs / 60000) * 10) / 10;
        a.status = `Ouverture… ${a.opened} · prochain dans ${fmtWait(delay)} (max ${fmtWait(range.max)} = ${
          range.slots
        } × ${perMin} min)`;
        // Le compte à rebours doit exister avant le rendu, sinon le bloc n'apparaît pas.
        a.nextAt = Date.now() + delay;
        render();
        await autoSleep(delay);
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
    await loadPackState(true).catch(() => {});
    await loadPacks(true).catch(() => {});
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
    const perBoosterMin = Math.min(60, Math.max(0.2, Number(state.settings.autoMaxPerBoosterMin) || 10));
    const delayRange = autoDelayRange(total);
    const maxLabel = fmtWait(delayRange.max);
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
            <span>Minutes par booster</span>
            <input class="kp-input" type="number" min="0.2" max="60" step="0.5" data-setting="autoMaxPerBoosterMin" value="${perBoosterMin}">
          </label>
          <label class="kp-filter">
            <span>Rafraîchir (min)</span>
            <input class="kp-input" type="number" min="1" max="120" step="1" data-setting="autoRefreshMin" value="${refreshMin}">
          </label>
        </div>
        <div class="kp-hint">
          Un booster à la fois, puis un délai aléatoire entre <b>10 s</b> et <b>${maxLabel}</b> :
          ${perBoosterMin} min × ${delayRange.slots} place(s) restante(s) avant le plafond de
          ${AUTO_REMAINING_CAP} (stock actuel ${delayRange.stock}/${AUTO_REMAINING_CAP}).
          Plus le stock est haut, plus l'écart maximum se raccourcit.
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
            ? `<div class="kp-explain-sub">Meilleures trouvailles</div>
               <div class="kp-best-cards">
                 ${a.best
                   .map((card) => {
                     const info = rarityInfo(card.rarity);
                     return `
                   <div class="kp-best-card" style="--rc:${info.color}" data-act="open-card" data-id="${esc(
                       card.id
                     )}" title="${esc(card.name)} · ${esc(info.label)}">
                     <img src="${esc(imgSrc(card))}" alt="${esc(card.name)}" loading="lazy">
                     <b>${esc(info.label)}</b>
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
    const u = state.update;
    const newer = u.version && isNewerVersion(u.version, state.version);
    return `
      <div class="kp-settings">
        <div class="kp-section" style="margin-top:0">
          <div class="kp-section-title">Mise à jour</div>
          ${
            state.manifestOutdated
              ? `<div class="kp-alert is-bad" style="margin-bottom:8px">
                   <b>Firefox a gardé l'ancienne version</b><br>
                   Le dossier est en v${esc(state.version)}, mais l'add-on chargé est encore en
                   v${esc(state.manifestVersion ?? '?')}. Un add-on temporaire doit être retiré puis rechargé
                   pour prendre le nouveau numéro de version :
                   <code>about:debugging</code> → <b>Ce Firefox</b> → « Retirer », puis
                   « Charger un module temporaire » → <code>manifest.json</code> du dossier.
                 </div>`
              : ''
          }
          ${
            newer
              ? `<div class="kp-alert" style="margin-bottom:8px">
                   <b>v${esc(u.version)} disponible</b> — tu es en v${esc(state.version)}.
                   Télécharge l'archive puis remplace les fichiers de ton dossier (voir plus bas).
                 </div>`
              : ''
          }
          <div class="kp-card-stat">
            <span>Version du code</span>
            <b>v${esc(state.version)}</b>
            <small>manifeste lu depuis le dossier local · aucun téléchargement</small>
          </div>
          <div class="kp-card-stat" style="margin-top:6px">
            <span>Manifeste sur le disque</span>
            <b>v${esc(state.diskVersion ?? '—')}</b>
            <small>${state.diskVersion ? 'fichier manifest.json' : 'illisible'}</small>
          </div>
          <div class="kp-card-stat" style="margin-top:6px">
            <span>Manifeste chargé par Firefox</span>
            <b>v${esc(state.manifestVersion ?? '—')}</b>
            <small>${state.manifestVersion ? (state.manifestOutdated ? 'en retard sur le dossier' : 'à jour') : '—'}</small>
          </div>
          <div class="kp-card-stat" style="margin-top:6px">
            <span>Dépôt GitHub</span>
            <b>${u.checking ? '…' : u.version ? `v${esc(u.version)}` : '—'}</b>
            <small>${
              u.checking
                ? 'vérification…'
                : u.error
                  ? esc(u.error)
                  : u.checkedAt
                    ? newer
                      ? 'plus récent que ta version (pas forcément publié sur AMO)'
                      : 'tu es à jour'
                    : 'jamais vérifié'
            }</small>
          </div>

          <div class="kp-toolbar" style="margin-top:8px">
            <button class="kp-btn is-primary" type="button" data-act="update-now" ${u.checking ? 'disabled' : ''}>
              ${u.checking ? '<span class="kp-spinner"></span> Vérification…' : 'Mettre à jour et recharger'}
            </button>
            <button class="kp-btn" type="button" data-act="update-check" ${u.checking ? 'disabled' : ''}>Vérifier</button>
            <button class="kp-btn" type="button" data-act="update-download">Télécharger</button>
            <button class="kp-btn is-ghost" type="button" data-act="update-repo">Dépôt ↗</button>
          </div>
          <div class="kp-hint">
            <b>Mettre à jour et recharger</b> vérifie GitHub, puis recharge l'extension et la page :
            un seul clic après un <code>git pull</code>.
          </div>

          <div class="kp-explain" style="margin-top:10px">
            <p><b>Installée depuis addons.mozilla.org ?</b></p>
            <p>
              Les mises à jour sont <b>automatiques</b> : Firefox télécharge la nouvelle version en arrière-plan
              et l'active au redémarrage. Rien à faire ici.
            </p>
            <p><b>Chargée depuis un dossier (développement) ?</b></p>
            <p>
              L'extension ne peut pas réécrire ses propres fichiers. Clique sur <b>Télécharger la dernière version</b>,
              décompresse l'archive <b>dans le même dossier</b> (celui que Firefox surveille), puis
              <b>Recharge l'extension</b> ci-dessous.
            </p>
          </div>
          <div class="kp-hint" style="margin-top:8px">
            Après une modification du dossier, recharge l'extension pour appliquer le nouveau code.
            La page sera rafraîchie automatiquement.
          </div>
          <div class="kp-toolbar">
            ${
              state.reloadArmed
                ? `<button class="kp-btn is-primary" type="button" data-act="reload-ext">Confirmer le rechargement</button>
                   <button class="kp-btn is-ghost" type="button" data-act="reload-cancel">Annuler</button>`
                : `<button class="kp-btn is-primary" type="button" data-act="reload-ext">Recharger l'extension</button>`
            }
          </div>
        </div>

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
            ${getCfg()
              .durations.map((h) => `<option value="${h}" ${Number(state.settings.durationHours) === Number(h) ? 'selected' : ''}>${h} h</option>`)
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
          <span>Répondre à l'anti-AFK<small>Clique « Oui » tout seul, délai aléatoire de 2 s à 1 min</small></span>
          <input type="checkbox" data-setting="antiAfk" ${state.settings.antiAfk !== false ? 'checked' : ''}>
        </label>
        <div class="kp-hint">
          Surveille l'apparition de la boîte « toujours là ? » sur le site et clique sur le bouton de
          confirmation après un délai tiré au hasard entre <b>2 s</b> et <b>1 min</b>, pour ne pas
          répondre instantanément comme un robot.
        </div>
        <div class="kp-toolbar">
          <button class="kp-btn" type="button" data-act="anti-afk-test">Tester la détection</button>
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
        <div class="kp-card-stat"><span>Version</span><b>v${esc(state.version)}</b><small>manifeste chargé : v${esc(state.manifestVersion ?? '—')}</small></div>        <div class="kp-toolbar">
          <button class="kp-btn" type="button" data-act="reload-ext">Recharger l'extension</button>
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

  function renderModal() {
    if (!ui) return;
    if (!state.sell) {
      ui.modal.hidden = true;
      ui.modalCard.innerHTML = '';
      return;
    }

    const plan = state.sell.plan;
    const isAuction = state.sell.type === 'auction';
    const totals = sellTotals(plan);
    const blocker = sellBlocker(plan);
    const chakra = toNum(state.user?.chakra) ?? 0;
    const running = state.sell.running;
    const done = state.sell.done;
    const buyoutPreview = isAuction
      ? buyoutPriceFor(plan[0]?.price ?? 0, state.sell.buyoutPct)
      : null;
    const durations = getCfg().durations;

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
                 <div>Achat immédiat<small>0 = aucun · ${buyoutPreview != null ? `soit ◆ ${fmt(buyoutPreview)}` : 'désactivé'}</small></div>
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

        ${blocker ? `<div class="kp-alert is-bad">${esc(blocker)}</div>` : ''}

        <div class="kp-plan">
          ${plan
            .map(
              (row) => `
            <div class="kp-plan-row">
              <div class="kp-name">${esc(row.name)} <small>×${row.qty}${row.median != null ? ` · méd. ◆ ${fmt(row.median)}` : ''}</small></div>
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

    switch (act) {
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
        if (state.tab === 'dupes') state.query = '';
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
      case 'select-all': {
        // Remplit les places libres restantes, sans jamais dépasser la limite du site.
        const { remaining } = listingSlots();
        let used = selectedCopies();
        state.selected.clear();
        for (const row of filteredDupes()) {
          if (used + row.sellable > remaining) continue;
          state.selected.add(row.id);
          used += row.sellable;
          if (used >= remaining) break;
        }
        if (!state.selected.size && remaining > 0) {
          // Aucune carte ne rentre entièrement : on en prend au moins une.
          const first = filteredDupes()[0];
          if (first) state.selected.add(first.id);
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
      case 'anti-afk-test':
        notify(state.settings.antiAfk === false ? 'Anti-AFK désactivé.' : 'Anti-AFK actif : détection toutes les 3 s.');
        scanAfk();
        break;
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
        state.buyOrders = {};
        state.marketLoaded.clear();
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

      // Une place par exemplaire : on refuse de dépasser les emplacements libres.
      const row = duplicateRows().find((r) => r.id === id);
      const { remaining } = listingSlots();
      const already = selectedCopies();
      const need = row ? row.sellable : 0;

      if (already + need > remaining) {
        const free = Math.max(0, remaining - already);
        notify(
          free > 0
            ? `Pas assez de places : ${free} exemplaire(s) possible(s) pour cette carte (${remaining} place(s) libre(s) au total).`
            : `Limite d'annonces actives atteinte (${listingSlots().active}/${listingSlots().max}). Retire une annonce ou décoche une carte.`
        );
        render();
        return;
      }

      state.selected.add(id);
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
        state.settings.autoMaxPerBoosterMin = Math.min(60, Math.max(0.2, Number(value) || 10));
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

    const search = target.closest('[data-role="dupe-search"]');
    if (!search) return;
    state.query = search.value;
    render();
    const again = qs('[data-role="dupe-search"]');
    if (again) {
      again.focus();
      const pos = again.value.length;
      try {
        again.setSelectionRange(pos, pos);
      } catch {
        /* type=search may not support it */
      }
    }
  }

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
      autoDelay,
      autoDelayRange,
      autoStock,
      startAutoOpen,
      stopAutoOpen,
      ensureAutoAlive,
      autoLog,
      loadAutoLog,
      refreshAutoAccount,
      mergeUser
    };
  }

  boot();

  // Compte à rebours de l'auto-open : on ne touche qu'au texte, pas au panneau entier.
  setInterval(() => {
    if (state.autoOpen.nextAt) updateCountdownText();
  }, 1000);

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
