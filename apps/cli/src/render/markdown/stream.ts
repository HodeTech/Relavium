import { displayWidth } from '../tui/viewport.js';
import { parseInline } from './inline.js';
import { layoutMarkdown } from './layout.js';
import { parseMarkdown } from './parser.js';
import type { MarkdownBlock, MarkdownDisplayLine, MarkdownSpan } from './types.js';
import { isWordCodePoint } from './unicode-word.js';

const LIVE_SOURCE_LIMIT = 4_000;
const TABLE_SOURCE_LIMIT = 65_536;
const TAIL_CONTEXT = 64;
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

function sourceTail(source: string, limit = LIVE_SOURCE_LIMIT): string {
  if (source.length <= limit) return source;
  const window = source.slice(-limit - TAIL_CONTEXT);
  const minimum = window.length - limit;
  const unknownContinuation = /^[\p{Grapheme_Extend}\p{M}\p{Emoji_Modifier}\u200d]/u.test(window);
  let firstBoundary = true;
  for (const cluster of graphemes.segment(window)) {
    if (cluster.index === 0) continue;
    // A window beginning inside Extend*+ZWJ (or an Indic continuation)
    // cannot establish its first apparent break. Elide that whole cluster
    // conservatively instead of painting a suffix of an omitted grapheme.
    if (firstBoundary && unknownContinuation) {
      firstBoundary = false;
      continue;
    }
    firstBoundary = false;
    if (cluster.index >= minimum) return window.slice(cluster.index);
  }
  return '';
}

function completeTail(source: string, limit = LIVE_SOURCE_LIMIT): string {
  if (source.length <= limit) return source;
  const minimum = source.length - limit;
  for (const cluster of graphemes.segment(source)) {
    if (cluster.index >= minimum) return source.slice(cluster.index);
  }
  return '';
}

type InlineStyle = Omit<MarkdownSpan, 'text'>;
interface Delimiter {
  readonly marker: string;
  readonly start: number;
  readonly end: number;
}
interface Match extends Delimiter {
  readonly close: number;
  readonly finish: number;
}
interface LinkMatch {
  readonly start: number;
  readonly labelEnd: number;
  readonly targetStart: number;
  readonly finish: number;
  readonly target: string;
  readonly image: boolean;
  readonly autolink: boolean;
  readonly duplicate: boolean;
}
interface LinkCandidate {
  readonly start: number;
  readonly image: boolean;
  state: 'label' | 'bracket' | 'target' | 'auto';
  labelEnd: number;
  targetStart: number;
  target: string[];
  valid: boolean;
}
type Container = { readonly kind: 'quote' } | { readonly kind: 'list'; readonly content: number };
interface Fence {
  readonly containers?: readonly Container[];
  readonly block?: MarkdownBlock;
  readonly marker: string;
  readonly indent: number;
  readonly info: string;
}
interface Preview {
  readonly block: MarkdownBlock;
  readonly size: number;
  layout?: { readonly columns: number; readonly lines: readonly MarkdownDisplayLine[] };
}

function fence(line: string): Fence | undefined {
  const match = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(line);
  if (!match) return undefined;
  const marker = match[2] ?? '';
  const info = (match[3] ?? '').trim();
  if (marker[0] === '`' && info.includes('`')) return undefined;
  return { marker, indent: (match[1] ?? '').length, info };
}
function containerFence(
  line: string,
  parse: (source: string) => readonly MarkdownBlock[],
): Fence | undefined {
  let content = line;
  const containers: Container[] = [];
  for (let depth = 0; depth < 16; depth++) {
    const opening = fence(content);
    if (opening) {
      const block = parse(line)[0];
      return { ...opening, containers, ...(block ? { block } : {}) };
    }
    const quote = /^ {0,3}> ?/.exec(content);
    if (quote) {
      if (containers.filter((container) => container.kind === 'quote').length >= 8)
        return undefined;
      containers.push({ kind: 'quote' });
      content = content.slice(quote[0].length);
      continue;
    }
    const list = /^( *)(?:[-+*]|\d+[.)]) {1,4}(?=\S)/.exec(content);
    if (list) {
      if (containers.filter((container) => container.kind === 'list').length >= 8) return undefined;
      containers.push({ kind: 'list', content: list[0].length });
      content = content.slice(list[0].length);
      continue;
    }
    return undefined;
  }
  return undefined;
}
function tableContainers(line: string): readonly Container[] {
  let content = line;
  const containers: Container[] = [];
  for (let depth = 0; depth < 16; depth++) {
    const quote = /^ {0,3}> ?/.exec(content);
    if (quote) {
      containers.push({ kind: 'quote' });
      content = content.slice(quote[0].length);
      continue;
    }
    const list = /^( *)(?:[-+*]|\d+[.)]) {1,4}(?=\S)/.exec(content);
    if (!list) break;
    containers.push({ kind: 'list', content: list[0].length });
    content = content.slice(list[0].length);
  }
  return containers;
}
function stripContainers(line: string, containers: readonly Container[]): string | undefined {
  let content = line;
  let column = 0;
  for (const container of containers) {
    if (container.kind === 'quote') {
      const quote = /^ {0,3}> ?/.exec(content);
      if (!quote) return undefined;
      content = content.slice(quote[0].length);
      column += quote[0].length;
    } else {
      if (!content.trim()) {
        content = '';
        column += container.content;
        continue;
      }
      let at = 0;
      let consumed = 0;
      while (consumed < container.content) {
        const character = content[at];
        if (character !== ' ' && character !== '\t') return undefined;
        const cells = character === '\t' ? 8 - ((column + consumed) % 8) : 1;
        const needed = container.content - consumed;
        if (cells > needed) {
          // The container ends inside this tab. Its remaining cells belong to
          // the code/table body; deleting the tab would lose indentation and
          // could turn a six-space code line into a valid fence closer.
          content = ' '.repeat(cells - needed) + content.slice(at + 1);
          at = 0;
          consumed = container.content;
        } else {
          consumed += cells;
          at++;
        }
      }
      content = content.slice(at);
      column += container.content;
    }
  }
  return content;
}
function fenceContent(line: string, opening: Fence): string | undefined {
  return stripContainers(line, opening.containers ?? []);
}
function closesFence(line: string, marker: string): boolean {
  let at = 0;
  while (at < 3 && line[at] === ' ') at++;
  const start = at;
  while (line[at] === marker[0]) at++;
  if (at - start < marker.length) return false;
  while (line[at] === ' ') at++;
  return at === line.length;
}
function rule(line: string): boolean {
  return /^ {0,3}(?:(?:\* *){3,}|(?:- *){3,}|(?:_ *){3,})$/.test(line);
}
function startsBlock(line: string): boolean {
  return (
    fence(line) !== undefined ||
    /^ {0,3}#{1,6} +/.test(line) ||
    rule(line) ||
    /^( *)(?:[-+*]|\d+[.)]) {1,4}\S/.test(line) ||
    /^ {0,3}>/.test(line) ||
    /^ {4}/.test(line)
  );
}
function literal(source: string): MarkdownBlock {
  return { kind: 'literal', source, text: source };
}
function clippedSpans(spans: readonly MarkdownSpan[], limit: number): MarkdownSpan[] {
  const text = spans.map((span) => span.text).join('');
  let omit = text.length - completeTail(text, limit).length;
  const clipped: MarkdownSpan[] = [];
  for (const span of spans) {
    const count = Math.min(omit, span.text.length);
    omit -= count;
    if (count < span.text.length) clipped.push({ ...span, text: span.text.slice(count) });
  }
  return clipped;
}

