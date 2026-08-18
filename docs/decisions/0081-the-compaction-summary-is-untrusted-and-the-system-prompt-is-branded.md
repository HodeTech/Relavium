# ADR-0081: The compaction summary is untrusted content, and the system prompt becomes a branded type (supersedes ADR-0062 §1)

- **Status**: Proposed
- **Date**: 2026-08-18
- **Related**:
  - [ADR-0062](0062-context-compaction-and-cli-history-commands.md) — **§1 superseded here.** Its §2 (append-only marker row), §3 (producer/consumer split), and the `/clear` · `/trim` · `/compact` command surface are untouched.
  - [ADR-0059](0059-cli-mid-session-model-reseat.md) — the reseat that must carry the summary. **Amended here**: what it carries stops being a system-prompt preamble.
  - [ADR-0024](0024-agent-first-entry-point-agentsession.md) — the session engine. **Cited, not amended**: it says nothing about system-prompt authority.
  - [ADR-0011](0011-internal-llm-abstraction.md) + [ADR-0030](0030-llm-seam-shape-amendment-reasoning-response-format-provider-executed.md) — the seam. **Cited, not amended**: `LlmRequest.system` stays `z.string().optional()`; no seam shape changes.
  - [docs/standards/security-review.md](../standards/security-review.md) — the binding rule this restores.
  - [chat-session.md](../reference/cli/chat-session.md) § Context compaction — the canonical home for what compaction does to a session, updated alongside. [llm-provider-seam.md](../reference/shared-core/llm-provider-seam.md) is cited, not changed: the seam shape is untouched.
- **Closes**: **Decides** `CR-13` of [phase 2.6.5](../roadmap/phases/phase-2.6.5-core-reliability-remediation.md).

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

### 1. `AuthoredSystemPrompt` — a branded string, constructible in one place

`AgentTurnParams.system` and the session's system builder stop accepting `string`. They
accept `AuthoredSystemPrompt`, a branded type produced only by
`authoredSystemPrompt(agent, node?)` in `packages/shared`. That function reads
`agent.system_prompt` and the node's `system_prompt_append` and nothing else — there is no
overload, no escape hatch, and no `as` that type-checks under the repo's lint rules.

Considered: a runtime assertion that the assembled `system` contains no summary bytes
(rejected — it is a scan for a payload we already know the shape of, and it fails open on
any encoding the scan misses); a naming convention plus a review checklist (rejected — that
is exactly what was in force when ADR-0062 §1 shipped); and a `readonly` wrapper object
(rejected — it changes the seam shape for no additional guarantee, since a brand is erased
at the seam boundary where the string is finally read).

The brand is a compile-time device with **zero runtime cost and zero seam impact**:
`LlmRequest.system` remains `z.string().optional()`, and the branded value is a string. What
changes is that a dynamic string can no longer reach the field.

### 2. The summary rides in the first user-role turn, behind an in-band separator

The per-turn message array becomes:

```
user   : <untrusted-summary-block> + separator + <the user's actual first message>
… the kept verbatim exchange, unchanged …
user   : <this turn's message>
```

The summary block is a text content part in the **first user-role message**, never its own
message. That answers ADR-0062 §1's surviving objection directly: there is no leading
`assistant`, and no second consecutive `user` message is created — the summary joins an
existing one.

The separator is **in-band and explicit**, because the OpenAI adapter joins parts on the
wire and a part boundary would be invisible there. It states its own provenance in plain
text rather than relying on a fence the content can close: the block is introduced as a
machine-generated summary of earlier conversation, and the text after the separator is
identified as the user's message. Nothing in the block is presented as instruction.

Considered: keeping the XML fence and escaping the closing tag inside the summary (rejected
— escaping is a filter, and this ADR exists because a filter was mistaken for a boundary);
a dedicated `LlmMessage` role for untrusted context (rejected — a seam shape change,
CLAUDE.md #4, for a property the `user` role already has); and re-summarising with a
sanitizing pass (rejected — it spends a second model call to reduce, not remove, the risk).

### 3. What this changes about authority, stated plainly

The summary was previously *instruction*. It is now *data the model is told about*. That is
a real behavioural change and it is the point: a model that reads "ignore previous
instructions" in a user-role block that announces itself as a transcript summary is in the
same position it is in for any other untrusted input, which is the position the rest of the
system already assumes.

**Tool authorization is unaffected and must be provably so.** The granted tool set is
computed from policy — the agent's `tools` list and the node's grant — and never reads the
summary. This ADR requires a test that mutates the summary arbitrarily and asserts the
resolved tool set is byte-identical, because "the summary cannot escalate" is the claim a
reader most needs proven.

### 4. Persistence and reseat carry the same bytes, in the same place

The persisted summary (ADR-0062 §2's marker row) is unchanged on disk — the same column,
the same append-only marker. What changes is where a restored summary is placed on the next
turn: the first user-role message, not `system`. A model reseat ([ADR-0059](0059-cli-mid-session-model-reseat.md))
carries it the same way. The acceptance criteria below require the property re-asserted
**after** a restore and **after** a reseat, because the original defect survived both.

### 5. What is NOT decided here

The `system` brand covers the engine's two producers — `AgentSession` and the workflow
agent runner. It does **not** retroactively audit every other string the engine builds; a
future untrusted-content carrier gets the same treatment when it is written, not by a
sweep promised here.

## Consequences

### Positive

- The documented attack stops working structurally rather than by filtering: there is no
  concatenation left to escape out of.
- The guarantee is enforced by the compiler at every present and future call site, which is
  strictly stronger than the convention that was in force when the defect shipped.
- No seam change, no new dependency, no runtime cost — `LlmRequest.system` is untouched and
  the brand is erased.
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
