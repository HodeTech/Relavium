# Terminal agent CLI UX benchmark — 2026-11-08

> **Status:** research, not a spec. It informs [ADR-0122](../decisions/0122-the-home-is-the-interactive-product.md)
> (the Home is the interactive product), the 2026-11-08 revision of [ADR-0114](../decisions/0114-in-house-markdown-rendering-for-the-chat-transcript.md)
> (markdown tables) and the [MVP-2 plan](../roadmap/phases/phase-2.6-conversational-authoring.md#mvp-2-plan--home-first-2026-11-08).
> Concrete contracts stay in [docs/reference/](../reference/README.md).

## Why this exists

On 2026-11-08 the maintainer set the CLI's direction. A user should not have to memorise subcommands; they type
`relavium`, land in the full-screen TUI and do everything there. MVP-2 (first run, resume and a readable chat) is the
first milestone planned under that direction. Before planning it, this study looked at how the current terminal
agents handle the same problems:

- the entry screen;
- the command surface;
- onboarding and credentials;
- sessions;
- transcript rendering;
- tool rows;
- project init;
- keys;
- the cost of a full-screen TUI.

## Method

- **Research.** Six research agents each covered one product family against a shared brief of eleven topics. Eleven
  products were studied in depth; Amp, Qwen Code, Factory Droid and Cursor CLI got shorter notes. The agents
  used primary sources: official docs, the public repositories' source, changelogs and release notes, and official
  discussions.
- **Claim tags.** Every claim in their notes is tagged verified (with the URL and version), inferred or unverified.
  Community sources (issues, Hacker News) are used only for pain points and are labelled as such.
- **Internal analysis.** Two more agents mapped Relavium's own code: what the Home can reach today, and the technical
  ground truth for each MVP-2 item.
- **Fact-check.** An independent agent re-checked the ten claims the decisions below lean on hardest. The result is
  in [Verification](#verification).
- **Raw notes.** The full notes (about 54,000 words) are kept in the git-ignored `docs/analysis/private/2026-11-08-cli-ux-research/`.
  This document is the synthesis.

### Products and versions studied

| Product | Version studied | TUI engine | Notes |
|---|---|---|---|
| Claude Code | v2.1.319 (2026-11-06) | closed source | Docs at code.claude.com |
| Codex CLI | rust-v0.167.0 (2026-11-06) | Rust, ratatui | Source read at the tag |
| opencode | v2.2.6 (2026-11-06) | OpenTUI (Zig, Solid) | Repo now `anomalyco/opencode` |
| Crush | v0.100.0 (2026-11-05) | Bubble Tea v2 | Second full-screen reference |
| Gemini CLI | v0.67.0 (2026-11-04) | ink 6 (a fork) | Same stack family as Relavium; for enterprise and paid API keys since 2026-06-18 |
| Antigravity CLI | 1.5.x | Go, closed source | Replaced Gemini CLI for consumer tiers on 2026-06-18 |
| Grok Build | 1.0.x (docs synced 2026-09-29) | Rust, ratatui | Official xAI, open source |
| Copilot CLI | v1.0.107 (2026-11-06) | not stated | |
| Kimi Code CLI | 2.5.2 (2026-11-06) | TypeScript | Uses models.dev, as Relavium does |
| Kiro CLI, Cline CLI, Amp | 3.x, 3.0.74, current | various | Breadth sweep |

## The short version

1. **The bare command opens the app.** In every product studied, the interactive product is what the bare command
   opens, and subcommands are for scripts. Several have a landing or home screen:
   - Grok Build: a welcome menu plus the folder's recent sessions;
   - Copilot CLI: a tab bar;
   - opencode, Crush and Cline. Kimi shows a welcome panel inside its transcript instead.
   Relavium's Home is in the same family; it just cannot do much yet.
2. **Full-screen is now the default, and it is expensive.**
   - Claude Code (since May 2026), Codex (since September 2026), Copilot CLI, opencode, Crush and Grok Build open
     full-screen.
   - Each one that switched drew sustained complaints about lost scrollback, copy and search, then rebuilt those
     inside the app.
   - Gemini CLI tried full-screen as the default and rolled it back.
   - The products that kept an inline mode (Claude Code, Codex, Grok Build, Kiro, Antigravity) treat it as
     first-class.
3. **No product ends a first run in an error.** A missing credential opens a setup flow inside the app (Crush,
   Cline, Grok Build, opencode, Codex) or leaves a persistent footer line (Claude Code: `Not logged in · Run /login`).
4. **Environment keys are not adopted silently in the interactive TUI.**
   - Codex and Gemini CLI pre-fill the key field with "detected `…` environment variable" and ask.
   - Claude Code asks once before an env key overrides a login, and shows the active credential in `/status`.
   - opencode labels an env-sourced provider with `$VAR`.
   - Copilot CLI lets env silently override a stored login, and its own docs call that out.
   - Scripts and non-interactive modes use env keys directly everywhere.
5. **Sessions are scoped to the current directory.** One key widens the list (Claude Code, Codex, Kimi, Grok
   Build, Copilot CLI; opencode's `--continue` is per directory too). Pickers search, preview, sort by recency and show title, age and directory. Resume
   repaints the conversation within a bound, and several products print the way back on exit.
6. **Markdown tables are expected.** Every major product renders them, and the streaming ones hold a table back
   until it is complete.
7. **Tool rows tell the truth.** Success and failure have different marks, and most products also distinguish
   cancelled or not-run. Codex derives the mark from the recorded exit code, never at row creation. Claude Code
   fixed blocked calls that "read as if they ran".
8. **`/init` writes an instructions file.** Claude Code, Codex, opencode, Crush, Copilot CLI, Kimi and Gemini CLI
   all have the model write `AGENTS.md` (or their own file name); none scaffolds directories. Grok Build and
   Antigravity have no `/init`.
9. **Discoverability lives in the palette.** That means descriptions, argument hints, a shortcut overlay and
   disabled-with-reason entries. Claude Code stopped auto-running fuzzy matches for mistyped commands, because they
   ran the wrong command.
10. **The keymap has converged.**
    - Ctrl-C clears a draft, then interrupts, then a second press quits. Codex is the exception: it quits on one
      press when idle and calls the double press "janky".
    - Esc interrupts or declines, and never approves.
    - Typing during a turn queues the message.

## Findings by topic

### 1. Entry model and screen mode

| Product | Bare command opens | Inline option | Switch at runtime |
|---|---|---|---|
| Claude Code | Full-screen for users whose first use was on or after 2026-05-06 (behind a feature flag); others see a startup offer, at most three times | Classic renderer, selectable | `/tui` relaunches with the conversation carried over |
| Codex CLI | Full-screen since 0.157 | `--no-alt-screen`, `tui.alternate_screen`, `/raw` for copy-friendly output | `/tui`, applied on restart |
| opencode | Full-screen, centred logo and prompt | `opencode mini`, a separate inline UI | — |
| Crush | Full-screen landing: cwd, branch, model, LSP/MCP; one-time "Initialize this project?" | — | — |
| Gemini CLI | Inline with native scrollback | Alternate buffer opt-in (default in v0.15, rolled back in v0.18) | Setting |
| Antigravity CLI | First run asks: colour scheme, inline or full-screen, workspace trust | Inline recommended for SSH and tmux | Setting |
| Grok Build | Full-screen welcome screen: menu plus the folder's recent sessions | `--minimal`, `--no-alt-screen` | In place; the draft, running turn and queue survive |
| Copilot CLI | Full-screen only since 1.0.12 | Removed | — |

Lessons:

- **Claude Code's own history is the clearest record of the trade-off.** In December 2025 a maintainer wrote that the
  bar for alt-screen was "very high" (issue #769). Full-screen then shipped opt-in in April 2026 and became the
  default for new users in May. Within a week, users filed "kills all scrollback" issues. A tracking issue listed 42
  open copy and paste problems.
- **Codex took the same path.** It explained the switch publicly (discussion #49129): terminal scrollback limits,
  whole-history loading, and tables repainting the scrollback. It spent the following releases on copy, mouse and
  tmux fixes.
- **The products that switched rebuilt native affordances inside the app:**
  - in-app scroll and search;
  - copy on select with a toast;
  - a `/copy` picker;
  - dump to native scrollback or `$EDITOR`;
  - a mouse-capture off switch;
  - Kimi and Kiro reprint the transcript to the normal buffer on exit.

Relavium today:
- full-screen by default, inline with `--no-alt-screen` or `[preferences].alt_screen = false`;
- `/scrollback`, `/edit` and `/copy`;
- copy on select;
- mouse capture only while a chat owns the screen.

Missing: transcript search and a way back printed on exit.

### 2. Home screen and the command surface

- **Landing screens.**
  - Grok Build hosts login, folder trust and session resume on its welcome screen, and `/home` returns there.
  - Copilot CLI's home tab bar shows sessions, issues and pull requests, with a live sessions sidebar.
  - Cline's root is a state machine: `onboarding | home | chat | history | config`.
- **Palettes.**
  - Grok Build: a fuzzy menu with description, argument hint, source badge and a recency tiebreak.
  - Gemini CLI: a fuzzy inline list with a description column; each command declares whether Enter runs it or
    completes it.
  - Codex: prefix filtering ordered by frequency, and commands that cannot run are greyed out with a reason.
  - Kimi: an "always available" column, gating which commands work while a turn streams.
  - Amp: a `Ctrl+O` palette that runs commands without touching the draft.
- **Typo handling.** Claude Code highlights only name, alias or word-prefix matches. A typo reports `Unknown command`
  instead of running the closest match.
- **Things products retracted.** Claude Code removed its `/agents` wizard, `/vim` and the `#` memory prefix. Codex
  deprecated custom prompts in favour of skills.

Relavium today:
- the Home palette offers four commands (`/exit`, `/doctor`, `/clear`, `/models`);
- it runs a command's bare form only;
- no strip row can be opened;
- several in-TUI messages send the user to a shell command.

### 3. First run, credentials and environment variables

| Product | No credential | Env key in the interactive TUI | Credential source shown |
|---|---|---|---|
| Claude Code | Persistent footer `Not logged in · Run /login` | Asks once before an env key overrides a login; remembers the answer | `/status` marks the active and the unused credential |
| Codex CLI | Sign-in menu (ChatGPT, device code, API key) | Pre-fills the key box: "Detected OPENAI_API_KEY environment variable" | `/status` |
| Gemini CLI | Auth dialog | Pre-fills: "Existing API key detected (GEMINI_API_KEY)", then stores it in the keychain | Footer names the command that changes it |
| opencode | Connect dialog opens when a prompt is sent with no provider | Uses it; a saved account beats env | Provider row shows `$ENV_VAR_NAME` |
| Crush | Starts in onboarding (model and provider picker) | Uses it | — |
| Grok Build | Login menu on the welcome screen | Lowest precedence; ignored once logged in | On demand (`/session-info`) |
| Copilot CLI | `/login` prompt | Env beats keychain, silently | — |
| Kimi | TUI opens with a warning line "model: not set, run /login or /provider" | No implicit env fallback by design | — |

The closest precedent for Relavium's MVP-A6 is Claude Code's ask-once rule. A community issue on its tracker (#9699)
reports users surprised by billing through an env key; the link between that issue and the rule is an inference.

The technical analysis adds one Relavium-specific rule. A standard variable such as `OPENAI_API_KEY` must never be
applied to a provider configured with a custom `base_url`, or an ambient key would be sent to an arbitrary gateway.

### 4. Sessions: resume, continue, picker

- **Scope.** The default scope is the current directory, and one key widens it:
  - Claude Code: `Ctrl+W` for all worktrees, `Ctrl+A` for every project;
  - Codex: a Cwd / Repo / All filter;
  - opencode: `--continue` takes the newest session for the launch directory, and its session dialog toggles current
    directory and all projects with `Ctrl+A` (its starting scope follows a `tabs.scope` setting);
  - Kimi: `Ctrl+A`;
  - Grok Build: the current repository pinned first;
  - Copilot CLI: sorts by match to the directory.
- **Picker rows** show a title (auto-generated or renamed), age, directory or branch, and often the last prompt or
  size. Pickers search titles, and some also search content. Preview: `Space` in Claude Code, `Ctrl+T` in Codex.
  Delete is a two-step confirm: Grok `d`+`y`, Copilot `x x`, Kimi `Ctrl+X`+`y`.
- **Continue.** `--continue` or `-c` means "latest session for this directory" (Claude Code, opencode, Grok Build,
  Copilot CLI with a global fallback, Antigravity with a parent/child-directory fallback).
- **Repaint is bounded.**
  - Codex loads about three screens of rows, then pages of 100 on scroll.
  - opencode mounts a render budget around the viewport.
  - `opencode mini` replays up to 200 messages.
  - Codex's scrollback mode replays up to a per-terminal cap, and a user measured 21 s against about 1 s for
    full-screen.
  - Claude Code repaints from the last compaction with a `Conversation compacted` row; opencode shows a compaction
    divider.
- **Way back on exit.** Crush prints `Continue  crush -s <id>` and Gemini CLI prints `To resume this session: gemini
  --resume <id>`.
- **Known bugs to avoid:**
  - pickers listing too few or too many sessions (Claude Code #26123 and #46445);
  - blank rows (Copilot);
  - a resume that hung forever (Copilot, now a 10-second timeout);
  - tool results replayed twice because the UI transcript and the model transcript were converted separately
    (Gemini CLI #29365).

Relavium today:
- `chat resume <id>` needs an id;
- the resumed chat opens on an empty screen;
- the Home's "Continue" list cannot be opened;
- no continue affordance.

The stored transcript also differs from the displayed one, and a repaint must reconstruct the view:
- user rows hold attachment frames;
- assistant rows hold only the text after the last tool call;
- per-turn summaries are not stored.

### 5. Transcript rendering

- **Tables.**
  - Claude Code: bordered grids with a stacked key/value fallback when narrow, capped at 200 rows.
  - Gemini CLI: wraps cell text in proportional columns.
  - Kimi: wraps cells and falls back to raw markdown when too narrow.
  - opencode: grid tables.
  - Antigravity: fixed emoji and CJK width drift in tables.
- **Streaming.** The common strategy is to commit completed blocks and re-render only the open tail:
  - Codex commits complete lines and holds tables back;
  - Crush caches the render of the stable prefix up to the last blank line outside an open block;
  - Grok Build uses checkpoints, taking the cost from O(N²) to about O(N);
  - Gemini CLI commits to ink's `<Static>` at the last blank line outside a fence and caps the live region's
    height.
- **Ink 7 defects found by Qwen Code users** (same major as Relavium): a static chunk taller than the viewport lets
  the live region overwrite a line, and a rows-only shrink eats a transcript line. Synchronized output (DEC 2026) is
  ignored by tmux before 3.5.
- **Syntax highlighting has a cost.** Claude Code fixed a highlighting denial of service on long lines and unclosed
  strings twice in 2026. This supports ADR-0114's choice to defer highlighting.
- **Links.** Grok Build, Kimi and Qwen emit OSC 8 hyperlinks. ADR-0114 deliberately does not, so a label can never
  hide its target.

### 6. Tool rows

| Product | States shown |
|---|---|
| Claude Code | ran, red error, dim "Not run", "Interrupted"; one-line summaries, `Ctrl+O` expands |
| Codex CLI | animated "Running" until a duration is recorded; green or red bullet by exit code; output clipped to 5 lines |
| opencode | `✓`, `✗` in the error colour, strikethrough for denied calls, expandable error |
| Crush | awaiting permission, running, success, error, cancelled; an interruption is "cancelled", not "error" |
| Gemini CLI | `✓`, `o` pending, spinner, `?` confirming, `-` cancelled, bold red `x`, each with an aria label |
| Grok Build | red bullet for a failure, a different dim glyph for a cancellation, pinned by a test |

Relavium today shows `✓` once a call resolves, whether it succeeded or not. The `agent:tool_result` event already
carries `success`; the chat view ignores it.

### 7. Project init

- **The products that have `/init` use the model to write an instructions file:**
  - Claude Code writes or improves `CLAUDE.md`, with an interactive proposal-then-write flow behind a flag;
  - Codex and opencode send a prompt asking for an `AGENTS.md`;
  - Gemini CLI creates an empty `GEMINI.md` first, then asks the model to fill it;
  - Copilot CLI shows a startup hint when the file is missing.
- **None scaffolds directories.** Grok Build and Antigravity have no `/init` and read the files the user writes.
- **Crush** asks once per new project.
- **File names.** Most products read several: `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`.

Relavium's `init` has a different job: it creates the `.relavium/` workspace that workflows and agents live in.
Writing an instructions file belongs to MVP-5's project-instructions item (MVP-A16), which can later extend `/init`.

### 8. Keyboard and input

- **Ctrl-C:** clear the draft, then interrupt, then quit on a second press (Claude Code, Grok Build, Gemini CLI with
  a 3-second window). Codex quits on one press when idle.
- **Esc:** interrupts or declines, and never approves (Grok Build, opencode). `Esc Esc` rewinds or edits the previous
  message (Claude Code, Codex, Grok Build, Gemini CLI).
- **Queueing.** Typing while a turn runs queues the message (Claude Code, Grok Build, Gemini CLI). Codex
  distinguishes steering, applied after the next tool call, from queueing.
- **Large pastes** fold into a chip: Claude Code over 800 characters or 3 lines, Gemini CLI over 5 lines or 500
  characters.

[ADR-0115](../decisions/0115-one-interrupt-keymap-for-the-interactive-cli.md) (Proposed) already matches the
converged Ctrl-C contract. Type-ahead is MVP-5.

### 9. Platform, performance and accessibility

- **Windows.** All the major products support PowerShell natively now, and all have shipped ConPTY fixes. Gemini
  CLI's startup took 39 to 60 seconds on Windows. Issue #11511 was closed as a duplicate, and a maintainer answered
  #10726 with "not planned for now".
- **Startup.** opencode blocked startup on a terminal palette query (about 4.5 s on Ghostty, #14965). Probes need
  timeouts.
- **Terminal state.** opencode left mouse-report garbage in the shell after exit (#20458). Terminal state must be
  restored on every exit path.
- **Bounded memory.** opencode hit a 24–28 GB TUI out-of-memory (#51761) and a session database of 13 GB or more
  (#33356).
- **Accessibility.**
  - Claude Code has a screen-reader mode that forces linear plain text and the classic renderer.
  - Gemini CLI gives each tool state an aria label.
  - No full-screen product has a screen-reader story of its own.
- **Untrusted text at every sink.** Copilot CLI 1.0.106 started sanitizing model text, tool errors, session names,
  branch names and the working directory so none can restyle the terminal or set its title. Relavium's sanitize floor
  already covers this; titles and paths must stay inside it.

### 10. Safety UX (for MVP-3 and MVP-4)

- **Approval options.** Prompts offer allow once, always allow (showing exactly what will be remembered) and reject
  with a message (Codex, Grok Build, Claude Code). Grok Build's default selection is "Always allow on all
  sessions", a pattern to avoid.
- **Defaults differ.** opencode V2's base policy allows everything except `.env` reads. Crush asks before every
  call, and its dialog starts on Deny for flagged requests. Crush's modal dialog also hides the transcript (#149,
  open since July 2025).
- **Trust prompts.** Gemini CLI's folder-trust dialog lists what the folder would activate (commands, MCP servers,
  hooks) before the user chooses. Codex offers "Open restricted".

## Principles Relavium adopts

These are the rules the plan applies, each grounded in the findings above. [ADR-0122](../decisions/0122-the-home-is-the-interactive-product.md)
makes the binding ones part of every new screen's acceptance.

1. **One door.** `relavium` opens the Home, and every routine task has an in-TUI form. Subcommands are the scripting
   surface and call the same core.
2. **Never a dead end.** A missing key, project or session leads to the next action in place (setup, `/init`, a new
   chat), not to an error that sends the user to the shell.
3. **Say where things come from.** Show a credential's source. Do not adopt an environment key silently in the
   interactive TUI; ask once. Never send a standard variable to a custom endpoint.
4. **Scope to here, widen with one key.** Sessions default to the current directory.
5. **Show the truth.** Success, failure and interruption look different. "Copied" appears only after a successful
   write. A command that cannot run says why.
6. **Full-screen is earned.** Every full-screen feature ships with scroll, search, copy, a mouse opt-out,
   terminal-state restoration and inline parity.
7. **Discoverable without docs.** The palette has descriptions, aliases and argument hints, plus a shortcut overlay.
   A mistyped command reports the nearest match and never runs it.
8. **Stable streaming.** Commit completed blocks and re-render only the tail. Hold tables until they are complete.
   The live region never exceeds the viewport.
9. **Bounded everything.** Repaint windows, picker pages, caches and tables all have limits.
10. **A fast first frame.** No blocking terminal probe without a timeout. The first frame never waits on the network.
11. **One keymap everywhere** (ADR-0115), on every new screen.

## What this changes in the plan

- [ADR-0122](../decisions/0122-the-home-is-the-interactive-product.md) (Accepted, 2026-11-08) records the direction
  and the per-screen acceptance rules. It replaces ADR-0056's shell-only clause and ADR-0054's read-only strip.
- [ADR-0114](../decisions/0114-in-house-markdown-rendering-for-the-chat-transcript.md) (still Proposed) now renders
  GFM tables as an aligned grid when they fit, and holds a streaming table until it ends.
- The [MVP-2 plan](../roadmap/phases/phase-2.6-conversational-authoring.md#mvp-2-plan--home-first-2026-11-08)
  gives every MVP-2 item an in-TUI form and records the decisions taken from this study.

## Verification

An independent agent re-checked the ten claims the decisions lean on hardest against primary sources on
2026-11-08. None was refuted. Three needed narrower wording, which the text above already uses.

| # | Claim | Verdict |
|---|---|---|
| 1 | Claude Code ships a full-screen renderer and makes it the default for newer users | Partly. The default is keyed to a first-use date (on or after 2026-05-06) behind a feature flag, not to a version. `/tui` shipped in v2.1.110 |
| 2 | Codex added `/tui` in 0.156 and made full-screen the default in 0.157; discussion #49129 explains why | Confirmed |
| 3 | Codex's TUI does not silently use `OPENAI_API_KEY` and pre-fills the key field instead | Confirmed in source (`onboarding/auth.rs`); the realtime voice path is an exception |
| 4 | Claude Code asks once before using an env key in interactive mode, and `/status` shows the active method | Confirmed (authentication docs) |
| 5 | Claude Code's `/resume` defaults to the current worktree, and `Ctrl+A` shows all projects | Confirmed (sessions docs; CHANGELOG v2.1.108) |
| 6 | Grok Build is open source and opens a full-screen welcome screen listing this directory's sessions | Confirmed from the repository; the first-party page returned 403 |
| 7 | opencode's `--continue` takes the newest session for the launch directory, and its dialog has `Ctrl+A` | Partly. Both confirmed in source; the dialog's starting scope depends on a setting |
| 8 | Copilot CLI made alt-screen permanent in 1.0.12, and issue #4509 complains | Confirmed (the issue names the removed flag loosely) |
| 9 | Claude Code renders markdown tables as a bordered grid with a narrow fallback | Confirmed (CHANGELOG v1.0.10, v2.1.141, v2.1.152, v2.1.314) |
| 10 | Crush starts in onboarding with no provider; opencode opens a connect dialog on a send with no provider | Confirmed in source |

### Decision-bearing claims and their sources

Each decision in the MVP-2 plan that leans on another product's behaviour cites one of these rows. "Re-checked" means
the independent agent confirmed it from the primary source (the table above); the other rows come from source reads
in the research notes.

| Claim | Version | Source | Re-checked |
|---|---|---|---|
| Claude Code asks once before using an env API key interactively and shows the active method in `/status` | docs, 2026-11-08 | [authentication](https://code.claude.com/docs/en/authentication) | Yes |
| Codex's TUI only pre-fills the key field from `OPENAI_API_KEY` | rust-v0.167.0 | [`codex-rs/tui/src/onboarding/auth.rs`](https://github.com/openai/codex/blob/rust-v0.167.0/codex-rs/tui/src/onboarding/auth.rs) | Yes |
| Gemini CLI shows "Existing API key detected (GEMINI_API_KEY)" and pre-fills instead of authenticating silently | v0.67.0 | [`packages/cli/src/ui/auth/useAuth.ts`, `AuthDialog.tsx`](https://github.com/google-gemini/gemini-cli/tree/main/packages/cli/src/ui/auth) | No |
| Claude Code's `/resume` defaults to the current worktree; `Ctrl+A` shows all projects | v2.1.108 onward | [sessions](https://code.claude.com/docs/en/sessions), [CHANGELOG](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md) | Yes |
| Codex's resume picker and `--last` see this directory's sessions; `--all` widens | rust-v0.167.0 | [repository](https://github.com/openai/codex) (`codex-rs/tui`) | No |
| opencode's `--continue` takes the newest session for the launch directory | v2.2.6 | [`packages/tui/src/app.tsx`](https://github.com/anomalyco/opencode) | Yes |
| Grok Build's welcome screen lists this directory's sessions | 1.0.x | [user guide, sessions](https://github.com/xai-org/grok-build) | Yes |
| Claude Code renders tables as a bordered grid with a narrow fallback | v2.1.141, v2.1.152, v2.1.314 | [CHANGELOG](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md) | Yes |
| Codex holds a streaming table back until its block is stable | rust-v0.167.0 | [repository](https://github.com/openai/codex) (`codex-rs/tui/src/streaming`) | No |
| Copilot CLI made alt-screen permanent; issue #4509 lists the cost | 1.0.12 | [changelog](https://github.com/github/copilot-cli/blob/main/changelog.md), [#4509](https://github.com/github/copilot-cli/issues/4509) | Yes |
| Codex made full-screen the default and explained why | 0.156, 0.157 | [discussion #49129](https://github.com/openai/codex/discussions/49129) | Yes |
| Crush starts in onboarding with no provider; opencode opens its connect dialog | v0.100.0, v2.2.6 | [crush `internal/ui/model/ui.go`](https://github.com/charmbracelet/crush), [opencode `prompt/index.tsx`](https://github.com/anomalyco/opencode) | Yes |
| Gemini CLI replayed tool results twice on resume when its two transcripts diverged | issue | [#29365](https://github.com/google-gemini/gemini-cli/issues/29365) | No |
| A community issue reports Claude Code users surprised by env-key billing (its link to the ask-once rule is an inference) | issue | [#9699](https://github.com/anthropics/claude-code/issues/9699) | No |

## Appendix — Relavium's Home reach on 2026-11-08

What a bare `relavium` can do for each leaf subcommand at `0ef53496`, from the internal analysis. "Partly" means the
Home covers part of the task (for example, it lists recent runs but cannot open one).

| Subcommand | Task | In the Home today | Planned in-TUI form |
|---|---|---|---|
| `run <workflow>` | Run a workflow and watch it | No | Hub milestone (run-hosting ADR) |
| `chat` | Chat with an agent | Yes, default agent only; `--agent` not reachable | `/agents` (hub milestone) |
| `chat resume <id>` | Continue a session | No | `/resume`, actionable rows (MVP-2) |
| `chat list` | Find a session | Partly: eight recent sessions, read-only | `/resume` picker (MVP-2) |
| `chat export <id>` | Turn a session into a workflow | Partly: `/export` of the live session | Session actions (hub milestone) |
| `create` | Scaffold an agent or workflow | No | `/create` (MVP-6) |
| `export <id>` | Copy a workflow or agent as YAML | No | `/workflows` actions (hub milestone) |
| `import <path>` | Bring in a YAML file | No | Not yet planned |
| `agent run <agent>` | One-shot from stdin | No, by design | Stays shell-only |
| `gate <runId>` | Answer a human gate | No: shown under Attention only | Gate card (hub milestone) |
| `gate list` | See pending gates | Partly: Attention lists them | Actionable rows (hub milestone) |
| `budget resume` | Approve a budget gate | No | Budget card (hub milestone) |
| `models` | Pick a model | Yes: `/models` | Done |
| `models refresh` | Refresh the catalog | Yes: inside `/models` | Done |
| `models pricing` | Enter a model's price | No | Not yet planned |
| `provider list` | See providers and keys | Partly: `/doctor` | `/providers` (MVP-2) |
| `provider add` | Register a custom provider | No | `/providers` (MVP-9) |
| `provider set-key` | Store a key | Partly: first-run wizard only | `/providers` (MVP-2) |
| `provider remove-key` | Delete a key | No | `/providers` (MVP-9) |
| `provider test` | Check a key | Partly: `/doctor --deep` in a chat | `/providers` (MVP-9) |
| `media prune-temporaries` | Maintenance | No, by design | Stays shell-only |
| `list` | List workflows and runs | Partly: recent runs | `/workflows` (hub milestone) |
| `logs <runId>` | Read a run's events | No | Run detail (hub milestone) |
| `status [runId]` | Read run status | Partly: Attention and Continue | Run detail (hub milestone) |
| `init` | Create `.relavium/` | No (not implemented) | `/init` (MVP-2) |

## Sources

Primary sources, as read on 2026-11-08. The raw notes cite a URL and version for each claim.

- **Claude Code:**
  - [docs](https://code.claude.com/docs/llms.txt);
  - [fullscreen](https://code.claude.com/docs/en/fullscreen.md);
  - [sessions](https://code.claude.com/docs/en/sessions.md);
  - [CHANGELOG](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md);
  - issues [#769](https://github.com/anthropics/claude-code/issues/769),
    [#9699](https://github.com/anthropics/claude-code/issues/9699),
    [#42670](https://github.com/anthropics/claude-code/issues/42670).
- **Codex CLI:**
  - [repository](https://github.com/openai/codex) (`codex-rs/tui` at rust-v0.167.0);
  - [discussion #49129](https://github.com/openai/codex/discussions/49129);
  - releases [0.156.0](https://github.com/openai/codex/releases/tag/rust-v0.156.0) and
    [0.157.0](https://github.com/openai/codex/releases/tag/rust-v0.157.0);
  - [auth](https://learn.chatgpt.com/docs/auth).
- **opencode:** [docs](https://opencode.ai/docs/), [TUI](https://opencode.ai/docs/cli/tui),
  [providers](https://opencode.ai/docs/cli/providers), [OpenTUI](https://github.com/anomalyco/opentui).
- **Crush:** [README](https://github.com/charmbracelet/crush/blob/main/README.md).
- **Gemini CLI:**
  - [repository](https://github.com/google-gemini/gemini-cli);
  - [issue #13074](https://github.com/google-gemini/gemini-cli/issues/13074);
  - pull requests [#24873](https://github.com/google-gemini/gemini-cli/pull/24873),
    [#29644](https://github.com/google-gemini/gemini-cli/pull/29644) and
    [#29904](https://github.com/google-gemini/gemini-cli/pull/29904).
- **Antigravity CLI:** [repository and CHANGELOG](https://github.com/google-antigravity/antigravity-cli),
  [download](https://antigravity.google/download).
- **Grok Build:** [repository](https://github.com/xai-org/grok-build), [docs](https://docs.x.ai/build/overview),
  [announcement](https://x.ai/news/grok-build-cli).
- **Copilot CLI:**
  - [repository](https://github.com/github/copilot-cli);
  - [changelog](https://github.com/github/copilot-cli/blob/main/changelog.md);
  - [command reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference);
  - [issue #4509](https://github.com/github/copilot-cli/issues/4509).
- **Kimi Code CLI:** [repository](https://github.com/MoonshotAI/kimi-code),
  [sessions](https://www.kimi.com/code/docs/en/kimi-code-cli/guides/sessions).
- **Kiro CLI:** [docs](https://kiro.dev/docs/cli/).
- **Cline CLI:** [README](https://github.com/cline/cline/blob/main/apps/cli/README.md).
