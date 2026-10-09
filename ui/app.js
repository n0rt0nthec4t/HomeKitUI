// Module: HomeKitUI (Frontend App)
//
// Client-side application for the HomeKitUI web interface.
// Responsible for rendering the UI, managing navigation state,
// interacting with backend API endpoints, handling authentication,
// and coordinating live runtime updates.
//
// Responsibilities:
// - Manage shared frontend application state
// - Handle page navigation and browser history integration
// - Fetch data from HomeKitUI backend API endpoints
// - Render built-in pages (status, logs, HomeKit, config)
// - Render project-specific dashboard/configuration pages
// - Handle configuration editing and save workflows
// - Stream logs via Server-Sent Events (SSE)
// - Manage optional bearer-token authentication
// - Provide runtime error handling and user feedback
//
// Features:
// - URL hash-based navigation (e.g. /#dashboard)
// - Browser refresh persistence of selected page
// - Back/forward browser navigation support
// - Dynamic page loading and caching
// - Live log streaming with automatic reconnect
// - Schema-driven configuration rendering
// - Persistent collapse/visible UI state
// - Local bearer-token persistence for authenticated backends
// - Trusted backend-rendered HTML dashboard support
//
// Architecture:
// - Designed specifically for the HomeKitUI backend module
// - No external frontend framework (vanilla JS only)
// - UI rendering performed via direct DOM updates
// - Backend communication flows through a shared authenticated API wrapper
// - Runtime updates handled via polling and SSE streams
// - Project pages remain backend-driven and declarative
//
// Authentication:
// - Optional bearer-token authentication support
// - Supports session-only or persistent browser authentication
// - API requests use Authorisation: Bearer headers
// - SSE log streaming falls back to query-token authentication because
//   native browser EventSource does not support custom headers
// - Authentication state can fully lock the UI until valid credentials
//   are provided
//
// Notes:
// - Authentication remains fully optional and backend-controlled
// - UI remains functional without authentication when disabled server-side
// - Project-specific pages may provide trusted HTML/CSS when enabled by backend
// - All frontend actions route through centralised event delegation
//
// Code version 2026.10.09
// Mark Hulskamp

/* global EventSource, alert, confirm, document, fetch, window, DOMParser, structuredClone */
'use strict';

/* constants */
const AUTH_REQUIRED_MESSAGE = 'Authentication required';

/**
 * @typedef {import('../HomeKitUI.js').Configuration} Configuration
 * @typedef {import('../HomeKitUI.js').UIPage} UIPage
 * @typedef {import('../HomeKitUI.js').UIPageData} UIPageData
 * @typedef {import('../HomeKitUI.js').UITheme} UITheme
 * @typedef {import('../HomeKitUI.js').UILogEntry} UILogEntry
 * @typedef {import('../HomeKitUI.js').UIAccessoryDetails} UIAccessoryDetails
 */

/**
 * @typedef {object} SchemaDefinition
 * @property {string} [type] Rendered object, array, boolean, number, integer, or string type.
 * @property {string} [title] Field label.
 * @property {Object<string, SchemaDefinition>} [properties] Object child schemas.
 * @property {SchemaDefinition} [items] Schema shared by array entries.
 * @property {*} [default] JSON value copied for each new configuration item.
 * @property {*[]} [enum] Allowed JSON values in display order.
 * @property {number} [minimum] Lower numeric bound.
 * @property {number} [maximum] Upper numeric bound.
 * @property {string} [format] Password fields preserve existing secrets when blank.
 * @property {boolean} [restartRequired] Restart advice inherited by descendants.
 */

/**
 * @typedef {object} AuthSubmission
 * @property {string} token Trimmed user-supplied credential.
 * @property {boolean} remember Whether to attempt browser persistence.
 */

// Runtime UI state shared across all render functions
let state = {
  page: window.location.hash.replace('#', '') || 'status',
  info: {},
  homekit: {},
  config: {},
  schema: {},
  uiSchema: {},
  pageData: {},
  collapse: {},
  visible: {},
  logs: [],
  error: undefined,
  authRequired: false,
  changedPaths: new Set(),
};

// Core UI always includes the status page only
let appName = document.title || 'HomeKitUI';
let corePages = [{ id: 'status', title: 'Status', icon: 'home' }];
let logReconnectTimer = undefined;
let logStream = undefined;
let logsPaused = false;
let logsAutoScroll = true;
let uptimeSeconds = 0;
let runtimeTimer = undefined;
let lastStatusPoll = 0;
let lastPageRefresh = 0;
let lastControlInteraction = 0;
// Request generations also invalidate reads begun before a backend action.
let pageRequestGenerations = new Map();
let pendingActionCount = 0;
let pageRefreshInProgress = false;
let activeControlPointers = new Set();
let logScrollTop = 0;
let renderTimer = undefined;
let renderPending = false;
let renderBackgroundOnly = false;
let sessionAuthToken = '';
let browserStorageOverrides = new Map();
let pendingAuthRequest = undefined;
let saveInProgress = false;
let configRevision = 0;

// Retrieve the active HomeKitUI bearer token.
// Tokens can exist in two places:
//
// - sessionAuthToken
//   Temporary in-memory token for the current browser tab/session only.
//   Used when the user does NOT select "Remember for this browser".
//
// - localStorage
//   Persistent browser storage used when the user enables
//   "Remember for this browser". This survives page reloads and browser restarts.
//
// Session token always takes priority over persistent storage.
/**
 * @returns {string} Session credential or remembered browser credential; empty if absent.
 */
function authToken() {
  return sessionAuthToken || readBrowserStorage('homekitui-token') || '';
}

/**
 * @param {string} key HomeKitUI browser preference key.
 * @returns {string|null} Stored value, session override, or null if unavailable.
 */
function readBrowserStorage(key) {
  // Session writes take precedence even if persistence failed or removal was denied.
  if (browserStorageOverrides.has(key) === true) {
    return browserStorageOverrides.get(key);
  }

  try {
    return window.localStorage.getItem(key);
  } catch {
    // Restricted browser storage must not prevent API access or page rendering.
    return null;
  }
}

/**
 * @param {string} key HomeKitUI browser preference key.
 * @param {string|null} value Session value; null also removes the persisted value.
 * @returns {boolean} Whether the browser persisted the update successfully.
 */
function writeBrowserStorage(key, value) {
  browserStorageOverrides.set(key, value);
  try {
    if (value === null) {
      window.localStorage.removeItem(key);
    } else {
      window.localStorage.setItem(key, value);
    }
    return true;
  } catch {
    // Keep preferences and credentials usable for this tab when storage is denied.
    return false;
  }
}

// Merge bearer-token authentication into an existing headers object.
// This keeps API calls compatible with additional headers such as
// Content-Type used by config save and action requests.
//
// If no token exists, return the original headers unchanged so
// authentication remains fully optional when disabled server-side.
/**
 * @param {Object<string, string>} [headers={}] Additional request headers.
 * @returns {Object<string, string>} Headers with the active bearer credential when available.
 */
function authHeaders(headers = {}) {
  let token = authToken();

  if (token === '') {
    return headers;
  }

  return {
    ...headers,
    Authorization: 'Bearer ' + token,
  };
}

// Check whether an error represents the frontend authentication-required state.
// This lets callers distinguish an expected auth cancellation/lockout from
// normal backend, network, or rendering errors.
/**
 * @param {Error} error Request or authentication failure.
 * @returns {boolean} Whether the user cancelled authentication.
 */
function isAuthRequiredError(error) {
  return error?.message === AUTH_REQUIRED_MESSAGE;
}

