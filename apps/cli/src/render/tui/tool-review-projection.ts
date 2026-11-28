import { secretShapedRanges, type ToolPreview } from '@relavium/core';
import { secretMaskRanges } from '@relavium/llm/scrub-secrets';
import { sanitizeUntrusted, stripTerminalControls } from '../sanitize.js';
import { isNarrowEmojiBase, isWidthRiskCodePoint } from './screen-text.js';
import { displayWidth, isPrepend } from './viewport.js';

export interface SourceRange {
  readonly field: number;
  readonly start: number;
  readonly end: number;
}
export interface ReviewMask extends SourceRange {
  readonly id: number;
  readonly bytes: number;
  readonly flagged: boolean;
}
export interface ReviewField {
  readonly text: string;
  readonly masks: readonly ReviewMask[];
  readonly byteIndex: readonly { offset: number; bytes: number }[];
}
/** What a projected row IS, for colour and for the compact card — typed UI framing, never inferred from source. */
export type ReviewRowKind = 'added' | 'removed' | 'context' | 'meta';
export interface ReviewSourceLine extends SourceRange {
  readonly label: string;
  readonly ending: 'lf' | 'crlf' | 'none' | 'field';
  readonly changed: boolean;
  readonly trailingStart?: number;
  /** The diff role of a diff line; absent for a target/field line. */
  readonly kind?: ReviewRowKind;
  /**
   * The `=before N` copy of a context line. The full view lists both sides so every byte of each is inspectable;
   * the compact card shows a context line once (its `=N` after-side copy) and skips this one.
   */
  readonly cardSkip?: boolean;
  /**
   * The `=before N` copy of a context line that the full view ALSO leaves out, because nothing on it differs from its
   * `=N` twin: the two copies are byte-identical, so the one thing a second copy could add is a mask on the before side.
   * Set only where no mask touches the before copy; a masked before copy stays listed, because that is the one place its
   * mask can be inspected (ADR-0134 §2). The card skips every before copy ({@link ReviewSourceLine.cardSkip}).
   */
  readonly fullSkip?: boolean;
  /**
   * Whether the ending notation is printed after this line (ADR-0129 §4). `false` only for a `lf`/`crlf` line whose
   * side is uniformly that ending and whose other side is empty or the same — the ordinary case. A differing,
   * mixed or unterminated ending always shows its token, so a change of endings can never look unchanged.
   */
  readonly showEnding?: boolean;
}
export interface ReviewDocument {
  readonly valid: boolean;
  readonly preview: ToolPreview;
  readonly fields: readonly ReviewField[];
  readonly lines: readonly ReviewSourceLine[];
  readonly masks: readonly ReviewMask[];
  readonly required: readonly SourceRange[];
  readonly sourceBytes: number;
  readonly changedBytes: number;
  readonly changedLines: number;
  readonly remainingBytes: readonly number[];
  /** Suffix counts over the lines the COMPACT card shows (everything but {@link ReviewSourceLine.cardSkip}). */
  readonly cardRemainingLines: readonly number[];
  readonly cardRemainingBytes: readonly number[];
  /** Suffix counts of the changed (added or removed) lines: entry `n` is how many changed lines sit at index `n` or later. */
  readonly changedRemainingLines: readonly number[];
  /** Index of the first changed line, so the compact card can open on the change rather than on the file's top. */
  readonly firstChangedLine: number | undefined;
  /** Suffix counts over the lines the full view lists (everything but {@link ReviewSourceLine.fullSkip}). */
  readonly fullRemainingLines: readonly number[];
  readonly fullRemainingBytes: readonly number[];
  /**
   * Index of the first line of every change, in order: what "next change" and "previous change" move between. A change is a
   * run of changed lines; two runs no more than {@link CHANGE_GAP_LINES} unchanged lines apart are one change.
   */
  readonly changeStarts: readonly number[];
}
export interface ReviewCursor {
  readonly line: number;
  readonly offset: number;
}
export const REVIEW_START: ReviewCursor = Object.freeze({ line: 0, offset: 0 });
const encoder = new TextEncoder();
export const reviewBytes = (text: string): number => encoder.encode(text).byteLength;

interface SourceSpan {
  readonly start: number;
  readonly end: number;
}
/**
 * What scanning one text for review costs, and the only part of a field that does: the secret spans, the
 * display-floor check and the byte index. It does not depend on where the text sits in a document, so a diff
 * side is analysed once and re-stamped into every document built from the same diff.
 */
interface TextAnalysis {
  readonly text: string;
  readonly spans: readonly SourceSpan[];
  readonly byteIndex: ReviewField['byteIndex'];
}

/** Merge two sorted-or-not lists of ranges into sorted ranges that do not overlap (ranges that only touch stay apart). */
function unionRanges(
  left: readonly SourceSpan[],
  right: readonly SourceSpan[],
): readonly SourceSpan[] {
  const merged: { start: number; end: number }[] = [];
  for (const range of [...left, ...right].sort((a, b) => a.start - b.start || a.end - b.end)) {
    const last = merged.at(-1);
    if (last !== undefined && range.start < last.end) last.end = Math.max(last.end, range.end);
    else merged.push({ start: range.start, end: range.end });
  }
  return merged;
}

/**
 * Compose the diagnostic floor without guessing where replacement strings came from.
 *
 * `command` adds what the engine's event preview masks in a command's text (`secretShapedRanges`): the two scrubbers do not
 * recognize the same shapes (`password=…`, `--api_key=…`, `secret=…` are the engine's), and what the event hides the card, its
 * masked copy and its details must hide as well. The floor below is checked against the diagnostic scrubber's own spans, so it
 * runs before the engine's are added.
 */
function analyseText(text: string, command = false): TextAnalysis {
  let spans: readonly SourceSpan[] = secretMaskRanges(text);
  let projected = '',
    cursor = 0;
  for (const span of spans) {
    projected += text.slice(cursor, span.start) + '[REDACTED]';
    cursor = span.end;
  }
  projected += text.slice(cursor);
  if (stripTerminalControls(projected) !== sanitizeUntrusted(text))
    spans = [{ start: 0, end: text.length }];
  if (command) spans = unionRanges(spans, secretShapedRanges(text));
  const byteIndex = [{ offset: 0, bytes: 0 }];
  let offset = 0,
    bytes = 0,
    next = 1024;
  for (const char of text) {
    offset += char.length;
    const cp = char.codePointAt(0) ?? 0;
    bytes += codePointBytes(cp);
    if (offset >= next) {
      byteIndex.push({ offset, bytes });
      next += 1024;
    }
  }
  return { text, spans, byteIndex };
}

