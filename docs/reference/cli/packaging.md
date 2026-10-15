# CLI Packaging Contract

- **Status**: Proposed — unshipped, maintainer approval required
- **Date**: 2026-10-15
- **Related**: [ADR-0111](../../decisions/0111-cli-meta-operations-use-a-lazy-packaged-runtime.md), [commands.md](commands.md), [release runbook](../../runbooks/release-a-surface.md)

This is the proposed canonical artifact/custody contract. Current single-bundle
packaging remains governed by ADR-0047/0051 until approval and implementation.
No release, production recipient setup or asset upload is performed by this document.

## Finite runtime package

One executable ESM entry and finite runtime chunks live directly in `dist/`.
Engine workspace code is inlined; declared third-party runtime dependencies stay
external. No unresolved internal package imports or second loaded authority
instance (shutdown registry, media iterator provenance) is allowed.

The build inventory lists every JS output and static/dynamic import. Compare it
with actual emitted and packed files; reject absent/escaping/extra JS, duplicate
or escaping tar entries, unbundled internal imports, undeclared external packages
and unanalyzable runtime loading unless explicitly reviewed/allowlisted.
Chunk layout must preserve real installed `../drizzle` resolution. Runtime files,
migrations, package metadata and existing documented license/changelog assets
form an explicit public allowlist. No source TS/tree, map, private inventory,
build metafile or sourceMappingURL may enter npm.