function withPrefix(prefix: string, source: string): MarkdownSpan[] {
  if (!prefix) return parseInline(source);
  // The sentinel represents already-clipped content, so adjacent opener/closer
  // runs remain a real nonempty pair. It cannot occur in sanitized source and
  // is removed before spans leave the parser.
  return parseInline(prefix + '\0' + source)
    .map((span) => ({ ...span, text: span.text.replace('\0', '') }))
    .filter((span) => span.text.length > 0);
}

interface ColumnState {
  readonly cells: number;
  readonly context: string;
}

/** Measure whole graphemes only when a closed segment needs its column. */
class LogicalColumn {
  private committed = 0;
  private context = '';
  private contextWidth = 0;
  private pending: string[] = [];
  work = 0;

  get cells(): number {
    this.settle();
    return this.committed + this.contextWidth;
  }

  state(): ColumnState {
    this.settle();
    return { cells: this.committed + this.contextWidth, context: this.context };
  }

  restore(state: ColumnState): void {
    this.pending = [];
    this.context = state.context;
    this.contextWidth = displayWidth(state.context);
    this.work += state.context.length;
    this.committed = state.cells - this.contextWidth;
  }

  reset(cells = 0): void {
    this.committed = cells;
    this.context = '';
    this.contextWidth = 0;
    this.pending = [];
  }

  private settle(): void {
    if (!this.pending.length) return;
    const source = this.context + this.pending.join('');
    this.pending = [];
    let total = 0;
    let last = '';
    let lastWidth = 0;
    this.work += source.length;
    for (const cluster of graphemes.segment(source)) {
      last = cluster.segment;
      lastWidth = displayWidth(last);
      this.work += last.length;
      total += lastWidth;
    }
    this.committed += total - lastWidth;
    this.context = last;
    this.contextWidth = lastWidth;
  }

  append(text: string): void {
    let start = 0;
    for (let at = 0; at < text.length; at++) {
      const character = text[at];
      if (character !== '\n' && character !== '\t') continue;
      if (at > start) this.pending.push(text.slice(start, at));
      if (character === '\n') this.reset();
      else this.reset(this.cells + 8 - (this.cells % 8));
      start = at + 1;
    }
    if (start < text.length) this.pending.push(text.slice(start));
  }
}

interface SourceLine {
  readonly start: number;
  readonly block: MarkdownBlock;
}

/**
 * Advances the omitted prefix once. Closing a previously unresolved construct
 * only revisits that construct's omitted part, never the accumulated paragraph.
 * Emphasis nesting is bounded; code intervals collapse into a union instead
 * of replaying nested interiors. Completed source units retain their edits.
 */
class ColumnCheckpoint {
  private source: string[] = [];
  private riRuns: { start: number; end: number }[] = [];
  private sourcePointStart = 0;
  private edits = new Map<number, string>();
  private structure = new Map<number, string>();
  private breaks = new Map<number, string>();
  private raw = new Set<number>();
  private linkRaw = new Set<number>();
  private linkEdits = new Map<number, string>();
  private resets = new Map<number, number>();
  private pending = new Set<number>();
  private bases = new Map<number, ColumnState>();
  private rawColumn = new LogicalColumn();
  private rawBases = new Map<number, ColumnState>();
  private bodyStarts = new Set<number>();
  private tabs = new Map<
    number,
    { raw: number; semantic: number | undefined; before: ColumnState; reset: number }
  >();
  private liveCut = 0;
  private previewTabs: { key: string; tabs: ReadonlyMap<number, number> } | undefined;
  private lastRawReset = -1;
  private code: { start: number; end: number }[] = [];
  private codeHead = 0;
  private knownDelimiters = new Map<number, number>();
  private semanticColumn = new LogicalColumn();
  private offset = 0;
  private lines: SourceLine[] = [];
  private lastLineStart = -1;
  private annotatedThrough = 0;
  private previousKind = '';
  visits = 0;
  interpretation = 0;
  private previewWidth = 0;
  private contextWork = 0;

  describe(units: number): void {
    this.contextWork += units;
  }

  append(source: string): void {
    this.interpretation += source.length * 2;
    for (let at = 0; at < source.length; at++) this.source.push(source[at] ?? '');
    while (this.sourcePointStart < this.source.length) {
      const start = this.sourcePointStart;
      const first = this.source[start] ?? '';
      const high = first.charCodeAt(0) >= 0xd800 && first.charCodeAt(0) <= 0xdbff;
      if (high && start + 1 === this.source.length) break;
      const next = this.source[start + 1] ?? '';
      const pair = high && next.charCodeAt(0) >= 0xdc00 && next.charCodeAt(0) <= 0xdfff;
      const end = start + (pair ? 2 : 1);
      if (/\p{Regional_Indicator}/u.test(first + (pair ? next : ''))) {
        const run = this.riRuns[this.riRuns.length - 1];
        if (run?.end === start) run.end = end;
        else this.riRuns.push({ start, end });
      }
      this.sourcePointStart = end;
    }
  }

