const ext = globalThis.browser ?? globalThis.chrome;

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
    reloadBtn.textContent = "Mettre à jour l'extension";
    reloadHint.textContent = 'Relit le dossier local, sans téléchargement.';
  }, 8000);
}

function doReload() {
  reloadBtn.disabled = true;
  reloadBtn.textContent = 'Rechargement…';
  reloadHint.textContent = 'Extension rechargée depuis le dossier local.';

  const finish = () => setTimeout(() => window.close(), 500);

  if (activeTab && activeTab.id != null) {
    ext.tabs
      .sendMessage(activeTab.id, { type: 'kp-reload' })
      .then(finish)
      .catch(() => {
        try {
          ext.runtime.reload();
        } catch {
          /* ignore */
        }
        finish();
      });
    return;
  }

  try {
    ext.runtime.reload();
  } catch {
    /* ignore */
  }
  finish();
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
    statusEl.textContent = 'Ouvre kyara.games pour activer Kyara+.';
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
    statusEl.textContent = 'Kyara+ est installé mais la page doit être rechargée (F5) pour s’activer.';
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
