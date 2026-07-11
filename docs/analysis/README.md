# Analysis

This folder holds **research and analysis** that informs the product but is not itself a
binding spec. It answers two kinds of question: *what is the competitive landscape and
where do we win?* and *where did the design in the rest of the tree actually come from?*

It has two parts:

- **Living research** — dated analysis documents (competitive analysis, market notes).
  These carry an ISO date in the filename and may be superseded by a newer dated file.
- **`_archive/`** — the frozen raw analysis JSONs that seeded the entire `docs/` tree,
  plus a [provenance map](_archive/README.md) linking each frozen section to the living
  doc it became.

## Documents

| Document | What it is |
|----------|-----------|
| [managed-inference-business-model-2026-06-03.md](managed-inference-business-model-2026-06-03.md) | Decision analysis: BYOK vs managed inference (Relavium's own keys, metered by license). ToS/legality, competitive pricing, unit economics, gateway architecture, compliance. Led to the dual-mode decision ([ADR-0012](../decisions/0012-managed-inference-dual-mode.md)). |
| [models-dev-dynamic-catalog-enrichment-2026-07-11.md](models-dev-dynamic-catalog-enrichment-2026-07-11.md) | Design analysis: enriching the model catalog with per-model **price** + **effort/capability** data from the open `models.dev` database. Five alternatives (runtime-dynamic, vendored snapshot, hybrid, status quo, live-only) with pros/cons against local-first, cost-cap safety, and the frozen seam. Informs a future ADR extending [ADR-0064](../decisions/0064-live-model-catalog.md). |
| [_archive/README.md](_archive/README.md) | Provenance map: which living docs were seeded by which frozen raw-analysis section. The archive itself is **frozen — never edited**. |

## Conventions

- **Dated research** uses an ISO-date suffix: `managed-inference-business-model-2026-06-03.md`.
  When the analysis is redone, a new dated file is added rather than overwriting the old
  one — the dated trail is the point.
- **Analysis is not a spec.** Concrete specs (schemas, contracts, DDL, node types) live
  in their one canonical home under [reference/](../reference/README.md); analysis links
  to them rather than restating them (see
  [documentation-style.md](../standards/documentation-style.md) §6).
- **The archive is one-way and frozen.** The living tree never edits the archive, and the
  archive never gets new "current" content. See [_archive/README.md](_archive/README.md).

For where this folder sits in the overall taxonomy, see
[documentation-style.md](../standards/documentation-style.md) §4.
