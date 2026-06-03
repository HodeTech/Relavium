---
name: supersede-adr
description: >
  Supersede an existing Accepted ADR by writing a new one, flipping the old Status to "Superseded by", and repointing live references — never deleting or rewriting the old body. USE FOR: overriding a settled decision, reversing a prior choice, replacing one approach with another. DO NOT USE FOR: a first-time decision (use ../write-adr/SKILL.md) or a typo/clarity fix to an existing ADR (ADRs are append-only history, not living docs).
---
# Supersede an ADR

## Purpose
Change a settled Relavium decision the only sanctioned way: write a **new** ADR that supersedes the old one, mark the old one `Superseded by [ADR-NNNN]`, add a forward-pointer, and repoint the *live* references that should now follow the new decision. The old reasoning is preserved verbatim — the historical record is the whole point. The worked precedent is **0004 → 0011** (the Vercel AI SDK choice was superseded by the internal `@relavium/llm` abstraction); mirror it.

## When to use
- An Accepted ADR's decision is being reversed or replaced.
- A "named trigger" inside an existing ADR fires and mandates a follow-up ADR (e.g. the ADR-0011 reversible-bridge trigger).

## When not to use
- Recording a brand-new decision with no prior ADR — use ../write-adr/SKILL.md.
- Fixing a typo or broken link in an old ADR — that is a docs fix, but never alter the *decision content* of a superseded ADR.
- The change is to a spec, not a decision — that lives in `docs/reference/`.

## Inputs
| Input | Description |
|-------|-------------|
| Old ADR | The Accepted ADR being superseded (number + slug). |
| New decision | The replacement decision and the alternatives reweighed from scratch. |
| Live references | Files that cite the old ADR as the current rule and must repoint. |

## Workflow
1. **Write the new ADR first** with ../write-adr/SKILL.md (next free number, Accepted when settled). In its `Related` line, list the old ADR with a `(supersedes)` note, and in `Context` open by stating it supersedes ADR-XXXX and *why the prior choice is withdrawn* — exactly as 0011 opens against 0004.
2. **Flip the old ADR's Status — do not touch its body.** Change only the metadata line:
   ```
   - **Status**: Superseded by [ADR-0012](0012-new-slug.md)
   ```
   Leave Context / Decision / Consequences exactly as they were.
3. **Add a forward-pointer note** to the old ADR's `Related` line (e.g. `[0012-new-slug.md](0012-new-slug.md) (supersedes this)`) so a reader landing on the old file is sent forward. Do not delete the old cross-links.
4. **Update the decisions index.** In `docs/decisions/README.md` set the old row's Status to `Superseded by NNNN` and add the new ADR's row.
   ```bash
   grep -rn "0004-vercel-ai-sdk-multi-llm" /Users/dev/Documents/Projects/Agent-Organizer/docs/decisions/README.md
   ```
5. **Repoint live references — surgically.** Find every cite of the old ADR; repoint the ones that present it as the *current rule* (CLAUDE.md, standards, roadmap, architecture) to the new ADR. **Leave historical mentions intact** (the new ADR's own "supersedes 0004" link, and any narrative about how the design evolved).
   ```bash
   grep -rn "0004-vercel-ai-sdk-multi-llm\|ADR-0004" /Users/dev/Documents/Projects/Agent-Organizer/docs /Users/dev/Documents/Projects/Agent-Organizer/CLAUDE.md
   ```
   For each hit decide: live rule (repoint) vs history (keep). When unsure, keep and note it.
6. **Checkpoint — the old body is byte-for-byte unchanged below its metadata.** Diff to confirm only the Status/Related lines moved.
   ```bash
   git -C /Users/dev/Documents/Projects/Agent-Organizer diff -- docs/decisions/0004-vercel-ai-sdk-multi-llm.md
   ```
7. **Run ../standards-check/SKILL.md** then commit with ../commit-and-pr/SKILL.md: `docs(decisions): supersede ADR-0004 with ADR-0012` and a body naming both numbers + a `Refs: ADR-0012` trailer.

## Outputs
- A new Accepted ADR that supersedes the old one.
- The old ADR with `Superseded by` Status + a forward-pointer, body untouched.
- Index table and live references repointed; history left intact.

## Done criteria
- [ ] New ADR written, Accepted, and explains in Context why the old choice is withdrawn.
- [ ] Old ADR Status is `Superseded by [ADR-NNNN](...)`; its Context/Decision/Consequences are byte-for-byte unchanged.
- [ ] Old ADR has a forward-pointer to the new one.
- [ ] README index updated for both rows.
- [ ] Live references repointed; historical mentions deliberately preserved.
- [ ] No ADR renumbered or deleted.

## Common pitfalls
- Editing the superseded ADR's Decision/Consequences "to keep it accurate" — never; that erases history.
- Blanket find-replacing every `ADR-0004` mention and breaking the new ADR's own supersedes link.
- Forgetting the forward-pointer, stranding readers on the dead decision.
- Reusing the old number or renumbering — numbers are stable history.

## Related
- Append-only rule: ../../../docs/standards/documentation-style.md (§7), ../../../docs/decisions/README.md
- Worked example (0004→0011): ../../../docs/decisions/0011-internal-llm-abstraction.md, ../../../docs/decisions/0004-vercel-ai-sdk-multi-llm.md
- Sibling skills: ../write-adr/SKILL.md, ../commit-and-pr/SKILL.md, ../standards-check/SKILL.md
