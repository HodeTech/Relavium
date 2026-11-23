# `relavium` — Bare-invocation interactive Home

> Last updated: 2026-11-21

- **Status**: Reference — the Home surface is delivered by **2.5.B** (the bare-invocation Home, the read-only management strip over `history.db`, the single-ink-tree mode machine, one SIGINT/SIGTERM lifecycle, and bracketed paste); the in-app slash palette / `/help` / `/doctor` + the context-aware footer landed in **2.5.C**; and the reseat-less mode keymap (`Shift+Tab` / `/mode`) + the fail-closed per-tool approval + the `Esc` mid-turn abort landed in **2.5.E** ([ADR-0057](../../decisions/0057-cli-chat-modes-and-per-tool-approval.md)) — all **extend** this same canonical home. The Home-side **`/models` picker** landed in **2.5.G**: in the bare Home an accepted pick writes the global `[preferences].default_model` (+ the effort tier) for the *next* session ([ADR-0063](../../decisions/0063-cli-config-write-contract.md) §1, [ADR-0064](../../decisions/0064-live-model-catalog.md)); in the in-Home **chat** the same picker **reseats** the live session instead ([chat-session.md](chat-session.md#model-reseat-models)).
- **Surface**: CLI (a bare `relavium` with no subcommand, on a TTY; and a bare `relavium permissions` on a TTY, which opens this Home with the permissions sheet open)
- **Scope**: Phase 2.5, local-first. The Home is a thin surface over the **same** `@relavium/core` engine + `AgentSession` as `relavium chat` — it is a management + chat shell, never an IDE.
- **Related**: [commands.md](commands.md), [chat-session.md](chat-session.md), [../contracts/config-spec.md](../contracts/config-spec.md), [../contracts/agent-session-spec.md](../contracts/agent-session-spec.md), [../../decisions/0054-cli-bare-invocation-interactive-home.md](../../decisions/0054-cli-bare-invocation-interactive-home.md), [../../decisions/0049-cli-machine-output-contract.md](../../decisions/0049-cli-machine-output-contract.md), [../../decisions/0047-cli-framework-commander-ink-clack.md](../../decisions/0047-cli-framework-commander-ink-clack.md), [../../decisions/0024-agent-first-entry-point-agentsession.md](../../decisions/0024-agent-first-entry-point-agentsession.md), [../../decisions/0007-desktop-is-not-an-ide.md](../../decisions/0007-desktop-is-not-an-ide.md)

A bare `relavium` (no subcommand) on an interactive terminal opens a **branded, conversation-first Home**: a read-only **management strip** — recent sessions / runs / agents, with an *"Attention required"* section above a neutral *"Continue"* list — sitting over a live prompt. Type a message and the Home **graduates into a chat** in the same process; end the chat and you return to a freshly-read Home. The Home is the agent-first *"type the name → start talking"* entry ([ADR-0024](../../decisions/0024-agent-first-entry-point-agentsession.md)) that every terminal-native agent CLI offers, added **without** breaking the CLI's CI/automation contract. See [ADR-0054](../../decisions/0054-cli-bare-invocation-interactive-home.md) for the decision and rationale.

Bare Home uses the same [invocation filesystem-root contract](commands.md#global-options) and forwards its process-local authority into chat/resume. The [session reference](chat-session.md#filesystem-authority-and-resume) owns original-workspace resume and policy reuse.

## The TTY gate (when the Home opens)

The Home opens **only** when the process is genuinely interactive. The gate, evaluated in the existing bare-invocation branch of `run.ts` (**not** a `commander` default action, which would swallow unknown-command errors), is:

```text
stdoutIsTty && stdinIsTty && !json && !isCiEnv(env)
```

- Both `stdout` **and** `stdin` must be TTYs (the `stdinIsTty` seam is the one the `create` wizard already uses). A pipe or redirect on either end keeps the meta-op.
- `--json` never opens the Home (the machine contract wins).
- The CI guard reuses the existing `isCiEnv` helper ([output-mode.ts](../../../apps/cli/src/process/output-mode.ts)), which treats any **non-empty** `CI` other than `false`/`0` as CI (`CI=true`/`CI=1` count; `CI=false`/`CI=0`/empty opt out) — so a runner that sets `CI=1` or allocates a pseudo-TTY cannot accidentally open an interactive Home and stall the pipeline.

**Every non-interactive path is byte-for-byte unchanged**: a piped, `--json`, or CI bare invocation prints `program.helpInformation()` and exits `0`, exactly as before ([ADR-0049](../../decisions/0049-cli-machine-output-contract.md) — `--help` / `--version` / a bare no-command invocation are exit-`0` meta-operations). The Home adds a TTY-gated branch and **no** new IO surface.

A Home build/config fault uses the same [CLI failure classification](commands.md#failure-classification-and-remedies)
as a command: invalid config/invocation remains exit `2`, known operational faults
retain exit `1`, and an unexpected escaping throw uses the fixed `cli_internal`
projection and exit `9`, without its incoming message, cause or stack in that
projection. The legacy broad `internal` code is not remapped wholesale. Step 8d
implements caught Home/session fault integration and the complete fatal coordinator;
it is [independently accepted on `development`](../../roadmap/phases/phase-2.5.5-hardening-and-remediation.md#wave-3-step-8d-and-whole-step-8-acceptance--2026-10-17). This does not turn a
classified failed chat turn into a fatal CLI failure.

## Resume and Continue

`/resume` is available in the landing and the idle in-Home chat. It opens the
[native session picker](chat-session.md#finding-a-saved-session) while retaining
the current chat view. An empty landing prompt accepts Down to focus Continue's
recent sessions; Up/Down move, Enter resumes, and Esc returns to the prompt.
Typing or pasting into the prompt clears Continue focus before editing, so Enter
submits that draft rather than opening a previously focused session.
Only sessions are actionable in this increment. Session rows include a separate
sanitized directory line; management lists trim/scroll before the focused row,
keyless action and prompt can leave an 80×24 screen. No key/DB reads happen during
rendering or focus movement.

A saved session in another directory has a fixed open-Home-there/shell-picker
remedy; Home never reanchors its workspace. Safe restored history is prepared
before model/MCP build and activation, and a failed read offers retry/return.
Esc during restoration cancels the pending replacement host and its MCP startup,
preventing new credential/connection work. The existing Home or chat stays in place;
already-entered work and actual cleanup still join before the action returns.
An independent failure retains its original classification during cancellation.
Once a picker editor has been visibly mounted, filter typing, editing and paste
continue while its read-only results repaint under output backpressure. Enter,
result navigation, paging and scope changes still require the current result
card to be measured and flushed. A resize or new prompt invalidates editing
evidence too; suspension or loss of input custody blocks edits, and unseen input
is never buffered.
After selection the existing render-acknowledged effect disclosure remains the
activation boundary. The detailed projection, memory and hatch rules live in the
[chat reference](chat-session.md#proposed-restored-transcript-display--mvp-2).

## First-run onboarding wizard (2.5.G S8)

**Accepted on development — MVP-2 step 2 (2026-11-10).**
The Home mounts one Ink tree, then offers setup when no provider has a usable
source. Select, confirm, text and masked fields use the same native input owner;
existing chat history stays mounted while a setup card owns input. Native cards
require finite integer geometry of at least 80×24 and a fully visible current
card. Input and preference publication wait through resize until that card is
measured and flushed; a new snapshot or geometry change invalidates old evidence.
Esc/Ctrl+C closes the flow without leaving Home. Skipping leaves a persistent setup row;
Enter on an empty prompt or `/providers` opens it again. `/providers` is also
available in the in-Home chat, with connect/login/key discovery terms. Standalone
chat keeps its own palette and runs the shared setup before its normal host.
Native recovery messages name `/providers` in Home; standalone setup names
restarting `relavium chat`, where that shared setup is available.

The [credential-source contract](../contracts/config-spec.md#proposed-standard-environment-key-consent--mvp-2)
owns exact names, precedence, consent, backend-health distinctions and recovery.
Home samples availability on opening, after setup changes and on return from a
chat; rendering never probes the keychain. A usable source suppresses automatic
setup. An eligible standard source awaiting consent opens its named-source card;
a custom endpoint gets manual-key guidance instead. The `unavailable` state gets explicit acknowledgement/retry guidance. Backend
health remains independent of source status; a usable source still suppresses
automatic setup, and reminder state never grants credential authority.

Manual setup keeps the existing provider → masked key → validation/retry or
explicit save-anyway → OS-keychain flow. Native cards contain neither the key nor
its suffix, and validation copy comes from typed reasons. Before validation, both
Home and standalone chat show the safe origin (scheme, host and any non-default
port), without path, query or credentials, captured with the actual provider
adapter. A registry edit in another process cannot change that card's recipient
independently of its validation request. Restart Home/chat to use an externally
changed endpoint; the existing resolver keeps its original destination. An
invalid stored endpoint refuses validation and shows fixed recovery copy.
Private input is bounded, oversized paste is
rejected without truncation, and input after submit/cancel in the same dispatch
cannot become chat text or answer the next card. Actual validation work remains
owned until settlement even if its observation is cancelled.

First usable-source setup selects the provider's existing starter model through
the shared typed global writer. Existing-file rewrites display their comment/order
loss notice before publication. A saved preference with unconfirmed directory
sync says so; failure offers safe recovery, with a separately selected invocation
model where applicable. Explicit invocation defaults remain below project/workspace
model preferences. Connecting or replacing a key, or adding consent for another
provider, when one is already usable does not itself switch the default.
Provider cards name the currently usable source (OS keychain or the exact
environment-variable name), never its value or suffix. Resume keeps its saved agent/model.

Keys are never written to a config, transcript or plaintext fallback. A keychain
failure names the environment remedy; a later store failure does not falsely claim
that an already saved key vanished. Likewise, cancellation after a completed
key/default publication preserves its fixed committed outcome. The legacy injected
prompter remains a test/embedding seam; production Home and TTY chat setup use the
native host. Other shell scaffolding/gate prompts retain their existing contracts.

## Project initialization

**Accepted on development, MVP-2 step 3 (2026-11-10).**
`/init` is available in the landing and Home-chat palettes. Its card lists the
exact three directories before writing and defaults to **No**. Only an explicit
Yes creates them; Esc/Ctrl+C closes the card and keeps Home/chat. The existing
native input owner, complete-card visibility and resize/cancellation checks apply,
including at each directory publication. Existing chat history stays mounted.

The [shared init contract](commands.md#relavium-init) owns directory creation,
existing/nested projects, link refusal, cleanup and global-state exclusion. An
already initialized project produces a notice without a write confirmation or
repair. Global workflows/agents remain untouched; `/doctor` names the move/import
remedy. No unsolicited initialization prompt is shown.

## Running a workflow: `/run` (MVP-8 step 3, increment 5a, 2026-11-23)

**Built on `development`** (the strip row and the exit guard are [below](#leaving-the-home-while-a-run-executes-mvp-8-step-3-increment-5b-2026-11-23), the run view [after them](#the-run-view-mvp-8-step-3-increment-6-2026-11-23), and the gate and budget cards [after that](#deciding-a-parked-run-from-the-home-mvp-8-step-3-increments-7a-and-7b-2026-11-23)) ([ADR-0139](../../decisions/0139-a-workflow-run-is-hosted-inside-the-home.md) §2, §4, §7). `/run` is a Home command: it is in the landing palette, a typed or pasted `/run` at the landing opens it, and with a chat in front the line is the chat's (an unknown slash there) and starts nothing. It takes no argument. The launch is the same re-hosted core as `relavium run`, never a child process.

- **The picker** lists the project's workflows that parse (the catalog of [`relavium list`](commands.md#relavium-list)); a file that does not is **not offered**, and one line above the picker names it and says why. With no valid workflow the notice says so and no card opens. `Esc` and `Ctrl+C` leave.
- **The form** asks one field per declared input, in declaration order. Each value is checked as it is entered by the workflow's own validator (`resolveAndValidateWorkflowInputs`), so a wrong type or a value outside its enum is refused in the field; an empty answer to an optional input omits it. What the workflow author wrote (a description, a default) passes the sanitize floor. A `secret` input is a **masked field**: the value is held only by the prompt flow until the start call and is in no state, notice, history row or log line; `Esc` steps back one field and the value of the field returned to is dropped, `Ctrl+C` leaves, clears every masked value and starts nothing.
- **The confirmation** is a Yes/No select that **defaults to No**: an `Enter` typed ahead, held or repeated lands on No and nothing starts. It names the workflow and each input, a masked one by name only. A run starts only on a deliberate move to Yes.
- **The start is single-flight.** Answering Yes calls the run host once; a second confirmation in the same tick finds the launch past its confirmation and starts nothing, and the host itself turns away a second start while one is in flight. One engine is built for one run.
- **MCP consent.** A workflow that declares a local stdio MCP server the machine has not approved opens the **consent card** on the same prompt flow, before anything is spawned: `Ctrl+Y` allows and remembers the program on this machine (the per-machine grant `mcp-consent.ndjson` that `relavium run` writes), `Ctrl+N`, `Esc` and `Ctrl+C` refuse, and a refusal starts no server and no run. The card is the **only** prompt a hosted leg can open: its `io` reports non-TTY on purpose, so the gate's terminal check does not decide whether it may ask, the card does; with no card wired the gate refuses with the digest, as for a script. A resumed leg runs the same check and may open the same card ([below](#the-answer-the-resume-and-its-four-checks)).
- **Typing while a card is open.** A key or a paste the person types in the composer while a card is open reaches the prompt channel even when the card has not been painted yet, and counts toward the chord guard's quiet gap and typeahead window; a `Ctrl+Y` soon after it is refused. A key typed before any card opened is a composer edit, not typeahead.

## Leaving the Home while a run executes (MVP-8 step 3, increment 5b, 2026-11-23)

**Built on `development`** ([ADR-0139](../../decisions/0139-a-workflow-run-is-hosted-inside-the-home.md) §3, §6). Every way to end the Home is one request: `/exit` from the palette, the second `Ctrl+C` on the loaded landing, `Ctrl+D` on an empty prompt, `Ctrl+C` while the first chat is still being built, and the close of a bare `relavium permissions` sheet. With **no leg preparing, executing or cancelling**, the Home leaves exactly as it always did and shows no card. With one, it opens the **exit-guard card** and leaves nothing changed:

```text
A workflow run is executing: <run id>.
Leaving stops it, and a stopped run cannot be resumed.
Ctrl+Y stop the run and leave · Esc, Ctrl+C or Ctrl+N stay
```

- **Keys.** `Ctrl+Y` stops the run and leaves. `Esc`, `Ctrl+C` and `Ctrl+N` close the card and stay: a confirmation treats both interrupt keys as cancel and never as confirm ([ADR-0122](../../decisions/0122-the-home-is-the-interactive-product.md) §7.4), so at the card `Ctrl+C` is a cancel, not the second press of the interrupt keymap, and the keymap starts over once the card is closed. Every other key (a bare `y` or `n`, `Enter`, `Ctrl+D`, `Ctrl+Alt+Y`) and every paste answers nothing: the card stays open and nothing reaches the prompt behind it. The table is `interrupt-keymap.ts` and its table-driven test. The card replaces the prompt and the hint bar, and holds a notice back until it is closed. `Ctrl+Y` cancels a run for good, so it is a **deliberate** key like the other native cards': it counts only while the card's exact frame has been **measured and flushed at 80×24**, and not while a card the person just answered still holds the Home's **lockout** (one history shared by this card, the gate and budget cards and the MCP consent card, so a key held down through an answer cannot answer the next card on auto-repeat; every refused repeat restarts the window). `Esc`, `Ctrl+C` and `Ctrl+N` are never delayed. Below 80×24 the card is drawn in the resize degrade: `Ctrl+N`, `Esc` and `Ctrl+C` reach it there, and `Ctrl+Y` answers nothing (enlarge the terminal; with no card open the chords are not delivered below the minimum).
- **The grace and its two bounds.** After `Ctrl+Y` the card reads `Stopping the run…`. The Home asks the leg to stop (the engine's cooperative cancel) and waits for it to settle, re-reading its run host every 250 ms, for **at most ten seconds**, the engine's own grace window. A leg that settles first lets the Home leave at once. One that has not settled by then is **abandoned as the engine abandons a non-cooperative executor**: the Home runs the run host's teardown (`close`, which the Home's exit joins before it closes the shared database) and leaves. **`close` is bounded too**: it waits for the leg at most **three seconds more** (`HOSTED_LEG_SETTLE_BOUND_MS`, measured from the call). A leg whose work ignores the cancel and has not settled by then is **abandoned**: its owner stays registered, the invocation's finite-exit bound is armed (so the process ends, as it does for a signal), and the shared database is **not closed under it**, because the leg may still write to it: the handle is left to the process's exit. While it waits no key changes the wait, and a signal cuts it off with its own bound (below). The abandoned run keeps its lease for up to one TTL (sixty seconds), and the next start's reconcile settles it as failed; that is the outcome of a killed `relavium run`. So no path leaves the Home waiting without a bound: ten seconds for the leg, three more for the teardown, then the finite-exit bound.
- **After the screen is restored** the Home prints **one plain line** about a hosted run when one is owed: for the leg that ended with a workflow **safety fact** (money not confirmed `8`, an effect needing attention `7`, a held terminal `5`, taken over elsewhere `6`; the most serious one, which also sets the process's exit code), its headline and shell remedy, and for a leg it had to **abandon**, that the run was still stopping and the command that shows what happened. Each line names the run id and is a closed vocabulary plus that id, sanitized. A run that ended in an ordinary way (completed, failed, cancelled, paused) prints nothing: the screen already said how. The line is written with the Home's other end-of-run output (the resume hint), on stdout, except after an abandon, where the process is already ending and it is written to stderr.
- **A run that ends while the card is up** changes the card to `The run has ended.`; `Ctrl+Y` then leaves with nothing left to stop, and `Esc` stays. A first chat that finishes building while the card only asks takes the screen and closes the card; once the person confirmed, that chat is torn down instead of shown.
- **Signals** keep their process meaning ([ADR-0115](../../decisions/0115-one-interrupt-keymap-for-the-interactive-cli.md) §4): an external signal ends the Home on its own bound and stops the guard's wait.
- **The `▶` row.** While a leg is preparing, executing or cancelling, the strip shows one line under the heading: `▶ <run id>  ·  running  ·  Enter shows it`, `▶ <run id>  ·  cancelling  ·  Enter shows it`, or `▶ run  ·  starting` before the engine names the run (`Enter` at the empty prompt brings the run's view back once it has a name, and the landing's hint bar says so too: `/ commands · Enter shows it · …`). With no run active there is no row. It is a glyph and a word, so it reads with colour off; it takes one row of the strip's budget, so the Home still fits 80×24 with a full strip, a notice and a setup line. The Home re-reads the run host every 250 ms while a leg is live (and when an action that may have started one ends), publishes only what changed, and stops reading when none is live. The run view, a run's end and its disposition are [below](#the-run-view-mvp-8-step-3-increment-6-2026-11-23).

## The run view (MVP-8 step 3, increment 6, 2026-11-23)

**Built on `development`; the gate, budget and secret cards are [below](#deciding-a-parked-run-from-the-home-mvp-8-step-3-increments-7a-and-7b-2026-11-23), and the strip's note for a run that ended while another screen was in front is a later increment of the same step** ([ADR-0139](../../decisions/0139-a-workflow-run-is-hosted-inside-the-home.md) §3, §5; [ADR-0140](../../decisions/0140-management-browsers-the-run-drill-down-and-the-durable-run-detail.md) §1). A hosted run is shown by a **run view**: a screen of the Home's one `screen` slot, in front of the landing, drawn over the very `RunApp` projection that `relavium run` mounts, fed by the leg's own run store.

```text
▶ running  ·  run <run id>
<the live output: node rows, the active node's lines, tool lines, warnings, the cost footer>
note: <the newest of the run's notices>
Ctrl+C twice cancels the run · Esc leaves it running
```

- **The screen slot.** One optional `screen` of the Home controller, opened by `openScreen` and closed by `closeScreen` and nowhere else. It is opened only from the landing and refused while an overlay (the palette, the pickers, the `/permissions` sheet), the exit-guard card or a chat is in front. While it is open it owns every key, no overlay is open behind it, and a paste reaches neither it nor the prompt. The six older overlays keep their own fields; the tab host and the `/help` sheet will be kinds of the same slot.
- **How it opens.** A run started with `/run` opens its view at once. `Esc` leaves the view and the run keeps running; the strip's `▶` row is the way back: `Enter` at the empty prompt reopens the view of the run that is executing. With no run executing `Enter` does what it did (the provider setup when there is no key), and a card that was dismissed is not brought back.
- **The state is of the view's run, not of the host.** `starting`, `running`, `cancelling`, then one of `completed`, `failed`, `cancelled`, `paused`, `needs attention` (a run whose record or an external effect cannot be confirmed), `taken over` or `already settled`; and `not held` for a view whose run the host no longer holds (another run started or ended since). Each is a glyph **and** a word (`◌ ▶ ■ ✓ ✗ ⊘ ‖ ⚠ ○`), so colour is never the only signal. Another run executing never makes this view's run executing: a `Ctrl+C` in a view of a run that is not the one executing cancels nothing.
- **The ladder.** The first `Ctrl+C` with a leg executing only arms: the last line reads `Ctrl+C again cancels the run · Esc leaves it running`, and nothing is cancelled. A second `Ctrl+C` inside two seconds asks the leg for its cooperative cancel and the view reads `Cancelling · the run stops at its next safe point (up to 10 s)`; while it is cancelling, `Ctrl+C` is a hint only (`Waiting for the run to stop`) and arms nothing. Any other key, or two seconds, ends the armed state. `Esc` never arms and never cancels. With no leg executing (a disposition card, a parked run, a replaced run) `Esc` and `Ctrl+C` close the view and arm nothing. The second press is decided by the run's state **at that press**, read from the host again, so a run that ended between the presses is not cancelled. The table is `interrupt-keymap.ts` (`pressRunViewInterrupt`, `pressRunViewKey`) and its table-driven test.
- **The disposition card** is shown once the leg has ended: the headline and the remedy of `describeHostedRunTerminal` (a closed vocabulary plus the sanitized run id), and the reason a fault ended the leg, if one did. It stays until the person dismisses it with `Esc` or `Ctrl+C` or another run replaces it, and no other key touches it, with one exception: the card of a run that ended **paused** also takes `Enter`, which opens the run's gate or budget card ([below](#deciding-a-parked-run-from-the-home-mvp-8-step-3-increments-7a-and-7b-2026-11-23)) and says so on its key line (`Enter opens the gate · Esc / Ctrl+C close`). When the card cannot open (the run was answered elsewhere meanwhile, or its log cannot be read), the reason is the view's own newest `note:` row, and the key line reads `Enter tries the gate again · Esc / Ctrl+C close`; the note goes with the view.
- **Notices.** Everything the leg wrote to stderr (the withheld-effort, unpriced and legacy-hold warnings, the skipped-MCP lines, the departure diagnostics) is shown as `note:` rows: the newest three, each cut to 160 characters and sanitized again here, with `… N earlier notices` when there are more. The Home writes nothing to stderr while it owns the screen.
- **Geometry.** At 80×24 the screen is never more than 23 rows tall: the title, a status line when there is one, the live output in what is left (at least four rows; when it is taller than that its **newest** rows and its cost footer stay and the oldest node rows scroll off the top, and when it is shorter it sits at the top), the notices, the card (at most six rows) and the key line. It is the same screen in the full-screen and the inline renderer. Below 80×24 the screen is the enlarge line and the key line only (the key line says `Ctrl+C again cancels the run` once armed, so a person who cannot see the output still knows what the next press does), and only `Esc` and `Ctrl+C` are delivered.
- **Evidence owed.** The keys of this screen are rows 17 to 19 of the [Windows interrupt-evidence runbook](../../runbooks/windows-interrupt-evidence.md); none has been run on a Windows terminal.

## Deciding a parked run from the Home (MVP-8 step 3, increments 7a and 7b, 2026-11-23)

**Built on `development`** ([ADR-0139](../../decisions/0139-a-workflow-run-is-hosted-inside-the-home.md) §3, §4, §7). A run that pauses at a human gate or a budget gate **hands the run off** at the pause: its lease goes back and nothing holds it in memory, so it can be answered from this Home, from another terminal's Home or with `relavium gate` and `relavium budget resume`. The Home shows the runs of **this directory** that are parked as Attention rows, opens a **card** for one on a key, and answers through the run host's resume. A run recorded for another directory has no row and is never read or answered here ([§7](../../decisions/0139-a-workflow-run-is-hosted-inside-the-home.md)); it is readable in the History browser only.

### The Attention rows

```text
  Attention required
  > ‖ <run id>  ·  approval gate  ·  Enter opens
    ‖ <run id>  ·  3 open gates  ·  ↓ selects
```

- **One row per paused run of this directory**, newest first, at most eight, under *Attention required* and above the strip's own rows. A row is a glyph, the run id, what the run waits on (`approval gate`, `input gate`, `review gate`, `budget gate`, `<n> open gates`, or `parked, no gate to decide` for a run parked on a media job only) and the key. There is no row, no heading and no hint when nothing is paused. A run that has a row is **not repeated** by the strip's own gate rows or its *Continue* runs. A run whose event log cannot be read gets no row here: the strip's own `event log unreadable` line names it, and it has no card to open.
- **Keys.** At the empty prompt `↓` moves onto the first row, and the focused row (marked `>`) is the only one that names `Enter`; the others say `↓ selects`. `↑`/`↓` move along the rows, `↓` past the last reaches the *Continue* sessions and `↑` before the first returns to the prompt; `Enter` opens the focused run's card; `Esc` returns to the prompt; any other key (typing, a paste) ends the focus and is typed as usual. `Enter` on a row counts only once the frame that shows the focus is on screen, as it does for a session: a coalesced `↓` and `Enter` cannot open a row the person has not seen. The hint bar reads `↑/↓ select · Enter open the gate · Esc return to prompt · Ctrl+C twice to exit` while a row is focused.
- **When they are read.** When the Home opens, when the landing is shown again after a chat or a screen, when a card or the launch flow opens, and when a leg **starts or ends**. A flip in how the same live leg is described (a cancel was requested, the engine named the run) reads nothing. A read asks the log for the rows it keeps plus one (nine), never a chunk. A read that fails keeps the rows the Home has. A row whose run is no longer parked loses its focus. At 80×24 a long notice (a `/doctor` report) leaves the rows three lines (their heading, the gap under it and one row), so `↓` never focuses a row that is not drawn.
- **`Enter` on a run that is no longer parked here** (it was answered elsewhere, or belongs to another directory now) opens nothing and says so in the notice; on a run with no gate a card can show it says so and names `relavium status <run id>`.

### The gate card

```text
‖ waiting for you  ·  run <run id>
│ <the workflow author's message>
node <node id> · approval gate · expires <time>
Rejecting does not stop the run: the workflow routes on a rejection.
Ctrl+Y approves · Ctrl+N rejects · Esc leaves it pending
```

- **Opening it.** From an Attention row (`Enter` on the focused row), or from the run view of a run that ended paused (`Enter` at its disposition card). It is a screen of the one `screen` slot, in front of the landing or of the view it came from, and it reads the run's gates from the log at that moment. It holds them and does not read them again: a re-read after an answer would find the gate still pending until the resumed leg claims it, and offer it twice.
- **Chords only.** `Ctrl+Y` approves and `Ctrl+N` rejects, each only when the gate's own type accepts that decision; an `input` gate takes a typed value, which the card does not, so it offers `Ctrl+N` alone and names the `relavium gate <run id> --gate <gate id> --input` command. A bare letter, `Enter`, an arrow (with one gate), a chord with `meta` and a paste answer nothing; a paste counts as typing for the guard. With several open gates (a run can park on a human and a budget gate at once) the card lists them behind a cursor: `↑`/`↓` choose, an answer applies to the gate under the cursor and the others stay pending.
- **The same guards as every native card.** `Ctrl+Y` passes dwell, quiet gap, typeahead and lockout (the numbers of the approval card), and counts only while this exact frame has been **measured and flushed at 80×24**; the dwell restarts for each new frame (a different gate under the cursor, an answer that moved the cursor). `Ctrl+N` on a **human gate** passes the very same layers and the painted frame, because a rejection continues the run (the author routes on it): a bare or held `Ctrl+N` on a card whose frame has not been painted is refused, and a refused key restarts the lockout. A **budget abort** (`Ctrl+N` on a budget gate) is never delayed: it stops the step at the budget, and refusing is the safe answer. The lockout is the Home's one, shared with the MCP consent card and the exit guard: a key held through an answer cannot answer the card that follows. Below 80×24 the card is the enlarge line and the key line, and no chord is delivered.
- **`Esc` and `Ctrl+C` close it and decide nothing.** The gate stays pending and the row stays. `Esc` is the one step back: the run view the card came from, if any, is back in front. `Ctrl+C` closes the card **and** that view ([ADR-0139](../../decisions/0139-a-workflow-run-is-hosted-inside-the-home.md) §5) and returns to the landing. Neither can reject, because a rejection continues the run. `Ctrl+C` arms nothing here: a card is not a run to cancel.
- **One answer in flight.** The gate leaves the card the moment it is answered, so no key answers it twice, whatever the host replies; the card then says `Answered. The run continues in the background.` (the strip shows the resumed leg's `▶` row), or says what the host said: a refusal reopens the gate where it was with the host's words, and a gate that another process decided first is shown as `already decided` with what the log holds.
- **An overdue gate** shows `overdue`, its `expiresAt` and what the engine does at the deadline (approve, or fail the run with `run_timeout`); the card still answers, and the resume re-reads under the lease, so the answer and the deadline settle the gate exactly once in either order.
- **Author text is behind a gutter.** A gate message can interpolate model output. Every row of it is drawn behind `│ `, host glyphs and answer-chord tokens are removed from it and it passes the untrusted-text floor, so nothing in it can look like the card's own rows or keys.

### The budget card

```text
‖ waiting for you  ·  run <run id>
node <node id> · budget gate
Frozen allowance: $0.0420 (4200000 microcents)
Approval funds this agent execution only, for exactly this amount.
Aborting dispatches no agent and fails the run (budget_exceeded).
Ctrl+Y approves · Ctrl+N aborts · Esc leaves it pending
```

- **The amount is the gate's structured allowance**, the field the log froze (`budgetPromptContext` of the recorded quote), never a figure read from a message, a node name or an excluded notice. It is shown in USD and in integer microcents. `Ctrl+Y` approves **exactly that amount** (`approvedAmountMicrocents`), and `Ctrl+N` aborts (a rejection: no agent is dispatched and the run fails with `budget_exceeded`). Excluded candidate models are quoted behind the gutter, escaped, at most three, with a count of the rest.
- **Three cases.** (1) A **priced, representable allowance** offers both keys, as above. (2) A quote that **cannot be approved** (`unpriced`: no priced allowance; `unrepresentable`: it cannot be shown safely) says so, shows no amount and offers `Ctrl+N aborts` only. (3) A **legacy** gate with no frozen allowance says so and offers the abort only; the interactive `relavium run` prompt's "continue without an allowance" has no key here. With no approval offered, `Ctrl+Y` answers nothing.
- **A price that moved** is refused by the resume **before the gate is claimed**: the card reopens the gate with the host's words, it stays pending and abortable.
- **Same guard, same states** as the gate card: dwell, quiet gap, typeahead, lockout and the painted frame for `Ctrl+Y`; `Ctrl+N` never delayed; `Esc` and `Ctrl+C` decide nothing; an overdue budget gate shows `overdue` and its deadline (a budget gate records no timeout policy).

### The answer: the resume and its four checks

An answer is the run host's `resume`, the one resume core `relavium gate` and `relavium budget resume` share, started on a **fresh engine** as the next leg; the Home does not keep the run in memory while it waits. It opens the prompt flow for exactly as long as the leg prepares (a masked slot, the consent card), so one `busy` line (`Answering the gate…`) stands in for the card meanwhile, and a second prompt cannot open over it: with another prompt open the answer is refused (`busy`) and nothing is sent. The checks run in this order, and each refuses before the next costs anything:

1. **The project.** A run recorded for another directory is refused (`This run belongs to another directory. Open Home there to answer it.`) before an owner, an engine, a secret or a card exists.
2. **The decision fits the gate.** A decision the gate's type does not accept is refused before any secret is read.
3. **Each masked slot** of the run is asked for **once, by name**, in the Home's native masked field, in the order the run core names them. A blank value is refused by the Home's own port with fixed text, never passed on as "re-supplied"; `Esc` or `Ctrl+C` in a field leaves the whole answer and the gate stays pending. The value lives only in the prompt channel and in the resume call.
4. **The MCP consent check, run again.** A local program the run's servers want to start is checked against the machine's grants ([ADR-0084](../../decisions/0084-consent-before-a-local-mcp-spawn.md)): one this machine approved starts without a question, and one it holds no grant for (withdrawn, or the run was started on another machine or with a flag that approved it for one invocation only) is asked about through the **consent card**, which refuses by default and starts nothing when refused. A resume never skips the check on the ground that the run was started with `--allow-mcp-stdio`.

Then the engine re-reads the checkpoint under the lease: a gate already decided, or a run that already ended, settles the answer without building an engine, and for a budget gate the price is checked against the frozen quote before the gate is claimed.

- **Evidence owed.** The keys of the cards are rows 20 to 24 of the [Windows interrupt-evidence runbook](../../runbooks/windows-interrupt-evidence.md); none has been run on a Windows terminal.

## `/permissions` on the bare Home (MVP-4 step 7, 2026-11-21)

The landing palette offers `/permissions` (a line that reaches the Home as a paste, or typed with a leading space, does the same, since a `/` at an empty prompt opens the palette): it opens the permissions sheet docked under the Home with the project's remembered commands only, over a store opened afresh on every read, and closing it returns to the Home. While it is open it owns every key (the prompt and the footer are hidden, `Ctrl+C` closes it and arms no exit, PgUp and PgDn reach it, not a Home notice behind it).

A bare `relavium permissions` on a terminal (the gate above) starts this Home with the sheet already open, and without the first-run provider setup, and ends the run with exit `0` when the sheet is closed with `Esc` or `Ctrl+C`; it is the whole Home, so it opens the history database and inherits the Home's start-up refusals. Anywhere else (a pipe, `--json`, CI) the command group is unchanged.

Contract: [command-permissions.md](command-permissions.md#in-the-chat-permissions-a-sheet), [commands.md](commands.md#relavium-permissions).

## The management strip

The strip is a bounded, indexed aggregation over the durable `history.db` ([ADR-0050](../../decisions/0050-cli-history-db-at-rest-posture.md)), re-read on every return-to-Home — never a live subscription. Under [ADR-0122](../../decisions/0122-the-home-is-the-interactive-product.md), MVP-2 makes its recent sessions keyboard-openable (MVP-A24); the other rows remain displays until their management milestone lands. It never mutates anything on its own (the no-IDE-shell principle of [ADR-0007](../../decisions/0007-desktop-is-not-an-ide.md) applied to the CLI by analogy: management + chat only — no file tree, editor, or embedded terminal).

Before its first read the Home **reconciles** (2.6.G liveness): a run a dead process left `running` is settled and shows under *Attention required*, and a terminal held in the outbox is written. What is settled, how, and which runs are left alone are the rules `run` and `gate` follow, stated once with [exit code `5`](commands.md#exit-codes). The Home waits for this after the signal and exit nets are registered and before it mounts, so a crashed run whose lease has expired is settled before the first frame. A dead process's lease stays live for up to a minute after it died, and until it expires the run still shows as `running`; a later open settles it. Reconciling is best-effort and never keeps the Home from opening.

```text
relavium                                          ← branded header (bold)

  Attention required
    ⚠ deploy        · approval     · "Ship it?"  · expires in 5m
    ⚠ migrate       · review       · "LGTM?"     · expired          ← overdue ⇒ red
    ✗ nightly-build · failed       · 3h ago      · $0.0210

  Continue
  Sessions
    Plan the launch · planner · 5m ago · $1.2000
    chatter         · 12m ago · free                                ← untitled ⇒ agent slug once
  Runs
    deploy · completed · 2h ago · free
  Agents
    coder · 3d ago

> █                                                                 ← live prompt + cursor
/ for commands · type a message to start a chat · Ctrl+C twice to exit   ← footer hint (reads `Press Ctrl+C again to exit` once armed)
```

- **Attention required** — the **parked runs of this directory** first, each a row with the key that opens its card ([above](#the-attention-rows)); then pending **human gates** (ordered by their paused run's `created_at DESC`, a glanceable proxy for start time), then **failed runs** (most-recent first). An **overdue** (expired) gate is escalated yellow → red. A run that is failed or human-gated is **lifted** into this section and **never repeated** in *Continue*, and a run that has a parked-run row is not repeated by the gate rows either.
- **Continue** — the neutral recency lists: recent **sessions** (title or agent slug · agent · when · cost), **runs** (workflow or short id · status · when · cost), and **agents** (slug · last used), each bounded to a small limit.
- **First run** — when there is nothing to show, a welcome (value framing + an example prompt) replaces the empty strips.
- Every free-form label (a session title, a gate message) is sanitized at the display boundary (control sequences stripped, newlines/tabs collapsed) so it cannot forge a row or inject an escape; kebab slugs and closed enums are safe by construction. Cost reuses the canonical micro-cents → USD conversion (`free` for zero-cost).
- The aggregation is **indexed, not full-scan** (partial indexes on `updated_at`/`created_at` with the soft-delete predicate), and the pending-gate check reads only the gate-relevant events (the per-token streaming firehose is excluded), so the whole snapshot is a handful of bounded top-N reads — it over-fetches just enough to backfill *Continue* past the entries lifted into *Attention*.

A **session title** is derived from the first user message (~40 chars, truncated by code point so an emoji never splits) so the *Sessions* list is readable; an LLM-summarised title is a later phase.

## The mode machine (Home ↔ chat in one ink tree)

The Home and the chat render as **one ink tree with conditional rendering** — a single `useInput` owner — never two mounted apps, so the raw-mode owner never conflicts. The session state machine lives in a plain external store (`home-controller.ts`, unit-tested without ink); the ink component is a thin view that subscribes to it and forwards every key.

| Mode | What renders | Transition |
| --- | --- | --- |
| `home` | the management strip + the live prompt | a non-empty submit → `loading`; `Ctrl+C` twice → clean exit (`0`) |
| `loading` | the pending message echoed under `Starting chat…` | the deferred `buildChatSession` resolves → `chat`; it rejects → back to `home` with a banner |
| `chat` | the live chat region ([chat-session.md](chat-session.md)) | the chat ends (`/exit`, `/cancel`, or a second `Ctrl+C` inside the arming window) → back to a freshly-read `home` |

The chat session is built **after** the ink mount (an explicit loading state), so the strip shows instantly and a slow or failed build degrades to the loading state / a Home banner rather than blocking the entry. A built chat reuses the **built-in default chat agent** over `[chat].default_model` (the mode-gated editing/search grant plus `run_command`, which asks on a card in every mode except `auto`, where a command the person remembered or approved for the session runs unasked and anything else, a command on the repository's allowlist included, still asks — see [chat-session.md](chat-session.md)); the Home does not bind a custom agent (`relavium chat --agent <ref>` is the path for that).

Resume, model reseat and `/clear` retain the exact bound agent grant. `/clear`
uses that session's private fresh-builder closure, including an authored agent
named `relavium-chat` or an older read-only snapshot. It never identifies the
built-in agent by id. Each replacement resolves the current configured start
at its bound workspace and owns fresh approvals, read evidence and previews.


### Keymap (2.5.B)

| Key | `home` | `chat` | `loading` |
| --- | --- | --- | --- |
| printable | append to the prompt buffer | append (idle) / ignored mid-turn | ignored |
| Return | submit → start a chat | submit the turn (idle) / ignored mid-turn | ignored |
| Backspace / Delete | erase the char **before** the cursor | erase before the cursor (idle) / ignored mid-turn | ignored |
| **`/mode`** (MVP-3) | configure the startup default | choose current mode or separately save a startup default | — |
| **Shift+Tab** (2.5.E) | — | **cycle the chat mode** (ask → plan → accept-edits → auto), ADR-0057 | — |
| **Esc** (2.5.E) | — | **abort the in-flight turn** (mid-turn, EA7 — keeps the session; distinct from `/cancel`) | — |
| **`Ctrl+Y`/`Ctrl+G`/`Ctrl+O`/`Ctrl+N`/`Ctrl+R`/`Esc`/`Ctrl+C`** (2.5.E; chords since PR #99) | — | **answer a pending per-tool approval** — `Ctrl+Y` once · `Ctrl+G` (then Enter) always · `Ctrl+O` (then Enter, a command card only) remember for the project · `Ctrl+N` no · `Ctrl+R` no, with a reason · `Ctrl+C`, and `Esc` at the card, reject and stop the turn (`Esc` on the full view returns to the card; the card owns the keyboard; a bare letter answers nothing, so typing can never resolve it) | — |
| **↓ / ↑ / Enter / Esc** (MVP-8 step 3) | at the empty prompt with a parked run of this directory: `↓` moves onto its Attention row, `↑`/`↓` move along the rows, `Enter` opens the focused run's [gate or budget card](#deciding-a-parked-run-from-the-home-mvp-8-step-3-increments-7a-and-7b-2026-11-23), `Esc` returns to the prompt | — | — |
| **Ctrl+J** (2.5.D) | insert a newline (multi-line prompt) | insert a newline (idle) | ignored |
| **↑ / ↓** (2.5.D) | — | recall prev/next submitted line (buffer edge) / move by line (mid-buffer) | — |
| **Ctrl+R** (2.5.D) | — | reverse-incremental history search (chat only) | — |
| **`@`** (2.5.D) | append (no completion in the bare Home) | at a word boundary, open dir-navigable **file completion** → insert a `@path` marker + queue a **chip** that expands to UNTRUSTED context at submit ([ADR-0061](../../decisions/0061-cli-input-layer-file-injection-and-shell-escape.md)) | — |
| **`!`** (2.5.D) | append | a leading `!` runs a **shell command** through the same command card as the model's `run_command` (only a remembered grant that no file write has outdated, or an exact command approved for the session, runs unasked, and only in `auto`; the `[chat].allowed_commands` allowlist pre-approves nothing and only labels the card; [ADR-0118](../../decisions/0118-a-command-outside-the-allowlist-asks-instead-of-failing.md)) → `spawn` (`shell:false`); output shown read-only + queued as a **chip** carrying UNTRUSTED context to the next message ([ADR-0061](../../decisions/0061-cli-input-layer-file-injection-and-shell-escape.md)) | — |
| **`Esc`** (2.5.D) | — | at an **idle** prompt with pending `@`/`!` chips, **discard them** (else mid-turn abort) | — |
| **Ctrl+C** ([interrupt keymap](chat-session.md#the-interrupt-keymap--mvp-4-adr-0115)) | **arms** (the hint reads `Press Ctrl+C again to exit`, any draft stays while it is armed); a **second** press inside 2 s → **clean exit (`0`)**, and **a draft in the Home prompt is lost with the process** | **interrupts** the running turn (the abort `Esc` performs) and arms; at an idle empty prompt it arms; with a draft the first press **clears the draft** and arms nothing, the next press (now an empty prompt) arms, and a press inside 2 s after that → **`/cancel`**, end the chat, return to Home: **three presses from a draft**, two from an empty prompt | **bail out** (exit at once: nothing is loaded and nothing can be lost) |
| **Ctrl-D** (EOF) | **clean exit (`0`)** on an **empty** prompt (a non-empty buffer keeps it — no data loss) | — | **clean exit (`0`)** (the prompt is empty while building, so EOF bails the build like Ctrl-C) |

`Ctrl+C` is **always** an escape — it is honored even in the `loading` state (so a hung build is never an unkillable wedge), and leaving the loaded Home takes two presses, and leaving a chat takes two from an empty prompt and three from a draft, so one stray key cannot do it (`Ctrl+D` on an empty prompt still exits the Home at once). The Home keeps its draft through the first press and loses it when the second exits ([ADR-0115](../../decisions/0115-one-interrupt-keymap-for-the-interactive-cli.md), amended 2026-11-21). The reseat-less **mode keymap** (`Shift+Tab` + `/mode`) and the fail-closed **per-tool approval** landed in **2.5.E** ([ADR-0057](../../decisions/0057-cli-chat-modes-and-per-tool-approval.md); wired into the Home via the same `home-controller.ts` key routing — see [chat-session.md](chat-session.md)); the interactive `/` command palette landed in **2.5.C**. The **input ergonomics** (`Ctrl+J` multiline, `↑/↓` history + `Ctrl+R` search, readline motions) and the two data-moving affordances (`@`-mention file injection, `!`-shell command escape) landed in **2.5.D** ([ADR-0061](../../decisions/0061-cli-input-layer-file-injection-and-shell-escape.md)) — the `@`/`!` semantics are the SAME as the standalone chat (see [chat-session.md](chat-session.md#input-ergonomics-25d-adr-0061)).

The **footer hint-bar** in 2.5.B was the single fixed line; the context-aware hint-bar (the two or three most-relevant keys per context) landed in **2.5.C**, and the always-visible **active-mode footer indicator** (`formatSessionFooterWithMode`) arrived with **2.5.E** (ADR-0057) — together they extend that fixed footer.

## Bracketed paste (ink 7 native `usePaste`)

The Home receives a bracketed paste on **ink 7's native `usePaste` channel** (separate from `useInput`; adopted in 2.6.F, [ADR-0068](../../decisions/0068-full-screen-tui-renderer-ink7-harness.md)): ink enables/disables bracketed-paste mode (`ESC[?2004h`/`l`) automatically on mount/unmount and delivers the **whole paste as one event** (the `ESC[200~ … ESC[201~` markers stripped, and split stdin chunks reassembled). It is routed to `HomeController.handlePaste`, which appends the block **verbatim** — embedded newlines kept, CRLF/CR → LF — so a pasted multi-line block never submits early. A defensive `ESC[?2004l` is also written on the signal/exit teardown as belt-and-suspenders over ink's own unmount cleanup. Gate:

- **A paste appends ONLY when the main prompt is the active editable target** — dropped while a session **builds** (`loading`), a chat turn **streams** (`running`), a `!`-shell / submit is in flight, or any keyboard-owning overlay/submode is open (the `/` palette, `Ctrl+R` reverse-search, `@`-mention, `/models`, `/effort`, the `[c]` reason capture, the `/permissions` sheet). The gate is the shared `pasteIsEditable` predicate, so the Home and the standalone [chat](chat-session.md) can never diverge (a type-ahead queue while a turn runs is deferred — see the phase deferred list).
- **Security ([ADR-0057](../../decisions/0057-cli-chat-modes-and-per-tool-approval.md)):** a paste is dropped while a per-tool **approval is pending**, so a pasted approval token (`y` / `a` / `n` / … or a control byte) can **never** answer the fail-closed approval floor — paste arrives on the `usePaste` channel and is never routed to the approval key reducer.

## Render mode (inline / alt-screen)

A **branded banner** — a wordmark + tagline plaque — is drawn where the plain `relavium` heading otherwise sits, on a
fresh install: `[preferences].show_banner` is `true` (always) / `false` (never), and **absent** means *shown only while
the Home is empty*, so it greets a first run and auto-dismisses once there is anything to continue. It degrades to
plain ASCII under `NO_COLOR` / `--no-color`, and a forced banner stands down on a terminal too short to hold it beside
the strip. It is cosmetic and gates no feature.

The Home renders in one of two modes ([ADR-0068](../../decisions/0068-full-screen-tui-renderer-ink7-harness.md) §e): since Step 4b-3 the **default on a TTY is the full-screen alternate-screen renderer**, with the **inline** renderer (native scrollback, the screen-reader-friendly fallback) as the opt-out — **`--no-alt-screen`** ([commands.md](commands.md#global-options)) for one invocation, or **`[preferences].alt_screen = false`** ([config-spec.md](../contracts/config-spec.md)) durably. A non-TTY / `--json` / CI path is **always** inline (byte-identical). The alt screen renders the transcript through a resize-tracked **viewport** with **scroll-back + auto-follow** — **PgUp/PgDn** page, **Ctrl+Home/Ctrl+End** jump to top/tail, an upward scroll pauses the tail-follow and reaching the bottom resumes it (the scroll keymap is gated behind any keyboard-owning overlay) — and a per-entry wrap cache (keyed on the immutable transcript entry) keeps even a very large transcript cheap (Step 4b-3). The in-Home chat also carries the mouse **selection + copy-on-select** and the **`/scrollback`**, **`/edit`** and **`/copy`** copy-and-search hatches — the same code as `relavium chat` ([chat-session.md](chat-session.md)); the hatches are chat-only, so they never appear in the bare Home's palette. **Mouse reporting is armed only while the chat owns the screen**: the Home landing has no viewport to wheel-scroll and no in-app selection, so it keeps the emulator's own click-drag selection instead. The full-screen mode is inherently inaccessible to screen readers — see [accessibility.md](accessibility.md) for the trade-off and the inline-renderer escape hatch.

Both inline and full-screen interactive modes use the CLI's resolved output policy when mounting Ink.
An inline reseat keeps the existing terminal scrollback and displays the new store's entries once;
the root input owner stays mounted. The resume/reseat notice and retention ordering is defined in
[effect-journal.md](../shared-core/effect-journal.md#8-needs_attention).

## Minimum terminal size

Below **80×24** the landing shows `Terminal too small (WxH) — resize to at least 80×24.`
and a `Ctrl+C twice to exit` affordance. It suspends the management strip, prompt and overlays,
and refuses hidden typing, paste, Continue and palette activation using the live terminal
geometry. Esc and Ctrl+C/Ctrl-D cancellation remain available (`Ctrl+C` arms, then exits, as on the loaded Home). A resize restores the
existing input and selection. The resize is observed on stdout's cross-platform `resize`
event (backed by SIGWINCH on POSIX).

**MVP-3 Step 2 accepted on development (2026-11-12):** the same minimum and measured input
custody also apply inside the Home chat and standalone chat. Prepared-write
approval and `/details` share the
[chat interaction contract](chat-session.md#proposed-mvp-3-interaction-contract)
in both renderers; the full view and `/details` are one readable inspection screen
([ADR-0134](../../decisions/0134-the-full-view-and-the-tool-details-are-one-readable-inspection-screen.md),
[chat-session.md](chat-session.md#the-full-view-and-the-tool-details)). Tool details are chat-only; opening them executes no tool
and does not activate the management strip. Their bounded private previews
expire on teardown and are absent from restored history and transcript hatches.

At or above the minimum, management lists use the remaining row budget after the full
prompt, keyless action, errors and notices. The focused Continue session stays visible.
Strip labels truncate at the terminal edge; diagnostic notices and recovery instructions
wrap without dropping their source. Long notices show a range and **PgUp/PgDn** affordance
in both renderers. A new report or resize returns to its first page. Notice paging does
not submit input or change Continue focus, and yields to a keyboard-owning overlay.

## Signal lifecycle & exit codes

The invocation-backed Home shares **one signal lifecycle (SIGINT/SIGTERM/SIGHUP/SIGQUIT)** across the Home, pending/replaced chat hosts and MCP teardown. Its actual owners follow the [canonical invocation ordering](commands.md#invocation-owners-and-fatal-ordering); the synchronous native exit reap is a last-resort request, not a cleanup acknowledgement:

| Outcome | How | Exit code |
| --- | --- | --- |
| **Clean Home exit** | a second `Ctrl+C` inside the arming window / `Ctrl+D` or EOF on an empty prompt in `home` mode; or, for a bare `relavium permissions`, closing the sheet it opened (`Esc` or `Ctrl+C`) | `0` |
| **Signal-driven, without a stronger infrastructure fault** | an external SIGINT / SIGTERM / SIGHUP / SIGQUIT (`kill -INT`, closing the terminal window, a parent's signal) | `128 + signo` — **`130`** (SIGINT) / **`143`** (SIGTERM) / **`129`** (SIGHUP) / **`131`** (SIGQUIT); infrastructure faults follow the [canonical precedence](commands.md#failure-classification-and-remedies) |

An external signal stops admission and requests terminal restoration and cleanup of every actual host, including an in-flight build. Repeated signals share the original finite deadline and cannot restart cleanup or force an immediate second-signal exit. The physical exit backstop bounds the invocation; it does not certify terminal, MCP or database release. The shared database closes only after actual host/work settlement, and failed or held cleanup retains its owners and signal custody. Infrastructure faults may strengthen the final disposition; read the [canonical remedies](commands.md#failure-classification-and-remedies) before repeating uncertain work. The ownerless library compatibility path is not this product invocation lifecycle.

A keyboard Ctrl+C does **not** normally reach the process as SIGINT (raw mode), so the controller handles it through the one interrupt keymap (Home: arm, then `0`; chat: interrupt and arm, then `/cancel`). There is **one exception**: while a `/scrollback` or `/edit` suspension owns the terminal, ink has turned raw mode off and the kernel delivers a real SIGINT. That signal belongs to the hatch — the Home's handler drops it (`suspendPort.isSuspended()`), the hatch's own listener resumes the renderer, and the session survives. An external SIGTERM/SIGHUP/SIGQUIT still tears down, suspended or not.

A chat launched from the Home has its **own** exit code `4` ([chat-session.md](chat-session.md)) — but inside the Home that `4` is **consumed by the mode loop** (a chat ending returns to Home), **never leaked**. The Home's own exit code is `0` on a clean exit. See the canonical [Exit codes](commands.md#exit-codes) table.

## Recorded decisions / deferred surface

Settled in 2.5.B, recorded here as the canonical home (not re-litigated elsewhere):

- **In-flight build surface** — a slow `buildChatSession` shows a static `Starting chat…` loading state that echoes the pending message (the typed text never visually vanishes). A richer spinner is deferred; the `Esc` mid-turn abort (once a chat is built) landed in 2.5.E.
- **Attention ordering is a recency proxy, not a deadline sort** — gates are ordered by the paused run's `created_at DESC` (a glanceable proxy); true gate-recency / soonest-expiry-first would need the pending-gate read to carry the raise time. The renderer escalates an *expired* gate to red regardless of position.
- **Continue excludes lifted runs by status** — a failed or human-gated run lives only in *Attention*, never duplicated in *Continue*; the strip over-fetches to backfill *Continue* to its limit.
- **Landed since 2.5.B** — the interactive `/` palette UI (filterable, keyboard-navigable — 2.5.C S3b; the curated slash command set + the command-manifest shape are homed in [commands.md](commands.md)); the ask/plan/accept-edits/auto mode keymap + per-tool approval + `Esc` abort (2.5.E, [ADR-0057](../../decisions/0057-cli-chat-modes-and-per-tool-approval.md)); the input ergonomics + `@`-mention + `!`-shell (2.5.D, [ADR-0061](../../decisions/0061-cli-input-layer-file-injection-and-shell-escape.md)); the Home-side `/models` picker over the merged live/static catalog (2.5.G S7, [ADR-0064](../../decisions/0064-live-model-catalog.md) §10 — detailed in [commands.md](commands.md)); and the first-run onboarding wizard (2.5.G S8 — above).
- **Forthcoming, extending this doc** — an in-app message-queue/type-ahead while a turn runs (deferred, see [../../roadmap/deferred-tasks.md](../../roadmap/deferred-tasks.md)).
