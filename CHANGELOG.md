# Change Log

All notable changes to the `HomeKitUI` module are documented in this file.

## 2026/10/09

### Fixed

- Preserved JSON types for enum controls, including boolean choices.
- Copied structured defaults and enum values so new items cannot mutate siblings or schema definitions.
- Kept credentials and UI preferences usable in memory when browser storage fails, with feedback when a password cannot be remembered.
- Preserved the last successful project payload and displayed page load failures; successful reloads clear the error.

### Changed

- Replaced frontend template literals with explicit string concatenation and made the remaining implicit boolean check explicit.
- Documented shared frontend contracts and host page payloads with reusable JSDoc types.
- Updated module and frontend code dates to `2026.10.09`.

## 2026/10/06

### Added

- Public options, callback, and lifecycle JSDoc contracts.
- Adjacent Node test harness covering backend and browser behavior without a package manifest.
- Architecture documentation describing the runtime and host integration.

### Changed

- Updated the module and browser code version to `2026.10.06`.
- Serialised save and restore operations through one instance queue and replaced default writes with atomic file replacement.
- Made console capture instance-owned, restored console methods on shutdown or startup failure, and bounded retained logs and stream buffers.

### Fixed

- Preserved edits made during saving and prevented overlapping browser saves.
- Handled startup binding failures and allowed a later retry.
- Deferred pairing-reset restart until the response finishes and caught synchronous and asynchronous restart-hook errors.
- Shared authentication retry between API requests and backup downloads.
- Prevented errors when editing name fields outside configuration cards.
- Cleaned up early stream disconnects and slow clients.
- Filtered SVG root attributes and restricted icons to allowed elements, attributes, and local references.
- Rejected unconfigured accessory usernames during default pairing cleanup.
- Corrected network-binding documentation to reflect the loopback default.

## 2026/05/10

### Added

- Styled Web UI password dialog with password visibility control, optional browser persistence, and a dedicated authentication-required screen.
- Session-only authentication token storage when “Remember for this browser” is not selected.
- Public `/api/info` access so the frontend can display the application name before authentication.

### Changed

- Concurrent authentication failures share one prompt, with retry after invalid credentials and an explicit locked state when authentication is cancelled.
- Runtime polling and log streaming pause while authentication is required.
- Authentication text refers to the Web UI password while API requests retain bearer-token authentication.

### Fixed

- Prevented partially rendered pairing/log content when authentication is required.
- Preserved existing configuration password values when masked fields are left empty.

## 2026/05/07

### Added

- Optional bearer-token authentication middleware for API requests, configured by the host through `auth.enabled` and `auth.bearerToken`.
- Query-token authentication specifically for SSE logs, browser token storage, and API retry after a 401 response.

### Changed

- Set the default HTTP binding to `127.0.0.1` and included the listen address and authentication status in setup logs.
- Updated the module version to `2026.05.07`.
- Restart now returns `{ ok: true, restartRequired: true }` before invoking the host hook after the response finishes.

### Fixed

- Registered the restart finish listener before sending the response, using a one-time listener to avoid missing the event or invoking restart repeatedly.

## 2026/05/05

### Added

- Generic `switchVisible` frontend action and localStorage persistence for visible sections and collapsed cards.
- Batched render scheduling and a shared `DEFAULT_CONSOLE_HISTORY_LINES` constant.

### Changed

- Deferred dynamic page refresh while form controls are active, preserving collapse and visible state after backend actions.
- Improved sidebar tooltips and console history limit validation/trimming.

## 2026/05/04

### Added

- Declarative dashboard actions through `data-send-action` and JSON `data-payload`, handled by a generic delegated event dispatcher.
- Explicit `trustedHTML` page metadata and persistent head-based CSS injection for custom HTML pages.

### Changed

- Replaced inline click handlers with `data-*` actions and standardised collapse controls on `data-action="toggleCollapse"` and `data-target`.
- Preserved collapsed state after action-driven page refresh and adjusted pairing-card text alignment.
- Configuration saves return `{ ok: true }`, leaving restart decisions to frontend schema/page metadata.
- Validated page schema paths and exposed page-level restart overrides in sanitised metadata.
- Updated the module version to `2026.05.04`.

### Fixed

