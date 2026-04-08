// b1dz Sync popup. STUB — wiring to /api/dealdash/connect comes later.
// For now just persists settings to chrome.storage.local so the cookie pull
// itself can be filled in once we ship the matching API route.

const $ = (id) => document.getElementById(id);

async function loadSettings() {
  const { endpoint = '', token = '' } = await chrome.storage.local.get(['endpoint', 'token']);
  $('endpoint').value = endpoint;
  $('token').value = token;
}

async function saveSettings() {
  await chrome.storage.local.set({ endpoint: $('endpoint').value, token: $('token').value });
}

async function syncCookies() {
  $('status').textContent = '(stub — TODO: wire to /api/dealdash/connect)';
  $('status').className = 'status err';
}

$('endpoint').addEventListener('change', saveSettings);
$('token').addEventListener('change', saveSettings);
$('sync').addEventListener('click', syncCookies);
loadSettings();
