import { sanitizeInline } from '../sanitize.js';
import { StaticInlineIndex, type InlineSourceIndex } from './inline-index.js';
import { interpretInlineItem, type InlineItemEdit } from './inline-item.js';
import type { MarkdownSpan } from './types.js';

type Style = Omit<MarkdownSpan, 'text'>;

export interface InlineEdit {
  readonly start: number;
  readonly end: number;
  /** Replacement text; when raw is true, the source range is kept uninterpreted. */
  readonly text: string;
  readonly raw?: boolean;
}
export interface InlineDependency {
  readonly at: number;
  readonly token: string;
}
export interface InlineInterpretation {
  readonly spans: readonly MarkdownSpan[];
  readonly edits: readonly InlineEdit[];
  readonly unresolved: readonly InlineDependency[];
}

/** Parse sanitized inline input and expose the same source edits to streaming consumers. */
export function interpretInline(source: string): InlineInterpretation {
  const edits: InlineEdit[] = [];
  const unresolved: InlineDependency[] = [];
  const spans = parseInlineInternal(source, {}, 0, edits, unresolved, 0);
  return { spans, edits, unresolved };
}

/** Parse the supported inline syntax into semantic spans without escape sequences. */
export function parseInline(source: string, style: Style = {}, depth = 0): MarkdownSpan[] {
  return parseInlineInternal(source, style, depth, undefined, undefined, 0);
}

