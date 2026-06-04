# Reference — Desktop

Specs specific to the Tauri v2 desktop app — the agent-management surface. The
desktop app is **not an IDE** (see [ADR-0007](../../decisions/0007-desktop-is-not-an-ide.md));
these references cover its local storage, secret handling, native plugins, and screens.

Part of [reference/](../README.md).

| File | Reference |
|------|-----------|
| [database-schema.md](database-schema.md) | The local SQLite (Drizzle) run-history and catalog schema. |
| [keychain-and-secrets.md](keychain-and-secrets.md) | OS keychain storage for API keys + encrypted-file fallback. |
| [tauri-plugins.md](tauri-plugins.md) | The Tauri v2 plugins used (fs, shell, sql, keychain, tray, global-shortcut, notification, dialog, http, clipboard). |
| [routes-and-screens.md](routes-and-screens.md) | The desktop app's screens/routes (dashboard, workflows, canvas, agents, runs, settings). |