// Request HomeKitUI bearer-token authentication using a styled modal.
// This replaces the native browser prompt so authentication matches the
// rest of the HomeKitUI interface and theme styling.
//
// Returns:
//   {
//     token: string,
//     remember: boolean
//   }
//
// or undefined if cancelled by the user.
/**
 * @returns {Promise<AuthSubmission|undefined>} Submitted credentials, or undefined on cancellation.
 */
function requestAuthToken() {
  return new Promise((resolve) => {
    // Create a fullscreen modal overlay which blocks interaction with
    // the rest of the UI until authentication is completed or cancelled.
    let overlay = document.createElement('div');

    overlay.className = 'auth-overlay';

    // Render the authentication dialog using the same visual style
    // as the rest of HomeKitUI.
    overlay.innerHTML = (
      '\n' + '      <form class="auth-card" data-auth-form>\n' + '        <div class="auth-icon">' + lockIcon() + '</div>\n' + '\n' +
      '        <div class="auth-title">' + escapeHTML(appName) + '</div>\n' + '\n' + '        <div class="auth-subtitle">\n' +
      '          Please enter the Web UI password from your configuration file to continue.\n' + '        </div>\n' + '\n' +
      '        <label class="auth-field">\n' + '          <span>Web UI password</span>\n' + '\n' +
      '          <div class="auth-input-wrap">\n' + '            <input\n' + '              class="auth-input"\n' +
      '              type="password"\n' + '              autocomplete="current-password"\n' +
      '              placeholder="Enter Web UI password"\n' + '            >\n' + '\n' + '            <button\n' +
      '              class="auth-eye"\n' + '              type="button"\n' + '              title="Show password"\n' +
      '              data-auth-show\n' + '            >\n' + '              ' + eyeIcon() + '\n' + '            </button>\n' +
      '          </div>\n' + '        </label>\n' + '\n' + '        <label class="auth-remember">\n' +
      '          <input type="checkbox" data-auth-remember>\n' + '\n' + '          <span>Remember for this browser</span>\n' + '\n' +
      '          <button\n' + '            class="auth-info"\n' + '            type="button"\n' +
      '            title="The Web UI password is stored locally in this browser only. Recommended only on trusted devices."\n' +
      '            data-auth-info\n' + '          >\n' + '            i\n' + '          </button>\n' + '        </label>\n' + '\n' +
      '        <div class="auth-actions">\n' + '          <button class="secondary" type="button" data-auth-cancel>Cancel</button>\n' +
      '          <button class="primary" type="submit" data-auth-submit>Continue</button>\n' + '        </div>\n' + '      </form>\n' +
      '    '
    );

    document.body.appendChild(overlay);

    // Lookup dialog controls once after rendering.
    let input = overlay.querySelector('.auth-input');
    let remember = overlay.querySelector('[data-auth-remember]');
    let show = overlay.querySelector('[data-auth-show]');
    let info = overlay.querySelector('[data-auth-info]');
    let form = overlay.querySelector('[data-auth-form]');
    let cancel = overlay.querySelector('[data-auth-cancel]');
    let closed = false;

    // Cleanup helper used by all exit paths.
    // Removes the modal and resolves the Promise back to the caller.
    let close = (value) => {
      if (closed === true) {
        return;
      }

      closed = true;
      overlay.remove();
      resolve(value);
    };

    let submitAuth = (event) => {
      event?.preventDefault();
      event?.stopPropagation();

      close({
        token: input.value.trim(),
        remember: remember.checked === true,
      });
    };

    // User cancelled authentication.
    cancel.onclick = (event) => {
      event.preventDefault();
      event.stopPropagation();
      close(undefined);
    };

    // User submitted a token.
    form.onsubmit = submitAuth;

    // Toggle password visibility for easier entry/debugging of long tokens.
    show.onclick = () => {
      input.type = input.type === 'password' ? 'text' : 'password';
      show.title = input.type === 'password' ? 'Show password' : 'Hide password';
    };

    // Display additional information about local token storage behaviour.
    info.onclick = () => {
      alert(
        'The Web UI password is stored locally in this browser only. ' +
          'It is only sent to this HomeKitUI instance for authentication. ' +
          'Use this option only on trusted/private devices.',
      );
    };

    // Keyboard shortcuts:
    // - Enter submits authentication
    // - Escape cancels authentication
    input.onkeydown = (event) => {
      if (event.key === 'Enter') {
        submitAuth(event);
      }

      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        close(undefined);
      }
    };

    // Focus the token input automatically for immediate typing.
    input.focus();
  });
}

// Request and store a bearer token once, even if multiple API calls receive
// authentication failures at the same time.
/**
 * @returns {Promise<AuthSubmission|undefined>} Shared pending submission; credentials stay usable if storage fails.
 */
async function requestStoredAuthToken() {
  if (pendingAuthRequest !== undefined) {
    return pendingAuthRequest;
  }

  pendingAuthRequest = requestAuthToken()
    .then((auth) => {
      if (auth !== undefined && typeof auth.token === 'string' && auth.token.trim() !== '') {
        sessionAuthToken = auth.token.trim();
        if (auth.remember === true) {
          if (writeBrowserStorage('homekitui-token', sessionAuthToken) === false) {
            alert('Browser storage is unavailable. The Web UI password will be kept for this tab only.');
          }
        } else {
          writeBrowserStorage('homekitui-token', null);
        }
      }

      return auth;
    })
    .finally(() => {
      pendingAuthRequest = undefined;
    });

  return pendingAuthRequest;
}

function clearStoredAuthToken() {
  sessionAuthToken = '';
  writeBrowserStorage('homekitui-token', null);
}

/**
 * @param {boolean} required True locks rendering and stops log streaming.
 */
function setAuthRequired(required) {
  state.authRequired = required === true;

  if (state.authRequired === true) {
    state.error = undefined;

    if (logStream !== undefined) {
      try {
        logStream.close();
        // eslint-disable-next-line no-unused-vars
      } catch (error) {
        // Empty
      }

      logStream = undefined;
    }

    if (logReconnectTimer !== undefined) {
      window.clearTimeout(logReconnectTimer);
      logReconnectTimer = undefined;
    }
  }
}

// Simple API wrapper used by the frontend for all backend requests.
// Handles:
// - automatic bearer-token authentication injection
// - JSON response parsing
// - automatic authentication retry on HTTP 401
// - optional persistent browser token storage
// - consistent error propagation for UI handlers
/**
 * Fetch a response with shared credential retries for JSON and binary downloads.
 * @param {string} apiPath Same-origin API endpoint.
 * @param {RequestInit} [options={}] Fetch options and additional headers.
 * @returns {Promise<Response>} Authenticated response; cancellation rejects.
 */
async function authenticatedFetch(apiPath, options = {}) {
  options.headers = authHeaders(options.headers || {});
  let response = await fetch(apiPath, options);

  while (response.status === 401) {
    let auth = await requestStoredAuthToken();

    if (auth === undefined || typeof auth.token !== 'string' || auth.token.trim() === '') {
      setAuthRequired(true);
      render();
      throw new Error(AUTH_REQUIRED_MESSAGE);
    }

    options.headers = authHeaders(options.headers || {});
    response = await fetch(apiPath, options);

    if (response.status === 401) {
      clearStoredAuthToken();
    }
  }

  setAuthRequired(false);
  return response;
}

/**
 * @param {string} apiPath Same-origin JSON endpoint.
 * @param {RequestInit} [options={}] Request method, headers, and body.
 * @returns {Promise<*>} Parsed JSON; malformed JSON currently falls back to an empty object.
 * @throws {Error} On transport, authentication cancellation, or unsuccessful HTTP status.
 */
async function api(apiPath, options = {}) {
  let response = await authenticatedFetch(apiPath, options);
  let data = await response.json().catch(() => ({}));

  if (response.ok !== true) {
    throw new Error(data.error || 'Request failed');
  }

  return data;
}

