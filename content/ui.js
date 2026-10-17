/* Kyara+ — content script
 * Tableau de bord de compte, valorisation en chakra et vente assistée.
 * Tout passe par la session existante de l'utilisateur : aucun identifiant stocké.
 */
(() => {
  'use strict';

  if (window.__kyaraPlusLoaded) return;
  window.__kyaraPlusLoaded = true;

  const ext = globalThis.browser ?? globalThis.chrome;
  const VERSION = '0.1.0';
  const PRICE_KEY = 'kyaraplus.prices.v2';
  const SETTINGS_KEY = 'kyaraplus.settings.v2';
  const CHARS_KEY = 'kyaraplus.characters.v1';

  const DEFAULT_SETTINGS = {
    ttlH: 6,
    gapMs: 1200,
    maxBatch: 20,
    discountPct: 0,
    dryRun: false,
    autoPrices: true
  };

  const RARITY = {
    C: { label: 'Commune', color: '#9aa4b2' },
    U: { label: 'Peu commune', color: '#4ade80' },
    R: { label: 'Rare', color: '#60a5fa' },
    E: { label: 'Épique', color: '#c084fc' },
    L: { label: 'Légendaire', color: '#fbbf24' },
    M: { label: 'Mythique', color: '#ff4d2e' },
    H: { label: 'Héritage', color: '#f472b6' }
  };

  const nf = new Intl.NumberFormat('fr-FR');
  const fmt = (v) => (v == null || !Number.isFinite(Number(v)) ? '—' : nf.format(Math.round(Number(v))));
  const esc = (s) =>
    String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const toNum = (v) => {
    const n = typeof v === 'string' ? Number.parseFloat(v.replace(',', '.')) : Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const nowTime = () =>
    new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });

  class ApiError extends Error {
    constructor(status, message) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
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
    const code = err?.message;
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
    noticeTimer: null
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
      <button class="kp-fab" type="button" data-act="toggle" title="Kyara+ (Alt+K)">
        <span class="kp-diamond">◆</span><span>Kyara+</span>
      </button>
      <section class="kp-panel" hidden aria-label="Kyara+">
        <header class="kp-head">
          <div class="kp-brand">
            <span class="kp-logo">◆</span>
            <div><b>Kyara+</b><small>chakra &amp; doublons</small></div>
          </div>
          <div class="kp-head-actions">
            <button class="kp-icon-btn" type="button" data-act="refresh" title="Rafraîchir les données">⟳</button>
            <button class="kp-icon-btn" type="button" data-act="close" title="Fermer">✕</button>
          </div>
        </header>
        <div class="kp-stats" id="kp-stats"></div>
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
      tabs: qs('#kp-tabs'),
      view: qs('#kp-view'),
      foot: qs('#kp-foot'),
      modal: qs('#kp-modal'),
      modalCard: qs('#kp-modal-card')
    };

    shadow.addEventListener('click', onClick);
    shadow.addEventListener('change', onChange);
    shadow.addEventListener('input', onInput);

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
        } else if (msg.type === 'kp-status') {
          sendResponse({
            ok: true,
            ready: state.ready,
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
        if (data && typeof data === 'object') message = data.message || data.error || message;
        else if (typeof data === 'string' && data.trim()) message = data.trim().slice(0, 180);
        throw new ApiError(res.status, message);
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
    const saved = await storageGet(SETTINGS_KEY, {});
    state.settings = { ...DEFAULT_SETTINGS, ...(saved || {}) };
    for (const key of ['ttlH', 'gapMs', 'maxBatch', 'discountPct']) {
      const value = Number(state.settings[key]);
      state.settings[key] = Number.isFinite(value) ? value : DEFAULT_SETTINGS[key];
    }
    state.settings.dryRun = Boolean(state.settings.dryRun);
    state.settings.autoPrices = state.settings.autoPrices !== false;
    const cached = await storageGet(PRICE_KEY, {});
    if (cached && typeof cached === 'object') {
      state.prices = cached.prices && typeof cached.prices === 'object' ? cached.prices : cached;
    }
    await mount();
    await loadData();
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
    } catch (err) {
      state.error = err instanceof ApiError ? friendlyError(err) : String(err?.message || err);
    } finally {
      state.loading = false;
      render();
    }
  }

  async function refreshLight() {    try {
      const [me, coll] = await Promise.all([
        api('/api/me').catch(() => null),
        api('/api/me/collection?lean=1').catch(() => null)
      ]);
      if (me) state.user = me;
      if (Array.isArray(coll)) state.collection = coll;
      state.lastSync = Date.now();
      render();
    } catch {
      /* silencieux */
    }
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
    if (!query) return all;
    return all.filter((r) => `${r.name} ${r.series}`.toLowerCase().includes(query));
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

  function suggestPrice(id, rarity) {
    const key = String(id);
    const p = state.prices[key];
    const median = p?.m7 ?? p?.m30 ?? null;
    const low = state.lowest[key] ?? null;
    const bid = state.buyOrders[key]?.price ?? null;
    const floor = Math.max(1, recycleOf(rarity ?? state.characters.get(key)?.rarity));

    let base = median ?? low ?? floor;
    if (low != null && low > 1) base = Math.min(base, low - 1);
    if (bid != null) base = Math.max(base, bid);
    base = Math.max(floor, base);
    if (state.settings.discountPct) base = base * (1 - state.settings.discountPct / 100);
    return Math.max(1, Math.round(base));
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
    render();

    try {
      const data = await api('/api/market/listings?sort=price_asc&pageSize=120', { timeout: 20000 });
      const items = Array.isArray(data?.items) ? data.items : Array.isArray(data) ? data : [];

      const deals = [];
      for (const item of items) {
        if (item.isMine) continue;
        const id = String(item.characterId ?? item.character?.id ?? '');
        if (!id) continue;

        const price = String(item.type) === 'fixed' ? toNum(item.price) : toNum(item.buyoutPrice);
        const embedded = item.prices ?? null;
        const median = toNum(embedded?.median7d ?? embedded?.median30d) ?? priceOf(id);
        if (price == null || price <= 0 || median == null || median <= 0) continue;

        const pct = Math.round((1 - price / median) * 100);
        if (pct < 8) continue;

        deals.push({
          ...item,
          characterId: id,
          price,
          median,
          pct,
          sales7d: toNum(embedded?.sales7d),
          c: item.character ?? state.characters.get(id) ?? {}
        });
      }

      deals.sort((a, b) => b.pct - a.pct);
      state.deals = deals;
    } catch (err) {
      notify(`Scan impossible : ${friendlyError(err)}`);
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

    const plan = rows.map((r) => ({
      characterId: apiId(r.rawId ?? r.id),
      name: r.name,
      image: r.image,
      rarity: r.rarity,
      qty: r.sellable,
      price: suggestPrice(r.id, r.rarity)
    }));

    state.sell = { plan, running: false, done: false, log: [] };
    render();
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

  function sellBlocker(plan) {
    const t = sellTotals(plan);
    const cfg = getCfg();
    const chakra = toNum(state.user?.chakra) ?? 0;
    const maxActive = cfg.maxActive;
    const active = activeListings();
    const slots = maxActive == null ? null : Math.max(0, maxActive - active);

    if (!plan.length) return 'Aucune carte sélectionnée.';
    if (t.copies > state.settings.maxBatch) {
      return `Lot limité à ${state.settings.maxBatch} annonces (tu en as ${t.copies}). Réduis la sélection ou augmente la limite dans Réglages.`;
    }
    if (state.settings.dryRun) return '';
    if (t.fees > chakra) {
      return `Frais de dépôt : ${fmt(t.fees)} ◆, chakra disponible : ${fmt(chakra)} ◆.`;
    }
    if (slots != null && t.copies > slots) {
      return `Il te reste ${slots} emplacement(s) d'annonce(s) actif(s) sur ${maxActive}.`;
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
    const duration = cfg.durations.includes(24) ? 24 : cfg.durations[0] ?? 24;
    let consecutiveErrors = 0;

    const log = (text, kind = 'info') => {
      state.sell.log.push({ text, kind });
      render();
    };

    for (const row of plan) {
      for (let copy = 0; copy < row.qty; copy += 1) {
        if (!state.sell.running) break;

        if (state.settings.dryRun) {
          log(`(simulation) ${row.name} · ◆ ${fmt(row.price)}`, 'info');
          await sleep(90);
          continue;
        }

        try {
          const result = await api('/api/market/listings', {
            method: 'POST',
            timeout: 20000,
            body: {
              characterId: row.characterId,
              type: 'fixed',
              price: row.price,
              buyoutPrice: null,
              durationHours: duration
            }
          });
          log(`✓ ${row.name} · ◆ ${fmt(row.price)}${result?.matched ? ' · vendue immédiatement' : ''}`, 'ok');
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
    if (!state.mounted || !ui) return;
    ui.panel.hidden = !state.open;
    ui.fab.classList.toggle('is-open', state.open);
    if (!state.open) {
      renderModal();
      return;
    }

    const view = ui.view;
    const scrollTop = view.scrollTop;
    renderStats();
    renderTabs();
    renderView();
    renderFooter();
    renderModal();
    view.scrollTop = scrollTop;
  }

  function renderStats() {
    if (!ui) return;
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
      <span>v${VERSION} · Alt+K</span>
    `;
  }

  function renderView() {
    if (!ui) return;
    const fn = {
      account: viewAccount,
      dupes: viewDupes,
      market: viewMarket,
      settings: viewSettings,
      debug: viewDebug
    }[state.tab] ?? viewAccount;
    ui.view.innerHTML = fn();
  }

  function loginHTML() {
    return `
      <div class="kp-empty">
        <b>Connecte-toi à Kyara</b>
        Kyara+ utilise ta session existante, sans jamais voir ton mot de passe.<br>
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

  function viewAccount() {
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

    const progressPct = state.priceRun.total ? Math.round((state.priceRun.done / state.priceRun.total) * 100) : 0;

    const booster = toNum(state.user.freePacks) ?? 0;
    const boosterMax = toNum(state.user.freePacksMax) ?? toNum(state.config?.freePacks?.max) ?? null;
    const bonus = toNum(state.user.bonusPacks) ?? 0;
    const pity = toNum(state.user.pity);
    const pityMax = toNum(state.config?.pity?.threshold);
    const accessOk = state.access?.allowed !== false;

    return `
      <div class="kp-hero">
        <div class="kp-hero-label">Valeur estimée du compte</div>        <div class="kp-hero-value">◆ ${fmt(stats.total)}</div>
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
        <div class="kp-card-stat"><span>Doublons (brut)</span><b>◆ ${fmt(stats.dupGross)}</b><small>${stats.dupCopies} exemplaires vendables</small></div>
        <div class="kp-card-stat"><span>Net si vendus</span><b>◆ ${fmt(stats.dupNet)}</b><small>après taxe ${getCfg().taxPct} % + frais</small></div>
        <div class="kp-card-stat"><span>Cartes</span><b>${fmt(stats.unique)} <small>/ ${fmt(stats.totalCards)}</small></b><small>uniques / total</small></div>
        <div class="kp-card-stat"><span>Chakra</span><b>${fmt(toNum(state.user.chakra))}</b><small>solde actuel</small></div>
      </div>

      <div class="kp-section">
        <div class="kp-section-title">Ressources <span class="kp-link" data-act="tab" data-tab="dupes">${dupeCount} doublons →</span></div>
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

    const selected = rows.filter((r) => state.selected.has(r.id));
    const totals = sellTotals(
      selected.map((r) => ({ qty: r.sellable, price: suggestPrice(r.id, r.rarity) }))
    );

    return `
      <div class="kp-toolbar">
        <input class="kp-input" type="search" data-role="dupe-search" placeholder="Filtrer une carte…" value="${esc(state.query)}">
        <button class="kp-mini-btn" type="button" data-act="select-all">Tout</button>
        <button class="kp-mini-btn" type="button" data-act="select-none">Rien</button>
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
            return `
              <label class="kp-row ${checked ? 'is-selected' : ''}">
                <input type="checkbox" data-sel="${esc(r.id)}" ${checked ? 'checked' : ''}>
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
          <b>${selected.length} sélectionnée(s) · ◆ ${fmt(totals.net)} net</b>
          <span>${totals.copies} annonce(s) · frais ◆ ${fmt(totals.fees)}</span>
        </div>
        <button class="kp-btn is-primary" type="button" data-act="prepare-sell" ${selected.length ? '' : 'disabled'}>Préparer la vente</button>
      </div>
    `;
  }

  function viewMarket() {
    if (!state.user) return loginHTML();
    const deals = state.deals ?? [];
    const mine = Array.isArray(state.mine?.listings) ? state.mine.listings : Array.isArray(state.mine) ? state.mine : [];

    return `
      <div class="kp-toolbar">
        <button class="kp-btn is-primary" type="button" data-act="scan-market" ${state.dealsScanning ? 'disabled' : ''}>
          ${state.dealsScanning ? '<span class="kp-spinner"></span> Scan…' : 'Scanner les bons plans'}
        </button>
      </div>
      <div class="kp-hint">Compare les annonces au prix médian des 7 derniers jours.</div>

      ${
        state.deals === null
          ? `<div class="kp-empty"><b>Aucun scan</b>Lance un scan pour voir les annonces sous la médiane.</div>`
          : deals.length
            ? `<div class="kp-table">
                 ${deals
                   .slice(0, 40)
                   .map((d) => {
                     const ri = rarityInfo(d.c?.rarity);
                     return `
                     <div class="kp-deal" data-act="open-card" data-id="${esc(d.characterId)}">
                       <img src="${esc(imgSrc(d.c))}" alt="" loading="lazy">
                       <div>
                         <div class="kp-deal-name">${esc(d.c?.name ?? `Carte #${d.characterId}`)}</div>
                         <div class="kp-deal-meta">${esc(ri.label)}${d.type ? ` · ${esc(d.type)}` : ''}${d.sales7d != null ? ` · ${d.sales7d} vente(s)/7j` : ''}</div>
                       </div>
                       <div class="kp-deal-price">
                         <b>◆ ${fmt(d.price)}</b>
                         <small>${d.type === 'auction' ? 'achat imm. ' : ''}-${d.pct} %</small>
                       </div>
                     </div>`;
                   })
                   .join('')}
               </div>`
            : `<div class="kp-empty"><b>Rien sous la médiane</b>Les annonces actuelles sont au prix du marché (ou au-dessus).</div>`
      }

      ${
        mine.length
          ? `<div class="kp-section">
               <div class="kp-section-title">Mes annonces (${mine.length})</div>
               <div class="kp-table">
                 ${mine
                   .slice(0, 20)
                   .map(
                     (l) => `
                   <div class="kp-row" data-act="open-card" data-id="${esc(l.characterId)}">
                     <span></span>
                     <img src="${esc(imgSrc(state.characters.get(String(l.characterId))))}" alt="" loading="lazy">
                     <div class="kp-row-main">
                       <div class="kp-row-name">${esc(state.characters.get(String(l.characterId))?.name ?? `Carte #${l.characterId}`)}</div>
                       <div class="kp-row-meta">${esc(l.type ?? 'fixed')} · ${esc(l.status ?? 'active')}</div>
                     </div>
                     <div class="kp-row-price"><b>◆ ${fmt(l.price)}</b></div>
                   </div>`
                   )
                   .join('')}
               </div>
             </div>`
          : ''
      }
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
        <label class="kp-toggle">
          <span>Mode simulation<small>Affiche le plan sans créer d’annonce</small></span>
          <input type="checkbox" data-setting="dryRun" ${state.settings.dryRun ? 'checked' : ''}>
        </label>
        <label class="kp-toggle">
          <span>Valorisation automatique<small>Calcule les prix manquants à l’ouverture</small></span>
          <input type="checkbox" data-setting="autoPrices" ${state.settings.autoPrices ? 'checked' : ''}>
        </label>

        <div class="kp-alert">
          Frais actuels : dépôt ${cfg.feePct} % (min ${cfg.feeMin} ◆) · taxe de vente ${cfg.taxPct} %.
          ${cfg.maxActive != null ? `Limite : ${cfg.maxActive} annonces actives.` : ''}
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
    const totals = sellTotals(plan);
    const blocker = sellBlocker(plan);
    const chakra = toNum(state.user?.chakra) ?? 0;
    const running = state.sell.running;
    const done = state.sell.done;

    ui.modal.hidden = false;
    ui.modalCard.innerHTML = `
      <div class="kp-modal-head">
        <b>Vente assistée · ${plan.length} carte(s)</b>
        <button class="kp-icon-btn" type="button" data-act="sell-close" ${running ? 'disabled' : ''}>✕</button>
      </div>
      <div class="kp-modal-body">
        <div class="kp-summary">
          <div><span>Brut</span><b>◆ ${fmt(totals.gross)}</b></div>
          <div><span>Net estimé</span><b>◆ ${fmt(totals.net)}</b></div>
          <div><span>Frais de dépôt</span><b>◆ ${fmt(totals.fees)}</b></div>
          <div><span>Taxe de vente</span><b>◆ ${fmt(totals.tax)}</b></div>
        </div>

        <div class="kp-hint">${totals.copies} annonce(s) au total · chakra dispo ◆ ${fmt(chakra)} · ${esc(
          state.settings.dryRun ? 'mode simulation' : `délai ${state.settings.gapMs} ms`
        )}</div>

        ${blocker ? `<div class="kp-alert is-bad">${esc(blocker)}</div>` : ''}

        <div class="kp-plan">
          ${plan
            .map(
              (row) => `
            <div class="kp-plan-row">
              <div class="kp-name">${esc(row.name)} <small>×${row.qty}</small></div>
              <input class="kp-input" type="number" min="1" step="1" value="${row.price}" data-sell-price="${esc(row.characterId)}" ${running ? 'disabled' : ''}>
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
              : `<button class="kp-btn is-primary" type="button" data-act="sell-run" ${blocker ? 'disabled' : ''}>Vendre ${totals.copies} annonce(s)</button>`
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
      case 'tab':
        state.tab = el.getAttribute('data-tab') || 'account';
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
      case 'calc-prices': {
        if (state.priceRun.running) return;
        const ids = [...new Set(state.collection.map((c) => String(c.characterId ?? c.id)))];
        loadPrices(ids, true);
        break;
      }
      case 'select-all': {
        for (const row of filteredDupes()) state.selected.add(row.id);
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
        a.click();
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
      if (checkbox.checked) state.selected.add(id);
      else state.selected.delete(id);
      render();
      return;
    }

    const setting = target.closest('[data-setting]');
    if (setting) {
      const key = setting.getAttribute('data-setting');
      let value;
      if (setting.type === 'checkbox') value = setting.checked;
      else value = Number(setting.value);
      if (typeof value === 'number' && !Number.isFinite(value)) return;
      state.settings[key] = value;
      persistSettings();
      if (key === 'ttlH') schedulePriceRun();
      render();
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

  function onInput(event) {
    const target = event.target;
    if (!target || typeof target.closest !== 'function') return;
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
      loadData
    };
  }

  boot();

  setInterval(() => {
    if (state.open && state.user && !state.loading && !state.priceRun.running && !state.sell?.running) {
      refreshLight();
    }
  }, 90000);

  console.info(`[Kyara+] v${VERSION} chargé`);
})();
