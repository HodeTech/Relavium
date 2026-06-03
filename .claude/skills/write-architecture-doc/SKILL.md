---
name: write-architecture-doc
description: >
  Add or update a docs/architecture/*.md explanation that leads with a Mermaid diagram and CITES the reference/ specs rather than restating them, preserving one-canonical-home. USE FOR: explaining how a topology/flow/model is built (engine, execution, security, multi-LLM). DO NOT USE FOR: authoring an exact spec (that lives in docs/reference/), a decision (use ../write-adr/SKILL.md), or a how-to (that is docs/runbooks/).
---
# Write an Architecture Doc

## Purpose
Produce or update a `docs/architecture/*.md` doc that answers **"how is this built?"** — topology, data/control flow, the execution and security models — leading with a Mermaid diagram and then explaining it in prose. Architecture docs **cite** the canonical specs under `docs/reference/`; they never copy a YAML schema, event shape, or DDL. Duplicated specs drift, and a drifted spec is worse than none. Assumes you have read `CLAUDE.md` and `documentation-style.md`.

## When to use
- A new topology or flow exists and needs a "how it fits together" explanation (e.g. the shared-core engine, execution model, multi-LLM provider flow, local-first security model).
- An existing architecture doc is stale after a change to the system it describes.

## When not to use
- You are writing the exact contract itself (schema, SSE event, IPC, DDL, routes) — that is its one canonical home under `docs/reference/`.
- You are recording *why* a choice was made — use ../write-adr/SKILL.md (architecture docs link to ADRs, they don't relitigate them).
- You are writing a task/operational how-to — that belongs in `docs/runbooks/`.

## Inputs
| Input | Description |
|-------|-------------|
| Subject | The topology/flow/model being explained. |
| Reference specs | The `docs/reference/` files this doc must cite for concrete shapes. |
| Related ADRs | The decisions that shaped the design. |

## Workflow
1. **Confirm it is an explanation, not a spec.** If you are about to define an exact shape, stop — that goes in `docs/reference/`. Architecture explains and links.
2. **Find or create the file** under `docs/architecture/`, kebab-case (e.g. `shared-core-engine.md`, `execution-model.md`, `multi-llm-providers.md`). Add a row to `docs/architecture/README.md` if new.
3. **Open with the H1 and (optional) metadata** — single `#` title, no YAML front-matter; a `> Last updated: YYYY-MM-DD` line for a living doc.
4. **Lead with a Mermaid diagram** immediately after the H1, before prose (documentation-style §8). Mermaid only, inline fenced — no binary diagram formats.
   ```mermaid
   flowchart LR
       YAML[".relavium.yaml"] --> Parser["WorkflowYAMLParser"]
       Parser --> DAG["DAG + RunPlan"]
       DAG --> Engine["WorkflowEngine + RunEventBus"]
       Engine --> Runner["AgentRunner"]
       Runner --> Seam["@relavium/llm LLMProvider seam"]
   ```
5. **Explain the diagram in prose**, then the flow and the boundaries. Reinforce the invariants the topology depends on: engine zero-platform-imports, no vendor type across the `@relavium/llm` seam, secrets staying engine-side, the canonical `RunEvent` union.
6. **Cite specs — never restate them.** Every concrete shape is a relative link to its `reference/` home (e.g. `[run-event schema](../reference/contracts/sse-event-schema.md)`, `[node types](../reference/shared-core/node-types.md)`, `[LLM-provider seam](../reference/shared-core/llm-provider-seam.md)`). If you catch yourself pasting a schema or event body, replace it with a link.
   ```bash
   ls /Users/dev/Documents/Projects/Agent-Organizer/docs/reference/contracts/ /Users/dev/Documents/Projects/Agent-Organizer/docs/reference/shared-core/
   ```
7. **Link decisions and mark phases.** Cite the relevant ADRs for *why*; mark any Phase-2 (cloud) behavior explicitly with a bold marker or blockquote so it is never mistaken for shipped Phase-1 (documentation-style §9).
8. **Checkpoint — run ../standards-check/SKILL.md docs checks.** Confirm: one H1, no front-matter, diagram-first, relative links resolve, **no duplicated spec body**, ISO dates, Phase-2 marked. Then commit with ../commit-and-pr/SKILL.md (`docs(architecture): …`).

## Outputs
- A `docs/architecture/*.md` doc that opens with a Mermaid diagram, explains the design, cites `reference/` specs and ADRs, and marks Phase-2 content.
- An updated `docs/architecture/README.md` index row if the doc is new.

## Done criteria
- [ ] One H1, no YAML front-matter.
- [ ] A Mermaid diagram is the first content after the H1.
- [ ] Every concrete spec is cited by relative link to its `reference/` home — none restated.
- [ ] Relevant ADRs linked for the *why*.
- [ ] Phase-2 (cloud) content explicitly marked.
- [ ] Relative links resolve; ISO dates; English; kebab-case filename.
- [ ] `architecture/README.md` index updated if new.

## Common pitfalls
- Pasting a YAML schema / SSE event / DDL into the doc instead of linking its `reference/` home (the cardinal sin — it drifts).
- Putting the diagram below the prose, or using a non-Mermaid/binary diagram.
- Re-arguing a decision instead of linking the ADR.
- Letting Phase-2 cloud behavior read as shipped Phase-1.
- Adding a new doc without an index row in `architecture/README.md`.

## Related
- Style: ../../../docs/standards/documentation-style.md (§6 one-canonical-home, §8 diagram-first, §9 Phase-2 marking)
- One-canonical-home principle: ../../../docs/standards/architectural-principles.md (§7)
- Spec homes to cite: ../../../docs/reference/
- Sibling skills: ../write-adr/SKILL.md, ../standards-check/SKILL.md, ../commit-and-pr/SKILL.md
