import { displayWidth } from '../tui/viewport.js';
import { parseInline } from './inline.js';
import { StaticInlineIndex } from './inline-index.js';
import type { InlineSourceIndex } from './inline-index.js';
import { interpretInlineItem } from './inline-item.js';
import type { InlineItem, InlineItemStyle } from './inline-item.js';
import { InlineTextFactory } from './inline-text.js';
import type { InlineTextNode, InlineTextWork } from './inline-text.js';
import { isAutolinkTarget } from './opaque-targets.js';
import { PositionIndex } from './position-index.js';
import { layoutMarkdown } from './layout.js';
import { BlockLineClassifier, isBlockStart, isSetextPair, parseMarkdown } from './parser.js';
import type { BlockLineResult } from './parser.js';
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
interface RegionalSummary {
  readonly all: boolean;
  readonly trailing: number;
}

/** Raw source tabs and structural block metadata; inline geometry belongs to InlineTextFactory. */
class ColumnCheckpoint {
  private source: string[] = [];
  private sourcePointStart = 0;
  private lastRegional: { start: number; end: number } | undefined;
  private positionWork = { visits: 0 };
  private regional = new PositionIndex<{ start: number; end: number }>(this.positionWork);
  private lines = new PositionIndex<SourceLine>(this.positionWork);
  private annotations = new Map<
    number,
    {
      consumed: number;
      replacement: string;
      width: number;
      extent: number;
      source: string | undefined;
      body: string | undefined;
      block: MarkdownBlock;
    }
  >();
  private structure = new Map<number, string>();
  private rawColumn = new LogicalColumn();
  private blockColumn = new LogicalColumn();
  private offset = 0;
  private blockLine: SourceLine | undefined;
  private nextLine = Infinity;
  private tabs = new Map<number, { raw: number; code: number | undefined }>();
  private measured = 0;
  private visits = 0;
  private interpretation = 0;
  private contextWork = 0;
  private geometryFactory: InlineTextFactory | undefined;
  private sourceGeometry = new PositionIndex<InlineTextNode>(this.positionWork);
  private emptyGeometry = new PositionIndex<InlineTextNode>();
  private readGeometry: ((version: PositionIndex<InlineTextNode>) => InlineTextNode) | undefined;
  private geometryAccounting: InlineTextWork | undefined;
  private geometryLookups = 0;

  describe(units: number): void {
    this.contextWork += units;
  }

  attachGeometry(factory: InlineTextFactory, accounting: InlineTextWork): void {
    this.geometryFactory = factory;
    this.geometryAccounting = accounting;
    this.sourceGeometry = new PositionIndex(accounting);
    this.readGeometry = this.sourceGeometry.createFold(
      (node) => node,
      (left, right) => factory.concat([left, right]),
      factory.concat([]),
    );
  }

  rawGeometry(start: number, end: number, flatten = false): InlineTextNode {
    const factory = this.geometryFactory;
    const read = this.readGeometry;
    if (!factory || !read) throw new Error('Missing inline source geometry');
    if (flatten) return factory.raw(start, end, true);
    const before = this.positionWork.visits;
    const line = this.lines.floor(start);
    const lookup = this.positionWork.visits - before;
    this.geometryLookups += lookup;
    if (this.geometryAccounting) this.geometryAccounting.visits += lookup + 1;
    const first = line?.start ?? start;
    const annotation = this.annotations.get(first);
    if (annotation && end <= annotation.extent) {
      const body = first + annotation.consumed;
      if (start >= body) return factory.raw(start, end);
      const parts: InlineTextNode[] = [];
      if (annotation.replacement && body - 1 >= start && body - 1 < end)
        parts.push(factory.text(annotation.replacement, body - 1, body));
      if (end > body) parts.push(factory.raw(body, end));
      return factory.concat(parts);
    }
    const version = this.sourceGeometry.snapshot();
    version.replaceRange(0, first, this.emptyGeometry);
    version.replaceRange(end, 2 ** 53, this.emptyGeometry);
    const crop = (node: InlineTextNode): InlineTextNode => {
      if (this.geometryAccounting) this.geometryAccounting.visits++;
      if (node.end <= start || node.start >= end) return factory.concat([]);
      if (node.start >= start && node.end <= end) return node;
      if (node.kind === 'concat') return factory.concat(node.parts.map(crop));
      if (node.kind === 'raw')
        return factory.raw(Math.max(start, node.start), Math.min(end, node.end), node.flatten);
      if (node.end - node.start === node.value.length) {
        const from = Math.max(start, node.start);
        const to = Math.min(end, node.end);
        return factory.text(node.value.slice(from - node.start, to - node.start), from, to);
      }
      return node.start >= start ? node : factory.concat([]);
    };
    return crop(read(version));
  }

  renderSource(start: number, end: number): string {
    const parts: string[] = [];
    for (let position = start; position < end; position++) {
      parts.push(this.structure.get(position) === '' ? '\0' : (this.source[position] ?? ''));
    }
    return parts.join('');
  }

  originalSource(start: number, end: number): string {
    return this.source.slice(start, end).join('');
  }

  bodyStart(start: number, end: number): number {
    let position = start;
    while (position < end && this.structure.get(position) === '') position++;
    return position;
  }

  append(source: string): void {
    this.interpretation += source.length;
    for (let at = 0; at < source.length; at++) this.source.push(source[at] ?? '');
    while (this.sourcePointStart < this.source.length) {
      this.interpretation++;
      const start = this.sourcePointStart;
      const first = this.source[start] ?? '';
      const high = first.charCodeAt(0) >= 0xd800 && first.charCodeAt(0) <= 0xdbff;
      if (high && start + 1 === this.source.length) break;
      const next = this.source[start + 1] ?? '';
      const pair = high && next.charCodeAt(0) >= 0xdc00 && next.charCodeAt(0) <= 0xdfff;
      const end = start + (pair ? 2 : 1);
      if (/\p{Regional_Indicator}/u.test(first + (pair ? next : ''))) {
        if (this.lastRegional?.end === start) this.lastRegional.end = end;
        else {
          this.lastRegional = { start, end };
          this.regional.set(start, this.lastRegional);
        }
      }
      this.sourcePointStart = end;
    }
  }

  secondRegionalIndicator(position: number): boolean {
    const run = this.regional.floor(position);
    return run !== undefined && position < run.end && (position - run.start) % 4 === 2;
  }

  regionalSummary(start: number, end: number, accounting: InlineTextWork): RegionalSummary {
    if (end <= start) return { all: true, trailing: 0 };
    const before = this.positionWork.visits;
    const run = this.regional.floor(end - 1);
    const visits = this.positionWork.visits - before;
    this.geometryLookups += visits;
    accounting.visits += visits;
    if (!run || run.end < end) return { all: false, trailing: 0 };
    const units = end - Math.max(start, run.start);
    return { all: run.start <= start, trailing: Math.floor(units / 2) % 2 };
  }

  measurePrefix(text: string, end: number): number {
    if (!text.slice(end).includes('\t')) return 0;
    const column = new LogicalColumn();
    column.append(text.slice(0, end));
    const cells = column.cells;
    this.interpretation += end;
    this.measured += column.work;
    return cells;
  }

