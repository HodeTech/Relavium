# Ideas

This folder holds **idea notes**: things worth capturing but explicitly **not committed
work**. An idea note records a direction, its rationale, and what it would take — without
implying it is on the roadmap.

Idea notes are the opposite of [decisions/](../decisions/README.md). A decision is
settled and binding; an idea is a possibility, parked here so it is not lost. If an idea
matures into a real choice, it graduates to an ADR (and usually appears in
[roadmap/README.md](../roadmap/README.md)); the idea note then links forward to that ADR.

## How to read a note here

- An idea note is **not** a promise. Nothing in this folder is in scope unless it also
  appears in [roadmap/README.md](../roadmap/README.md) or has an accepted ADR.
- Many notes describe **Phase-2 (cloud)** behavior. Per
  [documentation-style.md](../standards/documentation-style.md) §9, those are marked
  explicitly so they are never mistaken for shipped Phase-1 behavior.
- Notes cite the canonical [reference](../reference/README.md) specs they would touch
  rather than restating them.

## Notes

| Note | Summary | Status |
|------|---------|--------|
| [scheduled-and-webhook-triggers.md](scheduled-and-webhook-triggers.md) | Time-based (cron) and HTTP webhook triggers for workflows. Out of scope for Phase 1 because they require an always-on listener. | Phase-2 idea, out of Phase-1 scope |
| [evaluation-harness.md](evaluation-harness.md) | Run a workflow against a git-committed dataset and score the outputs — deterministic scorers first, LLM-as-judge strictly opt-in, in-process via the normal engine. | Phase-2+ idea, not committed |

## When to add a note here

Add an idea note when you want to record a *future* direction and its reasoning without
committing to it. If the thing is already decided, write an
[ADR](../decisions/README.md) instead. If it is a research comparison, it belongs in
[analysis/](../analysis/README.md).
