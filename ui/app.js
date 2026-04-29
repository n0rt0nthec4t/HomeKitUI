// Module: HomeKitUI (Frontend App)
//
// Client-side application for the HomeKitUI web interface.
// Responsible for rendering the UI, managing navigation state,
// interacting with backend API endpoints, and handling live updates.
//
// Responsibilities:
// - Manage application state (current page, config, logs, HomeKit data)
// - Handle page navigation (including URL hash routing and history)
// - Fetch data from HomeKitUI API endpoints
// - Render built-in pages (status, config, logs, HomeKit)
// - Render project-specific pages via `/api/page/:id`
// - Handle configuration editing and save workflows
// - Stream logs via Server-Sent Events (SSE)
// - Provide error handling and user feedback
//
// Features:
// - URL hash-based navigation (e.g. /#dashboard)
// - Browser refresh persistence of selected page
// - Back/forward browser navigation support
// - Dynamic page loading and caching
// - Live log streaming with automatic reconnect
//
// Notes:
// - Designed to work with the HomeKitUI backend module
// - No external frontend framework (vanilla JS only)
// - All UI rendering is handled via DOM updates
// - Project-specific pages are data-driven or HTML-rendered
//
// Code version 2026.04.30
// Mark Hulskamp

/* global EventSource, alert, confirm, document, fetch, window, setTimeout, clearTimeout */
'use strict';

// Runtime UI state shared across all render functions
let state = {
  page: window.location.hash.replace('#', '') || 'status',
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
let logReconnectTimer = undefined;
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
    await loadLogs(false);
  } catch (error) {
    state.error = String(error.message || error);
  }

  if (state.page !== 'status') {
    await loadPageData(state.page);

    if (Object.keys(state.config).length === 0) {
      await loadConfig(false);
    }
  }

  render();
  startLogStream();
}

// Main render function - builds entire UI shell
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
  renderSchemaMount();
}

// Render schema-backed form content into the current page after the main
// HTML has been written. The form renderer uses DOM nodes, so it cannot be
// returned directly from the template string used by renderConfigPage().
function renderSchemaMount() {
  let mount = document.getElementById('schemaForm');

  // No schema form placeholder exists on non-config pages.
  if (mount === null) {
    return;
  }

  // Find the active project page so we know which part of the config/schema
  // should be rendered into this form.
  let page = (state.info.pages || []).find((item) => item.id === state.page);

  // Pages without schemaPath are display-only pages and do not have a form.
  if (page?.schemaPath === undefined) {
    return;
  }

  // Pull both the current config value and its matching schema section from
  // the configured schema path, then render the generic schema form.
  let value = getSchemaPathValue(page.schemaPath);
  let schema = getSchemaAtPath(page.schemaPath);

  renderSchemaPage(mount, schema, value, page.schemaPath.split('.'));
}

// Generic schema-backed page renderer.
// Dispatches to the correct renderer based on the schema type.
function renderSchemaPage(container, schema, value, path = []) {
  if (schema?.type === 'array') {
    return renderSchemaArray(container, schema, value, path);
  }

  if (schema?.type === 'object') {
    return renderSchemaObject(container, schema, value, path);
  }

  return renderSchemaField(container, schema, value, path);
}

// Render an array field from schema.items.
// Object arrays are rendered as config cards, primitive arrays as compact fields.
function renderSchemaArray(container, schema, value = [], path) {
  if (schema?.items?.type !== 'object') {
    return renderPrimitiveArray(container, schema, value, path);
  }

  if (Array.isArray(value) === false) {
    value = [];
  }

  let wrapper = document.createElement('div');
  wrapper.className = 'config-list';

  value.forEach((item, index) => {
    let row = document.createElement('div');
    row.className = 'card config-card';

    let header = document.createElement('div');
    header.className = 'config-card-header';

    let title = document.createElement('div');
    title.className = 'config-card-title';

    let displayName = typeof item?.name === 'string' && item.name.trim() !== '' ? item.name : `Item ${index + 1}`;

    title.textContent = displayName;

    let removeBtn = document.createElement('button');
    removeBtn.className = 'secondary';
    removeBtn.textContent = 'Remove';
    removeBtn.onclick = () => {
      value.splice(index, 1);
      setValueAtPath(state.config, path, value);
      render();
    };

    header.appendChild(title);
    header.appendChild(removeBtn);
    row.appendChild(header);

    renderSchemaObject(row, schema.items, item, [...path, index]);

    wrapper.appendChild(row);
  });

  container.appendChild(wrapper);
}

