/* Kyareeh+ — script de fond
 * Seul un contexte d'extension (et pas un content script) peut appeler runtime.reload().
 */
const ext = globalThis.browser ?? globalThis.chrome;

let pendingReload = null;

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
    }
  });
} catch {
  /* ignore */
}
