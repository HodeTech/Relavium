import { stripTerminalControls } from './sanitize.js';

/** Maximum withheld unfinished control string; source retention is owned by the turn. */
export const MAX_PENDING_TERMINAL_CONTROL = 65_536;
type Mode = 'plain' | 'escape' | 'csi' | 'string' | 'string-escape';

/**
 * Frame split terminal controls before applying the existing shared sanitizer.
 * A partial OSC/CSI never leaks its body into a markdown parser. This is framing,
 * not a second sanitizer: every released fragment uses stripTerminalControls.
 * Oversize unfinished controls suspend this segment's live display; completed
 * source is independently sanitized from the retained turn at its terminal.
 */
export class TerminalStream {
  private mode: Mode = 'plain';
  private pending: string[] = [];
  private pendingLength = 0;
  private intermediate = false;
  private suspended = false;

  get overflowed(): boolean {
    return this.suspended;
  }

  append(chunk: string): string {
    if (this.suspended) return '';
    const out: string[] = [];
    let i = 0;
    const hold = (text: string): void => {
      this.pending.push(text);
      this.pendingLength += text.length;
      if (this.pendingLength > MAX_PENDING_TERMINAL_CONTROL) {
        this.pending = [];
        this.pendingLength = 0;
        this.suspended = true;
      }
    };
    const release = (): void => {
      out.push(stripTerminalControls(this.pending.join('')));
      this.pending = [];
      this.pendingLength = 0;
      this.mode = 'plain';
      this.intermediate = false;
    };
    while (i < chunk.length && !this.suspended) {
      if (this.mode === 'plain') {
        const escape = chunk.indexOf('\x1b', i);
        const end = escape < 0 ? chunk.length : escape;
        out.push(stripTerminalControls(chunk.slice(i, end)));
        i = end;
        if (escape >= 0) {
          hold('\x1b');
          this.mode = 'escape';
          i += 1;
        }
        continue;
      }
      const char = chunk.charAt(i);
      if (this.mode === 'escape') {
        if (char === '[') {
          hold(char);
          this.mode = 'csi';
          i += 1;
        } else if (']P^_X'.includes(char)) {
          hold(char);
          this.mode = 'string';
          i += 1;
        } else {
          // Release ESC on its own if another ESC starts a new sequence.
          if (char !== '\x1b') {
            hold(char);
            i += 1;
          }
          release();
        }
        continue;
      }
      if (this.mode === 'csi') {
        const code = char.charCodeAt(0);
        if (code >= 0x40 && code <= 0x7e) {
          hold(char);
          i += 1;
          release();
        } else if (
          (code >= 0x30 && code <= 0x3f && !this.intermediate) ||
          (code >= 0x20 && code <= 0x2f)
        ) {
          this.intermediate ||= code < 0x30;
          hold(char);
          i += 1;
        } else release(); // Invalid continuation is processed again as ordinary input.
        continue;
      }
      if (this.mode === 'string-escape') {
        if (char === '\\') {
          hold(char);
          i += 1;
          release();
        } else {
          // That ESC invalidated the old string and begins its own sequence.
          this.pending.pop(); // ESC was always held as its own fragment.
          this.pendingLength -= 1;
          release();
          hold('\x1b');
          this.mode = 'escape';
        }
        continue;
      }
      const bell = chunk.indexOf('\x07', i);
      const escape = chunk.indexOf('\x1b', i);
      const end =
        bell < 0
          ? escape < 0
            ? chunk.length
            : escape
          : escape < 0
            ? bell
            : Math.min(bell, escape);
      hold(chunk.slice(i, end));
      i = end;
      if (this.suspended || i === chunk.length) continue;
      hold(chunk.charAt(i));
      this.mode = chunk.charAt(i) === '\x07' ? 'plain' : 'string-escape';
      i += 1;
      if (this.mode === 'plain') release();
    }
    return out.join('');
  }

  finish(): string {
    const tail = this.suspended ? '' : stripTerminalControls(this.pending.join(''));
    this.reset();
    return tail;
  }

  reset(): void {
    this.mode = 'plain';
    this.pending = [];
    this.pendingLength = 0;
    this.intermediate = false;
    this.suspended = false;
  }
}
