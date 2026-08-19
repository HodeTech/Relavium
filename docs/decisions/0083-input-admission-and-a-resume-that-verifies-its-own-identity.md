# ADR-0083: One input-admission gate in the engine, and a resume that verifies its own identity instead of trusting the caller

- **Status**: Accepted
- **Date**: 2026-08-19
- **Related**:
  - [ADR-0023](0023-strict-authored-yaml-validation.md) — parse-time validation. **Amended here**: §3 tightens `inputs` defaults and §6 forbids a `secret` default.
  - [ADR-0036](0036-run-loop-substrate-event-bus-and-execution-host.md) — the run loop and `run:started`. **Amended here**: `run:started` becomes the authoritative admission record for inputs and execution mode.
  - [ADR-0078](0078-ordered-durable-append-and-the-terminal-outbox.md) — the ordered durable log that makes §5 able to name one authority.
  - [ADR-0079](0079-cross-process-run-ownership-lease-and-fencing-token.md) — its §4 deferred "a content hash on `run:started`" for same-slug drift. §5 answers that without one, and §5's refusals must release the lease.
  - [ADR-0075](0075-fail-closed-resume-on-an-unreadable-event-log.md) — a resume that cannot be trusted refuses.
  - [ADR-0029](0029-tool-policy-hardening.md) — its secret-interpolation half, which §6's rules extend rather than restate.
  - [ADR-0082](0082-the-stream-grammar-is-a-seam-obligation-and-every-attempt-has-a-deadline.md) — the "quote what already exists" discipline this ADR's Context follows deliberately.
  - [workflow-yaml-spec.md](../reference/contracts/workflow-yaml-spec.md) · [database-schema.md](../reference/shared-core/database-schema.md) — the contract and the tables.
- **Closes**: **Decides** `CR-15` and `CR-17` of [phase 2.6.5](../roadmap/phases/phase-2.6.5-core-reliability-remediation.md). Accepted 2026-08-19 after a review that rejected the first draft on five blockers; three of them changed a decision rather than a sentence, and each is answered in place (§3 templated defaults, §5 the authoritative reader and MCP augmentation, §6 what a secret ref can and cannot prove). The §11 obligations land with the implementation.

## Context

Two gaps that share one question: **what was this run admitted with?**

### The authored input contract is validated by nobody

`WorkflowInputSchema` carries `required`, `default`, `type` and a `validation` block — `format`, `pattern`,
`enum`, `min`, `max`, `min_length`, `max_length` — plus a per-type table of which keys are legal on which
type. Parse time enforces the AUTHORING rules (that `min <= max`, that a `*_length` is not put on a number).
It says nothing about the VALUES a caller supplies, and neither does anything else.

`WorkflowEngine.start()` takes the caller's `inputs` object and hands it to the run execution, which stores
the reference without cloning, validating, or applying a single declared `default`. The CLI rejects unknown
keys, rejects a missing required input, and coerces argv strings — then defers:

> `continue; // omitted — the engine applies the declared default, if any`

The engine does not. A declared default arrives as `undefined`, an out-of-enum value reaches deep execution,
and every other surface gets whatever validation it happens to implement.

### A resume trusts identity it never verifies

`ResumeFromCheckpointInput`'s docblock states the gap and calls the remedy "a future revision": `workflow`,
`inputs`, `executionMode` and `planOptions` must be what the run started with, and nothing checks.

**Most of the durable record already exists**, and this ADR is written from the tree rather than from the
phase document's assumption:

- `runs.workflow_definition_snapshot` — *"the frozen graph that actually ran"*; `runs.input_json`;
  `runs.execution_mode`.
- `run:started` carries `inputs` and `executionMode`, with every `secret`-typed input already masked to
  `{ secret: true, ref: 'inputs.<name>' }`.
- `relavium gate` **already** resumes from that snapshot and refuses a masked secret rather than substituting.

So one host already does most of what `CR-17` asks. What is missing is that **the engine does not require
it** — a desktop, an extension or the Phase-2 API can resume the same run with different inputs and a
different mode, and nothing errors.

