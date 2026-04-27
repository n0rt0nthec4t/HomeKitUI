'use strict';

let state = {
  page: 'status',
  info: {},
  homekit: {},
  config: {},
  schema: {},
  uiSchema: {},
  logs: [],
  error: undefined,
};

let corePages = [
  { id: 'status', title: 'Status', icon: '⌂' },
  { id: 'configuration', title: 'Configuration', icon: '⚙' },
  { id: 'logs', title: 'Logs', icon: '☰' },
  { id: 'maintenance', title: 'Maintenance', icon: '⌘' },
];

async function api(path, options = {}) {
  let response = await fetch(path, options);
  let data = await response.json().catch(() => ({}));

  if (response.ok !== true) {
    throw new Error(data.error || 'Request failed');
  }

  return data;
}

async function load() {
  try {
    state.info = await api('/api/info');
    state.homekit = await api('/api/homekit');
    state.logs = (await api('/api/logs')).logs || [];
  } catch (error) {
    state.error = String(error.message || error);
  }

  render();
}

function render() {
  let pages = [...corePages, ...(Array.isArray(state.info.pages) ? state.info.pages : [])];

  document.getElementById('app').innerHTML = `
    <aside>
      <div class="brand">⌂</div>

      ${pages
        .map(
          (page) => `
            <button
              class="${state.page === page.id ? 'active' : ''}"
              title="${escapeHTML(page.title)}"
              onclick="setPage('${escapeHTML(page.id)}')"
            >
              ${icon(page.icon)}
            </button>
          `,
        )
        .join('')}
    </aside>

    <main>
      ${state.error !== undefined ? `<div class="error">${escapeHTML(state.error)}</div>` : ''}
      ${state.page === 'status' ? statusPage() : ''}
      ${state.page === 'configuration' ? configurationPage() : ''}
      ${state.page === 'logs' ? logsPage() : ''}
      ${state.page === 'maintenance' ? maintenancePage() : ''}
      ${projectPage()}
    </main>
  `;
}

function statusPage() {
  return `
    <h1>Status</h1>

    <section class="pairing-card">
      ${state.homekit.qrCode ? `<img class="qr" src="${state.homekit.qrCode}" alt="HomeKit QR Code">` : '<div class="qr-missing">QR unavailable</div>'}

      <div class="pin">${escapeHTML(state.homekit.pincode || '--- -- ---')}</div>

      <div class="pairing-status">
        <span>HAP</span>
        <span>•</span>
        <span class="${state.homekit.paired ? 'paired' : 'unpaired'}">
          ${state.homekit.paired ? 'Paired' : 'Not Paired'}
        </span>
      </div>

      <div class="meta">${escapeHTML(state.homekit.username || '')}</div>
      <div class="meta">${escapeHTML(state.info.name || 'HomeKit Device')} v${escapeHTML(state.info.version || '')}</div>
    </section>
  `;
}

function configurationPage() {
  return `
    <h1>Configuration</h1>

    <section class="card">
      <div class="card-title">Configuration Editor</div>
      <div class="card-description">
        Edit the current configuration. A restart may be required after saving.
      </div>

      <div class="actions">
        <button onclick="loadConfig()">Load</button>
        <button onclick="saveConfig()">Save</button>
      </div>

      <textarea id="configText" spellcheck="false">${escapeHTML(JSON.stringify(state.config, null, 2))}</textarea>
    </section>
  `;
}

function logsPage() {
  return `
    <h1>Logs</h1>

    <section class="card">
      <div class="actions">
        <button onclick="refreshLogs()">Refresh</button>
      </div>

      <pre>${escapeHTML(formatLogs(state.logs))}</pre>
    </section>
  `;
}

function maintenancePage() {
  return `
    <h1>Maintenance</h1>

    <section class="card">
      <div class="card-title">Service</div>
      <div class="card-description">Restart the host application after configuration changes.</div>

      <div class="actions">
        <button onclick="restartService()">Restart Service</button>
        <a class="button" href="/api/backup">Download Config Backup</a>
      </div>
    </section>

    <section class="card danger-card">
      <div class="card-title">HomeKit Pairing</div>
      <div class="card-description">
        Resetting HomeKit pairing removes all paired controllers. You will need to add the accessory again in the Home app.
      </div>

      <div class="actions">
        <button class="danger" onclick="resetPairing()">Reset HomeKit Pairing</button>
      </div>
    </section>
  `;
}

function projectPage() {
  let page = (state.info.pages || []).find((item) => item.id === state.page);

  if (page === undefined) {
    return '';
  }

  return `
    <h1>${escapeHTML(page.title)}</h1>

    <section class="card">
      <div class="card-title">${escapeHTML(page.title)}</div>
      <div class="card-description">
        This page is provided by the project schema path: <code>${escapeHTML(page.schemaPath || '')}</code>
      </div>

      <div class="actions">
        <button onclick="loadConfig()">Load Configuration</button>
      </div>

      <textarea id="configText" spellcheck="false">${escapeHTML(JSON.stringify(getSchemaPathValue(page.schemaPath), null, 2))}</textarea>
    </section>
  `;
}

async function setPage(page) {
  state.page = page;
  state.error = undefined;

  if (page === 'logs') {
    await refreshLogs(false);
  }

  render();
}

async function loadConfig() {
  try {
    state.config = await api('/api/config');
    state.schema = await api('/api/schema');
    state.uiSchema = await api('/api/ui-schema');
  } catch (error) {
    state.error = String(error.message || error);
  }

  render();
}

async function saveConfig() {
  try {
    let text = document.getElementById('configText')?.value;

    if (typeof text !== 'string') {
      throw new Error('Configuration editor is not available');
    }

    let config = JSON.parse(text);

    await api('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
    });

    state.config = config;
    alert('Configuration saved. Restart may be required.');
  } catch (error) {
    alert(String(error.message || error));
  }
}

async function refreshLogs(doRender = true) {
  try {
    state.logs = (await api('/api/logs')).logs || [];
  } catch (error) {
    state.error = String(error.message || error);
  }

  if (doRender === true) {
    render();
  }
}

async function restartService() {
  if (confirm('Restart service now?') !== true) {
    return;
  }

  try {
    await api('/api/service/restart', { method: 'POST' });
  } catch (error) {
    alert(String(error.message || error));
  }
}

async function resetPairing() {
  if (confirm('Reset HomeKit pairing? This removes all paired controllers.') !== true) {
    return;
  }

  try {
    await api('/api/homekit/reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: state.homekit.username }),
    });

    alert('HomeKit pairing reset. Restart and re-pair in the Home app.');
  } catch (error) {
    alert(String(error.message || error));
  }
}

function getSchemaPathValue(schemaPath) {
  if (typeof schemaPath !== 'string' || schemaPath === '') {
    return state.config;
  }

  return schemaPath.split('.').reduce((value, key) => value?.[key], state.config);
}

function formatLogs(logs) {
  if (Array.isArray(logs) === false) {
    return '';
  }

  return logs
    .map((entry) => {
      if (typeof entry === 'string') {
        return entry;
      }

      if (entry !== null && typeof entry === 'object') {
        return JSON.stringify(entry);
      }

      return String(entry);
    })
    .join('\n');
}

function icon(value) {
  let icons = {
    home: '⌂',
    status: '⌂',
    config: '⚙',
    settings: '⚙',
    logs: '☰',
    terminal: '☰',
    maintenance: '⌘',
    wrench: '⌘',
    tank: '◌',
    droplet: '◌',
    zones: '☷',
    sprinkler: '☷',
  };

  return icons[value] || value || '•';
}

function escapeHTML(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

load();