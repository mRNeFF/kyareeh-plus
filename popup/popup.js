const ext = globalThis.browser ?? globalThis.chrome;

// Le même popup sert Firefox et Chrome : seul le texte de secours change.
const IS_GECKO = /firefox\//i.test(navigator.userAgent);
const MANUAL_RELOAD_HINT = IS_GECKO
  ? 'Échec : recharge manuellement dans about:debugging.'
  : 'Échec : recharge manuellement dans chrome://extensions.';

const statusEl = document.getElementById('status');
const openBtn = document.getElementById('open');
const siteEl = document.getElementById('site');const reloadBtn = document.getElementById('reload');
const reloadHint = document.getElementById('reload-hint');
const versionEl = document.getElementById('version');

let activeTab = null;
let armed = false;

try {
  versionEl.textContent = `v${ext.runtime.getManifest().version}`;
} catch {
  /* ignore */
}

async function getActiveTab() {
  try {
    const tabs = await ext.tabs.query({ active: true, currentWindow: true });
    return tabs && tabs[0] ? tabs[0] : null;
  } catch {
    return null;
  }
}

function armReload() {
  armed = true;
  reloadBtn.classList.add('is-armed');
  reloadBtn.textContent = 'Confirmer le rechargement';
  reloadHint.textContent = 'La page sera rafraîchie automatiquement.';
  setTimeout(() => {
    if (!armed) return;
    armed = false;
    reloadBtn.classList.remove('is-armed');
    reloadBtn.textContent = 'Recharger les fichiers locaux';
    reloadHint.textContent = 'Relit le dossier local, sans téléchargement. Une vraie mise à jour vient du magasin.';
  }, 8000);
}

function doReload() {
  reloadBtn.disabled = true;
  reloadBtn.textContent = 'Rechargement…';
  reloadHint.textContent = 'Extension rechargée et page rafraîchie.';

  const finish = () => setTimeout(() => window.close(), 600);

  // Le fond est le seul contexte autorisé à appeler runtime.reload().
  // C'est aussi lui qui rafraîchit l'onglet : l'extension est coupée pendant
  // le rechargement, donc un appel tabs.reload() lancé d'ici ne partirait pas.
  ext.runtime
    .sendMessage({ type: 'kp-reload-extension' })
    .then((res) => {
      if (!res || !res.ok) throw new Error('refusé');
      finish();
    })
    .catch(() => {
      // Le fond n'a pas répondu : on tente le rechargement direct, puis la page.
      try {
        ext.runtime.reload();
      } catch {
        reloadHint.textContent = MANUAL_RELOAD_HINT;
      }
      finish();
    });
}

reloadBtn.addEventListener('click', () => {
  if (!armed) {
    armReload();
    return;
  }
  doReload();
});

async function init() {
  activeTab = await getActiveTab();

  if (!activeTab || !activeTab.url || !activeTab.url.includes('kyara.games')) {
    statusEl.textContent = 'Ouvre kyara.games pour activer Kyareeh+.';
    openBtn.textContent = 'Aller sur kyara.games';
    openBtn.addEventListener('click', () => {
      ext.tabs.create({ url: 'https://kyara.games/collection' });
    });
    return;
  }

  let status = null;
  try {
    status = await ext.tabs.sendMessage(activeTab.id, { type: 'kp-status' });
  } catch {
    status = null;
  }

  if (!status || !status.ok) {
    statusEl.textContent = 'Kyareeh+ est installé mais la page doit être rechargée (F5) pour s’activer.';
    openBtn.textContent = 'Recharger la page';
    openBtn.addEventListener('click', async () => {
      await ext.tabs.reload(activeTab.id);
      window.close();
    });
    return;
  }

  if (status.version) versionEl.textContent = `v${status.version}`;

  statusEl.textContent = status.user
    ? `Connecté en tant que ${status.user}.`
    : 'Pas encore connecté à Kyara (Discord).';

  openBtn.addEventListener('click', async () => {
    try {
      await ext.tabs.sendMessage(activeTab.id, { type: 'kp-toggle' });
      window.close();
    } catch {
      statusEl.textContent = 'Impossible d’ouvrir le panneau. Recharge la page.';
    }
  });
}

init();
