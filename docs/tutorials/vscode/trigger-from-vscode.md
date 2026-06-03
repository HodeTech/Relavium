# Trigger a Workflow from VS Code

> Status: draft — to be expanded

This tutorial shows the lowest-friction path to a meaningful Relavium run: install the VS
Code extension, **right-click a file**, and run a workflow on it — no desktop app, no
account, no server. The extension bundles the same `@relavium/core` engine and runs the
workflow in-process in the extension host, so your first run is under a few minutes away.

This walkthrough teaches the extension by using it. For the exact command IDs, settings,
and events, see the canonical
[VS Code extension API reference](../../reference/vscode/extension-api.md) — this tutorial
links to it rather than restating it.

## What you will accomplish

- Install the extension and confirm it activated.
- Right-click a source file and run a committed workflow on it.
- Watch the run stream live in the Relavium sidebar and read the result.

## Prerequisites

- VS Code.
- The Relavium extension (install below).
- At least one LLM provider key. The extension reads keys from secure secret storage —
  see [add-a-provider-key.md](../../runbooks/add-a-provider-key.md) and
  [keychain-and-secrets.md](../../reference/desktop/keychain-and-secrets.md).
- A workflow committed under `.relavium/` in the open workspace. Its schema's one home is
  [workflow-yaml-spec.md](../../reference/contracts/workflow-yaml-spec.md). The extension
  activates when it detects a `.relavium/` folder in the workspace.

## Steps (to be expanded)

1. **Install the extension.** From the Extensions panel search *Relavium* and click
   **Install**, or:

   ```bash
   code --install-extension relavium.relavium
   ```

2. **Confirm it activated.** Open a workspace that contains a `.relavium/` directory. The
   Relavium icon appears in the Activity Bar (sidebar), and a status-bar item shows
   `Relavium: idle` at the bottom right. The status bar is your passive run monitor — it
   updates as runs start, stream, and finish.

3. **Right-click a file to run.** In the editor or Explorer, right-click a source file
   (e.g. a `.ts`, `.py`, or `.md`) and choose **Run Relavium Workflow on this file**. The
   extension filters to workflows whose input schema accepts that file type and shows them
   in a QuickPick.

4. **Pick a workflow.** Select a workflow (for example a *Code Review Chain*) and press
   Enter. The active file's path is injected as the workflow input — you do not retype it.

5. **Watch it stream.** The status bar switches to a spinner with the active-run count,
   and the Relavium sidebar shows the live run: per-node status, a short streaming output
   preview per node, and cost-so-far. Completed nodes show a check; a failed node shows an
   error state.

6. **Resolve a human gate, if any.** If the workflow hits a `human_gate` node, the
   extension surfaces it as an ambient prompt (sidebar / status bar / panel) with the gate
   message and the time remaining. Approve, reject, or provide input without leaving the
   editor.

7. **Read the result.** When the run completes, the final output appears in the run output
   panel (for example, a formatted code review). The run is recorded locally just as it
   would be from the desktop or CLI.

## What just happened

To be expanded. This section will connect the in-editor experience to the engine model:
the extension activated on the `.relavium/` workspace, loaded the workflow, and ran the
*same* `@relavium/core` engine in-process — streaming
[RunEvents](../../reference/contracts/sse-event-schema.md) to the sidebar instead of a
canvas, checkpointing each node, and recording the run locally. The engine behavior is
identical to the desktop and CLI surfaces (see
[shared-core-engine.md](../../architecture/shared-core-engine.md)); only the host differs.

## Optional: the desktop integration

The extension runs **fully standalone** — it never requires the desktop app. If the
desktop app *is* running, the extension detects it and unlocks enhancements such as
*Open in Designer* (jump to the visual canvas for that workflow). When the desktop app is
not present, the extension silently stays in standalone mode with no degradation. This is
the "Model C hybrid" connection model documented in the
[extension API reference](../../reference/vscode/extension-api.md) and the
[IPC contract](../../reference/contracts/ipc-contract.md).

## Next steps

- Design a workflow visually first: [Build your first workflow (desktop)](../desktop/build-your-first-workflow.md).
- Run the same workflow headless in a pipeline: [Run a workflow in CI](../cli/run-a-workflow-in-ci.md).
- Full command, settings, and event surface: [VS Code extension API reference](../../reference/vscode/extension-api.md).