  secondRegionalIndicator(position: number): boolean {
    let low = 0;
    let high = this.riRuns.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if ((this.riRuns[middle]?.start ?? Infinity) <= position) low = middle + 1;
      else high = middle;
    }
    const run = this.riRuns[low - 1];
    return run !== undefined && position < run.end && (position - run.start) % 4 === 2;
  }

  open(position: number, bodyStart?: number): void {
    this.pending.add(position);
    if (bodyStart !== undefined) this.bodyStarts.add(bodyStart);
  }

  clearOpeners(): void {
    this.pending.clear();
    this.bases.clear();
    this.bodyStarts.clear();
    this.rawBases.clear();
  }

  private replace(start: number, end: number, text = ''): void {
    if (start >= end) return;
    this.interpretation++;
    this.edits.set(start, text);
    for (let at = start + 1; at < end; at++) {
      this.interpretation++;
      this.edits.set(at, '');
    }
  }

  escape(position: number): void {
    this.interpretation++;
    this.edits.set(position, '');
  }

  delimiter(match: Match): void {
    if (this.raw.has(match.start)) return;
    if (this.knownDelimiters.get(match.start) === match.finish) return;
    this.knownDelimiters.set(match.start, match.finish);
    this.replace(match.start, match.end);
    this.replace(match.close, match.finish);
    if (match.marker === '`') {
      // Completed code intervals are disjoint or contain earlier intervals.
      // Collapsing their union visits each interval at most once, even with
      // arbitrarily many distinct, overlapping backtick-run candidates.
      while ((this.code[this.code.length - 1]?.start ?? -1) >= match.end) {
        this.interpretation++;
        this.code.pop();
      }
      this.codeHead = Math.min(this.codeHead, this.code.length);
      this.code.push({ start: match.end, end: match.close });
      this.reconcileCode(match);
    } else this.reconcile(match.start);
  }

  private codeColumn(
    match: Match,
    end: number,
    rawEnd: ColumnState,
    lastReset: number,
  ): ColumnState | undefined {
    const base = this.bases.get(match.start);
    const rawBase = this.rawBases.get(match.end);
    if (!base || !rawBase) return undefined;
    if (end <= match.end) return base;
    if (lastReset >= match.end) return { cells: rawEnd.cells % 8, context: rawEnd.context };
    // Different backtick runs are separated by literal source. Probe through
    // the first intervening run, not an arbitrary UTF-16 window: the whole
    // leading grapheme may contain an arbitrarily long Extend/ZWJ sequence.
    // These leading source intervals are disjoint across delimiter runs.
    let boundary = match.end;
    while (boundary < end && this.source[boundary] !== '`') {
      this.interpretation++;
      boundary++;
    }
    const first = this.source.slice(match.end, boundary).join('');
    const combined = base.context + first;
    const rawCombined = rawBase.context + first;
    const correction =
      displayWidth(combined) -
      displayWidth(base.context) -
      displayWidth(rawCombined) +
      displayWidth(rawBase.context);
    this.previewWidth +=
      combined.length + base.context.length + rawCombined.length + rawBase.context.length;
    const cells = base.cells + rawEnd.cells - rawBase.cells + correction;
    let context = rawEnd.context;
    if (boundary === end) {
      this.previewWidth += combined.length;
      for (const cluster of graphemes.segment(combined)) context = cluster.segment;
    }
    return { cells, context };
  }

  private reconcileCode(match: Match): void {
    if (match.start < this.offset) {
      let first = true;
      for (const [position, tab] of this.tabs) {
        this.interpretation++;
        if (position < match.end || position >= Math.min(match.close, this.offset)) continue;
        if (first) {
          const state = this.codeColumn(match, position, tab.before, tab.reset);
          if (state) tab.semantic = 8 - (state.cells % 8);
          first = false;
        } else tab.semantic = tab.raw;
      }
      if (!first || (this.lastRawReset >= match.end && this.lastRawReset < match.close))
        this.semanticColumn.reset();
    }
    this.pending.delete(match.start);
    this.bases.delete(match.start);
    this.rawBases.delete(match.end);
    this.bodyStarts.delete(match.end);
  }

  private inCode(position: number): boolean {
    while ((this.code[this.codeHead]?.end ?? Infinity) <= position) {
      this.interpretation++;
      this.codeHead++;
    }
    const interval = this.code[this.codeHead];
    return interval !== undefined && position >= interval.start && position < interval.end;
  }

  link(link: LinkMatch): boolean {
    if (this.raw.has(link.start)) return false;
    let duplicate = false;
    if (link.autolink) {
      this.replace(link.start, link.start + 1);
      this.replace(link.finish - 1, link.finish);
    } else {
      const labelStart = link.start + (link.image ? 2 : 1);
      const label = this.source.slice(labelStart, link.labelEnd).join('');
      this.interpretation += label.length;
      const rendered = parseInline(label.replace(/[\t\n]+/g, ' '))
        .map((span) => span.text)
        .join('');
      for (let at = labelStart; at < link.labelEnd; at++) {
        this.interpretation++;
        if (this.source[at] === '\t')
          this.linkEdits.set(at, this.source[at - 1] === '\t' ? '' : ' ');
      }
      if (link.image) {
        this.replace(link.start, labelStart, '[image: ');
        this.edits.set(link.labelEnd, '] ');
        for (let at = labelStart; at < link.labelEnd; at++) {
          this.interpretation++;
          this.linkRaw.add(at);
          if (this.source[at] === '\t')
            this.linkEdits.set(at, this.source[at - 1] === '\t' ? '' : ' ');
        }
      } else {
        this.replace(link.start, labelStart);
        this.edits.set(link.labelEnd, ' ');
        if (rendered === link.target) {
          duplicate = true;
          for (let at = link.labelEnd; at < link.finish; at++) {
            this.interpretation++;
            this.linkEdits.set(at, '');
          }
        }
      }
    }
    for (let at = link.targetStart; at < link.finish - 1; at++) {
      this.interpretation++;
      this.linkRaw.add(at);
    }
    this.reconcile(link.start);
    return duplicate;
  }

  measurePrefix(text: string, end: number): number {
    if (!text.slice(end).includes('\t')) return 0;
    const column = new LogicalColumn();
    column.append(text.slice(0, end));
    this.interpretation += end;
    this.previewWidth += column.work;
    return column.cells;
  }

  private value(position: number): string {
    const structural = this.structure.get(position);
    if (structural !== undefined) return structural;
    const source = this.source[position] ?? '';
    if (this.raw.has(position) || this.inCode(position)) return source;
    const linkEdit = this.linkEdits.get(position);
    if (linkEdit !== undefined) return linkEdit;
    if (this.linkRaw.has(position)) return source;
    const hardBreak = this.breaks.get(position);
    if (hardBreak !== undefined) return hardBreak;
    const edit = this.edits.get(position);
    if (edit !== undefined) return edit;
    return source === '\n' ? ' ' : source;
  }

  private semanticUnit(position: number): void {
    this.visits++;
    const reset = this.resets.get(position);
    if (reset !== undefined) this.semanticColumn.reset(reset);
    const value = this.value(position);
    const tab = this.tabs.get(position);
    if (tab) tab.semantic = value === '\t' ? 8 - (this.semanticColumn.cells % 8) : undefined;
    this.semanticColumn.append(value);
    if (value === '\n') {
      const block = this.blockAt(position)?.block;
      const prefix = block?.continuation ?? block?.prefix ?? '';
      this.semanticColumn.reset(displayWidth(prefix) + (block?.kind === 'code' ? 2 : 0));
    }
  }

  private reconcile(start: number): void {
    const base = this.bases.get(start);
    if (start < this.offset && base) {
      this.semanticColumn.restore(base);
      while (this.codeHead > 0 && (this.code[this.codeHead - 1]?.end ?? -1) > start) {
        this.interpretation++;
        this.codeHead--;
      }
      for (let at = start; at < this.offset; at++) this.semanticUnit(at);
    }
    this.pending.delete(start);
    this.bases.delete(start);
  }

  line(
    start: number,
    source: string,
    block: MarkdownBlock,
    body: string | undefined,
    complete: boolean,
    extent = source.length,
  ): void {
    if (start !== this.lastLineStart) {
      this.lastLineStart = start;
      this.annotatedThrough = start;
      this.lines.push({ start, block });
      if (block.kind !== 'paragraph' || this.previousKind !== 'paragraph')
        this.resets.set(start, displayWidth(block.prefix ?? '') + (block.kind === 'code' ? 2 : 0));
      this.previousKind = block.kind;
    } else {
      const last = this.lines[this.lines.length - 1];
      if (last) this.lines[this.lines.length - 1] = { start, block };
    }
    const raw = body !== undefined || block.kind === 'literal' || block.kind === 'code';
    if (raw) {
      for (
        let at = Math.max(start, this.annotatedThrough);
        at < start + extent + (complete ? 1 : 0);
        at++
      ) {
        this.interpretation++;
        this.raw.add(at);
        if (block.kind === 'code' && body === undefined && this.source[at] === '\t')
          this.structure.set(at, this.source[at - 1] === '\t' ? '' : ' ');
      }
    }
    if (body !== undefined) {
      let shared = 0;
      while (
        shared < body.length &&
        shared < source.length &&
        body[body.length - shared - 1] === source[source.length - shared - 1]
      ) {
        this.interpretation++;
        shared++;
      }
      const consumed = source.length - shared;
      const replacement = body.slice(0, body.length - shared);
      if (consumed) {
        this.structure.set(start, replacement);
        for (let at = start + 1; at < start + consumed; at++) {
          this.interpretation++;
          this.structure.set(at, '');
        }
      }
    } else if (block.kind !== 'literal' && block.kind !== 'code') {
      const prefix = Math.max(0, block.source.length - block.text.length);
      for (let at = start; at < start + prefix; at++) {
        this.interpretation++;
        this.structure.set(at, '');
      }
    }
    if (complete) {
      const newline = start + source.length;
      if (raw || block.kind !== 'paragraph') this.structure.set(newline, '\n');
      else if (source.endsWith('  ') || source.endsWith('\\')) {
        const count = source.endsWith('  ') ? 2 : 1;
        for (let at = newline - count; at < newline; at++) this.breaks.set(at, '');
        this.breaks.set(newline, '\n');
      }
    }
    this.annotatedThrough = start + extent + (complete ? 1 : 0);
  }

  private advance(cut: number): void {
    while (this.offset < cut) {
      if (this.pending.has(this.offset)) this.bases.set(this.offset, this.semanticColumn.state());
      if (this.bodyStarts.has(this.offset)) this.rawBases.set(this.offset, this.rawColumn.state());
      const source = this.source[this.offset] ?? '';
      if (source === '\t') {
        const before = this.rawColumn.state();
        this.tabs.set(this.offset, {
          raw: 8 - (before.cells % 8),
          semantic: undefined,
          before,
          reset: this.lastRawReset,
        });
      }
      this.rawColumn.append(source);
      if (source === '\n' || source === '\t') this.lastRawReset = this.offset;
      this.semanticUnit(this.offset);
      this.offset++;
    }
  }

  private provisionalTabs(match: Match): ReadonlyMap<number, number> {
    const key = `${match.start}:${match.finish}`;
    const cached = this.previewTabs;
    if (cached?.key === key) return cached.tabs;
    const result = new Map<number, number>();
    if (match.marker === '`') {
      let first = true;
      for (const [position, tab] of this.tabs) {
        this.interpretation++;
        if (position < match.end || position >= match.close) continue;
        const state = first ? this.codeColumn(match, position, tab.before, tab.reset) : undefined;
        result.set(position, first && state ? 8 - (state.cells % 8) : tab.raw);
        first = false;
      }
    } else {
      const base = this.bases.get(match.start);
      if (base) {
        const column = new LogicalColumn();
        column.restore(base);
        for (let at = match.end; at < Math.min(this.offset, match.close); at++) {
          this.interpretation++;
          const value = this.value(at);
          if (value === '\t') result.set(at, 8 - (column.cells % 8));
          column.append(value);
        }
        this.previewWidth += column.work;
      }
    }
    this.previewTabs = { key, tabs: result };
    return result;
  }

  tabSpaces(start: number, end: number, plain: boolean, preview?: Match): readonly number[] {
    this.liveCut = Math.max(this.liveCut, start);
    let last = -1;
    for (let position = start; position < end; position++) {
      if (this.source[position] === '\t') last = position;
    }
    if (last >= 0) this.advance(last + 1);
    while (true) {
      const first = this.tabs.keys().next();
      if (first.done || first.value >= start) break;
      this.tabs.delete(first.value);
    }
    const provisional = !plain && preview ? this.provisionalTabs(preview) : undefined;
    const result: number[] = [];
    for (let position = start; position < end; position++) {
      if (this.source[position] !== '\t') continue;
      const tab = this.tabs.get(position);
      const spaces = plain ? tab?.raw : (provisional?.get(position) ?? tab?.semantic);
      if (spaces !== undefined) result.push(spaces);
    }
    return result;
  }

  blockAt(position: number): SourceLine | undefined {
    let low = 0;
    let high = this.lines.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if ((this.lines[middle]?.start ?? Infinity) <= position) low = middle + 1;
      else high = middle;
    }
    return this.lines[low - 1];
  }

  get work(): Readonly<{ units: number; interpretation: number; width: number; context: number }> {
    return {
      units: this.visits,
      context: this.contextWork,
      interpretation: this.interpretation,
      width: this.rawColumn.work + this.semanticColumn.work + this.previewWidth,
    };
  }
}

