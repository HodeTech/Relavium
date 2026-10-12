# Secrets causal controls

`pnpm check:secrets-mutations` runs the declared Step 3 secrets foundation,
Step 4 first-run input matrix and Step 5 snapshot/export controls on physical source
copies. `--mechanism <declared-id>`
supports diagnosis only; selected runs retain `complete: false`. The current manifest
declares **35 independent controls and 256 required named assertion witnesses**.
These counts describe the workload; a declaration is not evidence that its removal
passed. Actual fixed/removal/restored results belong to the coordinator's summary.

The thirteen preserved Step 3 controls cover the stdin aggregate/single-chunk cap, mutable
Buffer ownership, zero-byte retention, awaited iterator cleanup, fixed source-error
normalization, each native keychain operation's fixed error and finite query-name
scrubbing, the CLI diagnostic residual check, and three independent shared-scrubber
overlap mechanisms. Permanent adjacent suites supply named semantic assertions,
including exact-cap, Unicode/whitespace and benign query-name positive cases. The cap control
requires all three aggregate and all three single-chunk witnesses. Source-error
normalization requires all nine declared ownership boundaries. Each native
operation requires both constructor and method witnesses with an opaque Error.
The diagnostic residual control restores the unsafe early return after an in-place match
and requires all 21 named completed assertion witnesses: both sanitizer functions
for each of the eight query families, human/JSON diagnostics in normal/verbose
mode and an isolated verbose-stack case with a benign message. Each pairs a newly
recognized query with an independently split literal `api_key` query name before the
URL-userinfo and key examples. The literal split preserves the residual CLI obligation
when the shared non-query probe protects overlapping credential shapes upstream.
Ordinary diagnostics without a residual credential retain their in-place redaction
and benign text.

The prefix-before-redaction control removes the shared scrubber's whitespace join
from each rule's original diagnostic probe, leaving split key and URL-userinfo
evidence vulnerable to overlapping query redaction. It requires 58 named assertion
witnesses: eight LLM query-family cases, both CLI
sanitizer functions for all eight families, four actual human/JSON renderer modes
and an isolated verbose stack already passed through the shared scrubber, plus 29
new URL-userinfo overlap witnesses across the same surfaces. Each checks a remaining
secret suffix after an overlapping query value. The normalized-secret-probe control
removes the canonical `stripTerminalControls` view from the shared non-query probe;
29 named normalized-key overlap witnesses require that view in LLM messages/codes,
both CLI sanitizer functions, all four renderer modes and a verbose stack. The
non-query-before-query control reverses the final composition and requires 58 named
Bearer/Basic overlap witnesses across those same surfaces. These controls require
each finite non-query rule to inspect its own original diagnostic views before any
other replacement erases its evidence, followed by the finite query replacement.
The views include the canonical terminal-normalized text and a whitespace-joined
residual view. The split literal query name remains an independent CLI obligation.
Across the thirteen Step 3 controls, 191 named assertion witnesses are required. The shared
overlap controls collect 259 tests across the LLM, CLI sanitizer and renderer files.
When a long prefix was already completely masked, its following suffix remains an
existing classification ambiguity; this adds no universal secret-detection claim or
new deferral.

The eleven Step 4 controls remove separate production mechanisms:

| Control | Removal and required observation |
| --- | --- |
| `run-argv-secret-refusal` | Remove the explicit own-entry secret refusal; both empty and nonempty argv secrets must fail the named refusal assertion before the required-input loop. |
| `run-action-stdin-forwarding` | Drop the registered Boolean from the actual Commander action's dispatch input. |
| `run-dispatch-stdin-forwarding` | Discard the true Boolean at the typed dispatch builder while preserving its absent/false behavior. |
| `run-lazy-native-services` | Restore eager native service construction in `executeRun`; malformed ordinary input must then violate the zero-key-factory assertion in all four output modes. |
| `run-default-secret-reader` | Replace only the first-run default reader fallback with empty input; the real reader observation must fail before the command-outcome assertion. |
| `run-consumed-stdin-prompt-authority` | Restore run prompt authority after stdin consumption; the actual MCP consent decision must call the forbidden prompt under deliberately stale TTY metadata. |
| `gate-consumed-stdin-prompt-authority` | Restore gate-resume prompt authority after stdin consumption; the real reader/actual MCP consent witness must observe the forbidden prompt. |
| `run-native-event-input-mask` | Return raw values from the engine's event-input mask; actual native `runs.input_json` must fail its exact mask assertion in all four output modes. |
| `run-native-input-node-mask` | Bypass only the input-node handler's mask; actual native `step_executions.output_json` must fail independently in all four output modes. Expression-scope masking is untouched. |
| `run-commander-diagnostic-projection` | Remove the run-local human-output and thrown-error projection while retaining Commander exception handling; all four parser-diagnostic modes must expose the opaque payload to their named assertion. |
| `run-core-admission-before-services` | Remove the pure pre-service core admission while retaining final engine validation; secret length/pattern/format and ordinary min/max/enum failures must violate the native zero-key-factory assertion in all four output modes. |

