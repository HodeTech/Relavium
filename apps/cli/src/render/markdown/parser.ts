import type { MarkdownBlock } from './types.js';

type Alignment = 'left' | 'right' | 'center';

/** Split on unescaped pipes outside matched backtick runs. */
function cells(line: string): string[] | undefined {
  const nextRun = new Map<number, number>();
  const latest = new Map<number, number>();
  for (let at = line.length - 1; at >= 0; ) {
    if (line[at] !== '`') {
      at--;
      continue;
    }
    const end = at + 1;
    while (at >= 0 && line[at] === '`') at--;
    const start = at + 1;
    const length = end - start;
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
  if (firstPipe < 0) return undefined;
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
  const match = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(line);
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
  return i >= length && /^ *$/.test(trimmed.slice(i));
}
function closing(line: string, marker: string): boolean {
  return closingFence(line, marker[0] ?? '', marker.length);
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
  let end = line.length;
  while (end > contentStart && line[end - 1] === ' ') {
    end--;
    if (work) work.steps++;
  }
  let hashStart = end;
  while (hashStart > contentStart && line[hashStart - 1] === '#') {
    hashStart--;
    if (work) work.steps++;
  }
  if (hashStart < end && hashStart > contentStart && line[hashStart - 1] === ' ') {
    end = hashStart;
    while (end > contentStart && line[end - 1] === ' ') {
      end--;
      if (work) work.steps++;
    }
  }
  return { level, text: line.slice(contentStart, end) };
}
function isRule(line: string): boolean {
  return /^ {0,3}(?:(?:\* *){3,}|(?:- *){3,}|(?:_ *){3,})$/.test(line);
}
function unsupported(line: string): boolean {
  return /^ {0,3}(?:<\/?[A-Za-z][A-Za-z0-9-]*(?:\s[^>]*)?\/?>|\[[^\]]+\]:)/.test(line);
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

function stripIndent(line: string, required: number, offset: number): string | undefined {
  let width = 0;
  let index = 0;
  while (index < line.length && width < required) {
    if (line[index] === ' ') width++;
    else if (line[index] === '\t') width += 8 - ((width + offset) % 8);
    else return undefined;
    index++;
  }
  if (width < required) return undefined;
  return ' '.repeat(width - required) + line.slice(index);
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
  openFence: { marker: string; length: number; indent: number } | undefined;
  previous:
    | {
        source: string;
        eligible: boolean;
        paragraph: boolean;
        tableColumns: number | undefined;
      }
    | undefined;
  inTable: boolean;
  revision: MarkdownBlock | undefined;
  preserveRevisionPrefix: boolean;
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
    openFence: undefined,
    previous: undefined,
    inTable: false,
    revision: undefined,
    preserveRevisionPrefix: false,
  };
}

