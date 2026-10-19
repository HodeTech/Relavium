# Secrets causal controls

`pnpm check:secrets-mutations` runs the declared Step 3 secrets foundation,
Step 4 first-run input matrix, Step 5 snapshot/export, Step 7 provider-header and PR #95 B2 redaction controls on physical source
copies. `--mechanism <declared-id>`
supports diagnosis only; selected runs retain `complete: false`. The current manifest
declares **57 independent controls and 336 required named assertion witnesses**.
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
The diagnostic residual control skips the CLI's still-unmasked-span residual scan
and requires all 21 named completed assertion witnesses: both sanitizer functions
for each of the eight query families, human/JSON diagnostics in normal/verbose
mode and an isolated verbose-stack case with a benign message. Each pairs a newly
recognized query with an independently split literal `api_key` query name before the
URL-userinfo and key examples. The literal split preserves the residual CLI obligation
when the shared non-query probe protects overlapping credential shapes upstream.
Ordinary diagnostics without a residual credential retain their in-place redaction
and benign text.

The prefix-before-redaction control removes the shared scrubber's whitespace join
from each rule's remaining diagnostic spans, leaving space-separated incomplete key
and URL-userinfo evidence vulnerable to overlapping query redaction. The separate
LF/TAB probe stays active. Its pre-scrubbed verbose-stack witness exercises LF, TAB
and space/CR/LF/TAB forms so the broader residual mechanism remains independently
load-bearing. It requires 58 named assertion
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
overlap controls collect 278 tests across the LLM, CLI sanitizer and renderer files.
The B2 controls below pin the conservative LF/TAB continuation rule when a first
fragment already meets a key-length floor. Broader whitespace residual checks retain
their finite scope; neither mechanism claims universal secret detection.

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

The Step 4 declarations require 52 additional named assertion witnesses. Every
selected workload remains a complete test file: 33 input cases, 14 action-forwarding
cases, 32 dispatch cases, 84 run-command cases, three run-consent cases, 73 gate cases,
28 top-level parser cases, or 131 native integration cases, as declared per control.
The coordinator independently enforces exact case counts, unique complete case
identities and identical fixed/removal/restored inventories. It accepts only a
completed `AssertionError` carrying the expected marker in each selected target;
setup/import errors, thrown mock blockers or a failure elsewhere cannot substitute.
The default-reader control requires both native and structurally equivalent stdin
reader witnesses. An ordinary tooling test independently pins the corrected complete-file
counts and both reader witnesses. The coordinator still validates actual collection in each
phase; collection never supplies or rewrites its expected counts.

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
removal must fail its own serializer assertion in the complete 25-case file. Separate
positive tests retain legitimate secret-input context propagation, faithful metadata,
and deterministic parse/serialize behavior. These controls do not certify universal
transliteration or uniqueness of generated IDs.

Two independent CLI notice controls remove the successful standalone command and
live `/export` notice sites. Each requires named human and JSON witnesses in
the complete 18-case command-export or 133-case chat file. The live control also
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
its complete 10-case detector, 11-case create, 11-case import or 84-case run file.
The adjacent tests check preserved authored files and admitted run snapshots, JSON
stdout, and scan-budget/incomplete notices. These controls certify warning delivery
for the planted supported shapes at these entry points, not universal secret
detection, redaction, historical rows, or the user's native keychain. The separate
native run/resume snapshot suite is permanent integration coverage but is not a
declared mutation workload here.

The six Step 7 controls implement the interim gate in
[ADR-0108](../../docs/decisions/0108-provider-headers-stay-gated-until-keychain-custody.md).
They retain all 35 earlier declarations, workloads and their order. Twenty new
named semantic witnesses cover the independent mechanisms below; every phase runs
the indicated complete file, without case filtering or skips.

