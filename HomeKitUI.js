// Module: HomeKitUI
//
// Shared web UI module for HomeKit-enabled standalone applications.
// Designed to provide a lightweight, Homebridge-like setup and maintenance
// interface for accessories built using HAP-NodeJS.
//
// Provides a simple browser-based interface for configuring, maintaining,
// and managing HomeKit accessories without requiring Homebridge.
//
// Responsibilities:
// - Serve the built-in HomeKitUI web interface
// - Expose config.json, config.schema.json, and config.ui.schema.json for UI rendering
// - Provide generic project page data through a single page API endpoint
// - Handle configuration save, validation, backup, and restore workflows
// - Provide HomeKit pairing details (QR code, setup URI, pairing state)
// - Stream logs from a file, journald or console capture
// - Support resetting HomeKit pairing data via HAP-NodeJS cleanup
// - Provide optional hooks for restart and maintenance actions
// - Provide optional bearer-token authentication for API/UI access
//
// Architecture:
// - Intended to be used alongside HomeKitDevice-based projects
// - Operates at the application/bridge level (not per-device instance)
// - HomeKitUI owns the application shell, status page, logs, and maintenance controls
// - Host projects provide configuration schema, optional pages, and page data hooks
// - UI communicates with the host application via API endpoints and hooks
// - Authentication is handled centrally via Express middleware before route handling
//
// API Endpoints:
// - GET  /api/info
// - GET  /api/config
// - POST /api/config
// - GET  /api/schema
// - GET  /api/ui-schema
// - GET  /api/page/:id
// - GET  /api/homekit
// - POST /api/homekit/reset
// - POST /api/service/restart
// - GET  /api/logs
// - GET  /api/logs/stream
// - GET  /api/backup
// - POST /api/restore
// - POST /api/action
//
// Authentication:
// - Provide optional Web UI password authentication for API/UI access
// - Uses standard HTTP Authorization: Bearer <token> header
// - SSE log streaming supports token query parameter fallback because
//   native browser EventSource does not support custom headers
// - Authentication tokens are supplied by the host application
// - Host application remains responsible for token generation/persistence
//
// Notes:
// - Designed for HAP-NodeJS standalone environments (not Homebridge)
// - Does not manage accessory lifecycle or publishing directly
// - Host application remains responsible for device creation and runtime control
// - Resetting HomeKit pairing removes all controllers and requires re-pairing
// - Explicit log file is preferred when configured
// - Journald is preferred in auto mode when running under systemd
// - Console capture is used as fallback for direct/manual runs
// - Built-in UI is always served from this module's ui folder
// - Default host binding is loopback unless explicitly configured
//
// Mark Hulskamp
'use strict';

// Define external module requirements
import express from 'express';
import QRCode from 'qrcode';
import { AnsiUp } from 'ansi_up';

// Define nodejs module requirements
import console from 'node:console';
import { Buffer } from 'node:buffer';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import util from 'node:util';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Define constants
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATIC_PATH = path.join(__dirname, 'ui');
const MAX_LOG_LINE_CHARS = 16384;
const MAX_LOG_HISTORY_BYTES = 1024 * 1024;
const MAX_LOG_HISTORY_LINES = 10000;

const LOG_LEVELS = {
  INFO: 'info',
  SUCCESS: 'success',
  WARN: 'warn',
  ERROR: 'error',
  DEBUG: 'debug',
};

/**
 * @typedef {Object<string, *>} Configuration
 * Complete JSON configuration. The host validates application-specific semantics.
 */

/**
 * @typedef {object} UIPage
 * @property {string} id Unique project page ID; status belongs to the built-in page.
 * @property {string} title Sidebar label.
 * @property {string} [icon] Built-in icon name.
 * @property {string} [svg] Filtered SVG icon markup.
 * @property {string} [schemaPath] Dot-separated path into configuration and schema.
 * @property {boolean} [restartRequired] False suppresses page restart advice.
 * @property {number} [refreshInterval] Dynamic-page refresh interval in milliseconds.
 * @property {boolean} [trustedHTML] Allows host-owned HTML and CSS page payloads.
 */

/**
 * @typedef {object} UIAccessory
 * @property {string} [displayName] Accessory label.
 * @property {string} [username] HAP accessory identifier.
 * @property {string} [lastKnownUsername] Fallback HAP identifier.
 * @property {string} [pincode] Setup code.
 * @property {function(): string} [setupURI] HAP setup URI provider.
 * @property {string} [_setupID] HAP setup identifier.
 * @property {{username?: string, pincode?: string, setupID?: string,
 *   paired?: function(): boolean, listPairings?: function(): object[]}} [_accessoryInfo] HAP pairing metadata.
 */

/**
 * @typedef {object} UILogEntry
 * @property {string} time ISO timestamp assigned during capture or conversion.
 * @property {string} level Console level or info for file/journal lines.
 * @property {string} message Bounded terminal line.
 * @property {string} terminal Raw terminal text retained for ANSI conversion.
 * @property {string} html ANSI-converted HTML.
 */