// Initial load of UI data from backend
async function load() {
  try {
    setAuthRequired(false);
    state.error = undefined;

    state.info = await api('/api/info');
    appName = state.info.name || appName;
    document.title = appName;

    if (Number.isFinite(Number(state.info?.uptime)) === true) {
      uptimeSeconds = Number(state.info.uptime);
    }

    applyTheme(state.info.theme);

    state.homekit = await api('/api/homekit');
    await loadLogs(false);
  } catch (error) {
    if (isAuthRequiredError(error) === true) {
      render();
      return;
    }

    state.error = String(error.message || error);
  }

  if (state.page !== 'status') {
    try {
      await loadPageData(state.page);

      if (Object.keys(state.config).length === 0) {
        await loadConfig(false);
      }
    } catch (error) {
      if (isAuthRequiredError(error) === true) {
        render();
        return;
      }

      state.error = String(error.message || error);
    }
  }

  render();

  if (state.authRequired !== true) {
    startLogStream();
  }
}

// Protect both request initiation and deferred renders. The cooldown is independent
// of focus because some browsers do not focus buttons on pointer interaction.
/**
 * @param {boolean} [includeCooldown=true] Whether to include the five-second interaction pause.
 * @returns {boolean} Whether replacing dynamic-page controls would interrupt interaction.
 */
function pageInteractionActive(includeCooldown = true) {
  let focused = document.activeElement;
  return pendingActionCount > 0 || activeControlPointers.size > 0 ||
    (focused !== null && (focused.tagName === 'INPUT' || focused.tagName === 'TEXTAREA')) ||
    (includeCooldown === true && Date.now() - lastControlInteraction < 5000);
}

// Coalesce renders, retaining deferred work until editing, pointer interaction,
// or pending actions finish. Action results can render without waiting for cooldown.
/**
 * @param {boolean} [background=false] Whether this render came only from automatic page refresh.
 * @returns {void} Schedules or retains a single render for the current page.
 */
function scheduleRender(background = false) {
  renderBackgroundOnly = renderPending === true ? renderBackgroundOnly === true && background === true : background === true;
  renderPending = true;

  if (renderTimer !== undefined) {
    return;
  }

  renderTimer = window.setTimeout(() => {
    renderTimer = undefined;

    if (renderPending !== true ||
      (state.authRequired !== true && state.page !== 'status' && pageInteractionActive(renderBackgroundOnly) === true)) {
      return;
    }

    renderPending = false;
    render();
  }, 0);
}

// Main render function - builds entire UI shell
function render() {
  if (state.authRequired === true) {
    document.getElementById('project-style')?.remove();
    document.getElementById('app').innerHTML = authRequiredPage();
    return;
  }

  // Full-shell rendering removes the old focused node. Match the same control
  // by its stable identity and occurrence, allowing payload and label updates.
  let app = document.getElementById('app');
  let focused = document.activeElement;
  let focusAttributes = ['id', 'name', 'data-action', 'data-send-action', 'data-page', 'data-target', 'data-path'];
  let focusCandidates = [...app.querySelectorAll('select, button, [data-action], [data-send-action]')];
  let matchesFocus = (control) => control.tagName === focused?.tagName &&
    focusAttributes.every((attribute) => control.getAttribute(attribute) === focused.getAttribute(attribute));
  let focusOccurrence = focusCandidates.filter(matchesFocus).indexOf(focused);

  let pages = [...corePages, ...(Array.isArray(state.info.pages) === true ? state.info.pages : [])];
  let page = (state.info.pages || []).find((item) => item.id === state.page);
  let style = document.getElementById('project-style');

  if (style !== null && page?.trustedHTML !== true) {
    style.remove();
  }

  document.getElementById('app').innerHTML = (
    '\n' + '    <aside>\n' + '      ' +
    (pages
        .map(
          (page) => (
            '\n' + '            <button\n' + '              class="' +
            (state.page === page.id ? 'active' : '') + '"\n' + '              title="' + escapeHTML(page.title) + '"\n' +
            '              aria-label="' + escapeHTML(page.title) + '"\n' + '              data-page="' + escapeHTML(page.id) + '"\n' +
            '            >\n' + '              ' + icon(page) + '\n' + '            </button>\n' + '          '
          ),
        )
        .join('')) +
    '\n' + '    </aside>\n' + '\n' + '    <main>\n' + '      ' +
    (state.error !== undefined ? ('<div class="error">' + escapeHTML(state.error) + '</div>') : '') + '\n' + '      ' +
    (state.page === 'status' ? statusPage() : '') + '\n' + '      ' +
    (state.page !== 'status' ? projectPage() : '') + '\n' + '    </main>\n' + '  '
  );

  renderLogsOnly(true);
  renderSchemaMount();
  restoreCollapseState();
  restoreVisibleState();

  if (focusOccurrence >= 0) {
    let replacement = [...app.querySelectorAll('select, button, [data-action], [data-send-action]')]
      .filter(matchesFocus)[focusOccurrence];
    replacement?.focus({ preventScroll: true });
  }
}

function authRequiredPage() {
  return (
    '\n' + '    <main class="auth-required-page">\n' + '      <section class="auth-required-card">\n' + '        <div class="auth-icon">' +
    lockIcon() + '</div>\n' + '        <h1>Authentication required</h1>\n' + '        <p>Enter the Web UI password to continue.</p>\n' +
    '        <button class="primary" data-action="authenticate">Authenticate</button>\n' + '      </section>\n' + '    </main>\n' + '  '
  );
}