/**
 * An append-only delimiter checkpoint. Positions refer to sanitized source, not
 * to a newly clipped string. A closer can therefore style visible text even
 * when its opener has already left the live source window. Only bounded-depth
 * unresolved delimiters and matches touching that window survive pruning.
 *
 * The source itself lives in fragment arrays; this lexer never joins an open
 * paragraph or unfinished line. Bounded preview parsing is drawing work.
 */
class InlineCheckpoint {
  private readonly columns: ColumnCheckpoint;

  constructor(columns: ColumnCheckpoint) {
    this.columns = columns;
  }
  private pending = new Map<string, Delimiter>();
  private ticks = new Map<number, Delimiter>();
  private tickStack: Delimiter[] = [];
  private matchHead = 0;
  private linkHead = 0;
  private matches: Match[] = [];
  private links: LinkMatch[] = [];
  private link: LinkCandidate | undefined;
  private runCharacter = '';
  private runLength = 0;
  private runStart = 0;
  private previous = '';
  private beforeRun = '';
  private deferredHigh: { character: string; position: number } | undefined;
  private intraword: { start: number; end: number }[] = [];
  private intrawordHead = 0;
  private escaped = false;
  work = 0;

  reset(): void {
    this.columns.clearOpeners();
    this.pending.clear();
    this.ticks.clear();
    this.tickStack = [];
    this.matchHead = 0;
    this.linkHead = 0;
    this.matches = [];
    this.links = [];
    this.link = undefined;
    this.runCharacter = '';
    this.runLength = 0;
    this.previous = '';
    this.beforeRun = '';
    this.deferredHigh = undefined;
    this.intraword = [];
    this.intrawordHead = 0;
    this.escaped = false;
  }

  append(source: string, offset: number): void {
    this.work += source.length;
    let at = 0;
    const held = this.deferredHigh;
    if (held) {
      this.deferredHigh = undefined;
      const next = source.charCodeAt(0);
      if (next >= 0xdc00 && next <= 0xdfff) {
        this.point(held.character + (source[0] ?? ''), held.position);
        at = 1;
      } else this.point(held.character, held.position);
    }
    while (at < source.length) {
      const character = source[at] ?? '';
      const code = character.charCodeAt(0);
      const high = code >= 0xd800 && code <= 0xdbff;
      if (high && at + 1 === source.length) {
        this.deferredHigh = { character, position: offset + at };
        break;
      }
      const next = source.charCodeAt(at + 1);
      const paired = high && next >= 0xdc00 && next <= 0xdfff;
      this.point(character + (paired ? (source[at + 1] ?? '') : ''), offset + at);
      at += paired ? 2 : 1;
    }
    const cutoff = offset + source.length - LIVE_SOURCE_LIMIT;
    while ((this.intraword[this.intrawordHead]?.end ?? Infinity) <= cutoff) {
      this.work++;
      this.intrawordHead++;
    }
    if (this.intrawordHead > 1_024 && this.intrawordHead * 2 > this.intraword.length) {
      this.intraword = this.intraword.slice(this.intrawordHead);
      this.intrawordHead = 0;
    }
    while ((this.matches[this.matchHead]?.finish ?? Infinity) <= cutoff) {
      this.work++;
      this.matchHead++;
    }
    while ((this.links[this.linkHead]?.finish ?? Infinity) <= cutoff) {
      this.work++;
      this.linkHead++;
    }
    if (this.matchHead > 1_024 && this.matchHead * 2 > this.matches.length) {
      this.matches = this.matches.slice(this.matchHead);
      this.matchHead = 0;
    }
    if (this.linkHead > 1_024 && this.linkHead * 2 > this.links.length) {
      this.links = this.links.slice(this.linkHead);
      this.linkHead = 0;
    }
  }