### Three things in the tree that make the naive version of this ADR wrong

A first draft was reviewed and rejected on these. They are stated here because each one changes a decision.

1. **`inputs` defaults are a TEMPLATE field.** The spec lists them alongside `context` values and
   `prompt_template` as places `{{ }}` interpolation is legal. "Validate the default at parse" is therefore
   only expressible for a literal one.
2. **The frozen snapshot is NOT always what ran.** `relavium run` opens the history store with the parsed
   definition, then augments the workflow with MCP-discovered tools, then starts the engine with the
   augmented one. The snapshot is the pre-augmentation graph.
3. **The persisted secret `ref` is `inputs.<name>` — a self-reference, not a credential identity.** It names
   the slot; it says nothing about which key filled it.

## Decision

**We will add one pure admission gate in the engine that resolves and validates inputs before a run exists,
and make resume RECONSTRUCT its identity from the durable record rather than accept the caller's.**

### 1. `resolveAndValidateWorkflowInputs` — pure, synchronous, in core, before anything exists

A pure synchronous function in `packages/core`, taking the parsed workflow and the caller's raw inputs and
returning either the resolved input map or a typed admission error. It runs in `start()` **before the run id
is generated and before the first event is emitted**.

That ordering is the decision. An admission failure must leave **no `runId`, no `run:started`, no row** — a
rejected run is not a run.

**Synchronous, and §3 is what makes that possible.** An async admission would need a cancellation contract,
an ordering rule against the lease, and a story for a host capability failing mid-admission. None of that is
worth carrying for a step whose whole job is to say yes or no to a map.

### 2. The surface coerces; the engine is strict

- **A surface may COERCE** — turn its transport's representation into the declared type. A CLI has only
  strings, so `--input count=3` must become the number `3` somewhere, and only the surface knows its
  transport.
- **The engine is STRICT.** Given a `number`-typed input it accepts a number, not `"3"`. It applies defaults,
  checks `required`, rejects unknown keys, and enforces every `validation` field.