  line(
    start: number,
    source: string,
    block: MarkdownBlock,
    body: string | undefined,
    complete: boolean,
    extent = source.length,
  ): void {
    const previous = this.annotations.get(start);
    const width = displayWidth(block.prefix ?? '') + (block.kind === 'code' ? 2 : 0);
    let consumed = previous?.consumed ?? 0;
    let replacement = previous?.replacement ?? '';
    if (
      !previous ||
      previous.source !== source ||
      previous.body !== body ||
      previous.block.kind !== block.kind
    ) {
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
        consumed = source.length - shared;
        replacement = body.slice(0, body.length - shared);
      } else {
        replacement = '';
        consumed =
          (block.kind === 'literal' && !block.prefix) ||
          block.kind === 'code' ||
          block.kind === 'rule'
            ? 0
            : Math.max(0, block.source.length - block.text.length);
        if (block.kind === 'heading') {
          const marker = /#{1,6} +/.exec(source);
          if (marker) consumed = marker.index + marker[0].length;
        }
      }
    }
    const changed =
      consumed !== (previous?.consumed ?? 0) ||
      replacement !== (previous?.replacement ?? '') ||
      width !== previous?.width;
    if (changed) {
      for (let at = start; at < start + Math.max(consumed, previous?.consumed ?? 0); at++) {
        this.interpretation++;
        this.structure.delete(at);
      }
      if (consumed) {
        this.structure.set(start, replacement);
        for (let at = start + 1; at < start + consumed; at++) this.structure.set(at, '');
      }
    }
    const through = start + extent + (complete ? 1 : 0);
    if (block.kind === 'code' && body === undefined) {
      for (let at = Math.max(start, previous?.extent ?? start); at < through; at++) {
        this.interpretation++;
        if (this.source[at] === '\t')
          this.structure.set(at, this.source[at - 1] === '\t' ? '' : ' ');
      }
    }
    if (!previous || previous.block !== block) {
      const line = { start, block };
      this.lines.set(start, line);
      if (this.blockLine?.start === start) this.blockLine = line;
      else if (start > (this.blockLine?.start ?? -1) && start < this.nextLine)
        this.nextLine = start;
    }
    this.annotations.set(start, {
      consumed,
      replacement,
      width,
      extent: through,
      source: source.length <= 256 ? source : undefined,
      body: body !== undefined && body.length <= 256 ? body : undefined,
      block,
    });
    if (this.geometryFactory) {
      const parts: InlineTextNode[] = [];
      if (consumed && replacement)
        parts.push(this.geometryFactory.text(replacement, start + consumed - 1, start + consumed));
      parts.push(this.geometryFactory.raw(start + consumed, through));
      const node = this.geometryFactory.concat(parts);
      if (this.sourceGeometry.floor(start) !== node) this.sourceGeometry.set(start, node);
    }
    if (changed && start < this.offset) {
      this.blockColumn.reset(width);
      for (let at = start; at < this.offset; at++) this.blockUnit(at);
    }
  }

  private blockUnit(position: number): void {
    if (!this.blockLine || position < this.blockLine.start || position >= this.nextLine) {
      this.blockLine = this.lines.floor(position);
      this.nextLine =
        this.lines.ceiling((this.blockLine?.start ?? position) + 1)?.start ?? Infinity;
    }
    const line = this.blockLine;
    if (line?.start === position)
      this.blockColumn.reset(
        displayWidth(line.block.prefix ?? '') + (line.block.kind === 'code' ? 2 : 0),
      );
    const source = this.source[position] ?? '';
    const value = this.structure.get(position) ?? source;
    const tab = this.tabs.get(position);
    if (tab) tab.code = value === '\t' ? 8 - (this.blockColumn.cells % 8) : undefined;
    this.blockColumn.append(value);
    if (value === '\n')
      this.blockColumn.reset(
        displayWidth(line?.block.continuation ?? line?.block.prefix ?? '') +
          (line?.block.kind === 'code' ? 2 : 0),
      );
  }

  private advance(end: number): void {
    while (this.offset < end) {
      this.visits++;
      const source = this.source[this.offset] ?? '';
      if (source === '\t')
        this.tabs.set(this.offset, { raw: 8 - (this.rawColumn.cells % 8), code: undefined });
      this.rawColumn.append(source);
      this.blockUnit(this.offset);
      this.offset++;
    }
  }

  tabSpaces(start: number, end: number, plain: boolean): readonly number[] {
    let last = -1;
    for (let position = start; position < end; position++)
      if (this.source[position] === '\t') last = position;
    if (last >= 0) this.advance(last + 1);
    const retainedFrom = Math.max(0, this.source.length - LIVE_SOURCE_LIMIT - TAIL_CONTEXT);
    for (const position of this.tabs.keys()) {
      if (position >= retainedFrom) break;
      this.tabs.delete(position);
    }
    const spaces: number[] = [];
    for (let position = start; position < end; position++) {
      if (this.source[position] !== '\t') continue;
      const tab = this.tabs.get(position);
      const value = plain ? tab?.raw : tab?.code;
      if (value !== undefined) spaces.push(value);
    }
    return spaces;
  }

  blockAt(position: number): SourceLine | undefined {
    return this.lines.floor(position);
  }

  get work(): Readonly<{ units: number; interpretation: number; width: number; context: number }> {
    return {
      units: this.visits,
      interpretation: this.interpretation + this.positionWork.visits - this.geometryLookups,
      width: this.rawColumn.work + this.blockColumn.work + this.measured,
      context: this.contextWork,
    };
  }
}

interface InlineObserver {
  readonly dispose: (() => void)[];
  invalidate(): void;
}
interface InlineScope {
  readonly start: number;
  end: number;
  readonly missing: Map<string, Set<{ start: number; width: number; owner: InlineObserver }>>;
  readonly boundaries: Set<InlineObserver>;
}

class InlineRangeObservers {
  private ranges = new Map<string, Set<InlineObserver>>();
  visits = 0;

  add(owner: InlineObserver, start: number, end: number): void {
    for (let position = start; position < end; ) {
      const remaining = end - position;
      let size = 2 ** Math.floor(Math.log2(remaining));
      while (size > remaining || position % size !== 0) {
        size /= 2;
        this.visits++;
      }
      const level = Math.round(Math.log2(size));
      const key = `${level}:${position / size}`;
      this.visits++;
      let owners = this.ranges.get(key);
      if (!owners) {
        owners = new Set();
        this.ranges.set(key, owners);
      }
      if (!owners.has(owner)) {
        owners.add(owner);
        owner.dispose.push(() => {
          owners.delete(owner);
          if (!owners.size) this.ranges.delete(key);
        });
      }
      position += size;
    }
  }

  notify(position: number): void {
    if (position < 0) return;
    for (let level = 0; level < 53; level++) {
      this.visits++;
      const owners = this.ranges.get(`${level}:${Math.floor(position / 2 ** level)}`);
      if (owners)
        for (const owner of [...owners]) {
          this.visits++;
          owner.invalidate();
        }
    }
  }
}

interface IndexedRun {
  readonly start: number;
  end: number;
  readonly observers: Set<InlineObserver>;
}

/**
 * Append-only lexical facts for the shared canonical item interpreter. A query
 * subscribes to its actual answer (or the absent next token), rather than to a
 * source generation. Appending prose therefore leaves earlier decisions cached.
 */
class LiveInlineIndex implements InlineSourceIndex {
  private units: string[] = [];
  private lastContent = -1;
  private escapes: boolean[] = [];
  private words: boolean[] = [];
  private opaqueUnits: boolean[] = [];
  private tokens = new Map<string, number>();
  private positions = new Map<string, PositionIndex<number>>();
  private allPositions = new Map<string, PositionIndex<number>>();
  private opaqueRanges = new PositionIndex<{ start: number; end: number }>();
  private radixWork = { visits: 0 };
  private specialPositions = new PositionIndex<number>(this.radixWork);
  private tickPositions = new Map<number, PositionIndex<number>>();
  private runs: IndexedRun[] = [];
  private runAt = new Map<number, IndexedRun>();
  private nextObservers = new Map<
    string,
    Set<{ start: number; end: number; width: number; owner: InlineObserver }>
  >();
  private answers = new Map<number, Set<InlineObserver>>();
  private boundaries = new Map<number, Set<InlineObserver>>();
  private wordObservers = new Map<number, Set<InlineObserver>>();
  private singleObservers = new Map<number, Set<InlineObserver>>();
  private singleRanges = new InlineRangeObservers();
  private singles = new Map<string, PositionIndex<number>>();
  private rawSingles = new Map<string, PositionIndex<number>>();
  private owner: InlineObserver | undefined;
  private dynamic = false;
  private scopeStart = 0;
  private scopeEnd = Infinity;
  private scope: InlineScope | undefined;
  private underscore: { start: number; end: number } | undefined;
  private label: number | undefined;
  private parentheses: number[] = [];
  private parenEnds = new Map<number, number>();
  private parenOpens = new Map<number, number>();
  private parenTargets = new Map<number, number>();
  private references: { start: number; end: number }[] = [];
  private automatic: number | undefined;
  work = 0;
  slices = 0;

  get length(): number {
    return this.units.length;
  }

  hasContentAfter(position: number): boolean {
    return this.lastContent > position;
  }

  get deferredWord(): boolean {
    const run = this.underscore;
    return (
      run !== undefined &&
      run.end + 1 === this.length &&
      /[\uD800-\uDBFF]/u.test(this.units[run.end] ?? '')
    );
  }

  observe<T>(
    owner: InlineObserver,
    action: () => T,
    dynamic = false,
    start = 0,
    end = this.length,
    scope?: InlineScope,
  ): T {
    const previous = this.owner;
    const previousDynamic = this.dynamic;
    const previousStart = this.scopeStart;
    const previousEnd = this.scopeEnd;
    const previousScope = this.scope;
    this.owner = owner;
    this.dynamic = dynamic;
    this.scopeStart = start;
    this.scopeEnd = end;
    this.scope = scope;
    try {
      return action();
    } finally {
      this.owner = previous;
      this.dynamic = previousDynamic;
      this.scopeStart = previousStart;
      this.scopeEnd = previousEnd;
      this.scope = previousScope;
    }
  }

  private watch(table: Map<number, Set<InlineObserver>>, position: number): void {
    const owner = this.owner;
    if (!owner) return;
    let observers = table.get(position);
    if (!observers) {
      observers = new Set();
      table.set(position, observers);
    }
    if (observers.has(owner)) return;
    observers.add(owner);
    owner.dispose.push(() => {
      observers.delete(owner);
      if (!observers.size) table.delete(position);
    });
  }

  private wake(table: Map<number, Set<InlineObserver>>, position: number): void {
    const observers = table.get(position);
    if (!observers) return;
    for (const owner of [...observers]) {
      this.work++;
      owner.invalidate();
    }
  }

  private publish(token: string, position: number): void {
    const observers = this.nextObservers.get(token);
    if (!observers) return;
    for (const query of [...observers]) {
      this.work++;
      if (query.start <= position && position + query.width <= query.end) query.owner.invalidate();
    }
  }

