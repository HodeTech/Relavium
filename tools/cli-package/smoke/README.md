# Installed CLI behavior smoke

`runInstalledSmoke({ packageRoot, supportRoot, artifactSha256, source })` from
[index.mjs](index.mjs) tests the actual installed `relavium` package. The caller
inspects and installs the exact tarball first, binds its digest/source identity,
and supplies absolute paths. This runner never builds, packs, installs or rewrites
product files. `supportRoot/installed-smoke.json` contains bounded structured
results; the runner removes its owned temporary HOME/workspaces after joining
children. Every compiled JS digest must remain unchanged.

The launcher runs the complete cohort in [worker.mjs](worker.mjs), a bounded
owned process, and reads its bounded report only after native process closure.
Actual worker PID/parent identity and source/artifact/runtime identities must match.
SQLite inspection and native addon loads therefore cannot lock the installation
in its cleanup owner. The surrounding consumer removes that installation before
publishing success. Worker failure, forged PID or cleanup refusal remains failure;
no successful receipt is inferred from an early private report.

[cases.mjs](cases.mjs) is the fixed required case inventory, shared with the
aggregate. Each result has `id`, `passed`, and evidence or an error. Overall
`success` requires the complete inventory and unchanged compiled bytes.

- Load the actual keyring native addon without constructing `Entry` or calling a
  keychain API; load actual SQLite and execute an in-memory query. Dependency and
  native binary resolution must stay in the installed consumer's `node_modules`.
- Execute installed version and compare it with installed package metadata.
  The surrounding bootstrap controls own exhaustive meta-operation isolation.
- Run the actual transform workflow and installed migrations; discover a paused
  human gate and resume it in a fresh process. Produce a real budget pause, reject
  four invalid decisions without durable mutation, abort and repeat idempotently.
  A documented `agent run --fixture` cassette drives an actual governed write
  denial: no target file, dispatch or effect-journal mutation.
- Drive two actual chat turns through the installed OpenAI SDK, inlined adapter,
  AgentSession, JSON printer and SQLite stores. Hold stdin until assistant output
  and its durable row exist, then `/exit` with code 4. Resume the same session and
  check the second real SDK request carries the first exchange, four ordered
  transcript rows, exact dispatch counts and complete durable usage.
- Spawn a real native stdio MCP fixture after the actual consent refusal/digest
  flow, verify initialize carries the installed CLI version, discover tools, and
  join the native child. No provider/key lookup is needed on this gate-only graph.
- Run the existing parameterized actual media/CAS native cleanup witness against
  the installed entry, including the shared iterator-provenance ownership join.
- Replay a public offline `agent run --fixture` with `git_status` through the actual
  native process host. A private copied Node executable named `git`/`git.exe` runs
  the fixed extensionless fixture script, which creates only its recorded child.
  Inject a synthetic error on the real target after readiness, then observe actual
  target and descendant closure. Delay delivery of real close events to distinguish
  an error/request from the owned native acknowledgement. POSIX additionally covers
  natural leader exit while a descendant holds inherited pipes. Windows runs the
  verified absolute system taskkill with exact `/PID <owned-root> /T /F`, joins its
  actual helper independently, and ignores an executable hostile PATH shim. Its
  refusal mode preserves the launching SystemRoot and injects a synthetic EACCES
  only at the exact canonical taskkill `fs.promises.access` boundary after bootstrap,
  through the actual product verifier. It requires one fixed refusal observation,
  zero target/helper entry, the fixed public refusal, exit 1 and a completed turn;
  it is not an actual OS permission-fault claim. All other access paths call the
  original native function, and healthy modes keep that function's identity.
  An unrelated owned sibling must
  survive; external watchdogs and exact created PIDs bound and join cleanup.
  Each mode owns a fresh sibling with its own finite watchdog; watchdog cleanup
  remains failure. A copied Homebrew macOS Node also receives its fixed adjacent
  `libnode.<ABI>.dylib` when present, so dyld can enter the fixture. The two same-directory
  executables share that support file only after bounded ordinary-file byte verification;
  an existing read-only copy is verified and reused. Readiness requires
  the exact root, created descendant and descendant's matching PID/parent ACK;
  a root/stdout marker alone never authorizes injection. Failed modes retain bounded
  native stdout/stderr, partial mode records and actual cleanup observations in the
  private report; the public receipt still carries only the required case ID/pass.

Chat's key resolver is keychain-first: exactly two synthetic `Entry` constructor
attempts are recorded and refused before native API access. The budget run has one
separately asserted synthetic preflight attempt. All other key/network attempts
are forbidden. The native addon load-only process has no keyring substitute.

The external `--import` preload uses Node's `module.register` API available in
Node 22.0. It replaces only the keyring import and exact synthetic HTTP transport,
not shipped commands, engine code, SDK parsing or persistence. The only admitted
network-shaped data fetch is QuickJS's local WASM data URL; the only admitted
child spawns are the explicit MCP fixture and the new native case's exact target
and verified Windows taskkill helper. These are test witnesses, not a claimed
security sandbox. The chat transport admits one exact synthetic OpenAI request
shape and returns complete synthetic SSE. No real credential, provider call or
billing setup is used.

The exact Node 22.0 Linux and current Node 24 Linux/macOS/Windows consumers must
execute this same runner and artifact digest. A local pass cannot substitute for
those required platform legs. Archive inspection, bootstrap/meta controls and
aggregate enforcement belong to the surrounding package runner. The new case
captures the actual packaged creation-registry exit callback before native entry,
invokes that exact finite callback in a separate subcase, and observes its release
after native close. This proves packaged creation/fallback identity; source
forwarding controls separately prove original bootstrap object identity. The error
is explicit native-edge fault injection, not an OS-fault claim.

Step 8d adds an eighth required case through the untouched installed entry: an
actual scheduled uncaught throw, an actual unhandled rejection, and a real stdout
pipe closure/write. Exact root/descendant readiness precedes injection. Fatal and
output modes require no product diagnostic while actual native close delivery remains
gated, then one fixed diagnostic and exit 9 after delivery. Background mode keeps
both native PIDs alive, permits the fixture's ordinary successful turn, and ends
with background-only exit 9. Each independent mode retains its own sibling,
watchdog, actual close and exact-PID cleanup evidence. These are plain one-shot
activation/ACK-order controls: interactive terminal restoration and absolute
budget nonrenewal retain their separately attributed source controls. Whole
Step 8d acceptance remains open. Original-TS maps/custody remain Step 9. All eight
behavior cases and 177 bootstrap controls are required. Windows bootstrap modes
require five actual target/helper creations (two fatal, one background, two output);
the other platform/cohort combinations require three.

The exact Node 22.0.0 JSON-module ExperimentalWarning is retained in raw private
stderr and recorded separately from product diagnostics only for that runtime
and the actual owned CLI PID. The entire two-line frame must match once; unknown,
partial, duplicate, wrong-PID and wrong-runtime output remains diagnostic output
and cannot pass the JSON or pre-delivery checks. No warning is disabled in the
installed process.

Narrow child-lifetime negative controls run with:

```sh
node --test tools/cli-package/smoke/process.test.mjs tools/cli-package/smoke/native-process.test.mjs tools/cli-package/smoke/native-spawn-witness.test.mjs
```
