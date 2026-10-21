/* Kyareeh+ — script de fond
 * Seul un contexte d'extension (et pas un content script) peut appeler runtime.reload().
 * Gère aussi la fenêtre détachée du duel (docs/DUEL-V2.md §3) : une seule instance à la fois.
 */
const ext = globalThis.browser ?? globalThis.chrome;

let pendingReload = null;

/* ------------------------------------------------------------------ */
/* Duel détaché : une seule fenêtre, mémorisée dans storage.local       */
/* ------------------------------------------------------------------ */

const DUEL_WINDOW_KEY = 'kyareeh.duel.window';
const DUEL_URL = 'duel/duel.html';
let duelOpening = null; // promesse en cours : évite deux fenêtres sur double clic

async function readDuelWindow() {
  try {
    const obj = await ext.storage.local.get(DUEL_WINDOW_KEY);
    return obj ? obj[DUEL_WINDOW_KEY] || null : null;
  } catch {
    return null;
  }
}

async function writeDuelWindow(value) {
  try {
    if (value) await ext.storage.local.set({ [DUEL_WINDOW_KEY]: value });
    else await ext.storage.local.remove(DUEL_WINDOW_KEY);
  } catch {
    /* stockage indisponible */
  }
}

/** Fenêtre du duel encore ouverte ? Nettoie la clé si elle est périmée (redémarrage, crash). */
async function liveDuelWindow() {
  const saved = await readDuelWindow();
  if (!saved || saved.id == null) return null;
  try {
    return await ext.windows.get(saved.id);
  } catch {
    await writeDuelWindow(null);
    return null;
  }
}

async function detachDuel() {
  if (duelOpening) return duelOpening;
  duelOpening = (async () => {
    const existing = await liveDuelWindow();
    if (existing) {
      try {
        await ext.windows.update(existing.id, { focused: true });
      } catch {
        /* fenêtre en cours de fermeture */
      }
      return { ok: true, reused: true, id: existing.id };
    }
    const win = await ext.windows.create({
      url: ext.runtime.getURL(DUEL_URL),
      type: 'popup',
      width: 1100,
      height: 760
    });
    await writeDuelWindow({ id: win.id, at: Date.now() });
    return { ok: true, id: win.id };
  })()
    .catch((err) => ({ ok: false, error: String((err && err.message) || err) }))
    .finally(() => {
      duelOpening = null;
    });
  return duelOpening;
}

async function attachDuel() {
  const existing = await liveDuelWindow();
  await writeDuelWindow(null);
  if (existing) {
    try {
      await ext.windows.remove(existing.id);
    } catch {
      /* déjà fermée */
    }
  }
  return { ok: true };
}

try {
  // Fermeture manuelle de la fenêtre : le panneau reprend l'application.
  ext.windows.onRemoved.addListener(async (windowId) => {
    const saved = await readDuelWindow();
    if (saved && saved.id === windowId) await writeDuelWindow(null);
  });
} catch {
  /* API windows indisponible */
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

try {
  ext.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'kp-reload-extension') {
      const tabId = sender && sender.tab ? sender.tab.id : null;
      sendResponse({ ok: true, version: ext.runtime.getManifest().version, tab: tabId });
      scheduleReload(tabId);
      return;
    }

    if (msg.type === 'kp-manifest-version') {
      sendResponse({ ok: true, version: ext.runtime.getManifest().version });
      return;
    }

    if (msg.type === 'kp-duel-detach') {
      detachDuel().then(sendResponse);
      return true; // réponse asynchrone
    }

    if (msg.type === 'kp-duel-attach') {
      attachDuel().then(sendResponse);
      return true;
    }
  });
} catch {
  /* ignore */
}