  private addToken(token: string, position: number): void {
    if ((this.tokens.get(token) ?? -1) >= position) return;
    this.tokens.set(token, position);
    let all = this.allPositions.get(token);
    if (!all) {
      all = new PositionIndex(this.radixWork);
      this.allPositions.set(token, all);
    }
    all.set(position, position);
    let indexed = this.positions.get(token);
    if (!indexed) {
      indexed = new PositionIndex(this.radixWork);
      this.positions.set(token, indexed);
    }
    const delimiter = token[0] === '*' || token[0] === '_' || token[0] === '~';
    if (
      (!delimiter || !this.opaqueUnits[position]) &&
      (!token.includes('_') || !this.words[position])
    )
      indexed.set(position, position);
    this.publish(token, position);
  }

  private tick(run: IndexedRun): void {
    let indexed = this.tickPositions.get(run.end - run.start);
    if (!indexed) {
      indexed = new PositionIndex(this.radixWork);
      this.tickPositions.set(run.end - run.start, indexed);
    }
    indexed.set(run.start, run.start);
    this.publish(`tick:${run.end - run.start}`, run.start);
  }

  private markOpaque(start: number, end: number): void {
    let covered = this.opaqueRanges.ceiling(start);
    while (covered && covered.start < end) {
      this.opaqueRanges.delete(covered.start);
      covered = this.opaqueRanges.ceiling(start);
    }
    this.opaqueRanges.set(start, { start, end });
    for (let at = start; at < end; at++) {
      this.work++;
      if (this.opaqueUnits[at]) continue;
      this.opaqueUnits[at] = true;
      this.updateDelimiter(at);
      this.updateSingle(at);
      this.wake(this.answers, at);
      this.wake(this.singleObservers, at);
    }
  }

  private updateDelimiter(position: number): void {
    const character = this.units[position];
    const tokens =
      character === '*'
        ? ['*', '**', '***']
        : character === '_'
          ? ['_', '__', '___']
          : character === '~'
            ? ['~~']
            : [];
    for (const token of tokens) {
      this.work++;
      if (this.allPositions.get(token)?.floor(position) !== position) continue;
      const indexed = this.positions.get(token);
      if (this.opaqueUnits[position] || (token.includes('_') && this.words[position]))
        indexed?.delete(position);
      else {
        const present = indexed?.floor(position) === position;
        indexed?.set(position, position);
        if (!present) this.publish(token, position);
      }
    }
  }

  private updateSingle(position: number): void {
    const marker = this.units[position];
    if (marker !== '*' && marker !== '_') return;
    let raw = this.rawSingles.get(marker);
    let semantic = this.singles.get(marker);
    if (!raw) {
      raw = new PositionIndex(this.radixWork);
      this.rawSingles.set(marker, raw);
    }
    if (!semantic) {
      semantic = new PositionIndex(this.radixWork);
      this.singles.set(marker, semantic);
    }
    const eligible =
      this.units[position - 1] !== marker &&
      this.units[position + 1] !== marker &&
      !this.escapes[position] &&
      !this.words[position];
    const before = semantic.floor(position) === position;
    if (eligible) raw.set(position, position);
    else raw.delete(position);
    if (eligible && !this.opaqueUnits[position]) semantic.set(position, position);
    else semantic.delete(position);
    if (before !== (eligible && !this.opaqueUnits[position])) this.singleRanges.notify(position);
  }

  private wordBefore(position: number): boolean {
    const last = this.units[position - 1] ?? '';
    const low = last.charCodeAt(0) >= 0xdc00 && last.charCodeAt(0) <= 0xdfff;
    return isWordCodePoint((low ? (this.units[position - 2] ?? '') : '') + last);
  }

  private classifyUnderscore(): void {
    const run = this.underscore;
    if (!run || run.end >= this.length) return;
    const first = this.units[run.end] ?? '';
    const high = first.charCodeAt(0) >= 0xd800 && first.charCodeAt(0) <= 0xdbff;
    if (high && run.end + 1 === this.length) {
      if (this.wordBefore(run.start)) {
        for (let at = run.start; at < run.end; at++) {
          this.work++;
          this.words[at] = true;
          this.updateDelimiter(at);
          this.updateSingle(at);
          this.wake(this.wordObservers, at);
          this.wake(this.answers, at);
          this.wake(this.singleObservers, at);
        }
      }
      return;
    }
    const next = this.units[run.end + 1] ?? '';
    const low = next.charCodeAt(0) >= 0xdc00 && next.charCodeAt(0) <= 0xdfff;
    const word = this.wordBefore(run.start) && isWordCodePoint(first + (high && low ? next : ''));
    for (let at = run.start; at < run.end; at++) {
      this.work++;
      if ((this.words[at] ?? false) !== word) {
        this.words[at] = word;
        this.updateDelimiter(at);
        this.updateSingle(at);
        this.wake(this.wordObservers, at);
        this.wake(this.answers, at);
        this.wake(this.singleObservers, at);
      }
    }
    this.underscore = undefined;
  }