// Render an array of primitive values as a single comma-separated field.
// This keeps simple lists such as GPIO pins compact in the generated form.
function renderPrimitiveArray(container, schema, value = [], path) {
  if (Array.isArray(value) === false) {
    value = value === undefined ? [] : [value];
  }

  let itemSchema = schema?.items || {};
  let label = document.createElement('div');
  label.className = 'list-title';
  label.textContent = schema.title || path[path.length - 1];

  let input = document.createElement('input');
  input.type = 'text';
  input.value = value.join(', ');

  let commit = () => {
    let newValue = input.value
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item !== '')
      .map((item) => {
        if (itemSchema.type === 'number' || itemSchema.type === 'integer') {
          let number = Number(item);

          if (Number.isFinite(number) === false) {
            return undefined;
          }

          if (Number.isFinite(Number(itemSchema.minimum)) === true && number < Number(itemSchema.minimum)) {
            number = Number(itemSchema.minimum);
          }

          if (Number.isFinite(Number(itemSchema.maximum)) === true && number > Number(itemSchema.maximum)) {
            number = Number(itemSchema.maximum);
          }

          return itemSchema.type === 'integer' ? Math.trunc(number) : number;
        }

        return item;
      })
      .filter((item) => item !== undefined);

    input.value = newValue.join(', ');
    setValueAtPath(state.config, path, newValue);
  };

  input.onchange = commit;
  input.onblur = commit;

  container.appendChild(label);
  container.appendChild(input);
}

// Render an object field from schema.properties.
// Fields are rendered in schema order as generic form rows.
function renderSchemaObject(container, schema, value = {}, path) {
  let props = schema?.properties || {};

  Object.keys(props).forEach((key) => {
    let fieldSchema = props[key];
    let fieldValue = value[key];

    let fieldWrapper = document.createElement('div');
    fieldWrapper.className = 'config-row';

    renderSchemaPage(fieldWrapper, fieldSchema, fieldValue, [...path, key]);

    container.appendChild(fieldWrapper);
  });
}

