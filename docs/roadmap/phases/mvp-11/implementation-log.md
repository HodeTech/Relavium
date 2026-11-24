# MVP-11 implementation log

> A running record of what each unit of [MVP-11](../mvp-11.md) delivered, how it was reviewed and what it left. It is written as the units land and folded into the phase record at the close-out (unit 10). Plan: [mvp-11.md](../mvp-11.md); decisions: ADR-0145 to ADR-0148; Step 1 evidence: [step-1-evidence.md](step-1-evidence.md). The units and their order are in the plan's header.

## Unit 2 — registry, palette, defects and first-run basics (2026-11-24)

**Commits.** `d19b9364` one record of overlay flags (2.1); `425d5713` one command table that orders the palette, and no shell command in the TUI's remedies (2.2 and 2.3); `dd5fe5f9` a keyless first run that keeps what was typed (2.4); `b2103932` the findings of the first review round; the clean-up commit that follows it.

**What it delivered.**

- **One record of overlay flags** (`render/tui/overlay-flags.ts`): 14 flags and a table of the gates each closes; the keyboard-ownership lists that were written out by hand in a dozen places (the Home's screen slot, the paste flags, the wheel gate, the interrupt context, the strip pause, the prompt-hidden gates, three custody predicates) derive from it; the nine places where the old lists disagreed are preserved row by row and pinned. A popup will be one more flag.
- **One command table** (`commands/repl-commands.ts`): one definition per name with placements for the Home, a chat and the Home-hosted chat (group, rank, per-surface description, surface class, availability); the palettes are built from it once per state change. `/` then `Enter` never leaves the application (it ran `/exit`: exit code 0); the first enabled row is the default; `/exit` is the last row of every list; `/clear` and `/resume` are dim with their reasons; arrows skip dim rows; `/help` joins both palettes; a keyless Home leads with `/providers`; a chat's list opens above the prompt with its first row beside it; a command typed where it is not offered answers one line naming the surface that has it.
- **No shell command in the TUI's remedies**: about forty strings, three wrong remedies, the stand-alone `/clear` pointer; a pattern test over the syntax tree of the TUI-reachable sources with a short reasoned allow-list.
- **A keyless first run** in the existing cards: the draft is kept and unsent; a key-shaped draft is never kept or recorded; a failed build shows its whole failure in the wrapping notice area and restores the draft; the skip says so; `Retry the check` first on a network failure and `Save it anyway` never pre-selected; no key prompt with the keychain down; one spelling of the labels, display names; the keyless line and hints; the cursor visible without colour; the first-run offer waits below 80×24.

**Review round 1** (five fresh agents: correctness, a security sitting on opus, the rebuilt CLI re-observed in the sandbox, test quality and pins, architecture and performance). No blocker. Fixed in `b2103932`: the key prompt reachable with the keychain down by three routes; the consent card opening on `Use it` under a chained `Enter` (now `Not now` until Step 6 adds the input guards); a key-shaped draft recorded in the history on the keyed path; a 'looks like a key' predicate that was the whole diagnostic scrubber (discarded `Explain Basic auth`, missed a key after a word character); a slash-led key echoed as `Unknown command`; an unbounded failed-build notice; a short query highlighting `/exit`; a stand-alone remedy that said 'restart' when another provider was usable; Home-chat remedies naming `/providers`; the model picker saying 'default' for a reseat; no cursor under `--no-color`; a stand-alone `/resume` answering 'unknown command'; the `'tui'` notice wording hard-wired into the scripted `agent run` and plain chats; hollow tests (a pasted slash line, a dim-row oracle); the `usage-coverage-controls` permanent workload pin (583). The observed screens of the rebuilt CLI are the evidence; they are not a substitute for the real-terminal rows still owed.

**Left for later units, by design.**

| What | Unit |
|---|---|
| The environment-key consent's disclosure (variable, provider, model, config write) and the approval card's input guards on its affirmative row; `Use it` back as the first row; the starter-model table (Haiku 5.5) | 6 |
| `Esc` stepping back from the key step; the one first screen instead of two; the remembered skip beyond the process; the key-shape hint; 'Setup skipped' worded for the explicit flows; wrapped option rows with a hanging indent | 6 |
| `/doctor` with a provider-keys row and the deep tier on the Home; `/models` and `/help` as popups (their cut rows, the keys block that still says `Enter` starts a chat); a chat's `/help` as a popup | 4 and 5 |
| The import boundary lint for the data modules; the glyph, legend and golden work; one bold rule (chalk level 0 strips bold and inverse under `--no-color`) | 3 |
| The Home layout, the populated Home's hint, the keyless line beside a hosted run | 7 |
| A durable record of a mode change | 5 |

**Reference pages that now say something false** (updated in the close-out pass): `home.md` (the `/providers` and `/init` entries of the Home chat's palette; the keyless line 'suppressed while a run or strip row has focus' and its text; 'fourteen' commands; a chat's reaction to Home words; the failed-build banner), `commands.md` (`REPL_COMMANDS` as the source of the palettes; the Home chat's `/providers`, `/init`, `/resume`), `chat-session.md` (the `/export` notice's command; the `/clear` notice's id and resume command; the palette and `/help` order), `mvp-11.md` Appendix B (one row off on every surface because of `/help`) and the plan's §4.6 rule 6 (`/run` is not dim).