/** Place an analysed text in a document: only the masks carry the field index and the running mask id. */
function maskField(analysis: TextAnalysis, field: number, firstId: number): ReviewField {
  const { text } = analysis;
  return {
    text,
    byteIndex: analysis.byteIndex,
    masks: analysis.spans.map((span, index) => ({
      ...span,
      field,
      id: firstId + index,
      bytes: reviewBytes(text.slice(span.start, span.end)),
      flagged: !/^[\p{L}\p{N}\-_.+/=~:]*$/u.test(text.slice(span.start, span.end)),
    })),
  };
}

type DiffSide = 'before' | 'after';
/**
 * The analysis of a diff's sides, by the diff object. The text is compared too, so an entry can never describe a
 * side that has since changed; a diff that is rebuilt into a new document (the details view adds fields to the
 * same diff) therefore does not scan its multi-MiB sides again.
 */
const diffAnalyses = new WeakMap<object, Partial<Record<DiffSide, TextAnalysis>>>();
function analyseDiffSide(diff: object, side: DiffSide, text: string): TextAnalysis {
  const known = diffAnalyses.get(diff)?.[side];
  if (known?.text === text) return known;
  const analysis = analyseText(text);
  diffAnalyses.set(diff, { ...diffAnalyses.get(diff), [side]: analysis });
  return analysis;
}

const documents = new WeakMap<ToolPreview, ReviewDocument>();
/** The previews of a command built with the engine's secret spans too (`command`), apart from the plain ones. */
const commandDocuments = new WeakMap<ToolPreview, ReviewDocument>();
/** The same previews built with every mask required (a command card's), cached apart so none of the three answers for another. */
const strictDocuments = new WeakMap<ToolPreview, ReviewDocument>();

/**
 * Whether a preview can no longer change, so a document built from it stays true for as long as the preview
 * lives. The engine's registry delivers every preview deeply frozen (the preview, its fields, and the diff with
 * its lines and spans); anything else — a hand-built fixture, a surface stub — is rebuilt each time.
 */
function isImmutablePreview(preview: ToolPreview): boolean {
  if (!Object.isFrozen(preview) || !Object.isFrozen(preview.fields)) return false;
  if (!preview.fields.every((field) => Object.isFrozen(field))) return false;
  const diff = preview.diff;
  if (diff === undefined) return true;
  return (
    Object.isFrozen(diff) &&
    Object.isFrozen(diff.stats) &&
    Object.isFrozen(diff.lines) &&
    diff.lines.every(
      (line) =>
        Object.isFrozen(line) &&
        (line.before === undefined || Object.isFrozen(line.before)) &&
        (line.after === undefined || Object.isFrozen(line.after)),
    )
  );
}

/** The cache a document of this kind is kept in: strict (every mask required), command, or ordinary. */
function documentCache(strict: boolean, command: boolean): WeakMap<ToolPreview, ReviewDocument> {
  if (strict) return strictDocuments;
  return command ? commandDocuments : documents;
}

/**
 * Source snapshots occur once; row indexes and masks refer to absolute original UTF-16 offsets. Building scans
 * every field for secrets, which is the cost of the review (260 ms per MiB), so the one preview that is shown as
 * a tool event, then as a card, then as details is built once: the document is kept for the frozen preview.
 *
 * `requireAllMasks` makes EVERY masked span a requirement the person must reveal and see before an affirmative answer counts, not
 * only the ones that hold characters a credential does not (ADR-0118 §1): a command is the one call whose arguments can carry a
 * credential into a process, and a program name or an argument that is nothing but a mask is not something to approve unseen.
 *
 * A command's preview (`command`, which `requireAllMasks` implies) is also masked wherever the engine's event preview of the same
 * command is: see {@link analyseText} and {@link titleHidesArguments}. A file diff's document is never changed by either.
 */
export function createReviewDocument(
  preview: ToolPreview,
  options?: { readonly requireAllMasks?: boolean; readonly command?: boolean },
): ReviewDocument {
  const strict = options?.requireAllMasks === true;
  const command = strict || options?.command === true;
  const cache = documentCache(strict, command);
  const known = cache.get(preview);
  if (known !== undefined) return known;
  const built = buildReviewDocument(preview, strict, command);
  if (isImmutablePreview(preview)) cache.set(preview, built);
  return built;
}

/**
 * Whether a command's title, which is the quoted line, hides what its argument rows hide. Quoting rewrites an embedded `'` as
 * `'"'"'`, which breaks the `key='value'` context a scan reads, so a secret that holds a quote cannot be located in the title and
 * a scan of the title alone can miss it; any other argument text appears in the title as it is, so it is hidden when none of it
 * is left outside the title's masks. When it is not hidden the whole title is masked ({@link analyseTitle}).
 */
function titleHidesArguments(title: TextAnalysis, args: readonly TextAnalysis[]): boolean {
  // Every masked span of the title becomes one character no secret holds, so what is left cannot join into one.
  let shown = '',
    cursor = 0;
  for (const span of title.spans) {
    shown += title.text.slice(cursor, span.start) + '\u0000';
    cursor = span.end;
  }
  shown += title.text.slice(cursor);
  for (const arg of args) {
    for (const span of arg.spans) {
      const secret = arg.text.slice(span.start, span.end);
      if (secret.includes("'") || secret.includes('\u0000') || shown.includes(secret)) return false;
    }
  }
  return true;
}

/**
 * A command's fields analysed one by one, plus what only the whole line shows. The engine's event preview also reads the
 * arguments joined by single spaces (`scrubbedCommandDisplay`'s oracle), which finds a secret split from its key across two
 * arguments (`password=` then the value); its spans are mapped back onto the arguments they cover. Only the unnamed fields are
 * arguments: a named one (a result summary) is not part of the line.
 */
function analyseArguments(fields: ToolPreview['fields']): TextAnalysis[] {
  const argumentIndexes = fields.flatMap((item, index) => (item.name === '' ? [index] : []));
  const joined = argumentIndexes.map((index) => fields[index]?.value ?? '').join(' ');
  const joinedSpans = secretShapedRanges(joined);
  const split = new Map<number, SourceSpan[]>();
  let offset = 0;
  for (const index of argumentIndexes) {
    const length = fields[index]?.value.length ?? 0;
    const here: SourceSpan[] = [];
    for (const span of joinedSpans) {
      const start = Math.max(span.start, offset),
        end = Math.min(span.end, offset + length);
      if (start < end) here.push({ start: start - offset, end: end - offset });
    }
    split.set(index, here);
    offset += length + 1;
  }
  return fields.map((item, index) => {
    const analysis = analyseText(item.value, true);
    const extra = split.get(index) ?? [];
    return extra.length === 0
      ? analysis
      : { ...analysis, spans: unionRanges(analysis.spans, extra) };
  });
}

