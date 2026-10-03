# Budget replay compatibility check

`pnpm smoke:budget-replay` is the offline downgrade acceptance check for
[ADR-0100](../../docs/decisions/0100-budget-authorization-is-durable-state-with-a-replay-barrier.md).
It is also part of `pnpm run ci`. The canonical authorization contract is
[sse-event-schema.md](../../docs/reference/contracts/sse-event-schema.md).

The check freezes the actual predecessor at
`1b3f8d70c05c9152043dcc476eaa1afaaa87381d`, snapshots the current production
sources, and executes each version in a separate Node worker. The predecessor
first produces a genuine legacy budget pause. The current engine then produces
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

`frozen/dependencies.json.gz` pins all 93 installed packages in the predecessor's
dependency closure by version, package metadata and portable file hashes. Its
SHA256 is `94b86d29f86bdb68d9d5eefe51325917d2999beed69692e293a32ec34b2dbe97`.
The
locally compiled `better-sqlite3/build/**` output is platform-specific and excluded
from byte matching; its package version and original source remain pinned. The
archived baseline lockfile is immutable. The current repository lockfile can evolve;
the check verifies the archived lockfile and requires the matching installed pnpm
closure, refusing mismatches. It never installs packages or resolves dependencies
over the network. A future dependency update must retain an explicit way to run
this predecessor rather than silently refreshing its source or dependency pins.

All extraction, snapshots, logs, loader traces, SQLite databases, caches and
temporary files go into one exclusive external `relavium-budget-replay-*`
directory printed by the command. Its `OWNER` identifies the invocation. The
directory is preserved on success and failure for inspection. No old source or
test is extracted into the repository or normal Vitest collection. Dependencies
are individually linked inside a physical `node_modules` directory. Workers have
45-second deadlines and their exit records are retained; SQLite connections close
in `finally`. Providers and key resolution are refusing injected doubles, and
network fetch is forbidden. No live key or keychain access is involved.

This check proves the downgrade boundary for its captured current sources. The
core runtime suites separately prove allowance exhaustion, quote refusal, crash
identity, deadline, effect preflight and acknowledgement races. Compatibility
evidence alone does not constitute whole-W7 acceptance.
