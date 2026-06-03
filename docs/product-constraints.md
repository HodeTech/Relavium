# Product Constraints

- **Status**: Binding
- **Related**: [vision.md](vision.md), [roadmap/README.md](roadmap/README.md), [tech-stack.md](tech-stack.md)

These are the hard, user-defined boundaries for Relavium. They override
convenience and feature pressure. When a proposed feature conflicts with a
constraint here, the constraint wins.

## Hard Constraints

### The desktop app is NOT an IDE

The desktop app is a pure **agent-management center**. Its scope is exactly:

- Workflow canvas design
- Agent creation and configuration
- Run monitoring and history
- Provider / API key management
- Cost tracking

It does **not** have a code editor, a file browser, or a terminal. That is the
VS Code extension's job. When suggesting features for the desktop app, keep them
within agent-management scope; code-editing ideas belong to the VS Code
extension.

### Local-first in Phase 1

No cloud dependency. No account required to use the product. Agents run on the
user's machine and API calls go directly to the LLM providers. Privacy is a
feature. See the execution model in [vision.md](vision.md).

### Cloud execution is Phase 2

Do not design Phase 1 to require the cloud. The engine architecture must support
both local and cloud modes via a clean interface switch, so that Phase 2 adds a
cloud layer without breaking Phase 1 surfaces. See [roadmap/README.md](roadmap/README.md).

### Workflow files are git-native

`.relavium/*.relavium.yaml` files are first-class artifacts — designed to be
committed, PR'd, code-reviewed, and version-controlled. The schema is a public
API from day one; breaking changes require a migration path so users'
git-committed workflows do not silently break.

## Explicit MVP Out-of-Scope

The following are explicitly **not** part of the Phase 1 MVP:

| Out of scope (MVP) | Why / where it lands |
|--------------------|----------------------|
| Multi-user / team features | Phase 2 (cloud + portal) |
| Billing / subscription | Phase 2 |
| Ollama / local models | API-based providers only for MVP |
| Cloud execution queue | Phase 2 (BullMQ + Redis) |
| Web portal | Phase 2 |
| Automatic cloud firing of scheduled / webhook triggers | Phase 2 — auto-fire needs an always-on cloud listener; the trigger *types* are still declarable in Phase 1 (see note and [ideas/scheduled-and-webhook-triggers.md](ideas/scheduled-and-webhook-triggers.md)) |
| OAuth | Portal uses email + password only at first |

> The `manual` and `file_change` triggers fire automatically in Phase 1. The
> `webhook` and `schedule` trigger *types* are declarable in YAML in Phase 1 and
> are honored when the workflow is invoked manually or by a user-run watcher;
> only **automatic cloud-hosted firing** (an always-on HTTP listener / cron
> scheduler) is deferred to Phase 2. See
> [reference/contracts/workflow-yaml-spec.md](reference/contracts/workflow-yaml-spec.md).

## Rationale

The user explicitly confirmed that the desktop app is an application for
*managing agents* — no separate IDE, agent-management focus only. Every scope
decision above flows from that intent: keep the desktop surface focused, ship a
trustworthy local-first product first, and earn the cloud layer with real usage
data rather than building it speculatively.
