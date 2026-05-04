# Change Log

All notable changes to the `HomeKitUI` module are documented in this file.

## 2026/05/04

### Added
- Added support for backend-defined dashboard actions via `data-send-action` and JSON `data-payload`
- Added generic frontend action dispatcher for backend-driven UI interactions
- Added reusable backend helpers for generating safe dashboard buttons
- Added persistent `<head>`-based CSS injection for custom HTML pages

### Changed
- Replaced all inline `onclick` handlers with declarative `data-*` attributes
- Updated dashboard rendering to support fully trusted backend HTML (`trustedHTML`)
- Improved SVG sanitisation to remove unsafe elements and attributes
- Updated log streaming to ensure idempotent cleanup and prevent listener/process leaks
- Standardised collapse handling using `data-action="toggleCollapse"` and `data-target`
- Updated collapse state restoration to align with new attribute model
- Refined CSS handling for custom pages to allow `@media` and block only unsafe `@import`
- Improved event delegation model to support both core UI actions and backend-defined actions

### Fixed
- Fixed dashboard CSS not rendering due to overly strict `@` filtering
- Fixed collapse toggle arrow not rotating due to selector mismatch
- Fixed duplicate or stale style injection during page refresh
- Fixed log stream cleanup edge cases causing potential resource leaks
- Fixed schemaPath handling inconsistencies in page sanitisation

### Removed
- Removed inline JavaScript execution from all dynamically rendered HTML
- Removed legacy `data-collapse` attribute in favour of `data-target`

## 2026/05/02

### Added
- Added schema-driven `restartRequired` support for configuration fields.
- Added tracking of modified configuration paths to determine restart requirements dynamically.
- Added dynamic Save Configuration button behaviour:
  - Highlights only when there are unsaved changes
  - Disabled when no changes are pending
  - Label updates between “Save Changes” and “No Changes”

### Changed
- Configuration save workflow now evaluates restart requirements based on changed fields and schema metadata.
- Restart prompt is no longer shown unconditionally after saving configuration.
- Page-level `restartRequired: false` now suppresses restart prompts entirely for that page.
- Default behaviour is now “restart required” unless explicitly disabled via schema or page configuration.
- Improved configuration UX to better reflect real-time edit state.
- Save

### Removed
- Removed unconditional restart alert after saving configuration.

## 2026/04/30

### Added
- Added URL hash-based page navigation support (e.g. `/#dashboard`) for `HomeKitUI`.
- Added browser refresh persistence so the currently selected page is retained on reload.
- Added support for browser back/forward navigation between pages.

### Changed
- Page routing is now driven by `window.location.hash` instead of internal-only state.
- Initial page load now resolves from URL hash when present, falling back to default page.
- Improved client-side navigation behaviour to better align with standard web app expectations.

## 2026/04/29

### Added
- Added startup logging for `HomeKitUI`, including listening port and configured pages.
- Added configurable log streaming support for:
  - Explicit log files
  - journald/systemd services
  - Captured console output for direct/manual runs
- Added automatic journald unit detection for systemd-based services.
- Added ANSI-to-HTML conversion inside `HomeKitUI` so log colours render correctly in the browser.
- Added visible browser scrollbar styling support for the log viewer.

### Changed
- Project pages are now logged at debug level during `HomeKitUI` startup.
- Moved log streaming responsibility into `HomeKitUI`.
- Explicit log file configuration now takes priority over journald and console capture.
- journald is now preferred in auto mode when running under systemd.
- Console capture is now used as the fallback log source for direct/manual runs.
- Removed dependency on legacy Logger history/live listener support for UI log streaming.
- Improved log scrollback behaviour by querying journald by service unit instead of current invocation only.