/* Kyareeh+ — script de fond
 * Seul un contexte d'extension (et pas un content script) peut appeler runtime.reload().
 */
const ext = globalThis.browser ?? globalThis.chrome;

let pendingReload = null;

function scheduleReload() {
  if (pendingReload) return;
  pendingReload = setTimeout(() => {
    pendingReload = null;
    try {
      ext.runtime.reload();
    } catch {
      /* ignore */
    }
  }, 150);
}

try {
  ext.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'kp-reload-extension') {
      sendResponse({ ok: true, version: ext.runtime.getManifest().version });
      scheduleReload();
      return;
    }

    if (msg.type === 'kp-manifest-version') {
      sendResponse({ ok: true, version: ext.runtime.getManifest().version });
    }
  });
} catch {
  /* ignore */
}
