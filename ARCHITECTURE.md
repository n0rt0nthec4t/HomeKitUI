# HomeKitUI Architecture

## Overview

`HomeKitUI` is a shared management module for standalone HAP-NodeJS applications. It provides an HTTP API and browser shell around application-owned configuration, accessories, logs, and maintenance hooks.

**Version:** 2026.10.09 (`HomeKitUI.VERSION`)

**Primary module:** `HomeKitUI.js`

**Consumers:** standalone host applications, including HomeKitDevice-based projects

---

## Position In The System

```text
              ┌───────────────────────────────┐
              │ Browser                       │
              │ HTML shell + ui/app.js        │
              └───────────────┬───────────────┘
                              │ HTTP / JSON / SSE
              ┌───────────────▼───────────────┐
              │ HomeKitUI                     │
              │ Express API + static UI       │
              │ auth + forms + log delivery   │
              └───────────────┬───────────────┘
                              │ files / hooks / HAP metadata
              ┌───────────────▼───────────────┐
              │ Host application              │
              │ config + published accessories│
              │ runtime + maintenance policy  │
              └───────────────────────────────┘
```

The host constructs HomeKitUI in its own Node.js process and supplies file paths, published accessories, and callbacks. HomeKitUI owns a separate HTTP server. Like HomeKitDevice, it is consumed as shared source; the host supplies external dependencies and the module's adjacent UI assets.

---

## Core Responsibilities

`HomeKitUI` owns:

- HTTP-server startup and shutdown
- static UI asset serving and optional bearer authentication
- application, theme, and project-page metadata
- configuration, JSON Schema, and optional UI schema reads
- configuration save, backup, and restore workflows
- schema-driven browser forms and changed-path tracking
- project-page data and action dispatch
- accessory pairing metadata and QR generation
- pairing cleanup and host-defined restart dispatch
- console, file, and journald log history and live streaming

The host owns accessory creation and publishing, device control, configuration validation, process supervision, dependency provisioning, and credential configuration. HomeKitUI does not instantiate HomeKitDevice or participate in its device-message lifecycle.

---

## Runtime Integration Model

```js
new HomeKitUI(options)
```

The constructor accepts a plain object, merges defaults, and normalises option groups. Console capture starts when the server starts. `start(options)` can supply values that become available later, such as published accessories. Start-time options merge at the top level; supplying a nested group replaces that group before normalisation.

The backend imports `express`, `qrcode`, and `ansi_up`, alongside Node filesystem, path, URL, process, console, formatting, and child-process APIs. One class coordinates routes, persistence, HAP metadata, and log sources. The browser uses plain JavaScript, mutable state, DOM operations, and scheduled rendering, with no frontend build step.

| Option | Default | Meaning |
| --- | --- | --- |
| `name` | `'HomeKit Device'` | Host name |
| `version` | `HomeKitUI.VERSION` | Host version returned separately from `uiVersion` |
| `port` | `8581` | HTTP listen port |
| `host` | `'127.0.0.1'` | Network binding |
| `auth` | Disabled after normalisation | `enabled` and `bearerToken` settings |
| `configFile` | `undefined` | Configuration reads and default writes |
| `schemaFile` | `undefined` | JSON Schema reads |
| `uiSchemaFile` | `undefined` | Optional UI schema reads; absent path returns `{}` |
| `theme` | `{}` | Browser theme settings |
| `pages` | `[]` | Project-page metadata |
| `accessory` | `undefined` | Single-accessory fallback |
| `accessories` | `[]` | Multiple published accessories |
| `hap` | `undefined` | HAP API providing accessory-data cleanup |
| `log` | `undefined` | Host logger for module messages |
| `logs` | Auto source, 500 lines after normalisation | `source`, optional `file`, optional `unit`, and `lines` |

Hooks are optional and described below. Invalid `pages` and `accessories` values become empty arrays. Authentication is enabled only by `enabled: true`; its token is trimmed. Log history size is converted to a positive finite number, otherwise it defaults to `DEFAULT_CONSOLE_HISTORY_LINES`.

File paths are checked when used. Relative paths resolve from the host process's working directory. Module-relative paths can use Node's URL helpers:

```js
import { fileURLToPath } from 'node:url';

const configFile = fileURLToPath(new URL('./config.json', import.meta.url));
```

---

## Lifecycle Flow

### Start

```text
ui.start(options)
        │
        ├─ merge options and normalise groups
        ├─ return false if a server reference already exists
        ├─ return false for a non-finite port or port outside 1–65535
        ├─ create Express application and 2mb JSON parser
        ├─ mount API authentication and management routes
        ├─ serve adjacent ui/ assets and entry fallback
        ├─ install console capture
        ├─ listen on configured port and host
        └─ resolve true after the listen callback
```

