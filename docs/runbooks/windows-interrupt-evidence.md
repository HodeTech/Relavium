# Collect Windows evidence for the interrupt keymap

- **Status**: Manual acceptance recipe for [ADR-0115](../decisions/0115-one-interrupt-keymap-for-the-interactive-cli.md) §5. No Windows pseudo-terminal harness exists (one would be a new dependency and needs its own ADR), so the evidence is collected by hand on a Windows machine and recorded in the phase register before MVP-4's final review round.
- **Date**: 2026-11-19
- **Related**: [the interrupt keymap](../reference/cli/chat-session.md#the-interrupt-keymap--mvp-4-adr-0115), [the Home's keys](../reference/cli/home.md), [the continue checkpoint](../reference/cli/chat-session.md#the-continue-checkpoint--mvp-4-adr-0136)

The keymap is decided in one pure reducer and is covered by automated tests on every platform. What a test cannot show is what a **Windows console** actually delivers: whether `Ctrl+C` in raw mode arrives as a key (the keymap applies) or as a SIGINT (the signal path of ADR-0115 §4 applies instead). This recipe records which one it is, and that the keymap still behaves as designed under it.

## What you need

- A Windows 10 or 11 machine, a built `relavium` (the installed package or `node apps/cli/dist/index.js`), and a provider key in the Windows credential store.
- **Two terminals**, one each from: Windows Terminal (PowerShell) and the legacy console host (`cmd.exe` in a classic conhost window). Repeat the checks in both; the answer can differ.
- A throwaway directory as the working directory. Nothing below needs a real project.
- Use a small, quiet model; the turns below are one line each.

## Checks

Record, for each row: terminal, `PASS` or `FAIL`, and a short note (what you pressed, what appeared). `Ctrl+C` is the key chord, not a typed `^C`.

| # | Do | Expect |
| --- | --- | --- |
| 1 | `relavium` (the Home). Press `Ctrl+C` once on the empty prompt. | The footer reads `Press Ctrl+C again to exit`; the Home stays open. |
| 2 | Press `Ctrl+C` again within two seconds. | The Home exits with code 0 (`echo %ERRORLEVEL%` or `$LASTEXITCODE`). |
| 3 | Reopen the Home. Press `Ctrl+C`, wait three seconds, press `Ctrl+C`. | The second press is a first press: it arms again and the Home stays open. |
| 4 | Type a message and press Enter to start a chat. While the reply is streaming, press `Ctrl+C` once. | The turn stops, the session stays open, and the hint reads `Press Ctrl+C again to end the session`. |
| 5 | Press `Ctrl+C` again within two seconds. | The chat ends and the Home returns, freshly read. The session is listed under *Sessions* and resumes. |
| 6 | Start a chat. At the idle prompt type a few characters and press `Ctrl+C`. | The characters are cleared and **nothing is armed** (no hint). Press `Ctrl+C` on the empty prompt: now it arms. |
| 7 | In a chat in `ask` mode, ask the model to create a file so a card opens. Press `Ctrl+C` at the card. | The file is not created, the tool row shows `denied` (not `? outcome unknown`), the turn stops, and the hint arms. |
| 8 | Repeat 7 with `Esc` at the card. | The same rejection and stop, and **no** arming hint. |
| 9 | Open a card, press `Ctrl+R` (the reason box), type a few characters, press `Esc`. | The box closes, the typed text is gone and the card is still waiting. A second `Esc` rejects and stops. |
| 10 | Set `[chat].checkpoint_tool_turns = 1` in a project's `.relavium/project.toml` (see [config-spec.md](../reference/contracts/config-spec.md#chat-limits); a repository layer may only lower the value, so use a number below the default), ask for a task that needs several file reads. At the checkpoint card press `Ctrl+N`. | The turn ends, the held round did not run, and the summary line reads `stopped at a checkpoint after 1 tool round`. |
| 11 | Repeat 10 and press `Ctrl+Y` once the card has been up for at least two seconds, with no other key pressed in that time. | The turn continues for one more interval. |
| 12 | `relavium chat --json` (or set `CI=true` — `$env:CI='true'` in PowerShell, `set CI=true` in `cmd` — and run `relavium chat`), so the plain driver runs with no raw mode. While a turn runs, press `Ctrl+C` once. | This is a real SIGINT: the turn is cancelled, the session is saved, and the process exits with code 4. |

## If `Ctrl+C` arrives as a signal

If row 1 ends the process (or prints `^C` and returns to the shell) instead of showing the hint, the console delivered a SIGINT and the raw-mode key never reached the keymap. Record that fact in the register with the terminal and Windows version. Per ADR-0115 §4 the signal path then applies there: the first SIGINT ends the session cooperatively (abort, persist, code 4) and a second force-exits. Rows 2 to 9 are then expected to differ, and the register notes which ones. It is not a defect in the keymap, but it is a documented platform difference the maintainer decides what to do about.

## Recording the evidence

Add a dated entry to the MVP-4 implementation record in [the phase document](../roadmap/phases/phase-2.6-conversational-authoring.md#mvp-4-implementation-record) naming the Windows version, both terminals, the build (commit or package version) and the table above with each row's result. A row left unchecked is recorded as unchecked, not as passed.
