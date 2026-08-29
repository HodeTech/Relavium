# ADR-0086: Authored values get absolute admission ceilings, and an omitted concurrency cap is finite

- **Status**: Accepted
- **Date**: 2026-08-28
- **Decides**: `CR-31` of [Phase 2.6.5](../roadmap/phases/phase-2.6.5-core-reliability-remediation.md) (`W3`)
- **Supersedes, on one clause**: [ADR-0040](0040-node-retry-budget-above-the-chain.md) — its "`max` itself is
  **intentionally unbounded**" sentence and the reasoning that the backoff cap alone is the guardrail. The rest
  of ADR-0040 stands unchanged and its Status stays **Accepted**; see [§8](#8-why-adr-0040-is-superseded-on-one-clause-and-not-as-a-whole).
- **Amends (a refinement, not a reversal)**: [ADR-0028](0028-workflow-resource-governance.md) — its
  concurrency-cap bullet says the cap is "configurable" and never says what an OMITTED value means. §3 below
  answers that and §2 gives the field a roof. Neither reverses "configurable", so ADR-0028 keeps its Status
  and gains a dated amendment note; the distinction from ADR-0040 is the whole reason both are listed.
- **Implementation**: staged for `W3` of Phase 2.6.5 and landing in the same PR as this ADR. "Accepted" here
  means the decision is settled, not that the ceilings are enforced in a shipped build — until the `W3` commits
  land, the code still admits everything §2 forbids.
- **Related**: [ADR-0023](0023-strict-authored-yaml-validation.md) (reject loudly, never silently drop) ·
  [ADR-0036](0036-run-loop-substrate-event-bus-and-execution-host.md) (the run loop that honours the cap) ·
  [workflow-yaml-spec.md](../reference/contracts/workflow-yaml-spec.md) (the public API this constrains) ·
  [run-plan.md](../reference/shared-core/run-plan.md) (where admission faults are raised) ·
  [architectural-principles.md](../standards/architectural-principles.md)

## Context

The engine admits any authored graph that parses. The only admission limit is a 2 MiB source-text ceiling
(`MAX_SOURCE_CHARS`), and a 2 MiB YAML file holds tens of thousands of small nodes. Nothing bounds the node
count, the edge count, a node's fan-out width, a fallback chain's length, the retry budget, the number of
parallel tool calls, or the total attempts a run may make. An omitted `max_parallel` means `Infinity`.

Three of these are not merely unbounded by omission — [ADR-0040](0040-node-retry-budget-above-the-chain.md)
decided they should be:

> `max` itself is **intentionally unbounded** (`positiveInt`, consistent with `max_attempts` / `window_size` /
> `max_parallel` — author-controlled, git-committed, code-reviewed config): the backoff cap, not a `max`
> ceiling, is the guardrail against an absurd budget.

That reasoning is sound about the thing it was reasoning about, and insufficient for the thing this ADR is
about. **The backoff cap bounds how long one node waits between attempts. It does not bound how much work the
run does.** A node with `retry: { max: 100000, backoff_ms: 1 }` is schema-valid today: every attempt is a real
provider call that costs real money, may fire a real external effect, and holds its `max_parallel` slot for the
whole budget. Clamping each *delay* at 24 h does nothing to that; it arguably makes it worse, because a small
`backoff_ms` keeps every attempt cheap in time and expensive in everything else.

"Author-controlled, git-committed, code-reviewed" is also doing more work in that sentence than it can carry.
It is a good argument that an author may choose an *unusual* value. It is not an argument that the engine
should have no opinion about an *impossible* one — a run cannot survive an authored value that exhausts memory
before it produces a single event, and no amount of code review makes the engine's behaviour there defined.

## Decision

**The authored values `CR-31` enumerates — the ones that AMPLIFY into repeated work, concurrent work or graph
size — get absolute ceilings, enforced at admission; and an omitted concurrency cap resolves to a finite
default.**

The scope is that enumeration and no wider. Other authored numbers that consume resources — `memory.window_size`,
`max_tokens`, the media `count` / `duration_seconds` knobs — are deliberately **not** covered here: each is
bounded by something else already (a context window, a provider ceiling, a per-modality cost class under
[ADR-0044](0044-media-access-governance-read-media-save-to-cost.md)), and none multiplies the way a retry
budget times a chain length times a fan-out does. A later ADR may reach them; this one does not, and a reader
should not infer a general rule from a list of eight.

### 1. Ceilings are enforced at ADMISSION, and exceeding one is a rejection — never a clamp

A value above its ceiling fails the parse/compile step with a typed, field-named, secret-free fault, batched
with every other admission fault the way [run-plan.md](../reference/shared-core/run-plan.md) already raises
them. The run never starts.

Considered **silently clamping** an over-ceiling value to the ceiling (rejected: it contradicts
[ADR-0023](0023-strict-authored-yaml-validation.md), which is the decision that a committed workflow file
never runs as something other than what it says — a clamp is exactly the silent narrowing that ADR forbids,
and an author who wrote `max_parallel: 200` and got 8 would debug the wrong thing). Considered **a runtime
cap** with no admission check (rejected: the failure then arrives mid-run, after money has been spent, instead
of before the run starts — and the phase's own framing for these items is *fail closed at admission*).

The phase document's wording for `CR-31` was "an authored value may only narrow", which describes a clamp.
That wording is superseded here for the reason above; the intent — an author cannot raise the engine past its
own limits — is preserved by rejecting instead.

### 2. The ceilings

| What | Ceiling | Why this one |
|---|---|---|
| Nodes per workflow | **500** | An order of magnitude above the largest workflow the spec's own examples reach; a graph past this is a program, and Relavium's answer to a program is a sub-workflow. |
| Edges per workflow | **2000** | Four per node at the ceiling — comfortably above any fan-in/fan-out shape, and the number that stops a dense-graph blow-up in the compile step. |
| Fan-out width (a node's out-degree) | **50** | The width that becomes concurrent work in one step. Above this the run is bounded by `max_parallel` anyway, so the extra width buys nothing but scheduling cost. |
| Fallback chain length (entries) | **5** | A chain is a degradation ladder. Past five the tail entries are models nobody has reasoned about, and each is a full attempt budget. |
| `retry.max` | **10** | Ten attempts is already a bad day for one node. This is the clause that supersedes ADR-0040. |
| `max_attempts` per chain entry | **10** | Same reasoning, one layer down; the two multiply, so both need a ceiling or neither does. |
| Tool calls in ONE model response | **16** | The only ceiling here the AUTHOR does not choose — the model does. See the note below; it is not a concurrency limit. |
| `max_parallel` | **64** | The absolute ceiling, distinct from the default below. High enough that a deliberate wide run is still expressible. |

These are ceilings, not recommendations. Nothing about a workflow becomes better by approaching one.

**Two things about that table that a first draft got wrong, corrected here rather than discovered later.**

*The tool-call row is not about parallelism.* An earlier version of this ADR called it "parallel tool calls in
one turn", which describes something the engine does not do: `agent-turn.ts` dispatches a response's tool calls
in a `for` loop with an `await` inside, strictly sequentially, because each one takes the next effect-journal
slot ([ADR-0080](0080-durable-effect-journal-and-the-tiered-effect-contract.md)). What it bounds is the COUNT
of tool calls in a single model response, and it is enforced **before the first dispatch**, so a response over
the ceiling fires no effects at all. Checking it per-call would leave the first sixteen already executed —
which for tier-3 effects is exactly the duplicate the journal exists to prevent. It is also the one ceiling
whose subject is a provider response rather than an authored file, so it cannot live at admission; it is a
turn-level check.

*The graph ceilings count the AUTHORED file, not the compiled plan.* The authored file is what the ceiling is
a statement about — an author can act on "you wrote 600 nodes" and cannot act on a number that only exists
after a compile step they never see. It also makes the check cheap and order-independent: it runs before the
graph is built, so a file over the ceiling never reaches the compiler.

**"Authored" means everywhere the author wrote an edge, not only `edges[]`** — a distinction the first
implementation of this ADR got wrong, and which is recorded here because getting it wrong made the ceiling
bypassable rather than merely inaccurate. A `parallel` node's `parallel_of` members become one fan-out edge
each inside the builder, with no `edges[]` entry; counting only `edges[]` therefore saw a 200-member split as
a width of ZERO, and 500 parallel nodes of 500 members as an edge count of zero. Measured: a 200-member split
built a plan against a fan-out ceiling of 50. Members count toward both the fan-out and the edge ceiling.

A `condition`'s `branches` are **excluded** from fan-out, and the asymmetry is the decision: branches are
routing ALTERNATIVES — exactly one is taken — so counting them as concurrent width would reject a wide
`switch` that never runs more than one target. `parallel_of` members all run, concurrently, which is precisely
the shape a fan-out ceiling is for.

### 3. An omitted `max_parallel` is **8**, and the number is a fixed constant

Omitting the field currently means `Infinity`, which is the least defensible default a concurrency knob can
have: it is the only value at which the engine's behaviour depends entirely on the graph's width.

The default is **8** and it is **the same 8 on every machine**. Considered **deriving it from host capacity**
(rejected, and this is the constraint that decides it):
[workflow-yaml-spec.md](../reference/contracts/workflow-yaml-spec.md) states that the same file "parses and
runs **identically** on every surface", and a CPU-derived default breaks that guarantee — the same committed
workflow would run 4-wide on a laptop and 32-wide on a build server, with different cost, different rate-limit
behaviour and different failure modes. `packages/core` also cannot read a CPU count without breaking its
zero-platform-import rule, so "capacity-derived" would have meant a host seam whose only effect is to make a
public-API guarantee conditional. `CR-31`'s own text said "capacity-derived"; that phrase was written without
checking the spec guarantee it contradicts, and is superseded here.

An author who wants more says so, up to the ceiling in §2.

### 4. Total node dispatches per run: **500**, enforced at runtime, counted from the durable log

Unlike the rest, this one cannot be checked at admission — it is a property of what a run *does*, not of what
it *says*. It is the backstop for the multiplication the individual ceilings still permit (a 500-node graph
whose nodes each retry 10 times is 5000 attempts), and it fails the run with a typed error rather than a
clamp, for the same reason as §1.

**The unit is one `node:started` event, and that choice is load-bearing.**
[ADR-0040](0040-node-retry-budget-above-the-chain.md) defines **two** `attemptNumber` families that
"do **not** join", and ADR-0080's amendment to it records that `retryCount` "resets to 1 on a crash-resume and
again on a budget approval" — so neither in-memory counter can answer "how much has this run done". A durable
event can. Every attempt emits exactly one `node:started` (the first from `#step`, each re-dispatch from the
retry loop), the event is persisted before delivery, and `reconstructCheckpointState` already replays the log
in order — so the count is a fold over events the checkpoint fold already walks. **It therefore survives a
crash-resume, a budget approval and a cross-process handover**, which is the property the in-memory counters
lack and the whole reason this cap needs its own definition rather than reusing one of theirs.

Considered counting **provider calls** instead (rejected: they are not durable events, so a resume would
restart the count — the exact defect above) and counting **`node:retrying`** (rejected: it misses first
attempts, so a 500-node graph with no retries would count zero).

**The error code is `turn_limit`, and the taxonomy is not widened.** `sse-event-schema.md` describes
`turn_limit` as "the limit-family code for a **hard** agent/session turn/round cap", classified fatal, and
records ADR-0082 §9's rule that "a closed taxonomy every surface switches on should not gain a member for a
distinction the `nodeId` already carries". A run-level dispatch cap is the same family; a new member would buy
a surface nothing it cannot read from the message.

### 5. What this ADR does **not** change

ADR-0040's mechanism is untouched: the retry budget still sits above the chain, the backoff strategies are
unchanged, the 24 h `MAX_NODE_RETRY_BACKOFF_MS` clamp stays (it solves a different problem — integer overflow
and absurd single timers — and remains the right guardrail for *delay*), and the set of node types that carry
`retry` is unchanged. `max_parallel` remains an author-facing cost/rate-limit knob exactly as
[ADR-0028](0028-workflow-resource-governance.md) describes; it simply now has a floor of meaning when omitted
and a roof when supplied.

### 6. Both entry points check, through one validator

`relavium agent run` and `relavium chat` never build a workflow graph — they hand an `AgentDefinition`
straight to `AgentSession`, which consumes `fallback_chain` and `max_attempts` directly. Putting the ceilings
only in the workflow compiler would therefore have shipped them on one of the two first-class entry points
([ADR-0024](0024-agent-first-entry-point-agentsession.md) makes the session co-equal), and the agent-scoped
ceilings — `retry.max`, `max_attempts`, chain length — are exactly the ones that path uses.

So the agent-scoped checks live in **one exported validator over an `AgentDefinition`**, called by the
workflow compiler for every resolved agent AND by the session entry point before its first turn. The
workflow-scoped checks (node count, edge count, fan-out, `max_parallel`) stay in the compiler, because a
session has no graph for them to be about.

One function, two callers, is the point: two copies of eight numbers is how the two surfaces drift, and a
drift here means the same agent file is admitted by `chat` and rejected by a workflow that references it.

### 7. These are engine limits, not schema limits

The ceilings are enforced in the compile/admission step, not as Zod `.max()` refinements on the authored
schema. Two reasons. A `.max()` on `positiveInt` would change the shape of `WorkflowSchema` — a public API —
where an admission check does not, and the same schema is reused for partial/streaming authoring surfaces
where a ceiling that applies to a *whole workflow* is not meaningful. And the fan-out, edge-count and
total-attempt limits are properties of the compiled graph, not of any single field, so they have no schema
expression at all; putting half the ceilings in the schema and half in the compiler is how the two drift.

### 8. Why ADR-0040 is superseded on one clause and not as a whole

A partial supersede is the corpus's **established** pattern, not a new one, and an earlier draft of this ADR
claimed otherwise — it cited only the two whole-ADR supersedes ([0004→0011](0004-vercel-ai-sdk-multi-llm.md),
[0021→0067](0021-node-sqlite-driver-better-sqlite3.md)) and concluded it was setting a precedent. It was not.
[ADR-0072](0072-model-metadata-in-the-db-behind-a-generated-offline-floor.md) declares
`**Supersedes (partial)**` over ADR-0064 §4's prohibition, and
[ADR-0081](0081-the-compaction-summary-is-untrusted-and-the-system-prompt-is-branded.md) supersedes ADR-0062
§1 — in its **title** — while spelling out which of ADR-0062's parts stand. Both superseded ADRs keep
`Status: Accepted`. This ADR follows that pattern; it does not invent it. (The error is left recorded rather
than quietly fixed, because an ADR that cites the corpus incorrectly is worth one sentence of warning to the
next author who cites it back.)

ADR-0040 is the same case those two are: its decision — a retry budget above the chain — is correct and
shipped, and marking it wholly Superseded would tell every future reader that the design is dead when only
one sentence of its rationale is. It keeps `Status: Accepted` and gains a dated forward-pointing note on the
superseded clause. A pointer is not a rewrite, which is what
[documentation-style.md](../standards/documentation-style.md) §7 permits in place; the reversal itself lives
here, where it can be argued against.

### 9. The transition for files that are valid today

[workflow-yaml-spec.md](../reference/contracts/workflow-yaml-spec.md) requires a migration path for a breaking
change to the schema. **The schema is not changing** — §7 keeps these out of `WorkflowSchema` — but a file
that parses today can stop *running*, and that deserves the same seriousness rather than a technicality.

The transition, stated rather than assumed:

1. **Nothing is silently reinterpreted.** Every ceiling breach is a loud admission failure naming the field,
   the authored value and the ceiling, so the edit is mechanical. The one behaviour change without an error —
   an omitted `max_parallel` becoming 8 — changes a run's *speed*, never its outputs.
2. **No `schema_version` bump.** A version bump is the migration anchor for a change that alters what a file
   *means*; these change what the engine *admits*. Bumping would invalidate every file in the ecosystem to
   describe a limit that eight of them will ever meet.
3. **Ceilings are raisable without editing engine source.** They resolve from named constants that a host may
   override, so an operator with a legitimate outlier has a documented lever and does not fork the engine.
   Lowering one is not offered: a ceiling that a host can tighten silently is a ceiling no author can rely on.
4. **The specs say the numbers.** `workflow-yaml-spec.md`, `agent-yaml-spec.md`, `run-plan.md` and
   `sse-event-schema.md` carry them, so a reader learns the limit from the contract rather than from a
   rejection.

## Consequences

### Positive

- The engine's resource behaviour is now defined for every authored input, not merely for the reasonable ones.
- The failure is at admission, before money is spent, and it names the field and the ceiling — an author can
  act on it without reading engine source.
- A concurrency default that no longer depends on graph width makes a run's cost predictable from the file.
- The identical-on-every-surface guarantee survives, which a capacity-derived default would have ended.

### Negative

- **A previously-valid workflow can now fail to parse.** The format is a public API and this is a behaviour
  change within `'1.0'`. Accepted because the affected values are ones no working workflow holds — the
  ceilings sit an order of magnitude above real usage — and because the alternative is an engine with no
  defined behaviour at the extremes. Mitigated by the error naming the field, the value and the ceiling.
- **A workflow that omitted `max_parallel` and relied on unbounded width now runs 8-wide** and takes longer.
  Accepted: unbounded was never a considered choice, it was the absence of one. Mitigated by the field being
  authorable up to 64.
- **Eight ceilings are eight numbers that will eventually be wrong.** Accepted rather than pretending
  otherwise: they live as named constants in one place, and moving one upward is not a breaking change.
- ADR-0040 now requires two files to read. Accepted for the reason in §8 — the alternative misrepresents a
  shipped design as dead.