A non-empty host string is passed to `listen()`; otherwise Node's default binding applies. The listen promise resolves from the callback. Startup server errors reject it, clear the instance references, and release console capture so startup can be retried. Later server errors are forwarded to the host logger.

### Stop

```text
ui.stop()
        │
        ├─ return false if no server reference exists
        ├─ clean up and end active log streams
        ├─ close the HTTP server
        ├─ clear server and app references
        ├─ restore console methods
        └─ resolve true
```

The instance can start again after its references are cleared. Stop leaves host accessories and configuration alone. HomeKitUI uses one instance per process. Stopping it restores the original console methods and clears captured history. HTTP-close callback errors are ignored.

---

## Static UI Layout

Assets resolve to `ui/` beside `HomeKitUI.js`. Express serves that directory directly. A final middleware sends `ui/index.html` for unmatched requests, including unmatched API paths that reach it.

| File | Responsibility |
| --- | --- |
| `ui/index.html` | Browser entry point and asset loading |
| `ui/app.js` | Authentication, navigation, forms, page rendering, API calls, and live logs |
| `ui/style.css` | Shell, cards, forms, logs, authentication dialog, and responsive layout |

The built-in Status page provides accessory cards, uptime, logs, restart, and backup controls. Other sidebar pages come from host metadata. Restore is exposed through the API.

---

## Authentication Model

Authentication middleware covers `/api`. `/api/info` remains public so the browser can identify the application before authenticating. Static assets remain public.

When `auth.enabled === true`, protected requests must match the configured token using `Authorization: Bearer <token>`. The log-stream endpoint also accepts `?token=...` when no bearer token was extracted, because browser `EventSource` cannot set an Authorization header. Other endpoints do not accept query-token authentication. Missing or incorrect credentials return status 401 with `{ error: 'Authentication required' }`.

The browser presents a password dialog after a 401 and retries the request. A token can stay in memory for the session or be remembered in local storage under `homekitui-token`. Cancelling authentication switches to a locked screen, stops log streaming, and suspends runtime updates until authentication resumes.

Browser storage failures leave credentials and UI preferences usable in the current tab. A failed attempt to remember a password reports that it will remain available only in that tab. Session overrides prevent denied token removal from reusing stale browser credentials during the session.

The host supplies the token and transport or deployment-level access controls. HomeKitUI does not generate credentials or terminate TLS.

---

## HTTP API

Responses use JSON except the backup attachment and SSE stream. Save and restore accept the complete configuration object.

| Method and path | Request | Response / action |
| --- | --- | --- |
| `GET /api/info` | None; public | `{ name, version, uiVersion, port, uptime, pages, theme }` |
| `GET /api/config` | None | Parsed configuration file |
| `POST /api/config` | Plain JSON object | Validate and save; `{ ok: true }` |
| `GET /api/schema` | None | Parsed JSON Schema file |
| `GET /api/ui-schema` | None | Parsed UI schema, or `{}` without a path |
| `GET /api/page/:id` | Configured page ID | Host page payload, or `{}` without a page-data hook |
| `POST /api/action` | `{ action, data?, page? }` | Invoke host action; `{ ok: true }` |
| `GET /api/homekit` | None | Accessory collection and first-accessory compatibility fields |
| `POST /api/homekit/reset` | Optional `{ username }` | Reset pairing; `{ ok: true, restartRequired: true }` |
| `POST /api/service/restart` | None | Respond, then invoke restart hook; `{ ok: true, restartRequired: true }` |
| `GET /api/logs` | None | `{ logs: [...] }` from the selected source |
| `GET /api/logs/stream` | Optional query token | SSE connection and live log entries |
| `GET /api/backup` | None | JSON attachment named `config.backup.json` |
| `POST /api/restore` | Plain JSON object | Validate and restore; `{ ok: true, restartRequired: true }` |

Unknown project pages return 404. Missing action or restart hooks return 501. Caught handler errors return status 500 with `{ error: message }` and forward the stack to the configured logger. Express body-parser errors use Express's own error handling.

Page-data responses set no-cache headers. The browser API helper parses JSON, falling back to `{}` if parsing fails, and rejects non-success statuses.

---

## Host Hook Model

| Hook | Arguments | Contract |
| --- | --- | --- |
| `onGetPage(id)` | Configured page ID | Return renderer data; null or non-object results become `{}` |
| `onAction(action, data, page)` | Action ID, object data, optional configured page ID | Perform a project-defined command |
| `onValidateConfig(config)` | Submitted plain object | Throw or reject to prevent persistence; return value is ignored |
| `onSaveConfig(config)` | Validated configuration | Replace the default save write |
| `onRestoreConfig(config)` | Validated configuration | Replace the default restore write |
| `onRestart()` | None | Perform host-defined restart handling; return void or a promise |
| `onResetPairing(username, accessory)` | Selected username and matching accessory, if found | Replace default pairing cleanup and restart handling |

