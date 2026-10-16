# Compiled CLI bootstrap controls

`node tools/cli-bootstrap/check.mjs` consumes the existing untouched
`apps/cli/dist/index.js` and its actual `run-*` / `dispatch-*` runtime chunks.
Build ownership remains with the caller; this control never builds or rewrites
the artifact. Its JSON result includes the entry digest, runtime/platform,
scenario results and deduplicated native import/path/filesystem observations.
Temporary application paths are represented as `<synthetic-fixture>`.

The tooling export `runBootstrap(absolutePackageRoot)` runs those same controls on
an explicitly selected installed package. The package consumer supplies its
verified tarball/install identity; no selector or test hook is added to the CLI.
The default command continues to use repository `dist`.

`node --test tools/cli-bootstrap/witness.test.mjs` proves the witnesses reject
swallowed ESM/CommonJS import failures, application FS access, native service
dispatch, missing observations and genuine dynamic chunk loading. It also checks
timeout/output enforcement and joining the owned child.

The inventory covers existing human help/version/bare/subtree grammar, with and
without `--json`, and syntactically valid absent absolute filesystem roots.
Explicit cwd/config selectors accompany the grant cases. Syntax failures retain
exit 2 and bounded-root values remain absent from diagnostics. Unknown invocation
compatibility is retained. The current artifact supplies the human-output byte
comparison; this is not a measurement of a previous revision.

The native `--import` preload installs Node 22.0-compatible `module.register`
hooks before importing the entry. It records and refuses native/provider/MCP/TUI/
schema/config-parser imports, protects poisoned temporary HOME/workspace/grant
paths, and refuses network/subprocess dispatch. Node's module/package loader FS
reads outside those application roots remain allowed and recorded. The main
witness writer retains an open descriptor and primitive write function, avoiding
the patched FS wrappers. Native `realpath[Sync].native` is preserved and guarded.

Positive controls execute the real compiled chat grant-admission path and refuse
real deferred entry/dispatcher chunk loads. Import failures must reach the fixed
diagnostics without the arbitrary synthetic error canary or stack. Their current
fallback exit 1 is explicit; Step 8 owns native ABI classification and exit 9.

Each scenario uses a fresh sanitized child environment and a finite deadline,
with a combined UTF-8 output-byte cap. POSIX children own a process group which
is killed and joined; product subprocess dispatch is forbidden on every OS.
Fixture snapshots prove poisoned application files/directories remain unchanged,
including on passing controls. Cleanup removes only the exact owned mkdtemp root.

These controls establish selected-artifact behavior on the runtime/OS that
actually ran them. Alone they do not certify tarball content, dependency install,
Node's minimum floor, other platforms, complete Step 7, native owner integration
or archival custody. Step 7b's package consumer independently supplies the
tarball/install binding and records each actual platform execution.
