# ADR-NNNN: Title

- **Status**: Accepted
- **Date**: YYYY-MM-DD
- **Related**: [ADR-XXXX](XXXX-related-slug.md)

<!--
Copy this file to docs/decisions/NNNN-your-slug.md (next free zero-padded number) and
fill it in. Choose the starting Status by whether the decision is actually settled:

  - If the decision is ALREADY SETTLED when you write the ADR (the common case in this
    corpus — every committed ADR is Accepted), author it directly as Accepted. Do not
    perform a ceremonial Proposed -> Accepted round-trip for a decision that is already
    made.
  - If the decision is GENUINELY OPEN and you are recording it to drive discussion, start
    as Proposed and flip to Accepted in a later commit once it is settled.

Never delete or rewrite a superseded ADR — mark it
"Superseded by [ADR-XXXX](XXXX-...md)" and link forward; the historical reasoning is
the point.

Status enum (use one):
  - Proposed                 — drafted for a still-open decision, awaiting Accept.
  - Accepted                 — settled; the project follows this decision (default).
  - Deprecated               — historical; followed for a time but no longer.
  - Superseded by [ADR-XXXX] — overridden by a later ADR; old body preserved.

This is the condensed MADR form used across the whole decisions/ corpus: Context,
Decision (with the considered alternatives written inside it), Consequences. Do not
restate pinned version numbers — reference ../tech-stack.md so versions have one
canonical home (see standards/documentation-style.md §6, §7). For an unusually
contested decision you may add explicit ## Decision drivers / ## Considered options
/ ## Decision outcome / ## References sections — but keep a single ADR internally
consistent and prefer the condensed form for the common case.
-->

## Context

What situation, problem, or question is being decided? What constraints apply (the
current Relavium vision: engine-first TypeScript, local-first Phase 1,
desktop-is-not-an-IDE, git-native YAML)? What are the stakes of getting this wrong?
Link to the relevant [product-constraints.md](../product-constraints.md) or
[architectural-principles.md](architectural-principles.md) clauses that frame the
decision.

## Decision

State the decision plainly: **we will do X.** Then walk the alternatives that were
weighed and why they lost — e.g. "Considered A (rejected: …), B (rejected: …); chose
X because …". Reference [tech-stack.md](../tech-stack.md) for any pinned versions
instead of repeating them here.

## Consequences

### Positive

- Benefit 1
- Benefit 2

### Negative

- Cost or risk 1 — and how we plan to live with or mitigate it.
- Cost or risk 2