// Render schema-backed form content into the current page after the main
// HTML has been written. The form renderer uses DOM nodes, so it cannot be
// returned directly from the HTML string used by renderConfigPage().
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

  // schemaPath is already sanitised by the backend, but validate again before
  // resolving nested objects in the frontend.
  if (/^[a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)*$/.test(page.schemaPath) !== true) {
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
/**
 * @param {HTMLElement} container Form mount.
 * @param {SchemaDefinition} schema Schema for the selected configuration section.
 * @param {*} value Current configuration value.
 * @param {(string|number)[]} [path=[]] Configuration path, including numeric array indexes.
 */
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
/**
 * @param {HTMLElement} container Array mount.
 * @param {SchemaDefinition} schema Array schema with a shared item definition.
 * @param {*[]} [value=[]] Current entries.
 * @param {(string|number)[]} path Configuration path to the array.
 */
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

    let displayName = typeof item?.name === 'string' && item.name.trim() !== '' ? item.name : ('Item ' + (index + 1));

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
/**
 * @param {HTMLElement} container Field mount.
 * @param {SchemaDefinition} schema Array schema; numeric items use declared bounds.
 * @param {*[]} [value=[]] Entries displayed as a comma-separated field.
 * @param {(string|number)[]} path Configuration path to update.
 */
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
/**
 * @param {HTMLElement} container Object mount.
 * @param {SchemaDefinition} schema Object property definitions.
 * @param {Configuration} [value={}] Current object values.
 * @param {(string|number)[]} path Configuration path to the object.
 */
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
/**
 * @param {HTMLElement} container Field mount.
 * @param {SchemaDefinition} [schema={}] Type, enum, bounds, and password metadata.
 * @param {*} value Current field value.
 * @param {(string|number)[]} path Configuration path committed by control events.
 */
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

    schema.enum.forEach((option, index) => {
      let opt = document.createElement('option');
      // DOM values are strings; indexes preserve the original JSON enum types.
      opt.value = String(index);
      opt.textContent = option;

      if (option === value) {
        opt.selected = true;
      }

      input.appendChild(opt);
    });
  } else if (schema.type === 'boolean') {
    // BOOLEAN
    input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = value === true;
  } else if (schema.type === 'number' || schema.type === 'integer') {
    // NUMBER / INTEGER
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
    } else {
      input.step = 'any';
    }
  } else {
    // STRING (default)
    let isPassword = schema.format === 'password';
    let hasExistingPassword = isPassword === true && typeof value === 'string' && value !== '';

    input = document.createElement('input');
    input.type = isPassword === true ? 'password' : 'text';
    input.value = hasExistingPassword === true ? '' : (value ?? '');
    input.placeholder = hasExistingPassword === true ? 'Leave unchanged' : '';
    input.autocomplete = isPassword === true ? 'new-password' : 'off';

    // live update for "name" fields
    input.oninput = () => {
      if (hasExistingPassword === true && input.value === '') {
        setValueAtPath(state.config, path, value);
        return;
      }

      setValueAtPath(state.config, path, input.value);

      if (path[path.length - 1] === 'name') {
        let card = container.closest('.config-card');
        let title = card?.querySelector('.config-card-title');

        if (title !== undefined && title !== null) {
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

    if (Array.isArray(schema.enum) === true) {
      newValue = structuredClone(schema.enum[Number(input.value)]);
    } else if (schema.type === 'boolean') {
      newValue = input.checked === true;
    } else if (schema.type === 'number' || schema.type === 'integer') {
      newValue = normaliseNumber(input.value);
      input.value = newValue ?? '';
    } else {
      if (schema.format === 'password' && typeof value === 'string' && value !== '' && input.value === '') {
        return;
      }

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
/**
 * @param {string} schemaPath Dot path to an object array; each insertion owns its defaults.
 */
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
  return (
    '\n' + '    <div class="page-header">\n' + '      <div>\n' + '        <h1>Status</h1>\n' + '        <div class="page-meta">\n' +
    '          App v' + escapeHTML(state.info.version || '') + ' •\n' + '          UI v' + escapeHTML(state.info.uiVersion || '') + ' •\n' +
    '          Port ' + escapeHTML(state.info.port || '') + ' •\n' + '          Uptime <span class="uptime">' +
    (escapeHTML(formatUptime(uptimeSeconds))) + '</span>\n' + '        </div>\n' + '      </div>\n' + '\n' +
    '      <div class="page-actions">\n' + '        <button title="Restart Service" data-action="restartService">\n' + '          ' +
    restartIcon() + '\n' + '        </button>\n' + '\n' + '        <button title="Backup Configuration" data-action="backupConfig">\n' +
    '          ' + downloadIcon() + '\n' + '        </button>\n' + '      </div>\n' + '    </div>\n' + '\n' +
    '    <div class="status-layout">\n' + '      ' +
    ((state.homekit.accessories || [state.homekit]).map((accessory) => pairingCard(accessory)).join('')) + '\n' + '    </div>\n' + '\n' +
    '    ' + logsCard() + '\n' + '  '
  );
}

// HomeKit pairing information card
/**
 * @param {UIAccessoryDetails} [accessory=state.homekit] Backend pairing metadata.
 * @returns {string} Pairing card HTML.
 */
function pairingCard(accessory = state.homekit) {
  return (
    '\n' + '    <section class="pairing-card">\n' + '      <div class="pairing-title">' +
    escapeHTML(accessory.displayName || state.info.name || 'HomeKit Device') + '</div>\n' + '\n' + '      <div class="pairing-content">\n' +
    '        <div class="pairing-left">\n' + '          ' +
    (accessory.qrCode
              ? ('<img class="qr" src="' + (accessory.qrCode) + '" alt="HomeKit QR Code">')
              : '<div class="qr-missing">QR unavailable</div>') +
    '\n' + '\n' + '          <div class="pin">' + escapeHTML(accessory.pincode || '--- -- ---') + '</div>\n' + '\n' +
    '          <div class="pairing-status">\n' + '            <span class="hap-icon">' + homeIcon() + '</span>\n' +
    '            <span>HAP</span>\n' + '            <span>•</span>\n' + '            <button\n' + '              class="pairing-state ' +
    (accessory.paired === true ? 'paired' : 'unpaired') + '"\n' + '              title="' +
    (accessory.paired === true ? 'Reset HomeKit Pairing' : 'Not Paired') + '"\n' + '              ' +
    (accessory.paired === true
                  ? ('data-action="resetPairing" data-username="' + escapeHTML(accessory.username || '') + '"')
                  : 'disabled') +
    '\n' + '              data-dynamic="pairing"\n' + '            >\n' + '              ' + linkIcon() + '\n' + '            </button>\n' +
    '          </div>\n' + '\n' + '          <div class="meta">' + escapeHTML(accessory.username || '') + '</div>\n' + '        </div>\n' +
    '      </div>\n' + '    </section>\n' + '  '
  );
}

// Logs card renders live log output
function logsCard() {
  return (
    '\n' + '    <section class="card logs-card">\n' + '      <div class="logs-header">\n' + '        <div class="logs-title">Log</div>\n' +
    '\n' + '        <div class="logs-controls">\n' + '          <button id="logs-pause" title="Pause logs" data-action="togglePause">\n' +
    '            ' +
    (logsPaused === true ? 'Live' : 'Pause') + '\n' + '          </button>\n' +
    '          <button title="Clear logs" data-action="clearLogs">Clear</button>\n' +
    '          <button id="logs-scroll" title="Toggle auto-scroll" data-action="toggleScroll">\n' + '            ' +
    (logsAutoScroll === true ? 'Scroll' : 'Manual') + '\n' + '          </button>\n' + '        </div>\n' + '      </div>\n' + '\n' +
    '      <div id="logs" class="log-output"></div>\n' + '    </section>\n' + '  '
  );
}

// Project-specific page renderer.
// HomeKitUI remains generic by rendering trusted host-provided HTML,
// list data, or schema-backed config sections.
function projectPage() {
  // Find the active page definition
  let page = (state.info.pages || []).find((item) => item.id === state.page);

  if (page === undefined) {
    return '';
  }

  let data = state.pageData[page.id];

  // HTML page (fully rendered by trusted backend)
  if (page.trustedHTML === true && data !== undefined && data !== null && data.type === 'html' && typeof data.html === 'string') {
    // Inject CSS once (or update it if changed)
    if (typeof data.css === 'string' && data.css !== '') {
      let style = document.getElementById('project-style');

      if (style === null) {
        style = document.createElement('style');
        style.id = 'project-style';
        document.head.appendChild(style);
      }

      if (style.textContent !== data.css) {
        style.textContent = data.css;
      }
    }

    return (
      '\n' + '      <h1>' + escapeHTML(page.title) + '</h1>\n' + '      ' +
      (data.html) + '\n' + '    '
    );
  }

  // LIST page (inline rendering)
  if (data !== undefined && data !== null && data.type === 'list' && Array.isArray(data.items) === true) {
    return (
      '\n' + '      <h1>' + escapeHTML(page.title) + '</h1>\n' + '\n' + '      <section class="card">\n' +
      '        <div class="card-title">' + escapeHTML(page.title) + '</div>\n' + '\n' + '        <div class="list">\n' + '          ' +
      (data.items
            .map((item) => {
              // Render each row safely
              return (
                '\n' + '                <div class="list-row">\n' + '                  <div>\n' +
                '                    <div class="list-title">' + escapeHTML(item.title || '') + '</div>\n' +
                '                    <div class="list-sub">' + escapeHTML(item.subtitle || '') + '</div>\n' + '                  </div>\n' +
                '\n' + '                  ' +
                (item.value !== undefined ? ('<div class="list-value">' + (escapeHTML(String(item.value))) + '</div>') : '') + '\n' +
                '                </div>\n' + '              '
              );
            })
            .join('')) +
      '\n' + '        </div>\n' + '      </section>\n' + '    '
    );
  }

  // Default: schema-driven config page
  return renderConfigPage(page);
}

// Generic config page renderer.
// The actual schema-driven form is mounted later by renderSchemaMount().
/**
 * @param {UIPage} page Host page metadata selecting a configuration section.
 * @returns {string} Configuration shell with a mount for DOM form controls.
 */
function renderConfigPage(page) {
  let addButton = '';
  let hasChanges = state.changedPaths.size > 0;

  // Array-backed config pages get an Add button.
  if (page?.schemaPath !== undefined) {
    let schema = getSchemaAtPath(page.schemaPath);

    if (schema?.type === 'array' && schema?.items?.type === 'object') {
      addButton = ('<button class="secondary" data-action="addSchemaItem" data-path="' + escapeHTML(page.schemaPath) + '">+ Add</button>');
    }
  }

  return (
    '\n' + '    <h1>' + escapeHTML(page.title) + '</h1>\n' + '\n' + '    <section class="card">\n' +
    '      <div class="config-page-header">\n' + '        <div class="card-description">Manage settings</div>\n' + '\n' +
    '        <div class="actions">\n' + '          <button\n' + '            id="save-config"\n' + '            class="' +
    (hasChanges === true ? 'primary' : 'secondary') + '"\n' + '            ' +
    (saveInProgress === true || hasChanges !== true ? 'disabled' : '') + '\n' + '            data-action="saveConfig"\n' + '          >\n' +
    '            ' +
    (saveInProgress === true ? 'Saving…' : hasChanges === true ? 'Save Changes' : 'No Changes') + '\n' + '          </button>\n' + '\n' +
    '          ' + addButton + '\n' + '        </div>\n' + '      </div>\n' + '\n' + '      <div id="schemaForm"></div>\n' +
    '    </section>\n' + '  '
  );
}

// Change active page and load data/config if required
/**
 * @param {string} page Built-in status ID or configured project page ID.
 * @returns {Promise<void>} Resolves after page loading and rendering.
 */
async function setPage(page) {
  let logs = document.getElementById('logs');

  if (logs !== null) {
    logScrollTop = logs.scrollTop;
  }

  state.page = page;
  state.error = undefined;

  if (window.location.hash !== '#' + page) {
    window.location.hash = page;
  }

  if (page !== 'status') {
    try {
      await loadPageData(page);

      if (Object.keys(state.config).length === 0) {
        await loadConfig(false);
      }
    } catch (error) {
      if (isAuthRequiredError(error) === true) {
        render();
        return;
      }

      state.error = String(error.message || error);
    }
  }

  lastPageRefresh = 0;
  render();
}

// Load dynamic page data from backend
/**
 * @param {string} pageId Configured host page ID.
 * @returns {Promise<void>} Applies only the latest read; preserves the payload on failure or invalidation.
 * @throws {Error} When authentication is cancelled.
 */
async function loadPageData(pageId) {
  let generation = (pageRequestGenerations.get(pageId) ?? 0) + 1;
  pageRequestGenerations.set(pageId, generation);

  try {
    let payload = await api(('/api/page/' + pageId));
    if (pageRequestGenerations.get(pageId) !== generation) {
      return;
    }
    state.pageData[pageId] = payload;
    state.error = undefined;
  } catch (error) {
    if (isAuthRequiredError(error) === true) {
      throw error;
    }

    // Obsolete failures must not overwrite a newer action result either.
    if (pageRequestGenerations.get(pageId) !== generation) {
      return;
    }

    // Preserve the last successful payload so transient failures leave useful state.
    state.error = String(error.message || error);
  }
}

// Load config + schema from backend
/**
 * @param {boolean} [doRender=true] Whether to render after loading configuration and schemas.
 * @returns {Promise<void>} Records ordinary load failures; rejects authentication cancellation.
 */
async function loadConfig(doRender = true) {
  try {
    state.config = await api('/api/config');
    state.schema = await api('/api/schema');
    state.uiSchema = await api('/api/ui-schema');
  } catch (error) {
    if (isAuthRequiredError(error) === true) {
      throw error;
    }

    state.error = String(error.message || error);
  }

  if (doRender === true) {
    render();
  }
}

async function retryAuthentication() {
  state.error = undefined;

  let auth = await requestStoredAuthToken();

  if (auth === undefined || typeof auth.token !== 'string' || auth.token.trim() === '') {
    setAuthRequired(true);
    render();
    return;
  }

  setAuthRequired(false);
  await load();
}

// Save the current in-memory configuration model back to the backend.
// Handles:
// - restart-required detection using schema metadata
// - page-level restart overrides
// - authenticated config persistence
// - clearing tracked frontend change state after successful save
async function saveConfig() {
  if (saveInProgress === true || state.changedPaths.size === 0) {
    return;
  }

  // Keep edits available during I/O, but never allow overlapping save requests.
  saveInProgress = true;
  let submittedRevision = configRevision;
  updateSaveButton();

  try {
    // Determine the active page so page-level restart behaviour can override
    // schema-level restart detection when explicitly configured.
    let page = (state.info.pages || []).find((item) => item.id === state.page);

    // Default to "no restart required" unless a changed field explicitly
    // requires one via schema metadata or fallback behaviour.
    let restartRequired = false;

    // Page-level override:
    // If restartRequired is explicitly false for this page, never require
    // a restart regardless of changed field metadata.
    if (page?.restartRequired !== false) {
      // Evaluate each changed config path against schema metadata.
      //
      // Restart detection walks upward through the schema hierarchy:
      //
      // Example:
      // - options.flowRate
      // - options
      //
      // This allows parent schema sections to define restart behaviour
      // for entire groups of related configuration fields.
      restartRequired = [...state.changedPaths].some((changedPath) => {
        let parts = changedPath.split('.');

        while (parts.length > 0) {
          // Resolve schema at current hierarchy depth.
          let schema = getSchemaAtPath(parts.join('.'));

          if (schema !== undefined) {
            // Explicit override:
            // This field/group does NOT require restart.
            if (schema.restartRequired === false) {
              return false;
            }

            // Explicit override:
            // This field/group DOES require restart.
            if (schema.restartRequired === true) {
              return true;
            }
          }

          // Move upward one level in schema hierarchy.
          parts.pop();
        }

        // No explicit schema override found.
        // Default to safe behaviour and assume restart required.
        return true;
      });
    }

    // Persist updated configuration to backend.
    // Authentication headers are automatically injected by api().
    await api('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(state.config),
    });

    // Clear tracked frontend change state after successful save.
    // A later edit was not part of the submitted payload; retain its dirty state.
    if (configRevision === submittedRevision) {
      state.changedPaths.clear();
    }

    // Notify user only when restart is required for changes to apply.
    if (restartRequired === true) {
      alert('Configuration saved. Restart required for changes to take effect.');
    }
  } catch (error) {
    // Surface backend validation, save, or transport failures directly to user.
    alert(String(error.message || error));
  } finally {
    saveInProgress = false;
    updateSaveButton();
  }
}

// Download the current backend configuration as a local backup file.
// Uses the authenticated API download helper because normal browser
// links cannot attach Authorisation headers for protected endpoints.
async function backupConfig() {
  try {
    await downloadAPI('/api/backup', 'config.backup.json');
  } catch (error) {
    // Surface download or authentication failures directly to the user.
    alert(String(error.message || error));
  }
}

// Send a project-defined UI action to the backend.
// Used by dynamic pages for controls that are not configuration changes,
// such as dashboard buttons, runtime commands, or device actions.
//
// Actions are intentionally generic so HomeKitUI does not need to know
// about project-specific concepts such as irrigation zones, cameras,
// locks, weather systems, or garage doors.
/**
 * @param {string} action Host-defined command ID.
 * @param {Object<string, *>} [data={}] Host-defined command parameters.
 * @returns {Promise<void>} Dispatches for the active page, refreshes its data, and reports errors.
 */
async function sendAction(action, data = {}) {
  if (typeof action !== 'string' || action === '') {
    return;
  }

  // Capture the originating page and invalidate older reads before dispatch.
  // This applies to every host-defined action, including overlapping controls.
  let pageId = state.page;
  pendingActionCount++;
  pageRequestGenerations.set(pageId, (pageRequestGenerations.get(pageId) ?? 0) + 1);

  try {
    await api('/api/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, data, page: pageId }),
    });

    if (pageId !== 'status') {
      await loadPageData(pageId);
    }

    if (state.page === pageId) {
      // Collapse/visibility state stays in memory; do not restore an old snapshot
      // over frontend interactions made while the action was pending.
      lastPageRefresh = Date.now();
      scheduleRender();
    }
  } catch (error) {
    alert(String(error.message || error));
  } finally {
    pendingActionCount--;
  }
}

// Start live log stream from HomeKitUI.
// Uses Server-Sent Events so backend log entries can be pushed to the
// browser without polling.
//
// EventSource cannot send custom Authorisation headers, so when a bearer
// token is stored locally it is appended as a query parameter. The backend
// only accepts this query-token fallback for the log streaming endpoint.
function startLogStream() {
  if (state.authRequired === true) {
    return;
  }

  if (logStream !== undefined) {
    return;
  }

  let token = authToken();
  let url = '/api/logs/stream';

  if (token !== '') {
    url += '?token=' + encodeURIComponent(token);
  }

  logStream = new EventSource(url);

  logStream.onopen = () => {
    // When reconnecting after a restart, reload history so startup logs are not missed.
    loadLogs(true).catch((error) => {
      if (isAuthRequiredError(error) === true) {
        render();
      }
    });
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
      window.clearTimeout(logReconnectTimer);
    }

    logReconnectTimer = window.setTimeout(() => {
      logReconnectTimer = undefined;
      startLogStream();
    }, 2000);
  };
}

// Reload current log history from backend
/**
 * @param {boolean} [scroll=true] Whether the refreshed log view may auto-scroll.
 * @returns {Promise<void>} Updates history; transient failures preserve it and authentication cancellation rejects.
 */
async function loadLogs(scroll = true) {
  try {
    state.logs = (await api('/api/logs')).logs || [];
    renderLogsOnly(scroll);
  } catch (error) {
    if (isAuthRequiredError(error) === true) {
      throw error;
    }

    // Ignore transient log reload failures
  }
}

// Append a single live log entry without re-rendering the full page
/**
 * @param {UILogEntry} entry Backend log record; HTML comes from backend ANSI conversion.
 */
function appendLog(entry) {
  if (logsPaused === true) {
    return;
  }

  let logs = document.getElementById('logs');

  if (logs === null) {
    return;
  }

  let div = document.createElement('div');
  let html = typeof entry.html === 'string' && entry.html.includes('<span') === true ? entry.html : escapeHTML(entry.message || '');

  div.className = 'log-line log-' + escapeClassName(entry.level || 'info');
  div.innerHTML = html;

  logs.appendChild(div);

  while (logs.children.length > 500) {
    logs.removeChild(logs.firstChild);
  }

  if (logsAutoScroll === true) {
    logs.scrollTop = logs.scrollHeight - logs.clientHeight;
  }
}

// Render current log history into the log output element
/**
 * @param {boolean} [scroll=true] Whether to auto-scroll when automatic scrolling is enabled.
 */
function renderLogsOnly(scroll = true) {
  let logs = document.getElementById('logs');

  // Logs element is not present on the current page/render.
  if (logs === null) {
    return;
  }

  // Rebuild the current buffered log history as safe HTML.
  logs.innerHTML = state.logs
    .map((entry) => {
      // Ignore invalid log entries.
      if (entry === null || typeof entry !== 'object') {
        return '';
      }

      // Restrict level to safe class-name characters.
      let level = escapeClassName(entry.level || 'info');

      // Prefer ANSI-rendered HTML from backend, otherwise escape plain text.
      let html = typeof entry.html === 'string' && entry.html.includes('<span') === true ? entry.html : escapeHTML(entry.message || '');

      return '<div class="log-line log-' + level + '">' + html + '</div>';
    })
    .join('');

  // Restore previous manual scroll position if auto-scroll is disabled
  // or if caller explicitly requested no scrolling.
  if (scroll !== true || logsAutoScroll !== true) {
    logs.scrollTop = logScrollTop;
    return;
  }

  // Defer scroll until after DOM has been updated.
  window.setTimeout(() => {
    logs.scrollTop = logs.scrollHeight - logs.clientHeight;
  }, 0);
}

// Starts the shared frontend runtime timer.
// Handles lightweight local updates every second, plus slower backend polling
// for HomeKit status and page-specific refreshes. This avoids multiple timers
// competing with each other as more dynamic pages are added.
function startRuntimeTimer() {
  if (runtimeTimer !== undefined) {
    return;
  }

  runtimeTimer = window.setInterval(async () => {
    if (state.authRequired === true) {
      return;
    }

    uptimeSeconds++;

    document.querySelectorAll('.uptime').forEach((uptime) => {
      uptime.textContent = formatUptime(uptimeSeconds);
    });

    let now = Date.now();

    // Poll general HomeKit/UI status every 30 seconds.
    if (now - lastStatusPoll >= 30000) {
      lastStatusPoll = now;

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

          if (state.page === 'status') {
            scheduleRender();
          }
        }
        // eslint-disable-next-line no-unused-vars
      } catch (error) {
        // Ignore transient failures
      }
    }

    // Refresh dynamic project pages that request periodic updates.
    // Do not refresh while the user is interacting with a form/control,
    // otherwise the page can re-render while a select/dropdown is open.
    let page = (state.info.pages || []).find((item) => item.id === state.page);
    let refreshInterval = Number(page?.refreshInterval);
    let uiControlActive = pageInteractionActive();

    // Retry deferred rendering without starting another page request first.
    if (renderPending === true) {
      scheduleRender(renderBackgroundOnly);
    }

    if (
      uiControlActive !== true &&
      pageRefreshInProgress === false &&
      state.page !== 'status' &&
      page?.schemaPath === undefined &&
      Number.isFinite(refreshInterval) === true &&
      refreshInterval > 0 &&
      now - lastPageRefresh >= refreshInterval
    ) {
      lastPageRefresh = now;

      // Async interval callbacks can overlap. Keep one automatic read in flight
      // so slow responses are not continually invalidated by the next poll.
      pageRefreshInProgress = true;
      try {
        await loadPageData(page.id);
        scheduleRender(true);
      } finally {
        pageRefreshInProgress = false;
      }
    }
  }, 1000);
}

