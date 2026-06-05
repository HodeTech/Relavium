# Tutorials

Tutorials are **learning-oriented walkthroughs**: start from zero and build something
real end-to-end. They differ from [runbooks/](../runbooks/README.md), which assume you
already know why and just need the steps. A tutorial teaches the concept while you do
it.

Every tutorial is grounded in the canonical [reference](../reference/README.md) specs
and links to them rather than restating them (see
[documentation-style.md](../standards/documentation-style.md) §6).

## Pick your first tutorial by surface

| If you are… | Start here |
|-------------|-----------|
| Just want to start talking to an agent | [Start a chat session](cli/start-a-chat-session.md) *(planned, Phase 2)* |
| Designing visually on the desktop canvas | [Build your first workflow](desktop/build-your-first-workflow.md) |
| Automating in CI / the terminal | [Run a workflow in CI](cli/run-a-workflow-in-ci.md) |
| Living inside VS Code | [Trigger a workflow from VS Code](vscode/trigger-from-vscode.md) |

## Recommended path

If you are brand new to Relavium, follow the product's own arc — **start as an agent,
ship the workflow, own every run.** You begin in a conversation, turn that conversation
into a committed workflow, then watch the same workflow run identically on every surface.

1. [Start a chat session (CLI)](cli/start-a-chat-session.md) — talk to an agent, watch
   it use tools, no YAML up front. *(planned, Phase 2)*
2. **Export the session to a workflow** — turn the conversation into a reviewable
   `.relavium.yaml` scaffold (see [ADR-0026](../decisions/0026-session-export-to-workflow.md)).
   *(tutorial planned)*
3. [Build your first workflow (desktop)](desktop/build-your-first-workflow.md) — give you
   the full mental model (workflow, nodes, run, cost) on the canvas.
4. [Run a workflow in CI (CLI)](cli/run-a-workflow-in-ci.md) — the same workflow running
   headless and committed to git.
5. [Trigger a workflow from VS Code](vscode/trigger-from-vscode.md) — the
   zero-install-to-value path many developers prefer day to day.

The chat session and the workflow run sit on the **same** engine, and the same workflow
runs identically across every surface — that continuum and that portability are the
point (see [uvp.md](../uvp.md)).
