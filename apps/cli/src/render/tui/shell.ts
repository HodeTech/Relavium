import type { ChatMode } from '../../chat/chat-mode.js';
import { frameUntrusted } from './injection.js';

/**
 * The `!`-shell escape input model (2.5.D step 5, [ADR-0061](../../../../docs/decisions/0061-cli-input-layer-file-injection-and-shell-escape.md)).
 * A line starting with `!` is a USER-invoked shell command: the rest of the line is tokenized into argv (NO shell
 * metachar expansion — the process arm spawns with `shell:false`) and run through `AgentSession.runUserCommand`,
 * which enforces the `[chat].allowed_commands` allowlist (BEFORE approval) → the mode-aware `confirmAction` → the
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
 * Tokenize a `!`-shell line (WITHOUT the leading `!`) into argv, respecting single + double quotes but performing
 * NO shell expansion (no glob, no `$var`, no `;`/`|`/`&&` — those become literal argv characters, inert under
 * `shell:false`). Whitespace outside quotes separates tokens; a quote's contents (incl. spaces) stay ONE token; an
 * unterminated quote tolerantly runs to end of line. Returns `undefined` when there is no command token (a bare
 * `!` / `!   ` — the caller treats that as a no-op, not a shell run).
 */
export function tokenizeCommand(rest: string): ShellCommand | undefined {
  const tokens: string[] = [];
  let cur = '';
  let started = false; // whether `cur` is an open token (so a quoted empty string `""` still yields a token)
  let quote: "'" | '"' | undefined;
  for (const ch of rest) {
    if (quote !== undefined) {
      if (ch === quote) quote = undefined;
      else cur += ch;
      started = true;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      started = true;
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      if (started) {
        tokens.push(cur);
        cur = '';
        started = false;
      }
      continue;
    }
    cur += ch;
    started = true;
  }
  if (started) tokens.push(cur);
  const [command, ...args] = tokens;
  if (command === undefined || command.length === 0) return undefined;
  return { command, args };
}

/** The resolved command string (binary + args joined) — for the allowlist-deny hint + the injection `cmd` attr. */
export function commandLine(cmd: ShellCommand): string {
  return [cmd.command, ...cmd.args].join(' ');
}

/**
 * The ACTIONABLE, secret-free deny message (ADR-0061 — "never a dead 'denied'"). An `allowlist` miss shows the
 * exact `[chat].allowed_commands` line to add; a mode/approval deny is either the `ask`/`plan` mode floor (offer
 * the Shift+Tab switch) or a user decline. The command string is the user's OWN typed input (already visible +
 * history-recallable), so echoing it adds no exposure.
 */
export function shellDenyHint(cmd: ShellCommand, allowlist: boolean, mode: ChatMode): string {
  const line = commandLine(cmd);
  if (allowlist) {
    return `! ${line}: not allowed. Add "${line}" to [chat].allowed_commands to enable it.`;
  }
  if (mode === 'ask' || mode === 'plan') {
    return `! ${line}: denied in ${mode} mode. Switch to accept-edits or auto (Shift+Tab) to run it.`;
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
  return frameUntrusted('command', { cmd: commandLine(cmd), exit: String(exitCode) }, body, nonce);
}
