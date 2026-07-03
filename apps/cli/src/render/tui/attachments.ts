import { boundInjection, injectionNonce, INJECT_MAX_CHARS } from './injection.js';
import {
  estimateTokens,
  formatMentionInjection,
  mentionNonce,
  MENTION_TOKEN_WARN,
} from './mention.js';
import { commandLine, formatCommandInjection, type ShellCommand } from './shell.js';

/**
 * The `@`/`!` pending-attachment model (2.5.D, [ADR-0061](../../../../../docs/decisions/0061-cli-input-layer-file-injection-and-shell-escape.md)).
 * Instead of splicing a mentioned file's bytes / a command's output DIRECTLY into the compose editor (which floods
 * the buffer + transcript), each is queued as a compact **pending attachment** shown in a chip bar, and expanded
 * into the shared UNTRUSTED, nonce-fenced frame ({@link injection.ts}) only at SUBMIT — so the model still receives
 * the same unforgeable, bounded context, but the user sees a clean prompt + a `@path` reference / a read-only `!`
 * result. A FILE attachment is referenced inline by its `@path` marker (deleting the marker drops it); a COMMAND
 * attachment is carried context (its output was shown read-only when it ran). Both are TTY-only.
 */
export type PendingAttachment =
  | {
      readonly kind: 'file';
      readonly path: string;
      readonly content: string;
      readonly sizeBytes: number;
    }
  | {
      readonly kind: 'command';
      readonly cmd: ShellCommand;
      readonly exitCode: number;
      readonly stdout: string;
      readonly stderr: string;
    };

/** The `@path` marker inserted into the editor for a file mention — a whitespace-bounded token the submit scan finds. */
export function mentionMarker(path: string): string {
  return `@${path}`;
}

/** Whether `@path` appears as a whitespace-bounded token in `line` — so a DELETED marker drops its attachment, and a
 *  mid-word `@` (an email `x@path`) never matches. */
export function mentionPresent(line: string, path: string): boolean {
  const marker = mentionMarker(path);
  for (let i = line.indexOf(marker); i >= 0; i = line.indexOf(marker, i + 1)) {
    const before = i === 0 ? ' ' : line.charAt(i - 1);
    const afterIdx = i + marker.length;
    const after = afterIdx >= line.length ? ' ' : line.charAt(afterIdx);
    if (/\s/.test(before) && /\s/.test(after)) return true;
  }
  return false;
}

/** A compact chip label for the attachment bar (`@src/foo.ts` / `!npm test (exit 0)`). */
export function attachmentChip(a: PendingAttachment): string {
  return a.kind === 'file' ? mentionMarker(a.path) : `!${commandLine(a.cmd)} (exit ${a.exitCode})`;
}

/** Expand ONE attachment into its framed, UNTRUSTED, nonce-fenced block (a fresh nonce per expansion). */
function expandOne(a: PendingAttachment): string {
  return a.kind === 'file'
    ? formatMentionInjection(a.path, a.content, mentionNonce())
    : formatCommandInjection(a.cmd, a.exitCode, a.stdout, a.stderr, injectionNonce());
}

/** The outbound build for a submit — what the model receives + what the transcript shows + which attachments were used. */
export interface Outbound {
  /** The message SENT to the model: the prose + each consumed attachment's framed block. */
  readonly message: string;
  /** The COMPACT string shown in the transcript: the prose (file `@markers` are already visible in it) plus a
   *  `[📎 …]` note for carried COMMAND outputs, which have no marker in the line. */
  readonly display: string;
  /** The attachments actually included — the caller clears exactly these (a file whose marker the user deleted stays). */
  readonly consumed: readonly PendingAttachment[];
}

/**
 * Build the outbound message + compact display for a submitted `line`. A FILE attachment is included only if its
 * `@path` marker is still present in `line`; a COMMAND attachment is always included (carried context). The framed
 * blocks are appended AFTER the prose (each begins with its own `\n\n` separator).
 */
