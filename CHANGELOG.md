# Change Log

All notable changes to the `HomeKitUI` module are documented in this file.

## 2026/04/29

### Added
- Added configurable log streaming support for:
  - Explicit log files
  - journald/systemd services
  - Captured console output for direct/manual runs
- Added automatic journald unit detection for systemd-based services.
- Added ANSI-to-HTML conversion inside `HomeKitUI` so log colours render correctly in the browser.
- Added visible browser scrollbar styling support for the log viewer.

### Changed
- Moved log streaming responsibility into `HomeKitUI`.
- Explicit log file configuration now takes priority over journald and console capture.
- journald is now preferred in auto mode when running under systemd.
- Console capture is now used as the fallback log source for direct/manual runs.
- Removed dependency on legacy Logger history/live listener support for UI log streaming.
- Improved log scrollback behaviour by querying journald by service unit instead of current invocation only.