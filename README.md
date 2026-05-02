# HomeKitUI

Web UI module for standalone HomeKit applications using HAP-NodeJS.

Provides a browser-based interface for configuration, status monitoring, log streaming, and maintenance operations.

---

## Overview

`HomeKitUI` runs alongside your application and exposes a browser-based interface for:

- Viewing and editing configuration
- Managing HomeKit pairing
- Viewing logs (journald, file, or console)
- Accessing project-specific pages
- Performing maintenance actions (restart, restore, backup)
- Triggering runtime actions from UI pages

The module is **application-level**, not device-level.

---

## Features

- Built-in web UI (no external frontend required)
- JSON Schema-driven config UI
- HomeKit pairing details (QR code, setup URI)
- Multi-accessory support
- Live log streaming (SSE)
- URL-based navigation with browser history support
- journald integration (systemd-aware)
- File-based log support
- Console capture fallback
- Backup and restore support
- Dynamic UI actions via API (`/api/action`)

---

## Usage Example

    import HomeKitUI from './HomeKitUI.js';

    let ui = new HomeKitUI({
      name: 'GarageDoor',
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

---

## Options

| Option | Description |
|--------|------------|
| `name` | Display name in UI |
| `version` | Application version |
| `port` | Web UI port |
| `host` | Optional bind address |
| `configFile` | Path to config JSON |
| `schemaFile` | Path to JSON schema |
| `uiSchemaFile` | Path to UI schema (optional) |
| `accessory` | Single HAP accessory |
| `accessories` | Array of HAP accessories |
| `hap` | HAP-NodeJS reference |
| `log` | Logger for internal UI messages |
| `logs` | Log source configuration |
| `pages` | Custom UI pages |
| `onValidateConfig` | Config validation hook |
| `onSaveConfig` | Custom save handler |
| `onRestoreConfig` | Custom restore handler |
| `onRestart` | Restart handler |
| `onResetPairing` | Pairing reset handler |
| `onGetPage` | Dynamic page data provider |
| `onAction` | Handle UI-triggered actions |

---

## Logging

### Log Source Priority

1. Explicit file (`logs.file`)
2. journald (systemd environments)
3. console capture fallback

### Example

    logs: {
      source: 'auto',
      file: '/var/log/app.log',
      unit: 'my-service.service',
      lines: 500,
    }

### Notes

- journald uses service unit when available → enables full scrollback
- console capture is used for manual runs
- file mode supports log rotation (`tail -F`)

---

## Navigation

`HomeKitUI` supports URL-based navigation using hash routing.

- Pages can be accessed directly via URL (e.g. `/#dashboard`)
- The current page is preserved on browser refresh
- Browser back/forward navigation is supported

This enables deep linking and improves usability when accessing the UI remotely.

---

## API Endpoints

| Endpoint | Description |
|----------|------------|
| `/api/info` | UI metadata |
| `/api/config` | Get/save config |
| `/api/schema` | JSON schema |
| `/api/ui-schema` | UI schema |
| `/api/page/:id` | Custom page data |
| `/api/action` | Trigger runtime actions |
| `/api/homekit` | Pairing info |
| `/api/homekit/reset` | Reset pairing |
| `/api/service/restart` | Restart hook |
| `/api/logs` | Fetch logs |
| `/api/logs/stream` | Live log stream |
| `/api/backup` | Download config |
| `/api/restore` | Restore config |

---

## Custom Pages

Pages can be accessed directly via URL using their `id` (e.g. `/#status`).

    pages: [
      {
        id: 'status',
        title: 'Status',
        icon: 'activity',
      },
    ]

    onGetPage: async (id) => {
      if (id === 'status') {
        return { online: true };
      }
    }

---

## UI Actions

UI elements (buttons, toggles, etc.) can trigger backend logic via `/api/action`.

    fetch('/api/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'setPower',
        value: true
      })
    });

    onAction: async ({ action, value }) => {
      if (action === 'setPower') {
        await HomeKitDevice.message(uuid, HomeKitDevice.SET, {
          power: value
        });
      }
    }

---

## HomeKit Integration

Supports:

- Single accessory (`accessory`)
- Multiple accessories (`accessories`)

Provides:

- QR code generation
- Setup URI
- Pairing state
- Pairing list (if supported by HAP)

---

## Lifecycle

### start(options?)

Starts the web server.

### stop()

Stops the web server and cleans up log streams.

---

## Architecture Notes

- UI is served from built-in `ui/` directory
- Backend is stateless (reads config from disk each request)
- Logging is external (file/journald/console), not owned by UI
- Designed for systemd, Docker, or direct execution
- Host application owns all device logic and runtime control

---

## Versioning

    static VERSION = '2026.05.02';