# Idea: Scheduled and Webhook Triggers

- **Status**: Idea — out of scope for Phase 1
- **Phase**: Phase 2 (cloud)
- **Related**: [product-constraints.md](../product-constraints.md), [roadmap/README.md](../roadmap/README.md), [reference/contracts/workflow-yaml-spec.md](../reference/contracts/workflow-yaml-spec.md), [architecture/cloud-phase-2.md](../architecture/cloud-phase-2.md)

This note captures the idea of triggering workflows **automatically** — on a schedule
(cron) or by an inbound HTTP webhook — rather than only by an explicit human action.

> This is an **idea note, not committed work**. Scheduled and webhook triggers are
> explicitly **out of scope for the Phase-1 MVP** (see
> [product-constraints.md](../product-constraints.md)). They are recorded here so the
> design space is not lost, and so the workflow YAML can leave room for them.

## The idea

Today a Relavium run starts from a deliberate action: clicking *Run* on the desktop
canvas, `relavium run` in the terminal, or a right-click in VS Code. Two trigger types
would let workflows start without a person present:

- **Scheduled (cron) trigger** — run a workflow on a recurring schedule (e.g. a nightly
  dependency audit, a Monday-morning changelog summary).
- **Webhook trigger** — run a workflow when an external system POSTs to an endpoint
  (e.g. a GitHub PR opened, a CI job finished, a Slack slash command).

## Why it is out of scope for Phase 1

The reason is structural, not a matter of priority. Phase 1 is **local-first with zero
cloud dependency** (see [product-constraints.md](../product-constraints.md) and
[architectural-principles.md](../standards/architectural-principles.md) §3). Both trigger
types break that constraint:

- A **cron trigger** needs a process that is reliably running at the scheduled time. A
  developer's laptop is asleep, closed, or offline most of the time — so a local-only
  scheduler would silently miss runs. Reliable scheduling needs an always-on host.
- A **webhook trigger** needs a publicly reachable, always-listening HTTP endpoint. A
  local machine behind NAT has no stable public address, and exposing one is a security
  liability. Reliable webhooks need a cloud listener.

In short: both require an **always-on listener**, which is exactly what Phase 1
deliberately does not ship.

> A closely related, **in-scope** trigger does ship in Phase 1: the **`file_change`**
> trigger, which fires from a local file watcher while the app or extension is running.
> It needs no cloud listener. See the `trigger` block in
> [workflow-yaml-spec.md](../reference/contracts/workflow-yaml-spec.md).

## What a Phase-2 implementation would look like

> **Phase 2 (cloud).** The following is sketch-level and not committed. It depends on the
> cloud layer described in [architecture/cloud-phase-2.md](../architecture/cloud-phase-2.md).

- **Cron** — handled by the cloud queue's repeat-job mechanism, with the schedule
  declared in the workflow YAML `trigger` block. The cloud worker runs the *same*
  `@relavium/core` engine as every local surface, so a scheduled run behaves identically
  to a manual one.
- **Webhook** — an ultra-low-latency edge endpoint (e.g. `POST /webhooks/:workflowId`)
  authenticates the caller, maps the payload to the workflow's declared `inputs`, and
  enqueues a run. The endpoint only enqueues; it never runs the workflow inline.
- **YAML shape** — both would extend the existing `trigger` field (which already
  enumerates `manual`, `file_change`, and reserves `schedule` / `webhook`). The canonical
  schema is in [workflow-yaml-spec.md](../reference/contracts/workflow-yaml-spec.md); any
  real implementation updates that one home, not this note.
- **Execution-model candidate (the part that needs an ADR).** Whatever hosts the
  scheduler, the *execution model* should be: **durable and run-id'd** — schedule state
  lives in the database keyed to real run records
  ([ADR-0022](../decisions/0022-run-references-workflow-by-uuid.md)), never a loose
  side-file, so a crash can neither lose a fire nor double-fire (claim-idempotency: a
  fire is claimed transactionally before it enqueues, and a zombie claim from a dead
  host is reaped on startup); **deterministic catch-up policy** declared per workflow
  (skip vs run-once-on-recovery — never an unbounded replay storm); and **scheduling
  stays a host/surface concern outside `@relavium/core`** — the engine exposes
  `start(workflowId, input)` and stays free of timers and platform imports
  ([ADR-0003](../decisions/0003-pure-ts-engine-not-langgraph-python.md)), so the same
  scheduler core could drive a Phase-2 cloud queue or a long-running local host without
  forking the engine.

## Open questions

- **Auth for webhooks** — shared secret vs. signed payloads vs. per-workflow tokens.
- **Idempotency** — deduplicating a webhook that fires twice for the same event.
- **Backfill / catch-up** — does a missed cron run replay when the host comes back, or
  is it skipped?
- **Local ↔ cloud parity** — can a developer test a scheduled/webhook workflow locally
  before it is promoted to the cloud?

## Promotion path

If this idea is taken up, it becomes a roadmap item and (where it makes a non-trivial
choice, e.g. webhook auth) an [ADR](../decisions/README.md). At that point this note gets
a forward link to the ADR and the canonical trigger schema moves entirely into
[workflow-yaml-spec.md](../reference/contracts/workflow-yaml-spec.md).

> Source: the Phase-1 out-of-scope list in [product-constraints.md](../product-constraints.md)
> and the Phase-2 trigger discussion in the frozen `synthesis-raw.json` (`corePortal`
> section). See the [archive provenance map](../analysis/_archive/README.md).
