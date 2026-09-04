# ADR-0094: A tool grant is checked when the plan is built

- **Status**: Accepted
- **Date**: 2026-09-02
- **Related**: [0029-tool-policy-hardening.md](0029-tool-policy-hardening.md) (**corrects** §(b)'s "Enforced by the parser" attribution), [0038-agentrunner-llm-call-boundary.md](0038-agentrunner-llm-call-boundary.md) (**corrects** its "parser-enforced" parenthetical), [0023-strict-authored-yaml-validation.md](0023-strict-authored-yaml-validation.md) (the ADR both of the above attribute the enforcement to), [0037-engine-tool-execution-boundary.md](0037-engine-tool-execution-boundary.md) (the dispatch check that stays), [../standards/security-review.md](../standards/security-review.md) (the **binding** security home, which states it as validator-enforced), [../roadmap/phases/phase-2.6.5-core-reliability-remediation.md](../roadmap/phases/phase-2.6.5-core-reliability-remediation.md) (`CR-64`)

## Context

A workflow agent-node's `tools:` may only **narrow** the agent's granted toolset, never widen it. Five
documents say this is enforced before a run — [ADR-0029](0029-tool-policy-hardening.md) §(b) ("Enforced by the
parser"), [ADR-0038](0038-agentrunner-llm-call-boundary.md) ("parser-enforced — a node listing a tool the
agent lacks fails validation"), both of them attributing it to
[ADR-0023](0023-strict-authored-yaml-validation.md), and — decisively —
[security-review.md](../standards/security-review.md), which is the **binding** home for the tool-policy rules
and calls it a "parse/validation error (validator-enforced)".

**None of that is true.** `resolveGrant` in the node executor is the only place a node's `tools:` is checked
against its agent's grant. Nothing in `parser.ts`, `dag.ts` or `run-plan.ts` reads `tools` at all.

**The security boundary itself holds.** A widening node is refused at dispatch and no ungranted tool ever
runs; ADR-0029(b)'s guarantee is intact. What is wrong is **where and when**, and it costs three things: a
widening workflow passes every pre-run check and looks correct in review; it fails partway through a run,
after upstream nodes have spent real money; and a canonical ADR *and the binding security standard* tell the
next reader the parser already caught it — which is how someone later removes the runtime check as redundant.

Two facts constrain the fix, and both were discovered rather than assumed:

- **An MCP-derived grant IS final at plan build on the only host that has one.** `relavium run` starts the
  inline agents' MCP servers, rewrites the workflow so each agent's grant includes its own servers' discovered
  tools, and only then calls `engine.start()` with the augmented workflow — the plan is built from a grant
  that is already complete. So the check is not structurally blind here; what it needs is for that ordering to
  be a stated obligation rather than an accident of one call site.
- **The `$ref` half has no live caller.** `BuildRunPlanOptions.agents` exists and is exported, and **no
  surface populates it** — not the CLI, not the engine's own call sites. External `$ref` agent resolution is
  unwired everywhere, so a load-time check for a `$ref`'d agent has nothing to check against today.

## Decision

**The narrowing is enforced where the plan is built, as a graph issue, for the agents the plan can see.**

1. **The check lives in `buildRunPlan` (`dag.ts`)**, as a new `GraphIssue` kind beside the existing
   `dangling_ref`. That is the layer that already resolves `agent_ref` and already reports authored-graph
   faults with node-named, typed errors, and it runs on every surface that builds a plan — before a run id
   exists and before any provider call.

2. **The grant must be COMPLETE before the plan is built, and that becomes a host obligation.** A host that
   declares MCP servers resolves them and augments the workflow first — which is exactly what `relavium run`
   already does. `BuildRunPlanOptions` carries the completeness signal explicitly rather than leaving it to
   call order: when a plan is built from a grant that is not known to be final, the check **does not run**
   and says so, so the absence of a refusal is never mistaken for proof of a narrow grant.

3. **The refusal is POSITIONAL and echoes no authored value.** `errors.ts` binds every `GraphIssue` field to
   "a *name* — a node id, an edge locator, or an `agent_ref` field — **never an authored value**", and an
   invalid edge handle is already reported positionally (`edge #n`) for exactly this reason. `node.tools` is
   validated only as a non-empty string: no charset, no length bound, so an authored tool id can carry a
   newline, a terminal control sequence, or secret-shaped text. The issue therefore locates the offence as
   `node <id>.tools[<index>]` and does **not** repeat the value. An earlier draft of this ADR mandated naming
   the tool in the message; that would have put an unbounded authored string into an event and a log line,
   against the contract the surrounding code already keeps. The same correction applies to the runtime
   `resolveGrant` message, which has the identical exposure today.

4. **The runtime check stays.** `resolveGrant` remains the last line of defence: a host can construct a node
   executor directly without ever building a plan, and the security boundary must not depend on a caller
   having gone through the front door. It stops being the *first* line, not the only one.

5. **The `$ref` half is scoped honestly.** The check covers an **inline** agent completely. For a `$ref`'d
   agent it activates when `BuildRunPlanOptions.agents` is populated — and the fact that **no surface
   populates it today** is recorded as an open residual, in the item and in
   [deferred-tasks.md](../roadmap/deferred-tasks.md), rather than implied to work by a checked box.

6. **All five documents are corrected, and the binding one first.**
   [security-review.md](../standards/security-review.md) is the security home and is corrected to say
   plan-build-enforced with the dispatch check as the floor; ADR-0029 and ADR-0038 each get a dated amendment
   note (ADRs are append-only — never a rewrite). `CR-64`'s own acceptance criterion named `relavium validate`,
   **a command that does not exist**; it is restated against `relavium run`'s pre-engine refusal.

*Considered:* **(a)** `validateWorkflowWithCatalog` — the `W5`/`CR-51` load-time home — rejected: that check
is about a *model's* capabilities and depends on a host-injected catalog port, whereas `tools` narrowing is
entirely inside the authored document; putting it there points the dependency the wrong way. **(b)**
`WorkflowSchema.superRefine` in `@relavium/shared` — rejected: it is the earliest point and needs no host, but
the inline-agent-to-node relationship is awkward to express in a Zod refinement and the `$ref` case is
unreachable from a schema, which cannot read another file. **(c)** leave it at dispatch and correct the five
documents — rejected: it is honest, but it keeps the cost (money spent before the refusal) that makes this a
`W6` item at all.

## Consequences

### Positive

- A widening workflow is refused before a run id exists, with an error naming the node, the tool and the
  agent — the acceptance `CR-64` asks for, on a command that actually exists.
- The binding security standard stops describing a control that is not in that place, which is the failure
  mode most likely to get the real control deleted as redundant.
- Defence in depth is now deliberate rather than accidental: one check where authors are, one where the
  executor is, each documented as such.

### Negative

- A workflow that widens a grant and previously failed mid-run now fails at load. Strictly better, and still
  a behaviour change on authored files in the wild.
- The check is inert for `$ref`'d agents until `planOptions.agents` is wired, and skipped entirely when a
  host builds a plan from a grant it has not declared complete. A conditional guarantee is harder to reason
  about than a total one — which is why the completeness signal is explicit in the options rather than
  implied by call order, and why the gap is written into this ADR and the residual list.
- Locating the offence positionally (`tools[2]`) rather than naming the tool costs the reader one lookup.
  Accepted: the alternative is an unbounded authored string in an event and a log, and the surrounding code
  already made this trade for edge handles.
- Two ADRs and one standard carry corrections for a claim that was never true. Recorded as amendments so the
  original reasoning stays legible, per the append-only rule.

## Amendment — 2026-09-03 (three corrections after implementation and two review rounds)

**1. Consequences/Positive ¶1 contradicted Decision §3 and is wrong.** It promised "an error naming the
node, **the tool** and the agent". §3 forbids exactly that, the Negative section says so again ("Locating the
offence positionally… rather than naming the tool"), and the code follows §3. Read ¶1 as: *naming the node,
the agent, and the POSITION of the offending entry — never the tool value.* The stale sentence survived a
draft correction; it is amended rather than rewritten, per the append-only rule, because a maintainer reading
¶1 as the acceptance could re-add the tool id and undo the security half of the change.

**2. `CR-64`'s acceptance text in the phase doc was never restated, though §6 claims it was.** It still named
`relavium validate` (a command that does not exist) and demanded the tool id. Restated with this amendment.

**3. The refusal also moved six PRE-EXISTING graph faults from exit 1 to exit 2.** Implementing this needed
an arm in the CLI's `toUserFacing` for `WorkflowParseError`, because a `WorkflowGraphError` reached the user
as "An unexpected internal error occurred." with exit 1 — for a file that could never run. The arm is on the
base class, so `cycle`, `unknown_edge_target`, `invalid_handle`, `mismatched_branch_target`, `dangling_ref`
and `ceiling_exceeded` now surface as `invalid_invocation` / exit 2 with their real message, on `run`,
`gate`, `chat` and `agent run`. That is a machine-contract change (ADR-0049's `--json` envelope keys on
`code`) on faults this ADR was not about, and it is a strict improvement — recorded here because it was not
in the original Decision.

**Known consequence, not resolved here: a PAUSED run can be stranded.** `resumeFromCheckpoint` rebuilds the
plan from the frozen snapshot, so a run that paused at a gate — with a widening node downstream that was
never dispatched — now fails at resume and cannot be edited into health, because the resume reads the
snapshot rather than the file. `agent-session.ts` records the opposite instinct for a session ("a RESUME does
not re-admit… admission governs what is ADMITTED"), but `buildRunPlan` already applies ADR-0086's ceilings on
resume the same way, so this is an engine-wide question rather than one this ADR may settle alone. Recorded
in [deferred-tasks.md](../roadmap/deferred-tasks.md); the dispatch-time `resolveGrant` floor is unaffected.
