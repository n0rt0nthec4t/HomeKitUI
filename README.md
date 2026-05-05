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
- Performing maintenance actions (restart, backup, restore)  
- Triggering runtime actions from the UI  

The module operates at the **application level**, not the device level.

---

## Features

- Built-in web UI (no external frontend required)  
- JSON Schema-driven configuration editor  
- HomeKit pairing support (QR code, setup URI, status)  
- Multi-accessory support  
- Live log streaming (SSE with automatic reconnect)  
- URL-based navigation with browser history support  
- journald, file, and console log support  
- Custom dashboard pages (backend-rendered HTML)  
- Declarative UI actions (no inline JavaScript)  
- Persistent UI state (collapse panels and selections remembered)  
- Smooth, flicker-free updates via batched rendering  
- Backup and restore support  

---

## UI Philosophy

HomeKitUI follows a backend-driven UI model:

- The frontend is generic and declarative  
- The backend defines behaviour via API responses and `data-*` attributes  
- No inline JavaScript is executed from dynamic content  
- All user interactions are routed through a central action dispatcher  

---

## Usage Example

```js
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
```

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

## Version

```
static VERSION = '2026.05.05'
```