// Render a primitive schema field.
// Supports enum/select, boolean/checkbox, number/integer, and string inputs.
function renderSchemaField(container, schema = {}, value, path) {
  let label = document.createElement('div');
  label.className = 'list-title';
  label.textContent = schema.title || path[path.length - 1];

  let input;

  // Normalise number/integer values against schema constraints
  let normaliseNumber = (rawValue) => {
    let newValue = rawValue === '' ? undefined : Number(rawValue);

    if (newValue !== undefined) {
      if (Number.isFinite(Number(schema.minimum)) === true && newValue < Number(schema.minimum)) {
        newValue = Number(schema.minimum);
      }

      if (Number.isFinite(Number(schema.maximum)) === true && newValue > Number(schema.maximum)) {
        newValue = Number(schema.maximum);
      }

      if (schema.type === 'integer') {
        newValue = Math.trunc(newValue);
      }
    }

    return newValue;
  };

  // ENUM (select)
  if (Array.isArray(schema.enum) === true) {
    input = document.createElement('select');

    schema.enum.forEach((option) => {
      let opt = document.createElement('option');
      opt.value = option;
      opt.textContent = option;

      if (option === value) {
        opt.selected = true;
      }

      input.appendChild(opt);
    });
  }

  // BOOLEAN
  else if (schema.type === 'boolean') {
    input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = value === true;
  }

  // NUMBER / INTEGER
  else if (schema.type === 'number' || schema.type === 'integer') {
    input = document.createElement('input');
    input.type = 'number';
    input.value = value ?? '';
    input.placeholder = 'disabled';

    if (Number.isFinite(Number(schema.minimum)) === true) {
      input.min = String(schema.minimum);
    }

    if (Number.isFinite(Number(schema.maximum)) === true) {
      input.max = String(schema.maximum);
    }

    if (schema.type === 'integer') {
      input.step = '1';
    }

    // Live clamp numeric input so manually typed values cannot remain outside bounds
    input.oninput = () => {
      let newValue = normaliseNumber(input.value);

      input.value = newValue ?? '';
      setValueAtPath(state.config, path, newValue);
    };
  }

  // STRING (default)
  else {
    input = document.createElement('input');
    input.type = 'text';
    input.value = value ?? '';

    // live update for "name" fields
    input.oninput = () => {
      setValueAtPath(state.config, path, input.value);

      if (path[path.length - 1] === 'name') {
        let card = container.closest('.config-card');
        let title = card?.querySelector('.config-card-title');

        if (title !== null) {
          title.textContent = input.value.trim() !== '' ? input.value : 'Item';
        }
      }
    };
  }

  // CHANGE HANDLER (final value commit)
  // Uses both onchange and onblur to ensure validation runs when leaving the field,
  // as some browsers do not fire change for invalid number inputs.
  let commit = () => {
    let newValue;

    if (schema.type === 'boolean') {
      newValue = input.checked;
    } else if (schema.type === 'number' || schema.type === 'integer') {
      newValue = normaliseNumber(input.value);
      input.value = newValue ?? '';
    } else {
      newValue = input.value;
    }

    setValueAtPath(state.config, path, newValue);
  };

  input.onchange = commit;
  input.onblur = commit;

  container.appendChild(label);
  container.appendChild(input);
}

// Adds a new object entry to a schema-backed config array
function addSchemaItem(schemaPath) {
  let path = schemaPath.split('.');
  let value = getSchemaPathValue(schemaPath);
  let schema = getSchemaAtPath(schemaPath);

  if (Array.isArray(value) === false || schema?.items === undefined) {
    return;
  }

  value.push(getDefaultValue(schema.items));
  setValueAtPath(state.config, path, value);
  render();
}

// Status page combines HomeKit pairing cards, app actions, and logs
function statusPage() {
  return `
    <div class="page-header">
      <div>
        <h1>HomeKit Status</h1>
        <div class="page-meta">
          App v${escapeHTML(state.info.version || '')} •
          UI v${escapeHTML(state.info.uiVersion || '')} •
          Port ${escapeHTML(state.info.port || '')} •
          Uptime <span class="uptime">${escapeHTML(formatUptime(uptimeSeconds))}</span>
        </div>
      </div>

      <div class="page-actions">
        <button title="Restart Service" onclick="restartService()">
          ${restartIcon()}
        </button>

        <a title="Backup Configuration" href="/api/backup">
          ${downloadIcon()}
        </a>
      </div>
    </div>

    <div class="status-layout">
      ${(state.homekit.accessories || [state.homekit]).map((accessory) => pairingCard(accessory)).join('')}
    </div>

    ${logsCard()}
  `;
}

// HomeKit pairing information card
function pairingCard(accessory = state.homekit) {
  return `
    <section class="pairing-card">
      <div class="pairing-title">${escapeHTML(accessory.displayName || state.info.name || 'HomeKit Device')}</div>

      <div class="pairing-content">
        <div class="pairing-left">
          ${
            accessory.qrCode
              ? `<img class="qr" src="${accessory.qrCode}" alt="HomeKit QR Code">`
              : '<div class="qr-missing">QR unavailable</div>'
          }

          <div class="pin">${escapeHTML(accessory.pincode || '--- -- ---')}</div>

          <div class="pairing-status">
            <span class="hap-icon">${homeIcon()}</span>
            <span>HAP</span>
            <span>•</span>
            <button
              class="pairing-state ${accessory.paired === true ? 'paired' : 'unpaired'}"
              title="${accessory.paired === true ? 'Reset HomeKit Pairing' : 'Not Paired'}"
              onclick="${accessory.paired === true ? `resetPairing('${escapeHTML(accessory.username || '')}')` : ''}"
              data-dynamic="pairing"
            >
              ${linkIcon()}
            </button>
          </div>

          <div class="meta">${escapeHTML(accessory.username || '')}</div>
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
          <button id="logs-pause" title="Pause logs" onclick="togglePause()">${logsPaused === true ? 'Live' : 'Pause'}</button>
          <button title="Clear logs" onclick="clearLogs()">Clear</button>
          <button id="logs-scroll" title="Toggle auto-scroll" onclick="toggleScroll()">${logsAutoScroll === true ? 'Scroll' : 'Manual'}</button>
        </div>
      </div>

      <div id="logs" class="log-output"></div>
    </section>
  `;
}

