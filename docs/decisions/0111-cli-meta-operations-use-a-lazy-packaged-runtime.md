# ADR-0111: CLI meta-operations use a lazy packaged runtime

- **Status**: Proposed
- **Date**: 2026-10-15
- **Supersedes (partial)**: [ADR-0047](0047-cli-framework-commander-ink-clack.md) and [ADR-0051](0051-cli-distribution-thin-bundle-private-engine.md), single-output packaging constraint
- **Related**: [ADR-0056](0056-cli-in-app-slash-command-system-and-manifest.md), [ADR-0067](0067-node-supported-floor-22-reaffirm-better-sqlite3.md), [ADR-0071](0071-models-dev-as-the-model-metadata-source.md), [ADR-0072](0072-model-metadata-in-the-db-behind-a-generated-offline-floor.md), [ADR-0103](0103-a-paused-run-hands-off-its-local-producers-before-its-host-closes.md), [ADR-0109](0109-native-media-close-ownership-is-explicit-iterator-provenance.md), [ADR-0110](0110-cli-diagnostics-and-discovery-have-explicit-compatibility.md), [Wave 3](../roadmap/current.md#wave-3--clear-the-ground)

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
without a second argv parser. New JSON-help integration lands after the descriptor
and lazy graph; the earlier increment only certifies implemented meta operations.

For execution distinguish **filesystem grant admission** from model/cost admission.
Preserve current order: filesystem admission, once-only cache fallback seed where
needed, current DB catalog overlay at its owner, then first capability/quote/
budget/egress read. A late file seed must never replace authoritative DB long-tail
prices. Preserve ADR-0072's offline floor, empty-DB non-erasure and no-startup-fetch
rules and media maintenance's no-config/cache/DB exception. Home/slash/resume
transitions cannot reinstall an older file overlay.

Inspect every emitted JS output and its static/dynamic imports. Closure rejects
missing/escaping chunks, unbundled internal packages and undeclared externals;
shipped and emitted finite graphs must agree. Flat layout preserves migration
relative paths. Required PR/push CI installs the exact same tarball on supported
OSes and the declared minimum runtime, then release CI reuses that mechanism.

### One build, exact maps and retryable custody

Enable external upstream TypeScript maps for inlined packages, without embedded
sources. The final bundler chains them to original TypeScript; do not substitute
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

Before retrying, retrieve and verify original staged or Release assets. Reuse
exact matching bytes, fill only missing assets from a recoverable candidate and
refuse conflicts. Expired staging without a complete candidate fails with recovery
instructions; re-encryption cannot manufacture identical custody. Never make
encryption deterministic, overwrite conflicts or silently swap a version's bytes.

A dedicated archive job retains ciphertext, tarball and binding receipt as
per-version Release assets beyond Actions expiry, verifies downloaded digests,
and gates npm publication of that same tarball. Only real trusted pushed tags
with version/main-ancestry checks can mutate Releases/publish. Manual dispatch,
including an off-main override or dispatch targeting a tag, remains dry-run.
Only the archive job gets Contents write; npm retains its provenance permission.

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
release identity must be preserved.

### Acceptance and landing

1. Packed existing meta operations have static reachability plus native throwing
   service witnesses, including early diagnostics/sanitization. Measure against
   the same current baseline; historical ~400 ms is not a fresh threshold.
2. Required packed platform/minimum-runtime controls cover real run/chat fixtures,
   native loading, migrations, MCP version, CAS and shared iterator/registry identity.
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
   before publish. No plaintext fallback or false production-custody claim.
6. Split lazy graph, fatal integration and archival into distinct reviewed
   increments. Rerun affected packed gates after later CLI/DB edits and at final
   whole-wave head. Two new independent complete cumulative clean rounds follow
   each final material fix. At acceptance append partial-replacement notes to
   ADR-0047/0051 and refinements to ADR-0056/0071/0072/0103/0109 before code; land
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
