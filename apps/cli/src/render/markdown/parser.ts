import type { MarkdownBlock } from './types.js';

type Alignment = 'left' | 'right' | 'center';

/** Split on unescaped pipes outside matched backtick runs. */
function cells(line: string, requirePipe: false): string[];
function cells(line: string, requirePipe?: true): string[] | undefined;
function cells(line: string, requirePipe = true): string[] | undefined {
  const nextRun = new Map<number, number>();
  const latest = new Map<number, number>();
  for (let at = line.length - 1; at >= 0; ) {
    if (line[at] !== '`') {
      at--;
      continue;
    }
    const end = at + 1;
    while (at >= 0 && line[at] === '`') at--;
    let start = at + 1;
    let escaped = false;
    for (let before = start - 1; before >= 0 && line[before] === '\\'; before--) escaped = !escaped;
    // The forward scanner consumes the first escaped tick with its backslash.
    // Any remaining ticks form their own unescaped run at the next position.
    if (escaped) start++;
    const length = end - start;
    if (!length) continue;
    nextRun.set(start, latest.get(length) ?? -1);
    latest.set(length, start);
  }
  const result: string[] = [];
  let cell = '';
  let ticks = 0;
  let firstPipe = -1;
  let lastPipe = -1;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i] ?? '';
    if (ch === '\\' && i + 1 < line.length) {
      cell += ch + (line[++i] ?? '');
      continue;
    }
    if (ch === '`') {
      let end = i + 1;
      while (line[end] === '`') end++;
      const count = end - i;
      if (ticks === count) ticks = 0;
      else if (ticks === 0 && (nextRun.get(i) ?? -1) >= 0) ticks = count;
      cell += line.slice(i, end);
      i = end - 1;
      continue;
    }
    if (ch === '|' && ticks === 0) {
      if (firstPipe < 0) firstPipe = i;
      lastPipe = i;
      result.push(cell.trim());
      cell = '';
    } else cell += ch;
  }
  result.push(cell.trim());
  if (firstPipe < 0) return requirePipe ? undefined : result;
  if (!line.slice(0, firstPipe).trim()) result.shift();
  if (!line.slice(lastPipe + 1).trim()) result.pop();
  return result;
}

function delimiter(line: string): Alignment[] | undefined {
  const parts = cells(line);
  if (!parts || !parts.length || parts.some((part) => !/^:?-{3,}:?$/.test(part))) return undefined;
  return parts.map((part) =>
    part.startsWith(':') && part.endsWith(':') ? 'center' : part.endsWith(':') ? 'right' : 'left',
  );
}

