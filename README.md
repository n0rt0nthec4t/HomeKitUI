# HomeKitUI

Backend-driven web UI framework for standalone HomeKit applications using HAP-NodeJS.

Provides a lightweight, browser-based interface for managing, monitoring, and interacting with your HomeKit-enabled application.

---

## Overview

HomeKitUI runs alongside your application and exposes a web interface for:

- Viewing and editing configuration
- Managing HomeKit pairing
- Viewing logs (journald, file, or console)
- Accessing project-specific dashboards
- Performing maintenance actions (restart and backup, with restore available through the API)
- Triggering runtime actions from the UI

The module operates at the **application level**, not the device level.

---

## Runtime Integration

HomeKitUI is consumed as shared ES-module source. Keep `HomeKitUI.js` and its adjacent `ui/` directory together in the host application's runtime layout. Create one HomeKitUI instance per process.

The host supplies these external dependencies:

| Dependency | Purpose |
| --- | --- |
| `express` | HTTP routing, JSON request parsing, and static asset serving |
| `qrcode` | HomeKit setup QR-code generation |
| `ansi_up` | Terminal log colours converted to browser HTML |

Express remains internal to HomeKitUI. Host applications extend the UI through options and callbacks; they do not need to provide an Express application or middleware. Configuration files, published accessories, credentials, and process restart policy belong to the host.

---

## Features

- Built-in web UI (no external frontend required)
- JSON Schema-driven configuration editor
- HomeKit pairing support (QR code, setup URI, status)
- Multi-accessory support
- Live log streaming (SSE with automatic reconnect)
- Optional Web UI password authentication for API access
- URL-based navigation with browser history support
- journald, file, and console log support
- Custom dashboard pages (backend-rendered HTML)
- Declarative UI actions (no inline JavaScript)
- Persistent UI state (collapse panels and selections remembered)
- Smooth, flicker-free updates via batched rendering
- Backup and restore support

---

## Authentication

HomeKitUI supports optional Web UI password authentication for API endpoints.

When enabled:

- API requests use `Authorization: Bearer <password>` internally
- The frontend can store the Web UI password in browser `localStorage` when the user chooses "Remember for this browser"
- The user is prompted for the Web UI password after an authentication failure
- The main UI is blocked until authenticated requests complete successfully
- If authentication is cancelled, the frontend shows a dedicated authentication-required screen instead of a partially loaded app
- SSE log streaming uses a query-token fallback because browser `EventSource` cannot send custom headers
- `/api/info` and static UI assets remain publicly reachable so the browser can identify the application and load the frontend

Password generation and persistence are handled by the host application. The password is supplied to HomeKitUI as `auth.bearerToken` because the underlying HTTP authentication mechanism is still a bearer token.

Example:

```js
let ui = new HomeKitUI({
  name: 'Some System',
  version: '1.0.0',
  port: 8581,
  auth: {
    enabled: true,
    bearerToken: config.options.webUIBearerToken,
  },
  configFile: './config.json',
  schemaFile: './config.schema.json',
  accessory: myAccessory,
  hap,
  log,
});
```

---

## Network Binding

HomeKitUI defaults to `127.0.0.1`, so the UI is accessible only from the host machine. No `host` option is needed for local access.

For access from other devices on your network, set:

```js
host: '0.0.0.0'
```

This listens on all IPv4 interfaces. Enable Web UI password authentication when exposing the UI on your network.

---

## UI Philosophy

HomeKitUI follows a backend-driven UI model:

- The frontend is generic and declarative
- The backend defines behaviour via API responses and `data-*` attributes
- Dashboard controls declare actions through `data-*` attributes and delegated events
- Navigation and UI actions use a central event dispatcher

Pages marked `trustedHTML: true` insert host-provided HTML and optional CSS directly. Use that option for host-owned markup; the SVG icon filter does not sanitise trusted page HTML.

Configuration save and restore operations use one instance queue, including validation and persistence hooks. Default writes use a flushed temporary file and atomic rename, retaining existing file mode bits and following existing symlinks. The configuration directory must be writable. Newly created configuration files use mode `0600`.

Both explicit restart and default pairing-reset restart hooks run after the response finishes. Hooks may return synchronously or return a promise; failures are logged. Default pairing cleanup rejects usernames outside the configured accessory list. A host reset hook can implement a broader policy explicitly.

HomeKitUI uses one instance per process. Console capture starts with the server and is restored when it stops. Log history and partial lines are bounded; slow streaming clients are disconnected and can reconnect to reload history. Startup binding errors reject `start()` and allow a subsequent retry.

---

## Usage Example

