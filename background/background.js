/* Kyareeh+ — script de fond
 * Seul un contexte d'extension (et pas un content script) peut appeler runtime.reload().
 * Gère aussi la fenêtre détachée du panneau complet (+Tools et +Duel) : une seule instance,
 * mémorisée dans storage.local pour survivre à l'endormissement du script de fond.
 */
const ext = globalThis.browser ?? globalThis.chrome;

let pendingReload = null;

/* ------------------------------------------------------------------ */
/* Panneau détaché : une seule fenêtre                                  */
/* ------------------------------------------------------------------ */

const PANEL_WINDOW_KEY = 'kyareeh.panel.window';
const PANEL_URL = 'panel/panel.html#kyareeh-panel';
const KYARA_TABS = 'https://kyara.games/*';
let panelOpening = null; // promesse en cours : évite deux fenêtres sur double clic

async function readPanelWindow() {
  try {
    const obj = await ext.storage.local.get(PANEL_WINDOW_KEY);
    return obj ? obj[PANEL_WINDOW_KEY] || null : null;
  } catch {
    return null;
  }
}

async function writePanelWindow(value) {
  try {
    if (value) await ext.storage.local.set({ [PANEL_WINDOW_KEY]: value });
    else await ext.storage.local.remove(PANEL_WINDOW_KEY);
  } catch {
    /* stockage indisponible */
  }
}

/** Fenêtre encore ouverte ? Nettoie la clé si elle est périmée (redémarrage, crash). */
async function livePanelWindow() {
  const saved = await readPanelWindow();
  if (!saved || saved.id == null) return null;
  try {
    return await ext.windows.get(saved.id);
  } catch {
    await writePanelWindow(null);
    return null;
  }
}

/** Ouvre le panneau complet dans sa fenêtre, ou remet au premier plan celle qui existe déjà. */
function detachPanel() {
  if (panelOpening) return panelOpening;
  panelOpening = (async () => {
    const existing = await livePanelWindow();
    if (existing) {
      try {
        await ext.windows.update(existing.id, { focused: true, drawAttention: true });
      } catch {
        /* fenêtre en cours de fermeture */
      }
      return { ok: true, reused: true, id: existing.id };
    }
    const win = await ext.windows.create({
      url: ext.runtime.getURL(PANEL_URL),
      type: 'popup',
      width: 1100,
      height: 820
    });
    await writePanelWindow({ id: win.id, at: Date.now() });
    return { ok: true, id: win.id };
  })()
    .catch((err) => ({ ok: false, error: String((err && err.message) || err) }))
    .finally(() => {
      panelOpening = null;
    });
  return panelOpening;
}

/** Rattache : ferme la fenêtre, le panneau de la page reprend la main (via la clé de stockage). */
async function attachPanel() {
  const existing = await livePanelWindow();
  await writePanelWindow(null);
  if (existing) {
    try {
      await ext.windows.remove(existing.id);
    } catch {
      /* déjà fermée */
    }
  }
  return { ok: true };
}

async function panelState() {
  const win = await livePanelWindow();
  return { ok: true, detached: Boolean(win), id: win ? win.id : null };
}

try {
  // Fermeture manuelle de la fenêtre : le panneau de la page reprend la main.
  ext.windows.onRemoved.addListener(async (windowId) => {
    const saved = await readPanelWindow();
    if (saved && saved.id === windowId) await writePanelWindow(null);
  });
} catch {
  /* API windows indisponible */
}

try {
  // Une fenêtre ne survit pas au redémarrage du navigateur : on oublie la précédente.
  ext.runtime.onStartup.addListener(() => writePanelWindow(null));
} catch {
  /* ignore */
}

/**
 * Recharge l'extension et rafraîchit l'onglet demandeur.
 * Important : l'onglet doit être rafraîchi AVANT runtime.reload(), car ce dernier
 * détruit le content script — un setTimeout(location.reload) lancé depuis la page
 * ne s'exécuterait jamais, et l'utilisateur resterait sur l'ancien code.
 */