Page, action, validation, save, restore, and reset hooks are awaited. Both restart and default pairing reset register a response `finish` listener before sending success. Each handler invokes `onRestart()` after finish and logs synchronous exceptions or promise rejections without sending a second response.

A validation result of `false` does not reject a request. Save, restore, and action hook results do not alter response content. Restore uses its own hook or disk write independently of `onSaveConfig`. Configuration reads and backups always use `configFile`, so persistence hooks must keep that file consistent with saved state.

---

## Configuration Persistence

```text
POST /api/config or /api/restore
        │
        ├─ require a plain JSON object
        ├─ enter the instance persistence queue
        ├─ await onValidateConfig when configured
        ├─ save: onSaveConfig or configFile write
        ├─ restore: onRestoreConfig or configFile write
        └─ return success; restore also reports restartRequired
```

Reads use `fs.readFile()` and `JSON.parse()` on every request. Save and restore share one instance queue covering validation and either host persistence or the default write. A failed operation does not block subsequent queued operations.

Default writes create a temporary file beside the target, write two-space JSON with a trailing newline, flush and close it, then atomically rename it over the target. Existing symlinks are followed and file mode bits are retained; new files use mode `0600`. Temporary files are removed on success or failure. The parent directory must be writable. Readers see the previous or completed file; external writers and separate processes are outside the queue, and no version-conflict check is performed. The backend delegates configuration semantics to host validation.

Backup includes the configuration file only. It excludes HAP pairing storage and runtime state. Restore's restart flag is advisory; the restore handler does not invoke the restart hook.

---

## HomeKit Pairing Model

The `accessories` array is used when it contains non-null entries; otherwise `accessory` supplies the single-accessory fallback. For each accessory, HomeKitUI reads setup and pairing metadata and encodes `setupURI()` as a QR-code PNG data URL.

Each record contains `displayName`, `username`, `pincode`, `setupID`, `setupURI`, `qrCode`, `paired`, and `pairings`, where available. The response includes `accessories`, an `accessory` field for the first record, and first-record fields at the top level for single-accessory consumers.

Metadata comes from public accessory properties and HAP private fields such as `_accessoryInfo` and `_setupID`. Missing pairing information yields `paired: false`; `listPairings()` errors yield an empty list. Setup-URI, QR-generation, or pairing-state errors can fail the request.

Reset computes current details, selects an explicit request username or the first accessory username, and looks up the matching accessory. A reset hook owns the operation when supplied. Otherwise an unmatched username returns 404 before cleanup. For a matching accessory HomeKitUI calls `hap.Accessory.cleanupAccessoryData(username)`, falling back to the matched accessory constructor's method, then calls the restart hook if configured. Cleanup is called directly without awaiting its result. Default reset leaves accessory teardown to the host and its restart lifecycle.

---

## Log Delivery Model

```text
log-source selection
        │
        ├─ configured file path → file history + tail -n 0 -F
        ├─ explicit console → captured history + listeners
        ├─ journald context → journalctl history + follow
        └─ no journal context → console fallback
```

A configured file path takes precedence over `logs.source`. Explicit `file` without a path falls back to console. Both `journald` and `auto` use journal arguments when a service unit or invocation ID can be established; otherwise they use console.

Journal selection prefers `logs.unit`, then a service unit from `/proc/self/cgroup`, then the unit reported by a journal query for the current PID. An invocation ID is the final fallback. Unit queries include previous service runs. History uses `journalctl -o cat`; streaming adds follow mode.

File history reads at most the last 1 MiB, discards an initial partial line, and retains the last configured number of non-empty lines. History line counts are capped at 10,000 and individual records and partial stream lines at 16,384 characters. Console and journal history also have a 1 MiB raw-message byte budget. File and journal records contain `time`, `level`, `message`, `terminal`, and ANSI-converted `html`. Their default level is `info`, and time is assigned during conversion.

Console capture patches `log`, `info`, `warn`, `error`, and `debug` once per process, formats arguments with `util.format()`, retains bounded history, notifies stream listeners, and forwards calls to the original methods. The configured line limit is applied when capture starts. Stopping the instance restores console methods and clears history. Console records retain their method-derived level and raw terminal text; HTML conversion happens when served.

SSE sends a connection event followed by log records. Each file or journal stream owns a child process. Disconnect handling is installed before source discovery so a closed client cannot create a later producer. Request/response closure and `stop()` remove listeners and terminate stream processes. HTTP backpressure disconnects a slow client and cleans up its producer rather than accumulating an unbounded write queue. The browser reloads history on connection, retains up to 500 streamed records, and reconnects after two seconds on stream failure.

The `log` option is separate from captured output: internal module messages call the matching host logger method when present.

