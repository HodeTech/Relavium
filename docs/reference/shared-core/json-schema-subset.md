# The JSON-Schema subset

**Canonical home** for what a JSON Schema may contain in Relavium, what is enforced, and what is refused.
It has two callers: an authored `output_schema`
([agent-yaml-spec.md](../contracts/agent-yaml-spec.md), [node-types.md](node-types.md)) and an MCP server's
tool `inputSchema` ([mcp-integration.md](mcp-integration.md)). Both are governed by the matrix below.

Decisions: [ADR-0052](../../decisions/0052-inbound-mcp-client-package-lifecycle-registration.md) §4 (the
compiler) and [ADR-0092](../../decisions/0092-output-schema-is-validated-by-the-compiler-we-already-own.md)
(its promotion to `@relavium/shared` and the `strict` mode).

## Dialect

A **subset of JSON Schema draft 2020-12**, compiled to an executable Zod validator. `$schema` is accepted
and ignored — the subset below is the contract, not whatever a `$schema` URI names. There is no `$ref`
resolution, so a schema is always self-contained.

## Two modes, because there are two threat models

| | `lenient` | `strict` |
| --- | --- | --- |
| used for | an MCP server's `inputSchema` | an authored `output_schema` |
| the schema is | a possibly-hostile stranger's | the author's own |
| unknown keyword | **ignored** | **refused** |
| malformed **bound** (`minLength: "5"`) | ignored | **refused** |
| malformed `type` / `required` / `properties` / `enum` / `const` / `items` | **fails closed** | **fails closed** |
| `pattern` / `format` | accepted, **never compiled** | **enforced** |
| when it is checked | at tool discovery | at **parse**, before a run id exists |

`lenient` never compiles a regex it was handed, so a hostile server has no ReDoS lever, and the server
validates its own input anyway. `strict` is an **allowlist**: a keyword that is not in the table below is
refused rather than ignored, so a construct nobody implemented can never again be silently accepted while
the author is told their schema is "validated".

## Per-keyword matrix

`✓` enforced · `–` accepted and ignored (no validation semantics) · `✗` refused

| keyword | `lenient` | `strict` | notes |
| --- | --- | --- | --- |
| `type` | ✓ | ✓ | `object` `array` `string` `number` `integer` `boolean` `null`; an array of them is a union |
| `nullable` | ✓ | ✓ | the OpenAPI modifier, distinct from a `'null'` type member |
| `enum` | ✓ | ✓ | non-empty; members must be string/number/boolean/null scalars |
| `const` | ✓ | ✓ | a finite number, string, boolean, or null |
| `properties` | ✓ | ✓ | |
| `required` | ✓ | ✓ | a name not in `properties` is still presence-enforced |
| `additionalProperties: false` | ✓ | ✓ | unknown keys rejected |
| `additionalProperties: <schema>` | – | ✓ | in `lenient` extras pass through **untyped** |
| `minProperties` / `maxProperties` | – | ✓ | |
| `items` | ✓ | ✓ | a single schema; a **tuple** (`items: [A, B]`) is refused in both modes |
| `minItems` / `maxItems` | ✓ | ✓ | |
| `uniqueItems` | – | ✓ | by **value**: `[{a:1},{a:1}]` is a duplicate, and key order is not a difference |
| `minLength` / `maxLength` | ✓ | ✓ | |
| `pattern` | – | ✓ | see the warning below |
| `format` | – | ✓ | only the listed values; **an unknown format is refused**, never ignored |
| `minimum` / `maximum` | ✓ | ✓ | |
| `exclusiveMinimum` / `exclusiveMaximum` | – | ✓ | a **number**, per draft 2020-12. The draft-04 spelling (`exclusiveMinimum: true` beside a `minimum`) is **refused** in `strict` — loudly, rather than read as a bound of `1`. In `lenient` the keyword is **ignored outright**: a schema declaring `exclusiveMinimum: 5` accepts `4` |
| `multipleOf` | – | ✓ | must be > 0 |
| `$schema` `$id` `$comment` `title` `description` `default` `examples` `deprecated` `readOnly` `writeOnly` | – | – | annotations; no validation semantics |
| `$ref` `$dynamicRef` `oneOf` `anyOf` `allOf` `not` `if`/`then`/`else` `patternProperties` `dependencies` `dependentSchemas` `dependentRequired` `unevaluatedProperties` | ✗ | ✗ | |
| anything else | ignored | ✗ | |

