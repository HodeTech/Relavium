# ADR-0081: The compaction summary is untrusted content, and the system prompt becomes a branded type (supersedes ADR-0062 §1)

- **Status**: Accepted
- **Date**: 2026-08-18
- **Related**:
  - [ADR-0062](0062-context-compaction-and-cli-history-commands.md) — **§1 superseded here**, and §3's *placement* of the restored value with it. Its durable half is untouched: §2's append-only marker row, §3's producer/consumer split, and the `/clear` · `/trim` · `/compact` command surface all stand exactly as written. What changes is where a restored summary is PUT on the next turn, and what it is called.
  - [ADR-0059](0059-cli-mid-session-model-reseat.md) — the reseat that must carry the summary. **Amended here**: what it carries stops being a system-prompt preamble.
  - [ADR-0024](0024-agent-first-entry-point-agentsession.md) — the session engine. **Cited, not amended**: it says nothing about system-prompt authority.
  - [ADR-0011](0011-internal-llm-abstraction.md) + [ADR-0030](0030-llm-seam-shape-amendment-reasoning-response-format-provider-executed.md) — the seam. **Cited, not amended**: `LlmRequest.system` stays `z.string().optional()`; no seam shape changes.
  - [docs/standards/security-review.md](../standards/security-review.md) — the binding rule this restores.
  - [chat-session.md](../reference/cli/chat-session.md) § Context compaction — the canonical home for what compaction does to a session, updated alongside. [llm-provider-seam.md](../reference/shared-core/llm-provider-seam.md) is cited, not changed: the seam shape is untouched.
- **Closes**: **Decides** `CR-13` of [phase 2.6.5](../roadmap/phases/phase-2.6.5-core-reliability-remediation.md). Accepted 2026-08-18 with the maintainer's review folded in (the constructor's engine arm, the summary's taint lifecycle, the narrowed enforcement claim, and §3's normative projection all come from it). The §7 obligations land with the implementation, not after it.

## Context

[ADR-0062](0062-context-compaction-and-cli-history-commands.md) §1 decided that a compacted
session carries its summary as a **system-prompt preamble**:

```
system = agent.system_prompt + "\n\n<earlier-conversation-summary>\n" + preamble + "\n</earlier-conversation-summary>"
```

That summary is **model output over untrusted input**. The conversation handed to the
summarizer contains user messages, tool results, and the contents of any document the
session read. The summarizer returns a plain string, and that string is concatenated into
the `system` role — the one role the engine treats as authored, trusted instruction.

The attack needs no cleverness. A read document or a user message contains a closing
`</earlier-conversation-summary>` followed by instructions. The summarizer, doing its job,
preserves them. On the next tool-capable turn those bytes sit in `system`, and because the
summary is persisted they survive a restart and a model reseat. **An XML fence is not a
trust boundary** — it is a formatting convention that the untrusted text can close.

This directly contradicts [security-review.md](../standards/security-review.md), which
treats model output and tool results as untrusted and forbids concatenating untrusted
content into `system`. ADR-0062 §1 is Accepted, so this is a superseding decision, not a
patch.

**ADR-0062 §1's rejection of the alternative must be answered, not ignored.** It rejected
injecting the summary as a transcript message because *"a summary message either forces an
`assistant`-first array Anthropic rejects, or sits next to the next real `user` turn as two
consecutive user messages"*. Verified against the tree:

- The **two-consecutive-user-messages half was already false when it was written.**
  `packages/llm/src/adapters/anthropic.ts`'s `mergeAdjacentSameRole` folds consecutive
  same-role messages into one with concatenated content blocks, and its docblock says it
  exists so "adjacent user messages the API would 400" are fixed at the seam. `git log -S`
  dates it to `1abd68c5`, **2026-06-14 — three weeks before ADR-0062**.
- The **`assistant`-first half is still genuine.** A design that puts the summary in its own
  leading message must not produce an `assistant`-first array.

One guarantee must **not** be overclaimed. The OpenAI adapter joins content parts on the
wire (`parts.map(...).join('')`), so "the bytes arrive as a separate part" is false there.
The guarantee available on every adapter is the **role boundary** plus an explicit in-band
separator — never a wire-level part boundary.