function fence(line: string): { marker: string; indent: number; info: string } | undefined {
  const match = /^( {0,3})(`{3,}|~{3,})([^\n]*)$/.exec(line);
  if (!match) return undefined;
  const marker = match[2] ?? '';
  const info = (match[3] ?? '').trim();
  if (marker.startsWith('`') && info.includes('`')) return undefined;
  return { marker, indent: (match[1] ?? '').length, info };
}
function closingFence(line: string, marker: string, length: number): boolean {
  const trimmed = line.replace(/^ {0,3}/, '');
  let i = 0;
  while (trimmed[i] === marker) i++;
  return i >= length && !/[^ \t]/.test(trimmed.slice(i));
}
export function closesMarkdownFence(line: string, marker: string): boolean {
  return closingFence(line, marker[0] ?? '', marker.length);
}

/** Source offsets of heading content, including a provisional closing hash run. */
export class HeadingContent {
  private offset = 0;
  private first: number | undefined;
  private last = 0;
  private spaces = 0;
  private closing: number | undefined;
  private previous = '';
  work = 0;

  get start(): number {
    return this.first ?? this.offset;
  }
  get end(): number {
    return Math.max(this.start, this.closing ?? this.last);
  }

  append(source: string): void {
    for (let at = 0; at < source.length; at++) {
      const character = source[at] ?? '';
      const position = this.offset++;
      this.work++;
      if (this.first === undefined) {
        if (character === ' ') continue;
        this.first = position;
      }
      if (character === ' ') {
        if (this.previous !== ' ') this.spaces = position;
      } else {
        this.last = position + 1;
        if (character !== '#') this.closing = undefined;
        else if (this.previous !== '#')
          this.closing = this.previous === ' ' ? this.spaces : undefined;
      }
      this.previous = character;
    }
  }
}

/** Scan one ATX heading with a bounded number of passes over the source. */
export function parseHeading(
  line: string,
  work?: { steps: number },
): { level: number; text: string } | undefined {
  let start = 0;
  while (start < 3 && line[start] === ' ') {
    start++;
    if (work) work.steps++;
  }
  let markerEnd = start;
  while (markerEnd - start < 7 && line[markerEnd] === '#') {
    markerEnd++;
    if (work) work.steps++;
  }
  const level = markerEnd - start;
  if (level < 1 || level > 6 || line[markerEnd] !== ' ') return undefined;
  let contentStart = markerEnd;
  while (line[contentStart] === ' ') {
    contentStart++;
    if (work) work.steps++;
  }
  const content = new HeadingContent();
  content.append(line.slice(contentStart));
  if (work) work.steps += content.work;
  return { level, text: line.slice(contentStart + content.start, contentStart + content.end) };
}
function isRule(line: string): boolean {
  return /^ {0,3}(?:(?:\* *){3,}|(?:- *){3,}|(?:_ *){3,})$/.test(line);
}
/** Incremental recognition of the existing tag-led one-line literal fallback. */
export class HtmlTagLine {
  private mode:
    | 'indent'
    | 'angle'
    | 'first'
    | 'name'
    | 'slash'
    | 'attributes'
    | 'bang'
    | 'commentDash'
    | 'doctype'
    | 'doctypeBoundary'
    | 'done'
    | 'invalid' = 'indent';
  private spaces = 0;
  private declaration = 0;
  work = 0;

  get literal(): boolean {
    return this.mode === 'done';
  }

  append(source: string): void {
    for (const character of source) {
      if (this.mode === 'done' || this.mode === 'invalid') break;
      this.work += character.length;
      if (this.mode === 'indent') {
        if (character === ' ' && this.spaces++ < 3) continue;
        this.mode = character === '<' ? 'angle' : 'invalid';
      } else if (this.mode === 'angle' && character === '/') this.mode = 'first';
      else if (this.mode === 'angle' && character === '!') this.mode = 'bang';
      else if (this.mode === 'bang') {
        if (character === '-') this.mode = 'commentDash';
        else if (character.toUpperCase() === 'D') {
          this.mode = 'doctype';
          this.declaration = 1;
        } else this.mode = 'invalid';
      } else if (this.mode === 'commentDash') this.mode = character === '-' ? 'done' : 'invalid';
      else if (this.mode === 'doctype') {
        if (character.toUpperCase() !== 'DOCTYPE'[this.declaration++]) this.mode = 'invalid';
        else if (this.declaration === 7) this.mode = 'doctypeBoundary';
      } else if (this.mode === 'doctypeBoundary')
        this.mode = /^\s$/.test(character) ? 'attributes' : 'invalid';
      else if (this.mode === 'angle' || this.mode === 'first')
        this.mode = /^[A-Za-z]$/.test(character) ? 'name' : 'invalid';
      else if (this.mode === 'name') {
        if (/^[A-Za-z0-9-]$/.test(character)) continue;
        this.mode =
          character === '>'
            ? 'done'
            : character === '/'
              ? 'slash'
              : /^\s$/.test(character)
                ? 'attributes'
                : 'invalid';
      } else if (this.mode === 'slash') this.mode = character === '>' ? 'done' : 'invalid';
      else if (this.mode === 'attributes' && character === '>') this.mode = 'done';
    }
  }
}

function unsupported(line: string): boolean {
  const tag = new HtmlTagLine();
  tag.append(line);
  return tag.literal || /^ {0,3}\[[^\]]+\]:/.test(line);
}

type HtmlRegion =
  | { readonly kind: 'tag'; readonly name: string; readonly depth: number }
  | { readonly kind: 'comment' };

const voidHtml = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'source',
  'track',
  'wbr',
]);

/** Conservative whole-line syntax only; attributes and other HTML are never interpreted. */
function htmlOpening(line: string): HtmlRegion | undefined {
  const comment = /^ {0,3}<!--/.exec(line);
  if (comment) return line.includes('-->', comment[0].length) ? undefined : { kind: 'comment' };
  const match = /^ {0,3}<([A-Za-z][A-Za-z0-9-]*)(?:\s[^<>]*)?>[ \t]*$/.exec(line);
  if (!match || match[0].length !== line.length || /\/>[ \t]*$/.test(line)) return undefined;
  const name = (match[1] ?? '').toLowerCase();
  return voidHtml.has(name) ? undefined : { kind: 'tag', name, depth: 1 };
}

function advanceHtml(region: HtmlRegion, line: string): HtmlRegion | undefined {
  if (region.kind === 'comment') return line.includes('-->') ? undefined : region;
  const close = /^ {0,3}<\/([A-Za-z][A-Za-z0-9-]*)>[ \t]*$/.exec(line);
  if (close?.[0].length === line.length && close[1]?.toLowerCase() === region.name)
    return region.depth === 1 ? undefined : { ...region, depth: region.depth - 1 };
  const opening = htmlOpening(line);
  if (opening?.kind === 'tag' && opening.name === region.name)
    return { ...region, depth: region.depth + 1 };
  return region;
}
export function isBlockStart(line: string): boolean {
  return (
    unsupported(line) ||
    !!fence(line) ||
    /^ {0,3}#{1,6} +/.test(line) ||
    isRule(line) ||
    /^ {0,3}(?:[-+*]|\d+[.)]) {1,4}(?:\S|$)/.test(line) ||
    /^ {0,3}>/.test(line)
  );
}

/** Whether the parser retains a candidate Setext pair literally. */
export function isSetextPair(header: string, underline: string): boolean {
  return /^ {0,3}(?:-{3,}|={3,}) *$/.test(underline) && !isBlockStart(header);
}

function isTablePair(header: string, under: string): boolean {
  const columns = cells(header);
  const alignment = delimiter(under);
  return columns !== undefined && alignment !== undefined && columns.length === alignment.length;
}

/** These block starts cannot become ordinary table text by appending more units. */
function persistentTableBoundary(line: string): boolean {
  if (!isBlockStart(line) || isRule(line)) return false;
  if (fence(line)?.marker.startsWith('`')) return false;
  // Empty list padding can still grow beyond four cells or acquire a TAB.
  return !/^ {0,3}(?:[-+*]|\d+[.)]) {1,4}$/.test(line);
}

interface SourceProjection {
  readonly sourcePrefixLength: number;
  readonly textPrefix: string;
}