- Refined SVG sanitisation and allowed custom CSS media rules while filtering imports.
- Made console/child-process log stream cleanup idempotent and handled closed/erroring streams.
- Corrected collapse-arrow state and custom page style injection after rerendering.

## 2026/05/02

### Added

- Configuration path tracking and schema/page-based restart decisions.
- Save button state reflecting pending changes, with saving disabled when no edits are tracked.
- Generic `POST /api/action` endpoint and `onAction(action, data, page)` host callback, with optional page validation.
- Frontend action submission followed by page-data refresh.

### Changed

- Replaced unconditional restart alerts with conditional restart confirmation after saving.
- Preserved manual log scroll position when auto-scroll is disabled.
- Updated the module version to `2026.05.02`.

## 2026/04/30

### Added

- URL hash routing, persistence of the selected page on reload, and browser back/forward navigation.
- Compact primitive-array configuration inputs, schema-based numeric normalisation, and array-item creation controls.
- Runtime page refresh metadata and collapsible project sections.

### Changed

- Consolidated uptime updates, status polling, and dynamic page refresh into one runtime timer.
- Preserved log pause/scroll behavior through page rendering and navigation.
- Expanded setup logging with the configured pages and updated the module version to `2026.04.30`.

## 2026/04/29

### Added

- Apache License 2.0, README, and the original changelog.
- Module-managed log sources for explicit files, journald/systemd, and captured console output, with automatic service-unit detection and ANSI-to-HTML conversion.
- Log viewer scrollbar styling and history reload on stream reconnection.

### Changed

- Replaced shared Logger history/live-listener integration with file/journal/console log retrieval and streaming.
- Explicit log files take precedence; auto mode prefers journald under systemd and falls back to console capture for direct runs.
- Improved startup log scrollback and log pause/scroll controls.

### Removed

- Removed the initial `.gitignore` in the same day's follow-up commit.

## 2026/04/28

Commit: `927bbd1` — “Enhancements”.

### Added

- Multi-accessory pairing/status support while preserving the original single-accessory option and top-level response fields.
- Schema-generated configuration forms for objects, arrays, enum values, booleans, numbers, and strings.
- Startup port validation and no-cache headers for dynamic page data.

### Changed

- Selected the matching accessory by username for pairing reset.
- Moved schema-backed editing from raw JSON text to an in-memory configuration model.

## 2026/04/27

### Added

- Initial `HomeKitUI` ES module with configurable application metadata, HTTP binding, configuration/schema paths, logger, and host accessory integration (`f7e8635`, “Initial commit”).
- `start()` and `stop()` methods for the Express server, with a default port of 8581 and source version `2026.04.27`.
- API endpoints for application information, configuration read/save, JSON Schema, HomeKit pairing details/reset, service restart, logs, configuration backup, and restore.
- HomeKit setup URI and QR generation, with pairing status and controller details read from the supplied accessory.
- Formatted JSON-file persistence and optional host hooks for validation, saving, restore, restart, pairing reset, and log retrieval.
- Optional host-selected static UI directory through the original `staticPath` option.
- Built-in HTML, JavaScript, and CSS interface with Status, Configuration, Logs, and Maintenance pages (`a5673ee`, “Default ui”).
- Whole-configuration JSON editor, log refresh, configuration backup download, restart confirmation, and pairing reset confirmation in the built-in UI.
- Optional `uiSchemaFile` configuration and `GET /api/ui-schema`, returning an empty object when no path is configured.
- Custom page metadata through `pages` and `/api/info`, with filtering of supported fields and frontend display of dot-selected configuration sections.

- Generic `GET /api/page/:id` and `onGetPage` integration, theme metadata, uptime/port information, and custom SVG navigation metadata.
- SSE log streaming and history through the shared Logger interface, plus runtime options supplied to `start(options)`.

### Changed

- Replaced host-selected `staticPath` serving with a fixed module-relative `dist/ui/` directory and an unconditional entry-point fallback (`a5673ee`).
- Updated module documentation and the integration example for the built-in UI, optional UI schema, and custom page metadata.
- In the subsequent dynamic-pages refinement, served assets directly from `ui/` and changed the entry fallback to middleware (`0b28e06`).
- Pairing reset stopped calling accessory unpublish/destroy directly, delegating process restart to the host after persistence cleanup.