/**
 * @typedef {object} HomeKitUIOptions
 * @property {string} [name='HomeKit Device'] Application name.
 * @property {string} [version] Application version; defaults to HomeKitUI.VERSION.
 * @property {number} [port=8581] HTTP port; invalid values disable startup.
 * @property {string} [host='127.0.0.1'] HTTP binding; an empty value uses Node's default.
 * @property {{enabled?: boolean, bearerToken?: string}} [auth] Optional API bearer credentials.
 * @property {string} [configFile] Configuration path for reads and default writes.
 * @property {string} [schemaFile] JSON Schema path.
 * @property {string} [uiSchemaFile] Optional UI schema path.
 * @property {Object<string, string>} [theme] Browser theme colours.
 * @property {UIPage[]} [pages=[]] Project page definitions.
 * @property {UIAccessory} [accessory] Single-accessory fallback.
 * @property {UIAccessory[]} [accessories=[]] Published accessories.
 * @property {{Accessory?: {cleanupAccessoryData: function(string): void}}} [hap] HAP cleanup API.
 * @property {Object<string, function>} [log] Host logger with level methods.
 * @property {{source?: string, file?: string, unit?: string, lines?: number}} [logs] Log source and bounded history.
 * @property {function(string): (object|Promise<object>)} [onGetPage] Project renderer payload provider.
 * @property {function(string, object, string=): (void|Promise<void>)} [onAction] Project action dispatcher.
 * @property {function(Configuration): (void|Promise<void>)} [onValidateConfig] Throw/reject to block persistence.
 * @property {function(Configuration): (void|Promise<void>)} [onSaveConfig] Replace the default save write.
 * @property {function(Configuration): (void|Promise<void>)} [onRestoreConfig] Replace the default restore write.
 * @property {function(): (void|Promise<void>)} [onRestart] Restart after the response finishes.
 * @property {function(string, UIAccessory=): (void|Promise<void>)} [onResetPairing] Host reset policy.
 */

// Define our HomeKit UI class
export default class HomeKitUI {
  static DEFAULT_PORT = 8581;
  static VERSION = '2026.10.06';

  // Console capture state for the single management instance
  static DEFAULT_CONSOLE_HISTORY_LINES = 500;
  #consoleCaptured = false; // Prevent double-patching console.*
  #consoleHistory = []; // Recent console output for non-systemd/direct runs
  #consoleListeners = new Set(); // Live console listeners for SSE clients
  #consoleHistoryBytes = 0;
  #configWrite = Promise.resolve(); // Serialize saves and restores within this instance
  #consoleOriginal = {}; // Original console methods before capture

  // Internal data only for this class
  #ansi = new AnsiUp(); // ANSI output to HTML converter for UI consumers
  #app = undefined; // Express app instance
  #logListeners = new Map(); // Active SSE response -> cleanup callback map
  #options = {}; // Runtime options
  #server = undefined; // HTTP server instance

  /**
   * @param {HomeKitUIOptions} [options={}] Host integration settings and callbacks.
   */
  constructor(options = {}) {
    // Options must be a plain object. If not, fall back to defaults so the class
    // can still be constructed safely and fail later with useful endpoint errors.
    if (options === null || typeof options !== 'object' || options.constructor !== Object) {
      options = {};
    }

    // Inline styles keep HomeKitUI self-contained and avoid browser-side ansi_up dependency.
    this.#ansi.use_classes = false;

    // Store all runtime options in one internal object so the public class surface
    // remains small. Hooks allow each standalone app to provide its own validation,
    // saving, restart, pairing reset, and generic page data behaviour.
    this.#options = {
      name: 'HomeKit Device',
      version: HomeKitUI.VERSION,
      port: HomeKitUI.DEFAULT_PORT,
      host: '127.0.0.1',
      auth: {},
      configFile: undefined,
      schemaFile: undefined,
      uiSchemaFile: undefined,
      theme: {},
      pages: [],
      accessory: undefined,
      accessories: [],
      hap: undefined,
      log: undefined,
      logs: {},
      onGetPage: undefined,
      onValidateConfig: undefined,
      onSaveConfig: undefined,
      onAction: undefined,
      onRestoreConfig: undefined,
      onRestart: undefined,
      onResetPairing: undefined,
      ...options,
    };