function indentProjection(
  line: string,
  required: number,
  offset: number,
): SourceProjection | undefined {
  let width = 0;
  let index = 0;
  while (index < line.length && width < required) {
    if (line[index] === ' ') width++;
    else if (line[index] === '\t') width += 8 - ((width + offset) % 8);
    else return undefined;
    index++;
  }
  if (width < required) return undefined;
  return { sourcePrefixLength: index, textPrefix: ' '.repeat(width - required) };
}

function stripIndent(line: string, required: number, offset: number): string | undefined {
  const projection = indentProjection(line, required, offset);
  return projection && projection.textPrefix + line.slice(projection.sourcePrefixLength);
}

function composeProjection(
  outer: SourceProjection | undefined,
  inner: SourceProjection | undefined,
): SourceProjection {
  const parent = outer ?? { sourcePrefixLength: 0, textPrefix: '' };
  const child = inner ?? { sourcePrefixLength: 0, textPrefix: '' };
  return {
    sourcePrefixLength:
      parent.sourcePrefixLength + Math.max(0, child.sourcePrefixLength - parent.textPrefix.length),
    textPrefix: child.textPrefix + parent.textPrefix.slice(child.sourcePrefixLength),
  };
}

/** Expand tabs for container indentation while retaining the source mapping. */
function structuralLine(
  line: string,
  displayOffset: number,
): { structural: string; sourceIndex: number[] } {
  let structural = '';
  const sourceIndex = [0];
  let column = displayOffset;
  for (let sourceColumn = 0; sourceColumn < line.length; sourceColumn++) {
    const character = line[sourceColumn] ?? '';
    if (character === '\t') {
      const count = 8 - (column % 8);
      structural += ' '.repeat(count);
      for (let cell = 0; cell < count; cell++) sourceIndex.push(sourceColumn + 1);
      column += count;
    } else {
      structural += character;
      sourceIndex.push(sourceColumn + 1);
      column++;
    }
  }
  return { structural, sourceIndex };
}

interface ListFrame {
  column: number;
  content: number;
  displayContent: number;
}

function gatherFence(line: string): { marker: string; length: number } | undefined {
  const opening = fence(line);
  return opening ? { marker: opening.marker[0] ?? '', length: opening.marker.length } : undefined;
}

interface ParserState {
  lists: ListFrame[];
  overflowColumn: number | undefined;
  lazyContinuation: boolean;
  streaming: boolean;
  quoteDepth: number;
  quote: ParserState | undefined;
  list: ParserState | undefined;
  listPreviousWasMarker: boolean;
  listPendingTable: boolean;
  listGatherFence: ReturnType<typeof gatherFence>;
  listGatherHtml: HtmlRegion | undefined;
  openFence: { marker: string; length: number; indent: number } | undefined;
  openHtml: HtmlRegion | undefined;
  previous:
    | {
        source: string;
        eligible: boolean;
        paragraph: boolean;
        tableColumns: number | undefined;
        tableCandidate: boolean;
        childProjection: SourceProjection | undefined;
      }
    | undefined;
  inTable: boolean;
  revision: MarkdownBlock | undefined;
  revisionProjection: SourceProjection | undefined;
  preserveRevisionPrefix: boolean;
  fenceBoundary: 'open' | 'close' | undefined;
  tableBoundary: boolean;
  tableRow: boolean;
  tableContext: boolean;
  htmlLine: boolean;
}

function newParserState(): ParserState {
  return {
    lists: [],
    overflowColumn: undefined,
    lazyContinuation: false,
    streaming: false,
    quoteDepth: 0,
    quote: undefined,
    list: undefined,
    listPreviousWasMarker: false,
    listPendingTable: false,
    listGatherFence: undefined,
    listGatherHtml: undefined,
    openFence: undefined,
    openHtml: undefined,
    previous: undefined,
    inTable: false,
    revision: undefined,
    revisionProjection: undefined,
    preserveRevisionPrefix: false,
    fenceBoundary: undefined,
    tableBoundary: false,
    tableRow: false,
    tableContext: false,
    htmlLine: false,
  };
}

function streamingParserState(): ParserState {
  const state = newParserState();
  state.streaming = true;
  return state;
}

function cloneParserState(state: ParserState): ParserState {
  // Region names and the other immutable values remain shared. In particular,
  // a long HTML name is not copied for each bounded current-line preview.
  return {
    ...state,
    lists: state.lists.map((frame) => ({ ...frame })),
    quote: state.quote && cloneParserState(state.quote),
    list: state.list && cloneParserState(state.list),
  };
}

function retireChildren(state: ParserState): void {
  state.quote = undefined;
  state.list = undefined;
  state.listPreviousWasMarker = false;
  state.listPendingTable = false;
  state.listGatherFence = undefined;
  state.listGatherHtml = undefined;
}

/** Parse sanitized source. Unsupported constructs remain visible as literal text. */
export function parseMarkdown(
  source: string,
  listDepth = 0,
  quoteDepth = 0,
  displayOffset = 0,
): readonly MarkdownBlock[] {
  return parseWithState(source, listDepth, quoteDepth, displayOffset, newParserState());
}