/** The title, masked as a whole when its own scan does not hide what the argument rows hide. */
function analyseTitle(title: string, args: readonly TextAnalysis[]): TextAnalysis {
  const analysis = analyseText(title, true);
  return titleHidesArguments(analysis, args)
    ? analysis
    : { ...analysis, spans: [{ start: 0, end: title.length }] };
}

function buildReviewDocument(
  preview: ToolPreview,
  requireAllMasks: boolean,
  command: boolean,
): ReviewDocument {
  const invalid = (): ReviewDocument => ({
    valid: false,
    preview: { kind: preview.kind, fields: [] },
    fields: [],
    lines: [],
    masks: [],
    required: [],
    sourceBytes: 0,
    changedBytes: 0,
    changedLines: 0,
    remainingBytes: [0],
    cardRemainingLines: [0],
    cardRemainingBytes: [0],
    changedRemainingLines: [0],
    firstChangedLine: undefined,
    fullRemainingLines: [0],
    fullRemainingBytes: [0],
    changeStarts: [],
  });
  if (!validPreviewBounds(preview) || !validPreviewDiff(preview)) return invalid();
  const fields: ReviewField[] = [],
    lines: ReviewSourceLine[] = [],
    masks: ReviewMask[] = [];
  // A command's arguments are analysed first: the title is masked as a whole when its scan hides less than they do.
  const values = command ? analyseArguments(preview.fields) : [];
  const add = (text: string, side?: DiffSide, known?: TextAnalysis): number => {
    const field = fields.length;
    const analysis =
      known ??
      (side === undefined || preview.diff === undefined
        ? analyseText(text, command)
        : analyseDiffSide(preview.diff, side, text));
    const value = maskField(analysis, field, masks.length + 1);
    fields.push(value);
    masks.push(...value.masks);
    return field;
  };
  const fieldLines = (field: number, label: string): void => {
    const text = fields[field]?.text ?? '';
    lines.push({ field, start: 0, end: text.length, label, ending: 'field', changed: false });
  };
  if (preview.target !== undefined) {
    // Only the unnamed fields are a command's arguments: a named one (a result summary) is not in the quoted line.
    const title = command
      ? analyseTitle(
          preview.target,
          values.filter((_, index) => preview.fields[index]?.name === ''),
        )
      : undefined;
    fieldLines(add(preview.target, undefined, title), 'target');
  }
  preview.fields.forEach((item, index) => {
    // A field with no name is a bare value (a command's arguments): one line, not a blank name line above it.
    if (item.name !== '') fieldLines(add(item.name), 'field name');
    fieldLines(add(item.value, undefined, values[index]), 'field value');
  });
  let changedBytes = 0,
    changedLines = 0;
  if (preview.diff !== undefined) {
    const changes = appendDiffLines(preview.diff, add, fields, lines);
    changedBytes = changes.changedBytes;
    changedLines = changes.changedLines;
  }
  const indexedLines = lines.map((line) => indexTrailingWhitespace(line, fields));
  const remainingBytes = indexRemainingBytes(lines, fields);
  const cardLines = indexRemainingLines(lines);
  const cardBytes = indexRemainingBytes(lines, fields, (line) => line.cardSkip !== true);
  const fullLines = indexRemainingLines(lines, (line) => line.fullSkip !== true);
  const fullBytes = indexRemainingBytes(lines, fields, (line) => line.fullSkip !== true);
  const required = requireAllMasks
    ? masks.map(({ field, start, end }): SourceRange => ({ field, start, end }))
    : requiredInspectionRanges(lines, fields, masks);
  return {
    valid: required.length <= 8192,
    preview,
    fields,
    lines: indexedLines,
    masks,
    required,
    remainingBytes,
    cardRemainingLines: cardLines,
    cardRemainingBytes: cardBytes,
    changedRemainingLines: indexRemainingChanges(lines),
    firstChangedLine: firstChangedIndex(lines),
    fullRemainingLines: fullLines,
    fullRemainingBytes: fullBytes,
    changeStarts: indexChangeStarts(lines),
    sourceBytes: fields.reduce((sum, field) => sum + reviewBytes(field.text), 0),
    changedBytes,
    changedLines,
  };
}

const INVISIBLE = /[\p{C}\p{Z}\p{Default_Ignorable_Code_Point}]/u;
const BLANKS = new Set([0x2800, 0x16fe4, 0x1d159]);
const COMBINING = /\p{M}/u;
/** The halfwidth voiced and semi-voiced sound marks: they extend the cluster before them, so after an emoji they join it (review round 5). */
const HALFWIDTH_VOICED = /^[\uFF9E\uFF9F]$/u;
/** What ends an emoji a halfwidth sound mark would join: a pictograph, its presentation selector, a keycap, a regional indicator, a tag flag's end. */
const EMOJI_END = /^[\p{Extended_Pictographic}\p{Regional_Indicator}\uFE0F\u20E3\u{E007F}]$/u;
/** The code point of `text` that ends just before `position` (a surrogate pair whole), or `undefined` at the start. */
export function codePointBefore(text: string, position: number): string | undefined {
  if (position <= 0) return undefined;
  const low = text.charCodeAt(position - 1);
  const start = low >= 0xdc00 && low <= 0xdfff && position >= 2 ? position - 2 : position - 1;
  return String.fromCodePoint(text.codePointAt(start) ?? 0);
}
/** The code point of `text` that starts at `position` (a surrogate pair whole), or `undefined` at the end. */
export function codePointAt(text: string, position: number): string | undefined {
  const code = text.codePointAt(position);
  return code === undefined ? undefined : String.fromCodePoint(code);
}
/** Every code point of `text` as the card draws it ({@link escapeReviewCharacter}, each with the code points before and after it). */
export function escapeReviewText(text: string): readonly string[] {
  const characters = [...text];
  return characters.map((char, index) =>
    escapeReviewCharacter(char, false, false, characters[index - 1], characters[index + 1]),
  );
}
/**
 * One code point of a reviewed string as the card draws it. Escaped as `<U+XXXX>` (never dropped: what the person sees is what they approve): `<`,
 * what draws nothing or blank, and (MVP-11 unit 9, review round 2, S2-4) every code point a terminal may draw WIDER than the card's layout counts
 * ({@link isWidthRiskCodePoint}, the screen filter's one classifier: a skin tone, a regional indicator, the Thai or Lao AM, the wide tone marks;
 * U+FE0F and a lone surrogate are invisible already). Unescaped, a run of them makes a row the card sized to fit wrap on the terminal: the path row
 * of a write once pushed its stats to the next row and shifted the whole frame. Escaped, the row is ASCII where it was at risk, measured as it is
 * drawn. The nine text-default emoji bases a terminal draws two columns ({@link isNarrowEmojiBase}, review round 3) are drawn with U+FE0F after
 * them instead, legible, and two columns to the layout as on the terminal ALONE; a mark right after one (`previous`, the code point before
 * `char` in the source) would make one cluster with it that the layout counts one column and tmux draws two (`☝️́`; review round 4, R4-S-2), so
 * that mark is escaped: the base keeps its two columns to both, and the mark's token is ASCII. The layout's measure counts every other joined
 * cluster as a terminal draws it (review round 5, R5-S-4), so the card escapes only for what it shows, by context (R5-S-3): a halfwidth sound mark
 * (U+FF9E, U+FF9F) after an emoji or a narrow base would join it and read as part of the pictograph, and a Prepend letter before a narrow base
 * (`next`, the code point after `char`) would draw as one glyph with it; both are written as tokens there. A halfwidth sound mark after a kana
 * (`ｶﾞ`, ordinary Japanese) stays as it is.
 */