    this.#normaliseOptions();
  }

  /**
   * Start the management server; top-level overrides replace nested option groups.
   * @param {HomeKitUIOptions} [options={}] Settings available after host initialisation.
   * @returns {Promise<boolean>} True when listening; false if already started or disabled.
   * @throws {Error} If server creation or binding fails; a later call may retry.
   */
  async start(options = {}) {
    // Runtime options may be supplied at start time because some values, like the
    // HAP accessory, may not exist until after the application has initialised.
    if (options !== null && typeof options === 'object' && options.constructor === Object) {
      this.#options = {
        ...this.#options,
        ...options,
      };
    }

    this.#normaliseOptions();

    // If the HTTP server is already running, don't bind twice. This makes start()
    // safe to call from app initialisation code that may be retried.
    if (this.#server !== undefined) {
      return false;
    }

    // Avoid Node/Express treating port 0 as "pick a random port". For HomeKitUI,
    // disabled should be handled by the host project, but this guard keeps the
    // module safe if an invalid port is accidentally passed in.
    if (Number.isFinite(Number(this.#options.port)) !== true || Number(this.#options.port) <= 0 || Number(this.#options.port) > 65535) {
      this.#log(LOG_LEVELS.INFO, 'HomeKitUI disabled');
      return false;
    }

    this.#options.port = Number(this.#options.port);

    // Create a new Express application for our API and built-in static UI assets.
    this.#app = express();

    // Accept JSON payloads for config save/restore and maintenance actions.
    // Limit is intentionally small since configs should not be large.
    this.#app.use(express.json({ limit: '2mb' }));

    // Register core API routes. Keep routes flat and explicit so the built-in UI can
    // remain simple and the host app has a predictable API contract.
    this.#app.use('/api', this.#handleAuthentication.bind(this));
    this.#app.get('/api/info', this.#handleInfo.bind(this));
    this.#app.get('/api/config', this.#handleGetConfig.bind(this));
    this.#app.post('/api/config', this.#handleSaveConfig.bind(this));
    this.#app.get('/api/schema', this.#handleGetSchema.bind(this));
    this.#app.get('/api/ui-schema', this.#handleGetUISchema.bind(this));
    this.#app.get('/api/page/:id', this.#handlePage.bind(this));
    this.#app.post('/api/action', this.#handleAction.bind(this));
    this.#app.get('/api/homekit', this.#handleHomeKit.bind(this));
    this.#app.post('/api/homekit/reset', this.#handleResetPairing.bind(this));
    this.#app.post('/api/service/restart', this.#handleRestart.bind(this));
    this.#app.get('/api/logs', this.#handleLogs.bind(this));
    this.#app.get('/api/logs/stream', this.#handleLogStream.bind(this));
    this.#app.get('/api/backup', this.#handleBackup.bind(this));
    this.#app.post('/api/restore', this.#handleRestore.bind(this));

    // The web app shell is owned by HomeKitUI and is not project-overridable.
    // Host projects extend the UI by providing schema/ui-schema/page metadata.
    this.#app.use(express.static(STATIC_PATH));

    // Client-side routing support. Any non-API route returns the built-in UI entry.
    this.#app.use((request, response) => {
      response.sendFile(path.join(STATIC_PATH, 'index.html'));
    });

    // Start listening on either a specific host or localhost by default.
    // HomeKitUI now defaults to loopback-only binding for safer standalone
    // deployments unless the host application explicitly exposes another interface.
    try {
      this.#captureConsole(this.#options.logs.lines);
      await new Promise((resolve, reject) => {
        // Keep an error listener after binding as well, so later server errors are logged.
        let listening = false;
        let onError = (error) => {
          if (listening !== true) {
            reject(error);
          } else {
            this.#log(LOG_LEVELS.ERROR, String(error?.stack ?? error));
          }
        };
        let onListening = () => {
          listening = true;
          resolve();
        };

        this.#server = this.#app.listen(
          this.#options.port,
          typeof this.#options.host === 'string' && this.#options.host !== '' ? this.#options.host : undefined,
          onListening,
        );
        this.#server.on('error', onError);
      });
    } catch (error) {
      this.#server = undefined;
      this.#app = undefined;
      // Restore console methods and discard captured history.
      if (this.#consoleCaptured === true) {
        Object.assign(console, this.#consoleOriginal);
        this.#consoleOriginal = {};
        this.#consoleCaptured = false;
        this.#consoleHistory = [];
        this.#consoleHistoryBytes = 0;
      }
      throw error;
    }

    this.#log(LOG_LEVELS.SUCCESS, 'Setup HomeKitUI for "%s"', this.#options.name);
    this.#log(
      LOG_LEVELS.INFO,
      '  += Listening on "%s:%s"%s',
      typeof this.#options.host === 'string' && this.#options.host !== '' ? this.#options.host : 'localhost',
      this.#options.port,
      this.#options.auth.enabled === true ? ' (authentication enabled)' : '',
    );
    this.#sanitisePages(this.#options.pages).forEach((page) => {
      this.#log(LOG_LEVELS.DEBUG, '  += Added page "%s"', page.title);
    });
    return true;
  }

  /**
   * Close log clients and the HTTP server, restoring console methods.
   * @returns {Promise<boolean>} True when stopped; false if no server exists.
   */
  async stop() {
    // No server means there is nothing to stop. Return false so the caller can tell
    // whether this call actually changed anything.
    if (this.#server === undefined) {
      return false;
    }

    // Remove live file/journal/console listeners and close any active log
    // streams before shutting down the HTTP server.
    for (let [response, cleanup] of this.#logListeners) {
      try {
        if (typeof cleanup === 'function') {
          cleanup();
        }

        response.end();
        // eslint-disable-next-line no-unused-vars
      } catch (error) {
        // Empty
      }
    }

    this.#logListeners.clear();

    // Close the HTTP server gracefully. This only stops the web UI; it does not
    // unpublish or remove the HomeKit accessory.
    await new Promise((resolve) => {
      this.#server.close(resolve);
    });

    // Drop references so the instance can be started again later if required.
    this.#server = undefined;
    this.#app = undefined;
    // Restore console methods and discard captured history.
    if (this.#consoleCaptured === true) {
      Object.assign(console, this.#consoleOriginal);
      this.#consoleOriginal = {};
      this.#consoleCaptured = false;
      this.#consoleHistory = [];
      this.#consoleHistoryBytes = 0;
    }
    return true;
  }

  #handleAuthentication(request, response, next) {
    // Allow public UI metadata so the frontend can show the app name before auth.
    if (request.path === '/info') {
      next();
      return;
    }

    // Authentication is optional so existing standalone applications can continue
    // operating exactly as before unless bearer-token protection is explicitly enabled.
    if (this.#options.auth.enabled !== true) {
      next();
      return;
    }

    let token = undefined;

    // Prefer standard HTTP Authorization header using Bearer authentication.
    // This keeps API access compatible with curl, reverse proxies, and scripts.
    let authHeader = typeof request.headers?.authorization === 'string' ? request.headers.authorization.trim() : '';

    if (authHeader.startsWith('Bearer ') === true) {
      token = authHeader.slice(7).trim();
    }

    // Native browser EventSource connections do not support custom headers.
    // Allow token authentication via query parameter specifically for the
    // live log streaming endpoint used by the built-in UI.
    if (token === undefined && request.path === '/logs/stream' && typeof request.query?.token === 'string') {
      token = request.query.token.trim();
    }

    // Reject requests if:
    // - no configured bearer token exists
    // - configured token is invalid/empty
    // - supplied token does not match configured token
    //
    // Intentionally return a generic authentication error rather than exposing
    // whether authentication is enabled or partially configured.
    if (
      typeof this.#options.auth.bearerToken !== 'string' ||
      this.#options.auth.bearerToken === '' ||
      token !== this.#options.auth.bearerToken
    ) {
      response.status(401).json({ error: 'Authentication required' });
      return;
    }

    // Authentication successful, continue processing the request.
    next();
  }

  async #handleInfo(request, response) {
    // Return metadata used by the built-in UI header/sidebar. Project-provided pages
    // are included here so the UI shell can add extra navigation items dynamically.
    response.json({
      name: this.#options.name,
      version: this.#options.version,
      uiVersion: HomeKitUI.VERSION,
      port: this.#options.port,
      uptime: process.uptime(),
      pages: this.#sanitisePages(this.#options.pages),
      theme: this.#options.theme ?? {},
    });
  }

  async #handleGetConfig(request, response) {
    try {
      // Load the current configuration from disk every time so the UI reflects
      // external edits made while the service is running.
      response.json(await this.#readJsonFile(this.#options.configFile));
    } catch (error) {
      this.#sendError(response, error);
    }
  }

  async #handleSaveConfig(request, response) {
    try {
      // Config saves must be plain JSON objects. Arrays or primitive values would
      // not match the expected config file layout for the standalone apps.
      if (request.body === null || typeof request.body !== 'object' || request.body.constructor !== Object) {
        throw new TypeError('Invalid configuration supplied');
      }

      await this.#persistConfig(request.body, this.#options.onSaveConfig);

      response.json({ ok: true });
    } catch (error) {
      this.#sendError(response, error);
    }
  }

  async #handleGetSchema(request, response) {
    try {
      // Serve the JSON Schema that drives the generated form. The built-in UI can
      // use this with RJSF or another schema renderer to mimic Homebridge Config UI.
      response.json(await this.#readJsonFile(this.#options.schemaFile));
    } catch (error) {
      this.#sendError(response, error);
    }
  }

  async #handleGetUISchema(request, response) {
    try {
      // UI schema is optional. If not supplied, return an empty object so the
      // frontend can still render the configuration form from the JSON Schema.
      if (typeof this.#options.uiSchemaFile !== 'string' || this.#options.uiSchemaFile === '') {
        response.json({});
        return;
      }

      response.json(await this.#readJsonFile(this.#options.uiSchemaFile));
    } catch (error) {
      this.#sendError(response, error);
    }
  }

  async #handlePage(request, response) {
    try {
      // Disable browser caching for dynamic page data.
      // Without this, Safari will return 304 (Not Modified) and you won’t see updates.
      // This endpoint is dynamic (runtime state), so it must always be fresh.
      response.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
      response.setHeader('Pragma', 'no-cache');
      response.setHeader('Expires', '0');

      // Project pages are intentionally generic. HomeKitUI does not know about
      // tanks, zones, cameras, locks, or any other project-specific concepts.
      // The host project returns renderer-friendly data for the requested page id.
      let id = typeof request.params?.id === 'string' ? request.params.id : undefined;

      if (typeof id !== 'string' || id === '') {
        throw new Error('Invalid page id');
      }

      // Ensure requested page actually exists in configured pages list.
      if (this.#hasPage(id) === false) {
        response.status(404).json({ error: 'Unknown page' });
        return;
      }

      // Delegate page data generation to host application.
      // This keeps HomeKitUI completely generic and reusable.
      if (typeof this.#options.onGetPage === 'function') {
        let data = await this.#options.onGetPage(id);

        // Always return a plain object to keep frontend logic simple.
        if (data === null || typeof data !== 'object') {
          response.json({});
          return;
        }

        response.json(data);
        return;
      }

      // No handler provided, return empty payload.
      response.json({});
    } catch (error) {
      this.#sendError(response, error);
    }
  }

  async #handleAction(request, response) {
    try {
      // Actions are optional project-defined commands from dynamic pages.
      // HomeKitUI does not interpret the action itself; it only validates the
      // payload shape and passes it to the host application.
      if (request.body === null || typeof request.body !== 'object' || request.body.constructor !== Object) {
        throw new TypeError('Invalid action supplied');
      }

      let action = typeof request.body?.action === 'string' && request.body.action !== '' ? request.body.action : undefined;
      let page = typeof request.body?.page === 'string' && request.body.page !== '' ? request.body.page : undefined;
      let data =
        request.body?.data !== undefined && typeof request.body.data === 'object' && request.body.data !== null ? request.body.data : {};

      if (action === undefined) {
        throw new Error('Invalid action id');
      }

      if (page !== undefined && this.#hasPage(page) === false) {
        response.status(404).json({ error: 'Unknown page' });
        return;
      }

      if (typeof this.#options.onAction !== 'function') {
        response.status(501).json({ error: 'Action hook not configured' });
        return;
      }

      await this.#options.onAction(action, data, page);

      response.json({ ok: true });
    } catch (error) {
      this.#sendError(response, error);
    }
  }

  async #handleHomeKit(request, response) {
    try {
      // Build HomeKit status objects for the UI. This keeps QR generation,
      // setup URI handling, and pairing state logic out of the frontend.
      response.json(await this.#homeKitDetails());
    } catch (error) {
      this.#sendError(response, error);
    }
  }

  async #handleResetPairing(request, response) {
    try {
      let details = await this.#homeKitDetails();

      // Prefer an explicit username from the request, but normally the first
      // available accessory username is used. Username is the HAP MAC-style identifier.
      let username = typeof request.body?.username === 'string' && request.body.username !== '' ? request.body.username : details.username;
      let accessory = this.#findAccessoryByUsername(username);

      if (typeof username !== 'string' || username === '') {
        throw new Error('Cannot reset HomeKit pairing because no accessory username is available');
      }

      // If the host application supplied a reset hook, delegate to it.
      if (typeof this.#options.onResetPairing === 'function') {
        await this.#options.onResetPairing(username, accessory);
      } else {
        if (accessory === undefined) {
          response.status(404).json({ error: 'Unknown accessory username' });
          return;
        }

        // Default reset flow for HAP-NodeJS accessories:
        //
        // 1. Remove HAP-NodeJS pairing/persist data for the selected username.
        // 2. Let the host application restart the process.
        //
        // Do NOT call accessory.unpublish() or accessory.destroy() here.
        // HAP-NodeJS/bonjour teardown can race during active advertisement.
        //
        // This will remove pairings for the selected accessory. It must be re-added in Home.
        if (typeof this.#options.hap?.Accessory?.cleanupAccessoryData === 'function') {
          this.#options.hap.Accessory.cleanupAccessoryData(username);
        } else if (typeof accessory?.constructor?.cleanupAccessoryData === 'function') {
          accessory.constructor.cleanupAccessoryData(username);
        } else {
          throw new Error('HAP-NodeJS cleanupAccessoryData() is not available');
        }

        if (typeof this.#options.onRestart === 'function') {
          // Wait for the reply to finish; catch both synchronous and asynchronous hook failures.
          response.once('finish', () => {
            Promise.resolve().then(() => this.#options.onRestart()).catch((error) => {
              this.#log(LOG_LEVELS.ERROR, String(error?.stack ?? error));
            });
          });
          response.json({ ok: true, restartRequired: true });
          return;
        }
      }

      response.json({ ok: true, restartRequired: true });
    } catch (error) {
      this.#sendError(response, error);
    }
  }

  async #handleRestart(request, response) {
    try {
      // Restart is intentionally delegated to the host app. This module should not
      // assume systemd, PM2, Docker, launchd, or direct process management.
      if (typeof this.#options.onRestart !== 'function') {
        response.status(501).json({ error: 'Restart hook not configured' });
        return;
      }

      // Wait for the reply to finish; catch both synchronous and asynchronous hook failures.
      response.once('finish', () => {
        Promise.resolve().then(() => this.#options.onRestart()).catch((error) => {
          this.#log(LOG_LEVELS.ERROR, String(error?.stack ?? error));
        });
      });

      response.json({ ok: true, restartRequired: true });
    } catch (error) {
      this.#sendError(response, error);
    }
  }

  async #handleLogs(request, response) {
    try {
      let source = await this.#logSource();

      // Explicit file source wins. This allows a host app to point HomeKitUI at any
      // rotating or application-managed log file.
      if (source === 'file') {
        response.json({ logs: await this.#readLogFile(this.#options.logs.file, this.#options.logs.lines) });
        return;
      }

      // Journald is preferred in auto mode when running under systemd. It survives
      // process restarts and avoids relying on in-process memory.
      if (source === 'journald') {
        response.json({ logs: await this.#readJournal(this.#options.logs.lines) });
        return;
      }

      // Console fallback is useful for direct/manual runs where systemd and a log
      // file are not available.
      response.json({ logs: this.#consoleHistory.slice(-this.#options.logs.lines).map((entry) => this.#logEntry(entry.terminal, entry.level, entry.time)) });
    } catch (error) {
      this.#sendError(response, error);
    }
  }

  async #handleLogStream(request, response) {
    // Keep an HTTP connection open so log entries can be pushed to the browser.
    response.setHeader('Content-Type', 'text/event-stream');
    response.setHeader('Cache-Control', 'no-cache');
    response.setHeader('Connection', 'keep-alive');

    // Initial event confirms the stream is open. Browser EventSource will reconnect
    // automatically if this connection drops.
    response.write('event: connected\n');
    response.write('data: true\n\n');

    // Disconnect handling must exist before asynchronous source discovery begins.
    let disconnected = false;
    let disconnect = () => {
      disconnected = true;
      let cleanup = this.#logListeners.get(response);
      if (typeof cleanup === 'function') {
        cleanup();
      }
    };
    request.once('close', disconnect);
    response.once('close', disconnect);

    let source = await this.#logSource();
    if (disconnected === true) {
      return;
    }

    // Explicit file source wins. `tail -F` follows rotation/replacement better than
    // `tail -f`, which is useful when the host app or system rotates logs.
    if (source === 'file') {
      this.#streamCommand(response, 'tail', ['-n', '0', '-F', this.#options.logs.file]);
    } else if (source === 'journald') {
      // Journald stream uses -o cat so ANSI escape codes are preserved for the UI.
      this.#streamCommand(response, 'journalctl', [...(await this.#journalArgs(0)), '-f']);
    } else {
      // Console stream is the last fallback for direct/manual runs.
      let closed = false;

      let cleanup = () => {
        if (closed === true) {
          return;
        }

        closed = true;
        this.#consoleListeners.delete(listener);
        this.#logListeners.delete(response);
      };

      let listener = (entry) => {
        try {
          this.#sendLogEvent(response, this.#logEntry(entry.terminal, entry.level, entry.time));
        } catch {
          cleanup();
        }
      };

      this.#consoleListeners.add(listener);
      this.#logListeners.set(response, cleanup);
    }
  }

  async #handleBackup(request, response) {
    try {
      // Backup is just the current config file returned as a download. This keeps
      // backup/restore simple and transparent for the user.
      response.setHeader('Content-Type', 'application/json');
      response.setHeader('Content-Disposition', 'attachment; filename="config.backup.json"');
      response.send(JSON.stringify(await this.#readJsonFile(this.#options.configFile), null, 2) + '\n');
    } catch (error) {
      this.#sendError(response, error);
    }
  }

  async #handleRestore(request, response) {
    try {
      // Restore uses the same plain-object requirement as normal config save.
      if (request.body === null || typeof request.body !== 'object' || request.body.constructor !== Object) {
        throw new TypeError('Invalid configuration supplied');
      }

      await this.#persistConfig(request.body, this.#options.onRestoreConfig);

      response.json({ ok: true, restartRequired: true });
    } catch (error) {
      this.#sendError(response, error);
    }
  }

  async #homeKitDetails() {
    let accessories = this.#accessories();
    let items = [];

    for (let accessory of accessories) {
      items.push(await this.#accessoryHomeKitDetails(accessory));
    }

    // Return the new multi-accessory payload while preserving the original top-level
    // fields for older frontends or simple single-accessory projects.
    return {
      accessories: items,
      accessory: items[0],
      displayName: items[0]?.displayName,
      username: items[0]?.username,
      pincode: items[0]?.pincode,
      setupID: items[0]?.setupID,
      setupURI: items[0]?.setupURI,
      qrCode: items[0]?.qrCode,
      paired: items[0]?.paired === true,
      pairings: items[0]?.pairings ?? [],
    };
  }

  async #accessoryHomeKitDetails(accessory) {
    // HAP-NodeJS generates the HomeKit setup URI from the accessory pairing details.
    // This is the same payload that the QR code encodes.
    let setupURI = typeof accessory?.setupURI === 'function' ? accessory.setupURI() : undefined;

    // Convert setup URI into a browser-displayable PNG data URL. If setupURI is not
    // available, QR code is left undefined and the UI can fall back to setup code.
    let qrCode = setupURI !== undefined ? await QRCode.toDataURL(setupURI) : undefined;

    // HAP-NodeJS stores live pairing state internally. This is not as clean as a
    // public API, but is the practical way to mirror the Homebridge UI behaviour.
    let accessoryInfo = accessory?._accessoryInfo;
    let pairings = [];

    // Pairing list is optional depending on HAP-NodeJS version. If it fails, hide
    // the list rather than failing the whole HomeKit page.
    if (typeof accessoryInfo?.listPairings === 'function') {
      try {
        pairings = accessoryInfo.listPairings();
        // eslint-disable-next-line no-unused-vars
      } catch (error) {
        pairings = [];
      }
    }

    // Return a frontend-friendly object. The UI can render the QR image directly
    // from qrCode, show setupURI for debugging, and use paired to control warnings.
    return {
      displayName: accessory?.displayName,
      username: accessory?.username ?? accessory?.lastKnownUsername ?? accessoryInfo?.username,
      pincode: accessory?.pincode ?? accessoryInfo?.pincode,
      setupID: accessory?._setupID ?? accessoryInfo?.setupID,
      setupURI,
      qrCode,
      paired: typeof accessoryInfo?.paired === 'function' ? accessoryInfo.paired() === true : false,
      pairings,
    };
  }

  #findAccessoryByUsername(username) {
    if (typeof username !== 'string' || username === '') {
      return undefined;
    }

    return this.#accessories().find((accessory) => {
      let accessoryInfo = accessory?._accessoryInfo;

      return accessory?.username === username || accessory?.lastKnownUsername === username || accessoryInfo?.username === username;
    });
  }

  #accessories() {
    let accessories = [];

    if (Array.isArray(this.#options.accessories) === true) {
      accessories = this.#options.accessories.filter((accessory) => accessory !== undefined && accessory !== null);
    }

    if (accessories.length === 0 && this.#options.accessory !== undefined && this.#options.accessory !== null) {
      accessories = [this.#options.accessory];
    }

    return accessories;
  }

  async #readJsonFile(file) {
    // Require a valid file path before attempting disk access. This gives a useful
    // API error if the host app forgot to configure configFile/schemaFile.
    if (typeof file !== 'string' || file === '') {
      throw new Error('JSON file path not configured');
    }

    // Parse and return JSON. Any syntax error is intentionally allowed to throw so
    // the UI can surface a clear configuration/schema problem.
    return JSON.parse(await fs.readFile(file, 'utf8'));
  }

  // Serialize save and restore operations, including validation and host hooks.
  async #persistConfig(config, hook) {
    let operation = this.#configWrite.catch(() => {}).then(async () => {
      if (typeof this.#options.onValidateConfig === 'function') {
        await this.#options.onValidateConfig(config);
      }
      if (typeof hook === 'function') {
        await hook(config);
      } else {
        await this.#writeJsonFile(this.#options.configFile, config);
      }
    });
    this.#configWrite = operation;
    await operation;
  }

  async #writeJsonFile(file, data) {
    if (typeof file !== 'string' || file === '') {
      throw new Error('JSON file path not configured');
    }

    // Resolve existing symlinks so replacing the file preserves the link itself.
    let target = path.resolve(file);
    let mode = 0o600;
    try {
      target = await fs.realpath(target);
      mode = (await fs.stat(target)).mode & 0o777;
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
    }
    let directory = await fs.mkdtemp(path.join(path.dirname(target), '.homekitui-'));
    let temporary = path.join(directory, 'config.json');
    let handle;
    try {
      handle = await fs.open(temporary, 'wx', mode);
      await handle.chmod(mode);
      await handle.writeFile(JSON.stringify(data, null, 2) + '\n');
      await handle.sync();
      await handle.close();
      handle = undefined;
      // Same-filesystem rename exposes either the previous or the completed file.
      await fs.rename(temporary, target);
    } finally {
      try {
        await handle?.close();
      } finally {
        await fs.rm(directory, { recursive: true, force: true });
      }
    }
  }

  async #readLogFile(file, lines) {
    // File logs are read as plain text and converted into UI log entries line by line.
    // Read only a bounded tail so archival logs cannot exhaust process memory.
    let handle = await fs.open(file, 'r');
    let content;
    try {
      let size = (await handle.stat()).size;
      let offset = Math.max(0, size - MAX_LOG_HISTORY_BYTES);
      let buffer = Buffer.alloc(Math.min(size, MAX_LOG_HISTORY_BYTES));
      let { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
      content = buffer.subarray(0, bytesRead).toString('utf8');
      // The first line in a bounded tail may have started before the read window.
      if (offset > 0) {
        content = content.slice(content.indexOf('\n') + 1);
      }
    } finally {
      await handle.close();
    }

    return content
      .split('\n')
      .filter((line) => line.trim() !== '')
      .slice(-lines)
      .map((line) => this.#logEntry(line));
  }

  async #readJournal(lines) {
    let entries = [];
    let buffer = '';
    let entryBytes = 0;
    let append = (line) => {
      let entry = this.#logEntry(line);
      entries.push(entry);
      entryBytes += Buffer.byteLength(entry.message);
      while (entries.length > lines || entryBytes > MAX_LOG_HISTORY_BYTES) {
        entryBytes -= Buffer.byteLength(entries.shift().message);
      }
    };
    let args = await this.#journalArgs(lines);

    await new Promise((resolve) => {
      let finished = false;
      let proc = spawn('journalctl', args);

      let finish = () => {
        if (finished === true) {
          return;
        }

        finished = true;

        if (buffer.trim() !== '') {
          append(buffer);
        }

        resolve();
      };

      proc.stdout.on('data', (data) => {
        buffer += String(data);

        let chunkLines = buffer.split('\n');
        buffer = (chunkLines.pop() ?? '').slice(-MAX_LOG_LINE_CHARS);

        chunkLines.forEach((line) => {
          if (line.trim() !== '') {
            append(line);
          }
        });
      });

      proc.on('close', finish);
      proc.on('error', finish);
    });

    return entries;
  }

  async #journalArgs(lines) {
    // Prefer an explicitly supplied systemd unit when configured.
    // Unit-based journald queries include previous service runs, so UI scrollback works.
    let unit = typeof this.#options.logs.unit === 'string' && this.#options.logs.unit !== '' ? this.#options.logs.unit : undefined;

    // Try to infer the service unit from /proc/self/cgroup.
    if (unit === undefined) {
      try {
        let cgroup = await fs.readFile('/proc/self/cgroup', 'utf8');
        let match = cgroup.match(/(?:^|\/)([^/\n]+\.service)(?:\/|$)/);

        if (Array.isArray(match) === true && typeof match[1] === 'string' && match[1] !== '') {
          unit = match[1];
        }
        // eslint-disable-next-line no-unused-vars
      } catch (error) {
        // Empty
      }
    }

    // If cgroup did not expose the unit, ask journald which unit owns this PID.
    if (unit === undefined) {
      try {
        let json = '';
        await new Promise((resolve) => {
          let proc = spawn('journalctl', ['_PID=' + process.pid, '-n', '1', '-o', 'json', '--no-pager']);

          proc.stdout.on('data', (data) => {
            json += String(data);
          });

          proc.on('close', resolve);
          proc.on('error', resolve);
        });

        let entry = JSON.parse(json.trim() || '{}');

        if (typeof entry?._SYSTEMD_UNIT === 'string' && entry._SYSTEMD_UNIT !== '') {
          unit = entry._SYSTEMD_UNIT;
        }
        // eslint-disable-next-line no-unused-vars
      } catch (error) {
        // Empty
      }
    }

    if (unit !== undefined) {
      return ['-u', unit, '-o', 'cat', '-n', String(lines), '--no-pager'];
    }

    // Last resort only. Invocation id is intentionally narrow and only shows this run.
    if (typeof process.env.INVOCATION_ID === 'string' && process.env.INVOCATION_ID !== '') {
      return ['_SYSTEMD_INVOCATION_ID=' + process.env.INVOCATION_ID, '-o', 'cat', '-n', String(lines), '--no-pager'];
    }

    return [];
  }

  async #logSource() {
    // Log source priority:
    // 1. Explicit file path (always wins)
    // 2. journald (preferred under systemd or when explicitly requested)
    // 3. console fallback (direct/manual runs)

    // Explicit file override
    if (typeof this.#options.logs.file === 'string' && this.#options.logs.file !== '') {
      return 'file';
    }

    // Explicit source selection
    if (this.#options.logs.source === 'file') {
      return typeof this.#options.logs.file === 'string' && this.#options.logs.file !== '' ? 'file' : 'console';
    }

    if (this.#options.logs.source === 'journald') {
      return (await this.#journalArgs(this.#options.logs.lines)).length > 0 ? 'journald' : 'console';
    }

    if (this.#options.logs.source === 'console') {
      return 'console';
    }

    // Auto mode (default)
    if ((await this.#journalArgs(this.#options.logs.lines)).length > 0) {
      return 'journald';
    }

    return 'console';
  }

  #streamCommand(response, command, args) {
    // Stream a child process line-by-line into SSE. Used by both tail and journalctl.
    let buffer = '';
    let proc = spawn(command, args);
    let closed = false;

    let cleanup = () => {
      if (closed === true) {
        return;
      }

      closed = true;
      this.#logListeners.delete(response);

      try {
        proc.kill('SIGTERM');
        // eslint-disable-next-line no-unused-vars
      } catch (error) {
        // Empty
      }

      try {
        response.end();
        // eslint-disable-next-line no-unused-vars
      } catch (error) {
        // Empty
      }
    };

    this.#logListeners.set(response, cleanup);

    proc.stdout.on('data', (data) => {
      buffer += String(data);

      let lines = buffer.split('\n');
      buffer = (lines.pop() ?? '').slice(-MAX_LOG_LINE_CHARS);

      lines.forEach((line) => {
        if (closed !== true && line.trim() !== '') {
          try {
            this.#sendLogEvent(response, this.#logEntry(line));
          } catch {
            cleanup();
          }
        }
      });
    });

    proc.on('error', cleanup);
    proc.on('close', cleanup);
  }

  // A stalled client must not accumulate an unbounded HTTP write queue.
  // EventSource reconnects and reloads bounded history after this disconnect.
  #sendLogEvent(response, entry) {
    if (response.write('data: ' + JSON.stringify(entry) + '\n\n') === false) {
      let cleanup = this.#logListeners.get(response);
      if (typeof cleanup === 'function') {
        cleanup();
      }
      response.destroy();
    }
  }

  /**
   * @param {string} line Terminal output, truncated to the configured record bound.
   * @param {string} [level='info'] Captured severity.
   * @param {string} [time] ISO timestamp; defaults to the conversion time.
   * @returns {UILogEntry} Record consumed by history and SSE clients.
   */
  #logEntry(line, level = LOG_LEVELS.INFO, time = new Date().toISOString()) {
    // Convert raw terminal text into the structured object expected by app.js.
    line = line.slice(-MAX_LOG_LINE_CHARS);
    return {
      time,
      level,
      message: line,
      terminal: line,
      html: this.#ansi.ansi_to_html(line),
    };
  }

  #normaliseOptions() {
    // Normalise option groups after constructor/start merges so callers can provide
    // partial options without needing to mirror the full defaults object.
    if (Array.isArray(this.#options.pages) === false) {
      this.#options.pages = [];
    }

    if (Array.isArray(this.#options.accessories) === false) {
      this.#options.accessories = [];
    }

    if (this.#options.logs === null || typeof this.#options.logs !== 'object' || this.#options.logs.constructor !== Object) {
      this.#options.logs = {};
    }

    if (this.#options.auth === null || typeof this.#options.auth !== 'object' || this.#options.auth.constructor !== Object) {
      this.#options.auth = {};
    }

    this.#options.auth = {
      enabled: this.#options.auth.enabled === true,
      bearerToken:
        typeof this.#options.auth.bearerToken === 'string' && this.#options.auth.bearerToken.trim() !== ''
          ? this.#options.auth.bearerToken.trim()
          : undefined,
    };

    this.#options.logs = {
      source: typeof this.#options.logs.source === 'string' && this.#options.logs.source !== '' ? this.#options.logs.source : 'auto',
      file: typeof this.#options.logs.file === 'string' && this.#options.logs.file !== '' ? this.#options.logs.file : undefined,
      unit: typeof this.#options.logs.unit === 'string' && this.#options.logs.unit !== '' ? this.#options.logs.unit : undefined,
      lines:
        Number.isFinite(Number(this.#options.logs.lines)) === true && Number(this.#options.logs.lines) > 0
          ? Math.min(MAX_LOG_HISTORY_LINES, Math.max(1, Math.floor(Number(this.#options.logs.lines))))
          : HomeKitUI.DEFAULT_CONSOLE_HISTORY_LINES,
    };
  }

  #hasPage(id) {
    // Only allow requests for pages explicitly advertised by the host project.
    // This prevents arbitrary ids from reaching the project's page data hook.
    return this.#sanitisePages(this.#options.pages).some((page) => page.id === id);
  }

  #sanitisePages(pages = []) {
    // Project pages are treated as metadata only. Sanitise them before exposing to
    // the frontend so a bad project config cannot inject arbitrary values.
    if (Array.isArray(pages) === false) {
      return [];
    }

    return pages
      .filter((page) => page !== null && typeof page === 'object' && page.constructor === Object)
      .map((page) => ({
        id: typeof page.id === 'string' && page.id !== '' ? page.id : undefined,
        title: typeof page.title === 'string' && page.title !== '' ? page.title : undefined,
        icon: typeof page.icon === 'string' && page.icon !== '' ? page.icon : undefined,
        svg: typeof page.svg === 'string' && page.svg !== '' ? page.svg : undefined,
        schemaPath:
          typeof page.schemaPath === 'string' &&
          page.schemaPath !== '' &&
          /^[a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)*$/.test(page.schemaPath) === true
            ? page.schemaPath
            : undefined,
        restartRequired: page.restartRequired === true ? true : page.restartRequired === false ? false : undefined,
        refreshInterval:
          Number.isFinite(Number(page.refreshInterval)) === true && Number(page.refreshInterval) > 0
            ? Number(page.refreshInterval)
            : undefined,
        trustedHTML: page.trustedHTML === true ? true : undefined,
      }))
      .filter((page) => page.id !== undefined && page.title !== undefined);
  }

  #sendError(response, error) {
    // Normalise all API errors through one path so logging and client responses are
    // consistent across config, HomeKit, and maintenance endpoints.
    this.#log(LOG_LEVELS.ERROR, String(error?.stack ?? error));
    response.status(500).json({ error: String(error?.message ?? error) });
  }

  #log(level, message, ...args) {
    // Ignore invalid log messages. This keeps endpoint error handling safe even if
    // a caller passes unusual values.
    if (typeof message !== 'string' || message === '') {
      return;
    }

    // Forward internal HomeKitUI logs to the host application's logger if provided.
    // This is not used for log streaming, only for UI/service-level messages.
    if (typeof this.#options.log?.[level] === 'function') {
      this.#options.log[level](message, ...args);
    }
  }

  #captureConsole(lines) {
    // Patch console once so direct/manual runs still have a live log source when
    // journald and file logs are unavailable.
    if (this.#consoleCaptured === true) {
      return;
    }

    this.#consoleCaptured = true;

    // Preserve original console methods so we can still output to stdout/stderr
    // after intercepting log calls.
    this.#consoleOriginal.log = console.log;
    this.#consoleOriginal.info = console.info;
    this.#consoleOriginal.warn = console.warn;
    this.#consoleOriginal.error = console.error;
    this.#consoleOriginal.debug = console.debug;

    [
      ['log', LOG_LEVELS.INFO],
      ['info', LOG_LEVELS.INFO],
      ['warn', LOG_LEVELS.WARN],
      ['error', LOG_LEVELS.ERROR],
      ['debug', LOG_LEVELS.DEBUG],
    ].forEach(([method, level]) => {
      let original = this.#consoleOriginal[method];
      console[method] = (...args) => {
        // Cached method references remain usable after capture stops.
        if (this.#consoleCaptured !== true) {
          original.apply(console, args);
          return;
        }

        // Format console arguments into a single string using Node.js util.format
        let line = util.format(...args).slice(-MAX_LOG_LINE_CHARS);

        // Construct a log entry that can be consumed by the UI or streamed via SSE
        let entry = {
          time: new Date().toISOString(),
          level,
          message: line,
          terminal: line, // Preserve raw terminal output for streaming
        };

        // Append to in-memory history buffer
        this.#consoleHistory.push(entry);

        this.#consoleHistoryBytes += Buffer.byteLength(line);
        let remove = 0;
        while (this.#consoleHistory.length - remove > lines || this.#consoleHistoryBytes > MAX_LOG_HISTORY_BYTES) {
          this.#consoleHistoryBytes -= Buffer.byteLength(this.#consoleHistory[remove++].message);
        }
        this.#consoleHistory.splice(0, remove);

        // Notify active listeners (e.g. SSE log stream clients)
        this.#consoleListeners.forEach((listener) => {
          try {
            listener(entry);
          } catch {
            // Ignore listener errors to avoid breaking logging
          }
        });

        // Forward the original console call so logs still appear normally
        original.apply(console, args);
      };
    });
  }
}