  append(source: string): void {
    const from = this.length;
    for (let at = 0; at < source.length; at++) {
      const position = this.length;
      const character = source[at] ?? '';
      this.work++;
      const escaped = this.units[position - 1] === '\\' && !this.escapes[position - 1];
      this.units.push(character);
      if (/\S/.test(character)) this.lastContent = position;
      if (/[\\\n`[!<*_~]/.test(character)) {
        this.specialPositions.set(position, position);
      }
      this.escapes.push(escaped);
      this.wake(this.boundaries, position);
      this.wake(this.singleObservers, position - 1);
      this.updateSingle(position - 1);
      this.updateSingle(position);
      if (character === '_' && !escaped) {
        if (this.underscore?.end === position) this.underscore.end++;
        else {
          this.classifyUnderscore();
          this.underscore = { start: position, end: position + 1 };
        }
      } else this.classifyUnderscore();
      const previous = this.runs[this.runs.length - 1];
      if (character === '`' && previous && previous.end === position && !escaped) {
        if (character === '`') {
          this.wake(this.answers, previous.start);
          const length = previous.end - previous.start;
          const indexed = this.tickPositions.get(length);
          indexed?.delete(previous.start);
          if (indexed?.size === 0) this.tickPositions.delete(length);
        }
        previous.end++;
        for (const owner of [...previous.observers]) {
          this.work++;
          owner.invalidate();
        }
        if (character === '`') this.tick(previous);
      } else if (character === '`' && !escaped) {
        const run = { start: position, end: position + 1, observers: new Set<InlineObserver>() };
        this.runs.push(run);
        this.runAt.set(position, run);
        if (character === '`' && !escaped) this.tick(run);
      }
      if (escaped) continue;
      if (character === '(') this.parentheses.push(position);
      if (character === '\n') this.label = undefined;
      if (character === '[') {
        if (
          this.label !== undefined &&
          this.units[position - 1] === ']' &&
          !this.escapes[position - 1]
        )
          this.references.push({ start: this.label, end: position });
        this.label = position;
      }
      if (
        character === '(' &&
        this.units[position - 1] === ']' &&
        !this.escapes[position - 1] &&
        this.label !== undefined
      ) {
        this.parenTargets.set(position, this.label);
        this.label = undefined;
      }
      if (character === ')') {
        const open = this.parentheses.pop();
        if (open !== undefined) {
          this.parenEnds.set(open, position);
          this.parenOpens.set(position, open);
          this.publish(`paren:${open}`, position);
          const label = this.parenTargets.get(open);
          if (label !== undefined) {
            this.markOpaque(label, position + 1);
            this.parenTargets.delete(open);
            if ((this.label ?? -1) > label) this.label = undefined;
          }
        }
      }
      if (character === ']') {
        const reference = this.references[0];
        if (reference && position > reference.end) {
          this.markOpaque(reference.start, position + 1);
          this.references = [];
          if ((this.label ?? -1) > reference.start) this.label = undefined;
        }
      }
      if (character === '<') this.automatic = position;
      if (character === '>' && this.automatic !== undefined) {
        const start = this.automatic + 1;
        if (isAutolinkTarget(this.slice(start, position))) this.markOpaque(start - 1, position + 1);
        this.automatic = undefined;
      }
    }
    const tokens = ['***', '___', '**', '__', '~~', '*', '_', '](', ')', '[', '][', ']', '>', '<'];
    for (let at = Math.max(0, from - 2); at < this.length; at++) {
      this.work++;
      if (this.escapes[at]) continue;
      for (const token of tokens) {
        if (
          token.length === 1
            ? this.units[at] === token
            : token.split('').every((ch, part) => this.units[at + part] === ch)
        )
          this.addToken(token, at);
      }
    }
  }

  charAt(index: number): string {
    this.work++;
    if (index >= this.length) this.watch(this.boundaries, index);
    return this.units[index] ?? '';
  }

  slice(start: number, end: number): string {
    const limit = Math.min(end, this.length);
    this.slices += Math.max(0, limit - start);
    return this.units.slice(start, limit).join('');
  }

  startsWith(token: string, index: number): boolean {
    for (let at = 0; at < token.length; at++)
      if (this.charAt(index + at) !== token[at]) return false;
    return true;
  }

  escaped(index: number): boolean {
    this.work++;
    return this.escapes[index] ?? false;
  }

  intraword(index: number): boolean {
    this.work++;
    if (this.underscore && index >= this.underscore.start && index < this.underscore.end)
      this.watch(this.wordObservers, index);
    return this.words[index] ?? false;
  }

  opaque(index: number): boolean {
    this.work++;
    this.watch(this.answers, index);
    const range = this.opaqueRanges.floor(index);
    return (
      range !== undefined &&
      index < range.end &&
      range.start >= this.scopeStart &&
      range.end <= this.scopeEnd
    );
  }

  private missing(token: string, start: number, end: number, width = token.length): void {
    const owner = this.owner;
    if (!owner) return;
    const scope = !this.dynamic ? this.scope : undefined;
    if (scope) {
      let queries = scope.missing.get(token);
      if (!queries) {
        queries = new Set();
        scope.missing.set(token, queries);
      }
      const query = { start, width, owner };
      queries.add(query);
      owner.dispose.push(() => {
        queries.delete(query);
        if (!queries.size) scope.missing.delete(token);
      });
      return;
    }
    let observers = this.nextObservers.get(token);
    if (!observers) {
      observers = new Set();
      this.nextObservers.set(token, observers);
    }
    const query = {
      start,
      end: this.dynamic && end === this.length ? Infinity : end,
      width,
      owner,
    };
    observers.add(query);
    owner.dispose.push(() => {
      observers.delete(query);
      if (!observers.size) this.nextObservers.delete(token);
    });
  }

  scopeBoundary(owner: InlineObserver, scope: InlineScope): void {
    if (scope.boundaries.has(owner)) return;
    scope.boundaries.add(owner);
    owner.dispose.push(() => scope.boundaries.delete(owner));
  }

  extendScope(scope: InlineScope, end: number): void {
    const previous = scope.end;
    scope.end = end;
    for (const owner of [...scope.boundaries]) owner.invalidate();
    const notify = (token: string, position: number): void => {
      const queries = scope.missing.get(token);
      if (queries)
        for (const query of [...queries]) {
          this.work++;
          if (query.start <= position && position + query.width <= end) query.owner.invalidate();
        }
    };
    const tokens = ['***', '___', '**', '__', '~~', '*', '_', '](', ')', '[', '][', ']', '>', '<'];
    for (let position = Math.max(scope.start, previous - 2); position < end; position++) {
      this.work++;
      if (!this.escapes[position])
        for (const token of tokens) {
          this.work++;
          if (
            position + token.length > previous &&
            position + token.length <= end &&
            token.split('').every((character, part) => this.units[position + part] === character)
          )
            notify(token, position);
        }
      const run = this.runAt.get(position);
      if (run && run.end > previous && run.end <= end)
        notify(`tick:${run.end - run.start}`, position);
      const open = this.parenOpens.get(position);
      if (position >= previous && open !== undefined) notify(`paren:${open}`, position);
    }
    let range = this.opaqueRanges.floor(previous);
    if (!range || range.end <= previous) range = this.opaqueRanges.ceiling(previous);
    while (range && range.end <= end) {
      if (range.end > previous) {
        for (let position = range.start; position < range.end; position++) {
          this.work++;
          this.wake(this.answers, position);
        }
      }
      range = this.opaqueRanges.ceiling(range.end);
    }
  }

  next(token: string, start: number, end: number): number {
    const indexed = this.positions.get(token);
    let position = indexed?.ceiling(start);
    if (token[0] === '*' || token[0] === '_' || token[0] === '~') {
      const boundary = this.opaqueRanges.floor(this.scopeEnd - 1);
      if (boundary && boundary.start < this.scopeEnd && boundary.end > this.scopeEnd) {
        const exposed = this.allPositions.get(token)?.ceiling(Math.max(start, boundary.start));
        if (
          exposed !== undefined &&
          exposed < this.scopeEnd &&
          (!token.includes('_') || !this.words[exposed])
        )
          position = Math.min(position ?? Infinity, exposed);
      }
    }
    while (position !== undefined) {
      this.work++;
      if (position + token.length > end) break;
      if (token[0] === '*' || token[0] === '_' || token[0] === '~')
        this.watch(this.answers, position);
      return position;
    }
    this.missing(token, start, end);
    return -1;
  }

  tickClose(start: number, end: number): number {
    const run = this.runAt.get(start);
    if (!run) return -1;
    const length = run.end - start;
    const indexed = this.tickPositions.get(length);
    let position = indexed?.ceiling(run.end);
    while (position !== undefined) {
      this.work++;
      if (position + length > end) break;
      const candidate = this.runAt.get(position);
      if (!candidate || candidate.end - position !== length || this.escapes[position]) {
        position = indexed?.ceiling(position + 1);
        continue;
      }
      this.watch(this.answers, position);
      return position;
    }
    this.missing(`tick:${length}`, run.end, end, length);
    return -1;
  }

  runEnd(start: number, character: string, end: number): number {
    const run = this.runAt.get(start);
    if (!run || this.units[start] !== character) return start;
    const owner = this.owner;
    if (owner && run.end <= end && !run.observers.has(owner)) {
      run.observers.add(owner);
      owner.dispose.push(() => run.observers.delete(owner));
    }
    this.work++;
    return Math.min(run.end, end);
  }

  parenClose(open: number, end: number): number {
    this.work++;
    const close = this.parenEnds.get(open);
    if (close !== undefined && close < end) return close;
    this.missing(`paren:${open}`, open + 1, end, 1);
    return -1;
  }

  singleCount(marker: string, start: number, end: number): number {
    if (this.owner) this.singleRanges.add(this.owner, start, end);
    let count = this.singles.get(marker)?.countRange(start, end) ?? 0;
    const boundary = this.opaqueRanges.floor(this.scopeEnd - 1);
    if (boundary && boundary.end > this.scopeEnd) {
      const from = Math.max(start, boundary.start);
      const to = Math.min(end, this.scopeEnd);
      count +=
        (this.rawSingles.get(marker)?.countRange(from, to) ?? 0) -
        (this.singles.get(marker)?.countRange(from, to) ?? 0);
    }
    for (const position of new Set([this.scopeStart, this.scopeEnd - 1])) {
      if (position < start || position >= end || this.units[position] !== marker) continue;
      const left = position > this.scopeStart ? this.units[position - 1] : '';
      const right = position + 1 < this.scopeEnd ? this.units[position + 1] : '';
      if (
        left !== marker &&
        right !== marker &&
        !this.escapes[position] &&
        !this.words[position] &&
        !this.opaque(position) &&
        this.rawSingles.get(marker)?.floor(position) !== position
      )
        count++;
    }
    return count;
  }

  plainEnd(start: number, end: number): number {
    this.work++;
    return Math.min(this.specialPositions.ceiling(start) ?? this.length, end);
  }

  get indexedWork(): number {
    return this.radixWork.visits + this.opaqueRanges.visits + this.singleRanges.visits;
  }
}

interface MemoChild {
  readonly sequence: InlineSequence;
  readonly style: InlineItemStyle;
  readonly start: number;
  readonly end: number;
}
interface InlineTextPlan {
  readonly node: InlineTextNode;
  readonly trim: number;
}
interface MemoItem extends InlineObserver {
  readonly start: number;
  readonly sequence: InlineSequence;
  previous: MemoItem | undefined;
  next: MemoItem | undefined;
  item: InlineItem<MemoChild>;
  alive: boolean;
  dirty: boolean;
  suffix: string;
  applied: boolean;
  plan: InlineTextPlan;
}
interface SavedInlineBody {
  readonly items: PositionIndex<MemoItem>;
  readonly first: MemoItem;
  readonly last: MemoItem;
  readonly start: number;
  readonly end: number;
  readonly geometry: PositionIndex<InlineTextPlan>;
}

/** Cache a sequence of canonical decisions; unchanged neighbours are linked, not rescanned. */
class InlineSequence {
  private first: MemoItem | undefined;
  private last: MemoItem | undefined;
  private dirtyPositions = new PositionIndex<Set<MemoItem>>();
  private dirtyAt = new Map<number, Set<MemoItem>>();
  private children = new Map<string, InlineSequence>();
  private items = new PositionIndex<MemoItem>();
  private savedBodies = new Map<number, SavedInlineBody>();
  private suspended = new PositionIndex<MemoItem>();
  private gaps = new Set<MemoItem>();
  private emptyItems = new PositionIndex<MemoItem>();
  private geometry = new PositionIndex<InlineTextPlan>();
  private readonly factory: InlineTextFactory;
  private readonly readGeometry: (version: PositionIndex<InlineTextPlan>) => InlineTextPlan;
  private readonly emptyPlan: InlineTextPlan;
  private readonly renderedSource: (start: number, end: number) => string;
  private readonly rawGeometry: (start: number, end: number, flatten: boolean) => InlineTextNode;
  readonly owners = new Set<InlineObserver>();
  private readonly index: InlineSourceIndex;
  private readonly start: number;
  private bound: number | undefined;
  private readonly scope: InlineScope;
  private readonly depth: number;
  private readonly mapper: (position: number) => number;
  private readonly changed: (node: MemoItem, old: InlineItem<MemoChild> | undefined) => void;
  private readonly accounting: { decisions: number; visits: number };
  private readonly removed: (node: MemoItem) => void;
  private prefixEdits: { start: number; end: number; text: string }[] = [];