Considered and rejected: coercing in the engine (it would silently accept a form's stringly-typed payload as
validated, and bury each surface's quirks in shared code); validating only at the surface (the status quo).

### 3. Interpolation is FORBIDDEN in an input `default`

The spec today lists `inputs` defaults as a template field. This removes them from that list, and the reason
is that at admission time — which must precede run creation — **none of the three referenceable scopes
exists**:

- `{{inputs.*}}` is what admission is resolving. A default referencing another input needs a dependency
  order, cycle detection and a dangling-reference rule, for a feature nothing uses.
- `{{ctx.*}}` is resolved at RUN START, after admission by construction.
- `{{secrets.*}}` must never enter a default at all (§6).

**No run behaviour changes, but this is not a no-op — and the difference is worth stating precisely.** The
engine never applied a declared default, so a templated default's VALUE is dead today: it parses, and it
never reaches a run. What is NOT dead is the ANALYSIS of those templates. `analyzeSecretTaint` treats an
input default as a live reference site and rejects `default: '{{secrets.token}}'` laundered into a
`prompt_template` — transitively, across multiple hops — and `analyzePreRunReferences` flags a default
reading `run.outputs`.

Forbidding interpolation **subsumes** those rules rather than orphaning them: a default that cannot reference
anything cannot launder a secret, and the rejection moves one step earlier, from "this reference leaks" to
"this field takes no references". The security outcome is strictly stronger — an attack surface disappears
instead of being policed — and the tests that proved the old rule are rewritten to prove the new one, with
their reasoning recorded.

What a workflow author loses is a feature whose value never arrived. That is
[ADR-0023](0023-strict-authored-yaml-validation.md)'s own rule: silent deadness becomes a loud authoring
error.

With interpolation gone, a `default` is a literal, and **an authored default that violates its own
`validation` block fails at PARSE** — not at run, where it would surface only the first time someone omits
that input.

Considered and rejected: **two-phase validation** (literal defaults at parse, templated ones at admission).
It preserves a feature that has never worked, at the cost of dependency ordering, cycle detection, async
capability access inside a step this ADR deliberately keeps synchronous, and a second place validation lives.

### 4. Validation semantics, decided rather than implied

The current schema types `format` and `pattern` as any non-empty string, `enum` as `unknown[]`, and `default`
as `unknown`. "Enforce every validation field" is not implementable against that, so:

- **`format` is a CLOSED vocabulary**: `email`, `uri`, `uuid`, `date-time`. An unrecognised format is an
  authored error at PARSE. An open vocabulary would mean each surface inventing its own semantics — the
  failure this whole ADR is about.
- **`pattern` is compiled at PARSE**, so an invalid regex is an authored error rather than a run-time throw.
  It is **anchored** (a full match, not a search) and carries **no flags** — "does this value match" is the
  only question the field can honestly answer across surfaces. Its source is length-capped.
- **ReDoS is bounded, not eliminated.** A pattern is matched only AFTER the length checks, so `max_length`
  bounds the input a catastrophic pattern can chew on. An author who writes a nested-quantifier pattern and
  no `max_length` can still stall their own run; that is named here rather than papered over, and the
  mitigation is the length cap, not a static analysis we would get wrong.
- **`enum` members must satisfy the declared `type`** at parse. Matching is `Object.is`, so `NaN` matches
  `NaN` and `0` does not match `-0` — a decision, because `===` and deep equality both answer differently.
- **A `number` must be finite.** `NaN` and `±Infinity` are rejected regardless of `min`/`max`, which cannot
  express them.
- **Absent means absent.** A missing key and an own property whose value is `undefined` are both "omitted"
  and take the default. **`null` is a VALUE**, not an omission, and fails type validation for every declared
  type.
- **`required: true` with a `default` is satisfied by the default.** That is what the CLI already assumes.

> Amended 2026-08-19 — three corrections the implementation forced, each measured before it was written.
>
> - **An anchored `pattern` must be a complete regex on its own.** "Anchored" above assumed the wrapping
>   group defends itself. It does not: a source carrying an unmatched `)` closes it early, so `x)|(?:.*`
>   anchors to `^(?:x)|(?:.*)$` — a declared `pattern` that matches EVERY string while this ADR promises a
>   full match. Rejected at parse, by compiling the source BARE: escaping the wrapper requires a `)` that is
>   unmatched within the source, which is a `SyntaxError` bare in every mode. The check is the regex engine's
>   own, not a parenthesis scanner we would get wrong.
> - **`format: uri` means any absolute URI.** The first implementation required `://`, so it rejected
>   `mailto:`, `urn:` and `data:` — URIs by every definition of the word, under a vocabulary key that says
>   `uri` and not `url`. Corrected to a scheme-prefixed absolute URI.
> - **A `date-time` is range-checked per component, and no string format admits a control character.**
>   Unbounded two-digit groups accepted `0000-99-99T99:99:99Z`, which is not a pragmatic check failing
>   gracefully but the check being absent. Calendar validity — `2026-02-31` — is still out of scope and now
>   says so. The control-character exclusion is because these values are echoed by surfaces and written to
>   log sinks, the same reason §1's issue messages are value-free.

### 5. Resume reconstructs identity; the caller's copy is VERIFIED, not trusted

**Authority, named once.** `inputs` and `executionMode` come from **`run:started`**, folded into
`CheckpointState` — the ordered durable log is the truth ADR-0078 built, and the engine already folds that
event. No new port. The engine does **not** read `runs.input_json`, so there is no two-source disagreement to
resolve.

**The graph comes from the frozen definition**, which lives in `runs` and is not in the event log. `RunStore`
gains **one method** to read it — a method on the seam the engine already owns, not a new port. Verification
is a **deep structural equality** against the caller's parsed workflow, on the normalized parse output rather
than raw YAML, so formatting and key order cannot cause a false mismatch. That answers
[ADR-0079](0079-cross-process-run-ownership-lease-and-fencing-token.md) §4's deferred content hash without a
digest and without asking a platform-free engine to compute SHA-256.

**The snapshot must be the ADMITTED definition** — §Context 2's bug. `relavium run` currently freezes the
pre-augmentation graph and starts the engine with the MCP-augmented one, so the two differ on every run with
`mcp_servers`. The host must persist what it started the engine with. **MCP-discovered tool grants are part
of workflow identity**: they are part of the graph that ran, and an MCP server returning a different tool set
on resume IS a divergence. It fails closed, and the error says so rather than continuing under a graph the
run never had.

**A refusal releases the lease.** Every identity check sits after `resumeFromCheckpoint` has acquired
ownership, and [ADR-0079](0079-cross-process-run-ownership-lease-and-fencing-token.md) §4's rule — an acquire
that leads nowhere must not leak — covers these exactly as it covers `workflow_mismatch`.

**`planOptions.agents` is verified by ID, not by content**, because the resolved agents are read from the
filesystem by the host and are not persisted. An agent file edited between processes is NOT detected. §10
records it as a limitation rather than implying a completeness the mechanism does not have.

> Amended 2026-08-19 — two things the implementation settled.
>
> - **`RunStore.readWorkflowSnapshot` is REQUIRED, and answers `string | undefined`.** Optional would mean a
>   host that omits the property silently loses the guarantee — the failure mode
>   [ADR-0078](0078-durable-truth-and-the-terminal-outbox.md) §4 names for the outbox port. Required forces a
>   host author to decide, and a store that genuinely keeps no frozen definition says so by answering
>   `undefined`, which is an honest fact rather than a fabricated belief. The engine then skips content
>   verification with that fact stated. The cost is real and was paid: every `RunStore` fixture in the tree
>   had to answer the question.
> - **`plan_mismatch` was NOT implemented, and should not be.** §11 listed it in the taxonomy, but every case
>   it could name is already covered: an `agent_ref` that does not resolve against `planOptions.agents` makes
>   `buildRunPlan` throw on the resume path, and everything else about the plan is derived from the workflow,
>   whose content this section now verifies. A code no refusal can reach is dead taxonomy — a surface would
>   branch on something that never arrives. The verified-by-ID limitation above is unchanged; what is dropped
>   is a second name for it.

### 6. A `secret` input: what the engine can prove, and what it cannot

A `secret` value is never persisted; the record carries `{ secret: true, ref: 'inputs.<name>' }`.

**The contract:** the caller re-supplies the secret by name; a missing or unexpected secret is a typed error;
it is never silently substituted, defaulted, or dropped to `undefined`. The CLI's existing
`assertNoMaskedSecretInputs` already takes the refusing side; the engine adopts it as the contract.

**What that proves, stated exactly.** The engine verifies the SLOT — that the same named secret input is
supplied, and that the record holds a masked placeholder rather than a value. It does **not** prove the value
is the same credential, that nothing was rotated, or that the run continues under the key it started with.
The persisted ref is a self-reference; it names the slot, not the key. A first draft of this ADR claimed
"same inputs" and "a different credential is prevented"; both are withdrawn.

Considered and rejected: **failing closed on any secret-bearing resume** until a versioned reference exists
(it would break every secret-bearing `relavium gate` today, to buy a guarantee nothing can yet check);
**inventing a key version here** (there is no key-versioning concept in the tree; a second unused mechanism
is worse than a named gap).

**A `secret` input may not declare a `default`.** It can today, and such a default is written verbatim into
`runs.workflow_definition_snapshot` — a plaintext credential in the durable store. Rejected at PARSE, and
§9's acceptance scans every persisted column, not just the input map.

> Amended 2026-08-19 — **a `secret` also loses `enum`.** The rule shipped with the parse-time half and this
> section did not carry it, which left the code citing a paragraph that said nothing and the canonical
> [spec table](../reference/contracts/workflow-yaml-spec.md) contradicting the shipped parser. It is the
> same reasoning as the `default` ban one paragraph up: an `enum` of allowed secret values writes the
> credential into the same unmasked `workflow_definition_snapshot` column through a neighbouring key, and
> "the credential is one of these three" is not a contract worth expressing. `pattern` survives, because a
> SHAPE is not a value — and an author who writes a literal there has written the secret down either way.

**That closes the DECLARED case and no more, which is worth saying plainly.** The snapshot is the full
authored YAML, unredacted — [phase 2.5.5](../roadmap/phases/phase-2.5.5-hardening-and-remediation.md) already
records this and names the residue: a hardcoded credential literal sitting in an unrelated field is not a
declared `secret`, so no taint rule and no rule here sees it. Its own item — a best-effort secret-shaped-
literal lint at authoring time — stays where it is. This ADR removes one path into that column; it does not
make the column safe.

**Re-supply must not travel through argv.** A raw secret on a command line leaks to `ps`, shell history and
CI logs; `relavium provider set-key` already uses stdin for exactly this reason. The CLI's secret-bearing
resume takes its value the same way, and `relavium gate` gains that option — it has none today.

### 7. The engine BUILDS its input map; it does not clone the caller's

The resolved map is constructed fresh, with a `null` prototype, by iterating the DECLARED inputs and reading
the caller's object through `Object.hasOwn`. The caller's object is never spread, assigned from, or cloned
wholesale.

**A first draft said `structuredClone`, for a reason that was wrong twice.** `JSON.parse` makes `__proto__` an
own property and does not pollute; and `structuredClone` does **not** preserve a null prototype — it returns
an ordinary object. Both were verified. The real hazard is the ACCUMULATOR: writing `out[name] = value` onto a
`{}` when `name` is `__proto__` invokes the prototype setter, and an input name may legitimately be
`__proto__` under the `[A-Za-z0-9_-]+` grammar. Building a null-prototype map from the declared list closes
that at both ends, and it also gives the "unknown key" check for free.

Mutating the caller's object after `start()` cannot change the run, because the run never holds it.

### 8. `start` and `resume` apply the SAME admission

Both go through §1. A resumed run's inputs are the durable ones, so admission is re-verification rather than
re-resolution — but running the same function means a rule cannot hold on one path and not the other.

**A legacy run keeps its own semantics.** A run admitted before this landed may have no recorded value for an
input that declares a default. Resume VERIFIES what is recorded; it does not invent a value the run never
had. That follows from §5's authority rule and needs no version marker.

### 9. Acceptance

1. A missing `required` input fails admission; one satisfied by a `default` does not.
2. An unknown input key fails admission.
3. **Every** `validation` field rejects a violating value and accepts a conforming one — one case each, both
   directions — plus: an unknown `format`, an invalid `pattern`, and an `enum` member of the wrong type each
   fail at PARSE.
4. A `pattern` is anchored: a value that merely CONTAINS a match is rejected.
5. `null` fails; a missing key and an own `undefined` both take the default; a non-finite number fails.
6. The engine is strict: a `number`-typed input rejects `"3"`. The CLI's coercion of `"3"` into `3` before
   the engine is pinned separately, so the split is proven from both sides.
7. Input names `__proto__`, `constructor` and `toString` round-trip as ordinary inputs, on the CLI path and
   the engine path, with `Object.prototype` unpolluted after.
8. Interpolation in a `default` fails at PARSE, with the message naming the rule.
9. An admission failure produces a typed error and **no `runId`, no `run:started`, an untouched store** —
   asserted by inspecting the store.
10. `start` and `resume` reject the same violating input.
11. A resume whose caller passes different inputs, a different `executionMode`, or a content-different
    workflow is a typed error — one test per axis, each asserting the run did not continue **and that the
    lease was released**.
12. An **MCP-augmented** workflow resumes cleanly when the server returns the same tools, and fails closed
    when it returns a different set.
13. A resume that omits a required `secret` is a typed error; one that supplies it proceeds; the persisted
    record still contains only the ref.
14. A `secret` input declaring a `default` fails at PARSE, and a scan of **every persisted column** —
    including `workflow_definition_snapshot` — finds no raw secret.
15. A **pre-0083 legacy fixture**: a durable record missing a key that now declares a default resumes with
    what it recorded, and the default is not invented.
16. **No assertion that a secret's VALUE round-trips** — proving that would require persisting it.

### 10. What is NOT decided here

- **Key versioning for `secret` inputs**, and with it credential continuity across a resume (§6).
- **`planOptions.agents` content verification** (§5). Verified by id only; an edited agent file is not
  detected.
- **Per-surface coercion rules.** Each surface owns its transport's conversions.
- **Static ReDoS analysis** of an authored `pattern` (§4). Bounded by `max_length`, not eliminated.
- **Retrofitting existing rows.** §8's legacy rule is the whole policy.

### 11. Landing obligations

- A typed admission taxonomy on `EngineStateErrorCode`, which today has only `workflow_mismatch`:
  `input_admission_failed`, `input_mismatch`, `execution_mode_mismatch`, `workflow_content_mismatch`,
  `plan_mismatch`, `secret_input_missing`, `secret_input_unexpected`, `admission_record_unreadable`. Each is
  a permanent invocation fault, not transient.
- ADR-0023: a dated amendment for §3 and §6's parse-time tightenings.
- ADR-0036: a dated amendment naming `run:started` the admission record.
- [workflow-yaml-spec.md](../reference/contracts/workflow-yaml-spec.md): `inputs` defaults removed from the
  template-field list; §4's validation semantics; the `secret`-default prohibition; the correction that a
  workflow input `secret` is caller-supplied, not resolved from a store.
- [database-schema.md](../reference/shared-core/database-schema.md): the "exact graph that ran" claim
  corrected for MCP augmentation.
- [sse-event-schema.md](../reference/contracts/sse-event-schema.md) and `run-event.ts`'s docblock: the masked
  placeholder is a self-reference, not a keychain/env reference.
- [commands.md](../reference/cli/commands.md): the secret-bearing gate resume, and its stdin contract.
- The `ResumeFromCheckpointInput` docblock's "a future revision will…" replaced with what shipped.
- The phase document's `CR-17` correction note updated with the augmented-vs-frozen resolution.
- This ADR to Accepted, with the index row to match.

## Consequences

### Positive

- The authored contract is enforced once, in the layer every surface shares.
- A rejected run leaves nothing behind.
- A resumed run is provably the run that started: same inputs, same mode, same graph — including the tools
  MCP contributed.
- No new persisted state, no event-contract change, no new port — one `RunStore` method and a wider fold.
- The `__proto__` hazard is closed at the accumulator, where it actually lives.

### Negative

- **Strictness will break callers passing stringly-typed values.** A host sending `"3"` for a `number` input
  works today and stops. That is the bug being fixed, and it will look like a regression first.
- **Resume gains failure modes.** A host quietly resuming with different inputs now gets a typed error.
- **An MCP server that changes its tool set breaks resume.** Fail-closed is right — the graph really did
  change — but it makes resume dependent on a remote server's stability, and the error must say so clearly
  enough that an operator knows it is not their workflow that broke.
- **Templated input defaults are removed from the spec, and the break reaches PERSISTED runs.** Their value
  never reached a run, so no run behaviour changes — but a workflow that parses today will stop parsing, and
  `relavium gate` re-validates `runs.workflow_definition_snapshot` with the same schema on every resume. A
  run created before this landed, from a workflow with a templated default, a `secret` default, an unknown
  `format` or an invalid `pattern`, becomes **unresumable**, not merely un-reauthorable. No such run exists
  in this repo — every tracked fixture and doc sample was checked — but a user's paused run is a real
  possibility, and whether snapshot rehydration should share authoring strictness is a question this ADR
  leaves open rather than answers. Three secret-taint rules that policed those templates are subsumed
  rather than kept. A reader looking for "why was my laundering test deleted"
  finds the answer in §3 and in the rewritten tests, not in a silence.
- **A `secret` input must be re-supplied on every resume**, through stdin, which is friction on an unattended
  resume and the honest cost of never persisting a credential — and it still does not prove continuity (§6).
- **A catastrophic authored `pattern` can still stall a run** whose input has no `max_length`.
