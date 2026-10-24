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
  /* Le même fichier sert aussi à la page d'extension `panel/panel.html` : la fenêtre détachée
   * (panneau complet dans sa propre fenêtre). Hors du site, pas de DOM Kyara ni de session. */
  const IS_PANEL = /^(moz|chrome)-extension:$/.test(location.protocol);
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
  const LOGO_URL = (() => {
    try {
      return ext.runtime.getURL('icons/icon-128.png');
    } catch {
      return '/icons/icon-128.png';
    }
  })();
  const PRICE_KEY = 'kyaraplus.prices.v2';
  const SETTINGS_KEY = 'kyaraplus.settings.v2';
  const CHARS_KEY = 'kyaraplus.characters.v1';
  const PACK_AVG_KEY = 'kyareeh.packavg.v1';
  const PACK_POOLS_KEY = 'kyareeh.packpools.v1';
  const STATS_KEY = 'kyareeh.statboard.v1';
  // v1 = ancien journal des annonces créées (faux positif : une mise en vente
  // n'est pas une vente). v2 = ventes réellement confirmées, seules comptées.
  const SALES_KEY = 'kyareeh.sales.v1';
  const SALES_LEDGER_KEY = 'kyareeh.sales.v2';
  const SALES_TRACK_KEY = 'kyareeh.salestrack.v1';
  // Retraits automatiques : cartes rendues à l'inventaire et journal des remises.
  const AUTOSELL_EXPIRY_KEY = 'kyareeh.autosellexpiry.v1';
  const SALES_MAX = 2000;
  const SALES_TRACK_MAX = 200;
  // Délai laissé au site pour indexer une annonce qui vient d'être créée.
  const SALES_TRACK_GRACE_MS = 90 * 1000;
  const SOUND_KEY = 'kyareeh.sound.v1';
  const UI_KEY = 'kyareeh.ui.v1';
  const PANEL_WINDOW_KEY = 'kyareeh.panel.window';
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
    salesRange: '7d',
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
    autoSellOrder: 'score',
    autoSellDelayMinSec: 5,
    autoSellDelayMaxSec: 60,
    autoSellRefreshMinMin: 7,
    autoSellRefreshMaxMin: 10,
    autoSellIncludeM: false,
    autoSellDryRun: false,
    // Retrait des annonces de la vente auto restées en ligne au-delà de X.
    // Désactivé par défaut : rien ne change tant que l'option n'est pas cochée.
    autoSellExpireEnabled: false,
    autoSellExpireValue: 72,
    autoSellExpireUnit: 'h',
    // Une carte retirée pour ancienneté peut être recyclée au lieu de repartir
    // dans le pool de vente. Désactivé par défaut : comportement inchangé.
    autoSellRecycleExpired: false
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

  // Ordres de la vente auto. « score » = prix + ventes sur 7 jours (défaut).
  const AUTOSELL_ORDERS = [
    ['score', 'Optimisé : prix + ventes sur 7 j'],
    ['price_desc', 'Prix ↓ · plus cher → moins cher'],
    ['price_asc', 'Prix ↑ · moins cher → plus cher']
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
    price_too_low: 'Prix inférieur au minimum autorisé par le marché.',
    too_many_listings: 'Limite d’annonces actives atteinte.',
    has_bids: 'Impossible de retirer cette vente : des enchères existent déjà.',
    listing_closed: 'Cette annonce est déjà terminée.',
    own_listing: 'C’est déjà ta propre annonce.',
    chakra: 'Pas assez de chakra pour les frais de dépôt.',
    rate_limited: 'Trop de requêtes : patiente quelques secondes.',
    guest_limit: 'Compte invité : connecte-toi avec Discord.',
    same_device: 'Action refusée depuis le même appareil.',
    no_kyara_tab: 'Aucun onglet kyara.games ouvert : ouvre le site dans un onglet (connecté), puis réessaie.',
    kyara_tab_unready: 'L’onglet kyara.games ne répond pas : recharge-le (F5), puis réessaie.'
  };

  function friendlyError(err) {
    const code = err?.code || err?.message;
    return ERROR_HINTS[code] || code || 'Erreur inconnue';
  }

  const state = {
    mounted: false,
    open: false,
    // Panneau complet ouvert dans la fenêtre détachée (vu depuis la page du site).
    panelAway: false,
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
      detailHideRecommend: false,
      refreshing: false,
      lastRefresh: 0
    },
    // Onglet Recyclage : sélection ciblée des exemplaires en trop.
    recycleView: {
      query: '',
      rarity: 'all',
      series: 'all',
      sort: 'value_desc',
      limit: 40,
      onlyDupes: true,
      includeML: false
    },
    recycle: {
      // Sélection en cours, par carte : id → nombre d'exemplaires à recycler.
      selection: new Map(),
      // Aperçu figé au moment de l'ouverture de la modale.
      plan: [],
      open: false,
      running: false,
      done: false,
      stop: false,
      gained: 0,
      planned: 0,
      processed: 0,
      log: []
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
    listingCancelId: null,
    // Ventes réellement confirmées (le site ne fournit aucun historique).
    salesLog: [],
    // Annonces créées par Kyareeh+ en attente de confirmation (vendue ou non).
    salesTrack: [],
    salesLogLoaded: false,
    salesChart: null,
    // Son global, partagé par les onglets Global et par +Duel.
    sound: { muted: false, volume: 0.7 },
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
      starting: false,
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
      lastPlan: [],
      // Annonces actives lues sur le site + celles créées pendant le cycle.
      listingsAt: 0,
      listingsError: null,
      priceScanAt: 0,
      pendingListings: [],
      initialPrep: null,
      refreshing: false,
      lastPick: null,
      // Nombre de classements recalculés (un par vente en mode optimisé).
      rankCount: 0,
      rankAt: 0,
      // Annonces revenues sans acheteur, en attente de remise en vente.
      relist: {
        queue: [],
        // Dernière remise en vente automatique (affichée dans le panneau).
        last: null,
        count: 0,
        // characterId -> horodatage de la dernière remise en vente (anti-boucle).
        locks: {},
        // listingId -> horodatage : annonce déjà remise en vente (pastille).
        ids: {}
      },
      // Retrait des annonces trop anciennes (durée réglable, désactivé par défaut).
      expiry: {
        // Vérification en cours : empêche deux retraits simultanés.
        purging: null,
        lastAt: 0,
        lastCheck: null,
        // listingId -> horodatage : vérification déjà faite (anti double retrait).
        locks: {},
        // Cartes retirées pour expiration, classées en fin de file.
        returns: [],
        // Journal persistant des retraits et des remises en vente.
        history: []
      },
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
        <img class="kp-fab-logo" src="${esc(LOGO_URL)}" alt=""><span>Kyareeh+</span>
      </button>
      <section class="kp-panel${IS_PANEL ? ' is-window' : ''}" hidden aria-label="Kyareeh+">
        <header class="kp-head">
          <nav class="kp-modes" id="kp-modes"></nav>
          <div class="kp-brand">
            <span class="kp-logo"><img src="${esc(LOGO_URL)}" alt=""></span>
            <div><b>Kyareeh+</b><small>chakra &amp; doublons</small></div>
          </div>
          <div class="kp-head-actions">
            <span class="kp-sound">
              <button class="kp-icon-btn" id="kp-sound-btn" type="button" data-act="sound-mute" aria-pressed="false" title="Couper le son">🔊</button>
              <input class="kp-volume" id="kp-sound-range" type="range" min="0" max="100" step="5" value="70" data-role="sound-volume" aria-label="Volume global">
            </span>
            <button class="kp-icon-btn" type="button" data-act="refresh" title="Rafraîchir les données">⟳</button>
            <button class="kp-icon-btn" type="button" data-act="close" title="${IS_PANEL ? 'Rattacher (fermer cette fenêtre)' : 'Fermer'}">✕</button>
          </div>
        </header>
        <div class="kp-stats" id="kp-stats"></div>
        <div class="kp-banner" id="kp-banner" hidden></div>
        <nav class="kp-tabs" id="kp-tabs"></nav>
        <div class="kp-view" id="kp-view"></div>
        <div class="kp-duel-slot" id="kp-duel-slot" hidden></div>
        <div class="kp-away" id="kp-away" hidden></div>
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
      away: qs('#kp-away'),
      foot: qs('#kp-foot'),
      modal: qs('#kp-modal'),
      modalCard: qs('#kp-modal-card'),
      soundBtn: qs('#kp-sound-btn'),
      soundRange: qs('#kp-sound-range')
    };

    // Fenêtre détachée : le panneau remplit la fenêtre, sans bouton flottant.
    if (IS_PANEL && ui.fab) ui.fab.style.display = 'none';
    if (IS_PANEL) {
      applyPanelWindowScale();
      window.addEventListener('resize', applyPanelWindowScale);
    }

    shadow.addEventListener('click', onClick);
    shadow.addEventListener('change', onChange);
    shadow.addEventListener('input', onInput);
    shadow.addEventListener('keydown', onKeyDown);
    shadow.addEventListener('pointermove', onPointerMove);
    shadow.addEventListener('pointerleave', hideSalesChartHover);

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
        } else if (msg.type === 'kp-status') {
          sendResponse({
            ok: true,
            ready: state.ready,
            version: state.version,
            user: state.user?.pseudo ?? null,
            value: computeStats(ownedRows()).total
          });
        } else if (msg.type === 'kp-api-request') {
          api(msg.path, { method: msg.method, body: msg.body, timeout: msg.timeout })
            .then((data) => sendResponse({ ok: true, data }))
            .catch((err) =>
              sendResponse({ ok: false, status: err?.status || 0, error: friendlyError(err) })
            );
          return true;
        }
      });
    } catch {
      /* extension reloaded */
    }

    state.mounted = true;
    render();
  }

  function toggle(force) {
    // Dans la fenêtre détachée, le panneau est toujours ouvert : « fermer » = rattacher.
    if (IS_PANEL) {
      if (force === false) panelAttach();
      return;
    }
    state.open = typeof force === 'boolean' ? force : !state.open;
    persistUiSoon();
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
    const ask = ext.runtime.sendMessage({ type: 'kp-reload-all' });
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

  /*
   * Le site coupe l'accès quelques minutes dès qu'il voit une rafale de requêtes.
   * Toutes les requêtes API passent donc par une petite file : **une seule à la
   * fois** et un délai minimum entre deux départs. Les scans marché carte par
   * carte ne peuvent plus partir en grappe.
   */
  const API_GATE = {
    max: 1,
    gapMs: 350,
    active: 0,
    lastStart: 0,
    waiting: [],
    timer: null
  };

  function pumpApiGate() {
    if (API_GATE.active >= API_GATE.max || !API_GATE.waiting.length) return;
    const wait = API_GATE.lastStart + API_GATE.gapMs - Date.now();
    if (wait > 0) {
      if (!API_GATE.timer) {
        API_GATE.timer = setTimeout(() => {
          API_GATE.timer = null;
          pumpApiGate();
        }, wait);
      }
      return;
    }
    const resolve = API_GATE.waiting.shift();
    API_GATE.active += 1;
    API_GATE.lastStart = Date.now();
    resolve(() => {
      API_GATE.active = Math.max(0, API_GATE.active - 1);
      pumpApiGate();
    });
    pumpApiGate();
  }

  function acquireApiSlot() {
    return new Promise((resolve) => {
      API_GATE.waiting.push(resolve);
      pumpApiGate();
    });
  }

  async function api(path, options = {}) {
    const method = options.method || 'GET';
    const headers = { accept: 'application/json', ...readAuthHeaders() };
    if (method !== 'GET') Object.assign(headers, readPassHeader());
    if (options.body != null) headers['content-type'] = 'application/json';

    const release = await acquireApiSlot();
    const started = performance.now();
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
    } finally {
      release();
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
    state.settings.autoSellOrder = AUTOSELL_ORDERS.some(([value]) => value === state.settings.autoSellOrder)
      ? state.settings.autoSellOrder
      : 'score';
    state.settings.autoSellRefreshMinMin = Math.min(
      60,
      Math.max(1, Math.round(Number(state.settings.autoSellRefreshMinMin) || 7))
    );
    state.settings.autoSellRefreshMaxMin = Math.min(
      60,
      Math.max(state.settings.autoSellRefreshMinMin, Math.round(Number(state.settings.autoSellRefreshMaxMin) || 10))
    );
    state.settings.autoSellDelayMinSec = Math.min(
      300,
      Math.max(5, Math.round(Number(state.settings.autoSellDelayMinSec) || 5))
    );
    state.settings.autoSellDelayMaxSec = Math.min(
      300,
      Math.max(state.settings.autoSellDelayMinSec, Math.round(Number(state.settings.autoSellDelayMaxSec) || 60))
    );
    if (state.settings.autoSellIncludeML != null) {
      // Ancienne option « M/L » : on ne conserve que l'accord Mythiques.
      state.settings.autoSellIncludeM =
        state.settings.autoSellIncludeM || Boolean(state.settings.autoSellIncludeML);
    }
    state.settings.autoSellIncludeM = Boolean(state.settings.autoSellIncludeM);
    delete state.settings.autoSellIncludeML;
    state.settings.autoSellDryRun = Boolean(state.settings.autoSellDryRun);
    // Retrait des annonces trop anciennes : valeur validée et bornée, conservée
    // telle quelle entre les sessions (clé `kyaraplus.settings.v2`).
    const expireSettings = autoSellExpireSettings({
      enabled: state.settings.autoSellExpireEnabled,
      value: state.settings.autoSellExpireValue,
      unit: state.settings.autoSellExpireUnit
    });
    state.settings.autoSellExpireEnabled = expireSettings.enabled;
    state.settings.autoSellExpireValue = expireSettings.value;
    state.settings.autoSellExpireUnit = expireSettings.unit;
    state.settings.autoSellRecycleExpired = Boolean(state.settings.autoSellRecycleExpired);
    state.settings.dealsRarity = String(state.settings.dealsRarity || 'all');
    state.settings.dupeSort = DUPE_SORTS.some(([value]) => value === state.settings.dupeSort) ? state.settings.dupeSort : 'price_desc';
    state.settings.salesRange = ['1d', '7d', 'total'].includes(state.settings.salesRange)
      ? state.settings.salesRange
      : '7d';
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
      'autoMaxDelaySec',
      'autoSellMinPrice',
      'autoSellIntervalSec',
      'autoSellMaxPerCycle'
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
    await loadExpiryJournal();
    await loadSoundPrefs();
    await loadUiPrefs();
    // Fenêtre détachée : le panneau est toujours ouvert (il remplit la fenêtre).
    if (IS_PANEL) state.open = true;
    // L'état de la fenêtre (aller-retour avec le fond) ne retarde pas le montage du panneau,
    // mais doit être connu avant toute boucle (reprise de l'Auto-Open, relectures).
    const panelWindowReady = loadPanelWindowState();
    await mount();
    await panelWindowReady;
    render();
    await loadData();
    await loadAutoLog();
    // L'onglet Stat est global : rien à collecter ici, il charge son analyse
    // à la première ouverture (ou après 12 h).
    startAutoRefreshLoop();
    // L'anti-AFK lit le DOM du site : il n'a de sens que dans l'onglet kyara.games.
    if (!IS_PANEL) installAntiAfk();
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
    // Une seule instance fait tourner la boucle : jamais la fenêtre au démarrage (c'est la page
    // qui reprend), et jamais la page tant que le panneau est détaché.
    if (IS_PANEL || state.panelAway) return;
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

  // Codes du relais de la fenêtre détachée : aucun onglet du site, ou onglet sans content script.
  const RELAY_CODES = ['no_kyara_tab', 'kyara_tab_unready'];
  let relayRetryTimer = null;

  /** Fenêtre détachée sans onglet du site : on réessaie seule dès qu'un onglet apparaît. */
  function scheduleRelayRetry() {
    if (relayRetryTimer) return;
    relayRetryTimer = setTimeout(() => {
      relayRetryTimer = null;
      if (!state.loading && RELAY_CODES.includes(state.errorCode)) loadData();
    }, 8000);
  }

  async function loadData(opts = {}) {
    state.loading = true;
    state.error = null;
    state.errorCode = null;
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
      // Recalcul de l'historique à chaque chargement : une annonce vendue (ou
      // expirée) pendant l'absence de l'extension est confirmée ici.
      reconcilePendingSales();

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
      state.errorCode = err instanceof ApiError ? err.code : null;
      if (IS_PANEL && RELAY_CODES.includes(state.errorCode)) scheduleRelayRetry();
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
    if (state.loading || state.panelAway) return;
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
    return salesFeeOf(price, { feePct: cfg.feePct, feeMin: cfg.feeMin });
  }

  function taxOf(price) {
    return salesTaxOf(price, { taxPct: getCfg().taxPct });
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

  /* RECYCLE:BEGIN — sélection et totaux purs du recyclage ciblé, testés par verify-recycle.mjs */
  /**
   * Le site conserve **toujours un exemplaire** de chaque carte : le recyclage
   * ne porte que sur les exemplaires en trop.
   */
  const RECYCLE_KEEP_COPIES = 1;

  /**
   * Exemplaires qu'on ne peut pas recycler : ceux **déjà en vente** (champ
   * `locked` du site, affiché « N en vente ») et les exemplaires engagés dans
   * un échange que `listable` exclut déjà. Aucune donnée inventée : sans
   * `listable`, seuls les exemplaires en vente sont retirés.
   */
  function recycleBlockedCopies(row) {
    const qty = Math.max(0, Number(row?.qty ?? row?.quantity) || 0);
    if (!qty) return 0;
    const rawListable = row?.listable ?? row?.listableQty;
    const listable = rawListable == null ? qty : Math.max(0, Math.min(qty, Number(rawListable) || 0));
    const engaged = Math.max(0, qty - listable);
    const locked = Math.max(0, Number(row?.lockedQty ?? row?.locked) || 0);
    return Math.min(qty, Math.max(engaged, locked));
  }

  /**
   * Exemplaires recyclables d'une carte : tout sauf les exemplaires déjà en
   * vente et l'exemplaire conservé. Une carte verrouillée (`pinned`, échelle
   * carte) n'en a aucun : le site indique qu'elle « ne peut être ni vendue, ni
   * échangée, ni recyclée ».
   */
  function recycleSpareOf(row) {
    if (!row || row.pinned) return 0;
    const qty = Math.max(0, Number(row?.qty ?? row?.quantity) || 0);
    return Math.max(0, qty - recycleBlockedCopies(row) - RECYCLE_KEEP_COPIES);
  }

  /** Pourquoi une carte n'est pas recyclable (null = sélectionnable). */
  function recycleBlockOf(row, options = {}) {
    if (!row) return 'Carte introuvable';
    if (row.pinned) return 'Verrouillée : le site refuse le recyclage';
    const qty = Math.max(0, Number(row.qty) || 0);
    if (qty <= 1) return 'Seul exemplaire : conservé';
    if (recycleSpareOf(row) <= 0) {
      const locked = Math.max(0, Number(row.lockedQty ?? row.locked) || 0);
      if (locked > 0) return `${locked} exemplaire(s) déjà en vente`;
      return 'Tous les exemplaires sont engagés';
    }
    const rarity = String(row.rarity || 'C').toUpperCase();
    if (!options.includeML && (rarity === 'M' || rarity === 'L')) {
      return rarity === 'M' ? 'Mythique exclue par défaut' : 'Légendaire exclue par défaut';
    }
    return null;
  }

  /** Quantité retenue pour une carte : jamais plus que ce qui reste à recycler. */
  function recycleQtyOf(row, wanted) {
    const qty = Math.max(0, Math.floor(Number(wanted) || 0));
    return Math.min(recycleSpareOf(row), qty);
  }

  /**
   * Plan de recyclage à partir d'une sélection `Map<id, quantité>` (ou objet).
   * `rates` = barème de recyclage par rareté (`/api/config` → `recycle`).
   * Les cartes bloquées sont écartées : aucune destruction sans ligne valide.
   */
  function recycleBuildPlan(rows, selection, rates = {}) {
    const wanted = (id) => {
      if (!selection) return 0;
      if (typeof selection.get === 'function') return selection.get(String(id));
      return selection[String(id)];
    };
    const plan = [];
    for (const row of Array.isArray(rows) ? rows : []) {
      const qty = recycleQtyOf(row, wanted(row.id));
      if (qty <= 0) continue;
      const rarity = String(row.rarity || 'C').toUpperCase();
      const unit = Math.max(0, Number(rates?.[rarity]) || 0);
      plan.push({
        id: String(row.id),
        characterId: row.rawId ?? row.id,
        name: row.name,
        rarity,
        qty,
        maxQty: recycleSpareOf(row),
        totalQty: Math.max(0, Number(row.qty) || 0),
        unit,
        total: unit * qty
      });
    }
    return plan;
  }

  /** Totaux d'un plan : cartes, exemplaires, chakra attendu. */
  function recycleTotals(plan) {
    let cards = 0;
    let copies = 0;
    let chakra = 0;
    for (const row of Array.isArray(plan) ? plan : []) {
      cards += 1;
      copies += Math.max(0, Number(row.qty) || 0);
      chakra += Math.max(0, Number(row.total) || 0);
    }
    return { cards, copies, chakra };
  }

  /**
   * Une carte dont l'annonce vient d'être retirée pour ancienneté peut-elle
   * être recyclée à la place d'un retour dans le pool ?
   *
   * `row` décrit la carte **après le retrait** (les exemplaires de l'annonce
   * sont de nouveau libres : `listable` doit déjà les inclure). `listingQty`
   * est la quantité exacte de l'annonce retirée : on ne recycle jamais plus
   * que ça, et jamais moins (sinon une partie retournerait au pool sans trace).
   *
   * Retourne `{ recycle: true, qty }` ou `{ recycle: false, reason }`.
   */
  function recycleAfterExpiryDecision(row, options = {}) {
    const enabled = Boolean(options.enabled);
    const listingQty = Math.max(1, Math.floor(Number(options.listingQty) || 1));
    const includeM = Boolean(options.includeM);
    if (!enabled) return { recycle: false, reason: 'recyclage automatique désactivé' };
    if (!row) return { recycle: false, reason: 'carte absente de la collection' };
    const block = recycleBlockOf(row, { includeML: true });
    if (block) return { recycle: false, reason: block };
    const rarity = String(row.rarity || 'C').toUpperCase();
    if (rarity === 'M' && !includeM) {
      return { recycle: false, reason: 'Mythique exclue (option « Inclure les Mythiques » désactivée)' };
    }
    const spare = recycleSpareOf(row);
    if (spare < listingQty) {
      return {
        recycle: false,
        reason: `quantité non recyclable (${spare} exemplaire(s) en trop pour ${listingQty} annoncé(s))`
      };
    }
    return { recycle: true, qty: listingQty, reason: '' };
  }
  /* RECYCLE:END */

  /* AUTOSELL:BEGIN — sélection pure des doublons, testée par verify-autosell.mjs */
  /**
   * Toutes les annonces connues de `/api/me/market`, quel que soit le nom du
   * tableau renvoyé par le site (listings, activeListings, items…).
   * Aucune donnée inventée : un objet sans tableau d'annonces renvoie [].
   */
  function autoSellListingRows(mine) {
    if (Array.isArray(mine)) return mine.filter((item) => item && typeof item === 'object');
    if (!mine || typeof mine !== 'object') return [];
    const candidates = [
      mine.listings,
      mine.activeListings,
      mine.active,
      mine.items,
      mine.data?.listings,
      mine.data?.activeListings,
      mine.data?.items,
      mine.data,
      mine.market?.listings,
      mine.market
    ];
    for (const candidate of candidates) {
      if (Array.isArray(candidate)) {
        return candidate.filter((item) => item && typeof item === 'object');
      }
      if (candidate && Array.isArray(candidate.items)) {
        return candidate.items.filter((item) => item && typeof item === 'object');
      }
    }
    return [];
  }

  /** Vrai si la réponse contient bien une liste d'annonces (même vide). */
  function autoSellHasListings(mine) {
    if (Array.isArray(mine)) return true;
    if (!mine || typeof mine !== 'object') return false;
    for (const key of ['listings', 'activeListings', 'active', 'items']) {
      if (Array.isArray(mine[key])) return true;
      if (mine[key] && Array.isArray(mine[key].items)) return true;
    }
    if (mine.data) return autoSellHasListings(mine.data);
    if (mine.market) return autoSellHasListings(mine.market);
    return false;
  }

  function autoSellListingStatus(listing) {
    return String(listing?.status ?? '').trim().toLowerCase();
  }

  /** Une annonce active occupe une place et ne doit jamais être remise en vente. */
  function autoSellListingIsActive(listing, now = Date.now()) {
    if (!listing || typeof listing !== 'object') return false;
    const status = autoSellListingStatus(listing);
    if (['sold', 'expired', 'cancelled', 'canceled', 'ended', 'completed', 'filled'].includes(status)) {
      return false;
    }
    if (status && !['active', 'live', 'listed', 'open', 'pending'].includes(status)) return false;
    const rawEnd = listing.endsAt ?? listing.expiresAt ?? null;
    const end = rawEnd == null ? NaN : Date.parse(rawEnd);
    if (Number.isFinite(end) && end <= now) return false;
    return true;
  }

  function autoSellListingQty(listing) {
    const raw = listing?.qty ?? listing?.quantity ?? listing?.copies ?? listing?.amount ?? 1;
    const qty = Math.round(Number(raw));
    return Number.isFinite(qty) && qty > 0 ? qty : 1;
  }

  function autoSellListingPrice(listing) {
    const auction = String(listing?.type ?? '').toLowerCase() === 'auction';
    const raw = auction
      ? listing?.currentBid ?? listing?.price ?? listing?.finalPrice
      : listing?.finalPrice ?? listing?.price ?? listing?.currentBid;
    const price = Number(raw);
    return Number.isFinite(price) && price >= 0 ? price : null;
  }

  function autoSellListingTotal(listing, qty = autoSellListingQty(listing)) {
    const raw = listing?.totalPrice ?? listing?.total;
    const total = Number(raw);
    if (Number.isFinite(total) && total >= 0) return total;
    const unit = autoSellListingPrice(listing);
    return unit == null ? null : unit * qty;
  }

  function autoSellListingIds(listing) {
    return [listing?.id, listing?.listingId]
      .filter((value) => value != null && String(value))
      .map(String);
  }

  /**
   * Quantité déjà engagée par carte. Les identifiants et les noms sont indexés
   * séparément, puis le maximum est retenu pour ne pas compter deux fois une
   * même annonce qui porte à la fois `characterId` et `character.name`.
   */
  function autoSellActiveQtyByKey(listings, now = Date.now()) {
    const byId = new Map();
    const byName = new Map();
    for (const listing of Array.isArray(listings) ? listings : []) {
      if (!autoSellListingIsActive(listing, now)) continue;
      const qty = autoSellListingQty(listing);
      const id = listing?.characterId ?? listing?.character?.id ?? listing?.cardId ?? listing?.card?.id;
      if (id != null && String(id)) {
        const key = String(id);
        byId.set(key, (byId.get(key) ?? 0) + qty);
        continue;
      }
      const name = listing?.character?.name ?? listing?.name ?? listing?.card?.name;
      if (name) {
        const key = String(name).trim().toLowerCase();
        byName.set(key, (byName.get(key) ?? 0) + qty);
      }
    }
    return { byId, byName };
  }

  function autoSellActiveQtyFor(row, activeQtyByKey) {
    if (!row || !activeQtyByKey) return 0;
    const id = row.characterId ?? row.rawId ?? row.id;
    const fromId = id == null ? 0 : activeQtyByKey.byId.get(String(id)) ?? 0;
    const fromName = row.name ? activeQtyByKey.byName.get(String(row.name).trim().toLowerCase()) ?? 0 : 0;
    return Math.max(0, fromId, fromName);
  }

  /**
   * Nombre d'exemplaires réellement « en trop » : on garde toujours une copie
   * et on réserve celles qui sont déjà en vente. `listable` inclut la dernière
   * copie ; on ne peut donc pas l'utiliser tel quel.
   */
  function autoSellSpare(row, activeQty = 0) {
    if (!row) return 0;
    const qty = Math.max(0, Number(row.qty) || 0);
    if (qty <= 1) return 0;
    const reserved = Math.max(0, Math.floor(Number(activeQty) || 0));
    const locked = Math.max(0, Number(row.lockedQty) || 0);
    const rawListable = row.listable == null ? qty - locked : Number(row.listable);
    const listable = Number.isFinite(rawListable) ? Math.max(0, rawListable) : qty - locked;
    // On ne peut ni vendre la dernière copie ni revendre une copie déjà en ligne.
    const available = Math.max(0, qty - 1 - reserved);
    return Math.max(0, Math.min(available, listable));
  }

  /**
   * Une ligne peut-elle être vendue maintenant ? `price` est contrôlé séparément
   * (`requirePrice`) pour pouvoir compter les doublons sans prix connu.
   */
  function autoSellEligible(row, options = {}) {
    if (!row) return false;
    const autoQty = Number.isFinite(Number(row.autoQty))
      ? Number(row.autoQty)
      : autoSellSpare(row, row.activeQty);
    if (autoQty <= 0) return false;
    if (row.pinned) return false;
    if (row.sellBlock || row.block) return false;
    // Les légendaires sont vendues automatiquement ; seules les mythiques
    // restent protégées par défaut.
    if (!options.includeM && String(row.rarity || '').toUpperCase() === 'M') return false;

    if (options.requirePrice !== false) {
      if (row.price == null || row.price === '') return false;
      const price = Number(row.price);
      if (!Number.isFinite(price) || price <= 0) return false;
    }
    return true;
  }

  /**
   * Ancienneté maximale d'une statistique de ventes 7 j pour servir au
   * classement optimisé. Au-delà, le volume n'est plus considéré comme fiable :
   * la carte est classée comme si sa demande était inconnue (donc sans bonus).
   */
  const AUTOSELL_VOLUME_MAX_AGE_MS = 6 * 3600 * 1000;

  /** Les volumes/prix des candidats sont relus au plus toutes les 5 minutes. */
  const AUTOSELL_VOLUME_TTL_MS = 5 * 60 * 1000;

  /** Poids du classement optimisé : la demande pèse plus lourd que le prix. */
  const AUTOSELL_SCORE_WEIGHTS = { volume: 0.7, price: 0.3 };

  /**
   * Volume de ventes 7 j réellement exploitable pour une ligne.
   * `sales7dAt` est l'horodatage de la lecture marché : sans date, ou avec une
   * date trop ancienne, le volume est marqué `stale` et n'est pas utilisé.
   * Aucune donnée inventée : pas de volume connu ⇒ `missing`.
   */
  function autoSellVolumeInfo(row, options = {}) {
    const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
    const maxAge = Number.isFinite(Number(options.volumeMaxAgeMs))
      ? Math.max(0, Number(options.volumeMaxAgeMs))
      : AUTOSELL_VOLUME_MAX_AGE_MS;
    const raw = row?.sales7d ?? row?.sales7 ?? row?.sold7d ?? null;
    const volume = Number(raw);
    const known = raw != null && raw !== '' && Number.isFinite(volume) && volume >= 0;
    const atRaw = Number(row?.sales7dAt ?? row?.salesAt);
    const at = Number.isFinite(atRaw) && atRaw > 0 ? atRaw : null;
    if (!known) return { volume: null, status: 'missing', at };
    // Une valeur sans date de lecture ne peut pas être datée : on la traite
    // comme obsolète plutôt que de la croire sur parole.
    if (at == null) return { volume, status: 'stale', at: null };
    if (now - at > maxAge) return { volume, status: 'stale', at };
    return { volume, status: 'ok', at };
  }

  /**
   * Classement « Optimisé : prix + ventes sur 7 j ».
   *
   * Score 0–100 = 70 % liquidité + 30 % prix, chaque part log-normalisée sur la
   * meilleure candidate du moment (statistiques réelles, aucune constante de
   * marché) :
   *   - liquidité = log(1 + ventes 7 j) / log(1 + meilleur volume)
   *   - prix      = log(prix) / log(meilleur prix)
   * Le volume pèse donc plus lourd que le prix : une carte chère mais peu
   * demandée passe derrière une carte un peu moins chère qui s'écoule vite,
   * même avec un gros écart de prix. À liquidité comparable, le prix départage.
   * Un volume absent ou périmé laisse la liquidité à 0 : la carte ne peut pas
   * être supposée très demandée (score plafonné à 30/100).
   */
  function autoSellRank(rows, options = {}) {
    const list = Array.isArray(rows) ? rows : [];
    const infos = list.map((row) => autoSellVolumeInfo(row, options));
    const maxVolume = infos.reduce(
      (max, info) => (info.status === 'ok' ? Math.max(max, info.volume) : max),
      0
    );
    const maxPrice = list.reduce((max, row) => {
      const price = Number(row?.price);
      return Number.isFinite(price) && price > 0 ? Math.max(max, price) : max;
    }, 0);
    const weightVolume = Number.isFinite(Number(options.volumeWeight))
      ? Number(options.volumeWeight)
      : AUTOSELL_SCORE_WEIGHTS.volume;
    const weightPrice = Number.isFinite(Number(options.priceWeight))
      ? Number(options.priceWeight)
      : AUTOSELL_SCORE_WEIGHTS.price;
    const logVolumeRef = Math.log1p(maxVolume);
    const logPriceRef = Math.log(Math.max(2, maxPrice));

    const scored = list.map((row, index) => {
      const info = infos[index];
      const price = Number(row?.price);
      const liquidity =
        info.status === 'ok' && logVolumeRef > 0
          ? Math.min(1, Math.max(0, Math.log1p(info.volume) / logVolumeRef))
          : 0;
      const pricePart =
        Number.isFinite(price) && price > 0
          ? Math.min(1, Math.max(0, Math.log(price) / logPriceRef))
          : 0;
      const exact = weightVolume * liquidity + weightPrice * pricePart;
      return {
        ...row,
        // Volume brut conservé pour l'affichage, même s'il n'est pas exploitable.
        volume7: info.volume,
        volume7Status: info.status,
        volume7At: info.at,
        rank: {
          score: Math.round(exact * 100),
          exact,
          liquidity: Math.round(liquidity * 100) / 100,
          pricePart: Math.round(pricePart * 100) / 100,
          share: maxVolume > 0 && info.status === 'ok' ? info.volume / maxVolume : 0,
          maxVolume,
          maxPrice
        }
      };
    });

    scored.sort((a, b) => {
      const score = (b.rank?.exact ?? 0) - (a.rank?.exact ?? 0);
      if (score) return score;
      // Égalité de score : le prix unitaire, puis le lot, puis le nom.
      const priceA = Number(a.price) || 0;
      const priceB = Number(b.price) || 0;
      if (priceA !== priceB) return priceB - priceA;
      const totalA = priceA * (Number(a.autoQty) || 0);
      const totalB = priceB * (Number(b.autoQty) || 0);
      if (totalA !== totalB) return totalB - totalA;
      return String(a.name ?? '').localeCompare(String(b.name ?? ''), 'fr');
    });

    return scored.map((row, index) => ({ ...row, rank: { ...row.rank, position: index + 1 } }));
  }

  /**
   * Filtre les lignes de vente pour ne garder que les doublons sûrs.
   * `price` doit déjà être résolu par l'appelant (null = pas de prix connu).
   * Trois ordres : `score` (prix + ventes 7 j), `price_desc` ou `price_asc`.
   * Les deux tris par prix portent sur le **prix unitaire**, jamais sur le total
   * du lot : un lot de 2 cartes à 12 ne doit pas passer devant une carte à 100.
   */
  function autoSellSelect(rows, options = {}) {
    const list = (Array.isArray(rows) ? rows : [])
      .map((row) => ({ ...row, autoQty: autoSellSpare(row, row.activeQty) }))
      .filter((row) => autoSellEligible(row, options));
    if (options.order === 'score') return autoSellRank(list, options);

    const ascending = options.order === 'price_asc';
    const sign = ascending ? 1 : -1;
    return list.sort((a, b) => {
      const priceA = Number(a.price);
      const priceB = Number(b.price);
      const unit = sign * (priceA - priceB);
      if (unit) return unit;
      // À prix égal, le lot qui rapporte le plus passe devant.
      const total = sign * (priceA * a.autoQty - priceB * b.autoQty);
      if (total) return total;
      return String(a.name ?? '').localeCompare(String(b.name ?? ''), 'fr');
    });
  }

  /** Prix d'une stratégie de vente, sans jamais retomber sur un prix inventé. */
  function autoSellStrategyPrice(rec, strategy = 'balanced') {
    if (!rec || rec.estimated) return null;
    const pick = rec[strategy] ?? rec.balanced;
    const price = Number(pick?.price);
    return Number.isFinite(price) && price > 0 ? Math.max(1, Math.round(price)) : null;
  }

  /* --- Remise en vente automatique d'une annonce revenue sans acheteur ------ */

  /** Délai minimal entre deux remises en vente automatiques d'une même carte. */
  const AUTOSELL_RELIST_COOLDOWN_MS = 90 * 1000;

  /** Essais avant d'abandonner : la carte reste alors dans l'inventaire. */
  const AUTOSELL_RELIST_MAX_ATTEMPTS = 2;

  /** Une demande de remise en vente oubliée après ce délai (carte plus vendable). */
  const AUTOSELL_RELIST_TTL_MS = 6 * 3600 * 1000;

  /**
   * Tableau 2 — prix le plus bas réellement pratiqué sur le marché, par rareté
   * (relevé `price_asc` du 23/10/2026 vers 14:50, heure de Paris).
   *
   * C'est la référence de la remise en vente automatique : une carte qui revient
   * sans acheteur repart à ce prix, jamais en dessous. Si elle y était déjà
   * (ou moins cher), elle repart exactement au même prix.
   *
   * À rafraîchir quand le marché bouge : `GET /api/market/listings?rarity=…&
   * type=fixed&sort=price_asc&pageSize=1`.
   */
  const AUTOSELL_RELIST_TABLE = Object.freeze({
    C: 3,
    U: 3,
    R: 5,
    E: 15,
    L: 100,
    M: 815
  });

  /**
   * Prix d'une remise en vente : **le plus bas autorisé**, c'est-à-dire la
   * valeur du tableau 2 pour la rareté (prix fixe le plus bas réellement
   * pratiqué), jamais sous la valeur de recyclage. Sans entrée dans le tableau
   * (Héritage), repli sur la stratégie « Vente rapide » : 1 chakra sous la vente
   * la plus basse, sinon la médiane.
   *
   * Une carte déjà proposée à ce prix (ou en dessous) repart **exactement au
   * même prix** : inutile de descendre plus bas, le site refuserait la mise en
   * vente (`price_too_low`).
   */
  function autoSellRelistPrice({ floor, lowest, median, previous, rarity, table } = {}) {
    const min = Math.max(1, Math.round(Number(floor) || 1));
    const prev = Number(previous) > 0 ? Math.round(Number(previous)) : null;
    const low = Number(lowest) > 0 ? Math.round(Number(lowest)) : null;
    const med = Number(median) > 0 ? Math.round(Number(median)) : null;
    const reference = Number((table ?? AUTOSELL_RELIST_TABLE)[String(rarity ?? '').toUpperCase()]);
    let target = reference > 0 ? Math.round(reference) : low != null ? low - 1 : med;
    if (target == null) target = prev;
    if (target == null) target = min;
    target = Math.max(min, Math.round(target));
    // Déjà au prix plancher : on remet au même prix, sans tenter plus bas.
    if (prev != null && prev <= target) return Math.max(min, prev);
    return target;
  }

  /**
   * Une annonce expirée peut-elle repartir tout de suite ?
   * Renvoie `{ ok: true }` ou `{ ok: false, reason, permanent }`.
   *
   * `permanent` = inutile de réessayer (annulation volontaire, carte absente,
   * dernière copie, mythique exclue…) ; sinon la demande reste en attente
   * (place libre, délai anti-boucle, prochain essai).
   */
  function autoSellRelistCheck({
    dropped = null,
    row = null,
    spare = 0,
    slots = 0,
    includeM = false,
    lastAt = 0,
    now = Date.now(),
    cooldownMs = AUTOSELL_RELIST_COOLDOWN_MS
  } = {}) {
    const reason = String(dropped?.reason ?? '');
    // Retrait volontaire : jamais de remise en vente automatique.
    if (dropped?.manual || /annul/i.test(reason)) {
      return { ok: false, reason: 'annonce retirée à la main', permanent: true };
    }
    if (!row) return { ok: false, reason: 'carte absente de la collection', permanent: true };
    if (String(row.rarity || '').toUpperCase() === 'M' && !includeM) {
      return { ok: false, reason: 'carte mythique exclue de la vente auto', permanent: true };
    }
    if (row.pinned) return { ok: false, reason: 'carte épinglée', permanent: true };
    if (row.sellBlock || row.block) {
      return { ok: false, reason: 'revente bloquée (achat de moins de 48 h)', permanent: true };
    }
    if (Number(spare) <= 0) {
      return { ok: false, reason: 'aucune copie disponible, dernière copie conservée', permanent: true };
    }
    if (Number(slots) <= 0) return { ok: false, reason: 'aucune place d’annonce libre', permanent: false };
    if (Number(lastAt) > 0 && now - Number(lastAt) < Math.max(0, Number(cooldownMs) || 0)) {
      return { ok: false, reason: 'délai anti-boucle', permanent: false };
    }
    return { ok: true };
  }

  /**
   * Ajoute une demande de remise en vente sans doublon : une seule entrée par
   * carte, la plus récente (dernier prix connu, dernier horodatage) gagne.
   */
  function autoSellRelistEnqueue(queue, entry, options = {}) {
    const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
    const ttl = Math.max(0, Number(options.ttlMs) || AUTOSELL_RELIST_TTL_MS);
    const list = (Array.isArray(queue) ? queue : []).filter(
      (item) => item && String(item.characterId ?? '') && now - Number(item.at || 0) <= ttl
    );
    const characterId = String(entry?.characterId ?? '');
    if (!characterId) return list;
    const next = { ...entry, characterId, at: now, attempts: 0 };
    const index = list.findIndex((item) => String(item.characterId) === characterId);
    if (index >= 0) list[index] = next;
    else list.push(next);
    return list;
  }

  /** Répartit les places d'annonce disponibles, en commençant par les lots les plus values. */
  function autoSellBuildPlan(candidates, options = {}) {
    let left = Math.max(0, Math.min(10, Math.round(Number(options.slots) || 0)));
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

  /* --- Retrait des annonces trop anciennes, retour en fin de classement ---- */

  /** Unités acceptées pour la durée de retrait : minutes ou heures. */
  const AUTOSELL_EXPIRE_UNITS = Object.freeze({ min: 60 * 1000, h: 3600 * 1000 });

  /** Bornes de la durée : 1 minute au minimum, 30 jours au maximum. */
  const AUTOSELL_EXPIRE_MIN_MS = 60 * 1000;
  const AUTOSELL_EXPIRE_MAX_MS = 30 * 24 * 3600 * 1000;

  /** Une carte retirée n'est pas remise en vente avant ce délai (anti-boucle). */
  const AUTOSELL_RETURN_COOLDOWN_MS = 10 * 60 * 1000;

  /** Un retour trop ancien n'occupe plus la file de fin de classement. */
  const AUTOSELL_RETURN_TTL_MS = 24 * 3600 * 1000;

  /** Taille maximale du journal des retraits (affiché dans le panneau). */
  const AUTOSELL_EXPIRY_HISTORY_MAX = 40;

  /** Champs d'horodatage qui donnent la vraie date de mise en vente d'une annonce. */
  const AUTOSELL_LISTING_START_FIELDS = ['createdAt', 'listedAt', 'publishedAt', 'startAt', 'created'];

  /** Unités proposées dans le panneau. */
  const AUTOSELL_EXPIRE_UNIT_OPTIONS = [
    ['min', 'minutes'],
    ['h', 'heures']
  ];

  /** Durée de retrait en millisecondes, ou 0 si la fonctionnalité est désactivée. */
  function autoSellExpireDelayMs(options = {}) {
    if (!options.enabled) return 0;
    const unit = String(options.unit ?? 'h') === 'min' ? 'min' : 'h';
    const amount = Math.round(Number(options.value));
    if (!Number.isFinite(amount) || amount <= 0) return 0;
    const ms = amount * AUTOSELL_EXPIRE_UNITS[unit];
    return Math.min(AUTOSELL_EXPIRE_MAX_MS, Math.max(AUTOSELL_EXPIRE_MIN_MS, ms));
  }

  /**
   * Réglage validé de la durée de retrait : unité connue, valeur entière dans
   * les bornes de cette unité (1 minute à 30 jours). Une valeur absente ou
   * illisible retombe sur 72 heures, jamais silencieusement sur zéro.
   */
  function autoSellExpireSettings(raw = {}) {
    const unit = String(raw.unit ?? 'h') === 'min' ? 'min' : 'h';
    const max = unit === 'min' ? Math.round(AUTOSELL_EXPIRE_MAX_MS / 60000) : Math.round(AUTOSELL_EXPIRE_MAX_MS / 3600000);
    const fallback = unit === 'min' ? 60 : 72;
    // Une saisie explicite (0, valeur négative, texte) est ramenée dans les
    // bornes ; une valeur absente ou vide retombe sur le défaut de l'unité.
    const rawValue = raw.value;
    const parsed =
      rawValue === null || rawValue === undefined || rawValue === '' ? NaN : Number(rawValue);
    const value = Number.isFinite(parsed) ? Math.min(max, Math.max(1, Math.round(parsed))) : fallback;
    return { enabled: Boolean(raw.enabled), unit, value };
  }

  /** Durée lisible : « 45 min », « 2 h 30 min », « 3 j 2 h ». */
  function autoSellExpireLabel(ms) {
    const total = Math.round(Number(ms) / 60000);
    if (!(total > 0)) return '—';
    if (total < 60) return `${total} min`;
    const hours = Math.floor(total / 60);
    const minutes = total % 60;
    if (hours < 24) return minutes ? `${hours} h ${minutes} min` : `${hours} h`;
    const days = Math.floor(hours / 24);
    const rest = hours % 24;
    return rest ? `${days} j ${rest} h` : `${days} j`;
  }

  /**
   * Date réelle de mise en vente : d'abord l'horodatage renvoyé par le site,
   * sinon la trace locale de création par Kyareeh+ (`trackAt`). Sans les deux,
   * renvoie `null` — on ne retire jamais une annonce dont la date est inconnue.
   */
  function autoSellListingStartAt(listing, options = {}) {
    for (const field of AUTOSELL_LISTING_START_FIELDS) {
      const raw = listing?.[field];
      const parsed = typeof raw === 'number' ? raw : Date.parse(raw ?? '');
      if (Number.isFinite(parsed) && parsed > 0) return parsed < 1e11 ? parsed * 1000 : parsed;
    }
    const trackAt = Number(options.trackAt);
    return Number.isFinite(trackAt) && trackAt > 0 ? trackAt : null;
  }

  /**
   * Origine d'une annonce. Seule une annonce **créée par la vente auto** peut
   * être retirée : `track` est le suivi local de Kyareeh+ (`state.salesTrack`,
   * avec `source: 'auto' | 'manual'`). Sans preuve d'origine, `auto` vaut false.
   */
  function autoSellOriginOf(listing, track) {
    const entries = Array.isArray(track) ? track : [];
    const ids = autoSellListingIds(listing);
    if (ids.length) {
      const direct = entries.find((entry) => entry && ids.includes(String(entry.id)));
      if (direct) return { auto: direct.source === 'auto', entry: direct };
    }
    const cardId = listing?.characterId ?? listing?.character?.id ?? listing?.cardId ?? listing?.card?.id ?? null;
    if (cardId == null || cardId === '') return { auto: false, entry: null };
    const price = autoSellListingPrice(listing);
    // Repli réservé aux annonces dont le site n'a pas renvoyé d'identifiant
    // (`local-…`) : une annonce portant un identifiant serveur inconnu du suivi
    // n'est jamais attribuée à la vente auto, donc jamais retirée.
    const sameCard = entries.filter(
      (entry) =>
        entry &&
        String(entry.id).startsWith('local-') &&
        String(entry.characterId ?? '') === String(cardId)
    );
    const samePrice = sameCard.filter(
      (entry) => price == null || entry.price == null || Number(entry.price) === Number(price)
    );
    // Rapprochement uniquement s'il est unique : deux annonces identiques ne
    // peuvent pas être attribuées sans risque, on ne touche donc à aucune.
    if (samePrice.length === 1) return { auto: samePrice[0].source === 'auto', entry: samePrice[0] };
    return { auto: false, entry: null };
  }

  /** Une enchère ayant déjà reçu une offre ne peut pas être retirée par le site. */
  function autoSellListingHasBids(listing) {
    const bids = Number(listing?.bidCount ?? listing?.bids ?? 0);
    if (Number.isFinite(bids) && bids > 0) return true;
    const bid = Number(listing?.currentBid ?? listing?.bid ?? 0);
    const price = autoSellListingPrice(listing);
    return Number.isFinite(bid) && bid > 0 && (price == null || bid > price);
  }

  /**
   * Cette annonce doit-elle être retirée maintenant ? `due` n'est vrai que si :
   * fonctionnalité active, annonce encore active (ni vendue ni terminée),
   * créée par la vente auto, date de mise en vente connue, seuil atteint et
   * aucune offre déjà placée. Aucune date n'est inventée.
   */
  function autoSellExpiryCheck(listing, options = {}) {
    const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
    const maxAgeMs = Math.max(0, Number(options.maxAgeMs) || 0);
    const startedAt = autoSellListingStartAt(listing, { trackAt: options.trackAt });
    const ageMs = startedAt == null ? null : Math.max(0, now - startedAt);
    const base = { startAt: startedAt, ageMs, listingId: autoSellListingIds(listing)[0] ?? null };
    if (!(maxAgeMs > 0)) return { ...base, due: false, reason: 'désactivé' };
    if (!autoSellListingIsActive(listing, now)) return { ...base, due: false, reason: 'annonce déjà terminée' };
    if (options.auto !== true) return { ...base, due: false, reason: 'annonce manuelle' };
    if (autoSellListingHasBids(listing)) return { ...base, due: false, reason: 'enchère avec offre' };
    if (startedAt == null) return { ...base, due: false, reason: 'date de mise en vente inconnue' };
    if (ageMs < maxAgeMs) return { ...base, due: false, reason: 'délai non atteint' };
    return { ...base, due: true, reason: 'durée dépassée' };
  }

  /**
   * Annonces à retirer, triées par date de mise en vente (ordre stable).
   * `skipIds` écarte les annonces déjà en cours de retrait (verrou) ; un même
   * identifiant n'est jamais proposé deux fois.
   */
  function autoSellExpiredListings(listings, options = {}) {
    const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
    const maxAgeMs = Math.max(0, Number(options.maxAgeMs) || 0);
    const track = Array.isArray(options.track) ? options.track : [];
    const skip = options.skipIds instanceof Set ? options.skipIds : new Set(Array.isArray(options.skipIds) ? options.skipIds : []);
    const out = [];
    const seen = new Set();
    for (const listing of Array.isArray(listings) ? listings : []) {
      const ids = autoSellListingIds(listing);
      if (!ids.length) continue;
      if (ids.some((id) => skip.has(id) || seen.has(id))) continue;
      const origin = autoSellOriginOf(listing, track);
      const check = autoSellExpiryCheck(listing, {
        now,
        maxAgeMs,
        auto: origin.auto,
        trackAt: origin.entry?.createdAt
      });
      if (!check.due) continue;
      ids.forEach((id) => seen.add(id));
      const card = listing.character ?? {};
      out.push({
        listing,
        id: ids[0],
        ids,
        startAt: check.startAt,
        ageMs: check.ageMs,
        reason: check.reason,
        characterId: listing.characterId ?? card.id ?? null,
        name: String(card.name ?? listing.name ?? ''),
        rarity: String(card.rarity ?? listing.rarity ?? ''),
        price: autoSellListingPrice(listing)
      });
    }
    out.sort((a, b) => (a.startAt ?? 0) - (b.startAt ?? 0) || String(a.name).localeCompare(String(b.name), 'fr'));
    return out;
  }

  /** Ajoute une carte retirée à la file de fin, sans doublon (la plus récente gagne). */
  function autoSellReturnAdd(returns, entry, options = {}) {
    const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
    const ttl = Math.max(0, Number(options.ttlMs) || AUTOSELL_RETURN_TTL_MS);
    const list = (Array.isArray(returns) ? returns : []).filter(
      (item) => item && item.characterId != null && item.characterId !== '' && now - Number(item.at || 0) <= ttl
    );
    const characterId = String(entry?.characterId ?? '');
    if (!characterId) return list;
    const at = Number.isFinite(Number(entry.at)) && Number(entry.at) > 0 ? Number(entry.at) : now;
    const next = { ...entry, characterId, at };
    const index = list.findIndex((item) => String(item.characterId) === characterId);
    if (index >= 0) list[index] = next;
    else list.push(next);
    return list;
  }

  /** Retire une carte de la file de retour : elle a été resélectionnée. */
  function autoSellReturnClear(returns, characterId) {
    const key = String(characterId ?? '');
    if (!key) return Array.isArray(returns) ? returns : [];
    return (Array.isArray(returns) ? returns : []).filter((entry) => String(entry?.characterId ?? '') !== key);
  }

  /** Le délai anti-boucle d'une carte retirée est-il écoulé ? */
  function autoSellReturnReady(entry, now = Date.now(), cooldownMs = AUTOSELL_RETURN_COOLDOWN_MS) {
    const at = Number(entry?.at);
    if (!(at > 0)) return false;
    return Number(now) >= at + Math.max(0, Number(cooldownMs) || 0);
  }

  /**
   * Réintégration en fin de classement. Les cartes retirées pour expiration
   * passent **après toutes les autres**, dans l'ordre de leur retrait (stable).
   * Une carte encore dans son délai anti-boucle est écartée de la sélection
   * (`heldBack`) : elle n'est donc jamais retirée puis remise en vente aussitôt.
   */
  function autoSellApplyReturns(rows, returns, options = {}) {
    const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
    const cooldownMs = Number.isFinite(Number(options.cooldownMs))
      ? Math.max(0, Number(options.cooldownMs))
      : AUTOSELL_RETURN_COOLDOWN_MS;
    const list = Array.isArray(rows) ? rows : [];
    const byCard = new Map();
    for (const entry of Array.isArray(returns) ? returns : []) {
      const key = String(entry?.characterId ?? '');
      if (!key) continue;
      const previous = byCard.get(key);
      if (!previous || Number(entry.at) > Number(previous.at)) byCard.set(key, entry);
    }
    const head = [];
    const tail = [];
    let heldBack = 0;
    for (const row of list) {
      const key = String(row?.characterId ?? row?.id ?? '');
      const entry = byCard.get(key);
      if (!entry) {
        head.push(row);
        continue;
      }
      if (!autoSellReturnReady(entry, now, cooldownMs)) {
        heldBack += 1;
        continue;
      }
      tail.push({ ...row, expiredReturn: true, returnedAt: Number(entry.at) });
    }
    tail.sort(
      (a, b) => (a.returnedAt ?? 0) - (b.returnedAt ?? 0) || String(a.name ?? '').localeCompare(String(b.name ?? ''), 'fr')
    );
    return { rows: [...head, ...tail], returned: tail.length, heldBack };
  }

  /** Lecture tolérante d'une file de retours persistée (aucune donnée inventée). */
  function autoSellExpiryReturnsSanitize(raw) {
    const out = [];
    for (const item of Array.isArray(raw) ? raw : []) {
      if (!item || item.characterId == null || item.characterId === '') continue;
      const at = Number(item.at);
      if (!(at > 0)) continue;
      out.push({
        characterId: String(item.characterId),
        listingId: item.listingId == null ? null : String(item.listingId),
        name: String(item.name ?? ''),
        rarity: String(item.rarity ?? ''),
        price: Number(item.price) > 0 ? Math.round(Number(item.price)) : null,
        at,
        ageMs: Math.max(0, Number(item.ageMs) || 0),
        thresholdMs: Math.max(0, Number(item.thresholdMs) || 0)
      });
    }
    return out.sort((a, b) => a.at - b.at).slice(-AUTOSELL_EXPIRY_HISTORY_MAX);
  }

  /** Lecture tolérante du journal des retraits et remises en vente. */
  function autoSellExpiryHistorySanitize(raw) {
    const out = [];
    for (const item of Array.isArray(raw) ? raw : []) {
      if (!item) continue;
      const at = Number(item.at);
      if (!(at > 0)) continue;
      const kind = item.kind === 'relist' ? 'relist' : 'remove';
      out.push({
        kind,
        at,
        listingId: item.listingId == null ? null : String(item.listingId),
        characterId: item.characterId == null ? null : String(item.characterId),
        name: String(item.name ?? ''),
        rarity: String(item.rarity ?? ''),
        price: Number(item.price) > 0 ? Math.round(Number(item.price)) : null,
        ageMs: Math.max(0, Number(item.ageMs) || 0),
        thresholdMs: Math.max(0, Number(item.thresholdMs) || 0),
        // Ce que la carte est devenue : recyclée ou renvoyée en fin de file.
        outcome: item.outcome === 'recycle' ? 'recycle' : 'return',
        recycledQty: Math.max(0, Math.round(Number(item.recycledQty) || 0)),
        gained: Math.max(0, Math.round(Number(item.gained) || 0)),
        reason: String(item.reason ?? '')
      });
    }
    return out.sort((a, b) => a.at - b.at).slice(-AUTOSELL_EXPIRY_HISTORY_MAX);
  }
  /* AUTOSELL:END */

  /* SALES:BEGIN — ventes confirmées, profit réalisé et courbe cumulée.
     Bloc pur, testé par verify-sales-chart.mjs. Il réutilise les helpers
     d'annonce du bloc AUTOSELL (juste au-dessus) : les tests extraient les deux
     blocs. Aucune donnée inventée : le profit n'est calculé qu'à partir du prix
     réellement encaissé et du barème de frais du site. */

  /** Frais de mise en vente (barème du site), appliqués à un prix encaissé. */
  function salesFeeOf(price, rates = {}) {
    const value = Math.max(0, Number(price) || 0);
    const pct = Number.isFinite(Number(rates.feePct)) ? Number(rates.feePct) : 2;
    const min = Number.isFinite(Number(rates.feeMin)) ? Number(rates.feeMin) : 1;
    return Math.max(min, Math.ceil((value * pct) / 100));
  }

  /** Taxe de vente (barème du site), appliquée à un prix encaissé. */
  function salesTaxOf(price, rates = {}) {
    const value = Math.max(0, Number(price) || 0);
    const pct = Number.isFinite(Number(rates.taxPct)) ? Number(rates.taxPct) : 5;
    return Math.ceil((value * pct) / 100);
  }

  /**
   * Profit net d'une vente confirmée : encaissé − frais − taxe.
   * Le site ne fournit **aucun coût d'acquisition** : il n'est donc jamais
   * inventé ni déduit (affiché comme non fourni dans l'interface).
   */
  function salesProfitOf(gross, rates = {}) {
    const value = Math.max(0, Number(gross) || 0);
    const fees = salesFeeOf(value, rates);
    const tax = salesTaxOf(value, rates);
    return { gross: value, fees, tax, net: Math.max(0, value - fees - tax) };
  }

  function salesLedgerTotals(log) {
    const totals = { gross: 0, fees: 0, tax: 0, net: 0, count: 0, matched: 0, auto: 0, manual: 0, autoNet: 0, manualNet: 0 };
    for (const entry of Array.isArray(log) ? log : []) {
      const gross = Math.max(0, Number(entry?.gross) || 0);
      const fees = Math.max(0, Number(entry?.fees) || 0);
      const tax = Math.max(0, Number(entry?.tax) || 0);
      const net = Math.max(0, Number(entry?.net) || 0);
      totals.gross += gross;
      totals.fees += fees;
      totals.tax += tax;
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

  /** Statuts d'annonce qui prouvent une vente, puis ceux qui l'excluent. */
  const SALES_SOLD_STATUSES = ['sold', 'completed', 'filled'];
  const SALES_DEAD_STATUSES = ['expired', 'ended', 'cancelled', 'canceled'];

  /** Lecture normalisée d'une annonce de `/api/me/market` (pure). */
  function salesListingSnapshot(listing, now = Date.now()) {
    if (!listing || typeof listing !== 'object') return null;
    const status = autoSellListingStatus(listing);
    const rawEnd = listing.endsAt ?? listing.expiresAt ?? null;
    const end = rawEnd == null ? NaN : Date.parse(rawEnd);
    const rawSold = listing.soldAt ?? listing.soldOn ?? listing.completedAt ?? null;
    const sold = rawSold == null ? NaN : Date.parse(rawSold);
    const bid = Number(listing.currentBid);
    const bids = Number(listing.bidCount);
    const characterId = listing.characterId ?? listing.character?.id ?? listing.cardId ?? listing.card?.id ?? null;
    return {
      ids: autoSellListingIds(listing),
      status,
      active: autoSellListingIsActive(listing, now),
      sold: SALES_SOLD_STATUSES.includes(status),
      dead: SALES_DEAD_STATUSES.includes(status),
      at: Number.isFinite(end) ? end : null,
      soldAt: Number.isFinite(sold) ? sold : null,
      price: autoSellListingPrice(listing),
      bid: Number.isFinite(bid) && bid > 0 ? bid : null,
      bids: Number.isFinite(bids) && bids > 0 ? bids : null,
      characterId: characterId == null || characterId === '' ? null : characterId
    };
  }

  /** Transforme une annonce suivie en vente confirmée (profit net compris). */
  function salesEntryFromTrack(track, snapshot, at, rates) {
    const auction = String(track?.type ?? '').toLowerCase() === 'auction';
    const raw = auction
      ? snapshot?.bid ?? track?.bid ?? snapshot?.price ?? track?.price
      : snapshot?.price ?? track?.price;
    const profit = salesProfitOf(raw, rates);
    return {
      id: `sale:${track.id}`,
      listingId: String(track.id),
      at: Math.max(0, Number(at) || Date.now()),
      name: String(track.name ?? ''),
      rarity: String(track.rarity ?? ''),
      characterId: track.characterId ?? null,
      accountId: track.accountId ?? null,
      source: track.source === 'auto' ? 'auto' : 'manual',
      matched: false,
      ...profit
    };
  }

  /**
   * Confronte les annonces suivies au dernier instantané de `/api/me/market`.
   *
   * Règles, sans jamais deviner :
   *  - annonce encore active → conservée (avec son prix et sa meilleure offre) ;
   *  - annonce au statut « vendue » → vente confirmée tout de suite ;
   *  - annonce annulée / expirée → abandonnée, aucun point ;
   *  - annonce **disparue avant son échéance** → vente confirmée (le site ne
   *    fournit aucun historique : c'est la seule trace d'une vente) ;
   *  - annonce disparue à/après son échéance → expiration, sauf enchère ayant
   *    reçu au moins une offre (l'adjudication est alors une vente).
   * Un délai de grâce couvre l'indexation d'une annonce qui vient d'être créée.
   */
  function salesTrackReconcile(track, listings, now = Date.now(), options = {}) {
    const current = Number.isFinite(Number(now)) ? Number(now) : Date.now();
    const rates = options.rates ?? {};
    const accountId = options.accountId == null ? null : String(options.accountId);
    const graceMs = Number.isFinite(Number(options.graceMs))
      ? Math.max(0, Number(options.graceMs))
      : 90 * 1000;
    const snaps = (Array.isArray(listings) ? listings : [])
      .map((listing) => salesListingSnapshot(listing, current))
      .filter(Boolean);
    const byId = new Map();
    const byCard = new Map();
    for (const snap of snaps) {
      for (const id of snap.ids) byId.set(String(id), snap);
      if (snap.characterId != null) {
        const key = String(snap.characterId);
        if (!byCard.has(key)) byCard.set(key, []);
        byCard.get(key).push(snap);
      }
    }

    // Identifiant local (l'API n'a rien renvoyé) : on reconnaît l'annonce par
    // carte et par prix, et seulement si le rapprochement est unique.
    const findSnap = (entry) => {
      const direct = byId.get(String(entry.id));
      if (direct) return direct;
      if (!String(entry.id).startsWith('local-')) return null;
      const candidates = byCard.get(String(entry.characterId ?? '')) ?? [];
      const priced = candidates.filter(
        (snap) => entry.price == null || snap.price == null || Number(snap.price) === Number(entry.price)
      );
      return priced.length === 1 ? priced[0] : null;
    };

    const sales = [];
    const keep = [];
    const dropped = [];
    for (const entry of Array.isArray(track) ? track : []) {
      if (!entry || entry.id == null) continue;
      // Suivi d'un autre compte : on n'y touche pas depuis celui-ci.
      if (accountId && entry.accountId != null && String(entry.accountId) !== accountId) {
        keep.push(entry);
        continue;
      }
      const createdAt = Number(entry.createdAt ?? entry.at) || 0;
      const endsAt = Number(entry.endsAt) || 0;
      const snap = findSnap(entry);

      if (snap) {
        if (snap.sold) {
          sales.push(salesEntryFromTrack(entry, snap, snap.soldAt ?? current, rates));
          continue;
        }
        if (snap.dead) {
          // Détail conservé : une annulation volontaire ne doit jamais être
          // remise en vente, contrairement à une expiration sans acheteur.
          dropped.push({
            id: entry.id,
            reason: snap.status === 'expired' ? 'expirée' : 'annulée',
            status: snap.status,
            characterId: entry.characterId ?? null,
            name: entry.name ?? '',
            rarity: entry.rarity ?? '',
            type: entry.type ?? '',
            price: snap.price ?? entry.price ?? null,
            endsAt: snap.at ?? entry.endsAt ?? null
          });
          continue;
        }
        if (snap.active) {
          keep.push({
            ...entry,
            id: snap.ids.length && String(entry.id).startsWith('local-') ? snap.ids[0] : entry.id,
            price: snap.price ?? entry.price,
            bid: snap.bid ?? entry.bid ?? null,
            bids: snap.bids ?? entry.bids ?? null,
            endsAt: snap.at ?? entry.endsAt,
            lastSeenAt: current
          });
          continue;
        }
      }

      // Annonce absente du dernier instantané.
      if (createdAt && current - createdAt < graceMs) {
        keep.push(entry);
        continue;
      }
      const seen = Number(entry.lastSeenAt) > 0;
      const serverId = !String(entry.id).startsWith('local-');
      const auction = String(entry.type ?? '').toLowerCase() === 'auction';
      const bestBid = Math.max(Number(entry.bid) || 0, Number(entry.price) || 0);
      const hadBid = (Number(entry.bids) || 0) > 0 || (Number(entry.bid) || 0) > Number(entry.price) || false;

      if (!endsAt || current < endsAt) {
        // Disparue avant son échéance : vendue. Sans identifiant serveur et
        // sans jamais l'avoir vue, on ne peut pas l'affirmer : on attend
        // l'échéance plutôt que d'inventer une vente.
        if (seen || serverId) {
          sales.push(salesEntryFromTrack(entry, null, current, rates));
        } else {
          keep.push(entry);
        }
        continue;
      }
      if (auction && hadBid) {
        sales.push(salesEntryFromTrack({ ...entry, price: bestBid }, null, endsAt, rates));
        continue;
      }
      dropped.push({
        id: entry.id,
        reason: 'expirée',
        status: 'expired',
        characterId: entry.characterId ?? null,
        name: entry.name ?? '',
        rarity: entry.rarity ?? '',
        type: entry.type ?? '',
        price: entry.price ?? null,
        endsAt
      });
    }
    return { sales, keep, dropped };
  }

  /**
   * Fusionne des ventes dans le journal en garantissant **une seule ligne par
   * vente** (identifiant d'annonce). Renvoie le journal trié et les ajouts.
   */
  function salesMergeEntries(log, entries) {
    const list = Array.isArray(log) ? log.slice() : [];
    const seen = new Set(list.map((entry) => String(entry?.id ?? '')));
    const added = [];
    for (const entry of Array.isArray(entries) ? entries : []) {
      if (!entry || entry.id == null) continue;
      const key = String(entry.id);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      list.push(entry);
      added.push(entry);
    }
    list.sort((a, b) => Number(a.at) - Number(b.at) || String(a.id).localeCompare(String(b.id)));
    return { log: list, added };
  }

  /**
   * Profit réalisé **cumulé** par tranche horaire sur la fenêtre demandée
   * (`1d`, `7d`, `total`). Chaque point porte le cumul et les ventes de la
   * tranche (nom, heure, profit) pour l'infobulle.
   */
  function salesChartSeries(log, now = Date.now(), range = '7d', options = {}) {
    const normalized = ['1d', '7d', 'total'].includes(range) ? range : '7d';
    const accountId = options.accountId == null ? null : String(options.accountId);
    const hour = 3600000;
    const current = new Date(Number(now) || Date.now());
    current.setMinutes(0, 0, 0);
    const lastAt = current.getTime();
    const entries = (Array.isArray(log) ? log : [])
      .map((entry) => ({ ...entry, at: Number(entry?.at) }))
      .filter((entry) => Number.isFinite(entry.at) && entry.at <= now)
      // Les ventes d'un autre compte ne polluent pas la courbe du compte courant.
      .filter((entry) => !accountId || entry.accountId == null || String(entry.accountId) === accountId);

    let startAt;
    let stepHours = 1;
    if (normalized === '1d') {
      startAt = lastAt - 23 * hour;
    } else if (normalized === '7d') {
      startAt = lastAt - 167 * hour;
    } else {
      const first = entries.length ? Math.min(...entries.map((entry) => entry.at)) : lastAt;
      const firstHour = new Date(first);
      firstHour.setMinutes(0, 0, 0);
      startAt = firstHour.getTime();
      const spanHours = Math.max(1, Math.floor((lastAt - startAt) / hour) + 1);
      // « Total » peut couvrir des mois : on garde au plus ~720 points,
      // toujours par pas d'heures entières.
      stepHours = Math.max(1, Math.ceil(spanHours / 720));
    }

    const count = Math.max(1, Math.floor((lastAt - startAt) / (hour * stepHours)) + 1);
    const buckets = Array.from({ length: count }, (_, index) => ({
      at: startAt + index * hour * stepHours,
      profit: 0,
      sales: []
    }));

    let net = 0;
    let gross = 0;
    let fees = 0;
    let tax = 0;
    let included = 0;
    let matched = 0;
    for (const entry of entries) {
      if (entry.at < startAt) continue;
      const index = Math.floor((entry.at - startAt) / (hour * stepHours));
      if (index < 0 || index >= count) continue;
      const value = Math.max(0, Number(entry.net) || 0);
      buckets[index].profit += value;
      buckets[index].sales.push({
        at: entry.at,
        name: String(entry.name ?? ''),
        net: value,
        matched: Boolean(entry.matched)
      });
      net += value;
      gross += Math.max(0, Number(entry.gross) || 0);
      fees += Math.max(0, Number(entry.fees) || 0);
      tax += Math.max(0, Number(entry.tax) || 0);
      included += 1;
      if (entry.matched) matched += 1;
    }

    let cumulative = 0;
    let maxProfit = 0;
    const points = buckets.map((bucket) => {
      cumulative += bucket.profit;
      maxProfit = Math.max(maxProfit, bucket.profit);
      // `value` = cumul (comptabilité du total), `profit` = gain de la tranche :
      // c'est cette valeur que la courbe trace, heure par heure.
      return { at: bucket.at, value: cumulative, profit: bucket.profit, sales: bucket.sales };
    });
    return {
      points,
      max: Math.max(1, cumulative),
      // Plus gros gain d'une seule tranche : échelle de la courbe par heure.
      maxProfit: Math.max(0, maxProfit),
      range: normalized,
      net: cumulative,
      gross,
      fees,
      tax,
      count: included,
      matched,
      stepHours,
      startAt,
      lastAt
    };
  }
  /* SALES:END */

  /**
   * Prix auto : on réutilise exactement les trois stratégies de la vente manuelle.
   * Sans données de marché, on renvoie null : la vente auto n'invente pas de prix.
   */
  function autoSellPrice(row, strategy = state.settings.autoSellStrategy) {
    return autoSellStrategyPrice(rowRecommendation(row, row), strategy);
  }

  /**
   * Statistiques de marché du classement optimisé, lues dans le cache de prix
   * (le même instantané que la fiche carte). `sales7dAt` permet de détecter un
   * volume trop ancien : une donnée périmée n'est jamais présentée comme fraîche.
   */
  function autoSellMarketStats(id) {
    const entry = state.prices[String(id ?? '')];
    if (!entry) return { sales7d: null, sales7dAt: null };
    const raw = entry.sales7d;
    const volume = raw == null || raw === '' ? null : Number(raw);
    return {
      sales7d: Number.isFinite(volume) ? volume : null,
      sales7dAt: Number(entry.at) > 0 ? Number(entry.at) : null
    };
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
  async function openCardDetail(id, opts = {}) {
    const key = String(id ?? '');
    if (!key) return;
    const view = state.sellView;
    view.detailId = key;
    view.detail = null;
    view.detailError = null;
    view.detailLoading = true;
    // Fiche ouverte depuis une annonce en cours : on masque le prix recommandé.
    view.detailHideRecommend = Boolean(opts.hideRecommend);
    state.listingCancelId = null;
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
    view.detailHideRecommend = false;
    state.listingCancelId = null;
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
        await openCardDetail(view.detailId, { hideRecommend: view.detailHideRecommend });
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

  let uiSaveTimer = null;

  /** Onglets du site synchronisés : ouverture et onglet actif partagés. */
  function applyUiPrefs(raw) {
    if (!raw || typeof raw !== 'object') return;
    // La fenêtre détachée est toujours ouverte : fermer le panneau de la page ne doit jamais
    // la vider (c'était la panne « Détacher ne marche plus »).
    if (!IS_PANEL && typeof raw.open === 'boolean') state.open = raw.open;
    if (typeof raw.tab === 'string' && raw.tab) state.tab = raw.tab;
    render();
  }

  async function loadUiPrefs() {
    applyUiPrefs(await storageGet(UI_KEY, null));
    // La fenêtre détachée part de l'onglet actif de la page, puis vit sa vie : pas de synchro
    // continue (elle écraserait l'onglet que l'on consulte dans l'une ou l'autre).
    if (IS_PANEL) return;
    try {
      ext.storage.onChanged.addListener((changes, area) => {
        if (area && area !== 'local') return;
        if (changes && changes[UI_KEY]) applyUiPrefs(changes[UI_KEY].newValue);
      });
    } catch {
      /* pas d'écoute : chaque onglet garde son état */
    }
  }

  function persistUiSoon() {
    if (IS_PANEL) return;
    if (uiSaveTimer) clearTimeout(uiSaveTimer);
    uiSaveTimer = setTimeout(() => {
      uiSaveTimer = null;
      storageSet(UI_KEY, { open: state.open, tab: state.tab, at: Date.now() });
    }, 250);
  }

  let saleAudioCtx = null;

  /** Applique le son global (partagé entre les onglets et +Duel). */
  function applySoundPrefs(raw) {
    if (!raw || typeof raw !== 'object') return;
    if (typeof raw.muted === 'boolean') state.sound.muted = raw.muted;
    if (Number.isFinite(Number(raw.volume))) {
      state.sound.volume = Math.max(0, Math.min(1, Number(raw.volume)));
    }
    syncSoundControls();
  }

  function syncSoundControls() {
    if (!ui?.soundBtn || !ui?.soundRange) return;
    ui.soundBtn.setAttribute('aria-pressed', state.sound.muted ? 'true' : 'false');
    ui.soundBtn.textContent = state.sound.muted ? '🔇' : '🔊';
    ui.soundBtn.title = state.sound.muted ? 'Activer le son' : 'Couper le son';
    ui.soundRange.value = String(Math.round(state.sound.volume * 100));
    ui.soundRange.disabled = state.sound.muted;
  }

  async function loadSoundPrefs() {
    applySoundPrefs(await storageGet(SOUND_KEY, null));
    try {
      ext.storage.onChanged.addListener((changes, area) => {
        if (area && area !== 'local') return;
        if (changes && changes[SOUND_KEY]) applySoundPrefs(changes[SOUND_KEY].newValue);
      });
    } catch {
      /* pas d'écoute : le son reste local à cet onglet */
    }
    syncSoundControls();
  }

  function persistSound() {
    storageSet(SOUND_KEY, { muted: state.sound.muted, volume: state.sound.volume });
  }

  /** Petit son discret de vente, coupé si le son global est muet. */
  function playSaleSound() {
    if (state.sound.muted || state.sound.volume <= 0) return;
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      if (!saleAudioCtx) saleAudioCtx = new Ctx();
      const ctx = saleAudioCtx;
      const t = ctx.currentTime;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(880, t);
      osc.frequency.exponentialRampToValueAtTime(1318.5, t + 0.09);
      const peak = Math.max(0.0001, 0.07 * state.sound.volume);
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(peak, t + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.24);
    } catch {
      /* audio indisponible */
    }
  }

  let salesSaveTimer = null;

  /** Barème réel des frais et de la taxe, lu dans `/api/config`. */
  function salesRates() {
    const cfg = getCfg();
    return { feePct: cfg.feePct, feeMin: cfg.feeMin, taxPct: cfg.taxPct };
  }

  /** Nettoie une vente relue du stockage (jamais de valeur inventée). */
  function salesSanitizeEntry(entry) {
    if (!entry || !Number.isFinite(Number(entry.at))) return null;
    if (!Number.isFinite(Number(entry.net))) return null;
    const gross = Math.max(0, Math.round(Number(entry.gross) || 0));
    const fees = Math.max(0, Math.round(Number(entry.fees) || 0));
    const tax = Math.max(0, Math.round(Number(entry.tax) || 0));
    return {
      id: String(entry.id ?? `sale:${entry.at}:${entry.name ?? ''}`),
      listingId: entry.listingId == null ? null : String(entry.listingId),
      at: Number(entry.at),
      source: entry.source === 'auto' ? 'auto' : 'manual',
      name: String(entry.name ?? ''),
      rarity: String(entry.rarity ?? ''),
      characterId: entry.characterId ?? null,
      accountId: entry.accountId ?? null,
      gross,
      fees,
      tax,
      net: Math.max(0, Math.round(Number(entry.net) || 0)),
      matched: Boolean(entry.matched)
    };
  }

  function salesSanitizeTrack(entry) {
    if (!entry || entry.id == null) return null;
    const price = Number(entry.price);
    return {
      id: String(entry.id),
      characterId: entry.characterId ?? null,
      name: String(entry.name ?? ''),
      rarity: String(entry.rarity ?? ''),
      type: entry.type === 'auction' ? 'auction' : 'fixed',
      price: Number.isFinite(price) && price > 0 ? price : null,
      bid: Number.isFinite(Number(entry.bid)) && Number(entry.bid) > 0 ? Number(entry.bid) : null,
      bids: Number.isFinite(Number(entry.bids)) && Number(entry.bids) > 0 ? Number(entry.bids) : null,
      accountId: entry.accountId ?? null,
      source: entry.source === 'auto' ? 'auto' : 'manual',
      createdAt: Number(entry.createdAt) || 0,
      endsAt: Number(entry.endsAt) || 0,
      lastSeenAt: Number(entry.lastSeenAt) || 0
    };
  }

  /**
   * Charge les ventes **confirmées** (v2) et les annonces encore en attente.
   * L'ancien journal v1 ne contenait que des mises en vente : seules celles
   * vendues immédiatement (`matched`) sont reprises, le reste est écarté pour
   * que d'anciennes annonces non vendues ne faussent pas la courbe.
   */
  async function loadSalesLog() {
    try {
      const saved = await storageGet(SALES_LEDGER_KEY, null);
      if (Array.isArray(saved)) {
        state.salesLog = saved.map(salesSanitizeEntry).filter(Boolean).slice(-SALES_MAX);
      } else {
        const legacy = await storageGet(SALES_KEY, []);
        const migrated = (Array.isArray(legacy) ? legacy : [])
          .filter((entry) => entry && entry.matched === true)
          .map((entry) => {
            const gross = Math.max(0, Math.round(Number(entry.price) || 0));
            const net = Math.max(0, Math.round(Number(entry.net) || 0));
            return salesSanitizeEntry({
              id: `legacy:${entry.at}:${entry.name ?? ''}`,
              at: Number(entry.at),
              source: entry.source,
              name: entry.name,
              rarity: entry.rarity,
              gross,
              fees: Math.max(0, gross - net),
              tax: 0,
              net,
              matched: true
            });
          })
          .filter(Boolean);
        state.salesLog = migrated.slice(-SALES_MAX);
        if (migrated.length) storageSet(SALES_LEDGER_KEY, state.salesLog).catch(() => {});
      }

      const tracked = await storageGet(SALES_TRACK_KEY, []);
      state.salesTrack = (Array.isArray(tracked) ? tracked : [])
        .map(salesSanitizeTrack)
        .filter(Boolean)
        .slice(-SALES_TRACK_MAX);
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
      storageSet(SALES_LEDGER_KEY, state.salesLog.slice(-SALES_MAX)).catch(() => {});
      storageSet(SALES_TRACK_KEY, state.salesTrack.slice(-SALES_TRACK_MAX)).catch(() => {});
    }, 700);
  }

  /** Ajoute des ventes confirmées, sans jamais compter deux fois la même. */
  function recordConfirmedSales(entries) {
    const merged = salesMergeEntries(state.salesLog, entries);
    if (!merged.added.length) return [];
    state.salesLog = merged.log.slice(-SALES_MAX);
    if (merged.added.some((entry) => entry.matched)) playSaleSound();
    saveSalesSoon();
    render();
    return merged.added;
  }

  /** Mémorise une annonce créée par Kyareeh+ en attendant sa confirmation. */
  function trackPendingSale(row, posted, type, duration, source = 'auto') {
    const characterId = apiId(row?.characterId ?? row?.id);
    if (characterId == null || characterId === '') return;
    const id =
      posted?.listing?.id ?? posted?.id ?? posted?.listingId ?? `local-${Date.now()}-${state.salesTrack.length}`;
    if (state.salesTrack.some((entry) => String(entry.id) === String(id))) return;
    const now = Date.now();
    state.salesTrack.push({
      id: String(id),
      characterId,
      name: String(row?.name ?? ''),
      rarity: String(row?.rarity ?? ''),
      type: type === 'auction' ? 'auction' : 'fixed',
      price: Math.max(0, Math.round(Number(row?.price) || 0)) || null,
      bid: null,
      bids: null,
      accountId: state.user?.id ?? null,
      source: source === 'auto' ? 'auto' : 'manual',
      createdAt: now,
      endsAt: now + Math.max(1, Number(duration) || 12) * 3600000,
      lastSeenAt: 0
    });
    if (state.salesTrack.length > SALES_TRACK_MAX) {
      state.salesTrack.splice(0, state.salesTrack.length - SALES_TRACK_MAX);
    }
    saveSalesSoon();
  }

  /** Oublie une annonce retirée depuis Kyareeh+ : ce n'est pas une vente. */
  function untrackPendingSale(listingId, characterId = null) {
    const before = state.salesTrack.length;
    state.salesTrack = state.salesTrack.filter((entry) => {
      if (listingId != null && String(entry.id) === String(listingId)) return false;
      if (listingId == null || String(entry.id).startsWith('local-')) {
        if (characterId != null && String(entry.characterId) === String(characterId)) return false;
      }
      return true;
    });
    if (state.salesTrack.length !== before) saveSalesSoon();
  }

  /**
   * Confronte les annonces suivies au dernier `/api/me/market` : c'est le seul
   * signal de vente du site (aucun historique). À appeler après chaque lecture
   * d'annonces valide.
   */
  function reconcilePendingSales() {
    if (!state.salesLogLoaded) return [];
    if (!autoSellHasListings(state.mine)) return [];
    const result = salesTrackReconcile(state.salesTrack, autoSellListingRows(state.mine), Date.now(), {
      rates: salesRates(),
      graceMs: SALES_TRACK_GRACE_MS,
      accountId: state.user?.id ?? null
    });
    state.salesTrack = result.keep.slice(-SALES_TRACK_MAX);
    saveSalesSoon();
    // Une annonce revenue sans acheteur repart immédiatement si la vente auto
    // tourne ; une annulation volontaire est écartée par `autoSellRelistCheck`.
    autoSellQueueRelists(result.dropped);
    if (!result.sales.length) return [];
    const added = recordConfirmedSales(result.sales);
    if (added.length) {
      const profit = added.reduce((sum, entry) => sum + entry.net, 0);
      autoSellLog(
        `✓ ${fmt(added.length)} vente(s) confirmée(s) · profit ◆ ${fmt(profit)}`,
        'ok'
      );
    }
    return added;
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
    // Prix de référence du marché : le minimum entre une annonce fixe et un
    // achat immédiat d'enchère. Une mise courante n'est pas un prix de vente.
    const saleLows = [fixedLow, auctionBuyout].filter((value) => value != null && value > 0);
    const lowest = saleLows.length ? Math.min(...saleLows) : null;
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

    // 1) Vente rapide : **1 chakra sous** la vente la plus basse (prix fixe ou
    //    achat immédiat d'enchère) pour passer devant. Si le site refuse ce
    //    prix (« price_too_low »), la mise en vente se remet exactement au prix
    //    le plus bas (voir runSalePlan). Sans concurrence, on prend la médiane.
    let quickRaw;
    if (lowest != null && lowest > 0) {
      quickRaw = Math.max(1, lowest - 1);
    } else {
      quickRaw = base;
    }
    const quick = safe(quickRaw);

    // 2) Équilibrée : médiane ajustée de la tendance, bornée à ±10 %.
    //    Elle ne descend jamais sous la vente rapide (prix ordonnés).
    const adjust = clamp(trend / 100, -0.1, 0.1);
    let balancedRaw = base * (1 + adjust);
    if (lowest != null && lowest > 1) balancedRaw = Math.min(balancedRaw, Math.max(min, lowest));
    const balanced = Math.max(quick, safe(balancedRaw));

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
        reason:
          lowest != null
            ? `vente la plus basse ◆ ${fmt(lowest)} · 1 ◆ en dessous${
                quick < lowest ? '' : ' (plancher)'
              }`
            : `médiane ◆ ${fmt(base)} · aucune vente fixe/immédiate`
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

  /**
   * Annonces actives connues : celles du site, plus celles que Kyareeh+ vient
   * de créer et que `/api/me/market` n'a pas encore indexées. Une annonce
   * encore en attente de confirmation ne doit jamais être relancée.
   */
  function autoSellPendingListings() {
    const a = state.autoSell;
    const server = autoSellListingRows(state.mine);
    const serverQty = autoSellActiveQtyByKey(server);
    const ids = new Set();
    for (const listing of server) {
      for (const id of autoSellListingIds(listing)) ids.add(id);
    }
    return (Array.isArray(a.pendingListings) ? a.pendingListings : []).filter((listing) => {
      if (!listing || Date.now() - Number(listing.at || 0) > 20 * 60000) return false;
      if (autoSellListingIds(listing).some((id) => ids.has(id))) return false;
      // Même si le site renvoie un autre identifiant, le nombre d'annonces
      // actives de cette carte permet de reconnaître l'annonce déjà indexée.
      const baseline = Math.max(0, Number(listing.baseline) || 0);
      const current = autoSellActiveQtyFor(
        { characterId: listing.characterId, name: listing.character?.name },
        serverQty
      );
      if (current >= baseline + 1) return false;
      // L'annonce a disparu (vendue ou refusée) : on libère la réservation,
      // uniquement après une relecture serveur postérieure à sa création.
      const refreshedSince = Number(a.listingsAt) >= Number(listing.at || 0);
      if (refreshedSince && current < baseline && Date.now() - Number(listing.at || 0) > 60000) return false;
      return true;
    });
  }

  function autoSellListings() {
    return [...autoSellListingRows(state.mine), ...autoSellPendingListings()];
  }

  function autoSellActiveEntries() {
    return autoSellListings().filter((listing) => autoSellListingIsActive(listing));
  }

  function activeListings() {
    return autoSellActiveEntries().length;
  }

  /**
   * Emplacements d'annonce restants. Le site plafonne les annonces actives
   * (10 par défaut) ; chaque annonce active occupe une place, y compris celles
   * créées par Kyareeh+ pas encore visibles côté site.
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
    const gap = typeof options.gap === 'function' ? options.gap : () => gapMs;
    const log = typeof options.log === 'function' ? options.log : () => {};
    const shouldStop = typeof options.shouldStop === 'function' ? options.shouldStop : () => false;
    const source = options.source === 'auto' ? 'auto' : 'manual';
    const result = { created: 0, matched: 0, errors: 0, simulated: 0, stopped: null, posted: null };

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
          let salePrice = Math.max(1, Math.round(Number(row.price) || 1));
          let posted = null;
          // Vente rapide : le premier refus « prix trop bas » se règle en se
          // remettant exactement au prix le plus bas, avant toute majoration.
          let quickAligned = false;
          for (let attempt = 0; ; attempt += 1) {
            try {
              const buyout = saleType === 'auction' ? buyoutPriceFor(salePrice, buyoutPct) : null;
              posted = await api('/api/market/listings', {
                method: 'POST',
                timeout: 20000,
                body: {
                  characterId: row.characterId,
                  type: saleType,
                  price: salePrice,
                  buyoutPrice: buyout,
                  durationHours: duration
                }
              });
              break;
            } catch (err) {
              const code = String(err?.code || '');
              const message = String(err?.message || '');
              const tooLow = code === 'price_too_low' || /trop bas|too low|minimum/i.test(message);
              if (!tooLow || attempt >= 11) throw err;
              const floor = Math.max(1, Math.round(Number(row.floor) || recycleFloor(row.rarity) || 1));
              if (options.quick && !quickAligned) {
                const key = String(row.characterId ?? row.id ?? '');
                const lowest = Number(state.lowest[key] ?? state.fixedLow[key]);
                if (Number.isFinite(lowest) && lowest > 0) {
                  const aligned = Math.max(floor, Math.round(lowest));
                  quickAligned = true;
                  log(
                    `↻ ${row.name} · ◆ ${fmt(salePrice)} refusé (trop bas) · aligné sur le prix le plus bas ◆ ${fmt(aligned)}`,
                    'info'
                  );
                  salePrice = aligned;
                  continue;
                }
              }
              const minimum = message.match(/(?:minimum|min\.?)\s*:?\s*(\d+)/i);
              const nextPrice = Math.max(
                salePrice + 1,
                floor,
                minimum ? Number(minimum[1]) : Math.ceil(salePrice * 1.05)
              );
              log(`↻ ${row.name} · prix ◆ ${fmt(salePrice)} refusé (trop bas) · nouvel essai ◆ ${fmt(nextPrice)}`, 'info');
              salePrice = nextPrice;
            }
          }
          const label =
            saleType === 'auction' ? `enchère dès ◆ ${fmt(salePrice)}` : `prix fixe ◆ ${fmt(salePrice)}`;
          // Le plan reflète le prix réellement accepté (utile après un retry).
          row.price = salePrice;
          result.created += 1;
          result.posted = posted;
          if (posted?.matched) result.matched += 1;
          // Une mise en vente n'est pas une vente : on ne l'ajoute au graphique
          // que si elle est achetée immédiatement, sinon on la met sous
          // surveillance jusqu'à sa confirmation (ou son échéance).
          if (posted?.matched) {
            const profit = salesProfitOf(salePrice, salesRates());
            recordConfirmedSales([
              {
                id: `sale:${posted?.listing?.id ?? posted?.id ?? `${Date.now()}-${salePrice}`}`,
                listingId: posted?.listing?.id ?? posted?.id ?? null,
                at: Date.now(),
                name: row.name,
                rarity: row.rarity,
                characterId: apiId(row.characterId ?? row.id),
                accountId: state.user?.id ?? null,
                source,
                matched: true,
                ...profit
              }
            ]);
          } else {
            trackPendingSale(row, posted, saleType, duration, source);
          }
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

        await sleep(Math.max(0, Number(gap()) || 0));
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
      quick: sell.method === 'quick',
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
  /* Recyclage ciblé : préparation et exécution                          */
  /* ------------------------------------------------------------------ */

  function closeRecycleModal() {
    const rec = state.recycle;
    if (rec.running) return;
    rec.open = false;
    rec.plan = [];
    rec.done = false;
    rec.gained = 0;
    rec.planned = 0;
    rec.processed = 0;
    rec.log = [];
    render();
  }

  /** Ouvre l'aperçu de la sélection en cours (aucune requête, aucune action). */
  function prepareRecycle() {
    const plan = recyclePlan();
    if (!plan.length) {
      notify('Sélectionne au moins un exemplaire à recycler.');
      return;
    }
    const rec = state.recycle;
    rec.plan = plan;
    rec.open = true;
    rec.running = false;
    rec.done = false;
    rec.stop = false;
    rec.gained = 0;
    rec.processed = 0;
    rec.planned = plan.reduce((sum, row) => sum + row.qty, 0);
    rec.log = [];
    render();
  }

  /** Relit la collection et renvoie l'état réel de chaque carte, par identifiant. */
  async function recycleFreshCollection() {
    const data = await api('/api/me/collection?lean=1', { timeout: 25000 });
    const items = Array.isArray(data) ? data : Array.isArray(data?.items) ? data.items : null;
    if (!items) throw new ApiError(0, 'Collection illisible');
    const map = new Map();
    for (const item of items) {
      const rawId = item?.characterId ?? item?.id;
      if (rawId == null) continue;
      const id = String(rawId);
      const character = state.characters.get(id) ?? {};
      map.set(id, {
        id,
        rawId,
        qty: Math.max(0, Number(item.qty ?? item.quantity ?? 1) || 0),
        listable: item.listable == null ? null : Math.max(0, Number(item.listable) || 0),
        lockedQty: Math.max(0, Number(item.locked) || 0),
        pinned: Boolean(item.pinned),
        rarity: String(character.rarity ?? item.rarity ?? 'C').toUpperCase()
      });
    }
    return map;
  }

  /** Applique la ligne renvoyée par le site à la collection locale. */
  function applyRecycleEntry(entry) {
    if (!entry || typeof entry !== 'object') return;
    const rawId = entry.characterId ?? entry.id;
    if (rawId == null) return;
    const id = String(rawId);
    const index = state.collection.findIndex((item) => String(item?.characterId ?? item?.id) === id);
    if (index < 0) return;
    state.collection[index] = { ...state.collection[index], ...entry };
  }

  /**
   * Exécute le plan affiché. Le site ne fournit qu'un endpoint **par carte** :
   * les requêtes partent une par une, dans la file anti-rafale existante.
   * Une relecture de la collection précède toute destruction : si les
   * quantités ont changé, rien n'est recyclé.
   */
  async function executeRecycle() {
    const rec = state.recycle;
    if (!rec.open || rec.running || !rec.plan.length) return;

    rec.running = true;
    rec.stop = false;
    rec.done = false;
    rec.gained = 0;
    rec.processed = 0;
    rec.log = [];
    render();

    const log = (text, kind = 'info') => {
      rec.log.push({ text, kind });
      render();
    };

    let fresh;
    try {
      fresh = await recycleFreshCollection();
    } catch (err) {
      rec.running = false;
      rec.done = true;
      log(`✗ Relecture impossible : ${friendlyError(err)} — rien n'a été recyclé.`, 'err');
      render();
      return;
    }

    const changed = [];
    for (const row of rec.plan) {
      const live = fresh.get(String(row.id));
      const max = recycleSpareOf(live);
      if (!live || max < row.qty) changed.push(`${row.name} (${row.qty} → ${max})`);
    }
    if (changed.length) {
      rec.running = false;
      rec.done = true;
      log(
        `✗ Collection modifiée entre-temps : ${changed.slice(0, 3).join(', ')}${
          changed.length > 3 ? '…' : ''
        }. Rien n'a été recyclé, vérifie l'aperçu.`,
        'err'
      );
      render();
      await loadData({ keepPrices: true });
      return;
    }

    let gained = 0;
    let copies = 0;
    let stopped = null;
    let consecutiveErrors = 0;
    const gap = Math.max(350, Number(state.settings.gapMs) || 1200);

    for (const row of rec.plan) {
      if (rec.stop) {
        stopped = 'user';
        break;
      }
      try {
        const posted = await api(
          `/api/me/collection/${encodeURIComponent(String(row.characterId))}/recycle`,
          { method: 'POST', timeout: 20000, body: { qty: row.qty } }
        );
        const reward = Math.max(0, Math.round(Number(posted?.gained ?? row.total) || 0));
        gained += reward;
        copies += row.qty;
        rec.gained = gained;
        rec.processed += row.qty;
        if (posted?.user && typeof posted.user === 'object') {
          state.user = { ...state.user, ...posted.user };
        }
        applyRecycleEntry(posted?.entry);
        log(`✓ ${row.name} ×${fmt(row.qty)} · +◆ ${fmt(reward)}`, 'ok');
        consecutiveErrors = 0;
      } catch (err) {
        consecutiveErrors += 1;
        log(`✗ ${row.name} · ${friendlyError(err)}`, 'err');
        const status = Number(err?.status);
        if (status === 401 || status === 403 || status === 429) {
          stopped = 'auth';
          break;
        }
        if (consecutiveErrors >= 3) {
          stopped = 'errors';
          break;
        }
      }
      if (rec.stop) {
        stopped = 'user';
        break;
      }
      await sleep(gap);
    }

    rec.running = false;
    rec.done = true;
    if (stopped === 'user') log('Arrêt demandé.', 'info');
    else if (stopped === 'auth') log('Arrêt : session expirée ou limite API atteinte.', 'err');
    else if (stopped === 'errors') log('Arrêt après 3 erreurs consécutives.', 'err');
    log(`Terminé · ${fmt(copies)} exemplaire(s) recyclé(s) · +◆ ${fmt(gained)}.`, 'ok');

    // Les cartes sorties de la sélection ne peuvent plus être recyclées : on
    // repart d'une sélection propre et d'une collection relue.
    state.recycle.selection.clear();
    render();
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

  /**
   * Relit la collection **et** les ventes actives du site. Les annonces sont
   * obligatoires : sans elles, l'automatisation pourrait remettre en vente une
   * carte déjà engagée. L'appelant reçoit une erreur explicite dans ce cas.
   */
  async function autoSellRefresh() {
    const a = state.autoSell;
    let mine;
    try {
      // Volontairement séquentiel : deux requêtes suffisent, et elles ne
      // partent jamais en même temps qu'un POST de vente.
      const coll = await api('/api/me/collection?lean=1', { timeout: 25000 });
      mine = await api('/api/me/market', { timeout: 20000 });
      const list = Array.isArray(coll) ? coll : Array.isArray(coll?.items) ? coll.items : null;
      if (!list) throw new Error('Collection illisible');
      if (!autoSellHasListings(mine)) throw new Error('Ventes actives illisibles : /api/me/market ne renvoie aucune liste d’annonces.');
      state.collection = list;
      state.mine = mine;
      state.lastSync = Date.now();
      state.sellView.lastRefresh = Date.now();
      a.listingsAt = Date.now();
      a.listingsError = null;
      // Chaque relecture des annonces peut révéler une vente confirmée.
      reconcilePendingSales();
    } catch (err) {
      const message = friendlyError(err);
      a.listingsError = message;
      throw err instanceof Error ? err : new Error(message);
    }
  }

  function autoSellDuration() {
    const cfg = getCfg();
    return cfg.durations.includes(Number(state.settings.durationHours))
      ? Number(state.settings.durationHours)
      : cfg.durations[0] ?? 12;
  }

  /** Refresh de la vente auto : aléatoire entre les minutes réglées (7–10 min par défaut). */
  function autoSellRefreshDelayMs() {
    const rawMin = Number(state.settings.autoSellRefreshMinMin);
    const rawMax = Number(state.settings.autoSellRefreshMaxMin);
    if (!(rawMin > 0) || !(rawMax > 0)) return 0; // tests automatisés uniquement
    const min = Math.min(60, Math.max(1, rawMin));
    const max = Math.min(60, Math.max(min, rawMax));
    return (min + Math.random() * (max - min)) * 60000;
  }

  /** Délai anti-flag entre deux ventes : aléatoire dans la plage réglée. */
  function autoSellRandomDelayMs() {
    const rawMin = Number(state.settings.autoSellDelayMinSec);
    const rawMax = Number(state.settings.autoSellDelayMaxSec);
    // Valeur nulle : utilisé uniquement par les tests automatisés.
    if (!(rawMin > 0) || !(rawMax > 0)) return 0;
    const min = Math.min(300, Math.max(5, rawMin));
    const max = Math.min(300, Math.max(min, rawMax));
    return (min + Math.random() * (max - min)) * 1000;
  }

  /**
   * Remplissage : tant qu'il reste des places, on plafonne le délai à 8 s pour
   * atteindre les 10 annonces sans attendre la plage anti-flag complète.
   */
  function autoSellGapMs() {
    const base = autoSellRandomDelayMs();
    if (listingSlots().remaining > 0) return Math.min(base, 8000);
    return base;
  }

  /** Message lisible quand le tri ne peut pas être fait sans inventer un prix. */
  function autoSellSortError(withoutPrice, total) {
    return `Tri impossible : aucun prix de vente connu pour ${fmt(withoutPrice)} doublon(s) sur ${fmt(
      total
    )}. Ouvre le marché ou relance le calcul des prix avant de démarrer.`;
  }

  /**
   * Récupère les prix manquants en **un seul lot** via l'endpoint officiel, au
   * lieu d'un scan marché par carte. C'est ce qui évite la rafale de requêtes
   * qui faisait expulser le compte. En mode optimisé (`force`), les entrées déjà
   * connues mais périmées sont aussi relues : le volume 7 j doit être récent.
   */
  async function autoSellEnsurePrices(ids, { force = false } = {}) {
    const a = state.autoSell;
    const unique = [...new Set((Array.isArray(ids) ? ids : []).map(String).filter(Boolean))];
    const missing = force ? unique : unique.filter((id) => priceOf(id) == null);
    if (!missing.length) return;
    a.priceScanAt = Date.now();
    for (let offset = 0; offset < missing.length; offset += 500) {
      const chunk = missing.slice(offset, offset + 500);
      let array = null;
      try {
        const data = await api(`/api/me/collection/prices?ids=${chunk.join(',')}`, { timeout: 45000 });
        if (Array.isArray(data)) array = data;
        else if (Array.isArray(data?.prices)) array = data.prices;
      } catch {
        /* les prix déjà en cache restent utilisables */
      }
      if (array) {
        chunk.forEach((id, index) => mergePriceEntry(id, parsePriceEntry(array[index])));
      }
      if (offset + 500 < missing.length) await sleep(250);
    }
  }

  /**
   * Prépare un cycle sans rien poster : relit la collection et les ventes
   * actives, met à jour les prix manquants, puis classe les doublons selon le
   * tri actif. Avant chaque vente, l'appelant rappelle cette fonction : en mode
   * optimisé, le classement est donc recalculé à chaque annonce, avec des
   * volumes 7 j relus s'ils ont plus de AUTOSELL_VOLUME_TTL_MS.
   */
  async function autoSellPrepare({ refresh = true } = {}) {
    const a = state.autoSell;
    const s = state.settings;
    const scoreMode = s.autoSellOrder === 'score';
    if (refresh) {
      a.status = 'Lecture de la collection et des ventes actives…';
      render();
      await autoSellRefresh();
    }

    const slots = listingSlots();
    const activeQtyByKey = autoSellActiveQtyByKey(autoSellActiveEntries());
    const all = sellRows().map((row) => ({
      ...row,
      activeQty: autoSellActiveQtyFor(row, activeQtyByKey)
    }));
    const allDuplicates = all.filter((row) => row.qty > 1);
    const duplicates = allDuplicates.filter((row) => autoSellSpare(row, row.activeQty) > 0);
    const reserved = all.reduce(
      (sum, row) => sum + (row.qty > 1 ? Math.min(Number(row.activeQty) || 0, row.qty - 1) : 0),
      0
    );
    const options = {
      includeM: Boolean(s.autoSellIncludeM),
      order: s.autoSellOrder
    };
    const eligible = duplicates.filter((row) =>
      autoSellEligible(row, { ...options, requirePrice: false })
    );
    const duplicateIds = eligible.map((row) => String(row.id));
    const now = Date.now();
    // Mode optimisé : on relit aussi les entrées dont le volume 7 j a vieilli.
    const wantedPrices = scoreMode
      ? duplicateIds.filter((id) => {
          if (priceOf(id) == null) return true;
          const at = Number(state.prices[id]?.at);
          return !(at > 0) || now - at > AUTOSELL_VOLUME_TTL_MS;
        })
      : duplicateIds.filter((id) => priceOf(id) == null);
    if (wantedPrices.length && now - Number(a.priceScanAt || 0) > 60000) {
      a.status = scoreMode
        ? `Lecture des prix et ventes 7 j (${Math.min(500, wantedPrices.length)}/${wantedPrices.length})…`
        : `Lecture des prix (${Math.min(500, wantedPrices.length)}/${wantedPrices.length})…`;
      render();
      // Un seul appel groupé : plus de scan marché carte par carte au lancement.
      await autoSellEnsurePrices(wantedPrices, { force: scoreMode });
    }

    const priced = all.map((row) => ({
      ...row,
      ...autoSellMarketStats(row.id),
      characterId: apiId(row.rawId ?? row.id),
      price: autoSellPrice(row, s.autoSellStrategy),
      floor: recycleFloor(row.rarity)
    }));
    // Classement normal, puis réintégration en fin de file des cartes retirées
    // pour expiration (celles encore en délai anti-boucle sont écartées).
    const applied = autoSellApplyReturns(autoSellSelect(priced, { ...options, now: Date.now() }), a.expiry.returns, {
      now: Date.now()
    });
    const candidates = applied.rows;
    // Un classement complet est refait ici, donc avant chaque vente : c'est ce
    // qui garantit que l'ordre suit les dernières stats de marché.
    a.rankCount = Number(a.rankCount || 0) + 1;
    a.rankAt = Date.now();
    const withoutPrice = priced.filter(
      (row) =>
        autoSellEligible(row, { ...options, requirePrice: false }) &&
        !(Number(row.price) > 0)
    ).length;
    const plan = autoSellBuildPlan(candidates, { slots: slots.remaining });

    let error = null;
    let errorKind = null;
    if (!duplicates.length) {
      if (reserved > 0) {
        errorKind = 'active';
        error = `Les ${fmt(reserved)} exemplaire(s) en double sont déjà en vente.`;
      } else {
        errorKind = 'empty';
        error = 'Aucun doublon : la vente auto conserve toujours une copie de chaque carte.';
      }
    } else if (slots.remaining <= 0) {
      // File pleine : ce n'est pas une erreur, même si toutes les copies sont
      // déjà en vente. La boucle attend qu'une vente libère une place.
      errorKind = 'full';
    } else if (!candidates.length) {
      if (applied.heldBack > 0) {
        // Toutes les cartes disponibles viennent d'être retirées pour
        // expiration : elles restent en fin de file pendant le délai
        // anti-boucle, aucune n'est remise en vente aussitôt.
        errorKind = 'returning';
        error = `${fmt(applied.heldBack)} carte(s) retirée(s) pour expiration · remise en file après le délai anti-boucle.`;
      } else if (withoutPrice > 0) {
        errorKind = 'price';
        error = autoSellSortError(withoutPrice, Math.max(eligible.length, duplicates.length));
      } else {
        errorKind = 'empty';
        error = 'Aucun doublon éligible : vérifie les blocages de revente et les cartes mythiques.';
      }
    }

    return { slots, all, duplicates, eligible, reserved, candidates, plan, withoutPrice, error, errorKind };
  }

  /** Mémorise une annonce créée par Kyareeh+ tant que le site ne la renvoie pas. */
  function autoSellRememberListing(row, posted, type, duration, baseline = 0) {
    const a = state.autoSell;
    const characterId = apiId(row.characterId ?? row.id);
    if (characterId == null || characterId === '') return;
    const id = posted?.listing?.id ?? posted?.id ?? posted?.listingId ?? `local-${Date.now()}-${a.pendingListings.length}`;
    if (a.pendingListings.some((listing) => String(listing.id) === String(id))) return;
    a.pendingListings.push({
      id,
      characterId,
      character: {
        id: characterId,
        name: row.name,
        rarity: row.rarity,
        image: row.image
      },
      type,
      price: row.price,
      qty: 1,
      status: 'active',
      pending: true,
      // Quantité active avant ce POST : permet de reconnaître l'annonce côté
      // site même si l'API ne renvoie pas le même identifiant.
      baseline: Math.max(0, Number(baseline) || 0),
      at: Date.now(),
      endsAt: new Date(Date.now() + Math.max(1, Number(duration) || 12) * 3600000).toISOString()
    });
  }

  /**
   * Met en file les annonces revenues sans acheteur, pour une remise en vente
   * immédiate. Uniquement pendant la vente auto : hors session ou après un
   * arrêt demandé, rien n'est remis en ligne.
   */
  function autoSellQueueRelists(dropped) {
    const a = state.autoSell;
    if (!a || (!a.running && !a.starting) || a.stop) return [];
    for (const item of Array.isArray(dropped) ? dropped : []) {
      const listingId = String(item?.id ?? '');
      if (!listingId || a.relist.ids[listingId]) continue;
      if (item?.characterId == null || item.characterId === '') continue;
      a.relist.queue = autoSellRelistEnqueue(a.relist.queue, {
        listingId,
        characterId: String(item.characterId),
        name: String(item.name ?? ''),
        rarity: String(item.rarity ?? ''),
        type: String(item.type ?? 'fixed'),
        previousPrice: Number(item.price) > 0 ? Math.round(Number(item.price)) : null,
        endsAt: item.endsAt ?? null,
        reason: String(item.reason ?? 'expirée')
      });
    }
    return a.relist.queue;
  }

  /**
   * Remet en vente les cartes dont l'annonce est revenue sans acheteur, au prix
   * le plus bas autorisé (stratégie « Vente rapide », jamais sous la valeur de
   * recyclage). Une carte à la fois, jamais deux annonces en parallèle pour la
   * même carte. En cas d'échec, la carte reste dans l'inventaire et l'erreur
   * est affichée : rien n'est perdu.
   */
  async function autoSellProcessRelists() {
    const a = state.autoSell;
    const s = state.settings;
    const report = { created: 0, matched: 0, errors: 0, rows: [], skipped: 0 };
    if (!a.relist.queue.length) return report;

    const type = s.autoSellType === 'auction' ? 'auction' : 'fixed';
    const keep = [];
    for (const item of a.relist.queue.slice()) {
      if (!a.running || a.stop) {
        keep.push(item);
        continue;
      }
      const row = sellRows().find((r) => String(r.id) === item.characterId) ?? null;
      const activeQty = row
        ? autoSellActiveQtyFor(row, autoSellActiveQtyByKey(autoSellActiveEntries()))
        : 0;
      const check = autoSellRelistCheck({
        dropped: item,
        row,
        spare: row ? autoSellSpare(row, activeQty) : 0,
        slots: listingSlots().remaining,
        includeM: Boolean(s.autoSellIncludeM),
        lastAt: Number(a.relist.locks[item.characterId] || 0)
      });
      if (!check.ok) {
        if (check.permanent) {
          report.skipped += 1;
          autoSellLog(`↻ ${item.name || 'Carte'} · remise en vente impossible · ${check.reason}`, 'err');
        } else {
          keep.push(item);
        }
        continue;
      }

      const key = item.characterId;
      // Prix le plus bas réel de cette carte : un seul instantané marché.
      if (s.autoSellStrategy === 'quick' && !state.marketScanned.has(key)) {
        try {
          await ensureMarketData([key]);
        } catch {
          /* les prix déjà connus suffisent */
        }
      }
      const floor = recycleFloor(row.rarity);
      const prices = state.prices[key] ?? {};
      const hasTable = Number(AUTOSELL_RELIST_TABLE[String(row.rarity ?? '').toUpperCase()]) > 0;
      const price = autoSellRelistPrice({
        floor,
        rarity: row.rarity,
        table: AUTOSELL_RELIST_TABLE,
        lowest: Number(state.lowest[key] ?? state.fixedLow[key]),
        median: Number(prices.m7 ?? prices.m30),
        previous: item.previousPrice
      });
      const alreadyLowest = item.previousPrice != null && price === item.previousPrice;
      const single = {
        ...row,
        characterId: apiId(row.rawId ?? row.id),
        price,
        qty: 1,
        floor
      };

      const result = await runSalePlan([single], {
        type,
        duration: autoSellDuration(),
        buyoutPct: s.buyoutPct,
        quick: true,
        dryRun: Boolean(s.autoSellDryRun),
        gap: () => 0,
        source: 'auto',
        log: autoSellLog,
        shouldStop: () => !a.running || a.stop
      });

      if (result.created) {
        a.relist.locks[key] = Date.now();
        a.relist.ids[String(item.listingId)] = Date.now();
        a.relist.count += 1;
        a.relist.last = {
          name: single.name,
          price,
          at: Date.now(),
          previous: item.previousPrice
        };
        autoSellMarkRelisted(key, single.name, price);
        if (!result.matched) {
          autoSellRememberListing(single, result.posted, type, autoSellDuration(), activeQty);
        }
        report.created += 1;
        if (result.matched) report.matched += 1;
        report.rows.push(single);
        autoSellLog(
          `↻ ${single.name} · remise en vente auto · ◆ ${fmt(price)}${
            alreadyLowest
              ? ' · déjà au plancher, même prix'
              : hasTable
                ? ' · plancher du tableau 2'
                : ''
          }`,
          'ok'
        );
        continue;
      }

      if (result.simulated) {
        // Simulation : rien n'est posté, la demande ne revient pas en boucle.
        a.relist.ids[String(item.listingId)] = Date.now();
        report.rows.push(single);
        continue;
      }

      // Échec réel (API, prix refusé…) : la carte reste dans l'inventaire.
      a.relist.locks[key] = Date.now();
      item.attempts = Number(item.attempts || 0) + 1;
      report.errors += 1;
      if (item.attempts < AUTOSELL_RELIST_MAX_ATTEMPTS) {
        keep.push(item);
      } else {
        autoSellLog(
          `✗ ${single.name} · remise en vente impossible · la carte reste dans l’inventaire`,
          'err'
        );
      }
    }
    a.relist.queue = keep;
    return report;
  }

  /**
   * Un cycle : relit les données, puis vend **une annonce à la fois**. Après
   * chaque vente, la collection et les ventes actives sont relues et le
   * meilleur candidat est choisi à nouveau. `preview` ne poste rien.
   */
  async function autoSellCycle({ dryRun = false, preview = false, initialPrep = null } = {}) {
    const a = state.autoSell;
    const s = state.settings;
    const type = s.autoSellType === 'auction' ? 'auction' : 'fixed';

    let prep = initialPrep;
    if (!prep) {
      try {
        prep = await autoSellPrepare();
      } catch (err) {
        const message = friendlyError(err);
        a.lastError = message;
        a.status = message;
        a.preview = null;
        autoSellLog(message, 'err');
        return {
          plan: [],
          created: 0,
          matched: 0,
          errors: 0,
          simulated: 0,
          fatal: message,
          error: message,
          errorKind: 'listings'
        };
      }
    }

    // Retrait des annonces créées par la vente auto qui dépassent la durée
    // réglée : la carte revient dans l'inventaire et repart en fin de file,
    // jamais tout de suite. Le mode aperçu et la simulation ne retirent rien.
    let purged = { checked: 0, removed: 0, skipped: 0, errors: 0 };
    if (!preview && a.running && !a.stop) {
      purged = await autoSellPurgeExpired({ refresh: false });
      if (purged.removed) {
        try {
          prep = await autoSellPrepare({ refresh: false });
        } catch {
          /* le plan initial reste valable */
        }
      }
    }

    // Remise en vente des annonces revenues sans acheteur, avant tout nouveau
    // choix : la carte repart au prix le plus bas autorisé, jamais sous le
    // plancher de recyclage.
    let relisted = { created: 0, matched: 0, errors: 0, rows: [], skipped: 0 };
    if (!preview) {
      relisted = await autoSellProcessRelists();
      if (relisted.created && !prep.error) {
        try {
          prep = await autoSellPrepare({ refresh: false });
        } catch {
          /* le plan initial reste valable */
        }
      }
    }

    if (prep.error && !relisted.created) {
      a.lastError = prep.error;
      a.status = prep.error;
      a.preview = null;
      autoSellLog(prep.error, 'err');
      return {
        plan: [],
        created: 0,
        matched: 0,
        errors: 0,
        simulated: 0,
        fatal: prep.errorKind === 'price' || prep.errorKind === 'listings' ? prep.error : null,
        error: prep.error,
        errorKind: prep.errorKind
      };
    }

    if (prep.error) {
      // La remise en vente a réussi : ce n'est pas une erreur de la signaler.
      prep = { ...prep, error: null, errorKind: null, plan: [], candidates: [] };
    }

    if (preview) {
      a.preview = {
        at: Date.now(),
        plan: prep.plan,
        slots: prep.slots,
        candidates: prep.candidates.length,
        withoutPrice: prep.withoutPrice
      };
      a.status = `Aperçu · ${fmt(prep.plan.length)} annonce(s) prévue(s)`;
      autoSellLog(
        `${a.status}${prep.withoutPrice ? ` · ${fmt(prep.withoutPrice)} doublon(s) sans prix ignoré(s)` : ''}`,
        'info'
      );
      render();
      return { plan: prep.plan, created: 0, matched: 0, errors: 0, simulated: 0, fatal: null, preview: true };
    }

    if (dryRun) {
      a.status = `Simulation de ${fmt(prep.plan.length)} annonce(s)…`;
      render();
      const result = await runSalePlan(prep.plan, {
        type,
        duration: autoSellDuration(),
        buyoutPct: s.buyoutPct,
        dryRun: true,
        gap: autoSellGapMs,
        source: 'auto',
        log: autoSellLog,
        shouldStop: () => !a.running || a.stop
      });
      a.cycles += 1;
      a.created += result.created;
      a.matched += result.matched;
      a.errors += result.errors;
      a.lastPlan = prep.plan;
      a.preview = null;
      render();
      return { ...result, plan: prep.plan, fatal: null };
    }

    const totals = {
      created: relisted.created,
      matched: relisted.matched,
      errors: relisted.errors,
      simulated: 0
    };
    const plan = [...relisted.rows];
    let fatal = null;
    let needSync = false;
    let current = prep;
    while (a.running && !a.stop) {
      if (!current.candidates.length) break;
      if (current.slots.remaining <= 0) break;

      // Rechoisit la meilleure carte sur les données fraîches, pas sur le plan initial.
      const pick = current.candidates[0];
      const single = { ...pick, qty: 1 };
      a.lastPick = single;
      // En mode optimisé, on affiche les critères retenus : volume 7 j + score.
      const pickDetail =
        s.autoSellOrder === 'score'
          ? ` · ${autoSellVolumeLabel(single)} · score ${single.rank?.score ?? 0}/100`
          : '';
      a.status = `Meilleure carte · ${single.name} · ◆ ${fmt(single.price)}${pickDetail} · ${fmt(
        current.slots.remaining
      )} place(s) libre(s)`;
      render();

      // Vente rapide : on lit la vraie vente la plus basse (fixe ou achat
      // immédiat) de la carte choisie. Un seul instantané par carte, pas un
      // scan de tout l'inventaire.
      if (s.autoSellStrategy === 'quick') {
        const key = String(single.id);
        if (!state.marketScanned.has(key)) {
          a.status = `Lecture du prix le plus bas · ${single.name}…`;
          render();
          try {
            await ensureMarketData([key]);
          } catch {
            /* repli sur le prix conseillé déjà connu */
          }
        }
        const adjusted = autoSellPrice(single, 'quick');
        if (adjusted != null && adjusted !== single.price) {
          single.price = adjusted;
          a.lastPick = single;
          a.status = `Vente rapide · ${single.name} · ◆ ${fmt(single.price)}`;
          render();
        }
      }

      const result = await runSalePlan([single], {
        type,
        duration: autoSellDuration(),
        buyoutPct: s.buyoutPct,
        quick: s.autoSellStrategy === 'quick',
        dryRun: false,
        gap: autoSellGapMs,
        source: 'auto',
        log: autoSellLog,
        shouldStop: () => !a.running || a.stop
      });
      totals.created += result.created;
      totals.matched += result.matched;
      totals.errors += result.errors;

      if (result.created) {
        plan.push(single);
        // Carte resélectionnée : elle quitte la file de retour, son nouveau
        // délai repart de zéro (nouvelle annonce, nouvel horodatage).
        autoSellMarkRelisted(single.characterId ?? single.id, single.name, single.price);
        if (!result.matched) {
          // L'annonce est active immédiatement : on la bloque localement pour
          // ne pas la relancer avant que /api/me/market ne la renvoie.
          autoSellRememberListing(single, result.posted, type, autoSellDuration(), single.activeQty);
          needSync = true;
        }
      }

      if (result.stopped) break;
      if (!result.created) break;
      if (!a.running || a.stop) break;

      try {
        // Mise en vente simple : pas d'appel réseau, on continue avec l'état
        // local. Une vente réelle déclenche, elle, une relecture immédiate.
        current = await autoSellPrepare({ refresh: Boolean(result.matched) });
      } catch (err) {
        fatal = friendlyError(err);
        break;
      }
      if (result.matched) needSync = false;
      if (current.error) {
        if (current.errorKind === 'price' || current.errorKind === 'listings') {
          fatal = current.error;
        }
        break;
      }
    }

    // Une seule relecture en fin de cycle si des annonces non vendues ont été
    // créées : elles passeront de « confirmation » à l'état réel du site.
    if (!fatal && needSync && plan.length && !a.stop) {
      try {
        await autoSellRefresh();
        needSync = false;
      } catch (err) {
        fatal = `Ventes actives illisibles après le cycle : ${friendlyError(err)}`;
      }
    }

    a.cycles += 1;
    a.created += totals.created;
    a.matched += totals.matched;
    a.errors += totals.errors;
    a.lastPlan = plan;
    a.preview = null;

    const result = { ...totals, plan, fatal };
    if (fatal) return result;
    if (plan.length) {
      a.status = `Cycle ${a.cycles} · ${fmt(totals.created)} annonce(s) · ${fmt(
        totals.matched
      )} vente(s) immédiate(s)`;
    }
    render();
    return result;
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
    if (a.running || a.starting) return;
    a.starting = true;
    a.preview = null;
    a.priceScanAt = 0;
    a.status = 'Calcul de l’aperçu…';
    render();
    try {
      await autoSellCycle({ preview: true });
    } catch (err) {
      a.lastError = friendlyError(err);
      a.status = 'Aperçu impossible';
      autoSellLog(`Aperçu impossible · ${a.lastError}`, 'err');
    } finally {
      a.starting = false;
      render();
    }
  }

  /** Relit uniquement les ventes actives, pour le bouton Actualiser de la section. */
  async function autoSellRefreshListings() {
    const a = state.autoSell;
    if (a.refreshing || a.running || a.starting) return;
    a.refreshing = true;
    a.status = 'Actualisation des ventes actives…';
    render();
    try {
      await autoSellRefresh();
      a.status = `Ventes actives actualisées · ${fmt(activeListings())} en ligne`;
      a.lastError = null;
    } catch (err) {
      a.lastError = friendlyError(err);
      a.status = a.lastError;
      autoSellLog(a.lastError, 'err');
    } finally {
      a.refreshing = false;
      render();
    }
  }

  /* --- Retrait des annonces restées trop longtemps en vente --------------- */

  /** Un retrait en échec n'est pas retenté avant ce délai. */
  const AUTOSELL_EXPIRY_RETRY_MS = 5 * 60 * 1000;

  /** Retraits traités par vérification : évite une rafale de requêtes. */
  const AUTOSELL_EXPIRY_BATCH = 5;

  let expirySaveTimer = null;

  /** Écrit la file de retour et le journal des retraits (throttlé). */
  function saveExpirySoon() {
    if (expirySaveTimer) clearTimeout(expirySaveTimer);
    expirySaveTimer = setTimeout(() => {
      expirySaveTimer = null;
      const e = state.autoSell.expiry;
      storageSet(AUTOSELL_EXPIRY_KEY, {
        savedAt: Date.now(),
        returns: e.returns.slice(-AUTOSELL_EXPIRY_HISTORY_MAX),
        history: e.history.slice(-AUTOSELL_EXPIRY_HISTORY_MAX)
      }).catch(() => {});
    }, 700);
  }

  /** Recharge la file de retour et le journal après un rechargement de page. */
  async function loadExpiryJournal() {
    try {
      const saved = await storageGet(AUTOSELL_EXPIRY_KEY, null);
      if (!saved || typeof saved !== 'object') return;
      const e = state.autoSell.expiry;
      e.returns = autoSellExpiryReturnsSanitize(saved.returns);
      e.history = autoSellExpiryHistorySanitize(saved.history);
    } catch {
      /* journal illisible : on repart d'une file vide */
    }
  }

  /** Réglage effectif du retrait (valeur validée + seuil en millisecondes). */
  function autoSellExpirySettings() {
    const s = state.settings;
    const raw = autoSellExpireSettings({
      enabled: s.autoSellExpireEnabled,
      value: s.autoSellExpireValue,
      unit: s.autoSellExpireUnit
    });
    return { ...raw, maxAgeMs: autoSellExpireDelayMs(raw) };
  }

  /** Identifiants d'annonces écartés par un verrou de retrait encore valide. */
  function autoSellExpiryLocks(now = Date.now()) {
    const locks = state.autoSell.expiry.locks;
    const skip = new Set();
    for (const [id, at] of Object.entries(locks)) {
      if (now - Number(at) < AUTOSELL_EXPIRY_RETRY_MS) skip.add(String(id));
    }
    return skip;
  }

  /** Une annonce suivie atteint-elle le seuil de retrait ? (lecture locale) */
  function autoSellExpiryDueSoon(now = Date.now()) {
    const cfg = autoSellExpirySettings();
    if (!cfg.enabled || !state.autoSell.running || state.autoSell.stop) return false;
    if (state.settings.autoSellDryRun) return false;
    return (
      autoSellExpiredListings(autoSellListingRows(state.mine), {
        now,
        maxAgeMs: cfg.maxAgeMs,
        track: state.salesTrack,
        skipIds: autoSellExpiryLocks(now)
      }).length > 0
    );
  }

  /**
   * Relit les ventes actives et renvoie l'annonce demandée si elle est encore
   * active. C'est la vérification « état réel » faite juste avant un retrait :
   * une carte vendue entre-temps n'est jamais touchée.
   */
  async function autoSellFindActiveListing(listingId) {
    const mine = await api('/api/me/market', { timeout: 20000 });
    if (!autoSellHasListings(mine)) throw new Error('Ventes actives illisibles');
    state.mine = mine;
    state.autoSell.listingsAt = Date.now();
    reconcilePendingSales();
    const key = String(listingId);
    return autoSellListingRows(mine).find((listing) => autoSellListingIds(listing).includes(key)) ?? null;
  }

  /** Retire une annonce de l'état local (la carte, elle, n'est jamais supprimée). */
  function autoSellDropLocalListing(listingId) {
    const key = String(listingId);
    const rows = autoSellListingRows(state.mine).filter((listing) => !autoSellListingIds(listing).includes(key));
    if (Array.isArray(state.mine)) state.mine = rows;
    else if (state.mine && typeof state.mine === 'object') state.mine = { ...state.mine, listings: rows };
    state.autoSell.pendingListings = (state.autoSell.pendingListings ?? []).filter(
      (listing) => !autoSellListingIds(listing).includes(key)
    );
  }

  /**
   * Retire les annonces **créées par la vente auto** qui dépassent la durée
   * réglée, puis rend la carte au pool disponible en la classant en fin de file.
   *
   * Garde-fous :
   *  - une seule vérification à la fois (`expiry.purging`) et un verrou par
   *    annonce : jamais de double retrait ni de conflit entre deux contrôles ;
   *  - chaque candidat est relu sur le site juste avant le retrait ; une annonce
   *    vendue, terminée ou introuvable est laissée telle quelle ;
   *  - les annonces manuelles ne sont jamais touchées (origine inconnue = rien) ;
   *  - la carte et sa quantité restent dans la collection : seule l'annonce part.
   */
  async function autoSellPurgeExpired({ refresh = false } = {}) {
    const a = state.autoSell;
    const report = { checked: 0, removed: 0, recycled: 0, skipped: 0, errors: 0, disabled: false, simulated: false };
    const cfg = autoSellExpirySettings();
    if (!cfg.enabled) {
      report.disabled = true;
      return report;
    }
    if (!a.running || a.stop) return report;
    // Le mode simulation ne doit jamais retirer une annonce réelle.
    if (state.settings.autoSellDryRun) {
      report.simulated = true;
      return report;
    }
    if (a.expiry.purging) return a.expiry.purging;

    const task = (async () => {
      if (refresh) {
        try {
          const mine = await api('/api/me/market', { timeout: 20000 });
          if (!autoSellHasListings(mine)) throw new Error('Ventes actives illisibles');
          state.mine = mine;
          a.listingsAt = Date.now();
          reconcilePendingSales();
        } catch (err) {
          report.errors += 1;
          a.lastError = `Retrait automatique · ${friendlyError(err)}`;
          return report;
        }
      }

      const now = Date.now();
      const due = autoSellExpiredListings(autoSellListingRows(state.mine), {
        now,
        maxAgeMs: cfg.maxAgeMs,
        track: state.salesTrack,
        skipIds: autoSellExpiryLocks(now)
      });
      report.checked = due.length;
      a.expiry.lastAt = now;
      a.expiry.lastCheck = { at: now, checked: due.length, removed: 0, thresholdMs: cfg.maxAgeMs };
      if (!due.length) return report;

      // Recyclage automatique : une seule lecture de collection pour tout le
      // lot. Chaque retrait libère ses exemplaires dans cet instantané, pour
      // que deux annonces de la même carte ne se disputent pas la même quantité.
      let recycleOn = Boolean(state.settings.autoSellRecycleExpired);
      let collectionSnapshot = null;
      if (recycleOn) {
        try {
          const coll = await api('/api/me/collection?lean=1', { timeout: 25000 });
          const items = Array.isArray(coll) ? coll : Array.isArray(coll?.items) ? coll.items : null;
          if (!items) throw new Error('Collection illisible');
          collectionSnapshot = new Map();
          for (const entry of items) {
            const rawId = entry?.characterId ?? entry?.id;
            if (rawId == null) continue;
            const key = String(rawId);
            const character = state.characters.get(key) ?? {};
            collectionSnapshot.set(key, {
              qty: Math.max(0, Number(entry.qty ?? entry.quantity ?? 0) || 0),
              listable: entry.listable == null ? null : Math.max(0, Number(entry.listable) || 0),
              lockedQty: Math.max(0, Number(entry.locked) || 0),
              pinned: Boolean(entry.pinned),
              rarity: String(character.rarity ?? entry.rarity ?? 'C').toUpperCase()
            });
          }
        } catch (err) {
          recycleOn = false;
          a.lastError = `Recyclage automatique · ${friendlyError(err)}`;
          autoSellLog(
            `♻ Recyclage automatique indisponible (${friendlyError(err)}) · les cartes retirées repartent en fin de file`,
            'err'
          );
        }
      }

      for (const item of due.slice(0, AUTOSELL_EXPIRY_BATCH)) {
        if (!a.running || a.stop) break;
        try {
          // État réel : l'annonce doit toujours exister et être active.
          const fresh = await autoSellFindActiveListing(item.id);
          if (!fresh) {
            a.expiry.locks[item.id] = Date.now();
            report.skipped += 1;
            autoSellLog(`⏱ ${item.name || 'Carte'} · déjà terminée sur le site, retrait annulé`, 'info');
            continue;
          }
          const origin = autoSellOriginOf(fresh, state.salesTrack);
          const recheck = autoSellExpiryCheck(fresh, {
            now: Date.now(),
            maxAgeMs: cfg.maxAgeMs,
            auto: origin.auto,
            trackAt: origin.entry?.createdAt
          });
          if (!recheck.due) {
            a.expiry.locks[item.id] = Date.now();
            report.skipped += 1;
            if (recheck.reason === 'enchère avec offre') {
              autoSellLog(`⏱ ${item.name || 'Carte'} · retrait impossible, enchère déjà engagée`, 'err');
            }
            continue;
          }

          const canceled = await api(`/api/market/listings/${encodeURIComponent(item.id)}/cancel`, {
            method: 'POST',
            timeout: 20000
          });
          if (canceled && canceled.ok === false) throw new ApiError(0, 'Annonce introuvable ou déjà terminée.');

          // L'annonce seulement : la collection garde la carte et sa quantité.
          autoSellDropLocalListing(item.id);
          untrackPendingSale(item.id, item.characterId);
          const at = Date.now();
          const listingQty = Math.max(1, Math.floor(Number(autoSellListingQty(fresh ?? item)) || 1));

          // Le retrait vient de libérer les exemplaires de l'annonce : ils ne
          // sont plus « en vente » (`locked`) et redeviennent disponibles. Sans
          // cette mise à jour, un ancien `locked` ferait refuser le recyclage.
          const live = collectionSnapshot ? collectionSnapshot.get(String(item.characterId)) : null;
          if (live) {
            live.lockedQty = Math.max(0, live.lockedQty - listingQty);
            const free = live.listable == null ? live.qty : live.listable;
            live.listable = Math.min(live.qty, free + listingQty);
          }

          let outcome = 'return';
          let fallbackReason = '';
          let recycledQty = 0;
          let gained = 0;
          if (recycleOn) {
            const decision = recycleAfterExpiryDecision(live, {
              enabled: true,
              listingQty,
              includeM: Boolean(state.settings.autoSellIncludeM)
            });
            if (decision.recycle) {
              try {
                const posted = await api(
                  `/api/me/collection/${encodeURIComponent(String(item.characterId))}/recycle`,
                  { method: 'POST', timeout: 20000, body: { qty: decision.qty } }
                );
                if (posted && posted.ok === false) {
                  throw new ApiError(0, 'Recyclage refusé par le site');
                }
                recycledQty = decision.qty;
                gained = Math.max(
                  0,
                  Math.round(Number(posted?.gained ?? recycleOf(live.rarity) * recycledQty) || 0)
                );
                if (posted?.user && typeof posted.user === 'object') {
                  state.user = { ...state.user, ...posted.user };
                }
                if (posted?.entry) {
                  applyRecycleEntry(posted.entry);
                }
                if (posted?.entry?.qty == null) {
                  // Réponse sans quantité : on retire localement la quantité exacte.
                  const index = state.collection.findIndex(
                    (row) => String(row?.characterId ?? row?.id) === String(item.characterId)
                  );
                  if (index >= 0) {
                    const row = state.collection[index];
                    row.qty = Math.max(0, (Number(row.qty) || 0) - recycledQty);
                    if (row.listable != null) row.listable = Math.max(0, Number(row.listable) - recycledQty);
                  }
                }
                live.qty = Math.max(0, live.qty - recycledQty);
                live.listable = Math.max(0, (live.listable ?? 0) - recycledQty);
                a.expiry.returns = autoSellReturnClear(a.expiry.returns, item.characterId);
                outcome = 'recycle';
                report.recycled += 1;
              } catch (err) {
                // Repli : la carte repart en fin de file, avec le motif affiché.
                fallbackReason = friendlyError(err);
              }
            } else {
              fallbackReason = decision.reason;
            }
          } else if (!recycleOn && state.settings.autoSellRecycleExpired) {
            fallbackReason = 'collection indisponible';
          }

          if (outcome === 'return') {
            a.expiry.returns = autoSellReturnAdd(
              a.expiry.returns,
              {
                characterId: item.characterId,
                listingId: item.id,
                name: item.name,
                rarity: item.rarity,
                price: item.price,
                at,
                startedAt: recheck.startAt,
                ageMs: recheck.ageMs,
                thresholdMs: cfg.maxAgeMs
              },
              { now: at }
            );
          }
          a.expiry.history = [
            ...a.expiry.history,
            {
              kind: 'remove',
              at,
              listingId: item.id,
              characterId: item.characterId,
              name: item.name,
              rarity: item.rarity,
              price: item.price,
              ageMs: recheck.ageMs,
              thresholdMs: cfg.maxAgeMs,
              outcome,
              recycledQty,
              gained,
              reason: outcome === 'recycle' ? 'durée dépassée' : fallbackReason || 'durée dépassée'
            }
          ].slice(-AUTOSELL_EXPIRY_HISTORY_MAX);
          a.expiry.locks[item.id] = at;
          a.expiry.lastCheck.removed += 1;
          a.lastError = null;
          report.removed += 1;
          saveExpirySoon();
          if (outcome === 'recycle') {
            autoSellLog(
              `♻ ${item.name || 'Carte'} · retirée après ${autoSellExpireLabel(
                recheck.ageMs
              )} · recyclée ×${fmt(recycledQty)} · +◆ ${fmt(gained)}`,
              'ok'
            );
          } else if (fallbackReason) {
            autoSellLog(
              `⏱ ${item.name || 'Carte'} · retirée après ${autoSellExpireLabel(
                recheck.ageMs
              )} · renvoyée en fin de file · non recyclée : ${fallbackReason}`,
              'info'
            );
          } else {
            autoSellLog(
              `⏱ ${item.name || 'Carte'} · retirée après ${autoSellExpireLabel(recheck.ageMs)} (seuil ${autoSellExpireLabel(
                cfg.maxAgeMs
              )}) · carte rendue à l’inventaire, classée en fin de file`,
              'ok'
            );
          }
        } catch (err) {
          a.expiry.locks[item.id] = Date.now();
          report.errors += 1;
          const message = friendlyError(err);
          if (String(err?.code ?? '') === 'has_bids' || /enchère/i.test(message)) {
            autoSellLog(`⏱ ${item.name || 'Carte'} · retrait impossible, enchère déjà engagée`, 'err');
          } else {
            a.lastError = `Retrait automatique · ${item.name || 'Carte'} : ${message}`;
            autoSellLog(`⏱ ${item.name || 'Carte'} · retrait impossible · ${message}`, 'err');
          }
        }
      }
      return report;
    })();

    a.expiry.purging = task;
    try {
      return await task;
    } finally {
      if (a.expiry.purging === task) a.expiry.purging = null;
    }
  }

  /**
   * Une carte « retour après expiration » vient d'être resélectionnée : elle
   * quitte la file de fin et son nouveau délai repart de zéro (nouvelle
   * annonce, donc nouvel horodatage de mise en vente).
   */
  function autoSellMarkRelisted(characterId, name = '', price = null) {
    const a = state.autoSell;
    const key = String(characterId ?? '');
    if (!key) return;
    const entry = a.expiry.returns.find((item) => String(item.characterId) === key);
    if (!entry) return;
    a.expiry.returns = autoSellReturnClear(a.expiry.returns, key);
    a.expiry.history = [
      ...a.expiry.history,
      {
        kind: 'relist',
        at: Date.now(),
        listingId: null,
        characterId: key,
        name: name || entry.name,
        rarity: entry.rarity,
        price: price ?? entry.price,
        ageMs: 0,
        thresholdMs: entry.thresholdMs,
        reason: 'remise en vente après expiration'
      }
    ].slice(-AUTOSELL_EXPIRY_HISTORY_MAX);
    saveExpirySoon();
  }

  async function startAutoSell() {
    const a = state.autoSell;
    if (a.running || a.starting) return;
    if (!state.user) {
      notify('Connecte-toi à Kyara pour lancer la vente auto.');
      return;
    }
    if (state.sell) {
      notify('Ferme la fenêtre de vente manuelle avant de lancer la vente auto.');
      return;
    }

    const gen = ++a.gen;
    a.armed = false;
    a.starting = true;
    a.running = false;
    a.stop = false;
    a.status = 'Vérification des ventes actives et des prix…';
    a.lastError = null;
    a.preview = null;
    a.lastPlan = [];
    a.lastPick = null;
    a.initialPrep = null;
    a.priceScanAt = 0;
    a.log = [];
    // Nouvelle session : file de remise en vente repartie de zéro.
    a.relist = { queue: [], last: null, count: 0, locks: {}, ids: {} };
    // Verrous de retrait repartis de zéro ; la file des cartes retirées pour
    // expiration est conservée (elles restent classées en fin de file).
    a.expiry.purging = null;
    a.expiry.locks = {};
    render();

    let prep;
    try {
      prep = await autoSellPrepare();
    } catch (err) {
      prep = { error: friendlyError(err), errorKind: 'listings' };
    }

    // Arrêt demandé pendant la vérification : la génération a changé.
    if (!a.starting || a.gen !== gen) return;
    a.starting = false;

    if (prep.error) {
      a.running = false;
      a.stop = true;
      a.lastError = prep.error;
      a.status = prep.error;
      autoSellLog(`Démarrage impossible · ${prep.error}`, 'err');
      notify(prep.error);
      render();
      return;
    }

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
    // Le premier cycle réutilise la vérification déjà faite : pas de rafale
    // collection + ventes actives juste après le démarrage.
    a.initialPrep = prep;
    autoSellLog('Vente auto démarrée · doublons uniquement, dernière copie conservée');
    persistSettings();
    render();
    autoSellLoop().catch((err) => {
      a.running = false;
      a.stop = true;
      a.starting = false;
      a.lastError = friendlyError(err);
      a.status = 'Erreur inattendue';
      autoSellLog(`Erreur inattendue · ${a.lastError}`, 'err');
      render();
    });
  }

  function stopAutoSell(reason = 'Vente auto arrêtée') {
    const a = state.autoSell;
    if (!a.running && !a.armed && !a.starting) return;
    a.armed = false;
    a.starting = false;
    a.running = false;
    a.stop = true;
    a.gen += 1;
    a.nextAt = 0;
    a.initialPrep = null;
    // Arrêt demandé : aucune remise en vente ne doit partir après ce point.
    a.relist.queue = [];
    a.relist.ids = {};
    a.relist.locks = {};
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

  /**
   * Une annonce suivie arrive-t-elle à échéance ? La boucle relit alors les
   * ventes actives sans attendre le refresh complet, pour remettre la carte en
   * vente tout de suite.
   */
  function autoSellExpirySoon(now = Date.now(), windowMs = 90000) {
    return state.salesTrack.some((entry) => {
      const ends = Number(entry?.endsAt) || 0;
      return ends > 0 && ends <= now + Math.max(0, Number(windowMs) || 0);
    });
  }

  /** Vérifie une place libre sans relire toute la collection (une requête). */
  async function autoSellCheckFreeSlot() {
    const a = state.autoSell;
    try {
      const mine = await api('/api/me/market', { timeout: 20000 });
      if (!autoSellHasListings(mine)) return false;
      state.mine = mine;
      a.listingsAt = Date.now();
      a.listingsError = null;
      reconcilePendingSales();
      render();
      return listingSlots().remaining > 0;
    } catch {
      return false;
    }
  }

  async function autoSellLoop() {
    const a = state.autoSell;
    const gen = ++a.gen;
    const alive = () => a.running && !a.stop && a.gen === gen;
    let firstPrep = a.initialPrep;
    a.initialPrep = null;
    while (alive()) {
      a.beatAt = Date.now();
      if (state.sell) {
        firstPrep = null;
        a.status = 'Vente manuelle ouverte · attente';
        a.nextAt = Date.now() + 15000;
        render();
        await autoSellWait(15000, alive);
        continue;
      }

      let result;
      try {
        result = await autoSellCycle({
          dryRun: Boolean(state.settings.autoSellDryRun),
          initialPrep: firstPrep
        });
        firstPrep = null;
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

      const full = listingSlots().remaining <= 0;
      const baseWait = autoSellRefreshDelayMs();
      // Tant qu'il reste des places et qu'on vient de vendre, on retente plus
      // vite pour remplir les 10. Une fois plein, on garde le refresh long mais
      // on surveille une vente toutes les 30 s pour remettre une annonce vite.
      const pause =
        baseWait > 0
          ? full
            ? baseWait
            : result.plan.length
              ? Math.min(baseWait, 60000)
              : baseWait
          : result.plan.length
            ? 250
            : 2000;
      a.nextAt = Date.now() + pause;
      const slotState = listingSlots();
      a.status = result.error
        ? result.error
        : full
          ? `File pleine (${fmt(slotState.active)}/${fmt(slotState.max)}) · attente d’une vente`
          : result.plan.length
            ? `Cycle ${a.cycles} · ${fmt(a.created)} annonce(s) · ${fmt(a.matched)} vente(s) immédiate(s)`
            : state.settings.autoSellDryRun
              ? 'Simulation · aucun doublon vendable'
              : 'Aucun doublon vendable · attente';
      render();
      let elapsed = 0;
      while (alive() && elapsed < pause) {
        // File pleine : on surveille une vente toutes les 5 s pour remettre
        // immédiatement une annonce dès qu'une place se libère. Sinon, une
        // annonce proche de son échéance est surveillée toutes les 15 s.
        const soon = autoSellExpirySoon();
        const watch = full ? 5000 : soon ? 15000 : 30000;
        const chunk = Math.min(watch, pause - elapsed);
        await autoSellWait(chunk, alive);
        elapsed += chunk;
        if (!alive() || elapsed >= pause) break;
        // Une annonce créée par la vente auto dépasse la durée réglée : elle est
        // retirée sans attendre le prochain cycle complet, et la carte revient
        // dans l'inventaire, classée en fin de file.
        if (autoSellExpiryDueSoon()) {
          const purged = await autoSellPurgeExpired({ refresh: true });
          if (purged.removed) {
            a.nextAt = 0;
            a.status = `Retrait auto · ${fmt(purged.removed)} annonce(s) trop ancienne(s) · carte(s) de retour en fin de file`;
            render();
            break;
          }
        }
        if (full && (await autoSellCheckFreeSlot())) {
          a.nextAt = 0;
          a.status = 'Place libre · reprise du remplissage';
          render();
          break;
        }
        if (!full && autoSellExpirySoon() && (await autoSellCheckFreeSlot())) {
          a.nextAt = 0;
          a.status = 'Annonce arrivée à échéance · remise en vente';
          render();
          break;
        }
      }
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
    // L'aperçu de recyclage ne doit jamais masquer un autre onglet : hors action,
    // changer d'onglet le referme.
    if (state.tab !== 'recycle' && state.recycle.open && !state.recycle.running) {
      state.recycle.open = false;
      state.recycle.plan = [];
      state.recycle.done = false;
    }
    syncSoundControls();
    ui.panel.hidden = !state.open;
    // Les onglets denses (Vente, Recyclage, Stat) gardent un peu plus de largeur.
    ui.panel.classList.toggle('is-wide', state.tab === 'sell' || state.tab === 'recycle' || state.tab === 'stat');
    // +Duel : l'application occupe toute la hauteur (pas de stats ni d'onglets au-dessus).
    ui.panel.classList.toggle('is-duel', duelState().mode === 'duel');
    ui.fab.classList.toggle('is-open', state.open);
    ui.panel.classList.toggle('is-away', Boolean(state.panelAway));
    if (!state.open) {
      renderModal();
      return;
    }
    if (state.panelAway) {
      // Le panneau tourne dans la fenêtre détachée : ici, seulement la carte « Afficher / Rattacher ».
      renderModes();
      renderAway();
      renderFooter();
      renderModal();
      return;
    }
    if (ui.away && !ui.away.hidden) ui.away.hidden = true;

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

  function renderAway() {
    if (!ui?.away) return;
    ui.view.hidden = true;
    ui.slot.hidden = true;
    ui.away.hidden = false;
    if (!ui.away.firstElementChild) ui.away.innerHTML = awayCardHtml();
  }

  function renderBanner() {
    if (!ui?.banner) return;

    // 0) Fenêtre détachée sans onglet kyara.games exploitable : les données ne peuvent plus
    //    être relues (celles déjà chargées restent affichées).
    if (IS_PANEL && state.error && RELAY_CODES.includes(state.errorCode)) {
      ui.banner.hidden = false;
      ui.banner.classList.add('is-stale');
      ui.banner.innerHTML = `
        <span class="kp-banner-text">${esc(state.error)}</span>
        <button class="kp-btn is-primary" type="button" data-act="open-site">Ouvrir kyara.games</button>
      `;
      return;
    }

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
  /* +Duel : application autonome intégrée (iframe)                      */
  /* ------------------------------------------------------------------ */
  // Le duel vit dans `duel/duel.html` (docs/DUEL-V2.md §3). Ici : le mode +Duel affiche cette
  // page dans une <iframe> (ressource web_accessible_resources sur le site ; page d'extension
  // dans la fenêtre détachée) et publie le profil du joueur (pseudo + cartes possédées) dans
  // storage.local, la page du duel n'ayant pas la session kyara.games. Le « Détacher » est celui
  // du panneau complet (voir « Fenêtre détachée » plus bas) : il n'y en a qu'un.

  const DUEL_PROFILE_KEY = 'kyareeh.duel.profile';
  const DUEL_PROFILE_REFRESH_MS = 5 * 60 * 1000;
  const DUEL_FRAME_TIMEOUT_MS = 6000;

  let duelProfileSig = '';
  let duelProfileAt = 0;
  let duelHostEl = null;
  let duelFrameEl = null;
  let duelFrameTimer = null;

  function duelState() {
    if (!state.__duel) {
      state.__duel = { mode: 'tools', frameReady: false, frameFailed: false };
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

  /* ------------------------------------------------------------------ */
  /* Fenêtre détachée : le panneau complet (+Tools et +Duel) à part       */
  /* ------------------------------------------------------------------ */
  // Le script de fond tient le registre de la fenêtre (une seule, clé PANEL_WINDOW_KEY). Tant
  // qu'elle existe, la page affiche une carte « ouvert dans une fenêtre » et laisse à la fenêtre
  // les boucles (Auto-Open, vente auto, relectures) ; l'anti-AFK, qui lit le DOM du site,
  // reste dans l'onglet. À la fermeture de la fenêtre, la page reprend tout.

  function bgSend(message) {
    try {
      const ask = Promise.resolve(ext.runtime.sendMessage(message)).catch(() => null);
      return Promise.race([ask, new Promise((resolve) => setTimeout(() => resolve(null), 4000))]);
    } catch {
      return Promise.resolve(null);
    }
  }

  /** Reprend ce que la fenêtre a écrit dans le stockage pendant qu'elle avait la main. */
  async function panelResync() {
    try {
      const saved = await storageGet(SETTINGS_KEY, null);
      if (saved && typeof saved === 'object') Object.assign(state.settings, saved);
      const cached = await storageGet(PRICE_KEY, null);
      const prices = cached && typeof cached === 'object' ? cached.prices ?? cached : null;
      if (prices && typeof prices === 'object') {
        for (const [id, entry] of Object.entries(prices)) {
          const mine = state.prices[id];
          if (entry && typeof entry === 'object' && (!mine || Number(entry.at || 0) > Number(mine.at || 0))) {
            state.prices[id] = entry;
          }
        }
      }
      await loadSalesLog();
      await loadAutoLog();
      startAutoRefreshLoop();
    } catch {
      /* on garde l'état en mémoire */
    }
    render();
  }

  /** La fenêtre existe-t-elle ? (côté page uniquement : la fenêtre, elle, ne s'efface pas.) */
  function panelApplyWindow(value) {
    if (IS_PANEL) return;
    const away = Boolean(value && typeof value === 'object' && value.id != null);
    if (away === Boolean(state.panelAway)) return;
    state.panelAway = away;
    if (away) {
      // Une seule application de duel vivante : celle de la fenêtre.
      destroyDuelFrame();
      render();
      return;
    }
    render();
    panelResync().then(() => {
      resumeAutoOpenIfNeeded();
      refreshLight();
    });
  }

  async function loadPanelWindowState() {
    if (IS_PANEL) return;
    // Le fond vérifie que la fenêtre existe encore : la clé survit à un crash ou à un redémarrage.
    const res = await bgSend({ type: 'kp-panel-state' });
    state.panelAway = Boolean(res && res.ok && res.detached);
    try {
      ext.storage.onChanged.addListener((changes, area) => {
        if (area && area !== 'local') return;
        if (changes && changes[PANEL_WINDOW_KEY]) panelApplyWindow(changes[PANEL_WINDOW_KEY].newValue);
      });
    } catch {
      /* pas d'écoute possible : l'état est relu à chaque chargement de page */
    }
  }

  /** La fenêtre détachée peut être agrandie/maximisée : on grossit tout le
   * panneau proportionnellement (polices comprises) via `zoom`, en compensant
   * la largeur/hauteur pour qu'il remplisse exactement la fenêtre. */
  function applyPanelWindowScale() {
    if (!IS_PANEL || !ui?.panel) return;
    if (!globalThis.CSS || typeof CSS.supports !== 'function' || !CSS.supports('zoom', '1.2')) return;
    const scale = Math.max(
      1,
      Math.min(1.6, Math.min(window.innerWidth / 1100, window.innerHeight / 720))
    );
    ui.panel.style.zoom = String(scale);
    ui.panel.style.width = `${window.innerWidth / scale}px`;
    ui.panel.style.height = `${window.innerHeight / scale}px`;
  }

  /** Détacher (ou remettre au premier plan la fenêtre déjà ouverte). */
  async function panelDetach() {
    if (IS_PANEL) return;
    if (!state.panelAway && (state.autoOpen.running || state.autoSell?.running)) {
      notify('Arrête d’abord Auto-Open et la vente auto : une seule instance doit les faire tourner.');
      return;
    }
    const res = await bgSend({ type: 'kp-panel-detach' });
    if (!res || !res.ok) {
      notify('Impossible d’ouvrir la fenêtre Kyareeh+.');
      return;
    }
    panelApplyWindow({ id: res.id });
  }

  /** Rattacher : ferme la fenêtre ; la page reprend le panneau. */
  async function panelAttach() {
    const res = await bgSend({ type: 'kp-panel-attach' });
    if (IS_PANEL) {
      if (res && res.ok) return; // le fond ferme cette fenêtre
      try {
        const win = await ext.windows.getCurrent();
        await ext.windows.remove(win.id);
        return;
      } catch {
        /* repli : fermeture directe */
      }
      try {
        window.close();
      } catch {
        /* ignore */
      }
      return;
    }
    panelApplyWindow(null);
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
        <span>La page peut bloquer l’affichage dans le panneau. Recharge-le, ou rafraîchis la page.</span>
        <button class="kp-btn is-primary" type="button" data-act="duel-retry">Recharger le duel</button>`;
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

  function awayCardHtml() {
    return `<div class="kp-away-card">
        <span class="kp-away-icon" aria-hidden="true">⧉</span>
        <b>Kyareeh+ est ouvert dans une fenêtre</b>
        <p>Le panneau complet (+Tools et +Duel) tourne dans sa propre fenêtre, avec ses boucles (Auto-Open, vente auto). L’anti-AFK reste actif ici, dans l’onglet.</p>
        <div class="kp-away-actions">
          <button class="kp-btn is-primary" type="button" data-act="panel-focus">Afficher</button>
          <button class="kp-btn" type="button" data-act="panel-attach">Rattacher</button>
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
    ui.modes.hidden = Boolean(state.panelAway);
    if (state.panelAway) {
      ui.modes.innerHTML = '';
      return;
    }
    const detach = IS_PANEL
      ? '<button class="kp-mode kp-detach" type="button" data-act="panel-attach" title="Fermer cette fenêtre : le panneau de la page reprend la main">⧉ Rattacher</button>'
      : '<button class="kp-mode kp-detach" type="button" data-act="panel-detach" title="Ouvrir Kyareeh+ (+Tools et +Duel) dans sa propre fenêtre">⧉ Détacher</button>';
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
      ['recycle', 'Recyclage'],
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
      if (!duelHostEl) {
        ui.slot.replaceChildren(duelHost());
      }
      return;
    }
    ui.view.hidden = false;
    ui.slot.hidden = true;
    const fn = {
      account: viewAccount,
      sell: viewSell,
      recycle: viewRecycle,
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
    if (RELAY_CODES.includes(state.errorCode)) {
      return `
      <div class="kp-empty">
        <b>${state.errorCode === 'no_kyara_tab' ? 'Aucun onglet kyara.games ouvert' : 'L’onglet kyara.games ne répond pas'}</b>
        ${esc(state.error || '')}<br>
        Cette fenêtre lit tes données par un onglet du site : elle réessaie toute seule.
        <div style="margin-top:14px">
          <button class="kp-btn is-primary" type="button" data-act="open-site">Ouvrir kyara.games</button>
          <button class="kp-btn" type="button" data-act="refresh">Réessayer</button>
        </div>
      </div>`;
    }
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

  /* ------------------------------------------------------------------ */
  /* Onglet Recyclage : doublons ciblés                                  */
  /* ------------------------------------------------------------------ */

  const RECYCLE_SORTS = [
    ['value_desc', 'Valeur de recyclage ↓'],
    ['qty_desc', 'Doublons ↓'],
    ['price_desc', 'Prix ↓'],
    ['sales_desc', 'Ventes 7 j ↓'],
    ['rarity_desc', 'Rareté ↓'],
    ['name_asc', 'Nom A→Z']
  ];

  /** Barème réel de recyclage par rareté (`/api/config` → `recycle`). */
  function recycleRates() {
    const rates = {};
    for (const code of RARITY_ORDER) rates[code] = recycleOf(code);
    return rates;
  }

  function recycleRows() {
    return sellRows().map((row) => {
      const spare = recycleSpareOf(row);
      return {
        ...row,
        spare,
        unit: recycleOf(row.rarity),
        blockReason: recycleBlockOf(row, { includeML: state.recycleView.includeML })
      };
    });
  }

  /** Cartes réellement sélectionnables (aucun blocage, au moins un exemplaire en trop). */
  function recycleSelectableRows(rows = recycleRows()) {
    return rows.filter((row) => !row.blockReason && row.spare > 0);
  }

  function recyclePlan() {
    return recycleBuildPlan(recycleSelectableRows(), state.recycle.selection, recycleRates());
  }

  /** Retire de la sélection les cartes devenues non recyclables (verrou, filtre). */
  function recyclePruneSelection() {
    const rows = new Map(recycleRows().map((row) => [String(row.id), row]));
    for (const [id, qty] of [...state.recycle.selection]) {
      const row = rows.get(String(id));
      if (!row || row.blockReason) {
        state.recycle.selection.delete(id);
        continue;
      }
      const next = Math.min(row.spare, Math.max(0, Math.floor(Number(qty) || 0)));
      if (next > 0) state.recycle.selection.set(id, next);
      else state.recycle.selection.delete(id);
    }
  }

  function recycleSeriesOptions() {
    const set = new Set();
    for (const row of sellRows()) if (row.series) set.add(row.series);
    return [...set].sort((a, b) => a.localeCompare(b, 'fr'));
  }

  function filteredRecycleRows(base = recycleRows()) {
    const view = state.recycleView;
    const query = view.query.trim().toLowerCase();
    let rows = base;
    if (view.onlyDupes) rows = rows.filter((row) => row.qty > 1);
    if (query) rows = rows.filter((row) => `${row.name} ${row.series}`.toLowerCase().includes(query));
    if (view.rarity !== 'all') rows = rows.filter((row) => String(row.rarity) === view.rarity);
    if (view.series !== 'all') rows = rows.filter((row) => String(row.series) === view.series);

    const rarityRank = (code) => RARITY_ORDER.indexOf(String(code || 'C').toUpperCase());
    const valueOf = (row) => row.unit * row.spare;
    const priceOfRow = (row) => (row.price == null ? -1 : row.price);
    const salesOf = (row) => toNum(state.prices[String(row.id)]?.sales7d) ?? -1;

    const comparators = {
      value_desc: (a, b) => valueOf(b) - valueOf(a) || b.qty - a.qty,
      qty_desc: (a, b) => b.qty - a.qty || valueOf(b) - valueOf(a),
      price_desc: (a, b) => priceOfRow(b) - priceOfRow(a) || valueOf(b) - valueOf(a),
      sales_desc: (a, b) => salesOf(b) - salesOf(a) || valueOf(b) - valueOf(a),
      rarity_desc: (a, b) => rarityRank(b.rarity) - rarityRank(a.rarity) || valueOf(b) - valueOf(a),
      name_asc: (a, b) => a.name.localeCompare(b.name, 'fr')
    };
    return rows.sort(comparators[view.sort] ?? comparators.value_desc);
  }

  function recycleRarityChips(counts) {
    const view = state.recycleView;
    return `<div class="kp-rarities ${view.rarity !== 'all' ? 'is-focus' : ''}">
      <button class="kp-rchip ${view.rarity === 'all' ? 'is-active' : ''}" type="button" data-act="recycle-rarity" data-rarity="all">Toutes ${counts.all ? `<em>${fmt(counts.all)}</em>` : ''}</button>
      ${RARITY_ORDER.map((code) => {
        const info = rarityInfo(code);
        const count = counts[code] ?? 0;
        return `<button class="kp-rchip ${view.rarity === code ? 'is-active' : ''}" type="button" data-act="recycle-rarity" data-rarity="${code}" style="--rc:${info.color}" ${count === 0 ? 'disabled' : ''}>
          ${esc(info.label)} ${count ? `<em>${fmt(count)}</em>` : ''}
        </button>`;
      }).join('')}
    </div>`;
  }

  /** Une ligne de l'onglet : carte, exemplaires en trop, quantité choisie. */
  function recycleRowHTML(row) {
    const checked = Number(state.recycle.selection.get(String(row.id)) || 0);
    const info = rarityInfo(row.rarity);
    const blocked = Boolean(row.blockReason);
    const unit = row.unit;
    const total = unit * checked;
    const price = row.price;
    return `
      <div class="kp-recycle-row ${checked ? 'is-selected' : ''} ${blocked ? 'is-locked' : ''}">
        <input type="checkbox" data-recycle-sel="${esc(row.id)}" ${checked ? 'checked' : ''} ${blocked ? 'disabled' : ''}
          aria-label="Recycler des exemplaires de ${esc(row.name)}" ${blocked ? `title="${esc(row.blockReason)}"` : ''}>
        <div class="kp-sell-thumb">
          <img src="${esc(row.image)}" alt="" loading="lazy">
          ${row.qty > 1 ? `<span class="kp-dupe-count" title="${fmt(row.qty)} exemplaires">×${fmt(row.qty)}</span>` : ''}
        </div>
        <div class="kp-sell-main">
          <div class="kp-row-name">
            ${esc(row.name)}
            ${row.qty > 1 ? '<span class="kp-dupe-tag">doublon</span>' : ''}
          </div>
          <div class="kp-row-meta">
            <span class="kp-rar" style="--rc:${info.color}">${esc(info.label)}</span>
            ${fmt(row.qty)} ex. · ${fmt(row.spare)} recyclable${row.spare > 1 ? 's' : ''}
            ${price != null ? ` · vente ◆ ${fmt(price)}` : ''}
          </div>
          ${blocked ? `<span class="kp-recycle-note">${esc(row.blockReason)}</span>` : ''}
        </div>
        <div class="kp-recycle-stepper" aria-label="Exemplaires à recycler">
          <button class="kp-step" type="button" data-act="recycle-dec" data-id="${esc(row.id)}" ${!checked ? 'disabled' : ''} aria-label="Un exemplaire de moins">−</button>
          <b>${checked || 0}<small>/${fmt(row.spare)}</small></b>
          <button class="kp-step" type="button" data-act="recycle-inc" data-id="${esc(row.id)}" ${blocked || checked >= row.spare ? 'disabled' : ''} aria-label="Un exemplaire de plus">+</button>
        </div>
        <div class="kp-recycle-gain">
          <b>${checked ? `◆ ${fmt(total)}` : unit ? `◆ ${fmt(unit)}` : '—'}</b>
          <small>${checked ? `${fmt(checked)} × ◆ ${fmt(unit)}` : unit ? 'par exemplaire' : 'barème inconnu'}</small>
        </div>
      </div>`;
  }

  function recycleBar() {
    const plan = recyclePlan();
    const totals = recycleTotals(plan);
    const disabled = !plan.length || state.recycle.running;
    return `
      <div class="kp-sellbar">
        <div class="kp-sellbar-info">
          <b>${totals.cards} carte(s) · ${totals.copies} exemplaire(s) · ≈ ◆ ${fmt(totals.chakra)}</b>
          <span>1 copie de chaque carte conservée · action définitive</span>
        </div>
        <div class="kp-sellbar-actions">
          <button class="kp-btn is-ghost" type="button" data-act="recycle-clear" ${totals.cards ? '' : 'disabled'}>Vider</button>
          <button class="kp-btn is-primary" type="button" data-act="recycle-start" ${disabled ? 'disabled' : ''}>Recycler</button>
        </div>
      </div>`;
  }

  function viewRecycle() {
    if (!state.user) return loginHTML();
    const view = state.recycleView;
    const all = recycleRows();
    const rows = filteredRecycleRows(all);
    const visible = rows.slice(0, view.limit);
    const selectable = recycleSelectableRows(all);
    const recyclableCopies = selectable.reduce((sum, row) => sum + row.spare, 0);

    // Prix de vente des premières lignes : même lecture que l'onglet Vente, par
    // petits lots, pour comparer « recycler » et « vendre » sans tout scanner.
    if (visible.length) loadMarketInfo(visible.slice(0, 12).map((row) => row.id), 12);

    const counts = { all: all.length };
    for (const row of all) counts[row.rarity] = (counts[row.rarity] ?? 0) + 1;

    if (!all.length) {
      return `<div class="kp-empty"><b>Collection vide</b>Le site n'a renvoyé aucune carte pour ce compte.</div>`;
    }

    return `
      <div class="kp-hint">
        Le site conserve <b>toujours 1 exemplaire</b> de chaque carte. Le recyclage ne porte que sur
        les exemplaires en trop : les cartes verrouillées et les exemplaires déjà engagés
        (annonce, échange) sont exclus. <b>Action définitive</b>, sans annulation possible.
      </div>
      <div class="kp-toolbar kp-toolbar-search">
        <input class="kp-input" type="search" data-role="recycle-search" autocomplete="off"
          placeholder="Filtrer les doublons…" value="${esc(view.query)}">
        <button class="kp-btn" type="button" data-act="recycle-refresh" ${state.loading ? 'disabled' : ''}>
          ${state.loading ? '<span class="kp-spinner"></span> Actualisation…' : 'Actualiser'}
        </button>
      </div>
      <div class="kp-filters">
        <label class="kp-filter">
          <span>Trier</span>
          <select class="kp-select" data-recycle-sort>
            ${RECYCLE_SORTS.map(
              ([value, label]) => `<option value="${value}" ${view.sort === value ? 'selected' : ''}>${label}</option>`
            ).join('')}
          </select>
        </label>
        <label class="kp-filter">
          <span>Série</span>
          <select class="kp-select" data-recycle-series>
            <option value="all">Toutes</option>
            ${recycleSeriesOptions()
              .map(
                (name) => `<option value="${esc(name)}" ${view.series === name ? 'selected' : ''}>${esc(name)}</option>`
              )
              .join('')}
          </select>
        </label>
      </div>
      <div class="kp-sell-toggles">
        <label class="kp-check">
          <input type="checkbox" data-recycle-only-dupes ${view.onlyDupes ? 'checked' : ''}>
          <span>Doublons <small>plus d'un exemplaire</small></span>
        </label>
        <label class="kp-check">
          <input type="checkbox" data-recycle-include-ml ${view.includeML ? 'checked' : ''}>
          <span>Inclure L et M <small>exclues par défaut</small></span>
        </label>
      </div>
      ${recycleRarityChips(counts)}
      <div class="kp-hint">
        ${rows.length === all.length ? `${fmt(all.length)} carte(s)` : `${fmt(rows.length)} / ${fmt(all.length)} carte(s)`}
        · ${fmt(selectable.length)} carte(s) recyclable(s) · ${fmt(recyclableCopies)} exemplaire(s) en trop
        · ◆ ${fmt(recycleOf('C'))} à ◆ ${fmt(recycleOf('M'))} selon la rareté
      </div>
      <div class="kp-recycle-list">${visible.map(recycleRowHTML).join('')}</div>
      ${
        rows.length > visible.length
          ? `<div class="kp-toolbar"><button class="kp-btn" type="button" data-act="recycle-more">Afficher plus (${fmt(rows.length - visible.length)})</button></div>`
          : ''
      }
      <div class="kp-toolbar">
        <button class="kp-btn" type="button" data-act="recycle-select-all" ${selectable.length ? '' : 'disabled'}>
          Tout sélectionner${rows.length !== all.length ? ' (filtré)' : ''}
        </button>
      </div>
      ${recycleBar()}`;
  }

  /**
   * Doublons disponibles, classés selon l'ordre actif. Les statistiques de
   * marché (volume 7 j + date de lecture) sont jointes avant le tri : c'est le
   * même jeu de données que celui utilisé par la vente auto.
   */
  function autoSellRankedCandidates() {
    const strategy = state.settings.autoSellStrategy;
    const activeQtyByKey = autoSellActiveQtyByKey(autoSellActiveEntries());
    const priced = sellRows().map((row) => ({
      ...row,
      activeQty: autoSellActiveQtyFor(row, activeQtyByKey),
      ...autoSellMarketStats(row.id),
      price: autoSellPrice(row, strategy),
      floor: recycleFloor(row.rarity)
    }));
    const ranked = autoSellSelect(priced, {
      includeM: Boolean(state.settings.autoSellIncludeM),
      order: state.settings.autoSellOrder,
      now: Date.now()
    });
    // Même règle que la boucle : les cartes retirées pour expiration passent en
    // fin de classement, et celles encore en délai anti-boucle sont écartées.
    return autoSellApplyReturns(ranked, state.autoSell.expiry.returns, { now: Date.now() }).rows;
  }

  /** Valeur totale des doublons **disponibles** selon la stratégie choisie. */
  function autoSellEstimate() {
    const candidates = autoSellRankedCandidates();
    let total = 0;
    let copies = 0;
    for (const row of candidates) {
      total += (Number(row.price) || 0) * row.autoQty;
      copies += row.autoQty;
    }
    return { total, copies, cards: candidates.length, candidates };
  }

  /** Libellé français du niveau de priorité d'une carte classée. */
  function autoSellPriorityLabel(row) {
    const status = row?.volume7Status;
    if (status === 'missing') return 'ventes 7 j inconnues';
    if (status === 'stale') return 'ventes 7 j périmées';
    const share = Number(row?.rank?.share) || 0;
    if (share >= 0.6) return 'forte demande';
    if (share >= 0.2) return 'demande moyenne';
    return 'faible demande';
  }

  /** « 83 ventes/7 j », « ventes 7 j — » ou « 83 ventes/7 j (périmé) ». */
  function autoSellVolumeLabel(row) {
    const status = row?.volume7Status;
    if (status === 'missing') return 'ventes 7 j —';
    const volume = Number(row?.volume7);
    if (!Number.isFinite(volume)) return 'ventes 7 j —';
    return `${fmt(volume)} vente(s)/7 j${status === 'stale' ? ' · périmé' : ''}`;
  }

  /** Date courte de la lecture marché, pour justifier un volume ignoré. */
  function autoSellVolumeDate(row) {
    const at = Number(row?.volume7At);
    if (!Number.isFinite(at) || at <= 0) return null;
    return new Date(at).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' });
  }

  function autoSellPanel(all, slots) {
    const a = state.autoSell;
    const s = state.settings;
    const expire = autoSellExpirySettings();
    const returned = a.expiry.returns.length;
    const lastRemoval =
      [...a.expiry.history].reverse().find((entry) => entry.kind === 'remove') ?? null;
    const estimate = autoSellEstimate();
    const scoreMode = s.autoSellOrder === 'score';
    const activeQtyByKey = autoSellActiveQtyByKey(autoSellActiveEntries());
    const rows = all.map((row) => ({
      ...row,
      activeQty: autoSellActiveQtyFor(row, activeQtyByKey)
    }));
    const options = {
      includeM: Boolean(s.autoSellIncludeM)
    };
    const strategyLabel =
      { quick: 'Vente rapide', balanced: 'Équilibrée', max: 'Prix maximal' }[s.autoSellStrategy] ?? 'Équilibrée';
    const dupes = rows.filter((row) => row.qty > 1).length;
    const spare = rows.reduce((sum, row) => sum + autoSellSpare(row, row.activeQty), 0);
    const eligibleSpare = rows.reduce(
      (sum, row) =>
        sum + (autoSellEligible(row, { ...options, requirePrice: false }) ? autoSellSpare(row, row.activeQty) : 0),
      0
    );
    const withoutPrice = rows.filter(
      (row) =>
        autoSellEligible(row, { ...options, requirePrice: false }) &&
        autoSellPrice(row, s.autoSellStrategy) == null
    ).length;
    const mSpare = rows
      .filter((row) => String(row.rarity || '').toUpperCase() === 'M')
      .reduce((sum, row) => sum + autoSellSpare(row, row.activeQty), 0);
    const stateLabel = a.starting
      ? 'vérification'
      : a.running
        ? 'en cours'
        : a.armed
          ? 'à confirmer'
          : 'arrêtée';
    const locked = a.running || a.starting;
    const log = a.log.slice(-8);
    // Mode optimisé : la carte qui partira au prochain tour, avec les chiffres
    // exacts qui ont servi au classement (volume 7 j, prix, score).
    const pick = scoreMode ? estimate.candidates[0] ?? null : null;
    const runnerUp = scoreMode ? estimate.candidates[1] ?? null : null;
    const pickWhy = (row) => {
      if (!row) return '';
      if (row.expiredReturn) {
        return 'Retour après expiration : classée après toutes les autres cartes, en fin de file.';
      }
      if (row.volume7Status === 'missing') {
        return 'Ventes 7 j inconnues : aucun bonus de demande, score plafonné à 30/100.';
      }
      if (row.volume7Status === 'stale') {
        const date = autoSellVolumeDate(row);
        return `Ventes 7 j lues le ${date ?? '—'} : trop anciennes, ignorées (score plafonné à 30/100).`;
      }
      const share = Number(row.rank?.share) || 0;
      const liquid = share >= 0.999 ? 'le plus liquide de la sélection' : `liquidité ${Math.round(share * 100)} % du meilleur`;
      return `Volume 7 j : ${fmt(row.volume7)} (${liquid}) · prix ◆ ${fmt(row.price)} · score ${row.rank?.score ?? 0}/100.`;
    };
    const scoreHint = scoreMode
      ? '<div class="kp-autosell-hint">Score 0–100 : 70 % ventes sur 7 j + 30 % prix, recalculé avant chaque vente · volume relu au plus toutes les 5 min.</div>'
      : '';
    return `
      <section class="kp-autosell ${a.running ? 'is-running' : ''} ${a.armed ? 'is-armed' : ''} ${
        a.starting ? 'is-starting' : ''
      }">
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
          <span><b>${fmt(eligibleSpare)}</b> éligible(s)</span>
          <span><b>${fmt(slots.active)}</b> vente(s) active(s)</span>
          <span><b>${fmt(slots.remaining)}</b> place(s) libre(s)</span>
        </div>
        ${
          a.relist.last
            ? `<div class="kp-autosell-relist">↻ Remise en vente auto · <b>${esc(
                a.relist.last.name
              )}</b> · ◆ ${fmt(a.relist.last.price)} · ${nowTime(a.relist.last.at)}${
                a.relist.count > 1 ? ` · ${fmt(a.relist.count)} au total` : ''
              }</div>`
            : ''
        }
        ${
          lastRemoval
            ? `<div class="kp-autosell-expire-note">⏱ Retrait auto · <b>${esc(
                lastRemoval.name || 'Carte'
              )}</b> · après ${esc(autoSellExpireLabel(lastRemoval.ageMs))} (seuil ${esc(
                autoSellExpireLabel(lastRemoval.thresholdMs)
              )}) · ${nowTime(lastRemoval.at)} · carte rendue à l’inventaire${
                returned ? ` · ${fmt(returned)} en fin de file` : ''
              }</div>`
            : ''
        }
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
            <select class="kp-select" data-autosell-type ${locked ? 'disabled' : ''}>
              <option value="fixed" ${s.autoSellType === 'fixed' ? 'selected' : ''}>Prix fixe</option>
              <option value="auction" ${s.autoSellType === 'auction' ? 'selected' : ''}>Enchère</option>
            </select>
          </label>
          <label>
            <span>Stratégie</span>
            <select class="kp-select" data-autosell-strategy ${locked ? 'disabled' : ''}>
              <option value="quick" ${s.autoSellStrategy === 'quick' ? 'selected' : ''}>Vente rapide</option>
              <option value="balanced" ${s.autoSellStrategy === 'balanced' ? 'selected' : ''}>Équilibrée</option>
              <option value="max" ${s.autoSellStrategy === 'max' ? 'selected' : ''}>Prix maximal</option>
            </select>
          </label>
          <label>
            <span>Ordre</span>
            <select class="kp-select" data-autosell-order ${locked ? 'disabled' : ''}>
              ${AUTOSELL_ORDERS.map(
                ([value, label]) =>
                  `<option value="${value}" ${s.autoSellOrder === value ? 'selected' : ''}>${label}</option>`
              ).join('')}
            </select>
          </label>
          <label>
            <span>Durée annonce</span>
            <select class="kp-select" data-autosell-duration ${locked ? 'disabled' : ''}>
              ${[12, 24, 48]
                .map(
                  (h) =>
                    `<option value="${h}" ${Number(s.durationHours) === h ? 'selected' : ''}>${h} h</option>`
                )
                .join('')}
            </select>
          </label>
        </div>
        <div class="kp-autosell-expire">
          <label class="kp-check">
            <input type="checkbox" data-autosell-expire ${s.autoSellExpireEnabled ? 'checked' : ''} ${locked ? 'disabled' : ''}>
            Retirer les annonces après
          </label>
          <input
            class="kp-input"
            type="number"
            min="1"
            max="${expire.unit === 'min' ? 43200 : 720}"
            step="1"
            value="${expire.value}"
            data-autosell-expire-value
            ${locked || !expire.enabled ? 'disabled' : ''}
          >
          <select class="kp-select" data-autosell-expire-unit ${locked || !expire.enabled ? 'disabled' : ''}>
            ${AUTOSELL_EXPIRE_UNIT_OPTIONS.map(
              ([value, label]) => `<option value="${value}" ${expire.unit === value ? 'selected' : ''}>${label}</option>`
            ).join('')}
          </select>
          <label class="kp-check kp-expiry-recycle">
            <input type="checkbox" data-autosell-recycle-expired ${s.autoSellRecycleExpired ? 'checked' : ''} ${locked ? 'disabled' : ''}>
            Recycler automatiquement les cartes retirées après expiration
          </label>
          <small class="kp-expiry-help">
            Décoché : la carte revient dans le <b>pool de vente</b>, classée en fin de file (comportement actuel).
            Coché : après le retrait, elle part au <b>recyclage</b> (1 exemplaire conservé, cartes verrouillées
            et Mythiques exclues) ; si le recyclage est refusé, elle revient en fin de file avec le motif.
          </small>
          <small>${
            expire.enabled
              ? `seuil ${autoSellExpireLabel(expire.maxAgeMs)} · ventes auto uniquement · ${
                  s.autoSellRecycleExpired
                    ? 'cartes expirées recyclées, repli en fin de file si refus'
                    : 'carte rendue à l’inventaire et classée en fin de file'
                }`
              : 'désactivé · aucune annonce n’est retirée pour ancienneté'
          }</small>
        </div>
        ${scoreHint}
        ${
          pick
            ? `<div class="kp-autosell-pick">
                 <div class="kp-pick-head">
                   <span>${a.running ? 'Carte en cours de sélection' : 'Prochaine carte'} · classement optimisé</span>
                   <span class="kp-pick-score">${pick.rank?.score ?? 0}<i>/100</i></span>
                 </div>
                 <div class="kp-pick-line">
                   <b>${esc(pick.name)}</b>
                   <span class="kp-pick-cell">◆ ${fmt(pick.price)}</span>
                   <span class="kp-pick-cell">${esc(autoSellVolumeLabel(pick))}</span>
                   <em class="kp-pick-tag ${pick.volume7Status === 'ok' && !pick.expiredReturn ? '' : 'is-warn'}">${esc(
                     pick.expiredReturn ? 'retour après expiration · fin de file' : autoSellPriorityLabel(pick)
                   )}</em>
                 </div>
                 <div class="kp-pick-why">${esc(pickWhy(pick))}</div>
                 ${
                   runnerUp
                     ? `<div class="kp-pick-next">Ensuite · ${esc(runnerUp.name)} · ◆ ${fmt(
                         runnerUp.price
                       )} · ${esc(autoSellVolumeLabel(runnerUp))} · score ${runnerUp.rank?.score ?? 0}/100</div>`
                     : ''
                 }
               </div>`
            : ''
        }
        <div class="kp-autosell-estimate">
          <span>Gain estimé · ${strategyLabel}</span>
          <b>◆ ${fmt(estimate.total)}</b>
          <small>${fmt(estimate.copies)} doublon(s) disponible(s) · ${fmt(estimate.cards)} carte(s)</small>
        </div>
        <div class="kp-autosell-opts">
          <label class="kp-check">
            <input type="checkbox" data-autosell-include-m ${s.autoSellIncludeM ? 'checked' : ''} ${locked ? 'disabled' : ''}>
            Inclure les Mythiques <em>${s.autoSellIncludeM ? '· dangereux' : '· exclues par défaut'}</em>
          </label>
          <label class="kp-check">
            <input type="checkbox" data-autosell-dryrun ${s.autoSellDryRun ? 'checked' : ''} ${locked ? 'disabled' : ''}>
            Simulation
          </label>
          <span class="kp-autosell-note">${fmt(withoutPrice)} sans prix · ${fmt(mSpare)} mythique(s)</span>
        </div>
        <div class="kp-autosell-actions">
          <button class="kp-btn" type="button" data-act="autosell-preview" ${locked ? 'disabled' : ''}>Aperçu</button>
          <button class="kp-btn is-primary" type="button" data-act="autosell-start" ${locked ? 'disabled' : ''}>
            ${a.starting ? 'Vérification…' : a.armed ? 'Confirmer le démarrage' : 'Démarrer'}
          </button>
          <button class="kp-btn" type="button" data-act="autosell-stop" ${a.running || a.starting ? '' : 'disabled'}>Arrêter</button>
          ${a.armed ? '<button class="kp-btn" type="button" data-act="autosell-cancel">Annuler</button>' : ''}
        </div>
        ${
          a.armed
            ? `<div class="kp-autosell-confirm">
                 <b>Confirmer la vente auto ?</b>
                 <span>${fmt(eligibleSpare)} exemplaire(s) disponible(s) · ◆ ${fmt(
                   estimate.total
                 )} estimés · ${slots.remaining} place(s) libre(s) · ${
                   s.autoSellIncludeM ? 'Mythiques incluses' : 'Mythiques exclues'
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
                           (row, index) =>
                             `<div><span>#${index + 1} ${esc(row.name)} × ${row.qty}</span>${
                               scoreMode
                                 ? `<span class="kp-preview-meta">${esc(autoSellVolumeLabel(row))} · score ${
                                     row.rank?.score ?? 0
                                   }</span>`
                                 : ''
                             }<b>◆ ${fmt(row.price)}</b></div>`
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

  /** Libellé d'état d'une annonce active (ou en attente de confirmation). */
  function autoSellListingLabel(listing) {
    if (listing?.pending) return 'Confirmation en cours';
    const status = autoSellListingStatus(listing);
    if (status === 'sold') return 'Vendue';
    if (status === 'expired') return 'Terminée';
    if (status === 'cancelled' || status === 'canceled') return 'Annulée';
    if (status === 'pending') return 'En attente';
    if (String(listing?.type || '').toLowerCase() === 'auction') return 'Enchère active';
    return 'En vente';
  }

  /**
   * Ventes actives : nom, quantité, prix unitaire et total, état. La liste est
   * relue au démarrage de l'auto-vente, après chaque vente et via Actualiser.
   */
  function listedCardsBlock() {
    const a = state.autoSell;
    const slots = listingSlots();
    const active = autoSellActiveEntries();
    if (!active.length) {
      return `<section class="kp-listed">
        <div class="kp-listed-head">
          <b>Ventes actives</b>
          <span>0 annonce · ${fmt(slots.active)}/${fmt(slots.max)} place(s) occupée(s)
            <button class="kp-listed-refresh" type="button" data-act="autosell-refresh-listings" ${
              a.refreshing || a.running || a.starting ? 'disabled' : ''
            }>${a.refreshing ? '…' : 'Actualiser'}</button>
          </span>
        </div>
        <div class="kp-listed-empty">${
          a.listingsError
            ? `Ventes actives illisibles : ${esc(a.listingsError)}`
            : 'Aucune vente active pour le moment.'
        }</div>
      </section>`;
    }
    return `<section class="kp-listed">
      <div class="kp-listed-head">
        <b>Ventes actives</b>
        <span>${fmt(active.length)} annonce(s) · ${fmt(slots.active)}/${fmt(slots.max)} place(s) occupée(s)
          <button class="kp-listed-refresh" type="button" data-act="autosell-refresh-listings" ${
            a.refreshing || a.running || a.starting ? 'disabled' : ''
          }>${a.refreshing ? '…' : 'Actualiser'}</button>
        </span>
      </div>
      <div class="kp-listed-grid">
        ${active
          .slice(0, 20)
          .map((listing) => {
            const card = listing.character ?? state.characters.get(String(listing.characterId)) ?? null;
            const info = rarityInfo(card?.rarity);
            const type = String(listing.type || '').toLowerCase() === 'auction' ? 'enchère' : 'prix fixe';
            const qty = autoSellListingQty(listing);
            const unit = autoSellListingPrice(listing);
            const total = autoSellListingTotal(listing, qty);
            const left = listingTimeLeft(listing);
            const id = String(listing.characterId ?? card?.id ?? '');
            const stateText = autoSellListingLabel(listing);
            const pending = Boolean(listing.pending);
            const relisted = Boolean(state.autoSell.relist.ids[String(listing.id)]);
            // Temps réellement écoulé depuis la mise en vente, et échéance du
            // retrait automatique — uniquement pour les annonces de la vente auto.
            const expire = autoSellExpirySettings();
            const origin = autoSellOriginOf(listing, state.salesTrack);
            const startedAt = autoSellListingStartAt(listing, { trackAt: origin.entry?.createdAt });
            const ageMs = startedAt == null ? null : Math.max(0, Date.now() - startedAt);
            const autoListing = origin.auto && !pending;
            const remainMs = expire.enabled && autoListing && ageMs != null ? expire.maxAgeMs - ageMs : null;
            const ageText = autoListing && ageMs != null ? `En vente depuis ${autoSellExpireLabel(ageMs)}` : '';
            const expireText =
              remainMs == null
                ? ''
                : remainMs <= 0
                  ? ' · retrait auto dépassé'
                  : ` · retrait auto dans ${autoSellExpireLabel(remainMs)}`;
            const dueSoon = remainMs != null && remainMs <= 0;
            return `<button class="kp-listed-card ${pending ? 'is-pending' : ''} ${
              dueSoon ? 'is-due' : ''
            }" type="button" style="--rc:${esc(info.color)}" data-act="sell-detail" data-id="${esc(
              id
            )}" data-hide-recommend="1" title="Voir l'étude de marché de cette carte${
              ageText ? ` — ${esc(ageText)}${esc(expireText)}` : ''
            }">
              <img src="${esc(imgSrc(card))}" alt="" loading="lazy">
              <span class="kp-listed-info">
                <b>${esc(card?.name ?? `Carte #${listing.characterId ?? '?'}`)}${
                  relisted
                    ? ' <i class="kp-listed-relist" title="Remise en vente automatique après expiration">↻</i>'
                    : ''
                }${autoListing ? ' <i class="kp-listed-auto" title="Annonce créée par la vente auto">auto</i>' : ''}</b>
                <small>${esc(info.label)} · ${type} · ×${fmt(qty)}${ageText ? ` · ${esc(ageText)}` : ''}</small>
                <em>◆ ${fmt(unit)}${
                  qty > 1 && total != null ? ` <i>· total ◆ ${fmt(total)}</i>` : ''
                }</em>
                <span class="kp-listed-state ${pending ? 'is-pending' : ''} ${dueSoon ? 'is-due' : ''}">${esc(
                  stateText
                )}${left ? ` · ${esc(left)}` : ''}${expireText ? esc(expireText) : ''}</span>
              </span>
            </button>`;
          })
          .join('')}
      </div>
    </section>`;
  }

  /**
   * Journal des retraits automatiques : heure, carte, motif, et file des cartes
   * « retour après expiration » classées en fin de sélection.
   */
  function autoSellExpiryBlock() {
    const a = state.autoSell;
    const cfg = autoSellExpirySettings();
    const history = a.expiry.history.slice(-6).reverse();
    const returned = a.expiry.returns;
    if (!cfg.enabled && !history.length && !returned.length) return '';
    const rows = history
      .map((entry) => {
        const relist = entry.kind === 'relist';
        if (relist) {
          const what = `remise en vente${entry.price ? ` · ◆ ${fmt(entry.price)}` : ''}`;
          return `<div class="kp-expiry-row is-relist">
            <span class="kp-expiry-time">${nowTime(entry.at)}</span>
            <b>${esc(entry.name || 'Carte')}</b>
            <span class="kp-expiry-what">${esc(what)}</span>
          </div>`;
        }
        const recycled = entry.outcome === 'recycle';
        const what = `retirée après ${autoSellExpireLabel(entry.ageMs)} (seuil ${autoSellExpireLabel(
          entry.thresholdMs
        )})${entry.price ? ` · annonce ◆ ${fmt(entry.price)}` : ''}`;
        const tag = recycled
          ? `<span class="kp-expiry-tag is-recycled">♻ recyclée${
              entry.recycledQty ? ` ×${fmt(entry.recycledQty)}` : ''
            }${entry.gained ? ` · +◆ ${fmt(entry.gained)}` : ''}</span>`
          : `<span class="kp-expiry-tag is-return">↩ fin de file${
              entry.reason && entry.reason !== 'durée dépassée' ? ` · ${esc(entry.reason)}` : ''
            }</span>`;
        return `<div class="kp-expiry-row is-remove">
          <span class="kp-expiry-time">${nowTime(entry.at)}</span>
          <b>${esc(entry.name || 'Carte')}</b>
          <span class="kp-expiry-what">${esc(what)}</span>
          ${tag}
        </div>`;
      })
      .join('');
    const queue = returned.length
      ? `<div class="kp-expiry-queue">${fmt(returned.length)} carte(s) en fin de file · ${returned
          .slice(-3)
          .reverse()
          .map((entry) => `${esc(entry.name || 'Carte')} (${nowTime(entry.at)})`)
          .join(' · ')}</div>`
      : '';
    return `<section class="kp-expiry">
      <div class="kp-expiry-head">
        <b>Retraits automatiques</b>
        <span>${
          cfg.enabled ? `seuil ${autoSellExpireLabel(cfg.maxAgeMs)}` : 'désactivé'
        }${cfg.enabled && state.settings.autoSellRecycleExpired ? ' · recyclage auto' : ''} · annonces de la vente auto uniquement</span>
      </div>
      ${
        rows
          ? `<div class="kp-expiry-list">${rows}</div>`
          : '<div class="kp-listed-empty">Aucun retrait automatique pour le moment.</div>'
      }
      ${queue}
    </section>`;
  }

  function salesChart() {
    const range = ['1d', '7d', 'total'].includes(state.settings.salesRange)
      ? state.settings.salesRange
      : '7d';
    const model = salesChartSeries(state.salesLog, Date.now(), range, {
      accountId: state.user?.id ?? null
    });
    const { points, net, count, matched, fees, tax, maxProfit } = model;
    const W = 720;
    const H = 230;
    const pad = { l: 70, r: 16, t: 18, b: 36 };
    // Échelle en chakra : le plus gros gain d'une seule heure fixe le plafond,
    // arrondi à 50 pour garder des repères lisibles.
    const yMax = Math.max(50, Math.ceil(Math.max(1, maxProfit) / 50) * 50);
    const plotW = W - pad.l - pad.r;
    const plotH = H - pad.t - pad.b;
    const x = (index) => pad.l + (index / Math.max(1, points.length - 1)) * plotW;
    const y = (value) => H - pad.b - (Math.max(0, Number(value) || 0) / yMax) * plotH;
    // Courbe du **bénéfice par heure** : chaque point est le gain de la tranche,
    // pas un cumul — la courbe monte quand une heure rapporte, redescend quand
    // l'heure suivante rapporte moins.
    const line = points
      .map(
        (point, index) =>
          `${index ? ' L' : 'M'}${x(index).toFixed(1)} ${y(point.profit).toFixed(1)}`
      )
      .join('');
    const area = points.length > 1
      ? `${line} L${x(points.length - 1).toFixed(1)} ${(H - pad.b).toFixed(1)} L${x(0).toFixed(1)} ${(
          H - pad.b
        ).toFixed(1)} Z`
      : '';
    const saleDots = points
      .map((point, index) =>
        point.profit > 0
          ? `<circle class="kp-sales-dot is-sales" cx="${x(index).toFixed(1)}" cy="${y(point.profit).toFixed(
              1
            )}" r="2.6"></circle>`
          : ''
      )
      .join('');

    // Lignes horizontales : 50 = fine, 100 = moyenne, 1000 = épaisse.
    const chakraStep = plotH / yMax;
    const grid = [];
    for (let value = 0; value <= yMax; value += 50) {
      const major = value % 1000 === 0;
      const medium = value % 100 === 0;
      if (!major && !medium && 50 * chakraStep < 5) continue;
      if (!major && medium && 100 * chakraStep < 6) continue;
      grid.push({ value, major, medium });
    }
    const labelStep = yMax <= 500 ? 50 : yMax <= 1200 ? 100 : yMax <= 5000 ? 500 : 1000;
    const yLabels = grid.filter((lineItem) => lineItem.value % labelStep === 0);
    if (!yLabels.some((lineItem) => lineItem.value === yMax)) {
      yLabels.push({ value: yMax, major: yMax % 1000 === 0, medium: yMax % 100 === 0 });
    }
    const yGrid = grid
      .map(
        (lineItem) =>
          `<line class="kp-sales-grid ${lineItem.major ? 'is-major' : lineItem.medium ? 'is-medium' : 'is-minor'}" x1="${
            pad.l
          }" y1="${y(lineItem.value).toFixed(1)}" x2="${W - pad.r}" y2="${y(lineItem.value).toFixed(1)}"></line>`
      )
      .join('');
    const yText = yLabels
      .map(
        (lineItem) =>
          `<text class="kp-sales-axis ${lineItem.major ? 'is-major' : ''}" x="${pad.l - 9}" y="${(
            y(lineItem.value) + 3
          ).toFixed(1)}" text-anchor="end">◆ ${fmt(lineItem.value)}</text>`
      )
      .join('');

    // Lignes verticales : 1 h fine, 12 h moyenne, 24 h épaisse.
    const xSpacing = plotW / Math.max(1, points.length - 1);
    const majorEvery = Math.max(1, Math.round(24 / model.stepHours));
    const mediumEvery = Math.max(1, Math.round(12 / model.stepHours));
    const xGrid = [];
    points.forEach((point, index) => {
      const major = index % majorEvery === 0;
      const medium = index % mediumEvery === 0;
      if (!major && !medium && xSpacing < 3) return;
      xGrid.push(
        `<line class="kp-sales-grid-x ${major ? 'is-major' : medium ? 'is-medium' : 'is-minor'}" x1="${x(index).toFixed(
          1
        )}" y1="${pad.t}" x2="${x(index).toFixed(1)}" y2="${H - pad.b}"></line>`
      );
    });

    // Repères lisibles : toutes les 6 h sur 1 jour, toutes les 24 h au-delà.
    const labelEveryHours = range === '1d' ? 6 : 24;
    const labelEveryPoints = Math.max(1, Math.round(labelEveryHours / model.stepHours));
    const labelIndexes = new Set([0, points.length - 1]);
    points.forEach((point, index) => {
      if (index % labelEveryPoints === 0) labelIndexes.add(index);
    });
    const labelOf = (at) => {
      const date = new Date(at);
      const hh = `${String(date.getHours()).padStart(2, '0')} h`;
      if (range === '1d') return hh;
      const day = `${String(date.getDate()).padStart(2, '0')}/${String(date.getMonth() + 1).padStart(2, '0')}`;
      return `${day} ${hh}`;
    };
    const xLabels = [...labelIndexes]
      .sort((a, b) => a - b)
      .map((index) => {
        const point = points[index];
        return `<text class="kp-sales-axis" x="${x(index).toFixed(1)}" y="${H - 9}" text-anchor="middle">${esc(
          labelOf(point.at)
        )}</text>`;
      })
      .join('');

    const rangeLabel = { '1d': '24 h', '7d': '7 jours', total: "tout l'historique" }[range];
    state.salesChart = {
      points,
      pad,
      W,
      H,
      plotW,
      plotH,
      yMax,
      range,
      stepHours: model.stepHours,
      startAt: model.startAt
    };
    return `
      <section class="kp-sales">
        <div class="kp-sales-head">
          <b>Bénéfice par heure (chakra)</b>
          <div class="kp-sales-head-right">
            <span>gain de chaque heure sur ${esc(rangeLabel)} · ventes confirmées via Kyareeh+</span>
            <select class="kp-select kp-sales-range" data-sales-range aria-label="Période du bénéfice par heure">
              <option value="1d" ${range === '1d' ? 'selected' : ''}>1 jour</option>
              <option value="7d" ${range === '7d' ? 'selected' : ''}>7 jours</option>
              <option value="total" ${range === 'total' ? 'selected' : ''}>Total</option>
            </select>
          </div>
        </div>
        <div class="kp-sales-kpis">
          <span><b>◆ ${fmt(net)}</b><small>profit réalisé</small></span>
          <span><b>${fmt(count)}</b><small>ventes confirmées</small></span>
          <span><b>${fmt(matched)}</b><small>dont immédiates</small></span>
          <span><b>◆ ${fmt(fees + tax)}</b><small>frais + taxe déduits</small></span>
        </div>
        <svg class="kp-sales-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="Bénéfice généré par heure en chakra">
          ${yGrid}
          ${xGrid}
          ${yText}
          ${area ? `<path class="kp-sales-area is-sales" d="${area}"></path>` : ''}
          <path class="kp-sales-line is-sales" d="${line}"></path>
          ${saleDots}
          <g class="kp-sales-hover" style="display:none">
            <line class="kp-sales-hover-line" x1="${pad.l}" y1="${pad.t}" x2="${pad.l}" y2="${H - pad.b}"></line>
            <circle class="kp-sales-hover-dot" cx="${pad.l}" cy="${H - pad.b}" r="4"></circle>
            <rect class="kp-sales-tip-bg" x="${pad.l}" y="${pad.t}" width="180" height="21" rx="5"></rect>
            <text class="kp-sales-tip" x="${pad.l + 8}" y="${pad.t + 14}" text-anchor="start"></text>
          </g>
          ${xLabels}
        </svg>
        <div class="kp-sales-legend">
          <span><i class="is-sales"></i>Gain de l'heure</span>
          <span>meilleure heure <b>◆ ${fmt(maxProfit)}</b></span>
        </div>
        <div class="kp-sales-note">
          Chaque point est le bénéfice de la tranche : la courbe monte quand une heure rapporte et
          redescend quand la suivante rapporte moins — ce n'est pas un cumul${
            model.stepHours > 1 ? ` · tranches de ${fmt(model.stepHours)} h` : ' · une tranche par heure'
          }. Profit = encaissé − frais de mise en vente − taxe. Une mise en vente sans achat n'ajoute rien.
          Coût d'acquisition non fourni par le site : non déduit.
        </div>
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
        ${listedCardsBlock()}
        ${autoSellExpiryBlock()}
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
    const mineAll = autoSellListings();
    const mine = mineAll.filter((l) => autoSellListingIsActive(l));
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
    if (IS_PANEL || state.settings.antiAfk === false) return;
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
          <span>Vente auto — délai min<small>Anti-flag : 5 s minimum</small></span>
          <input class="kp-input" type="number" min="5" max="300" step="1" data-setting="autoSellDelayMinSec" value="${state.settings.autoSellDelayMinSec}">
        </label>
        <label class="kp-field">
          <span>Vente auto — délai max<small>Plage aléatoire entre chaque vente</small></span>
          <input class="kp-input" type="number" min="5" max="300" step="1" data-setting="autoSellDelayMaxSec" value="${state.settings.autoSellDelayMaxSec}">
        </label>
        <label class="kp-field">
          <span>Vente auto — refresh min<small>Minutes entre deux relectures (auto-open en parallèle)</small></span>
          <input class="kp-input" type="number" min="1" max="60" step="1" data-setting="autoSellRefreshMinMin" value="${state.settings.autoSellRefreshMinMin}">
        </label>
        <label class="kp-field">
          <span>Vente auto — refresh max<small>Plage aléatoire de relecture</small></span>
          <input class="kp-input" type="number" min="1" max="60" step="1" data-setting="autoSellRefreshMaxMin" value="${state.settings.autoSellRefreshMaxMin}">
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
    // L'annonce du marché peut ne pas encore contenir `isMine` : on retombe
    // sur la liste des ventes actives déjà chargée.
    const myListing =
      analysis.myListing ??
      autoSellActiveEntries().find(
        (listing) =>
          !listing.pending &&
          String(listing.characterId ?? listing.character?.id ?? '') === String(card.id)
      ) ??
      null;
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
          rec && !view.detailHideRecommend
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
          myListing
            ? `<div class="kp-alert" style="margin-top:10px">
                 Tu as déjà une annonce sur cette carte (${esc(
                   myListing.type === 'auction' ? 'enchère' : 'prix fixe'
                 )} · ◆ ${fmt(myListing.buyoutPrice ?? myListing.currentBid ?? myListing.price)}).
                 ${
                   myListing.id
                     ? `<button class="kp-btn ${
                         state.listingCancelId === String(myListing.id) ? 'is-primary' : ''
                       }" type="button" data-act="listing-cancel" data-listing="${esc(
                         myListing.id
                       )}" data-character="${esc(card.id)}" data-name="${esc(card.name)}">${
                         state.listingCancelId === String(myListing.id) ? 'Confirmer le retrait' : 'Retirer la vente'
                       }</button>`
                     : ''
                 }
               </div>`
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
        card: {
          id: key,
          name: row.name,
          rarity: row.rarity,
          // Le plancher de recyclage doit être connu même quand l'appelant
          // n'a pas encore préparé la ligne (vente auto, estimation…).
          floor: row.floor ?? recycleFloor(row.rarity)
        },
        mine: mineRow ?? sellRowOf(key),
        listings: marketItems.length ? { items: marketItems } : null,
        book: state.buyOrders[key] ? { bids: [{ price: state.buyOrders[key].price }] } : null
      });
    }
    if (analysis?.recommend) return { ...analysis.recommend, estimated: false };

    // Pas de données de marché : les trois stratégies gardent le prix estimé.
    const floor = Math.max(1, Math.round(row.floor ?? recycleFloor(row.rarity) ?? 1));
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

  /**
   * Aperçu du recyclage ciblé : ce qui va être détruit, ce qui reste, et le
   * chakra attendu (estimation du barème, puis gain réel renvoyé par le site).
   */
  function renderRecycleModal() {
    const rec = state.recycle;
    const plan = rec.plan;
    const totals = recycleTotals(plan);
    const running = rec.running;
    const done = rec.done;
    const remaining = plan.reduce((sum, row) => sum + Math.max(0, row.totalQty - row.qty), 0);
    const heavy = plan.filter((row) => row.rarity === 'M' || row.rarity === 'L');

    ui.modal.hidden = false;
    ui.modalCard.classList.add('is-wide');
    ui.modalCard.innerHTML = `
      <div class="kp-modal-head">
        <b>Recyclage ciblé · ${totals.cards} carte(s)</b>
        <button class="kp-icon-btn" type="button" data-act="recycle-close" ${running ? 'disabled' : ''}>✕</button>
      </div>
      <div class="kp-modal-body">
        ${
          heavy.length
            ? `<div class="kp-alert is-bad">
                 <b>Cartes de valeur</b><br>
                 Tu vas recycler ${fmt(heavy.reduce((sum, row) => sum + row.qty, 0))} exemplaire(s)
                 de rareté Légendaire ou Mythique. Ils seront perdus contre du chakra.
               </div>`
            : ''
        }
        <div class="kp-alert is-bad">
          <b>Action définitive</b><br>
          Les exemplaires recyclés quittent définitivement ta collection : il n'y a
          <b>aucune annulation</b>. Une copie de chaque carte est toujours conservée.
        </div>
        <div class="kp-summary">
          <div><span>Exemplaires</span><b>${fmt(totals.copies)}</b></div>
          <div><span>Chakra ${done ? 'gagné' : 'attendu'}</span><b>◆ ${fmt(done ? rec.gained : totals.chakra)}</b></div>
          <div><span>Cartes</span><b>${fmt(totals.cards)}</b></div>
          <div><span>Restant</span><b>${fmt(remaining)} ex.</b></div>
        </div>
        <div class="kp-hint">
          ${running ? `Progression ${fmt(rec.processed)}/${fmt(rec.planned)} exemplaire(s).` : 'Vérifie la liste, puis confirme.'}
          Le gain réel est celui renvoyé par le site.
        </div>
        <div class="kp-plan">
          ${plan
            .map(
              (row) => `
            <div class="kp-plan-row">
              <div class="kp-name">${esc(row.name)} <small>${esc(rarityInfo(row.rarity).label)} · reste ${
                Math.max(0, row.totalQty - row.qty)
              } ex.${row.unit ? ` · ◆ ${fmt(row.unit)}/ex.` : ' · barème inconnu'}</small></div>
              <div class="kp-net">×${fmt(row.qty)} · ◆ ${fmt(row.total)}</div>
            </div>`
            )
            .join('')}
        </div>
        ${rec.log.length ? `<div class="kp-log">${rec.log.map((l) => `<div class="is-${l.kind}">${esc(l.text)}</div>`).join('')}</div>` : ''}
      </div>
      <div class="kp-modal-foot">
        <button class="kp-btn is-ghost" type="button" data-act="recycle-close" ${running ? 'disabled' : ''}>Annuler</button>
        ${
          running
            ? `<button class="kp-btn is-danger" type="button" data-act="recycle-stop">Arrêter</button>`
            : done
              ? `<button class="kp-btn is-primary" type="button" data-act="recycle-close">Fermer</button>`
              : `<button class="kp-btn is-primary" type="button" data-act="recycle-run">Recycler ${fmt(
                  totals.copies
                )} exemplaire(s)</button>`
        }
      </div>
    `;
    ui.modalCard.dataset.kind = 'recycle';
  }

  function renderModal() {
    if (!ui) return;

    // L'aperçu de recyclage prend la modale tant qu'il est ouvert (il suit la
    // progression de l'action, même si l'utilisateur change d'onglet).
    if (state.recycle.open) {
      renderRecycleModal();
      return;
    }

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

  function hideSalesChartHover() {
    if (!ui?.view) return;
    for (const group of ui.view.querySelectorAll('.kp-sales-hover')) {
      group.style.display = 'none';
    }
  }

  /** Infobulle du graphique : valeur exacte de la courbe sous la souris. */
  function onPointerMove(event) {
    const chart = state.salesChart;
    if (!chart || !chart.points.length) {
      hideSalesChartHover();
      return;
    }
    const target = event.target;
    const svg = target && typeof target.closest === 'function' ? target.closest('.kp-sales-svg') : null;
    if (!svg) {
      hideSalesChartHover();
      return;
    }
    const rect = svg.getBoundingClientRect();
    if (!rect.width) return;
    const vx = clamp(
      ((event.clientX - rect.left) / rect.width) * chart.W,
      chart.pad.l,
      chart.W - chart.pad.r
    );
    const position = ((vx - chart.pad.l) / chart.plotW) * Math.max(1, chart.points.length - 1);
    const index = Math.max(0, Math.min(chart.points.length - 1, Math.round(position)));
    const point = chart.points[index];
    // Gain exact de la tranche, jamais une interpolation au pixel.
    const value = Math.round(Number(point.profit) || 0);
    const at = point.at;
    const snapX = chart.pad.l + (index / Math.max(1, chart.points.length - 1)) * chart.plotW;
    const cy = chart.H - chart.pad.b - (value / chart.yMax) * chart.plotH;

    const group = svg.querySelector('.kp-sales-hover');
    if (!group) return;
    group.style.display = '';
    const line = group.querySelector('.kp-sales-hover-line');
    const dot = group.querySelector('.kp-sales-hover-dot');
    const tip = group.querySelector('.kp-sales-tip');
    const bg = group.querySelector('.kp-sales-tip-bg');
    if (!line || !dot || !tip || !bg) return;

    line.setAttribute('x1', snapX.toFixed(1));
    line.setAttribute('x2', snapX.toFixed(1));
    line.setAttribute('y1', String(chart.pad.t));
    line.setAttribute('y2', String(chart.H - chart.pad.b));
    dot.setAttribute('cx', snapX.toFixed(1));
    dot.setAttribute('cy', cy.toFixed(1));

    const date = new Date(at);
    const hh = `${String(date.getHours()).padStart(2, '0')} h`;
    const day = `${String(date.getDate()).padStart(2, '0')}/${String(date.getMonth() + 1).padStart(2, '0')}`;
    const when = chart.range === '1d' ? hh : `${day} ${hh}`;
    // Date + gain de la tranche, puis chaque vente de la tranche (nom + profit).
    const unit = Number(chart.stepHours) > 1 ? 'Gain de la tranche' : "Gain de l'heure";
    const lines = [`${unit} ◆ ${fmt(value)} · ${when}`];
    const sales = Array.isArray(point.sales) ? point.sales : [];
    if (!sales.length) {
      lines.push('Aucune vente sur cette tranche');
    } else {
      for (const sale of sales.slice(0, 5)) {
        const saleDate = new Date(Number(sale.at) || at);
        const clock = `${String(saleDate.getHours()).padStart(2, '0')}:${String(saleDate.getMinutes()).padStart(
          2,
          '0'
        )}`;
        const name = String(sale.name || 'Vente');
        lines.push(`${clock} · ${name.length > 26 ? `${name.slice(0, 25)}…` : name} · ◆ ${fmt(Math.round(sale.net))}`);
      }
      if (sales.length > 5) lines.push(`+ ${fmt(sales.length - 5)} autre(s) vente(s)`);
    }
    const lineHeight = 14;
    const width = Math.max(
      150,
      Math.min(chart.W - 8, Math.max(...lines.map((text) => text.length)) * 5.6 + 20)
    );
    const height = 8 + lines.length * lineHeight;
    const tipX = Math.max(
      chart.pad.l - 40,
      Math.min(snapX - width / 2, chart.W - chart.pad.r - width + 24)
    );
    const tipY = Math.max(chart.pad.t + 2, Math.min(cy - height - 8, chart.H - chart.pad.b - height));
    bg.setAttribute('x', tipX.toFixed(1));
    bg.setAttribute('y', tipY.toFixed(1));
    bg.setAttribute('width', width.toFixed(1));
    bg.setAttribute('height', String(height));
    tip.setAttribute('x', (tipX + 9).toFixed(1));
    tip.setAttribute('y', (tipY + 13).toFixed(1));
    // Une ligne par élément : `<text>` ne revient pas à la ligne tout seul.
    while (tip.firstChild) tip.removeChild(tip.firstChild);
    lines.forEach((text, lineIndex) => {
      const tspan = document.createElementNS('http://www.w3.org/2000/svg', 'tspan');
      tspan.setAttribute('x', (tipX + 9).toFixed(1));
      tspan.setAttribute('dy', lineIndex ? String(lineHeight) : '0');
      tspan.textContent = text;
      tip.appendChild(tspan);
    });
  }

  async function onClick(event) {
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
      case 'panel-detach':
      case 'panel-focus':
        panelDetach();
        break;
      case 'panel-attach':
        panelAttach();
        break;
      case 'duel-retry':
        destroyDuelFrame();
        render();
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
      case 'sound-mute':
        state.sound.muted = !state.sound.muted;
        persistSound();
        syncSoundControls();
        render();
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
        // Quitter l'onglet ferme l'aperçu de recyclage, sauf pendant l'action.
        if (state.tab !== 'recycle' && state.recycle.open && !state.recycle.running) {
          state.recycle.open = false;
          state.recycle.plan = [];
          state.recycle.done = false;
        }
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
        persistUiSoon();
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
        if (
          mode === 'auto' &&
          !state.autoSell.running &&
          !state.autoSell.starting &&
          Date.now() - Number(state.autoSell.listingsAt || 0) > 30000
        ) {
          autoSellRefreshListings();
        }
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
        if (id) openCardDetail(id, { hideRecommend: el.getAttribute('data-hide-recommend') === '1' });
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
      case 'listing-cancel': {
        const listingId = el.getAttribute('data-listing');
        const name = el.getAttribute('data-name') || 'cette carte';
        if (!listingId) break;
        // Deux clics : le premier arme, le second retire réellement.
        if (state.listingCancelId !== String(listingId)) {
          state.listingCancelId = String(listingId);
          render();
          break;
        }
        state.listingCancelId = null;
        el.disabled = true;
        try {
          const canceled = await api(`/api/market/listings/${encodeURIComponent(listingId)}/cancel`, {
            method: 'POST',
            timeout: 20000
          });
          if (canceled && canceled.ok === false) throw new ApiError(0, 'Annonce introuvable ou déjà terminée.');
          const characterId = state.sellView.detailId || el.getAttribute('data-character');
          const removeLocally = (withPending = true) => {
            const rows = autoSellListingRows(state.mine).filter(
              (listing) => String(listing.id) !== String(listingId)
            );
            if (Array.isArray(state.mine)) state.mine = rows;
            else if (state.mine && typeof state.mine === 'object') state.mine = { ...state.mine, listings: rows };
            if (!withPending) return;
            const pending = state.autoSell.pendingListings;
            const sameCardPending = pending.filter(
              (listing) =>
                characterId != null &&
                String(listing.characterId ?? listing.character?.id ?? '') === String(characterId)
            );
            const byId = sameCardPending.find((listing) => String(listing.id) === String(listingId));
            // Priorité à l'identifiant ; sinon on retire la réservation la plus
            // récente (baseline la plus haute), celle qui correspond à l'annonce
            // affichée en dernier.
            const target =
              byId ||
              sameCardPending.reduce(
                (best, listing) => (!best || Number(listing.baseline || 0) >= Number(best.baseline || 0) ? listing : best),
                null
              );
            if (target) {
              state.autoSell.pendingListings = pending.filter((listing) => listing !== target);
            } else {
              state.autoSell.pendingListings = pending.filter(
                (listing) => String(listing.id) !== String(listingId)
              );
            }
            // Un retrait volontaire n'est pas une vente : on l'oublie aussi dans
            // le suivi du graphique, sinon sa disparition passerait pour un achat.
            untrackPendingSale(listingId, characterId);
          };
          removeLocally();
          notify(`Annonce retirée : ${name}.`);
          closeCardDetail();
          try {
            await autoSellRefresh();
          } catch {
            /* la liste sera relue au prochain passage */
          }
          // Si le serveur n'a pas encore retiré l'annonce de sa réponse,
          // on garde au moins l'affichage cohérent avec l'action utilisateur.
          removeLocally(false);
          render();
        } catch (err) {
          el.disabled = false;
          notify(`Retrait impossible : ${friendlyError(err)}`);
        }
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
      case 'recycle-rarity':
        state.recycleView.rarity = el.getAttribute('data-rarity') || 'all';
        state.recycleView.limit = 40;
        recyclePruneSelection();
        render();
        break;
      case 'recycle-inc':
      case 'recycle-dec': {
        const id = String(el.getAttribute('data-id') || '');
        const row = recycleRows().find((r) => String(r.id) === id);
        if (!row || row.blockReason) break;
        const current = Number(state.recycle.selection.get(id) || 0);
        const next = act === 'recycle-inc' ? Math.min(row.spare, current + 1) : Math.max(0, current - 1);
        if (next > 0) state.recycle.selection.set(id, next);
        else state.recycle.selection.delete(id);
        render();
        break;
      }
      case 'recycle-select-all':
        for (const row of recycleSelectableRows(filteredRecycleRows())) {
          state.recycle.selection.set(String(row.id), row.spare);
        }
        render();
        break;
      case 'recycle-clear':
        state.recycle.selection.clear();
        render();
        break;
      case 'recycle-start':
        prepareRecycle();
        break;
      case 'recycle-run':
        executeRecycle();
        break;
      case 'recycle-stop':
        if (state.recycle.open && state.recycle.running) {
          state.recycle.stop = true;
          state.recycle.log.push({ text: 'Arrêt demandé…', kind: 'info' });
          render();
        }
        break;
      case 'recycle-close':
        closeRecycleModal();
        break;
      case 'recycle-more':
        state.recycleView.limit += 40;
        render();
        break;
      case 'recycle-refresh':
        loadData({ keepPrices: true });
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
      case 'autosell-refresh-listings':
        autoSellRefreshListings();
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

    // --- Onglet Recyclage : sélection et options ---
    const recycleSel = target.closest('input[data-recycle-sel]');
    if (recycleSel) {
      const id = String(recycleSel.getAttribute('data-recycle-sel') || '');
      const row = recycleRows().find((r) => String(r.id) === id);
      if (!row || row.blockReason) {
        state.recycle.selection.delete(id);
        render();
        return;
      }
      if (recycleSel.checked) state.recycle.selection.set(id, row.spare);
      else state.recycle.selection.delete(id);
      render();
      return;
    }

    const recycleSort = target.closest('[data-recycle-sort]');
    if (recycleSort) {
      state.recycleView.sort = String(recycleSort.value) || 'value_desc';
      state.recycleView.limit = 40;
      render();
      return;
    }

    const recycleSeries = target.closest('[data-recycle-series]');
    if (recycleSeries) {
      state.recycleView.series = String(recycleSeries.value) || 'all';
      state.recycleView.limit = 40;
      recyclePruneSelection();
      render();
      return;
    }

    const recycleOnlyDupes = target.closest('[data-recycle-only-dupes]');
    if (recycleOnlyDupes) {
      state.recycleView.onlyDupes = Boolean(recycleOnlyDupes.checked);
      state.recycleView.limit = 40;
      render();
      return;
    }

    const recycleIncludeML = target.closest('[data-recycle-include-ml]');
    if (recycleIncludeML) {
      state.recycleView.includeML = Boolean(recycleIncludeML.checked);
      recyclePruneSelection();
      render();
      return;
    }

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
    const autoOrder = target.closest('[data-autosell-order]');
    const autoDuration = target.closest('[data-autosell-duration]');
    const autoIncludeM = target.closest('[data-autosell-include-m]');
    const autoDryRun = target.closest('[data-autosell-dryrun]');
    const autoExpire = target.closest('[data-autosell-expire]');
    const autoExpireValue = target.closest('[data-autosell-expire-value]');
    const autoExpireUnit = target.closest('[data-autosell-expire-unit]');
    const autoRecycleExpired = target.closest('[data-autosell-recycle-expired]');
    if (
      autoType ||
      autoStrategy ||
      autoOrder ||
      autoDuration ||
      autoIncludeM ||
      autoDryRun ||
      autoExpire ||
      autoExpireValue ||
      autoExpireUnit ||
      autoRecycleExpired
    ) {
      if (state.autoSell.running) return;
      state.autoSell.armed = false;
      if (autoType) state.settings.autoSellType = autoType.value === 'auction' ? 'auction' : 'fixed';
      if (autoStrategy) {
        state.settings.autoSellStrategy = ['quick', 'balanced', 'max'].includes(autoStrategy.value)
          ? autoStrategy.value
          : 'balanced';
      }
      if (autoOrder) {
        state.settings.autoSellOrder = AUTOSELL_ORDERS.some(([value]) => value === autoOrder.value)
          ? autoOrder.value
          : 'score';
      }
      if (autoDuration) {
        const hours = Number(autoDuration.value);
        if ([12, 24, 48].includes(hours)) state.settings.durationHours = hours;
      }
      if (autoIncludeM) state.settings.autoSellIncludeM = Boolean(autoIncludeM.checked);
      if (autoDryRun) state.settings.autoSellDryRun = Boolean(autoDryRun.checked);
      if (autoExpire) state.settings.autoSellExpireEnabled = Boolean(autoExpire.checked);
      if (autoRecycleExpired) {
        state.settings.autoSellRecycleExpired = Boolean(autoRecycleExpired.checked);
      }
      if (autoExpireUnit) {
        const previousUnit = state.settings.autoSellExpireUnit === 'min' ? 'min' : 'h';
        const nextUnit = autoExpireUnit.value === 'min' ? 'min' : 'h';
        if (previousUnit !== nextUnit) {
          // Change d'unité sans changer la durée réelle : 72 h → 4 320 min.
          const current = Math.max(1, Math.round(Number(state.settings.autoSellExpireValue) || (previousUnit === 'min' ? 60 : 72)));
          state.settings.autoSellExpireValue = nextUnit === 'min' ? current * 60 : Math.max(1, Math.round(current / 60));
        }
        state.settings.autoSellExpireUnit = nextUnit;
      }
      if (autoExpireValue) {
        // Valeur validée : entière, entre 1 minute et 30 jours selon l'unité.
        state.settings.autoSellExpireValue = autoExpireValue.value;
      }
      // Normalise toujours le couple valeur/unité avant de persister : une
      // saisie vide ou aberrante ne peut pas désactiver silencieusement le seuil.
      const expire = autoSellExpireSettings({
        enabled: state.settings.autoSellExpireEnabled,
        value: state.settings.autoSellExpireValue,
        unit: state.settings.autoSellExpireUnit
      });
      state.settings.autoSellExpireEnabled = expire.enabled;
      state.settings.autoSellExpireValue = expire.value;
      state.settings.autoSellExpireUnit = expire.unit;
      persistSettings();
      render();
      return;
    }

    const salesRange = target.closest('[data-sales-range]');
    if (salesRange) {
      state.settings.salesRange = ['1d', '7d', 'total'].includes(salesRange.value)
        ? salesRange.value
        : '7d';
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
      if (key === 'autoSellDelayMinSec') {
        state.settings.autoSellDelayMinSec = Math.min(300, Math.max(5, Math.round(Number(value) || 5)));
        state.settings.autoSellDelayMaxSec = Math.max(
          state.settings.autoSellDelayMinSec,
          state.settings.autoSellDelayMaxSec
        );
      }
      if (key === 'autoSellDelayMaxSec') {
        state.settings.autoSellDelayMaxSec = Math.min(300, Math.max(5, Math.round(Number(value) || 60)));
        state.settings.autoSellDelayMinSec = Math.min(
          state.settings.autoSellDelayMinSec,
          state.settings.autoSellDelayMaxSec
        );
      }
      if (key === 'autoSellRefreshMinMin') {
        state.settings.autoSellRefreshMinMin = Math.min(60, Math.max(1, Math.round(Number(value) || 7)));
        state.settings.autoSellRefreshMaxMin = Math.max(
          state.settings.autoSellRefreshMinMin,
          state.settings.autoSellRefreshMaxMin
        );
      }
      if (key === 'autoSellRefreshMaxMin') {
        state.settings.autoSellRefreshMaxMin = Math.min(60, Math.max(1, Math.round(Number(value) || 10)));
        state.settings.autoSellRefreshMinMin = Math.min(
          state.settings.autoSellRefreshMinMin,
          state.settings.autoSellRefreshMaxMin
        );
      }
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

    const soundVolume = target.closest('[data-role="sound-volume"]');
    if (soundVolume) {
      state.sound.volume = Math.max(0, Math.min(1, Number(soundVolume.value) / 100));
      persistSound();
      syncSoundControls();
      return;
    }


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

    const recycleSearch = target.closest('[data-role="recycle-search"]');
    if (recycleSearch) {
      state.recycleView.query = recycleSearch.value;
      state.recycleView.limit = 40;
      const restoreRecycleFocus = () => {
        const again = qs('[data-role="recycle-search"]');
        if (!again) return;
        again.focus();
        const pos = again.value.length;
        try {
          again.setSelectionRange(pos, pos);
        } catch {
          /* type=search may not support it */
        }
      };
      if (recycleRenderTimer) clearTimeout(recycleRenderTimer);
      recycleRenderTimer = setTimeout(() => {
        recycleRenderTimer = null;
        render();
        restoreRecycleFocus();
      }, 160);
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
  let recycleRenderTimer = null;

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
      autoSellRefresh,
      autoSellRefreshListings,
      autoSellActiveEntries,
      autoSellListings,
      autoSellSelect,
      autoSellRank,
      autoSellVolumeInfo,
      autoSellRankedCandidates,
      startAutoSell,
      stopAutoSell,
      armAutoSell,
      disarmAutoSell,
      autoSellPanel,
      autoSellPurgeExpired,
      autoSellExpirySettings,
      autoSellApplyReturns,
      loadAutoLog,
      // Ventes confirmées et graphique du profit réalisé
      loadSalesLog,
      reconcilePendingSales,
      recordConfirmedSales,
      trackPendingSale,
      untrackPendingSale,
      salesChartSeries,
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
      !state.panelAway &&
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
