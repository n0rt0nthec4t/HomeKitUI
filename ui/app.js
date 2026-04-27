/* global EventSource, alert, confirm, document, fetch, window */
'use strict';

// Runtime UI state shared across all render functions
let state = {
  page: 'status',
  info: {},
  homekit: {},
  config: {},
  schema: {},
  uiSchema: {},
  pageData: {},
  logs: [],
  error: undefined,
};

// Core UI always includes the status page only
let corePages = [{ id: 'status', title: 'Status', icon: 'home' }];
let logStream = undefined;
let logsPaused = false;
let logsAutoScroll = true;
let uptimeSeconds = 0;

// Simple API wrapper with error handling
async function api(apiPath, options = {}) {
  let response = await fetch(apiPath, options);
  let data = await response.json().catch(() => ({}));

  if (response.ok !== true) {
    throw new Error(data.error || 'Request failed');
  }

  return data;
}

// Initial load of UI data from backend
async function load() {
  try {
    state.info = await api('/api/info');

    if (Number.isFinite(Number(state.info?.uptime)) === true) {
      uptimeSeconds = Number(state.info.uptime);
    }

    applyTheme(state.info.theme);

    state.homekit = await api('/api/homekit');
    state.logs = (await api('/api/logs')).logs || [];
  } catch (error) {
    state.error = String(error.message || error);
  }

  render();
  startLogStream();
}

// Main render function - builds entire UI
function render() {
  let pages = [...corePages, ...(Array.isArray(state.info.pages) === true ? state.info.pages : [])];

  document.getElementById('app').innerHTML = `
    <aside>
      ${pages
        .map(
          (page) => `
            <button
              class="${state.page === page.id ? 'active' : ''}"
              title="${escapeHTML(page.title)}"
              onclick="setPage('${escapeHTML(page.id)}')"
            >
              ${icon(page)}
            </button>
          `,
        )
        .join('')}
    </aside>

    <main>
      ${state.error !== undefined ? `<div class="error">${escapeHTML(state.error)}</div>` : ''}
      ${state.page === 'status' ? statusPage() : ''}
      ${state.page !== 'status' ? projectPage() : ''}
    </main>
  `;

  renderLogsOnly(false);
}

// Status page combines pairing + logs
function statusPage() {
  return `
    <h1>HomeKit Status</h1>

    <div class="status-layout">
      ${pairingCard()}
    </div>

    ${logsCard()}
  `;
}

// HomeKit pairing information card
function pairingCard() {
  return `
    <section class="pairing-card">
      <div class="pairing-title">${escapeHTML(state.info.name || 'HomeKit Device')}</div>

      <div class="pairing-content">
        <div class="pairing-left">
          ${
            state.homekit.qrCode
              ? `<img class="qr" src="${state.homekit.qrCode}" alt="HomeKit QR Code">`
              : '<div class="qr-missing">QR unavailable</div>'
          }

          <div class="pin">${escapeHTML(state.homekit.pincode || '--- -- ---')}</div>

          <div class="pairing-status">
            <span class="hap-icon">${homeIcon()}</span>
            <span>HAP</span>
            <span>•</span>
            <button
              class="pairing-state ${state.homekit.paired === true ? 'paired' : 'unpaired'}"
              title="${state.homekit.paired === true ? 'Reset HomeKit Pairing' : 'Not Paired'}"
              onclick="${state.homekit.paired === true ? 'resetPairing()' : ''}"
              data-dynamic="pairing"
            >
              ${linkIcon()}
            </button>
          </div>

          <div class="meta">${escapeHTML(state.homekit.username || '')}</div>
        </div>

        <div class="pairing-right">
          <div class="pairing-actions vertical">
            <button title="Restart" onclick="restartService()">
              ${restartIcon()}
            </button>

            <a title="Backup" href="/api/backup">
              ${downloadIcon()}
            </a>
          </div>

          <div class="details">
            <div>App v${escapeHTML(state.info.version || '')}</div>
            <div>UI v${escapeHTML(state.info.uiVersion || '')}</div>
            <div>Port ${escapeHTML(state.info.port || '')}</div>
            <div>Uptime <span id="uptime">${escapeHTML(formatUptime(uptimeSeconds))}</span></div>
          </div>
        </div>
      </div>
    </section>
  `;
}