function parseWithState(
  source: string,
  listDepth: number,
  quoteDepth: number,
  displayOffset: number,
  state: ParserState = newParserState(),
): readonly MarkdownBlock[] {
  const lines = source.split('\n');
  const result: MarkdownBlock[] = [];
  state.revision = undefined;
  state.revisionProjection = undefined;
  state.preserveRevisionPrefix = false;
  state.fenceBoundary = undefined;
  state.tableBoundary = false;
  state.tableRow = false;
  state.tableContext = false;
  state.htmlLine = false;
  let i = 0;
  const lists = state.lists;
  let overflowColumn = state.overflowColumn;
  let lazyContinuation = state.lazyContinuation;
  // Lookahead belongs to a physical line, not merely its eventual block kind.
  // A consumed underline and an already-owned lazy line cannot be reused as
  // the header of another Setext pair. The first dedent remains provisional.
  let consumedPair = false;
  let ownedLazyLine = false;
  // A continued container already owns this line and its next-line lookahead;
  // the parent must not pair the same physical bytes a second time.
  let delegatedLine = false;
  // The first physical container line can still be adopted by this scope's
  // earlier raw table lookahead, even if its tentative child is code or HTML.
  let tentativeContainer = false;
  let activeChild: ParserState | undefined;
  let childProjection: SourceProjection | undefined;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    if (state.streaming && state.openFence) {
      const open = state.openFence;
      if (closingFence(line, open.marker, open.length)) {
        state.fenceBoundary = 'close';
        state.openFence = undefined;
        result.push({ kind: 'code', source: line, text: '' });
      } else {
        let trim = 0;
        while (trim < open.indent && line[trim] === ' ') trim++;
        result.push({ kind: 'code', source: line, text: line.slice(trim) });
      }
      i++;
      continue;
    }
    if (state.streaming && state.openHtml) {
      state.htmlLine = true;
      state.openHtml = advanceHtml(state.openHtml, line);
      result.push({ kind: 'literal', source: line, text: line });
      i++;
      continue;
    }
    if (state.streaming && state.inTable) {
      state.tableContext = !persistentTableBoundary(line);
      if (line.trim() && !isBlockStart(line)) {
        state.tableRow = true;
        result.push({ kind: 'literal', source: line, text: line });
        i++;
        continue;
      }
      state.inTable = false;
    }
    if (state.streaming && state.previous?.tableColumns !== undefined) {
      const alignment = delimiter(line);
      if (alignment && alignment.length === state.previous.tableColumns) {
        state.tableBoundary = true;
        state.revision = {
          kind: 'literal',
          source: state.previous.source,
          text: state.previous.source,
        };
        state.revisionProjection = { sourcePrefixLength: 0, textPrefix: '' };
        state.inTable = true;
        retireChildren(state);
        lists.length = 0;
        overflowColumn = undefined;
        lazyContinuation = false;
        result.push({ kind: 'literal', source: line, text: line });
        i++;
        continue;
      }
    }
    if (state.streaming && state.previous?.eligible && isSetextPair('header', line)) {
      consumedPair = true;
      retireChildren(state);
      state.revision = {
        kind: 'literal',
        source: state.previous.source,
        text: state.previous.source,
      };
      state.revisionProjection = { sourcePrefixLength: 0, textPrefix: '' };
      lists.length = 0;
      overflowColumn = undefined;
      lazyContinuation = false;
      result.push({ kind: 'literal', source: line, text: line });
      i++;
      continue;
    }
    if (
      state.streaming &&
      state.previous?.paragraph &&
      line.trim() &&
      !isBlockStart(line) &&
      !/^ {4}/.test(line)
    ) {
      result.push({ kind: 'paragraph', source: line, text: line });
      i++;
      continue;
    }
    if (state.streaming && !/^ {0,3}>/.test(line)) state.quote = undefined;
    if (
      state.streaming &&
      !line.trim() &&
      state.list &&
      (state.listGatherFence || state.listGatherHtml)
    ) {
      const active = lists[lists.length - 1];
      if (active) {
        const block = parseWithState(
          stripIndent(line, active.content, displayOffset) ?? '',
          listDepth + lists.length,
          quoteDepth,
          displayOffset + active.displayContent,
          state.list,
        )[0];
        state.fenceBoundary = state.list.fenceBoundary;
        state.htmlLine = state.list.htmlLine;
        if (block)
          result.push({
            ...block,
            source: line,
            prefix: ' '.repeat(active.displayContent) + (block.prefix ?? ''),
            continuation:
              ' '.repeat(active.displayContent) + (block.continuation ?? block.prefix ?? ''),
          });
        i++;
        continue;
      }
    }
    if (!line.trim()) {
      lists.length = 0;
      overflowColumn = undefined;
      lazyContinuation = false;
      state.list = undefined;
      state.listGatherFence = undefined;
      state.listGatherHtml = undefined;
      state.quote = undefined;
      result.push({ kind: 'literal', source: line, text: line });
      i++;
      continue;
    }
    if (lazyContinuation) {
      if (isBlockStart(line) || isTablePair(line, lines[i + 1] ?? '')) lazyContinuation = false;
      else {
        ownedLazyLine = true;
        result.push({ kind: 'literal', source: line, text: line, raw: true });
        i++;
        continue;
      }
    }
    const currentList = lists[lists.length - 1];
    const relative = currentList
      ? stripIndent(line, currentList.content, displayOffset)
      : undefined;
    if (state.streaming && relative === undefined) {
      state.list = undefined;
      state.listGatherFence = undefined;
      state.listGatherHtml = undefined;
    }
    if (state.streaming && state.listPendingTable) {
      const alignment = relative === undefined ? undefined : delimiter(relative);
      if (!alignment || alignment.length !== state.list?.previous?.tableColumns)
        state.list = undefined;
      state.listPendingTable = false;
    }
    if (
      currentList &&
      relative !== undefined &&
      (isBlockStart(relative) || (state.streaming && state.list !== undefined)) &&
      overflowColumn === undefined
    ) {
      delegatedLine = true;
      childProjection = indentProjection(line, currentList.content, displayOffset);
      const original: string[] = [];
      const inner: string[] = [];
      let openFence = state.streaming ? state.listGatherFence : undefined;
      let openHtml = state.streaming ? state.listGatherHtml : undefined;
      while (i < lines.length) {
        const raw = lines[i] ?? '';
        const stripped = stripIndent(raw, currentList.content, displayOffset);
        if (!raw.trim()) {
          if (!openFence && !openHtml) break;
          original.push(raw);
          inner.push(stripped ?? '');
          i++;
          continue;
        }
        if (stripped === undefined) break;
        original.push(raw);
        inner.push(stripped);
        if (openHtml) openHtml = advanceHtml(openHtml, stripped);
        else if (openFence && closingFence(stripped, openFence.marker, openFence.length))
          openFence = undefined;
        else if (!openFence) {
          openFence = gatherFence(stripped);
          if (!openFence) openHtml = htmlOpening(stripped);
        }
        i++;
      }
      let sourceLine = 0;
      const childState = state.streaming ? (state.list ??= streamingParserState()) : undefined;
      activeChild = childState;
      for (const block of parseWithState(
        inner.join('\n'),
        listDepth + lists.length,
        quoteDepth,
        displayOffset + currentList.displayContent,
        childState,
      )) {
        const count = block.source.split('\n').length;
        const originalSource = original.slice(sourceLine, sourceLine + count).join('\n');
        sourceLine += count;
        if (block.raw)
          result.push({ kind: 'literal', source: originalSource, text: originalSource, raw: true });
        else
          result.push({
            ...block,
            source: originalSource,
            prefix: ' '.repeat(currentList.displayContent) + (block.prefix ?? ''),
            continuation:
              ' '.repeat(currentList.displayContent) + (block.continuation ?? block.prefix ?? ''),
          });
      }
      state.fenceBoundary = childState?.fenceBoundary;
      state.tableBoundary = childState?.tableBoundary ?? false;
      state.tableRow = childState?.tableRow ?? false;
      state.tableContext = childState?.tableContext ?? false;
      state.htmlLine = childState?.htmlLine ?? false;
      if (state.streaming) state.listGatherFence = openFence;
      if (state.streaming) state.listGatherHtml = openHtml;
      state.preserveRevisionPrefix =
        childState?.preserveRevisionPrefix === true ||
        (childState?.revision !== undefined && state.listPreviousWasMarker);
      if (childState?.revision) {
        state.revisionProjection = composeProjection(
          state.previous?.childProjection,
          childState.revisionProjection,
        );
        const block = childState.revision;
        const prefix = state.preserveRevisionPrefix ? '' : ' '.repeat(currentList.displayContent);
        state.revision = {
          ...block,
          source: state.previous?.source ?? block.source,
          prefix: prefix + (block.prefix ?? ''),
          continuation: prefix + (block.continuation ?? block.prefix ?? ''),
        };
      }
      state.listPreviousWasMarker = false;
      continue;
    }
    if (unsupported(line)) {
      lists.length = 0;
      overflowColumn = undefined;
      lazyContinuation = false;
      let region = htmlOpening(line);
      if (region) {
        state.htmlLine = true;
        const raw = [line];
        i++;
        while (i < lines.length && region) {
          const next = lines[i++] ?? '';
          raw.push(next);
          region = advanceHtml(region, next);
        }
        if (state.streaming) state.openHtml = region;
        const text = raw.join('\n');
        result.push({ kind: 'literal', source: text, text });
      } else {
        result.push({ kind: 'literal', source: line, text: line });
        i++;
      }
      continue;
    }
    const open = fence(line);
    if (open) {
      if (state.streaming) state.fenceBoundary = 'open';
      lists.length = 0;
      overflowColumn = undefined;
      lazyContinuation = false;
      const body: string[] = [];
      const raw = [line];
      i++;
      let closed = false;
      while (i < lines.length) {
        const next = lines[i] ?? '';
        raw.push(next);
        i++;
        if (closesMarkdownFence(next, open.marker)) {
          closed = true;
          break;
        }
        let trim = 0;
        while (trim < open.indent && next[trim] === ' ') trim++;
        body.push(next.slice(trim));
      }
      if (state.streaming && !closed)
        state.openFence = {
          marker: open.marker[0] ?? '',
          length: open.marker.length,
          indent: open.indent,
        };
      result.push({ kind: 'code', source: raw.join('\n'), text: body.join('\n'), info: open.info });
      continue;
    }
    const header = cells(line);
    const alignment = delimiter(lines[i + 1] ?? '');
    if (header && alignment && header.length === alignment.length) {
      lists.length = 0;
      overflowColumn = undefined;
      lazyContinuation = false;
      const raw = [line, lines[i + 1] ?? ''];
      const rows: string[][] = [header];
      i += 2;
      let overflow = header.length > 32 || raw.join('\n').length > 65536;
      let size = line.length + (lines[i - 1] ?? '').length + 1;
      while (i < lines.length) {
        const next = lines[i] ?? '';
        if (!next.trim() || isBlockStart(next)) break;
        const row = cells(next, false);
        raw.push(next);
        size += next.length + 1;
        i++;
        if (row.length > header.length || rows.length > 128 || size > 65536) overflow = true;
        if (!overflow) {
          while (row.length < header.length) row.push('');
          rows.push(row);
        }
      }
      result.push(
        overflow
          ? { kind: 'literal', source: raw.join('\n'), text: raw.join('\n') }
          : { kind: 'table', source: raw.join('\n'), text: raw.join('\n'), rows, align: alignment },
      );
      continue;
    }
    const heading = parseHeading(line);
    if (heading) {
      lists.length = 0;
      overflowColumn = undefined;
      lazyContinuation = false;
      result.push({
        kind: 'heading',
        source: line,
        text: heading.text,
        heading: heading.level,
      });
      i++;
      continue;
    }
    if (isSetextPair(line, lines[i + 1] ?? '')) {
      lists.length = 0;
      overflowColumn = undefined;
      lazyContinuation = false;
      const text = `${line}\n${lines[i + 1] ?? ''}`;
      result.push({ kind: 'literal', source: text, text });
      i += 2;
      continue;
    }
    if (isRule(line)) {
      lists.length = 0;
      overflowColumn = undefined;
      lazyContinuation = false;
      result.push({ kind: 'rule', source: line, text: line });
      i++;
      continue;
    }
    const { structural, sourceIndex } = structuralLine(line, displayOffset);
    const list = /^( *)([-+*]|\d+[.)])( {1,4})(\S[^\n]*|$)$/.exec(structural);
    if (list) {
      const column = (list[1] ?? '').length;
      while (lists.length && column < (lists[lists.length - 1]?.column ?? 0)) lists.pop();
      const parent = lists[lists.length - 1];
      if (overflowColumn !== undefined && column < overflowColumn) overflowColumn = undefined;
      const sibling = parent?.column === column;
      const child = parent !== undefined && column >= parent.content;
      if (
        overflowColumn !== undefined ||
        (!parent && column > 3) ||
        (parent && !sibling && !child) ||
        (child && lists.length + listDepth >= 8)
      ) {
        if (child && lists.length + listDepth >= 8) overflowColumn = column;
        result.push({ kind: 'literal', source: line, text: line, raw: true });
        i++;
        continue;
      }
      if (state.streaming) {
        state.list = undefined;
        state.listGatherFence = undefined;
        state.listGatherHtml = undefined;
      }
      const marker = list[2] ?? '';
      const padding = list[3] ?? ' ';
      const visibleMarker = /^\d/.test(marker) ? marker : '•';
      const content = column + marker.length + padding.length;
      const displayContent = column + visibleMarker.length + padding.length;
      const frame = { column, content, displayContent };
      if (sibling) lists[lists.length - 1] = frame;
      else lists.push(frame);
      const itemText = line.slice(sourceIndex[content] ?? line.length);
      childProjection = { sourcePrefixLength: sourceIndex[content] ?? line.length, textPrefix: '' };
      let remainder = itemText;
      let projectedDepth = lists.length + listDepth;
      let projectedColumn = content;
      while (!isRule(remainder)) {
        const nested = /^( {0,3})(?:[-+*]|\d+[.)]) {1,4}(?=\S)/.exec(remainder);
        if (!nested) break;
        projectedDepth++;
        if (projectedDepth > 8) break;
        projectedColumn += nested[0].length;
        remainder = remainder.slice(nested[0].length);
      }
      if (projectedDepth > 8) {
        overflowColumn = projectedColumn;
        result.push({ kind: 'literal', source: line, text: line, raw: true });
        i++;
        continue;
      }
      const markerPrefix = ' '.repeat(column) + visibleMarker + padding;
      tentativeContainer = state.streaming;
      const itemNext = stripIndent(lines[i + 1] ?? '', content, displayOffset);
      const itemTable = cells(itemText) && itemNext !== undefined && delimiter(itemNext);
      if (isBlockStart(itemText) || itemTable) {
        const original = [line];
        const inner = [itemText];
        let cursor = i + 1;
        let openFence = gatherFence(itemText);
        let openHtml = htmlOpening(itemText);
        while (cursor < lines.length) {
          const following = lines[cursor] ?? '';
          const stripped = stripIndent(following, content, displayOffset);
          if (!following.trim()) {
            if (!openFence && !openHtml) break;
            original.push(following);
            inner.push(stripped ?? '');
            cursor++;
            continue;
          }
          if (stripped === undefined) break;
          original.push(following);
          inner.push(stripped);
          if (openHtml) openHtml = advanceHtml(openHtml, stripped);
          else if (openFence && closingFence(stripped, openFence.marker, openFence.length))
            openFence = undefined;
          else if (!openFence) {
            openFence = gatherFence(stripped);
            if (!openFence) openHtml = htmlOpening(stripped);
          }
          cursor++;
        }
        let sourceLine = 0;
        for (const [index, block] of parseWithState(
          inner.join('\n'),
          listDepth + lists.length,
          quoteDepth,
          displayOffset + displayContent,
          state.streaming ? (state.list = streamingParserState()) : undefined,
        ).entries()) {
          const count = block.source.split('\n').length;
          const originalSource = original.slice(sourceLine, sourceLine + count).join('\n');
          sourceLine += count;
          const parentPrefix = index === 0 ? markerPrefix : ' '.repeat(displayContent);
          if (block.raw) {
            result.push({
              kind: 'literal',
              source: originalSource,
              text: originalSource,
              raw: true,
            });
            continue;
          }
          result.push({
            ...block,
            source: originalSource,
            prefix: parentPrefix + (block.prefix ?? ''),
            continuation: ' '.repeat(displayContent) + (block.continuation ?? block.prefix ?? ''),
          });
        }
        if (state.streaming) state.fenceBoundary = state.list?.fenceBoundary;
        activeChild = state.list;
        if (state.streaming) {
          state.tableBoundary = state.list?.tableBoundary ?? false;
          state.tableRow = state.list?.tableRow ?? false;
          state.tableContext = state.list?.tableContext ?? false;
          state.htmlLine = state.list?.htmlLine ?? false;
          state.listGatherFence = openFence;
          state.listGatherHtml = openHtml;
        }
        i = cursor;
        continue;
      }
      if (state.streaming && cells(itemText)) {
        state.list = streamingParserState();
        parseWithState(
          itemText,
          listDepth + lists.length,
          quoteDepth,
          displayOffset + displayContent,
          state.list,
        );
        state.listPreviousWasMarker = true;
        state.listPendingTable = true;
        activeChild = state.list;
      }
      result.push({
        kind: 'list',
        source: line,
        text: itemText,
        prefix: markerPrefix,
        continuation: ' '.repeat(displayContent),
      });
      i++;
      continue;
    }
    const activeList = lists[lists.length - 1];
    const indent = /^( *)/.exec(structural)?.[1]?.length ?? 0;
    if (overflowColumn !== undefined && indent >= overflowColumn) {
      result.push({ kind: 'literal', source: line, text: line, raw: true });
      i++;
      continue;
    }
    overflowColumn = undefined;
    if (activeList && indent >= activeList.content) {
      result.push({
        kind: 'list',
        source: line,
        text: stripIndent(line, activeList.content, displayOffset) ?? line,
        prefix: ' '.repeat(activeList.displayContent),
      });
      i++;
      continue;
    }
    if (activeList && !/^ {0,3}>/.test(line)) {
      lists.length = 0;
      lazyContinuation = true;
      result.push({ kind: 'literal', source: line, text: line, raw: true });
      i++;
      continue;
    }
    lists.length = 0;
    const quote = /^( {0,3})((?:> ?)+)([^\n]*)$/.exec(line);
    if (quote) {
      childProjection = {
        sourcePrefixLength: (quote[1]?.length ?? 0) + (quote[2]?.length ?? 0),
        textPrefix: '',
      };
      const depth = (quote[2]?.match(/>/g) ?? []).length;
      if (quoteDepth + depth > 8) {
        result.push({ kind: 'literal', source: line, text: line, raw: true });
        i++;
        continue;
      }
      const inner: string[] = [];
      const original: string[] = [];
      while (i < lines.length) {
        const originalLine = lines[i] ?? '';
        const match = /^( {0,3})((?:> ?)+)([^\n]*)$/.exec(originalLine);
        if (!match || (match[2]?.match(/>/g) ?? []).length !== depth) break;
        original.push(originalLine);
        inner.push(match[3] ?? '');
        i++;
      }
      let sourceLine = 0;
      if (state.streaming && state.quoteDepth !== depth) state.quote = undefined;
      if (state.streaming) {
        if (state.quote) delegatedLine = true;
        else tentativeContainer = true;
      }
      state.quoteDepth = depth;
      const childState = state.streaming ? (state.quote ??= streamingParserState()) : undefined;
      activeChild = childState;
      for (const block of parseWithState(
        inner.join('\n'),
        listDepth,
        quoteDepth + depth,
        displayOffset + depth * 2,
        childState,
      )) {
        const count = block.source.split('\n').length;
        const originalSource = original.slice(sourceLine, sourceLine + count).join('\n');
        sourceLine += count;
        if (block.raw) {
          result.push({ kind: 'literal', source: originalSource, text: originalSource, raw: true });
          continue;
        }
        result.push({
          ...block,
          source: originalSource,
          prefix: '│ '.repeat(depth) + (block.prefix ?? ''),
          continuation: '│ '.repeat(depth) + (block.continuation ?? block.prefix ?? ''),
          quoted: true,
        });
      }
      state.fenceBoundary = childState?.fenceBoundary;
      state.tableBoundary = childState?.tableBoundary ?? false;
      state.tableRow = childState?.tableRow ?? false;
      state.tableContext = childState?.tableContext ?? false;
      state.htmlLine = childState?.htmlLine ?? false;
      if (childState?.revision) {
        state.revisionProjection = composeProjection(
          state.previous?.childProjection,
          childState.revisionProjection,
        );
        const block = childState.revision;
        state.preserveRevisionPrefix = childState.preserveRevisionPrefix;
        state.revision = {
          ...block,
          source: state.previous?.source ?? block.source,
          prefix: '│ '.repeat(depth) + (block.prefix ?? ''),
          continuation: '│ '.repeat(depth) + (block.continuation ?? block.prefix ?? ''),
          quoted: true,
        };
      }
      continue;
    }
    if (/^ {4}/.test(line)) {
      result.push({ kind: 'literal', source: line, text: line });
      i++;
      continue;
    }
    const paragraph = [line];
    i++;
    while (
      i < lines.length &&
      (lines[i] ?? '').trim() &&
      !isBlockStart(lines[i] ?? '') &&
      !isTablePair(lines[i] ?? '', lines[i + 1] ?? '') &&
      !isSetextPair(lines[i] ?? '', lines[i + 1] ?? '') &&
      !/^ {4}/.test(lines[i] ?? '')
    ) {
      paragraph.push(lines[i] ?? '');
      i++;
    }
    result.push({ kind: 'paragraph', source: paragraph.join('\n'), text: paragraph.join('\n') });
  }
  if (state.streaming) {
    const last = result[result.length - 1];
    // A recognized delimiter/body already belongs to its table. After that
    // table ends, those physical bytes cannot become another pair's header.
    const tableOwned = state.tableBoundary || state.tableRow;
    const header =
      !tableOwned &&
      (!state.htmlLine || tentativeContainer) &&
      !delegatedLine &&
      !unsupported(source) &&
      !fence(source) &&
      (last?.kind !== 'code' || tentativeContainer)
        ? cells(source)
        : undefined;
    state.previous = {
      source: source.slice(0, 256),
      paragraph: last?.kind === 'paragraph' && !last.prefix,
      tableColumns: header?.length,
      tableCandidate: header !== undefined || activeChild?.previous?.tableCandidate === true,
      childProjection,
      eligible:
        !tableOwned &&
        !consumedPair &&
        !ownedLazyLine &&
        !state.htmlLine &&
        !delegatedLine &&
        !!source.trim() &&
        !isBlockStart(source) &&
        last?.kind !== 'code',
    };
  }
  state.overflowColumn = overflowColumn;
  state.lazyContinuation = lazyContinuation;
  return result;
}

