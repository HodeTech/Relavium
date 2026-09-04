# ADR-0092: `output_schema` is deep-validated by the JSON-Schema compiler we already own

- **Status**: Accepted
- **Date**: 2026-09-02
- **Related**: [0038-agentrunner-llm-call-boundary.md](0038-agentrunner-llm-call-boundary.md) (**fulfils** the clause it left open — node-side `output_schema` validation, "not silently deferred"), [0088-the-mcp-boundary-is-hostile.md](0088-the-mcp-boundary-is-hostile.md) (the compiler this promotes was built for that boundary), [0023-strict-authored-yaml-validation.md](0023-strict-authored-yaml-validation.md) (the fail-loud-at-parse discipline this extends), [0011-internal-llm-abstraction.md](0011-internal-llm-abstraction.md) + [../standards/architectural-principles.md](../standards/architectural-principles.md) §9 (build in-house, minimize dependencies), [../standards/error-handling.md](../standards/error-handling.md) (the narrower rule this replaces), [../reference/shared-core/agent-runner.md](../reference/shared-core/agent-runner.md) + [../reference/contracts/agent-yaml-spec.md](../reference/contracts/agent-yaml-spec.md) (the homes this corrects), [../roadmap/phases/phase-2.6.5-core-reliability-remediation.md](../roadmap/phases/phase-2.6.5-core-reliability-remediation.md) (`CR-61`)

## Context

[ADR-0038](0038-agentrunner-llm-call-boundary.md) required node-side `output_schema` validation to land with
1.O "**in the same PR or behind a hard acceptance gate**… **not** silently deferred", because the seam's
`responseFormat` is a *request-side hint only* — no adapter validates the response, and DeepSeek degrades to
bare `json_object`. What shipped is narrower: the runner `JSON.parse`s the output and checks nothing else.
[error-handling.md](../standards/error-handling.md) records that narrower rule as if it were the contract, so
two documents disagree about what was required and the narrowing was never decided.

**`CR-61` framed the fix as needing a new dependency.** That premise is false. `packages/mcp` already contains
a **dependency-free JSON-Schema→Zod compiler** (`schema-compiler.ts`), written for
[ADR-0088](0088-the-mcp-boundary-is-hostile.md)'s hostile-MCP boundary, whose only imports are `zod` and two
bounds constants. `@relavium/shared`'s runtime-dependency allowlist is already exactly `['zod']`. So the
capability exists, in-house, and is one move away from the authored path — no new dependency, and no
amendment to the dependency ADR.

**The compiler is not a conformance validator, and an earlier draft of this ADR wrongly assumed it was.**
It is a **denylist**: `UNSUPPORTED_KEYS` rejects `$ref`, `oneOf`/`anyOf`/`allOf`, `not`, `if`/`then`/`else`,
`patternProperties`, `dependencies` and `unevaluatedProperties` — and everything else is *accepted*, whether
or not it is enforced. Verified against the code:

- **`pattern` and `format` are accepted and NOT enforced.** The compiler's own docblock says so, and gives the
  reason: it "never compiles an untrusted `pattern`/`format` regex — there is no ReDoS surface… the server
  still validates server-side".
- **`additionalProperties: { …schema… }` is passthrough** — "we do not type the extra values, but we never
  reject them" — and a test pins that behaviour.
- **Validation keywords it does not know are silently ignored**, because a denylist cannot reject what it has
  never heard of: `multipleOf`, `uniqueItems`, `exclusiveMinimum`/`exclusiveMaximum`, `minProperties`/
  `maxProperties`, `contains`. A malformed value for a supported keyword (`minLength: "5"`) likewise passes
  unenforced rather than failing.

Every one of those is **correct for the MCP boundary**: the compiler's job there is to make an untrusted
tool's shape safe to hand to a model, while the server remains responsible for its own semantics. Carried
unchanged onto an **authored** `output_schema`, the same behaviour means a model output that violates
`pattern` is accepted with no `validation` failure — which is precisely the silent gap `CR-61` exists to
close, reintroduced by its own remedy.

