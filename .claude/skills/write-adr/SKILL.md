---
name: write-adr
description: >
  Author a new Architecture Decision Record in docs/decisions/ using the condensed MADR form and update the index. USE FOR: recording a settled non-trivial architectural/product/process decision, adding a new runtime dependency, justifying a stack or seam choice. DO NOT USE FOR: replacing an existing Accepted decision (use ../supersede-adr/SKILL.md), restating a spec (that belongs in docs/reference/), or scoping a unit of work (use ../start-task/SKILL.md).
---
# Write an ADR

## Purpose
Record *why* a non-trivial Relavium decision was made so future contributors can follow the reasoning and disagree by writing a new ADR rather than silently changing code. This skill produces one append-only ADR file in `docs/decisions/` in the condensed MADR form the whole corpus uses, and registers it in the index table. It assumes you have read `CLAUDE.md` and the relevant standards.

## When to use
- A decision touches more than one surface, the shared engine, or product scope/phasing.
- You are about to add a new runtime dependency to the core path (this *requires* an ADR — see architectural-principles §9).
- You are choosing between real alternatives and the loser deserves to be remembered.

## When not to use
- The decision overrides an already-Accepted ADR — use ../supersede-adr/SKILL.md.
- The artifact is a concrete spec (YAML schema, SSE event, IPC, DDL) — that has one canonical home under `docs/reference/`.
- It is a Phase-2 cloud-backend-internal decision — that belongs in the reserved `relavium-cloud/` ADR space, not here (see ../../../docs/decisions/README.md §"Two ADR spaces").

## Inputs
| Input | Description |
|-------|-------------|
| Decision statement | The plain "we will do X" you are recording. |
| Alternatives | The options weighed and why each lost. |
| Related ADRs / constraints | Sibling ADRs and the product-constraints / principles clauses that frame it. |
| Settled? | Accepted if the decision is made (the common case); Proposed only if genuinely open. |

## Workflow
1. **Confirm it is a product ADR and not a supersede.** If it overrides an Accepted ADR, stop and use ../supersede-adr/SKILL.md instead. If it is cloud-internal, it is out of this repo's number space.
2. **Pick the next free number.** Numbers are zero-padded 4 digits and never reused or renumbered.
   ```bash
   ls /Users/dev/Documents/Projects/Agent-Organizer/docs/decisions/ | grep -E '^[0-9]{4}-' | sort | tail -1
   ```
   Take the highest and add one (the current head is `0011`, so a new ADR is `0012`).
3. **Copy the template** into the new file and rename with a kebab slug:
   ```bash
   cp /Users/dev/Documents/Projects/Agent-Organizer/docs/standards/adr-template.md \
      /Users/dev/Documents/Projects/Agent-Organizer/docs/decisions/0012-your-slug.md
   ```
4. **Fill the H1 and metadata.** `# ADR-0012: Title`, then bold `Status` / `Date` (ISO 8601, e.g. `2026-06-03`) / `Related` lines linking sibling ADRs and the framing `product-constraints.md` / `architectural-principles.md` clauses by relative path. Set Status to **Accepted** when settled; do not do a ceremonial Proposed→Accepted round-trip.
5. **Write Context.** The situation, problem, constraints (engine-first TS, local-first Phase 1, desktop-is-not-an-IDE, git-native YAML), and the stakes of getting it wrong.
6. **Write Decision.** State "we will do X" plainly, then walk the alternatives inline: "Considered A (rejected: …), B (rejected: …); chose X because …". **Do not restate pinned versions** — link `../tech-stack.md` so versions keep one home. **Cite specs, never paste them** — link the `docs/reference/` file.
7. **Write Consequences** split into `### Positive` and `### Negative`, each negative paired with how you live with or mitigate it.
8. **Update the index.** Add a row to the table in `docs/decisions/README.md` (`| 0012 | [Title](0012-your-slug.md) | Accepted | 2026-06-03 |`) in numerical order.
9. **Checkpoint — self-review against the standards.** Run ../standards-check/SKILL.md mentally: one H1, no front-matter, relative links resolve, no spec duplication, versions linked not restated, Phase-2 content explicitly marked. Confirm a new dependency (if any) is the subject of *this* ADR.
10. **Commit** with ../commit-and-pr/SKILL.md: `docs(decisions): add ADR-0012 <topic>` and a `Refs: ADR-0012` trailer.

## Outputs
- A new `docs/decisions/NNNN-your-slug.md` in condensed MADR form.
- An updated index row in `docs/decisions/README.md`.

## Done criteria
- [ ] Next free 4-digit number used; no renumbering of existing ADRs.
- [ ] H1 + bold Status/Date/Related; Status is Accepted when settled.
- [ ] Context / Decision / Consequences (Positive + Negative) all present.
- [ ] Alternatives are written inside Decision with the reason each lost.
- [ ] Versions reference ../tech-stack.md; no spec body is restated (reference/ is cited).
- [ ] Index table in README.md updated, in order.
- [ ] Any new runtime dependency is justified by this ADR.

## Common pitfalls
- Restating version numbers instead of linking `tech-stack.md`.
- Pasting a YAML/event/DDL spec into the ADR instead of linking its `reference/` home.
- Forgetting the README index row (the ADR then "doesn't exist" to navigation).
- Doing a Proposed→Accepted round-trip for an already-settled decision.
- Filing a cloud-backend-internal decision in this repo's number space.

## Related
- Template: ../../../docs/standards/adr-template.md
- ADR rules & index: ../../../docs/decisions/README.md, ../../../docs/standards/documentation-style.md (§7)
- Principles (when a dep needs an ADR): ../../../docs/standards/architectural-principles.md (§9)
- Worked supersede example: ../../../docs/decisions/0011-internal-llm-abstraction.md
- Sibling skills: ../supersede-adr/SKILL.md, ../commit-and-pr/SKILL.md, ../standards-check/SKILL.md
