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
| Designing visually on the desktop canvas | [Build your first workflow](desktop/build-your-first-workflow.md) |
| Automating in CI / the terminal | [Run a workflow in CI](cli/run-a-workflow-in-ci.md) |
| Living inside VS Code | [Trigger a workflow from VS Code](vscode/trigger-from-vscode.md) |

## Recommended path

If you are brand new to Relavium, do them in this order. The desktop tutorial gives you
the mental model (workflow, nodes, run, cost), the CLI tutorial shows the same workflow
running headless and committed to git, and the VS Code tutorial shows the
zero-install-to-value path many developers prefer day to day.

1. [Build your first workflow (desktop)](desktop/build-your-first-workflow.md)
2. [Run a workflow in CI (CLI)](cli/run-a-workflow-in-ci.md)
3. [Trigger a workflow from VS Code](vscode/trigger-from-vscode.md)

The same workflow runs identically across all three surfaces — that portability is the
point (see [uvp.md](../uvp.md)).
