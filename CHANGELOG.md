# Change Log

All notable changes to the `HomeKitUI` module are documented in this file.

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