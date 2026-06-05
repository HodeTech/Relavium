# Reference — VS Code Extension

Specs for the VS Code extension — the in-editor surface for both **conversational
agent chat** and **triggering workflows** on files. It is standalone: it bundles
`packages/core` and runs both entry points in-process, so the desktop app is not
required.

Part of [reference/](../README.md).

| File | Reference |
|------|-----------|
| [extension-api.md](extension-api.md) | The extension's commands, the chat panel (agent session), right-click triggers, status bar, sidebar, human-gate webview, chat/run events, and settings. |