The Step 4 declarations require 51 additional named assertion witnesses. Every
selected workload remains a complete test file: 33 input cases, 14 action-forwarding
cases, 32 dispatch cases, 76 run-command cases, three run-consent cases, 61 gate cases,
28 top-level parser cases, or 131 native integration cases, as declared per control.
The coordinator independently enforces exact case counts, unique complete case
identities and identical fixed/removal/restored inventories. It accepts only a
completed `AssertionError` carrying the expected marker in each selected target;
setup/import errors, thrown mock blockers or a failure elsewhere cannot substitute.

The native suite keeps the actual top-level parser/dispatch, default stdin reader,
engine, production history openers and SQLite persistence. It observes both the
provider-registry and workflow-history opens, uses an owned temporary home, restores
stdin's descriptor, and replaces the native credential accessor. The consent fixture
replaces external transport only and keeps the real consent gate/manager; observation
spies call through. Positive cases prove verbatim engine input, typed ordinary values,
prototype-like own input names, optional omission, exact-cap delivery, faithful workflow
snapshots and native masked inputs/node outputs/events/reconstructed state. A real
pause, missing-resupply refusal and fresh-stdin resume retain the later-gate exit.

Native input-only sentinels prove neither universal workflow-literal/tool-output
redaction nor scrubbing of historical rows. The complete workflow snapshot is
preserved. Real pipes naturally disable prompting; stale-TTY seam witnesses establish
removal of the explicit consumed-stdin authority separately. Final engine validation
remains present in the early-admission removal: its witness proves service ordering,
not successful dispatch of invalid inputs. Commander controls protect the documented
run input/option boundary, not every ordinary workflow/config path in argv.

Native keychain suites mock `@napi-rs/keyring` before loading the production wrapper
and verify the mock calls; these controls do not touch the user's keychain or certify
a real locked store.

The eleven Step 5 controls require 14 named assertion witnesses. Four remove independent
parse/export mechanisms: direct unsupported `secrets.*` context refusal, title NFKD
normalization, session-identity fallback for an unusable title, and bounded legal
encoding for an odd external session id. The context removal must fail an unread
direct-reference parser case; the complete analysis file has 22 cases. Each export-ID
removal must fail its own serializer assertion in the complete 24-case file. Separate
positive tests retain legitimate secret-input context propagation, faithful metadata,
and deterministic parse/serialize behavior. These controls do not certify universal
transliteration or uniqueness of generated IDs.

Two independent CLI notice controls remove the successful standalone command and
live `/export` notice sites. Each requires named human and JSON witnesses in
the complete 15-case command-export or 122-case chat file. The live control also
requires its actual interactive transcript/Ink-frame witness. A third control
restores raw stderr delivery only for the live notice: human/JSON positive cases
still pass, while the interactive witness must fail with its named assertion marker.
The mounted installed Ink component uses owned TTY streams and file-backed SQLite;
a separate visible transcript notice proves the renderer is active. The tests use actual
export writes, retain exactly one export event on stdout in JSON mode, and check the fixed
compaction/context and retained-content review clauses. Refused writes have separate
permanent negative cases; no notice is produced before a successful export.

Four snapshot controls remove the finite scrubber detection site and the actual
`create`, `import`, and `run` warning calls. Each has a named value-free assertion in
its complete 10-case detector, 10-case create, 10-case import or 76-case run file.
The adjacent tests check preserved authored files and admitted run snapshots, JSON
stdout, and scan-budget/incomplete notices. These controls certify warning delivery
for the planted supported shapes at these entry points, not universal secret
detection, redaction, historical rows, or the user's native keychain. The separate
native run/resume snapshot suite is permanent integration coverage but is not a
declared mutation workload here.

The thin entry point uses the same coordinator, outcome and bounded process join
as the filesystem family in [causal-controls](../causal-controls/README.md).
Source manifests physically capture both the shared tooling and this family,
including helpers and declarations. Exact file membership/hashes, installed
dependencies, HEAD/index, target body evaluations, inventories and restoration are
required. The secrets child receives a small operational environment and a scratch
HOME, without ambient credentials, Node injection or operator config/history.

`RELAVIUM_ACCEPTANCE_EVIDENCE=/absolute/directory` exports bounded metadata under
`secrets/` outside the repository and scratch tree. No graph, cache, native database
or installed dependency bytes are retained. Existing evidence cannot be overwritten.
Scratch cleanup preserves the primary failure. Required local CI and the dedicated
GitHub job execute the full matrix; the always-run aggregator requires literal
success. Metadata uploads run on failure too, with seven-day retention.

A passing matrix supplies causal evidence; full required gates, independent reviews
and whole-wave security acceptance retain separate authority.
