# ADR-0132: The model can ask the user a structured question mid-turn, and an answer is never consent

- **Status**: Accepted — 2026-11-16, by the maintainer, after four independent design reviews (their findings and dispositions are in the review table at the end). The maintainer ruled three forks: **no timeout**, **the answer is not stored**, and **Esc stops the turn** (skipping a question has its own key).
- **Date**: 2026-11-16
- **Refines**: the Phase 2.6 toolbelt row for `ask_user` ([phase register](../roadmap/phases/phase-2.6-conversational-authoring.md)) — it **replaces** that row's five-minute timeout, its single-choice shape and its `Esc`-dismisses behaviour. [ADR-0120](0120-the-toolbelt-grows-and-a-tool-call-shows-what-it-does.md) had deferred the mid-turn pause to "a separate later ADR"; this is it.
- **Related**: [ADR-0057](0057-cli-chat-modes-and-per-tool-approval.md), [ADR-0095](0095-what-an-agent-session-remembers-across-turns.md), [ADR-0098](0098-a-session-effect-row-holds-no-result-and-never-replays.md), [ADR-0115](0115-one-interrupt-keymap-for-the-interactive-cli.md) (the interrupt keys; the question card follows its approval row), [ADR-0117](0117-a-denied-tool-call-returns-to-the-model.md), [ADR-0119](0119-an-interrupted-turn-stays-as-a-content-free-marker.md), [ADR-0122](0122-the-home-is-the-interactive-product.md), [ADR-0128](0128-content-free-tool-receipts-ground-later-chat-turns.md), [ADR-0129](0129-the-approval-card-is-docked-bounded-and-says-only-what-matters.md), [ADR-0130](0130-chat-modes-ask-prompts-plan-reads-accept-edits-accepts.md), [ADR-0131](0131-a-round-that-made-progress-resets-the-correction-budget.md), [built-in tools](../reference/shared-core/built-in-tools.md#ask-the-user--mvp-3d) (the contract)

## Context

When a request is ambiguous the default chat agent is told to "ask a brief clarifying
question". Today that is prose: the model writes a question, the turn ends, the person
types an answer as a new message. That works, and it stays the fallback. What it cannot
do is offer **choices** — "which of these three files?" — or let the person answer with
one keystroke, and it spends a whole turn (receipts, cost line, history row) on a one-word
reply.

The Phase 2.6 design was a structured mid-turn question: options plus free text on a
keyboard-owning overlay, the engine pausing the turn and returning the answer as the tool
result, a five-minute timeout, and `human_gate` for workflows. It **omits multiple choice
with multi-select**, and it predates three things now in the tree:

- **The delegate mechanism.** A tool can declare an engine *delegate* it dispatches
  through (`requiresDelegate`, [tool-registry](../reference/shared-core/tool-registry.md)); a
  surface that wires none never offers the tool (`CR-73`). `invoke_agent` and `read_media`
  use it.
- **The approval pause.** A governed dispatch already awaits a host promise, the registry
  routes an abort to the **cancel** path, and the chat store holds one pending promise with
  a docked card ([ADR-0129](0129-the-approval-card-is-docked-bounded-and-says-only-what-matters.md)).
- **Content-free history.** A session row keeps a tool call's argument *byte count* and a
  result's *byte count and outcome*, never the content; later turns see only
  [ADR-0128](0128-content-free-tool-receipts-ground-later-chat-turns.md) receipts; a stopped
  turn is retained as a marker ([ADR-0119](0119-an-interrupted-turn-stays-as-a-content-free-marker.md)).

Two things make this more than a widget. **It is a new terminal sink for untrusted
content**: the question, the option labels and the descriptions are written by the model
and painted in the product's own consent-looking chrome. And **the question sits next to
consent**: a model can ask "May I overwrite `config.toml`?" and a person can answer "yes"
believing that authorised it. It must not — the approval card, the mode and the
protected-path floors are untouched by any answer.

## Decision

**Add a built-in tool `ask_user` that pauses the turn on an engine delegate, shows the
person a bounded, host-drawn card, and returns their selection as the tool result. An
answer is data for the model, never a permission.** The tool contract — arguments,
bounds, key behaviour, result shapes and fixed texts — is canonical in
[built-in-tools.md](../reference/shared-core/built-in-tools.md#ask-the-user--mvp-3d); the
decisions below bind its implementation.

### 1. A delegate-backed tool, absent where no one can answer

`ask_user` declares `requiresDelegate: 'askUser'`. The delegate is an optional capability
of the session (`SessionDeps.askUser(request, signal)`), copied into the per-turn dispatch
context; `ToolDelegateName`, the `ToolDelegates` pick and `delegateAvailable` all gain it
(the exhaustive switch stays exhaustive). A surface with a person at a terminal wires it;
every other surface does not, and then **the tool is never advertised** — a plain non-TTY
chat, `--json`, `relavium agent run`, and every workflow node. The dispatch guard stays
authoritative (`tool_unavailable`).

There are **two** advertise gates and both must agree: the engine's `delegateAvailable`
(per turn) and the CLI's `wiredToolIds`, which `narrowToWired` calls on a fresh start and on
resume and which today receives no delegates, so it would drop `ask_user` from the effective
grant even on an interactive driver. The CLI computes **one** boolean — "this driver can
ask" — and feeds it to the session dependency, to both `narrowToWired` calls and to nothing
else.

This is deliberately *unlike* approvals, which deny immediately when nobody can answer: a
denied write is a safe default, a question has no safe default, and a model that is offered
the tool and refused wastes a round. A workflow's counterpart is `human_gate`; granting
`ask_user` to a workflow node is inert, exactly as `invoke_agent` is today. Session export
([ADR-0026](0026-session-export-to-workflow.md)) omits it from a node's `tools:` list (that
list is the union of tools the turn *called*), and the agent snapshot it carries is left
faithful and inert. A delegated child agent (`invoke_agent`, not wired today) never
inherits the delegate: a question from a sub-agent could not be attributed.

The tool is **not governed**: no action class, no approval, no effect journal entry, no
`always`. It mutates nothing outside the process, and routing a question through the
approval hook would make the *mode* decide whether the model may ask. It is available in
all four modes (`plan` is where a clarifying question is worth most) and **the card opens
in every mode, `auto` included** — the mode applies to governed actions only, and nothing
answers a question but the person. It is granted to the default chat agent; a resumed
session keeps the grant it was frozen with.

### 2. The question is small, plain, and the card always fits

One call carries **one to four questions**. Each has a short `header`, the `question`, a
`multiSelect` flag and **two to four options**, each a `label` plus a short `description`.
The host — never the model — adds a final **type-your-own-answer** row to every question, so
the person is never confined to the model's menu and the model cannot suppress, relabel or
pre-fill it. It is drawn with its own glyph (`✎`) and is not numbered, so no option can
stand in for it; a label that is, after normalisation, `other`, that contains `type your
own`, or that begins with `✎` is refused.

**The ceilings are derived from the card, not guessed.** At the 80×24 floor the card has
twelve rows (ADR-0129 §2; `cardRowBudget(24)`): the rule, two key rows, and nine body rows.
The body is *progress/header* (1) + *question* (≤ 2) + *options* (≤ 4) + *type-your-own* (1) +
*the highlighted option's description* (1) = 9. The bounds that make each part exactly
that, in UTF-8 bytes (a code point never occupies more columns than bytes): `header` ≤ 24,
`question` ≤ 150, `label` ≤ 60, `description` ≤ 72. Every model-authored line is
**hard-wrapped by display width** — never word-wrapped, because word wrapping can spend a
third row on 150 bytes — so the row count is `⌈width / 78⌉` and an over-long unbroken word
is broken, not cut. A larger terminal changes nothing; a smaller one gets the approval
card's "terminal too small" state, in which only the stop keys work. A test drives the
maximum admissible call through the real layout at 80×24.

**Plain text, refused rather than repaired.** A model-authored string that contains a
control character (which includes ESC, so every terminal sequence), a line or paragraph
separator, a bidirectional or other format character (zero-width, joiner, tag, byte-order
mark), a private-use, unassigned or unpaired code point, more than three combining marks in
a row, anything not in NFC, leading or trailing whitespace, or that begins with a marker a
list could draw (`1.`, `2)`, `[x]`, `( )`, a bullet) is refused as `invalid_args` — the call
fails and the model retries in plain text. Nothing is escaped, flattened or truncated, so
nothing the person sees differs from what the model sent, and no escape marker can inflate a
line past its row. A label must also be unique within its question after NFC, trimming and
a locale-independent case fold. What this does **not** defend against is stated: look-alike
letters (a Cyrillic `а`), and an approval-sounding header (ADR-0120 accepted the first; the
fixed "not an approval" chrome and the structural guarantee of §6 answer the second).

### 3. The card says what it is, and its keys are not the approval keys

The card is docked in place of the composer (ADR-0129 §1). Its rule row is host-authored
and fixed: **`Question from the agent · not an approval`**, in cyan, never the
approval card's `Approval needed` in warning yellow. Its keys are the question keys, never `[y]`/`[a]`/`[n]`.

Keys (the table with every edge — first question, nothing chosen, empty text — is in the
contract): `↑`/`↓` move the highlight (which starts on the first option; nothing is
pre-chosen); `1`–`4` choose that option, and in a multi-select question *toggle* it;
`Space` toggles in a multi-select question; `Enter` confirms, and a multi-select question
with nothing ticked and no text of its own is refused with a hint; `←` returns to the
previous question; selecting the type-your-own row opens a one-line field. **`s` skips the
whole call** — the model receives `skipped`, the turn continues, and answers already given
are discarded. **`Esc` and `Ctrl-C` stop the turn**, exactly as at an approval card
([ADR-0129](0129-the-approval-card-is-docked-bounded-and-says-only-what-matters.md) is the accepted source;
ADR-0115, still Proposed, will refine `Ctrl-C` outside a card, not at one); the busy line's "Esc stops the turn" therefore stays true and ADR-0129 §6 needs
no amendment. The card owns the keyboard as the approval card does: it is routed before the
composer and before `Shift+Tab`, and it ignores choosing keys until its exact frame has been
acknowledged visible (the measured-frame acknowledgement the approval card already uses), so a
key typed ahead of the card cannot choose; the stop keys work at all times.

The field says, in the row where the highlighted option's description would be, that the
text is **sent to the model**. The person's text is bounded and passed through a finite
secret-shaped-text backstop — the engine's own (`redactSecretShapedText`, applied where the answer is
validated, so every surface gets it), equivalent in intent to the one the `[c]` denial reason uses but
not the same implementation; the model's tool description tells it never to ask for a secret.

