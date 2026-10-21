# Secrets causal controls

`pnpm check:secrets-mutations` runs the declared Step 3 secrets foundation,
Step 4 first-run input matrix, Step 5 snapshot/export, Step 7 provider-header and PR #95 B2 redaction controls on physical source
copies. `--mechanism <declared-id>`
supports diagnosis only; selected runs retain `complete: false`. The current manifest
declares **130 independent controls and 513 required named assertion witnesses**.
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
non-query-before-query control applies the literal query names before the merged
pass and requires 58 named Bearer/Basic overlap witnesses across those same surfaces.
These controls require each finite non-query rule to inspect its own original
diagnostic views before any other replacement erases its evidence; the literal query
values then join the same merged masking pass instead of following it.
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
its complete 11-case detector, 11-case create, 11-case import or 84-case run file.
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
Every core projection phase executes the complete 218-case bounding file (the journal-identity
control's phases the complete 115-case registry file); every new LLM phase executes the complete 224-case scrubber file. Independent ordinary tooling tests pin
these inventories, the 278-case overlap cohort, 180-case CLI diagnostic cohort and
18-case command-export cohort. Actual collection still has to match in every phase.

The boundary controls preserve an embedded public-word key-shaped run containing an
internal LF as well as recognizing a real key after an LF boundary. This makes the
original-text boundary check load-bearing rather than relying on a no-split case that
would survive its removal. Other witnesses require complete recognized spans and
retain public tails, host contacts and the full-value identity policy. The finite
LF/TAB continuation and malformed-userinfo policy is documented in the canonical
[effect-journal contract](../../docs/reference/shared-core/effect-journal.md#11-secrets-what-a-row-may-hold).
Eight-MiB permanent fixtures in the core and scrubber files check completion and whole-span
behavior under a 15-second case deadline rather than a machine-speed threshold; these controls do
not certify arbitrary obfuscation.

Two R1 original-boundary recovery controls add eight named assertions, retaining all
51 prior identities and required witnesses. The core removal admits embedded-word
starts while retaining the mapper's late refusal and bounded probe; the rejected
candidate consumes the later valid start. The LLM removal replaces original-boundary checks with joined-boundary checks only
for the key (`sk-`/`AIza`) rules in its unified scanner (the URL and header rules supply their own joined patterns), preserving the finite-header path. All four
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
its finite-header rule; other rules still use original boundaries. (The URL rule is selected
too, because it supplies its own joined pattern, but its boundary blocks no start, so the
substitution cannot change its result.) Neither removal
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
matchers and bounded raw/joined standalone visitors. Current collection is 26
complete files / 1,648 cases, with each control's exact workload and named target
checked separately. These are updated declarations and author checks, not new
physical causal captures or a clean review round. R3 is preserved as NONCLEAN;
later corrective acceptance belongs to the owning phase register. Prior selected
`7e9096a8` captures retain their older source/workload attribution.

The current 130-control / 390-phase full declaration runs as two round-robin shards of 65 controls
(`--shard 1/2` and `--shard 2/2`), each exporting its own evidence: each projects 1,177 retained
files (65 × 18 + 7) of the unchanged 2,000. Locally both exports held exactly that many and measured
50.24 MiB and 50.14 MiB, final export record included, against the unchanged
64-MiB bound. That is one local measurement at the round-10 source, not a CI capture; one export of
the whole family would exceed the byte bound. Historical 41-control captures retain their original
source and cohort attribution; selected B2 or original-boundary recovery captures are not
full-family acceptance.

Wave 3's PR95 increment adds nine controls and 80 named assertions, retaining all 57
prior identities and witnesses. The LLM header control restores the old header value
class, so a value that begins with a `Bearer`/`Basic` label leaks its token again. Two
LLM and two core controls each drop one half of the raw `?`/`#` contact predicate (the
host-shaped prefix, or the `=` assignment that must follow it). The connection-scheme
control restores the original six-scheme list (`sftp` is no witness: the old list still
masks it by its `ftp` suffix). Three controls cut the URL rule's split-scanner support:
its joined form, its no-boundary start (a glued scheme) and its `://` window (`ws` alone
fits a two-character window, so it is no witness). Each of the nine ran in diagnosis mode
with its fixed and restored phases green and every declared witness failing on its marker;
that is author evidence, not a full-family capture. The eight-MiB scrubber cases now carry a 15-second
case deadline instead of a wall-clock assertion, inside the phases' `CAUSAL_TIMEOUT_BUDGET`.

The increment's first review round added six more controls and 14 named assertions. Two
header controls narrow the label prefix back to one label, or its whitespace back to one
character, so a doubled `Bearer Bearer` label or a multi-character gap leaks the token. Two
controls per masker remove the host-shaped prefix's length bound (an admitted-size dotted
prefix then exhausts V8's RegExp stack, and its witness catches the throw) or its `^`/`$`
anchors (look-alike prefixes such as `john.doe:s3cret` turn public). The snapshot detector's
complete workload is now 11 cases.

The second review round added seven controls and 11 named assertions: an unbounded header label
run, and the label-as-token and masked-marker guards of the header and standalone rules. The
host-length controls also witness the exact 260/261 boundary.

The third round replaced sequential rule application with one merged masking pass: every rule
finds its matches in the original text, the masked ranges are merged, and a token rule masks only
its token, so masking an exact `[REDACTED]` is the identity and the three masked-marker guards are
gone. The header and label block now has 23 controls, 13 more than the ten it replaced. Seven
re-anchor the earlier label-run, label-whitespace, label-bound and not-a-label controls; the new
ones restore the sequential pass, disable range merging or mask a whole header match; unbound the
concatenated-label lookaheads (an admitted-size glued run then exhausts the RegExp stack); drop
the header's not-a-nested-header guard, nested-header stop or zero-width boundary; weaken its
escaped separator, quote-run prefix, first-character or escaped-stop rules; drop the standalone
rules' closing-quote or glued-label guard or their embedded-label stop; or reintroduce round 2's
masked-marker guard, which exposes a tail glued to the marker.

The fourth round merged the two standalone label rules into one, whose first label is either
label, so neither copy can drift from the other: the former Bearer and Basic not-a-label controls
became `diagnostic-label-token-not-label`, and every label control now covers both labels. A run
of up to eight concatenated labels (`BearerBearer`) is one label, nine blank the diagnostic, the
literal query names join the merged pass, an ambiguous authority is masked through its end, and
the scrubber repeats its pass to a fixed point. Nineteen controls were added: the label run, its
embedded stop, its not-a-label refusal (`{1,8}` weakened to `{1}`), its stack bound and its
leading quote run; the header's concatenated run and its `}`/`'` stops; the nine-label bound;
the query merge; the merge extent; the fixed point; the ambiguous-authority extent and its host
length bound (with core twins for the last two); and core's URL-scheme lookahead after a scheme
label, its split-userinfo edges and its fixed point. With the merged pair, 109 controls remain:
`diagnostic-label-concat-bound` was retired as an equivalent mutant: the label rule's not-a-label bound is reached only by nine or more
concatenated labels, which the nine-label bound blanks first, or in the whitespace-stripped
residual, where a label rule (which needs whitespace after the label) never matches. The header's
bound stays controlled through the residual of a separate-label run. Edges that only change how
much is masked, never whether a token leaks (a word-glued label is no label, whitespace before a
header colon, a host after an ambiguous authority staying visible), are pinned by tests without a
control, which keeps the family inside the 2,000-file export bound. Three guards are pinned only
by the admitted-size case deadline: the label token's first-character lookahead and the URL rule's
`://` prefilter are output-equivalent, and the header stop's bounded escape run only decides how
many escapes past fifteen fold into the mask; removing any of them brings back a quadratic scan,
and the coordinator counts a timeout as infrastructure, never as a removal's failure, so they have
no control.

The fifth round found that core's round-4 authority extent erased the context its later rules
read: core's rules run in sequence, so masking through an ambiguous authority's end swallowed the
key name, label, scheme or PEM marker of the next credential, and in the LF/TAB-joined view it ran
across a real line break. Core now masks an ambiguous userinfo together with exactly the query
values its opaque-query and secret key/value rules would mask whole, ending where those rules end
them, and masks the userinfo only in the joined view; the URL-scheme lookahead after a scheme label
is gone, because the split view now masks URL userinfo before scheme labels, as the main pass
always did. Three core controls were replaced by three for those mechanisms
(`core-userinfo-query-extent`, `core-userinfo-joined-extent`,
`core-split-userinfo-before-scheme`); `core-userinfo-split-scheme` controls a separator inside a
URL's `scheme://`, which now splits its userinfo as one at the userinfo's edges does (core had left
`https:/\n/user:pass@host` unmasked since before the increment); and `diagnostic-url-split-retry`
controls the split scan's retry of a kept candidate glued across a line break (`files\nftp://`
read as `sftp://`). `diagnostic-label-concat-refusal` is retired to make room, and its test stays.
The family is now 110 controls, the most the unchanged 2,000-file export bound admits (110 × 18 + 7
= 1,987). From this round on, a control pins each new leak-bearing mechanism, and the pieces inside
a mechanism's pattern (one character of a delimiter class, a repetition bound, a flag, a fixed
point's fail-closed branch) are pinned by discriminating tests instead: the fifth round's tests for
the label rule's trailing `;`/`,`, its embedded stop's closing quote run and bound, the nine-label
bound's case and LF/TAB letters, the exactly masked password, the escaped joined header name and
both fixed-point helpers were each checked against the mutation they kill.

The sixth round found that round 5's value mirror rescanned the text from every query assignment
(quadratic at admitted size), still masked through a later credential's key name, label or PEM
marker, and was dropped by the split view, which treated a URL after any line break as split.
Core now works like the scrubber: every rule reports its ranges on one text and overlapping ranges
merge before anything is replaced, so no mask removes another rule's context. A key or parameter
in a URL userinfo's own text — all of an unambiguous userinfo, and a `user:password` before a raw
`?`/`#` — belongs to it; the key/value and opaque-query rules read the rest of an ambiguous
userinfo. The key/value rule resumes its scan at each value, so a key inside a value is read too,
and reads values through earlier masks, line breaks included; the scheme-label rule resumes after
each label; an LF/TAB-split header label, and a scheme label even where a key's value runs on over
it, may start right after a credential (one helper, `afterMasks`, fills the credentials before them
as applied masks would); and PEM blocks are found with one shared END search instead of a bounded
rescan after every BEGIN marker. Six controls pin the new mechanisms (`core-merged-ranges`,
`core-userinfo-query-zone`, `core-key-value-nested`, `core-key-value-through-masks`,
`core-scheme-nested-label`, `core-mask-boundaries`). The three round-5 core controls are gone with their mechanisms;
`core-joined-credential-spans`, `core-joined-original-boundary`, `core-userinfo-split-scheme`,
`core-userinfo-split-edges`, `diagnostic-label-run-bound` and `query-names` are re-anchored; and
three single-character pieces of the header rule (`diagnostic-header-stop-brace`,
`diagnostic-header-stop-quote`, `diagnostic-header-backslash-first`) are retired to make room, each
after its test was checked to still kill its mutation. Pinned by tests without a control: the
userinfo zone's colon and unambiguous branches, the opaque rule's parameter view, the fill's
boundary brackets, the PEM body bound (20,000 and 20,001), the scrubber's raw-text nine-label check
and `#` query names, and both maskers' fail-closed values, observed through a module mock of the
fixed-point helper that keeps its implementation. The split view still maps a URL's scheme past a
separator right before it; that only spares reporting the main view's range a second time, so the
output cannot show it and it has neither a test nor a control. The shared END search is pinned by
the admitted-size case deadline alone, like round 4's deadline-only guards.

The seventh round found that a key in a URL userinfo's own text could still hide a real
credential. An unambiguous userinfo owned every key in it, so a key in its password or parameter
position (`jdbc:sqlserver://db:1433;user=sa;password=P@ss…`, `https://svc;a=1;password=P@ss…`) and,
in the LF/TAB-joined view, a key on the next line (`DATABASE_URL=https://h\nDB_PASSWORD=P@ss…`) left
its value's text after the last `@` visible. Only a userinfo's username — the text before its first
`:` when no raw `?`/`#` comes before that colon — now owns its keys, and never past an LF or TAB. The
quoted-value pattern's repeated group exhausted V8's RegExp stack at an exactly admitted 8-MiB value,
after a write had landed; quoted values are now found by a character scan. A credential glued to the
end of a fixed-length one (`AKIA…ASIA…`) is a credential of its own, so a run of them is masked in one
pass, and a split span glued to the one before it is bounded by it as by an applied mask. Summaries
recognize split shapes with the projection's fixed point. A projection that does not settle becomes
one constant, which would give two different calls one journal digest, so a tiered call whose
journal projection does not settle is refused before its prepare, its argument names masked. The
family also could not export its evidence: one export of its 110 controls measured about 77 MiB
against the unchanged 64-MiB bound, and no author gate exercised the export, because only the
dedicated job sets `RELAVIUM_ACCEPTANCE_EVIDENCE`. It now runs as two shards
([causal-controls](../causal-controls/README.md)), and both ran locally with the export enabled.
Ten controls were added: `core-userinfo-username-zone`, `core-split-zone-cap`,
`core-quoted-value-scan`, `core-standalone-chain`, `core-glued-span-boundary`,
`core-summary-fixed-point`, `core-journal-settled` and `core-unsettled-refusal`, and
`diagnostic-label-run-normalized` and `diagnostic-label-run-raw`, which remove one half of the
nine-label bound each, since removing the whole line (`diagnostic-label-run-bound`, kept) left the
normalized half untested. `core-userinfo-query-zone` is re-anchored and no control is retired.
Pinned by tests without a control: the username zone's colon comparisons, the merged run's
replacement, the fill's merge and order and the place of opaque values among the masks, the key
rule's keyword alternatives, suffix and boundary and the value's delimiters, the quoted scan's escape
and line-break rules, the refused argument names' masking and the helper's settled report. The header
label join's `:` prefilter only skips work whose result is the text unchanged, so the output cannot
show it and it has neither a test nor a control.

The eighth round found that round 7's glued-credential chain could start a narrower family inside a
wider credential or swallow a key name or label after it, and that four older gaps remained. The
chain and its glued-span exemption are gone: a glued credential is read at the earlier mask's
boundary on the next pass, and a run that never settles is redacted and refused. A structured
result's summary is read from its JSON as one text once credential members and flag arguments are
masked whole; quoted values are read one JSON string down, also behind escaped tabs and line breaks,
where an apostrophe opens a value too; a quoted value that does not close on its line, or one JSON
string down before its string ends, is decided once the pass's other masks are known, masked whole
when they join its lines and it closes and otherwise read as an unquoted run from after its quote,
no further than that end, while a summary masks one stopped by a line break through a later quote
that could close it (else to the end of its line) and one that reaches the end of its string or of
the text to that end; two member names that project alike make the journal projection unsettled; a
header label at a line start inside a split continuation is read through a second label view; and
the scrubber's split probe also reads the raw text when terminal normalization changed it. The
round's password-position finding is documented rather than changed: such a key's value runs to the
key rule's delimiter, through a URL's host and path, and calls that differ only there share a
projection, as recognized credentials do. Before the commit the author ran the reviewers' method on
the candidate, and six internal pre-reviews reviewed it. The first found that the draft's
alternatives each opened a gap, and they were dropped: an authority-end rule that trusted a
host-shaped tail revealed a password tail BASE had masked, quoted values that crossed lines took a
quote that closes a string for one that opens a value, and a line-start credential inside a
continuation made the split scan quadratic. The second found that the summary's pre-pass could erase
the key of a nested multi-line value and that JSON escaping hid such values in structured results,
that a value one JSON string down ran across a raw line break behind a backslash, and that two
member names projecting alike dropped a member from the journal identity. The third found that the
round's own additions failed: masking a value that never closes to the end of its line, decided from
the end of the text back, merged the journal identities of calls whose text after a quote that
closes a string around the key differed, so such a value is read as an unquoted run instead (the
author's distinctness oracle then found the same merge one JSON string down, where a value ran to
the end of its string, which now ends its run too); and the scrubber's reading of JSON-escaped tabs
after a header's colon and its view of terminal sequences' final bytes each let a token leak or
blanked coloured diagnostics, so both are withdrawn and their cases documented as limits. The fourth
found that the run, deciding a value in the pass whose other rule also masked its line break, and
the opaque mask's kept backslash showed values that every earlier version masked whole in its next
pass, so such a value is now decided once the pass's other masks are known and the opaque mask takes
the backslash again (the value one JSON string down that needed it is a documented limit); it also
found that a terminal hyperlink to a bare origin before a later `@` blanks a diagnostic through the
raw split probe, now a documented trade-off. The fifth found that projecting a structured result's
strings one by one masked the keys and PEM markers that reading its JSON needs across members, so a
structured summary reads its JSON as one text again and the per-string cache and summary-only runs
over line breaks are withdrawn. The sixth found that the closing view and the summary's closer read
a quote's escape after a nested key's value had taken the backslash before it, which showed a
value's tail that base had masked; that a structured summary's walk took a private-key marker that a
block across members needs; and that a structured summary read no JSON-escaped line break or tab, a
gap base shares. A quoted value now closes at the later of two readings, with the masks before and
inside it filled and with each mask keeping the backslashes it ends with, which also masks the tail
that an opaque value's mask unescaped, behind a URL userinfo (which base masked) or not (which base
showed too); the walk keeps a marker whose partner lies outside its member; and every summary also
reads a view in which each escaped line feed, carriage return or tab is that separator. A structured
summary's walk also became linear in its members at a small constant factor (one media-redaction
walk serves both texts, that walk applies no text rule to a string because the text rules read the
masked JSON once, and the key and label rules skip text that cannot hold them), and a many-part
result takes a case deadline. Core's four eight-MiB cases take the scrubber's case deadline in place
of their wall-clock bounds. `core-standalone-chain` and `core-glued-span-boundary` are removed with
their mechanisms; `core-quoted-value-scan`, `core-joined-original-boundary`,
`core-summary-fixed-point`, `core-key-value-through-masks`, `core-key-value-nested` and
`core-journal-settled` are re-anchored; twelve controls are added (`core-summary-walk`,
`core-escaped-quote`, `core-unclosed-run`, `core-unclosed-closing-view`, `core-continuation-label`,
`core-summary-through-closer`, `core-summary-whole-json`, `core-journal-key-collision`,
`core-escaped-value-start`, `core-summary-escape-view`, `core-summary-pem-markers`,
`diagnostic-split-probe-raw`); and `core-unsettled-refusal` gains an unmocked witness and one for
its whole-projection fallback. Pinned by tests without a control, each killed by its mutation: the
separator before an escaped quote in the key rule; the escaped scan's decoding, its raw line breaks,
also behind a backslash, and the raw quote that ends its string; a plain value's CR and backslash
line ends, a lone backslash at the end of the text and the end of the text that leaves a value open;
the run's start after its quote, its limit at its line's end, its six-character floor and its
delimiters, which unquoted values share, the closing view's reread, its guard on a quote that
another range takes and its second reading, the unquoted values' shared delimiter scan, the key
rule's second reading of a quoted value, the backslashes each mask keeps in it and the later of the
two readings; the raw tab, escaped CR, escaped apostrophe and raw apostrophe behind escaped
separators; the summary's closers (the masked values' coverage, the nearest outside closer, the
furthest masked one, the fill, the text end, the order by end, an escaped value's quote kind, the
closers' backslash parity, even, 4k+1 and 4k+3, and the second reading's closers, masks and escapes
with the later of the two), its fail-closed value, the summary projection in both passes, and the
undefined and unserializable results; the conditions of the key and scheme rules' early exits and of
the second scheme-label read, whose removal is output-neutral; the collision report inside arrays
and under keys; the second label view's first-separator fill, the fill's opening bracket and the `'`
delimiter; the structured summary's walk-only values; the escaped view's line feed, carriage return
and tab, its doubled separator, its run of backslashes and each of the three rules that read it; the
kept markers' first END and last BEGIN, the conditions under which a marker's partner lies inside
its member, and the whole mask through arrays, members and both spellings of a flag argument, with
the journal's and the display's own; the scrubber's host cut at a query or a fragment and the TAB
half of its split retry; and the registry's masked, deduplicated refused names and its
whole-projection fallback. Two and three PEM blocks in one text pin the shared END search's
re-search, whose removal loops until the test worker runs out of memory, so no control can certify
it. Four mutations are output-neutral and have neither a test nor a control: the kept markers'
`-----` prefilter and the two shortcuts that reuse a view when no mask ends with a backslash, which
only skip work, and preferring a second reading that closes at all, since a reading that keeps the
masks' backslashes closes only at a quote where the other reading has closed by then.