| Control | Removal and required observation | Complete workload |
| --- | --- | --- |
| `provider-header-admission` | Replace the captured admission branch with constant preservation before clock/SQL entry. New and existing rows with opaque and benign nonempty maps must each violate `PROVIDER_HEADERS_NO_PLAINTEXT`. | 56 DB cases |
| `provider-header-omission-preservation` | Write canonical empty JSON in place of the preservation/clear expression. Omitted and explicit-undefined updates must each violate `PROVIDER_HEADERS_PRESERVE_LEGACY` on exact stored bytes and retained trusted maps. | 56 DB cases |
| `provider-header-explicit-clear` | Keep the existing raw column instead of the preservation/clear expression. Both ordinary and null-prototype empty maps must violate `PROVIDER_HEADERS_EXPLICIT_CLEAR`. | 56 DB cases |
| `provider-header-dormant-wire` | At the actual custom-adapter fetch site, merge stored headers into a native Request and forward it to the actual fetch. All six OpenAI/DeepSeek generate, fully drained stream and listModels cases must violate `FS_CAUSAL_PROVIDER_HEADER_WIRE` after installed-SDK HTTP capture. | 18 host/SDK cases |
| `provider-header-public-projection` | Spread the full trusted row into the actual provider-list JSON record. Offline, successful verify, refused verify and unavailable-key NDJSON cases must violate `FS_CAUSAL_PROVIDER_HEADER_PUBLIC`. | 29 command/factory/renderer cases |
| `provider-header-read-diagnostic` | Restore the stored member name in the parser's nonstring-member error. Actual command-read and eager factory-read human verbose cases must violate `FS_CAUSAL_PROVIDER_HEADER_DIAGNOSTIC` on rendered stderr. | 29 command/factory/renderer cases |

The admission removal retains canonical empty serialization: it proves refusal and
the pre-effect barrier, not that this mutation writes plaintext headers. The wire
removal changes the production consumption point rather than adding an ignored SDK
option. Its full native header recorder precedes the separate W8 redacted exchange
projection, and positive protocol outcomes prove that the installed SDK reached the
recorder. Twelve default-provider cases separately require exactly one asserted
HTTP 400 request with ordinary authentication/protocol headers and no legacy data;
the wire removal targets custom adapters only. All captures use synthetic credentials,
isolated SDK environment, in-memory legacy SQLite seeds and offline transports.

Trusted get/list preservation is a positive prerequisite for public/wire exclusion.
The JSON spread removal certifies the JSON projection; the complete suite separately
pins human output. Diagnostic witnesses render a positive verbose stack before
checking opaque sentinel exclusion, so an earlier fixed-message assertion cannot
substitute for observing the actual rendered failure. Other diagnostic modes retain
their fixed-error and own-property checks. These controls cover factory composition,
command core and rendering, not full top-level parser/native composition. Legacy
plaintext remains sensitive in SQLite/WAL/backups; logical empty-map clearing proves
neither physical erasure nor functional keychain-reference headers.

The ten PR #95 B2 controls require 25 additional named assertions and retain all
41 previous control identities and their required witnesses. Six core controls remove
modern `sk-` body characters, joined-span application, the original-text left-boundary
check, split scheme labels, split API-header labels and raw `?`/`#` password recognition
independently. Four LLM controls remove the before-masking LF/TAB probe, its original
left-boundary check, split API-header recognition and raw-password recognition.
Every core phase executes the complete 142-case bounding file; every new LLM phase
executes the complete 111-case scrubber file. Independent ordinary tooling tests pin
these inventories, the 278-case overlap cohort, 180-case CLI diagnostic cohort and
18-case command-export cohort. Actual collection still has to match in every phase.

