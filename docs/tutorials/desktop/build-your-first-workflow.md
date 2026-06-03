# Build Your First Workflow (Desktop)

> Status: draft — to be expanded

In this tutorial you go from a freshly installed desktop app to a running, multi-node AI
workflow — adding a provider key, creating an agent, opening a starter template, and
watching tokens stream live on the canvas. No account, no cloud: everything runs
locally on your machine (see [product-constraints.md](../../product-constraints.md)).

This walkthrough is the canonical "day-one" experience. The schemas it produces have
their one home in
[workflow-yaml-spec.md](../../reference/contracts/workflow-yaml-spec.md) and
[agent-yaml-spec.md](../../reference/contracts/agent-yaml-spec.md); the node types you
drag onto the canvas are catalogued in
[node-types.md](../../reference/shared-core/node-types.md). This tutorial links to those
specs rather than restating them.

## What you will build

A three-node **Research Pipeline**: an input feeds a research agent, whose output feeds
a summary agent, whose output lands in an output node. You will run it and read the run
record (duration, cost, tokens).

## Prerequisites

- The desktop app installed (`brew install --cask relavium`, or the `.dmg` from the
  download page). The macOS bundle is only a few MB because Tauri uses the OS-native
  WebView.

## Steps (to be expanded)

1. **Open the app.** The canvas is visible but dimmed, with one focused CTA: *Connect
   your first API key*.
2. **Add a provider key.** Click *Connect API Key* → select Anthropic → paste your key
   → *Verify & Save*. The model list populates with context windows and per-token
   pricing; the key goes to the OS keychain. Full procedure:
   [add-a-provider-key.md](../../runbooks/add-a-provider-key.md).
3. **Create your first agent.** Click *Create Agent*, name it `Summarizer`, pick a
   model, write a system prompt, and use *Test Agent* to watch a streaming reply. The
   agent is saved to local SQLite. Agent fields are defined in
   [agent-yaml-spec.md](../../reference/contracts/agent-yaml-spec.md).
4. **Open a starter template.** Click the *Research Pipeline* template card. The canvas
   opens with a pre-built `Input → ResearchAgent → SummaryAgent → Output` graph whose
   placeholder agents auto-bind to the agent you just created.
5. **Run it.** Click *Run* (or `Cmd+Enter`), fill the input modal (`topic: quantum
   computing`), and *Start Run*. Nodes light up sequentially; tokens stream **inside the
   agent node faces** on the canvas, not in a separate log. This live canvas execution
   theater is a signature Relavium feature.
6. **Read the run record.** The Run History panel slides up showing duration, total
   cost, token count, and a per-node cost waterfall so you can see which node spent
   what.

## What just happened

To be expanded. This section will connect the on-screen experience to the underlying
model: the engine ran a DAG over your nodes, streamed events to the canvas via the
[SSE event schema](../../reference/contracts/sse-event-schema.md), checkpointed each
node, and recorded the run to local SQLite (schema:
[database-schema.md](../../reference/desktop/database-schema.md)).

## Next steps

- Commit the workflow YAML and run the same pipeline headless:
  [Run a workflow in CI](../cli/run-a-workflow-in-ci.md).
- Trigger a workflow on a file from your editor:
  [Trigger from VS Code](../vscode/trigger-from-vscode.md).
