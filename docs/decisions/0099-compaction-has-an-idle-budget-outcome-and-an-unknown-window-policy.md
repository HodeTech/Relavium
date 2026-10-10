# ADR-0099: Compaction has an idle budget outcome and an unknown-window policy

- **Status**: Accepted — maintainer approved 2026-10-02; implementation staged in `W7`
- **Date**: 2026-10-02
- **Related**: [ADR-0062](0062-context-compaction-and-cli-history-commands.md) · [ADR-0095](0095-what-an-agent-session-remembers-across-turns.md) · [ADR-0096](0096-a-request-is-measured-before-it-is-sent.md) · [architectural principles](../standards/architectural-principles.md)
- **Scope**: `W7`'s `CR-72` and `CR-98`; replaces ADR-0096 §3 invariant 4's unconditional unknown-window guarantee, qualifies §2 invariant 2 for summariser requests to cover every attemptable fallback window, and clarifies idle compaction's budget outcome in ADR-0062, ADR-0095 and ADR-0096. Main-turn measurement still uses the first entry the chain will actually attempt. All other decisions stand.

> Amended 2026-10-02 — [ADR-0101](0101-configured-output-estimates-apply-only-when-the-wire-is-uncapped.md),
> accepted by the maintainer, refines the shared output-reservation rules consumed by every pass:
> the summariser's authored 4,096 cap takes precedence over configured uncapped estimates, with
> the prepared plan handed to each measured candidate. A replacement repeats dependent measurement
> before egress; it cannot use a stale fit or install a partial summary. Known/mixed-window bounds,
> manual best effort and idle-versus-active budget/trim outcomes remain this ADR's decisions.
> Implementation is staged in W7. The historical body remains unchanged.

## Context

The `W7` pre-implementation review of 2026-10-02 found two gaps that would otherwise become silent implementation decisions.

[ADR-0062](0062-context-compaction-and-cli-history-commands.md) §5 explicitly allows manual compaction for an unknown or custom model because it needs no window. [ADR-0096](0096-a-request-is-measured-before-it-is-sent.md) §3 invariant 4 requires every summariser request, including manual compaction, to fit its window. Its amendment skips automatic compaction for a custom endpoint, but gives no manual rule for an unknown window. An absent or unauthoritative window cannot support a fit guarantee.

ADR-0062's 2026-09-18 amendment also says a summariser budget refusal ends the turn `budget_exceeded`; ADR-0095's same-date "permission, not funding" note repeats it. Pre-send and overflow recovery run inside an active turn, where this is coherent. After-turn compaction runs after the successful `session:turn_completed` has already been emitted; manual compaction has no active turn at all. Neither can produce another turn terminal without violating the session lifecycle. The shipped after-turn fallback currently trims on a budget refusal, contrary to the amendment's no-trim rule.

The canonical lifecycle and event shapes remain in [agent-session-spec.md](../reference/contracts/agent-session-spec.md) and [sse-event-schema.md](../reference/contracts/sse-event-schema.md). This ADR decides the outcomes, rather than duplicating their schemas.

## Decision

**We preserve manual compaction for an unknown window as bounded best effort, and keep idle compaction's budget outcome separate from an already-completed turn.**

### Unknown-window manual compaction

- An unknown window includes a custom endpoint reusing a catalog model id and a provider whose window lookup is absent, throws, or returns an invalid value. A catalog window is not authoritative for a custom endpoint.
- Manual compaction remains available when the authored `memory` policy permits it. Before egress, the surface discloses that the window is unknown and the request's fit cannot be guaranteed.
- Each pass uses a fixed soft **input** budget of **16,384 estimated tokens**, including the summariser's system text, its rendered history and any running summary. This maintainer-approved choice is four times the existing 4,096-token summary output cap: it gives a finite input envelope larger than one running summary without claiming evidence about an unknown provider's capacity. It is an operational bound, never model metadata or a claimed context window. Output remains separately capped by ADR-0096's shared output-reservation rules.
- The fold makes at most four passes, each budget-gated and accounted, with all-or-nothing installation. A single oversized message uses ADR-0096's disclosed head-and-tail truncation. Unprocessed history at the four-pass limit is a compaction failure; it is never silently omitted from an installed summary.
- Failure, overflow, cancellation or budget refusal preserves the working history and installs no boundary marker. The spend of attempts that actually ran remains accounted.
- No automatic compaction or automatic overflow recovery uses this soft budget. The footer does not treat it as a context window.

For known, authoritative windows, each constructed summariser request is measured against every attemptable fallback entry's window and output reservation before it can egress. If a fallback's window is unknown, automatic compaction cannot claim a fit guarantee and is skipped; a manual operation follows the disclosed best-effort rule. A mixed known/unknown manual chain satisfies both the soft input budget and every known entry's input-plus-output bound; the unknown entry never relaxes a known bound. An unavailable, throwing or invalid request estimator fails the operation before egress rather than admitting an unmeasured request. This is a guarantee about the **heuristic construction**, not a claim that the heuristic bounds actual provider tokenisation; ADR-0096 §1's limitation remains explicit.