// Apply optional project-provided theme colours
/**
 * @param {UITheme} theme Optional host colours applied to shell CSS variables.
 */
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

// Toggle a project-provided collapsible section.
// Open state is stored so dynamic page refreshes and browser refreshes can re-apply it.
/**
 * @param {string} id DOM ID of the project panel whose state is remembered.
 */
function toggleCollapse(id) {
  let element = document.getElementById(id);

  if (element === null) {
    return;
  }

  let storageKey = 'homekitui-collapse-' + state.page + '-' + id;

  if (state.collapse[id] === undefined) {
    state.collapse[id] = element.classList.contains('open');
  }

  state.collapse[id] = state.collapse[id] === true ? false : true;
  writeBrowserStorage(storageKey, state.collapse[id] === true ? 'true' : 'false');

  element.classList.toggle('open', state.collapse[id] === true);

  document.querySelectorAll(('[data-target="' + (id) + '"]')).forEach((button) => {
    button.classList.toggle('open', state.collapse[id] === true);
  });

  lastPageRefresh = Date.now();
}

// Re-apply stored collapse state after a page re-render.
function restoreCollapseState() {
  if (typeof state.collapse !== 'object' || state.collapse === null) {
    return;
  }

  document.querySelectorAll('.dashboard-collapse').forEach((element) => {
    if (typeof element.id !== 'string' || element.id === '') {
      return;
    }

    let storageKey = 'homekitui-collapse-' + state.page + '-' + element.id;
    let storedValue = readBrowserStorage(storageKey);

    if (storedValue !== null) {
      state.collapse[element.id] = storedValue === 'true';
    }

    let isOpen = state.collapse[element.id] === true;

    // Restore panel
    element.classList.toggle('open', isOpen);

    // Restore matching toggle buttons
    document.querySelectorAll(('[data-target="' + (element.id) + '"]')).forEach((button) => {
      button.classList.toggle('open', isOpen);
    });
  });
}