A third disagreement sits beside it: [agent-yaml-spec.md](../reference/contracts/agent-yaml-spec.md) says
`output_schema` has the "same role" as `input_schema` — *"purely additive metadata… does not change run-time
execution"* — which is false. It becomes `responseFormat` and gates a `validation` failure.

## Decision

**We will land deep `output_schema` validation on a compiler we already own, promoted to `@relavium/shared`
and given an ALLOWLIST-based strict mode for authored input — where every validation-affecting keyword is
either genuinely enforced or refused at parse.**

1. **`schema-compiler.ts` moves to `@relavium/shared`**, parameterized over its bounds so `@relavium/mcp`
   keeps its hostile-ingress limits. It cannot stay where it is: `packages/mcp` depends on `@relavium/core`,
   so core cannot import from it. No new runtime dependency in any package; `shared`'s allowlist is unchanged.

2. **A second mode — `strict`, for AUTHORED schemas — replaces the denylist with an allowlist.** This is the
   substance of the decision, not a flag. In strict mode:
   - the keywords the compiler already enforces keep working;
   - **`pattern`, `format`, `multipleOf`, `uniqueItems`, `exclusiveMinimum`/`exclusiveMaximum`,
     `minProperties`/`maxProperties`, and `additionalProperties`-as-a-schema become genuinely ENFORCED.**
     An authored `pattern` is ours, not an untrusted server's, so the ReDoS reasoning that justifies skipping
     it at the MCP boundary does not apply — but the regex is still compiled under the existing node/depth
     budget, and a pattern that fails to compile is an authoring error, not a run-time surprise;
   - **every other keyword is REFUSED**, by allowlist, so a construct nobody implemented can never be
     silently ignored again;
   - **a malformed value for a supported keyword is refused** (`minLength: "5"` fails; it does not pass
     unenforced).
   `@relavium/mcp` keeps the denylist mode verbatim — its behaviour, and its tests, do not change.

3. **An agent's or node's `output_schema` is compiled at PARSE time** in strict mode. A refusal is a typed
   authoring error naming the offending keyword and the field, before a run id exists — the discipline
   [ADR-0023](0023-strict-authored-yaml-validation.md) applies to every other authored value.

4. **At run time, the compiled validator checks the parsed output**, and a miss is a `validation` failure with
   `retryable: false` — the behaviour ADR-0038 specified. Parse-as-JSON is the first step; conformance is the
   second. The compiled validator is derived from the authored schema and rebuilt on load rather than
   persisted: a plan and a checkpoint stay plain serializable data, and a resumed run recompiles from the
   same authored text. A caller that reaches the runner directly, without a plan, compiles on first use.

5. **The supported subset is a written contract** with one canonical home —
   `docs/reference/shared-core/json-schema-subset.md` — naming the dialect, the bounds, the per-keyword
   enforced/refused matrix, and the rule that neither a parse-time nor a run-time error echoes an authored
   schema property name or any part of the model output. The parse error links to it.

6. **`agent-yaml-spec.md` stops calling `output_schema` purely additive.** It states that, unlike
   `input_schema`, it *does* affect a run, and links to `agent-runner.md` rather than restating the rule
   (rule 8). `error-handling.md`'s narrower sentence is replaced by the contract above.

*Considered:* **(a0)** promote the compiler AS IS and call it deep validation — rejected, and it is what an
earlier draft of this ADR proposed: the compiler accepts `pattern`/`format`/`additionalProperties`-schemas
without enforcing them and ignores keywords it does not know, so "validated" would have been false for
exactly the schemas an author writes to be precise. **(a1)** strict mode that merely REFUSES everything not
already enforced, adding no new enforcement — rejected as too blunt: it would reject `pattern`, one of the
most ordinary things an author writes, and push them back to an unvalidated schema. **(a)** add a full
JSON-Schema validator dependency (ajv or similar) behind an ADR — rejected:
CLAUDE.md rule 2 and architectural-principles §9 say build in-house and minimize dependencies, and we already
own a compiler; adding a supply-chain surface to avoid moving a file we wrote is the wrong trade. **(b)**
record the parse-as-JSON narrowing as the shipped contract, superseding ADR-0038's clause — rejected: it is
honest but leaves the defect, and ADR-0038's reasoning for requiring validation (no adapter validates the
response) is still true today. **(c)** promote the compiler but *degrade to parse-as-JSON* for a schema it
cannot express — rejected: it reintroduces the silent gap for exactly the most expressive schemas, which is
the shape of defect this wave exists to remove. **(d)** fail the node at run time on an unsupported keyword —
rejected outright: it is the worst of both, spending the model call before refusing.