// Logs card renders live log output
function logsCard() {
  return `
    <section class="card logs-card">
      <div class="logs-header">
        <div class="logs-title">Log</div>

        <div class="logs-controls">
          <button title="Pause logs" onclick="togglePause()">Pause</button>
          <button title="Clear logs" onclick="clearLogs()">Clear</button>
          <button title="Toggle auto-scroll" onclick="toggleScroll()">Scroll</button>
        </div>
      </div>

      <div id="logs" class="log-output"></div>
    </section>
  `;
}

// Project-specific page renderer
function projectPage() {
  let page = (state.info.pages || []).find((item) => item.id === state.page);

  if (page === undefined) {
    return '';
  }

  let data = state.pageData[page.id];

  if (data !== undefined && data !== null && data.type === 'list' && Array.isArray(data.items) === true) {
    return renderListPage(page, data);
  }

  return renderConfigPage(page);
}

// Generic list page renderer
function renderListPage(page, data) {
  return `
    <h1>${escapeHTML(page.title)}</h1>

    <section class="card">
      <div class="card-title">${escapeHTML(page.title)}</div>

      <div class="list">
        ${data.items
          .map(
            (item) => `
              <div class="list-row">
                <div>
                  <div class="list-title">${escapeHTML(item.title || '')}</div>
                  <div class="list-sub">${escapeHTML(item.subtitle || '')}</div>
                </div>

                ${item.value !== undefined ? `<div class="list-value">${escapeHTML(String(item.value))}</div>` : ''}
              </div>
            `,
          )
          .join('')}
      </div>
    </section>
  `;
}

// Fallback config page renderer
function renderConfigPage(page) {
  return `
    <h1>${escapeHTML(page.title)}</h1>

    <section class="card">
      <div class="card-title">${escapeHTML(page.title)}</div>
      <div class="card-description">
        Project configuration section: <code>${escapeHTML(page.schemaPath || '')}</code>
      </div>

      <div class="actions">
        <button onclick="loadConfig()">Load Configuration</button>
        <button onclick="saveConfig()">Save Configuration</button>
      </div>

      <textarea id="configText" spellcheck="false">${escapeHTML(JSON.stringify(getSchemaPathValue(page.schemaPath), null, 2))}</textarea>
    </section>
  `;
}

// Change active page and load data if required
async function setPage(page) {
  state.page = page;
  state.error = undefined;

  if (page !== 'status') {
    await loadPageData(page);

    if (Object.keys(state.config).length === 0) {
      await loadConfig(false);
    }
  }

  render();
}

// Load dynamic page data from backend
async function loadPageData(pageId) {
  try {
    state.pageData[pageId] = await api(`/api/page/${pageId}`);
    // eslint-disable-next-line no-unused-vars
  } catch (error) {
    state.pageData[pageId] = undefined;
  }
}

// Load config + schema from backend
async function loadConfig(doRender = true) {
  try {
    state.config = await api('/api/config');
    state.schema = await api('/api/schema');
    state.uiSchema = await api('/api/ui-schema');
  } catch (error) {
    state.error = String(error.message || error);
  }

  if (doRender === true) {
    render();
  }
}

// Save config back to backend
async function saveConfig() {
  try {
    let text = document.getElementById('configText')?.value;

    if (typeof text !== 'string') {
      throw new Error('Configuration editor is not available');
    }

    let page = (state.info.pages || []).find((item) => item.id === state.page);
    let value = JSON.parse(text);

    if (page?.schemaPath !== undefined) {
      setSchemaPathValue(page.schemaPath, value);
    } else {
      state.config = value;
    }

    await api('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(state.config),
    });

    alert('Configuration saved. Restart may be required.');
  } catch (error) {
    alert(String(error.message || error));
  }
}

// Start live log stream from HomeKitUI
function startLogStream() {
  if (logStream !== undefined) {
    return;
  }

  logStream = new EventSource('/api/logs/stream');

  logStream.onmessage = (event) => {
    try {
      let entry = JSON.parse(event.data);

      if (entry !== null && typeof entry === 'object') {
        state.logs.push(entry);

        while (state.logs.length > 500) {
          state.logs.shift();
        }

        appendLog(entry);
      }
      // eslint-disable-next-line no-unused-vars
    } catch (error) {
      // Ignore malformed stream entries
    }
  };

  logStream.onerror = () => {
    // Browser EventSource reconnects automatically
  };
}