The ninth round found two high findings in round 8's own code and eight medium regressions against
base in five shapes. Round 8 compared whole views with `===` inside its loops and walked a run of
backslashes once per mask that ends in it, both quadratic at admitted size: each view of a quoted
value is now built once per pass, its presence a value decided once, and a run's start is remembered
at every end it serves. A value whose line break a scheme label's token takes did not close where
another key's value took its closing quote or ended at its opening one, and a reading closed early
where a filled scheme token would have let it reach its real quote: such a value is now reread with
and without the key rule's own masks, and the key rule's first decision also reads a view with the
masks' backslashes kept and the scheme tokens filled, which only moves a closing that a plain
reading reaches. A summary took one reading's early closing over another reading that stops at a
line break, and now masks such a value through its later closer. A structured summary's walk
replaced credential members and flag arguments before the text rules read the JSON: the summary now
reads the unwalked JSON once, each masked value spliced back where the walk left a private-use
placeholder, with the walk's masks as ranges of that pass, and round 8's kept PEM markers are
withdrawn. A summary's pass before normalization cut a private-key marker that a line break, a tab
or more than one space splits, and a summary now reads such markers. `core-summary-pem-markers`,
`core-summary-whole-json` and `core-unclosed-closing-view` are re-anchored, and
`core-key-value-through-masks` now targets round 7's reading through earlier masks, since the
unclosed value's reread also reads round 6's quoted witnesses; no control is added, and a control
for the later closing is deferred. Pinned by tests without a control, each killed by its
mutation: the quoted value's plain and scheme views, the gate that keeps a scheme view to a closing
a plain reading reaches, and the latest closing; the summary's stopped reading and its later closer;
the unclosed value's views with and without the key rule's masks, their kept variants, the guard on
a view that fills the value's quote and the latest reread; the unwalked reading's placeholders,
whole and inside a string, a value with no JSON form through its `??` fallback, its mask and its
collision guard; the scheme-labelled and argument whole masks; the wrapped markers in the summary
alone, their whitespace between `PRIVATE` and `KEY` and the prefilter; and the opaque parameter in a
URL username. (Corrected after round 10: the no-JSON-form value's try/catch and the whitespace inside
the wrapped markers' type words have no killing test; both gaps are deferred.) An admitted-size case deadline
pins the four quadratic shapes in the journal, display and summary paths; a timeout counts as
infrastructure, so no control can certify it. Five mutations are output-neutral and have neither a
test nor a control: the closing mask of a summary value that also stops at a line break, which its
later closer covers; a kept run's clamp to its range, whose empty ranges a fill skips anyway; and
three shortcuts that keep or reuse a view when no mask ends with a backslash.

The tenth round, the last under the maintainer's round cap, found no high finding. The maintainer
counted one realistic gap that base shares as high: in a structured result's JSON a query value at
the end of a line runs on through the next line's key and takes the backslash of its value's escaped
quote, so a `cat .env` result's password showed in its summary. A summary now opens such a value
where the earlier mask keeps its trailing backslashes; the journal keeps its reading.
`core-quoted-value-scan` and `core-escaped-quote` are re-anchored on the changed lines; no control is
added. Pinned by a test without a control, each killed by its mutation: the summary-only gate, the
kept opening and both of its reading sets. Two mutations are output-neutral and have neither a test
nor a control: the condition that the filled view holds no backslash at the opening and the
condition that the kept view holds one, since a mask the kept view keeps ends before a delimiter,
where a view that keeps the backslashes closes no later than the filled one. The round's other
findings are recorded in deferred-tasks.md.

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
