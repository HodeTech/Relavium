# ADR-0111: CLI meta-operations use a lazy packaged runtime

- **Status**: Proposed
- **Date**: 2026-10-15
- **Related**: [ADR-0047](0047-cli-framework-commander-ink-clack.md), [ADR-0051](0051-cli-distribution-thin-bundle-private-engine.md), [ADR-0056](0056-cli-in-app-slash-command-system-and-manifest.md), [ADR-0067](0067-node-supported-floor-22-reaffirm-better-sqlite3.md), [ADR-0071](0071-models-dev-as-the-model-metadata-source.md), [ADR-0110](0110-cli-diagnostics-and-discovery-have-explicit-compatibility.md), [Wave 3](../roadmap/current.md#wave-3--clear-the-ground)

## Context

Wave 3 #43/#44/#271 concerns eager service imports and cached catalog reads on
help/version. At `702cdc9c`, deferring `driveHome` alone is insufficient:
`program` → `specs` → `dispatch` imports command implementations and their
DB/provider/TUI dependencies. The entry also imports MCP, and diagnostic helpers
reach engine dependency barrels. This requires a dependency-graph correction,
not just moving one function call.

ADR-0051's single ESM bundle and the closure guard's single-output assertion prevent
a genuine lightweight entry with deferred implementation chunks. The engine must
still be inlined and third-party dependencies externalized. Wave 3 #46 also needs
release sourcemaps, while ADR-0051 prohibits their publication. The GitHub repository
was verified public during preflight; an ordinary Actions artifact is not a private
archive merely because it is absent from npm.

This proposal requires approval before bundler, startup or release-policy changes.
No dependency version bump, new runtime dependency or package publication is authorized.

## Decision

We will package one executable ESM entry plus its finite, explicitly packaged ESM
runtime chunks. This replaces ADR-0051's **single-output-file** constraint only;
all proprietary engine code remains inlined into the CLI artifact, every third-party
runtime dependency remains external and declared, and the engine packages remain private.

The entry, flag grammar, version and command descriptors form a lightweight graph.
Meta-operations resolve descriptors without reading config or cached catalogs,
admitting native filesystem grants, opening history/migrations/keychain, connecting
MCP or constructing providers/TUI. Runtime validation still owns normal command
execution; invalid option grammar is not silently accepted by the meta path.
Defer command executor imports, Home, native services and MCP version wiring to
their actual owners. Seed the cached catalog once before an executing command's
first price/capability read, retaining the shipped offline floor and no-startup-fetch
rule. Never move seeding after admission or budget pricing.

The bundle guard must inspect **every** emitted JavaScript output and its static
and dynamic imports, verify the complete declared dependency closure, and reject
unbundled `@relavium/*`, missing/escaping chunks and undeclared external packages.
The packed artifact, not a source checkout, is the cross-platform smoke subject.
Chunk-relative migration paths, native iterator/shared-module identity and lazy
initialization must be tested together; splitting must not create independent
copies of authority-bearing module state.

### Private source-map custody

Generate private sourcemaps for the **exact final minified JavaScript bytes** that
are packed, with `sourcesContent: false`. Do not rebuild the shipping JavaScript
after its map receipt is recorded. A private manifest binds source commit, package
version, actual toolchain and every JavaScript/map digest. Published JavaScript has
no sourceMappingURL, and npm contains neither maps, metafiles, source trees nor the
private manifest. A pack inspection is required, not just a files-list assumption.

The maintainer selected public-recipient encrypted CI archival on 2026-10-15;
this method selection does not approve the remaining ADR or implementation plan.
Use vetted [GnuPG recipient encryption](https://gnupg.org/documentation/manuals/gnupg/Operational-GPG-Commands.html)
as release tooling, not a CLI runtime dependency or in-house cryptographic protocol.
Use an isolated public-only keyring and an explicitly pinned maintainer-confirmed
recipient fingerprint, without ambient keyring/config or automatic key discovery.
An exact-source archive receipt establishes build provenance; encryption alone
does not authenticate who created an archive.
The private decryption key never enters this repository or CI. Public artifact
storage is permitted only for ciphertext; fixed diagnostics never print map
contents or key material. The recipient and retention destination must be explicitly
configured and verified before a release can claim private archival. A local
owner-only archive is available for development and custody tests; it does not
claim that CI release archival happened.

CI stages ciphertext as its workflow artifact. Because [workflow artifacts expire](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/remove-workflow-artifacts),
actual publication also retains that exact ciphertext as a per-version
[Release asset](https://docs.github.com/en/rest/releases/assets), verified by digest
before npm publication. Retain it for every supported release; this wave adds no
automatic deletion. Never replace an existing version's different ciphertext
silently. Public storage remains ciphertext-only; this does not make the repository
or artifact access private. Release uploads use only the existing trusted main/tag
path with least required permissions, never a PR/fork or help invocation.

Implementation may use synthetic recipient keys for offline encryption/decryption
controls, never manufacture a production recipient or upload plaintext to complete
a gate. Do not publish proprietary maps encrypted to a publicly available fixture
private key. Production recipient configuration and actual storage remain separate
release prerequisites; no key material is requested for this proposal review.
The first actual release belongs to Wave 4b and fails closed if private archival
is absent. Wave 3 implements/tests the complete selected path and records its real
configuration status without presenting a fixture as production custody.

Considered retaining a single file and deferring only Home: rejected because
external imports remain eager through the rest of the graph. Considered publishing
engine packages separately: rejected by the proprietary bundle boundary.
Considered publishing source-free maps openly: rejected because symbol names and
source layout remain private even without embedded TypeScript. Considered ordinary
public Actions artifacts or Release attachments: rejected as private custody.

### Acceptance and landing

1. Native packed help/version/root-help/JSON-help executions install throwing
   service-boundary witnesses and prove no service initialization or cached-config
   I/O. Record cold-start measurements against the same current baseline; the
   historical approximately 400 ms figure is not a fresh measurement or threshold.
2. Real packed run/chat fixture, DB migrations, MCP version, CAS and native iterator
   identity controls pass on supported platforms, including the minimum Node floor.
3. Deliberately missing/escaping chunks, external engine imports and an undeclared
   dependency break the complete closure/pack guard. Every required chunk is shipped.
4. Map-to-JavaScript receipts survive packing byte-for-byte; a planted original source,
   map, manifest or metafile fails public-artifact inspection. Actual private archive
   round-trip controls use test keys, and failure cannot fall back to public plaintext.
5. Update the [release runbook](../runbooks/release-a-surface.md), packaging reference
   and canonical CLI docs, and append a dated partial-replacement note to ADR-0051
   plus refinements to ADR-0047/0056/0071. Required CI, packed smokes and two fresh
   independent cumulative reviews must pass before implementation acceptance.

## Consequences

### Positive

- Help/version avoid initializing unrelated native/network/UI subsystems by construction.
- Exact release bytes can be symbolicated without publishing proprietary source metadata.

### Negative

- Multiple packaged files replace a single-file assumption. Complete closure checks,
  shared-state identity controls and exact-tarball platform smokes become mandatory.
- Private archival adds a release custody prerequisite. Its configuration is explicit;
  absence blocks the archival claim/release instead of leaking maps or silently skipping it.