The boundary controls preserve an embedded public-word key-shaped run containing an
internal LF as well as recognizing a real key after an LF boundary. This makes the
original-text boundary check load-bearing rather than relying on a no-split case that
would survive its removal. Other witnesses require complete recognized spans and
retain public tails, host contacts and the full-value identity policy. The finite
LF/TAB continuation and malformed-userinfo policy is documented in the canonical
[effect-journal contract](../../docs/reference/shared-core/effect-journal.md#11-secrets-what-a-row-may-hold).
An eight-MiB permanent fixture checks completion and whole-span behavior without a
machine-speed threshold; these controls do not certify arbitrary obfuscation.

Two R1 original-boundary recovery controls add eight named assertions, retaining all
51 prior identities and required witnesses. The core removal admits embedded-word
starts while retaining the mapper's late refusal and bounded probe; the rejected
candidate consumes the later valid start. The LLM removal replaces original-boundary checks with joined-boundary checks only
for the non-header rules in its unified scanner, preserving the finite-header path. All four
OpenAI/Google × LF/TAB poisoned-prefix cases must then fail with
`SECRETS_B2_ORIGINAL_BOUNDARY`;
public embedded-word preservation and the later complete split credential are
asserted together. The earlier core boundary control removes both scanner and
mapper boundary checks as one policy; removing the late mapper check alone leaves
the new scanner prefilter active. The LLM boundary control removes its actual early
original-boundary predicate. Their existing named witnesses remain required. These
are declared controls; actual final-source fixed/removal/restored evidence remains
separate from the older eleven selected captures and independent acceptance.

Two R2 finite-header recovery controls add eight named assertions while preserving
all 53 prior control identities, paths, targets, markers and witness arrays. Four
`x-`/`x-goog-` × swapped LF/TAB witnesses per package require
`SECRETS_B2_HEADER_ORIGINAL_BOUNDARY`. The core removal admits an embedded outer
label but retains the mapper's late boundary refusal, reproducing consumption of
the valid inner label. The LLM removal substitutes joined-boundary checks only for
its finite-header rule; other rules still use original boundaries. Neither removal
disables bounded JWT probing or replaces canonical matcher authority. The earlier
split-header-label control now removes the header helper's actual mask delivery.
Core and LLM stress cases check bounded preparation with length/Boolean assertions,
so a regression cannot serialize an admitted-size value into failure metadata.

A separately confirmed raw-path failed-JWT preparation defect is covered by a
permanent admitted-size raw-path regression. All declared removals retain the
bounded canonical visitor used by both raw and joined standalone-key passes.
Reverting that protection would make timeout an invalid substitute for semantic
failure; there is no declared raw-scanner timeout control or retrospective R2
review claim for this later author correction.

Earlier eleven-control author captures and the four selected `ce6df268` captures
retain their own source/workload attribution. Declaration maintenance and fresh
collection do not recertify them as current-source or full-55 execution. Actual
fixed/removal/restored evidence and independent acceptance remain separate.

Two R3 display-projection controls add eighteen named assertion witnesses while
retaining all 55 prior identities, targets, markers and witness arrays. The
`diagnostic-inline-projection-order` removal collapses LF/TAB before the complete
untrusted-text projection. Its two inline sanitizer cases and four actual
human/JSON normal/verbose renderer cases must fail `SECRETS_B2_DISPLAY_ORDER`.
The independent `diagnostic-original-control-boundary` removal strips terminal
controls before the initial shared scrubber can observe their original credential
boundary. Eight multiline/inline sanitizer cases cover removed C0, DEL, C1 and
bidi units; the same four real renderer cases must fail their distinct
`SECRETS_B2_DISPLAY_BOUNDARY` assertion. Both phases execute the complete 180-case
sanitizer/renderer cohort. The earlier CLI residual-query control remains
independent and retains its required witnesses. Its removal now skips the actual
remaining-span loop: the new outer raw scrubber can already mask ordinary matches,
so the former conditional early-return mutation would leave this policy active.

Core candidate and separator runs now use native scans while retaining the same
canonical matcher and bounded JWT preview. The original-boundary removals target
the actual native candidate guards; the combined removal also drops the mapper
guard. An LLM native absence preflight derives from the existing canonical rule,
so it adds no second credential grammar or acceptance authority.

The LLM original-boundary removal now removes both the numeric coarse
previous-word prefilter and the rule's own boundary predicate; retaining either
would leave the tested policy active. Header/key recovery removals still change
their original-rule boundary only, and all removals retain the same canonical
matchers and bounded raw/joined standalone visitors. Current collection is 25
complete files / 1,343 cases, with each control's exact workload and named target
checked separately. These are updated declarations and author checks, not new
physical causal captures or a clean review round. R3 is preserved as NONCLEAN;
later corrective acceptance belongs to the owning phase register. Prior selected
`7e9096a8` captures retain their older source/workload attribution.

The current 57-control / 171-phase full declaration projects 1,033 retained files
(57 × 18 + 7) under the unchanged 2,000-file / 64-MiB export bounds. This is a capacity
calculation, not a measured full capture. Historical 41-control captures retain their
original source and cohort attribution; selected B2 or original-boundary recovery captures are not full-family
acceptance.

The thin entry point uses the same coordinator, outcome and bounded process join
as the filesystem family in [causal-controls](../causal-controls/README.md).
The provider-header diagnostic control pins the store's fixed throwable message
as well as the separately sanitized rendered bytes. Its named assertion also
owns the store-message check: a native accessor-backed `Error.stack` is correctly
unread by the safe renderer, so public masking alone cannot certify the store's
content-free failure boundary. The control identity, cases and witnesses remain.
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