**`format` values enforced in `strict`:** `email`, `uuid`, `uri`, `url`, `date-time`, `date`, `time`,
`duration`, `ipv4`, `ipv6`.

> **A `pattern` is a real regular expression, and the string it runs against is model output.**
> `strict` compiles an authored `pattern` and enforces it. Catastrophic backtracking needs a vulnerable
> regex *and* a hostile input, and the input here is the least trusted value in a run. Measured on
> `^(a+)+$`: 27 characters takes 286 ms, ~40 takes minutes. Backtracking is **synchronous**, so a node
> deadline cannot interrupt it — the failure is the whole engine process.
>
> **Declare a `maxLength` beside every `pattern`.** The length bound GATES the regex: an over-long input is
> rejected without the pattern ever running. Measured on the same `^(a+)+$` with `maxLength: 8` against a
> 29-character input — 8010 ms when the two are merely chained, **0.1 ms** when the length gates first,
> which is how the compiler builds it. Without a `maxLength` the pattern runs on an input of any size and
> nothing bounds it. An anchored pattern with no nested quantifier is the other half.
>
> The residual — a `pattern` with no `maxLength` — is tracked in
> [deferred-tasks.md](../../roadmap/deferred-tasks.md) with the measurement.

> **A number is an IEEE-754 double by the time it is validated.** An `output_schema` is checked against the
> result of `JSON.parse`, so an integer beyond ±2^53 is ROUNDED before any keyword sees it: a model that
> returns `9007199254740993` is validated — and stored — as `9007199254740992`. A `const`, `enum`,
> `multipleOf` or exact boundary on such a value therefore cannot be relied on, and the engine's own output
> differs from what the model produced. Keep large identifiers as **strings**. Tracked in
> [deferred-tasks.md](../../roadmap/deferred-tasks.md).

## Bounds

Every bound fails the whole schema **closed** — none truncates, because a truncated constraint is a
validator that silently accepts the wrong value.

| bound | authored | MCP ingress |
| --- | --- | --- |
| nesting depth | 12 | 16 |
| total nodes | 1000 | 2000 |
| `enum` members | 500 | 1000 |
| object properties | 200 | 500 |
| `const`/`enum` string bytes, and a `pattern` | 4 KiB | 4 KiB (a `pattern` is not compiled in `lenient`) |
| property-name bytes | 256 | 256 |

The authored side is tighter on shape and looser on nothing: an author who needs 500 properties in one node
output has a design problem the compiler should surface rather than absorb.

## Errors never echo an authored value or a model output

A parse-time refusal names the offending keyword **only when it is a member of the published JSON-Schema
vocabulary**; an unrecognised key is text the author typed and is never echoed. Where the offending thing is
a **value** — an unsupported `type`, an unsupported `format` — the refusal lists what IS allowed instead of
quoting what was written, which is safe and also the more actionable half. A run-time conformance
failure names **neither the failing property nor any part of the output** — a property name is authored, and
model output is the least trusted value in a run, so a message quoting either would be the one place a
secret could ride out of a node failure into an event payload and a log. The cost is a terse failure; it is
the deliberate trade ([ADR-0092](../../decisions/0092-output-schema-is-validated-by-the-compiler-we-already-own.md) §5,
and the same rule [errors.ts](../../standards/error-handling.md) applies to every graph issue).