  private point(character: string, position: number): void {
    if (this.escaped && /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/.test(character))
      this.columns.escape(position - 1);
    this.linkCharacter(character, position);
    if (this.runLength && character !== this.runCharacter) this.flushRun(character);
    if (
      !this.escaped &&
      (character === '`' || character === '*' || character === '_' || character === '~')
    ) {
      if (!this.runLength) {
        this.runStart = position;
        this.beforeRun = this.previous;
      }
      // A run is represented by a count, rather than repeatedly copying it.
      this.runCharacter = character;
      this.runLength++;
    } else if (character === '\\' && !this.escaped) {
      this.escaped = true;
    } else {
      this.escaped = false;
    }
    this.previous = character;
  }

  private linkCharacter(character: string, position: number): void {
    if (!this.escaped && character === '<') {
      this.columns.open(position);
      this.link = {
        start: position,
        image: false,
        state: 'auto',
        labelEnd: position,
        targetStart: position + 1,
        target: [],
        valid: true,
      };
      return;
    }
    if (!this.escaped && character === '[' && this.link?.state !== 'target') {
      this.columns.open(this.previous === '!' ? position - 1 : position);
      this.link = {
        start: this.previous === '!' ? position - 1 : position,
        image: this.previous === '!',
        state: 'label',
        labelEnd: 0,
        targetStart: 0,
        target: [],
        valid: true,
      };
      return;
    }
    const link = this.link;
    if (!link) return;
    if (character === '\n') {
      this.link = undefined;
    } else if (link.state === 'label' && character === ']' && !this.escaped) {
      link.labelEnd = position;
      link.state = 'bracket';
    } else if (link.state === 'bracket') {
      if (character !== '(') this.link = undefined;
      else {
        link.state = 'target';
        link.targetStart = position + 1;
      }
    } else if (link.state === 'target' || link.state === 'auto') {
      if (character === (link.state === 'auto' ? '>' : ')')) {
        const target = link.target.join('');
        const valid =
          link.state === 'auto'
            ? /^(?:https?:\/\/[^\s<>]+|[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+)$/.test(target)
            : link.valid;
        if (valid && target) {
          const match = {
            start: link.start,
            image: link.image,
            autolink: link.state === 'auto',
            duplicate: false,
            labelEnd: link.labelEnd,
            targetStart: link.targetStart,
            finish: position + 1,
            target,
          };
          const duplicate = this.columns.link(match);
          this.links.push({ ...match, duplicate });
        }
        this.link = undefined;
      } else {
        if (/\s/.test(character) || character === '(') link.valid = false;
        link.target.push(character);
      }
    }
  }

  private flushRun(next: string): void {
    const character = this.runCharacter;
    const length = this.runLength;
    const start = this.runStart;
    this.runCharacter = '';
    this.runLength = 0;
    if (character === '`') {
      const open = this.ticks.get(length);
      if (open) {
        const match = { ...open, close: start, finish: start + length };
        this.matches.push(match);
        this.columns.delimiter(match);
        if (this.link && this.link.start > open.start && this.link.start < start)
          this.link = undefined;
        while ((this.tickStack[this.tickStack.length - 1]?.start ?? -1) >= open.start) {
          this.work++;
          const candidate = this.tickStack.pop();
          if (candidate) this.ticks.delete(candidate.end - candidate.start);
        }
        for (const [marker, candidate] of this.pending) {
          this.work++;
          if (candidate.start > open.start) this.pending.delete(marker);
        }
      } else {
        this.columns.open(start, start + length);
        const candidate = { marker: '`', start, end: start + length };
        this.ticks.set(length, candidate);
        this.tickStack.push(candidate);
      }
      return;
    }
    if (character === '~' && length < 2) return;
    if (character === '_' && isWordCodePoint(this.beforeRun) && isWordCodePoint(next)) {
      this.intraword.push({ start, end: start + length });
      return;
    }
    let used = 0;
    while (used < length) {
      this.work++;
      const count = length - used >= 2 ? 2 : 1;
      if (character === '~' && count === 1) break;
      const marker = character.repeat(count);
      const at = start + used;
      const open = this.pending.get(marker);
      if (open && at > open.end) {
        const match = { ...open, close: at, finish: at + count };
        this.matches.push(match);
        this.columns.delimiter(match);
        for (const [key, candidate] of this.pending) {
          this.work++;
          if (candidate.start >= open.start) this.pending.delete(key);
        }
      } else if (!open && this.pending.size < 32) {
        this.columns.open(at);
        this.pending.set(marker, { marker, start: at, end: at + count });
      }
      used += count;
    }
  }

  deferredUnderscore(): boolean {
    return (
      this.deferredHigh !== undefined &&
      this.runCharacter === '_' &&
      isWordCodePoint(this.beforeRun)
    );
  }

  preview(): Match | undefined {
    if (this.deferredUnderscore()) return undefined;
    if (this.runCharacter === '`') {
      const open = this.ticks.get(this.runLength);
      return open
        ? { ...open, close: this.runStart, finish: this.runStart + this.runLength }
        : undefined;
    }
    if (this.runLength) {
      const marker = this.runCharacter.repeat(this.runLength > 1 ? 2 : 1);
      const open = this.pending.get(marker);
      if (open && this.runStart > open.end)
        return { ...open, close: this.runStart, finish: this.runStart + marker.length };
    }
    return undefined;
  }

  /** No source mutation: a trailing run is only classified when its next byte arrives. */
  project(source: string, offset: number): MarkdownSpan[] {
    const preview = this.preview();
    const trailing = preview ? [preview] : [];
    const literal = this.intraword
      .slice(this.intrawordHead)
      .find((run) => run.start <= offset && run.end > offset);
    const protect = (value: string, sourceOffset: number): string => {
      let output = value;
      if (literal && sourceOffset >= literal.start && sourceOffset < literal.end) {
        const count = Math.min(output.length, literal.end - sourceOffset);
        output = output.slice(0, count).replace(/_/g, '\\_') + output.slice(count);
      }
      if (this.deferredUnderscore()) {
        const start = Math.max(sourceOffset, this.runStart);
        const count = Math.max(
          0,
          Math.min(sourceOffset + value.length, this.runStart + this.runLength) - start,
        );
        const at = start - sourceOffset + (output.length - value.length);
        if (count)
          output =
            output.slice(0, at) +
            output.slice(at, at + count).replace(/_/g, '\\_') +
            output.slice(at + count);
      }
      return output;
    };
    const crossing = [...this.matches.slice(this.matchHead), ...trailing]
      .filter((match) => match.start < offset && match.finish > offset)
      .sort((left, right) => left.start - right.start);
    let start = offset;
    const code = crossing.find((match) => match.marker === '`' && match.close > offset);
    const link = this.links
      .slice(this.linkHead)
      .find((candidate) => candidate.start < offset && candidate.finish > offset);
    let prefix = '';
    let style: InlineStyle = {};
    for (const match of crossing) {
      if (match.marker === '`') {
        if (code && match.start > code.start) continue;
        if (start >= match.close) start = Math.max(start, match.finish);
        continue;
      }
      if ((code && match.start > code.start) || (link && match.start > link.start)) continue;
      if (start >= match.close) {
        start = Math.max(start, match.finish);
        continue;
      }
      prefix += match.marker;
      style =
        match.marker === '~~'
          ? { ...style, strike: true }
          : match.marker.length === 2
            ? { ...style, strong: true }
            : { ...style, emphasis: true };
    }
    if (link && (!code || link.start < code.start)) {
      if (start >= link.targetStart) {
        if (link.duplicate) return withPrefix(prefix, source.slice(link.finish - offset));
        const text = source.slice(start - offset, link.finish - offset - (link.autolink ? 1 : 0));
        return [
          { text, ...style, linkURL: link.target, ...(link.image ? { dim: true } : {}) },
          ...withPrefix(prefix, source.slice(link.finish - offset)),
        ];
      }
      if (start <= link.labelEnd) {
        let labelStart = start;
        let labelPrefix = '';
        for (const match of crossing) {
          if (match.start <= link.start || (code && match.start > code.start)) continue;
          if (labelStart >= match.close) labelStart = Math.max(labelStart, match.finish);
          else
            labelPrefix +=
              match.marker === '`' ? '`'.repeat(match.end - match.start) : match.marker;
        }
        if (link.duplicate) {
          const label = parseInline(
            prefix +
              labelPrefix +
              '\0' +
              protect(source.slice(labelStart - offset, link.labelEnd - offset), labelStart),
          )
            .map((span) => ({ ...span, text: span.text.replace('\0', ''), linkURL: link.target }))
            .filter((span) => span.text.length > 0);
          return [...label, ...withPrefix(prefix, source.slice(link.finish - offset))];
        }
        // Preserve both the link and delimiters inside its clipped label. The
        // complete target is already in this bounded suffix and stays visible.
        return parseInline(
          prefix +
            (link.image ? '![' : '[') +
            labelPrefix +
            '\0' +
            (link.image
              ? source.slice(labelStart - offset)
              : protect(source.slice(labelStart - offset), labelStart)),
        )
          .map((span) => ({ ...span, text: span.text.replace('\0', '') }))
          .filter((span) => span.text.length > 0);
      }
    }
    if (code) {
      const text = source.slice(start - offset, code.close - offset);
      return [
        { text, ...style, code: true },
        ...withPrefix(prefix, source.slice(code.finish - offset)),
      ];
    }
    return withPrefix(prefix, protect(source.slice(start - offset), start));
  }
}

/**
 * Incremental ingestion of already-sanitized chunks. append() consumes source
 * before tail() clips it. finish()/snapshot() are full-source projections, never
 * the per-frame API. A resize only invalidates the one bounded layout cache.
 */
export class MarkdownStream {
  private source: string[] = [];
  private sourceLength = 0;
  private sourceWindow = '';
  private clippedSource: string | undefined;
  private completed: string[] = [];
  private fragments: string[] = [];
  private linePrefix = '';
  private lineLength = 0;
  private pendingSize = 0;
  private pendingFence: Fence | undefined;
  private pendingTable = false;
  private pendingTableContainers: readonly Container[] = [];
  private pendingList = false;
  private stable: MarkdownBlock[] = [];
  private previews: Preview[] = [];
  private previewSize = 0;
  private layoutElided = false;
  private columns = new ColumnCheckpoint();
  private inline = new InlineCheckpoint(this.columns);
  private generation = 0;
  private cached:
    | { generation: number; columns: number; rows: number; lines: readonly MarkdownDisplayLine[] }
    | undefined;
  private blockWork = 0;
  private semanticWork = 0;
  private lineWork = 0;