export function escapeReviewCharacter(
  char: string,
  trailing: boolean,
  numeric = false,
  previous?: string,
  next?: string,
): string {
  const cp = char.codePointAt(0) ?? 0;
  if (char === '\t') return '<TAB>';
  if (char === ' ' && trailing) return '<SP>';
  // `numeric` (the `p` view) writes every NON-ASCII character as its code point; printable ASCII stays readable, and the
  // tokens above and below (a tab, a trailing space, a control, `<`) are the same in both views.
  if (
    (numeric && cp > 0x7f) ||
    char === '<' ||
    (char !== ' ' && INVISIBLE.test(char)) ||
    BLANKS.has(cp) ||
    isWidthRiskCodePoint(char) ||
    (previous !== undefined && isNarrowEmojiBase(previous) && COMBINING.test(char)) ||
    (previous !== undefined &&
      (isNarrowEmojiBase(previous) || EMOJI_END.test(previous)) &&
      HALFWIDTH_VOICED.test(char)) ||
    (next !== undefined && isNarrowEmojiBase(next) && isPrepend(char))
  )
    return `<U+${cp.toString(16).toUpperCase().padStart(4, '0')}>`;
  // one of the nine text-default emoji bases a terminal draws two columns: drawn with its presentation selector, so the layout counts two too
  // (MVP-11 unit 9, review round 3); a real U+FE0F after it is escaped on its own, so the two never draw alike
  if (isNarrowEmojiBase(char)) return `${char}${String.fromCodePoint(0xfe0f)}`;
  return char;
}
export interface ReviewPage {
  readonly rows: readonly string[];
  /** The role of each row in {@link ReviewPage.rows}, parallel to it. */
  readonly kinds: readonly ReviewRowKind[];
  /**
   * The framing label each row starts with (`target`, `field name`, `+12`, `=12`, …), parallel to {@link ReviewPage.rows}.
   * Typed UI framing: a view that restyles a row strips THIS, never guesses from the row's text.
   */
  readonly labels: readonly string[];
  /** Masked companion of exactly these emitted rows, never a second viewport projection. */
  readonly maskedRows: readonly string[];
  /** Source actually readable in this frame: placeholders do not prove their hidden bytes. */
  readonly visibleSource: readonly SourceRange[];
  readonly shown: readonly SourceRange[];
  readonly requiredTarget?: SourceRange;
  readonly next: ReviewCursor | undefined;
  readonly hiddenLines: number;
  readonly hiddenBytes: number;
  /**
   * Changed (added or removed) lines of the document that are NOT drawn in this page — before its first line or
   * from its cut onwards. A card that cannot show every change must say so and must not grant more than one answer.
   */
  readonly hiddenChanges: number;
  /** {@link ReviewPage.hiddenChanges} split by side: changed lines before the page's first row, and from its cut onwards. */
  readonly changesAbove: number;
  readonly changesBelow: number;
  /**
   * Where the page sits among the lines the view lists: how many come before its first line, how many are left after its
   * cut, and how many there are. Counts of listed lines (the skip set in force), never of rows.
   */
  readonly position: { readonly above: number; readonly below: number; readonly total: number };
  /** The width and height the page was projected for, so a key can page by exactly what is drawn. */
  readonly columns: number;
  readonly rowLimit: number;
  readonly valid: boolean;
}

/** Lines of unchanged context the compact card keeps above the first change. */
export const CARD_CONTEXT_LINES = 3;
/** The most unchanged lines between two edits that still count as one change: context above one and below the other. */
export const CHANGE_GAP_LINES = 2 * CARD_CONTEXT_LINES;
/** The most listed lines one change spans, however closely its edits follow one another (about two pages at 24 rows). */
export const CHANGE_SPAN_LINES = 40;

/**
 * The line the compact card opens on. A long file's first rows are not what the person is deciding on, so the card
 * opens on the first changed line with up to {@link CARD_CONTEXT_LINES} lines of context above it, never before
 * `base` (the first line the card would otherwise show). A preview whose rows before the diff are not diff rows (a
 * target or field row) keeps `base`: those rows are the call's identity and must stay on the card.
 */
export function cardStartLine(
  document: ReviewDocument,
  base: number,
  fit?: { readonly budgetRows: number; readonly rowsOf: (index: number) => number },
): number {
  const first = document.firstChangedLine;
  if (first === undefined || first <= base || document.lines[base]?.kind === undefined) return base;
  let start = first,
    context = 0,
    used = 0;
  while (start > base && context < CARD_CONTEXT_LINES) {
    const line = document.lines[start - 1];
    if (line === undefined) break;
    if (line.cardSkip !== true) {
      if (line.kind !== 'context') break;
      // Lines that wrap can fill the whole card: the context may take only the rows `fit` allows, so the change is drawn.
      if (fit !== undefined) {
        const own = fit.rowsOf(start - 1);
        if (used + own > fit.budgetRows) break;
        used += own;
      }
      context++;
    }
    start--;
  }
  return start;
}