// Project-specific page renderer.
// HomeKitUI remains generic by rendering host-provided HTML, list data,
// or schema-backed config sections.
function projectPage() {
  let page = (state.info.pages || []).find((item) => item.id === state.page);

  if (page === undefined) {
    return '';
  }

  let data = state.pageData[page.id];

  if (data !== undefined && data !== null && data.type === 'html' && typeof data.html === 'string') {
    return `
    <h1>${escapeHTML(page.title)}</h1>
    ${typeof data.css === 'string' && data.css !== '' ? `<style>${data.css}</style>` : ''}
    ${data.html}
  `;
  }

  if (data !== undefined && data !== null && data.type === 'list' && Array.isArray(data.items) === true) {
    return renderListPage(page, data);
  }

  return renderConfigPage(page);
}

// Generic list page renderer for host-provided list data
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

// Generic config page renderer.
// The actual schema-driven form is mounted later by renderSchemaMount().
function renderConfigPage(page) {
  let addButton = '';

  if (page?.schemaPath !== undefined) {
    let schema = getSchemaAtPath(page.schemaPath);

    if (schema?.type === 'array' && schema?.items?.type === 'object') {
      addButton = `<button class="secondary" onclick="addSchemaItem('${escapeHTML(page.schemaPath)}')">+ Add</button>`;
    }
  }

  return `
    <h1>${escapeHTML(page.title)}</h1>

    <section class="card">
      <div class="config-page-header">
        <div class="card-description">Manage settings</div>

        <div class="actions">
          <button onclick="saveConfig()">Save Configuration</button>
          ${addButton}
        </div>
      </div>

      <div id="schemaForm"></div>
    </section>
  `;
}

// Change active page and load data/config if required
async function setPage(page) {
  state.page = page;
  state.error = undefined;

  if (window.location.hash !== '#' + page) {
    window.location.hash = page;
  }

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

// Save the in-memory config model back to the backend
async function saveConfig() {
  try {
    await api('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(state.config),
    });

    alert('Configuration saved. Restart required for accessory changes to take effect.');
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

  logStream.onopen = () => {
    // When reconnecting after a restart, reload history so startup logs are not missed.
    loadLogs(true);
  };

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
    try {
      logStream.close();
      // eslint-disable-next-line no-unused-vars
    } catch (error) {
      // Empty
    }

    logStream = undefined;

    if (logReconnectTimer !== undefined) {
      clearTimeout(logReconnectTimer);
    }

    logReconnectTimer = setTimeout(() => {
      logReconnectTimer = undefined;
      startLogStream();
    }, 2000);
  };
}

// Reload current log history from backend
async function loadLogs(scroll = true) {
  try {
    state.logs = (await api('/api/logs')).logs || [];
    renderLogsOnly(scroll);
    // eslint-disable-next-line no-unused-vars
  } catch (error) {
    // Ignore transient log reload failures
  }
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

  div.className = 'log-line log-' + escapeClassName(entry.level || 'info');
  div.innerHTML = typeof entry.html === 'string' ? entry.html : escapeHTML(entry.message || '');

  logs.appendChild(div);

  while (logs.children.length > 500) {
    logs.removeChild(logs.firstChild);
  }

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

      if (JSON.stringify(latestHomeKit) !== JSON.stringify(state.homekit)) {
        state.homekit = latestHomeKit;
        render();
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

    document.querySelectorAll('.uptime').forEach((uptime) => {
      uptime.textContent = formatUptime(uptimeSeconds);
    });
  }, 1000);
}