function streamingParserState(): ParserState {
  const state = newParserState();
  state.streaming = true;
  return state;
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
  state.preserveRevisionPrefix = false;
  let i = 0;
  const lists = state.lists;
  let overflowColumn = state.overflowColumn;
  let lazyContinuation = state.lazyContinuation;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    if (state.streaming && state.openFence) {
      const open = state.openFence;
      if (closingFence(line, open.marker, open.length)) {
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
    if (state.streaming && state.inTable) {
      if (line.trim() && !isBlockStart(line) && cells(line)) {
        result.push({ kind: 'literal', source: line, text: line });
        i++;
        continue;
      }
      state.inTable = false;
    }
    if (state.streaming && state.previous?.tableColumns !== undefined) {
      const alignment = delimiter(line);
      if (alignment && alignment.length === state.previous.tableColumns) {
        state.revision = {
          kind: 'literal',
          source: state.previous.source,
          text: state.previous.source,
        };
        state.inTable = true;
        lists.length = 0;
        overflowColumn = undefined;
        lazyContinuation = false;
        result.push({ kind: 'literal', source: line, text: line });
        i++;
        continue;
      }
    }
    if (state.streaming && state.previous?.eligible && isSetextPair('header', line)) {
      state.revision = {
        kind: 'literal',
        source: state.previous.source,
        text: state.previous.source,
      };
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
    if (state.streaming && !line.trim() && state.list?.openFence) {
      const active = lists[lists.length - 1];
      if (active) {
        const block = parseWithState(
          '',
          listDepth + lists.length,
          quoteDepth,
          displayOffset + active.displayContent,
          state.list,
        )[0];
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
      state.quote = undefined;
      result.push({ kind: 'literal', source: line, text: line });
      i++;
      continue;
    }
    if (lazyContinuation) {
      if (isBlockStart(line) || delimiter(lines[i + 1] ?? '')) lazyContinuation = false;
      else {
        result.push({ kind: 'literal', source: line, text: line, raw: true });
        i++;
        continue;
      }
    }
    const currentList = lists[lists.length - 1];
    const relative = currentList
      ? stripIndent(line, currentList.content, displayOffset)
      : undefined;
    if (state.streaming && relative === undefined) state.list = undefined;
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
      const original: string[] = [];
      const inner: string[] = [];
      let openFence: ReturnType<typeof fence>;
      while (i < lines.length) {
        const raw = lines[i] ?? '';
        const stripped = stripIndent(raw, currentList.content, displayOffset);
        if (!raw.trim()) {
          if (!openFence) break;
          original.push(raw);
          inner.push(stripped ?? '');
          i++;
          continue;
        }
        if (stripped === undefined) break;
        original.push(raw);
        inner.push(stripped);
        if (openFence && closing(stripped, openFence.marker)) openFence = undefined;
        else if (!openFence) openFence = fence(stripped);
        i++;
      }
      let sourceLine = 0;
      const childState = state.streaming ? (state.list ??= streamingParserState()) : undefined;
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
      state.preserveRevisionPrefix =
        childState?.preserveRevisionPrefix === true ||
        (childState?.revision !== undefined && state.listPreviousWasMarker);
      if (childState?.revision) {
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
      result.push({ kind: 'literal', source: line, text: line });
      i++;
      continue;
    }
    const open = fence(line);
    if (open) {
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
        if (closing(next, open.marker)) {
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
        const row = cells(next);
        if (!row) break;
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
    const list = /^( *)([-+*]|\d+[.)])( {1,4})(\S.*|$)$/.exec(structural);
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
      if (state.streaming) state.list = undefined;
      const marker = list[2] ?? '';
      const padding = list[3] ?? ' ';
      const visibleMarker = /^\d/.test(marker) ? marker : '•';
      const content = column + marker.length + padding.length;
      const displayContent = column + visibleMarker.length + padding.length;
      const frame = { column, content, displayContent };
      if (sibling) lists[lists.length - 1] = frame;
      else lists.push(frame);
      const itemText = line.slice(sourceIndex[content] ?? line.length);
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
      const itemNext = stripIndent(lines[i + 1] ?? '', content, displayOffset);
      const itemTable = cells(itemText) && itemNext !== undefined && delimiter(itemNext);
      if (isBlockStart(itemText) || itemTable) {
        const original = [line];
        const inner = [itemText];
        let cursor = i + 1;
        let openFence = fence(itemText);
        while (cursor < lines.length) {
          const following = lines[cursor] ?? '';
          const stripped = stripIndent(following, content, displayOffset);
          if (!following.trim()) {
            if (!openFence) break;
            original.push(following);
            inner.push(stripped ?? '');
            cursor++;
            continue;
          }
          if (stripped === undefined) break;
          original.push(following);
          inner.push(stripped);
          if (openFence && closing(stripped, openFence.marker)) openFence = undefined;
          else if (!openFence) openFence = fence(stripped);
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
      }
      result.push({ kind: 'list', source: line, text: itemText, prefix: markerPrefix });
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
    const quote = /^( {0,3})((?:> ?)+)(.*)$/.exec(line);
    if (quote) {
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
        const match = /^( {0,3})((?:> ?)+)(.*)$/.exec(originalLine);
        if (!match || (match[2]?.match(/>/g) ?? []).length !== depth) break;
        original.push(originalLine);
        inner.push(match[3] ?? '');
        i++;
      }
      let sourceLine = 0;
      if (state.streaming && state.quoteDepth !== depth) state.quote = undefined;
      state.quoteDepth = depth;
      const childState = state.streaming ? (state.quote ??= streamingParserState()) : undefined;
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
      if (childState?.revision) {
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
    const header =
      !unsupported(source) && !fence(source) && !last?.prefix ? cells(source) : undefined;
    state.previous = {
      source: source.slice(0, 256),
      paragraph: last?.kind === 'paragraph' && !last.prefix,
      tableColumns: header?.length,
      eligible:
        !!source.trim() &&
        !isBlockStart(source) &&
        !last?.raw &&
        !last?.prefix &&
        (last?.kind === 'paragraph' || last?.kind === 'literal'),
    };
  }
  state.overflowColumn = overflowColumn;
  state.lazyContinuation = lazyContinuation;
  return result;
}

export interface BlockLineResult {
  readonly block: MarkdownBlock;
  readonly continuesParagraph: boolean;
  readonly revision?: MarkdownBlock;
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

  preview(line: string): BlockLineResult {
    return this.classify(line, structuredClone(this.state));
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
    return state.revision
      ? {
          block,
          revision: state.revision,
          continuesParagraph,
          preserveRevisionPrefix: state.preserveRevisionPrefix,
        }
      : { block, continuesParagraph };
  }
}
