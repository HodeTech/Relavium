# ADR-0110: CLI diagnostics and discovery have explicit compatibility

- **Status**: Accepted
- **Date**: 2026-10-15
- **Related**: [ADR-0049](0049-cli-machine-output-contract.md) (§5 infrastructure/pre-run exceptions and §6 explicit JSON-help partially replaced), [ADR-0047](0047-cli-framework-commander-ink-clack.md), [ADR-0056](0056-cli-in-app-slash-command-system-and-manifest.md), [ADR-0088](0088-the-mcp-boundary-is-hostile.md), [ADR-0103](0103-a-paused-run-hands-off-its-local-producers-before-its-host-closes.md), [ADR-0111](0111-cli-meta-operations-use-a-lazy-packaged-runtime.md), [Wave 3](../roadmap/current.md#wave-3--clear-the-ground)

## Context

Wave 3 D19/D20/D22, #13/#17/#18/#19/#40/#41/#42/#45/#224/#264/#265/#268/#269/
#309/#310 and G35 require explicit CLI compatibility. Accepted ADR-0056 already
promises machine-readable help; ADR-0049 §6 prescribes human help under JSON.
This proposal realizes the former and partially replaces ADR-0049 §6 for explicit
JSON help, and §5 for classified storage/infrastructure exceptions. Actual run
terminal outcomes and the pure stdout event stream retain their contracts.

At baseline `702cdc9c`, verbosity has no effective general consumer and debug
predicates differ. Unexpected CLI failures share exit 1 with known operational
failures. Crucially, `CliErrorCode.internal` also names typed history refusals and
unacknowledged departures: remapping it wholesale would change accepted semantics.
Commander echoes unknown input although the later dispatcher does not. The
recoverable background-rejection net already exists.

G15's token-firehose premise is refuted: token/reasoning events use only the live
bus, shipping persistence excludes them, and `logs` reads durable history.
Preserve replay and add an actual-engine/store regression. Invented persisted
token fixtures cannot demonstrate a shipping coalescing defect.

The strict, alias-free model command manifest lacks CLI flag spellings,
positionals, repeats, globals and group paths. Discovery needs an enriched
descriptor authority and separate compatible projections, not that inadequate DTO.

These choices remain Proposed. Exact shapes, categories and exits belong in
[CLI commands](../reference/cli/commands.md#proposed-wave-3-cli-compatibility).
No engine ErrorCode or runtime dependency is added.

## Decision

### Diagnostics and ownership

Keep quiet and verbose mutually exclusive; explicit flags override the exact
debug alias defined in the canonical proposal. Narrowing the old defined-variable
debug predicate is deliberate. Quiet preserves requested data and safety output.
Verbose adds bounded diagnostic metadata and validated stack-frame locations from a closed build-owned relative-file allowlist,
never arbitrary error messages, cause trees or raw stack headers. Pattern
redaction is defence in depth, not proof that arbitrary text is secret-free.
JSON diagnostics, including #269's last resort, remain structured stderr records.

Reserve exit 9 for CLI infrastructure failure on every surface: unexpected faults
use the distinct CLI diagnostic `cli_internal`; classified failed-output/EPIPE
uses `output_unavailable`. Output failure deliberately moves from the earlier
proposal's exit 1 to 9: it does not mean the workflow failed, even if its result
could not be delivered. Known history/departure and operational failures retain
their stated disposition; do not remap the existing broad `internal` code.
Classify actual storage-boundary failures before native integration, rather than
waiting for the final DB refactor. The canonical surface/site table owns details.
An ordinary failed chat turn leaves the REPL alive; one-shot agent outcomes are
0/1. Unknown catches inside slash/rebuild/one-shot paths cannot silently turn an
infrastructure fault into a successful Home/REPL end.

Create one lightweight invocation-owned shutdown registry in the CLI process layer,
with no engine/native/UI service imports. Owners register kind-specific stop/join,
terminal-restore and native-reap callbacks before admitting work; only workflow
owners expose existing RunHandle health. AgentSession has no run-departure or 5–8
channel: join its existing host lifetime, retain publication failure and give
inspect-before-repeat advice without inventing a health DTO or acknowledgement.
Unregister only after actual settlement. Normal, fatal and output-failure paths
share those registrations. ADR-0111's chunks retain one instance. Ambient PID
scanning is not ownership proof.

Install early diagnostic flag extraction and the registry before dynamic runtime
imports. Recoverable background rejection keeps the process alive, reports safely,
and upgrades only an otherwise clean success; existing nonzero outcomes remain.
Fatal exception/top-level rejection stops admission and exits without resuming
business logic. One absolute three-second **fatal process termination** budget
includes stop/join, native reap, terminal restoration and diagnostic flush; no
owner/helper receives a fresh budget or starts unbounded work after expiry. This
is not an ADR-0103 receipt deadline, acknowledgement or safe-close permission.
Restore raw/alternate-screen/render custody before final stderr diagnosis so it
is not erased. Diagnostic text never falls back to stdout. An exit callback cannot
await; re-entry and broken sinks are guarded. Normal/recoverable cleanup still
joins actual owners. The first termination request owns cleanup; later observed
faults can upgrade disposition, never restart cleanup or extend its deadline.

Actual workflow health takes precedence on **return and throw** paths, followed
by fatal/output infrastructure failure, actual terminating signal, then ordinary
outcome; the canonical contract defines the total order and distinct recoverable
background-rejection rule. Unavailable/session health remains uncertain, with
inspection before retry; no terminal or acknowledgement is fabricated. Native
teardown follows creation ownership: run_command owns a POSIX process group,
SDK-backed MCP owns a PID, not a detached group. Windows uses the verified absolute
taskkill facility for a still-owned live root. Never infer PGID from an MCP PID,
search PATH or scan foreign processes. Root-exit, escape/reparenting and same-user
PID/PGID reuse are not race-free contained. A request is not close ACK. Full native
containment is not claimed; existing M/N lifecycle ownership remains.

EPIPE is a classified infrastructure output failure, not an unknown exception.
Stop/join producers, preserve actual stronger workflow safety exits and use at
most one fixed stderr diagnostic if that sink is usable. A failed sink cannot
acknowledge itself. The exit-9 remedy covers both output and unexpected failures:
no automatic repetition of paid/effectful work; inspect existing work first.

### Discovery and compatibility

One framework-free descriptor registry owns stable executor IDs, canonical token
paths, explicit aliases, argument bindings and globals. Derive Commander, help and
the existing model manifest from it. Keep the legacy strict model-manifest shape;
new JSON help describes the actual grammar in a separate versioned projection.
Groups need no executor. Explicitly register nested chat paths and flat aliases;
Commander aliases alone cannot span them. Two-way grammar drift tests are required.

Explicit help plus JSON realizes ADR-0056 and replaces only ADR-0049's corresponding
exception. Root/subtree projection starts no services. Version plus JSON and bare
JSON remain human meta-operations. Invalid grammar refuses. JSON-help integration
follows the descriptor and lazy-graph increments, not an earlier unimplemented step.

Make noun-verb chat paths and unambiguous pricing flags canonical, retaining old
aliases and one structured stderr deprecation notice in JSON mode. Conflicting
pricing spellings refuse even if equal. #18/#310's remaining command-scoped input
meanings are intentionally preserved/documented: workflow inputs, reserved agent
input and gate payload are not collateral renames. Unknown command/option errors
use static hints without arbitrary tokens or Commander suggestions; this is a
parser-path correction, not merely preservation of dispatcher behaviour.

Key deletion requires interactive consent or explicit automation force. Canonical
eligibility/decline/interruption rules and every existing deletion example must
agree. G15 closes as a refuted current defect with preservation evidence.

At **acceptance**, record ADR-0049's clause-specific partial replacement in its
Status/index and dated forward note: §5 pre-run/infrastructure exceptions and §6
explicit JSON help. Append ADR-0056's realization note and
ADR-0088/0103 refinements before dependent code. Reconcile D19's old precedence
ladder, D22's two-exception shorthand, E's “Required ADR: none new” and phase exit
criterion 4's blanket machine-contract prohibition to this enumerated scope.
Accepted historical bodies stay intact. Use the existing Status/Date/Related
metadata convention. Proposed reference sections stay unshipped until their
implementing increment lands; the plan owns promotion/removal and overlapping
current-text reconciliation.

Considered verbose winning over quiet: rejected to preserve conflict refusal.
Considered remapping every internal error: rejected because known refusals use it.
Considered sanitized raw stacks: rejected because pattern matching cannot prove
confidentiality. Considered coalescing invented token rows: rejected as a false
premise. Considered every rejection fatal: rejected because the persister
backstop's keepalive policy is distinct. Considered output failure remaining
exit 1: rejected because it confuses output delivery with workflow outcome.
Considered uniform process-group/session-health abstractions: rejected because
shipping owners do not supply them. Windows facility admission protects finite
best-effort cleanup; reconsider its availability cost when platform/owner support
changes, rather than claiming universal containment.

### Acceptance and landing

1. Inventory production output owners against the canonical category matrix.
   Flags × environment × output-mode tests exercise those owners. Preserve data
   and warnings; arbitrary canaries in messages/causes/stack headers never render.
2. Native children test early import failure, background rejection, fatal/repeated
   fault, both broken sinks, owned children/grandchildren and Windows teardown.
   Actual workflow health wins on return and throw; session joins never fabricate
   it. Include competing signal/faults, caught command failures and terminal-restore
   ordering; timeout never certifies safe store close.
3. Test every surface's exit classification, typed history/departure refusals and
   existing 0–8/signal outcomes. Distinguish Node's pre-bootstrap exits.
4. Commander-to-dispatch and packed tests cover root/subtree discovery, globals,
   repeated/positional args, aliases, conflicts, non-echoing refusal and deletion
   consent with zero unintended key/service effects.
5. Actual engine/store/log tests pin the G15 disposition and unchanged JSON replay;
   label preservation controls honestly. Actual corrections each need a causal
   regression and two new independent complete cumulative clean reviews. Land
   canonical references and the Wave 3 register.

## Consequences

### Positive

- Scripts distinguish unexpected/output infrastructure faults from outcomes
  across surfaces; known operational failures retain their explicit table.
- Discovery describes real grammar; diagnostics preserve data, consent and safety.

### Negative

- JSON help, consent, debug predicate and failure classification deliberately alter
  public behaviour. Explicit compatibility tables and aliases bound the change.
- Fatal cleanup cannot promise crash-safe receipts or universal descendant containment. Inspect before repeating paid
  or effectful work; a failed cleanup must not be reported acknowledged.
- Windows subprocess admission refuses if its verified teardown facility is
  unavailable; POSIX MCP cleanup cannot promise reaping its descendants.

## Maintainer acceptance — 2026-10-16

The maintainer approved this final decision, its linked unshipped canonical
contracts and the nineteen-increment Wave 3 plan. Earlier proposal wording above
records the review stage; approval is complete. Implementation, independent
review gates and canonical promotion remain staged in that plan. Acceptance
does not claim shipping behaviour, an actual release or production custody setup.

## Step 8a partial implementation — 2026-10-16

The approved storage-origin subset and fixed runtime classification are implemented
on `development`; independent acceptance is still pending. The
[CLI contract](../reference/cli/commands.md#step-8a-origin-adapters) owns concrete
dispositions and the [Node database contract](../reference/shared-core/database-schema.md#node-client-failure-provenance)
owns the read-only private-identity fact. The native coordinator remains inert
until Step 8d connects every actual creation owner and caught/forced-exit path.
This does not claim whole Step 8, production fatal integration or later discovery
work complete. The [implementation checkpoint](../roadmap/phases/phase-2.5.5-hardening-and-remediation.md#wave-3-step-8a-implementation-checkpoint--2026-10-16)
attributes local author, selected causal and installed-host evidence separately.

## Step 8a independent acceptance — 2026-10-16

The [Step 8a register](../roadmap/phases/phase-2.5.5-hardening-and-remediation.md#wave-3-step-8a-acceptance--2026-10-16)
accepts the origin adapters and inert native foundation at `e0a5ae19` after two
NEW complete cumulative clean rounds and a separate clean security sitting.
Actual same-tarball platform controls and broader CI retain their exact source
and completion status. Product activation, remaining owners and whole Step 8
stay staged in 8b–8d; later review remains cumulative over the entire Step 8 range.

## Step 8b partial implementation — 2026-10-16

The creation-owned native integration is implemented on `development`, with
author and independent acceptance gates still open. The
[native teardown contract](../reference/cli/commands.md#native-crash-teardown-scope)
owns platform distinctions, actual target/helper closure and finite exit
cleanup; the [MCP contract](../reference/shared-core/mcp-integration.md#creation-owned-native-stdio-lifetime)
owns the SDK-free attachment and native-versus-full-work close distinction.
The [implementation checkpoint](../roadmap/phases/phase-2.5.5-hardening-and-remediation.md#wave-3-step-8b-implementation-checkpoint--2026-10-16)
keeps author, installed-host, causal and review evidence separately attributed.
Production fatal activation, workflow/session health integration and whole Step 8
remain staged in 8c–8d. This note grants no acceptance or safe-store-close ACK.
