import { scrubbedCommandDisplay } from '@relavium/core';

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
 * result. A FILE attachment is referenced inline by its `@path` marker (deleting the marker drops it, at that edit:
 * {@link attachmentsOfDraft}); a COMMAND attachment is carried context (its output was shown read-only when it ran).
 * Both are TTY-only.
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

/**
 * The pending attachments `draft` still references: a FILE attachment stays only while its `@path` marker is in the draft as a
 * whitespace-bounded token ({@link mentionPresent}); a COMMAND attachment has no marker by design (it is carried context, drawn in the
 * chat's chip bar, cleared by `Esc`) and stays. The ONE rule both surfaces (the Home's prompts and the chat it hosts, and the stand-alone
 * `ChatApp`) apply after EVERY change to the draft or to the list (MVP-11 unit 7, round 2 sitting #3): an attachment whose marker left the
 * draft (deleted, cleared, replaced by a command line or a recalled entry) is gone for good, so a marker typed, pasted or recalled later is
 * plain text and never brings back the content read at an earlier pick. The Home draws no chip bar, so without this a file the person could
 * no longer see rode the next message that happened to name it. `list` itself when nothing is dropped (callers compare by reference).
 */
export function attachmentsOfDraft(
  draft: string,
  list: readonly PendingAttachment[],
): readonly PendingAttachment[] {
  const kept = list.filter((a) => a.kind === 'command' || mentionPresent(draft, a.path));
  return kept.length === list.length ? list : kept;
}

/**
 * How long an `Enter` that would send is held off after an `Enter` chose a file in the `@` picker: the approval card's lockout (2 s), for the
 * same reason. A key held through the choice auto-repeats only after the terminal's initial delay (250 to 1800 ms), so a quiet-gap rule
 * cannot tell its first repeat from a deliberate press; a window from the choice, restarted by each `Enter` inside it, can.
 */
export const PICK_ENTER_LOCKOUT_MS = 2000;

/**
 * The guard against a held `Enter` that chose a file in the `@` picker and then sent the message (MVP-11 unit 7, round 2 sitting #3: on the
 * Home a held `Enter` on the picker started a chat with the file, and in a chat it sent the message, with no deliberate send). After
 * {@link PickEnterLock.chosen}, an `Enter` that would send inside {@link PICK_ENTER_LOCKOUT_MS} is a repeat of the one that chose: it is
 * ignored and restarts the window, so a key held at any rate never sends. Any other key or a paste ({@link PickEnterLock.typed}) is the person
 * typing: the next `Enter` is theirs. Pure but for the clock the caller passes, so the Home's controller and `ChatApp` share it.
 */
export interface PickEnterLock {
  /** An `Enter` chose a file in the picker at `at`. */
  readonly chosen: (at: number) => void;
  /** A key other than `Enter`, or a paste: the window ends. */
  readonly typed: () => void;
  /** Whether an `Enter` that would send at `at` is held off; `true` restarts the window. */
  readonly holds: (at: number) => boolean;
}

export function createPickEnterLock(): PickEnterLock {
  let since: number | undefined;
  return {
    chosen: (at) => {
      since = at;
    },
    typed: () => {
      since = undefined;
    },
    holds: (at) => {
      if (since === undefined || at - since >= PICK_ENTER_LOCKOUT_MS) {
        since = undefined;
        return false;
      }
      since = at;
      return true;
    },
  };
}

/** A compact chip label for the attachment bar (`@src/foo.ts` / `!npm test (exit 0)`). */
export function attachmentChip(a: PendingAttachment): string {
  return a.kind === 'file' ? mentionMarker(a.path) : `!${commandLine(a.cmd)} (exit ${a.exitCode})`;
}

/** The chip as the transcript stores it: a file's marker, or a command's scrubbed line (`attachmentChip` is the live, local bar). */
function storedChip(a: PendingAttachment): string {
  return a.kind === 'file'
    ? mentionMarker(a.path)
    : `!${scrubbedCommandDisplay([a.cmd.command, ...a.cmd.args])} (exit ${a.exitCode})`;
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
  /** The attachments actually included — the caller clears exactly these (a file whose marker left the draft was already dropped at that edit). */
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
  // The display is what the transcript keeps and what the session stores as `user_display_text`: a command's note is its SCRUBBED line,
  // like the frame's `cmd`, so a credential typed after `!` is not written to history.db by the note (the live attachment bar is local).
  const display =
    commands.length > 0 ? `${line} [📎 ${commands.map(storedChip).join(', ')}]` : line;
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