  constructor(
    index: InlineSourceIndex,
    start: number,
    bound: number | undefined,
    depth: number,
    mapper: (position: number) => number,
    changed: (node: MemoItem, old: InlineItem<MemoChild> | undefined) => void,
    accounting: { decisions: number; visits: number },
    removed: (node: MemoItem) => void = () => {},
    factory: InlineTextFactory,
    renderedSource: (start: number, end: number) => string,
    rawGeometry: (start: number, end: number, flatten: boolean) => InlineTextNode,
  ) {
    this.index = index;
    this.start = start;
    this.bound = bound;
    this.scope = { start, end: bound ?? index.length, missing: new Map(), boundaries: new Set() };
    this.depth = depth;
    this.mapper = mapper;
    this.changed = changed;
    this.accounting = accounting;
    this.items = new PositionIndex(accounting);
    this.geometry = new PositionIndex(accounting);
    this.suspended = new PositionIndex(accounting);
    this.emptyItems = new PositionIndex(accounting);
    this.dirtyPositions = new PositionIndex(accounting);
    this.removed = removed;
    this.factory = factory;
    this.renderedSource = renderedSource;
    this.rawGeometry = rawGeometry;
    this.emptyPlan = { node: factory.concat([]), trim: 0 };
    this.readGeometry = this.geometry.createFold(
      (plan) => plan,
      (left, right) => {
        if (!right.trim && !right.node.renderLength) return left;
        if (!left.trim && !left.node.renderLength && !right.trim) return right;
        return {
          node: factory.concat([factory.trimEnd(left.node, right.trim), right.node]),
          trim: left.trim + Math.max(0, right.trim - left.node.renderLength),
        };
      },
      this.emptyPlan,
    );
  }

  source(position: number): number {
    return this.mapper(position);
  }

  private enqueue(node: MemoItem): void {
    let nodes = this.dirtyAt.get(node.start);
    if (!nodes) {
      nodes = new Set();
      this.dirtyAt.set(node.start, nodes);
      this.dirtyPositions.set(node.start, nodes);
    }
    nodes.add(node);
    this.accounting.visits++;
  }

  private dequeue(): MemoItem | undefined {
    const nodes = this.dirtyPositions.ceiling(0);
    const next = nodes?.values().next().value;
    if (next) {
      nodes?.delete(next);
      if (!nodes?.size) {
        this.dirtyPositions.delete(next.start);
        this.dirtyAt.delete(next.start);
      }
    }
    return next;
  }

  private discard(node: MemoItem): void {
    node.alive = false;
    this.removed(node);
    for (const dispose of node.dispose.splice(0)) dispose();
    this.accounting.visits++;
  }

  private suffix(node: MemoItem | undefined): string {
    return node?.suffix ?? '';
  }

  private child(
    parent: MemoItem,
    start: number,
    end: number,
    depth: number,
    style: InlineItemStyle,
    flatten: boolean,
  ): { readonly text: string; readonly value: MemoChild } {
    const key = `${start}:${depth}:${flatten ? end : 0}`;
    let sequence = this.children.get(key);
    if (!sequence) {
      if (flatten) {
        const original = this.index.slice(start, end);
        let normalized = '';
        const mapping = [this.source(start)];
        const prefixEdits: { start: number; end: number; text: string }[] = [];
        for (let at = 0; at < original.length; ) {
          const character = original[at] ?? '';
          if (character === '\t') {
            const begin = at;
            while (original[at] === '\t') at++;
            normalized += ' ';
            prefixEdits.push({
              start: this.source(start + begin),
              end: this.source(start + at),
              text: ' ',
            });
          } else {
            normalized += character;
            at++;
          }
          mapping.push(this.source(start + at));
        }
        sequence = new InlineSequence(
          new StaticInlineIndex(normalized),
          0,
          normalized.length,
          depth,
          (position) => mapping[position] ?? this.source(end),
          () => {},
          this.accounting,
          () => {},
          this.factory,
          this.renderedSource,
          this.rawGeometry,
        );
        sequence.prefixEdits = prefixEdits;
      } else {
        sequence = new InlineSequence(
          this.index,
          start,
          end,
          depth,
          this.mapper,
          () => {},
          this.accounting,
          () => {},
          this.factory,
          this.renderedSource,
          this.rawGeometry,
        );
      }
      this.children.set(key, sequence);
    }
    if (!flatten && sequence.bound !== undefined && end > sequence.bound) {
      sequence.bound = end;
      if (this.index instanceof LiveInlineIndex) this.index.extendScope(sequence.scope, end);
    } else if (!flatten && sequence.bound !== end) {
      // A shorter provisional closer has its own fixed view. Growing views
      // keep their persistent prefix and are reused on the next extension.
      const smallerKey = `${start}:${depth}:short:${end}`;
      let smaller = this.children.get(smallerKey);
      if (!smaller) {
        smaller = new InlineSequence(
          this.index,
          start,
          end,
          depth,
          this.mapper,
          () => {},
          this.accounting,
          () => {},
          this.factory,
          this.renderedSource,
          this.rawGeometry,
        );
        this.children.set(smallerKey, smaller);
      }
      sequence = smaller;
    }
    sequence.flush();
    if (!sequence.owners.has(parent)) {
      sequence.owners.add(parent);
      const childSequence = sequence;
      parent.dispose.push(() => childSequence.owners.delete(parent));
    }
    const value = { sequence, style, start: this.source(start), end: this.source(end) };
    const childSequence = sequence;
    return {
      get text(): string {
        return childSequence
          .project(-Infinity, Infinity)
          .map((span) => span.text)
          .join('');
      },
      value,
    };
  }

  private renderSuffix(item: InlineItem<MemoChild>, previous: string): string {
    if (!item.plain) return '';
    let suffix = item.trimPlain ? previous.slice(0, -item.trimPlain) : previous;
    for (const part of item.parts) {
      if (part.kind === 'raw')
        suffix = (suffix + this.index.slice(Math.max(part.start, part.end - 2), part.end)).slice(
          -2,
        );
      else if (part.kind === 'text') suffix = (suffix + part.text).slice(-2);
    }
    return suffix;
  }