  get elided(): boolean {
    return this.sourceLength > LIVE_SOURCE_LIMIT || this.layoutElided;
  }

  /** Sanitized source projection for the color-disabled live renderer. */
  sourceTail(): string {
    if (this.clippedSource === undefined) {
      let window = this.sourceWindow;
      let offset = this.sourceLength - window.length;
      const first = window.charCodeAt(0);
      if (offset > 0 && first >= 0xdc00 && first <= 0xdfff) {
        window = window.slice(1);
        offset++;
      }
      if (this.columns.secondRegionalIndicator(offset)) window = window.slice(2);
      this.clippedSource = sourceTail(window);
    }
    return this.clippedSource;
  }

  /** Causal accounting: bytes actually handed to lexing/parsing, not token count. */
  get work(): Readonly<{ lexical: number; lines: number; blocks: number; inline: number }> {
    return {
      lexical: this.inline.work,
      lines: this.lineWork,
      blocks: this.blockWork,
      inline: this.semanticWork,
    };
  }

  get columnWork(): Readonly<{
    units: number;
    interpretation: number;
    width: number;
    context: number;
  }> {
    return this.columns.work;
  }

  plainTail(columns: number, maxRows: number): readonly MarkdownDisplayLine[] {
    if (!Number.isFinite(columns) || columns < 1 || !Number.isFinite(maxRows) || maxRows < 1)
      return [];
    const source = this.sourceTail();
    const spaces = this.columns.tabSpaces(
      this.sourceLength - source.length,
      this.sourceLength,
      true,
    );
    let tab = 0;
    const expanded = source.replace(/\t/g, () => ' '.repeat(spaces[tab++] ?? 8));
    const lines = layoutMarkdown([literal(expanded)], columns);
    this.layoutElided = lines.length > maxRows;
    return lines.slice(-Math.floor(maxRows));
  }

  append(chunk: string): void {
    if (!chunk) return;
    const initialOffset = this.sourceLength;
    this.source.push(chunk);
    this.columns.append(chunk);
    this.sourceLength += chunk.length;
    this.sourceWindow = (this.sourceWindow + chunk.slice(-LIVE_SOURCE_LIMIT - TAIL_CONTEXT)).slice(
      -LIVE_SOURCE_LIMIT - TAIL_CONTEXT,
    );
    this.generation++;
    this.clippedSource = undefined;
    this.cached = undefined;
    let start = 0;
    for (let i = 0; i <= chunk.length; i++) {
      if (i !== chunk.length && chunk[i] !== '\n') continue;
      const part = chunk.slice(start, i);
      if (part) {
        this.fragments.push(part);
        this.lineLength += part.length;
        if (this.linePrefix.length < 256)
          this.linePrefix += part.slice(0, 256 - this.linePrefix.length);
        this.pendingSize += part.length;
        this.inline.append(part, initialOffset + start);
      }
      if (i < chunk.length) {
        this.inline.append('\n', initialOffset + i);
        this.pendingSize++;
        const line = this.fragments.join('');
        this.lineWork += line.length;
        this.fragments = [];
        this.linePrefix = '';
        this.lineLength = 0;
        const offset = initialOffset + i - line.length;
        this.columnLine(line, offset, true);
        this.completeLine(line, offset);
      }
      start = i + 1;
    }
    if (
      this.pendingFence?.containers?.length &&
      /\S/.test(this.linePrefix) &&
      fenceContent(this.linePrefix, this.pendingFence) === undefined
    ) {
      // A nonblank dedent has already left the container, even before this
      // line's newline arrives. Keep that new block outside the old fence.
      this.pendingSize -= this.lineLength;
      this.finalize();
      this.pendingSize = this.lineLength;
      this.inline.append(this.fragments.join(''), this.sourceLength - this.lineLength);
    }
    const tableLine = stripContainers(this.linePrefix, this.pendingTableContainers);
    if (this.pendingTable && tableLine !== undefined && /^ {0,3}#{1,6} +/.test(tableLine)) {
      this.pendingSize -= this.lineLength;
      this.finalize();
      this.pendingSize = this.lineLength;
      this.inline.append(this.fragments.join(''), this.sourceLength - this.lineLength);
    }
    if (this.lineLength)
      this.columnLine(this.linePrefix, this.sourceLength - this.lineLength, false);
  }

