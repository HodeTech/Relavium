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
function closing(line: string, marker: string): boolean {
  const trimmed = line.replace(/^ {0,3}/, '');
  let i = 0;
  while (trimmed[i] === marker[0]) i++;
  return i >= marker.length && /^ *$/.test(trimmed.slice(i));
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
function isStart(line: string): boolean {
  return (
    unsupported(line) ||
    !!fence(line) ||
    /^ {0,3}#{1,6} +/.test(line) ||
    isRule(line) ||
    /^ {0,3}(?:[-+*]|\d+[.)]) {1,4}\S/.test(line) ||
    /^ {0,3}>/.test(line)
  );
}

function stripIndent(line: string, required: number): string | undefined {
  let width = 0;
  let index = 0;
  while (index < line.length && width < required) {
    if (line[index] === ' ') width++;
    else if (line[index] === '\t') width += 8 - (width % 8);
    else return undefined;
    index++;
  }
  if (width < required) return undefined;
  return ' '.repeat(width - required) + line.slice(index);
}

/** Parse sanitized source. Unsupported constructs remain visible as literal text. */
export function parseMarkdown(
  source: string,
  listDepth = 0,
  quoteDepth = 0,
): readonly MarkdownBlock[] {
  const lines = source.split('\n');
  const result: MarkdownBlock[] = [];
  let i = 0;
  const lists: { column: number; content: number; displayContent: number }[] = [];
  let overflowColumn: number | undefined;
  let lazyContinuation = false;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    if (!line.trim()) {
      lists.length = 0;
      overflowColumn = undefined;
      lazyContinuation = false;
      result.push({ kind: 'literal', source: line, text: line });
      i++;
      continue;
    }
    if (lazyContinuation) {
      if (isStart(line) || delimiter(lines[i + 1] ?? '')) lazyContinuation = false;
      else {
        result.push({ kind: 'literal', source: line, text: line, raw: true });
        i++;
        continue;
      }
    }
    const currentList = lists[lists.length - 1];
    const relative = currentList ? stripIndent(line, currentList.content) : undefined;
    if (
      currentList &&
      relative !== undefined &&
      isStart(relative) &&
      overflowColumn === undefined
    ) {
      const original: string[] = [];
      const inner: string[] = [];
      let openFence: ReturnType<typeof fence>;
      while (i < lines.length) {
        const raw = lines[i] ?? '';
        const stripped = stripIndent(raw, currentList.content);
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
      for (const block of parseMarkdown(inner.join('\n'), listDepth + lists.length, quoteDepth)) {
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
      while (i < lines.length) {
        const next = lines[i] ?? '';
        raw.push(next);
        i++;
        if (closing(next, open.marker)) break;
        let trim = 0;
        while (trim < open.indent && next[trim] === ' ') trim++;
        body.push(next.slice(trim));
      }
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
        if (!next.trim() || isStart(next)) break;
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
    if (/^ {0,3}(?:-{3,}|={3,}) *$/.test(lines[i + 1] ?? '') && !isStart(line)) {
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
    // Tabs affect structural columns even though source text is retained for fallback.
    let structural = '';
    const sourceIndex = [0];
    let structuralColumn = 0;
    for (let sourceColumn = 0; sourceColumn < line.length; sourceColumn++) {
      const character = line[sourceColumn] ?? '';
      if (character === '\t') {
        const count = 8 - (structuralColumn % 8);
        structural += ' '.repeat(count);
        for (let tabCell = 0; tabCell < count; tabCell++) sourceIndex.push(sourceColumn + 1);
        structuralColumn += count;
      } else {
        structural += character;
        sourceIndex.push(sourceColumn + 1);
        structuralColumn++;
      }
    }
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
      const marker = list[2] ?? '';
      const padding = list[3] ?? ' ';
      const visibleMarker = /^\d/.test(marker) ? marker : '•';
      const content = column + marker.length + padding.length;
      const displayContent = column + visibleMarker.length + padding.length;
      const state = { column, content, displayContent };
      if (sibling) lists[lists.length - 1] = state;
      else lists.push(state);
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
      const itemNext = stripIndent(lines[i + 1] ?? '', content);
      const itemTable = cells(itemText) && itemNext !== undefined && delimiter(itemNext);
      if (isStart(itemText) || itemTable) {
        const original = [line];
        const inner = [itemText];
        let cursor = i + 1;
        let openFence = fence(itemText);
        while (cursor < lines.length) {
          const following = lines[cursor] ?? '';
          const stripped = stripIndent(following, content);
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
        for (const [index, block] of parseMarkdown(
          inner.join('\n'),
          listDepth + lists.length,
          quoteDepth,
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
        text: stripIndent(line, activeList.content) ?? line,
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
      for (const block of parseMarkdown(inner.join('\n'), listDepth, quoteDepth + depth)) {
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
      !isStart(lines[i] ?? '') &&
      !delimiter(lines[i + 1] ?? '') &&
      !/^ {0,3}(?:-{3,}|={3,}) *$/.test(lines[i + 1] ?? '') &&
      !/^ {4}/.test(lines[i] ?? '')
    ) {
      paragraph.push(lines[i] ?? '');
      i++;
    }
    result.push({ kind: 'paragraph', source: paragraph.join('\n'), text: paragraph.join('\n') });
  }
  return result;
}
