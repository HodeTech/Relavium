/**
 * The system clipboard over **OSC 52** — the output half of copy-on-select (2.6.F Step 6, ADR-0068 §e amendment).
 *
 * OSC 52 asks the terminal EMULATOR to set the clipboard, so it works wherever the escape reaches: a local terminal,
 * a plain SSH session, a container. That is the whole reason to prefer it over shelling out to `pbcopy`/`xclip`/
 * `wl-copy` — no platform branch, no child process, and it is the only mechanism that survives SSH.
 *
 * SECURITY. The payload is base64, so no byte of transcript text can terminate the escape and inject a sequence of
 * its own — the encoding is the boundary. (The text is also already sanitized upstream: it comes from the wrapped
 * `DisplayLine`s, which `entryLines` stripped of ANSI/C0/C1 and Trojan-Source bidi controls.) We only ever WRITE:
 * OSC 52 can also *read* the clipboard back with a `?` payload, which would let a rogue MCP server or model output
 * exfiltrate whatever the user last copied. This module never emits `?`, and nothing else in the CLI emits OSC 52.
 *
 * KNOWN TERMINAL REALITY, designed for rather than discovered later (each is a live issue against a competing agent
 * CLI that shipped copy-on-select first):
 *   - **tmux** swallows a bare OSC 52; it must be wrapped in a DCS passthrough, and the user must have
 *     `set-clipboard on`. {@link encodeOsc52} does the wrapping; the tmux option is theirs to set.
 *   - **VS Code Remote SSH** silently drops OSC 52 entirely. There is no reply to detect that — OSC 52 write has no
 *     acknowledgement — so a copy can never be *confirmed*, only attempted. Callers must not claim success they
 *     cannot know: {@link ClipboardOutcome} says `'written'`, not `'copied'`.
 *   - Terminals cap the escape's length. {@link OSC52_MAX_BASE64_LENGTH} is the conservative floor; beyond it we
 *     refuse rather than truncate, because a silently half-copied selection is worse than a refusal.
 */

/** The OSC 52 clipboard selection to set. `c` (CLIPBOARD) is the only one macOS terminals implement; X11's `p`
 *  (PRIMARY) is deliberately not written — it would surprise a Linux user by clobbering their middle-click buffer. */
const CLIPBOARD_SELECTION = 'c';

/**
 * The maximum base64 payload we will emit. tmux refuses a longer DCS, and several terminals bound the OSC string
 * similarly; taking the smallest documented limit keeps behaviour identical everywhere instead of "works until it
 * silently does not". ~74 KB of base64 ≈ ~56 KB of UTF-8 text — far more than any plausible selection, and less than
 * a large transcript, which is what `/scrollback` and `/edit` are for.
 */
export const OSC52_MAX_BASE64_LENGTH = 74_994;

/** The terminal multiplexer we are running inside, if any — it changes how the escape must be framed. */
export type Multiplexer = 'tmux' | 'zellij';

/** Detect the multiplexer from the environment it sets for its children. */
export function detectMultiplexer(
  env: Readonly<Record<string, string | undefined>>,
): Multiplexer | undefined {
  if (env['TMUX'] !== undefined && env['TMUX'] !== '') return 'tmux';
  if (env['ZELLIJ'] !== undefined && env['ZELLIJ'] !== '') return 'zellij';
  return undefined;
}

/**
 * Encode `text` as an OSC 52 clipboard-set escape.
 *
 * Inside **tmux** the escape is wrapped in a DCS passthrough (`ESC P tmux; … ESC \`) with every inner `ESC` DOUBLED —
 * that doubling is what tells tmux to forward the byte rather than interpret it. Without this, tmux consumes the
 * OSC 52 and nothing reaches the outer terminal.
 *
 * Zellij forwards OSC 52 unwrapped, so it takes the plain form.
 */
export function encodeOsc52(base64: string, multiplexer?: Multiplexer): string {
  const osc = `\x1b]${52};${CLIPBOARD_SELECTION};${base64}\x07`;
  if (multiplexer !== 'tmux') return osc;
  return `\x1bPtmux;${osc.replaceAll('\x1b', '\x1b\x1b')}\x1b\\`;
}

/** What a copy attempt did. Never `'copied'`: OSC 52 has no acknowledgement, so a terminal that drops the escape
 *  (VS Code Remote SSH) is indistinguishable from one that honoured it. We report what we WROTE. */
export type ClipboardOutcome =
  /** The escape was written to the terminal. Whether the emulator honoured it is unknowable from here. */
  | { readonly kind: 'written'; readonly characters: number }
  /** Nothing was selected — no escape emitted. */
  | { readonly kind: 'empty' }
  /** Past the terminal's escape-length floor. Refused rather than truncated. */
  | { readonly kind: 'too-large'; readonly base64Length: number; readonly limit: number };

export interface ClipboardDeps {
  /** Write a raw control sequence to the TTY (the same sink the alt-buffer toggles use). */
  readonly writeControl: (sequence: string) => void;
  /** The process environment — read for the multiplexer detection only. */
  readonly env: Readonly<Record<string, string | undefined>>;
}

/**
 * Put `text` on the system clipboard. Total: never throws, and never writes a truncated payload.
 */
export function copyToClipboard(deps: ClipboardDeps, text: string): ClipboardOutcome {
  if (text.length === 0) return { kind: 'empty' };

  const base64 = Buffer.from(text, 'utf8').toString('base64');
  if (base64.length > OSC52_MAX_BASE64_LENGTH) {
    return { kind: 'too-large', base64Length: base64.length, limit: OSC52_MAX_BASE64_LENGTH };
  }

  deps.writeControl(encodeOsc52(base64, detectMultiplexer(deps.env)));
  return { kind: 'written', characters: text.length };
}
