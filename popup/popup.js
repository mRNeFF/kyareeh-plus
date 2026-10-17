const ext = globalThis.browser ?? globalThis.chrome;

const statusEl = document.getElementById('status');
const openBtn = document.getElementById('open');
const siteEl = document.getElementById('site');

async function getActiveTab() {
  try {
    const tabs = await ext.tabs.query({ active: true, currentWindow: true });
    return tabs && tabs[0] ? tabs[0] : null;
  } catch {
    return null;
  }
}

async function init() {
  const tab = await getActiveTab();

  if (!tab || !tab.url || !tab.url.includes('kyara.games')) {
    statusEl.textContent = 'Ouvre kyara.games pour activer Kyara+.';
    openBtn.textContent = 'Aller sur kyara.games';
    openBtn.addEventListener('click', () => {
      ext.tabs.create({ url: 'https://kyara.games/collection' });
    });
    return;
  }

  let status = null;
  try {
    status = await ext.tabs.sendMessage(tab.id, { type: 'kp-status' });
  } catch {
    status = null;
  }

  if (!status || !status.ok) {
    statusEl.textContent = 'Kyara+ est installé mais la page doit être rechargée (F5) pour s’activer.';
    openBtn.textContent = 'Recharger la page';
    openBtn.addEventListener('click', async () => {
      await ext.tabs.reload(tab.id);
      window.close();
    });
    return;
  }

  statusEl.textContent = status.user
    ? `Connecté en tant que ${status.user}.`
    : 'Pas encore connecté à Kyara (Discord).';

  openBtn.addEventListener('click', async () => {
    try {
      await ext.tabs.sendMessage(tab.id, { type: 'kp-toggle' });
      window.close();
    } catch {
      statusEl.textContent = 'Impossible d’ouvrir le panneau. Recharge la page.';
    }
  });
}

init();