### 4. The pause is the approval pause, with no clock

The dispatch awaits the delegate exactly as it awaits `confirm`: one card at a time (tool
calls in a response run strictly in sequence), the abort signal rejects with an `AbortError`
the registry already routes to the **cancel** path, and **there is no timeout** (maintainer,
2026-11-16): a timed-out question would let the model proceed on a guess, in `auto` mode
including the writes that follow it. The wait is the person's time, not the turn's
(ADR-0129 §6: the busy line, the footer's active time). The delegate resolves with an answer
or a skip, or rejects with an `AbortError`; **any other failure is classified fatal and not
retryable** — a retryable class would reopen the card. A store that is sealed or closed
while a question is pending rejects it with an `AbortError`; it never resolves it as a skip.

### 5. What the turn records and what the model gets

- **Every outcome except a stop is a successful, non-error result:** `answered`, `skipped`,
  and `not_asked` (a card was not shown because an earlier skip closed questions for the
  turn, or the per-turn ceiling was reached). Each carries a fixed message where the model
  needs one. They are **not** denials: ADR-0117's text ("ask the user what they prefer")
  would be circular here.
- **The recorded outcome is `ok`.** A result that ran to completion is progress for the
  correction budget, so by ADR-0131 §1 **it resets that budget** — deliberately: the budget
  exists for rounds in which nothing ran, and a question the person answered is not one.
  Repeated `not_asked` results cost a provider round each and end at the existing tool-round
  limit, like any repeated successful call.
- **A skip closes questions for the rest of that turn, and at most three calls open a
  card per turn.** The engine owns both, so every surface behaves alike: the per-turn state
  (`opened`, `skipped`) lives on the dispatch context the session builds once per turn, and
  only a call that actually invokes the delegate counts. Calls refused at validation count
  for nothing.
- **Stopped while a card is open** (`Esc`/`Ctrl-C`): the turn core records the call
  `cancelled` — ADR-0128's "execution state unknown" — and ADR-0119 retains the turn as
  `aborted` when its rule says so, which it does here (a card means the provider already
  returned content). A **session-ending** cancel (`/cancel`, `Ctrl-C` outside a card, the
  process signals) and a crash keep ADR-0119's rollback: nothing is written. No new
  interruption reason.

### 6. The answer is never at rest, and never consent

**Not stored** (maintainer, 2026-11-16). The durable record is what ADR-0095/0098 already
write for every tool: the call's argument byte count, the result's byte count and outcome.
No new column, no migration, no shared schema change, and the person's text never reaches
the database or the event stream. Stated, not hidden:

- The **live transcript** shows an entry — what was asked and what was chosen — built by the
  host from the answer it already holds, and the terminal's own scrollback keeps it, as it
  keeps everything on the person's screen. A **resumed** session shows only the tool row.
- **Later turns** see an ADR-0128 receipt ("`ask_user` ok") and nothing of the answer — not
  even whether it was answered or skipped, because both record `ok`. The tool's description
  tells the model to carry the decision into its reply, which *is* retained.
- `agent:tool_result.outputSummary` is a **fixed, content-free phrase** (`answered 2
  questions`, `skipped`, `not asked`) from a pure, optional per-tool display-summary
  function on the tool definition, called with the tool's own result and nothing else; every
  other tool keeps the derived summary. The tool defines **no preview**, so its tool row
  shows only the name. The question text does appear in `agent:tool_call.toolInput`,
  sanitised, as every tool argument does.

**An answer is never consent.** It creates no cache entry, runs no `onDispatchSucceeded`,
changes no mode and lifts no protected-path or scope floor; it cannot satisfy a fresh-read
requirement. The card's chrome says so in words the model cannot touch. **A "no" is not a
veto either:** in `accept-edits` and `auto` no card follows a write, so an answer *guides*
the model and never *restricts* it — the contract says so, and the tool description says
that approval of writes and commands is requested by the system, not through this tool. The
safety property does not depend on the model complying: no answer reaches an approval path.

### 7. What each part owns

- **`@relavium/core`** — the schemas, request/answer types and fixed texts in one module
  (`packages/core/src/tools/ask-user.ts`, beside the tool, not in `shared`: no event, row or
  wire shape changes), the tool definition, the delegate and its three availability sites,
  the per-turn state and its enforcement inside the tool, the display-summary function and
  its use by the registry, the receipt label (derived from the built-in ids), and the export
  rule. No platform import.
- **`apps/cli`** — a question prompt beside `requestApproval` in the chat store (same
  promise-and-overlay shape and abort handling), the docked card and its key handling in the
  chat and Home views, the transcript entry, and the wiring: the delegate and `wiredToolIds`'
  delegate list are set only on an interactive driver, from one boolean. `DEFAULT_CHAT_TOOLS`
  gains `ask_user` and the default agent's clarifying-question line prefers it for choices.
- **Not here**: a desktop or editor surface supplies the same delegate behind its own card
  when it exists; nothing in the engine assumes a terminal.

## Alternatives considered

- **A run-level suspension (`human_gate`'s machine).** Rejected: it checkpoints and resumes
  across processes. A chat turn is not resumable mid-flight — process death rolls it back
  (ADR-0119) — so the question lives in-process with its turn, as an approval does.
- **The native prompt host** (the select/text primitives used before a chat starts).
  Rejected: it is initiated by the host, has no multi-select, and is a full-screen mount that
  cannot sit over a live turn; the docked card is the surface ADR-0129 built for this.
- **Keep asking in prose.** Rejected as the only path, kept as the fallback.
- **A governed action behind the approval hook.** Rejected: a question is not an action, and
  the mode would decide whether the model may ask.
- **The five-minute timeout.** Rejected by the maintainer: it turns an unanswered question
  into a guess, and in `auto` mode a guess with writes behind it.
- **`Esc` skips the question.** Rejected by the maintainer: `Esc` stops the turn everywhere
  else, so a card where it only skips would let a turn the person meant to stop carry on —
  with writes, in `auto` — and would skip unseen on a terminal too small to draw the card.
- **Store the question and answer.** Rejected by the maintainer for now: it would put the
  person's text in `history.db` and reopen ADR-0095/0128. A later ADR can add it with a migration.
- **Repair model text (escape, flatten, truncate).** Rejected: an escape marker inflates a
  line past its row, truncation answers a question nobody finished reading, and ADR-0117's
  explanation rule cuts at 300. Refusing makes the card's content exactly the model's.
- **Larger ceilings with paging.** Rejected: scroll state inside a consent-adjacent card for
  questions that should be one line.
- **Let the model supply or suppress the type-your-own row.** Rejected: it could trap the person.
- **Partial answers.** Deferred: one clear rule (`s` skips the call) beats a half-filled form.
- **Render the question as markdown.** Rejected: links, emphasis and fences are an
  authority-forging surface in a consent-adjacent card.

## Consequences

### Positive

- A choice costs one keystroke instead of a turn, and the model gets a structured answer.
- Nothing about consent changes: the approval path is not touched, the card says it is not an
  approval, and the safety property holds against a model that tries to use the question as one.
- No migration, no shared schema or event change; a surface without a person never sees the tool.

### Negative

- **The answer lives only in the turn.** Resume shows a bare tool row and a later turn cannot
  see the answer, nor whether there was one. Mitigation: the tool description says so; a
  stored form is a later ADR.
- **The ceilings are tight** (a 150-byte question, 60-byte labels). A model that exceeds one
  is refused and retries. Mitigation: the model-facing description states them.
- **A new sink for model-authored text in the product's own chrome.** The security sitting is
  about exactly this: that no label, description or question can forge a key, a state or an
  approval beyond the accepted look-alike residual, that the layout holds at 80×24 for every
  admissible call, that no answer can reach an approval path, and that the person's text is
  bounded and backstopped.
- **No timeout means a stalled terminal stalls the turn.** An approval already behaves so;
  `Esc` and `Ctrl-C` are the exits.
- **A skip closes questions for the turn**, which can frustrate a person who wanted to skip
  only one. They can still answer in the composer afterwards.
- **A workflow node that grants `ask_user` is silently inert.** The same is true of
  `invoke_agent`; a validation warning for either is a possible later improvement.

### Design review — 2026-11-16

Four independent reviews read the proposal against the code and ADRs. Their findings
overlap heavily; the dispositions below are the author's after verifying each against the
code. Severities are the reviewers', re-judged.

| Finding | Disposition |
|---|---|
| The worst-case card (512-byte question, 256-byte description) needs ~18–24 rows against a budget of 12 (every review; **blocker/high**) | **Fixed.** Ceilings re-derived from the row budget (§2); hard wrap; a test at 80×24. |
| `Esc` declines while it stops the turn everywhere else (three reviews; high) | **Fixed by the maintainer's ruling:** `Esc`/`Ctrl-C` stop; `s` skips (§3). The busy line and ADR-0129 §6 stay true. |
| A model label can clone the host's "Other" row; labels can forge `1)`/`[x]`; no fixed "not an approval" line | **Fixed** (§2, §3): own glyph, unnumbered, reserved labels, marker-prefix refusal, a fixed rule row. Look-alike letters accepted (ADR-0120). |
| The delegate has no carrier, and the CLI's `wiredToolIds` is a second advertise gate (two reviews) | **Fixed** (§1, §7): `SessionDeps.askUser`, the `ToolDelegates` pick, both `narrowToWired` calls, one boolean. |
| "The engine owns" the ceiling and skip with no mechanism; refusals as `isError` have no producer (two reviews) | **Fixed** (§5): per-turn state on the dispatch context; every non-stop outcome is a successful result, so no error class is needed. |
| A decline "does not spend" the correction budget — it resets it | **Stated** (§5). |
| "Session ending" is recorded `cancelled` (three reviews); `Ctrl-C` "stops the turn, as everywhere" | **Fixed** (§5, §3): turn abort retains; session-ending cancel and a crash roll back; `Ctrl-C` outside a card ends the session. |
| Sanitiser mis-cited; ADR-0117's rule truncates at 300 and the visible-escape rule inflates a line | **Fixed** (§2): refuse, never repair. |
| `invalid_args` cannot "name the bound" (the registry reports field paths only) | **Fixed:** the contract names the field path; the description states the bounds. |
| The summary hook is unspecified; `not asked` was unreachable; the tool row must not carry the question | **Fixed** (§6, contract): a pure function of the result; `not_asked` is now a result; no preview. |
| Free text from the person can carry a secret; no disclosure | **Fixed** (§3): disclosure row, backstop, description forbids asking for secrets. |
| Empty answers, digit keys in multi-select, `←` on the first question, highlight vs choice, empty text | **Fixed**: the contract's key table. |
| Export "grant" is really the union of called tools; existing sessions keep frozen grants | **Fixed** (§1). |
| "Three questions" text is a count of calls; fixed-text module location; delegate type's agent name | **Fixed** (contract; §7; the card carries no agent name). |
| Receipts cannot tell answered from skipped | **Accepted and stated** (§6, Negative). |
| Registry non-abort throw is retryable and would reopen the card | **Fixed** (§4). |
| The native prompt host is not discussed; the phase register still shows the old design; ADR-0115 not related | **Fixed** (Alternatives, Related; the register's old row is annotated). |

### Acceptance note — 2026-11-16

Accepted by the maintainer. The increment touches a consent-adjacent path and adds a
terminal sink for untrusted content, so [D64](../roadmap/current.md)'s rigor tier applies:
one new complete cumulative round with no blocker, high or medium finding, and a separate
security sitting, before the maintainer accepts the implementation.

### Implementation and its reviews — 2026-11-16

Built as the ADR says, with these deviations from the text accepted above, each found by the implementation's own review
rounds (four independent reviewers — engine, CLI, documents-and-tests honesty, and a separate security sitting on a stronger
model) and each recorded in the [contract](../reference/shared-core/built-in-tools.md#ask-the-user--mvp-3d):

- **The own-answer field ends the question in both kinds.** The accepted contract said a multi-select field returned to the
  list; in use that left `Enter` reopening the field, so accepting text now ends the question and the ticks already made are sent
  with it. `↑` leaves the field keeping a draft, which is how a person ticks more after typing. An **empty** `Enter` clears
  text accepted earlier, so a multi-select question can return to ticks only.
- **The host owns column 0.** The security sitting forged a convincing option row at a wrap boundary using plain ASCII, which
  §2's start-of-string marker rule could not stop. Model rows now sit behind a host gutter `│ `, and the host's own glyphs, tick
  shapes and the approval keys are refused **anywhere** in model text. The same sitting found that default-ignorable and
  non-ASCII-space characters defeated the "invisible characters are refused" promise, and that one grapheme can be 100 columns
  wide: both are now refused, with a four-code-point cap per grapheme.
- **A key needs a settled frame.** The measured-frame acknowledgement proves a flush, not that a person could read the card, so a
  held Enter answered every question with its first option. A choosing key now also waits 250 ms after a question first shows; the
  store mints a new frame token for each question and on every resize or resume, so a blocked card recovers when the terminal is
  enlarged and a key typed right after `fg` cannot choose. The stop keys never wait.
- **A skip is not a veto, and the card now says so** in `accept-edits` and `auto`, where no card follows a write.
- **The host's answer is shape-checked before it is read**, `displaySummary` is honoured for built-ins only and clamped, and both
  delegate fields (`askUser` and `askUserTurn`) gate the offer.
- **The plain-text rules are stated to the model**, because the registry reports only the field path of an invalid argument.

Recorded and **not** changed: look-alike letters (accepted by ADR-0120); an approval-sounding header (the fixed rule row and the
structural guarantee answer it); a delegate that ignores its abort signal makes `Esc` dead (the same trust model as the approval
hook); the tool's own `signal.aborted` check duplicates the registry's cancel routing (a redundant defence); `Esc` at a card with
no `onAbort` wired does nothing (production always wires it); `Ctrl+T` is consumed by an open card, so a long expanded thinking
panel that blocks the card in the inline renderer cannot be collapsed until the terminal is enlarged. The guard that keeps the mouse wheel and selection from acting while a card is open (a cosmetic parity with the approval card) is not covered by a test.