function parseInlineInternal(
  source: string,
  style: Style,
  depth: number,
  edits: InlineEdit[] | undefined,
  unresolved: InlineDependency[] | undefined,
  offset: number,
  mapping?: readonly number[],
): MarkdownSpan[] {
  const result: MarkdownSpan[] = [];
  const position = (at: number): number => mapping?.[at] ?? offset + at;
  const record = (change: InlineEdit): void => {
    if (!edits || change.start >= change.end) return;
    if (!change.raw) {
      while (edits.length) {
        const previous = edits[edits.length - 1];
        if (!previous || previous.raw || previous.start < change.start || previous.end > change.end)
          break;
        edits.pop();
      }
    }
    edits.push(change);
  };
  const base = new StaticInlineIndex(source);
  if (unresolved) {
    for (let at = 0; at < source.length; ) {
      if (base.charAt(at) !== '_' || base.escaped(at)) {
        at++;
        continue;
      }
      const start = at;
      while (base.charAt(at) === '_' && !base.escaped(at)) at++;
      if (
        at === source.length ||
        (at + 1 === source.length && /[\uD800-\uDBFF]/u.test(base.charAt(at)))
      )
        unresolved.push({ at: position(start), token: 'word' });
    }
  }
  let decisionAt = 0;
  const index: InlineSourceIndex = {
    length: base.length,
    charAt: (at) => base.charAt(at),
    slice: (start, end) => base.slice(start, end),
    startsWith: (token, at) => base.startsWith(token, at),
    escaped: (at) => base.escaped(at),
    intraword: (at) => base.intraword(at),
    opaque: (at) => base.opaque(at),
    runEnd: (start, character, end) => base.runEnd(start, character, end),
    plainEnd: (start, end) => base.plainEnd(start, end),
    singleCount: (marker, start, end) => base.singleCount(marker, start, end),
    next: (token, start, end) => {
      const found = base.next(token, start, end);
      if (found < 0 && unresolved) unresolved.push({ at: position(decisionAt), token });
      return found;
    },
    parenClose: (open, end) => {
      const found = base.parenClose(open, end);
      if (found < 0 && unresolved) unresolved.push({ at: position(decisionAt), token: ')' });
      return found;
    },
    tickClose: (start, end) => {
      const found = base.tickClose(start, end);
      if (found < 0 && unresolved)
        unresolved.push({
          at: position(start),
          token: source.slice(start, base.runEnd(start, '`', end)),
        });
      return found;
    },
  };
  let plain = '';
  const flush = (): void => {
    if (plain) result.push({ text: plain, ...style });
    plain = '';
  };
  const sameStyle = (left: Style, right: Style): boolean =>
    left.strong === right.strong &&
    left.emphasis === right.emphasis &&
    left.code === right.code &&
    left.strike === right.strike &&
    left.heading === right.heading &&
    left.quote === right.quote &&
    left.dim === right.dim &&
    left.linkURL === right.linkURL;
  for (let at = 0; at < source.length; ) {
    decisionAt = at;
    const childEdits: InlineEdit[] = [];
    const item = interpretInlineItem(
      index,
      at,
      source.length,
      depth,
      plain.slice(-2),
      (start, end, childDepth, flags, flatten) => {
        const childSource = source.slice(start, end);
        const childInput = flatten ? sanitizeInline(childSource) : childSource;
        let childMap = mapping?.slice(start, end + 1);
        const tabs: InlineEdit[] = [];
        if (edits && flatten) {
          childMap = [position(start)];
          for (let cursor = start; cursor < end; ) {
            if (source[cursor] === '\t') {
              const begin = cursor;
              while (cursor < end && source[cursor] === '\t') cursor++;
              tabs.push({ start: position(begin), end: position(cursor), text: ' ' });
              childMap.push(position(cursor));
            } else {
              cursor++;
              childMap.push(position(cursor));
            }
          }
        }
        const nestedEdits: InlineEdit[] | undefined = edits ? [] : undefined;
        const spans = parseInlineInternal(
          childInput,
          { ...style, ...flags },
          childDepth,
          nestedEdits,
          unresolved,
          position(start),
          childMap,
        );
        const nested = nestedEdits ?? [];
        let tabIndex = 0,
          nestedIndex = 0;
        while (tabIndex < tabs.length || nestedIndex < nested.length) {
          const tab = tabs[tabIndex],
            inner = nested[nestedIndex];
          if (tab && (!inner || tab.start <= inner.start)) {
            childEdits.push(tab);
            tabIndex++;
          } else if (inner) {
            childEdits.push(inner);
            nestedIndex++;
          }
        }
        return { text: spans.map((span) => span.text).join(''), value: spans };
      },
    );
    if (!item.plain) flush();
    if (item.trimPlain) plain = plain.slice(0, -item.trimPlain);
    let pendingText = '';
    let pendingStyle: Style | undefined;
    const flushPending = (): void => {
      if (pendingText && pendingStyle) result.push({ text: pendingText, ...pendingStyle });
      pendingText = '';
      pendingStyle = undefined;
    };
    for (const part of item.parts) {
      if (part.kind === 'child') {
        flushPending();
        for (const span of part.value) result.push(span);
        continue;
      }
      const value =
        part.kind === 'text'
          ? part.text
          : part.flatten
            ? sanitizeInline(source.slice(part.start, part.end))
            : source.slice(part.start, part.end);
      if (item.plain) {
        plain += value;
        continue;
      }
      const partStyle = { ...style, ...part.style };
      if (pendingStyle && !sameStyle(pendingStyle, partStyle)) flushPending();
      pendingStyle = partStyle;
      pendingText += value;
      if (edits && part.kind === 'raw' && part.flatten) {
        for (let cursor = part.start; cursor < part.end; ) {
          if (source[cursor] !== '\t') {
            cursor++;
            continue;
          }
          const begin = cursor;
          while (cursor < part.end && source[cursor] === '\t') cursor++;
          childEdits.push({ start: position(begin), end: position(cursor), text: ' ' });
        }
      }
    }
    flushPending();
    if (edits) {
      const outer: InlineEdit[] = item.edits
        .filter((entry) => entry.start < entry.end)
        .map((entry: InlineItemEdit) =>
          entry.raw
            ? {
                start: position(entry.start),
                end: position(entry.end),
                text: entry.text,
                raw: true,
              }
            : { start: position(entry.start), end: position(entry.end), text: entry.text },
        );
      let outerIndex = 0,
        childIndex = 0;
      while (outerIndex < outer.length || childIndex < childEdits.length) {
        const parent = outer[outerIndex],
          nested = childEdits[childIndex];
        if (parent && (!nested || parent.start <= nested.start)) {
          record(parent);
          outerIndex++;
        } else if (nested) {
          record(nested);
          childIndex++;
        }
      }
    }
    at = item.end;
  }
  flush();
  return result;
}
