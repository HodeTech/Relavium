# Native filesystem asset tooling

These contributor/CI tools implement the delivery boundary of
[ADR-0125](../../docs/decisions/0125-file-writes-preserve-security-metadata-through-a-native-host-adapter.md).
The [metadata contract](../../docs/reference/cli/native-filesystem-metadata.md) owns filesystem
profiles and acceptance; [CLI packaging](../../docs/reference/cli/packaging.md) owns public inventory
and exact-tarball custody. A successful protocol probe is not a metadata-write acceptance.

Install the exact Rust toolchain named by
[`rust-toolchain.toml`](../../apps/cli/native/fs-metadata/rust-toolchain.toml), with the native
platform linker. Then `node tools/native-fs/build.mjs` builds the current host's locked crate and
executes its protocol in an owned bounded child. A failed or crashed child produces no new execution
receipt. The generated `apps/cli/native/fs-metadata/runtime/` inventory is ignored by Git. Ordinary
CLI builds run this tool before tsup; tsup's success hook copies verified assets after its clean.

`development-current` contains one actual target and can support local source tests/builds. It cannot
be packed. `node tools/native-fs/build.mjs --verify-profile` also executes every declared Rust parent
test and the eleven fixed Node lifecycle cases against the exact binary, then records their population
in the asset's `validation`. Rust child fixtures are declared separately and owned by their parent
tests. A missing, extra, skipped or failed parent refuses.
Windows validation additionally records `genuineOwnerContext: same | distinct` from exactly one
fixed success marker emitted by the actual OS default-owner fixture. That fixture and the fixed
rename-parameter diagnostic cohort use `--show-output`; each normal successful completion is still
required. `same` truthfully describes
a local TokenUser-only owner context and is not evidence for the distinct TokenOwner case. Both
Windows CI target checks and complete eight-target assembly require `distinct` independently for
x64 and arm64. Missing, duplicate or malformed markers refuse; no SID, path or token bytes enter the
receipt. Synthetic fixture values exercise the validator only and never certify a target.
`assemble.mjs <directory>` selects one validated native execution artifact per required target and
writes `release-complete`; eight protocol-only assets cannot pass. The matrix runs on native x64/arm64 runners;
Linux uses digest-pinned baseline images without emulation. GNU assets build and execute with glibc
2.28. The selected Rust musl toolchain uses musl 1.2.5, and the Alpine recipe executes Node 22.0.0 on
that baseline. macOS sets deployment target 11.0; Windows uses MSVC. This is an adapter-specific
build/deployment profile, not evidence that the whole CLI's SQLite/keyring closure works on every
architecture, minimum OS, filesystem or libc. The existing four installed consumers remain required.
Native CI uploads immutable `native-fs-<run>-<producer-attempt>-<target>` artifacts, each containing
`delivery.json` and a nested exact `assets/` inventory. The envelope locates a producer; it grants no
native admission. Consumers download only their own run into separate directories, then
`artifact.mjs select <directory> <target>` or complete assembly validates every candidate's locator,
exact source commit, native source/recipe/lock/notices binding, binary identity and profile evidence
before choosing the latest successful producer attempt per target. A failed consumer can reuse an
earlier successful producer; a partially retried matrix can combine identical-source successes from
different attempts. A corrupt older candidate still refuses, even beside a valid newer candidate.
No artifact directories are blindly merged, and full reruns retain their distinct immutable names.
The offline selector admits at most 256 candidate directories and 32 distinct producer attempts,
with bounded names, envelope bytes and the existing exact native file/byte limits. The consumer's
attempt number has no corresponding cap. Exceeding a candidate quota requires a fresh workflow run.

Each native CI check also inspects the actual addon bytes and rejects the fixed
test-hook/checkpoint prefix, even when all hashes and profile receipt fields otherwise match.

The Windows rename-parameter cohort runs first so an ordinary profile failure cannot hide its
bounded diagnostic measurements. Only parsed, fixed records reach CI stderr; raw child output is
never forwarded. These observations, including test-only absolute-path variants, do not select a
production fallback or certify publication. All ordinary native parents, genuine-owner proof and
Node lifecycle cases remain required. See the
[native evidence boundary](../../docs/reference/cli/native-filesystem-metadata.md#acceptance-evidence).

`loader.cjs` is the reviewed source of a byte-equivalent shim in generated runtime and installed
`dist/native-fs/`. It selects only the eight literal package-relative binaries, after bounded manifest,
file-kind, hash and inventory checks. It has no compiler, network or workspace/PATH/config lookup.
The exact literal dynamic import in `fs-native-metadata.ts` is externalized by one narrow esbuild
resolver. Closure admits only that lazy source edge and pinned shim, keeping the loader ban everywhere
else. Source imports and meta/read-only paths remain usable when generated assets are absent.
Both fresh and reused builds run an actual plain-Node ESM import of the staged shim, assert its named
export and call the native protocol. The bundled host-helper regression runs outside Vitest's CJS
interop; a separate former-export negative reproduces the shorthand-only namespace failure.

The manifest binds Cargo/Rust source, lockfile, compiler pin, reviewed build recipe/images, loader,
notices, target and binary hashes. `THIRD_PARTY_NOTICES.txt` carries exact locked crate license and
copyright texts. Production verifies those bindings against the isolated chosen candidate before
copying assets; native files join archive inspection, finalized hashes and post-seal drift checks.
Source, Cargo output, per-source inventories and maps never enter npm. A missing target refuses
packaging; no runtime download, install script or compilation fallback is added for this adapter.
SQLite's existing prebuild-download/node-gyp behavior is outside that narrower promise.

Run validator, delivery and independent closure controls with:

```sh
node --test tools/native-fs/assets.test.mjs tools/native-fs/artifact.test.mjs tools/native-fs/checkout.test.mjs tools/native-fs/delivery.test.mjs tools/bundle-closure/closure.test.mjs
```

`fixture.mjs` creates explicitly synthetic format/inventory fixtures for refusal controls only. It
never constitutes a native-execution receipt or a complete release asset set. Required CI builds and
executes real binaries before any native artifact upload. Existing release publication guards remain
in force.

The filesystem/secrets causal runner copies the closed native input inventory into its chosen
source graph and stages source-bound assets once. Each fixed, mutated and restored phase rechecks
that graph's source/helper/recipe binding and every asset hash. CJS/native bytes are hashed runtime
infrastructure, so the existing source loader verifies them without transpiling the shim or treating
binary bytes as TypeScript source. A mutation to a native input refuses old assets; later developer
changes cannot populate the isolated graph. The final original-input check still rejects a moving
developer capture. This mechanism never builds or eagerly loads the addon for a metadata-independent
control. Final frozen-source coordinator and target/profile execution remain separate gates.
