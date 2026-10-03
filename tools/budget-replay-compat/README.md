# Budget replay compatibility check

`pnpm smoke:budget-replay` is the offline downgrade acceptance check for
[ADR-0100](../../docs/decisions/0100-budget-authorization-is-durable-state-with-a-replay-barrier.md).
It is also part of `pnpm run ci`. The canonical authorization contract is
[sse-event-schema.md](../../docs/reference/contracts/sse-event-schema.md).

The check freezes the actual predecessor at
`1b3f8d70c05c9152043dcc476eaa1afaaa87381d`, snapshots the current production
sources, and executes each version in a separate Node worker. The predecessor
first produces a genuine legacy budget pause and a historical `input_provided` decision prefix.
The current checkpoint, admitted engine and both strict discovery stores read the latter as a
fatal budget rejection, retaining its original bytes and producing no agent output or egress.
The current engine then produces
12 durable pause/decision prefixes, including its decisions of that legacy gate.
The predecessor's actual parser, SQLite strict reader, CLI checkpointer and
engine entry must refuse every prefix before execution registration, scheduling,
credential resolution or egress. Its exact acquired lease must be released. A
legacy budget rejection and an ordinary human-gate approval are positive controls.
Tolerant display is tested separately and never supplies a replay checkpoint.

`frozen/pre-w7-source.tar.gz` contains the original source, package metadata,
lockfile, SQLite migrations and source manifest. Its SHA256 is
`cf980edd6d4d8a8652fa236c1c0d46055249fe59944ec284a120aea19c6b10bb`;
the source manifest's SHA256 is
`cb3361e5c0f75d427ee936ba43beba871acacbc117729df7820dbb7aa5ec229b`.
Both are verified before any frozen source runs. The loader also verifies each
source it loads and forbids mixing versions or resolving workspace source/dist.
It transpiles TypeScript for execution; normal CI owns typechecking.

`frozen/dependencies.json.gz` pins 180 package roots and 12,000 portable files,
including every installed declared dependency, peer and optional edge. All versions
are present in the immutable predecessor lockfile. Its SHA256 is
`7cce53b58c5eade131f59dcce426519980b9cdc27644d9fbade5087b625bd529`.
The original 93 roots' portable bytes are retained; the 2026-10-03 review correction
extends their metadata closure to installed peers rather than changing their versions.
The 296 edges record exact target roots, two Node builtins and 29 absent optional
edges. Multiple versions have distinct identities; a name alone is not a join key.

The check verifies installed metadata, complete portable file inventories and actual
Node lookup edges before a worker starts. It copies verified bytes into its owned
tree and reconstructs each explicit dependency link, including Drizzle's SQLite peer.
It verifies lookup again in the copied graph. A redirected edge or a newly resolving
optional package is refused. Both the ESM loader and CommonJS `module.require` check
the resolved file against the copied byte inventory and its issuer-specific frozen edge before loading it;
neither accepts a switch to a different already-pinned version. Root imports and same-package
relative imports are bound too. Declared lookup edges, including absent optionals, are rechecked
before package execution so `require.resolve` cannot silently acquire a previously absent optional.
Neither runtime accepts
an arbitrary `node_modules` path. CommonJS uses the public `module.require` and
`createRequire.resolve` APIs, including in the loader thread, without a private loader
hook or a newer Node minimum. `NODE_PATH` is empty in workers.

The locally compiled `better-sqlite3/build/Release/better_sqlite3.node` is the explicit
platform exception to portable matching. Its package version and source are pinned;
its actual binary is copied, hashed for the invocation and checked at runtime. The
archived baseline lockfile is immutable. The current repository lockfile can evolve;
the check verifies the archived lockfile and requires the matching installed pnpm
closure, refusing mismatches. It never installs packages or resolves dependencies
over the network. A future dependency update must retain an explicit way to run
this predecessor rather than silently refreshing its source or dependency pins.

All extraction, snapshots, logs, loader traces, SQLite databases, caches and
temporary files go into one exclusive external `relavium-budget-replay-*`
directory printed by the command. Its `OWNER` identifies the invocation. The
directory is preserved on success and failure for inspection. No old source or
test is extracted into the repository or normal Vitest collection. Dependencies are
physical owned copies with individual links inside physical `node_modules` directories.
Thirteen permanent graph/runtime controls cover CJS/ESM/peer drift, optional presence,
unlisted files, post-preflight unpinned and pinned-to-pinned resolution, root-import/byte drift,
and positive/restored two-version graphs. The ESM control uses the actual production loader
with an inert, pinned TypeScript stand-in; it loads no TS source and is separate from the
real predecessor/source/dependency acceptance workers.
Their probe code cannot run its inert marker on a rejected load. Workers have
45-second deadlines and their exit records are retained; SQLite connections close
in `finally`. Providers and key resolution are refusing injected doubles, and
network fetch is forbidden. No live key or keychain access is involved.

This check proves the downgrade boundary for its captured current sources. The
core runtime suites separately prove allowance exhaustion, quote refusal, crash
identity, deadline, effect preflight and acknowledgement races. Compatibility
evidence alone does not constitute whole-W7 acceptance.