function scheduleReload(tabId) {
  if (pendingReload) return;
  pendingReload = setTimeout(async () => {
    pendingReload = null;
    try {
      if (tabId != null) await ext.tabs.reload(tabId);
    } catch {
      /* onglet fermé ou permission refusée */
    }
    // Petite marge pour que la page commence à se recharger avant la coupure.
    setTimeout(() => {
      try {
        ext.runtime.reload();
      } catch {
        /* ignore */
      }
    }, 250);
  }, 100);
}

/**
 * Relais API pour la fenêtre détachée : une page d'extension n'a pas la session
 * kyara.games, donc ses appels /api/... passent par un onglet du site resté ouvert
 * (le content script de cet onglet exécute la requête avec ses cookies et son jeton).
 * Les codes `no_kyara_tab` / `kyara_tab_unready` sont traduits en français par le panneau.
 */
async function relayApi(msg) {
  const path = String(msg.path || '');
  if (!path.startsWith('/api/')) return { ok: false, status: 0, error: 'Chemin API invalide.' };
  let tabs = [];
  try {
    tabs = (await ext.tabs.query({ url: KYARA_TABS })).filter((tab) => tab && tab.id != null);
  } catch {
    tabs = [];
  }
  if (!tabs.length) return { ok: false, status: 0, code: 'no_kyara_tab', error: 'no_kyara_tab' };
  // L'onglet actif d'abord, puis les autres : un onglet resté ouvert avant l'installation
  // de l'extension n'a pas de content script et refuse la connexion.
  tabs.sort((a, b) => Number(Boolean(b.active)) - Number(Boolean(a.active)));
  for (const tab of tabs) {
    try {
      const res = await ext.tabs.sendMessage(tab.id, {
        type: 'kp-api-request',
        path,
        method: msg.method || 'GET',
        body: msg.body,
        timeout: msg.timeout
      });
      if (res) return res;
    } catch {
      /* content script absent de cet onglet : on essaie le suivant */
    }
  }
  return { ok: false, status: 0, code: 'kyara_tab_unready', error: 'kyara_tab_unready' };
}

/** Rechargement demandé depuis un onglet Global : on rafraîchit tous les onglets. */
async function reloadAllTabs() {
  let count = 0;
  try {
    const tabs = await ext.tabs.query({ url: KYARA_TABS });
    for (const tab of tabs) {
      if (tab?.id == null) continue;
      try {
        await ext.tabs.reload(tab.id);
        count += 1;
      } catch {
        /* onglet fermé */
      }
    }
  } catch {
    /* API tabs indisponible */
  }
  setTimeout(() => {
    try {
      ext.runtime.reload();
    } catch {
      /* ignore */
    }
  }, 400);
  return { ok: true, count };
}

/* ------------------------------------------------------------------ */
/* Mises à jour : version publiée sur AMO + recherche navigateur        */
/* ------------------------------------------------------------------ */

// Le magasin est la seule source servie aux utilisateurs : c'est cette version
// qu'il faut comparer à celle qui tourne, pas le dépôt GitHub.
const AMO_SLUG = 'kyareeh';
const STORE_VERSION_KEY = 'kyareeh.storeversion.v1';
const STORE_VERSION_TTL = 6 * 3600 * 1000;

/**
 * Dernière version **publiée** sur addons.mozilla.org (API publique, sans clé).
 * Mise en cache 6 h pour ne pas interroger le magasin à chaque ouverture.
 * Retourne aussi le statut du fichier : une version en relecture n'est pas
 * encore servie aux navigateurs.
 */