## Decision

**We will carry the compaction summary as untrusted content inside the first user-role
turn, and make `system` a branded type that only the authored-prompt builder can
construct** — so the compiler, not a convention, enforces the boundary.

### 1. `AuthoredSystemPrompt` — a branded string with a CLOSED set of constructors

`AgentTurnParams.system` and the session's system builder stop accepting `string`. They accept
`AuthoredSystemPrompt`, a branded type produced only by a closed-arm constructor:

```
authoredSystemPrompt({ kind: 'agent', agent, node? })   // agent.system_prompt + node.system_prompt_append
authoredSystemPrompt({ kind: 'engine', prompt: 'compaction' })
```

**The second arm is not an escape hatch and takes no arbitrary string.** It takes a closed union of
engine-owned prompt IDENTITIES and returns the corresponding engine-owned constant. It exists because the
engine genuinely has a third authored producer, and a draft of this ADR missed it: `COMPACTION_SYSTEM_PROMPT`
(`packages/core/src/engine/agent-session.ts`) is passed as `system` on the summariser call. Without the arm,
that call site would have to reach for an `as`, fabricate an `Agent`, or add the very second constructor the
rule forbids — so the honest design names the producer rather than pretending there are two.

Considered: a runtime assertion that the assembled `system` contains no summary bytes (rejected — it is a
scan for a payload whose shape we already know, and it fails open on any encoding the scan misses); a naming
convention plus a review checklist (rejected — that is exactly what was in force when ADR-0062 §1 shipped);
and a `readonly` wrapper object (rejected — it changes the seam shape for no additional guarantee, since a
brand is erased where the string is finally read).

The brand is a compile-time device with **zero runtime cost and zero seam impact**: `LlmRequest.system`
remains `z.string().optional()`, and the branded value is a string. What changes is that a dynamic string
can no longer reach the field through ordinary typed code.

**What the brand does and does not buy, stated precisely.** A brand is nominal to the type-checker but not
to a deliberate `as` — `dynamicString as AuthoredSystemPrompt` compiles, and a draft of this ADR wrongly
claimed the repo's lint rules stop it. They do not: `eslint.config.mjs` bans `any` and restricts seam
imports, and has no assertion ban. So the mechanism ships WITH its fence: `no-restricted-syntax` selectors
in the same slot as the existing seam and machine-output fences, covering a `TSAsExpression` or
`TSTypeAssertion` naming `AuthoredSystemPrompt`; a type-ALIAS declaration naming it, because a name-based
selector is otherwise defeated by one hop of indirection; and a type PREDICATE naming it, which needs no
assertion at all — `value is AuthoredSystemPrompt` narrows a plain string into the brand, type-checks
cleanly, and reads exactly like the legitimate `isBilledModality` guard already in `agent-runner.ts`. That
last one was the most important to close precisely because it is the most legible: the other forms keep the
brand's name beside an assertion, where a reviewer scanning for `as AuthoredSystemPrompt` has a chance.

**What the fence does not catch, stated rather than left to be found.** A generic cast helper
(`function id<T>(v: unknown): T { return v as T }`, called as `id<AuthoredSystemPrompt>(x)`) launders any
brand, as does an interface field typed as the brand plus an object assertion. Both were verified against
the shipped config. Neither is reachable by accident: each requires writing a construct whose only purpose
is to defeat the type, and TypeScript offers no defence against `as` short of a runtime wrapper — which §1
rejects for changing the seam shape. The claim is therefore exactly: **ordinary typed code cannot reach
`system` with a dynamic string, and a deliberate forgery is visible.** Not "impossible".

The type and its constructors live in `packages/core` beside the message assembly that consumes them, not in
`packages/shared` — exporting the constructor from the shared barrel would widen the surface that can mint
one to every package and surface, for a contract that has exactly two consumers, both in the engine.

### 2. The summary is `Untrusted<string>` from the moment it exists

A brand on the `system` SINK narrows the documented attack. It does not make the summary itself untrusted,
and the binding standard ([security-review.md](../standards/security-review.md)) asks for the content to
carry its provenance, not merely for one sink to be guarded. So:

- the in-memory summary field is `Untrusted<string>`, using the existing `packages/core/src/tools/untrusted.ts`
  primitive — **no new security primitive**;
