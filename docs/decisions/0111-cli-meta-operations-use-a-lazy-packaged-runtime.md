# ADR-0111: CLI meta-operations use a lazy packaged runtime

- **Status**: Accepted
- **Date**: 2026-10-15
- **Related**: [ADR-0047](0047-cli-framework-commander-ink-clack.md), [ADR-0051](0051-cli-distribution-thin-bundle-private-engine.md) (single-output constraint partially replaced), [ADR-0105](0105-filesystem-roots-are-invocation-grants-not-project-authority.md), [ADR-0056](0056-cli-in-app-slash-command-system-and-manifest.md), [ADR-0067](0067-node-supported-floor-22-reaffirm-better-sqlite3.md), [ADR-0071](0071-models-dev-as-the-model-metadata-source.md), [ADR-0072](0072-model-metadata-in-the-db-behind-a-generated-offline-floor.md), [ADR-0103](0103-a-paused-run-hands-off-its-local-producers-before-its-host-closes.md), [ADR-0109](0109-native-media-close-ownership-is-explicit-iterator-provenance.md), [ADR-0110](0110-cli-diagnostics-and-discovery-have-explicit-compatibility.md), [Wave 3](../roadmap/current.md#wave-3--clear-the-ground)

## Context

At baseline `702cdc9c`, program → specs → dispatch imports native/DB/provider/TUI
implementations, while errors and sanitization reach engine barrels. Deferring
Home alone cannot make help/version lightweight. #43/#44/#271 require correcting
the actual graph, including early crash handling. The single-output guard blocks
real deferred ESM chunks.

#46 requires useful release symbolication. All five engine packages currently
compile with sourceMap false and their exports point to compiled JS. A final CLI
map alone cannot map engine frames to TypeScript. Release also builds the CLI
before pnpm pack; prepack rebuilds it with clean output. tsup adds map-link trailers
even when esbuild is told to emit external maps. The prior abstract no-rebuild
rule therefore lacked an executable packing path.

The repository is public. Its source layout and symbol names are not secret;
ADR-0051 expressly relies on licensing/obfuscation rather than secrecy. The
maintainer selected encrypted CI archival on 2026-10-15 as a **distribution and
custody policy**: release debugging material stays out of npm and public plaintext
artifacts. This neither hides public source nor requires making the repo private.

All mechanisms remain Proposed. Exact artifact shapes and operational states live
in [CLI packaging](../reference/cli/packaging.md), with release procedures in the
[release runbook](../runbooks/release-a-surface.md). No runtime dependency/version
bump, production recipient, upload or publication is authorized.

## Decision

### Lazy graph and catalog authority

Package one executable ESM entry plus a finite flat set of ESM runtime chunks.
Only the single-output constraint changes: engine code stays inlined, engine
packages private, third-party runtime dependencies external and declared.

Use ADR-0110's single pure descriptor/grammar authority. Early flag policy,
local error class/exits and invocation-owned shutdown registry import no runtime
classifier, native service or engine barrel. Extract/share minimal sanitization
through a supported pure module rather than duplicate or weaken redaction.
Runtime classification and command executors load dynamically under the early
failure boundary; MCP version wiring moves before actual client construction.
Splitting must not duplicate the registry, media iterator WeakMap or other
authority-bearing module state. Do not treat tree shaking as source proof.

Meta help/version/bare noninteractive help reads no config/cache, admits no
filesystem grants and opens no DB/keychain/MCP/provider/TUI. Validate grammar
without a second argv parser. Skipping directory existence/link/permission admission
for meta operations is a deliberate ADR-0105 refinement: an absent root no longer
blocks help, while pure syntax/count/size checks remain. No grant is minted.
New JSON-help integration lands after the descriptor
and lazy graph; the earlier increment only certifies implemented meta operations.

For execution distinguish **filesystem grant admission** from model/cost admission.
Preserve current order: filesystem admission, one invocation-owned
`seedFileCatalogOnce()` gate for commands needing pricing, current DB catalog
overlay at its owner, then first capability/quote/
budget/egress read. A late file seed must never replace authoritative DB long-tail
prices. Preserve ADR-0072's offline floor, empty-DB non-erasure and no-startup-fetch
rules and media maintenance's no-config/cache/DB exception. Home/slash/resume
transitions share that owner and cannot reinstall an older file overlay. The
canonical owner inventory includes quote-only opens and offline fixture exceptions.

Inspect every emitted JS output and its static/dynamic imports. Closure rejects
missing/escaping chunks, unbundled internal packages and undeclared externals;
shipped and emitted finite graphs must agree. Flat layout preserves migration
relative paths. Required PR/push CI installs the exact same tarball on supported
OSes and the declared minimum runtime, then release CI reuses that mechanism.

### One build, exact maps and retryable custody

Emit external upstream TypeScript maps only in a fresh isolated, uncached
candidate build, without embedded sources. Ordinary workspace builds remain
map-free. The canonical contract gives executable dependency-build overrides,
prepack map selection/finalization and an entry-only shebang/mode inventory.
No Actions/Turbo/remote build-cache read/write or later broad cache
capture may include upstream/final maps, private manifests or staging. The final bundler chains them to original TypeScript; do not substitute
source aliases or claim a decrypt test proves engine symbolication.

Make **prepack the sole final CLI build** after dependency builds. Finalize tsup
output before hashing: remove only its known trailing map links, move maps/build
metadata outside the public package, verify complete closure and retain exact JS.
Then inspect the actual tarball against finalized bytes and seal the private map
manifest. Never build, rewrite or pack again as a retry for that candidate.

Use vetted GnuPG recipient encryption as release tooling. The selected public key,
primary/subkey fingerprints, validity, isolation and rotation policy are explicit;
private keys never enter CI/repo. Encryption is randomized and does not authenticate
the producer. Encrypt once and retain the original ciphertext, tarball and small
nonsecret binding receipt. The private per-source manifest stays inside ciphertext.
Public source/build identity and hashes are allowed in the binding receipt;
maps, source content and private per-source inventories are not.

Separate required package-test and actual release modes. PR/push/manual dry-runs
verify the exact pack and maps locally, discard private outputs and share only
tarball plus public package-test identity; no production recipient is needed.
Synthetic GPG controls use synthetic maps only. A package-test artifact is not
promoted after its maps are discarded. A trusted tag creates its own original
release candidate once, requiring production encryption in that originating pack
job before handoff; missing custody cannot downgrade to test mode.

Use one explicit trusted-tag custody graph: admission → permissioned candidate
discovery/reservation → fresh pack or exact reuse → smoke → archive → npm publish
→ Release finalization. Discovery precedes **every** product build, including an
all-jobs rerun. A native failed-jobs rerun cannot reuse stale fresh discovery
output to build: same-attempt admission refuses it. Reuse/downstream retries verify
the complete original candidate, not new map checks. It can see drafts and originating run/attempt artifacts; permission,
pagination or missing-history uncertainty is not “fresh”. Reserve a draft candidate
identity before its first build; interrupted/lost staging cannot become permission
to create different same-version bytes. Recover original tarball/ciphertext/receipt,
fill only absent matching assets and refuse conflicts or unrecoverable expiry.
Never make encryption deterministic or re-encrypt to imitate prior custody.

The canonical contract assigns each job, token capability, durable state and rerun
mode. Only discovery, archive and finalization get narrowly scoped Contents write;
cross-run retrieval gets Actions read in discovery. Builds do not receive Release
write or npm credentials. Publish retains only read plus existing provenance
permission and consumes verified staged tarball/archive receipt; finalization is
a separate post-publish writer. Workflow defaults deny unspecified permissions.
Only real trusted pushed tags with version/main-ancestry checks can mutate Releases
or publish. Manual dispatch, even against a tag, remains dry-run with separate
concurrency. Existing repository Release immutability is not assumed.

A dedicated crypto/recipient/CI-custody security sitting validates this path.
Fixture-key controls use synthetic maps only; do not upload product maps under a
public test private key. Production recipient/backup/retention configuration is
an actual-release prerequisite in Wave 4b, not a credential needed for proposal
review. Future releases fail closed without it. Rotation applies prospectively;
supported old archives require retained offline decryption capability, and public
ciphertext cannot be recalled by revoking a key. No automatic archive deletion
is introduced.

Considered retaining one file and deferring only Home: rejected because the graph
remains eager. Considered separate published engine packages: rejected by the
distribution boundary. Considered public source-free maps: technically possible
for this public repo, but contrary to the selected archive policy, **not** because
public source names would become newly secret. Considered deterministic encryption
or rebuilding on retry: rejected because cryptographic randomness and exact-byte
release identity must be preserved. The selected archive protects distribution/
custody, not secret source. Its release-availability cost is explicit; reconsider
proportionality with the maintainer if this policy or release/debugging needs change,
not by silently weakening a failed release gate.

### Acceptance and landing

1. Packed existing meta operations have static reachability plus native throwing
   service witnesses, including early diagnostics/sanitization. Measure against
   the same current baseline; historical ~400 ms is not a fresh threshold.
2. Required packed platform/minimum-runtime controls cover real run/chat fixtures,
   native loading, migrations, MCP version, CAS and shared iterator/registry identity.
   The required aggregate rejects missing/skipped/cancelled platform legs. Actual
   installed chat uses an external test transport, not a fictitious chat fixture flag
   or replaced inlined session implementation.
   Catalog order tests include file-only, empty/torn DB, authoritative DB tail,
   repeated Home/resume and media exceptions before first capability/budget read.
3. Missing/escaping chunks, external engine imports and undeclared dependencies
   break closure. Actual tarball inspection rejects public maps/source/metafiles/
   manifests/map links and compares every packed JS digest with finalized outputs.
4. Exact packed CLI **and engine** frames map to the expected original TS locations
   using the matching source revision. Wrong map/JS/source, an upstream missing map
   and a post-receipt rebuild fail; sourcesContent is absent throughout.
5. Synthetic GPG and archive/API controls cover recipient isolation/expiry/rotation,
   encryption failure, retry/partial upload/conflict/expired staging and archive
   before publish, finalization, all-jobs/failed-jobs/cross-run reruns and exact
   npm-already-published bytes. The same state controller uses permission-enforcing
   fake API controls; no live release/tag is needed for Wave 3. No plaintext fallback
   or false production-custody claim.
6. Split lazy graph, fatal integration and archival into distinct reviewed
   increments. Rerun affected packed gates after later CLI/DB edits and at final
   whole-wave head. Two new independent complete cumulative clean rounds follow
   each final material fix. At acceptance append partial-replacement notes to
   ADR-0047/0051, their Status/index partial annotations, and refinements to
   ADR-0056/0071/0072/0103/0105/0109 before code; land
   canonical references/runbook and actual configuration status separately.

## Consequences

### Positive

- Meta operations avoid unrelated services by construction and retain one grammar.
- Exact published bytes can be symbolicated to original public-source revisions.

### Negative

- Multiple files require complete graph, identity and exact-tarball platform gates.
- Encrypted archive policy adds a release availability dependency despite public
  source. Explicit backup/rotation/retry and recovery rules bound that tradeoff;
  missing production custody blocks release, not document review.

## Maintainer acceptance — 2026-10-16

The maintainer approved this final decision, its linked unshipped canonical
contracts and the nineteen-increment Wave 3 plan. Earlier proposal wording above
records the review stage; approval is complete. Implementation, independent
review gates and canonical promotion remain staged in that plan. Acceptance
does not claim shipping behaviour, an actual release or production custody setup.

## Compiled-graph implementation staging — 2026-10-16

The approved Step 7 is split into 7a (guarded lazy runtime, offline catalog order
and every-output emitted closure) and 7b (independent installed-tarball and required
platform/minimum-runtime controls), preserving every original obligation. Step 7a
implementation is present on `development`; independent reviews remain required.
The [canonical packaging contract](../reference/cli/packaging.md#compiled-graph-implementation-boundary--step-7a)
records the implemented boundary and remaining gates. Existing error and sanitizer
identities have supported pure leaves; no new runtime dependency or security policy
is introduced. Context/module continuity does not claim the native registered-owner
integration assigned to Step 8. Original-TS maps and custody remain Step 9. Neither
this note nor local compiled controls close whole Step 7 or claim a new release.