// Apply visible-switch state for one control.
// Used by trusted project pages for simple frontend-only view switching.
/**
 * @param {HTMLSelectElement|HTMLInputElement} control Project control with data-target-group.
 * @param {string} value Selected visibility value; nullish values use the control value.
 * @param {boolean} [persist=false] Whether to remember this selection across reloads when storage permits.
 */
function applyVisibleState(control, value, persist = false) {
  if (control === null || control === undefined) {
    return;
  }

  let group = control.dataset.targetGroup;

  if (typeof group !== 'string' || group === '') {
    return;
  }

  let selectedValue = String(value ?? control.value);
  let storageKey = 'homekitui-visible-' + state.page + '-' + group;

  state.visible[group] = selectedValue;
  control.value = selectedValue;

  if (persist === true) {
    writeBrowserStorage(storageKey, selectedValue);
  }

  let root = control.closest('[data-visible-root]') || document;

  root.querySelectorAll('[data-visible-group="' + group + '"]').forEach((item) => {
    item.hidden = item.dataset.visibleValue !== selectedValue;
  });
}

// Re-apply stored generic visible-switch state after a page re-render.
function restoreVisibleState() {
  if (typeof state.visible !== 'object' || state.visible === null) {
    return;
  }

  document.querySelectorAll('[data-action="switchVisible"]').forEach((control) => {
    let group = control.dataset.targetGroup;

    if (typeof group !== 'string' || group === '') {
      return;
    }

    let storageKey = 'homekitui-visible-' + state.page + '-' + group;
    let value = state.visible[group];

    if (value === undefined) {
      value = readBrowserStorage(storageKey);
    }

    if (value === null || value === undefined) {
      value = control.value;
    }

    applyVisibleState(control, value, false);
  });
}

