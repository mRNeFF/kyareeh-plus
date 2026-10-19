/* Kyareeh+ — script de page
 *
 * Observe UNIQUEMENT les réponses de `POST /api/packs/:id/open-many` déclenchées
 * par le site lui-même (ouverture manuelle d'un booster), afin de comptabiliser
 * les ouvertures réelles dans l'onglet Stat.
 *
 * Règles :
 *  - aucune requête n'est modifiée ni bloquée ;
 *  - rien n'est lu en dehors de cette réponse (pas de token, pas d'inventaire) ;
 *  - seuls l'id du booster et la rareté des cartes tirées sont transmis ;
 *  - toute erreur est avalée : le site continue de fonctionner normalement.
 */
(() => {
  'use strict';

  if (window.__kyareehOpenHook) return;
  // Drapeau de test : permet de vérifier le repli `wrappedJSObject` du content script.
  if (window.__kyareehDisablePageHook) return;
  window.__kyareehOpenHook = true;

  const MARKER = 'x-kyareeh';
  const PATTERN = /\/api\/packs\/([^/?#]+)\/open-many/;

  function packIdFrom(url) {
    if (typeof url !== 'string') return null;
    const match = url.match(PATTERN);
    if (!match) return null;
    try {
      return decodeURIComponent(match[1]);
    } catch {
      return match[1];
    }
  }

  function hasMarker(headers) {
    if (!headers) return false;
    try {
      if (typeof headers.get === 'function') return headers.get(MARKER) != null;
      if (Array.isArray(headers)) {
        return headers.some((pair) => Array.isArray(pair) && String(pair[0]).toLowerCase() === MARKER);
      }
      if (typeof headers === 'object') {
        return Object.keys(headers).some((key) => String(key).toLowerCase() === MARKER);
      }
    } catch {
      /* ignore */
    }
    return false;
  }

  /** Une entrée par booster ouvert, chaque entrée listant les cartes obtenues. */
  function extractResults(json) {
    const results = Array.isArray(json?.results) ? json.results : [];
    return results.map((result) => {
      const list = Array.isArray(result?.cards) ? result.cards : [];
      return list.map((raw) => {
        const card = raw?.character ?? raw?.card ?? raw;
        return {
          id: String(card?.id ?? card?.characterId ?? raw?.characterId ?? ''),
          rarity: String(card?.rarity ?? '').toUpperCase()
        };
      });
    });
  }

  function post(packId, results) {
    try {
      window.postMessage(
        { source: 'kyareeh', type: 'packs-open', data: { packId, results } },
        window.location.origin
      );
    } catch {
      /* ignore */
    }
  }

  function handleText(packId, text) {
    if (!packId || !text) return;
    try {
      const json = JSON.parse(text);
      if (!json || typeof json !== 'object') return;
      post(packId, extractResults(json));
    } catch {
      /* réponse non JSON : on ignore */
    }
  }

  // 1) fetch
  const originalFetch = window.fetch;  if (typeof originalFetch === 'function') {
    window.fetch = function kyareehFetch(input, init) {
      const response = originalFetch.apply(this, arguments);
      try {
        const url = typeof input === 'string' ? input : input && input.url ? input.url : '';
        const packId = packIdFrom(url);
        // Une ouverture de l'extension est marquée : jamais comptée deux fois.
        if (!packId || hasMarker(init && init.headers)) return response;
        return response.then((res) => {
          try {
            if (res && res.ok && typeof res.clone === 'function') {
              res
                .clone()
                .text()
                .then((text) => handleText(packId, text))
                .catch(() => {});
            }
          } catch {
            /* ignore */
          }
          return res;
        });
      } catch {
        return response;
      }
    };
  }

  // 2) XMLHttpRequest (repli si le site n'utilise pas fetch)
  const XHR = window.XMLHttpRequest;
  if (XHR && XHR.prototype) {
    const originalOpen = XHR.prototype.open;
    const originalSend = XHR.prototype.send;

    XHR.prototype.open = function kyareehOpen(method, url) {
      try {
        this.__kyareehUrl = typeof url === 'string' ? url : '';
      } catch {
        /* ignore */
      }
      return originalOpen.apply(this, arguments);
    };

    XHR.prototype.send = function kyareehSend() {
      try {
        const packId = packIdFrom(this.__kyareehUrl || '');
        if (packId) {
          this.addEventListener('load', () => {
            try {
              if (this.status !== 200) return;
              const type = this.responseType;
              if (type && type !== 'text' && type !== 'json') return;
              if (type === 'json') {
                if (this.response && typeof this.response === 'object') {
                  post(packId, extractResults(this.response));
                }
                return;
              }
              handleText(packId, this.responseText);
            } catch {
              /* ignore */
            }
          });
        }
      } catch {
        /* ignore */
      }
      return originalSend.apply(this, arguments);
    };
  }
})();
