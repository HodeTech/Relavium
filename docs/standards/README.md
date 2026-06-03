# Standards

This folder holds the **binding rules** for the Relavium documentation tree and the
engineering principles that govern how the platform is built. Unlike
[architecture/](../architecture/README.md) (which explains *how* the system is
designed) or [decisions/](../decisions/README.md) (which records *why* a choice was
made), standards answer **how things must be written and built here**. They are
prescriptive, not descriptive.

If a pull request violates a standard in this folder, the standard wins — change the
PR, or write an [ADR](../decisions/README.md) that supersedes the standard.

## Documents

### Documentation and decisions

| Document | Binds |
|----------|-------|
| [documentation-style.md](documentation-style.md) | Every Markdown file in `docs/`: folder taxonomy, the no-front-matter / H1-plus-bold-metadata rule, kebab-case naming, relative links, ADR format, the one-canonical-home rule, Mermaid usage, Phase-2 marking, ISO dates. This is the docs CONTRIBUTING guide. |
| [adr-template.md](adr-template.md) | The canonical blank template to copy when writing a new Architecture Decision Record. |
| [architectural-principles.md](architectural-principles.md) | The non-negotiable engineering principles: engine-first build order, one-language TypeScript, local-first, desktop-is-not-an-IDE, build-in-house / minimize third-party deps, one-canonical-home, born-compliant docs. |

### Engineering standards

| Document | Binds |
|----------|-------|
| [code-style-typescript.md](code-style-typescript.md) | All TypeScript: strict mode, no-`any` policy, ESLint/Prettier, the no-vendor-type-across-the-LLM-seam module boundary, typed errors, naming. |
| [error-handling.md](error-handling.md) | Typed/discriminated errors, the `LlmError` retryable-vs-fatal classification the fallback chains depend on, no silent catches, user-facing vs internal errors. |
| [testing.md](testing.md) | Vitest unit tests (`packages/core` + `packages/llm`), per-provider conformance tests (fixtures on PR, live nightly), Playwright desktop e2e, coverage expectations, engine-first test discipline. |
| [code-review.md](code-review.md) | The review checklist: correctness, security, performance, no new third-party dependency without an ADR, the LLM seam, canonical-home docs. |
| [commit-style.md](commit-style.md) | Conventional Commits, scope per package, references to the ADR a change implements. |
| [security-review.md](security-review.md) | The security checklist: keys never leave the keychain / never reach the frontend, no plaintext, SSRF on custom base URLs, the `run_javascript` sandbox, prompt-injection posture, never hand-roll crypto. |
| [logging-and-observability.md](logging-and-observability.md) | Structured logging, no secrets in logs, the run-event stream as the observability backbone, local-first with no telemetry without consent. |

## How these relate to the rest of the tree

- New docs MUST be born compliant with [documentation-style.md](documentation-style.md).
  There is no "fix the formatting later" pass.
- New ADRs MUST start from [adr-template.md](adr-template.md) and follow the English
  MADR format codified there.
- Code and design proposals MUST respect
  [architectural-principles.md](architectural-principles.md). A proposal that breaks a
  principle needs an ADR, not a quiet exception.
- All TypeScript MUST follow [code-style-typescript.md](code-style-typescript.md) and
  [error-handling.md](error-handling.md), ship the tests required by
  [testing.md](testing.md), and pass the [code-review.md](code-review.md) and (where it
  applies) [security-review.md](security-review.md) checklists before merge.
- Commits follow [commit-style.md](commit-style.md); logging follows
  [logging-and-observability.md](logging-and-observability.md).

For the project-wide vocabulary these standards assume, see the
[glossary](../glossary.md).
