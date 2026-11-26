# Deferred tasks — confirmed review findings not yet actioned

> Status: Living

> Last updated: 2026-11-26 — a new section, [MVP-11 unit 6 follow-ups](#mvp-11-unit-6-follow-ups-2026-11-26), holds what unit 6's two review rounds left open on purpose. Earlier: 2026-11-24 — a new section, [MVP-11 follow-ups](#mvp-11-follow-ups-2026-11-24), holds the open sub-questions and the spike evidence still owed. Also 2026-11-24 — [PR #102](https://github.com/HodeTech/Relavium/pull/102) is merged (`c17e9763`): the entries that listed the full gate and the build as owed are closed with the run that met them (the Windows runbook rows stay owed), the three stray fixture directories were removed, and one entry holds the 138 intentional SonarCloud smells that need a maintainer's mark on `main`. Also 2026-11-24 — five entries that named the "common-language increment" now name [MVP-11](phases/mvp-11.md) (the legend builder move, the legend rewording, the glyph-only node rows) or say that nothing owns them yet (the gate-notice rows, the agent strip row). Also 2026-11-24 — the PR #102 review and its three security sittings are in [their section](#pr-102-review-2026-11-24--findings-answered-refuted-and-deferred); four older entries are closed in place (the append-only files' symlink window, the cross-process gate-resolve TOCTOU, a symlinked destination file under `--force`, the pricing sentence), and three carry an update. Earlier: 2026-11-23 — the MVP-8 step 5 reviews are in [their section](#mvp-8-step-5-review-2026-11-23--what-the-reviews-closed-and-what-is-left-open). Earlier: the MVP-8 step 4 review round 1 is recorded in [its section](#mvp-8-step-4-review-2026-11-23--round-1-closed-by-the-fixes-and-what-is-left-open), and rounds 2 to 4 in [theirs](#mvp-8-step-4-review-2026-11-23--rounds-2-to-4-closed-by-the-fixes-and-what-is-left-open). 2026-11-22 — the 38 smells PR #101's own lines introduced are refactored (`c27a350c`) and 149 false positives are marked on `main`; see [SonarCloud gate on PR #101](#sonarcloud-gate-on-pr-101-2026-11-21) and the [Sonar cleanup before MVP-8](phases/phase-2.6-conversational-authoring.md#sonar-cleanup-before-mvp-8-2026-11-22). 2026-11-21 — PR #101 (MVP-4) is **merged to `main`** (`0a599a36`; the [merge checkpoint](phases/phase-2.6-conversational-authoring.md#pr-101-merge-checkpoint-2026-11-21) owns the evidence); its Sonar gate fix and the 47 smells left on purpose are in [SonarCloud gate on PR #101](#sonarcloud-gate-on-pr-101-2026-11-21). Earlier the same day PR #101 was opened and its review (three reports) answered: the new section [PR #101 review (2026-11-21)](#pr-101-review-2026-11-21--findings-answered-refuted-and-deferred) holds what stays open, and the entries it closed (the ADR-0117 protected-path split, the allowlist widening in `auto`, `reduceApprovalKey`) are marked below. 2026-11-19 — PR #100 (native adapter Inc 1, CI once per commit, the narrowed coverage run) is merged to `main`; the native adapter entry, the C4 entry and the PR #99 merge CI observations carry the update. 2026-11-18 — the register is now three files, every checklist entry carries one of three markers, and a stale-entry sweep reworded or closed the entries listed in [Sweep of 2026-11-18](deferred-tasks-history.md#sweep-of-2026-11-18). PR #99 (MVP-3) is merged to `main`; the CLI MVP still comes first (maintainer, 2026-10-26) and Wave 3 Steps 9c–19 stay pending, not declined. The header text that stood here before is kept in the [closed record](deferred-tasks-history.md#earlier-file-headers-verbatim).

- **Related**: [current.md](current.md), [README.md](README.md), [phases/phase-0-foundations.md](phases/phase-0-foundations.md), [phases/phase-2.5.5-hardening-and-remediation.md](phases/phase-2.5.5-hardening-and-remediation.md)
- **Register files**: [deferred-tasks-parked.md](deferred-tasks-parked.md) · [deferred-tasks-history.md](deferred-tasks-history.md)

A holding pen so confirmed-but-deferred findings don't get lost. Every item here was
**adversarially confirmed** by a comprehensive review (the Phase-0 97-agent workflow, or a
later per-PR review pass) but was deliberately **not** fixed in that pass — either because it
needs a maintainer decision, is below the bar for its pass, or is an optimization whose
risk/benefit favors waiting. None block a shipped milestone. Pick them up opportunistically
(most fit naturally into the work that first touches the file) or in a dedicated hardening pass.

Severity is the review's verified rating. Check an item off in the PR that resolves it.

## How to read the register

The register is split by what a reader needs to do with each entry:

| Marker | Meaning | What to do |
|--------|---------|------------|
| `- [ ]` | **Open.** Needs work or a decision, and either has an owner or a deadline (`Scheduled → …`, a pulled-in MVP step, a recorded ruling such as *before v0.2.0*) or has no trigger recorded. | Pick it up, schedule it, or write down the trigger. |
| `- [~]` | **Parked.** The entry (or the intro of its section) names its own trigger — *approved deferral*, *named limit*, *Trigger*, or *Trigger for every entry: the next change to the file it names*. | Nothing until the trigger fires; then it becomes `- [ ]`. |
| `- [x]` | **Closed** — done, superseded or declined. Plain `- **DONE …**` / `- **DECLINED …**` bullets mean the same. | Nothing. Closed entries move to the closed record at the next sweep; in the parked file they stay with the round that closed them. |

The marker is the authority; the file is a reading aid. An entry is parked only on the evidence of its own text — no trigger was invented for
this split, and an entry without one stays `- [ ]`. A bullet with no marker inside a narrative section is a list member, not an entry.
A step of the paused Wave 3 counts as a **trigger** when the section intro names it as one (for example "Step 9d for the two release entries") and as an **owner** when
an entry names it only as its destination ("Low, for Step 10a"); owners keep `- [ ]`.

**Changing state.** Mark an entry `- [x]` in the PR that resolves it; the next sweep moves it to the closed record. When a parked entry's trigger fires, change
`- [~]` to `- [ ]` and name its owner.

**Position words.** Entries written before 2026-11-18 say "above", "below" or "the entry above" about the register as one file. Where the target now
sits in another file those words are stale: the target's section heading is the same in every file, and the places where an open entry would mislead
carry a bracketed *[Moved 2026-11-18 …]* pointer. Prose elsewhere that says "recorded in deferred-tasks.md" may mean any of the three files; search all three.

| File | Holds | Entries (`[ ]` / `[~]` / closed) |
|------|-------|-----------------------------------|
| **This file** | Decisions needed, the watch list, and the active sections: Phase 1/2 forward-obligations, the Phase 2.6.5 residuals other than the deferrals and `W3`, the PR #95 review, the older per-phase follow-ups, Sonar, carry-forward and the MVP-3 / PR #99 entries. | 177 / 10 / 0 |
| [deferred-tasks-parked.md](deferred-tasks-parked.md) | Review-round ledgers (Wave 3 Steps 9a/9b, NI, PR #95 masker, PR #96, MVP-1, PR #97), the Phase 2.6.5 deferrals and `W3` residuals, the Windows file-identity limits, and the narrative entry on rename / move / delete for the default chat agent. | 9 / 270 / 24 |
| [deferred-tasks-history.md](deferred-tasks-history.md) | Sections closed in full, and the closed entries of the active sections kept in the front door (the parked ledgers keep their own). | 0 / 0 / 66 |

Counts are as of 2026-11-18; an entry that bundles several numbered points counts once, so the real number of points is higher.

## Watch list

Entries that matter most whatever file they sit in: every entry rated **High**, every entry a recorded ruling owes **before v0.2.0**, and every other entry still `[ ]` inside the parked file. Compiled from the register on 2026-11-18, not generated on every edit; if it disagrees with an entry, the entry wins. [current.md](current.md#next-work--the-cli-mvp) lists the same v0.2.0 obligations from the roadmap side.

| Rating / state | Entry | Where |
|----------------|-------|-------|
| High · open | Bound the host persistence seam, or decide what a run may do when it cannot learn whether its own write… | [Phase 2.6.5 W2 residuals (ADR-0085, 2026-08-25)](deferred-tasks.md#phase-265-w2-residuals-adr-0085-2026-08-25) |
| High · open | Anthropic redacted_thinking replay | [AgentRunner (1.O) / reasoning-replay follow-ups](deferred-tasks.md#agentrunner-1o--reasoning-replay-follow-ups) |
| High · open | The MCP schema compiler's denylist silently DROPS unsupported assertions | [Schema / validation hardening](deferred-tasks.md#schema--validation-hardening) |
| High · open | Carrying tool history into the model's context (CR-70). | [Phase 2.6.5 deferrals — CR-93 and CR-95 (long half), recorded…](deferred-tasks-parked.md#phase-265-deferrals--cr-93-and-cr-95-long-half-recorded-2026-09-06-cr-70-cr-94-remainder-and-the-in-turn-overflow-continuation-recorded-2026-09-14-the-errored-or-aborted-turn-residual-the-pre-upgrade-free-page-bytes-and-the-estimators-calibration-recorded-2026-09-18) |
| High · parked | Recovering a context overflow that arrives after a tool round (the in-turn continuation). | [Phase 2.6.5 deferrals — CR-93 and CR-95 (long half), recorded…](deferred-tasks-parked.md#phase-265-deferrals--cr-93-and-cr-95-long-half-recorded-2026-09-06-cr-70-cr-94-remainder-and-the-in-turn-overflow-continuation-recorded-2026-09-14-the-errored-or-aborted-turn-residual-the-pre-upgrade-free-page-bytes-and-the-estimators-calibration-recorded-2026-09-18) |
| High · parked | A mid-tool-loop budget pause replays the whole loop (CR-95, long half). | [Phase 2.6.5 deferrals — CR-93 and CR-95 (long half), recorded…](deferred-tasks-parked.md#phase-265-deferrals--cr-93-and-cr-95-long-half-recorded-2026-09-06-cr-70-cr-94-remainder-and-the-in-turn-overflow-continuation-recorded-2026-09-14-the-errored-or-aborted-turn-residual-the-pre-upgrade-free-page-bytes-and-the-estimators-calibration-recorded-2026-09-18) |
| Owed before v0.2.0 · open | Chord answer keys: security sitting residuals (2026-11-17; no blocker, high or medium). | [MVP-3b, MVP-3c, MVP-3d and the PR #99 reviews (2026-11-16 to…](deferred-tasks.md#mvp-3b-mvp-3c-mvp-3d-and-the-pr-99-reviews-2026-11-16-to-2026-11-18) |
| Owed before v0.2.0 · open | A URL password that holds a , or / leaves the whole userinfo public (the PR #96 review's A4). | [PR #96 review — recorded findings and Sonar dispositions…](deferred-tasks-parked.md#pr-96-review--recorded-findings-and-sonar-dispositions-2026-11-04) |
| Owed before v0.2.0 · open | A 0.1.x run still executing when a newer start reconciles is settled as crashed. | [MVP-1 1b — recorded low findings (2026-11-05)](deferred-tasks-parked.md#mvp-1-1b--recorded-low-findings-2026-11-05) |
| Owed before v0.2.0 · parked | The pre-flight's exit change needs a release note. | [PR #97 review — fixed findings and recorded lows (2026-11-06)](deferred-tasks-parked.md#pr-97-review--fixed-findings-and-recorded-lows-2026-11-06) |
| Open · filed in the parked file | --verbose never prints a real stack. | [Wave 3 Step 9a.1 — recorded low findings (2026-10-24)](deferred-tasks-parked.md#wave-3-step-9a1--recorded-low-findings-2026-10-24) |
| Open · filed in the parked file | Two packs of one source can differ in the packed manifest's key order. | [Wave 3 Step 9a.2a — recorded low findings (2026-10-24)](deferred-tasks-parked.md#wave-3-step-9a2a--recorded-low-findings-2026-10-24) |
| Open · filed in the parked file | Step 9d handoffs. | [Wave 3 Step 9b.2 — named limits and handoffs (2026-10-25)](deferred-tasks-parked.md#wave-3-step-9b2--named-limits-and-handoffs-2026-10-25) |
| Open · filed in the parked file | The durable-event bound has no engine-level test. | [Phase 2.6.5 W3 residuals (PR #86, merged 2026-08-30)](deferred-tasks-parked.md#phase-265-w3-residuals-pr-86-merged-2026-08-30) |
| Open · filed in the parked file | Two reference-doc nits. | [Phase 2.6.5 W3 residuals (PR #86, merged 2026-08-30)](deferred-tasks-parked.md#phase-265-w3-residuals-pr-86-merged-2026-08-30) |

## Decisions needed (maintainer call)

### MVP-11 follow-ups (2026-11-24)

> What [MVP-11](phases/mvp-11.md)'s Step 1 left open or created. The four ADRs ([0145](../decisions/0145-the-cli-has-one-surface-language.md), [0146](../decisions/0146-the-home-and-the-chat-share-one-calm-layout-and-the-first-run-has-no-dead-end.md), [0147](../decisions/0147-a-system-started-question-is-a-sheet-with-a-frame-and-a-wait-clock.md), [0148](../decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)) were accepted on 2026-11-24; the evidence is in [step-1-evidence.md](phases/mvp-11/step-1-evidence.md). Each open entry has an owner.

- [x] **The two open sub-questions are ruled (2026-11-24, maintainer):** the Home's one-line title is the spaced wordmark, and the three default-model paths share one starter table of current models (Haiku 5.5 for Anthropic). The plan's remaining "proposed, not ruled" items (the execution order, the cut line, the sheet class and the popup mechanism, the palette orders) are settled by the ADRs and the ten-unit plan; the cut line no longer applies, the transcript grid being in v0.2.0.
- [ ] **Spike evidence rows still owed, with the risk accepted (2026-11-24):** Windows Terminal, iTerm2, an SSH session, the inline form by hand in the VS Code terminal and Terminal.app, a terminal with the ambiguous-width setting on, focus behaviour, and whether a terminal that reflows on resize leaves a stale chord legend in the scrollback. The maintainer moved the first-run secret step into the popup without the Windows Terminal row; each row that is run later is recorded in a dated note on [ADR-0148](../decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md) §9, a failing one triggers its docked-panel fallback, and the rows join MVP-10's Windows runbook and the close-out matrix. The kit: [mvp-11/spike/](phases/mvp-11/spike/README.md). *Owner: MVP-10 and MVP-11 close-out.*
- [ ] **A second `Ctrl+C` on the Home loses an unsent draft** ([ADR-0115](../decisions/0115-one-interrupt-keymap-for-the-interactive-cli.md)'s 2026-11-21 amendment says so plainly). Whether it should keep the draft, or ask, is not decided; the first-run work only guarantees that a key-shaped draft is never kept. *Trigger:* the Home and chat presentation step of MVP-11 reads it with the exit guard, or the usability run shows lost input. *(low, UX)*
- [ ] **The deep-tier redaction of a provider's error is exact-match only** (`engine/providers.ts`): a provider that echoes a partial or masked form of the key can reach a doctor row. Pre-existing; the popup keeps the scrub and adds none. *Trigger:* the next change to `validateProviderKey`'s error path, with a superset oracle (masks may only be added). *(low · apps/cli/src/engine/providers.ts)*
- [ ] **A key-shape hint on the first-run key step** (a key that looks like another provider's is about to be sent to the chosen host). Candidate for the flows step; it would only warn, because key formats change and a heuristic can block a valid key. *Trigger:* the flows step decides, or a report. *(low, UX)*

### MVP-11 unit 6 follow-ups (2026-11-26)

> What the two review rounds and the focused sitting of [unit 6](phases/mvp-11/implementation-log.md) (the flows and the first run as popups) left open on purpose. None is a blocker, high or medium finding; the log's "Unit 6: decisions, accepted limits and what is owed" table holds the rest.

- [ ] **The secret scrub's `sk-` rule does not redact a key glued to a word character** (`yyyysk-ant-api03-…`, `_sk-ant-…`; with `/`, a space or `-` before it the key is `[REDACTED]`): a `/import` refusal that quotes a path the person typed re-displays text they typed into an unmasked field. Nothing leaves the machine; before unit 6 the same text reached the screen through the relative name. *Trigger:* the next change to `packages/llm/src/scrub-secrets.ts`, with a superset oracle (masks may only be added; the secrets controls pin its anchors). *(low · packages/llm/src/scrub-secrets.ts:136)*
- [ ] **`storedWords().interrupted` says "the default was not saved" whenever the flow is aborted, even after the starter write was published** (`onboarding/wizard.ts` ~765, used by `chooseStarter` and `report()`). Unreachable today because `drive-home.tsx` publishes synchronously and returns before `report()` reads the signal; only that timing keeps the sentence true now that `Esc` cancels in the starter wait. *Trigger:* any change that lets the publication await after it has published; choose the line from the starter's outcome once the write has returned. *(low · apps/cli/src/onboarding/wizard.ts)*
- [~] **`SHELL_PROVIDER_REMEDY` replaces a `/pricing` refusal that merely quotes `provider add <word>` in a model id** with "Connect … with /providers first". Misleading, still a refusal, nothing is written; kept because the guarantee that a popup names no shell command outranks the sentence. *(low · apps/cli/src/render/tui/pricing-card.ts)*
- [ ] **Home's refusal of a config rewrite while no card is open is unpinned** (`drive-home.tsx` `publishPreference`, `|| !native`; ADR-0148 §6): every caller runs inside an open flow, so no public seam reaches it. *Trigger:* the next change to the publication path; inject or export `publishPreference` and pin it. *(low, test)*
- [ ] **Five real-clock host test files take about 160 s sequentially** (`drive-home-providers`, `home-flow-popups-hosts`, `home-project-init`, `keyless-journey`, `native-prompt-framed-hosts`; 0 failures in 30 runs at low load and in 6 under load 37); two single tests sit at ~9.9 s against a 30 s ceiling. *Trigger:* the CI time budget bites, or the next gate speed-up; move them onto the injected clock (`native-prompt-lock.test.ts` shows the pattern). *(low, test)*
- [ ] **Polish found by the observation sittings** (each low, UX; none breaks a flow): chat `/export`'s `Esc` closes silently where `Ctrl+N`, an early `Ctrl+Y` and a stray key say `Nothing exported…`; a failed write shows the generic storage sentence; `/pricing`'s write wait shows an empty body; `/init`'s failure says the same thing twice; the stand-alone first-run end frame (about 36 ms) says "Connected" twice; an empty `/resume` page still names `↑/↓ select`, `PgUp/PgDn page` and `Page 1`; `/doctor`'s `[r]` moves the cursor to the first row; the first-run `Official endpoint:` hint wraps like a row; `Esc` back from the key step resets the consent cursor to `Not now`; the cancel words and `Ctrl+N` verbs differ per flow. *Trigger:* the polish pass of MVP-11's close-out, or the usability run. *(low, UX)*
- [ ] **A skip on ANY existing config is not remembered** (no lossless-rewrite check exists in `config/write.ts`): a person with a machine-written config sees `Setup skipped · not saved, it opens again next launch` every launch until they connect a provider. *Trigger:* a maintainer decision (a lossless check, or one more consent), or a report. *(low, UX · apps/cli/src/config/write.ts)*
- [ ] **`(wait)` is not on the chat store's approval, command, question and checkpoint cards or the Home's gate, budget and exit cards** (their legend builders are their own). *Trigger:* MVP-11 unit 7 (Home and chat presentation) decides. *(low, UX)*

### ADR-0137 follow-ups (2026-11-20)

> What [ADR-0137](../decisions/0137-permissions-is-a-sheet-and-esc-steps-back-out-of-the-full-view.md) §6 left undecided. Each names its own trigger, so each is parked.

- [~] **Opening the permissions sheet during a running turn.** A peer does; a card can then arrive and compete for the keyboard. *Trigger:* the maintainer asks for it, or the MVP-8 run view needs it.
- [~] **A stored display line for a remembered command**, so two `npm, 1 argument` rows can be told apart. It changes ADR-0118 §2 ("never the command") and the scrub is heuristic. *Trigger:* a separate decision with its own security reading.
- [~] **A repository `[chat]` allowlist section, and the domain, MCP and egress sections, in the permissions pane.** *Trigger:* MVP-8's `/permissions` tab and MVP-9.
- [~] **A withdraw-all key in the sheet** (`relavium permissions revoke --all` is the one place). *Trigger:* a maintainer request.
- [~] **Moving `/models`, `/effort`, the palette, reverse search, mention and the session picker onto the shared frame and legend builder.** *Trigger:* [MVP-11](phases/mvp-11.md): [Step 3](phases/mvp-11.md#step-3--language-scaffolding) puts the hand-written hints of the palette, reverse search and mention behind the legend builder, and Steps 4c and 4d move `/models`, `/effort` and the session picker into the popup host (its ADRs take the next free numbers; 0135 was taken by the native adapter).
- [~] **The sheet's intents on the desktop and the VS Code extension.** *Trigger:* those surfaces start.
- [~] **A secret split by a control character is not masked by the scrub** (`pass\x1b[0mword=…`): the command card's title and the sheet's session rows run the same `scrubbedCommandLine`, which reads the raw text. The person saw the whole argv on the card. The zero-width (Cf) variant of the same split behaves the same. *Trigger:* the next change to the shared scrub, with a superset oracle (masks may only be added).
- [~] **The sheet's load-time scrub of an absurd set of session approvals** (dozens of megabyte-sized commands, each approved for the session): the scrub runs over the whole argv before the 400-character cut, so opening the sheet blocks for seconds. It needs the model to call `run_command` with such a command and the person to approve it that many times. *Trigger:* the next change to `scrubbedCommandDisplay`, or a report.
- [~] **`revokeById` of an id whose record is tombstoned while a twin stays live** says "already withdrawn" once (the reload shows the grant under the twin's id), and a multi-tombstone append that fails part-way says "nothing changed" although the first record is gone. Low, self-correcting on reload. *Trigger:* the next change to `command-grants.ts`.
- [~] **In the Home, a card that arrives while the sheet is open is dropped on the next key, not on arrival** (the standalone chat closes the sheet in an effect the moment it arrives). The sheet opens only at an idle prompt with nothing running, so no card can arrive while it is open today; the key-time close is the defence. *Trigger:* the first entry above (opening the sheet during a running turn), when the Home needs the same effect-time close.
- [~] **The bare Home's sheet reads the grant key from the keychain once per open and twice per withdrawal, synchronously** (every read and withdrawal opens its own store, so a key replaced by another terminal is never missed). `@napi-rs/keyring` reads block the event loop, so a macOS item whose access list no longer covers this `node` binary (after an upgrade), answered "Allow" and not "Always Allow", prompts on each and `Ctrl+C` does nothing until it is answered. *Trigger:* a report, or an async keychain port.
- [~] **A split escape sequence can end a `relavium permissions` run** (a slow or packet-splitting link such as SSH can deliver the first byte of an arrow key as a lone `Esc` after ink's 20 ms window; the sheet closes and the run exits 0, nothing withdrawn). On the typed `/permissions` it only closes the sheet. *Trigger:* a report, or a keyboard layer that handles split sequences.
- [~] **A populated Home plus the sheet is taller than a 24-row terminal** (about 29 to 32 lines; the palette is 33 to 35): the legend, being last, stays visible and the top of the strip scrolls off. *Trigger:* the next change to the Home's layout budget.
- [~] **`relavium permissions` inherits the Home's start-up requirements** (a working directory a chat cannot use, a configuration that cannot be loaded, an unusable history database, the start-up reconcile): it opens the Home with the sheet open instead of a host of its own, to reuse the terminal ownership. *Trigger:* a standalone, smaller host for interactive one-shot commands (the MVP-8 hub, or a second command that needs one).
- [~] **A chat's own `/permissions` sheet reads the grant store its session cached**, so a key replaced by another terminal's `revoke --all` is invisible to a chat already open (it lists nothing, while chats started later read the new grant). The bare Home's sheet opens a store on every read; the chat's store also serves the card's `Remember` and the engine's `matches`, so changing it is a session-store decision. *Trigger:* the next change to `openCommandGrants`, or a report.
- [~] **Below 80×24 the Home's own "Terminal too small… Ctrl+C twice to exit" sits above the sheet's "Enlarge the terminal…"**; the first `Ctrl+C` closes the sheet (and ends a `relavium permissions` run), so the Home's hint is false there. *Trigger:* the next change to the Home's small-terminal view.
- [~] **"Any other key cancels" is not literally true while a session-wide or remember question waits** (`Ctrl+Y` answers the card once, `Ctrl+N` denies, a full-view key such as `[b]`, `p` or `/` cancels the question **and** does its own job). The card's rows say it and the full view's copy them (step 6, round 2). No key grants anything it did not before. *Trigger:* [MVP-11](phases/mvp-11.md) Step 3a, whose wording commit rewords every legend once (after the equivalence test).
- [~] **`matches()` re-reads the grant store once per approval when the sheet loads and twice per approval on a project withdrawal.** Bounded by the store's own size limits, and a person has few approvals. *Trigger:* a report, or a change that gives `matches` a cached view.

### Open decisions (collected 2026-11-18)

> Entries whose own text asks for a maintainer decision before any work starts. They were moved here, unchanged apart from the
> status note on the first, in the 2026-11-18 stale-entry sweep; design questions that sit inside a larger entry stay where they are.

- [ ] **⚠ OpenAI Sora 2 + Videos API SHUT DOWN 2026-09-24 — the Sora arm is dead code awaiting a maintainer decision (affects 1.AH A3).**
  *Status 2026-11-18 (stale-entry sweep):* the date below has passed. A web search on 2026-11-18 found OpenAI's model page and several
  secondary write-ups agreeing that the Sora 2 models and the Videos API were shut down on 2026-09-24 and that OpenAI named **no
  replacement** (the official deprecations page was not opened directly, so treat this as reported, not verified here). The Sora arm is
  still in `packages/llm/src/adapters/openai.ts` (the `video` dispatch and `pollMediaJobSora`) and nothing in the repository records a
  decision. The reason the original entry gives for "no live exposure" (the host `media_surface` wiring was still to come) is out of date — the CLI wired it in
  PR #52 — but the shipped catalog snapshot (`packages/llm/src/catalog/`) lists no `sora` model, so no shipped model id routes to the arm. **Decision needed (maintainer):** remove the arm now, as the entry below prescribes when no replacement is announced, or
  keep it until a replacement video API is chosen. The original entry follows.
  **⚠ OpenAI Sora 2 + Videos API DEPRECATED — provider shutdown 2026-09-24 (affects 1.AH A3).** OpenAI
  announced the Sora 2 video models (`sora-2`, `sora-2-pro`, `sora-2-2025-10-06`, `sora-2-2025-12-08`,
  `sora-2-pro-2025-10-06`) + the `videos.*` API shut down **2026-09-24**. The 1.AH A3 OpenAI/Sora async-video
  adapter targets exactly these (`videos.create`/`retrieve`/`downloadContent` + `pollMediaJobSora`). **Impact is
  narrow:** only the Sora adapter arm + its tests; the engine async-job LRO ([ADR-0045](../decisions/0045-async-media-job-loop-poll-checkpoint-resume-cancel.md)),
  the shared `encode/decodeMediaJobId` codec, the generative-seam conformance, and the **Gemini/Veo (A4)** adapter
  are provider-agnostic and **unaffected**. No live exposure today — A3 is not runtime-reachable until the
  Phase-2 host `media_surface` wiring. **Action (maintainer call, before 2026-09-24):** when OpenAI announces a
  replacement video model/API, retarget the A3 arm; otherwise **disable/remove** the Sora arm (the `generateMedia`
  `video` dispatch + `pollMediaJobSora` + their tests) leaving the seam + Veo intact. Low priority until a
  replacement lands or the date nears. *(packages/llm/src/adapters/openai.ts; 1.AH/Phase-2)*
- [ ] **Gate and CI speed-up left for a decision (2026-11-17) — decided 2026-11-18: C4 and Y2/C3 applied, C5, C6 and C7 dropped, Y4/Y5 stay deferred (see the last paragraph).** (C4) The `push` and `pull_request` runs of one commit are two full CI runs (about 544 job-minutes per commit) and, today, two sets of macOS runner requests that GitHub cancelled for capacity; limiting `push` to `main` would halve it, but a `development` push with no open pull request would get no CI, and the workflow's own concurrency comment records that the two runs are kept apart on purpose (a cancelled required check blocks a merge) — a policy choice for the maintainer. (C5) Build the eight native targets only when native sources change (the macOS arm64 leg is the one GitHub cancels). (C6) A path filter for docs-only pull requests (a skipped required check counts as passing, so it needs its own design). (C7) A shared `pnpm install` cache. (Y2/C3) Scope the enforced coverage run to the packages that have a floor (`llm`, `mcp`): about −10 to −14 minutes, but the other packages' tests may contribute coverage, and it changes what the floor measures, so it needs an experiment first. (Y4/Y5) Share the fixed/restored phases between controls that use the same tests (about half the phases) or cut a phase's fixed cost: the mutation evidence model, a security-owner and ADR decision.
  **Analysis (2026-11-18, read-only; recommendations, not decisions).** *Facts:* `main` requires exactly three checks — `lint · typecheck · test` (the `ci` aggregate), `engine coverage floor (llm, mcp)` and
  `windows · db concurrency + filesystem + headless smoke` (`strict: false`, admins not enforced: PR #99 merged while `coverage` was cancelled in both runs); `development` is unprotected.
  The `ci.yml` comment on separate concurrency groups (lines ~42-48) only keeps a push and its same-SHA PR run from cancelling each other; no test pins `on:` or `concurrency`.
  Required contexts attach to the head SHA, so a `push` run can satisfy a development→main PR. Native artifacts are own-run only by design (the delivery model refuses a foreign
  `run-id`; `delivery.test.mjs` mutates it). A complete run costs 250-310 job-minutes; the repository is public, so the cost is wall time and queueing, not money. 22 commits of the
  last week ran twice, and 27 of 52 `development` pushes had no PR (17 of them quick Windows-native debugging failures). **C4 — do now, low risk:** keep `push` for `main` and `development`
  (optionally `'**'`), drop `pull_request`, add `workflow_dispatch`, rewrite the comments at lines ~1-2 and ~42-48 and add one pin test for the `on:` keys; it saves one run per
  commit while a PR is open (the analysis averaged 186 job-minutes per duplicate over 22 pairs, because cancelled runs are cheap; a complete run is 250-310). The price: PRs from forks or from a branch other than `development` get no automatic CI (2 of the last 40 merged PRs did); the alternative (keep
  `pull_request`, drop the development push) loses CI for pushes without a PR and needs a standing draft PR. **C5 — drop:** about 5% of minutes and 3-5 min of wall time, and it would
  break the own-run trust model and five pin sets. **C6 — drop:** about one checkpoint PR in six is docs-only, a PR path filter sees the whole accumulated diff, a workflow-level
  `paths:` filter leaves required checks Pending, and the aggregate redesign touches about 65 `if`/`needs` pins. **C7 — drop:** the setup-node pnpm cache already shares one store per
  OS per ref and a warm install takes about 2 s (median of 530 samples). **Y2/C3:** verified, about 22-32 min, not 10-14 — see the coverage entry in the PR #99 merge observations.
  **Y4/Y5:** stay deferred (they change what each causal-control proof means and do not move the critical path). Aside: `pnpm test:acceptance-tools` runs in seven jobs per run (about 10
  job-minutes); deduplicating it would touch the evidence model. **Maintainer questions:** the trigger set of C4; whether to switch `enforce_admins` on.
  **Decided (maintainer, 2026-11-18):** C4 as recommended (`push` on `main` and `development` plus `workflow_dispatch`, no `pull_request`; commit `48ea618a`, with a pin test on the
  trigger set, the group and `cancel-in-progress`); Y2/C3 as the coverage narrowing (commit `63123bd9`); C5, C6 and C7 are dropped, not deferred; Y4/Y5 stay deferred and are the only
  part of this entry still open. `enforce_admins` was not asked and is unchanged. **Not yet proved:** that a development -> main PR is satisfied by the `push` run alone — it rests on
  GitHub's rule that required checks attach to the head SHA by name, and the first real PR after this change is the evidence; if the merge box shows the checks as missing, restore
  `pull_request` and keep the rest.
  **Evidence (2026-11-19, PR #100).** The premise held: at head `2ce6a252` the pull request was `CLEAN` and `MERGEABLE` with no `pull_request` run, its three required checks satisfied by the `push` run alone. The maintainer then pushed a docs-only head and merged ten seconds later
  with that head's run unfinished, so that merge went ahead with required checks pending (admins are not enforced, as in PR #99); it shows nothing about a pending head, and `enforce_admins` remains unasked. *(low · tools/ci, .github/workflows/ci.yml)*

### Multimodal forward-obligations (carry the not-yet-coded pieces — see ADR-0031)

- [ ] **Host-side SSRF enforcement in `EgressCapability.fetch` (DNS resolve + connect-by-validated-IP + per-hop redirect re-validation)** — the shared SSRF range-primitive (1.AE) covers the **policy** half
  (literal format checks on URLs and hostnames); the **mechanism** half — resolving a hostname to its
  IP, validating the IP against the same range block, pinning the connection to that IP (connect-by-validated-IP),
  and re-validating on every redirect hop — belongs to the host-side `EgressCapability.fetch` (already
  defined in `packages/core/src/tools/types.ts`). When the desktop or CLI surface implements that fetch
  hook, it must apply these runtime checks. The current `assertHttpsBaseUrl` and `refineInFlightMediaPart`
  URL validation are construction-time / seam-ingestion-time policy; they catch malformed URLs but cannot
  catch DNS rebinding or a public hostname resolving to a private IP. **Scope split (resolving the earlier "Phase 2" framing):** the **media** url-carrier mechanism is **pulled into 1.AF** on a new bytes-shaped media-egress capability ([ADR-0043](../decisions/0043-media-egress-failover-rematerialization-ssrf.md)); the **CLI tool** `EgressCapability.fetch` **landed in 2.5.E** ([ADR-0057](../decisions/0057-cli-chat-modes-and-per-tool-approval.md)) — `apps/cli/src/engine/tool-host/egress.ts` over the shared `connectValidated` connect-by-validated-IP mechanism (`packages/db/src/safe-egress.ts`), with the Host/`:authority`-header strip; the **desktop** surface's fetch hook still lands when the desktop implements it. *(packages/core/src/tools/types.ts; security-review.md; media → 1.AF/ADR-0043; CLI tool → 2.5.E/ADR-0057; desktop → surface fetch hook)*
- [ ] **MCP admission and dialer canonicalize a url differently.** The admission parses the AUTHORED string
  with `extractEgressAuthority`; the dialer parses `new URL(spec.url).href`, i.e. the WHATWG-canonicalized
  form. They diverge on the expanded IPv6 form (`[0:0:0:0:0:0:0:1]` vs `::1`), on IDNA/UTS-46 mappings
  (`127。0。0。1`, `ⓛocalhost`, fullwidth text), and on anything else `new URL` normalizes. **Every divergence
  fails CLOSED today** — the `host:port` scope stops matching, the range block then refuses the resolved
  private host — so the exposure is a usability one: an author who writes the expanded IPv6 form of a local
  endpoint gets a server that is admitted and then permanently refused. But the invariant the code comment
  asserts ("the dialer's scope is derived from the SAME parse the admission approved") is not true, and it is
  untrue in the one place a `host:port` policy is compared. Fix by canonicalizing once at admission and
  passing the canonical string down. Note the parse-time `z.string().url()` is a third reader of the same
  bytes. *(medium · apps/cli/src/engine/mcp-servers.ts; ADR-0088 §2.2)*
- [ ] **Native DNS work can outlive caller cancellation (G31; reconciled 2026-10-12).**
  The earlier medium finding about unnormalized MCP resolver errors and unbounded caller wait no
  longer describes the source: `createMcpFetch` now normalizes unknown failures to a fixed
  `SafeEgressError`, races caller cancellation and checks cancellation before late connection entry;
  its owning MCP operation supplies the deadline instead of a second nested fetch timer. The remaining
  resource limit is Node's nonabortable `dns.promises.lookup`: background `getaddrinfo` can occupy a
  libuv threadpool slot until the OS resolver times out, even after the caller's deadline rejects.
  Retained-work ownership does not make that native resolver abortable. This is the existing low-priority
  follow-up G31 asks to file, not a new waiver of MCP caller deadlines. Evaluate a bounded resolver
  implementation or explicit host concurrency/resource controls when DNS background work is addressed;
  preserve validated-IP connection and late-abort refusal. Wave 2 records this source-backed limitation
  and reruns the existing caller-cancellation/error regressions; it does not implement a new resolver.
  *(G31 · packages/db/src/safe-egress.ts; apps/cli/src/engine/mcp-fetch.ts; ADR-0088 §2.1;
  [Wave 2 scope](phases/phase-2.5.5-hardening-and-remediation.md#wave-2-preflight-and-proposed-execution-plan--2026-10-12))*
- [ ] **`allow_local_endpoint` may name a host whose RESOLUTION an attacker steers.**
  `isPrivateOrLocalHost` treats `*.local` / `*.internal` / `*.localhost` as local from the suffix alone, so
  `http://svc.local:4000` is an opt-in to whatever the LAN's mDNS responder claims. Since 2.6.5 `W4` the
  dialer refuses a public or metadata answer and pins the private one, so the residual is narrower than it
  was: a LAN-adjacent attacker who answers with its own RFC1918 address becomes the MCP server, with no
  consent gate (ADR-0084 covers `stdio` only). Consider restricting what the opt-in may name to an IP
  literal or `localhost`, or extending consent to a network server. *(medium ·
  packages/shared/src/content.ts, apps/cli/src/engine/mcp-servers.ts; ADR-0088 §4)*
- [ ] **MCP `stdio` spawn — `npx` dependency pinning ([ADR-0052](../decisions/0052-inbound-mcp-client-package-lifecycle-registration.md) §2).** *[Moved 2026-11-18: the entry this continues, "MCP `stdio` spawn — consent before a local spawn", is closed and now sits in the [closed record](deferred-tasks-history.md#multimodal-forward-obligations-carry-the-not-yet-coded-pieces--see-adr-0031--closed-entries).]* The **other half** of the entry above, deliberately left open: consent answers *"may this program run?"*, not *"is this program the same code it was yesterday?"* An approved `npx -y @acme/server` re-resolves the package on every spawn, so the registry — not the grant — decides what executes, and the fingerprint cannot see it (the declaration is byte-identical). Pin the package version/integrity for the built-in auto-install servers, and consider surfacing the resolved version at the consent prompt. Unscheduled: it needs a decision on where a lockfile for a *tool the user declared* would live. *(packages/mcp/src; apps/cli; ADR-0052 §2; ADR-0029 trust model)*
- [ ] **MCP lazy connect — connect on first tool call, not at session start ([ADR-0052](../decisions/0052-inbound-mcp-client-package-lifecycle-registration.md) §3).** Every declared MCP server is spawned/connected at session or run **start**, so a session that never calls an MCP tool still paid for every server — and, since [ADR-0084](../decisions/0084-consent-before-a-local-mcp-spawn.md), still asked the user to consent to every local program it never ran. **Blocker:** ADR-0052 §3's registry is **immutable after assembly** — the tool list must be known before the first turn, and that is exactly what discovery connects to obtain. **Unblocker:** the durable cross-invocation **tool-list cache** in the MCP follow-ups entry below — with a cached list, the registry can be assembled without connecting, leaving the connect (and the consent prompt) to the first actual call. Order matters: the cache lands first. ADR-0084 §8 explicitly does **not** decide this, and notes the consent model already fits — a grant is per declaration, so deferring the spawn defers the prompt without changing what is decided. *(packages/mcp/src; apps/cli/src/engine/mcp-servers.ts; ADR-0052 §3; ADR-0084 §8)*
- [ ] **MCP network transport — header-based auth ([ADR-0052](../decisions/0052-inbound-mcp-client-package-lifecycle-registration.md) §6).** 2.R injects `{{secrets.*}}` only into a **stdio** child's `env`; the network (`http`/`websocket`) specs carry only `{ url }`, so a network server's `env` is **rejected at parse** (fail-closed, never silently dropped). When network MCP servers need credentials, add a host-resolved auth-header field (e.g. `Authorization: 'Bearer {{secrets.<name>}}'`) wired through the SDK transport's `requestInit`/headers, resolved from the same isolated `mcp-secret:*` namespace and never logged/serialized. **Scheduled → 2.6.I.** *(packages/mcp/src/sdk-http.ts; apps/cli/src/engine/mcp-servers.ts; ADR-0052 §6)*
- [ ] **MCP follow-ups (non-security).** A durable cross-invocation **tool-list cache** (mcp-integration.md ~1h per-`(command,args)`, with a transport-covering key) — 2.R re-runs discovery per process ([ADR-0052](../decisions/0052-inbound-mcp-client-package-lifecycle-registration.md) §3); and a generalized **`SecretResolver`** seam beyond the 2.R `mcp-secret:*` keychain namespace ([ADR-0052](../decisions/0052-inbound-mcp-client-package-lifecycle-registration.md) §6); and reconciling the `types.ts` `ToolId` "register dynamically" comment to "host-side assembled" when 2.R touches `packages/core`; and ~~**mid-call abort propagation**~~ — *closed in 2.6.5 `W4` Step 1 ([ADR-0088](../decisions/0088-the-mcp-boundary-is-hostile.md) §1.2): the engine's `AbortSignalLike` is bridged to a real `AbortSignal` at the SDK fence and threaded through `callTool` and the discovery walk into `RequestOptions.signal`, so a turn cancel now reaches the server rather than only abandoning the caller. The connect is cancellable too. Pulled forward from 2.6.I because the deadline work touched the same call path.* **The tool-list-cache half remains scheduled → 2.6.I** (the rest stays opportunistic). *(packages/mcp/src; packages/core; Phase-3)*
- [ ] **Streaming media triad (`media_start`/`media_delta`/`media_end`) — host-deferred ([ADR-0046](../decisions/0046-inline-media-out-via-generate-streaming-triad-deferred.md) §4).**
  1.AG Section B delivers inline media-out through the non-streaming `generate()` path (the in-flight
  `media` `ContentPart` is de-inlined at `#emitDurable`). The **streaming** triad stays RESERVED: its Node
  de-inline needs a host hook reaching the *pure* adapter (the output twin of `resolveForEgress`, since
  `media_end` is handle-only and the adapter has no `MediaStore`) or the desktop Rust CAS ([ADR-0032](../decisions/0032-desktop-rust-media-de-inline-amends-0018.md)).
  Acceptable because a media-output turn is typically terminal/single-shot, so token-streaming its short
  accompanying text is low value against a frozen-seam change. Wire at **1.AH** (the progressive-preview surface). *(packages/llm/src/types.ts seam; 1.AH)*
- [ ] **OpenAI agentic image-gen via the Responses API — wire deferred ([ADR-0046](../decisions/0046-inline-media-out-via-generate-streaming-triad-deferred.md) §3).**
  The normalized delivery **shape** is defined (a `providerExecuted: true` `tool_result` carrying a
  normalized `media` part — ADR-0031 §4.3/#7) and 1.AG Section B wires the two Chat-Completions inline
  cases (Gemini `responseModalities` → `inlineData`, OpenAI inline audio → `audio`). OpenAI image output is
  **not** a Chat-Completions modality (`modalities` is `text`/`audio` only); agentic image-gen is the
  Responses API `image_generation` built-in tool — a **separate request surface** the Chat-Completions
  adapter does not call. Wire the Responses-API path (request + `image_generation_call` output-item parse →
  the already-defined providerExecuted media shape) when a Phase-1 model needs it. *(packages/llm/src/adapters/openai.ts; post-1.AG)*
- [ ] **Rate-carrying media representation for raw PCM (1.AH A1 known-limitation).** OpenAI TTS `pcm` is headerless
  16-bit LE PCM at 24 kHz, but the seam's `MediaMimeTypeSchema` forbids MIME parameters, so the bare `audio/L16`
  cannot carry `;rate=24000` (RFC 2586's default is 8 kHz) — a consumer of an `audio/L16` part must assume 24 kHz.
  Mirrors the pre-existing chat-audio `pcm16 → audio/L16` convention; the self-describing containers (mp3/opus/aac/
  flac/wav) are unaffected. A rate-carrying media representation (or dropping bare-PCM from the offered set) is the
  fix. Low priority — opt-in niche format only. *(packages/shared/src/content.ts MediaMimeTypeSchema; packages/llm/src/adapters/openai.ts; low · 1.AH/Phase-2)*
- [ ] **Node-retry of a PARKED media job — deferred (1.AG Section D, ADR-0045 §3 "MAY re-dispatch").**
  The node-retry budget (1.S) wraps the executor `#dispatch`; an async media job parks AFTER dispatch returns, and
  the engine's out-of-band poll loop settles a deadline/poll failure as `node:failed` (retryable for a timeout) directly
  — it does NOT re-enter the node-retry wrapper, so a parked media job is not automatically re-dispatched (a fresh paid
  submit) on a retryable timeout. ADR-0045 §3 makes this a **MAY** ("the loop itself never silently re-submits"), so the
  current behavior is conformant; re-dispatching a parked-then-failed media node through the node-retry budget is an
  additive refinement. *(packages/core/src/engine/engine.ts #pollMediaJob; post-1.AG)*
- [ ] **Per-modality pre-egress media cost estimate (A6)** — ADR-0028's governor is token-based and
  cannot price a media-gen call. Add a `[defaults].media_cost_estimate` config default (the media
  analogue of `max_tokens_estimate`, in [config-spec.md](../reference/contracts/config-spec.md)) **and** a
  per-model media rate in `pricing.ts`/`model_catalog`; the governor estimates `units × rate` pre-egress.
  **Decided in [ADR-0044](../decisions/0044-media-access-governance-read-media-save-to-cost.md)** (disjoint cost class folded into the existing `max_cost_microcents` cap — **no new cap dimension**; a distinct media count/bytes cap is deferred as additive). *(config.ts; pricing.ts; database-schema.md; wired at 1.AF)*
- [ ] **`partialRef` partial-write semantics (A3, reserved)** — `media_delta.partialRef` ships in the
  frozen triad (1.AD) but is **reserved, host-implementation-defined**; the `MediaStore` contract defines
  only `put(completeBytes)`. Specify append-vs-per-delta-put semantics when the surface that renders
  progressive previews lands. *(1.AH / Phase E)*
- [~] **`read_media` `workspace` authz scope kind (A8, reserved)** — `read_media` authz is a generic
  `handle → allowedScopes: Set<Scope>` with `Scope = { kind:'session', id }` today; the
  `{ kind:'workspace', id }` kind is **reserved (documented, not implemented)** so cross-session /
  shared-asset reads are an additive scope kind, no handle-model migration. Implement only when a
  shared-asset feature has a real consumer. *(reserved; [ADR-0044](../decisions/0044-media-access-governance-read-media-save-to-cost.md) ships the `session` kind at 1.AF, defers the `workspace` kind)*
- [ ] **`MediaStore` retention/GC + `media_objects` table (defaulted)** — per-distinct-reference
  `refcount` + `last_referenced_at` + grace window, separate from the 90-day `run_events` prune; GC owner
  is the host (Rust desktop / filesystem CLI). **Decided in [ADR-0042](../decisions/0042-engine-media-storage-substrate-mediastore-deinline-retention.md)** — a `media_references` refcount junction + a 7-day-default grace window + a terminal-state sweep; lands with the table at **1.AF**. *(database-schema.md; 1.AF)*
- [ ] **Retire the `vision` derived alias (OQ6 default)** — `CapabilityFlags.vision` is kept as a derived
  alias of `media.input.image` for live consumers (`db.supports_vision`, adapter `supports.vision`);
  schedule removal once those migrate to `media.input.image`. *(types.ts; a later cleanup)*

### 1.AE forward-obligations (PR #32)

- [ ] **Conformance test additions — image-in, audio-in, pdf-in per provider** — the 1.AE media input
  wiring (OpenAI `image_url`/`input_audio`, Anthropic `image`/`document` blocks, Gemini `inlineData`)
  is unit-tested but the conformance replay fixtures don't yet exercise media-in scenarios. Add recorded
  fixture-replay conformance tests per provider: image-in (all three), audio-in (OpenAI, Gemini), pdf-in
  (Anthropic, Gemini). Requires real API calls to record fixtures, then replay — do in a follow-up after
  the PR lands. *(packages/llm/src/conformance/; 1.AE follow-up)*
- [ ] **`mediaUnits` mapping (OpenAI audio tokens, others nil for now)** — `Usage.mediaUnits` ships as
  an optional field (ADR-0031 decision #4) but no adapter populates it yet. OpenAI reports
  `completion_tokens_details.audio_tokens` which maps to `{ modality: 'audio', direction: 'output',
  units: n, unit: 'count' }` (the RAW token count — audio_tokens are tokens, not seconds); Anthropic and Gemini report no media-specific billing counters in their
  current usage shapes. Wire OpenAI audio-token billing at 1.AF when the engine surfaces usage to the
  session; leave Anthropic/Gemini nil until those providers add billing counters. **Report the raw
  `audio_tokens` count (no fabricated tokens→seconds conversion) to avoid mis-billing** ([ADR-0044](../decisions/0044-media-access-governance-read-media-save-to-cost.md)).
  *(packages/llm/src/adapters/openai.ts; 1.AF)*
- [ ] **OpenAI reasoning-model capability matrix (`OPENAI_REASONING_CAPS`)** — o1/o3/o4-mini have a
  separate media capability surface (no audio input, restricted tools, etc.). The current `openai.ts`
  uses one `OPENAI_SUPPORTS` matrix for all GPT models; reasoning models need their own matrix selected
  by model id, paralleling how DeepSeek already has `DEEPSEEK_SUPPORTS`. Wire when reasoning-model
  media support is specified. *(packages/llm/src/adapters/openai.ts; 1.AF/1.AG)*
- [ ] **Handle and URL media source resolution in adapters (`1.AF` MediaStore integration)** — `handle`
  sources (`media://sha256-<hex>`) and `url` sources are accepted at the seam boundary but skipped
  (not wired) in the adapter content-building functions (`toOpenAiUserContent`, `toAnthropicContentBlocks`,
  `toGeminiMediaPart`) with `// handle: resolved at egress by MediaStore (1.AF)` / `// url/handle
  audio: deferred to 1.AF` comments. The engine's `deInlineMedia` + `MediaStore` contract resolves
  handles at egress; URL sources are fetched through `EgressCapability.fetch` (the SSRF mechanism
  half). Wire when the engine plumbing lands (1.AF). *(packages/llm/src/adapters/{openai,anthropic,gemini}.ts; 1.AF)*

### 1.AF P4 forward-obligations — engine policy landed, HOST WIRING deferred (review 2026-06-19)

> The 1.AF P4 engine-pure **policy** (read_media tool + scope-set authz + Range gate, the D15 load-check,
> the D17 cost governor, the save_to write port, the media-reference store) landed and is fully tested.
> The comprehensive 46-agent review confirmed the **host/surface wiring** below is **not yet present** —
> so D12/D15/D17 are inert end-to-end until a host (CLI/desktop, 1.AH/Phase-2) wires them. Recorded here
> so the roadmap is not read as "live end-to-end." None is a defect in the landed policy; each is the
> deferred mechanism/wiring half. *(1.AF is ✅ Done — all PRs merged #33/#34/#35/#36, 2026-06-20; the items
> below remain: `read_media` (D12) was deferred to 2.M, then **split into a dedicated, security-reviewed follow-up**
> (maintainer-approved, 2026-06-26) — the 2.M chat REPL shipped without it (it is engine/db + cross-surface
> security-sensitive work usable by both `run` and `chat`, orthogonal to the REPL). **D15/D17/D8 are now wired by the
> CLI (✅ PR #52, 2026-06-25, checked off below [Moved 2026-11-18: those entries now sit in the [closed record](deferred-tasks-history.md#1af-p4-forward-obligations--engine-policy-landed-host-wiring-deferred-review-2026-06-19--closed-entries)])** — the desktop/VS Code surfaces reuse the same injectable ports
> (Phase-3/Phase-4); the `save_to` multi-feeder semantics remain.)*

- [ ] **`read_media` host `MediaReadAccess` impl + base64 encoder (D12 mechanism)** — there is no host
  factory that bridges `MediaReferenceStore.describe()` + `MediaStore.readRange()` (which returns
  `Uint8Array`) into the `MediaReadAccess` the tool needs (whose `readRange` returns an in-flight **base64**
  `MediaSource`). Until a host provides one, `read_media` cannot be invoked successfully. *(packages/db; read_media D12 follow-up)*
- [ ] **`read_media` session-scope population (D12 authz data, ADR-0044 §1)** — nothing writes
  `session`/`workspace` `media_references` rows (the only writer, `createMediaReferencePort`, writes `run`
  refs only), so `describe().allowedScopes` is always `[]` and every read denies. The input-transfer
  scope-population at the node/session boundary is unimplemented. **Acceptance when it lands (recorded 2026-09-18,
  [ADR-0095](../decisions/0095-what-an-agent-session-remembers-across-turns.md) §1):** a session that ran
  `read_media` resumes and exports with the attachment recorded on the TOOL row as structure and no `user` row
  inside the turn — the synthesized media message is never persisted, or turn identity by structure breaks.
  *(packages/core engine input-transfer + AgentSession; read_media D12 follow-up)*
- [~] **`ctx.mediaRead` / `ctx.requestingScope` — and `ctx.invokeAgent` — not wired into the dispatch context**
  — the AgentRunner + AgentSession build `ToolDispatchContext` without them, so `read_media` and `invoke_agent`
  would always throw `ToolUnavailableError` in the engine path (fail-closed, no leak). Since `CR-73`
  (2026-09-06) neither tool is advertised while its delegate is absent, so nothing reaches that backstop.
  **Ownership corrected 2026-09-18:** the phase-2.6.5 `CR-73` note said "adding that field is `W7`'s work", and
  `W7`'s scope never included it. `ctx.mediaRead` belongs here, with the `CR-50` residual that argues wiring a
  delegate with no producer is worse than its absence; `ctx.invokeAgent` belongs to
  [2.6.N](phases/phase-2.6-conversational-authoring.md). **Trigger:** the first host that can actually supply
  one — a media-reference producer for `read_media`, or 2.6.N's sub-agent delegate.
  *(packages/core/src/engine/{agent-runner,agent-session}.ts; read_media D12 follow-up, `CR-73`, 2.6.N)*
- [ ] **`save_to` multi-feeder output semantics** — an output node with several feeders captures a record;
  `save_to` requires exactly one media handle across it (0/>1 → node failure). Document the "which handle"
  contract + add a mixed-feeder test. *(low · workflow-yaml-spec.md + packages/core; 1.AH)*
- [ ] **`save_to` accepts only the `run.id` namespace at LOAD time** — a non-`run.id` ref in `save_to`
  (e.g. `{{ run.outputs[...] }}`) parses, creates a spurious DAG edge, and fails only at runtime. Add a
  load-time check restricting `save_to` to `run.id` so the author gets an immediate error. *(low · packages/core load path)*
- [ ] **`save_to` url double-fetch** — a `url`-sourced media part in a save_to output is fetched twice (the
  save_to de-inline + the node:completed emit de-inline; the put dedupes the bytes). Thread one de-inlined
  result into both paths to fetch once. *(low · packages/core/src/engine/engine.ts `#performSaveTo`)*
- [ ] **Host-GC orchestration is CLI-local (2.S)** — `runHostMediaGc` (the 3 ordered steps: clean-terminal
  reclaim-retry, grace-window byte reclaim, CAS-orphan sweep + the `orphanMinAgeMs` concurrent-writer age-guard)
  is host-agnostic but lives in `apps/cli/src/engine/media-gc.ts`, so the Phase-3 desktop / Phase-6 cloud hosts
  can't reuse it. When a 2nd host wires media GC, promote the pure orchestration to `@relavium/db` (or a shared
  host-helper) and pin the mechanism in a `docs/reference/` home so the hosts can't drift. *(med · apps/cli → @relavium/db; Phase-3+)*
- [ ] **Keychain no-raw-key IPC test (ADR-0044 §4 acceptance gate)** — ADR-0044 §4 makes "the keychain bridge
  never returns a raw key from an IPC command" an **explicit 1.AF test deliverable**, bundled with the media
  IPC/byte-delivery review surface. That IPC surface is the desktop/Tauri command layer, which is **unbuilt at
  1.AF** — there is no keychain IPC command to assert against yet — so the test is deferred to the 1.AH host
  bridge that introduces it. The Node-side keychain seam (ADR-0006) exists, but the *no-raw-key-over-IPC* gate
  is meaningful only once the IPC command exists. **Owner: 1.AH (the keychain/media IPC bridge).** Recorded so
  the ADR-0044 §4 acceptance is not silently dropped. *(apps/desktop keychain IPC + a direct test; 1.AH)*
- [ ] **Surface `Usage.mediaUnits` on `cost:updated` (the disjoint per-unit observability axis)** — ADR-0031 A6
  / ADR-0044 §3 intend the per-unit media usage (image per-count, audio/video per-second; a token-based
  provider's audio as `unit:'count'`) to be observable on the `cost:updated` event. Realized media **spend**
  already folds into `cumulativeCostMicrocents` (D17), but the per-unit **counts** are not surfaced: `CostUpdatedEventSchema`
  lives in `@relavium/shared`, which cannot import `MediaUnitsEntry` from `@relavium/llm` (the layering forbids
  shared→llm). Surfacing it requires **relocating `MediaUnitsEntrySchema` to `@relavium/shared`** (llm re-exports
  it; `UsageSchema` keeps using it) — a seam-shape move that wants its own PR. The canonical docs (sse-event-schema.md)
  now reflect the current state (field deferred). *(low · @relavium/shared seam move + run-event.ts + agent-turn.ts emit; a later PR)*

> **2026-06-19 — second (Sonnet) review pass on PR #35.** A full re-review (9 dimensions, double-verified)
> on top of the first review's fixes confirmed **0 blockers/highs in reachable code**; ~17 small fixes
> landed in the follow-up commit. The items below are the **deferred** remainder *[Moved 2026-11-18: the `read_media` result-shape entry has since closed and now sits in the [closed record](deferred-tasks-history.md#1af-p4-forward-obligations--engine-policy-landed-host-wiring-deferred-review-2026-06-19--closed-entries)]* — a read_media *result-shape*
> contract that the 1.AH wiring must resolve coherently (it touches the inert read_media path, so fixing it in
> isolation now risks conflicting with the 1.AH host design), plus one test-injection gap.

- [ ] **Budget-governor media-cost block/warn/fail path has no non-zero-estimate test.** No shipped model
  carries a `mediaOutputRates` row, so `estimateMediaCost` always returns 0 and the governor's media-driven
  `warn`/`fail`/`pause` arm is never exercised end-to-end (the units×rate math IS covered in `mediaCost`/
  `estimateMediaCost` unit tests). Add coverage when a media-priced model lands (or refactor the governor to
  accept an injectable estimator). *(low test gap · packages/core/src/engine/budget-governor.test.ts)*

### Engine/seam policy & surface follow-ups (2026-06-09 hardening-analysis pass)

> A hardening-analysis pass over the seam / fallback / byte-delivery / i18n surfaces (validated against the
> current ADRs) produced these recorded rulings and deferrals. Each stands on Relavium's own architecture.

- [~] **Score-threshold / partial-success fallback — DECIDED out-of-scope for Phase 1 (Y2).** `FallbackChain`
  (1.K) routing is **binary** classified-retryable-vs-fatal only ([phase-1](phases/phase-1-engine-and-llm.md)
  1.K acceptance); a cross-provider *quality* judgment is a provider-superior decision that ADR-0011's
  capability-gated **lowest-common-denominator** seam explicitly fences out. Quality/score fallback stays an
  **author/node concern** (a judge / `condition` node + branch in the DAG), **not** an `LLMProvider`-seam or
  1.K concern — do **not** fold it into 1.K under any framing. Promote to a separate candidate-ADR **only** if
  a concrete multi-workflow demand for engine-native quality-fallback appears, and even then it must sit
  **above** the seam, never amend the `LLMProvider` contract. *(in-1.K scope: the fallback trigger is a typed
  `LlmError`/run-event, never a string-sentinel — see phase-1 1.K acceptance.)* *([ADR-0011](../decisions/0011-internal-llm-abstraction.md); 1.K)*
- [~] **Per-host/per-provider TLS-verify granularity — DEFERRED draft-proposal (MD-TLS).** The stance today
  is a single global never-disable ([security-review.md](../standards/security-review.md)), which is strictly
  safer. Per-host granular TLS (for a self-signed / private-CA local gateway) reintroduces the MITM surface
  and would need its own ADR + opt-on/opt-out tests. **Decided: keep the global never-disable stance**;
  revisit a per-host **opt-IN** only when a real private-CA self-hosted consumer lands (the BYOK
  custom-baseURL opt-in-local path already covers the realistic local-endpoint case). *(security-review.md)*
- [x] **Run-submission idempotency / request-dedup.** Distinct from the content-addressed
  media cache and any managed-mode metering `request_id`: should an identical run-create request be
  de-duplicated so a double-submit does not start two runs? **Open:** a Phase-1 engine run-create hook vs a
  surface concern. Low-stakes; recorded so it is not lost. **Scheduled → MVP-8 step 3** (the Home can start a
  workflow there, making double-submit real; the launch is single-flight in the Home controller and pinned by a test, [ADR-0139](../decisions/0139-a-workflow-run-is-hosted-inside-the-home.md)). *(WorkflowEngine run-create; 1.N)*
  **Closed 2026-11-23 (MVP-8 step 3, increment 5a):** the launch machine is the latch and `RunHost.start` is single-flight; `apps/cli/src/home/run-launch.test.ts`, "two Enters in one tick start exactly one run (one engine built)".
- [ ] **i18n CI key-parity + data/code separation (Phase 2+ surface).** When the desktop / CLI / VS Code
  surfaces add i18n: a CI test that **fails** on a missing/extra translation key (parity), **zero conditional
  logic in translation data** (data ≠ code), and a dead/unused-string lint. Recorded now; lands with the
  Phase-2/3/4 surface i18n work (no consumer yet). **Scheduled → 2.6.L** (the CLI `en`+`tr` catalog is the
  first consumer). *(a `docs/standards/` entry or skill; Phases 2–4)*
- [ ] **Pre-egress token-estimate accuracy — watch item (1.AC).** The ADR-0028 governor blocks on
  `worstCaseNextEstimate(maxTokens)` from `[defaults].max_tokens_estimate`. Record the open
  question: does the estimate need provider-accurate token counting (from the seam's model meta /
  usage feedback) to avoid systematic over/under-blocking, or is the declared estimate enough?
  No change now — re-evaluate with real 1.AC telemetry. *(1.AC; ADR-0028)*
- [ ] **Configurable sub-100% budget warning threshold (ADR-0028 amendment).** `budget:warning`
  today is emitted only when a pre-egress estimate would already exceed the cap, on the `on_exceed: warn`
  path (`thresholdPct` reports the observed spent/limit fraction at that point). A user-facing
  early-warning threshold (e.g. `warn_at_pct: 80`) requires amending ADR-0028 to add both a
  config default and a per-workflow `budget.warn_at_pct` field, plus a decision on whether it
  throttles/queues subsequent egresses or only surfaces a one-time advisory event. Deferred until
  there is concrete surface demand or telemetry showing operators need an earlier signal.
  *(1.AC; ADR-0028; config-spec.md; workflow-yaml-spec.md)*

## PR #95 independent review — unactioned findings (2026-10-18)

An independent systematic review of [PR #95](https://github.com/HodeTech/Relavium/pull/95) at `19c99968`
reported no blocker or high finding. Its medium and two of its four low findings (`LOW-3`, `LOW-4`) were corrected in `a3e164b5`
([disposition table](phases/phase-2.5.5-hardening-and-remediation.md#independent-review-of-the-published-head-and-its-corrections));
`LOW-2`'s change was reverted in `ebbec1c0` and `LOW-1` and `LOW-2` are the approved deferrals below *(reworded 2026-11-18 in the
stale-entry sweep: the entry said "three of its four", which the revert contradicted)*;
what follows was **not** actioned in that pass. **Owner rulings, 2026-10-19:** the maintainer approved an owner for
every open item ([rulings](phases/phase-2.5.5-hardening-and-remediation.md#wave-3-steps-919-preflight-review-and-maintainer-rulings--2026-10-19)).
Each `- [ ]` below is now **Scheduled** to a Wave 3 increment (the PR95 increment runs before Step 9a) and stays unchecked until
that increment lands, except LOW-1 and LOW-2, which are approved deferrals with their recorded triggers. Items
marked *(reviewer)* are quoted from that review and were not re-verified by the author; items marked *(author)* were
measured or counted here.

- [~] **Approved deferral (maintainer, 2026-10-19). `LOW-2` (the 1 s default `waitFor` on a real child) was examined and deliberately not changed.** *Low.* The only wait that observes a real child booting is `holdNativeToolProcess`'s marker wait, whose sole caller sits inside `drive-home.test.ts` waits (lines 633 and 637) that use the 1 s default and enclose the boot, so a longer inner bound cannot help; a retune must raise those outer waits together. No failure was reproduced (0 in dozens of loaded runs). `testing.md` also states that no readiness or case deadline is extended to pass the workspace gate. **Trigger: a recorded boot-time failure.** *(low · apps/cli/src/commands/native-forwarding.test-support.ts, apps/cli/src/home/drive-home.test.ts)*
- [ ] **Scheduled → Wave 3 17b. Join-table test nits.** *Nit.* The `process-close.test.ts` gate margin is nominally 100 ms but `waitFor`'s 50 ms poll makes it 100–150 ms, so a publication more than about 150 ms late is invisible; the three rejection cases assert the message but not the `ProcessCapabilityError` class; the `mcp-orphan.e2e.test.ts` comment's statement that its cases have only ever run on POSIX is historical and unverifiable; the abort case's `await spawned.promise` is unbounded (a spawn that never happens fails only as the 5 s case timeout), its closed-child `waitFor` carries no tag, and the 100/300/3,000 ms margins are bare literals. *(nit · apps/cli/src/engine/tool-host/process-close.test.ts, apps/cli/src/harness/mcp-orphan.e2e.test.ts)*
- [~] **Approved deferral (maintainer, 2026-10-19). Native-lifetime watchdogs are fixed 5 s bounds inside 10 s cases (`LOW-1`).** *Low.* The watchdogs in
  `apps/cli/src/process/native-process-owner.test.ts`, `engine/tool-host/os-native-lifetime.test.ts`,
  `render/editor-native-lifetime.test.ts`, `render/fixtures/native-editor.mjs` and
  `tools/cli-package/smoke/native-process.test.mjs` assert that a slow-but-correct close did not trip them, so a
  loaded runner produces red without a defect. *(author)* The constants are **coupled** — the Home editor case
  has a 5 s fixture watchdog, a 3 s ready wait, a 6 s release wait and a 10 s case bound — so raising one alone
  does nothing, and three runs of the three vitest files (52 tests) passed at a load average of 80–96 on macOS.
  The reviewer could not observe the Windows root cause either. **Trigger: a Windows trace that names the bound
  that fired**; retune the coupled set together then. *(low · the files above)*
- [ ] **Scheduled → Wave 3 17a (all four sites together). Raw exit-code literals where `EXIT_CODES` names exist.** *Nit.* *(reviewer)* reported
  `result === 5 || result === 7 || result === 8` in `apps/cli/src/chat/session-surface-lifetime.ts:54`; *(author)*
  the same literals occur in four places: that site, `commands/workflow-lifetime.ts:178`,
  `process/command-lifetime.ts:110` and `commands/drive.ts:225`. Behaviour-neutral, but it sits on the exit-code
  precedence that the review's red-team matrix held, so rerun the precedence tests with the change.
  *(nit · the four files above)*
- [ ] **Scheduled → Wave 3: `session-ink-input.ts` → 15c, `HomeDeps.exit` → 14a, the `lazy-dispatch.ts` cause-wrap → 10a. CLI lifetime and API-drift nits.** **Not pulled into the CLI MVP (checked 2026-11-04):** D65 moved only row 15c's #63 part into MVP-3; the `session-ink-input.ts` half is 15c's "PR #95 input-listener fold-in", which stays with 15c's paused remainder, and the other two halves stay with 14a and 10a. *Nit, (reviewer).* `chat/session-ink-input.ts:40-42,124-131` guards only
  the `readable` listener (Ink's kitty `data` path is latent because `kittyKeyboard` is unused);
  `home/drive-home.tsx:165-166,1067,1115-1116` keeps `HomeDeps.exit` although the owned path never calls it;
  `commands/lazy-dispatch.ts:49` imports the media route without the cause-wrap the sibling routes carry.
  *(nit · the files above)*
- [ ] **Scheduled → Wave 3: the purity-guard root set → 10a; the remaining test-evidence nits → 17b. Test-evidence nits.** *Nit, (reviewer).* `process/pure-substrate-graph.test.ts:117-133` — the purity-guard
  root set omits the ADR-0111 eager-boot files (the reviewer verified that opaque marking fixes it); three
  no-argument `toHaveBeenCalled()` positives outside `native-process-owner.test.ts`;
  `packages/llm/src/adapters/list-models-lifetime.test.ts:122` labels a fake-`fetch` case "real installed SDK";
  `apps/cli/src/harness/concurrency.e2e.test.ts:434-441` uses a fixed 100 ms contention margin;
  `tools/cli-package/consumer-lifetime.test.mjs:54-59` pre-marks every synthetic case `passed: true` (by design;
  real detection is the packed-consumer CI). *(nit · the files above)*
- [ ] **Scheduled → Wave 3 19b: the duplicate headings. Tooling and documentation nits (open half).** The duplicate headings stay with 19b. *Nit, (reviewer).* *Premise corrected 2026-10-19:* the repeated headings are the 2.5.5.A–I sub-stream headings and the Wave 2/Wave 3 "Decisions presented together before implementation" pair, not Wave 2 checkpoint sub-headings. Repeated heading texts in the phase register, whose later occurrences
  take a `-1` slug suffix. *(author)* A scan finds repeated H2–H4 headings (the 2.5.5.B–I sub-stream headings and the
  Wave 2 checkpoint's sub-headings among them); no link is broken today. *(nit · the files above)*

## Phase 2.6.5 `W5` residuals — `CR-55` ([ADR-0089](../decisions/0089-media-correctness-four-boundaries.md) §4, 2026-09-02)

> Recorded, not implied. `CR-55` closed the "a missing media rate reads as a price of zero" defect on both cost
> paths and extended `strict_cost_cap` to an unpriced modality. These two are reachable and named rather than
> left to be rediscovered — the phase rule is close it or name it, and each of these is genuinely a separate
> decision rather than an unfinished part of this one.

- [ ] **The pre-egress estimate has no billed-UNIT predicate, so a rate can clear the gate and still not price
      the call.** `estimateMediaCost` keys only on `{modality}`; the realized `mediaCost` additionally requires
      `unitMatchesBilledModality` (image=count, audio/video=second). A token-based provider reports audio as a
      raw token **count** (`openai.ts` maps `completion_tokens_details.audio_tokens` that way, deliberately —
      ADR-0044 §3 forbids a fabricated tokens→seconds conversion). So `models pricing <m> --audio 0.001` clears
      a `strict_cost_cap` refusal, and the realized fold *still* reports `audio` unpriced and contributes 0.
      The estimator cannot fix this alone: it does not know which unit the provider will report. The honest
      options are a per-COUNT audio rate alongside the per-second one, or refusing the `--audio` remedy for a
      provider known to bill audio by token. **The call is not mis-billed** — `priced: false` reaches the event
      and `/cost` says *price unknown* — but the strict gate admits a call it provably cannot price.
      *(medium · packages/llm/src/budget-estimator.ts, packages/llm/src/cost-tracker.ts; ADR-0089 §4)*
- [ ] **The media-rate INHERITANCE branch has no test, because nothing to inherit ships.** `mediaRates`
      (`apps/cli/src/engine/model-catalog-view.ts`) resolves `userRate ?? catalogRate`, and no shipped snapshot
      row carries a media rate — so deleting the catalog fall-through keeps the suite green. The test names the
      gap and pins `catalogPricing(id)?.mediaOutputRates` as `undefined` so it fails loudly the day a snapshot
      ships one; closing it properly needs that snapshot row (or a fixture catalog).
      *(low · apps/cli/src/engine/model-catalog-view.test.ts; ADR-0089 §4(c))*
- [ ] **A capability skip that SUCCEEDS on a later entry still emits nothing** (`CR-51`). When the chain skips
      a tool- or attachment-incapable model and a later entry serves the request, the run completes correctly
      and no event says a model was passed over — `agent-turn.ts` drops a `skipped` attempt record before any
      emit. The two loud cases are covered (a load-time refusal for an authored tool grant, and a
      reason-carrying `bad_request` when the whole chain is skipped), so this is the residual quiet case:
      a fallback silently doing its job, which is also the case where the user is least harmed. Closing it
      needs an event or a host notice channel that does not exist for chain skips today.
      *(low · packages/core/src/engine/agent-turn.ts; ADR-0071 §12, `CR-51`)*
- [ ] **A wrong shipped `toolCall`/`attachment` row has no user override** (`CR-51`). These fields were inert
      before this wave; now they deny service, and `admitRefreshedModels` deliberately refuses to let any
      refresh shadow a shipped id (a money guard). So a false-negative in the generated snapshot cannot be
      corrected by `models refresh`, by the DB catalog, or by any setting — only by a release. Reachable for a
      user pointing a custom `base_url` at a shipped id whose upstream row is wrong. An escape hatch would
      need a deliberate decision about which side errs: today the snapshot wins, which is right for money and
      arguably wrong for capability.
      *(medium · packages/llm/src/catalog/lookup.ts; `CR-51`)*
- [ ] **The widened `onUnpriced` modality argument is unproven at the CLI host boundary.** The governor's own
      test proves `checkPreEgress` passes `[modality]` to an injected sink, and `effort-notice.test.ts` proves
      `unpricedModelNote` renders the right sentence from it — but the three hand-written arrow functions that
      join them (`apps/cli/src/commands/run.ts`, `commands/gate.ts`, `chat/session-host.ts`) have no test
      exercising them with a non-empty `modalities`. That is structurally the same "TypeScript accepts a shorter
      parameter list, so the argument dies silently" risk this wave already fixed one layer down. The existing
      `session-host.test.ts` coverage is for the unpriced-MODEL (no-modality) shape only.
      *(medium · apps/cli/src/commands/{run,gate}.ts, apps/cli/src/chat/session-host.ts; ADR-0089 §4)*
- [ ] **No single test runs `models pricing --image` from argv to `ModelPricing.mediaOutputRates`.** Coverage
      exists as four adjacent segments — argv→args (`dispatch.test.ts`), args→real store (`models-pricing.test.ts`),
      store row→listing (`model-catalog-store.test.ts`), listing→overlay (`model-catalog-view.test.ts`) — each
      pair joined by a shared TypeScript type and, for the CLI registration half, by the pre-existing
      commander↔manifest parity test. The seams are typed, so the risk is real but bounded.
      *(low · apps/cli; ADR-0089 §4(c))*
- [ ] **A `node:failed` message can carry an unsanitized model id.** The new strict refusal interpolates the
      model id into `BudgetExceededError.message`, which reaches the terminal renderer through
      `run:failed.error.message`. The CLI's own `unpricedModelNote` sanitizes for exactly this reason, but
      `packages/core` cannot import a surface sanitizer, and the pre-existing unpriced-**model** refusal has the
      same shape — so this is a replicated pattern, not a new class. The correct fix is host-side stripping of
      `node:failed` / `run:failed` message text, which is broader than `W5`.
      *(low · packages/core/src/engine/budget-governor.ts; security-review.md)*

## Phase 2.6.5 `W5` residuals — `CR-54` ([ADR-0043](../decisions/0043-media-egress-failover-rematerialization-ssrf.md) §3, 2026-09-02)

> `CR-54` pinned the two paths that produce a url at first resolution — the node output and the human-gate
> resume payload. ADR-0043 §3 has a second clause these do not reach.

- [ ] **"An input URL re-hosted at INGEST" is still open for the surfaces that can carry one.** A `url`
      media part arriving on an `AgentSession` user message, or inside an MCP `tool_result` folded into a
      transcript, is not pinned — it can reach `#materializeMedia` and be handed to an adapter as a live
      url, and a second attempt may resolve to different bytes. `MEDIA_URL_SOURCE_ENABLED` is `true`, so
      this is a live path, not a hypothetical. The workflow half is closed; the session half is not.
      *(medium · packages/core/src/engine/agent-session.ts; ADR-0043 §3, `CR-54`)*
- [ ] **A pinned object is orphaned when the dispatch fails after the pin.** The pin runs at the dispatch
      boundary, so a node that then fails — a `save_to` template that will not resolve, a bounding breach —
      has already written bytes into the CAS. `#recordProducedMedia`, the only thing that registers a handle
      for the D11 terminal sweep, runs on the **durable event draft**, and a failed node emits `node:failed`
      with no output — so the object is never recorded and never reclaimed by any mechanism. Small and real.
      Closing it means recording a reference for a pinned-but-never-emitted object, or sweeping the CAS
      against `listObjectHandles` for row-less blobs past their age floor (the media GC already has that
      shape). A test comment asserted the opposite until a review checked it.
      *(low · packages/core/src/engine/engine.ts, apps/cli/src/engine/media-gc.ts; ADR-0042 §4, `CR-54`)*
- [ ] **A transient re-host failure fails the node rather than retrying the re-host.** A media pin that
      fails on a network blip is classified non-retryable ON PURPOSE — `retryable: true` means "re-dispatch
      the node" in this engine, and the node's own work already succeeded, so retrying would make a second
      paid generative call to fix a CDN hiccup downstream of it. The right answer is a bounded retry around
      the RE-HOST alone, which never re-invokes the executor. Until then a blip on a large video fails a
      node whose model call was fine.
      *(medium · packages/core/src/engine/engine.ts, media-pin-error.ts; ADR-0040, `CR-54`)*
- [ ] **`MediaStore.put` / `putStream` take no `AbortSignal`.** The fetch half of a pin honours the run
      signal; the STORE half cannot be interrupted by a cancel, a run timeout or a node deadline. Moving
      the pin to the dispatch boundary means an uncancellable write no longer corrupts a node's terminal —
      it now only delays one — but a very large write still holds a cancelling run open for its duration.
      *(low · packages/shared/src/content.ts, packages/db/src/media-store.ts; ADR-0042, ADR-0085)*
- [ ] **A post-terminal `node:completed` can still reach a live `subscribe()` observer.** Reproduced by a
      review and confirmed PRE-EXISTING (it occurs with `CR-54` fully reverted, because the emit's own
      de-inline `await` had the same window). Never persisted — `#authorizeWrite` refuses a `lost`/`done`
      run — so this is a delivery artefact, not a durability breach.
      *(low · packages/core/src/engine/engine.ts; ADR-0036, ADR-0085)*

## Phase 2.6.5 `W6` residuals — `CR-61` (`AgentSession`, 2026-09-03)

- [ ] **An agent's `output_schema` is honoured on a workflow node and ignored by `AgentSession`.** `CR-61`
  wired lowering-plus-enforcement on the `agent` node path (ADR-0092 §3/§4), but
  `packages/core/src/engine/agent-session.ts` does not read `output_schema` at all — verified by grep, zero
  occurrences — so `relavium chat` and `relavium agent run` neither lower it to `responseFormat` nor
  validate the response. The **same agent definition therefore behaves differently depending on which
  first-class entry point runs it**, which is the property [ADR-0024](../decisions/0024-agent-first-entry-point-agentsession.md)
  exists to deny. Not widened here because wiring it is new behaviour on a shipping surface, not a doc fix.
  *(M · packages/core/src/engine/agent-session.ts; agent-yaml-spec.md, agent-session-spec.md)*

- [ ] **A model's integer beyond ±2^53 is rounded before `output_schema` sees it, and the engine keeps the
  rounded value.** `output_schema` validates the result of `JSON.parse`, which is lossy for integers outside
  the safe range: a model returning `9007199254740993` is validated — and stored as the node's output — as
  `9007199254740992`. So a `const`/`enum`/`multipleOf`/boundary check can pass against a number the model did
  not produce, and the run's output silently differs from the response. **Pre-existing** (the agent path has
  always used `JSON.parse`), surfaced by `CR-61` making the conformance check meaningful. A correct fix is
  lossless number parsing or refusing an out-of-range numeric token before parse; both are real work, so the
  boundary is documented in [json-schema-subset.md](../reference/shared-core/json-schema-subset.md) and
  recorded here rather than claimed fixed. *(M · packages/core/src/engine/agent-runner.ts)*

## Phase 2.6.5 `W6` residuals — `CR-61` ([ADR-0092](../decisions/0092-output-schema-is-validated-by-the-compiler-we-already-own.md), 2026-09-03)

- [ ] **An authored `pattern` can hang the whole engine process, and no deadline can interrupt it.**
  ADR-0092 §2 enforces an authored `pattern` in `strict` mode, reasoning that the ReDoS concern belongs to
  an untrusted *server's* regex. Half an argument: catastrophic backtracking needs a vulnerable regex AND a
  hostile string, and the string is **model output**, which an indirect prompt injection can steer.
  Measured on `^(a+)+$` against `"a"×n + "!"` — 19 chars 9.6 ms, 23 chars 18.1 ms, 27 chars 286 ms, ~40
  chars minutes. Backtracking is **synchronous**, so ADR-0085's node deadline never gets a turn and a
  cancel cannot land either: the failure is the whole process, not one node. It also sits against
  ADR-0027's precedent that an author's *code* is resource-capped precisely so an authored construct cannot
  hang the engine.
  **Maintainer ruling 2026-09-03: record, do not mitigate yet.** The three candidate mitigations each have
  a real cost — a nested-quantifier heuristic both misses cases and can falsely refuse a valid pattern
  (`CR-62` hit that class seven times in one wave); refusing `pattern` is ADR-0092's already-rejected (a1)
  and pushes authors back to unvalidated schemas; a linear-time matcher is a new runtime dependency needing
  its own ADR.
  **Partly mitigated the same day, after that ruling, by an option it did not have.** A declared
  `maxLength` now GATES the pattern: the compiler builds `z.string()…pipe(z.string().regex(…))`, and a
  pipeline returns INVALID without running its second schema — 8010 ms chained versus 0.1 ms piped on the
  measurement above. So the residual is now specifically **a `pattern` with no `maxLength` beside it**;
  json-schema-subset.md tells authors to declare one and says what happens when they do not. This note
  described the hazard as wholly unmitigated for a day after it stopped being so.
  *(M · packages/shared/src/json-schema-compiler.ts)*

## Phase 2.6.5 `W6` residuals — `CR-62` ([ADR-0093](../decisions/0093-an-expression-sees-only-what-it-is-ordered-after.md), 2026-09-03)

`CR-62` narrowed an expression's `run.outputs` to the reading node's transitive closure and refuses a
**literal** out-of-closure read at parse. ADR-0093 says in its Decision and its Negative section that this
closes the common case and **explicitly does not close the class**. These are what it left, written out
here so the residue sits on a backlog rather than only inside an ADR's Negative section.

- [ ] **The non-literal read is still a silent `false`.** A computed key (`run.outputs[k]`), a rebound
  `run`, or any expression the masker cannot confidently lex is passed over. The read then resolves to
  `undefined` in the VM and a `condition` comparing it takes the false branch with no error — the original
  defect, at a smaller surface. The only exhaustive detector is ADR-0093's alternative (b), VM-side
  accessors; note its recorded cost was **overstated** and is corrected in the ADR's 2026-09-03 amendment
  (a VM-side accessor needs no ADR-0027 §3 amendment; the real cost is that it can only fail after the run
  has started). *(M · packages/core/src/expression/)*
- [ ] **The scan is silent on more spellings than the documents say.** Every home describes the blind spot
  as "a computed key, an aliased binding, or a value flowing through a variable"; in fact the scan also
  abandons on any `/` it cannot classify as a comment (so any expression containing DIVISION is unscanned),
  on a nested template literal, on an HTML-like comment, on any `run` token not written as a member access,
  and on any BACKSLASH in code position (an identifier escape — added 2026-09-04, and the list growing again
  is itself the argument for the rewording below). Each is a deliberate bail toward silence — the alternative was a false refusal — but "computed or
  aliased" understates it. Either widen the coverage or make every home say *"a read the scan cannot
  confidently resolve"*. *(S · docs + packages/core/src/expression/literal-output-reads.ts)*
- [ ] **A read of a node that is not in the workflow is reported by nothing, ever.** Not a hand-off to the
  runtime resolver — that covers template fields and never fires for an expression. Refusing it here is
  only safe once the scan's anchoring is beyond doubt, since a mis-anchored match would then make every
  bracket key refusable. *(S · packages/core/src/dag.ts)*
- [ ] **Decide whether an edge locator should name its endpoints.** A `WorkflowGraphError` on an edge reads
  `edge #1` — a 0-based positional index — while `nodes`/`agents`/`inputs`/`context` all resolve to an
  authored name. Pre-existing, but `CR-62`'s edge-`condition` refusal makes it the locator authors meet
  most often. Endpoints are kebab ids and would pass `SAFE_ID_LABEL`. *(S · packages/core/src/parser.ts)*

## Phase 2.6.5 `W6` residuals — `CR-64` ([ADR-0094](../decisions/0094-a-tool-grant-is-checked-when-the-plan-is-built.md), 2026-09-02)

> The plan-build narrowing check covers an INLINE agent completely. Two halves of the surface do not exist
> yet, and both are stated here rather than implied by a closed item.

- [ ] **`$ref` agent resolution is unwired on EVERY surface.** `BuildRunPlanOptions.agents` is exported and
      documented, and **nothing populates it** — not `relavium run`, not the engine's own call sites. So the
      `dangling_ref` check (pre-existing) and the new `tool_grant_widened` check are both inert for an
      external `$ref`'d agent: there is nothing to resolve against. Closing it means a host reading and
      validating `.agent.yaml` files and passing the registry — a surface feature, not a check.
      *(medium · apps/cli/src/commands/run.ts, packages/core/src/dag.ts; ADR-0094 §5)*
- [ ] **`relavium gate` does not assert `toolGrantsFinal`, and it is the host that most safely could.**
      Not hypothetical, as an earlier wording of this item implied: `gate.ts` calls `resumeFromCheckpoint`
      with no `planOptions`, so on resume an MCP-declaring agent is skipped. The irony is that the gate path
      rebuilds from the snapshot `relavium run` froze AFTER augmenting, so the grant there is final BY
      CONSTRUCTION — `run` has to reason about call ordering to claim the same thing. Either pass the flag at
      the gate resume, or resolve it together with the resume question below.
      *(low · apps/cli/src/commands/gate.ts; ADR-0094 §2)*
- [ ] **A paused run can be stranded by a check it passed before.** `resumeFromCheckpoint` rebuilds the plan
      from the FROZEN snapshot, so a run that paused at a gate — with a widening node downstream that was
      never dispatched, and which may have been about to run fine — now fails at resume, permanently: the
      author cannot fix it, because the resume reads the snapshot rather than the file on disk.
      `agent-session.ts` records the opposite instinct for a session ("a RESUME does not re-admit… admission
      governs what is ADMITTED", citing ADR-0083 for the run half), but `buildRunPlan` already applies
      ADR-0086's ceilings on resume the same way — so this is an engine-wide question about whether a resume
      re-admits at all, not one `CR-64` may settle alone. The dispatch-time `resolveGrant` floor is
      unaffected either way.
      *(medium · packages/core/src/engine/engine.ts, dag.ts; ADR-0094, ADR-0083, ADR-0086)*

## Phase 2.6.5 `W5` residuals — `CR-50` ([ADR-0089](../decisions/0089-media-correctness-four-boundaries.md) §1, 2026-09-02)

> `CR-50` closed its DELIVERY half: a `read_media` call now reaches the model as media on all three
> providers, over a marked engine-synthesized `user` message. What remains is a **producer**, not a wire.

- [ ] **Nothing creates a `session`/`workspace` media reference, so `read_media` can authorize nothing.**
      `MediaReferencePort` records only `run`-scope rows, and `describe` deliberately excludes those
      (ADR-0044 §1 — a run-lifetime reference never grants read). Wiring the host delegate today would give
      the model a tool that answers `unknown media handle` to every call, which is worse than the current
      fail-closed absence. Closing it needs a place where a handle ENTERS a session or workspace and a
      reference is recorded there — the natural home is an `AgentSession` de-inline choke point, which the
      session does not have at all today (the workflow engine's is in `engine.ts`).
      *(medium · packages/core/src/engine/agent-session.ts, packages/db/src/media-reference-store.ts;
      ADR-0042 §3-4, ADR-0044 §1, `CR-50`)*
- [ ] **The CLI chat has no media producer either.** `read_file` fail-closes on a binary/media file (the
      durable-handle arm is unwired in `apps/cli/src/engine/tool-host/fs.ts`) and `@`-mention injects text,
      so even with the two items above a chat session would have no handle to read. These three close
      together or not at all.
      *(medium · apps/cli/src/engine/tool-host/fs.ts, apps/cli/src/chat/session-host.ts; `CR-50`)*
- [ ] **`MediaReadAccess.readRange` now has no engine caller.** `CR-50` removed the tool's byte delivery, so
      the delegate's `readRange` arm and `validateByteRange` are exercised only by their own unit tests until
      the 1.AH desktop `read_media(ref)` display command lands. Retained deliberately (ADR-0089 §1 names that
      command as the caller) and re-homed in [testing.md](../standards/testing.md) as an OPEN acceptance
      criterion — recorded here so "wired but dead" is a known state rather than a discovery.
      *(low · packages/core/src/tools/types.ts; ADR-0089 §1)*
- [ ] **The synthesized media message has no reader but the model.** It lives in the turn's context window
      and nowhere else: `AgentSession` re-appends only the user text and the final assistant text, so it
      never reaches `history.db` or an export, and no event is emitted for it. The provenance preamble's
      stated audience — "anyone reading a transcript or an exported workflow" — does not exist, and no
      surface can show the user that an image was placed in the conversation on their behalf. Closing it is
      a surface change (an event, or persistence), which ADR-0089 §1 did not decide. Its Negative is
      amended in place with the correction.
      *(low · packages/core/src/engine/agent-session.ts; ADR-0089 §1)*
- [ ] **`read_media` is advertised to models that cannot receive an image.** The tool is offered on grant
      alone, so a model with no image input can call it, get a descriptor, and then have the whole turn die
      when the continuation is pre-skipped by every plan entry — a chain-exhausted failure for choosing a
      tool the engine offered. `CR-51` built the per-model capability metadata that would let the advertise
      filter drop it; wiring that (or turning the refusal into a correctable `isError`) is the fix.
      *(medium · packages/core/src/engine/agent-session.ts, packages/core/src/tools/registry.ts; `CR-50`, `CR-51`)*
- [ ] **Media over the inline ceiling cannot be delivered to a model at all.** `read_media` now refuses a
      video, a PDF, or an image over 256 KiB with a correctable error naming the limit — honest, but it
      means a screenshot or a photo often cannot be shown. The real fix is a delivery path that does not
      inline: `resolveForEgress` returning a provider-hosted ref (a Gemini `fileUri`, an OpenAI `file_id`)
      instead of base64, which ADR-0031 already reserves the sidecar for.
      *(medium · packages/llm/src/fallback-chain.ts, packages/db/src/media-store.ts; ADR-0031, ADR-0089 §1)*
- [ ] **`count` is silently ignored for an audio/video generative node.** Gemini's Veo hard-codes
      `numberOfVideos: 1` and the OpenAI TTS/Sora paths carry no count either, so an author writing
      `count: 3, duration_seconds: 4` gets ONE four-second clip. The BILLING now matches that (duration
      only — it used to charge `count × duration`, a 3× over-charge on a successful call), but the author's
      declaration is still accepted and then disregarded. Either refuse `count` on an audio/video generative
      node at validation, or carry it into the adapter request. Whichever: the accounting and the adapter
      must move together, which is precisely what they did not do.
      *(medium · packages/core/src/engine/agent-runner.ts, packages/llm/src/adapters/gemini.ts; ADR-0045 §5)*
- [ ] **Token rates from the DB are not range-validated, only the media ones are.** `mediaRates` now refuses
      a negative / non-finite / unsafe-integer value fail-closed, but `rowToUserPricing`'s
      `input`/`output`/`cached` columns take the same unchecked path from the same user-writable file. A
      negative token rate is the same cap bypass on the dominant cost axis. Left out of PR #88 only because
      the media columns are what `W5` added; the fix is the same predicate.
      *(medium · apps/cli/src/engine/model-catalog-view.ts; ADR-0089 §4, ADR-0050)*
- [ ] **Three more pasted remedies still use `<angle-bracket>` placeholders.**
      `provider.ts:198` and `models.ts:140,303` tell the user to run
      `relavium provider set-key <name>`; `<` is a shell redirection, so the pasted command tries to read
      stdin from a file named `name` and fails. Strictly less bad than the `W5` case fixed in
      `budget-governor.ts` / `effort-notice.ts` — those carried a `>` too, which CREATES a file named
      `--image` in the user's cwd — but the same defect. Left out of PR #88 only because those files are
      untouched by the wave; the fix is the same bare-word substitution.
      *(low · apps/cli/src/commands/provider.ts, models.ts)*
- [ ] **Three functions this wave touched sit over the 15 cognitive-complexity threshold.**
      `models-pricing.ts` (37), `budget-governor.ts:checkPreEgress` (16) and `dispatch.ts`
      `buildModelsPricingArgs` (17). SonarCloud reports them as issues, not gate failures, and they are
      branch-heavy for real reasons (each price flag has its own unit, its own validation and its own
      remedy sentence). Two others from the same wave were decomposed when the fix also removed a
      duplication — `dispatchToolCalls` and `countUnpinnedMedia` — which is the bar the rest should meet:
      refactor when it buys something beyond the number.
      *(low · apps/cli/src/commands/models-pricing.ts, dispatch.ts, packages/core/src/engine/budget-governor.ts)*
- [ ] **A signature Gemini attaches to a `text` or `inlineData` part is still dropped.**
      [ADR-0090](../decisions/0090-a-continuation-token-rides-the-part-it-belongs-to.md)'s named deferral:
      neither `text` nor `media` has a field for a continuation token, and the streaming fold flattens text
      and loses part order. The failure there is degraded quality, not a rejected request.
      *(low · packages/llm/src/adapters/gemini.ts; ADR-0090 Scope)*

## Phase 2.6.5 `W5` residuals — `CR-53` ([ADR-0089](../decisions/0089-media-correctness-four-boundaries.md) §2, 2026-09-02)

> `CR-53` closed its INGEST half: a url media body now streams from the network into the store under a size
> ceiling, an idle deadline and the run `AbortSignal`, and `put` is reserved for sub-ceiling bodies. Three
> clauses of its own acceptance did not land. Named here rather than left inside a closed checkbox.

- [ ] **The ADAPTER still returns whole base64 for generated media.** `packages/llm` is untouched by
      `CR-53`: Imagen and OpenAI image output return `{ kind: 'base64', data }`, and only Veo's `url`
      fallback arm streams. The defect text — "audio and video responses are read into a full buffer and
      converted to base64" — describes the adapter path, so the common generative case still pays it.
      Closing it needs a download-lease shape on the `generateMedia` seam.
      *(medium · packages/llm/src/adapters/gemini.ts, openai.ts; ADR-0089 §2, `CR-53`)*
- [ ] **DELIVERY is still whole-buffered.** `resolveForEgress` does `get(handle)` then base64-encodes the
      whole object, and `readRange` slices a fully-read buffer — the third buffering site ADR-0089's own
      Context names, and the only one on the path a provider re-upload takes. Ingest streams; delivery does
      not, so "end to end" is true of one direction.
      *(medium · packages/db/src/media-store.ts; ADR-0043 §2, ADR-0089 §2)*
- [ ] **No test measures peak MEMORY.** The acceptance says "a large-media test asserts peak memory stays
      bounded". What ships counts what the source produced and asserts it stops at the bound — honest, and a
      real property, but it proves the transfer is cut off rather than that the resident set is bounded. The
      mutation that would close it: a harness sampling RSS inside the body generator, in a separate process,
      comparing the streamed path against `readBounded`.
      *(low · packages/db/src/media-egress.test.ts; `CR-53` acceptance)*
- [ ] **`readBounded`'s double buffer was documented, not collapsed.** ADR-0089 §2's third bullet says it is
      collapsed; what shipped routes media around it instead and records what it costs. Bypassing is
      arguably the better answer — but it is a different one from the Accepted text, and the text egress
      path still pays ~2× peak. Either collapse it or amend §2.
      *(low · packages/db/src/safe-egress.ts; ADR-0089 §2)*

## Phase 2.6.5 `W2` residuals ([ADR-0085](../decisions/0085-the-node-executor-owes-liveness-and-the-engine-enforces-it.md), 2026-08-25)

The first two are **named by ADR-0085 itself** — §7 and §6 each accept a risk rather than close it, and an
accepted risk with no tracked home is indistinguishable from one nobody noticed. The ADR's §9 requires this
recording, and a Sonnet review round caught that §7 already claimed it in the present tense while the file
had never been touched.

- [~] **Executor quarantine, and the trigger that would make it necessary
  ([ADR-0085](../decisions/0085-the-node-executor-owes-liveness-and-the-engine-enforces-it.md) §7).**
  ADR-0085 declines quarantine and records the reasoning: on the only host that exists, the CLI runs one
  workflow per process and exits, so an abandoned dispatch outlives the run by at most the process. But
  `WorkflowEngine` holds ONE `#executor` across a reusable `#runs` map and accepts repeated `start()` calls,
  so a later run enters the same handler object — `retryable: false` bounds re-dispatch *within* a run and
  nothing bounds it across runs. **Trigger: the first long-lived host that drives more than one run through
  one `WorkflowEngine`** — the desktop app or the VS Code extension, neither of which has source today. That
  host must either add a quarantine or MEASURE that accumulation is harmless; ADR-0085 does not license
  assuming the latter. *(medium · packages/core/src/engine/engine.ts; ADR-0085 §7)*
- [ ] **Bound the host persistence seam, or decide what a run may do when it cannot learn whether its own
  write landed ([ADR-0085](../decisions/0085-the-node-executor-owes-liveness-and-the-engine-enforces-it.md) §6).**
  `RunStore.persistEvent` is `Promise`-typed and `#emitDurable` catches a REJECTION but still awaits a
  promise that never settles, so a hanging store hangs the run and no timer in ADR-0085 changes that. Not
  reachable on the shipping SQLite store (bounded and fail-loud at ~25 s), real for a future async or cloud
  store. **This is the half of ADR-0036's "structurally impossible" claim that stays conditional.** Deferred
  deliberately: bounding a durable write raises a question ADR-0085 must not answer in passing — what a run
  is allowed to do when the outcome of its own write is unknowable. *(high · packages/core/src/engine/engine.ts;
  ADR-0085 §6; Phase-2 cloud store)*
- [ ] **`onAuthError` is forwarded to the chain and exercised by nothing above it.**
  `agent-runner.ts` and `agent-session.ts` both conditionally spread `onAuthError` into `ChainCapabilities`;
  deleting BOTH lines leaves the entire core suite green (1337/1337, measured 2026-08-27), and no core test
  references it. **Deliberately NOT filed as a `CR-21`-class defect, and the distinction is the point:**
  `setTimer`/`newAbortController`/`attemptTimeoutMs` were HIGH because production hosts DO set them, so the
  engine was silently dropping values real callers supplied. No host sets `onAuthError` at all — not
  `build-engine.ts`, not `session-host.ts`, and no desktop or extension construction exists — so nothing is
  being defeated today. The feature itself is genuinely tested one layer down, against `FallbackChain`
  directly. This is a trap for whoever wires it next, not a live defect. *(medium · packages/core/src/engine/{agent-runner,agent-session}.ts)*

- [ ] **`W2`'s own commit history does not meet `commit-style.md`, and the maintainer accepted it.** Of the
  34 commits on this branch, 31 subjects exceed the ~72-char guidance and 20 use a comma-separated
  multi-scope (`fix(llm,core,shared): …`) where the standard asks for the primary scope with the rest named
  in the body. Raised as a Low finding in the PR #85 review; the maintainer's call on 2026-08-28 was to
  leave it. The reason is worth recording, because it is a real trade and not an oversight: rewriting the
  history changes every SHA on an open PR, which un-anchors the inline review comments the fourteen findings
  were attached to — a worse outcome for a branch whose whole value is its reviewability. **The remedy is
  forward-looking:** `W3` writes them correctly from the first commit rather than fixing these. *(low ·
  [commit-style.md](../standards/commit-style.md))*

- [ ] **A cross-process resume RENEWS the node `timeout_ms`, where it does not renew the run cap.** Found by
  an adversarial pass on this round's own findings, not by the round itself. A node `running` at the crash is
  absent from the checkpoint, so resume seeds it `pending` and re-runs it; `#nodeDeadlineStartMs`
  (`engine.ts`) is in-memory and never checkpointed, so `#armNodeDeadline` arms the full authored value. The
  behaviour is defensible — the prior attempt's work is discarded, so charging its elapsed time would bill
  the author for nothing, and the run-level cap still bounds the total — and it is now stated in ADR-0085 §2
  rather than left to be inferred. Open only as a QUESTION for the maintainer: if the bound should be
  absolute across a resume as well, it needs a durable `nodeDeadlineStartMs` on the checkpoint, which is a
  spec change (`CheckpointState`) and therefore its own item. *(low · packages/core/src/engine/engine.ts,
  checkpoint.ts)*

- [ ] **`attemptTimeoutMs` has no upper bound, so `armLongTimer`'s multi-hop path is configuration-reachable.**
  The PR #85 round asked for an absolute-deadline rewrite of `armLongTimer` with an injected clock; declined,
  and the reasons matter because two of the first-pass reasons were themselves wrong. It is NOT blocked by the
  ADR append-only rule — [documentation-style.md](../standards/documentation-style.md) §7 permits amending an
  Accepted ADR in place with a dated note — and multi-hop is NOT unreachable by construction:
  `ChainCapabilities.attemptTimeoutMs` is caller-supplied and validated only as finite-and-positive, and
  `packages/shared/src/deadline.test.ts` already exercises a thirty-day chain. What is true is narrower and
  sufficient: no shipped surface passes a large value (zero hits for `attemptTimeoutMs` across `apps/**`), the
  spec's largest documented `timeout_ms` is 24 h — single-hop — and the drift a late hop introduces is always
  LATE, never early, which is the safe direction for a liveness backstop. Injecting a clock would also break
  the `SetTimer`→`SetDeadlineTimer` assignability ADR-0085 §9 deliberately relies on. Revisit if a surface
  ever exposes `attemptTimeoutMs`, or add a `MAX_TIMER_DELAY_MS` ceiling at its validation instead — the
  cheaper fix. *(low · packages/shared/src/deadline.ts, packages/llm/src/fallback-chain.ts)*

## Phase 2.6.5 `W1` residuals (PR #83, merged 2026-08-24)

Named rather than left implicit, because every one of them was examined during `W1` and consciously left
open — an unstated residual reads as an oversight, and the review that found the seven `PR83-*` defects said
so directly: these "should remain visible rather than disappear behind the green test suite."

- [ ] **Terminal-outbox drain, callable from any surface ([ADR-0078](../decisions/0078-ordered-durable-append-and-the-terminal-outbox.md) §4/§5).**
  `drainTerminalOutbox` is a `WorkflowEngine` method. **Narrowed 2026-11-05 (MVP-1 1b):** `run`, `gate`,
  `budget resume` and Home open now drain through `reconcile()` (the Home through a reconcile-only engine,
  `apps/cli/src/history/reconcile.ts`). What stays open: `chat` and `agent run` run on `AgentSession` and have
  no engine to drain with, and `status` NAMES a held run (`terminalHeld` in `--json`) without draining it. The real fix
  lifts it off the engine onto its host ports (`store` + `terminalOutbox` + `runLeases` + `mediaReferences`),
  so any surface can call it at startup. **Acceptance:** a held terminal is retried before `status` reads the
  run; a drain failure stays non-fatal and preserves the entry; the entry is removed only once the exact
  terminal is durably present. Deliberately NOT done inside `status` as a read command — draining claims a run
  lease, and a status read must not take ownership of a run another process may be finishing.
  *(packages/core/src/engine/engine.ts; apps/cli/src/commands/status.ts; ADR-0078 §4/§5)*

- [x] **Check-then-write symlink window on the append-only files.** The MCP grant store and the terminal
  outbox both `lstat` a path and then append to it by name, and their comments admit the window. On POSIX a
  descriptor-based open with `O_NOFOLLOW | O_APPEND | O_CREAT` followed by `fstat`/`fchmod` closes it. Recorded
  as defense-in-depth rather than a blocker: the present threat already requires write access to the user's
  `~/.relavium` directory. *(apps/cli/src/engine/{mcp-consent,terminal-outbox}.ts)*
  **Closed 2026-11-24 (PR #102 review: M-E2, `e0f848f4`):** both files append through `appendToOwnerOnlyFile`
  (`apps/cli/src/engine/owner-only-append.ts`: one open with `O_NOFOLLOW | O_NONBLOCK`, `fstat` must say a regular file, the
  write and the `0600` mode on that descriptor), and both reads (`readRegularFile`) refuse a link, a FIFO, a device, a
  directory and an oversize file (4 MiB for the consent log, 32 MiB for the outbox). Pinned by `owner-only-append.test.ts`,
  `mcp-consent.test.ts` and `terminal-outbox.test.ts`; [ADR-0084](../decisions/0084-consent-before-a-local-mcp-spawn.md)
  carries the note.
  **Followed 2026-11-24 (third security sitting, `33266015`):** the append also refuses a file with **more than one hard link**
  (`nlink` from the descriptor: a hard link passes `O_NOFOLLOW` and the regular-file check, so the write and the `fchmod` would land
  in the file the other name belongs to), the consent log caps a line at 16 KiB by trimming comparison metadata only, a record that
  would take it past its 4 MiB read cap is refused at the write with the way out named, and the unreadable-store warning ends with
  that way out. Reads through a hard link still work, on purpose. Pinned by `owner-only-append.test.ts`, `mcp-consent.test.ts` and
  `terminal-outbox.test.ts`; the ADR-0084 note of the same date carries it.

- [ ] **Consent overflow can be approved without being read ([ADR-0084](../decisions/0084-consent-before-a-local-mcp-spawn.md) §7).**
  The prompt shows 12 arguments / environment entries and states how many more exist, asking the user to open
  the artifact. That bounds terminal abuse well, but a declaration whose dangerous part sits in the hidden tail
  can still be approved. A premium trust experience would require an explicit view/acknowledge step when
  overflow exists. *(apps/cli/src/mcp/consent-prompt.ts; ADR-0084 §7)*

- [ ] **The effect audit's occurrence is coarser than its type promises ([ADR-0080](../decisions/0080-durable-effect-journal-and-the-tiered-effect-contract.md)).**
  `effect-journal-store.ts` records openly that the provider-attempt and provider tool-call identity are not
  threaded to dispatch. Nothing load-bearing depends on them — the dedup key is the identity and the resume
  gate reads the scope — but an operator-facing journal should eventually carry the exact occurrence
  `EffectAttemptId` describes. *(packages/db/src/effect-journal-store.ts)*

- [ ] **An authored `pattern` with no `max_length` can still stall the process ([ADR-0083](../decisions/0083-input-admission-and-a-resume-that-verifies-its-own-identity.md) §4).**
  `max_length` bounds the input a catastrophic regex chews on, and it is checked first — but only when the
  author supplied it. ADR-0083 accepts this floor explicitly. A stronger contract would require `max_length`
  whenever `pattern` is present, or admit only a demonstrably safe regex subset. **Reframed by the PR #97 review
  (2026-11-06): the author need not be the user.** An input's `default` is checked against its `pattern` when the
  file is PARSED, and `relavium list`, chat's `/workflows` and `/export`, and `relavium create`/`import`/`export`
  parse every workflow in the project's catalog. A workflow in a cloned repository with `pattern: '(a+)+'`, a default of `'a'` × 28 + `'!'` and no `max_length` stalled
  `parseWorkflow` for between about 1 s and 7.6 s in two measurements that day (machine and load differ), and the
  cost doubles with each character, so a repository can hang those commands with no input from the user. *(medium for that vector ·
  packages/shared/src/workflow.ts; ADR-0083 §4)*

- [ ] **Two SonarCloud CRITICALs are declines, not debt — mark them Accepted in the UI.**
  `WorkflowEngine#emitDurable`'s closure (23) and `dispatch` (22) are both over the cognitive-complexity
  threshold and neither can be split without harm: in both, the branches ARE the ordering the surrounding
  comments exist to protect. `#emitDurable`'s extraction would reinsert the microtask hop that reordered the
  log once already. Resolving them requires a maintainer action in SonarCloud, not a code change.
  *(packages/core/src/engine/engine.ts; packages/core/src/tools/registry.ts)*

## Interpolation engine (1.L2) follow-ups

> A comprehensive multi-dimensional pre-merge review of **1.L2** (PR #15, merged 2026-06-12) confirmed
> the engine sound and folded every actionable finding. Two cross-layer forward-obligations were
> deliberately deferred (each marked in a code comment); recorded here so the 1.M / 1.R implementers
> see them. The security-critical deferrals — re-tainting `run.outputs` for a secret-derived node
> output, and carrying resolved-interpolation provenance into the untrusted-content-as-data boundary —
> are already **1.O acceptance criteria** (phase-1 §1.O), so they are not duplicated here.

- [ ] **Frozen `ctx` checkpoint transport must use `structuredClone` (→ ctx-threading, not 1.R).**
  `resolveContext` returns an `Object.freeze`d **null-prototype** map so a `__proto__`/`constructor`
  context key is a safe own property. That guard is in-memory only: persisting/transporting it via
  `JSON.stringify` → `JSON.parse` (esp. with a reviver, or merged into `{}`) can re-materialize
  `__proto__` as a real setter. **NB (2026-06-15): ctx-threading landed (the ctx-threading PR) and RE-RESOLVES `ctx` at
  run start AND on resume — it is never carried in `CheckpointState`, so there is nothing to transport.**
  This obligation therefore stays dormant; it only becomes live if a future revision decides to CHECKPOINT
  `ctx` (instead of re-resolving it), at which point that transport MUST use `structuredClone` (never a
  JSON round-trip) and pin it with a test. *(packages/core/src/interpolation/resolve.ts)*

## AgentRunner (1.O) / reasoning-replay follow-ups

> **2026-06-14 1.O pre-implementation review.** [ADR-0039](../decisions/0039-same-provider-reasoning-replay.md)
> scopes the same-provider signed-reasoning replay to **Anthropic signed (non-redacted) thinking** — the case
> 1.O's headline acceptance needs. Two harder per-provider cases are explicitly deferred (recorded here, not
> shipped half-built) because each needs a canonical opaque-continuation carrier (a seam-shape addition tracked
> against [ADR-0030](../decisions/0030-llm-seam-shape-amendment-reasoning-response-format-provider-executed.md)).

- [ ] **Anthropic `redacted_thinking` replay** — the inbound fold drops the opaque `data`
  (`{ type: 'reasoning', text: '', redacted: true }`), so a redacted block can never be lowered back. Faithful
  replay needs the canonical reasoning `ContentPart` to carry an opaque continuation payload; until then a
  `redacted` part is carried as-is and not replayed, and redacted-thinking continuations are out of 1.O scope.
  *(high · packages/llm/src/adapters/anthropic.ts:126-127, packages/shared/src/content.ts:447-450; ADR-0030 follow-up)*
- [ ] **Gemini `thoughtSignature` on a TEXT or `inlineData` part** — a named deferral of
  [ADR-0090](../decisions/0090-a-continuation-token-rides-the-part-it-belongs-to.md), which scopes itself to
  the FUNCTION-CALL signature (the half that can 400). Google attaches the token to any `Part`, including a
  plain text part and an `inlineData` part on the image models, and neither `text` nor `media` has a field for
  one — while the streaming fold concatenates text and loses part order, so even capturing it would have
  nowhere to put it back. The failure here is degraded quality rather than a rejected request. Closing it
  needs a part-order-preserving fold, which is a larger change than the carrier decision.
  *(medium · packages/llm/src/adapters/gemini.ts, packages/shared/src/content.ts; ADR-0090)*
- [ ] **A continuation token is lost when a chain RETURNS to its issuing entry after a foreign hop** — the
  strip latch tracks the last ATTEMPTED entry, not each part's issuer, so `[gemini → openai → gemini]` inside
  one turn strips a gemini-issued token from a request going back to gemini. The result is a lost
  continuation, never a foreign token replayed — i.e. the pre-`CR-52` behaviour, never worse. Closing it needs
  per-part issuer provenance the seam does not carry.
  *(low · packages/llm/src/fallback-chain.ts; ADR-0090, `CR-52`)*
- [ ] **A `reasoning` signature still strips on the PROVIDER boundary, not the model one** — `CR-52` tightened
  the `tool_call` latch to (provider, model) because that part is unconditionally replayed; the reasoning
  latch keeps ADR-0039's accepted provider-only rule. A same-provider cross-model advance can therefore
  replay one model's signed thinking to another. Pre-existing, out of `CR-52`'s scope, and narrowing an
  Accepted decision belongs in its own ADR rather than a fold.
  *(low · packages/llm/src/fallback-chain.ts; ADR-0039)*
- [ ] **Per-attempt model attribution for `agent:token` / `agent:reasoning`** — `cost:updated` is always
  per-attempt-accurate, but the two mid-stream events `agent:token.model` and `agent:reasoning.model` (EA6, 2.5.H)
  use `activeModel` (updated from the *succeeding* attempt record, which fires after the stream), so a
  *cross-model pre-content failover* attributes that turn's tokens/reasoning to the prior model (reasoning arrives
  before text, so it shares the same window). A precise fix needs a `FallbackChain` `onAttemptStart`/attributed-stream
  hook (a seam change). *(low · packages/core/src/engine/agent-turn.ts; packages/llm/src/fallback-chain.ts)*
- [ ] **Multi-tool result ordering in the turn core** — `dispatchToolCalls` appends tool-result messages in
  dispatch-completion order; for v1.0 (single tool call per `tool_use` stop) this is moot — and 1.V now reuses
  the core on that single-tool path. A parallel-tool provider should order by the accumulator's `toolOrder`;
  re-home to whatever future parallel-tool work first enables it. *(low · packages/core/src/engine/agent-turn.ts; future parallel-tool)*

> **2026-06-14 (PR #18 final review follow-ups).** Confirmed by the multi-dimensional pre-merge review;
> non-blocking, recorded so they aren't dropped.

- [ ] **Parse-time `run.outputs`/`read_file` gate on system-bound fields** — 1.O assembles `system` from
  authored text only (secure), but `system_prompt_append` is collected as a `{{ … }}` reference site
  (`collect.ts`) so the contract *implies* dispatch resolution. A future PR that admits **trusted**
  `{{ inputs }}`/`{{ ctx }}` in system fields must add a parse-time gate **rejecting** untrusted
  `run.outputs`/`read_file` references there (analogous to the secret-taint gate — do **not** drop the field
  from `nodeReferenceSites`, which would remove the existing secret-leak protection). A pinning test already
  asserts an untrusted `run.outputs` value never reaches the system string.
  **Scheduled → 2.6.D.** *(medium · packages/core/src/interpolation/analyze.ts, collect.ts; SEC-1)*
- [ ] **Multimodal tool-result through the adjacent-message + redaction paths** — all 1.O coverage exercises
  text/JSON tool args + content; confirm image/media tool-result blocks survive the Anthropic adjacent-role
  merge (no dropped blocks / no double-merge with `stripReasoningParts`) and the redaction path. *(low · packages/llm/src/adapters/anthropic.ts; 1.AF)*
- [ ] **Checkpoint/resume of a mid-tool-loop turn** — whether a run paused/resumed between tool dispatches
  reconstructs the message history (assistant turn + partial tool results) consistently. **NB (2026-06-15):
  1.R (PR #22) resumes only at GATE boundaries; a crash mid-tool-loop is non-resumable → reconciled to
  `run:failed` (a started-but-unfinished node re-runs from `pending`). Faithful mid-loop resume needs
  persisted agent message history (`CheckpointState` carries none today) → Phase-2.** *(medium · 1.R/Phase-2)*

## Node-type handlers (1.P) follow-ups

> **2026-06-14 1.P implementation + pre-merge review.** The six non-agent handlers (condition / transform /
> fan_out / fan_in / input / output) landed behind the 1.N seam. A comprehensive multi-dimensional review
> confirmed 18 findings; all blocker/high/medium/low/nit items were folded **in the 1.P PR** — including a
> BLOCKER secret-leak (the `input` handler emitted raw `secret`-typed inputs into events; fixed by threading
> `secretInputNames` onto `NodeExecContext` and masking in the input handler + the expression scope). The
> items below are the deliberately-deferred forward work (maintainer-approved), recorded so they aren't lost.

- [~] **True `wait_first` early-cancellation of losing branches** — `merge_strategy: first` is implemented
  executor-only: the engine still waits for all branches to settle, then the `fan_in` handler takes the first
  by `branchNodeIds` order. Genuine early-cancel (abort the still-running sibling branches the moment the
  first settles) needs an **engine-owned per-branch cancellation primitive** — the current single run-wide
  `AbortSignal` cannot cancel one branch without cancelling the run, and a handler cannot cancel sibling
  vertices. The engine's own run-loop docblock (`packages/core/src/engine/engine.ts`, the header comment)
  records it as a future capability rather than a wiring the executor already reads. Promote to a scoped
  1.N/engine change (possibly an ADR) only when a real workflow needs it. *(This pointer deliberately names
  no line number: the previous one, `engine.ts:26-28`, quoted a "1.P refinement" phrase that ADR-0091's
  wording fix then deleted — a citation that decays the moment the thing it cites is corrected.)*

  **Precondition, added 2026-09-03 with [ADR-0091](../decisions/0091-first-means-first-declared-not-first-to-finish.md).**
  A future ADR that wants race semantics owes one thing this deferral does not yet answer: how the WINNING
  BRANCH ID is durably pinned at the moment it is selected. Without that, a replay from a checkpoint can pick
  a different winner and produce a different run from the same snapshot. (An earlier draft of ADR-0091 said
  race semantics were *forbidden* by ADR-0027 — they are not; §4 is about expression purity and §7 pins
  `branches` order for a `custom` `merge_fn`, whose input `first` never uses. The constraint is real but it
  is a precondition, not a veto.) The COST of the current behaviour is now pinned by an engine test: the join
  waits for a genuinely still-pending loser, and a failing loser fails the run even when the winner is
  already done. *(low · packages/core/src/engine/engine.ts, packages/core/src/engine/node-handlers/fan-in.ts; run-plan.md §fan-in)*
- [ ] **Should a merge with ZERO value-producing branches be refused at parse?** — opened 2026-09-03 by
  [ADR-0091](../decisions/0091-first-means-first-declared-not-first-to-finish.md)'s amendment. Now that a
  `condition`/`parallel` predecessor is a control edge rather than a branch, a merge whose only
  predecessors are control edges combines nothing: `first` → `null`, `concat` → `[]`, `custom` →
  `branches: []`, `object_merge` → `{}`. **`object_merge` is the reason this is a question rather than a
  shrug**: it is the one strategy that previously refused a phantom loudly, and it now succeeds quietly.
  The amendment deliberately did NOT add a parse rejection — such a merge loads today, and refusing it
  would stop a workflow from loading to improve a value that is meaningless under either reading — but a
  merge that combines nothing is an authoring mistake in every case anyone has been able to name, and
  refusing it is exactly the "found before money is spent" property `W6` exists for. Needs a maintainer
  ruling, not more analysis. *(S · packages/core/src/dag.ts, docs/reference/shared-core/node-types.md)*

## Node retry (1.S) follow-ups

> **2026-06-15 1.S implementation (ADR-0040).** The above-chain node-retry budget (Part A — the run loop
> re-dispatches a whole node on a retryable failure, with backoff, bounded by `retry.max`, applied to
> agent/condition/transform/merge nodes) landed. Part B is deferred:

- [ ] **retry-from-node — re-run a settled run from a chosen node (ADR-0040 Part B) → Phase-2.** Deferred
  because the in-memory engine cannot satisfy the design intent simultaneously: re-running on the **same
  `runId`** (so the host dedups completed-upstream side effects via `runId+nodeId+retryCount`) would append
  a **second terminal event** to a settled run, breaking the exactly-one-terminal invariant (ADR-0036) and
  the 1.R Checkpointer fold; a **new `runId`** keeps a single terminal but loses upstream side-effect dedup.
  Reconciling both needs the real persistent store + a **run-attempt model** (a re-run row referencing the
  original) — Phase-2, which already owns the surface trigger. The in-run budget (Part A) is the landed 1.S
  deliverable. *(medium · packages/core/src/engine/engine.ts; ADR-0040 Part B; Phase-2)*

## Checkpoint/resume + human gate (1.R / 1.Q) follow-ups

> **2026-06-15 1.R/1.Q implementation + two pre-merge review passes (PR #22).** The derived `Checkpointer`
> + cross-process `resumeFromCheckpoint` and the `human_in_the_loop` gate (suspend/resume + one-shot
> `setTimer` timeout port) landed; both review rounds' findings were folded in the PR. The items below are
> the deliberately-deferred forward work — each is a **Phase-2** concern that needs real persistence and/or
> a store-level guarantee the in-memory reference cannot provide, recorded so it isn't lost.

- [x] **Content-level workflow-identity guard on resume** *(done: `resumeFromCheckpoint` verifies the frozen `runs.workflow_definition_snapshot` against the resumed graph with `verifyFrozenWorkflowContent`, [ADR-0083](../decisions/0083-input-admission-and-a-resume-that-verifies-its-own-identity.md) §5; found stale and struck on 2026-11-22, MVP-8 pre-flight)* — `resumeFromCheckpoint` compares the surrogate
  `workflowId` (catches resuming a *different* workflow → `workflow_mismatch`), but not a *same-slug,
  edited-content* workflow. The stronger guard rides on the frozen `runs.workflow_definition_snapshot` column
  ([database-schema.md](../reference/shared-core/database-schema.md)) — a Phase-2 persistence concern wired with
  the real `RunStore`, not the event-derived in-memory state. **Scheduled → 2.6.H.** *(low · packages/core/src/engine/engine.ts; Phase-2)*
- [x] **Cross-process concurrent gate-resolve (TOCTOU)** *(re-scoped 2026-11-22, MVP-8 pre-flight: the lease first, then the compare-and-append guard and the fence already close the window in the store; MVP-8 step 2 proves it with a two-process test instead of adding an expression index, and closes this entry with the test's name)* — idempotent re-delivery holds within a process
  (`#resolvedGates`) and across processes once the prior process's `human_gate:resumed` is persisted (the
  checkpoint reconstructs `resolvedGateIds`). The residual window — two processes loading the *same* still-pending
  gate before either persists — is closed by a store-level uniqueness constraint on `human_gate:resumed` per
  `(runId, gateId)`, a Phase-2 SQLite/cloud-store guarantee, not the in-memory reference. **Scheduled → 2.6.H.** *(low · checkpoint.ts/engine.ts; Phase-2 store)*
  **Closed 2026-11-24 (PR #102 review: P02a-1, T02a-2, `26025249`):** the lease is acquired **before** the checkpoint is read
  ([ADR-0079](../decisions/0079-cross-process-run-ownership-lease-and-fencing-token.md) §4), so two processes cannot both load the
  same pending gate; the loser is refused `run_owned_elsewhere` before it reads or writes, and a stale in-memory card that answers
  meanwhile is refused at its re-take and ends fenced. Two barrier-held, interleaved tests hold the winner inside the window and
  prove both orders on the in-memory reference store: `packages/core/src/engine/stale-gate-card.e2e.test.ts`, the describe "two
  engines deciding the SAME gate at once, interleaved". No Phase-2 store constraint is needed, and the JSDoc of
  `resumeFromCheckpoint` now says so. The test with separately spawned OS processes stays registered, in the
  [MVP-8 step 2 section](#mvp-8-step-2-review-2026-11-22--the-lows-left-open-on-purpose).

## Home's chat has no way to view or pick the bound agent (found 2026-07-14)

- [ ] **Open — a narrative entry, owned by 2.6.G (the text below is the entry; marker added 2026-11-18).**

> Raised while answering a question about editing the agent used by a Home-opened chat. The headline gap is
> **already tracked** at [phase-2.6-conversational-authoring.md §2.6.G](phases/phase-2.6-conversational-authoring.md)
> — recorded here anyway because the investigation surfaced a narrower residual that 2.6.G's current task
> description does not clearly cover, so it doesn't get lost when that workstream starts.

**Confirmed today:** `apps/cli/src/home/drive-home.tsx:510` launches every Home chat with
`agentRef: undefined` — i.e. always the built-in `buildDefaultChatAgent` (`apps/cli/src/chat/default-agent.ts`:
fixed system prompt, a 3-tool read-only grant, no `temperature`). There is no picker, no `--agent`-equivalent
affordance, and none of the registered chat slash commands
(`apps/cli/src/commands/repl-commands.ts` — help/exit/cancel/export/workflows/cost/doctor/mode/effort/
thinking/compact/trim/clear/models/scrollback/edit/copy) shows or edits the bound agent's full config. The
only way to bind a custom `.agent.yaml` today is `relavium chat --agent <ref>` from a shell — a path Home
never takes.

**The "pick a different agent" half is already scheduled — do not re-file it.** 2.6.G's task list says, almost
verbatim: *"`/agents` browser (Home + chat): tabs Defined | Sessions. Defined: the agent catalog with
'start a chat with this agent' (closing the Home's built-in-agent-only gap)."* That is this exact gap, already
named and owned.

**The narrower residual 2.6.G's current description does not clearly cover:** a **read-only** view of the
*full* config of the agent already bound to the *current* session — system prompt, tool grant, `temperature`,
`reasoning_effort`, provider — not just picking a different agent for a *new* chat. 2.6.G's *Sessions* tab is
described only as *"recent + in-progress sessions... a detail view (transcript summary, cost, model
attribution)"* — model attribution (which model/provider) is there, but system prompt / tools / temperature /
reasoning_effort are not mentioned. Today there is nowhere at all — Home or the terminal `chat` command — to
inspect that for a session already in flight.

**This should stay read-only, not become an edit surface.** `resolveChatAgent`'s doc comment is explicit that
one agent binds a session for its whole lifetime by design — *"ADR-0024 — one agent per session, no
mid-session switching."* So the fix here is a **view**, not a live-mutate command: "show me what I'm actually
talking to" (worth having even by itself, e.g. after a `/clear` reseat or a `--agent` invocation where the
resolved config isn't obvious), not "let me tweak the running agent." Changing agents mid-session is already
correctly out of scope by design, and 2.6.G's "start a chat with this agent" (a *new* session) is the
sanctioned way to switch.

**Home:** 2.6.G — when that workstream is scoped, confirm the Sessions-tab detail view (or a lightweight
`/agent` / `/whoami`-style command available in both Home and the terminal `chat` command) explicitly
includes system prompt, tool grant, `temperature`, and `reasoning_effort` for the *current* session, not only
model/provider/cost. If it's deliberately left out, that should be a stated decision, not a silent gap.

## AgentSession (1.V) follow-ups

> **2026-06-16 — 1.V `AgentSession` (ADR-0024) + 1.AC budget governor (ADR-0028) merged in PR #26** (after two
> pre-merge review passes + a Sonnet multi-dimensional review). The in-memory `AgentSession` entry point landed —
> multi-turn `start`/`sendMessage`/`cancel` over the **shared turn core** (`runAgentTurn`), the hard turn cap →
> `turn_limit`, session-wide cost, emission via an injected `SessionEventSink`. The deferrals below were decided
> while building it; each has a clear later home, recorded so it isn't lost. The still-open follow-ons are **1.W**
> (wire the `SessionEventSink` onto the `RunEventBus` + per-session `sequenceNumber`/`SessionHandle`), **1.X**
> (session persistence + the durable `SessionMessage` schema), resume **1.Y**, export **1.Z**, and the deferred
> cost-event persistence (below) — those are workstreams, tracked in
> [phase-1-engine-and-llm.md](phases/phase-1-engine-and-llm.md), not deferred items.

- [ ] **Session budget pause/resume (1.V × 1.AC).** `AgentSession` threads the ADR-0028 `preEgress` hook as a
  pass-through but has no pause/resume gate machinery: a `BudgetPauseError` settles the turn LOUDLY as
  `budget_exceeded` (`#settleTurnError`) and is not re-raised — corrected 2026-09-18; the earlier wording here
  described a re-raise that no longer happens. The run path maps a budget pause to
  a `paused` node outcome via the human-gate seam; a budgeted session needs the analogous suspend/resume
  lifecycle. Wire it when sessions gain a budget (surface phases). **Scheduled → 2.6.K** (with the EA4-ride
  sibling below). *(medium · packages/core/src/engine/agent-session.ts; ADR-0028)*
- [ ] **Per-session tool narrowing (ADR-0029 narrow-only).** 1.V grants the bound agent's `tools` verbatim; a
  session cannot yet **narrow** them per-session (it may only ever narrow, never widen). Add a session-level
  narrow when a surface needs to restrict a session's tools below the agent's grant.
  *(low · packages/core/src/engine/agent-session.ts; ADR-0029)*
- [ ] **Session `output_schema`.** 1.V ignores `agent.output_schema` (a chat session is free-form text);
  structured output stays a workflow concern. If a session ever needs it, lower it to `responseFormat` +
  validate node-side (as the AgentRunner does for an `agent` node). *(low · packages/core/src/engine/agent-session.ts)*
- [ ] **Session `{{ctx.*}}` prompt interpolation (surfaced by 2.Q `agent run --input`).** `AgentSession.#runTurn`
  passes the agent's `system_prompt` **verbatim** — it does NOT `resolveTemplate` it against
  `#context.variables` the way the workflow `AgentRunner` interpolates an `agent` node's prompt. So
  `relavium agent run --input k=v` (2.Q) carries the variables in `SessionContext` (visible on `session:started`)
  but a `{{ctx.k}}` placeholder in the agent's prompt is sent to the model **literally**. Wire a `resolveTemplate`
  pass over the session prompt against a `RunScope` built from `context.variables`. **Governed by
  [ADR-0060](../decisions/0060-session-ctx-prompt-interpolation.md) (Proposed, Phase-2.6 / workstream 2.6.D)** —
  it is NOT a plain `resolveTemplate` reuse: the safe implementation requires a **new per-variable
  provenance/taint marker on `SessionContext`** (today a flat record) so `--input`-derived (untrusted) values
  can never reach the `system` position, plus the ADR's **mandatory security review of the session-prompt taint
  path before Accept**. **2.5-close decision (2026-07-08):** the phase-2.5 close-plan (Step 13, Batch C) proposed
  landing this here; the maintainer chose to **DEFER to Phase 2.6 / 2.6.D** — where ADR-0060 is finalized
  (Proposed→Accepted) with its taint-provenance marker + security review — rather than pull an unaccepted,
  security-critical Phase-2.6 ADR forward into the consolidation close-out. Only the sibling
  `AgentParseError` line/col half of Step 13 landed. *(medium · packages/core/src/engine/agent-session.ts;
  ADR-0060)*

## Phase 2.5.D (`@`-mention / input ergonomics) follow-ups

> **2026-07-03 2.5.D ([ADR-0061](../decisions/0061-cli-input-layer-file-injection-and-shell-escape.md), Accepted).**
> The `@`-mention file injection (dir-navigable completion + fs-jailed reader + nonce-fenced, size/line-bounded
> untrusted injection) shipped. These bounded pieces were deliberately deferred (each is additive; the
> confidentiality floor + jail + injection framing hold without them):

- [ ] **`@`-glob / directory expansion.** Single-file injection ships; `@src/**/*.ts` glob / whole-directory
  expansion is deferred (ADR-0061). **Scheduled → 2.6.E.** *(low · apps/cli/src/render/tui/mention.ts)*
- [ ] **`@`-mention of a binary / media file.** The reader fail-closes on a binary file (parity with `read_file`);
  a durable media-handle injection path (ADR-0031) is a follow-up. *(low · apps/cli/src/render/tui/mention.ts)*

## Phase 2.5.E (chat modes + per-tool approval) follow-ups

> **2026-07-02 2.5.E ([ADR-0057](../decisions/0057-cli-chat-modes-and-per-tool-approval.md), Accepted).** The
> reseat-less mode system + per-tool approval + mid-turn abort + the host arms shipped. These bounded pieces
> were deliberately deferred (each is additive, none blocks the mode system's security guarantees):

- [x] **Extract the `[c]` reason-capture to a shared pure reducer (2.5-close Step 14 review, test-parity).** *Closed 2026-11-19 (MVP-4 step 2): moot — the older reason-draft path it describes was deleted together with the legacy approval prompt; the approval card's own reason box is the one path and has tests in both hosts.* The
  reason-capture keystroke glue is duplicated inline in `ChatApp` (chat-ink.tsx) and the Home controller; the shared
  primitives (`reduceApprovalKey`, `sanitizeApprovalReason`, `reduceEditorMotion`) are unit-tested and the Home path
  has an integration test, but the ChatApp inline copy has no direct test (matching the existing no-ChatApp-integration
  boundary). Extracting the capture step to one pure reducer (like the mention/effort submodes) would let both
  surfaces test the same function. **Scheduled → 2.6.M** (with tool-render v2). **Not pulled into the CLI MVP (checked 2026-11-04):** MVP-3 takes only render v2's two named behaviours, and paused Step 14b owns the shared reducer's call-site swap. *(low · apps/cli/src/render/tui/chat-ink.tsx + home-controller.ts)*
- [ ] **Live `web_search` / `http_request` egress credential resolver.** `assembleToolEnv` accepts an
  `egressCredentialResolver` and the egress arm attaches it host-side as a Bearer, but the chat/Home session-host does
  not yet wire it to the keychain — so a `web_search` needing a provider key currently 401s (surfaced, never a crash).
  Wire the provider-key resolver through when the chat surface needs authenticated egress. **Scheduled → 2.6.M** (the `web_search` activation). **Pulled into the CLI MVP 2026-11-04 (MVP-7, `web_search` activation).** *(low · apps/cli/src/chat/session-host.ts)*
- [ ] **Session-level budget pause/resume (rides the EA4 machine).** The EA4 pause/resume state landed for mid-turn
  abort + approval; the ADR-0028 session budget `pause_for_approval` can now ride the same machine (today a chat
  cost-cap trip settles the turn loudly as `budget_exceeded` — the REPL is the approval gate). See also the 1.V
  session-budget follow-up above. **Scheduled → 2.6.K.** *(medium · apps/cli/src/chat + agent-session.ts)*

- [ ] **fs hard-link aliasing — the pnpm virtual-store read exemption (accepted residual, ADR-0057 review record).**
  The hard-link aliasing READ guard (`st.nlink > 1` ⇒ refused) is disabled ONLY for pnpm's `node_modules/.pnpm/…`
  virtual store (`isPnpmStorePath`), so dependency-source reads work on Linux (where pnpm hard-links). The bounded
  residual: a **compromised dependency** (a malicious postinstall, or a hard-link path-traversal in the extractor —
  the node-tar CVE class) could plant a cross-boundary hard link UNDER `node_modules/.pnpm/` that a later read would
  follow; the same actor already has local RCE, and the sensitive-read floor still refuses a NAMED secret store even
  there. A future opt-out (`allow_aliased_reads` config, or resolving the inode's other name against a tool-known
  pnpm store root) would let a stricter deployment disable even this. *(low · apps/cli/src/engine/tool-host/fs.ts)*
- [ ] **Target-scoped approval cache + a per-tool preview target (ADR-0057 review elevation).** The once/always
  `ApprovalCache` is keyed by tool id only, so an `[a]lways` grant blankets every allowlisted target of that tool
  for the session (a `write_file` always covers every non-protected path; an `http_request` always covers every
  `allowedDomains` host). It is bounded (enforcePolicy's allowlists + the fs protected-paths floor still gate each
  dispatch) and is the documented accept-edits semantics — but keying by `(toolId, target)` (a path prefix for
  fs, a host for egress, a server for mcp) would make `always` track what the user actually reviewed. Pairs with:
  surface the MCP server/tool in `ToolActionPreview` (today `mcp_call`/`web_search` return a BLANK preview, so
  F3 correctly forbids caching their `always`) — a structured `{mcpServer,mcpTool}` preview would turn the
  blank-check downgrade into a real, reviewable, cacheable per-server grant. **Scheduled → 2.6.M.** *(medium · apps/cli/src/chat/chat-mode.ts + packages/core/src/tools/{types,registry,builtins}.ts + run-event.ts)*

## Phase-2 CLI (2.D) follow-ups

> **2026-06-22 2.D (`relavium run`) implementation.** The CLI was wired to `@relavium/core` — the first
> real engine consumer. The planned scope-splits it leans on (rich `ink` TUI → 2.E; finalized `--json`
> envelope → 2.F; interactive gate prompt + `relavium gate` resume → 2.G; durable run history → 2.H;
> provider keys from the OS keychain → 2.C) are tracked as their own workstreams in
> [phases/phase-2-cli.md](phases/phase-2-cli.md) and summarized in the `### relavium run` *Implementation
> status* note in [../reference/cli/commands.md](../reference/cli/commands.md), so they are **not**
> duplicated here. The one item below is an unscheduled security follow-up with no numbered workstream yet.

- [ ] **CLI `ToolHost` — the built-in host capabilities are wired for the CLI; the DESKTOP surface remains.**
  2.D originally built the tool registry with an empty `ToolHost` (`createToolRegistry({ tools: BUILTIN_TOOLS,
  host: {} })`). For the CLI this is now **closed**: 2.5.A wired the `fs` + `process` arms and 2.5.E wired the
  `egress` + `os` arms via `assembleToolEnv`, all behind the fail-closed approval floor (see the **RESOLVED**
  block below *[Moved 2026-11-18: the RESOLVED entries now sit in the [closed record](deferred-tasks-history.md#phase-25a-tool-environment-factory-follow-ups--closed-entries)]*, [ADR-0055](../decisions/0055-cli-host-capability-seam-tool-environment-factory.md) +
  [ADR-0057](../decisions/0057-cli-chat-modes-and-per-tool-approval.md)). What remains: the **desktop/Tauri**
  surface has no tool host wired yet (Phase 3), and its host-side `EgressCapability.fetch` SSRF hardening tracks
  with the SSRF item above. Until the desktop host is wired, a desktop workflow calling a capability-backed
  built-in tool surfaces a clean "tool unavailable" failure, never a half-implemented or unsafe execution.
  *(medium · desktop tool host; Phase 3; security-review.md; egress → the SSRF item above)*
- [ ] **VS Code docs claim a SQLCipher `history.db` "same store as CLI" — contradicts ADR-0050.** The
  Phase-4 VS Code docs ([reference/vscode/extension-api.md](../reference/vscode/extension-api.md) L46/67,
  [phases/phase-4-vscode.md](phases/phase-4-vscode.md) L376/378) still carry the pre-ADR-0050 assumption that
  the extension host opens the **SQLCipher** `history.db` that is **"the same store as CLI/desktop"**. Per
  [ADR-0050](../decisions/0050-cli-history-db-at-rest-posture.md) the CLI store is `better-sqlite3`
  **unencrypted** and a SQLCipher file cannot be the same physical file; there is no cross-surface shared
  session/run store until a Phase-3/4 ADR reconciles it. Reword the VS Code at-rest posture once the
  cross-host physical-store decision lands. *(low · Phase 4 forward-design docs; blocked on the cross-host
  store decision; surfaced during the 2.5.J encrypted-wording sweep)*
- [ ] **Run-resume reconstruction reads (`loadRun` + `loadRunEvents` + `loadStepExecutions`) are separate
  reads at the caller level — the same torn-read class 2.5.I S1 fixed for session `loadFull`.** A concurrent
  writer committing between them could yield a run row + event/step reads from different snapshots. Lower
  impact than the session case: run history is **event-sourced** and the checkpoint fold tolerates partial
  state, so a torn read self-heals on the next fold. If tightened, wrap the caller-level reconstruction in one
  read transaction (as `loadFull` now does). **Scheduled → 2.6.H.** *(low · packages/db run-history-store consumers + the resume
  caller; surfaced during 2.5.I S1 review)*
- [x] **The CLI chat persister writes a turn non-atomically — messages then session totals in separate
  auto-committed statements.** `apps/cli/src/chat/persister.ts` appends the user + assistant messages and then
  `updateSession`s the running totals as separate writes, so the DB legitimately passes through a state where a
  turn's messages are present but its totals are stale. `sessionStore.loadFull`'s read transaction (2.5.I S1)
  guarantees *snapshot* consistency (both reads see one DB snapshot) but not *turn* atomicity — a snapshot can
  observe messages ahead of their totals. To make "totals always match the returned messages" hold, wrap each
  turn's message-appends + `updateSession` in one host-side `db.transaction` (BEGIN IMMEDIATE). Bounded, host-side.
  **Scheduled → 2.6.H.** *(low · apps/cli/src/chat/persister.ts; surfaced during 2.5.I S2 review)* **Done:** `store.writeTurn` is one `BEGIN IMMEDIATE` transaction for the messages and the session totals (`packages/db/src/session-store.ts:667`, called from `persister.ts`); struck 2026-11-22, MVP-8 pre-flight.
- [ ] **`relavium run` maps any `run:paused` to exit 3 (gate-paused); revisit when media host-wiring lands.**
  `run.ts` returns `EXIT_CODES.gatePaused` (3) for any `run:paused`, which is correct in 2.D because a
  human gate is the **only** `run:paused` source (no `mediaStore`/media-job host is wired, so a media-only
  park — a valid `run:paused` carrying `pendingMediaJobNodeIds` and no gates, per `RunPausedEventSchema` /
  1.AG §D — can never be emitted). When the media host capability lands (the same surface as the deferred
  media-egress work, ~2.S), a media-only park would be reported as "gate-paused" with no gate; at that point
  decide whether exit 3 (and the rendered message) should distinguish a gate park from a media park.
  **Scheduled → 2.6.K.** *(low · apps/cli/src/commands/run.ts; media host-wiring / 2.S)*

### 2.I read-command follow-ups (PR #48 multi-agent review, 2026-06-24)

> The PR #48 review (7-dimension multi-agent pass) returned **0 blocker / 0 major**; the fix-now items (the
> catalog special-file guard + the doc/contract corrections) and the cheap test/code nits landed in the PR.
> The items below were verified-real but graded **fix-followup** — none blocks merge.

- [ ] **`AgentParseError` diagnostics are invisible on the `chat --agent` / `agent run` surfaces** (surfaced by
  the 2.5-close Step 13 Sonnet review, 2026-07-08). `resolveChatAgent` (agent-source.ts) deliberately surfaces
  the RAW `AgentParseError` — pinned by `agent-source.test.ts` "surfaces an invalid .agent.yaml as a field-named
  AgentParseError (not a silent default or CliError)" — and neither `buildChatSession` nor `agent-run.ts` catches
  it, so a malformed-but-existing `.agent.yaml` reaches the top-level `renderError`/`toUserFacing` and is reduced
  to exit **1** + the generic "An unexpected internal error occurred" (human AND `--json`). So the field-named,
  position-enriched diagnostic Step 13 built only actually reaches a user via `list --agents` / `create` /
  `import` (`catalog.ts` / `authoring.ts`, which DO catch it). **Pre-existing** (predates Step 13; the diff only
  changed message CONTENT, not this catch-layer gap) and it **conflicts with the deliberate `isCliError === false`
  test above**, so re-tagging is a cross-surface DESIGN decision, not a mechanical fix — deferred out of the
  `fix(core)` close-out. Fix options (need a maintainer call on which): (a) wrap the `AgentParseError` into a
  `CliError('invalid_invocation', err.message, { cause })` at `resolveChatAgent` / the `agent-run`/`chat` callers
  (revising the pinned test), or (b) teach the top-level `renderError`/`toUserFacing` to render a typed
  `AgentParseError` as an exit-2 invocation fault. Also relativize the `source` label at the `chat`/`agent run`
  call site (`agent-source.ts` passes the ABSOLUTE `source.path`, unlike the catalog's workspace-relative `rel`;
  no secret leak — it is the user-typed path — but it contradicts the parser docstring's "workspace-relative").
  **Scheduled → 2.6.B** (the conversational-authoring loop needs these diagnostics visible).
  *(medium · apps/cli/src/chat/agent-source.ts + session-host.ts + commands/agent-run.ts + run.ts)*
- [ ] **Residual read-command test pins.** A few low-risk coverage gaps remain after the PR's test additions:
  `pendingHumanGates` with `expiresAt` present and with multiple simultaneous gates; `list --json` no-project
  stderr + invalid-entry `error` machine-contract; the `status` "no node activity" fallback. The production code
  is correct (verified); these are operator-surface pins. *(low · apps/cli/src/**/*.test.ts; testing.md)*
- [ ] **Phase-doc structural views still omit `gate list`.** The §2.I heading + acceptance now name `gate list`,
  but the two Mermaid graphs and the from-scratch wave/dependency tables describe the original plan node and
  were left unchanged (they are the plan, not a live tracker). Fold `gate list` in if those diagrams are ever
  regenerated. *(nit · docs/roadmap/phases/phase-2-cli.md)*
- [~] **Offset/cursor pagination for the history read commands (cloud-scale only).** Split out on 2026-11-18 from the closed entry
  [History-read query indexes](deferred-tasks-history.md#2i-read-command-follow-ups-pr-48-multi-agent-review-2026-06-24--closed-entries), which keeps only the index work
  (migration 0005, `{ limit }` top-N on the Home reads). Still open: `listRuns` and `listSessions` take only `{ limit }` (no offset or cursor), and `relavium list` and
  `loadLatestRunPerWorkflow` still return the full set. Genuinely unneeded at single-user CLI scale. **Trigger:** add a cursor API before the desktop or cloud surfaces drive these
  reads at volume. *(low → scale · packages/db/src/run-history-store.ts, packages/db/src/session-store.ts; database-schema.md)*

## Phase 2.5.A (tool-environment factory) follow-ups

> **2026-06-28 2.5.A ([ADR-0055](../decisions/0055-cli-host-capability-seam-tool-environment-factory.md)).**
> The shared CLI **tool-environment factory** landed the `fs` + `process` `ToolHost` arms behind one
> `assembleToolEnv({ profile, fsScopeTier, workspaceDir })` seam, the advertise-filter, the `tool_unavailable`
> (EA1) fail-closed backstop, and real failed-turn usage (EA2). This directly advanced the 2.D *"CLI `ToolHost`
> is fail-closed"* item above. The `fs`/`process` halves were wired + security-reviewed in 2.5.A; the **`egress`
> and `os` halves + the write-capable chat tier landed in 2.5.E** ([ADR-0057](../decisions/0057-cli-chat-modes-and-per-tool-approval.md))
> behind the per-tool approval floor (see the resolved items below *[Moved 2026-11-18: now in the [closed record](deferred-tasks-history.md#phase-25a-tool-environment-factory-follow-ups--closed-entries)]* + the *Phase 2.5.E follow-ups* section). The
> 2.5.A items were confirmed by the PR #60 review passes and deliberately **not** taken in-PR — none blocked the milestone.

- [ ] **Residual fs TOCTOU on the PARENT directory (no `openat` in Node).** The read path (`readJailedFile`)
  and the write paths (append + temp/rename) all open the FINAL component with `O_NOFOLLOW`, so a final-component
  symlink swapped in after the jail's `realpath` fails closed. The unclosable residual is a swap of a PARENT
  directory component to an out-of-jail symlink between the `realpath` and the open — Node exposes no
  `openat`/`openat2` (nor Linux `RESOLVE_BENEATH`) to pin the parent by fd, so a pure-path open re-walks the
  (possibly swapped) parents. The window is narrowed to the gap between `jailExisting`/`jailWriteTarget`'s
  `realpath` and the immediately-following open. Additionally, `O_NOFOLLOW` is `0` on **Windows**, so even the
  final-component guard there rests on the pre-op `lstat` alone (the non-race case). Reads are bounded, and the
  write arm now serves the approval-gated `chat-read-write` chat as well as the author-trusted workflow-run path;
  the **ADR-0057 mandatory security review explicitly re-assessed and accepted** this Windows-only parent-swap
  residual for the write-capable surface (the protected-paths refusal + fs jail still hold). Close the gap with a
  native `openat`-based helper (or a Rust-side resolver) if an untrusted-read surface raises the bar. *(low · apps/cli/src/engine/tool-host/fs.ts)*
- [ ] **Deliberate non-fixes from the PR #60 excellence review (recorded, not bugs).** Each was weighed and
  skipped with a reason: (a) **no host-arm memoization** (fs scope-checker, process base-env, exec cache) —
  each would cache a security-relevant `realpath` on an I/O-dominated cold path, defeating the per-call
  re-resolution that catches a mid-session symlink swap; (b) **no tool-name prefix on the shared fs helper
  errors** (`jailExisting`/`assertInScope`/`lexicalTarget`) — they back read/write/list, so a single prefix
  would need `toolName` threading for marginal gain (write-only messages *are* prefixed); (c) the generic
  `guarded()` catch-all stays **reason-only** (the I3 boundary). Re-open only if a concrete need appears.
  *(nit · apps/cli/src/engine/tool-host/)*

## Schema / validation hardening

- [ ] **`z.unknown()` payload presence** — `agent:tool_call.toolInput`, `node:completed.output`,
  `human_gate:resumed.payload` validate even when absent. Decide presence per field (force the
  key via a `.superRefine` hasOwnProperty check, or document absence is OK) and add accept/reject
  tests. *(minor · run-event.ts:64,93,124)* **Deferred 2026-06-07:** the obvious per-member
  `.superRefine` is infeasible — these events are members of `z.discriminatedUnion`, which rejects a
  `ZodEffects` member; the correct fix adds the `hasOwnProperty` check to the existing outer
  `RunEventSchema.superRefine` (where the runId/sessionId cross-check already lives). Low value, left
  for the consumer that needs the guarantee.

- [ ] **The MCP schema compiler's denylist silently DROPS unsupported assertions** *(High · pre-existing ·
  surfaced by the PR #87 review, 2026-09-01)* — `compileJsonSchemaToZod` refuses a finite list of unsupported
  constructs and passes everything else through, so a keyword it does not implement is ignored rather than
  refused. Reproduced: `{ "type": "number", "exclusiveMinimum": 0 }` compiles **ok** and the resulting
  validator **accepts `0`**. Same for any sibling assertion outside the list (`multipleOf`, `pattern` on a
  non-string, `minItems`, …).

  This contradicts [ADR-0052](../decisions/0052-inbound-mcp-client-package-lifecycle-registration.md)'s
  "an `inputSchema` outside the supported subset **drops the tool at discovery** (fail closed)": the tool is
  admitted, and our dispatch gate is weaker than the schema the server published. The server still validates
  on its own side, so this is a weaker gate rather than an open door — which is why it is recorded rather than
  rushed.

  **Not a `W4` regression** and deliberately not fixed inside it: the correct shape is a per-type **supported-key
  allowlist**, which starts REFUSING schemas that work today, so it needs its own change with its own
  compatibility review. Scoped that way, or an explicit ADR note narrowing ADR-0052's claim to the keys the
  compiler actually implements.

## Test depth

- [ ] **dist-resolution packaging test** — the migration runner is tested only from `src/`; add
  a smoke test that imports built `dist/index.js` and runs `runMigrations` (the path consumers
  use). *(minor · packages/db/src/client.test.ts)* **Deferred 2026-06-07:** fragile as a Vitest unit
  test (it must import `dist/` which only exists after `turbo run build`, so it would skip or fail
  depending on run order). Belongs in a dedicated post-build packaging-smoke step, not the unit suite.

## Tooling / CI

- [ ] **Local `format:check` via turbo** — CI now runs `turbo run format:check`; consider routing
  the root `format:check` npm script through turbo too so local + CI share the cache. *(minor · package.json:21)*
  **Deferred 2026-06-07:** low-value cache nit that needs a task rename to avoid turbo recursion
  (`//#format:check` is bound by name to the `format:check` script); CI already runs through turbo,
  so only the local cache-share is missing. Not worth the rename churn now.
- [ ] **Enable the live-nightly conformance lane** — the per-provider conformance suite runs in
  fixture mode on every PR, but the scheduled live-API lane is still reserved/commented in `ci.yml`
  (the "enable with the first provider adapter" TODO), and the adapters have now landed (PR #9, M1).
  `1.J` accepted M1 with the live lane **explicitly pending keys**; to actually exercise it,
  uncomment the `schedule:` lane and add the provider API keys (`ANTHROPIC_API_KEY` / `OPENAI_API_KEY`
  / `GEMINI_API_KEY` / `DEEPSEEK_API_KEY`) as CI secrets. Until then live coverage is a known gap.
  **Decided (2026-06-21, maintainer): defer to Phase-2 workstream 2.K** — enable the live-nightly lane
  together with the 2.K regression harness rather than as a pre-Phase-2 ops chore; fixture coverage holds
  the line until then. **Update (2026-07-08): 2.K has shipped; this is now a Phase-2.6 in-window
  maintenance obligation** (see [phase-2.6](phases/phase-2.6-conversational-authoring.md) §"In-window
  maintenance obligations") — enable when CI provider keys are available.
  *(minor → keys · ci.yml, packages/llm/src/conformance/*.conformance.test.ts)*
- [ ] **Leakwatch secret-scanning CI gate** — CI has no secret-scan step. The HodeTech standard
  scanner is **Leakwatch** (never gitleaks); the blocking `ci.yml` step is wired once a
  distribution path for the binary onto Actions runners exists (private release / action). Until
  then scanning runs locally with the installed binary, and test fixtures keep building any
  key-shaped strings via `join()` so no contiguous key literal ever sits in the tree. Exceptions,
  when the gate lands, are documented per finding — never blanket-ignored.
  *(blocked → distribution path · ci.yml, security-review.md)*
- [ ] **Dependency-bump cooling window** — adopt a "no same-day upgrades" posture for runtime
  dependency bumps: a freshly published version waits a cooling period before entering the
  lockfile (supply-chain compromise of a new release is typically detected within days), with a
  documented security-exception path (a CVE fix may skip the window, recorded in the PR). pnpm 9
  has no native knob for this; enforce as review policy now and revisit native enforcement
  (e.g. a minimum-release-age setting) when the toolchain moves to a pnpm major that has one.
  *(policy now, tooling later · pnpm-workspace.yaml, architectural-principles.md)*

## Sonar code-quality backlog

> **2026-06-14 (PR #18 review).** Verified Sonar findings in **already-merged** code (1.L/1.L2/1.T/0.x),
> outside the 1.O diff — kept out of the 1.O feature PR (a behaviour-preserving refactor of merged,
> tested code is its own change, not feature scope). Pick these up in a dedicated `chore: sonar cleanup`
> pass. The 1.O-diff findings (the `tryParseJson` fence regex → string ops, and the `#nodeEmit`
> duplicate cases → fallthrough) were fixed in PR #18; they are **not** listed here.

- [ ] **2026-07-29 Sonar sweep — ~30 findings in already-merged code, outside the Wave 0 diff.** Recorded
      per this section's standing policy: a behaviour-preserving refactor of merged, tested code is its own
      change, not feature scope. Highest-value first: `chat-ink.tsx:1151` cognitive complexity **91 → 15**
      (the same god-file 2.5.5.I declines to decompose — hand it to 2.6.M's render-v2), `bounding.ts:165/:180`
      two regexes at complexity 38 and 57, `references.ts:154` a regex with **super-linear backtracking**
      (the only finding here with a runtime-safety edge — it parses `{{ }}` filter arguments, so treat it as
      2.5.5.A scope, not cosmetic), `agent-session.ts:545` complexity 17, `create-prompter.ts:70` a nested
      ternary, three `RunApp.tsx` array-index keys, two `'never' is overridden` union types, two
      `.some()` → `.includes()`, `openai.ts:481` nested template literals, `node.ts:60` `String.raw`, plus
      ~10 test-only nits (`toHaveLength`, parameterised tests, `test.skip()`).
- [ ] **2026-09-02 Sonar sweep during the PR #87 review — three findings in code the wave did not touch.**
      Same standing policy: a behaviour-preserving refactor of merged, tested code is its own change. The
      findings inside the `W4` diff were fixed in it (`scanSchema` and `isMetadataOrLinkLocal` split along the
      JSON type union and the address family; `buildServerToolDefs`'s gate sequence extracted verbatim into
      `admitTool`); these three are outside it:
      - `apps/cli/src/commands/run.ts:153` — `runCommand` cognitive complexity **26 → 15**. A ~300-line
        orchestration (parse → engine → drive → outcome → exit code) with the CLI's densest test coverage
        around it. The natural seam is per-phase extraction; it wants its own change, not a review fold.
      - `packages/shared/src/content.ts:1430` — `extractEgressAuthority` **24 → 15**. A security-critical URL
        parser where each branch is a documented refusal case. Its sibling `isMetadataOrLinkLocal` has already
        shipped one bug from branch interaction (`::1` read as metadata), so a refactor here needs the same
        before/after verdict sweep that one got, deliberately and not incidentally.
      - `packages/db/src/safe-egress.ts:198` — "prefer an optional chain" on
        `local !== undefined && target.host === local.host && target.port === local.port`. **Declined, not
        deferred:** `local?.host === target.host && local?.port === target.port` is equivalent but reads as
        two independent comparisons, losing the "there IS an authored opt-in AND it matches" structure that is
        the whole precondition of the local-endpoint policy. Worth marking won't-fix in SonarQube rather than
        re-surfacing each sweep.

      **Not actioned, with reasons:** the `--ignore-scripts` findings on all four workflows are declined —
      `pnpm.onlyBuiltDependencies` (root `package.json`) already allowlists the only two packages permitted
      to run install scripts, and adding the flag would break both while weakening nothing else; the
      `ci.yml` reserved-lane TODO was deleted in Wave 0 rather than deferred (it was superseded by
      `models-catalog.yml`'s live nightly lane).
      *(chore · a dedicated `chore: sonar cleanup` pass)*

- [ ] **Duplicated SQL literal in the initial migration (0.x)** — Sonar flags a 4× literal in the
  generated drizzle migration. Migrations are **append-only / generated** (never hand-edited), so this is
  informational — only act if the literal recurs in the *schema source* a future migration regenerates.
  *(critical-by-Sonar / likely won't-fix · packages/db/drizzle/0000_organic_the_santerians.sql:118)*

> **Intentional — not a defect (do not "fix"; recorded so Sonar's generic suggestion isn't re-litigated):**
> `bounding.ts` uses `charCodeAt` deliberately for **WTF-8 lone-surrogate** byte counting (and the
> matching test asserts surrogate pairs per UTF-16 unit) — `codePointAt` would merge pairs and break the
> pinned tests. `type ToolId = string` is a deliberate **semantic domain alias** for readability, not a
> redundant alias.

## Phase-2.6 out-of-scope carry-forward

> Items explicitly marked out-of-scope in
> [phase-2.6-conversational-authoring.md](phases/phase-2.6-conversational-authoring.md) that had no
> prior tracking entry in this file. Recorded 2026-07-08 so they don't get lost. Each maps to a
> concrete later phase or decision gate.

- [ ] **Dynamic runtime `invoke_workflow` from a workflow agent node.** Deferred past Phase 2.6 by decision
      **D57** (2026-07-26): a running workflow's agent node selecting a sub-workflow at runtime by model
      judgment is the unauthored composition 2.6.P's *authored surface == executable surface* invariant
      exists to prevent, and it has no cost-governance boundary. 2.6.P ships the **authored** `subworkflow`
      node only. **Owner:** a dedicated ADR + security review covering target selection, the nested-run
      event namespace, and cost/resource governance — before any implementation.
      *(medium · `packages/core` engine + an `invoke_workflow` tool)*

- [ ] **File-snapshot undo (revert of message + file changes).** Phase 2.6.E ships
  conversation-level `/rewind`/`/fork` only — reverting the file changes a message made requires an
  engine-level file-snapshot mechanism (tracking which tool calls modified which files at which
  conversation point). Deferred to [Phase 3 — desktop](../roadmap/phases/phase-3-desktop.md) or a
  dedicated follow-up ADR. *(medium · packages/core engine)*
- [ ] **Workflow-run `egress`/`os` arms in `build-engine.ts`.** The chat surface has `egress` and
  `os` wired behind the per-tool approval floor (2.5.E). The workflow-run path (`build-engine.ts`)
  deliberately wires only `fs`+`process` — the `egress`/`os` arms are not threaded into the workflow
  `ToolHost` factory. Revisiting this boundary requires its own ADR (the tool-environment factory
  design in [ADR-0055](../decisions/0055-cli-host-capability-seam-tool-environment-factory.md) /
  [ADR-0057](../decisions/0057-cli-chat-modes-and-per-tool-approval.md) was scoped to chat-first).
  **Owner:** a dedicated ADR before any implementation; likely Phase 3+ when workflows gain the
  full tool surface. *(medium · apps/cli/src/engine/build-engine.ts + assemble.ts)*
- [ ] **Multi-pane dashboard.** A split-pane or multi-tab dashboard layout for the Home (e.g.
  chat on the left, run monitor on the right) is explicitly **desktop canvas territory**
  ([ADR-0007](../decisions/0007-desktop-is-not-an-ide.md) — the CLI is not an IDE shell). The
  desktop app ([Phase 3](../roadmap/phases/phase-3-desktop.md)) owns the visual multi-pane
  experience; the CLI stays single-viewport. *(medium · apps/desktop)*
- [~] **`plugin` ToolSource loader.** The `ToolSource` type already defines `'builtin' | 'mcp' |
  'plugin'` (`packages/core/src/tools/types.ts`), but the `plugin` variant has no loader, no
  resolver, and no runtime wiring. Plugins loaded from npm packages or user-supplied JS/TS files
  need a sandboxed execution environment and an installation/security model distinct from both
  built-in tools and MCP. Deferred until there is concrete demand beyond the existing built-in +
  MCP tool surface (both of which are sufficient for Phase-2.6 toolbelt parity). *(medium ·
  packages/core/src/tools; [Phase 4 — VS Code](../roadmap/phases/phase-4-vscode.md) / post-Phase-3)*

### 2.6.F (full-screen renderer) — deferred by ADR-0067 / ADR-0068 (recorded 2026-07-09)

- [ ] **`vitest` 5 + `eslint` 10 toolchain migrations.** The [ADR-0067](../decisions/0067-node-supported-floor-22-reaffirm-better-sqlite3.md)
  floor bump to Node `>=22` makes `vitest` 5 (needs `>=22.12`) *eligible*; `eslint` 10 (needs `>=20.19`)
  was already reachable. Both are **explicitly out of Step-scope** — each is its own independent migration
  PR with its own breakage risk, never riding the governed floor bump ([node-runtime-upgrade.md §5/§8](phases/node-runtime-upgrade.md)).
  Not Phase-2.6 work; pick up when the toolchain is bumped on its own track. *(med · pnpm-workspace catalog + configs)*
- [ ] **Mouse click / drag / text-selection / copy-on-select / hover / URL-open.** [ADR-0068](../decisions/0068-full-screen-tui-renderer-ink7-harness.md)
  ships **wheel-only** mouse (DECSET 1000+1006, codes 64/65) in 2.6.F. Full mouse — click-to-position,
  click-to-expand, drag text-selection + copy-on-select (pbcopy/wl-copy/OSC-52), hover, Cmd/Ctrl-click
  URL/file-open — and per-terminal scroll-speed normalization pull in motion tracking (1002/1003), hit-test
  geometry, a clipboard bridge, and per-terminal quirks. **Deferred to [Phase 3 — desktop](phases/phase-3-desktop.md)
  / a later CLI polish PR.** *(med · apps/cli/src/render/tui + a clipboard bridge)*
- [ ] **Flip the mouse-wheel default OFF → ON-with-opt-out.** [ADR-0068](../decisions/0068-full-screen-tui-renderer-ink7-harness.md)
  ships wheel-scroll **opt-in** (`[preferences].mouse` default off) for the first release — keyboard
  PgUp/PgDn covers the core need and mouse capture disables native copy-on-select. After real-terminal
  validation (SSH/tmux/VS Code/iTerm2/Warp) with the 2.6.F harness, flip the default to **on-with-`--no-mouse`**
  (the field norm). A tracked 2.6.F follow-up, not a defect. *(low · apps/cli config default + validation matrix)*
- [ ] **Step 4b: bound / scroll the LIVE REGION when it alone exceeds the terminal height.** The alt-screen chat
  bounds the whole tree to the terminal `rows` with the transcript viewport flex-growing above a FIXED live region
  (prompt / approval / warnings / footer). When the live region ALONE is taller than the terminal (a huge pasted
  multi-line prompt, or a big approval block + warnings on a short terminal), the viewport measures height ≤ 0 and
  renders nothing (acceptable), but the fixed live region then overflows the `height={rows}` container — and the
  observed failure mode is WORSE than a clean top-clip (Step-4b-1 Sonnet review, empirical): at `rows` 1–2 two
  distinct fixed status lines visually MERGE onto one terminal row (character-level overlap), and at `rows` 3 a whole
  fixed line (the compose prompt) silently vanishes — the alt buffer has no scrollback to reach the lost content.
  Long-term give the live region its own bounded/scrollable box or guarantee the viewport a minimum height.
  *(low · apps/cli/src/render/tui/chat-ink.tsx ChatView layout)*
- [ ] **`isWide` still under-counts a few non-emoji EAW=Wide BMP punctuation code points (Step-4b-2 Sonnet review, NIT).**
  The per-code-point `isWide` table misses a handful of East-Asian-Width=Wide BMP points immediately adjacent to ranges
  it already handles: U+2329/232A angle brackets, U+268A–268F (Yijing monogram/digram symbols), and the U+4DC0–4DFF
  Yijing Hexagram Symbols block (just past the 0x4DBF CJK-Ext-A cutoff). These render 2 cells but count 1 — the same
  UNDER-count class the emoji-presentation fix closed, only for rare glyphs no chat realistically emits. Safe-direction
  bias means over-counting is fine, so this is cosmetic. Fold the missing ranges into the deferred `Intl.Segmenter`/EAW
  wrap-cache hardening below rather than a one-off patch. *(low · apps/cli/src/render/tui/viewport.ts)*
- [ ] **Step 4b-3: on an EXTERNAL SIGTERM/SIGHUP/SIGQUIT, unmount the live ink instance BEFORE the alt-exit (avoid the
  final-frame dump on the primary buffer).** With the ink render option `alternateScreen:false` (Step 4b-3), the hoist's
  signal handler `alt.restore()`s (DECRST-1049 → primary) then `process.exit(128+signo)`; `process.exit` is intercepted
  by ink's signal-exit, which fires ink's `unmount` → ink renders its FINAL frame onto stdout — now the PRIMARY buffer —
  leaving a screenful of transcript above the recovered shell prompt (Step-4b-3 Opus review). COSMETIC (the terminal IS
  recovered: buffer + cursor + raw mode + bracketed paste all restored; external-signal-only, not a keyboard path). The
  clean fix is to thread the current session's `instance.unmount` up to the hoist (driveHome parity) and call it BEFORE
  `alt.restore()`, so ink's final frame lands on the alt buffer that is then discarded — a small cross-seam wiring
  (ChatDriveContext `onInstance` → a loop ref → the signal handler). *(low · apps/cli/src/{commands/chat.ts,render/tui/chat-ink.tsx})*
- [ ] **`relavium run` TUI → full-screen + retained scrollable run-history.** [ADR-0068](../decisions/0068-full-screen-tui-renderer-ink7-harness.md)
  scopes the 2.6.F full-screen renderer to the **Home + `chat`**; the `relavium run` `RunApp` stays inline
  (no `useInput` → kernel `Ctrl-C → SIGINT` cooperative cancel preserved). Making it full-screen + giving it
  a retained, scrollable per-node token history requires the **COOKED→RAW cancel rework** (an in-process
  SIGINT handler, as `ChatApp` has) — the single riskiest cancel change, deliberately kept out of 2.6.F.
  **Owner:** a focused follow-up (candidate 2.6.G run-detail browser, or its own PR) with a real-TTY cancel
  test. *(med · apps/cli/src/render/tui/{ink-renderer.ts,RunApp.tsx,run-view-model.ts})*
- [ ] **Bracketed-paste teardown symmetry — drop the redundant Home `DISABLE_BRACKETED_PASTE` write (Step-2 Sonnet
  review).** ink 7's `App` has an unconditional unmount-cleanup that writes `ESC[?2004l` on EVERY unmount (verified
  against ink 7.1.0 source), so the Home's manual defensive `writeControl(DISABLE_BRACKETED_PASTE)` on the
  signal/exit teardown (`drive-home.tsx`) is redundant, and the standalone `ChatApp` correctly relies on ink's
  cleanup with no manual write (an asymmetry, not a bug). When **2.6.F Step 4** re-introduces `writeControl` for the
  alt-screen (DECSET 1049) control writes, resolve this cleanly: drop the redundant Home paste-DISABLE (and its
  `home-input` `DISABLE_BRACKETED_PASTE` export + the drive-home test assertion) so both surfaces rely on ink's
  unmount cleanup uniformly. Low; deferred to ride Step 4's `writeControl` rework rather than churn it twice.
  *(low · apps/cli/src/home/drive-home.tsx + render/tui/home-input.ts; Step 2.6.F-4)*

- [ ] **The Anthropic adapter's non-streaming `generate()` cannot carry a large `max_tokens`.** The SDK refuses a
  non-streaming request whose cap implies a >10-minute generation (empirically: `claude-opus-4-5` is accepted at
  ~21 000 and refused at ~24 000), and **every** Anthropic row in the catalog has a `maxOutputTokens` of 32 000 or
  more. So the ADR-0071 §7 clamp — which holds the cap AT the ceiling — cannot bring a large authored cap back
  under that threshold: `generate()` still fails, just with the SDK's message instead of a provider 400. Reachable
  only through the public seam (`LlmProvider.generate`, the conformance harness, `validateProviderKey`), because
  the engine's own agent turn takes `stream()`; the seam's other callers all pass a tiny cap. Resolve by either
  capping the non-streaming Anthropic request under the SDK threshold, or failing with a typed, actionable
  `bad_request` naming `stream()` rather than surfacing an SDK string.
  *(medium · packages/llm/src/adapters/anthropic.ts; found by the 2.6.Q Step-5 Opus review)*

- [ ] **Cache WRITES are billed at the flat rate, never a context tier's.** `ratesFor` (`packages/llm/src/cost-tracker.ts`)
  moves input, output and cache-read onto the tier a prompt lands in (ADR-0071 §11), but cache-write stays on the flat
  `cacheWritePerMtokMicrocents` — because models.dev's tier schema publishes `input`, `output` and `cache_read` and
  **no `cache_write`**, so a per-tier write rate is not a number we have. Scaling one from the input tier's multiple
  would be a guess on a money path, which is the thing this ADR exists to stop. The exposure is a cache-write-heavy
  prompt above the 272k threshold on the four `gpt-5.6` variants (the only shipped models with both a cache-write rate
  and a tier). Resolve by extending `CatalogPriceTier` + the upstream schema **if models.dev starts publishing it**, or
  by asking upstream to.
  **2026-11-26 (MVP-11 unit 6 round-1 security sitting): the trigger has fired.** models.dev now publishes a tier `cache_write`
  for 24 rows, among them `claude-haiku-5-5` (the new zero-config chat default: $0.625 per Mtok above 100k against the flat
  $0.125), and `toPriceTiers` (`catalog/models-dev-schema.ts`) still drops it. Exposure today is none: no adapter sends
  `cache_control`, so no request writes the cache. The first adapter that does (or a provider that bills writes on its own)
  must carry `cacheWritePerMtokMicrocents` on `CatalogPriceTier` and use it in `ratesFor`; regenerate the snapshot then.
  *(medium · packages/llm/src/cost-tracker.ts + catalog/models-dev-schema.ts; found by the 2.6.Q Step-6 Sonnet review)*

- [ ] **Auto-open a PR for additive catalog drift.** ADR-0071 §9 wants new models to "merge automatically" while a
  moved shipped-model price stays a red human-reviewed check. The red check ships (`.github/workflows/models-catalog.yml`
  `weekly-catalog-check` runs `pnpm sync:models`, red ONLY on a moved/vanished shipped-model price; additive drift is green). The *automatic*
  half — a bot PR that runs `pnpm sync:models` and commits the additive diff — is deferred because it needs a
  third-party `create-pull-request` action pinned to a verified commit SHA (the repo pins every action by SHA;
  inventing one unseen is the supply-chain risk rule 3 forbids). Add it as a second job once the SHA is verified.
  Until then a maintainer runs `pnpm sync:models` locally when the weekly check goes red — which also forces the
  `--accept-price-changes` human decision on a moved price, exactly as §9 intends.
  *(low · .github/workflows/models-catalog.yml; ADR-0071 §9)*

- [ ] **Per-model capability gating: `tool_call`/`attachment` + a withheld-parameter notice.** The 2.6.Q capability
  gating (ADR-0071 §12) carries all four per-model `requestCapabilities` in the catalog and WITHHOLDS the two safe
  silent param-drops — `temperature` and `structured_output` — at the adapters. `tool_call` and `attachment` change
  request MEANING (dropping tools leaves the agent unable to act; dropping an image input changes what the model
  sees), so silently withholding them is wrong: they need a LOUDER signal — a config/authoring-time validation, or a
  gate-level notice like the effort gate (ADR-0066 §6). The catalog data is already parsed and carried, so this is
  the wiring only. Likewise, a user-facing notice for the two silent withholds (so a dropped `temperature` is *said
  out loud*, §6's standard) is a follow-up — the correctness fix (no 400) shipped first.
  *(low · packages/llm/src/adapters/* + a gate-level check; ADR-0071 §12; found by the 2.6.Q capability review)*

- [ ] **Surface a user↔catalog price DIVERGENCE on the ongoing surfaces, not only at set-time.** ADR-0071 §5 promises a
  user price that diverges from the catalog is surfaced in the `/models` picker and `/cost`, not just echoed by
  `models pricing` when it is set. Today only the set-time echo is wired: the picker and `/cost` show the effective
  (user) price without flagging that it OVERRIDES a different catalog price. Add a divergence marker to both so a
  stale/wrong override is visible on the surfaces a user actually reads, per §5's intent.
  *(low · apps/cli/src/render/tui/model-picker-view.tsx + the /cost breakdown; ADR-0071 §5; found by the 2.6.Q review)*

## Full-project review (2026-07-19) — deliberately unscheduled findings

> **2026-07-19 — full-project review.** A 377-finding multi-agent code review at HEAD `f88b0e8` was
> adversarially verified down to 373 confirmed findings — one agent per finding tried to refute it against
> the code, a second audited its materiality — with the toolchain green throughout (lint, typecheck, all 226
> test files passing): every finding below is a defect a green build cannot catch. The bulk (176 of the 205 triaged work items)
> now live in [phases/phase-2.5.5-hardening-and-remediation.md](phases/phase-2.5.5-hardening-and-remediation.md).
> Sixteen of the review's findings turned out to duplicate items already recorded in this file — each already
> carries an accurate `Scheduled →` marker (2.6.B/2.6.H/2.6.I/2.6.K/2.6.M/2.6.Q) or an accurate "no owner yet"
> note, and the review's own triage confirmed none needed a new entry or a marker change. The items below are
> the ones the triage deliberately left **unscheduled**: small enough to pick up opportunistically, or
> genuinely unowned by any phase or workstream.

- [ ] **Annotate the `FallbackChain` cost-underreporting pinning tests as a KNOWN GAP, not a deliberate
  contract.** `fallback-chain.test.ts`'s "records a content-free success with no usage when the stream omits
  a stop chunk" (line 984) and its sibling (line 1000) assert `trace[0]?.usage`/`trace[0]?.cost` are
  `toBeUndefined()` when a provider stream ends without a usage chunk — literally encoding the known
  spend-under-reporting gap (the two failure paths named in [current.md](current.md)'s 2.6.C carry-overs,
  filed against 2.6.Q/[ADR-0070](../decisions/0070-durable-per-model-session-cost-attribution.md) §3) as the CORRECT,
  asserted behavior, with nothing in the suite signaling that the assertion itself is a product gap rather
  than a design choice. Add a comment on both tests marking them as pinning a known gap (with a pointer to
  the 2.6.Q fix) so a future engineer editing this file understands it is not a green test to preserve as-is.
  Independently shippable now — the comment-only annotation does not need 2.6.Q's 7 open maintainer decisions
  to land, unlike the underlying fix. *(low · packages/llm/src/fallback-chain.test.ts:984,1000; #292)*

- [ ] **Outbound MCP ("workflow-as-MCP-server") has no owner.**
  [mcp-integration.md](../reference/shared-core/mcp-integration.md) documents an
  `import { createMcpAdapter } from '@relavium/core/mcp'` API as shipped, tagged "Status: Stable" — neither
  `createMcpAdapter` nor a `/mcp` subpath exists anywhere in the repo (`packages/core/package.json` exports
  only `.`; `packages/mcp` implements inbound tool-consumption only, no `listen()`/server capability).
  [ADR-0034](../decisions/0034-mcp-client-sdk-dependency.md) and
  [ADR-0052](../decisions/0052-inbound-mcp-client-package-lifecycle-registration.md) both call outbound MCP
  "a later workstream," but no phase or workstream ID actually claims it. The doc-honesty half (rewrite the
  section as unimplemented/roadmap-only, strike the fabricated sample, drop it from "Stable") is scheduled →
  2.5.5.F; the *implementation* — a real `createMcpAdapter` turning an agent/workflow into an MCP server,
  firing the already-schema-accepted `mcp_call` trigger — needs **no** later-phase substrate
  (`packages/mcp`, `packages/core`, and the trigger schema all exist today) and simply has no home.
  *(medium · packages/mcp, packages/core, docs/reference/shared-core/mcp-integration.md; #141)*

## Native file identity on Windows — approved increment (2026-10-24)

*[Moved 2026-11-18: this section, with its scoped Windows file-identity limits, now sits in [deferred-tasks-parked.md](deferred-tasks-parked.md#native-file-identity-on-windows--approved-increment-2026-10-24). This heading stays here only so links written before the register split (for example [ADR-0105](../decisions/0105-filesystem-roots-are-invocation-grants-not-project-authority.md)) still reach it.]*

## Wave 3 approved later-wave ownership — 2026-10-16

- [ ] **Scheduled → Wave 4b: production recipient key constraints.** Approved with the Wave 3
  Steps 9–19 rulings (2026-10-19, [Step 9 mechanics ruling](phases/phase-2.5.5-hardening-and-remediation.md#wave-3-steps-919-preflight-review-and-maintainer-rulings--2026-10-19)):
  the confirmed production recipient for encrypted release custody must be an OpenPGP v4 key
  with a cv25519 or RSA≥3072 encryption-capable subkey. Wave 3 Step 9 implements custody with
  synthetic keys only; an actual release fails closed until this recipient, its offline
  recovery check and backup ownership exist. *Added 2026-10-25 (Step 9b preflight decisions):* the key
  must not advertise the AEAD feature, because custody requires SEIPDv1 with MDC and AES-256 so that
  `gpg -d | tar -x` with GnuPG ≥ 2.2.8 stays true; and the committed recipient file is the export of the
  primary with only the pinned encryption subkey (`gpg --armor --export '<subkey fingerprint>!'`),
  because a second usable encryption subkey refuses. *Added after Step 9b.1's review round 1:* its
  cipher preferences must include AES256, since custody passes an AES-256 preference and refuses any
  other cipher. *Added with Step 9b.2:* the recipient is committed at
  `tools/cli-package/release-recipient/` as `recipient.asc` and `pins.json`, whose history is append-only
  (exactly one `current`, a rotated recipient `retired`, never removed); a fixture fingerprint refuses. Wave 4b
  then updates `release-recipient.test.mjs`'s absence test and `release-scope.test.mjs`'s interim control that no
  recipient directory is committed. Any expiry margin is passed as the `now` the custody check uses. The
  loader sees one revision of `pins.json` and cannot detect a removed or rewritten entry, so Wave 4b adds a
  control that every committed revision keeps the previous one's entries, with only `current` becoming
  `retired` (rigor pass, CLAIM-9B2-3). With the files committed, Wave 4b also replaces the absence test with a
  load through `loadProductionRecipient()` itself, so the production path's own denylist and root wiring are
  exercised: in Wave 3 the absent directory refuses before either is read (round 1, TEST-9B2-R1-4).

### MVP-3b, MVP-3c, MVP-3d and the PR #99 reviews (2026-11-16 to 2026-11-18)

> Subheading added in the 2026-11-18 stale-entry sweep: these entries were filed under the 2026-10-16 Wave 3 ownership heading above
> because that was the last section of the file when they were written. Their text is unchanged.

- [ ] **ADR-0119 — an Esc at an approval card is recorded `cancelled` although the tool never ran.** The registry throws
  `ToolCancelledError` from several points before `def.dispatch`, and the engine cannot tell them from a call that executed, so
  the next request says "one marked cancelled has an unknown outcome" and the model may spend a call re-verifying a file that
  was never touched. Conforms to ADR-0128's `cancelled` ("execution state unknown"); a registry mark for "never reached
  dispatch" would let the engine record `denied`/`error` instead but needs a vocabulary decision. *(low · packages/core/src/tools/registry.ts, agent-turn.ts)*
- [ ] **ADR-0119 — hardening: latch an interruption event that arrives with no pending user message.** The persister fails
  closed on a contradictory event but writes nothing, without a latch, when `interruption` is set and `beginUserTurn` was never
  called (completed turns behave the same today; every production caller calls it). *(low · apps/cli/src/chat/persister.ts)*
- [ ] **A way to remove an interrupted turn (the removal path ADR-0119 names).** An Esc after the provider returned its first chunk now keeps the
  user's message — and anything they pasted or `@`-mentioned — in `history.db`, in every later request of the session and
  in the `/export` file's `metadata.relaviumExport.messages` (and possibly the session title and export file name);
  ADR-0119 points at `/rewind` (2.6.E), which does not exist, and the CLI has no session delete. Until a removal path ships,
  the residual recorded in the security-review sitting stands. Needs: `/rewind` or "discard the last interrupted turn", and
  a decision whether Esc should keep the turn when the user's message carried `@`/`!` content. *(medium · privacy ·
  docs/standards/security-review.md, apps/cli/src/chat/persister.ts)*
- [ ] **`ask_user` — follow-ups of a structured mid-turn question (MVP-3d; ADR-0132 Accepted, merged in PR #99 on 2026-11-18).** Built with
  multi-select, free text, a docked card in the chat and the Home, and no timeout. Its D64 round, separate security sittings, the full gate and the maintainer's merge of PR #99 (2026-11-18) have all happened; a real-provider
  sample of `ask_user` is not recorded in these notes. Still open, recorded in the ADR: a validation warning for a workflow node that grants `ask_user` (it is inert,
  like `invoke_agent`); `Esc` at a card when a driver wires no `onAbort`; letting `Ctrl+T` pass through an open card.
  *(The stored question/answer form this item once listed is done: [ADR-0133](../decisions/0133-an-ask-user-question-and-its-answer-are-kept-with-the-session.md), no migration — its D64 round, separate security sitting and a focused corrective sitting have run (2026-11-16); the named residual is model-authored question text in a user-role block.)* *(medium · product · docs/decisions/0132-…)*
- [ ] **Resume audit lows (2026-11-16, from the `chat resume` report).** None blocks a resume; each is a wording or small-state gap. (1) On a resumed
  session every plain chat turn is "ambiguous" (ADR-0128's choice), so the model gets the 109-byte "some earlier tool activity may not be listed" sentence
  even when no tool ever ran — an ADR-0128 amendment to tell a turn that predates receipts from one that has none. (2) After `/compact` or `/trim` the
  resumed turn count shrinks, so the hard `max_turns` limit that fires on turn 4 live does not on resume, and the banner says "1 earlier turn".
  (3) A `/effort` override is lost on a plain resume (document it, or persist it on the row). (4) *(done 2026-11-16: a `/models` reseat now writes the
  switched model to the adopted row when the persister starts, and — D64 round — the OLD persister no longer writes its model and `ended` back over it when the Home's build-first reseat tears the old session down.)* (5) A second process opening the same session fails on the `UNIQUE` row rather than saying it
  is open elsewhere. (6) An agent whose MCP server is gone makes the session unresumable. (7) `@` attachments are re-sent every turn (a context-size risk).
  *(low · resume · apps/cli/src/chat, packages/core/src/engine/session-resume.ts)*
- [ ] **ADR-0132/0133 — lows from the D64 cumulative round (2026-11-16).** The round's mediums are fixed; these lows are recorded, none blocks.
  *Card UI:* the model's `header` and the Review tab's rows are drawn at column 0, outside the host gutter, so a header such as `● ● · [Review]`
  can imitate the tab strip (the accepted "approval-sounding header" residual, not the option rows); the own-answer field draws its block cursor at
  the end while `←`/`→` move the real one; the Review tab ellipsises long answers although the contract says "exactly as it will be sent"; the settle
  clock is wall-clock `Date.now()` (use `performance.now()`); typing or opening the field refuses the 500th character (`>=`); the `n/500` counter
  threshold and the Esc/Ctrl-C key-to-abort chain have no mounted-host test; the abort listener's removal on settle is unpinned. *Core/shared:* the stored
  part's `outcome === 'ok'` half of the pairing could be a part-level refine (three consumers re-check it, so it is inert); `new Intl.Segmenter` is
  built at module load in `ask-user.ts` (a runtime without it would fail the whole `@relavium/core` import; construct it lazily); the model-facing
  description does not mention that older answers can be evicted from view; a `not_asked` second call reads `ask_user — ok (no question text kept)`
  (wording); `askUserRecord` clips own text by code unit before the schema (an astral split would drop the record). *Resume/persister:* the bare
  `catch` around the adopt write swallows every error with no latch, and the adopt write (like every flush) resets `exported_workflow_path` and an
  `exported` status; the restore notice still says "targets, previews, results and diff statistics are unavailable" next to answers it now shows, and
  "N more saved questions" counts calls, not questions. *Tests:* ±1 boundaries at the 2,560-byte turn budget and the 1,232 line limit, duplicate
  result rows, the omitted-line entry in the restore budget, the empty-`other` refine, and an interrupted turn that kept an answered question have
  no committed test. *Docs:* the stored `ask` shape's field table is split between `built-in-tools.md`, `database-schema.md` and ADR-0133 §1 (keep one
  home); ADR-0133's commit (`ebe8b361`) has no scope or trailer and bundles the reseat-durability fix its message does not mention.
  *(low · apps/cli/src/render/tui, packages/core/src/tools/ask-user.ts, apps/cli/src/chat)*
- [ ] **ADR-0133 — lows from the separate security sitting (2026-11-16).** The sitting's one medium (a skipped call stored question text the
  person never saw) is fixed — amendment 7; these three lows are recorded, none blocks. (1) *Look-alike host glyphs (amendment 9):* the entry's
  `› ` / `  └ ` rows are protected by refusing the exact glyphs; a look-alike the rules do not refuse (U+23BF `⎿`, U+23A3, U+221F, U+231E, U+276F,
  U+FF1E, `»`) can open a continuation row of a long wrapped question and read as a host row, live and restored, when the break lands on the
  right column. Display only. Give the entry's continuation rows a hanging indent or gutter as the card has, or widen the refused set (one home:
  `HOST_GLYPH` in `packages/core/src/tools/ask-user.ts`). (2) *A quoted string can read as more of the note (amendment 8):* a model question
  containing `→ chose “…”; own text “…` plus a look-alike quote reads as an answer clause inside its own JSON string; the compaction prompt
  (`authored-system-prompt.ts`) calls a recorded answer "the user's decision", so a summary may restate it as one. Escape `→` and the quote
  look-alikes (U+201C–U+201F, U+FF02, U+2033, U+3003, U+05F4) in the note's strings, or refuse them in model text, and reword the prompt so only
  the recorded answer counts. Escaping a 3-byte character to 6 bytes is the same 2× as an escaped quote, but re-run the per-note cap sweep when it is built. (3) *The masker's
  `&` boundary (amendment 10; existing behaviour):* `password=Tr0ub4dor&3xyz` is stored as `[redacted]&3xyz`. Treat under the masker acceptance
  bar, with the other masker items. *Not examined by the sitting:* real terminal and font rendering of the look-alikes, how a live model reacts
  to planted text, the standalone `chat` reseat ordering and two-process leases, the inline renderer's scrollback, and the desktop and VS Code
  surfaces (none exists). The corrective sitting on the fix (also no blocker/high/medium) adds: (4) the headers of tabs a person never reached
  stay in the model's view after a skip (ADR-0133 amendment 7(a)); keep the first header plus a count, or only the visited headers (the
  answer type would have to report them). (5) The ask notice sentence says the note shows "what the assistant asked and how the person
  answered", which reads slightly off for a header-only skip note; rewording it changes the ADR-0128 notice bytes and the pinned reserve
  (795), so do it with the next notice change. (6) An unpaired surrogate in the person's own text now fails the turn as a host fault instead of
  silently dropping the record; the CLI cannot produce one (input is decoded from UTF-8), so it matters only to a future host.
  *(low · apps/cli/src/render/tui, packages/core/src/engine/turn-receipts.ts, packages/core/src/tools/ask-user.ts)*
- [ ] **MVP-4 step 4 round 2: lows left open on the command card.** (1) Strong right-to-left letters in an argument can be reordered
  within the one-line title by a terminal that applies bidi (VTE, Konsole), so `mv <heb1> <heb2>` may read swapped on the title while
  each row below shows its argument whole; *Once* needs only the title. Cure: when an argument holds a strong RTL letter, require every
  row on screen for *Once* too (a new rule, so a decision). (2) `/permissions` lists a session approval without the time it was given.
  (3) A card with `Standing: remembered for this project` in `ask` does not say why it still asks, or point to `/permissions`.
  (4) The chat names a remembered file `remembered-commands file` and the CLI `remembered-command file`; the list headers differ
  between the chat and `relavium permissions list`. *(low · apps/cli/src/render/tui/tool-review-card.ts, apps/cli/src/permissions)*
- [x] **ADR-0117 — return a protected-path refusal.** *Closed 2026-11-21 (found by the PR #101 review; the work was done in MVP-4 step 1, commit `c059a16f`, 2026-11-19): the lexical arm returns to the model with the fixed `PROTECTED_PATH_REFUSAL`, the credential-store arm and every refusal that only resolution reveals stay fatal ([ADR-0117](../decisions/0117-a-denied-tool-call-returns-to-the-model.md), its 2026-11-19 implementation note and its 2026-11-21 amendment). The XDG `~/.config/git/` directory joined the lexical arm in the PR #101 review (`2a852e4e`).* The protected-path predicate also covers credential stores,
  which the rule keeps fatal; split the two so a refused protected path can return to the model while a credential
  store stays fatal. *(The allowlist-miss half is closed: a command outside the allowlist is a card since MVP-4 step 4,
  and the `!` escape's config-line hint is retired.)* *(medium · apps/cli/src/engine/tool-host/fs.ts)*
- [ ] **ADR-0131 — clip a spill read's line range too.** `session-output-store.ts` still refuses a line range
  whose end is past the last line; align it with `read_file`'s clip. *(low · apps/cli/src/engine/tool-host/session-output-store.ts)*
- [ ] **ADR-0129 follow-ups.** A terminal bell or notification when a card waits while the terminal is
  unfocused; a side-by-side diff on wide terminals; per-file review of a multi-file change; the
  narrow-the-scope key and editable "always" pattern for command cards (MVP-4). *(low · product)*

- [ ] **`surface-db-acquisition.test.ts` hung five cases once in CI under coverage (2026-11-16) — cause not found.** On PR #99 head `a15c8f8e`
  the push-event run's `engine coverage floor (llm, mcp)` job failed: of the file's 15 cases, `chat` (close failure) and both `chat-resume` and
  both `home` cases each ran 15.0 s (the 5 s case timeout plus the 10 s `afterEach` hook that awaits the raw case), and `agent` (no close
  failure) failed its 1 s `vi.waitFor` (`ACTUAL_SURFACE_REACHED_SQLITE_SETUP`); the other nine passed. The pull-event run of the **same SHA**
  passed the same job (the whole file in 4.5 s, every case under the reporter's 300 ms line), and so did every earlier run (file total 4.5–5.5 s
  at `56c63ab0`, `b2dff860`, `f29d44ae`). Measured locally on a quiet 18-core machine and under 18 and 54 CPU spinners, with and without
  `--coverage`: 27 of 27 runs passed, slowest case 180 ms quiet, 643 ms at 3× load, the file 5.4 s at 3× load — so neither the MVP-3d
  import growth (case cost is unchanged in CI) nor CPU contention reproduces it. The failing log has no stderr, crash or resource message. By reading
  the code (not confirmed in CI), the design can amplify one missed window into a cascade: when a surface has not reached SQLite setup,
  `disposeCommand` awaits a `result` that may never settle, so the next cases would wait out `afterEach` too. **Open:** if it recurs, capture the state at the first stuck case (open handles, pending
  imports, the fixture's `faultEnabled` and close attempts) before touching any timeout; bounding that await would stop the cascade but would
  not explain the stall. *(low · apps/cli/src/commands/surface-db-acquisition.test.ts, db-fault-acquisition.test-support.ts; one occurrence in about twelve CI runs of the file)*
- [ ] **SonarCloud: 44 open issues on PR #99, none gating (2026-11-16, head `a15c8f8e`).** The quality gate is **OK** (new reliability, security and
  maintainability ratings all 1; duplicated lines 0.9 % against 3 %; hotspots 100 % reviewed, none to review), so nothing here blocks the
  merge. The 44 are issues Sonar reports as open (`OPEN`/`CONFIRMED`, since the PR's leak period) and are separate from the 207 initial reports
  and 45 follow-ups the PR's Sonar record already dispositions: S3776 cognitive complexity ×10 (CRITICAL), S3358 nested ternary ×8, S6479 index
  keys ×6, S5906 `toHaveLength` ×5, S4624 nested template ×3, S7780 `String.raw` ×3, S7718 catch-parameter name ×3, S6353 `\d` ×2, S7758
  `fromCodePoint` ×2, S6606 `??` ×1, S6035 character class ×1. Four came from the last push (created 18:28 UTC): S5906 at
  `apps/cli/src/chat/restored-transcript.test.ts:632` and `apps/cli/src/render/tui/question-card-record.test.ts:78,79`, and S4624 at
  `apps/cli/src/render/tui/question-card-record.ts:46`. The rest sit mainly in `tool-review-view.tsx` (8), `ask-user.ts` (5), `denial-text.ts` (4)
  and `question-card-model.ts` / `question-card.ts` (6). **Decision (maintainer, 2026-11-16): leave the accepted source untouched and take them in a separate
  Sonar-only increment** — the cognitive-complexity refactors reach `persister.ts`, `turn-receipts.ts`, `ask-user.ts` and `agent-session.ts`,
  paths the security sittings reviewed, so changing them re-opens the full gate and the review rounds. Each issue needs a source action or a
  verified remote disposition; setting a remote status needs a maintainer token. *(low · apps/cli, packages/core)*
- [ ] **PR #99 independent review (2026-11-17): verified findings left open.** Six read-only verifiers re-derived each claim; about a third were refuted
  or are accepted ADR behaviour (for the record: the `#foldableEvidence` trim offset, retention rules #1/#2, #5, #7, #8, #10, #11, #14, #15, #16, U-5, U-8,
  U-9, #17). Verified and **not** fixed in that round, low unless noted. (1) DB-2: `media-write.ts` leaves a 0-byte `.save-to.<uuid>.tmp` when
  `handle.stat` throws or `nlink !== 1`; the cleanup's own identity test refuses an unproven path, so the reviewer's "assign `owned` earlier" does not
  change those branches — decide whether to remove an O_EXCL-created temp after a failed stat. (2) C-3: `gate` resume loads config from the resumer's
  cwd (`gate.ts` ~296-299, pre-existing): persist the fs tier on the run row or resolve config from `saveToRoot`. (3) C-6: an execute-time `stale_file`
  after `createParents()` is journaled `ambiguous` and blocks resume by design (`tool-registry.md` ~896-915); only the pre-mutation `stale_file` throws are
  provably effect-free, and a "refused before native work" marker for those would let them discard. (4) #19: `os.ts` ~255 clipboard/notify children
  inherit the whole environment on purpose (`os.ts` ~30-34); add a deny-filter for `RELAVIUM_*`, `*_API_KEY`, `*_TOKEN`, `*_SECRET` and keep `DISPLAY` and
  `DBUS_*`. (5) The overflow-after-tool residual, now an ADR-0119 amendment. (6) UX: U-2 type-ahead is dropped for 250 ms without a hint; U-3 the inline
  renderer can push the question card off screen (cap the live tool region); U-8 the legend lacks "1–n choose"; U-12 an empty new file shows no body row;
  U-13 a parked `↑` draft is invisible and not sent; U-14 Backspace on an empty denial reason cannot return to the card; U-18 the approval card shows no
  protected-path warning although the fs floor refuses. (7) Docs and evidence: the analysis archive redaction is incomplete (`_archive/synthesis-raw.json`
  names one product four times and four more competitors, `deep-analysis-raw.json:5`, `managed-inference-business-model-2026-06-03.md:71,75,78,211`);
  the release-admission regex accepts only a bare `Accepted` status line while 22 ADRs use `Accepted — date, by …` (`native-release-admission.mjs`; add a
  test for that form and for a multi-status file before ADR-0121 is accepted); the `pnpm-workspace.yaml` "cooled" comment for turbo 2.11.11 has no
  recorded justification (the version was at most about 2.8–4 days old at the bump; the publish date is not verifiable offline, and §9a asks for a stated
  reason under seven days); ADR-0128's dated notes (`0128` ~267, `agent-session-spec.md` ~361) still say its reviews are owed and need checking against
  the MVP-3c rounds; `native-assets.json` publishes Rust test names. (8) Delivery lows from the review's section 3.7 (a `Cargo.lock`↔notices heading
  check, 8 native legs on every docs-only PR, npm and PnP consumers, a `prepublishOnly` gate, `cargo audit`). *(low · various)*
- [ ] **Native adapter increment — concurrent processes on one operator home ARE supported (maintainer, 2026-11-17). Inc 1 implemented 2026-11-18 and merged to `main` in PR #100 (`1e71f652`; four independent review rounds, the fourth without blocker or high; all eight native legs green on `2ce6a252`; the maintainer's reading of ADR-0135 and a security sitting on the delta since round 4, which includes the Linux parent-snapshot change, are still owed); Inc 2 and Inc 3 open.** Measured on the built addon
  (macOS; throwaway probes of 2026-11-17, not kept): (a) the allocation and cleanup locks are one nonblocking try; two concurrent writers made 27 of 60 writes fail at stage (`changed:not_needed`)
  and 3 end `possibly_published:uncertain` with the target already written. Fix: bounded retry on EWOULDBLOCK only for the reserve and cleanup locks, inside
  the existing 2 s budget and the cancellation flag; `recover`'s per-record claim stays one-shot (a failed claim there means a live producer). (b) N-1:
  `Index::entries` treats ENOENT between `read_dir` and `open_nofollow` as a fatal `changed` (78 of 200 recovers under a tight churner); skip a vanished
  `.reserved` or `.prepare` as the TypeScript reader does, keep `.record` strict. (c) H2: Linux `mkdirat(0o700)` has no `fchmod`, so a setgid parent yields
  mode 02700 and `verify_private_directory` refuses after approval and claim (by reading only; add the `fchmod` that `macos.rs` ~884 has). (d) N-2:
  `Record::encode` does not enforce `decode`'s invariants (unreachable through the TypeScript host, which realpaths first). (e) N-3: the operator script's
  `removed + retained > 128` bound is wrong for entry counts (`native-filesystem-metadata.md` ~630-631; up to 385). (f) N-4: Windows stage verify and publish
  lack `nNumberOfLinks == 1`; N-5: Linux and Windows do not re-prove the staged payload before publish (macOS checks length only); N-6: the Linux private
  file create skips the parent policy check; N-7: `pin_empty` unlinks `.reserved` without identity revalidation. (g) No `SAFETY:` comments exist (ADR-0125
  does not require them; a `clippy::undocumented_unsafe_blocks` gate is a quality choice). Needs a native rebuild, the source-binding pins, a security
  sitting and the eight-target CI legs; Linux and Windows behaviour is verifiable only in CI.
  **Work breakdown (2026-11-18, read-only analysis; the lock sites, the `open_nofollow` sites and the `unsafe` counts below were spot-checked against the code, the other anchors were not).**
  Every finding is Rust-side except one found later by an external review: the TypeScript inventory reader (`fs-stage-inventory.ts`) has the same two vanishing-entry windows and was fixed in Inc 1; the thin TypeScript binding (`fs-native-*.ts`) and `fs.ts` needed nothing, so the work does not overlap the approval path. The stage drops come from
  `stage_index.rs`: `allocation_lock_checked` (~532, called by reserve at ~626) and `cleanup()` (~887) take one nonblocking try and every errno maps to `Changed`, and the host turns
  any native stage failure into a non-retryable `effect_needs_attention` (`fs-native-write.ts` ~92-150). `recover` has a third one-shot allocation-lock site (~1196) that the text above
  does not name; retrying it too is a maintainer decision. How much of the 27 of 60 belongs to the lock and how much to N-1 is not separated, and the probes (`n3.cjs` K writers,
  `n1.cjs` churner) exist only in the session scratchpad and were not re-run. Corrections to the text above: N-3's bound is at most 384 entries counted by `recover` (385
  includes the permanent lock, which `entries` skips); Linux can be exercised locally through the Dockerfiles by hand (smoke only, not acceptance evidence); there are 257 `unsafe`
  lines and no `SAFETY` comment. **Proposed split.** *Inc 1 (M-L), concurrency liveness:* a NEW bounded-retry lock function (keep `lock()` one-shot, its tests assert it errors),
  N-1 (an `open` variant that exposes NotFound; `.record` stays strict), N-2, N-7, N-3 (doc-only, may ship earlier), a deterministic test in the cross-platform `custody_tests` as
  the CI gate (the statistical probe would be flaky on slow arm64 runners), the contract text (`native-filesystem-metadata.md` ~452-461, ~503, ~630-631) and a dated ADR-0126 note;
  "concurrent processes are supported" is recorded only in the register and the phase doc, so a short ADR is recommended. *Inc 2 (M), Linux and Windows parity:* H2 (`linux.rs`
  ~658, mirror `macos.rs` ~884) before N-6 (Linux parent check, ~727-770), N-4 (`windows.rs` ~1328 and the publish paths), N-5 (the length re-proof is macOS-only in `common.rs`;
  a content re-read is a design change and needs an ADR). *Inc 3 (S), SAFETY comments,* last, because a comment edit changes the source binding and re-triggers the rebuild and
  the eight legs. **Constraint:** `recover`'s per-record claim (~1208) must stay one-shot: a writer holds its record claim while it waits for the allocation lock, so a retrying
  claim would make a wait cycle. **Mechanics.** `node tools/native-fs/build.mjs` (cargo +1.98.0, release, locked) writes the git-ignored `runtime/`; copy `runtime/` aside first to
  keep the "before" binary. Each new Rust test must join the exact-name set in `tools/native-fs/profile-catalog.mjs`, a new checkpoint joins `CHECKPOINTS` (`common.rs` ~2000) and
  `profile.test.mjs`, a new lifecycle case joins `NODE_LIFECYCLE_CASES`. `NATIVE_BUILD_INPUTS` includes `native-fs.yml` and four `tool-host` TypeScript files, so editing them
  shifts the build binding; the only committed source pin is the loader hash. `native-fs.yml` has no `workflow_dispatch`, so Linux and Windows evidence needs a push and a whole
  `ci.yml` run (each push costs one). D64 applies (writes, lease and resume paths): one rigor round plus a separate security sitting per increment.
  **Inc 1 — status (2026-11-18; the maintainer chose it before MVP-4).** [ADR-0135](../decisions/0135-concurrent-processes-on-one-operator-home-wait-for-the-allocation-claim.md)
  records the decision, the measurements and the limits. *Done:* the allocation claim is waited for (a 2 ms poll) at the four claim sites: reserving and recovery inside the operation's deadline and cancellation
  flag; cleanup after a publication and cleanup before a pin under a fresh budget, ignoring cancellation, and beyond the waiter limit with a 500 ms grace instead of 100 ms (a cleanup cannot be retried, but must not park the pool for two seconds); work under a claim, at every site,
  measures its budget from the instant the claim was acquired (`AllocationClaim.held_since`); the lock file is re-opened by name after the wait and must be the locked file; at most pool size minus one threads per
  process wait (the pool size read the way libuv reads `UV_THREADPOOL_SIZE`), a reservation beyond that polls for 100 ms and is then refused with `changed`, and cancellation is checked first; only contention is
  repeated; the per-record and marker claims stay single attempts (no wait cycle). The Rust scan **and the TypeScript inventory reader** skip an uncommitted `.reserved` or `.prepare` that vanishes before it is opened,
  **after** (the unlinked file reads link count zero and its identity differs, so it was `Unsupported`, not `Changed`) or whose `lstat` already reads link count zero; the Rust scan treats a held file at link count zero as gone even while the name still resolves (Linux lowers the count before the name leaves the directory cache; a name-only check failed 25 of 60 local arm64 gnu churn runs and the `aarch64-unknown-linux-gnu` leg of PR #100), otherwise the name must really be absent; the reader runs the
  whole scan again (up to eight whole scans) for a committed `.record` that vanishes in any of those ways; a skipped entry still counts toward the nonce bound and both scans accept every nonce count the directory-entry bound holds (384; a fixed slack of eight was an assumption) while `reserve` refuses at 128; N-2
  (`encode` shares `decode`'s validators; the locator in normalized form like the reader's `resolve(stage) === stage`), N-7 (a pin removes only the reservation it created) and N-3 (the contract bound is 384).
  *Measured* on the rebuilt addon (macOS, in-process writers; the same probes as before): two writers 60/60 clean (before 30/60 clean, 28 failed at stage and 2 wrote the target but ended uncertain), four 120/120,
  eight 240/240, two writers plus a recovery loop 60/60 with 2,288/2,288 recoveries, the churn probe 200/200 (before 98/200); no leftover entries; behind a claim held by another process `fs.stat`, `dns.lookup` and
  `crypto.randomBytes` took 0 ms with up to four writers, about 0.1 s with six and about 0.3 s with eight (about 0.1 s per caller beyond the limit, the price of the grace; 1.8 s and 3.8 s before the limit).
  *Proof kept in the repo:* 21 cross-platform and 9 POSIX-only Rust custody tests pinned in `tools/native-fs/profile-catalog.mjs` (Windows population 26 → 47, macOS 54 → 84, Linux 21 → 51; the darwin catalog equals
  the binary's own list, 89 of 89), TypeScript inventory tests for each vanishing window, the entry-bound overshoot, a replaced name and a denied lookup, `fs-native-concurrency.test.ts` (three concurrent writers through the real host
  path, which fails with `NativeWriteNeedsAttentionError` when the claim is one nonblocking attempt again; skipped on Windows so that the required `windows-concurrency` job does not run an unverified platform), and the
  three probes in `tools/native-fs/concurrency-probes/` (writers, recovery under churn, worker-pool stall; run against the pre-change binary they show 21 stage failures and 9 uncertain outcomes in 60 writes and 48 of 100
  failed recovery passes); a 46-mutant Rust sweep killed 45 (the survivor is equivalent: the private-mode check of the file under the name is implied by the identity comparison with the already-checked reservation
  handle) and the seven TypeScript mutants are killed; the Windows type check passes (a deliberate error in the Windows-only code is caught, so it does check it); `build.mjs --verify-profile` passes. One rebuild failed once with `ENOTEMPTY` while replacing
  `runtime/` and passed on the immediate retry; not reproduced.
  *Review rounds.* **Round 1** (two independent read-only reviewers, conclusions withheld): no blocker or high; mediums: pool starvation (every native call is an `AsyncTask` on Node's shared four-thread pool; with four
  and eight writers behind a held claim `fs.stat`, `dns.lookup` and `crypto.randomBytes` stalled 1.8 s and 3.8 s; fixed by a waiter limit), a pin-level proof that was missing, the pre-pin cleanup budget started before
  the wait; lows: a skipped entry was not counted (fixed), tests that slept for their assertions (hook-driven now), POSIX-only gating. **Round 2:** no blocker or high; mediums: the limit refused a fourth caller even
  behind a holder that was merely busy in another process (fixed with a pool-derived limit and a 100 ms grace), the budget-origin property was unpinned (typed claim); lows: the lock-file inode window (closed),
  unpinned behaviours. **Four external document reviews** (written without the process): the TypeScript reader had the same vanishing windows (fixed, tested), cancellation had to outrank the waiter limit (fixed),
  the ADR misdescribed the cleanup wait, the measurement wording, the locator claim, the status line, and the lack of a repo-reproducible end-to-end proof (all corrected or added). **Round 3** (two new, cumulative; the
  second also ran real OS processes: 2, 3 and 6 processes completed every write, the claim forced back to one attempt completed 30 of 60 and 30 of 90, twelve cold starts of six processes on a fresh home completed
  72 of 72): no blocker or high; mediums: the encode test left the length and nonce invariants unpinned (self-consistent cases now, the dead `CurDir` arm removed), the budget origin was pinned at the claim but not where it
  is used (three tests with a shortened budget and slow work under the claim now cover reserve, pre-pin cleanup and recovery, and the mutants that restore the old origin are killed), and the required Windows job would
  have run the new end-to-end test (skipped on Windows); lows: the remaining TypeScript windows (`lstat` at link count zero, a record unlinked between the stats; ~0.02% of scans in the reviewer's churn; fixed), the
  scan slack mirrored in the reader, `reserve` measuring its work from before the wait (fixed), a post-publication cleanup beyond the limit refused after the grace (6 `changed` and 1 uncertain in 240 writes; cleanups
  were exempted in round 3, and given a longer grace instead in round 4 because the exemption let four cleanups park the pool for 1.8 s), the pool-size parse (`2x`, garbage, negative values now follow `atoi`), and wording (status, "both readers", "until recovery drains them", the cleanup and recovery counts).
  **Round 4** (two new, cumulative; no blocker or high): the security sitting: the cleanup exemption let cleanups park the whole pool (fixed, see above), a refused pre-pin cleanup after a two-second wait leaks one slot and a junk
  stage directory (added to the leak entry below), the TypeScript `lstat` link-count-zero skip does not require the name to be absent because the name is still there for a moment in about half of those cases (documented), a skipped
  `.prepare` that was just renamed to `.record` is missing from that snapshot (the point-in-time design, as before); the review: the budget origin was unpinned at the post-publication cleanup and at the post-claim recheck, the
  waiter limit, the cleanup grace and recovery's cancellation were proven on the helpers but not at their call sites (five wiring mutants survived; seven new tests and eight new mutants now drive `reserve`, `recover` and both cleanups), and the reader
  still refused tool calls when a record vanished in three scans in a row under churn with 100 leftover entries and 8 to 12 concurrent writers (up to 9 of 64 refused; the retry cap is eight now); lows: the register heading,
  "its identity no longer matches" (it is the same inode, only the link count reads zero), `lstat` attributed to the Rust scan, the measurements not reproducible from the repo (the probes are kept now). One test failed once in
  12 parallel runs of one reviewer and passed in 117 further runs; hooks are per thread and the contending tests are serialised, so it was not reproduced (the older macOS tests do fsynced work without sharing the fixture lock
  the new tests could also take).
  **PR #100 (2026-11-18, the first push run and an automated review; dispositions checked against the code).** The first Linux execution of the POSIX-only churn test failed the
  `aarch64-unknown-linux-gnu` leg: `unlink` lowers a file's link count before the name leaves the directory cache, so the name-only proof of a vanished entry lied (25 of 60 runs in a local arm64 gnu container,
  reproduced with the OrbStack image; fixed in the Rust scan by the held file's link count, and the TypeScript reader has the same rule now; the CI log keeps no panic text, which is why a local Linux run was needed).
  Review findings, fixed: the fixed slack of eight past 128 nonces was an assumption (both scans now accept the 384 the entry bound holds, with tests that fill to that bound independently of the constant); an opened file
  of a different identity stays fatal even when the name is then absent, and a committed record whose name belongs to a different file at link count zero is fatal instead of rerunning the scan; the pool-size parse
  skipped Unicode spaces where `atoi` does not; a test built a `File` from an unopened descriptor; the probes (flags among numeric arguments, a churn handshake, a rejected publication counted as success, an unawaited
  async call); the concurrency test waited with `Promise.all`; ADR-0126's amendment still said cleanups are never refused beyond the waiter limit; ADR-0135's wording of the cap and its Related field; docs (the merge
  checkpoint's two CI observations, the CI provenance paragraph, the coverage prose, the moved register entries and one stale status). SonarCloud's gate failed on one condition, `new_security_rating` B, from
  S4036 (`spawn('perl')` resolved through `PATH` in a probe; now `/usr/bin/perl`); its remaining new items are minor: `await` in loops (S9382) is the sequential protocol of the probes and is left, and
  `inspectOpened`'s cognitive complexity (S3776, 21 of 15) now has its checks in two small pure functions (re-scored on 2026-11-19: S3776 is gone at `2ce6a252`). *Left, with reasons:* none of the review findings was rejected outright; the reviewers' multi-process probe
  and the Windows execution stay below.
  **PR #100, second push run (2026-11-18, found by the CI run, not by review).** The concurrent-writers end-to-end test failed once on Linux at *prepare*, not at the allocation claim: the Linux
  parent snapshot compared the destination directory's ctime across its policy reads, and a directory's ctime also moves when another writer creates, renames or removes an entry in it, so writers
  publishing into the same directory made snapshots fail (about 1 write in 120 with four writers on the arm64 gnu container, `prepare:changed:not_needed`; nearly every snapshot under a tight
  churn). macOS and Windows have their own snapshots and never compared it. It is a defect independent of ADR-0135's claim, in the supported mode of several processes writing in one project
  directory; the snapshot now reads the policy twice and compares the values (a change of mode, owner, flags, ACL or attributes still differs), with a Linux test that fails under the old check
  (100 of 100 pass, 20 of 20 fail with it restored) and 8 writers x 40 writes completing 320 of 320 on the container. Windows and the other Linux targets are covered only by the eight-target CI. **Owed:** a separate security sitting on this change (it touches the filesystem-write path; D64), not held yet.
  *Left, low (checked by mutation 2026-11-18, not introduced by the S3776 extraction of `inspectOpened`):* no test kills two defensive byte checks of the TypeScript reader, the committed record's read bound
  (bytes read over the record bound, the scan total, or a read that differs from the stat size) and the per-entry bound of an uncommitted entry; the earlier `lstat` size bound already refuses an oversized entry,
  so they matter only if a file grows between the `lstat` and the read.
  **CI failure review (2026-11-19, after repeated red runs on PR #100).** Of the 14 red `ci` runs between 2026-11-12 and 2026-11-18, at least seven were a failed native leg whose guard then failed or skipped every
  downstream job (the native code was being developed, and the guard shows one layer per push: native legs, then the workspace and Windows jobs, then the causal shards), one was the merge run's 10-second timeout, one was a lone aggregate whose
  identical commit passed as a pull-request run, one failed with no failed job, and four (installed-CLI consumers and causal shards, 2026-11-15 and 2026-11-16) were not re-investigated here. The two failures of this
  pull request after the claim fix were found by the first full downstream run: a Linux-only `ctime` comparison (fixed above) and a Windows case timeout. The timeout is a budget, not a race: the case `counts the final recovery cleanup winner
  when its peer loses at rmdir` holds three cold starts of a TypeScript fork, takes 4.5 to 10.3 s on Windows (file 53 to 98 s, 104 s in the failing run) and had a 15 s ceiling, which the causal-controls fence
  (`tools/causal-controls/timeout-setup.mjs`) enforces on the Linux physical phases. Windows is not in those phases, so only Windows now gets 45 s for that case and for the sibling
  `media-reference-store-process.e2e.test.ts` (9.5 s of 15 s); the per-stage deadlines still bound a hang, and the fence is checked to still reject a wide budget off Windows. The merge run's 10-second `native-process` test (typically 0.2 to 1.4 s, 13.97 s
  once, because it copies the Node executable twice) has 30 s. Measured headroom (worst observed over three green runs against the configured timeout) leaves these on the watch list, **not changed**, because the five-second default is deliberate and none has failed:
  `saved-snapshot-resource.test.ts` and `inline-text.test.ts` (3.9 s of 5 s on the workspace job), `run-media-prune.test.ts` (3.2 s of 5 s), `question-card-host.test.tsx` and `suspended-owner-resource.test.ts` (3.0 s of 5 s), `run-snapshot-notice.test.ts` (17.7 s of 30 s)
  and `question-card.test.ts` (30.8 s of 60 s); a slow-runner failure there should raise that test's own budget with its measured worst case, not the default. The earlier instrumented figures (4.1 s of 5 s) came from the coverage job, which no longer runs the apps tests.
  A developer aid now documents how to reproduce a Linux leg locally ([tools/native-fs/README.md](../../tools/native-fs/README.md#reproducing-a-linux-leg-on-a-macos-or-windows-machine)); run a changed or racy native test there before pushing.
  *Unproven or left open, recorded:* a multi-process probe kept in the repository (the reviewer's scripts were throwaway); Linux and Windows execution (only the eight-target CI shows it), including a Windows scan
  meeting a delete-pending entry, `LockFile` behaviour beyond the type check and the Windows e2e test; network homes that emulate `flock`; the cold-start race (twelve independent cold starts completed 72 of 72, which is
  evidence, not a proof); a reservation beyond the grace behind a holder in another process is still refused as before (a distinct "busy" result retried by the host without holding a thread stays an option);
  closing the producer's reservation handle after the pin removes it (a possible Windows hardening); the exported `recoverMetadataStaging` has no product caller although every native stage runs a recovery pass
  first; sibling `open_nofollow(&entry.path())` sites in cleanup paths were reviewed and left alone; the retired-index check is made once per operation. *Owed:* the maintainer's reading of ADR-0135, a separate
  security sitting on the delta since round 3 and all eight native legs green on the final head.
  **Update (2026-11-19, PR #100 merged as `1e71f652`).** CI run `44402914088` on `2ce6a252` passed all 29 jobs, including all eight native legs (Linux gnu and musl, macOS and Windows, x86_64 and aarch64), so the last of those three is met. The head that was merged,
  `639134b2`, differs from it only in `tools/native-fs/README.md`; its own run was still in progress when the maintainer merged ten seconds after the push, so no completed run exists on it. *(Updated 2026-11-21: that run, `44424575691`, completed and passed on `639134b2`, and the merge commit's push run, `44424607930`, passed too; checked with `gh run view`.)* Still owed: the reading and the security sitting, whose
  delta is everything after round 4 (the held-link-count scan check, the nonce bound of 384, the `capture_parent` double read, the reader's pure-function extraction); the Inc 1 status above stays the record of what shipped.
  *(medium · apps/cli/native/fs-metadata, apps/cli/src/engine/tool-host/fs-stage-inventory.ts)*
- [ ] **Entries leaked by a crashed producer are never reclaimed, so repeated crashes can fill the 128 inventory slots and refuse every native write (found 2026-11-18 by a security sitting; pre-existing, not changed by Inc 1).**
  An independent run of 40 SIGKILLs of a three-writer process left 84 retained entries (28 `.prepare`, 50 `.reserved`, 6 `.record`) and three recovery passes removed none; a rerun with 15 kills left 39 and removed 1.
  Recovery retains every `.reserved` and `.prepare` and every `.record` whose stage it cannot prove; some retained `.record`s belong to dead producers whose stage directory is already gone (killed between the
  directory removal and the marker removal), so `cleanup_record` returns `Changed` (`open_parent(&record.stage)`) and recovery retains them. At 128 entries every native write is refused (`changed:not_needed`, reported as
  `effect_needs_attention`) and the contract forbids removing entries by hand. The design is conservative on purpose (never delete evidence that cannot be proven) but nothing bounds the leak. **Open design question
  (needs an ADR):** a supported removal of a dead producer's `.record` whose stage is proven absent (identity-checked, claim the marker, remove only the marker) and, separately, of a dead producer's `.reserved` or
  `.prepare` that is proven empty. Candidate for Inc 2 or its own increment. A refused pre-pin cleanup leaks the same way: after a stuck holder made it wait two seconds (a security sitting broke the source recheck
  and grabbed the claim right after `reserve` released it) stage failed `changed:uncertain` and left the `.reserved` plus an empty `.relavium-fs-stage-v1.<pid>.<nonce>/payload` directory in the project, and a recovery
  pass retained the `.reserved`. *(medium · apps/cli/native/fs-metadata)*
- [ ] **PR #99 review corrections — what the 2026-11-17 implementation left undone (small).** (1) S-2 (review-document cost): the document is now built once
  per frozen preview and not at all in `plan`, but a build in `ask`, `accept-edits` and `auto` still runs when the preview event arrives, before any card
  needs it (about 300 ms per MiB of diff). Deferring it needs `ToolDisplay.document` (`tool-display.ts`) to become lazy; the retention loop reads
  `document.sourceBytes` and the call list's "preview unavailable" marker reads `document === undefined`. (2) C-2: `tools/fs-policy-controls/floor.cases.mjs`
  (~72-76) lists the credential classes its mutation cases cover; extend it with `.gnupg`, `.password-store`, `Library/Keychains`,
  `.local/share/keyrings`, `.config/op` and `gh/hosts.yml`, and expect the pinned fs control inventory counts to move. Windows GnuPG keeps its home in
  `%APPDATA%\gnupg` (no leading dot), which the floor still does not cover. (3) U-7 reserves more than strictly needed: the card strips the `target ` label only from the
  first row and the second row has spare columns, so a reviewer's probe puts the real headroom at about 15 columns (about 137 characters instead of 122 at
  80 columns); not worth a second budget. *(low · apps/cli/src/render/tui, apps/cli/src/engine/tool-host)*
- [ ] **PR #99 D64 round (2026-11-17): lows left open.** Four independent reviewers (approval logic, card/TUI, fs/core/db, honesty and pins) found one high, three
  mediums and the lows below; the high and the mediums are fixed. (1) A double-tap of `n` after card A can deny card B before its frame is acknowledged — a
  `user` denial for a call never shown, after which ADR-0117 §3 refuses an identical repeat for the turn; ignore a second `n` for about 150 ms after the review
  state changes. (2) `accept-edits` as a start mode is enforced only by the shared schema; `auto` also needs `source === 'global'` in
  `StartingModeAuthority.resolve`, so a card-approved or model-written `[preferences].default_mode = "accept-edits"` in an operator-selected
  workspace-local `--config` (ADR-0112) would start the next `/clear`, reseat or restart without a card for edits: give `accept-edits` the same
  global-source check, and give a repository `accept-edits` an actionable `OperatorConfigError` instead of the generic enum message (`load.ts` ~72).
  (3) **Closed 2026-11-19 (MVP-4 step 4, round 2, commit `c5bd43be`; ruled by the maintainer):** a repository's `[chat].allowed_commands` and globs no longer widen what an operator's own `auto` runs without a card: in `auto` only a remembered grant or a session approval skips the card, a listed command asks ([ADR-0118](../decisions/0118-a-command-outside-the-allowlist-asks-instead-of-failing.md), amended 2026-11-21). (4) **Closed 2026-11-19 (MVP-4 step 2, commit `066c8b64`): `reduceApprovalKey` is deleted** with the legacy prompt. It had mapped `y`, `a`, `1` and `2` to an approve with no
  visibility gate and was unreachable — **since 2026-11-17 it answered nothing** (only Esc and the Ctrl+T reasoning toggle); the dead legacy prompt around it is its own entry below; `agent:approval_requested` is still published for plan refusals,
  headless refusals and auto-approved writes with no card (ADR-0130 amendment 4). (5) A masked substring in a target does not lock Allow (conforms to
  ADR-0120; consider requiring a reveal for any mask in the target field); typing in the denial-reason box can drop characters typed in the same tick (`reviewPage`
  is reset after every state change); "Review unavailable — the tool identity does not fit; enlarge terminal" is also shown when the identity is invalid
  because a mask matched, where enlarging does nothing; there is no wide, CJK or emoji target test of the card; a last changed line whose ending-token row is
  cut counts as not shown on the card; repeated Shift+Tab mid-turn adds one notice row per press. (6) A `.prepare` that vanishes mid-scan is skipped without a retry
  (documented in the native contract); `list_directory` and `find_files` names still show Unicode format characters (only glob headers escape them);
  `GH_CONFIG_DIR` outside `gh` and Windows `%APPDATA%\gnupg` are not covered; glob headers are not counted in `sizeBytes` and the escape can expand a name up to
  6×; `hasSegmentRun` leaves `..` segments alone on purpose. *(low · apps/cli)*
- [ ] **Chord answer keys: security sitting residuals (2026-11-17; no blocker, high or medium).** (1) `Ctrl+G` is the abort reflex of Emacs, readline, zsh and fzf, and here it starts the most permissive answer: a person who presses it to "cancel" and then Enter 0.8–5 s later grants the session-wide permission (it only asks first; the rows say "Press Enter to allow all … · Any other key cancels"). The sitting judged a different key only marginally safer (every chord has a reflex) and advised keeping it unless a manual test shows the reflex; optionally put the scope first in the confirm row. Test it in the real terminals (VS Code's integrated terminal, tmux, Windows Terminal) before 0.2.0. (2) A terminal left in xterm `modifyOtherKeys` mode (a crashed app can leave it set) sends Ctrl+letter as `ESC[27;5;121~`, which Ink does not read as a chord: every answer chord is ignored and only Esc answers (fail-closed, and a regression from bare letters, which were immune); parse `CSI 27;m;c ~` in the host or reset `CSI > 4;0 m` on mount, and document the Esc fallback. Some hosts may also swallow Ctrl+G/Ctrl+Y/Ctrl+N/Ctrl+R (an Emacs terminal mode, VS Code's `commandsToSkipShell`): unverified here. (3) The `ask_user` refusal of key tokens (`APPROVAL_KEY_TOKEN`) catches the exact `[Ctrl+Y]`-style forms but not look-alikes (full-width brackets or letters, Cyrillic `С`, `<Ctrl+Y>`, `[Ctrl + Y]`, unbracketed `Ctrl+Y Allow`); harmless today because a question card answers no approval, and prose cannot be filtered. (4) A held chord's refusal note reads "Keys were typed just before this answer" although nothing was typed (wording predates the chords); `Ctrl+R` (the reverse-search reflex) opens the reason box, which can be left only by Enter (a denial with the typed text as its reason) or Esc (stops the turn). *[Resolved 2026-11-19 by ADR-0115 §3: `Esc` now closes the box and leaves the call pending; `Ctrl+C` is what stops the turn from it.]* (5) With no paste listener Ink delivers a pasted 0x19 as Ctrl+Y; the product always mounts one on both surfaces, but a terminal that does not strip `ESC[201~` from pasted content lets a clipboard break out of bracketed paste (the old breakout plus a bare `y` did the same). *(low · apps/cli/src/render/tui, packages/core)*
- [x] **Delete the dead legacy approval prompt (found 2026-11-17, with the chord change).** *Closed 2026-11-19 (MVP-4 step 2, commit `066c8b64`): deleted behind a characterization test, with the `approve`/`reject`/`reject-with-reason`/`cancel` key actions, the `approvalPending` parameter, the reason-draft state in both surfaces and the dead `ChatView` block.* The store opens a card for EVERY approval (`requestApproval` builds a fallback review when the call has no preview), and `handleReviewInput` answers `handled` for every key while one is open, so the older prompt is never reached: the `approval={review === undefined ? approval : undefined}` block in `chat-ink.tsx` / `home-app.tsx` (its hint text is kept truthful meanwhile), the `reasonDraft`/`applyReasonDraft` capture and its React state, `reduceApprovalKey` in `chat-input.ts`, and the `approve`/`reject`/`reject-with-reason` members of `ChatKeyAction` that nothing produces any more. Delete them together with their tests; it touches the approval path, so it takes a review round. Other bare-letter confirms in the CLI (the native prompt host's `y/N`, MCP consent, the workflow gate prompt) are line prompts that a running turn cannot be typed over, a separate surface and not part of this.
  **Analysis (2026-11-18, read-only; the always-`undefined` prop and the abort route were re-checked against the code).** Correction: `reduceApprovalKey`'s Esc is **not** dead.
  `home-app.tsx` ~683-688 forwards a card `abort` as a synthesized Esc into `home-controller.ts` ~1789, then `reduceChatKey(approvalPending)` and `reduceApprovalKey`; it goes
  with ADR-0115's keymap work (or the synthesized Esc becomes a direct abort), not before. Proof by reading that the block never renders: `approval` is assigned only at
  `chat-store.ts` ~863 and `review` at ~871 in the same synchronous executor before the only `flush()` (~877), so `approval={review === undefined ? approval : undefined}`
  (`chat-ink.tsx` ~1822, `home-app.tsx` ~215) is always `undefined`, and the three action kinds are produced by nothing, so `reasonDraft` is never set. Not proved: a
  synchronous throw between the two assignments would leave an approval with no card (none found by reading); add a store property test, `approval !== undefined` implies
  `review !== undefined`. **Delete (about 200 production and 200 test lines):** the `approval` and `reasonDraft` props and block, `applyReasonDraft`, `reasonCaptureOpen` and
  its capture handler in `chat-ink.tsx`; the matching lines in `home-app.tsx` and in `home-controller.ts` (`reasonDraft` state, `routeReasonKey`); the three action kinds and
  `reasonCaptureOpen` in `chat-input.ts`; `formatApprovalTarget` (`chat-projection.ts` ~757) with its tests. **Keep** `answerApproval`, `requestApproval`, `PendingApproval`,
  `snapshot.approval` (the card host reads it), `denialReasonDisclosure`, `sanitizeApprovalReason` and the `approvalPending` gates. **Tests to adapt:** `chat-input.test.ts` ~173-309
  and ~596-604, `readable-feedback.test.tsx` ~28-62 (the disclosure stays pinned in `tool-review-host.test.tsx` and `chat-app.test.tsx`), the `reasonDraft` assertions in
  `home-controller.test.ts`. Recommended order: the first steps of MVP-4 (see the S3776 entry below), so one cumulative D64 round and one sitting cover it; a stand-alone
  increment would need two rounds and would refactor code the keymap rewrites anyway. *(low · apps/cli/src/render/tui)*
- [ ] **PR #99 separate security sitting (2026-11-17): residuals after the fixes.** The sitting found one high, two mediums and one low; all four are fixed (the approval
  keys now need a 400 ms dwell and a 300 ms quiet gap; `[a]` only on a page that shows everything it grants; the card names the canonical path when parents are created;
  `list_directory` no longer resolves a link target). Left open, all low: (1) **Closed 2026-11-17:** a `y` that was the first key after 1.5 s with no other key, and a lone `a` followed by Enter, could not be told from a deliberate press; the maintainer
  moved every answer key to a Ctrl chord (`Ctrl+Y`, `Ctrl+G` then Enter, `Ctrl+N`, `Ctrl+R` — ADR-0129 note 12), so no letter typed at a card answers it. A bare `v` still opens the full view
  (inspection only, grants nothing). (2) `read_file`, `find_files`, `search_files` and `list_directory` with a planted link as the root still tell "escapes the allowed filesystem scope" from "does not exist"
  (and a search over a directory holding such a link counts an existing out-of-scope target as skipped, a missing one as unreadable), so the existence of a protected
  store is still observable (contents never are); (2b) the question card's `QUESTION_SETTLE_MS` guard still reads the wall clock (`Date.now()`) where the approval guard now uses a monotonic one. (3) Windows: the canonical-path comparison is exact, so a new intermediate
  directory name with a trailing dot or space is normalised by `mkdir` and is now refused as `stale_file`; the link tests are skipped on Windows. (4) The workflow-level
  `TURBO_TOKEN`/`TURBO_TEAM` environment applies to every job in `ci.yml` (it predates this change). (5) A shortened target on a call without a diff is not treated as a
  clipped body for `[a]`; the target already has its own mandatory-inspection lock. *(low · apps/cli, .github)*
- [ ] **Full view and tool details: left out of ADR-0134 on purpose (2026-11-17).** (1) A readable leading-tab glyph: a tab is `<TAB>` per character, so every indent of a Go or Makefile source reads `<TAB><TAB>func …`; drawing a leading run differently would change a safety notation and needs its own decision. (2) Syntax highlighting (a new dependency: ADR), word-level highlight inside changed lines, and a side-by-side layout on wide terminals. (3) Mouse-wheel scrolling in the full view (the alternate screen reports the wheel; the full view ignores it). (4) `End` on a document whose last line is longer than a page lands at that line's start, not its tail (`PgDn` walks through it, every page reachable). (5) `Tab`/`Shift+Tab` is listed even when the only change is already on screen. (6) The call list drops its right-hand text (`+a −r`, the outcome word) when it cannot fit — never at the 80-column floor — and its tool column follows the visible window, so it can shift while scrolling. (7) The nav legend says `[p] Unicode codes` and the status rule `Unicode code points`: one concept, two words. (7b) Found by the second security sitting, outside this change: a space at a row's cut is drawn raw at the end of the row (a `run_command` target `rm -rf …ddddd /` reads `Run rm -rf …ddddd` with a lone `/` on the next row), so the separating space is invisible and `[p]` does not mark it either; it comes from the ADR-0120 projection and affects the card's title and body rows alike. (7c) A terminal that draws a cluster wider than `string-width` counts (a conjunct chain, a keycap plus mark) is invisible to the measured acknowledgement — the standing ADR-0069 assumption. (7d) Rows and cut targets can be SHORTER than the room allows for text whose clusters the width estimate over-counts (decomposed Hangul, skin-tone emoji, a keycap followed by a modifier): a row ends at about two thirds of the page, a cut target keeps fewer characters than fit. Wasted columns only — never wider than the page, no byte lost; an upward probe after the downward halving would fix it (found by the ADR-0134 tests, accepted). (8) Found by the ADR-0134 review, not in its diff: searching again with the same query (`/` then Enter) finds the same occurrence, because a search starts at the cursor's own offset inclusive (`findLineMatch`), so "No later visible match" is never reached by repeating it. (9) The call list shows `ToolDisplay.target` — sanitised and bounded, but not secret-masked, exactly as the transcript's `→ target` row already does (a `run_command` target is the whole command); the review document masks it. Nothing new is exposed, but one masking policy for both would be cleaner. *(low · apps/cli/src/render/tui)*
- [ ] **Full view and tool details: seven SonarCloud cognitive-complexity findings left open (PR #99, 2026-11-17).** After PR #99's push, SonarCloud's gate was OK (all four new-code ratings 1, duplication 0.8%) and 98 non-gating `CODE_SMELL`s were open; 43 were new from the ADR-0134 commit and 36 of them were fixed in source (the `KeyRow` splitter is now a linear single pass, `keyLabelParts`, after Sonar's S8786 showed its regular expression backtracked quadratically — 5,000 `[` took 10 ms, 100,000 took 3.4 s — though a row is bounded by the terminal's width, so it was not exploitable; nested ternaries became helpers or statements, `.at()`/`toReversed()`, row keys that do not depend on position, `toHaveLength`). The maintainer chose to leave the seven S3776 findings open rather than refactor consent-path code without a new D64 round: `reduceFullReviewKey` (`tool-review-model.ts`, complexity 38 of 15), `projectReviewRow` (`tool-review-projection.ts`, 27) and `projectReviewPage` (17), the full view's chrome and status builders (`tool-review-screen.ts`, 21 and 21), and `tool-review-scroll.ts` (20 and 18). Splitting them is behaviour-preserving work that the 1,320 tests of the eight review files can check, but it touches the approval and inspection path, so it needs the tiered bar's new complete round and a separate security sitting. The other 40 open findings are the older non-gating set and are unchanged.
  **Analysis (2026-11-18, read-only; counts from SonarCloud's public API for `main` at `002dda58`, project `HodeTech_Relavium`; the open-finding total of 233 was confirmed live).**
  Sonar lists **11** open S3776 findings in the six review files, not seven, plus two in neighbouring files that MVP-4 rewrites anyway (`chat-store.ts` ~521 `handleReviewInput`
  at 45 and the `chat-ink.tsx` ~1385 `useInput` at 102); the repository has 233 open S3776 findings in all, so this entry's scope is the approval path only. The 11:
  `reduceFullReviewKey` (`tool-review-model.ts` ~658, 29 — the 38 above predates the nested-ternary fixes), `reduceToolReviewKey` (~357, 27), `toolReviewPage` (~516, 16),
  `projectReviewRow` (`tool-review-projection.ts` ~590, 27), `projectReviewPage` (~367, 18), `cardStartLine` (~338, 17), `fullWarnings` (`tool-review-screen.ts` ~98, 21),
  `keyLabelParts` (~429, 16), `contextStartLine` (`tool-review-scroll.ts` ~203, 20), `changeJump` (~255, 18) and `cardWarnings` (`tool-review-card.ts` ~167, 26). The "chrome and
  status builders (21 and 21)" and "`projectReviewPage` (17)" above do not map one-to-one onto this list. `reduceToolReviewKey`, `cardWarnings` and perhaps `toolReviewPage` are
  likely to be rewritten by MVP-4's chord and card work; `projectReviewRow` is defect-dense (ADR-0134 found a high and quadratic mediums there), so refactor it only behind a
  differential fuzz, or leave it. **Recommendation:** fold the refactors into MVP-4 as a droppable ride-along after the keymap and card work, behind test-only commits that need no
  round: golden characterization of `reduceFullReviewKey` driven through `reduceToolReviewKey` (key probes, a state grid, the `b`/`r`/`/`/`c` pins), a vendored pre-refactor
  baseline with seeded differential sweeps for the pure functions, and a store property test. One cumulative D64 round and one sitting then cover everything; a stand-alone
  increment costs two rounds and discards about four of the refactors. A mutation sweep over the five pure files is practical (about 11 s per run). There is no local sonarjs
  lint, so the counts are confirmable only by a fresh Sonar analysis. *(low · apps/cli/src/render/tui)*

### PR #99 merge CI observations (2026-11-18)

- [x] **The required `coverage` job stopped at its 45-minute limit on PR #99's final head, in both runs (2026-11-18) — analysed the same day; the narrowing is applied and closed by its first CI runs (2026-11-19).** The `pull_request`
  run `44222406356` (job started 02:58:01) and the `push` run `44222399222` (started 02:54:03) each ended exactly 45 minutes after their own start, with the annotation
  "The job has exceeded the maximum execution time of 45m0s" and the step "Engine coverage floor" cancelled. It was not a hang (the log shows test files completing
  normally seconds before the stop) and not a manual cancel (the two stops are four minutes apart, each at its start plus 45:00). The job took 26 to 38 minutes in
  six earlier completed runs (`de0573b1`, `a15c8f8e`, `13a79431`), 29 and 38 at `13a79431`; since then only seven `apps/cli/src/render/tui/tool-review-*` files changed in
  product code (the Sonar fixes, which the full local gate verified with the enforced coverage run: 917 files, 20,745 tests, 20,720 passed and 25 skips). The limit was 30 until
  2026-11-04, when the job took 15 to 27 minutes, and is 45 now. The merge commit's run `44232410834` passed it in 41 min 10 s (the same tree as `bb6f1671`).
  **Analysis (2026-11-18, read-only, 57 completed runs with logs): both slower and larger.** Runner speed varies 1.9× on identical code (the same tree took 29.4, 38.2 and
  41.2 min, and needed more than 45.3 on `bb6f1671`); the two runs of a same-SHA push/PR pair are independent draws (correlation 0.04 over 19 pairs, and lone runs are not faster),
  so the double trigger does not make them contend. The workload also grew: between `de0573b1` and `13a79431`, on equally fast runners, test time rose 1,048 → 1,199 s, 75% of
  it `tool-review-host.test.tsx` (36 s → 119 s, 144 → 266 tests). The step is 99% of the job and runs **all 917 test files** (20,745 tests) at `--maxWorkers=1`, although
  thresholds exist only for `packages/llm` and `packages/mcp`: apps/cli is about 74% of the test time, `packages/db` 17%, core 4.7%, llm and mcp 3.5%. The six per-test 5 s
  timeouts since 11-11 were all apps/cli CPU-bound tests running under coverage on a slow runner; a higher job limit would not fix them. **Remedy verified locally (2026-11-18):**
  `vitest run --coverage --maxWorkers=1 --dir packages` under `CI=true GITHUB_ACTIONS=true RELAVIUM_COVERAGE_ENFORCED_ONLY=1` passed 407 files in 4 min 44 s (at machine load
  about 13), and every enforced or reported line and branch figure equals the CI run of `002dda58` to two decimals (llm 97.80 / 95.72, mcp 96.56 / 91.30, core 96.83 / 91.59,
  db 97.85 / 93.21; only `shared` lines differ, 96.62 against 96.72, and it has no floor), so narrowing the instrumented run does not change what the floor measures; the apps
  tests still run in `ci-work`. Expected saving about 22-32 min per run. A change touches `tools/coverage-gate/run.mjs`, the pins in `tools/ci/workspace-scheduling.test.mjs`
  (run args ~line 47, timeout ~195-196) and `tools/ci/local-gate.test.mjs` ~99-122 (the local `pnpm gate` coverage lane shares the script), and a note in
  `docs/standards/testing.md`. Raising the limit to 60 saves nothing and only postpones this; sharding the run would move the thresholds into a merge job and rewrite many
  pins, which the narrowing makes unnecessary; do not remove `--maxWorkers=1` (commit `122e8189` made it on purpose, "retaining every case, threshold and native concurrency assertion"; its footer cites ADR-0111, whose title is about the lazy packaged runtime, so the commit message is the only recorded reason). Hot spots if more is needed
  later: `tool-review-host.test.tsx` (about 120 s on every runner) and `packages/db/src/session-usage-scale.test.ts` (one test, 91-215 s). It matters because a required check
  that cannot finish blocks every PR, and since the speed-up it is the longest job. **Applied (maintainer chose it 2026-11-18; commit `63123bd9`):** `tools/coverage-gate/run.mjs` passes `--dir packages`, the pin test expects it (mutation-checked) and the real
  `pnpm coverage:enforced` entry passed under the CI environment (407 files, 4 min 50 s, same figures). **Closed 2026-11-19:** the first CI runs on `development` after the change show the job's own duration and a green result: 10 min 56 s in run `44395981912` (`cf5ad1d3`) and 12 min 25 s in run `44402914088` (`2ce6a252`), against 26 to 45+ minutes before. The step ran 407 test files (11,214 tests passed, 11 skipped; the earlier job ran 917 files) and `llm` read 97.80 lines and 95.72 branches, the figures of the `002dda58` run. The apps tests keep running in `ci-work`, and the
  hot spots named above stay a possible later optimization, not an open item. *(medium · .github/workflows/ci.yml,
  tools/coverage-gate)*
- [ ] **One secrets-control shard's verify step hit a 10-second test limit on `main`'s merge run (2026-11-18); rate measured at about 1 in 27 job runs.** In the `push` run `44232410834` of the merge
  commit `002dda58` (its tree is identical to `bb6f1671`'s), `Wave 2 secrets causal controls (shard 1 of 3)` failed about two minutes in, at step "Verify causal outcome and worker
  lifecycle guards": `tools/cli-package/smoke/native-process.test.mjs:189`, "two same-directory copied Nodes share verified runtime support and acknowledge the actual descendant",
  took 13,966 ms against its 10,000 ms limit. The same step passed in the two final-head runs of the identical tree (that shard took 27 and 33 minutes there). One occurrence, so
  it is neither called flaky nor dismissed. **Measured (2026-11-18):** the same test took 0.2 to 1.5 s in 26 other secrets-shard job runs (11 workflow runs from `43709041301` to
  `44222406356`; the filesystem shards were not read), and 13.97 s in the failing one, about ten times the largest of the others; the neighbouring tests of that run were normal (a 1,004 ms case that is a 1 s
  watchdog by design), so one test's copy-and-start phase stalled. The test copies the Node binary twice (`copyFixtureNode`, `copyFileSync`) inside a 10 s case bound, and its
  inner 4 s readiness poll and 5 s watchdog start only after the copy, so a slow disk on a fresh runner can exhaust the case bound before either inner bound can fire; which phase
  stalled was not recorded. One failure in 27 is about 3.7% per job run (a small sample), and the test runs in every secrets shard, so a commit whose pipeline runs twice has roughly a 10-20% chance of one red `ci`, which a re-run clears.
  The case sits under the approved `LOW-1` deferral above (fixed 5 s bounds inside 10 s cases; "a loaded runner produces red without a defect"); its trigger, a recorded failure that names the bound that fired, is now met for the 10 s case bound on Linux. The retune is the coupled set
  (case bound, readiness poll, watchdog), so raise the outer case bound together with a measurement of which phase stalled, not alone. **Re-run (2026-11-18):** attempt 2 of the failed job
  passed (started 15:45 UTC, 35 min 49 s), the `ci` aggregate followed (16:21 UTC) and the run's conclusion is `success`, so `main`'s three required checks are green again.
  Second occurrence is the trigger to retune; until then the entry stays open as a measured low. **Update (2026-11-19):** PR #100's CI review raised this test's case bound to 30 s (`6f20bd2e`, with a comment); the bound was raised alone, not
  together with the readiness poll and the watchdog, and the stalled phase is still not measured, so the retune above is only half made. No second timeout of this test has been recorded since. *(low · tools/cli-package/smoke)*
- [ ] **The scheduled `model-catalog` run was red on 2026-11-18 at 16:02Z: the live DeepSeek effort test hit its five-second default (found 2026-11-19 while reviewing the repository's runs; unrelated to PR #100).** Run `44342569457` (a `schedule` run on `002dda58`),
  job `effort conformance (live)`: `packages/llm/src/conformance/effort.conformance.test.ts` > `deepseek-v4-pro accepts every tier the catalog claims (low, medium, high, max)` failed with "Test timed out in 5000ms" (the run's other 543 tests passed). The test makes one real
  provider request per distinct wire tier in a loop and has no timeout of its own, so it runs under the five-second default; it is a live network probe, so its duration is the provider's. The same workflow's scheduled runs passed on 2026-11-12 to 2026-11-17 except one on 2026-11-16 (15:29Z), which failed in a different job
  (`shipped-price-change guard`) that was not read here; that is two red runs of eight, with different causes, so no rate is claimed for this one. None of the file's four live cases (Anthropic, OpenAI, Gemini, DeepSeek) sets a timeout, so the other three have only not exceeded five seconds yet. Candidate fix: give the live cases a budget sized to their request count
  (the probe-tier count times a per-request bound) and keep the five-second default for the offline test. *(low · packages/llm/src/conformance, .github/workflows/models-catalog.yml)*

## MVP-4 step 2 follow-ups (2026-11-19)

- [ ] **A held `Ctrl+Y` on a slow key repeat can pass every approval-card guard (found 2026-11-19, step 2 security review).** The guards of [ADR-0129](../decisions/0129-the-approval-card-is-docked-bounded-and-says-only-what-matters.md) notes 9 to 11 refuse a held key by the 300 ms quiet gap and the 2 s lockout, but a `Ctrl+Y` held from before any card exists, on a key-repeat interval of 300 ms or more (an accessibility setting), counts as a foreign key while no card is open and its repeats at the card are not foreign, so after the card has been up for a few seconds one repeat passes every layer. Simulated at repeat intervals from 300 to 1,800 ms for the approval card and the continue checkpoint alike (the checkpoint inherits the guard, so it is no weaker than the card); it needs a key held for seconds. A fix (a refused affirmative key starts its own held window) makes a person who is merely a little early wait longer, so it is a trade for the maintainer: decide the window, then change `approvalKeyRefusal` for both cards. Low. **Not scheduled; needs a ruling.**
- [ ] **Repository-wide rot of `#proposed-…` doc anchors (found 2026-11-19, step 2 documentation review; pre-existing).** About fifty links in `docs/` (including appended-only ADRs and the phase register) point at headings that lost their "Proposed" prefix when their contracts were accepted (`#proposed-mvp-3-interaction-contract`, `#proposed-prepared-writes-and-live-previews--mvp-3`, `#proposed-standard-environment-key-consent--mvp-2`, …). Several targets also moved or were renamed, so the repair is per link, not a prefix strip. A link checker over `docs/` (headings slugged the GitHub way, `analysis/` and `reviews/` excluded) lists them; the ADR links need dated notes rather than edits. Low. **Owner: the next documentation sweep.**

## PR #101 review (2026-11-21) — findings answered, refuted and deferred

> Three independent reviews of [PR #101](https://github.com/HodeTech/Relavium/pull/101) (`development`→`main`, head `9c5985ac`, 210 files, opened 2026-11-21) produced three reports (A, B and C). Every claim was checked against the code and the other documents before it was classified. What was **fixed**, what was **refuted** and what **needs a human** is in the phase record's [PR #101 review corrections](phases/phase-2.6-conversational-authoring.md#pr-101-review-corrections--2026-11-21), with the commits; this section holds what stays **open**. The ids (M, L, B, H, K, S, U, T, V) are the reports' own. *Owner: maintainer decision* means a ruling is needed before any work; *not assigned* means no owner or trigger was recorded (so the marker is `[ ]`, not `[~]`). Lows are as the reports wrote them: they were not re-probed in this pass unless an entry says so.

### Report A (code and security review)

- [ ] **The grants directory's mode and ownership are not validated when it already exists (A·M1).** `appendLine` creates `~/.relavium` with the owner-only mode only when it makes the directory (`mkdirSync` with a mode); one that exists world-writable, or owned by someone else, keeps its mode, and the `0600` file inside it can be replaced by whoever owns the directory. The same-account limit already stands (ADR-0118 §2); this is a shared or tmp-style home. The review points at the private-directory discipline of `fs-policy.ts` (not a symbolic link, no group or other bits, own uid) for the parent. Decide whether an existing directory is repaired or refused. **Owner: maintainer decision.** *(medium · apps/cli/src/permissions/command-grants.ts)*
- [ ] **`writable()` is a best-effort `accessSync` that follows a symbolic link (A·M2).** `canRemember` can say yes for a path that is a link; the write itself refuses a link (`O_NOFOLLOW`), so nothing is bypassed, but the card can offer *Remember* and then fail. Mirror the reader's `lstat` and `O_NOFOLLOW` discipline in the pre-check. **Owner: not assigned.** *(low · apps/cli/src/permissions/command-grants.ts)*
- [ ] **Core coverage is measured but not enforced (A·M10).** The `coverage` job of `.github/workflows/ci.yml` fails only for `llm` and `mcp` under their floor; `packages/core` is reported and not gated, and `tools/ci/workspace-scheduling.test.mjs` pins the shape. **Owner: maintainer decision** (enforce core when Wave 3's coverage items finish, and align that pin). *(medium · .github/workflows/ci.yml)*
- [ ] **Report A lows, as written (L1–L3, L5, L6, L8–L14, L18, L19, L21–L27).** (L1) an all-zero or low-entropy keychain entry is accepted as a key (same-user attacker); (L2) a negative keychain state is not cached (a perf amplifier); (L3) `appendLine` itself checks no bound (its callers do); (L5) `isProtectedTarget` is optional in the mode deps, a fail-closed default is suggested; (L6) the 128 KiB injection bound counts UTF-16 units, not bytes; (L8) an argv holding NUL is accepted by the allowlist and by a grant; (L9) an explicit executable path can spawn outside the jail (the author-trust model); (L10) `GRANT_NUMBER` is six digits (the store holds at most 1,024); (L11) `findProjectConfigDir` swallows an error, so a chat and `permissions` could disagree on the root; (L12) an uppercase `D` arms a withdrawal; (L13) an armed withdrawal is dropped silently on `Esc`; (L14) typing on a very small terminal is dropped silently; (L18) a missing runtime root is protected lexically only (`fs-native-metadata.ts`); (L19) the host-denied error is generic (hard to triage); (L21) an abort listener in `fs-native-write.ts` needs `checkCancellation`; (L22) `builtins-identifier-order.test.ts` has a 5 s timeout; (L23) `secret-context.test.ts` has a 20 ms sandbox timeout; (L24) `scrubbedCommandLine` over-masks (documented); (L25) `ci.yml` has no `pull_request` trigger (documented policy, C4); (L26) the pins of the heavy files (shards 2 and 3) were not independently verified; (L27) `.gitattributes` LF pinning may need to cover future native-adjacent files. Not carried as entries: L4 (tombstones are unauthenticated: a documented design), L7 (the M3 refutation), L15 (a too-large card is not drawn: by design), L16 (verified, no change), L20 (a replaced lock is non-retryable: expected), L28–L31 (documents: fixed), L32 (two commits without the trailer: acknowledged, history not rewritten). **Owner: not assigned** (L25: maintainer decision). *(low · apps/cli, .github)*
- [ ] **Pre-existing on `main`, not in PR #101's diff (A·M4, A·M5, A·L17).** `apps/cli/native/fs-metadata/src/macos.rs` and `stage_index.rs` are not in `git diff 1e71f652..9c5985ac` (they came with PR #100): M4 resolves the optional `getumask` with `dlsym` and a `transmute` (a hostile `DYLD_INSERT_LIBRARIES` could supply the symbol; L17 is the ABI assumption), and M5 returns `is_unlinked = false` on Windows, so a delete-pending entry stays a name-only proof (ADR-0135 leaves Windows unproven). **Owner: ADR-0125, ADR-0127 and ADR-0135's own increments** (Inc 2 and 3 of the native adapter). *(medium · apps/cli/native/fs-metadata)*

### Report B (systematic review)

- [ ] **A partial append makes the whole store unreadable until `revoke --all` (B·H2, C·K8).** `writeSync` can stop part-way (a full disk), leaving a torn last line; the fold is fail-closed on purpose (a torn line may be a tombstone), so every remembered command reads as "no grants" and the person is told "not remembered". The recovery is `relavium permissions revoke --all` (documented). The follow-up is a truncate-back of the torn bytes that is safe against another writer appending at the same moment; related: there is no `fsync`, and two processes can pass the bound together so the next fold exceeds it. **Owner: maintainer decision** (fail-closed stays unless a safe truncate-back is designed). *(medium · apps/cli/src/permissions/command-grants.ts)*
- [ ] **`revoke --all` clears an account-wide key while the file is per home (B·H15).** Documented in [command-permissions.md](../reference/cli/command-permissions.md) on 2026-11-21 (one keychain entry per account, one file per `HOME`). The design option is to scope the keychain account by home, so a test home cannot clear the real key. **Owner: maintainer decision.** *(medium · apps/cli/src/permissions, apps/cli/src/commands/permissions.ts)*
- [ ] **The Home's sheet store tells nothing about ignored records (B·H14, Home half).** `permissions list` now says on stderr that records made with another key were ignored (`5d2ac9ab`), and a chat's store reports it once through `notify`; the Home's per-read store (`drive-home.tsx` ~1806) passes no `notify`, so after a reset keychain its sheet shows "nothing remembered" for a file that holds unverifiable records. Pass a sanitized notice, or return the ignored count in the port's list result. **Owner: not assigned.** *(low · apps/cli/src/home/drive-home.tsx)*
- [ ] **A `remember` that finds a live record reports success without re-reading (B Medium).** If another process tombstones that grant between the read and the answer, the person is told it is remembered and the grant is dead; append a new record or re-fold after the write, and add a two-store test. **Owner: not assigned.** *(low · apps/cli/src/permissions/command-grants.ts)*
- [ ] **UI and code, from Report B's medium table.** (a) The sheet's window can hide the recovery note when the project section is unreadable or empty and there are many session rows (`permissions-sheet.ts`): make the section fixed chrome or add a marker. (b) A command card can exceed 12 rows with chrome plus facts (the body is forced to one, the total reaches 13 to 18), so ADR-0129's "eight transcript rows" bound does not hold; the height test has no facts. (c) `chat.ts` counts a stdout TTY with piped stdin as interactive, so the `/permissions` sheet can open with no keyboard: gate on `stdinIsTty`. (d) `HOME=''` or a relative `.relavium` can write into the working directory, and a parent workspace's `.relavium` shares one grant set with every project below it: clarify or document the scope. (e) The registry records a delivery-card rejection plus a same-tick abort as `cancelled` after the effect (the pre-effect case was fixed): decide and test. (f) `invocationKey` is keyed on the raw arguments, so `{"command":"ls"}` and `{"command":"ls","args":[]}` (one argv) get different keys and a denied repeat can open a new card (`agent-turn.ts`). **Owner: not assigned.** *(low to medium · apps/cli/src/render/tui, apps/cli/src/commands, packages/core)*
- [ ] **Tests, from Report B's medium and low lists.** The Windows symlink-swap test of `appendLine` is skipped on Windows (`command-grants.test.ts`); the non-TTY bare `permissions` test does not assert exit 2, empty stdout, the help on stderr and the `--json` envelope (`run.test.ts`); the "home cannot be resolved" test does not run the real `catch` (`chat-command-grants.test.ts`); the checkpoint suite has no "a continue does not reset the correction budget" test (`agent-turn.test.ts`); `permissions-sheet-view.test.tsx` (a 5 s timeout) and the grant store's FIFO test (an 800 ms wall-clock bound) fail under load while the assertion holds; the case-variant-root test returns early on Linux and proves nothing there; `run.test.ts` Home and bare-permissions cases can read a real `~/catalog/models-dev.json` through `seedFileCatalogOnce` (inject a temp home). **Owner: not assigned.** *(low · apps/cli)*
- [ ] **Report B lows.** (1) The question card's `onAbort` is optional, so a host that omits it leaves `Esc` and `Ctrl+C` unable to close the card (`chat-ink.tsx`). (2) `CARD_ENTER_NOTE` says "Press the key again": an early `Enter` cancels the question, and `Ctrl+G` or `Ctrl+O` must be pressed again. (3) The Home sheet's key-time close is unreachable while a card is open; close in an effect. (4) `Ctrl+Shift+C/Y/N` does not exclude the shift, so a terminal's copy chord can arrive as an interrupt or an answer (`interrupt-keymap.ts`). (5) `answerApproval` carries no request or call id (a stale answer is theoretical). (6) `run_command`'s parameter description says "permitted by the configured command policy", which does not describe the interactive card (`builtins.ts`). (7) Model-controlled command text can imitate a key token such as `[Ctrl+Y]`; `ask_user` filters them, the command card does not (a fixed warning or a data marker is the cure). (8) `default-agent.ts`'s headless prompt mentions `run_command`, which is hidden on plain, `--json` and one-shot surfaces. (9) `CHAT_LIMIT_KEYS` is exported and unused. (10) `render/editor.ts` holds a second tokenizer that extends an open quote to the end of the line (older than this PR, and at odds with the "one grammar" claim). (11) A hand-built `argv: []` target produces an empty preview that the event schema rejects: normalize it. (12) The armed sheet's `Backspace` arming key is not on its legend. **Owner: not assigned.** *(low · apps/cli, packages/core)*
- [ ] **Code comments and messages that the documents now contradict (found by this sweep, which edits documents only).** `chat-mode.ts` ~91 says *Remember* "writes the exact argv to the project's grants file" (it writes a keyed digest, never the argv); `packages/shared/src/config.ts` ~286 says "both empty/absent ⇒ `!` denied" (true only where nothing can ask; an interactive chat shows a card); `apps/cli/src/commands/permissions.ts` ~69 to 78 say `revoke --all` "clears the entry" and removes an unreadable path (a locked keychain keeps the entry, and a directory at the path is exit `1`); `session-host.ts` ~889 says a one-shot `agent run` "reads none of these keys" while it passes `max_turns` (moot for one turn); the card's not-shown sentence names *This session* and *Remember* even where *Remember* is withheld for another reason (a code carrier, a covered command); `tool-review-card.ts` could build that sentence from `offers`. **Owner: not assigned.** *(low · apps/cli)*
- [ ] **No replayable mutation-sweep artifact (Report B, evidence).** The sweep counts the PR quotes (24, 45, 75, 97 and 59 mutants) have no committed runner, mutant list, report or log, so "every surviving mutant killed or equivalent" cannot be replayed, the Remember-cancellation guards and the split-secret test included. **Owner: maintainer decision** (whether a replay harness is committed). *(medium · process)*

### Report C (adversarial pass, decisions and open questions)

- [ ] **K2: an approved process command is not a file write (recorded in [ADR-0138](../decisions/0138-a-file-write-is-remembered-for-the-project-and-outdates-older-grants.md) §6).** `sed -i`, `prettier --write` and `make` approved on a card do not outdate grants; counting every approved process command was rejected (a *Once* for `ls` would outdate everything). Revisit if a hole is shown. **Owner: maintainer decision.** *(medium · apps/cli/src/chat/chat-mode.ts)*
- [ ] **K4: runners such as `npm test`, `make` and `pytest` are not flagged as running project code.** The code-carrier table names the common ways of hiding a script in one argument and says it is not a boundary; adding a card warning for runners was left as a possible addition. **Owner: maintainer decision.** *(low · apps/cli/src/chat/command-facts.ts)*
- [ ] **K9 (rationale recorded; no work): a *Session* answer is exempt from the write rule.** The maintainer's round 2 ruling of 2026-11-19 (ADR-0118, step 4) is that a session approval given knowingly is not affected by a later write: the person saw the whole command on the card and answered it for that chat; [ADR-0138](../decisions/0138-a-file-write-is-remembered-for-the-project-and-outdates-older-grants.md) §3 limits the exemption to that chat. Kept as ruled. K5 (a grant is root-scoped, not directory-bound) and K7 (the Home's draft) are documented in [command-permissions.md](../reference/cli/command-permissions.md) and [home.md](../reference/cli/home.md); K6 (a repository `[chat]` limit above the operator's base is a hard error naming the layer) is kept, and no compatibility path is needed (no deployed users; [config-spec.md](../reference/contracts/config-spec.md#chat-limits)).
- [ ] **K10: the "failed calls ended the turn" line lists rejected calls too (V6a-17).** Label a rejection apart from a failure. **Owner: not assigned.** *(low · apps/cli/src/render)*
- [ ] **K13: the VS Code spec's *Allow Always* appends to a committed workflow (V4b-09).** Not verified beyond the text: [extension-api.md](../reference/vscode/extension-api.md) says *Allow Always* appends the quoted command line to "that workflow's `allowedCommands`", the exposure [ADR-0118](../decisions/0118-a-command-outside-the-allowlist-asks-instead-of-failing.md) rejected for the chat (a repository file makes one person's consent every clone's). The spec now records it as an open decision. **Owner: Phase 4 (the extension), with an ADR; maintainer decision.** *(medium · docs/reference/vscode)*
- [ ] **The denial-reason box shows about 40 characters and then "… N characters hidden", while the sent text is cut at 300 characters with no mark (V6a-03).** The cut is documented; the mark is missing. *(low · apps/cli/src/render/tui)*
- [ ] **The Home's refused `/permissions` has no hint (V6a-13).** [ADR-0137](../decisions/0137-permissions-is-a-sheet-and-esc-steps-back-out-of-the-full-view.md) asked for the per-command hint; the Home says `/permissions accepts no arguments.` only. *(low · apps/cli/src/render/tui/home-controller.ts)*
- [ ] **A committed `run_command` that is replayed opens the approval card first (V1-06; not verified here).** The command does not run, but the person answers a card for a command that will not. Not probed in this pass; the report marked it single-sourced. **Owner: not assigned.** *(medium · packages/core replay, apps/cli)*
- [ ] **Report C lows and tests.** Lows: wrapped argument lines can look like new arguments (V6a-05); a mouse drag re-wraps the transcript twice per event (V6a-16, a performance medium); the `Enter`-bound "allow this session" row shows while the lock is open (V6a-06); `Runs in:` is cleaned with `sanitizeInline` where `escapeReviewCharacter` shows the character (V6a-07); `--json` `permissions` output includes `outputHelp` (V5-03); `permissions --allow-fs-root` is accepted on the bare group and refused on a subcommand (V5-04); a `chatIsInteractive` stdin fault exits 9 (V5-02); the limit error says "limit of N" where N is the default (V5-07); `CommandGrantStore.revokeAll` is not called (V2-05); the question card's settle uses `Date.now` (V6a-02); a keychain delete failure is swallowed (V2-09); the typed flag is also set by a refused `d` and a very small terminal counts it as typing (V6a-10, V6a-11); keys below the Home's lower bound never reach the sheet and `nativeActionBusy` drops `Ctrl+C` while `home.md` says "always" (V6a-14, V6a-15); the torn-tombstone test's name claims more than it measures (V2-04). Tests: the redact-before-cap test passes under cap-first order (V6b-03); the first `Ctrl+G` cycle does not verify nothing was approved (V6b-04); the `Shift+Enter` test does not catch its mutation (V6b-08); the `Ctrl`/`Alt` test does not catch the guard and `Ctrl+digit` is untested (V6b-09); the "no second exit after exit" tests do not tell the two exits apart (V6b-11); the card `Enter` test does not verify the card took the `Enter` (V6b-12); the sheet host tests do not catch the typed rule (settle and dwell refuse first, V6a-09); real-time races at about 250 ms can false-fail under load (V6b-10). Unverified single findings (not probed): `returnedRefusalSummary` leaves a plan or headless refusal bare (B1-F4), test-only `as unknown as ToolDef` casts (B1-F6 to F8), display clocks and paste drop (C1-3, C1-4). **Owner: not assigned.** *(low · apps/cli)*
- [ ] **Documents (Report C, V4a and V4b).** ADR-0118 and ADR-0136 still repeat reference content (the canonical-home rule; ADR-0137's duplicates were replaced and its amendment ledger written, [ADR-0137](../decisions/0137-permissions-is-a-sheet-and-esc-steps-back-out-of-the-full-view.md)); ADR bodies carry the process log (ADR-0137 about 67 KB, ADR-0118 about 51 KB) which belongs in the register or the phase record; ADR-0136's "revision" reference is broken (V4a-10); the PR description says `Ctrl+C` stops everywhere (not during a keychain read) and "one high" (the phase record records two, steps 2 and 4), and its checklist is stale (V4b-04, V4b-05): the PR body is the maintainer's to edit. **Owner: maintainer decision** for the ADR split; the PR body is a human edit.

### Closed by the PR #101 fix increment, and what its own review round left open

The fixes of the parallel agents landed on `development` after the documents were first written; each entry below was `[ ]` and is now closed with its commit. The increment then had its own independent round (a security sitting on Opus, a correctness and test review on Sonnet; no blocker or high finding): its medium and its lows are in the next list.

- [x] **B6: the *Remember* cancellation guards had no tests.** *Closed 2026-11-21 (`7a1f8cfa`): four tests (an answer after the abort writes no grant; a write that aborts the signal keeps the grant, says so once and cancels; a cancelled failed write announces nothing; the normal path), each guard proved by a mutation.* *(high · apps/cli/src/chat/chat-mode-commands.test.ts)*
- [x] **H1: the keychain fake ignored a failing `delete` (B·H1).** *Closed 2026-11-21 (`52dfff9c`): both fakes throw when locked; the tests assert the file is removed, the key stays and no keychain error is printed.* *(high · apps/cli/src/permissions, apps/cli/src/commands/permissions.test.ts)*
- [x] **H12: the absolute-backstop test (B·H12).** *Closed 2026-11-21 (`38ce5ff1`): measured at 5.4 s, not 50 s; 87% of it was V8 capturing a stack trace for every brand probe in `packages/llm/src/inert-data.ts` (a quadratic cost per round); the test runs the turn with `Error.stackTraceLimit = 0` and takes about 0.9 s. The cost in `inert-data.ts` itself is the open entry below.* *(packages/core/src/engine/agent-turn.test.ts)*
- [x] **U1, U2 and T1 (Report C).** *Closed 2026-11-21: U1 (`ecd9aae5`) the Review tab wraps each answer whole or says how many characters it hides; U2 (`d971dfc3`) an arrow key while a withdrawal is armed is not typing (the arrow still moves nothing: the question is dropped, as ADR-0137 documents); T1 (`64787e66`) the grapheme tests use an `Intl.Segmenter` oracle and a generator that no longer falls back to `xxxxxxxx`. V6a-11 (a `d` refused on a too-small terminal counts as typing) was refuted: ADR-0137 round 3 F3 pinned it.* *(apps/cli/src/render/tui)*

**Open after the increment's own review round** (a security sitting, a correctness review; every item below was probed by its reviewer):

- [ ] **The card does not mirror the engine's mask-every-argument fallback for quote-heavy split secrets.** `scrubbedCommandLine` (core) masks every argument after the program when a joined-line mask touches an argument the element-wise scrub left alone; the card masks only the spans of the joined line itself. Probe: `["psql","PGPASSWORD","=''S3cr3tValue9Zq'"]` shows `psql [redacted]` in the event and the argument row, the full view and the masked copy `c` show the value; a fuzz of 19,220 quote-heavy split-argument argvs leaked in 532 (all in this class). Realistic splits (`Authorization:` then `Bearer …`, `X-Api-Key:` then the value, `password=` then the value, `{"password":` then `"v"}`) are masked. A multi-word secret that follows a separate label argument (`["tool","token:","a b SECRET"]`) shows in its row too (128 of 7,243 in the second fuzz). Fix: export "the fallback applied" from core and mask every non-program argument and the title in the card when it did. **Owner: not assigned.** *(low · apps/cli/src/render/tui/tool-review-projection.ts, packages/core/src/tools/registry.ts)*
- [ ] **`titleHidesArguments`' `shown.includes(secret)` clause is pinned by no test** (it survived 1,498 tests; without it the fuzz's title leaks rise from 32 to 306). A test over the quote-heavy corpus that asserts the title never shows what an argument row masks. *(low · apps/cli/src/render/tui/command-card-masking.test.ts)*
- [ ] **A clock set ahead keeps a grant fresh past a later write, and a renewal in the same millisecond as the mark stays stale** ([ADR-0138](../decisions/0138-a-file-write-is-remembered-for-the-project-and-outdates-older-grants.md)). The mark never moves backwards and a renewal needs a strictly later time; the fix is `max(previous, now, the root's latest grant time + 1 ms)` for a mark and `mark + 1 ms` for a renewal. *(low · apps/cli/src/permissions)*
- [ ] **A write is recorded against the chat's own root only** (ADR-0138 §6): a chat rooted at a parent directory that edits a nested project's file does not outdate that project's grants, and a file written by an MCP tool (an egress-class action, approved with no card in `auto`) is never marked. Fix: mark every ancestor root that has a grant; mark an approved MCP write. *(low · apps/cli/src/chat/chat-mode.ts)*
- [ ] **The `/permissions` sheet shows no stale state, and the Home's port has no `standing`.** A remembered row reads the same whether `auto` will run it or ask; the card says why when it asks. The note for a withdrawn session approval was hedged (`auto may run it unasked`). *(low · apps/cli/src/permissions/chat-permissions.ts, apps/cli/src/render/tui/permissions-sheet.ts)*
- [ ] **Each approved file write reads the OS keychain** (ADR-0138: the key is read afresh so a chat that cached a replaced key signs with the current one). It is synchronous and small; a long `auto` turn pays it per write. Cache with a short lifetime if it shows. *(low · apps/cli/src/permissions/command-grants.ts)*
- [ ] **A turn's per-round cost is quadratic in `packages/llm/src/inert-data.ts`**: every provider call deep-copies the whole request and its brand probes throw a `TypeError` per object per call, each paying V8's stack-trace capture (87% of the backstop test's time). Caching inspected objects or probing without throwing would speed every long turn. It is security-sensitive code. **Owner: not assigned.** *(low · packages/llm/src/inert-data.ts)*
- [ ] **`tool --password <value>` is masked by neither scrubber** (a bare value after a flag has no secret shape). Pinned by a named test as recorded, not promised: a detector that learns the shape turns that test into a masked case. *(low · packages/core/src/tools/bounding.ts)*
- [ ] **The `!` chip in the live attachment bar shows the raw line** (the person's own typing, local only); the transcript's stored note and the frame are scrubbed. *(low · apps/cli/src/render/tui/attachments.ts)*
- [ ] **An arrow key while a withdrawal is armed only drops the question** (ADR-0137's pinned behaviour). Disarming and moving would be friendlier; it changes a pinned test and the documented behaviour, so it is a maintainer decision. *(low · apps/cli/src/render/tui/permissions-sheet.ts)*

### SonarCloud gate on PR #101 (2026-11-21)

The pull-request gate was red on one condition: `new_reliability_rating` C, from the one bug among 63 open findings (S7727: `answerRows` in `question-card.ts` passed a two-parameter function straight to `.map`, which would hand it the array as a third argument). The other four conditions passed (security A, maintainability A, duplication 1.5%, hotspots 100%). The bug is fixed with 15 more findings that were real and cheap. The remaining 47 are code smells that no gate condition counts.

- [x] **Fixed 2026-11-21 (16 findings).** The bug; three super-linear regexes in `programName`/`codeCarrier` (S8786: the three suffix rules backtracked quadratically on a long near-miss name from a model-written argv, 20,000 characters 0.6 s and 100,000 about 54 s, now a linear loop, pinned by a bound test that fails on the regex form); four tests with no `expect` of their own (S2699: they ended on a polling wait that throws on timeout, which is a real assertion Sonar cannot see; each now ends on a plain `expect`); three generic matchers (S5906), `[0-9]` to `\d` (S6353), three duplicate imports (S3863) and one `??` (S6606).
- [~] **Four S1940 ("use the opposite operator") are deliberate and must not be "fixed".** *(Marked false positive on `main` on 2026-11-22; the pull-request status is per branch.)* `!(renewed > latest)` in `command-grants.ts` and `!(toolTurn < allowedRounds)` / `!(interval >= 1)` in `agent-turn.ts` fail closed when an operand is `NaN`; the opposite operator would be false for `NaN` and fail open. Each carries its comment. They stay open on the pull request; a maintainer may mark them false positive in SonarCloud (a status is per branch, see the note on `main`'s gate). *(low · apps/cli/src/permissions/command-grants.ts, packages/core/src/engine/agent-turn.ts)*
- [x] **38 smells refactored on 2026-11-22 (`c27a350c`), counted on `main` against the lines the PR added (the pull request's own 43 count differs by a few sites, and two more went away with them).** 28 nested ternaries (S3358), seven cognitive-complexity findings (S3776), two index keys (S6479) and the optional-chain suggestion (S6582) became named helpers with no change of behaviour, behind a differential harness, a mutation sweep, four reviews (one of them a security sitting) and permanent tests for every helper the adequacy review found unpinned; see the [Sonar cleanup before MVP-8](phases/phase-2.6-conversational-authoring.md#sonar-cleanup-before-mvp-8-2026-11-22).
- [ ] **What is still open from that list, and what the cleanup's review found.** One 8-parameter function (S107, `reduceToolReviewKey`), the complexity of `ToolReviewHost` (`tool-review-view.tsx`), `session-view-model.ts` and `chat-projection.ts`, `modeDecision` (S3776) and the sequential `await` in `agent-turn.ts` (S9382, on purpose). Plus three lows: the guards in `hiddenSpan` (`bounding.ts`; the review found no input that reaches them, so they are defensive or dead, and pinning or removing them needs a unit test with a whitespace-only run); several pins of the card (the `fullChrome` call-site arguments, the unavailable-review order, the title indentation) live only in the two slow host files (`tool-review-host`, `command-card-host`, about 130 s and 60 s), so the fast review tests would not catch a regression there; and the SonarCloud re-analysis of the 38 cannot be read until `main` or a pull request is next analysed. *(low · apps/cli/src/render/tui, apps/cli/src/chat, packages/core/src/tools/bounding.ts)*

## MVP-8 step 1 review (2026-11-22) — the lows left open on purpose

Four review rounds and an opus security sitting covered the step; the findings are recorded in the phase record's [MVP-8 step 1 implementation record](phases/phase-2.6-conversational-authoring.md#mvp-8-step-1-implementation-record-2026-11-22). The entries below are the lows that were not fixed, each with its trigger or owner. *Owner: MVP-8 step 3 or 4* means the step that builds the surface the entry concerns.

- [x] **Unpin by row, for a ref that is not valid UTF-8.** A crafted `run_pins` row whose ref is invalid UTF-8 is listed as replacement characters, so its listed ref matches nothing and the row holds a cap slot. Needs same-user write access to `history.db`. *Trigger:* a report of a full pin list, or the step-4 browser's pin key ([ADR-0140](../decisions/0140-management-browsers-the-run-drill-down-and-the-durable-run-detail.md) §5) is built, whichever comes first; the fix is to return the row's `rowid` from `listPins` and delete by it. *(low · packages/db/src/run-pins.ts; security sitting 2026-11-22)*
  **Closed 2026-11-23 (MVP-8 step 4, increments 4a, 6 and 7; commits `6d8eb96b` and `015683cd`):** `listPins` returns each pin's `rowid` and an `oversized` mark, `unpinByRow` removes exactly that row, and the browsers' `p` uses it for any pin whose key cannot be spelled back: a pin whose workflow left the catalog and a pin whose run is gone are removed by their row, and the run detail's `p` toggles the run under its full id by the same path as a History row. Pinned by `packages/db/src/run-pins-rowid.test.ts`, "is listed as replacement characters, matches no key, and is removed by its row" and "frees the slot it held at the cap, so a fifty-first pin that was refused goes in once the row is removed"; `apps/cli/src/render/tui/tab-host-pin.test.ts`, "removes a pin whose workflow left the catalog by its row" and "removes a pin whose run is gone by its row"; and `apps/cli/src/render/tui/tab-host-node.test.ts`, "pins under the run`s canonical key, shows the mark in the header, and unpins with the next p" (the detail's `p`).
- [ ] **Gate-notice command rows wider than 80 columns with UUID ids.** Each `approve:` and `reject:` row is about 117 columns with real ids and wraps once; `relavium status` prints the same rows. *Owner: none yet.* [MVP-11](phases/mvp-11.md) (the successor of the "common-language increment") takes the display helpers, not the command rows of `logs.ts`, and a row that is a command to copy must keep its full id, so this needs its own decision. *Trigger:* the maintainer asks for it, or a later output-format increment. *(low · apps/cli/src/commands/logs.ts)*
- [x] **The absence vocabulary and the run's held terminal in the run detail.** The run detail decides "finished" from the run row's status only, so a run whose terminal is held in the outbox reads `in progress`; and the absence texts (`did not run`, `did not finish`, `in progress`, `not recorded (older log)`, `not recorded for this attempt`, `refused`, `failed after N ms`, `ok in N ms`) appear in no reference yet. *Owner: MVP-8 step 4 (the node page), which draws them; state the vocabulary in the reference when it lands.* *(low · apps/cli/src/history/run-detail-model.ts; docs/reference/cli/)*
  **Closed 2026-11-23 (MVP-8 step 4, increments 6 and 7).** *The held terminal:* the run detail reads the terminal outbox first and builds a run whose end is held as finished (`readRunDetail`, commit `015683cd`), so the page says `held` and no figure says `in progress`; pinned by `apps/cli/src/history/run-detail-source.test.ts`, "says in progress for a run that is running, and never for the same run once its end is held", and `apps/cli/src/render/tui/tab-host-history.test.ts`, "a run whose end is held says `held` and never `in progress`". *The vocabulary:* the Home reference's [Words for what is absent](../reference/cli/home.md#words-for-what-is-absent) lists every sentence (thirteen) and the four tool outcome words (`ok`, `ok in <duration>`, `refused`, `failed after <duration>`); `apps/cli/src/render/absence.ts` is the one module that spells them, and the run detail's model and the node page import them and write none of their own. `apps/cli/src/render/absence.test.ts`, "lists exactly the sentences of the module: none missing from the reference, none only in the reference" (and the same for the outcome words), compares the module with the reference read from disk in both directions, and `apps/cli/src/render/tui/tab-host-node.test.ts`, "has a page for every sentence the reference lists, and lists every sentence a page can say" and "draws `<sentence>` exactly as the reference spells it" (one case for each sentence), draw each of them on a real node page. The step added four sentences (`not yet run`, `no output`, `(empty)`, `unavailable`), named `skipped` and `no tool calls`, and changed one: a node of the frozen workflow that has no record in a run that has not ended says `not yet run`, where the model said `in progress` for a pending row.
- [ ] **The node page inspects one attempt: the last, or with `n` the first that failed.** A node that failed on three attempts shows the first and the last, and no key walks the second; the attempt rows list every attempt with its status, duration, tokens and cost, but only the inspected attempt has its error, output and trace on the page. *Trigger:* a report, or a retry-from-a-node action (Phase 3), which needs an attempt picker anyway; the fix is `[` and `]` to step through `attemptNumbers`, which the page's read already carries. *(low · apps/cli/src/render/tui/tab-host-node.ts, `foldFirstFailed`)*
- [ ] **A re-dispatched node's first-dispatch tool trace is not carried.** A budget-approved redispatch discards the first dispatch's calls from the terminal's `toolActivity`, while the attempt's cost still sums both dispatches. The reference says the trace is that of the attempt that produced the terminal, which does not say this. *Owner: MVP-8 step 1 reference note (written with the step's closing record), or carry the calls if a person needs them.* *(low · packages/core/src/engine/engine.ts)*
- [~] **Length gates on the text columns the summary reads select without one.** *Half closed 2026-11-23 (MVP-8 step 4, increment 4a): `run_pins.ref` and `project_root` are gated in `listPins` (an over-long value comes back as a 64-code-point preview with `oversized` set, and the pin is removed by its row), pinned by `packages/db/src/run-pins-rowid.test.ts`, "the length gates".* What is still open: `runs.project_root`, `workflow_id` and `id` (in `listRunSummaries`) have no SQL length gate, so a crafted oversized value is read into JavaScript whole; the display is still bounded. Needs same-user write access to `history.db`. *Trigger:* a report, or the next change to `listRunSummaries`; the fix is the same `length(CAST(col AS BLOB))` gate the documents use. *(low · packages/db/src/run-history-store.ts; security sitting round 5, 2026-11-22)*
- [ ] **A recovering surface would show a prepare-phase refusal as measured.** `dispatchRanAndThrew` treats every `execution_failed` as a tool that ran, but the registry also raises it for a recoverable refusal before dispatch. Unreachable today: only workflow nodes supply the clock, and they never recover tool failures. *Trigger:* a surface that both recovers tool failures and supplies the elapsed clock (the session path in step 4 or later). *(low · packages/core/src/engine/agent-turn.ts)*
- [ ] **A tie rule in the last-attempt picker is dead code.** `lastAttemptRow`'s `>=` against `>` cannot be reached with a tie, because both callers pass collapsed rows; the mutant is equivalent. Remove the branch when the picker is next touched. *(low · apps/cli/src/history/run-detail-model.ts)*


## MVP-8 step 2 review (2026-11-22) — the lows left open on purpose

Three review rounds and an opus security sitting covered the step; the findings are recorded in the phase record's step-2 implementation record. The entries below are the lows that were not fixed, each with its trigger.

- [ ] **A guarded write is checked against the last ASKED sequence during the re-take window.** After a stale-card re-take, a store fault on one write followed by a second guarded write whose expected value equals a head another writer has already produced could land. It needs a writer without a fence or an async store; the fence check normally refuses it. *Trigger:* any unfenced writer, or the first non-synchronous store. *(low · packages/core/src/engine/engine.ts:5468, `headGuard` in `#emitDurable`)*
- [ ] **A write that commits but returns an error moves the durable head away from the park head.** A lost acknowledgement makes the next conflict report a head other than `#reclaimedHead`, so the run is classified as ownership loss (exit 6, no terminal) instead of a store fault (exit 5). Unreachable on synchronous `better-sqlite3`. *Trigger:* the first async or cloud store. *(low · packages/core/src/engine/engine.ts:5493, `movedSincePark`)*
- [ ] **The retained-head branch of `??=` in `#reclaim` has no test, and its reachability is unproven.** *Trigger:* any change to the park or re-take path. *(low · packages/core/src/engine/engine.ts:4407)*
- [x] **The blank-secret refusal lives in the CLI shell, not in `resolveSecretInputs`.** The run core checks only a missing and an unexpected name; a blank value is refused by `parseSecretLines`, so a host port that does not use it would pass `''` through as "re-supplied". A Home port must refuse a blank value itself. *Trigger:* the Home run host (MVP-8 step 3). *(low, step 3 obligation · apps/cli/src/run-core/resume-run.ts:625; apps/cli/src/secrets/parse-secret-lines.ts:8)*
  **Closed 2026-11-23 (MVP-8 step 3, increment 3, commit `ed9c33a2`):** the Home's port refuses a blank value itself (`refuseBlankSecrets` in `apps/cli/src/home/run-host.ts`, fixed text, on a start and on a resume); pinned by `apps/cli/src/home/run-host.test.ts`, "(d) is refused by the wrapper when its value is blank", and, for a resume that leaves the gate pending, `apps/cli/src/home/run-host-resume.test.ts`, "refuses a blank value at the port, and leaves the gate pending for another answer".
- [ ] **A stale card's media URL is fetched before the refusal.** An in-process gate resume pins media in the decision payload after the re-take and before the first acknowledged write, so a stale card's media is fetched and then the write is refused. No credential is involved and media garbage collection removes the orphans. *Trigger:* a media-bearing stale card in a Home run (re-triggered 2026-11-23: step 3 built the Home's gate and budget cards and its review did not dispose this entry, so it waits for the first case that can show it). *(low · packages/core/src/engine/engine.ts:2031, `#pinMediaValue` in `#resume`)*
- [ ] **A successor that parks legitimately can be refused its re-take while a stale card holds the vacant lease.** Its gate deadline or Ctrl-C then exits 6 without recording the timeout. The window is one transaction. *Trigger:* the first Home-run stale card reproduced by a test in step 4 or later (re-triggered 2026-11-23: step 3 built the Home's gate cards and its review did not dispose this entry, so it waits for a test that can show the window). *(low, availability · packages/core/src/engine/engine.ts:4396 `#reclaim`, and the terminal re-take at :4506)*
- [ ] **No stale-card test covers the budget-gate path, or a gate deadline or the run timeout firing at a stale park.** By reading, both take the same `#emitDurable` path as the covered cases. *Trigger:* the next change to the budget gate or the deadline path. *(low, test gap · packages/core/src/engine/stale-gate-card.e2e.test.ts:269; apps/cli/src/engine/stale-gate-card.native.test.ts:470)*
- [ ] **A non-terminal write refused as ownership loss is still delivered to `handle.subscribe` observers after the stream closes.** No CLI subscriber exists today. *Trigger:* the first run-handle subscriber in `apps/cli/src/home` or `apps/cli/src/run-core`. *(low, first CLI subscriber · packages/core/src/engine/engine.ts:5448 and :5553, `#deliverDurableAsk`)*
- [ ] **The conflict check relies on `instanceof`.** Two copies of `@relavium/shared` would make `isAppendConflictError` false, so a stale card would fall back to the store-fault path; `isLeaseFencedError` has the same pattern. *Trigger:* a bundling change that duplicates `@relavium/shared`. *(low · packages/shared/src/run.ts:224 and :259; used at packages/core/src/engine/engine.ts:5495 and :5497)*
- [x] **A resumed hosted leg must not skip the per-machine consent check ([ADR-0084](../decisions/0084-consent-before-a-local-mcp-spawn.md)) on the ground that the run was started with `--allow-mcp-stdio`.** The flag is a per-invocation digest list, not a recorded decision. *Trigger:* the step 3 port review. *(low, step 3 obligation · apps/cli/src/engine/mcp-consent-gate.ts:106 and :159)*
  **Closed 2026-11-23 (MVP-8 step 3, increment 7a, commit `de5faea6`):** a hosted resume builds the same consent gate a start does (`#consentGate` in `apps/cli/src/home/run-host.ts`), so a server this machine holds no grant for is asked about through the Home's consent card and one it approved starts without a question; pinned by `apps/cli/src/home/run-host-resume.test.ts`, the "(b) a resumed leg runs the consent check again" group (asks through the card, asks nothing for an approved server, refuses with the gate still pending when the card says no).
- [x] **The head recorded at a park is the last sequence ASKED, not the last acknowledged: settled, and the path does not exist.** A failed non-terminal write fails the run at once: `#writeDurable` sets `#failure`, and `#step` settles `run:failed` before `#handleIdle` could pause, with no reset of `#failure` anywhere. So no park follows a failed ask. The guarded ask moves `#lastAskedSequenceNumber` (`engine.ts:5456`), so any later ask conflicts with the durable head instead of parking. In-flight writes settle before a park (`#parkAfterReceipts` and `#depart` join the host work first). Settled by code reading on 2026-11-22; no test was needed because the sequence cannot occur. *Re-open trigger:* a non-fatal non-terminal write failure, or any path that clears `#failure`. *(low · packages/core/src/engine/engine.ts:5456, 5510–5530, 2381–2387)*
- [x] **The unreachable `RunResources` guard throw in a `finally` would skip `closeHistoryDb`.** `releaseMcp` throws on a reused object before the database close runs. Not reachable in production; a step 3 host must create one `RunResources` per run. *Trigger:* the step 3 host. *(low · apps/cli/src/run-core/run-resources.ts:91; apps/cli/src/commands/gate.ts:301 and apps/cli/src/commands/run.ts:260)*
  **Closed 2026-11-23 (MVP-8 step 3, increment 3, commit `ed9c33a2`):** the Home host creates one `RunResources` for each leg (`#hostLeg` in `apps/cli/src/home/run-host.ts` calls `#createResources` once per leg, and a leg's tail releases it once), so the guard is never reached; `apps/cli/src/home/run-host.test.ts` runs a pause and the resume that answers it on one host (a reused object would throw its typed single-use error), and its "(f) tears down in the ADR order" case runs the real `releaseMcp` through the leg's own object. The guard itself stays, as the single-use backstop.
- [ ] **No test uses separately spawned OS processes.** The native proof runs both terminals in one process on separate SQLite connections. *Trigger:* a cross-process CI test. *(low, test gap · apps/cli/src/engine/stale-gate-card.native.test.ts)*
  *Update 2026-11-24 (PR #102 review, `26025249`):* two interleaved, barrier-held tests of the same window now exist on the in-memory reference store (`packages/core/src/engine/stale-gate-card.e2e.test.ts`, "two engines deciding the SAME gate at once, interleaved"), and they closed the cross-process TOCTOU entry. They prove the lease and the compare-and-append in both orders. What stays open here is what no in-process test shows: signals, timers and the operating system's own scheduling across real processes, and an interleaving on the SQLite store.

## MVP-8 step 3 review (2026-11-23) — the lows left open on purpose

The first review round of the step found these lows, which were not fixed; the fixes of the round are in the phase record's step-3 implementation record, which is written after the step's gate (the closing record of step 3 does not exist yet, and this line stays as it is until it does). Each has a location and its trigger. *Owner: MVP-8 step 4 or 5* means the step that builds the surface the entry concerns.

- [ ] **`RunCard.update()` has no production caller.** The card holds the gates it read when it opened and never re-reads them (a re-read after an answer would offer the gate twice), so the method that folds a re-read into an open card is exercised only by tests. *Trigger:* a surface that re-reads an open card (the Active tab, step 4), or the next change to the card model; until then it is dead code and may be removed. *(low · apps/cli/src/render/tui/run-card-model.ts, `update`)*
- [ ] **The run view reads `not held` for a moment after an answer.** Between the answer and the resumed leg naming its run, `locate` reports a leg still preparing as another run's once this run has ended here, so a view left open on a run just answered flashes `○ not held` before `▶ running`. Cosmetic; the next poll corrects it. *Trigger:* a report, or the run drill-down of step 4, which rewrites `locate`. *(low · apps/cli/src/render/tui/run-screen.ts, `locate`)*
- [ ] **A card dismissed while its answer is in flight loses the host's reply.** `Esc` or `Ctrl+C` disposes the card, and `send` drops the reply (`if (disposed) return`), so a refusal (`busy`, a stale gate, a price that moved) is never shown; the answer itself is safe (the host decides it). *Trigger:* a report of an answer whose refusal was not seen; the fix is to surface the reply as the landing's notice when the card was already gone. *(low · apps/cli/src/render/tui/run-card-model.ts, `send`)*
- [ ] **The exit guard vanishes silently when the first chat finishes building.** A chat that arrives while the card only asks takes the screen and closes the card (`exitGuard: undefined`), with no word that the exit was dropped. The run is untouched. *Trigger:* a report, or the chat status line of step 5. *(low · apps/cli/src/render/tui/home-controller.ts, the build-success arm of `submit`)*
- [ ] **Live node rows are glyph-only for pending, running and skipped.** The run view mounts the `RunApp` projection, whose rows for those three states draw a glyph and no word, so with colour off the difference is the glyph alone (ADR-0122 §7.2 asks for a glyph and a word). Pre-existing in `relavium run`. *Trigger:* [MVP-11](phases/mvp-11.md) Step 3b (every status table imports the one glyph table, and [that table](phases/mvp-11.md#410-the-visual-language) puts a word beside every glyph), or an accessibility report. Check at that step that the run view's rows for pending, running and skipped show the word; if the step does not reach `format.ts`, this stays open. *(low · apps/cli/src/render/tui/format.ts)*
- [ ] **The Attention rows have no `+N more` cue.** At most eight parked runs are read, and the rows that fit the terminal are drawn with the window following the focus; a project that parks more shows no count of the rest. *Trigger:* a project that parks more than the rows that fit, or the Active tab of step 4, which lists them all. *(low · apps/cli/src/render/tui/home-view.tsx, `parkedRows`; home-attention.ts `PARKED_RUNS_MAX`)*
- [ ] **A running leg has no indicator in chat mode.** The `▶` row and the `Enter shows it` hint are drawn on the landing only; a person inside an in-Home chat while a run executes sees nothing of it until the chat ends. The exit guard still protects the run. *Owner: MVP-8 step 5 (the chat's status line), or a report.* *(low · apps/cli/src/render/tui/home-app.tsx, the chat frame)*
- [ ] **The owner registration in the `HostedRunLifetime` constructor would leak if `notices.clear`, `#legIo` or `#createResources` threw first.** `#hostLeg` registers the leg's owner, then clears the notices, builds the leg's io and its resources; a throw in any of those leaves an owner registered that nothing retires. Practically unreachable: the first two cannot throw, and the third is a test seam. *Trigger:* any change that lets one of them throw, or a `createResources` that can fail. The fix is a `try` around the three that calls `cleanupFailed` and `finish`. *(low · apps/cli/src/home/run-host.ts, `#hostLeg`)*
- [ ] **A failed MCP close after a leg ends the whole Home within three seconds.** `reportMcpCloseFailure` makes the leg's cleanup unacknowledged, `cleanupFailed` arms the invocation's finite-exit bound, and a long-lived Home ends with it. That is ADR-0139 §6's choice (a cleanup that cannot be acknowledged is infrastructure uncertainty), and it is heavy for a process that lives for hours. *Trigger:* a report of a Home ended by an MCP close fault, which would be an ADR amendment, not a fix here. *(low, ADR choice · apps/cli/src/home/hosted-run-lifetime.ts, `cleanupFailed`)*
- [ ] **A budget rejection of a run with masked slots still asks for the secrets.** A resume reads the masked slots of the run's record and asks for each before it knows the decision is a rejection, which the shell's `relavium budget resume` does too (shell parity). *Trigger:* a report, or the next change to the resume port; the fix is to skip the secret port for a decision that needs none. *(low · apps/cli/src/home/run-host.ts, `#acquireResume`, and apps/cli/src/render/tui/run-card-model.ts, `createGateResumer`)*
- [ ] **A paste below 80×24 is not counted as typing on the gate card.** Below the minimum the card is the enlarge line and no key reaches it; a key is told to the card as unseen input (so a chord soon after it is refused), but a bracketed paste returns in `usePaste` before it reaches the controller. The painted-frame check (no frame is painted below the minimum) still refuses the chord. *Trigger:* a report, or the next change to the paste route; the fix is the same `card.unseenInput()` the key route calls. *(low · apps/cli/src/render/tui/home-app.tsx, `usePaste`)*
- [ ] **A held `Ctrl+C` in the run view arms the run's cancel and then cancels it on auto-repeat.** The ladder asks for two presses inside two seconds and nothing else: there is no minimum gap between them, so a key held down through the first press delivers the second a repeat later and the run is cancelled (cooperatively, by design, and a cancelled run cannot be resumed). The approval and exit-guard chords have quiet-gap and lockout layers for exactly this; the interrupt keymap has none. *Trigger:* a report of a run cancelled by a held key, or the next change to the interrupt keymap; the fix is a minimum gap (the quiet gap of the chord guard) before the second press counts. *(low, review nit · apps/cli/src/render/tui/interrupt-keymap.ts, `pressRunViewInterrupt`; apps/cli/src/render/tui/home-controller.ts, `handleScreenInterrupt`)*
- [ ] **A budget abort on a card with several gates is unguarded by design, so a double-tapped `Ctrl+N` can abort the next budget gate at once.** The abort is never delayed (refusing is the safe answer), and answering one gate moves the cursor to the next, so a second `Ctrl+N` of a double tap lands on the next budget gate's abort. Each abort stops one step at its budget and nothing else. *Trigger:* a report, or the next change to the card's guard; the fix is to restart the lockout after an abort that leaves another gate under the cursor, or to let the abort keep its dwell only when one is. *(low, review nit · apps/cli/src/render/tui/run-card-model.ts, the budget-abort branch of the answer guard; pinned by apps/cli/src/render/tui/run-card-keys.test.ts)*
- [ ] **The exit guard's `stay` does not stamp the shared chord history.** `Esc`, `Ctrl+C` and `Ctrl+N` close the card through `set({ exitGuard: undefined })` without telling the Home's one history that a card was resolved by a key, so a key held on after a `Ctrl+N` that stayed reaches the next card with no lockout. The confirm path stamps it (`decide`). *Trigger:* a report, or the next change to the exit guard; the fix is the guard's `resolved(stamp)` call on a stay. *(low, review nit · apps/cli/src/render/tui/home-controller.ts, `routeExitGuardKey`)*
- [ ] **A sibling-close rejection skips the owned path's terminal restoration.** The owned path's closing block awaits its cleanups under `Promise.allSettled`, then reports the first failure with `await Promise.all(closing)`, which throws out of the `finally` before the control writes that restore the terminal (`DISABLE_BRACKETED_PASTE`, `DISABLE_MOUSE`, `SHOW_CURSOR`) and before the post-exit line, so one failed sibling close leaves the terminal modes for the process's exit to undo. Pre-existing in the closing block, not made worse by step 3. *Trigger:* a second owned-path cleanup failure reproduced, or the next change to `drive-home.tsx`'s closing block. *(low · apps/cli/src/home/drive-home.tsx, the `Promise.allSettled(closing)` block)*
- [ ] **The workflow file is read three times, so a file changed between `Yes` and the start runs the changed file.** The catalog reads it for its label, the pick reads it (`catalog.load`) to show the file, and `prepareRun` reads it again to start, so a file edited after the person said `Yes` is the one that runs. Outside the cooperating-storage threat model (the workspace is the person's own). *Trigger:* a shared or untrusted workspace is supported; the fix is to hand the parsed definition (or its digest) from the pick to `prepareRun` and refuse a start whose file no longer matches. *(low · apps/cli/src/home/run-launch.ts, `catalog.load`; apps/cli/src/home/run-host.ts and apps/cli/src/run-core/prepare-run.ts, `prepareRun`)*
- [ ] **A note published while a chord card is open was drawn at column 0 without the gutter.** `note` and `committedNote` published into the open card's snapshot, and the card draws a note above its body, outside the gutter that marks the card's own rows. No caller does it today (opening a chord card clears the note, and none publishes one while the card is up). *Trigger:* any caller that publishes a note during a chord card; the channel now holds such a note until the card settles and shows it on the next frame (hardened in code with the round-4 fixes, pinned by `apps/cli/src/render/tui/chord-card-host.test.tsx`), so this entry closes when that test is on `main`. *(low, hardening · apps/cli/src/render/tui/native-prompt-channel.ts, `note` and `committedNote`)*

## MVP-8 step 4 review (2026-11-23) — round 1: closed by the fixes, and what is left open

The first review round of the step was verified finding by finding (a third of the first-pass severities moved), and its fixes landed as one increment on `development`. Each closed entry names the test that pins it; each was proved by a mutation (the guard removed, the test failing). What the fixes did not do is below, each with a location and its trigger.

### Closed

- [x] **C1: a History page re-read after its eviction could leave a stale next page.** *Closed 2026-11-23:* `recordNext` drops every kept page past a page whose cursor changed or ended. Pinned by `apps/cli/src/history/history-source.test.ts`, "drops the pages past a page whose boundary moved, so a page 0 re-read after its eviction never leaves a stale next page". *(medium · apps/cli/src/history/history-source.ts)*
- [x] **C2: the Active poll re-read every paused run's log and re-parsed the outbox at each tick.** *Closed 2026-11-23:* the gate count is kept per run under a key of the run's row (status and `updated_at`) and read again after one lease TTL; the outbox's held ids are kept under the file's size and mtime stamp; the token carries the hosted run's id; a read does not touch a database closed while the outbox was awaited; a cost read that throws no longer ends a key. Pinned by `apps/cli/src/history/active-source.test.ts`, "a paused run's gate count is kept per run, so a tick does not read every log again" (six tests) and "the asynchronous read" ("parses the outbox again only when its stamp moved, and a held set that changed is picked up", "does not read the database when it closed while the outbox was being read"), `apps/cli/src/history/change-probe.test.ts`, "the hosted run", `apps/cli/src/engine/terminal-outbox.test.ts` ("stamps the file by its size…") and `apps/cli/src/render/tui/tab-host-history.test.ts`, "never throws out of a key for a cost that cannot be read for a reason that is not the run's". *Two events in one millisecond leave a run's row as it was, so a kept count can be one gate behind until the next event or one lease TTL; the card itself reads the log afresh.* *(medium · apps/cli/src/history/active-source.ts, active-poll.ts, change-probe.ts)*
- [x] **C3: the pin cap counted every pin in the store while the Defined tab listed only this project's.** *Closed 2026-11-23:* a workflow pin of another project is a row marked `? other project`, removable by `p` (by its row), and a pin refused at the cap names the stored total and how many are in other projects or are runs. Pinned by `apps/cli/src/render/tui/tab-host-pin.test.ts`, "at the cap names what the store holds, lists the pins of other projects as rows, and p on such a row removes it so the pin then fits", `apps/cli/src/history/defined-model.test.ts`, "a pin of another project", and `apps/cli/src/home/defined-port.test.ts`, "lists the workflow pins of other projects as rows, and says what the store holds in all". The cap itself stays global at fifty (the maintainer's decision). *(medium-low · apps/cli/src/render/tui/tab-host-workflows.ts, apps/cli/src/home/defined-port.ts)*
- [x] **C4: the tab's cost copy grew with every row scrolled over.** *Closed 2026-11-23:* the copy is bounded to the source's own 500 entries (round 2 made both drop the run asked for least recently, not the one read first). Pinned by `apps/cli/src/render/tui/tab-host-history.test.ts`, "keeps at most 500 costs, the oldest read going first, however many rows were scrolled over". *(low)*
- [x] **S1: an output node whose id names a credential showed its value on the node page and masked it on the run summary.** *Closed 2026-11-23:* the page is given the node id and masks a primitive value whole by the summary's own rule. Pinned by `apps/cli/src/history/node-detail-model.test.ts`, "masks the value of an output whose node id labels a credential, whole, as the final summary does for the output of that name", and `apps/cli/src/render/output-masking.test.ts`, "masks the value of an output whose NAME labels a credential on both surfaces". *(low)*
- [x] **S2: the authored model was only sanitized.** *Closed 2026-11-23:* it is scrubbed whole and then cut, as a stored model is. Pinned by `apps/cli/src/history/node-detail-model.test.ts`, "masks an authored model that is shaped like a key, as it masks a stored one". *(low)*
- [x] **S3: two valid files with one workflow id made `r` and `x` take the first silently.** *Closed 2026-11-23:* both refuse, naming both paths. Pinned by `apps/cli/src/home/run-launch.test.ts`, "two files that declare one workflow id", `apps/cli/src/commands/export.test.ts`, "rejects an id that two valid workflow files declare, naming both paths, and exports neither", and `apps/cli/src/render/tui/export-card.test.ts`, "refuses an id two workflow files declare, before the card asks, naming both files". *(low)*
- [x] **S4: the repository allowlist on the Permissions tab was escaped and not masked.** *Closed 2026-11-23.* Pinned by `apps/cli/src/render/tui/tab-host.test.ts`, "masks an entry that is shaped like a key, command and pattern alike". *(nit)*
- [x] **S5: no re-sanitize at draw time.** *Closed 2026-11-23:* every line the tab host draws passes `sanitizeInline` once more. Pinned by `apps/cli/src/render/tui/tab-host-view.test.tsx`, "TabHostView sanitizes at draw time". *(nit)*
- [x] **U1: the `masked · shortened` note sat on the heading's right and was dropped at 80 columns.** *Closed 2026-11-23:* the notes are a row of their own under the heading. Pinned by `apps/cli/src/render/tui/tab-host-node.test.ts`, "at 80 columns a masked and shortened output shows both words, on a row of its own under the heading". *(medium)*
- [x] **U2: a gate card's `Ctrl+C` or a run view's close left the "command is the tab host" flag set, so a later `Esc` left the Home.** *Closed 2026-11-23:* the flag is read before it is cleared and the command ends with its screen (round 3 made `closeScreen` do that; see the rounds 2 to 4 section). Pinned by `apps/cli/src/render/tui/home-tab-host.test.ts`, "the command is over once its screen is gone, however it went". *(medium)*
- [x] **U3 to U6: the reference and the runbook said what the code did not.** *Closed 2026-11-23:* the tab memory, the keys of the host, the hint below 80×24 (`Enlarge the terminal — Esc steps back, or closes at the list.`, `TAB_HOST_TOO_SMALL`), the Defined row's contents, the status line's place, the permissions screen's wording, the detail header (the workflow's name is cut first), the legends of a detail that is loading, missing or unreadable (no scroll key) and the `Tab` item where it fits. Pinned by `apps/cli/src/render/tui/tab-host-history.test.ts`, "the run detail says what it could not read, and keeps what identifies the run", and `apps/cli/src/render/tui/tab-host.test.ts`. *(medium and low · docs/reference/cli/home.md, docs/runbooks/windows-interrupt-evidence.md rows 28 and 30)*
- [x] **T1: the run detail's three notices and the node page's partial-log notice were drawn by no test.** *Closed 2026-11-23.* Pinned by `apps/cli/src/render/tui/tab-host-history.test.ts` ("draws a notice for an outbox it could not read, for a log longer than the pages read, and for rows a newer version wrote") and `apps/cli/src/render/tui/tab-host-node.test.ts` ("draws the notice a log longer than the pages read leaves, and none for a log that was read whole"); `RUN_DETAIL_MAX_PAGES` (20) and `RUN_DETAIL_EVENT_PAGE` (1000) are pinned by `apps/cli/src/history/run-detail-source.test.ts`, "reads at most 20 pages of 1,000 events…". *(medium)*
- [x] **T2: a mutant of the held-terminal loader survived.** *Closed 2026-11-23.* Pinned by `apps/cli/src/history/run-detail-source.test.ts`, "reads the outbox first…" (an unfinished run the outbox does not name). *(medium)*
- [x] **T3: the batch bounds were tested through the exported constants.** *Closed 2026-11-23:* the literals 200 and 201 are asserted in `packages/db/src/run-history-store-batched.test.ts` and `packages/db/src/run-history-summaries-by-id.test.ts`, and `apps/cli/src/history/batched-state-events.test.ts`, "chunks at exactly the size the store accepts, 200", pins the CLI's chunk to the store's bound. *(medium)*
- [x] **T4: clock assertions, substring matches and two tests that read an operator home.** *Closed 2026-11-23:* the `performance.now` and `Date.now` comparisons are gone (the work counts carry the claim: round 2, 2026-11-23, replaced the four that survived in `node-detail-model.test.ts` and `run-detail-model.test.ts` with the scrubber's call and character counts and a counted string walk, as `output-masking.test.ts` does), the absence sentences are compared by whole figure (`figuresOf` in `tab-host-node.test.ts`), the vacuous `toBeDefined` is gone, and `export-bytes.test.ts` and `catalog-nodecount.test.ts` are handed a temporary home (`ExportCommandDeps.homeDir`). *(low)*
- [x] **T5: three sentences were spelled outside `absence.ts`.** *Closed 2026-11-23:* `no message recorded` and `no node was recorded` are in the module and the reference (fifteen sentences; `not recorded` is the existing `NOT_RECORDED`). Pinned by `apps/cli/src/render/absence.test.ts`, "has fifteen sentences…", and `apps/cli/src/render/tui/tab-host-node.test.ts`, "every absence sentence is the one the reference lists". *(medium)*

### Still open

- [ ] **ADR-0140 §2's "`Enter` on another process's run shows its node boundaries" is not built.** The Active tab's other rows are read-only and `Enter` only says why; a run of another process cannot be opened to its detail from the tab. *Owner: not assigned; needs a maintainer decision on whether step 4 closes without it.* *Trigger:* the node drill-down for a run another process owns is built (ADR-0140 §2). *(medium · apps/cli/src/render/tui/tab-host-active.ts, `foldActiveKey`)*
- [~] **The node page reads the run's events at every open instead of reusing the run detail's.** `readNodeDetail` pages the log again for each node opened (`pageRunEvents`, up to 20,000 events), where the detail already holds them. *Trigger:* a report of a slow node page on a long log, or the next change to `readNodeDetail`; the fix is to hand the detail's events to the loader. *(low · apps/cli/src/history/node-detail-source.ts, about line 139)*
- [~] **`loadDetail` has no cancellation.** A detail load that is slow (the outbox is a file) cannot be abandoned: leaving the detail drops the result, not the read. *Trigger:* a report of a slow or hung outbox read, or the next change to `openHistoryDetail`; the fix is an abort signal handed to `listHeld`. *(low · apps/cli/src/render/tui/home-controller.ts, `openHistoryDetail`, about line 1788)*
- [~] **`loadRunSnapshot` reads the whole frozen snapshot with no SQL size gate before the 1 MiB check.** The Home takes the snapshot through `loadRunSnapshot` (`frozenSnapshot` in `drive-home.tsx`), which selects the snapshot and `input_json` whole; `readSnapshotNodes` then refuses text over 1 MiB, after it is in memory. Needs same-user write access to `history.db`. *Trigger:* a report, or the next change to `loadRunSnapshot`; the fix is a reader that gates the document in SQL as `loadRunDetail` does and never selects `input_json`. *(low · packages/db/src/run-history-store.ts, `loadRunSnapshot`; apps/cli/src/home/drive-home.tsx, `frozenSnapshot`)*
- [~] **A pin removed by its row id can remove another pin if a second process wrote between the list and the key.** SQLite hands the number of a deleted last row to the next insert and `VACUUM` may renumber the table, so a row id is good for the listing it came from and no longer (documented on `PinRecord.rowid`, and now on `unpinRow`). The window is one list read to one key press, and only a pin whose key cannot be spelled has no other handle. *Trigger:* a report of a wrong pin removed, or a second writer to the pin table while a list is open; the fix is to remove by row id AND the listed key text in one statement. *(low · apps/cli/src/home/pin-port.ts, `unpinRow`; packages/db/src/run-pins.ts, `unpinByRow`)*
- [~] **`r` reads the workflow file twice, so a run can start from content other than what was confirmed.** The launch flow loads the file for the form and the confirmation (`catalog.load(choice.path)` in `pick`), and the host reads it again when the run starts (`host.start({ workflow: choice.path })`): a file changed between the two (a second process, a checkout, an editor's save) runs as the second content under a confirmation that named the first. The path is now compared with the row's own (round 2) and the file's id is checked at the pick (round 3), which close a different file; the same file's content is not. *PLAUSIBLE, and outside the cooperating-storage threat model: the writer needs access to the project's files.* *Trigger:* a shared or untrusted workspace is supported; the fix is to hand the host the parsed definition (or a digest it checks) instead of a path it reads again. *(low · apps/cli/src/home/run-launch.ts, `pick` and `start`; apps/cli/src/home/run-host.ts)*
- [~] **The batched state-event read holds the state events of every active run at once.** `batchedStateEvents` returns one map of every requested run's events, built chunk by chunk and kept whole until the caller is done (`batched-state-events.ts`, the loop at about lines 21 to 35), so the memory of a listing grows with the number of runs it covers, not with a chunk. Its callers are `relavium status` (every active run) and `relavium gate list` (every run it lists), neither of which caps the run count. *Trigger:* active-run counts in the hundreds, or a report of a listing's memory; the fix is to hand each chunk to the caller and drop it. *(low · apps/cli/src/history/batched-state-events.ts, `batchedStateEvents`; apps/cli/src/commands/status.ts, gate-list.ts)*
- [~] **The kept gate count can be one gate behind for up to a lease TTL.** Two events in one millisecond leave the run's row (`status`, `updated_at`) as it was, so the Active tab's count of a paused run is read again only at the next event or after one TTL; the gate card reads the log afresh when it opens. *Trigger:* a report of a count that disagrees with the card, or a summary read that carries the run's last event sequence (then the key is that sequence). *(low · apps/cli/src/history/active-source.ts, `gateKeyOf`)*

## MVP-8 step 4 review (2026-11-23) — rounds 2 to 4: closed by the fixes, and what is left open

Rounds 2 and 3 are fixed in `8909d502` and `c7c44874` (round 1 is `daf29b6b`); the step-4 implementation record, which the phase record will carry after the step's gate, will list what each round found. Round 4 ran four read-only reviewers at `c7c44874`: correctness, bounds and resources; UX, keys and documents; tests, isolation and this register; and an opus security sitting. It found no blocker, no high and no security finding. Its two mediums were a test gap (the node page's `N` was never pressed) and the launch refusals, whose paths were cut off at 80 columns; both and its lows are fixed in the commit that adds this section, and what it left is below.

### Closed in round 4

- [x] **R4-1: the node page's first-failed key was tested in lower case only.** *Closed 2026-11-23:* `N` is pressed and must set the first failed node's message. Pinned by `apps/cli/src/render/tui/tab-host-node.test.ts`, "names exactly the keys it answers to, and each does what it says". *(medium · tests)*
- [x] **R4-2: a key that moves nothing did not ask again for a cost that could not be read, so "press a key to retry" was false on a one-row list.** *Closed 2026-11-23:* a key that leaves the cursor in place reads the window's faulted costs again; a window with known costs reads nothing. Pinned by `apps/cli/src/render/tui/tab-host-history.test.ts`, "a key that moves nothing asks again for a cost that could not be read". *(low)*
- [x] **R4-3: the `pinOnDefined` comment said a removed row's cursor never lands on another row of the same name; it can.** *Closed 2026-11-23:* the comment is corrected and the test that pins the second of two same-name pins is renamed to what it shows. The residual is open below. *(low · tests and comments)*
- [x] **R4-4: the launch refusals for a moved file and for two files with one id put the paths after a filler, and at 80 columns no path showed.** *Closed 2026-11-23:* the two-files refusal names the files by their stems, or by their full file names when the stems are equal (`fileNames` in `apps/cli/src/home/run-launch.ts`); the moved-file refusal names the file that holds the slug now, by its full file name (`launchMoved`); the remedy comes first in both. Pinned by `apps/cli/src/render/tui/tab-host-defined.test.ts`, "a refused launch names its files on the message row at 80 columns", and `apps/cli/src/home/run-launch.test.ts`, "two files that differ only by suffix keep their suffixes" and "a file that moved to a name with the same stem". The two-files sentence can be cut at the slug when both file names are long (the suffixes kept); the remedy and the names are kept. *(medium · UX)*
- [x] **R4-5: a bare `relavium permissions` whose permissions could not be read on the way back from a view exited `0` without a word.** *Closed 2026-11-23:* the way back leaves through `leaveTabHost` with the reason, as a fault with a note does, so the Home stays with the sentence. Pinned by `apps/cli/src/render/tui/home-tab-host.test.ts`, "a permissions file that cannot be read on the way back from a view says so on the Home". *(nit · security)*
- [x] **R4-6: the History and node hints said "Read-only" while `p` writes a pin.** *Closed 2026-11-23:* the run detail's hint says "No run is changed here; p only marks one.", where `p` works. The node page has no `p`, so its footer says "No run is changed here." (`NODE_CHANGES_NO_RUN` in `tab-host-node.ts`). The first version of this fix put "p only marks it" on the node page too; the round-5 review caught it, and the commit message that claims it is `d602cc2b`. *(low · UX)*
- [x] **R4-7: the reference left out `Backspace` on Permissions and named the wrong path for the remedy.** *Closed 2026-11-23:* `docs/reference/cli/home.md` lists `Backspace` among the keys a legend leaves out on Permissions and says the launch sentences name file names; `docs/runbooks/windows-interrupt-evidence.md` names row 27 among the rows that `Ctrl+C` may differ on. *(low · docs)*

### Still open after round 4

- [ ] **R4-A: after `p` removes a row whose pin is not in the catalog, the cursor stays at its index, which can be another project's pin of the same name, and a second `p` removes that one.** The removed pin can be re-created only from the project that owns it. History has the same fallback after a missing pin is removed. *Trigger:* a report of a pin removed by a repeated key, or a repeat guard for `p`; the fixes are to leave the cursor on a heading, to name the removed pin's project root in the message, or to move to the nearest row with a different identity. *(low · apps/cli/src/render/tui/tab-host-workflows.ts, `pinOnDefined`; apps/cli/src/render/tui/tab-host-history.ts, the pin fold)*
- [ ] **R4-B: the catalog-row unpin finds the project root again at the key press, not from the list.** If a `.relavium/` appears or goes between the working directory and the listed root after the list was read, `p` acts on a same-slug pin under the new root, or says "Nothing was removed". Within the cooperating-storage assumption. *PLAUSIBLE.* *Trigger:* a shared workspace or a second writer to the project's `.relavium/`; the fix is to carry the listed root into the unpin. *(low · apps/cli/src/home/drive-home.tsx, the unpin; apps/cli/src/home/pin-port.ts, `unpinItem`)*
- [ ] **R4-C: "Open the list again" names no key.** On Defined, `←` is a no-op and a refused `r` does not read the list again, so a stale row repeats its refusal until the person leaves the tab and returns. *Trigger:* a report; the fix is to read Defined again on a refusal, or to name the way out. *(low · apps/cli/src/render/tui/tab-host.ts, the Defined legend; apps/cli/src/home/run-launch.ts, `launchMoved`)*
- [ ] **R4-D: the export card's clash sentence puts its remedy last.** `authoring.ts` names the two paths and then "rename one"; the card wraps and shows both, but the row after Close ("Not exported. …", `export-card.ts`) clips the remedy. *Trigger:* a report, or the next change to that sentence. *(low · apps/cli/src/authoring/authoring.ts, the clash message; apps/cli/src/render/tui/export-card.ts)*
- [ ] **R4-E: the History and node folds test `key.backspace` only.** The sibling chat input folds `backspace` or `delete`. Works on the pinned ink; no hedge. *Trigger:* an ink upgrade that changes the key the terminal sends for Backspace. *(low · apps/cli/src/render/tui/tab-host-history.ts; tab-host-node.ts)*
- [ ] **R4-F: the `exiting` guard in `closeScreen` has no test.** `if (exiting) return` at `home-controller.ts` (after `requestExit`) keeps a frame of a closing run from being a Home prompt; no test drives it. *Trigger:* the next change to `closeScreen`. *(low · tests)*
- [ ] **R4-G: two waits in the Home's driver tests are real.** `drive-home.test.ts` waits `SHEET_CONFIRM_DWELL_MS + SETTLE_MARGIN_MS` (about one second) in the `d` loop, and a `waitFor` of five seconds depends on the real 1,500 ms Active poll. The commit's "waits on the sheet's own events" is true of the `d` loop only. *Trigger:* a flake report under load. *(low · apps/cli/src/home/drive-home.test.ts)*
- [ ] **R4-H: the Permissions tab's allowlist heading counts use the capped lengths.** The allowlist is read with a cap of fifty entries (`MAX_ALLOWLIST_ENTRIES`, `readAllowlist`), and the heading counts the capped lengths, so it understates when the file holds more. *Trigger:* a repository whose allowlist is longer than the cap. *(low · apps/cli/src/permissions/chat-permissions.ts, `readAllowlist`; apps/cli/src/render/tui/tab-host.ts, the allowlist heading)*
- [ ] **R4-I: the first History draw folds up to eighteen whole event logs synchronously.** Not measured. *Trigger:* a measured slow first draw on a long history. *(low · apps/cli/src/history/history-source.ts, the first read)*
- [ ] **R4-J: commit `c7c44874`'s message calls the outbox's missing-file case "missing-file"; the test that pins it is the ENOTDIR case, and the ENOENT case is a separate test.** The commit is not amended; the step-4 implementation record will state the correct cases. *(note · commit message only)*
- [ ] **R4-K: a key that changes nothing on History returns a new state and a new cost map, so the tab's state identity changes and every ignored key re-renders the list.** `foldListKey`'s `stay()` (`apps/cli/src/render/tui/tab-host-history.ts`) rebuilds the cost map on each call, and the tab host compares the identity of the history state it gets back (`apps/cli/src/render/tui/tab-host.ts`, the fold's result). Not measured; nothing reads the identity for History today. *Trigger:* a measured redraw cost on a long list, or a change that reads the identity. *(low)*
- [ ] **R4-L: two `stay()` paths of History have no test.** Enter on an empty list and the unknown-key fallthrough return `stay()` (`foldListKey`), and only the moving-key path that asks again is pinned. *Trigger:* the next change to `foldListKey`'s early returns. *(low · tests)*

## MVP-8 step 5 review (2026-11-23) — what the reviews closed, and what is left open

Step 5 had a reviewer for each increment, three security sittings (increment 5a, and increments 6 and 7 together; all PASS, with lows fixed) and an external review of `15b30d68..8dbe6172`. The external review's verified findings were fixed or registered here; what it closed is below, each with its commit. Each open entry names a location and a trigger.

### Closed

- [x] **HOMECTL-1 (high): Enter was dead on every screen opened from a focused strip run.** *Closed 2026-11-23, `079298b6`:* the swallow gate applies on the landing only; pinned by a RootApp-level test (`home-screen-enter-app.test.tsx`).
- [x] **LAUNCH-3: an export write fault (EACCES, EROFS, ENOSPC …) ended the Home.** *Closed, `079298b6`:* the card returns a fixed sentence; any other fault is still rethrown (ADR-0139).
- [x] **LAUNCH-1: `/run` opened another run's view.** *Closed, `7f33a639`:* one rule (`launchStartedRun`) for `/run` and `r`.
- [x] **HOMECTL-2: a line that starts with `/` never reaches the model.** *Closed, `7f33a639`:* the landing answers every such line and never starts a chat; the earlier "text after a word is a first message" rule was wrong and is withdrawn by a correction note in ADR-0140.
- [x] **TABHOSTA-1: a tab forgot its state when another tab took the front.** *Closed, `7f33a639`:* History's scope, filter and focus and Active's focus are carried (History's page is read again from the first page, as documented).
- [x] **LAUNCH-4: the `/run` picker could not be used with more than about twenty workflows.** *Closed, `b47b5d51`:* the native select pages its options with `▲`/`▼` markers and PgUp/PgDn.
- [x] **SEC-1 and V3-B: a hostile YAML file froze the process (41 s), and a catalog scan had no byte bound.** *Closed, `d0f69bef`:* a linear duplicate-key check (341,547-document differential, 0 differences) and a 16 MiB scan budget.
- [x] **TUICARDS-1 and SEC-5: a gate message could spell an answer chord past the card's guard.** *Closed, `4861b03c`.*
- [x] **Test gaps (fsScopeTier default, the resumed leg's takeover, the strip's executing-run filter, the Active poll's age bound, the Active read's read-only rule).** *Closed, `d4b1f4ea`.*
- [x] **The security sittings' lows:** the hardened re-read and the changed-definition refusal at `c` (5a); the pricing card's invisible-character ids and the commit-time cross-provider check (7, `3351966e`); the FIFO-swap read and the commit-time id check of `/import` (6, `70ace782`).
- [x] **Document drift (DOCS-1 to DOCS-5).** *Closed, `35c9d88e`:* the status lines, the runbook's row 16, and as-built notes in ADR-0139 and ADR-0140 (the six points of ADR-0139 still await the maintainer's ruling).

- [x] **HOSTLIFE-1: a run parked on media jobs alone had no way back from the Home.** *Closed 2026-11-24, `aba9e7c9` and `b4213a9a`:* the maintainer chose to wire it. A media request of `resumeRun` and `RunHost.resume` continues it behind a Yes/No question (default No); a gate or budget decision cannot be skipped; a live lease refuses before any secret or MCP work. A security sitting passed it. The shell is unchanged.
- [x] **HOSTLIFE-3: an unclassified fault in a leg ends the Home.** *Closed by ruling, `f97ba095`:* deliberate and pinned (ADR-0139 §6); the as-built points of ADR-0139 are ruled in the same note.
- [x] **LAUNCH-2, and the palette's name ranking.** *Closed, `ad7b8e35`.*
- [x] **LAUNCH-5 and SEC-2: the confirmation was not bound to the file's bytes; `PreparedRun.start()` had no single-use guard.** *Closed, `27519b99` and `acb61f22`:* a digest of the confirmed text is checked before anything is parsed; a second `start()` throws. A security sitting passed it; what the digest does not bind is named in the code and in `home.md`.
- [x] **Homoglyph forms of an answer chord, TUICARDS-4's sentence, TUICARDS-6.** *Closed, `3797d19c`.*
- [x] **A symlinked kind directory sent an import's (and a create's) write outside the project; `readAgentFile` read outside `agents/`; `relavium import`'s missing read floor; ADR-0035's note; the 16 MiB scan budget in the reference.** *Closed, `d0682f19`.*
- [x] **RUNCORE-3 (a config path in a transcript), HISTORY-1 (`logs --follow` after a sleep), MISC-2 (`search_files` skips).** *Closed, `8ac8413b`.*
- [x] **`listPins` limit, the second copy of the price flag names, grid tables in CJK/combining/ZWJ/RTL, RUNDETAIL-1's qualifier.** *Closed, `8d5c95f3`.*
- [x] **The strip's lows:** the failed-read backoff, a failed parked-rows read, the `other project` marker, the Enter after a vanished focus, `Resume cancelled.`, and the driveHome wiring test. *Closed, `9c3eb31b`.*
- [x] **The `/agent` sheet's tool marks and `File` row.** *Closed, `d12966d6`* (the row after a `/clear` is the entry below).
- [x] **The typed-word rule and the six as-built points of ADR-0139.** *Ruled by the maintainer, `05092e3f` and `f97ba095`.*

### Still open

- [ ] **A Yes on a media continue ties the Home to the job, and leaving the Home cancels the run.** The resumed leg keeps polling, holding the lease and the Home's one leg slot until the job settles (the pause is already announced, so no new `run:paused` reaches the drive); a SIGHUP or the confirmed exit guard cancels it cooperatively, the run becomes `run:cancelled` and cannot be resumed, and the paid job's output is never fetched. The question says so before the Yes. *Follow-up:* a hosted media leg returns to the park on exit or a signal instead of cancelling (needs the host's teardown and the engine's cancel-versus-park rule to be designed). *(medium-low · apps/cli/src/home/run-host.ts teardown; packages/core/src/engine/drive.ts)*
- [ ] **No shell command continues a media park.** `relavium run` and `gate` still have no path for a run parked on media only; a command is a product decision. *Trigger:* the maintainer asks for it. *(low · apps/cli/src/commands)*
- [ ] **The input gate has no text field in the Home** (ADR-0139's ruling: a later increment); it offers `Ctrl+N` only. *Trigger:* a workflow with an input gate is run from the Home. *(low · apps/cli/src/render/tui/run-card-model.ts)*
- [~] **The `/agent` `File` row is absent after a `/clear`, after a `/models` reseat and in a resumed session.** Each holds the agent's definition and not the file (a `/clear` rebinds the definition by value, as the MCP consent label already does), so the sheet names no file rather than a file whose content may since have changed; the tool marks are kept. Carrying the label through `createClearRebuild` and the Home's `startChat(bound)` would show it again after a `/clear`. *Trigger:* a report, or the next change to the `/clear` rebuild. *(low · apps/cli/src/commands/chat.ts, apps/cli/src/home/drive-home.tsx)*
- [ ] **`/agents` Sessions does not tell an in-progress session from a finished one** (`listSessionPage` has no status). *Trigger:* a session status is stored, or a report. *(low · apps/cli/src/home/sessions-port.ts, tab-host-sessions.ts)*
- [ ] **After one of several gates is answered, the card's new sentence (`1 of 3 gates answered; 2 still wait.`) is visible only briefly.** `accepted()` publishes `phase: 'answered'` with the notice (`run-card-model.ts` ~264), `input` ignores every key outside `open` (~315), and the next re-read reopens the card and drops the notice (`update()` ~363-372). *Trigger:* a report, or the next change to the card's phases. *(low)*
- [ ] **Chord-guard gaps left on purpose:** `Ctrl: Y` with a space after a colon (not matched, so that `control: a plan` stays intact), and a Latin capital I or the digit 1 as the `l` of `Ctrl`. The gutter and the real key line at the bottom of the card are the defence. *(low · apps/cli/src/render/tui/run-card-model.ts)*
- [ ] **The YAML duplicate-key check builds one library error per key** (a 2 MiB document of 373,885 distinct keys takes 3.3 s and 816 MB: linear and bounded; answering "no" per key would bring the quadratic cost back). Files up to 8 MiB are charged to the catalog scan by bytes though the parser refuses more than 2 Mi characters, so two early junk files can spend the budget (later files are flagged, not hidden), and `takenWorkflowIds` cannot see an id inside a skipped file, so once the directory is thinned two files can carry one id. *Trigger:* a report, or a duplicate-id check in the catalog. *(low · packages/core/src/yaml-decode.ts; apps/cli/src/workflows/catalog.ts)*
  **Cost closed 2026-11-24 (PR #102 review: P1-15; `e0f848f4`, replaced by `33266015`):** the decode cost and the scan total are bounded now, and the per-key part above no longer applies to a document that large. The first fix, a budget of 100,000 map keys (`MAX_MAP_KEYS`), did not bound the cost (a flow sequence of maps at 2 MiB took about 4 to 9 s and 1.2 GB with it in place, eight such files 51 s and 2.75 GB), and is gone. `decodeHardenedYaml` now counts the source's structural characters (`\n \r , : - [ {`; one linear pass, an over-count) and refuses a source over `MAX_YAML_TOKENS = 120,000` with code `RESOURCE_EXHAUSTION` and the fixed message `the document is too large to read safely`, before the library composes anything; the catalog scan charges the same count per scan against `MAX_CATALOG_SCAN_TOKENS = 200,000` (see the entry in the [PR #102 section](#pr-102-review-2026-11-24--findings-answered-refuted-and-deferred)). Eight hostile 2 MiB files: 26.8 s and 2.7 GB before, 10 ms and 115 MB after. Pinned by `yaml-decode.test.ts`, `catalog.test.ts`. **Still open here:** the byte-versus-character point (a file the token cap refuses is still charged its bytes, so early junk files can spend the byte budget) and the id of a skipped file that `takenWorkflowIds` cannot see.
- [x] **A destination that is itself a symlinked FILE leading outside the project still writes through the link under `--force`** (the kind directory is confined; the file is not). *Trigger:* the next change to `writeAuthoredFile`. *(low · apps/cli/src/authoring/authoring.ts)*
  **Closed 2026-11-24 (PR #102 review: P0-1, H2, P05-5, T05-1; `75c87a44`, `2de9eefe`), and it was a medium, not a low:** a forced write of `import`, `create`, `export` and the Home's two commits looks at the final component without following it; a link, a FIFO, a socket or a device is refused (exit 2) with a fixed sentence and nothing is written, and a plain file is replaced through a fresh temporary and a rename, which never follows a link, keeping its mode and group. The write goes through the directory it was confined to and refuses if that directory stops resolving to itself; that look narrows a swap of the directory's name and does not close it, so a forced write also checks after the rename that the name holds the file that was written and reports a write that may have gone to another directory (`34151720`; the in-chat project export is pinned the same way). Pinned by `write-authored-file.test.ts`, `authored-paths.test.ts`, `write-pinned-directory.test.ts` and `forced-write.test.ts`. What a swap in the last instant can still do is in the [PR #102 section](#pr-102-review-2026-11-24--findings-answered-refuted-and-deferred).
- [x] **The pricing confirmation sentence can differ from the card:** for `1e-9` the card shows the stored `$0/Mtok` and the sentence after the write says `$1e-9/Mtok`; `Number()` also accepts `0x10`, `0b11` and `0o7`. The shell's behaviour, characterised over 76 cases; changing the sentence changes the shell's output. *Trigger:* the maintainer asks for stricter price input. *(low · apps/cli/src/commands/models-pricing.ts)*
  **Closed 2026-11-24 (PR #102 review: U06-1, H4, P1-12; `ff3e47fb`), and it was worse than a wording: `Math.round(usd * 1e8)` stored a positive price below one micro-cent as `0`, which the cost path believes as "free".** A price is now read digit by digit into whole micro-cents with no floating-point multiplication; a positive price below `$0.00000001` per million tokens, or with more than eight decimal places, is refused with a fixed sentence naming the smallest price, hex, binary, octal and separated numbers are refused, `0` in any spelling stays a believed "free", and every human line prints the stored value. The characterisation file is 75 cases (the "76" was 75 plus its one meta test; it is 77 tests now) and its expected values were not edited: `ff3e47fb` changed the test only to remove the `CHARACTERIZE_DUMP` path that could skip every comparison and rewrite the oracle. Pinned by `pricing-fields.test.ts`, `models-pricing.test.ts` and `pricing-port.test.ts`.
- [ ] **Two `canonicalRoot` functions, with different fallbacks for a path that does not resolve** (the pins' keeps the path as given; the command grants' returns a normalised absolute path). Do NOT unify them: the grants' value is HMAC-digested into a remembered grant's key, so unifying could silently re-key grants. *(info · packages/db/src/run-pins.ts; apps/cli/src/permissions/command-grants.ts)*
- [ ] **`RunCard.update` is not called in production** (twelve tests use it). Remove it together with those tests, or wire it, when the card's phases are next changed. *(low · apps/cli/src/render/tui/run-card-model.ts)*
- [ ] **The project-and-paused run read scans the project's runs because `status` is not in an index** (DB-1: 5–50 ms at 20,000 runs, at most every 5 s; an index is a migration), and `pin-port.counts()` reads at most 200 pins for a table over 200 rows. *Trigger:* a measured slow strip, or the next migration. *(low · packages/db)*
- [ ] **The launch digest binds the workflow file only** (not the project config files, the global config, the consent log, the keychain, the pricing and catalog rows or an MCP server's tool list); within the cooperating-storage model of `docs/standards/security-review.md`. *(info)*
- [ ] **Commit hygiene (the maintainer's):** commits in three ranges are not green one by one (`00827d82` to `ced42a23`: the effect-journal wiring pins; `7f659aa8` to `51638cf6`: the cohort count; `d415b0d4`: fixtures), so `git bisect` is unreliable there; `8dbe6172` has no scope, no `Refs:` and no trailer, and mixes the help-sheet rewrite, the `openResume` refactor and the `/agents` palette command with the two tabs; many subjects exceed 72 characters; `tools`, `roadmap` and `decisions` are not in the scope list. The trailers of the earlier commits name Haiku 5.5, while the Sonnet 5.5 sub-agents wrote most of the step's code. *Not changed: the maintainer ruled to leave the history as it is; the pull request description states it.*
- [ ] **Owed, not run:** the Windows runbook rows 1 to 38 on real terminals (a human step on Windows Terminal and the legacy console host; CI runs tests, not a console).
- [x] **Closed 2026-11-24 (the gate and the build that were listed here as owed).** The whole local gate (`pnpm gate --keep-going`, run from an isolated git worktree because the mutation controls need an unmoving tree) passed on a still tree at the code head `ae0326d9`: lint, build and format, the five smokes, `test-acceptance-tools`, the workspace tests under the CI environment, the wire, usage and filesystem mutation lanes, the three secrets-mutation shards and the enforced coverage run; it caught the count pins this branch had moved (the usage cohort, the secrets and provenance counts, the retained source-manifest bound, the workspace job timeout), fixed in `02930b38`. `lint:test-isolation` ran inside it. The installed-CLI smoke (`smoke:cli-package`) is CI-owned (it needs every platform's native component) and passed in CI on `f9cf2627`. The final CI run (`45322172313`, all 29 jobs) is the authority for the two commits after the gate (`04645e2e`, tests; `f9cf2627`, documents).
- [ ] **Environment:** `apps/cli/native/fs-metadata/target/debug/deps` stalls directory reads (an `ls` takes about a minute) and at least four vitest processes are stuck in the uninterruptible state on it (pids 12865, 16647, 74913, 92478); a plain `vitest run` in `apps/cli` may hang until it recovers. *(Update 2026-11-24: the `target` stall is gone after `pnpm turbo run build`, and the three untracked `.claude/__test_isolation_fixture__-*` directories (empty trees, left by a killed `lint:test-isolation` run) were removed.)* Every run in this step passed explicit files with a configuration that skips `native/`.

- [ ] **SonarCloud on PR #102 at the merge (2026-11-24): the gate was OK and the 138 open findings are all intentional.** The final head `f9cf2627` had no bug, no vulnerability, reliability, security and maintainability A, duplication 0.4%, hotspots 100% reviewed, and 138 open smells (all `MINOR`): **132 × `S7758`** (`charCodeAt` instead of `codePointAt`: the highlighters and the table and markdown scanners read UTF-16 code units on purpose, [ADR-0144](../decisions/0144-fenced-code-is-highlighted-by-an-in-house-lexical-scanner.md)), **5 × `S9382`** (an `await` in a loop: `seedFixtureRuns` and the test-support event writer persist in order, `createSlotSecretPort` asks the secrets one after another, the exit facts are written in order, and `followLogs` polls) and **1 × `S6582`** (`tokensEqual` in `history/change-probe.ts`: the suggested optional chain, `a?.x === b?.x`, would make two missing tokens equal, and the function says a missing token is never equal). They are not fixed and must not be "fixed". *Trigger:* someone with a SonarCloud token marks them "Won't fix" or "False positive" on `main`, where a pull request's marks do not reach (the status is per branch, see the note on `main`'s gate after earlier merges); no token is stored in the repository or by the assistant. *(info · apps/cli, packages/shared; `main`'s analysis of the merge commit `c17e9763` finished at 08:05Z with the gate OK, no bug, no vulnerability and 162 `S7758` open there)*

## PR #102 review (2026-11-24) — findings answered, refuted and deferred

> Three independent reviews of [PR #102](https://github.com/HodeTech/Relavium/pull/102) (`development`→`main`, head `a8b48018`, 418 files, 126 commits) and three security sittings on the fixes produced the findings. What was **fixed**, what was **refuted**, what was **registered** and what **needs the maintainer** is in the phase record's [PR #102 review corrections](phases/phase-2.6-conversational-authoring.md#pr-102-review-corrections--2026-11-24), with the commits; this section holds what stays **open**. Four older entries were closed in place by the fixes, each with its commit: the [check-then-write symlink window on the append-only files](#phase-265-w1-residuals-pr-83-merged-2026-08-24), the cross-process gate-resolve TOCTOU, a symlinked destination file under `--force` and the pricing confirmation sentence (the last two are in the [step 5 section](#mvp-8-step-5-review-2026-11-23--what-the-reviews-closed-and-what-is-left-open)); the cross-process test, the per-key YAML cost and a parked FIFO entry carry an update. The Windows runbook rows 1 to 38 and the full `pnpm gate` on the final head stay in that section's "Owed, not run" entry. The ids (H-, M-, P0 to P3, U, T, D) are the reports'.

### Not built, though a document describes it

- [ ] **The Defined tab has no workflow detail page ([ADR-0140](../decisions/0140-management-browsers-the-run-drill-down-and-the-durable-run-detail.md) §2).** `Enter` on a row says `No workflow detail yet. r runs it, x exports it, p pins it.` (`06014523`); the page (description, declared inputs with their type, required and secret marks, node count, the three latest runs) needs a bounded read of the workflow's detail and of its latest runs on the Defined port, and a page on the `tab-host` slot. The person cannot see a workflow's inputs before the launch form asks for them. *Trigger:* the maintainer asks for it, or the next change to the Defined tab. *(medium, UX · apps/cli/src/render/tui/tab-host-workflows.ts, `foldDefinedKey`; apps/cli/src/home/defined-port.ts; P1-6)*
- [ ] **A strip row for an agent opens nothing ([ADR-0140](../decisions/0140-management-browsers-the-run-drill-down-and-the-durable-run-detail.md) §6 table: "An agent | the agent detail, if it is in the catalog").** The row stays a display row, and `↑`/`↓` skip it ([home.md](../reference/cli/home.md) says so). The Active tab's node boundaries for another process's run (§2) is the same kind of gap and has its own entry in the [step 4 section](#mvp-8-step-4-review-2026-11-23--round-1-closed-by-the-fixes-and-what-is-left-open). *Trigger:* the maintainer asks for it. ([MVP-11](phases/mvp-11.md) draws the strip's focus and its place under the prompt in Step 6, not what a row opens.) *(low, UX · apps/cli/src/render/tui/home-controller.ts and home-attention.ts; D1-2)*
- [ ] **A run's launch confirmation cannot say what it does not read.** (a) A repository that sets `[defaults] fs_scope = "full"` is shown (the confirmation names the scope and that the repository set it) but no operator-level approval step is asked: whether a repository may widen the scope on a single Yes is a policy question. (b) The tool grants of a `$ref` agent are not read at the pick (the CLI reads no agent file while it prepares), so the sentence cannot name them. (c) The tools an MCP server will offer are known only after it connects. *Trigger:* the maintainer rules on (a); (b) and (c) when the sentence is next changed. *(medium for (a), low for (b) and (c) · apps/cli/src/home/run-launch.ts, `launchAuthorityNote`; P1-7; **MAINTAINER DECISION** for (a))*

### Decisions the maintainer owes

- [ ] **The node page's whole-text scrub corrupts indented JSON where a header- or query-named member holds an object or an array** (`{"x-api-key":{"nested":"x"}}`): the page masks its emitted pretty-printed text once more as a whole after the member rule, which rewrites the serialization; the summary has no such pass (it masks leaf by leaf and by member). [home.md](../reference/cli/home.md) describes the second pass and two tests pin it. Removing it is a behaviour change to a documented guarantee. *Trigger:* the maintainer decides. *(low-medium · apps/cli/src/history/node-detail-model.ts, `buildOutputPreview`; P2 "Render"; **MAINTAINER DECISION**)*
- [ ] **ADR-0138's write marks are recorded only on the chat's approval hook** (U01-1). A workflow's file writes, now started from the Home, are not marked, so an `auto` chat can run an edited `npm test` from a grant that a workflow's write should have outdated, without a card. *Trigger:* the maintainer decides whether a hosted workflow's writes enter [ADR-0138](../decisions/0138-a-file-write-is-remembered-for-the-project-and-outdates-older-grants.md). *(medium · apps/cli/src/permissions/write-marks.ts and the chat's approval hook; the run host; **MAINTAINER DECISION**)*
- [ ] **There is no command to withdraw an MCP consent** (U01-2). `appendRevocation` has no production caller (checked: the only reference outside tests is its own definition); the Home card says `Allow, and remember it on this machine` and [mcp-integration.md](../reference/shared-core/mcp-integration.md) describes revocation by tombstone. *Trigger:* the maintainer decides whether to build `relavium permissions`-style withdrawal for MCP grants. *(low-medium · apps/cli/src/engine/mcp-consent.ts; **MAINTAINER DECISION**)*
- [ ] **[ADR-0142](../decisions/0142-a-literal-search-is-linear-and-its-work-budget-charges-what-it-reads.md) was accepted without the separate security sitting it named while Proposed.** The ADR says so itself and records the maintainer's acceptance on the evidence under Verification; the per-line charge it calls the worst case is what a sitting would examine. *Trigger:* the maintainer asks for the sitting. *(low, process · docs/decisions/0142; **MAINTAINER DECISION**)*
- [ ] **`--force` over an existing file whose id is declared by another file writes a second file with the same id** (P05-4): `import --force` of an agent named `old-name.agent.yaml` in a project that holds `reviewer.agent.yaml` with the same id; the next `export` or `run` of that id then fails loudly, and nothing is lost. The product choice is to replace the declaring file, refuse, or write the canonical name. Reported by the fix agent and the review; not probed again here. *Trigger:* the maintainer decides. *(low · apps/cli/src/authoring/authoring.ts; **MAINTAINER DECISION**)*
- [x] **The catalog scan has no deterministic bound on its total decode cost.** *Closed 2026-11-24 (PR #102 review: P1-15; `33266015`).* The first fix, `e0f848f4`, bounded one decode by a key budget that did not bound the cost: the third security sitting measured eight hostile 2 MiB files at 51 s and 2.75 GB for a shape it does not cover. A **token budget** replaced it: one decode refuses a source over 120,000 structural tokens (`MAX_YAML_TOKENS`, `the document is too large to read safely`, no line and column), and one scan charges the same count per file, in name order, before the parse, against 200,000 (`MAX_CATALOG_SCAN_TOKENS`, `apps/cli/src/workflows/catalog.ts`). A file over the per-file cap is listed `valid: false` with the fixed reason `too large to read safely`, charged nothing and never parsed; the first file that would pass the scan's total is skipped with `skipped: the catalog is too large to read safely; move some files out of .relavium/<kind>/`, and so is every later file, unread. Eight hostile 2 MiB files: 26.8 s and 2.7 GB before, 10 ms and 115 MB after; one decode at the bound is 0.2 to 0.5 s and 150 to 240 MB, a scan at its bound one to two seconds at the most; the repo's own files are 66 to 223 tokens, and a 2 MiB prose prompt passes. Pinned by `yaml-decode.test.ts` and `catalog.test.ts`. The alternatives (a lower byte budget, discovery off the UI thread) were not built and are not needed for the bound; the scan still runs on the UI thread, now for at most a second or two. **If a legitimate file ever exceeds the cap, raising `MAX_YAML_TOKENS` (and `MAX_CATALOG_SCAN_TOKENS` with it) is a one-constant change**, and the cost scales linearly with it. *(was medium · packages/core/src/yaml-decode.ts; apps/cli/src/workflows/catalog.ts; P1-15)*

### Residuals of the fixes

- [ ] **Forced-write residuals.** What the directory pin and the after-the-fact check (`75c87a44`, `2de9eefe`, `34151720`) do not do. (a) The pin **narrows** a race and does not close it: Node has no `openat` or `renameat` on a directory descriptor, every step names the directory again, and a second principal with write access to `.relavium/` who swaps the directory's name for a link fast enough can still place the temporary or the replaced file in the swapped-to directory (the second security sitting did it with `renamex_np` and `RENAME_SWAP` in a loop); there is an instant between a check and the next system call that no check reaches. (b) A temporary created in a directory that is swapped away afterwards stays there, an orphan its name no longer reaches. (c) The detection after the rename (the name must hold the file that was written, the directory must still be the approved one) **reports, and cannot undo**: the replacement has happened, and the person is told in fixed words (`The file may have been written to another directory, because the target directory was changed by something else while it was being written. Check where it went, then retry.`). (d) A write without `--force` is an exclusive create, one system call after its look; it was not seen to escape in 51,141 raced tries, and has no after-the-fact check. (e) **Windows is untested**: every link, FIFO and race test is skipped there; reparse points, a rename over an open file and the device names on the `wx` path have no evidence. *Trigger:* (a) to (d) Node gains directory-descriptor calls, or the native adapter takes the write; (e) the Windows filesystem step. *(low · apps/cli/src/process/forced-write.ts, apps/cli/src/authoring/authoring.ts, apps/cli/src/chat/export.ts; `75c87a44`, `2de9eefe`, `34151720`)*
- [ ] **`list_directory` reports a FIFO, a socket or a device as `file`.** `DirEntry.type` has no fourth value, so the answer is a lie for those three. *Trigger:* the next change to `listOne`, or a fourth value in the entry type. *(low · apps/cli/src/engine/tool-host/fs.ts, `listOne`; packages/core/src/tools/types.ts)*
- [ ] **`.git` is not pruned from `search_files` and `find_files`** (only `.git/config` and `config.worktree` are refused on read). Whether discovery should prune it is a policy question. *Trigger:* the maintainer decides, or a report of a search that walks a large `.git`. *(low · apps/cli/src/engine/tool-host/fs.ts)*
- [ ] **`list_directory` and `read_file({ glob: true })` do unbounded matcher work** (`compileGlob` is called without `consumeWork`). Pre-existing, not PR #102's. *Trigger:* the next change to either tool. *(low · apps/cli/src/engine/tool-host/fs.ts)*
- [ ] **`MEDIA_RESUME_REFUSALS.liveLease` ("That run is being continued by another process.") has no retry hint**, and the host reports it as a refusal with the typed reason `rejected` (P02a-3); the Home cannot say "try again". The change belongs in `run-core/resume-run.ts`, with the wording of [ADR-0139](../decisions/0139-a-workflow-run-is-hosted-inside-the-home.md) §3. *Trigger:* the next change to the media resume refusals. *(low · apps/cli/src/run-core/resume-run.ts)*
- [ ] **`resumeRun` reads the project root with `statSync(projectRoot, { throwIfNoEntry: false })`**, which suppresses only a missing entry: an `EACCES` or an `ELOOP` on the recorded directory throws after a secret has been asked, where it should fall back to the resumer's working directory as a missing one does (the review reported exit 9). Not fixed in this round. *Trigger:* the next change to `resolveSaveToRoot` in `resume-run.ts`; the fix is a `try`/`catch` and a test for `EACCES`. *(low · apps/cli/src/run-core/resume-run.ts, `resolveSaveToRoot`, about line 107)*
- [ ] **A degraded gate read is cached like a good one.** The Active tab keeps each paused run's gate count while its row has not moved and for up to one lease TTL (`parkEntryOf` in `active-source.ts`); an entry whose read failed (`count` undefined, shown as "gate state not read") is stored by the same rule, so one transient fault shows for up to a TTL. Read in the code; `06014523` did not change it. *Trigger:* a report, or the next change to `parkEntryOf`; the fix is not to cache a failed read. *(low-medium · apps/cli/src/history/active-source.ts; T07a-3)*
- [ ] **M-E4: a read that races a consent-log append sees a torn last line, and the fold closes for one extra prompt.** Documented in [ADR-0084](../decisions/0084-consent-before-a-local-mcp-spawn.md)'s note of 2026-11-24 and in the reference: skipping a torn line is unsafe because it may be a tombstone. Nothing to fix. *(info · apps/cli/src/engine/mcp-consent.ts)*
- [ ] **Two credential-name classifiers can drift.** `CREDENTIAL_MEMBER_NAMES` in `apps/cli/src/render/output-masking.ts` (an exact list for output members) and `SECRET_WORDS` in `packages/core/src/tools/bounding.ts` (which masks more, for example `password_hint` and `input_tokens`). They serve different surfaces and were not unified. *Trigger:* the next change to either list. *(low · both files; P1-14)*
- [ ] **`stripTerminalControls` keeps ZWSP, U+2060 to U+2064, U+FEFF and the tag characters.** Deliberate (ZWJ and ZWNJ are kept for emoji and shaping, [security-review.md](../standards/security-review.md)), but an output can hide text with them. `ask_user` text already refuses them ([ADR-0132](../decisions/0132-the-model-can-ask-the-user-a-structured-question.md)). *Trigger:* the maintainer asks for a stricter floor. *(low · apps/cli/src/render/tui/chat-projection.ts)*
- [ ] **`run_pins` has no `pinned_at` index and no CHECK on the ref shape, `PinList.truncated` is not shown, and a moved project directory orphans workflow pins** (they show as `? other project`). The History pin-cap sentence counts other projects' pins without listing them (P07b-4). Each needs a migration or a new screen, so none was done in this round. *Trigger:* the next migration, or a report. *(low · packages/db/src/run-pins.ts, packages/db/src/schema.ts; apps/cli/src/render/tui/tab-host-history.ts)*
- [ ] **The table parser trims a cell's edges with `String.prototype.trim()`**, which also strips a no-break space (U+00A0) and an ideographic space (U+3000) that GFM keeps; so a table loses them at the edge of a cell before the layout runs, and [ADR-0143](../decisions/0143-a-wide-table-keeps-its-grid-and-records-are-the-last-resort.md) decision 6 ("nothing is dropped") is false there. Small: trim ASCII only, and check `stream.ts` for the same rule. *Trigger:* the next change to `parser.ts`. *(low · apps/cli/src/render/markdown/parser.ts, `cells`; P2 "Render")*
- [ ] **`InMemoryRunStore.persistEvent`'s duplicate-sequence check is O(n)** (a test double; nothing in production uses it). *(info · packages/core/src/engine/execution-host.ts, `InMemoryRunStore`)*

### Test gaps and report items not addressed

- [ ] **Test gaps not closed.** `Ctrl+C` and `Esc` reach the strip and sheet tests through `handleKey`, not the stdin path of `RootApp` (T08a-3); CJK and emoji are not in the strip and sheet tests (T08a-1/2); and no test swaps a FIFO in after the own-export check (the [parked entry](deferred-tasks-parked.md) was checked and stays open). *Trigger:* the next change to those tests. *(low · apps/cli/src/render/tui, apps/cli/src/process/owned-storage.ts)*
- [ ] **Report items that no fix of this round addressed and that were not re-verified here.** From the 24-agent review: M-8 (an Alt or Option combination that arrives as `Esc b` cancels a form like one `Esc`), U01-3 (the gate and budget card's dwell is never tested with a non-zero duration), P07a-2 (a `CliError` description is swallowed when the Defined, Agents or Sessions read fails), P07a-3 (a synchronous whole-log fold when History or the node page opens; the same as R4-I in the [step 4 section](#mvp-8-step-4-review-2026-11-23--rounds-2-to-4-closed-by-the-fixes-and-what-is-left-open)), T08b-2 and T08b-3 (the pinned-row `r`/`x` mapping and "a secret reaches the run" tests do not exercise their subject). From the 12-stream review: the `/models` picker reaches about 32 rows at 80×24 (pre-existing), `defined-port`'s pin-count drift across processes, the outbox stamp is not in the change token so a held run can read stale for 60 s, a stale comment in `chat-ink.tsx` and `Ctrl+C` in the review view not clearing an armed state (both marked "needs confirmation" by the review), `terminalOutboxStamp` returning `'absent'` on Windows and `undefined` on POSIX (same mark), 14 duplicate test names and two `as unknown as` test doubles. From the 8-stream review: M-H2 (the `fetchPage` boundary `>` against `>=`), M-H3 (`modelsUsed` is capped before it is scrubbed), M-H4 (`unattributedMicrocents` also subtracts boundary-sourced cost), M-R1 (chord-token detection does not cross a line break), M-R2 (the records guard can force a short generated table to literal), M-C2 (`readHistory` accumulates a whole log), M-C3 (`releaseMcp()` answering false waits for ever), M-C5 (`resumeGateSecrets` tests `stdin instanceof Readable`) and M-E3 (an ASCII fold is not chunked, so a one-megabyte line blocks the event loop). Each is a claim of a report; none was probed. *Trigger:* a report, or the next change to the file it names. *(low to medium · the files named in the phase record's list)*
