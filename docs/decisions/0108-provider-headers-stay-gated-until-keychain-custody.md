# ADR-0108: Provider headers stay gated until keychain custody

- **Status**: Accepted
- **Date**: 2026-10-12
- **Related**: [ADR-0006](0006-os-keychain-for-api-keys.md), [ADR-0050](0050-cli-history-db-at-rest-posture.md), [ADR-0065](0065-provider-economics-and-extensibility.md)

## Context

Wave 2 G20/D13 asks for a design gate on `llm_providers.default_headers` before live
consumption. `ProviderStore.upsert` currently accepts arbitrary string values into
plaintext SQLite. No first-party production caller in the current tree supplies a
nonempty map; the identified writers are test fixtures. No shipping adapter factory
consumes them. Custom provider base URLs already ship; default-header activation
is the separately blocked portion of
ADR-0065, not permission to implement an entire header feature in this wave.

Token-shape checks miss opaque credentials. Silently migrating existing headers to
keychain would introduce cross-store failure/recovery and custody decisions not
specified by the old schema. This proposal explicitly tightens an exported store
API and requires approval before implementation.

## Decision

We will settle D13 in favour of keychain-reference custody, with shape checks only
as defence in depth, and enforce an interim admission gate now.

`ProviderStore.upsert` refuses every explicitly supplied nonempty `defaultHeaders`
map, including seemingly benign literals. Omission preserves the existing row;
`{}` explicitly clears it under the existing transactional writer convention.
The refusal is a fixed, content-free `ProviderHeaderPolicyError`, exported with a
structural guard by `@relavium/db`; it includes no header name/value or payload-bearing
cause. Its canonical specification belongs in the existing
[database reference's `llm_providers` section](../reference/shared-core/database-schema.md#llm_providers),
covering write admission, the stable error discriminant, guard and public projection.
Implement it at the provider-store boundary and publish that specification in the
same step; it does not exist yet. This changes runtime acceptance without pretending
a shape heuristic establishes non-secret data.

Existing nonempty rows remain inert and sensitive; no automatic rewrite, historical
scrub, keychain copy or physical-erasure claim is authorized. Ordinary updates must
not resurrect/rewrite cleared headers or accidentally apply historical headers to
a request. Existing `ProviderStore.get`/`list` records still return the raw legacy map
to trusted host callers; this gate does not claim to remove that exported API field.
User-facing read/admin and diagnostic projections must not start exposing it. An
executable host-factory regression proves neither new nor historical maps reach
HTTP headers.

Live header support remains prohibited until an implementation supplies all of:
explicit keychain-ref values in the exported schema; trusted-host resolution only
at egress; owned Authorization/transport-header precedence and case/duplicate
validation; content-free failure on missing/locked references; safe list/export
projections; and a reviewed legacy-row migration/recovery policy. Whether any
non-secret literal class is permitted must be explicit and testable; arbitrary
string literals are not a safe default. Reference namespace/deletion/rollback and
legacy cleanup must be settled before activation, not guessed by a wire consumer.

Wave 2 closes the requested **design and interim gate**, not the outside-phase
header feature or historical plaintext cleanup. Record that distinction in D13
and the D sign-off, retaining ADR-0050's sensitive-history warning. This is no new
deferral of a shipping feature: the old task expressly gates its future activation.

Rejected shape-check-only (opaque credentials evade it), source-only “unused” comments
(new plaintext admissions remain possible), implementing live headers first (violates
custody), and automatic cross-store migration without a recovery design. The interim
gate is intentionally stricter than the unused API and adds no runtime dependency.

On acceptance append a dated refinement to ADR-0065 and update the canonical
[database reference](../reference/shared-core/database-schema.md),
[provider seam](../reference/shared-core/llm-provider-seam.md) and
[keychain/secrets reference](../reference/desktop/keychain-and-secrets.md). Preserve
the historical ADR body. Add the exact store/error contract to the named `llm_providers`
reference section, rather than implying an error specification already exists.

## Acceptance obligations

1. Direct store tests refuse arbitrary opaque and benign nonempty maps before SQL
   mutation; the public error and cause projections never echo values.
2. Seed a genuine legacy row; omission preserves it, explicit `{}` clears it and
   later ordinary updates do not resurrect it. No test reads the user's real DB.
3. Actual first-party provider factory/SDK HTTP capture with a legacy row shows no
   custom header value transmitted. A negative control enabling consumption fails.
4. Seed a legacy header sentinel through the actual provider-list command's human
   and JSON paths and surfaced error/verbose projections: neither the raw map nor
   its names/values may appear, while ordinary provider fields remain present.
   Removing the safe projection (for example, spreading the full `ProviderRecord`)
   must break the regression. Separately pin trusted store get/list preservation;
   a passing public-output test must not be misrepresented as removal of that API data.
5. Document current sensitive legacy retention and future activation prerequisites;
   no sign-off claims historical erasure or functional keychain-ref headers.
6. Required gates plus independent secrets-at-rest/config-trust reviews pass.

## Consequences

### Positive

- New arbitrary header credentials cannot enter plaintext through the unused API.
- A future wire feature has explicit custody/migration prerequisites.

### Negative

- The exported store API loses nonempty-map admission even though no first-party
  production writer is identified. Document the deliberate compatibility tightening
  for potential external callers and preserve explicit clearing.
- Old plaintext rows remain sensitive until separately reviewed cleanup; disclose
  that existing limitation and keep them out of new consumers/output.

### Maintainer acceptance — 2026-10-12

The maintainer approved the revised decision and the eight-step Wave 2 execution
plan after the ten-comment intake and two fresh independent cumulative proposal
reviews. Dependent implementation is authorised on `development`; acceptance of
this decision does not certify unimplemented mechanisms or close the wave.

### Step 7 implementation checkpoint — 2026-10-13

The working-tree implementation adds the approved interim store admission gate,
public refusal/guard and fixed CLI error projection. The
[canonical provider-header policy](../reference/shared-core/database-schema.md#interim-provider-header-policy)
now specifies the omission/own-undefined preservation branch, explicit empty-object
clear, legacy read validation and public/wire limits. This fulfils the planned
reference authoring; the decision's earlier “does not exist yet” wording describes
its proposal checkpoint.

Existing trusted store results retain legacy headers for compatibility. The clear
is logical only; no automatic migration, keychain copy, historical scrub, new clear
command or live-header activation is included. Future activation prerequisites
remain those in this decision. Source/test gates and independent implementation
reviews remain pending; this checkpoint makes no Step 7 or whole-wave acceptance
claim.


### Step 7 implementation acceptance — 2026-10-13

The dependent interim gate is independently accepted on `development`: two NEW
clean complete cumulative rounds and all nine published jobs at implementation
head `01259d12`. The [Step 7 acceptance register](../roadmap/phases/phase-2.5.5-hardening-and-remediation.md#step-7-acceptance--2026-10-13)
joins actual store/SDK/CLI controls and complete physical evidence. Future live
header activation, legacy migration/recovery and physical erasure remain outside
this gate. Whole-wave Step 8 acceptance remains separate.


### Wave 2 implementation landing — 2026-10-13

The applicable Wave 2 implementation is accepted on `development`. The
[closing register](../roadmap/phases/phase-2.5.5-hardening-and-remediation.md#wave-2-closing-register--2026-10-13)
joins the per-item disposition, two NEW clean complete whole-wave review rounds,
security sittings, exact-source gates and preserved limits. Earlier dated pending
checkpoints remain historical. This landing does not claim a merge, future header
activation, full M/N lifecycle or removal of approved residuals.


### Wave 2 merge landing — 2026-10-15

The applicable Wave 2 implementation and maintainer corrections merged to `main`
as PR #94 (`ab08209e`). The [merge checkpoint](../roadmap/phases/phase-2.5.5-hardening-and-remediation.md#wave-2-merge-checkpoint--2026-10-15)
joins final reviewed source `4cdfe011`, review scopes, execution evidence and preserved
limits. Earlier pending/unmerged notes are historical; this landing adds no decision,
future feature, deferral or claim of merge-commit execution.