  private build(position: number, previous: MemoItem | undefined): MemoItem {
    const node: MemoItem = {
      start: position,
      sequence: this,
      previous,
      next: undefined,
      item: { end: position, plain: true, trimPlain: 0, parts: [], edits: [] },
      alive: true,
      dirty: false,
      suffix: '',
      applied: false,
      dispose: [],
      plan: this.emptyPlan,
      invalidate: () => {
        if (!node.alive || node.dirty) return;
        node.dirty = true;
        for (const dispose of node.dispose.splice(0)) dispose();
        this.enqueue(node);
        for (const owner of [...this.owners]) owner.invalidate();
      },
    };
    const end = this.bound ?? this.index.length;
    const interpret = (): InlineItem<MemoChild> => {
      this.accounting.decisions++;
      const result = interpretInlineItem(
        this.index,
        position,
        end,
        this.depth,
        this.suffix(previous),
        (start, finish, depth, style, flatten) =>
          this.child(node, start, finish, depth, style, flatten),
      );
      if (result.end === end && /[\\![*_~`<]/.test(this.index.charAt(position))) {
        if (this.bound === undefined) this.index.charAt(end);
        else if (this.index instanceof LiveInlineIndex) this.index.scopeBoundary(node, this.scope);
      }
      return result;
    };
    node.item =
      this.index instanceof LiveInlineIndex
        ? this.index.observe(node, interpret, this.bound === undefined, this.start, end, this.scope)
        : interpret();
    node.suffix = this.renderSuffix(node.item, this.suffix(previous));
    node.plan = this.itemPlan(node);
    return node;
  }

  private itemPlan(node: MemoItem): InlineTextPlan {
    const parts: InlineTextNode[] = [];
    let cursor = this.source(node.start);
    for (const part of node.item.parts) {
      if (part.kind === 'child') {
        parts.push(part.value.sequence.textPlan.node);
        cursor = part.value.end;
      } else if (part.kind === 'text')
        parts.push(this.factory.text(part.text, cursor, cursor + (part.text === '\n' ? 1 : 0)));
      else {
        parts.push(
          this.rawGeometry(
            this.source(part.start),
            this.source(part.end),
            Boolean(part.flatten || this.prefixEdits.length > 0),
          ),
        );
        cursor = this.source(part.end);
      }
    }
    return { node: this.factory.concat(parts), trim: node.item.trimPlain };
  }

  get textPlan(): InlineTextPlan {
    return this.readGeometry(this.geometry);
  }

  private pure(node: MemoItem): boolean {
    const part = node.item.parts[0];
    return (
      node.dispose.length === 0 &&
      node.item.plain &&
      !node.item.edits.length &&
      !node.item.trimPlain &&
      node.item.parts.length === 1 &&
      part?.kind === 'raw' &&
      !part.style &&
      !part.flatten &&
      part.start === node.start &&
      part.end === node.item.end
    );
  }

  private releaseStableBody(node: MemoItem): void {
    const completeConstruct =
      node.item.parts.some((part) =>
        part.kind === 'child'
          ? part.value.style.linkURL !== undefined
          : part.style?.linkURL !== undefined,
      ) ||
      node.item.edits.some(
        (edit) => edit.raw && edit.start === node.start && edit.end === node.item.end,
      );
    const completeCode =
      node.item.end < this.index.length &&
      node.item.parts.some((part) => part.kind === 'raw' && part.style?.code);
    if (!completeConstruct && !completeCode) return;
    const saved = this.savedBodies.get(node.start);
    if (!saved) return;
    this.savedBodies.delete(node.start);
    for (let current: MemoItem | undefined = saved.first; current; ) {
      const next: MemoItem | undefined = current.next;
      this.discard(current);
      if (current === saved.last) break;
      current = next;
    }
  }

  private insert(
    position: number,
    previous: MemoItem | undefined,
    next: MemoItem | undefined,
    old?: MemoItem,
  ): MemoItem {
    const node = this.build(position, previous);
    const saved = this.savedBodies.get(position);
    if (saved && node.item.end <= saved.start) {
      this.items.replaceRange(saved.start, saved.end, saved.items);
      this.geometry.replaceRange(saved.start, saved.end, saved.geometry);
      saved.first.previous = node;
      saved.last.next = next;
      if (next) next.previous = saved.last;
      else this.last = saved.last;
      if (next && saved.last.item.end < next.start) this.gaps.add(saved.last);
      next = saved.first;
      let dirty = this.suspended.ceiling(saved.start);
      while (dirty && dirty.start < saved.end) {
        this.suspended.delete(dirty.start);
        this.enqueue(dirty);
        dirty = this.suspended.ceiling(saved.start);
      }
      this.savedBodies.delete(position);
    }
    if (next && next.start < node.item.end) {
      const covered = this.items.floor(node.item.end - 1);
      if (covered && covered.start >= next.start) {
        this.savedBodies.set(position, {
          items: this.items.snapshot(),
          geometry: this.geometry.snapshot(),
          first: next,
          last: covered,
          start: next.start,
          end: covered.item.end,
        });
      }
    }
    if (next && next.start < node.item.end) {
      const covered = this.items.floor(node.item.end - 1);
      if (covered) next = covered.next;
      this.accounting.visits++;
    }
    if (saved || this.savedBodies.has(position)) {
      this.items.replaceRange(position + 1, node.item.end, this.emptyItems);
      this.geometry.replaceRange(position + 1, node.item.end, new PositionIndex());
    }
    const merge =
      previous && previous.item.end === position && !old && this.pure(previous) && this.pure(node);
    if (!merge) {
      this.items.set(position, node);
      this.geometry.set(position, node.plan);
    }
    this.changed(node, old?.item);
    node.next = next;
    if (previous) previous.next = node;
    else this.first = node;
    if (next) next.previous = node;
    else this.last = node;
    this.releaseStableBody(node);
    if (merge) {
      previous.item = {
        ...previous.item,
        end: node.item.end,
        parts: [{ kind: 'raw', start: previous.start, end: node.item.end }],
      };
      previous.suffix = node.suffix;
      previous.plan = this.itemPlan(previous);
      previous.next = next;
      if (next) next.previous = previous;
      else this.last = previous;
      this.discard(node);
      this.items.set(previous.start, previous);
      this.geometry.set(previous.start, previous.plan);
      return previous;
    }
    if (
      next &&
      node.suffix !== (old?.suffix ?? node.suffix) &&
      this.index.charAt(next.start) === '\n'
    )
      next.invalidate();
    return node;
  }

  flush(): void {
    while (this.dirtyAt.size) {
      const old = this.dequeue();
      if (!old?.alive || !old.dirty) continue;
      if (this.items.floor(old.start) !== old) {
        this.suspended.set(old.start, old);
        continue;
      }
      const previous = old.previous;
      const next = old.next;
      this.items.delete(old.start);
      this.geometry.delete(old.start);
      this.discard(old);
      let node = this.insert(old.start, previous, next, old);
      while (node.next && node.item.end < node.next.start)
        node = this.insert(node.item.end, node, node.next);
    }
    while (this.gaps.size) {
      const gap = this.gaps.values().next().value;
      if (!gap) break;
      this.gaps.delete(gap);
      if (!gap.alive || this.items.floor(gap.start) !== gap) continue;
      let node = gap;
      while (node.next && node.item.end < node.next.start)
        node = this.insert(node.item.end, node, node.next);
    }
    const end = this.bound ?? this.index.length;
    while ((this.last?.item.end ?? this.start) < end)
      this.insert(this.last?.item.end ?? this.start, this.last, undefined);
  }

  close(end: number): void {
    this.bound = end;
    this.scope.end = end;
    while (this.last && this.last.start >= end) {
      const node = this.last;
      this.last = node.previous;
      if (this.last) this.last.next = undefined;
      else this.first = undefined;
      this.items.delete(node.start);
      this.geometry.delete(node.start);
      this.discard(node);
    }
    if (this.last && this.last.item.end > end) {
      this.last.invalidate();
      this.flush();
    }
  }

  reopen(): void {
    this.bound = undefined;
    this.scope.end = this.index.length;
    this.flush();
  }

  project(start: number, end: number, style: InlineItemStyle = {}): MarkdownSpan[] {
    const selected: MemoItem[] = [];
    for (let node = this.last; node && this.source(node.item.end) > start; node = node.previous) {
      this.accounting.visits++;
      if (this.source(node.start) < end) selected.push(node);
    }
    const spans: MarkdownSpan[] = [];
    const push = (text: string, flags: InlineItemStyle): void => {
      if (text) spans.push({ text, ...flags });
    };
    for (const node of selected.reverse()) {
      if (node.item.trimPlain) {
        let trim = node.item.trimPlain;
        while (trim && spans.length) {
          const previous = spans.pop();
          if (!previous) break;
          const count = Math.min(trim, previous.text.length);
          trim -= count;
          if (previous.text.length > count)
            spans.push({ ...previous, text: previous.text.slice(0, -count) });
        }
      }
      let cursor = this.source(node.start);
      for (const part of node.item.parts) {
        if (part.kind === 'child') {
          spans.push(...part.value.sequence.project(start, end, { ...style, ...part.value.style }));
          cursor = part.value.end;
        } else if (part.kind === 'text') {
          if (cursor >= start && cursor < end) push(part.text, { ...style, ...part.style });
        } else {
          const from = this.source(part.start);
          const to = this.source(part.end);
          if (to > start && from < end) {
            // Top-level coordinates are linear. A flattened label has a bounded
            // monotone source map, so binary-search its exposed raw interval.
            let low = part.start;
            let high = part.end;
            while (low < high) {
              const middle = Math.floor((low + high) / 2);
              if (this.source(middle) < start) low = middle + 1;
              else high = middle;
            }
            let upper = low;
            high = part.end;
            while (upper < high) {
              const middle = Math.floor((upper + high) / 2);
              if (this.source(middle) < end) upper = middle + 1;
              else high = middle;
            }
            const text = this.renderedSource(this.source(low), this.source(upper)).replace(
              /\0/g,
              '',
            );
            this.accounting.visits += upper - low;
            push(part.flatten || this.prefixEdits.length ? text.replace(/[\t\n]+/g, ' ') : text, {
              ...style,
              ...part.style,
            });
          }
          cursor = this.source(part.end);
        }
      }
    }
    return spans;
  }

  get retained(): number {
    let count = this.items.size + this.savedBodies.size;
    for (const child of this.children.values()) count += child.retained;
    return count;
  }

  get queueWork(): number {
    return 0;
  }
}

class CanonicalInlineCheckpoint {
  private readonly columns: ColumnCheckpoint;
  private index = new LiveInlineIndex();
  private sequence: InlineSequence | undefined;
  private offset = 0;
  private accounting = { decisions: 0, visits: 0 };
  private ingested = 0;
  private readonly textFactory: InlineTextFactory;
  readonly textWork: InlineTextWork = {
    nodes: 0,
    visits: 0,
    sourceUnits: 0,
    measuredUnits: 0,
    cacheKeyUnits: 0,
    constructedUnits: 0,
  };
  private lineStart = -1;
  private scopeBlock: MarkdownBlock | undefined;
  private archived: {
    sequence: InlineSequence;
    index: LiveInlineIndex;
    offset: number;
    end: number;
    block: MarkdownBlock | undefined;
  }[] = [];
  private retiredIndexed = 0;
  private retiredCopied = 0;
  private desiredStart = 0;
  private lineContinues = false;
  private bounded = new WeakMap<LiveInlineIndex, Map<number, InlineSequence>>();
  private regional = new WeakMap<InlineTextNode, RegionalSummary>();

  constructor(columns: ColumnCheckpoint) {
    this.columns = columns;
    this.textFactory = new InlineTextFactory(
      (start, end) => columns.originalSource(start, end),
      this.textWork,
    );
    columns.attachGeometry(this.textFactory, this.textWork);
  }

  reset(): void {
    this.retiredIndexed += this.index.work + this.index.indexedWork;
    this.retiredCopied += this.index.slices;
    this.index = new LiveInlineIndex();
    this.sequence = undefined;
    this.lineStart = -1;
    this.scopeBlock = undefined;
    for (const scope of this.archived) {
      this.retiredIndexed += scope.index.work + scope.index.indexedWork;
      this.retiredCopied += scope.index.slices;
    }
    this.archived = [];
  }

  line(start: number, block: MarkdownBlock, continues: boolean): void {
    const body = this.columns.bodyStart(start, start + block.source.length);
    if (start === this.lineStart && continues && !this.lineContinues) {
      const previous = this.archived[this.archived.length - 1];
      if (previous?.end === start - 1) {
        const end = this.offset + this.index.length;
        const copiedFrom = previous.offset + previous.index.length;
        const retained = this.columns.originalSource(copiedFrom, end);
        this.retiredIndexed += this.index.work + this.index.indexedWork;
        this.retiredCopied += this.index.slices + retained.length;
        this.archived.pop();
        this.index = previous.index;
        this.sequence = previous.sequence;
        this.offset = previous.offset;
        this.scopeBlock = previous.block;
        this.desiredStart = previous.offset;
        this.sequence.reopen();
        if (retained) this.consume(retained, copiedFrom);
      }
    }
    if (start === this.lineStart && !continues && this.lineContinues && this.offset < start)
      this.lineStart = -1;
    this.lineContinues = continues;
    if (start === this.lineStart) {
      if (this.offset >= start || !this.sequence) {
        this.scopeBlock = block;
        this.desiredStart = Math.max(this.desiredStart, body);
      }
      if (this.sequence && this.offset >= start && body > this.offset) {
        const retained = this.index.slice(
          Math.min(this.index.length, body - this.offset),
          this.index.length,
        );
        this.retiredIndexed += this.index.work + this.index.indexedWork;
        this.retiredCopied += this.index.slices;
        this.index = new LiveInlineIndex();
        this.sequence = undefined;
        this.offset = body;
        if (retained) this.consume(retained, body);
      }
      return;
    }
    this.lineStart = start;
    if (!continues && this.sequence) {
      const end = Math.max(this.offset, start - 1);
      const retained = this.index.slice(
        Math.min(this.index.length, Math.max(0, body - this.offset)),
        this.index.length,
      );
      this.sequence.close(end - this.offset);
      this.archived.push({
        sequence: this.sequence,
        index: this.index,
        offset: this.offset,
        end,
        block: this.scopeBlock,
      });
      this.sequence = undefined;
      this.index = new LiveInlineIndex();
      this.desiredStart = body;
      this.scopeBlock = block;
      if (retained) this.consume(retained, body);
    }
    this.desiredStart = !continues ? body : Math.min(this.desiredStart, body);
    if (!continues || !this.scopeBlock) this.scopeBlock = block;
  }

  append(source: string, offset: number): void {
    this.ingested += source.length;
    const omitted = Math.max(0, Math.min(source.length, this.desiredStart - offset));
    this.consume(source.slice(omitted), offset + omitted);
  }

  private consume(source: string, offset: number): void {
    if (!source) return;
    if (!this.sequence) {
      this.offset = offset;
      this.sequence = new InlineSequence(
        this.index,
        0,
        undefined,
        0,
        (position) => offset + position,
        () => {},
        this.accounting,
        () => {},
        this.textFactory,
        (start, end) => this.columns.renderSource(start, end),
        (start, end, flatten) => this.columns.rawGeometry(start, end, flatten),
      );
    }
    this.index.append(source);
    this.sequence.flush();
    const cut = offset + source.length - LIVE_SOURCE_LIMIT;
    while ((this.archived[0]?.end ?? Infinity) <= cut) {
      const scope = this.archived.shift();
      if (scope) {
        this.retiredIndexed += scope.index.work + scope.index.indexedWork;
        this.retiredCopied += scope.index.slices;
      }
    }
  }

  get work(): number {
    return this.ingested;
  }

  get checkpointWork(): Readonly<{
    indexed: number;
    copied: number;
    decisions: number;
    cache: number;
    retained: number;
  }> {
    let indexed = this.retiredIndexed + this.index.work + this.index.indexedWork;
    let copied = this.retiredCopied + this.index.slices;
    let retained = this.sequence?.retained ?? 0;
    let queues = this.sequence?.queueWork ?? 0;
    for (const scope of this.archived) {
      indexed += scope.index.work + scope.index.indexedWork;
      copied += scope.index.slices;
      retained += scope.sequence.retained;
      queues += scope.sequence.queueWork;
      for (const view of this.bounded.get(scope.index)?.values() ?? []) retained += view.retained;
    }
    for (const view of this.bounded.get(this.index)?.values() ?? []) retained += view.retained;
    return {
      indexed,
      copied,
      decisions: this.accounting.decisions,
      cache: this.accounting.visits + queues,
      retained,
    };
  }

  tabSpaces(start: number, end: number): readonly number[] {
    const tabs: number[] = [];
    const scopes = [
      ...this.archived,
      ...(this.sequence ? [{ sequence: this.sequence, block: this.scopeBlock }] : []),
    ];
    for (const scope of scopes) {
      const initial = displayWidth(scope.block?.prefix ?? '');
      const continuation = displayWidth(scope.block?.continuation ?? scope.block?.prefix ?? '');
      tabs.push(
        ...this.textFactory
          .tabSpaces(scope.sequence.textPlan.node, start, end, initial, continuation)
          .map((tab) => tab.spaces),
      );
    }
    return tabs;
  }

  deferredUnderscore(): boolean {
    return this.index.deferredWord;
  }

  private regionalPrefix(node: InlineTextNode, end: number): RegionalSummary {
    this.textWork.visits++;
    if (node.start >= end) return { all: true, trailing: 0 };
    const known = node.end <= end ? this.regional.get(node) : undefined;
    if (known) return known;
    let summary: RegionalSummary;
    if (node.kind === 'raw')
      summary = this.columns.regionalSummary(node.start, Math.min(node.end, end), this.textWork);
    else if (node.kind === 'text') {
      const value =
        node.end - node.start === node.value.length
          ? node.value.slice(0, Math.max(0, end - node.start))
          : node.value;
      let all = true;
      let trailing = 0;
      for (const point of value) {
        this.textWork.visits++;
        if (/\p{Regional_Indicator}/u.test(point)) trailing = (trailing + 1) % 2;
        else {
          all = false;
          trailing = 0;
        }
      }
      summary = { all, trailing };
    } else {
      let all = true;
      let trailing = 0;
      for (const child of node.parts) {
        if (!child.renderLength) continue;
        if (child.start >= end) break;
        const part = this.regionalPrefix(child, end);
        trailing = part.all ? (trailing + part.trailing) % 2 : part.trailing;
        all &&= part.all;
      }
      summary = { all, trailing };
    }
    if (node.end <= end) this.regional.set(node, summary);
    return summary;
  }

  project(source: string, offset: number, end = offset + source.length): MarkdownSpan[] {
    const scope = this.archived.find((entry) => entry.offset <= offset && entry.end >= offset);
    let sequence = scope?.sequence ?? this.sequence;
    const index = scope?.index ?? this.index;
    const base = scope?.offset ?? this.offset;
    const bound = scope?.end ?? base + index.length;
    // A terminal newline (including an unfinished blank line) cannot supply a
    // later closer. The range projection already omits its output and trim.
    if (
      sequence &&
      end + 1 < bound &&
      index.hasContentAfter(end - base) &&
      this.columns.originalSource(end, end + 1) === '\n'
    ) {
      let versions = this.bounded.get(index);
      if (!versions) {
        versions = new Map();
        this.bounded.set(index, versions);
      }
      let view = versions.get(end);
      if (!view) {
        view = new InlineSequence(
          index,
          0,
          end - base,
          0,
          (position) => base + position,
          () => {},
          this.accounting,
          () => {},
          this.textFactory,
          (start, finish) => this.columns.renderSource(start, finish),
          (start, finish, flatten) => this.columns.rawGeometry(start, finish, flatten),
        );
        view.flush();
        versions.set(end, view);
      }
      sequence = view;
    }
    const spans = sequence?.project(offset, end) ?? [{ text: source }];
    const first = spans.find((span) => span.text.length);
    if (
      sequence &&
      first &&
      /^\p{Regional_Indicator}/u.test(first.text) &&
      this.regionalPrefix(sequence.textPlan.node, offset).trailing === 1
    ) {
      const projected = spans.map((span) =>
        span === first ? { ...span, text: span.text.slice(2) } : span,
      );
      return projected.filter((span) => span.text.length);
    }
    return spans;
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
  private inline = new CanonicalInlineCheckpoint(this.columns);
  private generation = 0;
  private cached:
    | { generation: number; columns: number; rows: number; lines: readonly MarkdownDisplayLine[] }
    | undefined;
  private blockWork = 0;
  private semanticWork = 0;
  private lineWork = 0;
  private blockClassifier = new BlockLineClassifier();
  private classifierPrevious: { source: string; offset: number; block: MarkdownBlock } | undefined;
  private classifiedPreview:
    | { source: string; offset: number; result: BlockLineResult }
    | undefined;
  private ordinalState: 'indent' | 'digits' | 'marker' | 'padding' | 'quote' | 'done' = 'indent';
  private ordinalIndent = 0;
  private ordinalBase = 0;
  private ordinalParent: number | undefined;
  private ordinalDigits = 0;
  private ordinalPadding = 0;
  private ordinalWidth: number | undefined;

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

  get checkpointWork(): Readonly<{
    indexed: number;
    copied: number;
    decisions: number;
    cache: number;
    retained: number;
  }> {
    return this.inline.checkpointWork;
  }

  get geometryWork(): Readonly<InlineTextWork> {
    return this.inline.textWork;
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
        this.scanOrdinal(part);
        this.fragments.push(part);
        this.lineLength += part.length;
        if (this.linePrefix.length < 256)
          this.linePrefix += part.slice(0, 256 - this.linePrefix.length);
        this.pendingSize += part.length;
        this.columnLine(
          this.linePrefix,
          initialOffset + start - (this.lineLength - part.length),
          false,
        );
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
        this.resetOrdinal();
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
      this.replayInline(this.fragments.join(''), this.sourceLength - this.lineLength, false);
    }
    const tableLine = stripContainers(this.linePrefix, this.pendingTableContainers);
    if (this.pendingTable && tableLine !== undefined && /^ {0,3}#{1,6} +/.test(tableLine)) {
      this.pendingSize -= this.lineLength;
      this.finalize();
      this.pendingSize = this.lineLength;
      this.replayInline(this.fragments.join(''), this.sourceLength - this.lineLength, false);
    }
    if (this.lineLength)
      this.columnLine(this.linePrefix, this.sourceLength - this.lineLength, false);
  }

  private resetOrdinal(): void {
    this.ordinalState = 'indent';
    this.ordinalIndent = 0;
    this.ordinalBase = 0;
    this.ordinalParent = undefined;
    this.ordinalDigits = 0;
    this.ordinalPadding = 0;
    this.ordinalWidth = undefined;
  }

  /** Retain the width of a leading list prefix even when its ordinal exceeds the source window. */
  private scanOrdinal(source: string): void {
    if (this.ordinalState === 'done') return;
    for (const character of source) {
      if (this.ordinalState === 'done') break;
      this.columns.describe(character.length);
      let again = true;
      while (again) {
        again = false;
        if (this.ordinalState === 'quote') {
          this.ordinalState = 'indent';
          if (character === ' ') continue;
        }
        if (this.ordinalState === 'indent') {
          if (character === ' ' || character === '\t') {
            const column = this.ordinalBase + this.ordinalIndent;
            this.ordinalIndent += character === '\t' ? 8 - (column % 8) : 1;
          } else if (character === '>') {
            this.ordinalBase += 2;
            this.ordinalIndent = 0;
            if (this.ordinalParent !== undefined)
              this.ordinalParent = this.ordinalWidth = this.ordinalBase;
            this.ordinalState = 'quote';
          } else if (/[0-9]/.test(character)) {
            this.ordinalDigits = 1;
            this.ordinalState = 'digits';
          } else if (/[-+*]/.test(character)) {
            this.ordinalDigits = 0;
            this.ordinalState = 'marker';
          } else this.ordinalState = 'done';
          continue;
        }
        if (this.ordinalState === 'digits') {
          if (/[0-9]/.test(character)) this.ordinalDigits++;
          else this.ordinalState = character === '.' || character === ')' ? 'marker' : 'done';
          continue;
        }
        if (this.ordinalState === 'marker' || this.ordinalState === 'padding') {
          if (character === ' ' || character === '\t') {
            const column =
              this.ordinalBase + this.ordinalIndent + this.ordinalDigits + 1 + this.ordinalPadding;
            this.ordinalPadding += character === '\t' ? 8 - (column % 8) : 1;
            if (this.ordinalPadding > 4) {
              this.ordinalState = 'done';
              this.ordinalWidth = this.ordinalParent;
            } else {
              this.ordinalState = 'padding';
              this.ordinalWidth =
                this.ordinalBase +
                this.ordinalIndent +
                this.ordinalDigits +
                1 +
                this.ordinalPadding;
            }
          } else if (this.ordinalState === 'padding') {
            this.ordinalParent = this.ordinalWidth;
            this.ordinalBase = this.ordinalWidth ?? this.ordinalBase;
            this.ordinalIndent = this.ordinalDigits = this.ordinalPadding = 0;
            this.ordinalState = 'indent';
            again = true;
          } else {
            this.ordinalState = 'done';
            this.ordinalWidth = this.ordinalParent;
          }
        }
      }
    }
  }

  private columnLine(source: string, offset: number, complete: boolean): void {
    const prefix = source.slice(0, 256);
    let body = this.pendingFence
      ? fenceContent(complete ? source : prefix, this.pendingFence)
      : undefined;
    if (body !== undefined && this.pendingFence) {
      let indent = 0;
      while (indent < this.pendingFence.indent && body[indent] === ' ') indent++;
      body = body.slice(indent);
    }
    let classified: BlockLineResult;
    if (
      !complete &&
      this.classifiedPreview?.offset === offset &&
      this.classifiedPreview.source === prefix
    )
      classified = this.classifiedPreview.result;
    else {
      this.columns.describe(complete ? source.length : prefix.length);
      classified = complete
        ? this.blockClassifier.commit(source)
        : this.blockClassifier.preview(prefix);
      this.classifiedPreview = { source: prefix, offset, result: classified };
    }
    const previous = this.classifierPrevious;
    if (classified.revision && previous) {
      const revision = {
        ...classified.revision,
        source: previous.source,
        text: previous.block.text,
        ...(classified.preserveRevisionPrefix && previous.block.prefix !== undefined
          ? { prefix: previous.block.prefix }
          : {}),
        ...(classified.preserveRevisionPrefix && previous.block.continuation !== undefined
          ? { continuation: previous.block.continuation }
          : {}),
      };
      this.columns.line(previous.offset, previous.source, revision, undefined, true);
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
          : classified.block;
    this.columns.line(
      offset,
      complete ? source : prefix,
      block,
      body,
      complete,
      complete ? source.length : this.lineLength,
    );
    if (complete || source.trim()) this.inline.line(offset, block, classified.continuesParagraph);
    if (complete) this.classifierPrevious = { source, offset, block };
  }

  private replayInline(source: string, offset: number, complete: boolean): void {
    this.columnLine(complete ? source.slice(0, -1) : source, offset, complete);
    this.inline.append(source, offset);
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
      this.replayInline(line + '\n', offset, true);
    }
    if (this.pendingTable) {
      const content = stripContainers(line, this.pendingTableContainers);
      if (
        content === undefined ||
        !content.trim() ||
        isBlockStart(content) ||
        !content.includes('|')
      ) {
        // The current line has not been attached to the table yet.
        this.pendingSize -= line.length + 1;
        this.finalize();
        this.pendingSize = line.length + 1;
        this.replayInline(line + '\n', offset, true);
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
    const list = /^( *)(?:[-+*]|\d+[.)]) {1,4}(?:\S|$)/.test(line);
    const sameList = this.pendingList && (list || /^[ \t]/.test(line));
    const quote = /^ {0,3}>/.test(line);
    const previousQuote = previous !== undefined && /^ {0,3}>/.test(previous);
    const setext = previous !== undefined && isSetextPair(previous, line);
    if (
      (opening || isBlockStart(line)) &&
      !setext &&
      !sameList &&
      !(quote && previousQuote) &&
      this.completed.length
    ) {
      this.pendingSize -= line.length + 1;
      this.finalize();
      this.pendingSize = line.length + 1;
      this.replayInline(line + '\n', offset, true);
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
    this.blockClassifier.reset();
    this.classifierPrevious = undefined;
    this.classifiedPreview = undefined;
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
    const tabSpaces =
      this.pendingTable || this.pendingFence
        ? this.columns.tabSpaces(cutOffset, this.sourceLength, this.pendingTable)
        : this.inline.tabSpaces(cutOffset, this.sourceLength);
    const blocks: MarkdownBlock[] = [];
    const projectFirst = (block: MarkdownBlock): MarkdownSpan[] => {
      const body = this.columns.bodyStart(cutOffset, cutOffset + block.source.length);
      const end =
        block.kind === 'heading' ? body + block.text.length : cutOffset + block.source.length;
      return this.inline.project(block.text, body, end);
    };
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
      if (
        !this.pendingFence &&
        !this.pendingTable &&
        this.ordinalWidth !== undefined &&
        this.ordinalWidth >= columns &&
        cutOffset >= this.sourceLength - this.lineLength
      )
        blocks.push(literal(pending));
      else if (this.pendingTable) blocks.push(literal(pending));
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
            const spans = first.spans ?? projectFirst(first);
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
            parsed[0] = { ...first, spans: projectFirst(first) };
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
        if (!block.prefix) {
          tab += (original.source.match(/\t/g) ?? []).length;
          return { ...block, text: block.source };
        }
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
    this.inline = new CanonicalInlineCheckpoint(this.columns);
    this.blockClassifier.reset();
    this.classifierPrevious = undefined;
    this.classifiedPreview = undefined;
    this.resetOrdinal();
    this.cached = undefined;
    this.generation++;
    this.blockWork = 0;
    this.semanticWork = 0;
    this.lineWork = 0;
  }
}
