# TypeScript Code Style

- **Status**: Accepted
- **Date**: 2026-06-03
- **Related**: [architectural-principles.md](architectural-principles.md), [tech-stack.md](../tech-stack.md), [error-handling.md](error-handling.md), [code-review.md](code-review.md)

The binding code-style rules for all TypeScript in Relavium — every package and every
surface. The stack is one language ([one-language-TypeScript](architectural-principles.md#2-one-language--typescript)),
so these rules apply uniformly. They serve the
[build-in-house](architectural-principles.md#9-build-in-house-minimize-third-party-dependencies)
principle: code we own is code we hold to a high bar.

## Strictness

- TypeScript runs in **strict mode** (`strict: true`, plus `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`, `noImplicitOverride`). The shared `tsconfig` base
  (`packages/shared`) sets this; packages extend it and do not loosen it.
- The build is **typecheck-clean**: zero `tsc` errors, zero suppressed errors. A
  `@ts-expect-error` is allowed only with a one-line justification comment and is itself
  reviewed; `@ts-ignore` is forbidden.

## No `any`

- **`any` is banned.** Use `unknown` at trust boundaries (parsed JSON, provider `raw`
  payloads, IPC input) and narrow it with a Zod schema or an explicit type guard before
  use. `unknown` forces a decision; `any` hides one.
- Do not cast your way out of a type error (`as SomeType`) except at a validated
  boundary, and prefer `satisfies` over `as` when asserting a literal's shape.
- Lint enforces this (`@typescript-eslint/no-explicit-any` as an error).

## Tooling

- **ESLint + Prettier**, configured once at the repo root and shared by every package.
  Prettier owns formatting; do not argue formatting in review — run it.
- Lint and format are CI-required (see [testing.md](testing.md)); a red lint blocks merge.
- No per-file disable of a lint rule without a justification comment naming the reason.

## Module boundaries — no vendor type across the LLM seam

This is the load-bearing rule of the in-house multi-LLM decision
([ADR-0011](../decisions/0011-internal-llm-abstraction.md)):

- **No vendor SDK type ever crosses the `@relavium/llm` seam.** Provider SDKs
  (`@anthropic-ai/sdk`, `openai`, `@google/genai`) are imported **only** inside
  `packages/llm/src/adapters/*`. The seam exposes only Relavium/Zod types — `LlmRequest`,
  `LlmMessage`, `ContentPart`, `LlmResult`, `StreamChunk`, `LlmProvider`, `LlmError`.
- `packages/core` and every surface depend on the seam types only. The engine must never
  pattern-match on a vendor chunk object or re-export a vendor enum. A provider `raw`
  payload may be carried through as `unknown` for debugging but is never typed as a
  vendor shape above the adapter.
- An ESLint boundary rule (e.g. `no-restricted-imports` / an import-zones plugin) forbids
  importing a provider SDK outside the adapter folder. Adding a vendor dependency to the
  core path requires an [ADR](../decisions/README.md) and a
  [code review](code-review.md) sign-off.
- The same discipline applies to other framework seams (DB driver, keychain, IPC): the
  vendor lives behind a Relavium interface, and only that package imports it.

## Error types

- Errors are **typed**, not bare `Error` or thrown strings. The engine and the LLM layer
  throw discriminated, classifiable error types per [error-handling.md](error-handling.md)
  (notably `LlmError` with its retryable/fatal classification). Never `throw "string"`.
- Public async functions document their failure modes via the error type they reject with;
  callers narrow on the discriminant, not on `error.message`.

## Naming

- `camelCase` for variables and functions, `PascalCase` for types/interfaces/classes,
  `UPPER_SNAKE_CASE` for true constants. No Hungarian notation; no `I`-prefix on
  interfaces.
- File names are **kebab-case** (`tool-normalizer.ts`, `anthropic-adapter.ts`), matching
  the docs [file-naming rule](documentation-style.md#3-file-and-folder-naming).
- Names match the canonical vocabulary: run events use their colon-namespaced names
  (`node:started`, `agent:token`, `cost:updated`, …) and the per-event ordinal is
  `sequenceNumber` — never `seqNo` or the legacy dotted names. Domain terms match the
  [glossary](../glossary.md).
- Prefer descriptive over terse; a name that needs a comment to explain it is the wrong
  name.

## Code shape

- Prefer pure functions and explicit data flow in the engine; side effects (IO, IPC,
  keychain, network) live at the edges, behind interfaces, so the core stays testable.
- Async over callbacks; always thread the `AbortSignal` for cancellable work (streaming,
  fallback). No floating promises (`@typescript-eslint/no-floating-promises`).
- Public package exports are explicit (a curated `index.ts`), not `export *` of internals.
