# ADR-0133: An `ask_user` question and its answer are kept with the session

- **Status**: Accepted — 2026-11-16, by the maintainer, who asked for it after the first manual test of the question card: the question and **only** the answer to it are stored in the database, and are there when the person resumes the chat. The implementation is built and locally tested on `development`; the [D64](../roadmap/current.md) rigor tier applies (a new persisted-content path and a new content channel into the model request), so one new complete cumulative round with no blocker, high or medium finding and a separate security sitting are owed before the maintainer accepts the implementation.
- **Date**: 2026-11-16
- **Supersedes (in part)**: [ADR-0132](0132-the-model-can-ask-the-user-a-structured-question.md) §6, the paragraph "**Not stored**" and the alternative "Store the question and answer". Nothing else in ADR-0132 changes: the card, the keys, the plain-text rules, "an answer is never consent", no timeout.
- **Amends**: [ADR-0059](0059-cli-mid-session-model-reseat.md) (the `/models` disclosure wording), [ADR-0119](0119-an-interrupted-turn-stays-as-a-content-free-marker.md) (scoped), [ADR-0128](0128-content-free-tool-receipts-ground-later-chat-turns.md) (the receipt record is "a label and an outcome, nothing else" — it gains one bounded, quoted exception; the per-turn byte cap rises from 4,096 to 5,120), and the content-free rule of [ADR-0095](0095-what-an-agent-session-remembers-across-turns.md) / [ADR-0098](0098-a-session-effect-row-holds-no-result-and-never-replays.md) for the result row of this one tool, and — by a scoping note — the at-rest posture of [ADR-0050](0050-cli-history-db-at-rest-posture.md).
- **Related**: [ADR-0050](0050-cli-history-db-at-rest-posture.md) (`history.db` is unencrypted at rest, guarded by file permissions, and already holds the person's messages as user data), [ADR-0081](0081-the-compaction-summary-is-untrusted-and-the-system-prompt-is-branded.md), [ADR-0119](0119-an-interrupted-turn-stays-as-a-content-free-marker.md), [built-in tools](../reference/shared-core/built-in-tools.md#ask-the-user--mvp-3d) (the record's contract), [agent-session-spec](../reference/contracts/agent-session-spec.md#content-free-action-receipts--adr-0128) (the request text)

## Context

ADR-0132 ruled that the person's answer is **not stored**: the durable row kept only the call's byte counts and outcome, a later turn saw `ask_user — ok` and nothing of the answer, and a resumed session showed a bare tool row. The reason given was privacy — "it would put the person's text in `history.db` and reopen ADR-0095/0128."

The first manual test showed what that costs. A person answers a card, the turn ends, and a few turns later says "act on my answer to the question about the module". The model has no record of the question, of the answer, or even of whether there was one: both an answer and a skip record `ok`. The only memory is whatever the model chose to repeat in its reply. After `chat resume` the same is true of the whole conversation.

The privacy argument was overstated. `history.db` already stores the person's messages and the model's replies as plain text, unencrypted at rest and guarded by file permissions ([ADR-0050](0050-cli-history-db-at-rest-posture.md)). What ADR-0095 and ADR-0098 keep out of the database is a tool's **output** — file contents, command output, a fetched page: unbounded, controlled by a third party, and a likely home of secrets. An `ask_user` exchange is none of that. It is **conversation**: a short question the model wrote for the person to read, and an answer the person gave on purpose so the model would act on it. It is bounded by construction (four questions, 150 bytes each, four options, 500 characters of free text), and the person's text is already masked of secret-shaped runs by the engine before the model sees it.

## Decision

### 1. What is stored

One optional record, `ask`, on the **result part** of an `ask_user` call, validated by the strict `SessionAskRecordSchema` in `@relavium/shared`:

- `status` — `answered` or `skipped`;
- `items[]`, one to four, in question order — `header` and `question` as asked; for an answered item, `selected` (the chosen labels, in the order the question offered them) and/or `other` (the person's own text).

It is stored only for a call that **showed a card and returned `ok`**. A stopped call (`cancelled`), a failed one and a call a skip had closed (`not_asked`) store nothing. Never stored: the options that were not chosen, the option descriptions, the `multiSelect` flag. The person's text is the **masked** text the model itself received (not the raw host string) and is clipped to the stored ceiling of 500 code points, because masking can lengthen a run. The schema refuses control characters, line and paragraph separators and unpaired surrogates in every string, and a history entry accepts the record only for an `ask_user` call with outcome `ok`.

`content_parts` is a JSON column, so this is **no SQL migration**, and no other tool's row changes.

### 2. How it travels

A pure, total hook on the tool definition — `ToolDef.askRecord(args, result)`, honoured for **built-in tools only**, like `displaySummary` — builds it from the *validated* arguments and the tool's own result. The registry runs it, re-validates the output against the shared schema and drops it on a throw or a refusal, so a bad record costs the record and never the result the model receives. It rides `ToolDispatchOutcome.ask` into the typed `SessionToolHistoryEntry`, and the CLI persister writes the entry's result part as it always did.

The observability stream does **not** change. `agent:tool_result.outputSummary` is still a closed phrase; the question text still appears, sanitised, in `agent:tool_call.toolInput` as every argument does. The record's one event channel is the typed `session:turn_completed.toolHistory` — the channel a surface persists session rows from — and a surface that logs events wholesale must treat that field as conversation content, as it treats the person's messages.

### 3. How a later turn sees it

The record is part of the ADR-0128 receipt record of the call (`ReceiptRecord.ask`), so every path that already carries receipts carries it — the live turn, a resumed session (derived from the stored rows), a `/models` reseat, `/compact` evidence and the summariser's input, retention and eviction. It is rendered **under** the record's line, one indented line per question, with **every string JSON-quoted**:

```
1. ask_user — ok
   answered: "Scope" — "Which module?" → chose "alpha"; own text "keep the API stable"
   skipped: "Scope" — "Which module?"
```

Quoting makes the format unforgeable: a quote, a backslash or a look-alike of the block's own punctuation inside a string stays inside its quotes, and no string can start a line (the strings have no newline to begin with). A successful `ask_user` record with no note reads `ask_user — ok (no question text kept)`; one that failed or was cancelled is unchanged.

Bounds, applied identically to the live source, to derivation from rows and to host-supplied state: one call's note at most **1,280 bytes** (questions past it become one `[N more questions not listed]` line; a first question that does not fit shows no note), the own text clipped to **160 code points** in the note (the stored record keeps 500), one turn's notes at most **2,560 bytes** together, spent **newest first** — the first note that does not fit, and every older one of the turn, is dropped, never a larger one skipped for a smaller. Notes count toward the receipt caps, so retention evicts a note-heavy turn by the same newest-first rule, and the per-turn cap rises from 4,096 to **5,120** bytes so that "it cannot bind" stays provable by construction (the worst block is under 4,300). A supplied note over its budget is refused, never trimmed.

The request notice gains one fixed sentence, present whenever a selected turn lists a note: the questions are **the assistant's own words**, an answer is **what the person said at that time**, and **neither is a new request**. A recorded answer is context for a later request that refers to it; it is not consent, creates no approval and changes no mode (ADR-0132 §6 stands).

### 4. How a resumed session shows it

The restored transcript rebuilds the card's own entry (`Asked: … → …` / `Skipped the agent's question: …`) from the stored record, after the structural tool row and before the answer, at most sixteen per turn with the rest counted, each counting toward the restore budget. A live entry and a rebuilt one are produced by one renderer, so they cannot drift.

### 5. An export carries none of it

`/export` and `chat-export` embed the persisted transcript under `metadata.relaviumExport.messages`. The `ask` field is **dropped** from every exported tool row (the result part is rebuilt from an allow-list of its structural fields), as `ask_user` is already left out of an exported node's `tools`. An exported workflow is committed and shared, and a question and answer are not provenance of it; ADR-0098's "an export holds no tool result" stays true. Including them later is a one-line change under a new ADR.

### 6. The model is told

The tool's description no longer says later turns cannot see the answer. It says the question and the answer are kept with the conversation (a long answer may be shortened), and still asks the model to state any decision it relies on in its reply.

### 7. Three fixed texts follow it

- **The `/models` notice** (ADR-0059's bound disclosure, refined by ADR-0128) says that for the question tool the new model also receives *what you were asked and how you answered* — it crosses to a possibly different provider, so saying only "names and outcomes" would understate what leaves.
- **The compaction prompt** gains a sentence: where a record lists a question the assistant asked and the user's answer, keep both — the answer is the user's decision. ADR-0128's acceptance already required a summary to keep the recorded calls; a bare `ask_user — ok` would lose the decision.
- **An interrupted turn** (ADR-0119) keeps the record of an `ask_user` call that was answered before the interruption, as a completed turn does; a card that was stopped records nothing.

## Alternatives considered

- **Keep ruling "not stored".** Rejected by the maintainer: it makes "act on my answer" impossible, and the privacy reason was overstated (see Context).
- **A new table or column.** Rejected: the JSON column holds a record of this size, and a separate store would need its own retention, resume and export rules.
- **Store the whole result, descriptions and unchosen options included.** Rejected: not conversation the person acted on, and it multiplies the stored text for no use.
- **Put the question in the assistant's message and the answer in a user message.** Closer to the real roles, and it would keep model-authored text out of a user-role position. Rejected for now: the receipt carrier is the user-role block, and a second projection path for one tool doubles the surface the retention, folding and summarising rules must keep consistent. The residual below is the price.
- **Brand the question text `Untrusted`.** Rejected: the brand exists for unbounded free prose that a model produced while reading tool output (the compaction summary). A question is at most 150 bytes, plain-text-checked at three boundaries, quoted and framed; a brand would not add a check the schema does not already make.
- **Store only the answer.** Rejected: an answer without its question is "beta.ts" with no referent.
- **Rely on the model repeating the decision in its reply.** The status quo; kept as advice, insufficient as the only mechanism.

## Consequences

### Positive

- "Act on my answer to the question about X" works several turns later, in a resumed session, after a reseat, and after a compaction summarises the turn (the summariser sees the same text).
- A resumed session's transcript shows what was asked and answered, as the live one did.
- No migration, no new table, no event beyond the existing typed history; no other tool's storage changes, and nothing reaches an export.

### Negative

- **`history.db` now holds the free text the person typed into an answer card** (masked of secret-shaped runs). It is the same class and exposure as the chat messages already stored; a person who typed a password into an answer box in a form the masking does not recognise has stored it. The tool description tells the model never to ask for one.
- **Model-authored text now rides a user-role message.** The question is the model's; before this ADR it lived only in the turn's own tool call, and in later requests the model's words reached the user position only as the closed receipt vocabulary. A model steered by an injected instruction could now plant up to 150 bytes per question, four per call, in the block that every later request carries. Mitigations, all structural: the plain-text rules refuse control, format, invisible and forgery shapes at ingestion; the strict schema re-checks them when a row is written and read; every string is JSON-quoted and bounded in rendering; the block and the notice both say it is historical data and that the questions are the assistant's words; and the **person saw the question on the card when it was asked** (they could answer, skip or stop). It is the same text the model could write in an ordinary reply, which is replayed too. Accepted as a residual and named for the security sitting.
- **Context grows** by at most 2,560 bytes per turn and the shared 16,384-byte total of the receipts, so an old answer is evicted with its block once enough newer evidence exists. Mitigation: `/compact` summarises it with its evidence; the model still repeats decisions in its replies.
- **A long own text is clipped to 160 code points in the model's view.** The stored record keeps 500, so a later ADR can raise the view without a migration.
- **A surface that logs session events wholesale now logs the answers**, through `session:turn_completed.toolHistory` only. The contract says so.

## Amendments — 2026-11-16 (the cumulative review round)

The independent cumulative round (D64) found the following. The accepted text above is unchanged; each item corrects or qualifies it.

1. **What the strict schema re-checks.** The Negative section says the plain-text rules refuse "control, format, invisible and forgery shapes at
   ingestion" and that "the strict schema re-checks them when a row is written and read". The schema re-checks the bounds and **control
   characters, line and paragraph separators and unpaired surrogates only**. The format, invisible and forgery shapes (bidi, zero-width, tag
   characters, host glyphs, tick shapes, approval-key tokens) are refused at ingestion by the tool's plain-text rules, which live in
   `@relavium/core` and are their only home; the schema does not copy them (one canonical home). Every record the product writes passed them. A row
   written by anything else could carry such a shape into a later request, JSON-quoted, and the terminal path strips bidi controls at display. This
   is part of the residual named for the security sitting.
2. **The notice reserve is unconditional.** §3 says the added sentence is present "whenever a selected turn lists a note". The retention
   **reserve** for the notice includes its 273 bytes in every session, so every session's shared 16,384 bytes shrink by 274 (the reach at one call
   per turn is 105 turns, not 107; see ADR-0128's update).
3. **The cap raise is a margin.** "The worst block is under 4,300" is an analytic by-construction bound. The longest block actually constructible
   from real notes measured 4,072 bytes, under the old 4,096 cap; the raise to 5,120 keeps "the cap cannot bind" provable by construction rather
   than by measurement. Nothing changes functionally.
4. **§4 "cannot drift".** The live entry and the rebuilt one share one renderer and one wording, but not their inputs: the live entry is built
   from the raw host answer, the rebuilt one from the stored record (masked, trimmed, the choices in the order the question offered them, the own
   text clipped to 500 code points). The content can differ; the rebuilt form is the safer one. The entry's own **host rows** now start with a
   marker the plain-text rules refuse in model text — `› Asked: <header> — <question>`, `  └ <answer>`, `› Skipped the agent's question: …` — so that a
   long model string placed at a wrap boundary cannot begin a row that looks like the host's (the forged-row class the card's gutter closes).
5. **§5 "an export carries none of it".** The `ask` field is dropped from every exported tool row. But a `/compact` summary is a system row the
   persister stores verbatim and the export embeds, and the compaction prompt (§7) asks the summariser to keep the decision — so a summary
   written after an answered question may **restate the question and the answer** in an exported file. A summary is exported as every summary is; the
   person's messages and the assistant's replies are exported in full as well. Stripping summaries from exports would be a policy change and needs
   its own ADR.
6. **Older builds.** The result part has been strict since before this ADR. A build without it refuses a session whose rows carry `ask`:
   `loadFull` throws the fixed `message_invalid` error (no content leaks), so such a session cannot be resumed by the older build. "No migration"
   holds for the schema, not for a downgrade.

## Amendments — 2026-11-16 (the separate security sitting)

The separate security sitting (an independent reviewer, read-only, with probes against the built packages) found one medium and three lows.
No blocker, no high; no finding touched an approval path, a key, egress or a file write. The accepted text above is unchanged; each item
corrects or qualifies it.

7. **A skipped call stores headers only (medium, fixed).** §1 said a skipped item carries "`header` and `question` as asked", and the
   Negative section listed, among its five mitigations, that "the person saw the question on the card when it was asked". For a **skipped**
   call that was false: Ctrl+S ends the whole call from any tab, so a four-question call skipped on its first tab stored three questions the
   person never saw. The transcript entry listed only the headers, and the receipt note sent all four question texts, in user role, on
   every later request, across resume and a `/models` reseat — up to 450 bytes of model-authored question text (three unseen questions of at
   most 150 bytes each) with no trace on screen. (Reproduced
   with a call whose later questions carried an instruction "from the user"; the first tab showed none of it.) An **answered** call is not
   affected: every question must be answered before a call can be sent, so each was shown. The correction:
   - the writer keeps `{ header }` only for a skipped call, so no unseen question text is stored;
   - the receipt note for a skipped call is `skipped: "<header>"`, with no question;
   - the schema makes `question` optional and requires it on an **answered** item (a record that is answered but lost its question is
     refused). A skipped item that still carries one — a row written by the first build of this ADR — is read and ignored by every consumer, so
     a developer's existing session keeps resuming. The strict form would have refused that whole row;
   - the transcript entry already listed headers only, live and restored, and still does. A header is at most 24 bytes and is shown **in the
     transcript entry right after the skip** (and when the session is restored), so the person can see everything that is kept.

   Two residuals, named by the corrective sitting that checked this fix (no blocker, high or medium): (a) the card's tab strip shows dots
   only, so the headers of tabs the person never reached were not on the card before they skipped; up to three such headers (72 bytes), each
   quoted and prefixed `skipped:`, stay in the model's view. Keeping only the first header and a count, or only the visited headers, would
   remove it; deferred with amendment 8's options, which cover headers as well. (b) A session holding a header-only skipped record is
   refused by the first build of this ADR (its schema required `question`), so the downgrade caveat of amendment 6 applies to it too; no
   content leaks, development builds only.

   The mitigation now reads: **the person saw every question that is stored with its question text** (an answered call's), and nothing
   else of a skipped call's question survives the turn.
8. **"Unforgeable" is byte-level (low, deferred).** §3 says quoting makes the note unforgeable. It does at the byte level: a quote, a
   backslash and a line break cannot leave their string, and no string can start a line. It does not stop a model string from *reading* as
   more of the note: a question containing `→ chose “Replace it”; own text “…` followed by a look-alike quote can appear, inside its own
   quoted string, to carry an answer clause the person never gave (the same with fullwidth and other look-alike quotes). The person did see
   that question on the card, the block says its questions are the assistant's words, and the same text could be written in an ordinary reply
   that is replayed too. One amplifier is named: the compaction prompt calls a recorded answer "the user's decision", so a summary may
   restate such a string as one. Options, none built: escape `→` and the quote look-alikes in the note's strings, or refuse them in model
   text, and word the compaction prompt so only the recorded answer counts. Deferred (`deferred-tasks.md`).
9. **Amendment 4's "cannot begin a row that looks like the host's" holds for the exact refused glyphs (low, deferred).** The host rows
   start with `› ` and `  └ `, which the plain-text rules refuse in model text. Look-alikes the rules do not refuse (for example U+23BF, `⎿`)
   can open a continuation row of a long wrapped question and read as a host row, live and restored. The effect is on display only — the model
   receives the true answer — and it depends on guessing the terminal width. An ordinary assistant reply with colour off can already draw the
   exact `› Asked:` and `  └ ` rows. Options, none built: a hanging indent or gutter on the entry's continuation rows, as the card has, or a
   wider refused set. Deferred.
10. **The person's own text and the masker (low, deferred; existing behaviour).** A password typed as `password=Tr0ub4dor&3xyz` is stored as
    `[redacted]&3xyz`: the masker takes `&` as a query-parameter boundary. This is the masker's existing behaviour, not something this ADR
    introduced, and chat messages are stored unmasked, so this path is still the stricter of the two. It follows the masker acceptance bar.