---

## Browser State And Rendering

One mutable state object holds the active page, metadata, accessory details, configuration, schemas, page payloads, collapse and visibility state, logs, authentication state, errors, and changed paths.

Navigation uses the URL hash, including hash-change handling. Startup loads application info, HomeKit details, and log history, then project data and configuration when a project page is active. Rendering replaces the shell HTML, mounts schema controls, and restores collapse and visibility state. A scheduled-render helper combines pending updates.

A one-second runtime timer advances displayed uptime and polls application and accessory status every 30 seconds. Project-page refresh intervals are expressed in milliseconds. Refresh applies to non-Status pages without `schemaPath`. Focused inputs and textareas, active pointer gestures, and pending backend actions protect controls from refresh. Other control interactions pause background refresh for five seconds; retained dropdown or button focus does not prolong the pause. Only one automatic page read runs at a time. Deferred renders recheck interaction state and restore dropdown/button focus after replacing the shell. Authentication lock suspends these updates.

Ordinary displayed values are escaped. Sidebar controls and host actions use delegated events and data attributes. Named icons use built-in SVGs; supplied SVGs pass through an element and attribute allowlist that filters the root and descendants, removes active content, and restricts URL references to local fragments. Trusted project HTML is inserted directly under the explicit page opt-in described below.

---

## Project Page Model

The only built-in page ID is `status`. Host pages require non-empty `id` and `title`. Metadata is normalised before being returned by `/api/info`.

| Field | Role |
| --- | --- |
| `id`, `title` | Page identity and sidebar label |
| `icon`, `svg` | Named icon or supplied SVG |
| `schemaPath` | Dot-separated alphanumeric/underscore path into config and schema |
| `restartRequired` | Optional page-level restart setting |
| `refreshInterval` | Positive refresh interval in milliseconds |
| `trustedHTML` | Explicit opt-in to host-rendered HTML and CSS |

Page IDs are checked before invoking `onGetPage()` or an action associated with a page. Normalisation does not enforce unique IDs; hosts should supply unique IDs and retain `status` for the built-in page.

Project rendering supports three flows:

- A `trustedHTML: true` page with `{ type: 'html', html, css? }` renders host HTML directly and installs optional project CSS.
- A `{ type: 'list', items }` payload renders escaped title, subtitle, and value rows.
- Other payloads use the configuration-page shell; a valid `schemaPath` mounts the schema form.

Trusted HTML controls can dispatch `{ action, data, page }` through `/api/action`. Actions invalidate older page reads before dispatch. Only the latest request for each page may apply its payload or ordinary error. After an action completes, the browser reloads its originating page's payload and renders it if that page is still active. Collapse and visibility preferences remain in memory, including changes made while an action was pending. The host owns the markup and action semantics.

Failed project-page loads retain the last successful payload and display the backend or transport error. A successful reload updates the payload and clears the error.

---

## Schema Form Model

`schemaPath` selects both a configuration value and its corresponding JSON Schema section. Schema traversal follows `properties` for objects and `items` for arrays.

Forms support object properties, object-array cards with add/remove controls, comma-separated primitive arrays, enum selects, boolean checkboxes, numeric inputs, and text/password inputs. Numeric handling applies minimum, maximum, and integer conversion. New values use schema defaults where supplied. A blank password input preserves an existing non-empty password value.

Enum controls retain the selected value's original JSON type. Structured defaults and enum values are copied so editing a configuration item cannot mutate another item's defaults or the schema definition.

Edits update the in-memory configuration and record dotted paths in `changedPaths`. Save is enabled while changes exist and posts the entire configuration to `/api/config`. Only one save runs at a time. Successful saving clears changed paths when the configuration revision still matches the submitted revision. Edits made during the request remain dirty and can be saved afterward.

Restart advice is computed in the browser. A page-level `restartRequired: false` suppresses it. Otherwise each changed path is checked against its schema and ancestor schemas for an explicit restart setting; paths without a setting default to requiring restart. Saving can display restart advice but does not initiate a restart.

The optional UI schema is fetched and stored in browser state. The current form renderer uses JSON Schema directly rather than applying UI-schema layout rules. Host validation remains the authoritative persistence check.

---

## Extension Guidelines

- Supply host validation for complete configuration objects.
- Keep file-backed reads and backups consistent with save and restore hooks.
- Provide published accessories through `accessories` or the single-accessory fallback.
- Use page metadata, `onGetPage()`, and `onAction()` for project-specific behavior.
- Enable trusted HTML only for host-owned markup and styles.
- Let the host supervise process replacement through a synchronous or asynchronous restart hook.
- Use a reset hook when pairing cleanup needs a host-specific lifecycle.
- Select file, journal, or console logging through `logs` options.

Public integration examples are documented in [README.md](README.md).
