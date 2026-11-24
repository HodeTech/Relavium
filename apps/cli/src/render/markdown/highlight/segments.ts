import type { SyntaxToken } from '../types.js';

/** One classed run of the code. The runs of a block, joined, are exactly the block's text. */
export interface CodeSegment {
  readonly text: string;
  readonly token: SyntaxToken;
}

/** A scanner stopped advancing, or advanced more often than any linear scan can. It is a bug, never an input error. */
export class HighlightBudgetError extends Error {
  constructor() {
    super('highlight scanner exceeded its step budget');
    this.name = 'HighlightBudgetError';
  }
}

/**
 * Collects the classed runs of one code block (ADR-0144).
 *
 * A scanner only says where the next run ENDS. The runs are therefore contiguous by construction: no character can be
 * dropped, repeated or reordered, whatever the scanner does, and the text is never edited. Every scanner step is
 * counted against a budget proportional to the text, so a scanner that stopped advancing becomes an error instead of
 * a hang.
 */
export class Segments {
  private readonly ends: number[] = [];
  private readonly tokens: SyntaxToken[] = [];
  /** The last search for each needle: where it started and where it found the needle (-1: nowhere from there on). */
  private readonly searches = new Map<string, { readonly from: number; readonly at: number }>();
  private cursor = 0;
  private steps = 0;
  private readonly source: string;
  private readonly budget: number;

  constructor(source: string, budget: number) {
    this.source = source;
    this.budget = budget;
  }

  /** Where the next run starts: everything before it is already classed. */
  get position(): number {
    return this.cursor;
  }

  /** Steps counted so far; tests assert it stays linear in the text. */
  get work(): number {
    return this.steps;
  }

  /** Count one scanner step. */
  tick(): void {
    this.charge(1);
  }

  /** Count `units` characters read ahead against the budget. */
  charge(units: number): void {
    this.steps += units;
    if (this.steps > this.budget) throw new HighlightBudgetError();
  }

  /**
   * `source.indexOf(needle, from)`, charged for the characters it reads and remembered for each needle: asking again
   * past a search that found nothing, or inside the span of one that did, reads nothing. Looking ahead for a closer
   * that never comes therefore costs one pass over the text, however often it is asked; scanners use this and not
   * `indexOf`, so that the work counter sees every character read and the cost stays linear.
   */
  find(needle: string, from: number): number {
    const known = this.searches.get(needle);
    if (known && from >= known.from && (known.at < 0 || from <= known.at)) return known.at;
    const at = this.source.indexOf(needle, from);
    this.charge(Math.max(0, (at < 0 ? this.source.length : at + needle.length) - from));
    this.searches.set(needle, { from, at });
    return at;
  }

  /** The index of the next newline at or after `from`, or the end of the text. */
  lineEnd(from: number): number {
    const at = this.find('\n', from);
    return at < 0 ? this.source.length : at;
  }

  /** Class everything from the cursor up to `end` (exclusive). An `end` at or before the cursor adds nothing. */
  to(end: number, token: SyntaxToken): void {
    const limit = Math.min(end, this.source.length);
    if (!(limit > this.cursor)) return; // NOSONAR — S1940: the negation is deliberate, it is also true for NaN, which `<=` would let through
    const last = this.tokens.length - 1;
    if (last >= 0 && this.tokens[last] === token) this.ends[last] = limit;
    else {
      this.ends.push(limit);
      this.tokens.push(token);
    }
    this.cursor = limit;
  }

  /** Class `[start, end)` as `token`; whatever lies between the cursor and `start` is plain text. */
  mark(start: number, end: number, token: SyntaxToken): void {
    this.to(start, 'text');
    this.to(end, token);
  }

  /** The runs, with the rest of the text, if any, as plain text. */
  finish(): readonly CodeSegment[] {
    this.to(this.source.length, 'text');
    const segments: CodeSegment[] = [];
    let start = 0;
    for (const [index, end] of this.ends.entries()) {
      segments.push({ text: this.source.slice(start, end), token: this.tokens[index] ?? 'text' });
      start = end;
    }
    return segments;
  }
}

/** A scanner for one language family. It reads `source` and classes it through `out`. */
export type Scanner = (source: string, out: Segments) => void;