/** Expand only this bounded viewport. Synthetic tokens are indivisible and never rescanned as source. */
export function projectReviewPage(
  document: ReviewDocument,
  cursor: ReviewCursor,
  columns: number,
  rowLimit: number,
  reveal = false,
  numeric = false,
  compact = false,
  dedupe = false,
): ReviewPage {
  const page: PageProjection = {
    document,
    columns,
    rowLimit,
    reveal,
    numeric,
    rows: [],
    kinds: [],
    labels: [],
    maskedRows: [],
    visibleSource: [],
    shown: [],
    lineIndex: cursor.line,
    offset: cursor.offset,
    valid: document.valid && columns >= 32 && rowLimit >= 1,
    work: 0,
  };
  // The skip set in force: the card leaves out every before copy; the deduplicated full view only the unmasked ones.
  const skipped = (index: number): boolean => {
    const line = document.lines[index];
    return (compact && line?.cardSkip === true) || (dedupe && line?.fullSkip === true);
  };
  while (page.valid && page.lineIndex < document.lines.length && page.rows.length < rowLimit) {
    if (skipped(page.lineIndex)) {
      // This copy's twin is listed; a view that leaves the copy out gives it no row.
      page.lineIndex++;
      page.offset = 0;
      if (++page.work > PAGE_WORK_LIMIT) page.valid = false;
      continue;
    }
    if (!appendReviewLine(page)) break;
  }
  // A skipped line at the tail is not "more to read": settle on the next line the view would list.
  if (compact || dedupe) {
    while (page.valid && page.lineIndex < document.lines.length && skipped(page.lineIndex)) {
      page.lineIndex++;
      page.offset = 0;
    }
  }
  const next =
    page.lineIndex >= document.lines.length
      ? undefined
      : { line: page.lineIndex, offset: page.offset };
  const changes = hiddenChangedLines(document, cursor, next);
  const listed = listedRemainingLines(document, compact, dedupe);
  const after = next?.line ?? document.lines.length;
  return {
    rows: page.rows,
    kinds: page.kinds,
    labels: page.labels,
    maskedRows: page.maskedRows,
    visibleSource: page.visibleSource,
    shown: reveal ? page.shown : [],
    next,
    hiddenLines: listed === undefined ? document.lines.length - after : (listed[after] ?? 0),
    hiddenBytes: hiddenReviewBytes(document, next, compact, dedupe),
    hiddenChanges: changes.above + changes.below,
    changesAbove: changes.above,
    changesBelow: changes.below,
    position:
      listed === undefined
        ? {
            above: Math.min(cursor.line, document.lines.length),
            below: document.lines.length - after,
            total: document.lines.length,
          }
        : {
            above: (listed[0] ?? 0) - (listed[Math.min(cursor.line, document.lines.length)] ?? 0),
            below: listed[after] ?? 0,
            total: listed[0] ?? 0,
          },
    columns,
    rowLimit,
    valid: page.valid,
  };
}

/**
 * Changed lines before the page's first line plus those from its cut onwards: every one the page does not draw. A page
 * that STARTS PARTWAY through a changed line (the later pages of one long line) does not draw that line's beginning, so
 * the line is not fully shown either — counted here unless the page's own cut is inside the same line, which the
 * from-the-cut count already holds. A cursor's offset is an ABSOLUTE offset into its field (the projection starts a row at
 * `Math.max(line.start, offset)` and a search returns `line.start + relative`), so "partway" is past the line's own start:
 * a page that starts exactly there — or below it, which the projection clamps — draws the line from its beginning.
 */
function hiddenChangedLines(
  document: ReviewDocument,
  cursor: ReviewCursor,
  next: ReviewCursor | undefined,
): { readonly above: number; readonly below: number } {
  const suffix = document.changedRemainingLines;
  const before = document.changedLines - (suffix[cursor.line] ?? 0);
  const lineStart = document.lines[cursor.line]?.start ?? 0;
  const startsInsideChangedLine =
    cursor.offset > lineStart && (suffix[cursor.line] ?? 0) - (suffix[cursor.line + 1] ?? 0) === 1;
  const cutInsideSameLine = next !== undefined && next.line === cursor.line;
  return {
    above: before + (startsInsideChangedLine && !cutInsideSameLine ? 1 : 0),
    below: suffix[next?.line ?? document.lines.length] ?? 0,
  };
}

interface PageProjection {
  readonly document: ReviewDocument;
  readonly columns: number;
  readonly rowLimit: number;
  readonly reveal: boolean;
  readonly numeric: boolean;
  readonly rows: string[];
  readonly kinds: ReviewRowKind[];
  readonly labels: string[];
  readonly maskedRows: string[];
  readonly visibleSource: SourceRange[];
  readonly shown: SourceRange[];
  lineIndex: number;
  offset: number;
  valid: boolean;
  work: number;
}
interface ReviewRow {
  readonly start: number;
  readonly position: number;
  readonly text: string;
  readonly width: number;
}
function isTrailingCharacter(
  line: ReviewSourceLine,
  field: ReviewField,
  position: number,
): boolean {
  if (line.ending === 'field')
    return /^[ \t]*(?:\r?\n|$)/u.test(field.text.slice(position, line.end));
  return position >= (line.trailingStart ?? line.end);
}
function maskToken(mask: ReviewMask, field: ReviewField, position: number, end: number): string {
  return `<MASK:id=${mask.id};bytes=${fieldRangeBytes(field, position, Math.min(end, mask.end))}>`;
}
function appendVisibleRange(
  visible: SourceRange[],
  field: number,
  start: number,
  end: number,
): void {
  const last = visible.at(-1);
  if (last?.field === field && last.end === start) visible[visible.length - 1] = { ...last, end };
  else visible.push({ field, start, end });
}
/** The masked companion is derived from exactly the source range emitted in the visible row. */
function emitReviewRow(
  page: PageProjection,
  line: ReviewSourceLine,
  start: number,
  end: number,
  row: string,
  ending = '',
): void {
  const field = page.document.fields[line.field];
  if (field === undefined) return;
  let masked = `${line.label} `,
    position = start;
  while (position < end) {
    const mask = maskAt(field.masks, position);
    if (mask !== undefined) {
      const stop = Math.min(end, mask.end);
      masked += maskToken(mask, field, position, end);
      if (page.reveal) page.visibleSource.push({ field: line.field, start: position, end: stop });
      position = stop;
    } else {
      const char = String.fromCodePoint(field.text.codePointAt(position) ?? 0);
      masked += escapeReviewCharacter(
        char,
        isTrailingCharacter(line, field, position),
        page.numeric,
        codePointBefore(field.text, position),
        codePointAt(field.text, position + char.length),
      );
      const stop = position + char.length;
      appendVisibleRange(page.visibleSource, line.field, position, stop);
      position = stop;
    }
  }
  page.rows.push(row);
  page.kinds.push(line.kind ?? 'meta');
  page.labels.push(line.label);
  page.maskedRows.push(masked + ending);
}
/** The most work one projected page may do, in tokens; past it the page is not valid and the screen says so. */
export const PAGE_WORK_LIMIT = 65_536;

