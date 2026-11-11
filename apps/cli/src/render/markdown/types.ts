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
  readonly rows?: readonly (readonly string[])[];
  readonly align?: readonly ('left' | 'right' | 'center')[];
}

export interface MarkdownDisplayLine {
  readonly text: string;
  readonly spans: readonly MarkdownSpan[];
}