export interface BlockLineResult {
  readonly block: MarkdownBlock;
  readonly continuesParagraph: boolean;
  readonly fenceBoundary?: 'open' | 'close';
  readonly tableBoundary?: true;
  /** This physical line is a row of an already recognized table. */
  readonly tableRow?: true;
  /** The existing table's container was reached and this line may still become a row. */
  readonly tableContext?: true;
  readonly htmlLine?: true;
  /** Source prefix replaced before rendering list/container content. */
  readonly listProjection?: { readonly sourcePrefixLength: number; readonly textPrefix: string };
  readonly revision?: MarkdownBlock;
  /** Exact physical-source replacement for the preceding revised line's text. */
  readonly revisionProjection?: SourceProjection;
  readonly preserveRevisionPrefix?: boolean;
}

interface PrefixRun {
  readonly text: string;
  count: number;
}

function prefixRuns(prefix: string): PrefixRun[] {
  const runs: PrefixRun[] = [];
  for (const text of prefix) {
    const last = runs[runs.length - 1];
    if (last?.text === text) last.count++;
    else runs.push({ text, count: 1 });
  }
  return runs;
}

function matchesPrefix(runs: readonly PrefixRun[], prefix: string): boolean {
  const candidate = prefixRuns(prefix);
  return (
    candidate.length === runs.length &&
    candidate.every(
      (run, index) => run.text === runs[index]?.text && run.count === runs[index]?.count,
    )
  );
}

