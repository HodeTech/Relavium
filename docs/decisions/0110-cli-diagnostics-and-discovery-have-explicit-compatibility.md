# ADR-0110: CLI diagnostics and discovery have explicit compatibility

- **Status**: Proposed
- **Date**: 2026-10-15
- **Supersedes (partial)**: [ADR-0049](0049-cli-machine-output-contract.md) §6, for explicit help with JSON
- **Related**: [ADR-0047](0047-cli-framework-commander-ink-clack.md), [ADR-0056](0056-cli-in-app-slash-command-system-and-manifest.md), [ADR-0088](0088-the-mcp-boundary-is-hostile.md), [ADR-0103](0103-a-paused-run-hands-off-its-local-producers-before-its-host-closes.md), [ADR-0111](0111-cli-meta-operations-use-a-lazy-packaged-runtime.md), [Wave 3](../roadmap/current.md#wave-3--clear-the-ground)

## Context

Wave 3 D19/D20/D22, #13/#17/#18/#19/#40/#41/#42/#45/#224/#264/#265/#268/#269/
#309/#310 and G35 require explicit CLI compatibility. Accepted ADR-0056 already
promises machine-readable help; ADR-0049 §6 prescribes human help under JSON.
This proposal realizes the former and partially replaces the latter.

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

Reserve exit 9 for unexpected CLI infrastructure failures on every surface,
independently of the existing broad `internal` code. Known history, departure,
ownership, receipt and operational refusals retain their exit/remedy. The canonical
surface table explicitly covers Home, chat, one-shot agents, workflow/resume and
management/meta commands. Genuine run/turn outcomes and deliberate session end
remain distinct; an unknown CLI failure cannot become Home success or chat end.

Create one lightweight invocation-owned shutdown registry in the CLI process layer,
with no engine/native/UI service imports. Owners register stop, join, final-health
and owned-native-reap callbacks before admitting work; unregister only after actual
settlement. Normal, fatal and output-failure paths share those registrations.
ADR-0111's chunks retain one instance. Ambient PID scanning is not ownership proof.

Install early diagnostic flag extraction and the registry before dynamic runtime
imports. Recoverable background rejection keeps the process alive, reports safely,
and upgrades only an otherwise clean success; existing nonzero outcomes remain.
Fatal exception/top-level rejection stops admission and exits without resuming
business logic. Best-effort cooperative joining has a three-second **fatal process
termination** budget; afterward only explicitly owned native resources may be
synchronously reaped. This is not an ADR-0103 receipt deadline, acknowledgement or
safe-close permission. An exit callback cannot await; re-entry and broken sinks
are guarded. Normal/recoverable cleanup still joins actual owners.

Known final money/effect/durability/ownership health takes precedence on **return
and throw** paths. Unavailable health remains uncertain, with inspection before
retry; no terminal or acknowledgement is fabricated. Native teardown uses owned
POSIX groups and the trusted absolute Windows taskkill facility with fixed
owned-root tree arguments, never PATH lookup or foreign PID scanning. The
canonical contract limits this to live registered roots/current descendants;
root-exit, escape/reparenting and same-user PID reuse are not race-free contained.
A request is not close ACK. Full job-object/native containment is not claimed or
silently deferred as a completed Wave 3 guarantee; existing M/N ownership remains.

EPIPE is a classified output-unavailable operational failure, not an unclassified
exception. Stop/join producers, preserve stronger safety exits and use at most one
fixed diagnostic on an independent usable sink. A failed sink cannot acknowledge
itself. No automatic repetition of paid/effectful work follows an output or fatal
failure; the canonical exit-9 remedy explicitly says this.

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

At **acceptance**, append ADR-0049/0056 forward notes and ADR-0088/0103 refinements
before dependent code. Reconcile D19's old precedence ladder, D22's two-exception
shorthand, E's “Required ADR: none new” and phase exit criterion 4's blanket
machine-contract prohibition to this enumerated scope. Accepted historical bodies
stay intact. Proposed reference sections are explicitly unshipped.

Considered verbose winning over quiet: rejected to preserve conflict refusal.
Considered remapping every internal error: rejected because known refusals use it.
Considered sanitized raw stacks: rejected because pattern matching cannot prove
confidentiality. Considered coalescing invented token rows: rejected as a false
premise. Considered every rejection fatal: rejected because the persister
backstop's accepted keepalive policy is distinct from process exceptions.

### Acceptance and landing

1. Inventory production output owners against the canonical category matrix.
   Flags × environment × output-mode tests exercise those owners. Preserve data
   and warnings; arbitrary canaries in messages/causes/stack headers never render.
2. Native children test early import failure, background rejection, fatal/repeated
   fault, both broken sinks, owned children/grandchildren and Windows teardown.
   Joined health wins on return and throw; timeout never certifies safe store close.
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

- Scripts distinguish unexpected CLI faults from outcomes across surfaces.
- Discovery describes real grammar; diagnostics preserve data, consent and safety.

### Negative

- JSON help, consent, debug predicate and failure classification deliberately alter
  public behaviour. Explicit compatibility tables and aliases bound the change.
- Fatal cleanup cannot promise crash-safe receipts or universal descendant containment. Inspect before repeating paid
  or effectful work; a failed cleanup must not be reported acknowledged.