/** The most tokens one row holds: three per column. Combining marks and conjunct chains add no width, so without a bound one
 *  row could take a whole megabyte line and cost quadratic time to measure; past it the run goes on in the next row, every
 *  byte still drawn once. */
export const ROW_TOKENS_PER_COLUMN = 3;

/** The token a source position is drawn as, and where the next one starts. */
function tokenAt(
  page: PageProjection,
  line: ReviewSourceLine,
  field: ReviewField,
  position: number,
): { readonly token: string; readonly next: number } {
  const mask = page.reveal ? undefined : maskAt(field.masks, position);
  const char = String.fromCodePoint(field.text.codePointAt(position) ?? 0);
  return mask === undefined
    ? {
        token: escapeReviewCharacter(
          char,
          isTrailingCharacter(line, field, position),
          page.numeric,
          codePointBefore(field.text, position),
          codePointAt(field.text, position + char.length),
        ),
        next: position + char.length,
      }
    : { token: maskToken(mask, field, position, line.end), next: Math.min(line.end, mask.end) };
}

function projectReviewRow(
  page: PageProjection,
  line: ReviewSourceLine,
  field: ReviewField,
): ReviewRow {
  const label = `${line.label} `;
  const start = Math.max(line.start, page.offset);
  const maxTokens = Math.max(16, ROW_TOKENS_PER_COLUMN * page.columns);
  const parts: string[] = [];
  const ends: number[] = [];
  let position = start;
  let sum = displayWidth(label);
  while (position < line.end && parts.length < maxTokens) {
    if (++page.work > PAGE_WORK_LIMIT) {
      page.valid = false;
      break;
    }
    const { token, next } = tokenAt(page, line, field, position);
    const tokenWidth = displayWidth(token);
    if (sum + tokenWidth > page.columns) {
      if (parts.length === 0) page.valid = false;
      break;
    }
    parts.push(token);
    ends.push(next);
    sum += tokenWidth;
    position = next;
  }
  // The sum of the tokens' widths is a close ESTIMATE of the row's width, not the width: exact for most text, short for a
  // keycap (a digit and U+20E3 are two cells, not one plus none) and long for some emoji and jamo sequences. The terminal
  // measures the whole row, and a row drawn wider than its page would be cut or wrapped, hiding bytes the page reports as shown.
  // So the row is measured as the string it is and, if it is too wide, the longest prefix that fits is found by halving — each
  // probe one whole-row measure, a probe is VERIFIED because width is not monotone in the prefix (a modifier can narrow a
  // cluster), so the cost is the row times its logarithm, never the row squared.
  let text = label + parts.join('');
  let width = displayWidth(text);
  if (page.valid && width > page.columns && parts.length > 0) {
    let fits = 0;
    let over = parts.length - 1;
    while (fits < over) {
      const probe = (fits + over + 1) >> 1;
      if (displayWidth(label + parts.slice(0, probe).join('')) <= page.columns) fits = probe;
      else over = probe - 1;
    }
    parts.length = fits;
    ends.length = fits;
    position = ends.at(-1) ?? start;
    text = label + parts.join('');
    width = displayWidth(text);
  }
  // A row never ends between a base character and the zero-width mark that belongs to it (a keycap's digit and its U+20E3) —
  // unless giving the base back would make the row wider than its page (width is not monotone).
  if (page.valid && position < line.end && parts.length > 1) {
    const last = parts.at(-1) ?? '';
    if (displayWidth(last) > 0 && displayWidth(tokenAt(page, line, field, position).token) === 0) {
      const shorter = label + parts.slice(0, -1).join('');
      const shorterWidth = displayWidth(shorter);
      if (shorterWidth <= page.columns) {
        parts.pop();
        ends.pop();
        position = ends.at(-1) ?? start;
        text = shorter;
        width = shorterWidth;
      }
    }
  }
  if (page.valid && parts.length === 0 && start < line.end) page.valid = false;
  return { start, position, text, width };
}
function reviewEnding(ending: ReviewSourceLine['ending']): string {
  switch (ending) {
    case 'field':
      return '';
    case 'none':
      return '<EOF:NO_NEWLINE>';
    case 'crlf':
      return '<CRLF>';
    case 'lf':
      return '<LF>';
  }
}
function appendReviewLine(page: PageProjection): boolean {
  const line = page.document.lines[page.lineIndex];
  if (line === undefined) return false;
  const field = page.document.fields[line.field];
  if (field === undefined) {
    page.valid = false;
    return false;
  }
  const row = projectReviewRow(page, line, field);
  if (!page.valid) return false;
  if (row.position === line.end) return appendReviewLineEnding(page, line, row);
  emitReviewRow(page, line, row.start, row.position, row.text);
  if (page.reveal) page.shown.push({ field: line.field, start: row.start, end: row.position });
  page.offset = row.position;
  return true;
}
function appendReviewLineEnding(
  page: PageProjection,
  line: ReviewSourceLine,
  row: ReviewRow,
): boolean {
  const ending = line.showEnding === false ? '' : reviewEnding(line.ending);
  if (row.width + ending.length > page.columns) {
    if (row.position === row.start) {
      page.valid = false;
      return false;
    }
    // Endings are their own source-backed row when the notation does not fit.
    emitReviewRow(page, line, row.start, row.position, row.text);
    page.shown.push({ field: line.field, start: row.start, end: row.position });
    if (page.rows.length >= page.rowLimit) {
      page.offset = row.position;
      return false;
    }
    emitReviewRow(page, line, row.position, row.position, `${line.label} ${ending}`, ending);
  } else emitReviewRow(page, line, row.start, row.position, row.text + ending, ending);
  if (page.reveal)
    page.shown.push({
      field: line.field,
      start: row.start,
      end: row.position + endingLength(line.ending),
    });
  page.offset = 0;
  page.lineIndex++;
  return true;
}
/** The remaining-lines index of the view in use: the card's, the deduplicated full view's, or none (every line is listed). */
function listedRemainingLines(
  document: ReviewDocument,
  compact: boolean,
  dedupe: boolean,
): readonly number[] | undefined {
  if (compact) return document.cardRemainingLines;
  if (dedupe) return document.fullRemainingLines;
  return undefined;
}
/** The remaining-bytes index of the view in use (the same three views). */
function listedRemainingBytes(
  document: ReviewDocument,
  compact: boolean,
  dedupe: boolean,
): readonly number[] {
  if (compact) return document.cardRemainingBytes;
  if (dedupe) return document.fullRemainingBytes;
  return document.remainingBytes;
}
function hiddenReviewBytes(
  document: ReviewDocument,
  next: ReviewCursor | undefined,
  compact = false,
  dedupe = false,
): number {
  const nextLine = next === undefined ? undefined : document.lines[next.line];
  const suffix = listedRemainingBytes(document, compact, dedupe);
  const remaining = suffix[next?.line ?? document.lines.length] ?? 0;
  if (nextLine === undefined || next === undefined) return remaining;
  return (
    remaining -
    fieldRangeBytes(
      document.fields[nextLine.field],
      nextLine.start,
      Math.max(nextLine.start, next.offset),
    )
  );
}