/**
 * Incrementally classify physical lines using the static parser's container state.
 * Preview callers supply a bounded prefix; commit consumes the complete line once.
 * Revision source and text are bounded previews. The caller retains the prior line.
 */
export class BlockLineClassifier {
  private state = streamingParserState();
  private previousParagraph: { continuation: PrefixRun[]; quoted: boolean } | undefined;

  /** An actual scope on the last physical line can still adopt its raw header. */
  get pendingTableHeader(): boolean {
    return this.state.previous?.tableCandidate === true;
  }

  preview(line: string): BlockLineResult {
    return this.classify(line, cloneParserState(this.state));
  }

  commit(line: string): BlockLineResult {
    const result = this.classify(line, this.state);
    this.previousParagraph =
      result.block.kind === 'paragraph'
        ? {
            continuation: prefixRuns(result.block.continuation ?? result.block.prefix ?? ''),
            quoted: Boolean(result.block.quoted),
          }
        : undefined;
    return result;
  }

  reset(): void {
    this.state = streamingParserState();
    this.previousParagraph = undefined;
  }

  private classify(line: string, state: ParserState): BlockLineResult {
    const block = parseWithState(line, 0, 0, 0, state)[0] ?? {
      kind: 'literal',
      source: line,
      text: line,
    };
    const previous = this.previousParagraph;
    const continuesParagraph =
      !state.revision &&
      block.kind === 'paragraph' &&
      previous !== undefined &&
      matchesPrefix(previous.continuation, block.prefix ?? '') &&
      previous.quoted === Boolean(block.quoted);
    let listProjection: BlockLineResult['listProjection'];
    if (
      block.kind === 'list' ||
      ((block.kind === 'paragraph' || block.kind === 'literal') && !!block.prefix && !block.raw)
    ) {
      let shared = 0;
      while (
        shared < block.source.length &&
        shared < block.text.length &&
        block.source[block.source.length - shared - 1] ===
          block.text[block.text.length - shared - 1]
      )
        shared++;
      listProjection = {
        sourcePrefixLength: block.source.length - shared,
        textPrefix: block.text.slice(0, block.text.length - shared),
      };
    }
    return {
      block,
      continuesParagraph,
      ...(state.tableBoundary ? { tableBoundary: true } : {}),
      ...(state.tableRow ? { tableRow: true } : {}),
      ...(state.tableContext ? { tableContext: true } : {}),
      ...(state.htmlLine ? { htmlLine: true } : {}),
      ...(state.fenceBoundary ? { fenceBoundary: state.fenceBoundary } : {}),
      ...(listProjection ? { listProjection } : {}),
      ...(state.revision
        ? {
            revision: state.revision,
            preserveRevisionPrefix: state.preserveRevisionPrefix,
            ...(state.revisionProjection ? { revisionProjection: state.revisionProjection } : {}),
          }
        : {}),
    };
  }
}
