/* Fenêtre Global autonome : le panneau n'a pas la session kyara.games.
 * Les appels /api/... sont relayés vers un onglet kyara.games ouvert. */
(() => {
  'use strict';
  const ext = globalThis.browser ?? globalThis.chrome;
  if (!ext?.runtime?.sendMessage) return;

  const nativeFetch = window.fetch.bind(window);

  window.fetch = async (input, init = {}) => {
    const raw = typeof input === 'string' ? input : input?.url || '';
    const path = raw.startsWith('https://kyara.games') ? raw.slice('https://kyara.games'.length) : raw;
    if (!path.startsWith('/api/')) return nativeFetch(input, init);

    let body;
    if (typeof init.body === 'string' && init.body) {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }

    let relay;
    try {
      relay = await ext.runtime.sendMessage({
        type: 'kp-api',
        path,
        method: init.method || 'GET',
        body,
        timeout: 20000
      });
    } catch (err) {
      relay = { ok: false, status: 0, error: String(err?.message || err) };
    }

    if (!relay || !relay.ok) {
      return new Response(JSON.stringify({ error: relay?.error || 'Relais indisponible' }), {
        status: Number(relay?.status) || 503,
        headers: { 'content-type': 'application/json' }
      });
    }
    return new Response(JSON.stringify(relay.data ?? null), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  };
})();