- the summariser's result is `markUntrusted(...)` at the moment it is read off the model;
- persistence stores the raw string (the durable row shape does not change), and the RECONSTRUCTION boundary
  re-marks it — a value that comes back off disk has not become trustworthy by being stored;
- exactly **two** places unwrap it, and both are `user`-role positions: the request-assembly helper in §3
  (`buildTurnMessages`), and `renderConversationToSummarise`, which folds a prior summary into the next
  summarisation call. A draft of this section said "exactly one place" and was wrong about its own audit
  surface — the second site is equally load-bearing, and an auditor who grepped only the first would have
  missed it.

  **That count is a discipline, not a structural bound, and the asymmetry with §1 is deliberate.**
  `Untrusted<T>.value` is an ordinary readable property; `unwrapUntrusted()` is sugar for reading it, and
  nothing stops a future call site from reading `.value` directly — neither a grep for `unwrapUntrusted` nor
  any lint rule would surface it. The `AuthoredSystemPrompt` SINK is fenced (§1); the untrusted CARRIER is
  not, because that fence would need type information a syntactic selector does not have, and because the
  primitive is pre-existing (1.T) and this ADR deliberately introduces no new security primitive. The two
  halves carry different strengths, and saying so is worth more than a count that reads stronger than it is:
  the sink is enforced, the carrier is conventional.

The persisted marker row's `role: 'system'` (ADR-0062 §2) is a **storage encoding and nothing more**. No
consumer may read it as LLM system authority. That sentence is the one this ADR most needs on the record,
because the row's role name is precisely what would invite the defect back.

The field is renamed from `#contextPreamble` to `#compactionSummary`. "Preamble" names the thing this ADR
removes, and a name that describes the old placement is how the next reader reintroduces it.

### 3. One pure projection assembles the turn, and it never mutates the transcript

```
buildTurnMessages(
  summary: Untrusted<string> | undefined,
  messages: readonly LlmMessage[],
): LlmMessage[]
```

The rules are normative, because the alternatives are real bugs rather than style:

- **The join happens at REQUEST ASSEMBLY, never in `#messages` and never in the durable transcript.**
  Mutating `#messages` would make the summary part of the real conversation: the next compaction would fold
  it a second time (once as the standing summary, once embedded in the first user message), the persister
  would write it as user text, and every turn would re-prefix it.
- **The helper is pure.** It clones the first user-role message rather than editing it, and returns a new
  array.
- **The summary block is a text content part prepended inside the LEADING user message** — or its own
  leading user message when the transcript does not start with one. That answers ADR-0062 §1's surviving
  objection STRUCTURALLY rather than by assumption: the returned array is user-first for every input, so no
  leading `assistant` is reachable and no second consecutive `user` message is created. An earlier form
  embedded into the first user message wherever it sat, which left `[assistant, user]` still
  assistant-first — unreachable through any live caller, but a property of four separate caller invariants
  rather than of this helper, and therefore one the next caller would break.
- **The separator is in-band and explicit**, because the OpenAI adapter joins parts on the wire and a part
  boundary is invisible there. Its exact text has one canonical home — [chat-session.md](../reference/cli/chat-session.md)
  § Context compaction, where ADR-0062 §7 already put the summariser prompt — and is derived from there,
  never restated. It states the block's provenance in plain prose and identifies the text after it as the
  user's message; nothing in the block is presented as instruction.
- **When there is no first user-role message**, the helper prepends one carrying only the summary block.
  That case is reachable (a resumed session whose next action is a tool-result-only turn), and it must be
  defined rather than discovered.
- **The same helper serves every path** — a normal turn, a restore, a reseat, and the token estimator. The
  estimator measuring a different array than the request is how a context-window guard drifts from the
  request it is guarding.
- **The summary is never double-prefixed.** The helper is the only producer, it runs once per request, and
  it reads the session's single summary field — so a second compaction replaces that field rather than
  nesting.

### 4. Tool authorization is computed from policy alone

The granted tool set comes from the agent's `tools` list and the node's grant. It never reads the summary.
This is called out because "the summary cannot escalate" is the claim a reader most needs proven, and §6's
acceptance criteria require it proven by mutation rather than asserted here.

