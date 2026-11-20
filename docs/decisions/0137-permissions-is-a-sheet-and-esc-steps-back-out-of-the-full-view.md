# ADR-0137: `/permissions` is a sheet, and `Esc` steps back one level out of the full view

- **Status**: Accepted — 2026-11-20, by the maintainer, after the revision recorded at the end (three independent document reviews; each finding was checked against the code and the ADRs before it was applied or declined). Implementation: MVP-4 steps 5 to 7 (see Landing obligations). The D64 rigor tier and a separate security sitting apply to steps 5 and 6.
- **Date**: 2026-11-20
- **Decides**: the maintainer's request of 2026-11-20 that `/permissions` stop printing into the transcript and open as a keyboard-owning screen in front of the chat, that a granted permission can be taken back from it, and that the approval card's full view (`[v]`) leave by `Esc` the way the rest of the card's screens do.
- **Amends** (each with a dated note in place, written with this ADR): [ADR-0118](0118-a-command-outside-the-allowlist-asks-instead-of-failing.md) §2 (the chat's `/permissions` stops being a transcript notice with typed numbers and becomes the sheet; its Home sentence is answered by §3 here), [ADR-0115](0115-one-interrupt-keymap-for-the-interactive-cli.md) §2 (the clause that `Esc` rejects a pending call applies on the card, not on the full view) and §3 (its third table row; the alternative "`Esc` in the full view returns to the card first" is **not taken** there, in its words "outside what was decided on 2026-11-19", and is taken here), and [ADR-0134](0134-the-full-view-and-the-tool-details-are-one-readable-inspection-screen.md) §3 (the answer rows name the leaving key) and §5 (`b` is no longer the only way back).
- **Related**: [ADR-0110](0110-cli-diagnostics-and-discovery-have-explicit-compatibility.md) (a subcommand's interactive behaviour is listed in the compatibility table), [ADR-0122](0122-the-home-is-the-interactive-product.md) §4, §5, §7 and §9, [ADR-0129](0129-the-approval-card-is-docked-bounded-and-says-only-what-matters.md), [ADR-0064](0064-live-model-catalog.md) (the `/models` picker, the nearest list overlay), [ADR-0066](0066-normalized-reasoning-effort-control.md) (`/effort`), [ADR-0130](0130-chat-modes-ask-prompts-plan-reads-accept-edits-accepts.md) (what a remembered grant is worth in each mode). The reference contract that changes is [command-permissions.md](../reference/cli/command-permissions.md); this ADR cites it and does not restate it.

## Context

ADR-0118 §2 gave the chat a `/permissions` command that lists the commands remembered for this project and the ones approved for this session and revokes either by number. As shipped, it prints two numbered lists into the transcript and takes a typed `--revoke <n>` or `--revoke --session <n>`. Using it shows four faults.

- **It is a notice, not a screen.** The list scrolls away with the transcript, is stale the moment another process changes the file, and cannot be acted on where it is read.
- **A number is a position, not an identity.** Between the list and the revoke, another process can add or withdraw a grant; the number then names a different one (the command's own message says "the numbers have changed" for this reason). The remembered list also cannot tell two grants apart: the store keeps no command, so two entries read `npm, 1 argument` and differ only by date.
- **The bare Home has no `/permissions`.** The Home's palette leaves out chat-only commands, and ADR-0118 §2 left the Home's own screen for grants to MVP-8.
- **The card's full view takes the whole screen and `Esc` there stops the turn.** ADR-0115 §3 made `Esc` step back one level inside the card's text boxes and listed "`Esc` in the full view returns to the card first" among the alternatives it did **not** take, because the full view has `[b]` and the change was outside what was decided on 2026-11-19. A person who opened the full view to read a large change and presses `Esc` to leave loses the turn.

The retained UX notes (the peer research of 2026-11-08, the common-language analysis of 2026-11-18 and the full-view notes of 2026-11-17, kept as private analysis; products are not named, per the [documentation direction](../analysis/README.md#maintainer-documentation-direction--2026-11-15)) say, in terms that matter here:

- No terminal agent we read has a finished screen that lists the permissions a person granted and takes them back one at a time; the nearest has a tabbed rules dialog. Those that store grants and give no way to list or withdraw them, or leave withdrawal to a config file, are named as the thing to avoid.
- Every list-editing screen read deletes in two steps (arm, then confirm); none offers an undo. A destructive key bound to an exit key (`Ctrl+C`, `Ctrl+D`) went wrong twice.
- For reading a large request, every peer **enlarges** the view (a full-screen pager, a full-screen toggle on the same card) and none squeezes it into a smaller pane; for **deciding**, the complaint on record is a modal request that hides the context the person needs, and the answers were to draw the request in line and keep full screen on demand. Relavium already has that pair: a docked card and a full-screen view.
- Our own overlays already form a family: the palette, reverse search, `@` mention, `/models` and `/effort`, and the three cards are docked below the live region and own the keyboard, with the transcript above. The full view and the call list are the only screens that hide the chat. The family has four legend dialects and six meanings of `Esc`; a new screen written as a seventh would work against the common-language work still waiting on the maintainer's rulings.

[ADR-0122](0122-the-home-is-the-interactive-product.md) §7 binds every new screen: it works in the inline renderer, it reads with colour off, it works at 80×24, `Ctrl-C` and `Esc` close a non-approval overlay and never confirm or approve, untrusted text passes the sanitize floor, work is bounded.

### Rulings of 2026-11-20

| Question | Ruling |
|---|---|
| Where does `/permissions` open? | A docked bottom sheet (§1) |
| How is a permission taken back? | `d` or `Delete`, then `Enter`; any other key keeps it (§2) |
| What does `Esc` do in the full view? | Returns to the card; `Ctrl+C` stops the turn (§4) |
| What is in scope? | The sheet, the `Esc` change, the shared frame for the new sheet, and the Home entry points (Landing obligations). The Home's tab bar stays MVP-8's |

The rest of the text was set by this ADR and is accepted with it: the typed `--revoke` forms are removed (the application has no users to keep compatible), the per-surface wording, the verb **withdraw**, no opening mid-turn, and deferring a stored display line.

## Decision

**We will give `/permissions` a docked, keyboard-owning sheet; take a permission back from it by identity, in two steps; make `Esc` step back one level out of the full view and the call list; and build the new sheet on a small shared frame and legend builder, without migrating the older overlays in this change.**

### 1. A sheet is the docked overlay the product already has

A **sheet** is a keyboard-owning, bounded overlay drawn under the live region, in the same place and under the same rules as `/models`, `/effort` and the palette: the transcript stays above it and scrolls only while no sheet owns the keyboard; it works in the inline renderer; `Esc` and `Ctrl+C` close it and neither confirms anything.

It opens only while no turn is running and no card is open, as `/models` does (a turn's keystrokes are dropped, and the composer is the only way to type a command), so a card cannot arrive while it is open. If a host ever lets one arrive, the card wins: the sheet closes with its question dropped.

*Considered, and rejected:* **a popup in the middle** — the renderer has no layering, so it could only be composed by hand in the alternate screen and cannot be drawn at all in the inline renderer that [ADR-0122](0122-the-home-is-the-interactive-product.md) §7.1 keeps first-class; **a full-screen page** — it hides the context (the complaint above) and is heavy for a short list.

### 2. The permissions sheet

**Opens and arguments.** The bare `/permissions` opens the sheet in an interactive chat, in the standalone host and in the in-Home chat. `/permissions` takes **no arguments**: the typed `--revoke <n>` and `--revoke --session <n>` forms are removed, not kept as an alias, because a typed number is a position, because the sheet is where a session approval is seen, and because nothing depends on them. With an argument it prints the usage line (`Usage: /permissions opens the permissions sheet; press d on a row to withdraw it.`) and opens nothing. The script surface for remembered commands is `relavium permissions list|revoke`, unchanged, and it keeps the number caveat its reference page states. On a plain, `--json` or one-shot chat, which has no store and no one to ask, `/permissions` still says remembered commands are not available. The Home's entry points are §3.

**What it shows**, top to bottom: a title, the **This project · remembered (n)** section, the **This session · approved (n)** section (a chat only), one note row, one message row, the legend. There are **no row numbers**: the cursor is the selection, which removes the position fault.

| Surface | Title | Sections |
|---|---|---|
| A chat (standalone or in-Home) | `Permissions · <mode> mode` | project and session |
| The bare Home and a bare `relavium permissions` (§3) | `Permissions · this project` | project only |

*(Amended 2026-11-21: the wording of the notes, the empty states, the question and the answers changed after the step 5 reviews, because a session approval removes the card in every mode that asks and the first notes said less than that; the second implementation note below and [command-permissions.md](../reference/cli/command-permissions.md#in-the-chat-permissions-a-sheet) state the sentences as built.)*

The note row is one line, clipped to the width, and says what a grant is worth ([ADR-0118](0118-a-command-outside-the-allowlist-asks-instead-of-failing.md) §1): in `ask` and `accept-edits`, `Remembered commands still ask here; only auto mode runs one unasked.`; in `auto`, `Auto mode runs a remembered command unasked, and asks once after a file write.`; in `plan`, `Plan mode refuses every command; nothing here runs.`; with no chat, `A remembered command runs unasked only in auto mode, in a chat opened in this project.` An empty project list says what to do (in a chat, `Nothing is remembered for this project. Press Ctrl+O on a command card to remember one.`; without a chat, `Nothing is remembered for this project. A command is remembered from its card in a chat (Ctrl+O).`); an empty session list says `Nothing is approved for this session.`

**Rows.** A remembered row shows the label the store can honestly give (`npm, 1 argument`, or `(unnamed program)`) and the date. A session row shows the approved command, quoted and **scrubbed by the same function the command card's title uses**, and falls back to the label where that function would mask the whole argument list. A session row a *Remember* created, or one a remembered grant covers now, is marked `(also remembered)`. Every row passes the card's escaping and is clipped to the width with `…` by display width, so an argument cannot imitate the sheet's marker, its headings or its legend. The window is at most eight body lines (headings, rows and markers), with `▲ n more` / `▼ n more` markers that count the rows they stand in for (new; the picker's bound is the same but it draws no markers).

**Never edits, never adds.** A grant is a keyed digest of an exact argv; there is no command to edit, and adding one from a sheet would approve a command no card showed. The only action is to **withdraw**.

**Keys.** `↑`/`↓` move and clamp at the ends; `PgUp`/`PgDn` and `Home`/`End` are this sheet's own (the model picker has only the arrows). `d`, `Delete` or `Backspace` **arms** the selected row (a terminal's Delete key reaches the application as either of the last two, and the sheet has no text field to make them differ). `Enter` withdraws the armed row. Armed, any other key, a paste, and `Esc` disarm without withdrawing; a second `Esc` closes the sheet, one level per press. **`Ctrl+C` closes the sheet from either state and never withdraws.** Neither `Esc` nor `Ctrl+C` ever confirms. The legend follows the state: unarmed `↑/↓ select · d withdraw · Esc close`; armed `Enter withdraw · Esc keep`. This is the shape of the command card's *Remember* (a key, then `Enter`) and of every peer's delete (arm, then confirm); withdrawing only ever makes the chat ask **more**, so it is not timed like a consent, but the two steps alone do not guard a stray key typed ahead of the sheet (a typed line that ends in `d`, then `Enter`, is two steps): see *The clock* below.

*Considered, and rejected:* a single key (a person who types `/permissions`, `Enter` and goes on typing could withdraw a grant by accident), a gap-based clock alone (see below), and `Ctrl+X` then `Enter` (an unfamiliar chord for no reason: the sheet has no text field for a letter to collide with).

**Typing, and the clock** (added after the step 5 security sittings, 2026-11-20 and 21). A gap between keys cannot tell typing from choosing: the card learned that at 350 ms a key (PR #99), and a first, gap-based version of this rule was beaten by a typist at human pace in the second sitting (28–44 % of a slow typist's lines ending in `d` withdrew row 1). So the rule is about *what* was typed. Once any key that is not navigation has arrived since the sheet opened, `d` arms nothing until an arrow key (or a page key, `Home`, `End`) says the person is choosing a row; a refused `d` says so. On top of that `d` waits 400 ms after the sheet opened (an early `d` says to wait and is not typing), and `Enter` withdraws only between 300 ms and 10 s after the question appeared, and only unmodified (an `Esc` then `Enter` inside a terminal's escape window arrives as `Meta+Enter`); an `Enter` outside that window drops the question with a note. A paste is typing. The values are named constants and the clock is injected, as the interrupt keymap's is. A question already asked when the terminal shrinks below the floor is dropped by the next key, and `Esc` then closes.

**The message row** always exists, empty or not, so a state change never moves a row. Arming puts `Withdraw <row>? Any other key keeps it.` there (the legend says `Enter withdraw · Esc keep`), with `<row>` the project row's label and date, or the session row's scrubbed command clipped so the question and its keys always fit. A result says what was withdrawn and says nothing mode-blind (there is no "it asks again"):

- a project row: `Withdrew <row>. Auto mode asks about it again.`, and ` This chat's session approval of it went too.` when one did;
- a session row: `Withdrew the session approval for <row>. Auto mode asks about it again.`, or, when a remembered grant covers the command now, `Withdrew the session approval for <row>. It is also remembered for this project, so auto mode still runs it unasked: withdraw that row to stop that.`;
- a row that is already gone: `That row was already withdrawn.`, and the sheet reloads.

**Failures.** The store can report `no-key`, `unreadable`, `unwritable` and `full`. When it cannot be read, the project section shows the fixed text `chat-permissions` has today for that reason (`The OS keychain is not available…`, `The remembered-commands file could not be read…`) instead of rows, and the session section still works; where the chat has no store the section says `not available in this chat`. A withdrawal that cannot be written leaves the row, shows the fixed text for `unwritable` or `full` in the message row, and changes nothing else. A bare `relavium permissions` that cannot read the store opens the sheet with that text and exits 0 on close; the `list` and `revoke` subcommands keep their exit codes.

**Height and the floor.** The sheet takes at most three fifths of the terminal's rows and never so many that fewer than eight transcript rows remain, the card's own rule ([ADR-0129](0129-the-approval-card-is-docked-bounded-and-says-only-what-matters.md) §2; twelve rows at 80×24). The title, the legend and the message row are always drawn and the selected row is always visible; the note row is the first to go when the budget is short, and the window gets the rest, from one row to eight. A row, a note and a message longer than the width are clipped. Below the 80×24 floor the sheet draws its title, `Enlarge the terminal to use this screen — Esc closes.`, and the legend; `d` arms nothing, because a withdrawal is never asked for in a frame that cannot show the question.

**Withdraw by identity.** A project row is held by its grant `id`, a session row by its exact argv, the key the session cache uses. Before a project withdrawal the store is read again; a session withdrawal reads the cache again. The store gains `revokeById(id)` beside the by-number operation: it resolves the grant that **contains that `id`** — two live records for one argv are one grant ([command-permissions.md](../reference/cli/command-permissions.md)) — and tombstones **every** record of it, as `relavium permissions revoke` does by number. The session cache gains a withdraw-by-argv beside the by-index one. Withdrawing a project row also takes this chat's linked session approvals with it (by grant id, as today); withdrawing a linked session row leaves the project grant.

**No reveal.** A remembered row never shows an argument; the store keeps none ([ADR-0118](0118-a-command-outside-the-allowlist-asks-instead-of-failing.md) §2, "Never the command"). A session row does show its command because it is in memory and the person already saw it, in full, on the card that approved it; writing a display line to disk is a different act, with the heuristic scrub as its only guard. Showing one in the store, which would let two `npm, 1 argument` rows be told apart, is **not decided here** and needs its own security reading.

### 3. The Home reaches the same sheet

The bare Home gets `/permissions`, which opens the same sheet over the Home with the project's remembered commands only (§2, the project-only surface). A bare `relavium permissions` on a TTY, a command group today that prints its help, opens the sheet before any host mounts, as `relavium chat resume` opens the session picker ([ADR-0122](0122-the-home-is-the-interactive-product.md) §5). Non-TTY, `--json` and CI keep the group's help and the `list` and `revoke` subcommands with their exit codes. Per [ADR-0110](0110-cli-diagnostics-and-discovery-have-explicit-compatibility.md) the compatibility table in [commands.md](../reference/cli/commands.md) lists the bare form for each of those cases. The **tab bar** of MVP-8 (workstream 2.6.G) is not built here. When it is, its `/permissions` tab **composes** this sheet (withdraw-only for command grants) with the 2.6.G sections for domain allowlists, MCP servers and egress endpoints, which own add and remove; the component is shared, the tab is MVP-8's. One component, several hosts.

### 4. `Esc` steps back one level out of the full view and the call list

During an approval, `Esc` on the full view returns to the card, and `Esc` on the call list, where an approval review shows it, returns to the card. Nothing else about the approval changes:

| Where | `Esc` (replaces the third row of [ADR-0115](0115-one-interrupt-keymap-for-the-interactive-cli.md) §3; §2's rejection applies to the card) |
|---|---|
| A text box of an approval review (the reason box, the full view's search box) | Unchanged: close the box and return to where it opened; the call stays pending |
| The full view or the call list of an approval | **Return to the card.** The call stays pending and nothing is answered. `[b]` stays an alias |
| The card, no box open | Unchanged: reject the call and stop the turn |
| An `ask_user` card, no field open | Unchanged: stop the turn ([ADR-0115](0115-one-interrupt-keymap-for-the-interactive-cli.md) §3) |
| A details view with no approval pending | Unchanged: close the whole screen; `[b]` goes back to the list, which is why this row is an exception to "one level" |

So a person leaves the nesting one level per press: search box, full view, card, then the press that stops. `Ctrl+C` is unchanged and stops from anywhere ([ADR-0115](0115-one-interrupt-keymap-for-the-interactive-cli.md) §1); `Ctrl+N` still denies without a visible frame. `Esc` still never approves. It is an ordinary navigation key: it invalidates the frame, so every answer that grants something waits for a new drawn and acknowledged frame ([ADR-0129](0129-the-approval-card-is-docked-bounded-and-says-only-what-matters.md), [ADR-0134](0134-the-full-view-and-the-tool-details-are-one-readable-inspection-screen.md) §7), and it counts as a foreign key like `[b]`, so an affirmative answer right after it waits out the guards.

**What the legends say.** Every place that names `Esc` is updated together, because the stop key must stay named wherever it works:

- the full view's second answer row, `[Ctrl+N] Deny   [b] Back to the card   Esc back   Ctrl+C stops the turn` (it fits 78 columns); the search box's rows are unchanged;
- the call list's hint under an approval, which says `Esc back to the card` (with no approval it keeps `Esc closes`);
- the hint of an unreadable frame, by screen: the card's `[Ctrl+N] denies · Esc stops the turn.` is unchanged; the full view's is `[Ctrl+N] denies · Esc back · Ctrl+C stops the turn.`;
- the card keeps `Esc stops the turn`, and as ADR-0129 requires, the controls line is never the row that is dropped.

**The Home's routing** of a card key must treat the new back result like `[b]` and never as an abort; a host test pins it, because a wrong mapping would end the turn silently.

*Considered, and rejected:* **leave `Esc` as the stop key there** — the cost is a lost turn for a person who only meant to close a screen, the cost ADR-0115 already removed from the card's boxes, and the reading screens of the peers close without deciding; **make the full view a true bottom sheet over a visible transcript** — a sheet would leave the diff about six rows at 80×24, where the full view has 14 to 17 body rows today ([ADR-0134](0134-the-full-view-and-the-tool-details-are-one-readable-inspection-screen.md) §3), and puts the measured-frame acknowledgement and the "a frame is never as tall as the terminal" rule at risk for a reading task where every peer enlarges. A taller terminal showing a few rows of the transcript above the full view is a possible later decision, not taken here.

### 5. A small shared frame, used first by the new sheet

The new sheet is built on a small, pure **sheet frame** (a title row, section headings, a windowed row list with markers, a note row, a message row, a legend row) and a single **legend builder** whose key list comes from the constants the reducer reads, so a hint cannot drift from its handler. The full view does not share the component: it takes its title, status, message and legend **text** from the same constants and the same builder, so the two screens read as one family. The first consumers are therefore the new sheet (frame and builder) and the full view (constants and builder).

For the screens this ADR builds, it adopts the legend grammar of the common-language draft: dim, ` · `-separated, `Ctrl+X` with a plus, the leaving key last, the verbs Close and Back. It rules nothing else in that draft. If the common-language rulings later change a word, the strings change and the structure stands. **Not migrated here:** `/models`, `/effort`, the palette, reverse search, mention and the session picker keep their own footers; moving them is the common-language increment, which comes after this one so the strings their tests pin change once. No new bracketed key token is introduced; if one ever is, the host-glyph and key-token guards of the question card are widened with it.

### 6. Not decided, not done

- Opening the sheet during a running turn (a peer does; a card can then arrive and compete for the keyboard).
- A display line for a remembered command in the store (§2, "No reveal").
- A section for the repository's `[chat]` allowlist (it only labels the card in a chat now) and for domain allowlists and MCP consent (MVP-8 and MVP-9).
- A withdraw-all key in the sheet (`relavium permissions revoke --all` stays the one place).
- The verb across surfaces: the sheet says **withdraw**, the command keeps its name `revoke`, and the shipped words **approved** (a session) and **remembered** (a grant) are kept; the common-language ruling may rename them, and the glossary entries are part of landing this.
- The desktop and the VS Code extension: the sheet's intents (select, withdraw, close) are surface-neutral and map to a list with a withdraw action there; nothing is built for them here.

## Consequences

### Positive

- A granted permission can be read, judged and taken back where the person is looking, with the transcript still visible, and the sheet cannot name the wrong grant.
- The bottom sheet is the overlay shape the product already ships: no new geometry, no new renderer path, no inline-renderer exception.
- Reading a large change and leaving it no longer risks the turn; the stop is one press further, and the legend says which press it is.
- The first screen written on a shared frame and a single legend builder gives the older overlays a place to move to, without touching the strings their tests pin now.
- No peer we read offers this screen; the withdraw step uses the one pattern every peer converged on.
- With the typed forms gone there is one way to withdraw in a chat, and the chat never prints a list of numbers that can go stale.

### Negative

- **The remembered list still cannot tell two same-program grants apart** (date only). The sheet makes that visible instead of hiding it in a transcript. *Mitigation:* the session rows show the scrubbed command; the stored display line is a separate decision with its own security reading.
- **`Esc` in the full view changes an approval-path key** and a sentence a person may have learned ("`Esc` there stops the turn"). *Mitigation:* `Ctrl+C` and `Ctrl+N` keep the fast ways out and the legends name them; `Esc` still never approves; the D64 tier applies.
- **Many tests assert `Esc stops the turn`** (eleven test files when this ADR was accepted, the host test file alone with 70 hits), and the full view's legend and reference pages change. *Mitigation:* recount at landing, update them with the change, and let the mutation sweep check the rewritten assertions still fail under a deliberate break.
- **Two screens write their chrome from one set of constants while the older overlays do not**, a visible half-migration until the common-language increment moves them. *Mitigation:* the new frame has one consumer, the full view takes text only, and the migration order is recorded in the plan.
- **A new overlay is a new keyboard owner.** It must be gated against paste, the mouse wheel, terminal suspension and the measured-frame paths the way `/models` is. *Mitigation:* the picker tests (`chat-picker-stop`, `native-picker-input`) are the template.
- **The scrub function is not exported from the core today.** The session rows need it, so a small pure function joins the core's public surface. *Mitigation:* it is the function the preview already runs, moved behind an export, not new behaviour.

### Landing obligations

- **Tier (D64).** The sheet touches the remembered-command store, a consent path its withdrawal only narrows: a rigor pass (one new complete cumulative round with no blocker, high or medium finding) and a separate security sitting. The `Esc` change is the approval path itself: the same, in its own increment with its own sitting.
- **Order (the maintainer's, 2026-11-20).** **Step 5**, the sheet: `revokeById`, the session withdraw-by-argv, the reducer, the view, the frame and the legend builder, the core export of the scrub, the removal of the typed forms, the wiring in both chat hosts, and the references. **Step 6**, the `Esc` change: the reducer row, the three legends, the Home routing, the tests and the references (its own review rounds and sitting). **Step 7**, the Home entry points: the bare Home `/permissions` and the bare `relavium permissions` on a TTY, with the compatibility row. The Home's tab bar and the composed pane stay MVP-8's; the roadmap records that so the phase is not started without it.
- **References and pointers.** [command-permissions.md](../reference/cli/command-permissions.md) (the `/permissions` section), [chat-session.md](../reference/cli/chat-session.md), [home.md](../reference/cli/home.md), [accessibility.md](../reference/cli/accessibility.md) (inline parity of the sheet), [commands.md](../reference/cli/commands.md) (the grammar, the typed forms' removal and the ADR-0110 compatibility rows), the glossary (sheet, withdraw), the [interrupt-evidence runbook](../runbooks/windows-interrupt-evidence.md) (a new row for `Esc` and `Delete`, which it does not list today), [current.md](../roadmap/current.md), the phase record's MVP-4 table and its 2.6.G permissions bullet, and the dated amendment notes in ADR-0115, ADR-0118 and ADR-0134.
- **Tests that must exist.** The sheet's reducer (selection, window, arm, confirm, disarm, `Esc` ladder, armed `Ctrl+C`, `d` with nothing selected, `Delete` and `Backspace`, a paste while armed, the cursor after a reload), the host (focus, paste, wheel, suspension, one overlay at a time, a card arriving), the store (withdraw by `id`, a row gone between read and withdraw, twin records, the linked session approval, an unreadable store, an unwritable store), the session cache (withdraw by argv), renders at 80×24, inline and colour-off, with a long label, a long command and a long message, and the floor's refusal to arm; for the `Esc` change every row of §4's table, that `Esc` from the full view never answers, that the frame must be acknowledged again after it, the three legends, the Home's routing as a back and not an abort, and that `Ctrl+C` and `Ctrl+N` still do what they did. The two screens reading the same constants, and the sheet's legend reading the reducer's key constants, are asserted.
- **Evidence still owed.** Windows `Esc` and `Delete` behaviour in the terminals the interrupt runbook lists.

### Revision note — 2026-11-20

Three independent document reviews read the proposed text. Each claim was checked against the code and the ADRs before it was applied. Applied: the title and the first paragraph no longer say the full view is a sheet (it is not; only its text shares the family); the typed `--revoke` forms are removed instead of kept "for scripts" (a slash command is not a script, and the session numbers would no longer be printed anywhere); the full view's answer row, the call list's hint and the unreadable-frame hint keep the stop key named; the controls-line rule is quoted from ADR-0129 instead of weakened; session rows are held by argv and twin grants are withdrawn together; the surface-dependent texts, the failure states, the height budget and the floor are written; the armed `Ctrl+C` is defined; the amendment list now includes ADR-0115 §2 and §5's table-driven test, ADR-0118's Home sentence and ADR-0134 §3, and the attributions are corrected (ADR-0118 §2 names the list and the revoke, the notice is the shipped form; ADR-0134 has `b` back in §5 and the answer rows in §3; ADR-0115 says "not taken", not "rejected"); the 80×24 body rows cite ADR-0134 §3; the milestone order, the Home scope and the common-language dependency are written down; the rulings are tabled. Declined, with reasons: renaming **approved** to **allowed** (the shipped docs, the code and the store use "approved", the common-language ruling is still open, and a rename belongs to it); a legacy list form for the typed numbers (no one uses them, so there is nothing to keep compatible); treating the `Esc` change as a supersession of ADR-0115 (the ADR did not decide it, it set it aside as out of scope, so it is a refinement).

### Implementation note — 2026-11-20 (MVP-4 step 5)

The sheet, the identity withdrawal, the shared frame text and the legend builder are in. Where the code settled what the text left open:

- **The typed forms are rejected by the dispatch's own rule**, not by a custom usage line: `/permissions` declares no flag and no positional, so `/permissions --revoke 1` is `/permissions: unknown argument '--revoke'.` before anything runs. The sentence the ADR named is the generic one every zero-argument command gives.
- **Answers are short enough to be read whole in one 80-column row** (the message row is one row, clipped). A project answer names the label (`Withdrew npm, 1 argument. Auto mode asks about it again.`, with ` Its session approval went too.` when one did); a session answer does not repeat the command, which has just left the list (`Session approval withdrawn. Auto mode asks about it again.`, or `… Still remembered: auto mode runs it unasked.`). The failures have a short form for the message row beside the long one the project section shows.
- **A remembered row shows the minute, not only the date** (`2026-11-19 12:00Z`, UTC), so two grants of one program on one day can still be told apart. A withdrawal's question keeps that time and clips the label to make room for it: `Withdraw npm, 1 argument (2026-11-19 12:00Z)? Enter withdraws · Esc keeps it`.
- **A session row always shows the scrubbed command**: the scrub's own fallback for a command it cannot mask element by element is `program [redacted]`, which is already the safe form, so the label fallback §2 mentioned was never needed. Every row, remembered or session, passes the card's character escaper, so a `<`, a bidi override, an invisible character or a tab is a visible token.
- **`Delete` and `Backspace` both arm**: ink reports a terminal's Delete key as one or the other, and the sheet has no text field to tell them apart. The runbook gains row 14 for the terminals to record which arrives as which.
- **The Home controller is told the terminal size** (`setTerminalSize`, from the host on every resize), because the controller reduces keys without it and the sheet needs to know whether it can show the question. Until told, it assumes a terminal that can.
- **`scrubbedCommandDisplay(argv)` joins the core's public surface** as one pure function over the scrub the preview already ran; the test compares it with the preview of a real request for each form of the oracle corpus.
- **The sheet opens in the standalone chat and the in-Home chat.** The bare Home and the bare `relavium permissions` are step 7.

### Implementation note — 2026-11-20 (MVP-4 step 5, review round 1)

Three independent reviews of the committed step (a security sitting on Opus, correctness and test adequacy, UX and documentation truth) found the following, each probed before it was fixed:

- **The two steps did not protect a typed-ahead line** (security, medium): `/permissions`, `Enter`, then keys typed without a pause, ending in `d` and `Enter`, withdrew the first row. The sheet's keys are now timed (*The clock* in §2), and an `Enter` with `Meta`, `Ctrl` or `Shift` held no longer confirms.
- **A terminal that shrank while a question was up** left `Enter` live in a frame that hid the question; a key now drops it and `Esc` closes.
- **`sanitizeInline` ran before the sheet's escaper**, so a bidi override, a tab or an escape was deleted instead of shown, two different commands could look alike, and a secret split by a control character was shown after the scrub had missed it. The strip is gone and the sheet escapes every row and the message row. The control-split secret is the card's own property (its title is scrubbed the same way and shown to the person in full); it is recorded in the deferred register.
- **`(also remembered)` and the answers read a stale link**: a Remember's link to a grant that had been revoked elsewhere still said the grant covered the command. Both now ask the store (`matches`) and name only `auto`; a project withdrawal says when a plain session approval of the command remains.
- **The answers are shorter** (a project answer no longer repeats the label, so it fits the row whatever the label) and the question no longer repeats the legend.
- **The markers counted lines, not rows**, and a heading could sit alone above `▼`; they now count rows, the row under the marker included.
- **The window is eight body lines, not eight rows**, the sheet is capped at 100 columns, a wide character that straddles a cut is no longer counted over the width, a command is cut to 400 characters once at load (a megabyte argument was measured on every key), and the note is always drawn (the floor leaves room for it, so "the first row to go" never happened).
- **The Home gets the card-wins close** the standalone chat had; a port that throws on `load` no longer takes the input handler with it.
- **The shared frame is a module now** (`sheet-frame.ts`: line roles, width, clip, flush row, window), with the legend builder beside it; the older overlays are not moved.
- **Declined:** a withdrawn row whose id was tombstoned while a twin record stays live reads "already withdrawn" once and the reload shows the grant again under the twin's id (recorded, low); and a heuristic masker for control-split secrets in the shared scrub.

### Implementation note — 2026-11-21 (MVP-4 step 5, review round 2)

A second, new and complete round (a security sitting on Opus, correctness and test adequacy, UX and documentation truth; every claim probed) found two mediums and a run of lows; each was reproduced before it was fixed.

- **A typed line at human pace still withdrew** (security, medium): see *Typing, and the clock* above. The fix is a `typed` flag, not a longer gap, and the tests now drive 4,000 random typed streams at paces from instant to very slow, and a real-time stream at 110 ms a key through the mounted chat.
- **A project withdrawal said "a session approval of it remains" when another remembered command's approval stood** (security and correctness, medium): the answer now counts only the approvals this grant covered, those that matched before the revoke and match no more.
- **The mode note and some answers said less ran unasked than does** (UX, medium): a session approval, which every *Remember* leaves, removes the card in every mode that asks. The notes now read `Session-approved commands run unasked here; a remembered one still asks.` in `ask` and `accept-edits`, `Auto runs approved commands; remembered ones ask once after a file write.` in `auto`; the answers say `The chat asks about it again` where that is true in every mode and name `auto` only for what `auto` does. The *Remember* notice of step 4 had the same flaw (`ask mode still asks`, false for the chat that made the grant) and is corrected.
- **`d` was refused silently**: an early `d` says `Wait a moment, then press d.`, and one refused because of typing says `Typed keys are ignored here. Select a row with ↑/↓, then press d.`; the `Enter` window has an upper bound (10 s), which also covers a suspended terminal.
- **The window rule counts rows, not lines**: a marker is drawn only where a row is hidden, and the search for the nearest acceptable window removes `▲ 0 more`, a lone heading above `▼` and a cut sentence at the top (a brute force over 0–20 remembered × 0–10 approved rows, every cursor, at three sizes, is in the tests).
- **Smaller:** a session withdrawal asks the store before it changes anything; the session list is no longer wrapped in a `try` that drew "nothing is approved" over a fault; the full-file sentence names the whole command; a rejected typed form says `Open /permissions and press d on a row to withdraw it.` (the dispatch's own rejection plus a per-command hint, instead of a custom usage line).
- **Declined:** a smaller column cap, the load-time scrub cost of an absurd (megabyte, dozens) set of session approvals, rows that look like frame lines behind their two-column indent (withdrawal is by identity, nothing wrong can be withdrawn), and a clipped command that cannot be read in full (the full command was on the card). The control-split secret deferral now names the zero-width variant.