  private columnLine(source: string, offset: number, complete: boolean): void {
    const prefix = source.slice(0, 256);
    this.columns.describe(prefix.length);
    let body = this.pendingFence
      ? fenceContent(complete ? source : prefix, this.pendingFence)
      : undefined;
    if (body !== undefined && this.pendingFence) {
      let indent = 0;
      while (indent < this.pendingFence.indent && body[indent] === ' ') indent++;
      body = body.slice(indent);
    }
    const block =
      body !== undefined
        ? ({
            ...this.pendingFence?.block,
            kind: 'code',
            source: prefix,
            text: body,
          } satisfies MarkdownBlock)
        : this.pendingTable
          ? literal(prefix)
          : (parseMarkdown(prefix)[0] ?? literal(prefix));
    this.columns.line(
      offset,
      complete ? source : prefix,
      block,
      body,
      complete,
      complete ? source.length : this.lineLength,
    );
  }

  private parse(source: string): readonly MarkdownBlock[] {
    this.blockWork += source.length;
    return parseMarkdown(source);
  }

  private completeLine(line: string, offset: number): void {
    if (this.pendingFence) {
      const content = fenceContent(line, this.pendingFence);
      if (content !== undefined) {
        this.completed.push(line);
        if (closesFence(content, this.pendingFence.marker)) this.finalize();
        return;
      }
      this.pendingSize -= line.length + 1;
      this.finalize();
      this.pendingSize = line.length + 1;
      this.inline.append(line + '\n', offset);
    }
    if (this.pendingTable) {
      const content = stripContainers(line, this.pendingTableContainers);
      if (
        content === undefined ||
        !content.trim() ||
        startsBlock(content) ||
        !content.includes('|')
      ) {
        // The current line has not been attached to the table yet.
        this.pendingSize -= line.length + 1;
        this.finalize();
        this.pendingSize = line.length + 1;
        this.inline.append(line + '\n', offset);
      } else {
        this.completed.push(line);
        return;
      }
    }
    const previous = this.completed[this.completed.length - 1];
    if (
      previous !== undefined &&
      previous.length + line.length + 1 <= TABLE_SOURCE_LIMIT &&
      line.includes('|')
    ) {
      const candidate = this.parse(previous + '\n' + line);
      const delimiterLike =
        /^[ |:-]+$/.test(line) && line.includes('---') && previous.includes('|');
      if (candidate.length === 1 && (candidate[0]?.kind === 'table' || delimiterLike)) {
        this.completed.pop();
        const retainedSize = previous.length + line.length + 2;
        this.pendingSize -= retainedSize;
        this.finalize();
        this.completed = [previous, line];
        this.pendingSize = retainedSize;
        this.pendingTable = true;
        this.pendingTableContainers = tableContainers(previous);
        return;
      }
    }
    if (
      previous !== undefined &&
      previous.length + line.length + 1 > TABLE_SOURCE_LIMIT &&
      previous.includes('|') &&
      /^[ |:-]+$/.test(line) &&
      line.includes('---')
    ) {
      this.pendingTable = true;
      this.pendingTableContainers = tableContainers(previous);
      this.completed.push(line);
      return;
    }
    if (!line.trim()) {
      this.pendingSize -= line.length + 1;
      this.finalize();
      this.addStable(literal(line));
      return;
    }
    const opening = containerFence(line, (source) => this.parse(source));
    // Keep a list group together: its indentation stack is block-parser state.
    const list = /^( *)(?:[-+*]|\d+[.)]) {1,4}\S/.test(line);
    const sameList = this.pendingList && (list || /^[ \t]/.test(line));
    const quote = /^ {0,3}>/.test(line);
    const previousQuote = previous !== undefined && /^ {0,3}>/.test(previous);
    const setext =
      /^ {0,3}(?:-+|=+) *$/.test(line) && previous !== undefined && !startsBlock(previous);
    if (
      (opening || startsBlock(line)) &&
      !setext &&
      !sameList &&
      !(quote && previousQuote) &&
      this.completed.length
    ) {
      this.pendingSize -= line.length + 1;
      this.finalize();
      this.pendingSize = line.length + 1;
      this.inline.append(line + '\n', offset);
    }
    this.completed.push(line);
    if (list) this.pendingList = true;
    if (opening) this.pendingFence = opening;
  }

  private addStable(block: MarkdownBlock): void {
    this.stable.push(block);
    let preview = block;
    if (block.kind === 'table') {
      // Accepted tables are bounded at parse time and need their complete grid.
      preview = block;
    } else if (block.kind === 'literal' || block.kind === 'code' || block.kind === 'rule') {
      preview = {
        ...block,
        source: completeTail(block.source),
        text: completeTail(block.text),
        ...(block.info
          ? { info: completeTail(block.info, Math.max(0, LIVE_SOURCE_LIMIT - block.text.length)) }
          : {}),
        ...(block.prefix ? { prefix: completeTail(block.prefix) } : {}),
        ...(block.continuation ? { continuation: completeTail(block.continuation) } : {}),
        tabOffset: this.columns.measurePrefix(
          block.text,
          block.text.length - completeTail(block.text).length,
        ),
      };
    } else {
      this.semanticWork += block.text.length;
      const rendered = parseInline(block.text);
      const spans = clippedSpans(rendered, LIVE_SOURCE_LIMIT);
      const fullText = rendered.map((span) => span.text).join('');
      const clippedText = spans.map((span) => span.text).join('');
      preview = {
        ...block,
        source: completeTail(block.source),
        text: clippedText,
        spans,
        tabOffset: this.columns.measurePrefix(fullText, fullText.length - clippedText.length),
      };
    }
    const size = Math.min(LIVE_SOURCE_LIMIT, Math.max(1, block.source.length));
    this.previews.push({ block: preview, size });
    this.previewSize += size;
    while (
      this.previews.length > 1 &&
      this.previewSize - (this.previews[0]?.size ?? 0) >= LIVE_SOURCE_LIMIT
    ) {
      this.previewSize -= this.previews.shift()?.size ?? 0;
    }
  }

  private finalize(): void {
    if (this.completed.length) {
      const source = this.completed.join('\n');
      for (const block of this.parse(source)) this.addStable(block);
    }
    this.completed = [];
    this.pendingSize = 0;
    this.pendingFence = undefined;
    this.pendingTable = false;
    this.pendingTableContainers = [];
    this.pendingList = false;
    this.inline.reset();
  }

