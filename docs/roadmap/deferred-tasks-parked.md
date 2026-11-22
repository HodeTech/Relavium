# Deferred tasks — parked behind a trigger

> Status: Living

> Last updated: 2026-11-18 — created by splitting the register; the sections below moved whole under their original headings; the few entries the sweep edited are listed in its [log](deferred-tasks-history.md#sweep-of-2026-11-18).

- **Related**: [deferred-tasks.md](deferred-tasks.md) (front door, legend and active entries), [deferred-tasks-history.md](deferred-tasks-history.md), [current.md](current.md), [phases/phase-2.5.5-hardening-and-remediation.md](phases/phase-2.5.5-hardening-and-remediation.md), [phases/phase-2.6-conversational-authoring.md](phases/phase-2.6-conversational-authoring.md)

This file holds the register's **review-round ledgers**: the sections that record what a rigor pass, a review round or a security sitting
left unfixed on purpose, plus the Phase 2.6.5 deferrals whose entries each name their own trigger. In almost every section the
intro says **Trigger for every entry: the next change to the file it names**, so nothing here is due until that trigger fires.
Read [How to read the register](deferred-tasks.md#how-to-read-the-register) for the markers. A section is filed here when most of its
open entries are parked; a few entries in these sections are still `[ ]` because a workstream, a step or a release ruling
owns them (the [watch list](deferred-tasks.md#watch-list) names them) — the marker, not the file, is authoritative. Closed entries stay
with the round that closed them so each round reads whole. "Above" and "below" in these sections refer to the register as one file;
see *Position words* in [How to read the register](deferred-tasks.md#how-to-read-the-register).

## PR #95 masker edge cases — approved deferrals (2026-10-21 and 2026-10-22)

Under the [masker acceptance bar](phases/phase-2.5.5-hardening-and-remediation.md#wave-3-pr95-increment-implementation-checkpoint-and-review-round-corrections--2026-10-20)
that the maintainer set on 2026-10-21, a low finding in the open-ended masker work
(`packages/llm/src/scrub-secrets.ts` and core's twin projection in `packages/core/src/tools/bounding.ts`) is
recorded here instead of being corrected in the review loop, and under the round cap of the same day so is
every medium and low finding of round 10, the last round, after which only high findings are corrected. The
entries up to round 9 are not regressions against base `9902e0a0`; the round-10 entries say when they are, in the
shapes they name. The maintainer counted round 10's GEN-R10-1 (a `.env` password in a structured result's
summary) as high on 2026-10-22, so its summary half is corrected and only its journal half is recorded here, and
approved the two private-key block gaps the author found after round 9. The shapes that neither masker reads by design stay described in
their canonical homes, [built-in-tools.md](../reference/shared-core/built-in-tools.md) for core and
[error-handling.md](../standards/error-handling.md) for the scrubber; this list holds the review findings and the
re-checks they need. **Trigger for every entry:** a real tool result, journal entry or diagnostic that carries the
shape, or the next change to the rule the entry names. The generative harnesses that found them are not part of
the repository, so each entry names the input and the property to re-check by hand or in a test.

- [~] **Approved deferral (maintainer, 2026-10-21). A header label split by a JSON escape is not joined in a
  summary.** *Low, unchanged from base.* *(author)* `boundForModel({ stdout: 'api-k\tey: <value>' })` shows the
  value in its summary, while the same text as a string result is `[redacted]`. The summary's second reading
  (`visitEscapedSeparators`) runs the standalone, scheme-label and split-credential rules, not the split
  header-label join, which rewrites the text instead of reporting ranges. **Re-check:** whether a real tool output
  splits a header label across a line break; a fix reports the joined labels as ranges of the escaped view.
  *(low · packages/core/src/tools/bounding.ts)*
- [~] **Approved deferral (maintainer, 2026-10-21). A private-key block split across array elements shows its
  body in the journal and display projections.** *Low, unchanged from base.* *(author)*
  `redactSecretShapedValue(['--private-key', '<BEGIN marker>', 'MIIE…', '<END marker>'])` keeps `'MIIE…'` and the
  END marker, and `{ argv: ['ssh', '-i', '<BEGIN marker>\nMIIE…', '…\n<END marker>'] }` stays whole. Both
  projections read each string alone; only a summary reads a structured value's JSON as one text. **Re-check:**
  `redactSecretShapedWalk` under `projectSecretShapedValue` and `redactSecretShapedValue`; a fix changes `v5:`
  journal digests, so it needs the compatibility review of
  [effect-journal.md](../reference/shared-core/effect-journal.md#11-secrets-what-a-row-may-hold) §11.
  *(low · packages/core/src/tools/bounding.ts)*
- [~] **Approved deferral (maintainer, 2026-10-21). A summary does not read a key's unquoted value behind an
  escaped line break and indentation.** *Low, unchanged from base.* *(round 9 critic, CRIT-R9-1)*
  `boundForModel({ stdout: 'database:\n  password:\n  Qx7vT2mN9pL4kR8s\n  user: app' })` shows the value, while
  the same text as a string result is masked. The key rule reads a value behind escaped separators only when a
  quote opens it (`escapedValueStart`), and the summary's escaped-separator view runs no key rule. **Re-check:** a
  fix lets the summary's key rule read an unquoted value behind escaped separators and spaces, or runs it over
  `escapedSeparatorView`; the journal is unchanged. *(low · packages/core/src/tools/bounding.ts)*
- [~] **Approved deferral (maintainer, 2026-10-21). Core does not read a credential glued to a terminal
  sequence's final byte.** *Low, unchanged from base.* *(round 9, R9-GEN-4)* `ESC[1msk-<body>` and
  `ESC[0mBearer <token>` keep the credential: the SGR final byte `m` is a word character, so the standalone and
  scheme rules see no boundary; built-in-tools.md names the limit. **Re-check:** read those two rules in a view
  where CSI sequences are filled, as the backstop's normalized probe does. *(low · packages/core/src/tools/bounding.ts)*
- [~] **Approved deferral (maintainer, 2026-10-21). The quoted value's later-closing rule has tests but no causal
  control.** *Low, partial.* *(round 9, TST-R9-2)* The mutations that keep a single reading, drop the kept
  backslashes or skip the summary's second closer are each killed by
  `closes a quoted value at the later of its readings with and without the masks`, but no declaration in
  `tools/secrets-controls/mutations.mjs` targets it. **Re-check:** add a control (for example `keepingEscapes`
  returning `ranges`) when the secrets family is next extended, with its counts.
  *(low · tools/secrets-controls/mutations.mjs)*
- [~] **Approved deferral (maintainer, 2026-10-22). A private-key block cut off before its END marker is not
  masked.** *Unchanged from base; found by the author after round 9, outside any review finding.*
  `redactSecretShapedText('<BEGIN marker>\nMIIE…')` and the summary of the same text keep the whole body, as does
  a block whose END marker starts more than 20,000 characters after its BEGIN marker (`PEM_BODY_MAX`):
  `visitPemBlocks` masks only a BEGIN…END pair, and the LLM backstop reads no private-key block. A real tool output
  can cut a key short (`head -n 5 key.pem`, a tool that clips its own output). built-in-tools.md names the limit.
  **Re-check:** mask an unclosed BEGIN marker through its base64 body lines in every projection, linear at admitted
  size; a journal change needs the compatibility review of
  [effect-journal.md](../reference/shared-core/effect-journal.md#11-secrets-what-a-row-may-hold) §11.
  *(packages/core/src/tools/bounding.ts)*
- [~] **Approved deferral (maintainer, 2026-10-22). A structured result's summary does not read a private-key
  marker split by a line break or tab.** *Unchanged from base; found by the author after round 9.*
  `boundForModel({ a: '<BEGIN marker>\nMIIE…\n-----END RSA PRIVATE\nKEY-----' })` shows the block in its summary,
  while the same text as a string result is `[redacted]`: JSON escapes the line break or tab, so the wrapped-marker
  patterns, which read raw whitespace, see none; more than one space still collapses in the summary's one-line
  pass. built-in-tools.md names the limit. **Re-check:** read the wrapped markers in `escapedSeparatorView` as well
  (`visitEscapedSeparators`). *(packages/core/src/tools/bounding.ts)*
- [~] **Approved deferral (round cap, 2026-10-21). A summary reads a wrapped private-key marker only within its
  whitespace bounds.** *Medium, regression against base.* *(round 10, R10-SCRUB-1)*
  `boundForModel('PRIVATE_KEY=-----BEGIN PRIVATE KEY-----\nMIIE…\n-----END PRIVATE\n        KEY-----')` shows the
  body in its summary, which base masked: the wrapped patterns take one to eight whitespace characters between
  `PRIVATE` and `KEY` and up to 40 characters of type words, and the key's unquoted value takes the BEGIN marker
  before the one-line pass can pair the block. A line break with seven or more spaces of indentation in CRLF text,
  nine tabs and a 31-column hanging indent leak the same way. built-in-tools.md names the bound. **Re-check:** let
  each whitespace run grow as one simple quantifier (`PRIVATE\s+KEY`, type words separated by `\s+` with a bounded
  word count) under the admitted-size case deadline, and add summary tests with nine or more whitespace characters
  behind a key prefix. *(medium · packages/core/src/tools/bounding.ts `visitPemBlocks`)*
- [~] **Approved deferral (round cap, 2026-10-21). A U+E000 in a structured result brings back walk-first masking
  in its summary.** *Medium, regression against base.* *(round 10, R10-SCRUB-2, INT-R10-1 and PR95-R10-SEC-1)*
  `boundForModel({ icon: ' ok', private_key: '<BEGIN marker>\nMIIEAAAAfirst', rest: 'MIIEBBBBsecond\n<END marker>' })`
  shows the second half of the body and the END marker in its summary; `{ argv: ['mysql', "--password='correct",
  'horse', "battery'"], icon: '' }` shows `horse` and `battery'`. The summary marks each whole-masked value with
  a U+E000 placeholder and, when the result's JSON already holds that character, falls back to the walk's masks
  applied before the text rules. A planted character or a glyph (a Nerd Font icon) is enough. built-in-tools.md
  names the limit. **Re-check:** pick a placeholder that the result's JSON does not hold (an unused private-use code
  point or a nonce) so that the unwalked reading always runs, and add tests with U+E000 beside a cross-member PEM
  block and an argv password. *(medium · packages/core/src/tools/bounding.ts `structuredSummaryText`)*
- [~] **Approved deferral (round cap, 2026-10-21). A private-key block ends at its first END marker even where
  another rule's match is glued to it.** *Medium, regression against base since `b89ac62e`.* *(round 10,
  R10-SCRUB-3)* `redactSecretShapedText("api_key='x Wsecret12 -----BEGIN RSA PRIVATE KEY-----' ?sig=<24 a>-----END RSA PRIVATE KEY-----")`
  is `api_key='x Wsecret12 [redacted]` (base: `[redacted] ?sig=[redacted] RSA PRIVATE KEY-----`), and
  `'<BEGIN marker>\n?s=<26 characters><END marker>W<END marker>'` leaves `W<END marker>`, which base masked; base's
  rules ran in turn, so the glued match erased the marker. built-in-tools.md names the relaxation. **Re-check:** end
  a block only at an END marker that no other rule's match is glued to, or read a value's closing quote inside a
  PEM range as closing. *(medium · packages/core/src/tools/bounding.ts `visitPemBlocks`, `visitSecretKeyValues`)*
- [~] **Approved deferral (round cap, 2026-10-21). Whitespace inside a wrapped marker's type words has no killing
  test.** *Medium, test gap.* *(round 10, TST-R10-1)* Changing either wrapped pattern's type class
  `[A-Z0-9\s]{0,40}` to `[A-Z0-9 ]{0,40}` leaves every bounding case passing, while the summary of
  `PRIVATE_KEY=-----BEGIN RSA\nPRIVATE KEY-----\nMIIE…\n-----END RSA PRIVATE KEY-----`, or of the same split in the
  END marker, then shows the body. **Re-check:** add both inputs to `reads a private-key marker that a line break, a
  tab or a doubled space splits in a summary` and run both class mutants.
  *(medium · packages/core/src/tools/bounding.test.ts)*
- [~] **Approved deferral (round cap, 2026-10-21). The summary's no-throw handling of a whole-masked value with no
  JSON form has no killing test.** *Low, test gap.* *(round 10, TST-R10-2)* With `jsonValue` reduced to
  `return JSON.stringify(value);`, `boundForModel({ password: 10n, ok: 1 })` and
  `boundForModel(['--password', 10n, 'x'])` reject and every test still passes; the existing no-JSON-form test holds
  no credential key. **Re-check:** add both inputs (summaries `{"[redacted],"ok":1}` and
  `["--password","[redacted]","x"]`) and run the mutant. *(low · packages/core/src/tools/bounding.test.ts)*
- [~] **Approved deferral (maintainer, 2026-10-22). The journal projection of JSON text keeps a value whose escaped
  opening quote an earlier mask took.** *Unchanged from base; the journal half of GEN-R10-1, whose summary half is
  corrected.* `redactSecretShapedText(JSON.stringify({ stdout: 'DATABASE_URL=postgres://db.example.com/app?sslmode=require\nPOSTGRES_PASSWORD="<v>"\n' }))`
  shows `<v>`: the query value runs on through the JSON-escaped line break and the next line's key and takes the
  backslash of the value's escaped quote. A summary opens such a value where that mask keeps its backslashes; the
  journal does not, so `v5:` digests do not change, and a test pins that. **Re-check:** drop the `throughCloser`
  gate of the kept opening in `visitSecretKeyValues`, with the compatibility review of
  [effect-journal.md](../reference/shared-core/effect-journal.md#11-secrets-what-a-row-may-hold) §11.
  *(packages/core/src/tools/bounding.ts)*

## Wave 3 Step 9a.1 — recorded low findings (2026-10-24)

The internal rigor pass over Step 9a.1 at `1f247772`, run before its round 13 under the
[2026-10-23 acceptance amendment](phases/phase-2.5.5-hardening-and-remediation.md#wave-3-step-9a1-implementation-checkpoint--2026-10-22),
corrected every verified code defect and test gap it could close inside the increment. These low findings are
recorded instead: each needs a change of scope (a new CI leg, a refactor of a Step 7b script) or concerns a
local-only path no claim covers. **Trigger for every entry:** the next change to the file it names, or a
real run that shows the shape.

- [~] **The local consumer installs under the shared temporary directory.** *Low, unchanged since Step 7b.*
  *(rigor pass, SEC-1/PLAT-6)* `consume.mjs` installs the packed CLI under `mkdtemp(tmpdir())`, so the
  installed CLI's optional bare requires (for example `ws`'s `require('bufferutil')`, loaded by the
  `provider list` smoke case) fall through to `<tmpdir>/node_modules`, which another local user can create on
  a POSIX host with a shared `/tmp`. CI runners are single-tenant and macOS's per-user temporary directory is
  not shared; packaging.md names the limit. **Re-check:** install under a per-user parent no other user can
  write (for example a 0700 directory in the user's cache directory), with a test that plants
  `<temporary>/node_modules/bufferutil` and shows it never runs, as round 10's corepack test does.
  *(low · tools/cli-package/consume.mjs)*
- [~] **An interrupt during the consumer's publication leaves its receipt.** *Low.* *(rigor pass, PLAT-4)*
  `publish()` runs inside `completeConsumer`'s interrupt scope, and the interrupt path removes the fixtures,
  smoke roots and installation but not `installed-consumer.json`, so a consumer interrupted while publishing
  exits 130 beside a success receipt (the producer empties its artifact directory in the same case). A later
  local run into the same report directory then fails on the `wx` write; CI uploads only on success.
  **Re-check:** write the receipt under a temporary name and rename it after the interrupt scope returns, or
  retract it on the interrupt path, with a test that interrupts during `publish`.
  *(low · tools/cli-package/consumer-lifetime.mjs)*
- [~] **Two producers can share one artifact directory.** *Nit.* *(rigor pass, PLAT-9)* Both pass the
  emptiness check (`mkdirSync` recursive plus `readdirSync`), so one seal can read the other's tarball. It
  needs user error: the local check always uses a fresh root. **Re-check:** require that the directory does
  not exist yet and create it without `recursive`, or take an exclusive lock file first.
  *(nit · tools/cli-package/produce.mjs)* *Re-checked in Step 9a.2a (2026-10-24), which changed
  `produce.mjs` to add the symbolication work directory and the producer-Node refusal, which runs before the
  emptiness check: unchanged, still needs user error.*
- [~] **The consumer's and the smoke worker's composition has no node test.** *Low, unchanged since Step 7b.*
  *(rigor pass, F6 and F7)* `consume.mjs` hands `completeConsumer` the `supportRoot` that
  `runInstalledSmoke` uses and gives the local source lookup `isolatedGitEnvironment()`, and the worker picks
  its `node_modules` owner with `installedModulesOwner` and its root with `createInstalledSmokeRoot`; each
  line can be changed wrongly without a node test failing, and a CI consumer, never interrupted, would not
  notice a wrong `supportRoot`. The helpers themselves are tested. **Re-check:** export the consumer's
  composition with ports, as `produce.mjs` is, and assert that one `supportRoot` binding reaches both calls and
  that the Git call's environment equals `isolatedGitEnvironment()`.
  *(low · tools/cli-package/consume.mjs, tools/cli-package/smoke/worker.mjs)*
- [~] **The Windows interrupt, deadline and mode branches are not exercised.** *Low.* *(rigor pass, F14 and
  MCG-9)* `stopLiveCommands`' taskkill path, `runCommand`'s ungrouped deadline, `forwardInterrupts`' skip of
  ungrouped children, `stopBoundedChildren`'s fallback and the inventory's `not-observable-windows` mode
  evidence run only on Windows, and `pnpm test:acceptance-tools` runs only on Linux; packaging.md says so.
  **Re-check:** a Windows leg of the interrupt-free lifecycle checks (a stage past its deadline is killed at
  once with `graceMs > 0`) and of `tools/bundle-closure/closure.test.mjs`.
  *(low · tools/cli-package/process.mjs, tools/cli-bootstrap/process.mjs, tools/bundle-closure/inventory.mjs)*

Round 13, the acceptance round at `cf97b7f1` (no blocker, high or medium finding; security sitting clean),
reported ten verified findings, six of them distinct. Under the 2026-10-23 bar they are recorded here; the
documentation-only ones were also corrected in the acceptance commit, which changes no code.

- [~] **`forwardInterrupts`' group-wide forwarding has no test.** *Low.* *(round 13, TCA-9A1-R13-1)*
  `forwardInterrupts` sends the signal to each child's process group (`process.kill(-child.pid, signal)`), as
  its docblock says, but changing it to `process.kill(child.pid, signal)` passes `process.test.mjs` and
  `check.test.mjs`: the forwarding test checks only the leader's own marker. Every stage child today is
  detached into its own group, so the real composition behaves the same. **Re-check:** in the forwarding
  harness, have the detached child start a non-detached grandchild in its group that writes a marker on
  SIGINT, and assert both markers. *(low · tools/cli-package/process.mjs)*
- [x] **The map-source length bound is pinned on its admitted side only.** *Nit; closed in Step 9a.2a (2026-10-24), whose finalizer tests add the 1025-character source.* *(round 13, TCA-9A1-R13-2)*
  `finalize.test.mjs` admits a 1024-character source and refuses a 1031-character one, so loosening
  `source.length > 1024` to any bound up to 1030 passes. The source must still resolve to an existing original
  file, so nothing is exposed. **Re-check:** add a 1025-character source (`../src/${'a/'.repeat(507)}x.ts`)
  expecting `MAP_SOURCE_PATH`. *(nit · tools/cli-package/finalize.test.mjs)*
- [~] **A rule that lowers the exit code would let the guard exit 0.** *Nit, code half.* *(round 13,
  CRIT-9A1-R13-N1)* `release-guard.mjs` sets `process.exitCode = 1` once, so a rule that set
  `process.exitCode = 0` or called `process.exit(0)` would make the publish guard exit 0; today's rule always
  throws, and the guarantee that no way of invoking the guard skips the refusal holds. The wording that said
  the entry point "exits 1" is corrected. **Re-check:** when Step 9d replaces the rule, re-assert the code before
  the final line and keep it with an `exit` listener, with a test for each variant.
  *(nit · tools/cli-package/release-guard.mjs)*
- [x] **Documentation corrected in the acceptance commit.** *(round 13)* The contract's store-discovery list
  now names `NPM_CONFIG_STORE_DIR`, which the code forwards (low; PLAN-9A1-R13-1 = INT-9A1-R13-1, also
  PFC-R13-N1 and TCA-9A1-R13-3); the deadline's group kill is described as happening when the grace ends or as
  soon as the stage exits (PLAN-9A1-R13-N1); the guard's wording says it sets its exit code to 1 before its rule
  runs (CRIT-9A1-R13-N1, wording half); and this file's freshness line is current (PLAN-9A1-R13-N2 =
  INT-9A1-R13-N1). **Re-check:** the contract's list equals `STORE_DISCOVERY_VARIABLES` in
  `tools/cli-package/candidate.mjs`. *(docs/reference/cli/packaging.md, tools/cli-package/README.md,
  .github/workflows/release.yml)*

Observed in 9a.1's push CI and its preflight for 9a.2 (2026-10-24):

- [~] **A migration-running database test lacks the explicit timeout its siblings carry.** *Low.* *(author,
  push CI run 40050981969)* In `packages/db/src/session-effect-turns.test.ts`, the parametrized case
  `refuses issuance inside an outer %s transaction before any key can escape a rollback` runs every migration
  per case under vitest's default 5 s, while its siblings that migrate pass `30_000`; on the advisory Windows
  runner the `exclusive` case took 7.7 s and failed. 9a.1 changed no database source. The advisory Windows job
  failed 6 times in the last 40 CI runs, each a default 5 s timeout on a different SQLite- or
  process-heavy test (`fs-workspace-admission`, `concurrency.e2e`, the runner-abort ownership case and this
  one); the job was advisory then and every required job passed. **Since 2026-11-04 the Windows job is a required
  check** (the PR #96 review ruling), so such a timeout now blocks a merge; it has been green for 14 consecutive runs
  since 2026-10-25 (D64 round 2 on the PR #96 correction). **Re-check:** measure the failure's cause and rate before
  changing a bound, then give the case its siblings' `30_000` and review the other three tests' bounds against the
  Windows runner, when the file is next edited or the Windows job next fails on any run. *(low ·
  packages/db/src/session-effect-turns.test.ts)*
- [ ] **`--verbose` never prints a real stack.** *Low, for Step 10a.* *(9a.2 preflight)*
  `apps/cli/src/process/render-user-facing.ts` (`ownErrorStack`) prints a stack only when `stack` is an own
  data property, but V8 defines a real error's `stack` as an accessor (get/set), so a thrown `Error` prints
  nothing under `--verbose`; `render-error.test.ts` constructs a data `stack`, so the tests pass. Step 10a
  replaces this raw-stack branch (row 10a). **Re-check:** the replacement prints a real error's frames, tested
  with a thrown `Error` rather than a constructed property. *(low · apps/cli/src/process/render-user-facing.ts)*

## Wave 3 Step 9a.2a — recorded low findings (2026-10-24)

The internal rigor pass over Step 9a.2a at `1ab4c134`, run before its first review round under the
[2026-10-23 acceptance amendment](phases/phase-2.5.5-hardening-and-remediation.md#wave-3-step-9a1-implementation-checkpoint--2026-10-22),
corrected both high findings, every medium one and every low or nit it could close inside the increment
([checkpoint](phases/phase-2.5.5-hardening-and-remediation.md#wave-3-step-9a2a-implementation-checkpoint--2026-10-24)).
These are recorded instead. **Trigger for every entry:** the next change to the file it names, or a real run
that shows the shape.

- [~] **The symbolication child is not sandboxed.** *Low; a named limit.* *(rigor pass, SEC-9A2A-2)*
  `captureFrames` runs the candidate CLI's runtime import closure — packages that before 9a.2a ran only in the
  consumer jobs — as the producer's user, with network access, in the job whose sibling `staging` directory
  holds the private maps and manifest. Its isolated environment and owner-only work directory confine it,
  and, within the capture process only, the refusal of any module outside the candidate and the refused
  keyring and native addons (added after review round 1); a thread or subprocess the candidate started
  without the preload (an eval Worker, a `node -e` child) would have none of them, and `relavium import`
  starts none, though nothing enforces that or that it stays offline. packaging.md names the limit.
  **Re-check:** when Step 9b designs the custody job, run the capture child and every descendant under an
  OS sandbox or a separate user that cannot read `staging`. *(low · tools/cli-package/symbolicate.mjs)*
  *Re-checked after rounds 1 and 2 (2026-10-24): the module confinement narrows the limit; the record and
  packaging.md now say the refusals are in-process only.* *Re-recorded 2026-10-25 (Step 9b preflight
  decisions): Step 9b adds a library and synthetic controls and designs no custody job, so the trigger moves
  to Step 9d, which designs the release job.*
- [ ] **Two packs of one source can differ in the packed manifest's key order.** *Low, for Step 9c.* *(rigor
  pass, integration lens)* Two productions of the same tree packed the five `@relavium/*` `devDependencies`,
  which pnpm rewrites from `workspace:*` to versions at pack time, in different orders (`core, llm, shared,
  mcp, db` and `core, db, shared, llm, mcp`; the source order is alphabetical). Every other tarball entry was
  byte-equal and the sorted contents agree, but the two tarballs' SHA-256 differ (`84065f84…` and
  `d0f5b8da…`). The package-test receipt binds the one tarball it inspected, so nothing is wrong today; a
  release candidate simply cannot be rebuilt to the same digest. **Re-check:** in Step 9c's no-rebuild rules,
  never compare a rebuilt digest, or make the published manifest's key order deterministic, with a test that
  packs twice and compares the digests. *(low · tools/cli-package/prepack.mjs and pnpm's pack step)*

Round 3, the acceptance round at `a92a7602` (no blocker, high or medium finding and no regression; the security
sitting, plan, correctness and integration lenses and the critic clean), reported three verified findings. The
wording nit is corrected in the acceptance commit, which changes no code (the PLAT-9 re-check note above now
names both `produce.mjs` changes, INT-9A2A-R3-1); the two test gaps are recorded here.

- [~] **Symbolication's three read bounds have no test.** *Low.* *(round 3, TCA-9A2A-R3-1)* `symbolicate.mjs`
  reads the dirty source copy under 8 MiB (`readSourceRevision`), the staged map under 16 MiB (`mapsOf`) and
  each re-hashed frame file under 16 MiB; raising all three tenfold leaves `symbolicate.test.mjs` passing. It is
  defense in depth: the manifest step reads the same maps and sources under the same bounds, and every file is
  bound by digest. **Re-check:** one case per site, as `manifest.test.mjs`'s bounded reads do — pad the dirty
  copy, the staged map (re-recording its manifest digest) and a dist chunk (re-sealing) one byte past the bound
  and expect a refusal before any digest comparison — then rerun the three mutants.
  *(low · tools/cli-package/symbolicate.mjs, tools/cli-package/symbolicate.test.mjs)*
- [~] **No test shows that an injected anchor table is enforced.** *Nit.* *(round 3, TCA-9A2A-R3-2)* A mutant
  that loops over the module's `ANCHORS` instead of the `anchors` argument survives: the only injected table
  that reaches mapping, `[...ANCHORS, ANCHORS[0]]`, repeats a reached anchor. Production uses the default.
  **Re-check:** add an anchor whose source the manifest maps and whose call site resolves in the source revision
  but that no captured frame reaches, and expect `ANCHOR_UNMAPPED`. *(nit · tools/cli-package/symbolicate.test.mjs)*

## Wave 3 Step 9a.2b — recorded low findings (2026-10-24)

The internal rigor pass over Step 9a.2b at `77ee5d0a`, run before its first review round under the
2026-10-23 acceptance amendment, corrected its high finding, every medium one and the lows it could close
inside the increment
([checkpoint](phases/phase-2.5.5-hardening-and-remediation.md#wave-3-step-9a2b-implementation-checkpoint--2026-10-24)).
These are recorded instead. **Trigger for every entry:** the next change to the file it names, or Step 9d
for the two release entries.

- [~] **The runner's cleanup and its copies' placement have no test.** *Low.* *(rigor pass, F5)* Removing
  `runMapControls`' removal of its own temporary root, or moving a control's copies out of the staging, passes
  every test; the real runner shows the placement, but nothing asserts it. **Re-check:** a test that runs the
  runner's composition with recording ports (as `produce.test.mjs` does) and asserts every `scratch` path lies
  under the staging and the temporary root is gone afterwards. *(low · tools/cli-package/map-controls-core.mjs)*
- [~] **An interrupted runner can leave its own temporary directory.** *Low.* *(rigor pass, PLAT-9A2B-6 =
  SEC-9a2b-5 = INT-2; round 2, CRIT-9A2B-R2-1)* The producer's interrupt handler empties the artifact directory and
  exits, so `runMapControls`' `finally` never removes `relavium-map-controls-*/artifact`; and an interrupt after
  `producePackage` returned, during the final identity check, leaves the baseline public tarball and its
  `package_test` receipt in it. Nothing private.
  **Re-check:** remove the runner's root from the interrupt path too (for example with `exitOnInterrupt` around
  the run), with an interrupt test. *(low · tools/cli-package/map-controls-core.mjs)*
- [~] **The runner's own self-check refusals have no test.** *Low.* *(rigor pass, CRIT-9A2B-2)*
  `PACKED_CLI_MAP_CONTROL_CHECKOUT_CHANGED`, `_RESTORE`, `_NO_ANCHOR_CHUNK`, `_TARGET`, `_KIND` and `_ORIGIN` are
  checked only by reading and, for the target and kind checks, by a runner mutation run. **Re-check:** unit
  tests that drive each refusal through the runner's composition with stubbed ports. *(low ·
  tools/cli-package/map-controls-core.mjs)*
- [~] **Release artifacts are not bound to a successful `ci` run at their commit.** *Medium, for Step 9d.*
  *(rigor pass, PLAT-9A2B-2 = CLM-9A2B-4 = INT-1)* A release dispatch with `allow_off_main`, or of an intermediate
  commit, writes a `package_test` receipt at a commit no `ci` run (so no map-controls run) ever covered;
  packaging.md now says the mode is a claim and when it is backed, and the interim guard refuses every such
  artifact. **Re-check:** Step 9d's release graph or custody validator requires a successful `ci` run (with
  `map-controls`) at exactly the candidate's commit. *(medium · .github/workflows/release.yml)*
- [~] **The release pack job keeps its `pnpm` dependency cache.** *Low, for Step 9d.* *(rigor pass,
  CLM-9A2B-8)* `release.yml`'s pack job sets `cache: pnpm` while `ci.yml`'s `pack-cli` and `map-controls` refuse
  it; the store holds only content-addressed public registry packages, which packaging.md permits, so no map
  can enter it. **Re-check:** when Step 9d rebuilds the release graph, drop the cache or record why the release
  pack keeps it. *(low · .github/workflows/release.yml)*

Round 2, the acceptance round at `0f73c253` (no blocker, high or medium finding and no regression; the plan and
correctness lenses clean, the security sitting one low), reported seven verified findings. The plan's increment
count, the freshness line and the interrupted-runner wording are corrected in the acceptance commit, which changes
no code (INT-9A2B-R2-1, INT-9A2B-R2-2, CRIT-9A2B-R2-1, the last also amending the entry above); these are recorded.

- [~] **The workflow-level environment of the map-controls job is not pinned.** *Low.* *(round 2, SEC-9A2B-R2-1 =
  TCA-9A2B-R2-3)* `checkMapControls` pins the job's own `env` but not ci.yml's top-level `env`, which every job
  inherits, nor a job `container` or `services` key; a workflow-wide `NODE_OPTIONS` preload or a secret would reach
  the controls step with every pin passing. **Re-check:** pin `Object.keys(workflow.env)` to the two Turbo keys the
  job overrides, assert `job.container` and `job.services` are undefined, and add the negative cases.
  *(low · tools/ci/require-packed-cli.test.mjs)*
- [~] **A narrowed set of anchor-bearing chunks goes unnoticed.** *Low.* *(round 2, TCA-9A2B-R2-1)* The verdict
  derives the per-chunk ids from the runner's own chunk count, required only to be at least one, so a regression
  that drops a chunk (for example `.slice(0, 1)` on the derivation) leaves the runner green with 21 controls.
  **Re-check:** derive the expected count independently — every ANCHORS source covered by at least one controlled
  chunk — or test the composition with recording ports. *(low · tools/cli-package/map-controls-core.mjs)*
- [~] **Removing a refused control build's `dist` has no test.** *Low.* *(round 2, TCA-9A2B-R2-2)* Deleting the
  `rmSync` in `pack()` passes everything; the bundler's maps would stay in the candidate's `dist` (inside the
  producer's owner-only root) until the next build. **Re-check:** with the composition test of the F5 entry, assert
  `dist` holds no `.map` file after each refused control build. *(low · tools/cli-package/map-controls-core.mjs)*

## Wave 3 Step 9b.1 — named limits (2026-10-25)

Recorded with the Step 9b.1 implementation
([checkpoint](phases/phase-2.5.5-hardening-and-remediation.md#wave-3-step-9b1-implementation-checkpoint--2026-10-25)).
**Trigger for every entry:** the next change to the file it names, or a release producer on that platform.

- [~] **The custody tests do not run on Windows, and `encryptOnce` refuses there.** *Low; a named limit.*
  No Windows job runs `test:acceptance-tools`; the `gpg` on the Windows image's PATH is Git for Windows'
  MSYS2 build in `usr\bin`, and MSYS2's own GnuPG under `C:\msys64` is installed off PATH, neither exercised
  here, and the tests use POSIX process and permission tools (`ps`,
  owner-only modes), so `docs/runbooks/local-dev-setup.md` sends Windows developers to WSL. Windows modes
  say nothing about access and no ACL check exists, so since round 2 (SEC-9B1-R2-2) no private root
  qualifies there and every encryption refuses `PRIVATE_ROOT` before any GnuPG call. **Re-check:** before
  a release producer runs on Windows, add an ACL-based owner-only check for the private root and its work
  directory, then run the custody tests on that runner and record which of the two `gpg.exe` builds `resolveGpg` selects
  and whether its Windows path handling and gpgconf's line ending pass. *(low ·
  tools/cli-package/custody.mjs, tools/cli-package/gnupg.mjs)*
- [~] **An interrupted custody test run can leave its ephemeral key home.** *Low; test-only.* *(rigor pass,
  SEC-9B1-PS-2)* `gpg-fixture.mjs` removes the round-trip key's home, its synthetic secret export and its
  agent in `after()`, which a SIGINT to `node --test` skips: the `rg-*` and `rge-*` directories under the
  temporary directory and an orphaned `gpg-agent` remain. The key is synthetic and never decrypts a
  product archive. **Re-check:** stop the agent and remove both directories from a process exit hook as
  well. *(low · tools/cli-package/gpg-fixture.mjs)*
- [~] **The pre-check counts only the keys GnuPG lists.** *Low; fail-closed.* *(rigor pass, SEC-9B1-PS-5)*
  `--show-keys` omits a key an import would reject, for example one whose user ID packet was removed, so a
  recipient file holding such a key before the pinned one passes the one-key rule. GnuPG then encrypts to
  the first key in the file and refuses it, and `KEY_CONSIDERED` and the recipient check refuse any other
  outcome, so nothing is published. **Re-check:** count primary-key packets independently of import
  filtering if a recipient file is ever produced by anything but `gpg --export`. *(low ·
  tools/cli-package/custody.mjs)*
- [~] **Secret material GnuPG neither lists nor reads is admitted.** *Low; round 1, R1-COR-2.* A binary
  secret key appended after the armored public block is ignored by GnuPG's listing and encryption, so the
  pre-check admits the file and the ciphertext is published. The secret stays in the recipient file and
  never reaches the ciphertext, the record or a log. **Re-check:** refuse any byte after the armored public
  block's end line (or any secret-key packet tag in a packet walk) if recipient files are ever produced by
  anything but `gpg --armor --export`. *(low · tools/cli-package/custody.mjs)*
- [~] **The atomic publish has no fault-injection test.** *Low; round 1, T-9B1-R1-3.* `publish` writes a
  temporary sibling and hard-links it to the final name; writing the final name directly also passes every
  test, because no test makes the write fail midway. **Re-check:** inject a write failure (a full
  filesystem or a writer port) and assert no file exists under the final name afterwards. *(low ·
  tools/cli-package/custody.mjs)*
- [~] **The GnuPG 2.2.8 floor is enforced, never exercised.** *Low; a named limit.* The version check
  refuses an older GnuPG, but the tests ran only on 2.5.21 (local) and 2.4.4 (Ubuntu 24.04), so neither
  encryption nor the `gpg -d | tar -x` recovery is proven on 2.2.8. **Re-check:** run the custody tests
  against GnuPG 2.2.8 (for example in a container that ships it) before a recovery runbook names that
  version. *(low · tools/cli-package/gnupg.mjs)*

## Wave 3 Step 9b.1 — recorded low findings (2026-10-25)

Recorded with the Step 9b.1 acceptance after round 4
([acceptance](phases/phase-2.5.5-hardening-and-remediation.md#wave-3-step-9b1-acceptance--2026-10-25)).
**Trigger for every entry:** the next change to the file it names, or Step 9d's release integration.

- [~] **A temporary sibling that cannot be removed after the link reports `UNEXPECTED`.** *Low; round 4,
  COR-9B1-R4-1.* `publish` removes its `.partial` sibling in a `finally`. If that removal fails (`EACCES`,
  `EROFS`, `EIO`) after `linkSync` succeeded, `encryptOnce` refuses `UNEXPECTED` with no record although the
  ciphertext is published; the sibling, ciphertext only and never plaintext, stays beside it, and a retry
  refuses `ALREADY_ENCRYPTED`. Example: make the destination 0500 right after the link. **Re-check:** make the
  removal best-effort once the link succeeded, or refuse with a code that says the ciphertext was published, and
  inject that failure in a test alongside T-9B1-R1-3's. *(low · tools/cli-package/custody.mjs)*
- [~] **No test pins the metafile's 4 MiB bound.** *Low; round 4, T-9B1-R4-1.* The container's record-bound
  tests pad from `RECORD_BYTES` itself, so changing `'metafile-esm.json'` to 8 MiB passes every test while the
  contract says 4 MiB; `manifest.test.mjs` pins the other two values. The container and `seal.mjs` share the
  constant, so every record still stays within its reader's bound. **Re-check:** assert `RECORD_BYTES`'s literal
  values, or pad the metafile to a literal 4 MiB plus one byte. *(low · tools/cli-package/manifest.mjs)*
- [~] **No test builds the container from a real finalizer's staging.** *Low; round 4, INT-9B1-R4-1.* The
  container requires the finalizer record's exact key sets, but every container and custody test uses
  `candidate-fixture.mjs`'s hand-written record and a stub metafile. A field added to `finalize.mjs`'s record
  would pass every gate and refuse `CONTAINER_RECORD` on every real staging. A reviewer's probe built,
  encrypted, decrypted and extracted a real production's staging at `147c2788` without a refusal. **Re-check:**
  build and read back the container once from a real production's sealed staging (map-controls' seal port holds
  one), or pin the record's key set in `finalize.test.mjs`; at the latest in Step 9d. *(low ·
  tools/cli-package/container.mjs, tools/cli-package/finalize.mjs)*
- [~] **The overlap check misses containment through a bind mount.** *Low; round 4, CRIT-9B1-R4-1.* `within`
  compares device and inode along each path's own ancestors. It catches one directory reached by two spellings
  (a case-insensitive variant, or a bind mount of exactly that directory), but not a root that is a bind mount
  of a directory inside the destination, or the reverse: the work directory and its plaintext then sit inside
  the destination's tree while GnuPG runs. A bind mount needs privileges to set up. The acceptance commit
  narrows the contract's sentence; `custody.mjs`'s comment still says a bind mount can give one directory two
  spellings, without the limit. **Re-check:** in Step 9d, create the root and destination as fresh sibling
  directories of the job, or compare against the mount table, before relying on the refusal; narrow the comment
  on the next change to `custody.mjs`. *(low · tools/cli-package/custody.mjs)*

## Wave 3 Step 9b.2 — named limits and handoffs (2026-10-25)

Recorded with the Step 9b.2 implementation
([decisions](phases/phase-2.5.5-hardening-and-remediation.md#wave-3-step-9b2-preflight-decisions--2026-10-25)).
The release modules are library code with synthetic controls only: nothing outside their tests calls them.
**Trigger for every entry:** Step 9d's release integration, or the next change to the file it names.

- [~] **An orphaned ciphertext can never be sealed.** *Low; a named limit.* Only a record the gate returned in
  the same process seals, so a ciphertext whose seal never succeeds before its process exits — after a crash, or
  a refusal on an input the gate does not check, such as a malformed origin or an entry added to the
  destination after encryption — is named by no record. The gate refuses a linked or unresolvable destination,
  any entry but the tarball and a different tarball before encrypting, which removes the likeliest causes. The candidate then needs manual recovery
  (packaging.md's missing-asset state); it is never re-encrypted. **Re-check:** in Step 9c's reservation
  states, classify such a directory as incomplete and route it to manual recovery. *(low ·
  tools/cli-package/release-custody.mjs)*
- [~] **Reuse cannot re-check the ciphertext's recipients.** *Low; a named limit.* `verifyRetainedCandidate`
  binds each asset's size and SHA-256 to the receipt, and the receipt's recipient to the expected history, but
  re-reading the ciphertext's public-key packets (`ENC_TO`) needs GnuPG, which reuse never calls. The digest
  ties the bytes to the ones the sealer re-read after encryption checked their single recipient. **Re-check:**
  if a retained ciphertext can ever come from anything but the sealer, verify its recipients with the isolated
  runner before reuse. *(low · tools/cli-package/release-binding.mjs)*
- [~] **A sibling left after the receipt's link keeps the candidate from reuse.** *Low; a named limit (rigor
  pass, SIT-9B2-6).* When the sealer cannot remove its `.partial` sibling after the link, the receipt is
  published and the seal succeeds, but `verifyRetainedCandidate` admits exactly three entries and refuses
  `CANDIDATE_ENTRIES` until the sibling is removed by hand; a test pins that state. **Re-check:** in Step 9c's
  state classification, report such a directory as sealed with a stray sibling. *(low ·
  tools/cli-package/release-custody.mjs)*
- [~] **The fixture denylist covers only the fingerprints the fixtures' pins file lists.** *Low; a named limit
  (rigor pass, CLAIM-9B2-2).* `two-encryption-subkeys.asc` carries a second encryption subkey,
  `7BC68AC7D2944C2AB3240A521D784594073951D5`, that `custody-fixtures/pins.json` does not list, so a production
  history naming it would load. The loader reads no key material (it makes no GnuPG call), and encrypting to it
  would still need its armored key in the committed recipient file. **Re-check:** list every committed fixture
  fingerprint in the denylist when the fixtures are next generated. *(low · tools/cli-package/release-recipient.mjs)*
- [~] **`encryptOnce` called directly follows a link spelled with a trailing separator.** *Low; a named limit
  (round 2, COR-R2-2).* 9b.1's `plainDirectory` and `privateDirectory` lstat the path as given, and `lstat('link/')`
  follows the link, so a direct caller of `encryptOnce` can encrypt into a linked destination or use a linked
  private root. The release gate requires both paths in normalized absolute form and refuses a link itself, so
  no release path reaches this; nothing outside the gate and the tests calls `encryptOnce`. **Re-check:** on the
  next change to `custody.mjs`, require normalized absolute paths there too. *(low · tools/cli-package/custody.mjs)*
- [~] **The release entry points accept the test ports.** *Low; a named limit (round 1, SIT-R1-5).*
  `encryptCandidate` forwards `encryptOnce`'s `run` and `gpg` ports and `sealReleaseBinding` takes a `write`
  port, in production scope too, so an in-process caller could replace GnuPG and defeat its checks. Like the
  brand, the ports guard against an honest mistake, not hostile code in the same process. **Re-check:** in Step
  9d, call both without ports from the release job and add a permanent control that no product call passes
  them. *(low · tools/cli-package/release-custody.mjs)*
- [~] **The release modules do not run on Windows.** *Low; a named limit.* Like the 9b.1 tests, the release
  tests run only in `test:acceptance-tools`, which no Windows job runs; `encryptCandidate` refuses there
  through `encryptOnce`'s `PRIVATE_ROOT`, while reuse is platform-neutral but unexercised. **Re-check:** with
  the 9b.1 Windows limit. *(low · tools/cli-package/release-binding.mjs)*
- [ ] **Step 9d handoffs.** *Scheduled → Step 9d.* Wire `encryptCandidate` and `sealReleaseBinding` into the
  originating job, with the origin from `originFromEnvironment`; bind the receipt's `origin` to the trusted run
  and attempt (on reuse, the original run) and `mapCheck` to a successful `ci` run with the product map
  controls at `source.commit`; derive release smoke's public inventory and package metadata from the
  digest-verified tarball with the package-test inspector; check the production recipient before any
  reservation, so a recipient refusal never leaves an incomplete reservation; if the package-test receipt
  travels beside the tarball, widen the gate's, the sealer's and reuse's directory admission together, since all
  three admit exact entries (round 2, CRIT-9B2-R2-1); replace the interim guard; then update
  `release-scope.test.mjs`'s interim control that no product path or workflow names a release module, keeping
  its permanent controls (the loader takes no argument and its test seam stays out of product code; only the
  gate imports `encryptOnce`); and include `tools/cli-package/custody-fixtures/pins.json` in every checkout
  that loads the production recipient, because the loader reads it as its denylist. The guard test's
  non-canonical `relavium-0.1.1.tgz.gpg` name is corrected with the guard. *(scheduled ·
  tools/cli-package/release-custody.mjs, tools/cli-package/release-guard-core.mjs)*

## Wave 3 Step 9b.2 — recorded low findings (2026-10-26)

Recorded with the Step 9b.2 acceptance after round 4
([acceptance](phases/phase-2.5.5-hardening-and-remediation.md#wave-3-step-9b2-acceptance--2026-10-26)).
**Trigger for every entry:** Step 9d's update of `release-scope.test.mjs` and the release modules, or the next change
to the file it names.

- [~] **The `custody.mjs` control does not decode identity or legacy octal escapes.** *Low; round 4, PLAN-9B2-R4-1,
  COR-R4-2.* `namesFile` decodes `\x`, `\u`, `\u{…}` and percent escapes, but a specifier such as
  `'./custo\dy.mjs'` (an identity escape) or a sloppy-mode octal escape still loads `custody.mjs` unseen. The
  spelling is deliberate, never an honest mistake. **Re-check:** also match a variant with each stray backslash
  removed and octal escapes decoded, or refuse any backslash in a specifier. *(low ·
  tools/cli-package/release-scope.test.mjs)*
- [~] **The static controls skip `tools/lint-fixtures/assert-fence.mjs`.** *Low; round 4, PLAN-9B2-R4-2.* The scan
  treats all of `tools/lint-fixtures/` as test-only, but `assert-fence.mjs` is CI tooling (`pnpm lint:fence-check`), so
  a `custody.mjs`, fixture or test-seam reference there passes the controls. **Re-check:** exempt only the quarantined
  `.ts` fixtures and add the script to the scan's own assertion. *(low · tools/cli-package/release-scope.test.mjs)*
- [~] **The closure's specifier scan has blind spellings.** *Low; round 4, SIT9B2-R4-L1, COR-R4-3, T-R4-3.* A comment
  between `from` or `import` and the specifier, a specifier containing the other quote character, and computed member
  access such as `process['getBuiltin' + 'Module']` each pass the closure control, which proves reuse starts no
  process. Each spelling is deliberate, and today's closure contains none. **Re-check:** strip comments and tokenize
  string literals properly before scanning, and refuse computed access on `process` in closure files. *(low ·
  tools/cli-package/release-scope.test.mjs)*
- [~] **The loader reads the root by path after its link check.** *Low; round 4, COR-R4-4.* `lstat` then `readdir`
  and the two reads leave a window in which a swapped root is read through a link and branded. Only a committed,
  maintainer-owned directory is read in production. **Re-check:** open the root with `O_DIRECTORY | O_NOFOLLOW` and
  compare its device and inode before and after the reads, as `readOrdinaryFile` does for files. *(low ·
  tools/cli-package/release-recipient.mjs)*
- [~] **Some exact rules have no isolating test.** *Low; round 4, T-R4-1, T-R4-2, T-R4-4.* No history puts its current
  entry before a retired one, so choosing the last entry would pass; the toolchain's prerelease suffix (its character
  set and 64-character bound) and the target's digit count (three admitted, four refused) are unpinned; and a nit:
  the sealed-link case asserts the first link's target, and the non-POSIX fallback of the linked-tarball case removes
  the tarball instead. **Re-check:** add those cases on the next change to the release tests. *(low ·
  tools/cli-package/release-recipient.test.mjs, tools/cli-package/release-binding.test.mjs,
  tools/cli-package/release-custody.test.mjs)*

## PR #96 review — recorded findings and Sonar dispositions (2026-11-04)

Recorded by the PR #96 review correction. The review's verified high and medium findings and SonarCloud's 27 bugs and
10 vulnerabilities were fixed in that correction; these are the verified lows and the code smells the maintainer
ruled on 2026-11-04 to record rather than refactor now. **Trigger for every entry:** the next change to the file it
names, unless the entry names another.

**Sonar code smells (gate-neutral; maintainability stays A):**

- [~] **Cognitive complexity (`S3776`) in fifteen functions.** *Low.* `packages/core/src/tools/bounding.ts` (five,
  18–38), `packages/llm/src/scrub-secrets.ts:411`, `tools/cli-package/source-map.mjs:47` (35), `map-controls-core.mjs`,
  `release-custody.mjs`, `candidate.mjs`, `release-binding.mjs`, `symbolicate.mjs`, `ustar.mjs`,
  `tools/bundle-closure/closure.mjs` and `inventory.mjs`. Each is security-critical redaction or release tooling, so a
  refactor needs its own mutation sweep and review. *(low · the files named)*
- [~] **Regex complexity (`S5843`): eight reports on seven patterns.** *Low.* `bounding.ts`'s scheme and key rules
  (the key rule reported twice) and five `scrub-secrets.ts` rules: their "complexity" is the length of a finite name or shape alternation (as the existing
  `NOSONAR` notes say), and each is a causal-control anchor. The three `S5869` reports on `scrub-secrets.ts:138` are
  the `i` flag making `A-Z` and `a-z` overlap, not a duplicate. **Re-check:** split a rule only with its controls.
  *(low · packages/core/src/tools/bounding.ts, packages/llm/src/scrub-secrets.ts)*
- [~] **`S1994` on the closing-view loop.** *Low.* `bounding.ts`'s backward scan tests `next` but steps `index`; a
  `while` rewrite must keep the step that its `continue` skips. *(low · packages/core/src/tools/bounding.ts)*
- [~] **`S6582` in `media-store-paths.ts` (three).** *Low.* The optional-chain rewrites are equivalent, but the lines
  are filesystem causal-control anchors; change them with those controls. *(low · packages/db/src/media-store-paths.ts)*
- **DECLINED — `S9382` (seven sequential awaits) and `S7758` (five `charCodeAt`).** The awaits are ordered process
  steps by design (`map-controls-core.mjs`, `pipeline.mjs`, `symbolicate.mjs`), and `source-map.mjs` is a code-unit
  VLQ parser that advances one code unit at a time, which `codePointAt` would misstate.

**Redaction:**

- [ ] **A URL password that holds a `,` or `/` leaves the whole userinfo public (the PR #96 review's A4).** *Medium as
  reviewed. Pre-existing against `64fb8772`, but a reversal against `main`, which masks it since `0826f30a`: merging
  PR #97 returns the URL projection to `64fb8772` (maintainer ruling 2026-11-06).* Core's authority scan ends at
  either, so `https://user:pa,ss@host` and `https://user:pa/ss@host` leave `user:pa,ss` and `user:pa/ss` visible in
  `toolInput`, summaries and the journal digest input; the PR #97 review measured about thirty such shapes `main`
  masks today, among them a comma in a `git clone` URL's password, `mysql://`, `postgres://`, `ftp://` and `redis://`
  URLs with a `/` in the password, and `x-access-token` URLs. The LLM backstop masks the comma spelling but stops at
  `/` too. A reading past the delimiter landed with the PR #96 correction and was removed on 2026-11-05 (maintainer:
  one careful pass, then continue): the projection repeats until stable, so a reading's mask can change the text
  other rules read in a later pass, and D64 rounds 1, 3 and 4 each found a credential it newly showed. A new reading
  must keep a port and a path public (`host:8080/a@b`, pinned in `bounding.test.ts`). **Trigger:** before the v0.2.0
  release, as its own increment (maintainer 2026-11-06): a design that computes the reading's ranges once on the
  original text and merges them with the base rules' after the fixed point, so it provably only adds masks, with a
  superset oracle validated against both `64fb8772` and `b3cf117e`. *(medium as reviewed ·
  packages/core/src/tools/bounding.ts, packages/llm/src/scrub-secrets.ts)*
- [~] **A glued `-pSECRET` (`mysql -uroot -pSecret`) is not masked.** *Low.* A glued `-p` is ambiguous with
  `cp -pR` and `tar -pxf`, so only the separate and `=` spellings are read. *(low · packages/core/src/tools/bounding.ts)*
- [~] **The object-key rule masks count keys such as `max_tokens`.** *Low.* Its plural folding reads `tokens` as
  `token`, so two calls that differ only in `max_tokens` share a journal identity. The argv rule reads words as written
  and does not. *(low · packages/core/src/tools/bounding.ts)*
- [~] **Zero-width characters break the `sk-` and `Bearer` shapes; header names are matched with hyphens only.**
  *Low; verified.* *(low · packages/llm/src/scrub-secrets.ts)*
- [~] **A model-supplied tool name reaches an error message unmasked and unbounded.** *Low; verified.* *(low ·
  packages/core/src/tools/errors.ts:21)*
- [~] **Two redaction engines and two fixed-point copies; the parity test compares booleans only.** *Low; verified.*
  *(low · packages/core/src/tools/bounding.ts, packages/llm/src/scrub-secrets.ts)*
- [~] **Permanent causal controls for this correction's three mechanisms.** *Low.* The credential-flag words, the
  `,`/`/` password reading and the omitted-media bytes are pinned by permanent tests and a manual mutation sweep (every
  mutant killed), not by `check:secrets-mutations` controls. The secrets evidence has about 15 MiB of headroom per
  shard. *(low · tools/secrets-controls/mutations.mjs)*

**Release, custody and tooling (verified lows):**

- [~] **`isProductionRecipient` accepts seam values; the distinction rests on a grep control.** *(low ·
  tools/cli-package/release-recipient.mjs:52)* Trigger: Step 9d or Wave 4b.
- [~] **A revocation is visible only in the committed recipient snapshot.** *(low · docs/reference/cli/packaging.md)*
- [~] **`resolveGpg` checks `isFile`, not `X_OK`.** *(low · tools/cli-package/gnupg.mjs:33)*
- [~] **A developer's own `core.excludesFile` directory can let private untracked files into the candidate.** The
  public tarball is not affected; an explicit `RELAVIUM_GIT_EXCLUDES_FILE` naming a directory already fails in Git.
  *(low · tools/cli-package/candidate.mjs)*
- [~] **`prepack.mjs` selects the finalizer by environment variable; `symbolicate.mjs` may load TypeScript from a parent
  directory.** The closure check is equivalent for the first. *(low · tools/cli-package/prepack.mjs:36,
  tools/cli-package/symbolicate.mjs:306)*
- [~] **`runCommand` does not follow detached grandchildren after a successful exit; `causal-controls` starts a
  detached group without a Ctrl-C handler; the smoke's cleanup can skip its PID kill after a parse error.** *(low ·
  tools/cli-package/process.mjs, tools/causal-controls/, tools/cli-package/smoke/)*
- [~] **`mcp-orphan.e2e` scans the process table by fixture name, which sibling tests share; `vi.waitFor` keeps its
  1-second default.** *(low · packages/mcp)*
- [~] **The case-insensitive custody tests run in no CI job.** *Medium as reviewed, low in practice.* Ubuntu skips
  them and no macOS or Windows job runs `custody.test.mjs`; the local `pnpm run ci` on macOS runs them. A CI lane
  needs a macOS job inside `ci`'s success aggregation. *Re-checked 2026-11-18, still open:* `ci.yml` gained one macOS job
  (`macos-native-metadata`, advisory), but it runs only `fs-macos-metadata.test.ts`; no macOS or Windows job runs `custody.test.mjs`. *(low ·
  tools/cli-package/custody.test.mjs:855, .github/workflows/ci.yml)*
- [~] **CI no longer runs the real-GnuPG AEAD refusal.** *Low.* *(2026-11-05)* `ubuntu-latest` moved to ubuntu-26.04,
  whose GnuPG reports SEIPDv1 for the AEAD-advertising fixture, so the custody test now reads GnuPG's own status line
  and expects admission there. The real OCB refusal runs only where GnuPG picks OCB (the local `pnpm run ci` on
  macOS); the synthetic status rewrites still cover the refusal logic on every runner, and the test's diagnostic
  says which branch ran. The status line is also the only evidence: a GnuPG that wrote AEAD but reported `2 9` would
  pass both the product and the test. **Re-check:** with the macOS lane above, or a packet-level `gpg
  --list-packets` check of the ciphertext. *(low · tools/cli-package/custody.test.mjs, tools/cli-package/custody.mjs)*
- **DECLINED — declaring `RELAVIUM_CLI_CANDIDATE_STAGING` in `turbo.json`.** The candidate build never runs through
  Turbo (`pnpm exec tsc` and `pnpm pack`), and Turbo 2's strict environment mode withholds an undeclared variable, so
  a Turbo build is always map-free; declaring it would let one become a candidate build.

**D64 round 1 on this correction (2026-11-04, at `f25fb83d`).** A cumulative round of four scoped reviewers and a
separate security sitting, with one adversarial verifier per medium-or-higher finding, read the whole correction ([D61
checkpoint](phases/phase-2.5.5-hardening-and-remediation.md#d61-checkpoint--pr-96-merged-2026-11-04)). Its five
confirmed medium findings and the lows in the correction's own code and documents were fixed in the follow-up; these
lows are recorded:

- [~] **The argv rules are program-agnostic, so a value a boolean flag precedes is masked and calls that differ only
  there share one journal identity.** `-u`/`--user` masks any colon-bearing value (`docker run -u app:app`, `date -u
  +%H:%M`, `python -u C:\a.py`), and a boolean flag whose last word names a credential (`--ask-vault-password
  site.yml`) masks the next argument, and the one after it when that is itself a credential flag (round 3); on a crash-resume where the model changes exactly that element, the slot replays
  the committed result instead of refusing. Fix ideas: exclude drive paths and `+` formats from the pair shape, or
  verb-first flags (`ask`, `skip`, `with`, `generate`). Documented in built-in-tools.md and effect-journal.md §11.
  *(low · packages/core/src/tools/bounding.ts · round-1 F3, SEC-5)*
- [~] **Common credential spellings are outside the argv rules:** curl short-option clusters (`-su alice:pw`, `-sSu`,
  `-kualice:pw`), `-U`/`--proxy-user`, `--oauth2-bearer`, `--pass`, `--proxy-pass`, `--tlspassword`, openssl's
  `-passin pass:…` and keytool's `-storepass`/`-keypass`. None is a regression; documented as a limit in
  built-in-tools.md. *(low · packages/core/src/tools/bounding.ts · round-1 F6, SEC-4)*
- **DECLINED 2026-11-05 — moot: the `,`/`/` reading was removed (see the A4 entry above).** **A raw `?` or `#` after a URL password's `,` or `/` keeps the password public** (`https://user:pa,ss?1@host`);
  the LLM backstop masks the comma spelling. Admitting them needs a public-query test on the tail like
  `isPublicQueryContact`. Documented in built-in-tools.md. *(low · packages/core/src/tools/bounding.ts · round-1 F5,
  DOC-2)*
- **DECLINED 2026-11-05 — moot: the `,`/`/` reading was removed (see the A4 entry above).** **The `,`/`/` reading stops at the first `@`; the main userinfo path masks to the last.**
  `https://user:pa/ss@word9@host.example/x` keeps `word9` visible. Extend the mask to the last `@` before the next
  `/`, `?`, `#`, whitespace or quote. *(low · packages/core/src/tools/bounding.ts · round-1 SEC-6)*
- **DECLINED 2026-11-05 — moot: the `,`/`/` reading was removed (see the A4 entry above).** **The `,`/`/` tail scan runs once per scheme occurrence.** On dense `scheme://x:y,` input at the 1 MiB CLI
  output cap the projection costs about six times more than before (linear: each scan stops at 512 characters, so no
  ReDoS). Track the next `@` monotonically across matches and pin the cost with an admitted-size case. *(low ·
  packages/core/src/tools/bounding.ts · round-1 F7)*
- [~] **A binary buffer is counted at its `byteLength`, while its JSON form (`{"0":200,…}`) is about nine times
  larger.** The seam refuses the buffer in `tool_result.result`, so the model never receives it, but one under the
  ceiling is settled into the journal at the larger size, and an `ArrayBuffer` (JSON `{}`) is previewed needlessly.
  *(low · packages/core/src/tools/bounding.ts:114 · round-1 F4)*
- [~] **A dispatch result that holds inline media under the ceiling fails the next request:** the seam refuses raw
  media bytes in `tool_result.result` (ADR-0031), and only an over-ceiling result becomes a media-free preview.
  Pre-existing; builtins use the attachment rail. *(low · packages/core/src/tools/registry.ts · round-1 DOC-3)*
- [~] **The approval preview scrubs the joined command with the text rules only,** so an argv-rule credential masked
  in `toolInput` (`curl -u alice:pw`, `--password pw`) shows verbatim in `agent:approval_requested` and the prompt.
  Pre-existing for `--password`; the correction widened the gap to `-u` and the last-word flags. Build the process
  preview from the argv projection; an approval-path change, so it keeps that path's security sitting. *(low ·
  packages/core/src/tools/registry.ts:963 · round-1 SEC-3)*
- **DECLINED 2026-11-04 (maintainer) — enabling `enforce_admins` on `main`.** The branch protection does not bind
  administrators, and the sole maintainer is one; the maintainer keeps the green-CI rule by practice, as
  code-review.md and current.md state. *(low · repository settings · round-1 DOC-9)*

**D64 round 2 (2026-11-04, at `6155c6dd`).** A new cumulative round of the same shape confirmed one medium finding, a
boolean flag whose last word names a credential consuming the credential flag after it (`--pass-credentials --password
<pw>`), and it was fixed with the round's lows but these two recorded limits:

- **DECLINED 2026-11-05 — moot: the `,`/`/` reading was removed (see the A4 entry above).** **A URL password that begins with its `,` or `/` stays public** (`postgres://app:/Xk9@db`,
  `https://user:,pw@host`): the port test reads the empty text after the colon as a port. Treating only a non-empty
  digit run as a port needs the scheme check to cover the authority's trailing colon
  (`https://xhttps://user:pw@h.example/`). Documented in built-in-tools.md. *(low ·
  packages/core/src/tools/bounding.ts · round-2 RED-2)*
- **DECLINED 2026-11-05 — moot: the `,`/`/` reading was removed (see the A4 entry above).** **A non-numeric port with an `@` in its path reads as a password** (`http://localhost:$PORT/users/@me` →
  `http://[redacted]@me`), masking benign text and merging the journal identities of calls that differ there. Fix
  idea: leave a placeholder-shaped port (`$NAME`, `${…}`, `<…>`) after a host-shaped name public. Documented in
  built-in-tools.md. *(low · packages/core/src/tools/bounding.ts · round-2 RED-3)*

**D64 round 3 (2026-11-04, at `07f653e7`).** One medium finding (round 2's fix let a flag-shaped password show) and a
second claim downgraded to low were fixed by making both readings add masks only; the round's lows were fixed with
them but these:

- **DECLINED 2026-11-05 — moot: the `,`/`/` reading was removed (see the A4 entry above).** **A URL password with an `@` before its `,` or `/` keeps its tail after that `@`**
  (`https://user:p@ss/word@vault/x` → `https://[redacted]@ss/word@vault/x`): the authority scan finds the `@` first,
  so the `,`/`/` reading never runs. Pre-existing; documented in built-in-tools.md. Fix idea: when the userinfo before
  the first `@` holds a password and the next delimiter is `,` or `/`, read on through the next `@` with the port
  guard. *(low · packages/core/src/tools/bounding.ts · round-3 SEC-R3-3)*
- [~] **The hash-object answer check `names.length !== batch.paths.length` is equivalent to `<` within one batch:** an
  extra line is compared with the next batch's first file, so only a crafted answer across batches tells the two
  apart, and no test builds one. *(low · tools/cli-package/candidate.mjs:353 · round-3 RT3-1)*

**D64 round 4 (2026-11-05, at `7a12ee6f`).** One medium finding (the `,`/`/` reading skipped a nested URL) and a
downgraded claim (a masked `--flag=value` name shown) were fixed, with the round's lows; recorded with them:

- [~] **Eleven more test cleanups check a process with `alive()` and then kill it**, the race that failed
  `consumer-lifetime.test.mjs` once on the Linux CI (ESRCH when the process exits in between; fixed there in
  `93a8b033`): `tools/cli-bootstrap/witness.test.mjs:488,552`,
  `tools/cli-package/process.test.mjs:252,409,424,495,523,581`, `produce.test.mjs:593,806` and `check.test.mjs:218`.
  Replace each with a kill that ignores ESRCH only. *(low · the files named · round-4 CI-R4-1)*

**Resolution (maintainer, 2026-11-05).** No fifth round: one careful pass removed the `,`/`/` URL reading, which could
not be shown to only add masks under the repeated projection, and showed the argv rules to be a superset of the base
([D61 checkpoint](phases/phase-2.5.5-hardening-and-remediation.md#d61-checkpoint--pr-96-merged-2026-11-04)). The
entries about that reading above are closed as moot, and A4 is recorded under **Redaction**.

**The review's unverified first-pass lows, triaged at `f25fb83d` (2026-11-04).** Two agents checked all 86 against the
merged head: 81 still hold (78 entries below once duplicates merge), R1a-06 was fixed by `e8121aa4`, R1a-04 and R9a-05
are entries above, and R6-04 and R7-12 were refuted. Line numbers are at `f25fb83d`. The two roadmap lows the review
named without entries were R12b-03 (DONE entries whose bodies described the open state: four, and three more the D64 round 2 found) and R12b-04 (entries the
MVP pulled without an annotation); both were fixed on 2026-11-04.

*Release, custody and packaging tooling:*

- [~] `gnupg.mjs`'s header says no gpg call does key discovery. Only encryptArgs passes `--no-encrypt-to`,
  `--no-auto-key-locate` and `--no-auto-key-retrieve`. The version, `--show-keys` and recipient-listing calls use
  `isolated()` without those flags, and `gnupg.test.mjs` asserts the three flags for encryption only. *(low ·
  tools/cli-package/gnupg.mjs:67 · first-pass R1a-01)*
- [~] encryptOnce in `custody.mjs` publishes the bytes from its first read of `ciphertext.gpg`, but GnuPG lists the
  recipients of the file at that path, and the later byte-equality check cannot prove the listed file was those bytes:
  a same-user swap restored before the second read passes. Listing a private copy of the verified bytes, as the
  recipient path does, closes it. *(low · tools/cli-package/custody.mjs:384 · first-pass R1a-03)*
- [~] The end-to-end secret-key refusal in `custody.test.mjs` uses an armored secret export, which `custody.mjs`
  refuses by a byte check before any GnuPG call. The sec/ssb colon branch is tested only with synthetic records, and
  no test gives real GnuPG a standalone binary secret export. *(low · tools/cli-package/custody.test.mjs:380 ·
  first-pass R1a-05)*
- [~] The production recipient loader in `release-recipient.mjs` reads `recipient.asc` only for size and file kind and
  discards the bytes, so the loaded recipient is never checked against its pins. It also accepts a history entry whose
  primary equals its subkey, which encryptOnce refuses later as RECIPIENT_UNUSABLE. Comment the read as shape-only or
  check the pinned subkey against the key at load. *(low · tools/cli-package/release-recipient.mjs:169 · first-pass
  R1b-05)*
- [~] `release-scope.test.mjs`'s reach controls skip every file named `*.test.*`, `*-fixture.mjs` or under test/,
  tests/ or `__tests__/`, so a product or tooling file with such a name or location is invisible to them. The register
  records only the lint-fixtures case (PLAN-9B2-R4-2). *(low · tools/cli-package/release-scope.test.mjs:53 ·
  first-pass R1b-06)*
- [~] `release-recipient.mjs` requires the recipient directory to list exactly `pins.json` and `recipient.asc`. An
  extra entry such as a Finder .DS_Store refuses with PRODUCTION_RECIPIENT_INVALID, the same code as bad JSON or
  non-canonical bytes, and no runbook mentions it. Give unexpected entries their own fixed code. *(low ·
  tools/cli-package/release-recipient.mjs:163 · first-pass R1b-07)*
- [~] In `release-scope.test.mjs` only the `custody.mjs` control decodes escapes and ignores case. The release-module,
  fixture and loader-seam controls match case-sensitive regexes on raw text, so '`./Release-Custody.mjs`' or
  './release-custody%2Emjs' pass the release-module control. The scan also skips .jsx, .sh, .ps1 and non-package
  .json, which the test name and `packaging.md` do not say. *(low · tools/cli-package/release-scope.test.mjs:61 ·
  first-pass R2-03)*
- [~] verifyRetainedCandidate in `release-binding.mjs` lists the candidate directory without lstat-ing it, so a
  symlinked candidate directory is accepted; only its entries are lstat-ed. `packaging.md`'s Reuse paragraph names no
  linked-directory refusal, though the sealer refuses a linked destination. *(low ·
  tools/cli-package/release-binding.mjs:339 · first-pass R2-04)*
- [~] `release-binding.test.mjs` asserts verifyRetainedCandidate.length === 1 as proof the reuse API takes no GnuPG
  binary or run port, but function arity does not limit an options object's keys. The closure test in
  `release-scope.test.mjs` is the real control. Delete the assertion or replace it with a comment that points there.
  *(low · tools/cli-package/release-binding.test.mjs:955 · first-pass R2-05)*
- [~] The v1 release binding receipt carries toolchain, target and inputs, which are checked only for format and never
  bound, and mapCheck and origin, which are shape-only until Step 9d. These fields freeze when v1 is released.
  `packaging.md`'s sentence "Every field is a claim until Step 9d binds the last two" also conflicts with its table,
  which gives Step 9d trust to packageVersion and source as well. *(low · tools/cli-package/release-binding.mjs:4 ·
  first-pass R2-06)*
- [~] `production-failure.mjs`'s filter forwards any printable-ASCII line of up to 240 characters that starts with '✗
  CLI ' from captured child output. The header's "at most a repository-relative path" is therefore enforced by the
  producers, not the filter, and the PACKED_CLI_ code tail has no length bound. Reword the header or tighten the
  pattern. *(low · tools/cli-package/production-failure.mjs:9 · first-pass R2-07)*
- [~] `seal.mjs` writes `package-test-receipt.json` in place with the wx flag and no temporary file, fsync or rename.
  A hard kill mid-write leaves a truncated receipt that fails closed but blocks every re-seal with ALREADY_SEALED.
  Write a sibling, fsync it and link it to the final name. *(low · tools/cli-package/seal.mjs:187 · first-pass R3-01)*
- [~] `container.mjs` checks `finalized.json`'s outputs only by path and SHA-256 and its upstreamMaps only as an
  integer, so a recovered container can carry different outputs[].bytes or upstreamMaps and still pass. `packaging.md`
  already states that the metafile has no digest but does not mention these `finalized.json` fields. *(low ·
  tools/cli-package/container.mjs:104 · first-pass R3-02)*
- [~] buildPrivateContainer in `container.mjs` reads every staged record and map into memory, up to 16 MiB each for up
  to 256 maps, before it checks the 128 MiB total. `packaging.md` says the total is "refused before the archive is
  assembled", which is true for the archive but not for the reads. Sum the lstat sizes before reading. *(low ·
  tools/cli-package/container.mjs:189 · first-pass R3-03)*
- [~] Five negative cases in `seal.test.mjs` pass undefined as the expected refusal: the empty graph, a missing chunk,
  a missing hash record, a missing metafile and a missing public document. assert.throws then accepts any exception,
  including a TypeError from a broken fixture. Assert ENOENT at minimum, or give a missing expected file a fixed
  PACKED_CLI_ code. *(low · tools/cli-package/seal.test.mjs:127 · first-pass R3-04)*
- [~] No test pins finalizeCandidate's behavior on a re-run or after a crash. By reading it fails closed, because the
  first run unlinks `dist/metafile-esm.json` and a half-replaced dist is refused, but a reordering could let a re-run
  succeed on mixed state without a test failing. Add a second-finalize test and a half-replaced-candidate test. *(low
  · tools/cli-package/finalize.mjs:527 · first-pass R3-05)*
- [~] `seal.mjs`'s `finalizedPublicFiles` turns backslashes in metafile output keys into slashes, while `finalize.mjs`
  refuses any key that is not exactly `dist/<name>.js`. The two sides can therefore accept different keys. Drop the
  `replaceAll` and add a `dist\index.js` case to `seal.test.mjs`. *(low · tools/cli-package/seal.mjs:66 · first-pass
  R3-06)*
- [~] The same size and count bounds are written as separate literals in `finalize.mjs`, `seal.mjs`, `manifest.mjs`,
  `container.mjs` and `symbolicate.mjs`: 256 outputs, 8 MiB JS, 16 MiB map, 4 MiB metafile, 1 MiB `finalized.json` and
  128 KiB documents. A change to one copy does not reach the others. Export one frozen limits object and import it
  everywhere. *(low · tools/cli-package/seal.mjs:68 · first-pass R3-07)*
- [~] ustarEntry in `ustar.mjs` silently truncates a path longer than 100 bytes and would write a size of 8 GiB or
  more past its 12-byte field. The container's read-back catches the bad header only as CONTAINER_PATH or
  CONTAINER_UTF8. Refuse both cases in the writer and add negative writer tests. *(low ·
  tools/cli-package/ustar.mjs:37 · first-pass R4a-02)*
- [~] The USTAR reader is tested only against archives from the repository's own writer (`ustar.mjs`, also used by
  `ustar-fixture.mjs`). The one platform-tar test runs in the other direction: it extracts the writer's output with
  tar. A symmetric error in field offsets or the checksum would pass. Feed a platform `tar --format=ustar -c` archive
  through readUstar and inspectPackageArchive. *(low · tools/cli-package/ustar.test.mjs:65 · first-pass R4a-03)*
- [~] `archive.mjs`'s gzip check validates only ID1, ID2, CM and FLG, so MTIME, XFL and the OS byte vary by host and
  are bound into the receipt's sha256. The comment suggests a canonical header that the code does not enforce. Reword
  the comment, or pin MTIME and document the OS byte. *(low · tools/cli-package/archive.mjs:54 · first-pass R4a-04)*
- [~] The public package mode rule (`dist/index.js` 0755, every other file 0644) is written twice: once in
  `archive.mjs`'s inspector and once in `ustar-fixture.mjs`. The fixture claims to produce the exact shape the
  inspector accepts, so the two copies can drift without a test failing. Export one function and import it in the
  fixture. *(low · tools/cli-package/archive.mjs:199 · first-pass R4a-05)*
- [~] On failure or interrupt, `produce.mjs`'s emptyArtifact removes every entry in the caller's artifact directory,
  not only the ones the producer created, so a file another process writes there during the build is deleted. This is
  related to the recorded PLAT-9 entry "Two producers can share one artifact directory". Remove only what the producer
  created. *(low · tools/cli-package/produce.mjs:94 · first-pass R4a-06)*
- [~] When the local package check in `check.mjs` fails, the developer sees Node's uncaught-error dump of the whole
  runCommand result, including unbounded child stdout and stderr, not the fixed '✗ CLI' lines `production-failure.mjs`
  prints. `check.test.mjs` asserts only the exit code. Print only the fixed lines and rethrow a fixed code. *(low ·
  tools/cli-package/check.mjs:61 · first-pass R4b-03)*
- [~] `process.test.mjs`'s grace-validation test passes String(graceMs) as the second argument to assert.throws, which
  makes it the failure message, not a matcher. Any synchronous throw passes, including an unrelated TypeError. Match
  the AssertionError code instead. *(low · tools/cli-package/process.test.mjs:569 · first-pass R4b-04)*
- [~] The case-insensitive placement assertions in `paths.test.mjs` run only if an uppercased path happens to exist,
  so on case-sensitive Linux CI they are skipped silently and no skip is reported. Probe case sensitivity explicitly
  and call t.skip with a reason. *(low · tools/cli-package/paths.test.mjs:35 · first-pass R4b-05)*
- [~] resolvePnpm's comment in `process.mjs` says it resolves the action's standalone executable, but only Windows
  accepts a .exe. On POSIX, a non-JS pnpm binary is skipped and PINNED_PNPM_NOT_FOUND is thrown. The function also
  reads the whole target file only to check a 128-byte prefix. *(low · tools/cli-package/process.mjs:78 · first-pass
  R4b-06)*
- [~] In `check.mjs`'s finally block, rmSync runs before `interrupts.dispose()`. If the removal throws after an
  interrupt, dispose is skipped and the process exits 1 instead of 128 plus the signal number. Nest the removal in its
  own try/finally. *(low · tools/cli-package/check.mjs:64 · first-pass R4b-07)*
- [~] The consumer's cold-store `pnpm add` in `consume.mjs`, which builds better-sqlite3 and esbuild, depends on
  runCommand's implicit 300-second default timeout. The bound is not named, justified or tied to `check.mjs`'s
  deadline. Pass an explicit, named timeoutMs. *(low · tools/cli-package/consume.mjs:88 · first-pass R4b-08)*
- [~] publicPackage in `binding.mjs` admits any scripts object in the public manifest, including preinstall, install,
  postinstall and prepare, which npm runs on users' machines. The current apps/cli scripts are benign. Refuse the
  install-lifecycle keys. *(low · tools/cli-package/binding.mjs:201 · first-pass R4b-09)*
- [~] `prepack.test.mjs`'s 'tsup: false' case expects an exact MODULE_NOT_FOUND, but its fixture symlinks the real
  root node_modules, so the result depends on tsup not being hoisted there. If it ever were, the test would fail
  loudly rather than pass vacuously. Give the fixture an isolated empty node_modules. *(low ·
  tools/cli-package/prepack.test.mjs:181 · first-pass R4b-10)*
- [~] decodeMappings in `source-map.mjs` accepts non-canonical VLQ. 'B' (negative zero) and zero-padded continuation
  digits ('gA', up to seven digits) decode to the same value as 'A', so two byte strings for one map both pass, and
  `source-map.test.mjs` pins the padded form as accepted. Refuse them, or document that canonical form is not
  enforced. *(low · tools/cli-package/source-map.mjs:120 · first-pass R5b-02)*
- [~] decodeMappings in `source-map.mjs` bounds memory only by the 16 MiB input size, not by line, segment or field
  count. Every ';' allocates an array: a probe measured 87 MiB of retained heap for 2 MiB of ';', so roughly 700 MiB
  at the bound. A run of digits grows the field array until a separator. Refuse more than five fields inside the loop
  and cap lines at the generated line count. *(low · tools/cli-package/source-map.mjs:97 · first-pass R5b-03)*
- [~] mapsOf in `symbolicate.mjs` maps only SourceMapError and SyntaxError to MAP_DECODE. A staged map that lacks
  sources or names, or is null, throws a raw TypeError, which is printed as UNEXPECTED. mapsOf also never runs the
  generated or original range checks itself. Validate the map shape and run both range assertions inside the try.
  *(low · tools/cli-package/symbolicate.mjs:332 · first-pass R5b-04)*
- [~] `symbolicate.test.mjs` asserts that the host Node has module.registerHooks. The root `package.json` admits Node
  22.13, and `packaging.md` says the producer needs 22.15, so the file fails on 22.13 and 22.14 instead of skipping.
  CI uses Node 24 and is unaffected. Skip the capture cases without registerHooks, or state the 22.15 floor for the
  tools tests. *(low · tools/cli-package/symbolicate.test.mjs:991 · first-pass R5b-05)*
- [~] `source-map.test.mjs` and `symbolicate.test.mjs` run only in Ubuntu jobs. The now-required Windows job runs
  neither, so `symbolicate.mjs`'s realpath dirname containment is not exercised against file:///C:/ URLs or native
  path casing. A mismatch fails closed as a spurious refusal. Run both files on windows-latest, or unit-test the
  frame-to-dist mapping with win32 paths. *(low · tools/cli-package/symbolicate.mjs:348 · first-pass R5b-06)*
- [~] The symbolication frame record is produced inside the candidate's own process, and `frame-capture.mjs` calls the
  global Error.captureStackTrace, so code the candidate loads first could forge call sites. The anchors show that the
  runtime agrees with the maps, not that the runtime is honest. `packaging.md`'s Symbolication paragraph should say
  the record is self-reported. *(low · tools/cli-package/frame-capture.mjs:46 · first-pass R5b-07)*

*Engine and redaction:*

- [~] projectInput in `registry.ts` falls back to the unprojected arguments when the projection is not a plain record.
  On the journal path, that is the value the journal identity must never see. It is unreachable today because the walk
  preserves plain objects, but it fails open. Fail closed on the journal path. *(low ·
  packages/core/src/tools/registry.ts:1137 · first-pass R8-06)*
- [~] makeSummary in `bounding.ts` cuts the one-line summary at 500 UTF-16 code units, so it can leave a lone high
  surrogate in outputSummary. The byte preview is code-point safe and the summary is not. Cut on a code-point
  boundary. *(low · packages/core/src/tools/bounding.ts:1717 · first-pass R8-07)*
- [~] Review history is written into code and test names, for example 'PR95 review round N' describe titles,
  SECRETS_B7/B8 labels and 'a review caught…' or 'A PR #96 review found…' comments, in `bounding.ts`, its tests,
  `registry.test.ts` and `archive.mjs`. The PR #96 correction added more. Name tests by the property they assert and
  keep the history in the register; the labels are mutation-control ids, so rename them together with their controls.
  *(low · packages/core/src/tools/bounding.test.ts:1453 · first-pass R8-08)*
- [~] ToolResultLimits are never validated at the engine boundary. A NaN maxBytes makes every result count as
  truncated, while `bounding.ts`'s byte slicers never stop, so the preview is the whole text, head and tail both,
  bounded only by lines. Only the default limits are wired today. Validate the limits as finite non-negative integers
  at dispatch, or fall back to the default. *(low · packages/core/src/tools/bounding.ts:1818 · first-pass R8-09)*
- [~] The LLM diagnostic backstop in `scrub-secrets.ts` does not recognize JSON-escaped URL slashes
  (`https:\/\/user:pass@host`) or percent-encoded separators (`Bearer%20TOKEN`, `https%3A%2F%2F…`), so those
  credentials pass unmasked. The new `diagnostic-secret-backstop.md` Limits bullet does not list these forms. Accept
  `\/` as a separator or document the limit. *(low · packages/llm/src/scrub-secrets.ts:82 · first-pass R9a-03)*
- [~] The Bearer/Basic label fragment with its LF/TAB tolerance and the label-repeat groups are hand-copied into three
  regexes in `scrub-secrets.ts`: the header, standalone-label and label-run rules. A policy change must be repeated in
  each copy, and the comments do not name the others. Compose the fragments from named strings, as `terminal-safe.ts`
  does, and move the secrets mutation anchors along with them. *(low · packages/llm/src/scrub-secrets.ts:140 ·
  first-pass R9a-06)*

*Test and control harnesses:*

- [~] `tools/causal-controls/provenance.mjs`'s `exactReplacement` applies a control's `after` text with a string
  replacement, so a future `after` containing a `$` replacement pattern (`$&`, `$$`, `$n`, or a dollar sign followed
  by a backtick or quote) would be written as different bytes than declared. No anchor uses those sequences today; the
  fix is a replacer function (`text.replace(control.before, () => control.after)`) plus a `run.test.mjs` case. R7-10
  reports the same defect. *(low · tools/causal-controls/provenance.mjs:195 · first-pass R6-02)*
- [~] `tools/fs-policy-controls/mutations.mjs` sets each control's expectedTests from a file-keyed nested ternary
  whose final default is 19, so a new control on an unlisted file silently receives 19. A wrong guess still fails
  loudly as declared-workload drift. Make `control()` require expectedTests, as mediaControl already does, and drop
  the table. *(low · tools/fs-policy-controls/mutations.mjs:248 · first-pass R6-03)*
- [~] The `tools/overflow-capture/check.mjs` header claims the real stdin/file/signal boundary, but caller-abort emits
  a synthetic SIGTERM. Only the POSIX 'hang' mode sends a real signal, and cleanup-race cannot reach its race branch
  today, so it passes either way. State in the header that cleanup-race is a future-regression guard, or drive
  caller-abort with a real child.kill('SIGTERM'). *(low · tools/overflow-capture/check.mjs:1 · first-pass R6-05)*
- [~] `tools/fs-policy-controls/README.md:144` says 'The complete 19-case temporary regression' in the present tense.
  That control (MEDIA_TEMP_NATIVE_IDENTITY_PRECISION) now declares 23 cases, and line 5 says the temporary suite grew
  to 23. Change it to 23-case, or mark the paragraph as history. *(low · tools/fs-policy-controls/README.md:144 ·
  first-pass R6-06)*
- [~] `tools/secrets-controls/mutations.mjs` pins whole-file case counts by hand (CORE_PROJECTION_CASES,
  REGISTRY_CASES, LLM_SCRUB_CASES), so any new test in `bounding.test.ts` breaks every coreProjectionControl phase
  until someone edits the number. Add a helper that prints the current per-file counts from the harness's own
  collection, and document a refresh step in the README. *(low · tools/secrets-controls/mutations.mjs:339 · first-pass
  R6-07)*
- [~] `tools/secrets-controls/README.md` (581 lines, one heading) is a per-round changelog that names retired control
  IDs inline, so finding the current inventory means reading the whole file. Keep one current table (id, path,
  workload, witness count), move round history to a dated section, and list retired IDs once. *(low ·
  tools/secrets-controls/README.md:327 · first-pass R6-08)*
- [~] The `tools/secrets-controls/mutations.mjs` header still says 'Steps 3–5 and 7', although the file also declares
  the PR95 and Wave 2 controls. `README.md:556` names `deferred-tasks.md` as plain text, not as a relative link.
  Update the header and link `../../docs/roadmap/deferred-tasks.md`. *(low · tools/secrets-controls/mutations.mjs:1 ·
  first-pass R6-09)*
- [~] Two negative-control loops accept any refusal: `tools/bundle-closure/closure.test.mjs`'s escaping-specifier loop
  accepts any BundleClosureError, and `tools/cli-package/smoke/native-process.test.mjs`'s observed-group loop accepts
  any thrown error. A mutation can therefore pass for the wrong reason. Use the existing refuses(value, code) helper,
  and assert AssertionError or a message for the native vectors. *(low · tools/bundle-closure/closure.test.mjs:230 ·
  first-pass R7-04)*
- [~] The test 'output cap counts UTF-8 bytes' in `tools/cli-bootstrap/witness.test.mjs` cannot tell bytes from UTF-16
  units, because its emoji payload exceeds the 4,096 cap either way. A probe showed that a units-counting mutant of
  `process.mjs:65` still passes, and that 'é'.repeat(3000) separates the two. Switch to that payload. *(low ·
  tools/cli-bootstrap/witness.test.mjs:407 · first-pass R7-05)*
- [~] `tools/bundle-closure/closure.mjs` refuses loader and code-generation capabilities only by identifier name or
  string-literal element access. Computed forms such as globalThis['req'+'uire'], a template-literal key, or
  ({}).constructor.constructor pass, although the comment claims it refuses 'acquisition/aliasing'. Document the guard
  as best-effort drift detection, or refuse computed access on globals and .constructor chains. *(low ·
  tools/bundle-closure/closure.mjs:202 · first-pass R7-06)*
- [~] `tools/bundle-closure/check.mjs` reports every non-BundleClosureError failure, including a TypeError or EACCES,
  as 'cannot read valid build inventory — build the CLI first', with no message, which hides the real cause. Print
  error.code or error.message for non-closure errors, and keep the build hint for ENOENT. `prepack.test.mjs:164`
  matches the prefix. *(low · tools/bundle-closure/check.mjs:30 · first-pass R7-07)*
- [~] `tools/budget-replay-compat/system-tools.mjs` hard-codes C:`/Windows/System32/tar.exe` and C:/Program Files/Git
  for Windows, while `tools/cli-package/process.mjs` derives taskkill from SystemRoot. A Windows install on another
  drive fails with a generic assertion. Derive the paths from SystemRoot and ProgramFiles, and name the variable in
  the error. *(low · tools/budget-replay-compat/system-tools.mjs:9 · first-pass R7-08)*
- [~] On Windows, the timeout kill in `tools/causal-controls/process.mjs` and `tools/cli-bootstrap/process.mjs`
  reaches only the direct child, and both resolve only on 'close'. A grandchild holding the pipe can therefore leave
  the join unsettled after the timeout. Use taskkill /T on win32, or resolve on 'exit' after a bounded drain. CI runs
  these families on Ubuntu only, and the README admits descendant ownership is not asserted. *(low ·
  tools/causal-controls/process.mjs:20 · first-pass R7-09)*
- [~] `tools/causal-controls/provenance.mjs` gives filesystem phases the operator's whole environment, with the real
  HOME and TMPDIR. Secrets phases keep TMPDIR and redirect only HOME, and the bootstrap harness redirects TMP, TEMP
  and TMPDIR. The README says only that the filesystem environment is 'byte-for-byte equivalent to its predecessor'.
  Either redirect `TMP*` (and HOME for filesystem), or state the isolation choice per family in the causal README.
  *(low · tools/causal-controls/provenance.mjs:174 · first-pass R7-11)*
- [~] `tools/cli-package/smoke/README.md:101` says 'Step 8d adds an eighth required case', but 4b1f6f6b later inserted
  two cases before it, and REQUIRED_SMOKE_CASES now lists actual-native-bootstrap-lifecycle as the tenth. Name the
  case IDs instead of ordinals. *(low · tools/cli-package/smoke/README.md:101 · first-pass R7-13)*
- [~] The `provenance.test.mjs` test titled 'owned helpers and redirected root directories cannot be symlinked'
  symlinks only a helper file, so root-directory refusal in captureOwnedTools is untested. In
  `native-process.test.mjs` the sentinel loop's `mode` variable is unused. Add a root-directory symlink case and drop
  or use `mode`. *(low · tools/causal-controls/provenance.test.mjs:67 · first-pass R7-14)*
- [~] `tools/fs-policy-controls/outcome.test.mjs` and `process.test.mjs` are dead re-export shims that no script runs.
  The `require-packed-cli.test.mjs` listing guard covers only five tools directories, so a new unlisted test elsewhere
  would never run. Delete the shims and extend the guard to every `tools/*` directory with `*.test.mjs`, exempting
  db-sync. This consolidates R6-10 and R7-01. Nits: `ci.yml:250-251` repeats the same job heading twice. (Consolidates
  R6-10 and R7-01.) *(low · tools/ci/require-packed-cli.test.mjs:606 · first-pass R13-08)*

*Documentation and roadmap (trigger: Gate 0's stale-entry sweep, or the next change to the file):*
*[2026-11-18: the stale-entry sweep ran for this register only, not for the phase 2.6 bullets or the other documents named below, so these entries stay parked.]*

- [~] The rule that refuses an unsettled or member-collapsing journal projection is still stated in three reference
  docs: `built-in-tools.md:212-218`, `tool-registry.md:258-264` and `effect-journal.md:409-418`. Commit 0826f30a had
  to add the member-name clause to all three. Make `tool-registry.md` the one home and have the other two link to it.
  The `error-handling.md` half of the finding was fixed by 964994c7, which moved the backstop's shape list to
  `diagnostic-secret-backstop.md`. *(low · docs/reference/shared-core/effect-journal.md:409 · first-pass R10-03)*
- [~] `docs/reference/cli/packaging.md` keeps a 905-character status line and per-step 'implementation boundary — Step
  7a…9b.2' sections. `effect-journal.md:389` ('PR95 increment tightened') and `built-in-tools.md:257` ('a documented
  relaxation') also carry history in contract text. Keep one status line per reference doc, write the contract in the
  present tense, and move step history to the phase register. *(low · docs/reference/cli/packaging.md:3 · first-pass
  R10-06)*
- [~] Commit 964994c7 put only the 2026-10-25 corrections of ADR-0105 and ADR-0106 into the dated '> Amended' form,
  and those still sit under their old ### headings. ADR-0106 keeps 21 other dated ### correction sections and ADR-0105
  keeps 14, none in the blockquote form that `documentation-style.md` requires. ADR-0106's Decision also repeats 256
  KiB, 25 MiB and the 24-hour age that it says have canonical homes elsewhere. Convert them or document the
  correction-section convention. The D64 round 1 on the correction (DOC-10) found the same: either convert the
  sections or accept a dated `### <title> — YYYY-MM-DD` correction section in documentation-style.md §7. *(low ·
  docs/decisions/0106-media-publication-requires-bounded-verified-bytes.md:220 · first-pass R10-07)*
- [~] The Step 9b preflight ruling in `phase-2.5.5-hardening-and-remediation.md:10105` still says 'Windows has no
  GnuPG on its image'. Lines 10179-10181 and 10346-10347 record that the image ships Git for Windows' MSYS2 gpg. Add a
  dated note to the ruling pointing to the correction. *(low ·
  docs/roadmap/phases/phase-2.5.5-hardening-and-remediation.md:10105 · first-pass R12a-02)*
- [~] The NI row of the phase 2.5.5 increment table (line 3707) still says its Windows clause 'closes after three
  green advisory Windows runs', although the clause closed on 2026-10-26 (run 3 of 3 at line 10068, restated at
  10696). Add the closure to the row. *(low · docs/roadmap/phases/phase-2.5.5-hardening-and-remediation.md:3707 ·
  first-pass R12a-03)*
- [~] `phase-2.5.5-hardening-and-remediation.md:9274` says the merged PR95 head moved the scrub-secrets pin 89→103,
  and :9374 says the follow-up moved it 89→111. Git history settles it: a3e164b5 set the pin to 103 but left the
  README at 89, and c64f3c39 moved the pin 103→111 and the README 89→111. Line 9374 should say 'pin 103→111, README
  89→111'. *(low · docs/roadmap/phases/phase-2.5.5-hardening-and-remediation.md:9374 · first-pass R12a-04)*
- [~] `phase-2.5.5-hardening-and-remediation.md:9435` labels correction commits '(round N)', meaning the correction
  made after round N, while the round table at :9454 lists the same commit as round N+1's reviewed head. Add '(the
  correction after round N)' so readers do not match the label to the wrong round. *(low ·
  docs/roadmap/phases/phase-2.5.5-hardening-and-remediation.md:9435 · first-pass R12a-05)*
- [~] The entries in `docs/roadmap/deferred-tasks.md` carry only round-review tags (R10-SCRUB-1, TCA-9A1-R13-1,
  SEC-9B1-PS-2, COR-R4-2), and the detailed reports they come from are Git-ignored, so the tags cannot be resolved
  from the repository. Give entries a stable register ID and keep the round tag as provenance. *(low ·
  docs/roadmap/deferred-tasks.md:521 · first-pass R12b-07)*
- [x] **DONE 2026-11-18 (stale-entry sweep) —** `docs/roadmap/deferred-tasks.md:374` says the PR95 independent review's medium and 'three of its four' lows were
  corrected in a3e164b5. LOW-2's change was reverted in ebbec1c0, and the same paragraph lists LOW-1 and LOW-2 as
  approved deferrals, so the net is two of four (LOW-3, LOW-4). Reword it. *(low · docs/roadmap/deferred-tasks.md:374
  · first-pass R12b-08)*
- [~] In `docs/roadmap/deferred-tasks.md`, the CR-70 entry is 'Scheduled (D67): v0.2.1' with 'the trigger above is
  unchanged', but the trigger needs ADR-0096's recovery observed in a release that is not yet published. State the
  observation the schedule waits for. `phase-2.6-conversational-authoring.md:353` still says 'three already-live bugs
  gate it', which is stale since W7/CR-98, and links `deferred-tasks.md` without an anchor; point it at the CR-70
  entry. *(low · docs/roadmap/deferred-tasks.md:1143 · first-pass R12b-09)*
  **Half done 2026-11-18 (stale-entry sweep):** the CR-70 entry now states the observation its schedule waits for (no published release
  carries ADR-0096's recovery; `v0.1.1` predates it). The `phase-2.6-conversational-authoring.md:353` half is still open.
- [~] `phase-2.6-conversational-authoring.md:8` says 'The phase scope, exit criteria and milestones are unchanged'
  right after introducing the CLI MVP additions table, which adds MVP-A items. The M2.6-1 row and Required-ADR rows 9
  and 11 were also edited. Reword to 'the scope lines and exit criteria are unchanged; the CLI MVP additions table
  adds items'. *(low · docs/roadmap/phases/phase-2.6-conversational-authoring.md:8 · first-pass R12b-10)*
- [~] `phase-2.6-conversational-authoring.md:357` still lists 'The CLI e2e suite migrates the developer's real
  ~/.relavium/history.db' as an open obligation tracked in `deferred-tasks.md`, but `deferred-tasks.md:2572` marks it
  DONE 2026-07-13 (PR #76 review fold). Mark it closed in the phase record. *(low ·
  docs/roadmap/phases/phase-2.6-conversational-authoring.md:357 · first-pass R12b-11)*
- [x] **DONE 2026-11-18 (stale-entry sweep) —** The 'CLI render-layer (ink component) test harness' entry in `docs/roadmap/deferred-tasks.md` is still '[ ]
  Scheduled → 2.6.F', although 2.6.F is done and apps/cli now uses ink-testing-library; close it or re-point it. The
  '[ ]' tooling-nits entry at :437 records its accepted tooling half inline but stays open for 19b's headings; split
  it into a closed and an open half. *(low · docs/roadmap/deferred-tasks.md:2552 · first-pass R12b-12)*
- [~] `docs/roadmap/current.md:34` dates Phase 1's M2 to 2026-06-21, but `phase-1-engine-and-llm.md:795` records M2 as
  reached on 2026-06-16 (PR #27). 2026-06-21 is the last workstream merge. Write 'Complete (M2 2026-06-16; last
  workstream 2026-06-21)'. *(low · docs/roadmap/current.md:34 · first-pass R11-03)*
- [~] `docs/roadmap/current.md:69-74` states D64's security-tier bar without 'and no regression', which the register's
  D64 amendment includes. `current.md:365` lists D65 as six splits plus #61 and omits G30's rows 13a–13c, although
  `current.md:207-209` and the register's split table include them. The register's own summary at :10660 repeats 'six
  recorded splits plus #61'. Copy the register's D64 wording and count seven splits. *(low ·
  docs/roadmap/current.md:69 · first-pass R11-04)*
- [~] `docs/roadmap/current.md` still carries history that D66 says belongs to the registers: the D8 row's 'Recorded
  here because the shipped state contradicted this table for four days', the D3 row's execution detail, the Wave 2
  merged block with commit SHA, and the Departures section's 'Discharged 2026-07-26; kept here because…'. Keep one
  status line per closed decision with a register link. *(low · docs/roadmap/current.md:338 · first-pass R11-05)*
- **DONE 2026-11-04 (D64 round 3 follow-up).** Four in-page links in the record 964994c7 moved into the phase 2.5.5
  register pointed at `current.md`'s live sections instead of their moved copies: 'Execution order — Phase 2.5.5 +
  Phase 2.6 … below', two 'Active now' links and the 'Wave 3 queue' link. They now point in-page
  (`#execution-order--phase-255--phase-26-temporary`, `#what-is-active-now`, `#wave-3--clear-the-ground`). *(low ·
  docs/roadmap/phases/phase-2.5.5-hardening-and-remediation.md · first-pass R11-06, round-3 DOC-R3-4)*
- [~] The repository has no mechanical check behind its 'moved verbatim' claims, such as the one in
  `phase-2.5.5-hardening-and-remediation.md`'s 'Moved by the PR #96 review correction' note. The earlier D66 move
  silently dropped 983 lines. Add a small tools/ script that normalizes link text and whitespace and requires every
  moved line to appear in the destination. *(low · docs/roadmap/phases/phase-2.5.5-hardening-and-remediation.md:11125
  · first-pass R11-07)*

## MVP-1 1b — recorded low findings (2026-11-05)

D64 rounds 1 (at `5f2a0eb8`), 2 (at `60bc9727`), 3 (at `224b8f69`) and 4 (at `b70f9def`) of MVP-1's security
increment found nine, two, two and one medium findings, all fixed before the next round, and the lows below that
were not fixed with them. Round 5 (at `df685a52`) found no blocker, high or medium finding; its nine lows are the
next group below, and the separate security sitting's two lows (at `ab5e46e1`) are the last.
**Trigger for every entry:** the next change to the file it names.

- [~] **On the checkpoint path the engine checks a gate decision's fit only after passive admission.** *Low.*
  *(round 1, gate-2)* A direct engine caller (the coming desktop and VS Code `resume_run`, or any embedder of
  `@relavium/core`) that sends `input_provided` to an approval gate while a `context:` source is briefly missing, or
  an unresolved effect row blocks the resume, gets the run written `run:failed` instead of `invalid_decision` with
  the run left parked. The CLI refuses a misfit before any engine work, so it is not affected. **Re-check:** do the
  fit check in `#prepareCheckpointGate` right after the pending gate is found, before `prepareResumeAdmission`, and
  add a core test with a failing context. *(low · packages/core/src/engine/engine.ts)*
- [~] **A long output value row soft-wraps to column 0.** *Low.* *(round 1, outputs-5)* Hard line breaks in an
  output value are indented under its key, but a single row wider than the terminal wraps to column 0 of the next
  visual row, where padded text can look like a summary row. The comment now says so. **Re-check:** wrap value rows
  at the terminal width with the continuation indented (the TUI path knows the column count), or bound a row's
  width. *(low · apps/cli/src/render/run-outputs.ts)*
- [~] **One damaged row in any non-terminal run stops every reconcile and outbox drain.** *Low.* *(round 1,
  liveness-2)* `listInterruptedRuns` throws `CorruptRunEventError` for the whole listing, so `reconcile()` rejects,
  and the CLI's best-effort catch hides it: a crashed run stays `running` on every Home open and `run`/`gate` start,
  and a held terminal is never drained. `status` already isolates per run (`readPerRunOrDegrade`). The dependency
  predates 1b; 1b's liveness now relies on it. **Re-check:** isolate failures per run in the interruption listing
  and name an unreadable run once. *(low · packages/db/src/run-history-store.ts)*
- [~] **The compiled-CLI MCP orphan probe reads the developer's real keychain.** *Low; test-side.* *(round 1,
  keys-6)* Since the key pre-flight, `agent run` in `tools/cli-smoke/check.mjs` asks the keychain before the env
  var, so a stored Relavium Anthropic key shadows the synthetic one, and on macOS a keychain prompt could hold the
  probe until its step timeout. Nothing is sent: consent refuses the first call and the server never answers the
  second. **Re-check:** run the probe's bundle under the keyring-denied module guard the package smoke uses, so the
  synthetic env key is the only one resolved. *(low · tools/cli-smoke/check.mjs)*
- [~] **Under the home directory, `/export` with no project writes into the global `~/.relavium/workflows/`.**
  *Low.* *(round 1, export-6)* Project discovery walks up to the first `.relavium/`, and under `$HOME` that is the
  global data directory, so the scaffold and its transcript land there and appear as a project workflow from every
  other non-project directory under home. The reference now states this. **Re-check:** exclude the global
  configuration directory from project discovery for `/export` (writing `<cwd>/.relavium/workflows/` instead), or
  ask before writing there. *(low · apps/cli/src/chat/export.ts, apps/cli/src/config/paths.ts)*

- [~] **A `/clear` after a `/models` rescue rebuilds on the agent the session left.** *Low.* *(round 2, keys-1)* A
  `chat-resume` deferred for a missing key, rescued with `/models`, then `/clear`ed, rebuilds on the resumed
  snapshot's agent: the `/clear` rebuild closure captures `built.agent` once, and a reseat does not update it. The new
  pre-flight then ends the REPL with a refusal naming the abandoned provider. Nothing is lost; the printed
  `chat-resume` reopens on the rescued provider. The root cause predates 1b: ADR-0059's ADR-0112 amendment rules that
  an explicit model choice survives a rebuild, and that is not implemented yet. **Re-check:** with ADR-0112's rebuild
  rule, have the `/clear` rebuild take the agent of the session being cleared. *(low · apps/cli/src/commands/chat.ts)*
- [~] **A direct engine caller can send a payload with `approved` or `rejected`.** *Low.* *(round 2, gate-1)* The fit
  check reads the decision kind only, and the gate's output is `decision.payload ?? { decision }`, so an embedder that
  approves an approval gate with `payload: { decision: 'rejected' }` routes downstream on the payload. The CLI cannot
  send one (only `--input` carries a payload), and the spec now says the check reads the kind only. **Re-check:**
  refuse a payload on an `approved`/`rejected` human-gate decision in `#assertDecisionFitsGate`, as budget gates
  already do. *(low · packages/core/src/engine/engine.ts)*
- [~] **Run outputs no longer join a query name split by whitespace.** *Low.* *(round 2, outputs-3)* Dropping the CLI's
  diagnostics-only residual (round 1, outputs-2) also dropped its split-query-name probe, so an output holding
  `?access_ token=<value>` (a hard-wrapped URL, say) prints the value; round 1's head masked it. The shared scrubber
  does not join query names by design, and its query rule is private, so a per-leaf probe would be a second copy of a
  security rule. commands.md states the limit. **Re-check:** export a query-only probe from the shared scrubber and
  apply it per leaf. *(low · apps/cli/src/render/run-outputs.ts, packages/llm/src/scrub-secrets.ts)*
- [x] **On a resumed run the outputs note names `<runId>`.** *Low; cosmetic.* *(round 2, outputs-5)* **Fixed
  2026-11-06** (the MVP-1 1a milestone review, runid-2): the run view takes the run id from a resumed stream's first
  event, so the footer, the summary's id line and this note all name it. The original entry follows. The TUI final
  summary passes `state.runId`, which only `run:started` sets, so after `relavium gate` or `budget resume` a shortened
  or masked block says `relavium logs <runId> --json`; the plain renderer names the id. **Re-check:** fold the
  terminal's `runId` into the view state (or carry it on the summary) and pass that. *(low ·
  apps/cli/src/render/tui/final-summary.ts, apps/cli/src/render/tui/run-view-model.ts)*

- [~] **A held terminal the log has already moved past is never written, and its run is never settled.** *Low.*
  *(round 3, liveness-1)* The drain retries an outbox entry whose sequence number is at or below the run's durable
  last one, the store's append guard refuses it every time, and the run counts as held, so the repair skips it on
  every start. It takes three rare events in a row: a held terminal from a gate deadline, a drain that cannot land
  it during the next `relavium gate`, and that resume then dying after writing past it. The run stays `running`, and
  `status` keeps calling it held. **Re-check:** in `#drainTerminalOutbox`, drop an entry whose sequence number is at
  or below the log's last one (it can never land) instead of holding its run, and add a CLI reconcile test. *(low ·
  packages/core/src/engine/engine.ts)*
- [~] **Only `relavium status` says the terminal outbox cannot be read.** *Low.* *(round 3, liveness-2)* An outbox
  that exists but cannot be read (root-owned after a `sudo` run, a directory at its path) holds every run, so no
  start or Home open settles anything until it can be read. Holding is the safe choice, and the reference now says
  so, but `run`, `gate`, `budget resume` and the Home swallow the reconcile result and print nothing. **Re-check:**
  have `reconcile()` report an unreadable outbox, and print one fixed line on stderr and in the Home naming the
  file. *(low · packages/core/src/engine/engine.ts, apps/cli/src/history/reconcile.ts)*
- [~] **An export larger than the parser accepts is never recognized as the session's own.** *Low.* *(round 3,
  export-2)* Past the parser's 2,097,152-character bound, a later `/export` of the same session writes another
  file (`<slug>-2`, …) rather than rewriting the first, and the run hint it prints names a file `relavium run`
  refuses. It needs a session whose attachments or shell output reach that size. **Re-check:** refuse to write a
  scaffold over the bound, pointing at `relavium chat-export <sessionId> --out <path>`. *(low ·
  apps/cli/src/chat/export.ts)*
- [~] **An `/export` before the first completed exchange is not found by a later one.** *Low.* *(round 3,
  export-4)* With no title yet, the export's id is `exported-session-<sessionId>`; once a title exists, a later
  `/export` searches only the title's slug, so it writes a second file and the empty first one stays in the catalog.
  **Re-check:** also search the fallback id for the session's own export (renaming it on rewrite), or refuse
  `/export` while there is nothing to export. *(low · apps/cli/src/chat/export.ts)*

- [ ] **A 0.1.x run still executing when a newer start reconciles is settled as crashed.** *Low.* *(round 4,
  liveness-1)* `relavium@0.1.1` takes no run lease, so a run it is still executing has no lease row, and the first
  `run`, `gate`, `budget resume` or Home open of a version with 2.6.G reconcile claims it at once and writes
  `run:failed{internal}`. The 0.1.1 process then hits the sequence it expected, aborts, and its own `run:failed`
  lands behind the first, because 0.1.1's store has no terminal refusal. It needs an older executable still
  running on the upgraded `~/.relavium`, which [database-schema.md](../reference/shared-core/database-schema.md)
  calls unsupported ("active downgrade execution"). **Narrowed 2026-11-06 (maintainer ruling, PR #97 review):**
  reconcile now leaves a run younger than one lease TTL alone (ADR-0079 §3's 2026-11-06 note), so a 0.1.x run is
  safe for its first minute; one still executing after that is settled as before. **Re-check before the v0.2.0
  release:** the release notes tell users to finish or cancel 0.1.x runs before upgrading. *(low ·
  packages/core/src/engine/engine.ts)*
- [~] **A project config key with a line break can fake a line under an `/export` refusal.** *Low.* *(round 4,
  export-1)* A config error names the keys it refused, and a REPL command's output keeps its line breaks (only
  terminal controls are stripped), so a quoted `project.toml` key holding a newline and a made-up `exported session
  to …` line prints that line under `export failed:`. It needs a hostile config swapped in after the chat started.
  `doctor` and the top-level error renderer already print such a message on one line. **Re-check:** print the
  refusal through `sanitizeInline`, or name a config error by its code only, and check the other REPL commands
  that show config text. *(low · apps/cli/src/commands/chat.ts)*
- [~] **Two kinds of output name the name probe does not read as an API-key header.** *Low.* *(round 4,
  outputs-2)* The probe reads a name as serialized JSON, where a tab or line break inside the key becomes `\t` or
  `\n`: the escape's letter hides the header name's boundary, so an opaque value under `"\nx-api-key"` or
  `"x-api-key\t"` is shown (it was before round 4 too). And a name the scrubber masks up to its end is not a label
  by design, so an opaque value under `Bearer x-api-key` is shown, as it was before the member view. Both need a
  key no real header block produces cleanly. **Re-check:** turn control characters in the key into spaces before
  the probe, and pin both escapes. *(low · apps/cli/src/render/run-outputs.ts)*
- [~] **The VS Code gate event cannot tell an input gate from an approval gate.** *Low; reference only.* *(round 4,
  gate-1)* `relavium.onHumanGatePending` carries `{ runId, nodeId, promptText, timeoutMs }`: no `gateType` to
  choose between Approve and an input field, and no `gateId` to resume a run with more than one gate pending.
  Nothing implements it yet. **Re-check:** add both when the VS Code surface is built. *(low ·
  docs/reference/vscode/extension-api.md)*

- [~] **The exit-code table says every exit 5 is retried, but the next start drops a raced one.** *Low; reference
  only.* *(round 5, liveness-1)* The table row and the note on what 5 and 6 mean say a held terminal is retried on
  the next start. When a concurrent reconcile has already written the run's terminal, the next start's drain finds
  the run closed and drops the entry instead. The exit-5 note in the same section states this, and the remedy the
  two lines give (re-check after the next invocation) still gives the right answer. **Re-check:** qualify both
  lines ("…or drops it when the log already ends in a terminal"). *(low · docs/reference/cli/commands.md)*
- [~] **The `reconcile()` docstring leaves out two kinds of run it does not settle.** *Low; comment only.* *(round
  5, liveness-2)* A run whose repair write throws is skipped and retried on the next reconcile, and a run parked on
  a media job is resumable and left alone like one parked at a gate. The docstring names neither; nothing it states
  is false. **Re-check:** add "a run whose repair write failed" to the runs left for a later reconcile, and say
  "parked at a gate or on a media job". *(low · packages/core/src/engine/engine.ts)*
- [~] **Before a `/models` rescue, `/clear` in a resumed session without a key ends the REPL.** *Low.* *(round 5,
  keys-1)* A message and `/compact` consult the send guard and are refused with a pointer to `/models`; `/clear`
  does not, so it rebuilds on the resumed session's keyless agent, the key pre-flight refuses that, and the REPL
  ends with a remedy naming only the missing key and the same `chat-resume`. Nothing is sent or lost, and
  chat-session.md says a `/clear` whose build fails ends the REPL. Round 2's keys-1 is the same `/clear` after the
  rescue. **Re-check:** in `clearSession`, check the send guard first, as `compactHistory` does. *(low ·
  apps/cli/src/commands/chat.ts)*
- [~] **The desktop gate overlay reference gives an input gate no Reject.** *Low; reference only.* *(round 5,
  gate-1)* routes-and-screens.md gives an `input` gate an input field only, while the engine accepts `rejected` there
  and the VS Code reference and `relavium gate --reject` offer it. `apps/desktop` holds only a README. **Re-check:**
  with round 4's gate-1, when the desktop surface is built: "an input field and Reject for an `input` gate". *(low ·
  docs/reference/desktop/routes-and-screens.md)*
- [~] **An output name that is a secret shape still masks its value when a delimiter or control character follows
  the shape.** *Low; fails closed.* *(round 5, outputs-1)* Round 4's check keeps the value only when the name's own
  scrub ends in `[REDACTED]`. The scrubber's Basic/Bearer token cannot end on `,` `;` `}` `"` `'` or `\`, and a
  trailing tab or line break is written as `\t` or `\n` in the serialized view, so a value under `Basic plan,`,
  `"Basic auth"` or `Basic plan\r` (the last header of a naively split CRLF file) is masked whole, with the masked
  note. **Re-check:** strip trailing delimiters and control characters from the name's own scrub before the end
  check, rerun the round-4 oracle with these names, and pin `Basic plan,` and `Basic plan\n`. *(low ·
  apps/cli/src/render/run-outputs.ts)*
- [~] **An output name that already ends in `[REDACTED]` masks its value, through an unpinned clause.** *Low; fails
  closed.* *(round 5, outputs-2)* The `own !== key` clause in `namesCredential` makes `Bearer [REDACTED]` or
  `…?token=[REDACTED]` (an already-redacted log line used as a key) a label, while `Bearer token` keeps its value.
  Dropping the clause passes every test. **Re-check:** decide what the clause is for, and pin the choice with a
  `{ v: { 'Bearer [REDACTED]': 'x' } }` case. *(low · apps/cli/src/render/run-outputs.ts)*
- [~] **Two output names that mask to the same text show only the later value.** *Low.* *(round 5, docs-1; extends
  round 2's key collision)* Since round 4 a name that is a secret shape keeps its value, so `Basic plan` and `Basic
  support` in one object both become `Basic [REDACTED]` and only `Basic support`'s value is shown, in the first
  member's position; commands.md says such a name's value is kept. The masked note points at the full record.
  **Re-check:** suffix a colliding name (`Basic [REDACTED] (2)`, as core's bounding walk reports collisions) or mask
  every colliding value, and pin a `Basic plan` + `Basic support` case. *(low · apps/cli/src/render/run-outputs.ts,
  docs/reference/cli/commands.md)*
- [x] **`relavium list` prints a workflow's name without stripping terminal controls, and `/export` now feeds it
  session titles.** *Low for 1b.* *(round 5, export-1)* **Fixed 2026-11-06** (maintainer: fix it before the
  MVP-1 milestone review): `list` passes every catalog field it prints (slug, name, tag; the parse reason already
  did) through `sanitizeUntrustedInline`, pinned by a test whose name, tag, file-name slug and agent name carry
  `ESC ] … BEL`, `ESC [2J` and U+202E. The original entry follows. The scaffold's `name` is the raw session title (only its
  whitespace is collapsed, so ESC and BEL survive), and since MVP-A3 `/export` writes into `.relavium/workflows/`,
  which `list` scans and prints raw; a piped first message holding an OSC or CSI sequence then reaches the terminal
  on `relavium list`. The sink predates 1b: any committed workflow name, a tag and an invalid file's stem print raw
  the same way, and a cloned repository reaches it more easily. **Re-check:** pass `entry.name`, each tag and an
  invalid entry's slug through `sanitizeUntrustedInline`, as `list.ts` already does for `entry.error`, and pin it
  with an `ESC ] … BEL` name. *(low · apps/cli/src/commands/list.ts)*
- [~] **The canonical export mapping still says the export file is named by session id and that ids are not
  unique.** *Low; reference only.* *(round 5, export-2)* The live `/export` names its file after the first free
  `<slug>`, `<slug>-2`, … and writes that id into the file, and commands.md's chat-export section now links to this
  mapping. chat-session.md's `/export` row states the live behaviour correctly. **Re-check:** qualify the sentence:
  `relavium chat-export`'s default filename uses the session id; the live `/export` names its file after the id it
  takes. *(low · docs/reference/contracts/agent-session-spec.md)*

- [~] **A live run whose process is stopped for longer than the lease TTL is settled by the next start.** *Low;
  liveness only.* *(security sitting, sec-1)* A run whose owner is suspended for more than 60 seconds (SIGSTOP, or
  Ctrl+Z on the plain driver) has an expired lease, so the next `run`, `gate`, `budget resume` or Home open takes
  it over and writes `run:failed{internal}`. On Linux, timers do not count suspend, so after a laptop resume the
  owner's heartbeat can lag by up to 20 seconds, and a scheduled run that starts at wake can be the trigger. On
  macOS the monotonic clock counts sleep, so an overdue heartbeat fires on wake. Integrity holds: the takeover
  bumps the generation, so the woken owner is fenced (exit 6) and there is one terminal; a tool call between wake
  and the fence is the window ADR-0079 §6 accepts. **Re-check:** store the owner's pid and boot id on the lease row
  and skip a same-host takeover while that pid is alive, as an ADR-0079 amendment. *(low ·
  packages/core/src/engine/engine.ts, packages/db)*
- [~] **A `.relavium` that is a symlink sends the `/export` transcript to the link's target.** *Low.* *(security
  sitting, sec-2; extends round 1's export-6)* Project discovery follows the link, and the catalog's containment
  check compares against the link's own target, so `/export` creates `<target>/workflows/<slug>.relavium.yaml` with
  the full transcript, `@`-file and `!`-shell bodies included. A cloned repository whose `.relavium` points at a
  world-writable directory another local account prepared would receive it. Nothing is overwritten: a new file is
  written exclusively, and the rewrite replaces only a regular file carrying this session's marker. The same
  discovered directory already receives `create`'s writes. **Re-check:** refuse a project config directory whose
  real path is outside the directory that contains it, or ask before writing through a linked `.relavium`. *(low ·
  apps/cli/src/chat/export.ts, apps/cli/src/config/paths.ts)*

## MVP-1 1a milestone review — recorded low findings (2026-11-06)

The milestone review of MVP-1's UX increment 1a (at `624bb2e7`, the `relavium list` sink fix included) found four
medium findings, all fixed: a budget pause's summary pointed at `relavium gate`, `status <runId>` showed a finished
run's open gate as pending, the run-path tool pre-flight grew with nodes times grant length before the node ceiling,
and the chat's catalog-ceiling output cap ran into ADR-0082's 120-second absolute deadline. Round 2 (at `d8762a23`)
found one more medium, also fixed: the round-1 run-id latch let a resumed run's summary point a gate restored from its
checkpoint at `relavium gate`, although such a gate can be a budget gate `gate` declines. Round 2's wording and
`status` test lows (history-9/docs-3, history-10 in part, history-11, security-2/docs-4) were fixed with it, except
that the pending gate's node-id sanitizer stayed unpinned. Round 3 (at `32d1a8a7`) found one more medium, also fixed:
round 2's fix sent such a gate to `relavium status` for the command that continues it, which `status` printed only for
a budget gate; it now prints one for every pending human gate too, and the node-id sanitizer is pinned with it
(history-14, docs-2, security-1). Round 4 (at `8e7f41f2`) found one more medium, also fixed: `status <runId>` printed
an approved gate's step as `stopped` under its completed run, because no `node:completed` closes a gate's step row;
it now reads the decision from the log and prints `completed`. Round 5 (at `3354dda1`) found no blocker, high or
medium finding, so 1a is accepted; its docs-1 low, two entries below that still called `status`'s commands complete,
is fixed in this register. The lows below were not fixed. **Trigger for every entry:** the next change to the file it
names.

- [~] **A fenced run's summary can still point at `relavium gate`.** *Low.* *(runid-3)* When an inline gate prompt
  delivers a stale `run:paused` after the run was fenced (exit `6`), the TUI summary takes the paused branch while
  stderr says another process owns the run. Following either is harmless (`gate` is idempotent or refused).
  **Re-check:** pass the exit disposition to the summary and point a fenced run at `relavium logs`. *(low ·
  apps/cli/src/render/tui/final-summary.ts)*
- [~] **`list --runs` loads every column of every run.** *Low.* *(history-2)* The listing reads full run rows,
  inputs and outputs included, to print five fields, and offers no bound; `| head` instead exits `9` under
  `pipefail`. **Re-check:** a projection-only recency query, and a `--limit N` option. *(low ·
  apps/cli/src/commands/list.ts, packages/db)*
- [~] **No dispatch-level test passes `--runs` or a `<runId>` through.** *Low; test-side.* *(history-6)* A refactor
  that dropped either argument in `dispatch.ts` would turn `status <runId>` back into the active listing, or
  `list --runs` into the catalog, with every test green. **Re-check:** one `executeCommand` case per argument.
  *(low · apps/cli/src/commands/dispatch.ts)*
- [~] **Commit `e4783366` credits the 85th `run.test.ts` case to the run-id test.** *Low; history only.*
  *(docs-2)* The case that moved the secrets workload from 84 to 85 is the 2.6.A pre-flight test from `97714f9d`.
  Commits are immutable; the pins themselves are right. **Re-check:** if the workload pins gain a provenance note,
  credit `97714f9d`. *(low · tools/secrets-controls/mutations.mjs)*
- [~] **`mcp_call` with no declared server passes the run-path pre-flight.** *Low.* *(preflight-2)* `relavium run`
  wires the MCP arm only when an inline agent declares `mcp_servers`, so an agent granting `mcp_call` without one
  passes and fails with `tool_unavailable` at its first call. built-in-tools.md now says so. **Re-check:** give the
  pre-flight a conditional `mcp` arm and refuse `mcp_call` when no server is declared. *(low ·
  packages/core/src/validate-catalog.ts, apps/cli/src/commands/run.ts)*
- [~] **`gate` and `budget resume` do not re-run the tool pre-flight.** *Low.* *(preflight-3)* Only a run started
  before 1a, by `relavium@0.1.x`, can carry a grant the pre-flight would refuse; resuming it fails with
  `tool_unavailable` at the tool's first call, after the user decided the gate. built-in-tools.md now says so.
  **Re-check:** call the pre-flight beside the catalog check in `gate.ts`, before the MCP connect and the engine
  build. *(low · apps/cli/src/commands/gate.ts)*
- [~] **`/export`'s run hint names a scaffold the pre-flight refuses.** *Low.* *(preflight-6)* A chat that used an
  egress or os tool exports a workflow granting it, and the printed `relavium run <id>` exits `2` naming the tool.
  **Re-check:** check the exported workflow against the run profile and replace the hint with a note naming the
  tools, or say so in chat-session.md's `/export` row. *(low · apps/cli/src/commands/chat.ts)*
- [~] **The larger chat cap moves auto-compaction earlier and grows budget-shaped thinking.** *Low; recorded in
  ADR-0101's 2026-11-06 note.* *(budget-3, budget-4)* Pre-send compaction reserves the effective cap, so on a
  200k-window model with a 64,000-token ceiling it starts at about 68% of the window instead of 80%; and on a model
  whose effort tiers are budget-shaped, the thinking budgets derive from the effective cap and grow about 8–16× on the
  64,000-ceiling models from low to max (51,200 tokens at max), less on `claude-opus-4-1`.
  **Re-check:** reserve the configured estimate rather than the inserted default for the compaction decision, and
  derive budget-shaped tiers from a fixed reference cap. *(low · packages/core/src/engine/agent-session.ts,
  packages/llm/src/adapters/anthropic.ts)*

- [~] **The summary's budget command has no decision flag.** *Low.* *(runid-6)* The TUI summary prints
  `relavium budget resume <runId> --gate <gateId>`, and copied as printed it exits `2` asking for `--approve-amount`
  or `--abort`. The plain renderer and `status` print a command for each decision (history-16 covers the `secret`
  input case). **Re-check:** keep the allowance context on
  the view's budget notice and print `budgetResumeHints`. *(low · apps/cli/src/render/tui/final-summary.ts)*
- [~] **The summary embeds a run id in a command without the shell-inert check.** *Low.* *(security-3)* Only the
  budget command is checked; the `logs`, `gate` and `status` lines put the sanitized id in backticks, so a non-UUID id
  from a tampered `history.db`, resumed by quoting it, prints a command that differs from the id or parses as a flag.
  **Re-check:** apply `resumeCommandBase`'s test to the run id and fall back to display text. *(low ·
  apps/cli/src/render/tui/final-summary.ts)*
- [~] **A run whose terminal is held still lists its open gates.** *Low.* *(history-8)* The finished-run guard reads
  the projection, so a run held at exit `5` while paused shows the FINISHED banner beside a pending gate and a
  copyable `budget resume`, and `--json` pairs `terminalHeld: true` with non-empty gates. Acting on them answers
  `nothing to resume`. **Re-check:** treat `terminalHeld` as finished for the gate guard and the `stopped` mapping.
  *(low · apps/cli/src/commands/status.ts)*
- [x] **Run and step status strings print raw.** *Low.* *(history-12, security-1)* `status` and `list --runs`
  sanitize every history identifier but not the status column; only the SQLite CHECK keeps it clean, and a file
  written with `ignore_check_constraints` gets past it. **Fixed in the PR #97 review correction (2026-11-06):** the
  run and step status in `status`, the `--runs` row and the catalog line's `[last: …]` in `list`, and the run id and
  status in `logs`'s header now get the one-line floor, each pinned by a forged-status or forged-id test. *(low ·
  apps/cli/src/commands/status.ts, apps/cli/src/commands/list.ts, apps/cli/src/commands/logs.ts)*
- [~] **`status`'s own `completed` terminal entry is unpinned.** *Low; test-side.* *(history-10, remainder)* Removing
  `'completed'` from `TERMINAL_STATUSES` in `status.ts` passes every test, while a completed run with a stale outbox
  entry would then read held. **Re-check:** a completed run with a stale outbox entry expecting `terminalHeld: false`.
  *(low · apps/cli/src/commands/status.test.ts)*
- [~] **The CLI's issue count stops at ten.** *Low.* *(preflight-10)* The pre-flight reports ten nodes and one summary
  issue, and the CLI prints the first issue with `(and 10 more issues)`, so the summary holding the real count never
  shows. **Re-check:** render the summary issue, or put the total in the first message. *(low ·
  apps/cli/src/commands/drive.ts, packages/core/src/validate-catalog.ts)*
- [~] **The pre-flight still scans the agent list once per node.** *Low.* *(preflight-11)* The per-grant memo is
  consulted after `inlineAgent`'s linear find, so an adversarial 2 MiB file with tens of thousands of agents and nodes
  stalls about 2.3 s before the node ceiling, roughly doubling the time to its exit-`2` refusal. **Re-check:** build an
  agent map once per call. *(low · packages/core/src/validate-catalog.ts)*
- [~] **The pre-flight's bounded test passes without the memo.** *Low; test-side.* *(preflight-12)* Dropping the
  per-grant memo keeps every test green while round 1's 944 KB file then takes about 3 s in the pre-flight.
  **Re-check:** count iterations of a grant across many nodes rather than measuring output. *(low ·
  packages/core/src/validate-catalog.test.ts)*
- [~] **Nothing pins `agent run`'s `oneShot`.** *Low; test-side.* *(budget-6)* Deleting `oneShot: true` from
  `agent-run.ts`, or the builder's guard on the deadline, keeps every test green, though a one-shot would then send
  the catalog ceiling with a long deadline. **Re-check:** an `agent run` case asserting no cap on the wire and the
  default deadline, and a builder case with `oneShot` and an authored `max_tokens`. *(low ·
  apps/cli/src/commands/agent-run.test.ts, apps/cli/src/chat/session-host.test.ts)*
- [~] **`officialEndpointOf` is untested.** *Low; test-side.* *(budget-7, docs-2; round-1 budget-5's other half)*
  Making it report a custom endpoint, or a throwing resolver, as official keeps every test green; unreachable for
  Anthropic today, which refuses a custom base URL. **Re-check:** the two `buildChatSession` cases expecting no cap
  on the wire. *(low · apps/cli/src/chat/session-host.test.ts)*
- [~] **A chat reply longer than 30 minutes still times out.** *Low.* *(budget-8)* The 30-minute cap is below 25
  tokens per second for every ceiling above 45,000, so a healthy reply that streams past it fails as a billed,
  rolled-back timeout; ADR-0101's 2026-11-06 note states both bounds without the trade. **Re-check:** state the
  residual, or cap the chat's `max_tokens` at what the deadline can stream so the reply ends as `length`. *(low ·
  apps/cli/src/chat/session-host.ts, docs/decisions/0101-configured-output-estimates-apply-only-when-the-wire-is-uncapped.md)*
- [~] **The scaled deadline also bounds a stall, and the stall is retried.** *Low.* *(budget-9, security-4)* A
  pre-content timeout is retryable and the session primary gets two attempts, so a piped `chat --json` on an endpoint
  that keeps the stream open without content waits about 60 minutes per call (each fallback entry adds its own), instead
  of about 4. Each attempt stays bounded and SIGINT cancels it. **Re-check:** keep the default deadline until
  the first content chunk, or for non-interactive drivers, and say so in the note. *(low ·
  apps/cli/src/chat/session-host.ts, apps/cli/src/commands/chat.ts)*
- [~] **The deadline is sized from the requested cap, not the effective one.** *Low.* *(budget-11)*
  `chatAttemptDeadline` reads `agent.max_tokens` before the wire clamp, so `claude-opus-4-1` with a configured
  128,000 gets 30 minutes for a 32,000-token wire, and a cost-capped chat sending the implicit 4,096 keeps 120 s
  although 4,096 at 25 tokens per second needs 164 s. The note says "effective cap". **Re-check:** size it from the
  planned wire cap, or reword the note and config-spec. *(low · apps/cli/src/chat/session-host.ts)*

- [~] **The summary's `relavium gate <runId>` asks for `--gate` when two human gates wait.** *Low.* *(runid-8,
  docs-3)* A fan-out paused with no inline prompter (a piped stdin, `--secret-inputs-stdin`) announces both gates, and
  the summary prints one `relavium gate <runId>` with no `--gate`; copied as printed it exits `2` naming the pending
  gates. The same holds beside a gate restored from the checkpoint that is a human one. `relavium status <runId>`
  prints a command for each gate. **Re-check:** print one `relavium gate <runId> --gate <gateId>` per gate through
  `resumeCommandBase`, or point at `status` when more than one human gate may be pending. *(low ·
  apps/cli/src/render/tui/final-summary.ts)*
- [~] **`list --runs --json`'s record shape is only partly pinned.** *Low; test-side.* *(history-15)* Dropping
  `workflowId`, or replacing the documented `null` for a deleted workflow's slug or a missing start time with a
  fallback, keeps every test green. **Re-check:** assert one whole record with `toEqual`, plus a soft-deleted
  workflow's run and a never-started run. *(low · apps/cli/src/commands/list.test.ts)*
- [~] **The 30-minute chat cap and the `max_cost_microcents = 0` mapping are unpinned.** *Low; test-side.*
  *(budget-12)* The deadline tests read `MAX_CHAT_ATTEMPT_TIMEOUT_MS` rather than its value, so 10 or 60 minutes
  passes; and treating any defined `max_cost_microcents` as a cap, the documented unbounded `0` included, would
  restore the 4,096-token default with every test green. **Re-check:** assert the cap by value, and a
  `buildChatSession` case with `maxCostMicrocents: 0` expecting the catalog ceiling on the wire. *(low ·
  apps/cli/src/chat/session-host.test.ts)*

- [~] **The summary's human-gate line has no decision flag.** *Low.* *(runid-10)* The human-gate twin of runid-6:
  `relavium gate <runId>` copied as printed exits `2` asking for `--approve`, `--reject` or `--input`. `status` prints
  a command for each decision (history-16 covers the `secret` input case). **Re-check:** keep the gate type on the view's human-gate entry and print
  `humanGateResumeHints`, together with runid-6 and runid-8. *(low · apps/cli/src/render/tui/final-summary.ts)*
- [~] **`status`'s gate commands omit `--secret-stdin` for a run with a `secret` input.** *Low.* *(history-16,
  docs-1)* `gate` and `budget resume` refuse such a run without `--secret-stdin`, so the `approve:` and `reject:`
  lines `status` prints exit `2` as printed; the refusal names the full remedy. **Re-check:** read the masked secret
  names from `run:started` and print the piped `--secret-stdin` form `gate.ts`'s `secretPipeHint` builds, for human
  and budget hints alike. *(low · apps/cli/src/commands/status.ts, apps/cli/src/gate/pending.ts)*
- [~] **A run id of `list` turns a printed `gate` command into `gate list`.** *Low.* *(security-1)* `list` passes
  `resumeCommandBase`'s shell-inert check, so `status` prints `relavium gate list --gate <id> --approve`, which runs
  the listing and exits `0` with nothing resolved. Engine run ids are UUIDs; only a crafted `history.db` holds this.
  **Re-check:** refuse a run id that names a `gate` subcommand in `resumeCommandBase`, and make `gate list` reject
  decision flags. *(low · apps/cli/src/gate/budget.ts, apps/cli/src/commands/descriptors.ts)*
- [~] **No test has a shell-inert run id beside a hostile gate id at the `status` call site.** *Low; test-side.*
  *(docs-2)* The identifier test makes both ids hostile, so a call site that sanitized one of them before building
  the command would keep every test green and print an invented gate id. **Re-check:** a case per id, each expecting
  the flags-only sentence. *(low · apps/cli/src/commands/status.test.ts)*
- [~] **No pre-flight test has two inline agents.** *Low; test-side.* *(preflight-13)* A lookup that ignores
  `agent_ref`, or reads the first agent's grant for every node, passes every test. **Re-check:** two agents, one
  granting `web_search` and one `read_file`, a node bound to each, in both list orders; land it with preflight-11's
  agent map. *(low · packages/core/src/validate-catalog.test.ts)*
- [~] **A reply that fills a 200k window fails where the 4,096 cap ended it as `length`.** *Low.* *(budget-13)* On a
  64,000-ceiling model with a 200k window, a first message of about 180k tokens with nothing foldable skips
  compaction, suppresses overflow recovery and is sent with the catalog ceiling; the provider stops with
  `model_context_window_exceeded`, which fails and rolls back the exchange. **Re-check:** cap the default at the room
  the window leaves, or map that stop with committed content to `length`; or record it in ADR-0101's note beside
  budget-3 and budget-8. *(low · apps/cli/src/chat/session-host.ts, packages/llm/src/adapters/anthropic.ts)*

- [~] **The decided-gate relabel is tested only on a finished run with an approval.** *Low; test-side.* *(runid-11,
  history-17, docs-2)* Every `status` test that decides a gate seeds `decideAfterPause`, which approves and then
  completes the run, and the paused-run test checks the substring `g [human_in_the_loop]`, not its `running` label.
  Limiting the relabel to finished runs, recording only approvals in `decidedGateNodes`, or relabelling a still-pending
  gate's step under a paused run as `completed` each keeps every test that calls `statusCommand` green. The code at
  `3354dda1` is correct; real-engine probes print `completed` for a decided gate and `running` for the waiting one
  under a paused run, and `completed` after a rejection. **Re-check:** a paused two-gate case, one gate decided and one
  pending, expecting `completed` and `running` plus the pending gate's hints; a rejected-decision case through a
  decision option on `decideAfterPause`; and the paused-run test asserting `  running   g [human_in_the_loop]\n`.
  *(low · apps/cli/src/commands/status.test.ts, apps/cli/src/test-support.ts)*
- [~] **An approved budget gate lists its agent node twice, each row with the node's full cost.** *Low;
  pre-existing.* *(runid-12)* A budget approval re-dispatches the node at attempt 1, so a second `node:started`
  inserts a second step row, and the one `node:completed` closes both, since `stepMatch` matches on run, node and
  attempt 1, with the settled cost on each. `status <runId>` prints `completed agent [agent]` twice, and a `--json` consumer that sums
  step costs gets twice the run's spend. The projection predates 1a; `status <runId>` now shows it for finished runs
  too. **Re-check:** close the gated attempt's row when its budget gate resolves, or give the re-dispatch its own
  attempt number. *(low · packages/db/src/run-history-store.ts)*
- [~] **An empty `fallback_chain: []` misses the chat's catalog-ceiling default.** *Low.* *(budget-14)*
  `withChatOutputDefault` checks whether the key is present, not whether the chain has entries, and the schema
  accepts an empty chain. An Anthropic chat agent that authors `fallback_chain: []` keeps the adapter's 4,096-token
  cap and the 120-second deadline instead of the ceiling and the scaled deadline that config-spec.md and ADR-0101's
  notes promise. No Relavium generator writes an empty chain; removing the key or setting `[chat].max_tokens` works
  around it. **Re-check:** treat an empty chain as no chain, with a unit case expecting the ceiling; land it with
  budget-6 and budget-7. *(low · apps/cli/src/chat/session-host.ts)*
- [~] **Two comments overstate since round 4.** *Low; comment-only.* *(docs-3)* `ActiveRunStatus.gatesUnavailable`'s
  comment says it is `true` whenever the run's log could not be read, but a finished run's damaged log leaves it
  unset. `decidedGateNodes`'s comment says the projection never closes a human gate's step row, but a gate that times
  out without approval is settled with `node:failed`, which closes it. **Re-check:** say "an active run's" in the
  first and "a decided human gate's step row" in the second. *(low · apps/cli/src/commands/status.ts,
  apps/cli/src/gate/pending.ts)*
- [~] **A gate message can soft-wrap into a fake command row above `status`'s real ones.** *Low.* *(security-1)*
  `sanitizeInline` collapses tabs and line feeds but keeps runs of spaces, and the gate message has no length bound.
  A message padded to a guessed terminal width can place a row that looks like `    approve: relavium gate …` with an
  attacker-chosen suffix directly above the real `approve:` and `reject:` lines round 3 added. It needs a guessed
  width, leaves a stray `"` row visible, and a gate message can already carry a plain-prose instruction; the same
  class as round 1's outputs-5 in 1b's register. **Re-check:** bound the printed message's width, wrap it with an
  indented continuation, or put a fixed label row between it and the commands; land it with outputs-5. *(low ·
  apps/cli/src/commands/status.ts)*

## PR #97 review — fixed findings and recorded lows (2026-11-06)

Four reviews of the `development` → `main` checkpoint PR #97 (at `077650a8`) reported about sixty findings, several
rated high. Six verification agents checked each against the code at that commit, with probes, and none held as
high: the gate-type bypass is unreachable from the CLI, the live-run start race was recorded and fails closed, and
the `/export` race needs a concurrent writer. Eight held as medium. By the maintainer's rulings of 2026-11-06 six are
fixed before the PR merges and two are resolved in the record, so the correction owes a D64 rigor pass, a new complete
round and a separate security sitting. The verified register is `docs/analysis/private/2026-11-06-pr97-review-triage.md`
(not tracked).

**Fixed (medium):** reconcile's repair could relabel a completed run failed when its owner held its terminal in
the outbox meanwhile (it now reads the outbox again under its claim); a bare Enter on an approval, review or
budget-amount card approved; a card whose gate a deadline decided stayed open and dropped the later answer silently;
the Windows readiness budget; the ADR-0119 and ADR-0120 drafts. **Resolved in the record (medium):** the URL-password
reversal against `main` is stated (the PR #96 review's A4, above); the ReDoS entry names the cloned-repository vector
and stays open (M8). **Fixed (low):** the drain now reads the outbox before the open runs (A2); reconcile leaves a run
younger than one lease TTL alone, which narrows 1b's liveness-1 (A1); a crashed run with an unresolved external effect
is settled as `effect_needs_attention` (A4); Esc at the rejection reason cancelled the run (Ctrl-C there still
cancels it: the card watches its input for the key, since Clack reports both as one cancel); the card promised
`auto-reject` where the run fails; `/export`'s own-export rewrite re-checks the file before it replaces it; the
ADR-0118 draft (HMAC grants); history-12; the doc and comment items. The register's plan also listed B3's `?? []` and
B2's missing-vertex fail-closed as one-line fixes; they were recorded below instead. The lows below were not fixed.
**Trigger for every entry:** the next change to the file it names.

- [~] **A corrupt or schema-mismatched outbox line lets reconcile settle its run failed.** *Low.* *(A3)* The
  outbox skips a line it cannot parse, so its run holds no terminal and the repair settles it. A truncated line
  is ADR-0078's accepted floor; a complete line a newer binary wrote is not. **Re-check:** a JSON object with a
  string `runId` that fails the schema holds its run; count unreadable lines and print one fixed diagnostic; never
  hold every run on one bad line, since the file is never compacted. *(low · apps/cli/src/engine/terminal-outbox.ts,
  packages/core/src/engine/engine.ts)*
- [~] **Isolating an unreadable run would drop its outbox entry.** *Low.* *(A5)* The round-1 liveness-2 fix must also
  make the listing report the unreadable run and the drain hold its entry; a run simply left out of the list has its
  entry dropped as already landed. *(low · packages/db/src/run-history-store.ts, packages/core/src/engine/engine.ts)*
- [~] **Reconcile's result is discarded.** *Low.* *(A6)* `reconcileInterruptedRuns` and the `run`/`gate` calls
  swallow everything, which hides A3, A5 and a wiring regression. **Re-check:** return a structured outcome and print
  one fixed, secret-free line. *(low · apps/cli/src/history/reconcile.ts)*
- [~] **The run-terminal type set is repeated across packages.** *Low; nit.* *(A8)* **Re-check:** one exported set in
  `@relavium/shared`. *(low · packages/core, packages/db)*
- [~] **The gate-type fit checks skip a missing or non-gate node.** *Low.* *(B1, B2, B3)* Unreachable from the CLI
  (the snapshot schema and the gate producers rule it out), but an embedder's executor can pause an `agent` vertex as
  an approval gate and resume it with `input_provided`; a missing vertex may stall `#resume`; an unknown `gateType`
  throws a `TypeError`. **Re-check:** carry `gateType` on the pending gate and check against it, throw
  `invalid_decision` for a missing vertex, and treat an unknown type as accepting nothing. *(low ·
  packages/core/src/engine/engine.ts, packages/core/src/engine/gate-decision-fit.ts, apps/cli/src/gate/decision.ts)*
- [~] **An input gate records an empty value on a bare Enter and offers no Reject.** *Low; product call.* *(B8)*
  *(low · apps/cli/src/gate/clack-prompter.ts)*
- [~] **`gate list` hides the gates of a run a crash left `running`.** *Low.* *(B9)* `status` and `gate` still reach
  them, against commands.md's "the listing and the resume can never disagree". **Re-check:** read every non-terminal
  run. *(low · apps/cli/src/commands/gate-list.ts)*
- [~] **`chat-export --force` writes through a link at `--out`.** *Low; pre-existing.* *(C2)* **Re-check:** under
  `--force`, write a temp and rename it over the target. *(low · apps/cli/src/process/owned-storage.ts)*
- [~] **The own-export rewrite does not fsync the directory.** *Low.* *(C3)* A power loss can bring the old version
  back; the old-or-new promise holds. *(low · apps/cli/src/process/owned-storage.ts)*
- [~] **A locked keychain reads as "no API key".** *Low.* *(C6)* MVP-A4 shows it before the first turn now, with a
  "store one" remedy. **Re-check:** a tri-state key status and an "unlock the keychain" wording. *(low ·
  apps/cli/src/engine/providers.ts, apps/cli/src/chat/session-host.ts)*
- [~] **The chat output default looks the catalog up by model id alone.** *Low.* *(C7)* An Anthropic agent with an
  OpenAI model id gets that model's ceiling; harmless, since Anthropic refuses the id. **Re-check:** require the
  entry's provider to match. *(low · apps/cli/src/chat/session-host.ts)*
- [~] **The session builders fall back to an env-only key resolver.** *Low; latent.* *(C5)* Every production caller
  passes a keychain-aware one. **Re-check:** make `providers` required. *(low · apps/cli/src/chat/session-host.ts)*
- [~] **Run outputs show a credential nested under a credential's name.** *Low.* *(D3)* An object or array under
  `x-api-key` or `api-key` (a name the scrubber reads as a credential's label) is shown, a `null` under such a name
  prints `[REDACTED]`, and a value that cannot be represented prints no note. **Re-check:** mask any non-null value
  under a name the scrubber reads as a credential, keep `null`, carry `masked` out of the catch. *(low ·
  apps/cli/src/render/run-outputs.ts)*
- [~] **The secret walk and the media walk have no depth bound.** *Low; fails closed.* *(D5)* About 3,000 levels
  make the summary `[unserializable]`. **Re-check:** a depth cap with a fixed marker. *(low ·
  packages/core/src/tools/bounding.ts)*
- [~] **The `run_command` allowlist compares the space-joined argv.** *Low; pre-existing.* *(D11)* `["cat a b"]`
  admits `["cat", "a b"]` and `["cat a", "b"]`. ADR-0118's remembered grants match element-wise; this must be fixed
  before that ships. **Re-check:** compare tokenized entries element by element. *(low ·
  packages/core/src/tools/registry.ts, packages/core/src/tools/builtins.ts)*
- [~] **The release tooling refuses semver build metadata and some legal package names.** *Low; fails closed.*
  *(F3)* *(low · tools/cli-package/archive.mjs)*
- [~] **The MCP-orphan guarantee is not tested on Windows.** *Low.* *(F6)* `check.mjs` uses `/bin/ps` and the e2e
  suite skips win32. *(low · tools/cli-smoke/check.mjs, apps/cli/src/harness/mcp-orphan.e2e.test.ts)*
- [x] **The "required checks cannot be skipped" test pins 7 of the `ci` job's 29 steps.** *Low; closed (2026-11-18).* *(F7)* A
  `continue-on-error` on Format check passes it; `f213d2a8`'s subject overstates it. **Re-check:** assert no
  `continue-on-error` on any `ci` step, with the two known `if`/`shell` exceptions. **Closed:** the `ci` job is now a thin
  aggregate and its checks run in `ci-work`; `checkWorkspaceSteps` asserts that every `ci-work` step has no `continue-on-error` and no
  `working-directory`, an `if` only on the diagnostics upload and a `shell` only on the replay fetch, and the case "a check tolerating
  failure" (`continue-on-error` on `format:check`) must be refused. `node --test tools/ci/workspace-scheduling.test.mjs` passes (36 tests). *(low ·
  tools/ci/workspace-scheduling.test.mjs)*
- [~] **A workflow input's `min` or `max` of `.inf` makes its run unresumable.** *Low; pre-existing.* *(F8)* JSON
  turns it into `null` in the snapshot, which the snapshot schema refuses. **Re-check:** `.finite()`, with a
  round-trip test. `[chat].max_tokens` is unbounded too, though capped downstream. *(low ·
  packages/shared/src/workflow.ts, packages/shared/src/config.ts)*
- [~] **Five more Windows tests sit on Vitest's 5 s default.** *Low.* *(F1)* `concurrency.e2e` (twice),
  `fs-workspace-admission` (twice) and `session-effect-turns` timed out in the same slow-runner cohort over 58 runs.
  **Re-check:** watch at least 20 Windows runs after the readiness budget, then give these their own budget if they
  recur. *(low · packages/db, apps/cli)*
- [~] **The pre-flight's exit change needs a release note.** *Low.* *(E8)* `relavium run` now refuses (exit `2`) a
  workflow granting `http_request`, `web_search`, `read_clipboard` or `notify`; before, it ran and failed (exit `1`)
  at the first such call, or completed if none was made. **Trigger:** the v0.2.0 CHANGELOG (MVP-A23). *(low ·
  CHANGELOG.md)*

**D64 round 1 of the correction (2026-11-06, at `13979d60`)** found one medium, ADR-0118's grant label storing
`argv[0]` verbatim, and fixed it with the lows below it in the correction's own records and tests (the own-run
guard pinned again, the TTL rule bounded on both sides, the event contract's reconcile codes, a logs run-id test,
an own-export identity that also compares `size`, `mtime` and the bytes' SHA-256, so a same-length rewrite inside one
tick of a coarse filesystem clock is caught and its tests no longer depend on the clock, ADR-0118's Session answer and its
"what a grant does not bind" limit, ADR-0120's escape order). These were recorded:

- [~] **A late answer can still be dropped without a notice.** *Low.* *(gates-2, security-7)* The card closes
  when the deadline's `human_gate:resumed` reaches the run view. An answer that lands after the deadline claimed
  the gate but before that event arrives — the timer's few milliseconds, or seconds while the deadline's write
  waits on a busy `history.db` — reaches `engine.resume`, which ignores a decided gate in silence. **Re-check:** keep
  the card registered until its gate's `human_gate:resumed` is seen, or have `resume` report whether it applied the
  decision. *(low · apps/cli/src/commands/drive.ts, packages/core/src/engine/engine.ts)*
- [x] **The notice says "your answer" when no card was drawn.** *Low; cosmetic.* *(gates-3)* A deadline that fires
  while the view unmounts for the card prints it anyway; so does an idle card a deadline closes (round 2's gates-3).
  **Fixed 2026-11-06 (D64 round 2):** the notice now says no answer from this terminal was recorded, which holds in
  every case. *(low · apps/cli/src/commands/drive.ts)*
- [~] **A paste or a hotkey can still answer a gate card.** *Low; pre-existing.* *(security-2)* Clack's confirm
  takes `y`/`n` and `h`/`j`/`k`/`l`/space as answers, so a stray paste such as "The deploy looks wrong" approves an
  approval or budget-amount card; only a bare Enter is now safe. The MCP consent prompt shares it. The chat
  approvals have a paste floor (ADR-0057); the gate card has none. **Re-check:** filter the card's input to one
  unmodified keypress and drop bracketed paste, with a real-Clack paste test. *(low ·
  apps/cli/src/gate/clack-prompter.ts, apps/cli/src/mcp/consent-prompt.ts)*
- [~] **A raced own-export rewrite can leave two exports of one session.** *Low.* *(export-2)* When the file
  changed but still names this session (a second terminal's `/export`, an editor's atomic save), the export
  moves to the next id, and later `/export`s update the lower one. **Re-check:** prevent the duplicate without
  writing over the changed file: an editor's save keeps the session's marker, so a file that changed after it was
  recognized stays as it is, as the changed-file contract says. *(low · apps/cli/src/chat/export.ts)*
- [~] **No Windows job runs the own-export identity tests.** *Low.* *(export-3)* **Re-check:** add
  `owned-storage-replace.test.ts` and `export-project.test.ts` to the Windows filesystem step. *(low ·
  .github/workflows/ci.yml)*
- [~] **The Home and `chat list` print `history.db` status and slugs raw.** *Low.* *(sinks-2)* history-12's class on
  surfaces its fix did not cover. **Re-check:** `sanitizeInline` in `home-projection.ts`'s labels and
  `chat-list.ts`'s rows, with forged-status tests. *(low · apps/cli/src/render/tui/home-projection.ts,
  apps/cli/src/commands/chat-list.ts)*
- [~] **The reconcile guard against an in-flight resume, and the drain's own-run guard, are unpinned.** *Low;
  test-side; pre-existing.* *(reconcile-1)* The own-run test now pins `#runs` again; the `#resumingRuns` half and the
  drain's claim never had a test. *(low · packages/core/src/engine/run-lease.test.ts)*

**D64 round 2 of the correction (2026-11-06, at `82db354e`)** found two mediums, both in Proposed drafts. ADR-0118's
label took `argv[0]`'s base name before the grammar check, so the secret last segment of a webhook URL passed whole
as `command`, or the tail of an assigned secret, could become the label; the label now names only an `argv[0]` that
is a bare name resolving on the `PATH`. ADR-0120's approval escape covered only controls and bidi characters, so a
zero-width or tag-character run could hide content in an approved diff; it now covers every default-ignorable and
format code point. Fixed with them: the stale gate contracts in `drive.ts` and `prompter.ts`, the decided-elsewhere
notice (above), the hollow directory test and the forged-hash test, the own-export re-check reading the file before
comparing its stat fields (it now reads only the same regular file, no-follow and non-blocking, as `/export`'s own
read does, so a FIFO swapped in no longer blocks and a permission change moves the export on), the `logs`
skipped-row note printing `history.db`'s `seq` raw, and three doc sentences (D3's credential names, the ReDoS
entry's commands, the glossary's and the vision's auto-reject timeout). Recorded:

- [~] **A Reject chosen before an approve deadline still loses to it while the optional reason is typed.** *Low;
  pre-existing.* *(gates-2)* The rejection reaches the engine only when the reason prompt settles, so an `approve`
  deadline that elapses meanwhile approves the gate and the card closes with the notice. **Re-check:** on a card with
  an approve deadline, submit the rejection as soon as Reject is chosen, or show the time left at the reason prompt.
  *(low · apps/cli/src/gate/clack-prompter.ts)*

**D64 round 3 of the correction (2026-11-07, at `4f259890`)** found two mediums. Closing a card when a deadline
decided its gate opened the run's next card at once, so the keys the user was still typing for the closed card
answered it (Clack's `y` approves); after such a close the run's later gates are now left for the command its
summary names. The card also tells its own decision by what it returned, no longer by a `decidedBy` of `cli`, which
every CLI decision shares. ADR-0120's escape still let U+2028 and U+2029 through, which JavaScript reads as line breaks and a
terminal draws as nothing; the escape is now a closed set (every `\p{C}` code point, every separator but the ASCII
space, every default-ignorable code point and U+2800, with TAB shown as a tab mark). Fixed with them: tests for the
reconcile re-read's per-run check and its claim release, for a deadline deciding another gate while a card is open
and for the legacy budget card's Enter; tests for a swap between the own-export check's last `lstat` and its open;
`gate list`'s ids and `status`'s attempt number on one line; the card-close comments; and ADR-0118's masked spans and
Positive consequence, and ADR-0120's plain drawing, against ADR-0114 §5. Recorded:

- [~] **No test drives a FIFO swapped in between the own-export check's `lstat` and its open.** *Low; test gap.*
  *(export-1)* `O_NONBLOCK` is what keeps that open from blocking; a test would hang its worker on a regression
  rather than fail. **Re-check:** run the case in a child process with a `spawnSync` timeout. *(low ·
  apps/cli/src/process/owned-storage.ts)*
- [~] **The MCP consent card's argument display passes U+2028 and U+2029.** *Low; pre-existing.* *(security-1's
  sibling)* `safe()` in the consent gate strips controls and zero-width characters but not the line separators, so a
  repository-declared server's argument can look like a comment. **Re-check:** apply ADR-0120's approval escape when
  it lands. *(low · apps/cli/src/engine/mcp-consent-gate.ts)*

**D64 round 4 of the correction (2026-11-07, at `2d7f0714`)** found two mediums. Round 3's own fix left the pause
that parked a gate in place after the gate resumed, so once a card closed under the user every later event attempted a
departure and re-mounted the live view, which then stacked one frame per event and drew no streamed text; a resumed
gate now clears it. ADR-0120's closed escape still drew a trailing ASCII space as nothing and dropped a line's
ending from the comparison; whitespace at a line's end now shows a mark per character, and a changed or mixed line
ending shows as `<CR LF>` or `<LF>`, so a whitespace-only or ending-only change never renders as an unchanged line.
Fixed with them: a test that the TTL check runs before the claim, tests that something already at the own export's
path is refused before it is opened, a test for a legitimate attempt number, `gate list`'s empty-result line and
`gate`'s two idempotent notices on one line, ADR-0120's blank-drawing list (U+16FE4, U+1D159) and its plain drawing,
ADR-0118's card and Positive wording, and three comments. Recorded:

- [~] **Keys typed into a card closed under the user reach the shell when the CLI exits.** *Low.* *(security-3)*
  Nothing reads the input once the card closes, so the cooked line discipline keeps the rest of a typed reason, and
  the shell reads it when the run parks and the CLI exits `3`. **Re-check:** keep a raw-mode reader that discards
  input until the view re-mounts, or drain pending input before exit. *(low · apps/cli/src/commands/drive.ts)*

**D64 round 5 of the correction (2026-11-07, at `882a2ff8`)** found no medium in the code; reconcile came back clean.
It found two in ADR-0120. A new file written entirely in CR LF still looked like its LF twin, since only a differing
or mixed ending was marked; the card now states each side's endings whenever they are not all LF. And secret masking
could hide code a model chose: `Bearer $(curl …|sh)` is masked like `Bearer sk-…`. A masked span holding anything but
credential characters is now flagged, and approving waits until the user reveals it with a deliberate key. Fixed with
them: the escape notation escapes a literal `<U+`, visible right-to-left text and the hand-kept blank list are stated,
ADR-0118 draws each argument on its own line, a test that a chmod after recognition is refused, a test for `gate`'s
resolved-id notice, `/export`'s "next free id" wording, and the card-ownership comments and test names. Recorded:

- [~] **No test pins `gate`'s "already settled" notice sanitizer.** *Low; test gap.* *(sinks-1)* Reaching it needs a
  paused run whose stored id carries controls. **Re-check:** seed one through the run store and resume it with a
  closed handle. *(low · apps/cli/src/commands/gate.ts)*
- [x] **ADR-0120's approval escape completeness — closed in MVP-3 on development (2026-11-12).**
  *Maintainer ruling 2026-11-07.* Rounds 2 to 5 each found a further way an approval preview could hide content
  (zero-width and tag runs, U+2028 and U+2029, line-end whitespace and endings, code inside a mask), each rated medium
  against the draft's claim that a preview never hides what it approves. The draft now states its rules as a starting
  set and claims only them; the mandatory security review confirms or extends them before the card is built, and the
  correction's later rounds do not treat a further gap as a finding against the draft. **Trigger:** MVP-3's approval
  card. *(docs/decisions/0120-the-toolbelt-grows-and-a-tool-call-shows-what-it-does.md)*
  **Closure:** the pre-build design sitting and independent implementation/security
  reviews verify the escaped, masked, inspectable approval projection. The
  [MVP-3 checkpoint](phases/phase-2.6-conversational-authoring.md#mvp-3-development-implementation-checkpoint-2026-11-12)
  owns actual execution evidence and remaining PR CI/maintainer review.

**D64 round 6 of the correction (2026-11-07, at `2cc865c7`)** found one medium in the correction: commands.md still
said a losing rejection does not stop later gates, which cbe39064 changed; it now says the run parks on them. It also
found a medium that predates the correction (`d5ed56f4`, already on `main`): the whole gate card ran under the 250 ms
cleanup timer, so every card a person took longer than that to answer printed a false "Run cleanup is still pending"
under it and threw off its redraws. By the maintainer's ruling it is fixed here: the card's timer starts only when the
card is aborted. Fixed with them: the own export's stat fields pinned one at a time, independent of the filesystem
clock (round 5's chmod test needed a fine-grained ctime), the export docblock's wording, the reconcile comment that
called the drain order the protection, the race test's name, and ADR-0118's and ADR-0120's wording after the
narrowing. Recorded:

- [~] **Two CR-92 "not relabelled failed" tests now pass because of the TTL rule.** *Low; test erosion.*
  *(reconcile-1)* They reconcile a run younger than one lease TTL, so the repair never reaches it; the property stays
  pinned by engine.test.ts and history/reconcile.test.ts. **Re-check:** reconcile on a host clock past start + TTL.
  *(low · packages/core/src/engine/m2-e2e-harness.e2e.test.ts, apps/cli/src/harness/durability.e2e.test.ts)*
- [~] **A deadline that fires while the live view unmounts stops later inline prompts though no card was drawn.**
  *Low.* *(gates-3)* The notice prints and the run parks on its next gate. **Re-check:** set the refusal only when a
  card was drawn. *(low · apps/cli/src/commands/drive.ts)*
- [~] **No test pins that `/export` moves past a changed own export to another of the session's own exports.**
  *Low; test gap.* *(export-2)* **Re-check:** two own exports, the first changed during the replace. *(low ·
  apps/cli/src/chat/export.ts)*

**D64 round 7 of the correction (2026-11-07, at `72dee66a`)** found one medium in the correction: round 6's
commands.md sentence said a decision from another process closes an open card, but another process's decision never
reaches the run view; it now says only a deadline does, and what happens otherwise. It found a second medium that
predates the correction, recorded below by the maintainer's ruling. **The maintainer merged PR #97 at `72dee66a`
(merge commit `c04e6c13`, 2026-11-07), before a round came back clean and before the correction's separate security
sitting was held.** Round 7's medium and its lows (the reconcile comments, the TTL rule's either-way clock, two test
comments and a test name) were fixed on `development` after the merge. Recorded:

- [ ] **Answering a stale gate card after another process decided the gate fails a healthy run.** *Medium;
  pre-existing (on `main` before the correction); must be fixed before v0.2.0 (maintainer ruling 2026-11-07).*
  *(security-2)* When terminal B decides gate g with `relavium gate` and releases its lease, terminal A's open card for
  g still takes an answer. A's resume reclaims the lease under a fresh fence, its guarded append is refused on its
  stale head, and since only a fence refusal counts as losing ownership, A writes `run:failed{internal}` at a sequence
  B already used. SQLite refuses it, the outbox holds it for good (A exits `5`, and `relavium status` says the run
  FINISHED while it is paused at its next gate), and the held entry keeps every later reconcile from repairing that
  run if it crashes. The in-memory store, with no `(runId, seq)` uniqueness, lands the bogus terminal instead. Ctrl-C
  at the stale card writes a held `run:cancelled` the same way. **Re-check:** treat a guarded-append refusal after a
  reclaim as ownership loss (no terminal, no outbox entry, the re-acquired row released, exit `6`), or have
  `#reclaim()` give the claim back when the store's last sequence moved; add a two-engine SQLite test, and make
  `InMemoryRunStore` refuse a duplicate `(runId, seq)`. A lease-path change: its own D64 security-tier increment.
  *(medium · packages/core/src/engine/engine.ts, packages/core/src/engine/execution-host.ts; ADR-0079 §4)*
  **Implemented 2026-11-22 on `development`, uncommitted; stays open until its D64 review round and separate security
  sitting.** Classified at the write, not read in `#reclaim()`: a claim `#reclaim()` re-takes stays unproven until a
  write under it is acknowledged. Until then a terminal is guarded against the head this process left at its park, and
  an `AppendConflictError` whose durable head differs from that head is ownership loss: no terminal, no outbox entry,
  the re-taken row released by its exact fence, and `uncertain` with no terminal (exit `6`). The answer and the Ctrl-C
  case are both covered. `InMemoryRunStore` now refuses a duplicate `(runId, seq)` with an untyped error, as SQLite's
  index does. Tests: `packages/core/src/engine/stale-gate-card.e2e.test.ts` (two engines on one reference store;
  `@relavium/core` has no SQLite dependency, so a native two-process SQLite twin in `apps/cli` is still owed) and
  `execution-host.test.ts`.
- [~] **No test pins the own-export read's size-plus-one bound.** *Low; test gap.* *(export-1)* A file that grows
  between the descriptor's `fstat` and the read is caught only by that extra byte. **Re-check:** grow the file from an
  `fstatSync` hook in the race test. *(low · apps/cli/src/process/owned-storage.ts)*

## Wave 3 NI — recorded low findings (2026-10-25)

Round 1 of the native-identity increment at `fc5af701` accepted it with these lows
([acceptance](phases/phase-2.5.5-hardening-and-remediation.md#wave-3-ni-acceptance--2026-10-25)). **Trigger for
every entry:** the next change to the file it names.

- [~] **The lifecycle smoke's precondition reads can revert to numbers unnoticed.** *Low; test-side.* *(round 1,
  PLAN-NI-R1-1)* Restoring `fs.lstatSync(candidate.owned).ino` at `tools/budget-replay-compat/lifecycle-smoke.mjs`
  lines 325 and 369 still passes `pnpm smoke:budget-replay`: in the collision mode a bigint and a Number never
  compare strictly equal, and in the other modes the real inodes differ. Production's retention identity is
  witnessed separately. **Re-check:** assert both values are bigints before the comparison; reverting either read
  must then fail the smoke. *(low · tools/budget-replay-compat/lifecycle-smoke.mjs)*
- [~] **Nothing tests the projection's `mtimeMs` formula.** *Low.* *(round 1, NI-T-1)* Replacing it in
  `packages/db/src/media-store-paths.ts` `exactStats` with whole milliseconds (`Number(info.mtimeNs / 1_000_000n)`)
  or whole seconds passes every media-store test. The bit-identical claim rests on an author probe of 307 files, and
  a silent change could shift `listHandles()`'s `mtimeMs` and the sweep's age inputs by up to a second.
  **Re-check:** a case that sets a fractional and a negative fractional mtime and asserts the projection is
  `Object.is`-equal to `lstatSync(path).mtimeMs`; both mutants must fail. *(low ·
  packages/db/src/media-store-paths.ts)*
- [~] **The catalog's dense-multibyte case catches only a byte bound below 1.5 times the character cap.** *Low.*
  *(round 1, NI-T-2)* `apps/cli/src/workflows/catalog.test.ts` writes three-byte characters to about
  1.5 × `MAX_SOURCE_CHARS` bytes, so `BigInt(MAX_SOURCE_CHARS * 3)`, `* 2` or a `>=` boundary in `catalog.ts`'s
  precheck still pass, although a file of four-byte characters just under the character cap would then be refused.
  **Re-check:** use four-byte characters to within one character of 4 × `MAX_SOURCE_CHARS` bytes; the 3×, 2× and
  `>=` mutants must fail. *(low · apps/cli/src/workflows/catalog.test.ts)*

## Native file identity on Windows — approved increment (2026-10-24)

Found by Step 9a.2a's push CI (the advisory Windows job of run 40105286543). The maintainer approved a separate
increment, after 9a.2b and before 9b (register row NI), rather than a deferral; this entry tracks it until then.
NI is independently accepted on `development` at `fc5af701` (2026-10-25,
[acceptance](phases/phase-2.5.5-hardening-and-remediation.md#wave-3-ni-acceptance--2026-10-25)); the item stays
open until the Windows clause below closes it after three consecutive green advisory Windows runs on pushed heads.
**Closed 2026-10-26:** the third consecutive green advisory Windows run (push CI run 40276471445 at `5a328bca`, probe
`0 of 200`) closed the Windows clause ([NI acceptance](phases/phase-2.5.5-hardening-and-remediation.md#wave-3-ni-acceptance--2026-10-25)); the scoped limits below stay open.

- [x] **Identity checks compare `ino` as a JavaScript number, which Windows file IDs overflow.** *High; security,
  Windows.* `statSync`, `lstatSync`, `fstatSync` and `FileHandle.stat` without `{ bigint: true }` return `ino` as a
  number, but on Windows `ino` is the volume's 64-bit file ID; above 2^53 neighbouring IDs round to the same value,
  so a replaced file or directory can compare as the original. `apps/cli/src/engine/tool-host/fs-policy.test.ts`,
  "revokes a selected subdirectory replacement even when its enclosing grant is unchanged", read the replacement on
  the Windows runner (its first failure in sixty runs). Sites: `apps/cli/src/engine/tool-host/fs-policy.ts`
  (`pinDirectory`/`validatePin`), `apps/cli/src/workflows/catalog.ts` (the open check), and
  `packages/db/src/media-store-paths.ts` (directory pins and `assertOwnedFile`), `media-store-read.ts` (the
  read's before/after check) and `media-store-temporaries.ts` (`same` and the `Number(...)` comparison in
  `nativeFile`). **Re-check:** every identity is read with `{ bigint: true }` and compared as `bigint` (or its exact
  string), with a replacement test per site that fails when the comparison goes back to a number; the Windows job
  passes the fs-policy test repeatedly. *(high · the five files above)*

Scoped limits recorded with NI (2026-10-25):

- [~] **ReFS, Dev Drive, FAT and exFAT do not give unique, stable 64-bit file IDs.** *Low; Windows ReFS/Dev
  Drive and FAT/exFAT volumes.* Microsoft documents that the 64-bit identifier "is not guaranteed to be unique on
  ReFS", and that a FAT file ID is derived from the position of the file's directory entry, which renaming a file
  to a longer name moves. NI makes every comparison exact, so the claim is exact identity on filesystems whose
  64-bit file IDs are unique, such as NTFS, ext4 and APFS. On ReFS two files could share an index; on FAT or exFAT
  a replacement created in a freed directory entry could inherit the pinned ID, so a check would admit it (fail
  open), whatever the comparison's precision. Minimal example: a pinned directory `selected` on a FAT volume is
  renamed to `selected-old` and a new `selected` is created in the freed entry. **Re-check:** if ReFS, Dev Drive,
  FAT or exFAT workspaces become a supported target, read the 128-bit `FILE_ID_INFO` identity, pair the identity
  with a second discriminator such as creation time, or refuse such volumes; native code or a dependency needs an
  ADR. *(low · `apps/cli/src/engine/tool-host/fs-policy.ts`, `packages/db/src/media-store-paths.ts`)*
- [~] **The causal-control source graph's hard-link check still compares `ino` as a number.** *Low; tooling,
  fail-closed.* `tools/usage-coverage-controls/source-graph.mjs` asserts that each copied source file's `ino`
  differs from its original's, so a collision can only refuse a copy falsely; four causal families share the
  file, and NI left it unchanged rather than perturb them. **Re-check:** switch both reads to `{ bigint: true }`
  the next time that file changes. *(low · `tools/usage-coverage-controls/source-graph.mjs`)*

## Phase 2.6.5 deferrals — `CR-93` and `CR-95` (long half), recorded 2026-09-06; `CR-70`, `CR-94` (remainder) and the in-turn overflow continuation, recorded 2026-09-14; the errored-or-aborted turn residual, the pre-upgrade free-page bytes and the estimator's calibration, recorded 2026-09-18

**Phase closure — 2026-10-11:** W8 merged to `main` in PR #92 and Phase 2.6.5 is complete
with approved deferrals, 49/51 items closed. The
[merge checkpoint](phases/phase-2.6.5-core-reliability-remediation.md#w8-merge-checkpoint--2026-10-11)
joins all seven exit criteria. CR-70/93 and every scoped residual below retain their
existing severity, trigger and narrowed claim; none is marked implemented by phase closure.
CR-70's measurement/recovery prerequisite has merged, but its trigger also requires release
observation and a surface needing carrying. CR-93 remains due before the first multi-tenant
surface ships. CR-95's long continuation and the exact-capacity residual remain separate.

> Written to satisfy [exit criterion 2](phases/phase-2.6.5-core-reliability-remediation.md): a deferral carries
> its **severity**, its **trigger**, and — the part usually skipped — **the product claim it narrows**. The decisions are recorded in the phase register or, for the in-turn continuation, in ADR-0096 §5; only the WORK is deferred.
>
> **A third item, `CR-94`, was not deferred here, and is now decided (2026-09-13).** This note once said no
> maintainer call had been made. One has since been made, in
> [ADR-0097](../decisions/0097-a-budget-approval-is-an-allowance-not-an-exemption.md): the minimum correct allowance
> is built in `W7`, and only the lease's model binding and expiry are deferred. That deferral is recorded below,
> together with the other deferrals the `W7` ADRs made.

- [ ] **Carrying tool history into the model's context (`CR-70`).** *High (product).* **Decided and deferred on
      2026-09-13** by the maintainer, in
      [ADR-0095](../decisions/0095-what-an-agent-session-remembers-across-turns.md) §2. `W7` implements a session that persists the *structure* of its tool history (ADR-0095 §1). It carries no prior turn's tool rounds into the next request, so a coding agent re-reads a file it read the turn before.
      - **The claim it narrows.** [agent-session-spec.md](../reference/contracts/agent-session-spec.md) had implied
        that the transcript carries tool messages across turns. It now says they are not carried.
      - **Trigger.** [ADR-0096](../decisions/0096-a-request-is-measured-before-it-is-sent.md)'s measurement and
        recovery have shipped and been observed in a release, and a surface needs carrying. The coding-assistant
        surface is the named candidate.
      - **Constraints the future design inherits** (ADR-0095 §2): in-process only; never across a reseat; a pure
        request projection with a per-turn byte ceiling; no synthesized `read_media` message; engine notes behind
        ADR-0081's role boundary; ids unique per session; validity proven by the live conformance suite; a
        user-scoped `[preferences]` toggle.
      *(high · packages/core/src/engine/agent-session.ts, turn-messages.ts; `CR-70`, ADR-0095)*
      **Scheduled 2026-11-04 (D67):** v0.2.1, right after the CLI MVP's v0.2.0, designed together with ADR-0096 §5's
      in-turn overflow continuation ([current.md](current.md#next-work--the-cli-mvp)); the trigger above is unchanged.
      **What the schedule waits for (stated 2026-11-18, stale-entry sweep):** the trigger needs ADR-0096's measurement and recovery
      *observed in a published release*. The latest published release is `v0.1.1` (cut 2026-06-28; `v0.1.0` is older), which predates ADR-0096 (accepted
      2026-09-14), so no published release carries that recovery yet: the observation can start only after `v0.2.0` is published,
      and `v0.2.1` is the earliest release this item can ship in.
      **Investigation note 2026-11-15:** the maintainer retained that schedule.
      [ADR-0128](../decisions/0128-content-free-tool-receipts-ground-later-chat-turns.md)
      (Accepted 2026-11-15) adds only bounded content-free call/outcome receipts; it
      neither implements raw carrying nor closes this item, and this item's trigger and
      constraints are unchanged. Reuse the
      [ADR-0128 acceptance cases](../decisions/0128-content-free-tool-receipts-ground-later-chat-turns.md#acceptance-and-landing-obligations)
      when designing the separate full-content projection.

- [~] **Binding a budget allowance to its model, and giving it an expiry (`CR-94`, remainder).** *Medium.*
      [ADR-0097](../decisions/0097-a-budget-approval-is-an-allowance-not-an-exemption.md) builds the minimum
      correct allowance in `W7`: dispatch-owned, shown, and durable. The lease's two remaining properties are
      deferred.
      - **The claim it narrows.** An approved amount is quoted at one catalog price. **Restated 2026-09-18:** the
        amount is frozen and never recomputed, so if the model's price rises between the quote and the re-run, the
        approved step's first call can exceed it and the step **fails closed** — an approval that kills the step it
        was meant to authorise. That is the failure mode, stated plainly rather than as "is honoured even if the
        price changes".
      - **Trigger.** The first surface on which an approval can be exercised after the quoted model or its price has
        changed — for example an approval queue that outlives a catalog refresh. **`W7` builds the first such
        surface** (`relavium budget resume`, moved here from 2.6.K), and mitigates it rather than inheriting it: the
        command REFUSES a quote whose price no longer matches, telling the user to reject and re-run. Binding the
        allowance to the model it was quoted for, and expiring it, stay deferred behind that refusal.
      *(medium · packages/core/src/engine/budget-governor.ts; `CR-94`, ADR-0097 §3)*

- [x] **An errored or aborted turn persists nothing, including one whose tools already ran.** *Medium; closed 2026-11-18 (MVP-3c).* **NARROWED
      2026-11-16 by [ADR-0119](../decisions/0119-an-interrupted-turn-stays-as-a-content-free-marker.md) (MVP-3c, implemented;
      accepted and on `main` through PR #99, 2026-11-18): a turn the provider accepted that ends by the abort or a classified error is now persisted as the
      user's message, its structural pairs and one interruption row; what still persists nothing is listed in that ADR's
      implementation note and the session spec's *Not retained* list — read the paragraph below as the pre-ADR-0119
      record.** Recorded
      2026-09-18, because [ADR-0095](../decisions/0095-what-an-agent-session-remembers-across-turns.md)'s Negative
      section calls it "recorded as a residual" and no record existed. The engine rolls the user message back and
      the persister writes no row, so a turn that dispatched a tool and then failed leaves no transcript trace at
      all — only its effect row, which ADR-0098 discloses on the next resume.
      - **The claim it narrows.** [agent-session-spec.md](../reference/contracts/agent-session-spec.md)'s durable
        transcript is "completed exchanges only"; under `W7` it carries the STRUCTURE of every completed turn, and
        still nothing of a turn that failed or was aborted.
      - **Trigger.** The first surface that needs to show, or resume from, what a failed turn did — a coding
        assistant replaying a half-finished edit, or an audit view over a session's tool use.
      *(medium · apps/cli/src/chat/persister.ts, packages/core/src/engine/agent-session.ts; `CR-71`, ADR-0095)*
      **Pulled into the CLI MVP 2026-11-04 (D67) as "the CR-71 residual"** — CR-71 itself closed in `W7`: a failed, denied or aborted turn stays in context as a
      content-free interruption marker (ADR-0095 §1), behind an ADR-0095 amendment. **Moved 2026-11-16 out of MVP-4 into MVP-3c;** ADR-0119 Accepted, ADR-0095 amended.
      **Closed 2026-11-18:** MVP-3c is complete and merged to `main` with [PR #99](https://github.com/HodeTech/Relavium/pull/99); the
      [MVP-3 merge checkpoint](phases/phase-2.6-conversational-authoring.md#mvp-3-merge-checkpoint-2026-11-18) records its review, security and maintainer gates as closed.
      The cases ADR-0119 deliberately leaves unretained are the next entry.
- [~] **Interruption cases ADR-0119 does not retain.** *Medium as first recorded in the closed entry above; not re-rated.* Split out on 2026-11-18. The
      [spec's *Not retained* text](../reference/contracts/agent-session-spec.md#interrupted-turns--adr-0119) is canonical (session-ending cancellation, process death, an
      unclassified throw, a refusal before the message was accepted, a turn in which no provider engaged, and the other cases it lists); there today's rollback
      stays, and a tool that ran in such a turn is disclosed only by [ADR-0098](../decisions/0098-a-session-effect-row-holds-no-result-and-never-replays.md)'s effect row at the next resume.
      **Trigger.** The first surface that needs to show, or resume from, what a failed turn did in one of these cases — a coding assistant replaying a half-finished edit,
      or an audit view over a session's tool use. *(medium · apps/cli/src/chat/persister.ts, packages/core/src/engine/agent-session.ts; ADR-0119, ADR-0098)*

- [~] **Two at-rest residuals `secure_delete` does not cover: a blocked WAL checkpoint, and pages freed before the
      upgrade.** *Low.* Recorded 2026-09-18 with the `secure_delete` decision, and sharpened the same day after a
      maintainer probe on this tree found a planted token absent from `history.db` and present in `history.db-wal`.
      `W7` opens the connection with `PRAGMA secure_delete = ON` and checkpoints the WAL with `TRUNCATE` after the
      legacy clear and after each session-scope sweep, which is what makes the guarantee true — in WAL mode the
      zeroing write is a new frame while the old page image waits in the `-wal` file for a checkpoint.
      - **Residual 1: a checkpoint that cannot run.** A concurrent reader (another `relavium` process holding the
        database open) makes `wal_checkpoint(TRUNCATE)` return a busy result, and old bytes can remain in the
        main database and WAL until the next successful checkpoint. Logical clearing/deletion still commits;
        physical erasure is deferred, not claimed complete. Every later open and session sweep retries the
        checkpoint, including an empty sweep.
      - **Residual 2: pages freed before the upgrade.** `secure_delete` is not retroactive, and `chat-resume` has
        been sweeping committed session rows — which held `result_json` — since long before this change. Only a
        `VACUUM` reclaims those pages, which decision 15 did not take: it needs an exclusive lock other processes
        may contend for.
      - **The claim it narrows.** [ADR-0098](../decisions/0098-a-session-effect-row-holds-no-result-and-never-replays.md)'s
        "no tool result at rest" and [ADR-0050](../decisions/0050-cli-history-db-at-rest-posture.md)'s scoped note
        hold **after a successful checkpoint**, for bytes freed from the upgrade onward — not for a database's
        whole history, and not while a checkpoint is blocked.
      - **Trigger.** A threat model where the file itself is the adversary's prize — a shared or backed-up
        `history.db`, or a move off the single-user local posture ADR-0050 assumes.
      *(low · packages/db/src/client.ts, apps/cli/src/db/open.ts, apps/cli/src/engine/effect-retention.ts;
      ADR-0098, ADR-0050)*

- [~] **The token estimate is not calibrated against real usage.** *Low.* Decided 2026-09-18: `W7` ships the
      heuristic alone. [ADR-0096](../decisions/0096-a-request-is-measured-before-it-is-sent.md) §2 invariant 4
      binds any calibration that is added later — same-shape requests only, gross input including cached tokens,
      reset on a model or provider change — and nothing is built now.
      - **The claim it narrows.** None that ships: ADR-0096 §1 already states that the estimate is a heuristic and
        does not bound the real token count. What it costs is precision — a cache-heavy or tool-heavy session can
        compact slightly earlier or later than a calibrated estimate would.
      - **Trigger.** Measured evidence that the heuristic's error is causing needless compaction or missed
        overflows, which the classified `context_overflow` kind makes observable for the first time.
      *(low · packages/llm/src/adapters/shared.ts, packages/core/src/engine/agent-session.ts; ADR-0096 §2)*

- [~] **Recovering a context overflow that arrives after a tool round (the in-turn continuation).** *High.*
      [ADR-0096](../decisions/0096-a-request-is-measured-before-it-is-sent.md) §5 recovers an overflow only before
      any tool round runs, because re-running the turn would fire its tools again. An overflow at round one or later
      fails the turn, and says that tools had already run.
      - **The claim it narrows.** Overflow recovery covers only a turn that has not yet dispatched a tool.
      - **Trigger.** The first user whose tool-heavy turn dies at round one or later.
      - **Shape.** Compact the prior history, keep this turn's tool pairs, and re-issue only the failed round's call.
        That is the same durable-continuation family as `CR-95`'s long half, and it should be designed with it.
      *(high · packages/core/src/engine/agent-session.ts, agent-turn.ts; ADR-0096 §5)*

- [~] **Process-global catalog and parameter-learning state is not tenant-safe (`CR-93`).** *Medium today,
      High for cloud.* The model catalog and the learned-parameter state live in process-global mutable
      structures. For one local user that is correct and cheap. For a multi-tenant process it means one
      tenant's learning steers another tenant's requests, and one tenant's catalog refresh is visible to all.
      **The claim it narrows:** nothing in a shipped Phase-1/2.6 document — the surfaces that exist today are
      single-user by construction ([ADR-0008](../decisions/0008-local-first-phase-1-cloud-phase-2.md), and
      [ADR-0050](../decisions/0050-cli-history-db-at-rest-posture.md) for the CLI's single-user at-rest posture), so no current
      guarantee is wider than the code. What it narrows is a FUTURE claim: the cloud and managed execution
      modes ([ADR-0012](../decisions/0012-managed-inference-dual-mode.md)–[ADR-0015](../decisions/0015-managed-mode-data-handling-and-compliance.md))
      cannot be described as tenant-isolated while this stands. **Trigger:** the first multi-tenant surface —
      `apps/api`, or any managed-mode gateway that serves more than one account from one process. It must be
      scoped per run/session/tenant BEFORE that ships, not after.
      *(medium · packages/llm/src/catalog/, packages/llm/src/model-catalog.ts; `CR-93`)*

- [~] **A mid-tool-loop budget pause replays the whole loop (`CR-95`, long half).** *High.* The
      **short-term half is closed and shipped** ([ADR-0080](../decisions/0080-durable-effect-journal-and-the-tiered-effect-contract.md)
      §10, 2026-08-18): `agent-turn.ts`'s `turnCommitted = toolTurn > 0` guard refuses a `BudgetPauseError`
      once the turn has dispatched tools, so the replay cannot happen. What is deferred is making the pause
      WORK: checkpointing the continuation — provider messages, tool call/result pairs, round index — so an
      approved mid-loop pause resumes from where it stopped instead of re-running paid provider calls and
      re-performing tool mutations. **The claim it narrows:** `pause_for_approval` in
      [workflow-yaml-spec.md](../reference/contracts/workflow-yaml-spec.md) reads as a general "suspend and
      continue" for any node; for a tool-using agent turn it is a **refusal**, not a suspension, and the
      refusal is disruptive by design. **Trigger:** any surface that pauses a tool-using turn on budget and
      expects it to continue — a desktop approval prompt mid-turn, or a cloud run that pauses for a quota
      top-up. Until then the fail-closed refusal is the honest answer.
      *(high · packages/core/src/engine/agent-turn.ts; `CR-95`, ADR-0080 §10)*

## Phase 2.6.5 `W3` residuals (PR #86, merged 2026-08-30)

The PR #86 review returned 18 findings; an independent verification round reproduced or refuted each. Seven
were fixed before the merge. **These ten went in open**; the first was a blocker and is now closed by W8/PR #92. The original findings are recorded here with the
severity, the trigger and the product claim each narrows, per exit criterion 2.

- [x] **An un-pulled stream DROPS the terminal event ([ADR-0036](../decisions/0036-run-loop-substrate-event-bus-and-execution-host.md)).** *CLOSED on `main` in PR #92, 2026-10-11.*
  *Former blocker; the following defect describes the pre-W8 tree.* A `BoundedEventStream` at capacity 2 given three pushes and a `close()`
  delivers a clean EOF and never the terminal, with no `sequenceNumber` gap to signal it. **The claim it
  narrows:** ADR-0036 promises a gap-free, no-drop canonical stream, and `run-handle.ts` repeats it — neither
  held for an un-pulled stream at that checkpoint. **Trigger:** any consumer that attaches after `capacity` events,
  which on the session path is every consumer. The fix is
  [ADR-0087](../decisions/0087-consumed-streams-size-bounds-and-run-retention.md) §1 — a handle declares
  whether its stream is consumed. That ADR was Accepted on 2026-09-04 before §1 was implemented.
  **Current checkpoint — 2026-10-10:** [W8 Step 1](phases/phase-2.6.5-core-reliability-remediation.md#w8-step-1-consumption-modes--2026-10-10)
  implements the immutable mode through both standalone session handles and workflow
  start/checkpoint resume. Iterated streams retain every publication before first pull;
  subscribe-only streams retain no primary buffer and refuse iteration with a typed error.
  CLI builders select their actual consumption mode. Three NEW cumulative review rounds
  verify runtime and living-document corrections, with the final round clean in both
  dimensions. The linked register records exact heads, causal controls and scoped acceptance.
  **Merged to `main` — 2026-10-11:** PR #92 completes publication; the
  [merge checkpoint](phases/phase-2.6.5-core-reliability-remediation.md#w8-merge-checkpoint--2026-10-11)
  joins final checks and maintainer acceptance. The separate exact-capacity residual below is unchanged.
  *(packages/core/src/engine/event-stream.ts, run-handle.ts, session-handle.ts)*

- [x] **Media is measured as a handle but RETAINED as base64.** *Medium — CLOSED 2026-09-04, fixed in `W5`.*
  `state.output`, the completed state and every downstream template held the raw bytes while the durable event
  held the handle. **The claim it narrowed:**
  [ADR-0042](../decisions/0042-engine-media-storage-substrate-mediastore-deinline-retention.md)'s "the engine
  references media by handle", and CR-32's own memory bound — a 1 MiB image passed a 256 KiB node-output limit
  and was then held in full. **Closed by `CR-54`**, not by a `W3` follow-up: `#pinMediaOutput` runs at the
  dispatch boundary, `#settleCompleted` writes the pinned value into `#states`, the async media-job path
  re-enters through the same pin, and `deInlineMedia` rewrites a `base64` source into a handle exactly as it
  does a `url` — so ADR-0087 §3 is implemented. It stayed open here for two waves because it was fixed under a
  different item number, and a stale comment in `size-bounds.ts` ("`state.output` keeps the raw form") kept
  saying otherwise; a 2026-09-04 review read that comment and concluded §3 was unimplemented, which is the cost
  of a comment outliving its code. *(packages/core/src/engine/engine.ts, size-bounds.ts)*

- [~] **`whenDrained()` does not atomically reserve the slot it grants.** *Medium.* Several producers each get
  a resolved promise for the same free slot; measured peak `capacity + N − 1` (11 against a ceiling of 4 with
  8 producers). **The claim it narrows:** "a hard per-consumer ceiling". **Trigger:** concurrent producers,
  i.e. any `max_parallel` above 1. **Do not apply the obvious fix:** a permit with a consume/release lifecycle
  was prototyped and measured to REINTRODUCE the freeze — `agent-turn.ts` awaits readiness before `foldChunk`,
  and `tool_call_*`, `reasoning_start/end`, `stop`, `media_*` and `tool_result` emit nothing, so every such
  chunk leaks a permit. The correct shape moves the await to the emit site, which revises CR-30's producer-await
  and therefore wants an ADR. **ADR-0087 is Accepted with this explicitly OUT of scope** (its Correction 2), so
  its §1 "bounded per consumer" must not be read as a guarantee that holds today. **Corrected 2026-10-10:**
  neither the un-parked fast path nor `#wakeDrainWaiters` reserves outstanding grants. At capacity 2,
  six parked producers and two immediate pulls before their continuations can wake three producers
  and reach depth 3. This is a second schedule of the same residual, not a new deferral; the dated
  [ADR correction](../decisions/0087-consumed-streams-size-bounds-and-run-retention.md#w8-preflight-correction--2026-10-10)
  preserves the original claim and its correction. *(packages/core/src/engine/event-stream.ts)*

- [~] **Dispatch headroom is computed but not reserved.** *Medium.* Retry timers can dispatch from the same
  headroom during a batch's durable `node:started` awaits, so a pre-selected batch still starts.
  **The claim it narrows:** ADR-0086 §4's 500-dispatch cap as an exact bound. **Trigger:** a retrying node
  concurrent with a wide ready batch near the cap. *(packages/core/src/engine/engine.ts)*

- [~] **A redundant `conditionId:handle` edge counts toward fan-out.** *Medium.* The handle is stripped and the
  edge counted as ordinary width, so the same semantic workflow is admitted written one documented way and
  refused written the other. **The claim it narrows:** the spec's statement that a condition's branches are
  alternatives and do not count toward width. **Trigger:** an author who writes the redundant explicit edge
  form the spec documents. *(packages/core/src/limits.ts)*

- [~] **A human-gate payload skips the CR-32 bounds.** *Medium.* `measureNodeOutput` is called and its breach
  discarded, and no aggregate state check runs there. **The claim it narrows:** the 256 KiB per-node and 4 MiB
  accumulated-state contracts. **Trigger:** a gate whose decision carries a payload — the one node output a
  user supplies directly. **Narrowed 2026-09-04:** the discard is deliberate and now documented (ADR-0087
  Correction 5 + the canonical spec) — the gate is already resolved and its vertex already marked completed, so
  refusing there would strand a resumed run with no terminal. What remains open is the residual that leaves: the
  run-level total catches an abusive payload only *at the next node that adds to it*, so a gate that is the
  run's LAST node is never checked at all. *(packages/core/src/engine/engine.ts)*

- [~] **`JSON.stringify` is used as a size measure and validates nothing.** *Medium.* Nested functions and
  symbols vanish, `Map`/`Set` become `{}`, array holes become `null`, and a custom `toJSON` changes the value —
  so a live run and a resumed one can see different data. **The claim it narrows:** that checkpoint/resume
  replays the same state. **Trigger:** any node output holding a non-JSON value.
  *(packages/core/src/engine/size-bounds.ts)*

- [ ] **The durable-event bound has no engine-level test.** *Medium.* `measureDraft` is unit-tested; nothing
  proves an oversized non-terminal event is refused on the real `#emitDurable` path. **The claim it narrows:**
  the phase's own acceptance rule that a test fails when its production change is reverted.
  *(packages/core/src/engine/engine.test.ts)*

- [~] **A terminal event has no size bound in either direction.** *Low.* `measureDraft` returns before it
  measures, so the "measured and never refused" wording in ADR-0087 §2, `size-bounds.ts` and the workflow spec
  described an intention no code held; all three now say **exempt** (ADR-0087 Correction 4). The decision not to
  refuse a terminal is correct and unchanged — what is open is that its `outputs`, `partialOutputs` and
  `error.message` have no transitive cap of their own, so the ADR's "events are bounded by size" is narrower
  than its title. **The claim it narrows:** that title. **Trigger:** a run whose final outputs are large.
  Adding a cap would be a NEW bound and wants its own decision. *(packages/core/src/engine/size-bounds.ts)*

- [~] **`retainedSettledRuns` lives in `ADMISSION_CEILINGS`, which is the wrong home.** *Low.* Nothing about it
  is checked at admission — it is a runtime retention limit (ADR-0087 §4), grouped with ceilings that refuse a
  file before it runs. **The claim it narrows:** none directly; it misfiles a constant and quietly enrols it in
  ADR-0086 §9.3's (also unimplemented) host-override promise. **Trigger:** a reader or a host looking for it.
  Not moved here because removing a member from an exported const is a public-API change.
  *(packages/core/src/limits.ts)*

- [~] **ADR-0086 §9.3's host override does not exist.** *Medium.* The ADR promises ceilings "resolve from named
  constants that a host may override" so an operator "does not fork the engine". There is no such seam.
  **The claim it narrows:** the migration story ADR-0086 offers for a previously-valid workflow. **Trigger:** a
  legitimate outlier above any ceiling. Either build the seam or supersede that clause. *(packages/core/src/limits.ts)*

- [ ] **Two reference-doc nits.** *Low.* `agent-yaml-spec.md`'s field table lists `tools` twice; `run-plan.md`'s
  ceiling bullet omits condition targets and data-reference edges from its list of authored edge sources.
  *(docs/reference/)*

**One finding was REFUTED and is recorded so it is not re-raised**: "resume seed accepts oversized or invalid
outputs". `CheckpointState` is derived by replaying the durable log, never stored, so a checkpoint carrying
state the current bounds would refuse cannot exist in the shape the finding describes.

## The default chat agent cannot rename, move, copy or delete a file (found 2026-11-15)

- [~] **Parked — a narrative entry that waits for MVP-4 to be used ("Decision needed" and "Trigger to revisit" below; marker added 2026-11-18).**

> **Found in use:** after attaching a file, the user asked the agent to rename it. The agent has no rename tool, so
> it says so, offers to create a new file under the new name with the same content, and states that it cannot delete
> the original. That is the grant working as designed and the model describing it truthfully; the gap is the
> capability, not the wording.

**What is true today.** The built-in agent holds seven tools ([ADR-0116](../decisions/0116-the-built-in-chat-agent-can-edit-and-the-starting-mode-is-configurable.md)):
`read_file`, `list_directory`, `git_status`, `search_files`, `find_files`, `write_file`, `edit_file`. None can rename,
move, copy or delete, and no accepted or proposed ADR adds such a tool. The nearest thing the model can do is read the
old file and `write_file` the same bytes elsewhere, which is a copy, not a rename; it cannot remove the original.
Observed 2026-11-15: the model already discloses exactly that, so no prompt change was made. (A first reading
assumed it presented the copy as a rename; the user's transcript showed otherwise, and a prompt sentence added on
that assumption was reverted before it was committed.)

**What is planned, and what is not.**

- **Planned, as a command, not a tool.** MVP-4 ([ADR-0118](../decisions/0118-a-command-outside-the-allowlist-asks-instead-of-failing.md),
  D63) gives the default agent `run_command` behind a typed argv/cwd approval card, so `mv a b` and `rm a` become
  possible there as ordinary approved commands (`shell: false`, executable plus argv, no globbing). Until then the
  only route is the user's own `!mv a b`, which is disabled unless `[chat].allowed_commands` names that exact string.
- **Not planned: a dedicated `move_file` / `delete_file` tool.** It would be a new filesystem write path (jail and
  protected-path checks on both ends, symlink and cross-device cases, native metadata preservation per
  [ADR-0125](../decisions/0125-file-writes-preserve-security-metadata-through-a-native-host-adapter.md), an approval
  preview that shows source and destination, and an effect-journal identity), so it needs its own ADR, a rigor pass
  and a separate security sitting under the D64 bar.

**Decision needed from the maintainer, after MVP-4 has been used:** whether a command card for `mv`/`rm` is good
enough (the card shows the argv but not the files' content or metadata, and a command is not `fsWrite`-governed), or
whether rename/move earns a typed tool. **Trigger to revisit:** MVP-4 observed in use, or a second report of a
rename/move/delete request. **MVP-4 acceptance should include** a rename through the approved command path and a
refusal when the command is declined. *(medium · apps/cli/src/chat/default-agent.ts; ADR-0116, ADR-0118)*
