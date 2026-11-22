# ADR-0139: A workflow run is hosted inside the Home, one executing leg at a time, under the Home's own owners

- **Status**: Proposed — 2026-11-22, written for the maintainer's acceptance (MVP-8 pre-flight). Nothing in this ADR is implemented. The D64 rigor tier and a separate security sitting apply to every step that builds it (the lease and resume paths, an approval and consent surface, secrets).
- **Date**: 2026-11-22
- **Decides**: the question [ADR-0122](0122-the-home-is-the-interactive-product.md) §10 reserved ("Running a workflow and answering a gate inside the Home … gets its own ADR … That ADR also amends ADR-0115"), with the maintainer's three rulings of 2026-11-22: (1) a hosted run lives in the background and `Esc` leaves its view without stopping it; (2) `Ctrl+C` on a running leg takes two presses; (3) a run parked at a gate cannot be cancelled in MVP-8, and `current.md`'s "cancels … gated runs" is reworded.
- **Amends** (each with a dated note in place, written with this ADR): [ADR-0115](0115-one-interrupt-keymap-for-the-interactive-cli.md) §1 and §4, [ADR-0122](0122-the-home-is-the-interactive-product.md) §10, [ADR-0054](0054-cli-bare-invocation-interactive-home.md) (the Home's lifecycle claims), [ADR-0079](0079-cross-process-run-ownership-lease-and-fencing-token.md) (its two recorded deferral triggers), [ADR-0097](0097-a-budget-approval-is-an-allowance-not-an-exemption.md) (the budget card also lives in the Home), [ADR-0103](0103-a-paused-run-hands-off-its-local-producers-before-its-host-closes.md) (the Home is a host surface that departs) and [ADR-0118](0118-a-command-outside-the-allowlist-asks-instead-of-failing.md) (a workflow run hosted in the Home is still unattended).
- **Related**: [ADR-0036](0036-run-loop-substrate-event-bus-and-execution-host.md), [ADR-0049](0049-cli-machine-output-contract.md), [ADR-0083](0083-input-admission-and-a-resume-that-verifies-its-own-identity.md), [ADR-0084](0084-consent-before-a-local-mcp-spawn.md), [ADR-0129](0129-the-approval-card-is-docked-bounded-and-says-only-what-matters.md), [ADR-0132](0132-the-model-can-ask-the-user-a-structured-question.md), [ADR-0137](0137-permissions-is-a-sheet-and-esc-steps-back-out-of-the-full-view.md), [ADR-0140](0140-management-browsers-the-run-drill-down-and-the-durable-run-detail.md) (the browsers that start and open these runs), [D64, D68, D75](../roadmap/current.md#wave-gating-decisions), [the Home reference](../reference/cli/home.md), [commands.md](../reference/cli/commands.md#exit-codes)

## Context

The Home is the interactive product ([ADR-0122](0122-the-home-is-the-interactive-product.md)). A person who opens it must be able to run a workflow, watch it, and answer the human gates and budget gates it raises, without leaving for a shell. ADR-0122 §2 fixes the shape (an in-TUI form **re-hosts the same core** the subcommand calls; it never spawns `relavium <cmd>`) and §10 reserved the hard part: the Home process would then host a run's lease, signals, consent prompts and exit dispositions, and nothing in the documents says how.

The code and documents were read on 2026-11-22 (five reconnaissance reports, one per area). The facts that shape the decision:

1. **Answering a gate is hosting a run.** `relavium gate` and `relavium budget resume` start a fresh process that reconstructs the checkpoint, acquires the lease and **executes** until the next pause or terminal ([commands.md](../reference/cli/commands.md#relavium-gate)). A gate row in the Home is therefore the same problem as "run a workflow" (cross-process resume, secret re-supply, MCP reconnection against the original workspace), not just a card.
2. **The shell's run core is welded to a process.** `driveRun` takes a concrete `WorkflowLifetime`. Its constructor claims the invocation's one signal custody (a second claim throws `cli_internal`), activates the finite-exit fallback and registers a `workflow` owner and a `terminal` owner. The Home's own `SessionSurfaceLifetime` has already claimed the custody, so a `WorkflowLifetime` cannot coexist with it. A session surface also cannot publish the workflow health codes (5, 7, 8): it turns them into `cli_internal`.
3. **The prompts are clack.** The gate card, the budget card, the MCP consent card and the secret input all use `@clack/prompts`, which takes raw mode. The Home has exactly one raw-mode owner (`RootApp`'s `useInput`). A clack card cannot run over it, and the ADR-0122 §7.7 rule (a secret stays out of React state, history and the transcript) forbids reusing a prompt that is not the native one.
4. **`RunApp` is a pure view** (no `useInput`); it can be mounted inside the Home's tree. It was written for a cooked-mode terminal where a keyboard `Ctrl-C` is a real SIGINT. In the Home `Ctrl-C` is a key.
5. **No Ctrl-C rule exists for a run in the Home** (ADR-0115 §4: "out of scope … the later run-hosting ADR's"). The exit rules are written for chats ([commands.md](../reference/cli/commands.md#exit-codes): "Home: clean shell end / nested chat end"), and ADR-0079's two deferral triggers (an observer handle; a long-lived host that keeps one engine across many park-and-resume cycles) are both fired by a Home that hosts runs.
6. **A stale gate card can fail a healthy run** (an owed medium, [deferred-tasks-parked.md](../roadmap/deferred-tasks-parked.md), "Answering a stale gate card after another process decided the gate"): an engine that still holds the run in memory reclaims the lease on an answer, its guarded append is refused on a stale head, and it then writes `run:failed{internal}` at a sequence another process already used. It must be fixed before v0.2.0, and it matters more once a second surface can answer gates.
7. **A workflow run is unattended by contract.** [ADR-0118](0118-a-command-outside-the-allowlist-asks-instead-of-failing.md) §2 keeps `run_command` in a workflow to the allowlist, with no card and no remembered grant; a workflow host wires `fs` and `process` only, and `run` refuses `--allow-fs-root`. A person being present in the Home does not change that. The cards a hosted run can show are the human gate, the budget gate, the MCP stdio consent and masked secret fields, and none of them has a "full view" to back out of (the sentence in `current.md` that said a hosted run "shows approval cards" with the ADR-0137 `Esc` ladder is corrected by this ADR).

## Decision

**The Home hosts a workflow run in its own process by re-hosting the shell's run core under the Home's owners. It hosts one executing leg at a time. A human wait is never held in memory: the leg hands off at the pause and the answer starts a new leg through the one resume core.**

### 1. One run core, two hosts

The shell's run path is split at its process-bound seams, once, and both hosts call the result.

- **`prepareRun`** (workflow resolution and validation, input admission and secret inputs, the key and catalog pre-flights, MCP discovery with its consent gate, history store, engine build) and **`resumeRun`** (the checkpoint reconstruction, selection, decision checks and price pre-check, secret re-supply, MCP reconnection with preserved grants, `resumeFromCheckpoint`) are extracted from `run.ts` and `gate.ts`. `resumeRun` is the shared cross-process resume core of 2.6.K: `relavium gate`, `relavium budget resume` and the Home all call it, and no other path resumes a run.
- **`driveRun`** depends on a narrow **`RunLifetime`** interface (the abort signal, `checkpoint`, `adoptEngine`, `adoptHandle`, `publish`, `failure`, `notification`, the effect-notice owner and a `runPrompt` hook), not on `WorkflowLifetime`. Two implementations exist: `WorkflowLifetime` (the shell, unchanged in behaviour) and `HostedRunLifetime` (the Home).
- **The input and decision prompts are ports** (`GatePrompter`, the consent prompter, the secret reader), each with a clack implementation (the shell, unchanged) and a native implementation (the Home, §4). The shell keeps its prompts; the Home never imports clack.
- **The shell's machine surface does not change.** For every invocation `run`, `gate` and `budget resume` accept today, stdout, stderr, `--json` and the exit code are byte-identical ([ADR-0122](0122-the-home-is-the-interactive-product.md) §2, [ADR-0049](0049-cli-machine-output-contract.md)); the existing command harness proves it after the extraction, and a new case pins the `--json` stream of a resumed run.

### 2. One executing leg at a time, a fresh engine for each

- A **leg** is one engine's hosting of a run, from `start` or `resumeFromCheckpoint` to the next pause, terminal or cancellation. A fresh `WorkflowEngine` (a fresh lease owner id) is built for **every** leg. This sidesteps ADR-0079's recorded residual (a long-lived host cannot tell a straggler from the current leg when the same owner and generation repeat), so that deferral trigger does not fire.
- The Home hosts **one executing leg at a time**. A request to run or resume while one executes is refused with a one-line notice naming the hosted run; it is never queued. This is a deliberate bound (one SQLite connection, one MCP lifetime, one terminal), not a missing feature, and it is recorded in the reference. A run that is parked, finished or cancelled is not "hosted".
- **Starting is single-flight.** The controller latches a `launching` flag from the confirmation to the engine's `start` result; a second `Enter` while it is set does nothing (a double submit starts one run). The latch is pinned by a test that drives two `Enter`s in one tick.
- The Home reuses its open `history.db` connection (the one `opened.db`); a hosted leg never opens or closes a second one.

### 3. A leg lives in the background; a pause hands off

(The maintainer's first ruling of 2026-11-22.)

- A started leg runs in the Home process until it ends. It is shown by a **run view**, a Home screen that mounts the existing `RunApp` projection over the existing run store inside the Home's one ink tree. **`Esc` leaves the view and does not stop the leg.** While the leg executes, the landing's strip shows one row (`▶ deploy · running 2m · $0.0210`), and `Enter` on it reopens the view.
- **The leg's events are consumed by exactly one reader** started before any departure ([ADR-0103](0103-a-paused-run-hands-off-its-local-producers-before-its-host-closes.md)): `eventConsumption: 'iterated'`, the reader folds into the run store whether or not the view is open.
- **A pause hands off at once.** When a leg pauses on a human gate or a budget gate, the drive takes the same exit the shell's non-interactive path takes (`shouldBreakOnPause`), `depart()`s (the lease is already released at a human-gate park), and the leg ends as `paused`. The Home does **not** keep the run in memory waiting for a person. The run view (if open) turns the pending gates into the gate or budget card (§4); if it is not open, the strip gains an Attention row and a transcript notice if a chat is in front (a card never takes the keyboard from another screen). The answer is `resumeRun`, which starts the next leg on a fresh engine. Consequences: the pause is durable and answerable from any process (the Home, another terminal's Home, `relavium gate`); a deadline is re-armed from its persisted `expiresAt` when a leg resumes, as it is today; and the stale-card defect cannot occur on this path, because the answer re-reads the checkpoint after it holds the lease and finds the gate already decided.
- **The leg's outcome is view state.** `completed`, `failed`, `cancelled` and `paused` are shown in the run view as a persistent disposition card (the final-summary text with its continuation named as an in-TUI action, [ADR-0122](0122-the-home-is-the-interactive-product.md) §6) and kept until the person starts another run or dismisses it; they never end the Home.
- **Notices stay in the Home.** Everything `run` writes to stderr during a run (the withheld-effort, unpriced and legacy-hold warnings, the snapshot-literal warning, the skipped-MCP lines, the departure diagnostics) goes to the Home's notice channel and, when a chat is in front, to a one-line transcript notice. The Home writes nothing to stderr while it owns the screen.

### 4. The cards are native, answer with chords, and never answer on a paste

The clack prompts are not reused (§Context 3, and the residual that a paste or a hotkey can answer a clack card). The Home gets native ink cards on its one input owner, sibling to the ADR-0132 question card and the ADR-0129 approval card, with the same discipline: every answer is a Ctrl chord or an explicit field submit, a bare letter or a paste answers nothing, the affirmative answers pass the same dwell, quiet-gap, typeahead and lockout guards and the measured-frame acknowledgement (the card must have been painted and measured at 80×24 before an affirmative key counts), and a rejection is never delayed. They are specified in the reference when built; the decisions here are:

| Card | Answers | Notes |
|---|---|---|
| **Human gate, `approval` or `review`** | `Ctrl+Y` Approve, `Ctrl+N` Reject | The decision shape follows the gate type ([commands.md](../reference/cli/commands.md#relavium-gate)); a `rejected` decision does not fail the run (the author routes on it), and the card says so. |
| **Human gate, `input`** | text field + `Enter` submits `input_provided`; `Ctrl+N` rejects | The field is bounded; the typed value is never echoed into history or the transcript. |
| **Budget gate** ([ADR-0097](0097-a-budget-approval-is-an-allowance-not-an-exemption.md)) | `Ctrl+Y` approves **exactly the frozen allowance**; `Ctrl+N` aborts | The amount is read from the structured `allowanceQuote`, never parsed from message text, in USD with the qualified-cost words; excluded entries are quoted and escaped. A quote that cannot be approved (unpriced, unrepresentable, legacy) offers abort only. A price that moved is refused by `resumeRun` **before** the gate is claimed, leaving it pending and abortable. |
| **MCP stdio consent** ([ADR-0084](0084-consent-before-a-local-mcp-spawn.md)) | `Ctrl+Y` allows this run; `Esc`, `Ctrl+C` and `Ctrl+N` refuse | Default is refuse; a resumed leg reuses the frozen grants and asks nothing new. |
| **Masked secret field** | typed text + `Enter` | One field per declared `secret` input at a start, one per masked slot at a resume (ADR-0083 §6); the value lives only in the native prompt channel and `resumeRun`'s argument, never in React state, history, the transcript or an error. |

- With more than one pending gate the card lists them with a cursor; an answer applies to the selected gate and the others stay pending.
- `Esc` on a card **leaves it and decides nothing** (the gate stays pending; the strip keeps its row). `Ctrl+C` on a card does the same and never answers. Neither key can reject, because a `rejected` decision continues the run.
- Text that comes from a workflow author or from model output (a gate message, a node or workflow name, an excluded-entry label) passes the sanitize floor and the forged-legend refusals of [ADR-0132](0132-the-model-can-ask-the-user-a-structured-question.md) (host glyphs and answer-chord tokens), because a gate message can interpolate model output.
- The Home answers with `decidedBy: 'cli'`, the constant the event already carries; no event field is added.

### 5. The interrupt ladder of a hosted run (the second ruling)

This amends [ADR-0115](0115-one-interrupt-keymap-for-the-interactive-cli.md) §1 with these rows, kept in `interrupt-keymap.ts` and its table-driven test. Cancelling a run is irreversible (a `run:cancelled` run cannot be resumed), so it takes two presses like ending a session.

| State | First `Ctrl+C` | Second `Ctrl+C` (armed) |
|---|---|---|
| The run view is open and a leg is executing | Arm; the hint reads `Ctrl+C again cancels the run · Esc leaves it running`. Nothing is cancelled | Request the cooperative cancel; the view reads `Cancelling · the run stops at its next safe point (up to 10 s)` |
| The leg is cancelling | A hint only (`Waiting for the run to stop`); arms nothing and cancels nothing more | — |
| A gate, budget or consent card is open in the run view | Close the card and the view, decide nothing, do not arm | — |
| Another screen is in front (the landing, a chat, a sheet) and a leg executes | The key keeps the meaning of the screen in front (ADR-0115 §1 unchanged) | The exit guard of §6 applies when the second press would leave the Home |

`Esc` steps back one level and never arms: in the run view it leaves the view with the leg still running; on a card it closes the card. The cooperative cancel is the engine's own (`handle.cancel()`): the run settles as `run:cancelled`, a non-cooperative executor is abandoned after the engine's 10-second grace window, and cancellation wins over a racing failure ([ADR-0036](0036-run-loop-substrate-event-bus-and-execution-host.md)).

### 6. Leaving the Home with a leg executing; signals; the exit code

- **The exit guard.** A second `Ctrl+C` on the loaded landing, and `Ctrl+D` on an empty prompt, would end the Home. While a leg executes (or is cancelling) they open a confirmation card instead: `Ctrl+Y` cancels the run and exits, and `Esc`, `Ctrl+C` and `Ctrl+N` stay ([ADR-0122](0122-the-home-is-the-interactive-product.md) §7.4: a confirmation treats both interrupt keys as cancel). The confirmed path cancels the leg, waits for it to settle within the engine's grace window (the screen says `Stopping the run…`), and only then runs the Home's teardown. It never exits with a leg still executing.
- **Signals keep their process meaning** ([ADR-0115](0115-one-interrupt-keymap-for-the-interactive-cli.md) §4). An external SIGINT, SIGTERM, SIGHUP or SIGQUIT goes to the Home's one finite-exit authority. The hosted leg's owner (below) is told to stop (a cooperative cancel), and the invocation's fatal bound (three seconds) applies. A run that could not settle inside the bound keeps its lease until it expires (sixty seconds) and the next start's reconcile settles it as failed ([ADR-0079](0079-cross-process-run-ownership-lease-and-fencing-token.md)); this is the same as a killed `relavium run`, it is written in the reference, and the Home does not pretend otherwise.
- **The owner.** `HostedRunLifetime` registers a `workflow` owner with the **Home's** invocation registry before any work is admitted (before the engine is built), supplies `readSafetyExit`, and retires after the leg's actual cleanup. It claims no signal custody and no terminal owner (the Home's own owners hold both) and installs no job-control coordinator (the Home has one). The registry already accepts several owners; custody is the only exclusive claim.
- **The Home's exit code.** A leg's ordinary outcomes (0, 1, 3, a cancel) are view state and are **not** published ("a nested chat end is deliberately not published" extends to a nested run end). The workflow **safety** facts (money not confirmed 8, an effect needing attention 7, a held terminal 5, taken over elsewhere 6) are published through the owner and rank above a clean exit by the sticky priority already in force (8, 7, 5, 6, then infrastructure, then a signal, then ordinary). The person is shown the fact and its remedy in the run view; if the Home then exits, it prints one plain line after the screen is restored naming the run id and the shell remedy. These codes mean "do not repeat automatically" and the Home never re-invokes anything.
- **Teardown order**, which `teardownActive` gains: cancel the leg, join its stream, `depart()` (it must return `detached` or `closed`, else it is an internal fault as in the shell), close the leg's MCP clients and work, retire the owner, and only then close the Home's shared database, last.

### 7. Authority, workspace and what a hosted workflow may do

- **Unattended, as in the shell.** A hosted workflow's tools are exactly what its definition and the workflow host grant; `run_command` is allowlist-only with no card and no remembered grant; `--allow-fs-root` does not exist for a workflow ([ADR-0105](0105-filesystem-roots-are-invocation-grants-not-project-authority.md)); a chat's filesystem grants are not inherited. The run's filesystem root is the one `relavium run` would use from the Home's own working directory.
- **A run belongs to the workspace it was started in.** The Home starts workflows only from its own project's catalog. An answer or resume for a run whose recorded `project_root` is another directory is refused with the fixed remedy (open the Home there), exactly as a session in another directory is ([home.md](../reference/cli/home.md#resume-and-continue)); the Home never re-anchors its workspace. Such runs are readable in the History browser, not actionable.
- **The inputs are the shell's.** The launch form asks the declared inputs through the native prompt channel and validates them with the one core validator (`resolveAndValidateWorkflowInputs`); a secret is only ever a masked field.

### 8. Not decided here, and why

- **Cancelling a run parked at a gate** (the maintainer's third ruling): not in MVP-8. A `rejected` decision continues the run, so there is no cancel for a parked run, and a new terminal-writing path on a run nobody holds would be a new D64 lease-path increment. `current.md`'s MVP sentence is reworded to "cancels chats; resumes chats and gated runs". A parked run's actions are answer or leave.
- **Several concurrent legs, a detached child process, a warm engine kept across answers, and cross-process cancel** are not built (§2; ADR-0122 §2 and ADR-0103 rule out the child and the daemon; each later change is its own ADR).
- **Keychain re-resolution of a secret input on resume** stays unbuilt (`ref` is a self-reference); the masked field re-supplies it.

### Alternatives considered

- **Supervise a child `relavium run --json`.** Rejected: ADR-0122 §2 ("never spawns `relavium <cmd>` as a child"), and a child owns the terminal.
- **Foreground only (leaving the view cancels).** Rejected by the maintainer on 2026-11-22: a long run would block the Home.
- **Keep the run in memory while it waits at a gate.** Rejected: it holds engine, MCP and timers for as long as a person takes, and it is exactly the state in which the stale-card defect arises. A durable park answered by a fresh leg is one path with one set of tests.
- **A long-lived engine for the Home.** Rejected: it fires ADR-0079's long-lived-host residual for no gain a leg-per-engine does not give.
- **Port the clack prompters.** Rejected: raw-mode ownership, ADR-0122 §7.7, and the paste-and-hotkey residual.
- **`Ctrl+C` cancels the run on the first press.** Rejected by the maintainer: one stray key would destroy a long, paid, non-resumable run.
- **Approval cards for a workflow's tools.** Rejected: it would reverse ADR-0118's unattended contract and ADR-0057's floor for workflow runs.
- **Publish a leg's ordinary outcome as the Home's exit code.** Rejected: the Home outlives runs; only the safety facts must survive it.

## Consequences

### Positive

- A person can run, watch, answer and resume from the Home without a shell, and the shell and the Home share one run core and one resume core, so they cannot drift (and the machine contract is proven unchanged).
- A pause is durable and answerable from anywhere; the Home never holds a person-shaped wait in memory, and the owed stale-card defect has no path to occur on the Home's route.
- Cancelling is deliberate and consistent with ending a session; exiting the Home can never silently kill or orphan a run.
- The same native card discipline (chords, guards, no paste answers, sanitized author text) covers every decision the Home asks.

### Negative

- **Each answer rebuilds an engine** (providers, MCP reconnection with preserved grants). A multi-gate workflow pays that once per gate. Mitigation: it is the shell's existing cost; a warm engine is a later ADR if measurement says it matters.
- **One executing leg at a time** can feel limiting. Mitigation: the refusal names the hosted run and how to open it; a second terminal can host another.
- **The refactor touches the shell's run, gate and budget paths** (a D64 lease and resume area). Mitigation: the byte-identity harness, a differential check of the three commands before and after, and a separate security sitting.
- **Raw `Ctrl+C` semantics differ from the shell's** (two presses here, a SIGINT there). Mitigation: the hint says it, and the reference tables show both; new rows are owed to the Windows evidence runbook.

### Landing obligations

- **Code** (MVP-8 steps 2 and 3; [the plan](../roadmap/phases/phase-2.6-conversational-authoring.md#mvp-8-pre-flight-review-and-plan-2026-11-22)): the extraction of §1; the stale-gate-card fix in the engine's lease path with a two-engine SQLite test and a duplicate-sequence refusal in the in-memory store; a two-process gate-resolve test that closes the TOCTOU entry; `HostedRunLifetime`; the native cards; the run view; the controller's single screen slot and exit guard; the keymap rows with their table test.
- **References:** a section "Running a workflow in the Home" in [home.md](../reference/cli/home.md) (the canonical home of this contract); the run rows of the exit, signal and owner tables in [commands.md](../reference/cli/commands.md#exit-codes) (cross-linked, not copied); the interrupt table in [chat-session.md](../reference/cli/chat-session.md); an accessibility paragraph in [accessibility.md](../reference/cli/accessibility.md); new rows 17 and up in the [Windows interrupt-evidence runbook](../runbooks/windows-interrupt-evidence.md) (a hosted run's keys; collected with the owed rows 1 to 16).
- **Notes in place** on the ADRs named under *Amends*, each pointing here.
