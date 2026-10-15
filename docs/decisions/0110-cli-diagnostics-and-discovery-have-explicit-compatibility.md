# ADR-0110: CLI diagnostics and discovery have explicit compatibility

- **Status**: Proposed
- **Date**: 2026-10-15
- **Related**: [ADR-0047](0047-cli-framework-commander-ink-clack.md), [ADR-0049](0049-cli-machine-output-contract.md), [ADR-0056](0056-cli-in-app-slash-command-system-and-manifest.md), [ADR-0088](0088-the-mcp-boundary-is-hostile.md), [ADR-0103](0103-a-paused-run-hands-off-its-local-producers-before-its-host-closes.md), [Wave 3](../roadmap/current.md#wave-3--clear-the-ground)

## Context

Wave 3 contains maintainer decisions D19/D20/D22 and findings #13/#18/#19/#45,
#264/#265/#268/#309/#310 and G15/G35. They change public CLI behaviour and need
one compatibility decision before implementation. ADR-0049 says help remains
human-readable under `--json`; ADR-0056 describes a machine-readable command
manifest. Both cannot govern the same explicit help invocation.

At the preflight baseline `702cdc9c`, quiet is largely ineffective, debug and
verbose use different predicates, internal CLI faults share exit 1 with failed
workflows, and human log replay prints individual token events. The existing
background-rejection net already reports and keeps the process alive; its absence
must not be claimed as a new defect. Uncaught exceptions need a different policy.

This proposal requires maintainer approval. It introduces no engine ErrorCode,
provider seam field, runtime dependency or new tool. Exact option/output shapes
belong in [CLI commands](../reference/cli/commands.md), with the interactive
behaviour in [chat-session.md](../reference/cli/chat-session.md).

## Decision

We will preserve machine data and existing lifecycle outcomes while making
diagnostics, discovery and the enumerated remediation aliases explicit.

### Diagnostic policy and failure ownership

Keep `--quiet` and `--verbose` mutually exclusive: specifying both remains an
invalid invocation. Either explicit flag overrides `RELAVIUM_DEBUG=1`; only the
exact environment value `1` is a verbose alias. Default verbosity is normal.
`--json` controls representation independently of verbosity.

Quiet suppresses decoration, banners, progress churn and optional informational
notices. It preserves requested command results, assistant answers, final outcomes
and cost/usage qualifications, approvals, warnings, errors, denials and required
durability/effect disclosures. Implement categories at their owners; never filter
all stdout/stderr writes. JSON preserves every contractual data record and safety
diagnostic and never contains human stack dumps. Verbose diagnostics are bounded,
redacted, terminal-safe and exclude arbitrary cause inspection, raw argv, request
bodies and credential values. Generic failures point to the supported verbose flag.

Reserve additive exit **9** for an unclassified CLI internal failure. Genuine
workflow failure/cancellation remains 1; invocation faults remain 2; existing
0 and 3–8 and surface-specific signal outcomes retain their meanings. Typed
history/ownership/receipt refusals must not be flattened into 9. A final joined
money/effect/durability/ownership disposition takes precedence over a generic
internal failure.

Preserve the recoverable background-rejection net's keepalive policy: report a
bounded safe diagnostic, remember the failure and upgrade only an otherwise clean
exit 0 to 9. Preserve an existing nonzero lifecycle outcome. An uncaught exception
or top-level rejected invocation instead stops new work, reports once and requests
bounded cooperative owner cleanup. The fatal shutdown budget is three seconds;
after it, only owned native resources may be synchronously reaped before exit.
Normal/recoverable cleanup still joins ADR-0103 owners before closing their stores.
The process `exit` callback cannot await work and must never be described as an
asynchronous durability acknowledgement. No crash handler fabricates a run terminal
or retries a paid request. Repeated faults and a broken diagnostic stream cannot
recursively enter the handler.

A closed output pipe is a typed output failure, with bounded cancellation/cleanup,
not a raw Node stack. Write a safe diagnostic only to a still-usable independent
sink; an EPIPE sink cannot acknowledge its own error. Preserve more specific final
safety dispositions; otherwise use exit 9. Do not assert successful terminal delivery
or durable publication from a failed write.

### Discovery and compatibility

Explicit root `--help --json` returns a versioned command-manifest JSON record
(`type: command_manifest`, `version: 1`, `commands` containing the canonical list);
command-specific help returns the matching command/subtree in the same format.
Stable existing executor IDs remain available; aliases resolve to the same executor.
Both are exit-0 meta-operations and start no
services. This replaces **only** ADR-0049 §6's human-help exception for explicit
help plus JSON. `--version --json` and bare `--json` retain their existing human
meta-operation behaviour. Run/session JSON streams retain their event shapes and
sequence ordering. Invalid command/option grammar still fails as an invocation.

Make `chat resume`, `chat list` and `chat export` canonical while retaining working
flat aliases. Make `models pricing --input-price` / `--output-price` canonical,
retaining the old pricing spellings as deprecated aliases. Specifying both spellings
for one quantity refuses even when values match, rather than silently choosing one.
Successful deprecated-alias use has one bounded stderr notice, structured in JSON
mode, never an extra stdout record. Update the one command manifest,
dispatch and help together. Do not rename run inputs, gate payloads or reserved
agent input semantics as collateral work.

`provider remove-key` requires explicit confirmation on an interactive terminal or
`--force` for automation. A refusal/cancel performs no key deletion; JSON/CI cannot
prompt. Deliberately declining confirmation exits 0; a noninteractive invocation
without force exits 2. Actual process termination retains its signal contract.
Human `logs` coalesces consecutive token/reasoning fragments by run, node
and channel, flushing at boundaries and EOF with bounded buffering. JSON logs
retain the actual stored event stream. Unknown-command diagnostics keep arbitrary
command strings private and add a static help hint rather than echoing raw input.

D22 means no unrecorded breaking change. This decision explicitly authorizes the
listed aliases, deletion consent, diagnostic behaviour, meta-help format and
internal exit distinction. It does not authorize unrelated command or event
changes. Landing must reconcile the phase's older two-exception wording and its
blanket “no new ADR” claim, preserving historical ADR bodies through dated notes.

Considered preserving all current behaviour and correcting only documentation:
rejected because quiet, internal-fault distinction and discovery remain misleading.
Considered making verbose win over quiet: rejected because it changes the existing
conflict rule unnecessarily. Considered suppressing safety output in quiet or
coalescing JSON events: rejected because either hides contractual evidence.
Considered making every unhandled rejection fatal: rejected because it reverses
the accepted recoverable persister backstop. Fatal exceptions are distinct.

### Acceptance and landing

1. A flags × environment × output-mode matrix proves category-based suppression,
   explicit precedence and preserved JSON/safety data; planted secret/control text
   never enters diagnostics, including verbose and fatal paths.
2. Native child tests cover closed stdout/stderr, synchronous startup throws,
   background rejection, uncaught exception, repeated faults and owned subprocess
   teardown. Positive controls preserve genuine terminals and 3–8/signal outcomes.
3. Commander-to-dispatch tests prove help projection, aliases, conflict refusal,
   global help and deletion consent with zero unintended service/key effects.
4. Human log tests prove boundary-aware coalescing and bounded EOF flushing; JSON
   replay remains byte-equivalent for the same event sequence.
5. Removing each correction breaks its regression. Required CI, package/build
   checks and two new independent cumulative review rounds pass before acceptance.
   Add dated forward notes to ADR-0049/0056/0088/0103 at implementation landing;
   update their canonical CLI references and the Wave 3 register.

## Consequences

### Positive

- Scripts can distinguish a failed workflow from a broken CLI without changing
  actual run events, receipt authority or the existing safety exits.
- Quiet and verbose have predictable limits, and discovery derives from one manifest.

### Negative

- Explicit JSON help, deletion consent and exit 9 alter public behaviour. Their
  narrowly recorded scope, old aliases and permanent compatibility tests mitigate it.
- Fatal shutdown cannot promise durable acknowledgement after its deadline. The
  diagnostic and final outcome must retain that uncertainty rather than claim cleanup.