// Format one log entry as safe HTML
function formatLogLine(entry) {
  if (entry === null || typeof entry !== 'object') {
    return '';
  }

  let level = escapeClassName(entry.level || 'info');
  let html = typeof entry.html === 'string' ? entry.html : escapeHTML(entry.message || '');

  return `<div class="log-line log-${level}">${html}</div>`;
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

  let button = document.getElementById('logs-pause');

  if (button !== null) {
    button.textContent = logsPaused === true ? 'Live' : 'Pause';
    button.title = logsPaused === true ? 'Resume live logs' : 'Pause logs';
  }

  if (logsPaused === false) {
    renderLogsOnly(true);
  }
}

// Clear browser-side log view
function clearLogs() {
  state.logs = [];
  renderLogsOnly(false);
}

// Toggle automatic scrolling when logs arrive
function toggleScroll() {
  logsAutoScroll = logsAutoScroll === true ? false : true;

  let button = document.getElementById('logs-scroll');

  if (button !== null) {
    button.textContent = logsAutoScroll === true ? 'Scroll' : 'Manual';
    button.title = logsAutoScroll === true ? 'Disable auto-scroll' : 'Enable auto-scroll';
  }

  if (logsAutoScroll === true) {
    renderLogsOnly(true);
  }
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
async function resetPairing(username = state.homekit.username) {
  if (confirm('Reset HomeKit pairing? This removes all paired controllers.') !== true) {
    return;
  }

  await api('/api/homekit/reset', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username }),
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

// Safely set value in nested object using path
function setValueAtPath(obj, path, value) {
  let ref = obj;

  for (let i = 0; i < path.length - 1; i++) {
    if (ref[path[i]] === undefined) {
      ref[path[i]] = typeof path[i + 1] === 'number' ? [] : {};
    }

    ref = ref[path[i]];
  }

  ref[path[path.length - 1]] = value;
}

// Create a default config value from a schema definition
function getDefaultValue(schema) {
  if (schema?.default !== undefined) {
    return schema.default;
  }

  if (schema?.type === 'object') {
    let obj = {};

    Object.keys(schema.properties || {}).forEach((key) => {
      obj[key] = getDefaultValue(schema.properties[key]);
    });

    return obj;
  }

  if (schema?.type === 'array') {
    return [];
  }

  if (schema?.type === 'boolean') {
    return false;
  }

  if (Array.isArray(schema?.enum)) {
    return schema.enum[0];
  }

  return undefined;
}

// Resolve a nested schema section from the root JSON schema using a dot path
// (e.g. "doors", "options.something"). This mirrors getSchemaPathValue()
// but operates on the schema definition instead of the config data.
function getSchemaAtPath(schemaPath) {
  if (schemaPath === undefined || schemaPath === '') {
    return state.schema;
  }

  return schemaPath.split('.').reduce((schema, key) => {
    if (schema?.type === 'object') {
      return schema.properties?.[key];
    }

    if (schema?.type === 'array') {
      return schema.items;
    }

    return undefined;
  }, state.schema);
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
  return (
    '<svg viewBox="0 -1 24 24">' +
    '<path d="M4 7h16"/>' +
    '<path d="M4 17h16"/>' +
    '<circle cx="9" cy="7" r="2"/>' +
    '<circle cx="15" cy="17" r="2"/>' +
    '</svg>'
  );
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
window.addSchemaItem = addSchemaItem;
window.addEventListener('hashchange', async () => {
  let page = window.location.hash.replace('#', '') || 'status';
  let exists = (state.info.pages || []).some((p) => p.id === page) || page === 'status';
  if (exists === true && page !== state.page) {
    await setPage(page);
  }
});

// Start UI
load();
startStatusPolling();
startUptime();
