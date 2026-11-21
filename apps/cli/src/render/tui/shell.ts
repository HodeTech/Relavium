import { scrubbedCommandDisplay } from '@relavium/core';
import { quoteCommandLine, tokenizeCommandLine } from '@relavium/shared';

import type { ChatMode } from '../../chat/chat-mode.js';
import { frameUntrusted } from './injection.js';

/**
 * The `!`-shell escape input model (2.5.D step 5, [ADR-0061](../../../../../docs/decisions/0061-cli-input-layer-file-injection-and-shell-escape.md)).
 * A line starting with `!` is a USER-invoked shell command: the rest of the line is tokenized into argv (NO shell
 * metachar expansion — the process arm spawns with `shell:false`) and run through `AgentSession.runUserCommand`,
 * which judges the call against the `[chat].allowed_commands` allowlist (an interactive chat hands a miss to the mode-aware
 * `confirmAction` as a request, ADR-0118 §1; an unattended dispatch refuses it) → the mode-aware `confirmAction` → the
 * hardened process arm. The output is injected as UNTRUSTED, nonce-fenced, byte+line-bounded context (the SAME
 * framing as `@`-mention, {@link injection.ts}). `!` is TTY-only — a plain / `--json` driver never intercepts it.
 */

export interface ShellCommand {
  /** The executable (argv[0]) — spawned with `shell:false`. */
  readonly command: string;
  /** The remaining argv — each a literal token (quotes removed, spaces preserved inside a quoted token). */
  readonly args: readonly string[];
}

/** Whether a submitted line is a `!`-shell escape — a leading `!` (the line is already trimmed by the caller). */
export function isShellLine(line: string): boolean {
  return line.startsWith('!');
}

/**
 * What a `!`-shell line (WITHOUT the leading `!`) parses to. The grammar is the one shared command-line grammar
 * (`tokenizeCommandLine` in `@relavium/shared`, [ADR-0118](../../../../../docs/decisions/0118-a-command-outside-the-allowlist-asks-instead-of-failing.md) §3):
 * single and double quotes group, NO shell expansion (no glob, no `$var`, no `;`/`|`/`&&` — those are literal argv
 * characters, inert under `shell:false`), whitespace outside quotes separates tokens.
 *
 * - `command` — a program and its argv, ready to run;
 * - `empty` — no command token (a bare `!` or `!   `): never a shell run. The callers fall through and send it as an
 *   ordinary message, as they always have;
 * - `unterminated_quote` — the line ended inside a quote. The old tokenizer ran an open quote to the end of the line;
 *   that changes what runs, so it is refused and the caller says why.
 */
export type ShellLineParse =
  | { readonly kind: 'command'; readonly cmd: ShellCommand }
  | { readonly kind: 'empty' }
  | { readonly kind: 'unterminated_quote' };

/** The fixed, value-free message for a refused open quote. */
export const SHELL_UNTERMINATED_QUOTE_NOTICE =
  '! not run — a quote is still open. Close it (or remove it) and try again.';

/** Parse the rest of a `!` line into a command, a no-op or a refusal. */
export function parseShellLine(rest: string): ShellLineParse {
  const parsed = tokenizeCommandLine(rest);
  if (parsed.unterminatedQuote) return { kind: 'unterminated_quote' };
  const [command, ...args] = parsed.tokens;
  if (command === undefined || command.length === 0) return { kind: 'empty' };
  return { kind: 'command', cmd: { command, args } };
}

/**
 * The command as ONE line a person could paste back (`quoteCommandLine`): an argument with a space or a quote is
 * quoted, so `cat "a b"` and `cat a b` read differently — for the allowlist-deny hint and the chip, which are shown only to the
 * person who typed it. What is sent onward (the injection frame's `cmd` attribute) is the scrubbed line
 * ({@link formatCommandInjection}).
 */
export function commandLine(cmd: ShellCommand): string {
  return quoteCommandLine([cmd.command, ...cmd.args]);
}

/**
 * The secret-free deny message (ADR-0061 — "never a dead 'denied'"). A mode/approval deny is either the `plan` mode floor (offer
 * the Shift+Tab switch) or a user decline. An allowlist miss is no longer a failure that tells the person to edit a config file
 * ([ADR-0118](../../../../../docs/decisions/0118-a-command-outside-the-allowlist-asks-instead-of-failing.md) §1): in an interactive
 * chat it is a card they answer, so the only way to reach `allowlist` here is a dispatch with no approval regime, which a chat
 * with a keyboard never is; the sentence says so plainly and names no config key. The command string is the user's OWN typed
 * input (already visible + history-recallable), so echoing it adds no exposure.
 */
export function shellDenyHint(cmd: ShellCommand, allowlist: boolean, mode: ChatMode): string {
  const line = commandLine(cmd);
  if (allowlist) return `! ${line}: not run — it is not allowed here.`;
  if (mode === 'plan') {
    return `! ${line}: not run — plan mode is read-only. Switch to ask, accept-edits or auto (Shift+Tab) to run it.`;
  }
  return `! ${line}: declined.`;
}

/**
 * Format a `!`-shell command's output for injection as UNTRUSTED, user-position context — the shared
 * {@link frameUntrusted} framing over a `<command id="NONCE" cmd="…" exit="N">` tag. `stderr` (if any) is appended
 * under a `[stderr]` marker; the whole body is nonce-fenced + byte/line bounded, so the command's output cannot
 * forge/close the frame nor freeze the editor. The model must treat it as data, never instructions.
 */
export function formatCommandInjection(
  cmd: ShellCommand,
  exitCode: number,
  stdout: string,
  stderr: string,
  nonce: string,
): string {
  const body = stderr.length > 0 ? `${stdout}\n[stderr]\n${stderr}` : stdout;
  // The frame goes to the provider and into the session's history, so its `cmd` is the line the approval card's event preview
  // shows (`scrubbedCommandDisplay`), never the raw one: a `!curl -H "Authorization: Bearer …"` must not carry its credential
  // to the model in an attribute (ADR-0118 §1). The process still ran the raw argv; this is only what is written about it.
  const shown = scrubbedCommandDisplay([cmd.command, ...cmd.args]);
  return frameUntrusted('command', { cmd: shown, exit: String(exitCode) }, body, nonce);
}