function maskAt(masks: readonly ReviewMask[], position: number): ReviewMask | undefined {
  let low = 0,
    high = masks.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if ((masks[middle]?.end ?? 0) <= position) low = middle + 1;
    else high = middle;
  }
  const mask = masks[low];
  return mask !== undefined && mask.start <= position && position < mask.end ? mask : undefined;
}
function fieldByteOffset(field: ReviewField, position: number): number {
  let low = 0,
    high = field.byteIndex.length;
  while (low + 1 < high) {
    const middle = Math.floor((low + high) / 2);
    if ((field.byteIndex[middle]?.offset ?? 0) <= position) low = middle;
    else high = middle;
  }
  const anchor = field.byteIndex[low] ?? { offset: 0, bytes: 0 };
  return anchor.bytes + reviewBytes(field.text.slice(anchor.offset, position));
}
function fieldRangeBytes(field: ReviewField | undefined, start: number, end: number): number {
  return field === undefined ? 0 : fieldByteOffset(field, end) - fieldByteOffset(field, start);
}

type PreviewDiff = NonNullable<ToolPreview['diff']>;
type PreviewDiffLine = PreviewDiff['lines'][number];
function codePointBytes(cp: number): number {
  if (cp <= 0x7f) return 1;
  if (cp <= 0x7ff) return 2;
  return cp <= 0xffff ? 3 : 4;
}
function endingLength(ending: ReviewSourceLine['ending']): number {
  if (ending === 'crlf') return 2;
  return ending === 'lf' ? 1 : 0;
}
function endingText(ending: PreviewDiffLine['ending']): string {
  if (ending === 'crlf') return '\r\n';
  return ending === 'lf' ? '\n' : '';
}
function diffLineMark(kind: PreviewDiffLine['kind']): string {
  if (kind === 'removed') return '-';
  return kind === 'added' ? '+' : '=';
}
function validPreviewBounds(preview: ToolPreview): boolean {
  return (
    (preview.target?.length ?? 0) <= 4096 &&
    preview.fields.length <= 64 &&
    !preview.fields.some((field) => field.name.length > 256 || field.value.length > 4096) &&
    (preview.diff?.before?.length ?? 0) <= 8 * 1024 * 1024 &&
    (preview.diff?.after.length ?? 0) <= 8 * 1024 * 1024 &&
    (preview.diff?.lines.length ?? 0) <= 200_000
  );
}
function validDiffLineShape(line: PreviewDiffLine): boolean {
  return !(
    (line.kind !== 'added' && line.before === undefined) ||
    (line.kind !== 'removed' && line.after === undefined) ||
    (line.kind === 'added' && line.before !== undefined) ||
    (line.kind === 'removed' && line.after !== undefined) ||
    (line.text.length === 0 && line.ending === 'none')
  );
}
function validDiffSpan(
  span: NonNullable<PreviewDiffLine['before']>,
  source: string,
  line: PreviewDiffLine,
  position: number,
  number: number,
): boolean {
  return (
    Number.isSafeInteger(span.start) &&
    Number.isSafeInteger(span.end) &&
    span.start === position &&
    span.line === number &&
    span.start >= 0 &&
    span.end <= source.length &&
    span.end >= span.start &&
    source.slice(span.start, span.end) === line.text + endingText(line.ending)
  );
}
function validDiffSources(diff: PreviewDiff): boolean {
  const positions = { before: 0, after: 0 },
    numbers = { before: 1, after: 1 };
  let added = 0,
    removed = 0;
  for (const line of diff.lines) {
    if (!validDiffLineShape(line)) return false;
    if (line.kind === 'added') added++;
    if (line.kind === 'removed') removed++;
    if (!advanceDiffPositions(diff, line, positions, numbers)) return false;
  }
  return (
    positions.before === (diff.before?.length ?? 0) &&
    positions.after === diff.after.length &&
    added === diff.stats.addedLines &&
    removed === diff.stats.removedLines
  );
}
function validPreviewDiff(preview: ToolPreview): boolean {
  const diff = preview.diff;
  if (diff === undefined) return true;
  if (preview.kind === 'saved-result') return false;
  const beforeBytes = reviewBytes(diff.before ?? ''),
    afterBytes = reviewBytes(diff.after);
  return (
    beforeBytes <= 8 * 1024 * 1024 &&
    afterBytes <= 8 * 1024 * 1024 &&
    beforeBytes === diff.stats.beforeBytes &&
    afterBytes === diff.stats.afterBytes &&
    validDiffSources(diff)
  );
}
function appendDiffLines(
  diff: PreviewDiff,
  add: (text: string, side?: DiffSide) => number,
  fields: readonly ReviewField[],
  lines: ReviewSourceLine[],
): { changedBytes: number; changedLines: number } {
  const before = add(diff.before ?? '', 'before'),
    after = add(diff.after, 'after');
  let changedBytes = 0,
    changedLines = 0;
  for (const line of diff.lines) {
    const showEnding = endingShown(diff, line.kind, line.ending);
    if (line.kind === 'context' && line.before !== undefined && line.after !== undefined) {
      lines.push({
        field: before,
        start: line.before.start,
        end: line.before.end - endingLength(line.ending),
        label: `=before ${line.before.line}`,
        ending: line.ending,
        changed: false,
        kind: 'context',
        cardSkip: true,
        // The twin is byte-identical; only a mask on this side could make the copy worth listing.
        fullSkip: !touchesMask(fields[before], line.before.start, line.before.end),
        showEnding,
      });
    }
    const side = line.kind === 'removed' ? line.before : (line.after ?? line.before);
    if (side === undefined) continue;
    const field = line.kind === 'removed' ? before : after;
    lines.push({
      field,
      start: side.start,
      end: side.end - endingLength(line.ending),
      label: `${diffLineMark(line.kind)}${side.line}`,
      ending: line.ending,
      changed: line.kind !== 'context',
      kind: line.kind,
      showEnding,
    });
    if (line.kind !== 'context') {
      changedLines++;
      changedBytes += reviewBytes((fields[field]?.text ?? '').slice(side.start, side.end));
    }
  }
  return { changedBytes, changedLines };
}
/**
 * Whether a diff line prints its ending token (ADR-0129 §4, as ADR-0120 asks): only a line whose ending differs
 * from the rest of its side or from the other side. An unterminated line always shows `<EOF:NO_NEWLINE>`, so
 * adding or dropping only the final newline stays a visible two-sided change, and LF vs CRLF can never look equal.
 */