// Append a single live log entry without re-rendering the full page
function appendLog(entry) {
  if (logsPaused === true) {
    return;
  }

  let logs = document.getElementById('logs');

  if (logs === null) {
    return;
  }

  let div = document.createElement('div');

  div.className = 'log-line ' + escapeClassName(entry.level || 'info');
  div.innerHTML = typeof entry.html === 'string' ? entry.html : escapeHTML(entry.message || '');

  logs.appendChild(div);

  if (logsAutoScroll === true) {
    logs.scrollTop = logs.scrollHeight;
  }
}

// Render current log history into the log output element
function renderLogsOnly(scroll = true) {
  let logs = document.getElementById('logs');

  if (logs === null) {
    return;
  }

  logs.innerHTML = state.logs.map(formatLogLine).join('');

  if (scroll === true && logsAutoScroll === true) {
    logs.scrollTop = logs.scrollHeight;
  }
}

// Poll backend status periodically while uptime is updated locally every second
function startStatusPolling() {
  window.setInterval(async () => {
    try {
      let latestInfo = await api('/api/info');
      let latestHomeKit = await api('/api/homekit');

      state.info = latestInfo;

      if (Number.isFinite(Number(latestInfo?.uptime)) === true) {
        uptimeSeconds = Number(latestInfo.uptime);
      }

      applyTheme(state.info.theme);

      if (latestHomeKit.paired !== state.homekit.paired) {
        state.homekit = latestHomeKit;
        updatePairingUI();
      }
      // eslint-disable-next-line no-unused-vars
    } catch (error) {
      // Ignore transient failures
    }
  }, 30000);
}

// Update uptime locally so the status card feels live without polling every second
function startUptime() {
  window.setInterval(() => {
    uptimeSeconds++;

    let uptime = document.getElementById('uptime');

    if (uptime !== null) {
      uptime.textContent = formatUptime(uptimeSeconds);
    }
  }, 1000);
}

// Update only the pairing icon state without full re-render
function updatePairingUI() {
  let el = document.querySelector('.pairing-state');

  if (el === null) {
    return;
  }

  el.classList.toggle('paired', state.homekit.paired === true);
  el.classList.toggle('unpaired', state.homekit.paired !== true);

  el.title = state.homekit.paired === true ? 'Reset HomeKit Pairing' : 'Not Paired';

  if (state.homekit.paired === true) {
    el.setAttribute('onclick', 'resetPairing()');
  } else {
    el.removeAttribute('onclick');
  }
}

// Format one log entry as safe HTML
function formatLogLine(entry) {
  if (entry === null || typeof entry !== 'object') {
    return '';
  }

  let level = escapeClassName(entry.level || 'info');
  let html = typeof entry.html === 'string' ? entry.html : escapeHTML(entry.message || '');

  return `<div class="log-line ${level}">${html}</div>`;
}

// Apply optional project-provided theme colours
function applyTheme(theme) {
  if (theme === null || typeof theme !== 'object') {
    return;
  }

  if (typeof theme.accent === 'string' && theme.accent !== '') {
    document.documentElement.style.setProperty('--accent', theme.accent);
  }

  if (typeof theme.accentLight === 'string' && theme.accentLight !== '') {
    document.documentElement.style.setProperty('--accent-light', theme.accentLight);
  }

  if (typeof theme.background === 'string' && theme.background !== '') {
    document.documentElement.style.setProperty('--background', theme.background);
  }

  if (typeof theme.card === 'string' && theme.card !== '') {
    document.documentElement.style.setProperty('--card', theme.card);
  }

  if (typeof theme.text === 'string' && theme.text !== '') {
    document.documentElement.style.setProperty('--text', theme.text);
  }
}

// Toggle live log appending
function togglePause() {
  logsPaused = logsPaused === true ? false : true;
}

// Clear browser-side log view
function clearLogs() {
  state.logs = [];
  renderLogsOnly(false);
}

// Toggle automatic scrolling when logs arrive
function toggleScroll() {
  logsAutoScroll = logsAutoScroll === true ? false : true;
}

