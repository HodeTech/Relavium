/**
 * What a piece of highlighted code is (ADR-0144). A class, not a colour: the caller owns the palette. `text` is code
 * that is highlighted but has no class of its own (identifiers, punctuation, whitespace).
 */
export type SyntaxToken =
  | 'text'
  | 'keyword'
  | 'string'
  | 'number'
  | 'constant'
  | 'comment'
  | 'type'
  | 'function'
  | 'property'
  | 'variable'
  | 'meta'
  | 'inserted'
  | 'deleted'
  | 'hunk';

/** Text and semantic styling only; callers draw it without terminal escapes. */
export interface MarkdownSpan {
  readonly text: string;
  readonly strong?: boolean;
  readonly emphasis?: boolean;
  readonly code?: boolean;
  readonly strike?: boolean;
  readonly heading?: number;
  readonly quote?: boolean;
  readonly dim?: boolean;
  readonly linkURL?: string;
  /** Set only on the spans of a highlighted fenced code block (ADR-0144); the text is never changed by it. */
  readonly token?: SyntaxToken;
}

export interface MarkdownBlock {
  readonly kind: 'paragraph' | 'heading' | 'code' | 'list' | 'quote' | 'rule' | 'literal' | 'table';
  readonly source: string;
  readonly text: string;
  readonly spans?: readonly MarkdownSpan[];
  readonly prefix?: string;
  readonly continuation?: string;
  /** Display columns omitted before the first logical line, for tab stops. */
  readonly tabOffset?: number;
  readonly quoted?: boolean;
  readonly raw?: boolean;
  readonly heading?: number;
  readonly info?: string;
  /**
   * The start of the fence's info string, kept for the highlighter when the live window had to clip or drop `info`
   * (the label is the window's to omit; the language is not). Read before `info` (ADR-0144).
   */
  readonly highlightInfo?: string;
  readonly rows?: readonly (readonly string[])[];
  readonly align?: readonly ('left' | 'right' | 'center')[];
  /**
   * A table over a fixed limit, kept as literal source (ADR-0143). Its wrapped lines start at their text, not at the
   * space that broke them, because a table's spacing is not prose.
   */
  readonly tableSource?: boolean;
}

export interface MarkdownDisplayLine {
  readonly text: string;
  readonly spans: readonly MarkdownSpan[];
}