async function storeVersion(force) {
  const installed = ext.runtime.getManifest().version;
  if (!force) {
    try {
      const cached = (await ext.storage.local.get(STORE_VERSION_KEY))[STORE_VERSION_KEY];
      if (cached && Date.now() - Number(cached.at || 0) < STORE_VERSION_TTL) {
        return { ok: true, ...cached, installed, cached: true };
      }
    } catch {
      /* stockage indisponible : on interroge l'API */
    }
  }
  try {
    const res = await fetch(`https://addons.mozilla.org/api/v5/addons/addon/${AMO_SLUG}/?t=${Date.now()}`, {
      cache: 'no-store',
      credentials: 'omit'
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const record = {
      at: Date.now(),
      version: String(json?.current_version?.version ?? ''),
      fileStatus: String(json?.current_version?.file?.status ?? ''),
      channel: String(json?.current_version?.channel ?? ''),
      slug: String(json?.slug ?? AMO_SLUG),
      guid: String(json?.guid ?? '')
    };
    try {
      await ext.storage.local.set({ [STORE_VERSION_KEY]: record });
    } catch {
      /* cache non bloquant */
    }
    return { ok: true, ...record, installed, cached: false };
  } catch (err) {
    return { ok: false, installed, error: String((err && err.message) || err) };
  }
}

/**
 * Recherche de mise à jour du navigateur, quand l'API existe (Chrome / Edge).
 * Firefox n'expose pas `requestUpdateCheck` : c'est le service de mise à jour
 * de Firefox qui vérifie, au plus une fois toutes les 24 h (et au démarrage).
 */
function browserUpdateCheck() {
  const chromeApi = globalThis.chrome && globalThis.chrome.runtime;
  const request = chromeApi && typeof chromeApi.requestUpdateCheck === 'function' ? chromeApi.requestUpdateCheck : null;
  if (!request) {
    return Promise.resolve({
      ok: true,
      supported: false,
      engine: 'firefox',
      status: 'unsupported',
      message: 'Firefox vérifie les mises à jour lui-même (toutes les 24 h environ, et au démarrage).'
    });
  }
  return new Promise((resolve) => {
    let settled = false;
    const done = (payload) => {
      if (settled) return;
      settled = true;
      resolve(payload);
    };
    try {
      const maybe = request.call(chromeApi, (status, details) => {
        done({
          ok: true,
          supported: true,
          engine: 'chrome',
          status: String(status || ''),
          version: details && details.version ? String(details.version) : null
        });
      });
      if (maybe && typeof maybe.then === 'function') {
        maybe
          .then((result) =>
            done({
              ok: true,
              supported: true,
              engine: 'chrome',
              status: String(result?.status || ''),
              version: result?.version ? String(result.version) : null
            })
          )
          .catch((err) => done({ ok: false, supported: true, engine: 'chrome', error: String((err && err.message) || err) }));
      }
    } catch (err) {
      done({ ok: false, supported: true, engine: 'chrome', error: String((err && err.message) || err) });
    }
    setTimeout(() => done({ ok: false, supported: true, engine: 'chrome', status: 'timeout' }), 5000);
  });
}

try {
  ext.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'kp-store-version') {
      storeVersion(Boolean(msg.force)).then(sendResponse);
      return true;
    }

    if (msg.type === 'kp-update-check') {
      browserUpdateCheck().then(sendResponse);
      return true;
    }

    if (msg.type === 'kp-reload-extension') {
      const tabId = sender && sender.tab ? sender.tab.id : null;
      sendResponse({ ok: true, version: ext.runtime.getManifest().version, tab: tabId });
      scheduleReload(tabId);
      return true;
    }

    if (msg.type === 'kp-reload-all') {
      reloadAllTabs().then(sendResponse);
      return true;
    }

    if (msg.type === 'kp-panel-detach') {
      detachPanel().then(sendResponse);
      return true;
    }

    if (msg.type === 'kp-panel-attach') {
      attachPanel().then(sendResponse);
      return true;
    }

    if (msg.type === 'kp-panel-state') {
      panelState().then(sendResponse);
      return true;
    }

    if (msg.type === 'kp-api') {
      relayApi(msg).then(sendResponse);
      return true;
    }

    if (msg.type === 'kp-manifest-version') {
      sendResponse({ ok: true, version: ext.runtime.getManifest().version });
      return true;
    }
  });
} catch {
  /* ignore */
}