// Format uptime seconds into short display string
function formatUptime(seconds) {
  if (Number.isFinite(Number(seconds)) === false) {
    return '';
  }

  let totalSeconds = Math.floor(Number(seconds));
  let days = Math.floor(totalSeconds / 86400);
  let hours = Math.floor((totalSeconds % 86400) / 3600);
  let minutes = Math.floor((totalSeconds % 3600) / 60);

  if (days > 0) {
    return days + 'd ' + hours + 'h';
  }

  return hours + 'h ' + minutes + 'm';
}

// Restart service via API
async function restartService() {
  if (confirm('Restart service now?') !== true) {
    return;
  }

  await api('/api/service/restart', { method: 'POST' });
}

// Reset HomeKit pairing
async function resetPairing() {
  if (confirm('Reset HomeKit pairing? This removes all paired controllers.') !== true) {
    return;
  }

  await api('/api/homekit/reset', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: state.homekit.username }),
  });

  alert('Pairing reset. Restart and re-pair.');
}

// Safely get nested config path
function getSchemaPathValue(schemaPath) {
  if (schemaPath === undefined || schemaPath === '') {
    return state.config;
  }

  return schemaPath.split('.').reduce((value, key) => {
    if (value === undefined || value === null) {
      return undefined;
    }

    return value[key];
  }, state.config);
}

// Safely set nested config path
function setSchemaPathValue(schemaPath, value) {
  let keys = schemaPath.split('.');
  let target = state.config;

  keys.slice(0, -1).forEach((key) => {
    if (target[key] === undefined || typeof target[key] !== 'object') {
      target[key] = {};
    }

    target = target[key];
  });

  target[keys.at(-1)] = value;
}

// Escape HTML safely
function escapeHTML(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll('\'', '&#039;');
}

// Restrict dynamic class names to safe characters
function escapeClassName(value) {
  return String(value ?? '').replaceAll(/[^a-zA-Z0-9_-]/g, '');
}

// Icon mapping
function icon(page) {
  if (typeof page?.svg === 'string' && page.svg.trim() !== '' && page.svg.includes('<svg') === true) {
    return page.svg;
  }

  let icons = {
    home: homeIcon(),
    settings: gearIcon(),
    list: listIcon(),
  };

  if (typeof page?.icon === 'string' && icons[page.icon] !== undefined) {
    return icons[page.icon];
  }

  return '<span class="icon-dot"></span>';
}

// SVG home icon
function homeIcon() {
  return '<svg viewBox="0 0 24 24">' + '<path d="M3 11.5 12 3l9 8.5"/>' + '<path d="M5.5 10.5V21h13V10.5"/>' + '</svg>';
}

// SVG settings icon
function gearIcon() {
  return '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/></svg>';
}

// SVG list icon
function listIcon() {
  return '<svg viewBox="0 0 24 24"><path d="M4 6h16M4 12h16M4 18h16"/></svg>';
}

// SVG linked icon
function linkIcon() {
  return (
    '<svg viewBox="0 0 24 24">' +
    '<path d="M10 13a5 5 0 0 0 7 0l2-2a5 5 0 0 0-7-7l-1 1"/>' +
    '<path d="M14 11a5 5 0 0 0-7 0l-2 2a5 5 0 0 0 7 7l1-1"/>' +
    '</svg>'
  );
}

// SVG restart icon
function restartIcon() {
  return '<svg viewBox="0 0 24 24">' + '<path d="M21 12a9 9 0 1 1-3-6.7"/>' + '<path d="M21 3v6h-6"/>' + '</svg>';
}

// SVG download icon
function downloadIcon() {
  return '<svg viewBox="0 0 24 24">' + '<path d="M12 3v12"/>' + '<path d="M7 10l5 5 5-5"/>' + '<path d="M5 21h14"/>' + '</svg>';
}

// Expose functions globally for inline onclick handlers
window.setPage = setPage;
window.restartService = restartService;
window.resetPairing = resetPairing;
window.loadConfig = loadConfig;
window.saveConfig = saveConfig;
window.togglePause = togglePause;
window.clearLogs = clearLogs;
window.toggleScroll = toggleScroll;

// Start UI
load();
startStatusPolling();
startUptime();
