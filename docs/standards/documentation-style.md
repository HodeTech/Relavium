# Documentation Style

> Last updated: 2026-06-03

This is the binding style guide for everything under `docs/`. It is the Relavium
equivalent of a CONTRIBUTING guide for documentation. Every file in the tree —
including this one — follows these rules, and new files are expected to be **born
compliant** (there is no separate formatting cleanup pass; see
[architectural-principles.md](architectural-principles.md)).

These conventions are deliberately identical to the house style used across the
author's other repositories (MarkdownViewer, OS-Project, Saydın, Leakwatch, and the
rest), so a contributor who knows one repo's docs already knows this one's.

## 1. No front-matter — H1 plus bold metadata

Files do **not** use YAML front-matter. Every file starts with a single `#` H1 title
and nothing above it. Metadata, when needed, goes in bold key lines directly under the
H1:

```markdown
# ADR-0007: Desktop is not an IDE

- **Status**: Accepted
- **Date**: 2026-06-03
- **Related**: [product-constraints.md](../product-constraints.md)
```

Living documents that need to advertise their freshness add a single blockquote line
directly under the H1:

```markdown
# Documentation Style

> Last updated: 2026-06-03
```

Reference specs, ADRs, runbooks, and tutorials use bold metadata lines as appropriate
(Status, Date, Related, Phase). Indexes and short notes may have no metadata block at
all — just the H1 and the prose.

## 2. One H1 per file

Exactly one `#` heading, and it is the first line. Everything else is `##` and deeper.
The H1 is the document's canonical title and should match the intent of the filename.

## 3. File and folder naming

- Filenames are **kebab-case**, English, ending in `.md`:
  `local-dev-setup.md`, `multi-llm-providers.md`.
- ADRs are zero-padded four digits plus a slug: `0001-tauri-v2-over-electron.md`.
- Dated analysis docs suffix an ISO date:
  `managed-inference-business-model-2026-06-03.md`.
- Review records use a full ISO timestamp slug (see
  [reviews/README.md](../reviews/README.md)):
  `YYYY-MM-DDTHH-MM-SS-<slug>-review.md`.
- Every subfolder has a `README.md` that indexes its contents.

## 4. Folder taxonomy

The tree is organized by **the kind of question a reader is asking**, not by which
subsystem the answer touches. Two axes run through it: a **type axis** (vision →
architecture → reference → tutorial/runbook → standard → analysis) and a **surface
axis** (shared-core, desktop, cli, vscode, portal).

| Folder | Answers |
|--------|---------|
| `README.md`, `glossary.md`, and the flat product docs (`vision.md`, `product-constraints.md`, `uvp.md`, `tech-stack.md`, `project-structure.md`, `deployment-models.md`, `roadmap/README.md`) | What is Relavium and why? |
| [architecture/](../architecture/README.md) | How is it built? Topology, flow, the security and execution models. |
| [reference/](../reference/README.md) | Exact specs: YAML schemas, SSE events, IPC contract, DB DDL, node types, tools, routes. The one canonical home for every artifact. |
| [tutorials/](../tutorials/README.md) | Learning-oriented walkthroughs ("build your first workflow"). |
| [runbooks/](../runbooks/README.md) | Task-oriented how-tos ("set up local dev", "add a provider key"). |
| [decisions/](../decisions/README.md) | Why a choice was made. Numbered ADRs in MADR format. |
| [standards/](README.md) | How things must be written and built. Binding rules. |
| [analysis/](../analysis/README.md) | Research, competitive analysis, and the frozen `_archive/` provenance. |
| [compliance/](../compliance/README.md) | Legal/regulatory posture for managed mode: provider ToS, data protection (KVKK/GDPR), tax & billing, security / SOC 2. *(Phase 2.)* |
| [ideas/](../ideas/README.md) | Out-of-scope or future idea notes, explicitly not committed work. |
| [reviews/](../reviews/README.md) | Timestamped review records. |

## 5. Links

- Internal links are **relative Markdown paths** only — they must resolve on GitHub.
  Example: `[tech-stack.md](../tech-stack.md)`,
  `[workflow YAML spec](../reference/contracts/workflow-yaml-spec.md)`.
- Never use absolute internal URLs.
- External URLs (Tauri, the provider SDK docs — Anthropic / OpenAI / Google — and
  similar) may be absolute and inline.
- Prefer linking to a doc's H1 or a stable `##` anchor over deep link chains.
- On first use of a domain term, link back to [glossary.md](../glossary.md).

## 6. One canonical home per artifact

Every concrete spec lives in **exactly one** file under `reference/` and is cited from
everywhere else. The list of single-home artifacts:

- Workflow YAML → `reference/contracts/workflow-yaml-spec.md`
- Agent YAML → `reference/contracts/agent-yaml-spec.md`
- AgentSession contract → `reference/contracts/agent-session-spec.md` (its `session:*` events are owned by `reference/contracts/sse-event-schema.md`, and its `agent_sessions` / `session_messages` tables by `reference/desktop/database-schema.md` — the spec cites both, never restates them)
- SSE event schema → `reference/contracts/sse-event-schema.md`
- IPC contract → `reference/contracts/ipc-contract.md`
- Config spec → `reference/contracts/config-spec.md`
- Store shapes → `reference/shared-core/store-shapes.md`
- Node types → `reference/shared-core/node-types.md`
- Built-in tools → `reference/shared-core/built-in-tools.md`
- MCP integration → `reference/shared-core/mcp-integration.md`
- Database schema (DDL) → `reference/desktop/database-schema.md`
- Keychain / secrets → `reference/desktop/keychain-and-secrets.md`
- Tauri plugins → `reference/desktop/tauri-plugins.md`
- Routes / screens → `reference/desktop/routes-and-screens.md`
- CLI commands → `reference/cli/commands.md`
- VS Code extension API → `reference/vscode/extension-api.md`
- Portal API (Phase 2) → `reference/portal/api-reference.md`

Architecture docs, tutorials, and runbooks **cite** these by relative link. They never
copy a spec body. If you find yourself pasting a YAML schema or an SSE event shape into
a second file, stop and link instead. Duplicated specs drift, and a drifted spec is
worse than no spec.

## 7. ADRs (English MADR)

ADRs record *why* a non-trivial choice was made. They live in
[decisions/](../decisions/README.md), are named `NNNN-kebab-slug.md`, and follow the
template in [adr-template.md](adr-template.md). Required structure:

```markdown
# ADR-NNNN: Title

- **Status**: Proposed | Accepted | Deprecated | Superseded by [ADR-XXXX](xxxx-...md)
- **Date**: YYYY-MM-DD
- **Related**: [ADR-XXXX](xxxx-...md), [product-constraints.md](../product-constraints.md)

## Context

## Decision

## Consequences
### Positive
### Negative
```

This is the condensed MADR form the whole `decisions/` corpus uses: the
alternatives that were weighed are written *inside* `## Decision` (with a short
"considered: A vs B vs C — chose X because…" paragraph), and pinned versions are
linked to [tech-stack.md](../tech-stack.md) rather than restated. A fuller MADR
variant (separate `## Decision drivers` / `## Considered options` /
`## Decision outcome` / `## References` sections) is acceptable for an unusually
contested decision, but keep one ADR's shape consistent and prefer the condensed
form for the common case.

Rules:

- ADRs cross-link sibling and superseding ADRs. Superseded ADRs are never deleted or
  rewritten — the historical reasoning is the point. Mark them
  `Superseded by [ADR-XXXX](...)` and link forward.
- **Amend vs. supersede.** ADR history is append-only (CLAUDE.md rule 9). An **Accepted**
  ADR may be **amended in place** only for a change that *refines, clarifies, corrects, or
  reconciles* it **without reversing the decision** (e.g. a later ADR refines its mechanism):
  record the change as a dated `> Amended YYYY-MM-DD: …` blockquote note that points to the
  driving ADR, and keep the original text annotated — never silently rewritten. A change that
  **reverses or replaces** a decision is not an amendment — write a new ADR and mark the old
  one `Superseded by [ADR-XXXX](...)`. The dated note is what keeps an in-place edit
  honest history rather than a quiet rewrite.
- ADRs reference [tech-stack.md](../tech-stack.md) for pinned versions instead of
  restating version numbers, so versions have one home.
- ADR numbers are stable history and are never renumbered.

## 8. Architecture docs lead with a diagram

Wherever a topology or flow exists, an architecture doc opens with a **Mermaid**
diagram immediately after the H1, then explains it in prose. Diagrams are Mermaid only,
embedded as inline fenced code blocks — no binary diagram formats. Tables and Mermaid
are encouraged throughout the tree.

## 9. Mark Phase-2 content explicitly

Relavium ships in two phases (see [roadmap/README.md](../roadmap/README.md)). Phase 1 is local-first
with zero cloud. Phase 2 adds cloud execution and the web portal. Any content
describing Phase-2 behavior MUST be **explicitly labeled** so a reader never mistakes
unbuilt cloud features for shipped Phase-1 behavior. Use a bold inline marker or a
blockquote:

```markdown
> **Phase 2 (cloud).** Scheduled triggers run on cloud workers — not available in the
> local-first Phase 1 build.
```

## 10. Dates and language

- All dates are **ISO 8601** (`YYYY-MM-DD`). The seed date for this tree is
  `2026-06-03`.
- All documentation is in **English**.

## 11. Where new artifacts go

| You are writing… | It goes in… |
|------------------|-------------|
| A new exact spec (schema, contract, DDL, route list) | `reference/<surface>/` or `reference/contracts/`, as its one canonical home |
| The reasoning behind a non-trivial choice | a new numbered ADR in `decisions/` |
| A "how is this built" explanation | `architecture/` |
| A "how do I set up / operate X" procedure | `runbooks/` |
| A "learn by doing X end-to-end" walkthrough | `tutorials/<surface>/` |
| Dated research or a competitor comparison | `analysis/` |
| A managed-mode legal/regulatory posture (provider ToS, data protection, tax & billing, SOC 2) | `compliance/` *(Phase 2)* |
| A future / out-of-scope idea | `ideas/` |
| A binding rule | `standards/` |
| A review record | `reviews/` (timestamped filename) |

When in doubt, pick the folder whose **question** matches what the reader will be
asking when they open the file.