The lightweight entry imports only pure flag/descriptor/diagnostic/owner substrate.
Runtime modules load under the early fault boundary. Native witnesses and static
reachability prove meta operations do not touch config/cache/DB/keychain/MCP/UI.
Descriptor grammar and JSON help belong to [commands.md](commands.md#proposed-wave-3-cli-compatibility).
One registry instance passes through the chunk graph; no global-symbol bridge
silently replaces existing private-module provenance.

## Build, map and candidate identity

1. Build inlined dependencies fresh in an isolated candidate job with external
   TypeScript maps and no inline source contents. Ordinary workspace builds stay
   map-free. Disable build-cache read **and write**, including Turbo local/remote,
   Actions build caches and later broad capture; force alone is insufficient.
   Build via existing dependency-ordered scripts in that private stage; do not accept stale incremental/cache output missing maps.
   Keep current package exports, engine purity and SDK seam.
2. Invoke `pnpm pack` once. Prepack owns the sole final CLI build, clean output,
   minification, splitting, migration copy, map chaining and closure checks.
   Release must build dependencies beforehand, not build CLI then rebuild in prepack.
3. Before any receipt, remove only tsup's expected final map-link trailers and
   move maps/metafile to owner-only staging outside the npm package. Assert maps
   have repository-relative original TS sources and absent sourcesContent.
   No transform/banner/minifier/JS write is permitted after finalization.
4. Inspect the produced tarball. Compare each packed JS byte digest and migration
   inventory with finalized files; reject prohibited entries independently of the
   package files-list. Only now seal its private map manifest.
5. Symbolication loads the matching source revision separately and maps actual
   packed CLI and engine frames to expected TypeScript lines/columns. Verify wrong
   JS/map/source and missing upstream map refusal. A decrypt round trip alone
   does not certify mappings.

Upstream/final maps, private manifests, metafiles and staging may leave the
candidate job only inside ciphertext; exclude them from every artifact, cache,
diagnostic and failure upload. Package/dependency-download caching may include
only already-public dependencies, never this build output. A synthetic planted
map/cache marker must fail the public-output inventory; changing the exclusion
or enabling a candidate build-cache write must break that causal control.
[GitHub cache access](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching)
is not a private archive boundary.

The **private map manifest** is versioned JSON inside the encrypted archive:
source commit/tree, package version, Node/pnpm/TypeScript/tsup/esbuild versions,
target, lock/config hashes, each final JS/map path+SHA-256 pair, and tarball SHA-256.
No host absolute paths, credentials or embedded source are stored.

The **public binding receipt** is versioned JSON beside ciphertext: source SHA,
package version, tarball/ciphertext SHA-256, recipient primary and encryption-subkey
fingerprints, toolchain/config/lock identity, and originating trusted workflow/run/
attempt identity. It contains neither maps nor private per-source inventory.
Use SHA-256 for file identity, not a homemade signature/provenance protocol.
Check originating identity against the trusted CI service/run and real tag/source;
a self-declared JSON field alone does not authenticate its producer.

A candidate comprises exact tarball, original ciphertext and binding receipt.
Package version plus source SHA identifies the intended candidate; a different
candidate for that version refuses instead of silently superseding it.
The finalized JS/map receipt is sealed locally before encryption; the binding
receipt is sealed after ciphertext exists. These are distinct, named artifacts.

## Recipient custody

The maintainer selected encrypted CI archival. GnuPG is release tooling, never a
runtime dependency. Use an isolated public-only home/keyring/config, no ambient
keyring, automatic discovery or unexpected recipients. Pin maintainer-confirmed
primary and encryption-capable subkey fingerprints. Refuse missing, expired,
revoked or unusable recipients using machine-readable status; check subprocess
exit, bounded output and exact produced asset. Private keys never enter repo/CI.

Encrypt the archive once; OpenPGP session-key randomness is expected
([RFC 9580](https://www.rfc-editor.org/rfc/rfc9580.html#section-2.1)).
Retain original ciphertext before retryable upload. Temporary plaintext is cleaned
on all paths without claiming secure erasure. Diagnostics are fixed and never
print content/key data. Synthetic controls use synthetic maps only; a public
fixture private key may never decrypt a product archive.

Production setup requires confirmed recipient, offline recovery/decryption check
and backup ownership before an actual release. Rotation is a reviewed public-key
update for future candidates; preserve historical fingerprint/decryption capability
for supported versions. Existing public ciphertext cannot be recalled by revocation.
This wave creates no automatic deletion policy or production key.

## Archive, retry and publication

Workflow staging contains only tarball, ciphertext and nonsecret receipt.
A dedicated archive job after pack/smoke creates or reuses a draft Release for the
real pushed version tag, uploads those three assets, downloads/verifies them, then
permits npm publication of **that exact tarball**. A successfully published package
can finalize its matching Release; a failed npm step leaves an identifiable draft
candidate for recovery. Existing conflicting Release/tag/assets refuse.

Archive and npm both require real pushed `v*` tag, package-version equality and
main ancestry. Manual workflow_dispatch, including a tag ref or off-main override,
is build/smoke only: no Release mutation or npm publish. Archive alone gets
Contents write; npm keeps its separate provenance permission. PR/fork runs never
upload release assets. Configure version concurrency to prevent competing candidate
writers and recheck before upload; do not rely only on asset names.

| Durable state | Permitted action |
|---|---|
| No prior candidate | Build/pack/encrypt once, stage original candidate |
| Trusted candidate staging exists | Retrieve/verify and reuse exact bytes, rerun smoke if needed |
| Complete matching Release assets exist | Retrieve/verify; no rebuild, re-encryption or overwrite |
| Partial upload, trusted full staged candidate recoverable | Verify present assets against it; add only absent matching assets |
| Conflict or expired staging without complete recoverable candidate | Fail with explicit manual recovery; never invent replacement matching ciphertext |

Retain exact tarball as well as ciphertext/receipt for every supported release:
Actions retention can expire even when npm publication failed. Release is not
private storage; only ciphertext protects debugging material. Do not automatically
delete or replace per-version assets. Before npm retry, detect existing version
and compare package integrity; different bytes refuse, equal published bytes
count as completed publication rather than republishing.

Required PR/push gates pack once and all supported OS consumers install that same
digest. Include a packed runtime consumer at **Node 22.0.0**, separate from the
workspace install floor at 22.13, plus current .nvmrc on macOS/Linux/Windows.
If the pinned runtime closure fails the public floor, resolve the compatibility
decision explicitly before acceptance. Reuse the same smoke in release CI.
Controls cover actual run/chat/migrations/native load/MCP version/CAS/iterator
identity and early import failure without keychain/provider calls.

Wave 3 implements this path with offline/API-fake controls and a dedicated
crypto/CI-custody security sitting. Actual production configuration/publication
belongs to Wave 4b and fails closed if custody is missing. Required final whole-wave
checks repeat exact-artifact evidence after later CLI/DB changes.