### 5. What is NOT decided here

The brand covers the engine's system-prompt producers. It does not retroactively audit every other string
the engine builds; a future untrusted-content carrier gets the same treatment when it is written, not by a
sweep promised here. The `Untrusted<T>` marking covers the compaction summary specifically — other model
output already has its own handling and is out of scope.

### 6. Acceptance criteria

Structural and type-level only, per the phase's working-discipline clause 6. Stated here, not by reference,
because this repo treats the ADR as the contract the implementation is verified against.

1. A type-level test proves a dynamic `string` cannot be passed as `system`, and that the brand's
   constructors are the closed set in §1.
2. The lint fence in §1 is verified against the SHIPPED config, by an exact error count on a quarantined
   fixture — the mechanism this repo already uses for its seam fence, so a partial regression changes a
   count instead of passing on the remaining errors. The count is asserted in BOTH directions: fewer means a
   forging form stopped being policed, more means the fence now catches one of the residuals named above and
   this ADR's statement of its own bound needs correcting.
3. Given a summary containing a fence-closing sequence plus instructions, the assembled request has those
   bytes in a **user-role content part** and **zero** occurrences in the `system` field — asserted on the
   built request before any provider call, and again **after a restore from persistence** and **after a
   model reseat**. Both re-assertions are required because the original defect survived both.
4. `buildTurnMessages` does not mutate its inputs, and `#messages` after a request is byte-identical to
   `#messages` before it.
5. The token estimator and the request are built from the same projection.
6. A test mutates the summary text arbitrarily and asserts the resolved tool set is **byte-identical**.
7. **No assertion of the form "the model did not obey the injected instruction."**

### 7. Landing obligations

These are part of the change, not follow-ups — ADR-0080 landed Accepted with its canonical homes lagging,
and that is the pattern this list exists to prevent:

- ADR-0062: a dated `> Superseded (§1) by [ADR-0081]` note; its `Related` line describing ADR-0059 as
  carrying "the preamble" corrected.
- ADR-0059: a dated amendment saying what a reseat now carries and where.
- [chat-session.md](../reference/cli/chat-session.md) § Context compaction: the "session-level preamble
  (prepended to the agent's system prompt each turn)" sentence replaced, and the separator text's canonical
  home established there.
- This ADR's status moved to Accepted with the index row updated to match.

## Consequences

### Positive

- The documented attack stops working structurally rather than by filtering: there is no
  concatenation left to escape out of.
- The guarantee is enforced by the compiler at every present and future call site, which is
  strictly stronger than the convention that was in force when the defect shipped.
- No seam change, no new dependency, and no new security primitive — `LlmRequest.system` is untouched, the
  brand is erased, and the taint reuses the engine's existing `Untrusted<T>`.
- The rejected alternative from ADR-0062 §1 is engaged on its own terms, and half its
  ground is shown to have been false at the time.

### Negative

- **The summary carries less weight with the model.** Moving instruction-adjacent context
  out of `system` is a deliberate loss of authority, and a session may follow its summary
  slightly less closely. Lived with because the alternative is a trust boundary made of an
  XML tag; the in-band separator states the block's provenance so the model can still use it
  as context.
- **A branded type is friction at the call site.** Every producer must route through the
  builder. Lived with: there are two producers, and the friction is the mechanism.
- **The first user message is no longer verbatim on the wire.** A caller comparing the sent
  request to what the user typed will see the summary block prepended. Lived with, and made
  discoverable by the in-band separator naming what each half is.
- **Not a defence against a summary that is merely misleading.** An attacker can still
  influence what the summary *says*. This ADR bounds the summary's authority; it does not
  make the summarizer honest, and no acceptance criterion here asserts model obedience.
- **A deliberate `as` can still forge the brand.** The lint fence in §1 makes that visible rather than
  impossible; a contributor who suppresses the rule, or routes through a generic cast helper, defeats it. Lived with: the alternative — a runtime
  wrapper the seam would have to unwrap — buys no guarantee a reviewer reading a suppression would miss.
- **The separator costs its own length in input tokens on every turn**, exactly as ADR-0062's preamble did.
  Same cost, new position; it is named here so the move does not read as free.