## Consequences

### Positive

- ADR-0038's clause is fulfilled rather than narrowed, with no new dependency and no dependency-ADR amendment.
- The engine gains a real schema capability it owns, tested against a hostile boundary before it was ever
  pointed at an authored one.
- An authoring mistake — a malformed schema, an unsupported construct, an output that does not conform —
  is caught at the earliest point each can be caught, and the first two are caught before any provider call.

### Negative

- **A valid JSON Schema can be refused.** An author using `oneOf` must rewrite it or wait for the subset to
  grow. This is a real capability limit, chosen over a silent one; mitigated by naming the keyword in the
  error and documenting the subset, and revisitable by widening the compiler in one place.
- **Strict mode is real new code on a security-adjacent component**, not a flag: enforcing `pattern` means
  compiling a regex the MCP path deliberately never compiles. Contained by keeping the two modes separate,
  leaving `@relavium/mcp` on the denylist path unchanged, and compiling authored patterns under the existing
  node/depth budget.
- Moving a file between packages touches the MCP ingress path, which is security-relevant. Mitigated by the
  bounds becoming an explicit parameter rather than a constant the move could silently change, and by the
  compiler's existing test suite moving with it.
- `@relavium/shared` grows a compiler. It is the right home — it already owns the schemas every package
  validates against — but `shared` is imported by everything, so its surface deserves the scrutiny this
  records.

## Amendment — 2026-09-03: §2's ReDoS reasoning is half an argument

§2 justifies compiling an authored `pattern` like this: *"An authored `pattern` is ours, not an untrusted
server's, so the ReDoS reasoning that justifies skipping it at the MCP boundary does not apply."*

**That is true of the pattern and false of the input.** Catastrophic backtracking needs a vulnerable regex
*and* a hostile string, and the string here is **model output** — the least trusted value in the run, and
one an indirect prompt injection can steer. The MCP boundary's reasoning was never only about who wrote the
regex.

Measured on `^(a+)+$` against `"a"×n + "!"`:

| input length | match time |
| --- | --- |
| 19 | 9.6 ms |
| 23 | 18.1 ms |
| 27 | 286 ms |
| ~40 | minutes (exponential) |

**And the blast radius is the process, not the node.** Backtracking is synchronous, so
[ADR-0085](0085-the-node-executor-owes-liveness-and-the-engine-enforces-it.md)'s node deadline cannot fire —
the timer never gets a turn. A run cannot be cancelled out of it either. That also puts it against this
project's own precedent: [ADR-0027](0027-expression-sandbox.md) resource-caps an author's *code* precisely
so an authored construct cannot hang the engine, and this would be an authored construct evaluated in the
host with no cap at all.

**The decision stands for now, deliberately, and the reasoning is recorded rather than the conclusion
quietly changed.** The alternatives were weighed on 2026-09-03: a static refusal of nested-quantifier shapes
is a heuristic that both misses cases and can refuse a valid pattern (the exact failure class `CR-62` hit
seven times in one wave); refusing `pattern` outright is what §2's alternative (a1) already rejected, and
would push an author back to an unvalidated schema; a linear-time matcher (RE2 or similar) solves it
completely but is a new runtime dependency and needs its own ADR under CLAUDE.md rule 2.

Recorded in [deferred-tasks.md](../roadmap/deferred-tasks.md) with the measurement, so the next person
decides from numbers rather than rediscovering them.