function endingShown(
  diff: PreviewDiff,
  kind: PreviewDiffLine['kind'],
  ending: ReviewSourceLine['ending'],
): boolean {
  if (ending !== 'lf' && ending !== 'crlf') return true;
  if (kind === 'context') return !(diff.beforeEndings === ending && diff.afterEndings === ending);
  const own = kind === 'removed' ? diff.beforeEndings : diff.afterEndings;
  const other = kind === 'removed' ? diff.afterEndings : diff.beforeEndings;
  return !(own === ending && (other === 'empty' || other === ending));
}
function indexTrailingWhitespace(
  line: ReviewSourceLine,
  fields: readonly ReviewField[],
): ReviewSourceLine {
  const text = fields[line.field]?.text ?? '';
  let trailingStart = line.end;
  while (trailingStart > line.start && /[ \t]/u.test(text[trailingStart - 1] ?? ''))
    trailingStart--;
  return { ...line, trailingStart };
}
function indexRemainingBytes(
  lines: readonly ReviewSourceLine[],
  fields: readonly ReviewField[],
  include: (line: ReviewSourceLine) => boolean = () => true,
): number[] {
  const remaining: number[] = Array.from({ length: lines.length + 1 }, () => 0);
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index];
    if (line !== undefined)
      remaining[index] =
        (remaining[index + 1] ?? 0) +
        (include(line)
          ? fieldRangeBytes(fields[line.field], line.start, line.end) + endingLength(line.ending)
          : 0);
  }
  return remaining;
}
/** Suffix counts of the changed lines. */
function indexRemainingChanges(lines: readonly ReviewSourceLine[]): number[] {
  const remaining: number[] = Array.from({ length: lines.length + 1 }, () => 0);
  for (let index = lines.length - 1; index >= 0; index--)
    remaining[index] = (remaining[index + 1] ?? 0) + (lines[index]?.changed === true ? 1 : 0);
  return remaining;
}
function firstChangedIndex(lines: readonly ReviewSourceLine[]): number | undefined {
  const index = lines.findIndex((line) => line.changed);
  return index < 0 ? undefined : index;
}
/** Suffix counts of the lines a view lists: the compact card's by default, the full view's with its own predicate. */
function indexRemainingLines(
  lines: readonly ReviewSourceLine[],
  include: (line: ReviewSourceLine) => boolean = (line) => line.cardSkip !== true,
): number[] {
  const remaining: number[] = Array.from({ length: lines.length + 1 }, () => 0);
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index];
    remaining[index] = (remaining[index + 1] ?? 0) + (line !== undefined && include(line) ? 1 : 0);
  }
  return remaining;
}
/**
 * The first line of every change: a run of changed lines, joined to the one before it when no more than
 * {@link CHANGE_GAP_LINES} unchanged lines lie between them — two edits a few lines apart are one thing to read, so "next
 * change" does not stop between them (the unified diff's own hunk rule).
 */
function indexChangeStarts(lines: readonly ReviewSourceLine[]): number[] {
  const starts: number[] = [];
  let gap = Number.POSITIVE_INFINITY;
  let span = 0;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (line?.fullSkip !== true) span++;
    if (line?.changed === true) {
      // A chain of edits each a few lines from the next is not one thing to read: a change is also at most
      // CHANGE_SPAN_LINES listed lines long, so "next change" keeps reaching them.
      if (gap > CHANGE_GAP_LINES || span > CHANGE_SPAN_LINES) {
        starts.push(index);
        span = 0;
      }
      gap = 0;
    } else if (line?.fullSkip !== true) gap++;
  }
  return starts;
}
/** Whether any mask of `field` overlaps `[start, end)`. */
function touchesMask(field: ReviewField | undefined, start: number, end: number): boolean {
  if (field === undefined) return false;
  let low = 0,
    high = field.masks.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if ((field.masks[middle]?.end ?? 0) <= start) low = middle + 1;
    else high = middle;
  }
  const mask = field.masks[low];
  return mask !== undefined && mask.start < Math.max(end, start + 1);
}
function requiredInspectionRanges(
  lines: readonly ReviewSourceLine[],
  fields: readonly ReviewField[],
  masks: readonly ReviewMask[],
): SourceRange[] {
  const required: SourceRange[] = masks.filter((mask) => mask.flagged);
  for (const line of lines) {
    if (!line.changed) continue;
    const field = fields[line.field];
    if (field === undefined) continue;
    appendChangedMasks(required, line, field);
  }
  return required;
}
function appendChangedMasks(
  required: SourceRange[],
  line: ReviewSourceLine,
  field: ReviewField,
): void {
  const end = line.end + endingLength(line.ending);
  let low = 0,
    high = field.masks.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if ((field.masks[middle]?.end ?? 0) <= line.start) low = middle + 1;
    else high = middle;
  }
  for (let index = low; index < field.masks.length; index++) {
    const mask = field.masks[index];
    if (mask === undefined || mask.start >= end) break;
    if (!mask.flagged)
      required.push({
        field: line.field,
        start: Math.max(mask.start, line.start),
        end: Math.min(mask.end, end),
      });
  }
}

function advanceDiffPositions(
  diff: PreviewDiff,
  line: PreviewDiffLine,
  positions: { before: number; after: number },
  numbers: { before: number; after: number },
): boolean {
  for (const side of ['before', 'after'] as const) {
    const span = line[side];
    if (span === undefined) continue;
    const source = side === 'before' ? (diff.before ?? '') : diff.after;
    if (!validDiffSpan(span, source, line, positions[side], numbers[side])) return false;
    positions[side] = span.end;
    numbers[side]++;
  }
  return true;
}
