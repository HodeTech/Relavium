import { sanitizeInline } from '../render/sanitize.js';

/**
 * How many notices the ring keeps: the newest {@link RUN_NOTICE_CAPACITY} lines, oldest first.
 *
 * Fifty is far more than a leg writes in practice (a withheld-effort warning, an unpriced-model warning, a few
 * skipped-MCP lines, a departure diagnostic) and small enough that a leg which writes without end holds a fixed,
 * small amount of memory: `RUN_NOTICE_CAPACITY` x `RUN_NOTICE_WIDTH` code points, and nothing else.
 */
export const RUN_NOTICE_CAPACITY = 50;

/**
 * The widest an entry gets, in code points, the ellipsis included. A longer line is cut and ends in `…`, so no
 * single write (a provider body, a path, an echoed value) can take more of the Home's one notice channel than a
 * line's worth.
 */
export const RUN_NOTICE_WIDTH = 200;

/**
 * The most of one write that is looked at, counted from its END (the newest text). A write larger than this is
 * not a notice but a flood; its leading partial line is dropped so a cut never shows up as an entry.
 */
const MAX_WRITE_CHARS = 16 * 1024;

const ELLIPSIS = '…';

/** Cut to `width` code points (never in the middle of a surrogate pair), ending in an ellipsis when it cut. */
function fit(line: string): string {
  const points = Array.from(line);
  if (points.length <= RUN_NOTICE_WIDTH) return line;
  return points.slice(0, RUN_NOTICE_WIDTH - 1).join('') + ELLIPSIS;
}

/**
 * The Home's notice channel for a hosted run
 * ([ADR-0139](../../../../docs/decisions/0139-a-workflow-run-is-hosted-inside-the-home.md) §3): everything the
 * run core writes to stderr or stdout while a leg executes (the withheld-effort, unpriced and legacy-hold
 * warnings, the snapshot-literal warning, the skipped-MCP lines, the consent refusal's lines, the departure
 * diagnostics) lands here instead of on the terminal, because the Home writes nothing to stderr while it owns the
 * screen.
 *
 * It is a bounded ring of one-line, sanitized entries:
 *
 * - **Bounded**: the newest {@link RUN_NOTICE_CAPACITY} entries, each at most {@link RUN_NOTICE_WIDTH} code points.
 * - **Sanitized**: every line passes `sanitizeInline` BEFORE it is cut, so no terminal control, escape sequence or
 *   line break survives into an entry and a cut can never leave half of one.
 * - **Read-only to its readers**: {@link snapshot} is a frozen copy, so a reader cannot change what the next
 *   reader sees.
 *
 * It does not redact. The text is what this process composed (each call site already passes what it quotes
 * through the sanitize floor); this layer is the floor under them, not a second author.
 */
export class RunNotices {
  #entries: string[] = [];

  /** The number of entries held. */
  get size(): number {
    return this.#entries.length;
  }

  /**
   * Take a write as it was handed to `writeErr` or `writeOut`: any number of lines, with or without a trailing
   * newline. Blank lines are not entries.
   */
  push(text: string): void {
    let source = text;
    if (source.length > MAX_WRITE_CHARS) {
      source = source.slice(-MAX_WRITE_CHARS);
      const firstBreak = source.indexOf('\n');
      if (firstBreak !== -1) source = source.slice(firstBreak + 1);
    }
    for (const raw of source.split('\n')) {
      const line = sanitizeInline(raw).trimEnd();
      if (line === '') continue;
      this.#entries.push(fit(line));
    }
    if (this.#entries.length > RUN_NOTICE_CAPACITY)
      this.#entries = this.#entries.slice(-RUN_NOTICE_CAPACITY);
  }

  /** The entries, oldest first, as a frozen copy. */
  snapshot(): readonly string[] {
    return Object.freeze([...this.#entries]);
  }

  /** Forget every entry (a new run starts, or the person dismissed them). */
  clear(): void {
    this.#entries = [];
  }
}