// Format uptime seconds into short display string
/**
 * @param {number} seconds Process uptime in seconds.
 * @returns {string} Days, hours, minutes, and seconds for display.
 */
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

// Reset HomeKit pairing for a selected accessory.
// This removes all paired HomeKit controllers for the accessory and
// forces it back into an unpaired/setup state.
//
// Multi-accessory projects pass the accessory username explicitly.
// Single-accessory projects fall back to the primary HomeKit accessory.
/**
 * @param {string} [username=state.homekit.username] HAP identifier of the selected accessory.
 * @returns {Promise<void>} Requests confirmed cleanup; API failures reject.
 */
async function resetPairing(username = state.homekit.username) {
  // Pairing reset is destructive and requires the accessory to be
  // re-added in Apple Home or another HomeKit controller.
  if (confirm('Reset HomeKit pairing? This removes all paired controllers.') !== true) {
    return;
  }

  // Request pairing removal from backend.
  // Authentication headers are automatically injected by api().
  await api('/api/homekit/reset', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username }),
  });

  // Backend may restart automatically depending on project configuration.
  alert('Pairing reset. Restart and re-pair.');
}

// Safely get nested config path
/**
 * @param {string} schemaPath Dot path; empty or undefined selects the root configuration.
 * @returns {*} Selected value, or undefined for a missing path.
 */
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

// Download a backend-generated file using authenticated fetch.
// Normal browser links cannot include Authorisation headers, so protected
// downloads must be fetched first and then saved via a temporary object URL.
/**
 * @param {string} apiPath Same-origin download endpoint.
 * @param {string} filename Browser download filename.
 * @returns {Promise<void>} Downloads an authenticated response and releases its object URL.
 * @throws {Error} On authentication cancellation, transport, or HTTP failure.
 */
async function downloadAPI(apiPath, filename) {
  let response = await authenticatedFetch(apiPath);

  if (response.ok !== true) {
    let data = await response.json().catch(() => ({}));

    throw new Error(data.error || 'Download failed');
  }

  let blob = await response.blob();
  let url = window.URL.createObjectURL(blob);
  let link = document.createElement('a');

  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();

  window.URL.revokeObjectURL(url);
}

// Update the Save Configuration button state.
// Dynamically switches styling, label, and enabled state based on whether
// any config fields have been modified (tracked via state.changedPaths).
// Called after render() to keep the button in sync with user edits.
function updateSaveButton() {
  let button = document.getElementById('save-config');

  // Save button is only present on schema/config pages.
  if (button === null) {
    return;
  }

  // Any tracked config path means the form has unsaved changes.
  let hasChanges = state.changedPaths.size > 0;

  // Use primary styling only when there are changes to save.
  button.className = hasChanges === true ? 'primary' : 'secondary';

  // Prevent pointless saves when nothing has changed.
  button.disabled = saveInProgress === true || hasChanges !== true;

  // Make the button state obvious to the user.
  button.textContent = saveInProgress === true ? 'Saving…' : hasChanges === true ? 'Save Changes' : 'No Changes';
}

// Escape HTML safely
/**
 * @param {*} value Value converted to text; nullish values become an empty string.
 * @returns {string} Text escaped for HTML content and quoted attributes.
 */
function escapeHTML(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll('\'', '&#039;');
}

// Restrict dynamic class names to safe characters
/**
 * @param {*} value Dynamic CSS class suffix.
 * @returns {string} Only alphanumeric, underscore, and hyphen characters.
 */
function escapeClassName(value) {
  return String(value ?? '').replaceAll(/[^a-zA-Z0-9_-]/g, '');
}

// Safely set value in nested object using path
/**
 * @param {Configuration} obj Mutable configuration model.
 * @param {(string|number)[]} path Non-empty path; numbers select array entries.
 * @param {*} value New field value.
 * @returns {void} Mutates the model, tracks the path and revision, and updates the save button.
 */
function setValueAtPath(obj, path, value) {
  let ref = obj;

  for (let i = 0; i < path.length - 1; i++) {
    if (ref[path[i]] === undefined) {
      ref[path[i]] = typeof path[i + 1] === 'number' ? [] : {};
    }

    ref = ref[path[i]];
  }

  ref[path[path.length - 1]] = value;

  // Track changed path for restart logic.
  if (Array.isArray(path) === true && path.length > 0) {
    state.changedPaths.add(path.join('.'));
    configRevision++;
  }

  // Refresh only the save button state, not the full page.
  updateSaveButton();
}

// Create a default config value from a schema definition
/**
 * @param {SchemaDefinition} schema Schema whose explicit defaults or type determine a new value.
 * @returns {*} Independently owned default, generated object/array/boolean, first enum value, or undefined.
 */