  tail(columns: number, maxRows: number): readonly MarkdownDisplayLine[] {
    if (!Number.isFinite(columns) || columns < 1 || !Number.isFinite(maxRows) || maxRows < 1)
      return [];
    const rows = Math.floor(maxRows);
    if (
      this.cached?.generation === this.generation &&
      this.cached.columns === columns &&
      this.cached.rows === rows
    )
      return this.cached.lines;
    const pending = this.pendingSize
      ? this.sourceTail().slice(-Math.min(this.pendingSize, LIVE_SOURCE_LIMIT))
      : '';
    const cutOffset = this.sourceLength - pending.length;
    const tabSpaces = this.columns.tabSpaces(
      cutOffset,
      this.sourceLength,
      this.pendingTable,
      this.inline.preview(),
    );
    const blocks: MarkdownBlock[] = [];
    const selected: Preview[] = [];
    let budget = LIVE_SOURCE_LIMIT - pending.length;
    for (let i = this.previews.length - 1; i >= 0 && budget > 0; i--) {
      const preview = this.previews[i];
      if (!preview) continue;
      selected.push(preview);
      budget -= preview.size;
    }
    selected.reverse();
    if (pending) {
      if (this.pendingTable) blocks.push(literal(pending));
      else if (this.pendingFence) {
        const cut = this.pendingSize > LIVE_SOURCE_LIMIT;
        const opening = this.pendingFence;
        const body = pending
          .split('\n')
          .map((line, index) => {
            if (
              index === 0 &&
              this.sourceWindow[this.sourceWindow.length - pending.length - 1] !== '\n'
            )
              return line;
            const content = fenceContent(line, opening) ?? line;
            let indentation = 0;
            while (indentation < opening.indent && content[indentation] === ' ') indentation++;
            return content.slice(indentation);
          })
          .join('\n');
        const parsed = cut
          ? [
              {
                ...opening.block,
                kind: 'code',
                source: pending,
                text: body,
                info: '',
              } satisfies MarkdownBlock,
            ]
          : parseMarkdown(pending);
        blocks.push(...parsed);
      } else {
        const original = this.columns.blockAt(cutOffset);
        const midLine = original !== undefined && original.start < cutOffset;
        const template = original?.block;
        const forceParagraph = midLine && template?.kind === 'paragraph';
        const sentinel = 'x';
        const parsed = [...parseMarkdown(forceParagraph ? sentinel + pending : pending)];
        if (forceParagraph && parsed[0]) {
          const first = parsed[0];
          parsed[0] = {
            ...first,
            source: first.source.slice(sentinel.length),
            text: first.text.slice(sentinel.length),
            ...(template?.prefix ? { prefix: template.prefix } : {}),
            ...(template?.quoted ? { quoted: true } : {}),
          };
        }
        if (this.pendingSize > LIVE_SOURCE_LIMIT) {
          let first = parsed[0];
          if (midLine && template && template.kind !== 'paragraph') {
            const newline = pending.indexOf('\n');
            const fragment = newline < 0 ? pending : pending.slice(0, newline);
            first =
              template.kind === 'code' && !this.pendingFence
                ? {
                    kind: 'paragraph',
                    source: fragment,
                    text: fragment.replace(/[\t\n]+/g, ' '),
                    spans: [{ text: fragment.replace(/[\t\n]+/g, ' '), dim: true }],
                    ...(template.prefix ? { prefix: template.prefix } : {}),
                  }
                : { ...template, source: fragment, text: fragment };
            const remainder = newline < 0 ? [] : parseMarkdown(pending.slice(newline + 1));
            parsed.splice(0, parsed.length, first, ...remainder);
          }
          if (
            first &&
            first.kind !== 'literal' &&
            first.kind !== 'table' &&
            first.kind !== 'code' &&
            first.kind !== 'rule'
          ) {
            const spans = first.spans ?? this.inline.project(first.text, cutOffset);
            parsed[0] = { ...first, spans };
          } else if (first) parsed[0] = first;
        }
        if (this.inline.deferredUnderscore() && this.pendingSize <= LIVE_SOURCE_LIMIT) {
          const first = parsed[0];
          if (
            first &&
            first.kind !== 'literal' &&
            first.kind !== 'code' &&
            first.kind !== 'table' &&
            first.kind !== 'rule'
          )
            parsed[0] = { ...first, spans: this.inline.project(first.text, cutOffset) };
        }
        blocks.push(
          ...parsed.map((block) => (block.kind === 'table' ? literal(block.source) : block)),
        );
      }
    }
    const rawTabSpaces = this.columns.tabSpaces(cutOffset, this.sourceLength, true);
    let rawTab = 0;
    const expandSource = (text: string): string =>
      text.replace(/\t/g, () => ' '.repeat(rawTabSpaces[rawTab++] ?? 8));
    let tab = 0;
    const expand = (text: string): string =>
      text.replace(/\t/g, () => ' '.repeat(tabSpaces[tab++] ?? 8));
    const expandedBlocks = blocks.map((original): MarkdownBlock => {
      const block = {
        ...original,
        source: expandSource(original.source),
        ...(original.prefix ? { prefix: original.prefix.slice(-LIVE_SOURCE_LIMIT) } : {}),
        ...(original.continuation
          ? { continuation: original.continuation.slice(-LIVE_SOURCE_LIMIT) }
          : {}),
      };
      if (block.kind === 'literal' || block.kind === 'table') {
        const text = expand(block.prefix ? original.text : original.source);
        return { ...block, source: block.prefix ? block.source : text, text };
      }
      if (block.kind === 'code') return { ...block, text: expand(block.text) };
      const spans = (block.spans ?? parseInline(block.text)).map((span) => ({
        ...span,
        text: expand(span.text),
      }));
      return { ...block, spans };
    });
    const stableLines = selected.flatMap((preview) => {
      if (preview.layout?.columns !== columns)
        preview.layout = { columns, lines: layoutMarkdown([preview.block], columns) };
      return preview.layout.lines;
    });
    const laidOut = [...stableLines, ...layoutMarkdown(expandedBlocks, columns)];
    this.layoutElided = laidOut.length > rows;
    const lines = laidOut.slice(-rows);
    this.cached = { generation: this.generation, columns, rows, lines };
    return lines;
  }

  /** Full projection for compatibility/debugging; use tail() while streaming. */
  snapshot(): readonly MarkdownBlock[] {
    const blocks = [...parseMarkdown(this.source.join(''))];
    const last = blocks[blocks.length - 1];
    if (last?.kind === 'table' && this.pendingSize > 0)
      blocks[blocks.length - 1] = literal(last.source);
    return blocks;
  }

  finish(): readonly MarkdownBlock[] {
    const result = parseMarkdown(this.source.join(''));
    this.reset();
    return result;
  }

  reset(): void {
    this.source = [];
    this.sourceLength = 0;
    this.sourceWindow = '';
    this.clippedSource = undefined;
    this.completed = [];
    this.fragments = [];
    this.linePrefix = '';
    this.lineLength = 0;
    this.pendingSize = 0;
    this.pendingFence = undefined;
    this.pendingTable = false;
    this.pendingTableContainers = [];
    this.pendingList = false;
    this.stable = [];
    this.previews = [];
    this.previewSize = 0;
    this.layoutElided = false;
    this.columns = new ColumnCheckpoint();
    this.inline = new InlineCheckpoint(this.columns);
    this.cached = undefined;
    this.generation++;
    this.blockWork = 0;
    this.semanticWork = 0;
    this.lineWork = 0;
  }
}