Considered refusing manual compaction for unknown models: it would remove an existing remedy without supplying authoritative metadata. Considered an unbounded manual request: it keeps the command but defeats the reliability work. The proposed soft input budget bounds each request and preserves the existing explicit user operation. A new authored/configurable window override is not introduced.

### Budget refusal during idle compaction

- Pre-send and overflow-recovery refusal keep ADR-0096's rule: preserve history, send no main request/retry, and settle the active turn once with `budget_exceeded`.
- After-turn refusal preserves the turn's already-emitted successful terminal and its persisted text/structure. It leaves history intact, performs no trim, and surfaces the compaction budget refusal separately. `sendMessage` does not reject an otherwise-successful turn because this optional after-turn operation was refused.
- Manual refusal returns a typed, policy-independent budget outcome and a safe cap message. It creates no turn terminal and performs no trim.
- If the first pass is refused before admission, no `session:compacting` opens. The caller still receives/displays the typed budget outcome. If a later pass is refused, exactly one `session:compaction_failed` with `budget_exceeded` closes the open compaction moment. The CLI handles both paths, so neither a notice nor an indicator depends on a nonexistent event.
- The internal after-turn caller emits a standalone **`session:compaction_budget_refused` side notice** for a first-pass refusal. It carries the compaction reason and safe budget outcome, opens/closes no compaction moment, creates no turn terminal or persisted boundary, and is rendered by the session surfaces, including the CLI JSON stream. A later-pass refusal uses the existing failed-moment terminal instead, without a duplicate notice. Manual first-pass refusal is returned by `compact()` and rendered by its caller. The canonical event/result schemas are defined alongside implementation in the contracts linked above.
- Ordinary after-turn summariser failure retains ADR-0062's deterministic trim fallback where configured and permitted by `memory`; budget refusal is excluded from that fallback.

Considered changing a completed turn to failure or emitting a second turn terminal: the result already rendered and persisted, and both choices corrupt its lifecycle. Considered trimming on budget refusal: it changes context for a financial refusal rather than a summariser fault. The proposed separate outcome reports the actionable cause and preserves the completed work.

### Acceptance and landing

- Unknown/custom manual compaction discloses the limitation, measures every request within the soft input budget, makes at most four passes, and accounts every engaged attempt. Automatic paths make no summariser call and the footer claims no window.
- A known-window primary failing over to a smaller-window model sends no summariser request above that entry's measured input-plus-output bound.
- A mixed known/unknown manual chain respects its smallest known measured bound and the soft input budget, discloses the unknown entry, and cannot trigger automatic compaction. Estimator refusal preserves history and sends nothing.
- More than four windows of individually fitting messages fails without installing a partial summary; history is unchanged, completed passes remain billed, and an opened moment has one terminal.
- Budget refusal on pass 1 and separately on a later pass is tested for manual, after-turn, pre-send and recovery entry points. After-turn has one successful turn terminal, no trim and a visible budget notice; manual has no turn terminal; active-turn paths have one `budget_exceeded` terminal.
- All paths remain usable for the next permitted operation; abort and terminal cancel keep their existing precedence.

After approval, add dated forward notes to ADR-0062, ADR-0095 and ADR-0096 without rewriting their historical bodies. Each idle-versus-active budget note distinguishes these outcomes; ADR-0095's "permission, not funding" rule still refuses unfunded summarisation and forbids budget fallback trim. ADR-0096's note also covers both §2 invariant 2's summariser-specific qualification and §3 invariant 4's unknown-window limitation; it leaves main-turn measurement unchanged. Update the canonical session/event contracts, [chat-session.md](../reference/cli/chat-session.md) and `W7`'s acceptance/checklist alongside implementation. Record the unknown-window limitation as this command's contract, not as deferred implementation.

## Consequences

### Positive

- Idle compaction cannot overwrite a successful turn or invent another terminal.
- A budget refusal preserves context at every entry point and remains visible.
- Manual compaction remains available on custom providers with a disclosed, finite construction.

### Negative

- Unknown-window manual compaction can still overflow; its typed outcome states that limitation and preserves history. Choosing a model with an authoritative window provides the measured-fit path.
- A long unknown-window history can exceed the four-pass capacity; the operation fails explicitly rather than installing an incomplete summary.
- The heuristic can under-count even with a known window. Provider classification and the bounded failure/recovery rules remain necessary.

## W7 Step 8 implementation — 2026-10-10

The approved measured compaction/recovery and idle budget policies are implemented on
`development`, pending independent implementation acceptance and final whole-wave validation.
The [session contract](../reference/contracts/agent-session-spec.md#measured-compaction-and-one-shot-recovery)
and [event contract](../reference/contracts/sse-event-schema.md#session-event-namespace) own the
current mechanics and shapes: all-candidate measured bounds, four-pass atomic installation,
acknowledged unknown-window disclosure, balanced moments and distinct idle/active budget outcomes.
No accepted policy is superseded; this dated landing note leaves the historical body intact.