function getDefaultValue(schema) {
  if (schema?.default !== undefined) {
    // Each inserted item owns its defaults; edits must not mutate sibling items or schema.
    return structuredClone(schema.default);
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

  if (Array.isArray(schema?.enum) === true) {
    return structuredClone(schema.enum[0]);
  }

  return undefined;
}

// Resolve a nested schema section from the root JSON schema using a dot path
// (e.g. "doors", "options.something"). This mirrors getSchemaPathValue()
// but operates on the schema definition instead of the config data.
/**
 * @param {string} schemaPath Dot path; array indexes resolve through the shared items schema.
 * @returns {SchemaDefinition|undefined} Matching schema, or the root for an empty or undefined path.
 */
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
/**
 * @param {UIPage} page Host icon name or SVG metadata.
 * @returns {string} Allowed SVG markup, a built-in icon, or the default dot.
 */
function icon(page) {
  if (typeof page?.svg === 'string' && page.svg.length <= 5000 && page.svg.trim() !== '' && page.svg.includes('<svg') === true) {
    try {
      let parser = new DOMParser();
      let doc = parser.parseFromString(page.svg, 'image/svg+xml');
      let root = doc.querySelector('svg');

      if (root !== null && doc.querySelector('parsererror') === null) {
        // Only inert SVG geometry and local fragment references belong in icons.
        let elements = new Set([
          'svg', 'g', 'defs', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline',
          'polygon', 'title', 'desc', 'use', 'symbol', 'lineargradient', 'radialgradient',
          'stop', 'clippath', 'mask',
        ]);
        let attributes = new Set([
          'xmlns', 'viewbox', 'width', 'height', 'id', 'role', 'aria-label', 'aria-hidden',
          'd', 'points', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry',
          'fill', 'fill-rule', 'fill-opacity', 'stroke', 'stroke-width', 'stroke-linecap',
          'stroke-linejoin', 'stroke-miterlimit', 'stroke-dasharray', 'stroke-dashoffset',
          'stroke-opacity', 'opacity', 'transform', 'preserveaspectratio', 'clip-path',
          'clip-rule', 'mask', 'href', 'xlink:href', 'offset', 'stop-color', 'stop-opacity',
          'gradientunits', 'gradienttransform', 'spreadmethod', 'fx', 'fy',
        ]);

        // Include the root: descendant-only queries miss svg onload attributes.
        [root, ...root.querySelectorAll('*')].forEach((element) => {
          if (elements.has(element.localName.toLowerCase()) !== true) {
            element.remove();
            return;
          }

          [...element.attributes].forEach((attribute) => {
            let name = attribute.name.toLowerCase();
            let value = attribute.value.trim();
            let localReference = /^#[a-zA-Z0-9_-]+$/.test(value) === true;
            let unsafeURL = /url\s*\(/i.test(value) === true && /^url\(#[a-zA-Z0-9_-]+\)$/.test(value) !== true;

            if (
              attributes.has(name) !== true || unsafeURL === true ||
              ((name === 'href' || name === 'xlink:href') && localReference !== true)
            ) {
              element.removeAttribute(attribute.name);
            }
          });
        });

        return root.outerHTML;
      }
    } catch {
      // fall through to default
    }
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

// Lock icon
function lockIcon() {
  return (
    '<svg viewBox="0 0 24 24">' +
    '<rect x="5" y="10" width="14" height="10" rx="2"/>' +
    '<path d="M8 10V7a4 4 0 0 1 8 0v3"/>' +
    '<path d="M12 14v2"/>' +
    '</svg>'
  );
}

// Eye icon
function eyeIcon() {
  return (
    '<svg viewBox="0 0 24 24">' + '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/>' + '<circle cx="12" cy="12" r="3"/>' + '</svg>'
  );
}

// Expose functions globally for inline onclick handlers
window.scheduleRender = scheduleRender;
window.setPage = setPage;
window.restartService = restartService;
window.resetPairing = resetPairing;
window.loadConfig = loadConfig;
window.saveConfig = saveConfig;
window.togglePause = togglePause;
window.clearLogs = clearLogs;
window.toggleScroll = toggleScroll;
window.toggleCollapse = toggleCollapse;
window.sendAction = sendAction;
window.addSchemaItem = addSchemaItem;
// Global click handler using event delegation.
// Handles:
// - Page navigation (data-page)
// - Backend-driven actions (data-send-action)
// - Built-in UI actions (data-action)
document.addEventListener('click', async (event) => {
  // Page navigation (sidebar)
  //
  // Buttons declare: data-page="..."
  // Example: <button data-page="status">
  let pageButton = event.target.closest('[data-page]');

  if (pageButton !== null) {
    await setPage(pageButton.dataset.page);
    return;
  }

  // Backend-defined actions (custom dashboards)
  //
  // Buttons declare:
  // - data-send-action="actionName"
  // - data-payload='{"key":"value"}'
  //
  // This allows backend HTML to trigger actions without inline JS.
  let sendActionButton = event.target.closest('[data-send-action]');

  if (sendActionButton !== null) {
    let data = {};

    // Safely parse payload JSON
    try {
      data = JSON.parse(sendActionButton.dataset.payload || '{}');
    } catch {
      data = {};
    }

    // Dispatch action to backend
    await sendAction(sendActionButton.dataset.sendAction, data);
    return;
  }

  // Built-in UI actions
  //
  // Buttons declare: data-action="..."
  // Used for core UI features (logs, config, restart, etc.)
  let actionButton = event.target.closest('[data-action]');

  if (actionButton !== null) {
    let action = actionButton.dataset.action;

    // Restart service (backend call)
    if (action === 'restartService') {
      await restartService();
      return;
    }

    // Download configuration backup
    if (action === 'backupConfig') {
      await backupConfig();
      return;
    }

    if (action === 'authenticate') {
      await retryAuthentication();
      return;
    }

    // Reset HomeKit pairing for selected accessory
    if (action === 'resetPairing') {
      await resetPairing(actionButton.dataset.username);
      return;
    }

    // Clear log buffer (frontend only)
    if (action === 'clearLogs') {
      clearLogs();
      return;
    }

    // Pause/resume live logs
    if (action === 'togglePause') {
      togglePause();
      return;
    }

    // Toggle auto-scroll behaviour
    if (action === 'toggleScroll') {
      toggleScroll();
      return;
    }

    // Save configuration (backend call)
    if (action === 'saveConfig') {
      await saveConfig();
      return;
    }

    // Add item to schema array
    if (action === 'addSchemaItem') {
      addSchemaItem(actionButton.dataset.path);
      return;
    }

    // Collapse/expand UI sections
    if (action === 'toggleCollapse') {
      toggleCollapse(actionButton.dataset.target);
      return;
    }
  }
});

// Track actual control interaction independently from retained browser focus.
['pointerdown', 'keydown', 'input', 'change'].forEach((type) => {
  document.addEventListener(type, (event) => {
    if (event.target.closest('input, textarea, select, button, [data-action], [data-send-action]') !== null) {
      lastControlInteraction = Date.now();
      if (type === 'pointerdown') {
        activeControlPointers.add(event.pointerId);
      }
    }
  });
});

// Hold controls for the complete pointer gesture, even if it lasts over five
// seconds. Pointer release bubbles before click; deferred renders run afterward.
['pointerup', 'pointercancel'].forEach((type) => {
  document.addEventListener(type, (event) => {
    if (activeControlPointers.delete(event.pointerId) === true) {
      lastControlInteraction = Date.now();
    }
  });
});
window.addEventListener('blur', () => activeControlPointers.clear());

// Global change handler using event delegation.
// Handles generic frontend-only UI changes without inline JavaScript.
document.addEventListener('change', (event) => {
  let control = event.target.closest('[data-action="switchVisible"]');

  if (control === null) {
    return;
  }

  applyVisibleState(control, control.value, true);
});

window.addEventListener('hashchange', async () => {
  let page = window.location.hash.replace('#', '') || 'status';
  let exists = (state.info.pages || []).some((p) => p.id === page) || page === 'status';
  if (exists === true && page !== state.page) {
    await setPage(page);
  }
});

// Start UI
load();
startRuntimeTimer();