```js
import HomeKitUI from './HomeKitUI.js';

let ui = new HomeKitUI({
  name: 'Irrigation System',
  version: '1.0.0',
  port: 8581,
  configFile: './config.json',
  schemaFile: './config.schema.json',
  uiSchemaFile: './config.ui.schema.json',
  accessory: myAccessory,
  hap,
  log,
});

await ui.start();
```

---

## Public Methods

| Method | Behavior |
| --- | --- |
| `new HomeKitUI(options)` | Store and normalise host integration settings |
| `await ui.start(options)` | Merge optional start-time settings and start listening; return `true` on success, or `false` when already started or disabled by an invalid port |
| `await ui.stop()` | Close log clients and the HTTP server, restore console methods, and clear captured history; return `false` when no server exists |

Startup binding errors reject `start()`; the instance can be started again after a failure or shutdown. Start-time settings merge at the top level, so supplying an option group such as `auth` or `logs` replaces that group before normalisation.

---

## Options

| Option | Description |
|--------|-------------|
| `name` | Display name in UI |
| `version` | Application version |
| `port` | Web UI port; defaults to `8581` |
| `host` | Bind address. Defaults to `127.0.0.1` |
| `auth` | Optional Web UI password authentication configuration |
| `configFile` | Path to config JSON |
| `schemaFile` | Path to JSON schema |
| `uiSchemaFile` | Optional UI schema path; fetched by the browser, but not used for current form layout |
| `theme` | Optional browser theme colours |
| `accessory` | Single published HAP accessory, used when `accessories` has no entries |
| `accessories` | Array of published HAP accessories |
| `hap` | HAP-NodeJS reference |
| `log` | Logger for internal UI messages |
| `logs` | Log source configuration |
| `pages` | Custom UI pages |
| `onValidateConfig(config)` | Validate the complete submitted object; throw or reject to block persistence |
| `onSaveConfig(config)` | Replace the default save write and apply host runtime changes |
| `onRestoreConfig(config)` | Replace the default restore write independently of the save hook |
| `onRestart()` | Host restart handler, invoked after the response finishes |
| `onResetPairing(username, accessory)` | Replace default pairing cleanup and restart handling |
| `onGetPage(id)` | Return project-page data for a configured page |
| `onAction(action, data, page)` | Handle a UI-triggered project action |

---

## Project Pages

The built-in `status` page shows pairing information, logs, and maintenance controls. Additional sidebar pages come from `pages` metadata.

| Page field | Meaning |
| --- | --- |
| `id`, `title` | Unique page ID and displayed title |
| `icon`, `svg` | Built-in icon name or filtered SVG markup |
| `schemaPath` | Dot-separated path selecting a configuration value and its JSON Schema section |
| `restartRequired` | Set to `false` to suppress restart advice for the page |
| `refreshInterval` | Dynamic-page refresh interval in milliseconds; applies to pages without `schemaPath` |
| `trustedHTML` | Allow host-rendered HTML and CSS from `onGetPage()` |

Schema pages generate controls from JSON Schema. Other pages can return `{ type: 'list', items }`, or `{ type: 'html', html, css }` when trusted HTML is enabled. Dashboard buttons dispatch through `onAction()`.

Saving posts the complete configuration. One save runs at a time, and edits made while the request is pending remain marked as unsaved. Restart advice comes from page and schema metadata; saving does not automatically restart the host.

---

## Log Sources

`logs.source` defaults to `'auto'`, using journald when a service unit or invocation can be established and console capture otherwise. A configured `logs.file` takes precedence. `logs.unit` selects a systemd service explicitly, and `logs.lines` controls history length with a default of 500.

For example, file logging can use:

```js
logs: {
  file: './application.log',
  lines: 500,
}
```

History and individual lines are bounded. Live logs use SSE, with browser reconnect and history reload after a connection failure.

---

## API Endpoints

| Method and endpoint | Description |
| --- | --- |
| `GET /api/info` | Public application and UI metadata |
| `GET /api/config` | Read configuration |
| `POST /api/config` | Validate and save the complete configuration |
| `GET /api/schema` | Read JSON Schema |
| `GET /api/ui-schema` | Read optional UI schema |
| `GET /api/page/:id` | Fetch configured project-page data |
| `POST /api/action` | Dispatch a project action |
| `GET /api/homekit` | Accessory pairing details and QR codes |
| `POST /api/homekit/reset` | Reset pairing for a selected accessory |
| `POST /api/service/restart` | Invoke the host restart hook after replying |
| `GET /api/logs` | Fetch log history |
| `GET /api/logs/stream` | Stream live logs through SSE |
| `GET /api/backup` | Download configuration JSON |
| `POST /api/restore` | Validate and restore the complete configuration |

---

## Version

```js
static VERSION = '2026.10.06';
```