export function buildOutbound(line: string, attachments: readonly PendingAttachment[]): Outbound {
  const consumed = attachments.filter((a) => a.kind === 'command' || mentionPresent(line, a.path));
  const message = line + consumed.map(expandOne).join('');
  const commands = consumed.filter((a) => a.kind === 'command');
  const display =
    commands.length > 0 ? `${line} [📎 ${commands.map(attachmentChip).join(', ')}]` : line;
  return { message, display, consumed };
}

/** The soft size warning for an accepted FILE attachment, computed from the ACTUALLY-INJECTED (bounded) length — NOT
 *  the raw file size — so the count is honest, and it says so when the file was truncated to fit. `undefined` ⇒ no
 *  warning needed. */
export function fileAttachmentWarning(
  path: string,
  content: string,
  sizeBytes: number,
): string | undefined {
  const truncated = content.length > INJECT_MAX_CHARS;
  const injectedTokens = estimateTokens(Math.min(sizeBytes, INJECT_MAX_CHARS));
  if (truncated) {
    return `@${path}: truncated to fit — only ~${injectedTokens} tokens (head+tail) reach the model`;
  }
  if (injectedTokens > MENTION_TOKEN_WARN) {
    return `@${path} is large (~${injectedTokens} tokens) — it may crowd the context`;
  }
  return undefined;
}

/** A compact read-only preview of a `!`-command's output for the transcript (the FULL output rides the next message
 *  as an attachment). Bounds to `maxLines` with a "… (N more lines) …" marker; the store strips control chars on
 *  display, so this stays a safe preview. */
export function commandResultPreview(
  cmd: ShellCommand,
  exitCode: number,
  stdout: string,
  stderr: string,
  maxLines = 20,
): string {
  const header = `! ${commandLine(cmd)} (exit ${exitCode})`;
  // Merge the streams: stderr (if any) rides under a `[stderr]` marker; an empty stream is dropped, so a stderr-only
  // result has no leading blank line and a stdout-only result has no trailing marker.
  const stderrBlock = stderr.length > 0 ? `[stderr] ${stderr}` : '';
  const merged = [stdout, stderrBlock].filter((part) => part.length > 0).join('\n');
  // Byte-bound first (a single huge line — a base64 blob, minified output — would otherwise sail past the LINE cap
  // straight into the `<Static>` notice), then trim + line-bound: the same double-bound discipline as `injection.ts`.
  const combined = boundInjection(merged.trimEnd()).trimEnd();
  if (combined.length === 0) return `${header}\n(no output)`;
  const lines = combined.split('\n');
  const shown =
    lines.length > maxLines
      ? [
          ...lines.slice(0, maxLines),
          `… (${lines.length - maxLines} more lines — full output attached to your next message) …`,
        ]
      : lines;
  return [header, ...shown].join('\n');
}

/** Bound the number of pending attachments (defensive — the chip bar + expansion should never grow unbounded). */
export const MAX_PENDING_ATTACHMENTS = 20;

/**
 * Append `a` to `list`, deduping a FILE by path (a repeat `@path` is a no-op) and evicting the OLDEST to keep the
 * list within {@link MAX_PENDING_ATTACHMENTS}. Pure so both surfaces (the standalone `ChatApp` + the Home) share
 * one implementation + one test. `dropped` is how many were evicted (0 = under the cap or a dedup no-op) so the
 * caller can surface an honest "limit reached" note rather than silently losing the oldest attachment.
 */
export function appendAttachment(
  list: readonly PendingAttachment[],
  a: PendingAttachment,
): { readonly list: readonly PendingAttachment[]; readonly dropped: number } {
  if (a.kind === 'file' && list.some((x) => x.kind === 'file' && x.path === a.path)) {
    return { list, dropped: 0 }; // dedup — one entry per file path
  }
  const grown = [...list, a];
  const dropped = Math.max(0, grown.length - MAX_PENDING_ATTACHMENTS);
  return { list: dropped > 0 ? grown.slice(dropped) : grown, dropped };
}
