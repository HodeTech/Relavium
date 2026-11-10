import { displayWidth } from '../tui/viewport.js';

/** Work charged to the aggregator, including all text passed to the width engine. */
export interface InlineTextWork {
  nodes: number;
  visits: number;
  sourceUnits: number;
  measuredUnits: number;
  cacheKeyUnits: number;
  constructedUnits: number;
}

interface RawNode {
  readonly kind: 'raw';
  readonly start: number;
  readonly end: number;
  readonly flatten: boolean;
  readonly renderLength: number;
}
interface TextNode {
  readonly kind: 'text';
  readonly start: number;
  readonly end: number;
  readonly value: string;
  readonly renderLength: number;
}
interface ConcatNode {
  readonly kind: 'concat';
  readonly start: number;
  readonly end: number;
  readonly parts: readonly InlineTextNode[];
  readonly renderLength: number;
}
export type InlineTextNode = RawNode | TextNode | ConcatNode;
export interface InlineTabSpace {
  readonly position: number;
  readonly spaces: number;
}

interface State {
  /** Column before the uninterrupted pending text, modulo eight. */
  readonly column: number;
  readonly continuationColumn: number;
  /** Text since the last real tab/newline, not yet measured or flattened. */
  readonly pending: InlineTextNode | undefined;
}
type Token =
  | { readonly kind: 'fragment'; readonly node: InlineTextNode }
  | { readonly kind: 'tab' | 'newline'; readonly position: number };
const RECENT_LIMIT = 512;
const ASCII_PAGE_SIZE = 4096;
const SUMMARY_LIMIT = 32;
function getRecent<T>(entries: Map<string, T>, key: string): T | undefined {
  const value = entries.get(key);
  if (value !== undefined) {
    entries.delete(key);
    entries.set(key, value);
  }
  return value;
}
function putRecent<T>(entries: Map<string, T>, key: string, value: T, limit: number): void {
  entries.delete(key);
  entries.set(key, value);
  if (entries.size > limit) {
    const oldest = entries.keys().next();
    if (!oldest.done) entries.delete(oldest.value);
  }
}
interface AnchorSummary {
  readonly prefix: InlineTextNode;
  readonly suffix: InlineTextNode;
  /** Width from the first synchronization backtick through the last, inclusive. */
  readonly middle: number;
}

interface Frame {
  readonly node: InlineTextNode;
  readonly initial: State;
  state: State;
  next: number;
}

/** Immutable, source-ranged text nodes with memoized exact column transitions. */
export class InlineTextFactory {
  private readonly readSource: (start: number, end: number) => string;
  private readonly accounting: InlineTextWork;
  private readonly alignedRaw = new Map<string, RawNode>();
  private readonly rawNodes = new Map<string, RawNode>();
  private readonly textNodes = new Map<string, TextNode>();
  private readonly nodeIds = new WeakMap<InlineTextNode, number>();
  private readonly concatNodes = new Map<string, ConcatNode>();
  private readonly summaries = new WeakMap<InlineTextNode, Map<string, State>>();
  private readonly pairWidths = new WeakMap<InlineTextNode, WeakMap<InlineTextNode, number>>();
  private readonly tokens = new WeakMap<RawNode | TextNode, readonly Token[]>();
  private readonly widths = new WeakMap<InlineTextNode, number>();
  // Only measured short source intervals are retained; unlike arbitrary
  // growing ranges, each interval is bounded by the 64-unit leaf size.
  private readonly rawWidths = new Map<string, number>();
  private readonly rawEdges = new Map<string, { readonly first: string; readonly last: string }>();
  private readonly anchors = new WeakMap<InlineTextNode, AnchorSummary | null>();
  private readonly anchorOrdinals: Uint32Array[] = [];
  private anchorPositions = new Uint32Array(0);
  private anchorWidths = new Float64Array(0);
  private anchorSegments = new Uint32Array(0);
  private anchorCount = 0;
  private anchorIndexed = 0;
  private previousTick = false;
  private previousPivot = -1;
  private anchorSegment = 1;
  private anchorWidth = 0;
  private readonly contiguous = new WeakMap<InlineTextNode, readonly [number, number] | null>();
  private readonly contiguousWidths = new Map<string, number>();
  private readonly asciiPages: Uint32Array[] = [];
  private asciiIndexed = 0;
  private nonAscii = 0;
  private readonly controlCache = new WeakMap<InlineTextNode, boolean>();
  private readonly edges = new WeakMap<
    InlineTextNode,
    { readonly first: string; readonly last: string }
  >();
  private nextId = 0;

  constructor(readSource: (start: number, end: number) => string, accounting: InlineTextWork) {
    this.readSource = readSource;
    this.accounting = accounting;
  }

  /** Strongly held source-range and recent concatenation caches. */
  get cacheStats(): Readonly<{
    alignedRaw: number;
    alignedSummaries: number;
    recentRaw: number;
    recentText: number;
    recentConcat: number;
    measuredRawRanges: number;
    edgedRawRanges: number;
    recentContiguous: number;
    sourceAnchors: number;
    sourceAnchorPages: number;
  }> {
    let alignedSummaries = 0;
    for (const node of this.alignedRaw.values())
      alignedSummaries += this.summaries.get(node)?.size ?? 0;
    return {
      alignedRaw: this.alignedRaw.size,
      alignedSummaries,
      recentRaw: this.rawNodes.size,
      recentText: this.textNodes.size,
      recentConcat: this.concatNodes.size,
      measuredRawRanges: this.rawWidths.size,
      edgedRawRanges: this.rawEdges.size,
      recentContiguous: this.contiguousWidths.size,
      sourceAnchors: this.anchorCount,
      sourceAnchorPages: this.anchorOrdinals.length,
    };
  }

  private identify(node: InlineTextNode): number {
    const id = this.nodeIds.get(node);
    if (id !== undefined) return id;
    const next = ++this.nextId;
    this.nodeIds.set(node, next);
    this.accounting.nodes++;
    return next;
  }

  raw(start: number, end: number, flatten = false): InlineTextNode {
    const key = `${start}:${end}:${flatten ? 1 : 0}`;
    this.accounting.constructedUnits += key.length;
    const length = end - start;
    const aligned =
      !flatten && length >= 64 && Number.isInteger(Math.log2(length)) && start % length === 0;
    const cache = aligned ? this.alignedRaw : this.rawNodes;
    const existing = aligned ? cache.get(key) : getRecent(cache, key);
    if (existing) return existing;
    let renderLength = Math.max(0, end - start);
    if (flatten) {
      const source = this.readSource(start, end);
      this.accounting.sourceUnits += source.length;
      let inWhitespace = false;
      renderLength = 0;
      for (const character of source) {
        this.accounting.visits++;
        const whitespace = character === '\t' || character === '\n';
        if (!whitespace || !inWhitespace) renderLength += character.length;
        inWhitespace = whitespace;
      }
    }
    const node: RawNode = Object.freeze({ kind: 'raw', start, end, flatten, renderLength });
    this.identify(node);
    this.contiguous.set(node, flatten ? null : [start, end]);
    if (aligned) cache.set(key, node);
    else putRecent(cache, key, node, RECENT_LIMIT);
    return node;
  }

  text(value: string, start: number, end: number): InlineTextNode {
    const key = JSON.stringify([value, start, end]);
    this.accounting.constructedUnits += key.length;
    const existing = getRecent(this.textNodes, key);
    if (existing) return existing;
    const node: TextNode = Object.freeze({
      kind: 'text',
      value,
      start,
      end,
      renderLength: value.length,
    });
    this.identify(node);
    this.contiguous.set(node, null);
    putRecent(this.textNodes, key, node, RECENT_LIMIT);
    return node;
  }

  concat(parts: readonly InlineTextNode[]): InlineTextNode {
    if (parts.length === 1 && parts[0]) return parts[0];
    this.accounting.visits += parts.length * 2;
    const key = parts.map((part) => this.identify(part)).join(',');
    this.accounting.constructedUnits += key.length;
    const existing = getRecent(this.concatNodes, key);
    if (existing) return existing;
    let start = Infinity;
    let end = -Infinity;
    let renderLength = 0;
    let rawStart: number | undefined;
    let rawEnd: number | undefined;
    let rawContiguous = true;
    for (const part of parts) {
      if (part.renderLength) {
        const range = this.contiguous.get(part);
        if (!range || (rawEnd !== undefined && rawEnd !== range[0])) rawContiguous = false;
        else {
          rawStart ??= range[0];
          rawEnd = range[1];
        }
      }
      renderLength += part.renderLength;
      start = Math.min(start, part.start);
      end = Math.max(end, part.end);
    }
    const node: ConcatNode = Object.freeze({
      kind: 'concat',
      start,
      end,
      parts: Object.freeze([...parts]),
      renderLength,
    });
    this.identify(node);
    this.contiguous.set(
      node,
      rawContiguous && rawStart !== undefined && rawEnd !== undefined ? [rawStart, rawEnd] : null,
    );
    putRecent(this.concatNodes, key, node, RECENT_LIMIT);
    return node;
  }

  /** Remove rendered UTF-16 units from the right, preserving source provenance. */
  trimEnd(node: InlineTextNode, units: number): InlineTextNode {
    let remaining = Number.isFinite(units) ? Math.max(0, Math.trunc(units)) : 0;
    if (!remaining) return node;
    if (remaining >= node.renderLength) return this.concat([]);
    const parents: { readonly parts: readonly InlineTextNode[]; readonly index: number }[] = [];
    let current = node;
    while (current.kind === 'concat') {
      let index = current.parts.length - 1;
      while (index >= 0 && remaining >= (current.parts[index]?.renderLength ?? 0)) {
        remaining -= current.parts[index]?.renderLength ?? 0;
        index--;
        this.accounting.visits++;
      }
      const child = current.parts[index];
      if (!child) return this.concat([]);
      parents.push({ parts: current.parts, index });
      current = child;
    }
    let trimmed: InlineTextNode;
    if (current.kind === 'text') {
      const value = current.value.slice(0, current.value.length - remaining);
      const end =
        current.value.length === current.end - current.start
          ? current.end - remaining
          : current.end;
      trimmed = this.text(value, current.start, end);
    } else if (!current.flatten) trimmed = this.raw(current.start, current.end - remaining);
    else {
      const value = this.readSource(current.start, current.end);
      this.accounting.sourceUnits += value.length;
      let at = value.length;
      while (at > 0 && remaining > 0) {
        this.accounting.visits++;
        at--;
        if (value[at] === '\t' || value[at] === '\n') {
          while (at > 0 && (value[at - 1] === '\t' || value[at - 1] === '\n')) {
            this.accounting.visits++;
            at--;
          }
        }
        remaining--;
      }
      trimmed = this.raw(current.start, current.start + at, true);
    }
    while (parents.length) {
      const parent = parents.pop();
      if (parent) trimmed = this.concat([...parent.parts.slice(0, parent.index), trimmed]);
    }
    return trimmed;
  }

  private cacheKey(state: State): string {
    const key = `${state.column}:${state.continuationColumn}:${state.pending ? this.identify(state.pending) : 0}`;
    this.accounting.cacheKeyUnits += key.length;
    return key;
  }

  private cached(node: InlineTextNode, state: State): State | undefined {
    this.accounting.visits++;
    const entries = this.summaries.get(node);
    return entries ? getRecent(entries, this.cacheKey(state)) : undefined;
  }

  private remember(node: InlineTextNode, initial: State, result: State): void {
    let entries = this.summaries.get(node);
    if (!entries) {
      entries = new Map();
      this.summaries.set(node, entries);
    }
    putRecent(entries, this.cacheKey(initial), result, SUMMARY_LIMIT);
  }

  /** Aligned subranges let changing large bodies reuse already-measured prefix nodes. */
  private split(node: RawNode): readonly [InlineTextNode, InlineTextNode] | undefined {
    const length = node.end - node.start;
    if (node.flatten || length <= 64) return undefined;
    let size = 64;
    while (size * 2 < length) size *= 2;
    let middle = Math.ceil(node.start / size) * size;
    if (middle <= node.start) middle += size;
    if (middle >= node.end) middle = node.start + Math.floor(length / 2);
    return [this.raw(node.start, middle), this.raw(middle, node.end)];
  }

  private tokenize(node: RawNode | TextNode): readonly Token[] {
    const cached = this.tokens.get(node);
    if (cached) return cached;
    let value = node.kind === 'raw' ? this.readSource(node.start, node.end) : node.value;
    if (node.kind === 'raw') this.accounting.sourceUnits += value.length;
    if (node.kind === 'raw' && node.flatten) {
      this.accounting.visits += value.length;
      value = value.replace(/[\t\n]+/g, ' ');
      const result: readonly Token[] = value
        ? [{ kind: 'fragment', node: this.text(value, node.start, node.end) }]
        : [];
      this.tokens.set(node, result);
      return result;
    }
    if (node.kind === 'text' && /[\t\n]/.test(value) && node.end - node.start !== value.length)
      throw new RangeError('A replacement with tab or newline must map one-to-one to source units');
    const tokens: Token[] = [];
    let from = 0;
    const fragment = (to: number): void => {
      if (to <= from) return;
      const child =
        from === 0 && to === value.length
          ? node
          : node.kind === 'raw'
            ? this.raw(node.start + from, node.start + to)
            : this.text(value.slice(from, to), node.start + from, node.start + to);
      tokens.push({ kind: 'fragment', node: child });
    };
    for (let at = 0; at < value.length; at++) {
      this.accounting.visits++;
      if (value[at] !== '\t' && value[at] !== '\n') continue;
      fragment(at);
      tokens.push({ kind: value[at] === '\t' ? 'tab' : 'newline', position: node.start + at });
      from = at + 1;
    }
    fragment(value.length);
    this.tokens.set(node, tokens);
    return tokens;
  }

  /** Find tab/newline boundaries once per immutable source range. */
  private hasControls(node: InlineTextNode): boolean {
    const cached = this.controlCache.get(node);
    if (cached !== undefined) return cached;
    if (node.kind === 'raw' && !node.flatten && this.asciiRange(node.start, node.end)) {
      this.controlCache.set(node, false);
      return false;
    }
    const frames: { node: InlineTextNode; next: number; found: boolean }[] = [
      { node, next: 0, found: false },
    ];
    while (frames.length) {
      const frame = frames[frames.length - 1];
      if (!frame) break;
      this.accounting.visits++;
      if (
        frame.node.kind === 'raw' &&
        !frame.node.flatten &&
        this.asciiRange(frame.node.start, frame.node.end)
      ) {
        this.controlCache.set(frame.node, false);
        frames.pop();
        if (!frames.length) return false;
        continue;
      }
      const split = frame.node.kind === 'raw' ? this.split(frame.node) : undefined;
      if (frame.node.kind !== 'concat' && !split) {
        const found =
          frame.node.kind === 'raw' && frame.node.flatten
            ? false
            : this.tokenize(frame.node).some((token) => token.kind !== 'fragment');
        this.controlCache.set(frame.node, found);
        frames.pop();
        const parent = frames[frames.length - 1];
        if (parent) parent.found ||= found;
        else return found;
        continue;
      }
      const parts = frame.node.kind === 'concat' ? frame.node.parts : (split ?? []);
      const part = frame.found ? undefined : parts[frame.next++];
      if (!part) {
        this.controlCache.set(frame.node, frame.found);
        frames.pop();
        const parent = frames[frames.length - 1];
        if (parent) parent.found ||= frame.found;
        else return frame.found;
        continue;
      }
      const known = this.controlCache.get(part);
      if (known !== undefined) frame.found ||= known;
      else frames.push({ node: part, next: 0, found: false });
    }
    return false;
  }

  private shortRawKey(node: InlineTextNode): string | undefined {
    if (node.kind !== 'raw' || node.end - node.start > 64) return undefined;
    const key = `${node.start}:${node.end}:${node.flatten ? 1 : 0}`;
    this.accounting.constructedUnits += key.length;
    return key;
  }

  private edge(node: InlineTextNode): { readonly first: string; readonly last: string } {
    const key = this.shortRawKey(node);
    const cached = this.edges.get(node) ?? (key ? this.rawEdges.get(key) : undefined);
    if (cached) return cached;
    const pending: InlineTextNode[] = [node];
    while (pending.length) {
      const part = pending[pending.length - 1];
      if (!part) break;
      this.accounting.visits++;
      if (this.edges.has(part)) {
        pending.pop();
        continue;
      }
      if (!part.renderLength) {
        this.edges.set(part, { first: '', last: '' });
        pending.pop();
        continue;
      }
      if (part.kind === 'text') {
        this.edges.set(part, {
          first: part.value[0] ?? '',
          last: part.value[part.value.length - 1] ?? '',
        });
        pending.pop();
      } else if (part.kind === 'raw') {
        if (!part.flatten && this.asciiRange(part.start, part.end)) {
          const value = { first: 'x', last: 'x' };
          this.edges.set(part, value);
          const rawKey = this.shortRawKey(part);
          if (rawKey) this.rawEdges.set(rawKey, value);
          pending.pop();
          continue;
        }
        const firstUnit = this.readSource(part.start, part.start + 1);
        const source = part.flatten
          ? this.readSource(part.start, part.end).replace(/[\t\n]+/g, ' ')
          : firstUnit + (part.end - part.start > 1 ? this.readSource(part.end - 1, part.end) : '');
        this.accounting.sourceUnits += part.flatten
          ? part.end - part.start + 1
          : Math.min(2, part.end - part.start);
        const value = { first: source[0] ?? '', last: source[source.length - 1] ?? '' };
        this.edges.set(part, value);
        const rawKey = this.shortRawKey(part);
        if (rawKey) this.rawEdges.set(rawKey, value);
        pending.pop();
      } else {
        let first: InlineTextNode | undefined, last: InlineTextNode | undefined;
        for (const child of part.parts) {
          this.accounting.visits++;
          if (child.renderLength) {
            first = child;
            break;
          }
        }
        for (let at = part.parts.length - 1; at >= 0; at--) {
          this.accounting.visits++;
          const child = part.parts[at];
          if (child?.renderLength) {
            last = child;
            break;
          }
        }
        if (!first || !last) {
          this.edges.set(part, { first: '', last: '' });
          pending.pop();
          continue;
        }
        const firstKey = this.shortRawKey(first),
          lastKey = this.shortRawKey(last);
        const left = this.edges.get(first) ?? (firstKey ? this.rawEdges.get(firstKey) : undefined),
          right = this.edges.get(last) ?? (lastKey ? this.rawEdges.get(lastKey) : undefined);
        if (!left) {
          pending.push(first);
          continue;
        }
        if (!right) {
          pending.push(last);
          continue;
        }
        this.edges.set(part, { first: left.first, last: right.last });
        pending.pop();
      }
    }
    return this.edges.get(node) ?? { first: '', last: '' };
  }

  private materializedWidth(node: InlineTextNode): number {
    const chunks: string[] = [];
    const pending = [node];
    while (pending.length) {
      const part = pending.pop();
      if (!part) break;
      this.accounting.visits++;
      if (part.kind === 'concat') {
        for (let at = part.parts.length - 1; at >= 0; at--) {
          const child = part.parts[at];
          if (child) pending.push(child);
        }
      } else if (part.kind === 'text') chunks.push(part.value);
      else {
        const source = this.readSource(part.start, part.end);
        this.accounting.sourceUnits += source.length;
        chunks.push(part.flatten ? source.replace(/[\t\n]+/g, ' ') : source);
      }
    }
    const value = chunks.join('');
    this.accounting.constructedUnits += value.length;
    this.accounting.measuredUnits += value.length;
    return displayWidth(value);
  }

  /** Index printable-ASCII source once; numeric pages avoid a heap item per unit. */
  private asciiRange(start: number, end: number): boolean {
    if (end > this.asciiIndexed) {
      const source = this.readSource(this.asciiIndexed, end);
      this.accounting.sourceUnits += source.length;
      for (let at = 0; at < source.length; at++) {
        this.accounting.visits++;
        const absolute = this.asciiIndexed + at;
        const pageNumber = Math.floor(absolute / ASCII_PAGE_SIZE);
        let page = this.asciiPages[pageNumber];
        if (!page) {
          page = new Uint32Array(ASCII_PAGE_SIZE);
          this.asciiPages[pageNumber] = page;
          this.accounting.constructedUnits += ASCII_PAGE_SIZE;
        }
        const unit = source.charCodeAt(at);
        if (unit < 0x20 || unit > 0x7e) this.nonAscii++;
        page[absolute % ASCII_PAGE_SIZE] = this.nonAscii;
      }
      this.asciiIndexed += source.length;
    }
    const prefix = (position: number): number => {
      if (position <= 0) return 0;
      const absolute = position - 1;
      return (
        this.asciiPages[Math.floor(absolute / ASCII_PAGE_SIZE)]?.[absolute % ASCII_PAGE_SIZE] ?? 0
      );
    };
    return end <= this.asciiIndexed && prefix(start) === prefix(end);
  }

  /**
   * The second of two literal backticks starts an independent grapheme under
   * Unicode GB999, after clearing the unbounded RI, Prepend, and ZWJ contexts.
   * Width is additive across that shared backtick: W(a + tt + b) =
   * W(a + tt) + W(t + b) - 1. Source intervals are indexed once; numeric
   * prefix widths let overlapping code bodies reuse their unchanged interiors.
   * Source is sanitized and immutable, so terminal escape sequences cannot
   * cross these boundaries or change after indexing.
   */
  private indexAnchors(end: number): void {
    if (end <= this.anchorIndexed) return;
    const source = this.readSource(this.anchorIndexed, end);
    this.accounting.sourceUnits += source.length;
    for (let at = 0; at < source.length; at++) {
      this.accounting.visits++;
      const position = this.anchorIndexed + at;
      const unit = source[at];
      if (unit === '\t' || unit === '\n') {
        this.previousTick = false;
        this.previousPivot = -1;
        this.anchorSegment++;
        this.anchorWidth = 0;
      } else if (unit !== '`') this.previousTick = false;
      else if (!this.previousTick) this.previousTick = true;
      else {
        if (this.anchorCount === this.anchorPositions.length) {
          const capacity = Math.max(64, this.anchorCount * 2);
          const positions = new Uint32Array(capacity);
          const widths = new Float64Array(capacity);
          const segments = new Uint32Array(capacity);
          positions.set(this.anchorPositions);
          widths.set(this.anchorWidths);
          segments.set(this.anchorSegments);
          this.accounting.constructedUnits += capacity * 3;
          this.anchorPositions = positions;
          this.anchorWidths = widths;
          this.anchorSegments = segments;
        }
        if (this.previousPivot >= 0) {
          const interval = this.readSource(this.previousPivot, position + 1);
          this.accounting.sourceUnits += interval.length;
          this.accounting.measuredUnits += interval.length;
          this.anchorWidth += displayWidth(interval) - 1;
        }
        this.anchorPositions[this.anchorCount] = position;
        this.anchorWidths[this.anchorCount] = this.anchorWidth;
        this.anchorSegments[this.anchorCount] = this.anchorSegment;
        this.anchorCount++;
        this.previousPivot = position;
        this.previousTick = false;
      }
      const pageNumber = Math.floor(position / ASCII_PAGE_SIZE);
      let page = this.anchorOrdinals[pageNumber];
      if (!page) {
        page = new Uint32Array(ASCII_PAGE_SIZE);
        this.anchorOrdinals[pageNumber] = page;
        this.accounting.constructedUnits += ASCII_PAGE_SIZE;
      }
      page[position % ASCII_PAGE_SIZE] = this.anchorCount;
    }
    this.anchorIndexed += source.length;
  }

  /** Number of completed anchors strictly before a source position. */
  private anchorLowerBound(position: number): number {
    this.accounting.visits++;
    if (position <= 0) return 0;
    const at = position - 1;
    return this.anchorOrdinals[Math.floor(at / ASCII_PAGE_SIZE)]?.[at % ASCII_PAGE_SIZE] ?? 0;
  }

  private rawAnchor(node: RawNode): AnchorSummary | null {
    if (node.flatten) return null;
    this.indexAnchors(node.end);
    const first = this.anchorLowerBound(node.start + 1);
    const last = this.anchorLowerBound(node.end) - 1;
    const firstPivot = this.anchorPositions[first],
      lastPivot = this.anchorPositions[last];
    if (
      first > last ||
      firstPivot === undefined ||
      lastPivot === undefined ||
      this.anchorSegments[first] !== this.anchorSegments[last]
    )
      return null;
    return {
      prefix: this.raw(node.start, firstPivot + 1),
      suffix: this.raw(lastPivot, node.end),
      middle: 1 + (this.anchorWidths[last] ?? 0) - (this.anchorWidths[first] ?? 0),
    };
  }

  private anchorSummary(node: InlineTextNode): AnchorSummary | null {
    const known = this.anchors.get(node);
    if (known !== undefined) return known;
    const frames: {
      node: InlineTextNode;
      next: number;
      summary: AnchorSummary | null;
      preceding: InlineTextNode[];
    }[] = [{ node, next: 0, summary: null, preceding: [] }];
    while (frames.length) {
      const frame = frames[frames.length - 1];
      if (!frame) break;
      this.accounting.visits++;
      const contiguous = this.contiguousRange(frame.node);
      if (contiguous && frame.node.kind === 'concat') {
        const raw = this.raw(contiguous[0], contiguous[1]);
        if (raw.kind === 'raw') this.anchors.set(frame.node, this.rawAnchor(raw));
        frames.pop();
        continue;
      }
      if (frame.node.kind !== 'concat') {
        this.anchors.set(frame.node, frame.node.kind === 'raw' ? this.rawAnchor(frame.node) : null);
        frames.pop();
        continue;
      }
      const part = frame.node.parts[frame.next];
      if (!part) {
        this.anchors.set(frame.node, frame.summary);
        frames.pop();
        continue;
      }
      const summary = this.anchors.get(part);
      if (summary === undefined) {
        frames.push({ node: part, next: 0, summary: null, preceding: [] });
        continue;
      }
      frame.next++;
      if (!frame.summary && !summary) frame.preceding.push(part);
      else if (!frame.summary && summary) {
        frame.summary = {
          prefix: this.concat([...frame.preceding, summary.prefix]),
          suffix: summary.suffix,
          middle: summary.middle,
        };
        frame.preceding = [];
      } else if (frame.summary && !summary) {
        frame.summary = { ...frame.summary, suffix: this.concat([frame.summary.suffix, part]) };
      } else if (frame.summary && summary) {
        const boundary = this.concat([frame.summary.suffix, summary.prefix]);
        frame.summary = {
          prefix: frame.summary.prefix,
          suffix: summary.suffix,
          middle: frame.summary.middle + this.width(boundary) + summary.middle - 2,
        };
      }
    }
    return this.anchors.get(node) ?? null;
  }

  private contiguousRange(node: InlineTextNode): readonly [number, number] | null {
    return this.contiguous.get(node) ?? null;
  }

  private contiguousKey(node: InlineTextNode): string | undefined {
    const range = this.contiguousRange(node);
    if (!range || range[1] - range[0] <= 64) return undefined;
    const key = `${range[0]}:${range[1]}`;
    this.accounting.constructedUnits += key.length;
    return key;
  }

  private knownWidth(node: InlineTextNode): number | undefined {
    const key = this.shortRawKey(node);
    const known = this.widths.get(node) ?? (key ? this.rawWidths.get(key) : undefined);
    if (known !== undefined) return known;
    const contiguous = this.contiguousKey(node);
    if (contiguous) {
      const width = getRecent(this.contiguousWidths, contiguous);
      if (width !== undefined) return width;
    }
    if (node.kind === 'concat' && node.parts.length === 2) {
      const first = node.parts[0],
        second = node.parts[1];
      if (first && second) return this.pairWidths.get(first)?.get(second);
    }
    return undefined;
  }

  private storeWidth(node: InlineTextNode, width: number): void {
    this.widths.set(node, width);
    const contiguous = this.contiguousKey(node);
    if (contiguous) putRecent(this.contiguousWidths, contiguous, width, RECENT_LIMIT);
    const key = this.shortRawKey(node);
    if (key) this.rawWidths.set(key, width);
    if (node.kind === 'concat' && node.parts.length === 2) {
      const first = node.parts[0],
        second = node.parts[1];
      if (first && second) {
        let entries = this.pairWidths.get(first);
        if (!entries) {
          entries = new WeakMap();
          this.pairWidths.set(first, entries);
        }
        entries.set(second, width);
      }
    }
  }

  private width(node: InlineTextNode): number {
    const known = this.knownWidth(node);
    if (known !== undefined) return known;
    const frames: {
      node: InlineTextNode;
      next: number;
      total: number;
      additive: boolean | undefined;
      parts: readonly InlineTextNode[] | undefined;
    }[] = [{ node, next: 0, total: 0, additive: undefined, parts: undefined }];
    while (frames.length) {
      const frame = frames[frames.length - 1];
      if (!frame) break;
      this.accounting.visits++;
      if (frame.additive === undefined && frame.node.kind === 'raw' && !frame.node.flatten) {
        const result = this.asciiRange(frame.node.start, frame.node.end)
          ? frame.node.end - frame.node.start
          : undefined;
        if (result !== undefined) {
          this.storeWidth(frame.node, result);
          frames.pop();
          const parent = frames[frames.length - 1];
          if (parent) parent.total += result;
          else return result;
          continue;
        }
      }
      if (frame.additive === undefined) {
        frame.parts =
          frame.node.kind === 'concat'
            ? frame.node.parts
            : frame.node.kind === 'raw'
              ? this.split(frame.node)
              : undefined;
        frame.additive = frame.parts !== undefined;
        if (frame.parts) {
          let previous = '';
          for (const part of frame.parts) {
            if (!part.renderLength) continue;
            const edge = this.edge(part);
            if (previous && !(/^[ -~]$/.test(previous) && /^[ -~]$/.test(edge.first))) {
              frame.additive = false;
              break;
            }
            previous = edge.last;
          }
        }
        if (!frame.additive) {
          const anchor = this.anchorSummary(frame.node);
          if (
            anchor &&
            anchor.prefix.renderLength < frame.node.renderLength &&
            anchor.suffix.renderLength < frame.node.renderLength
          ) {
            frame.parts = [anchor.prefix, anchor.suffix];
            frame.total = anchor.middle - 2;
            frame.additive = true;
          }
        }
        if (!frame.additive) {
          const result = this.materializedWidth(frame.node);
          this.storeWidth(frame.node, result);
          frames.pop();
          const parent = frames[frames.length - 1];
          if (parent) parent.total += result;
          else return result;
          continue;
        }
      }
      const part = frame.parts?.[frame.next++];
      if (!part) {
        this.storeWidth(frame.node, frame.total);
        frames.pop();
        const parent = frames[frames.length - 1];
        if (parent) parent.total += frame.total;
        else return frame.total;
        continue;
      }
      const result = this.knownWidth(part);
      if (result !== undefined) frame.total += result;
      else frames.push({ node: part, next: 0, total: 0, additive: undefined, parts: undefined });
    }
    return 0;
  }

  private scan(
    node: RawNode | TextNode,
    initial: State,
    from: number,
    to: number,
    tabs?: InlineTabSpace[],
  ): State {
    let state = initial;
    for (const token of this.tokenize(node)) {
      this.accounting.visits++;
      if (token.kind === 'fragment') {
        state = {
          ...state,
          pending: state.pending ? this.concat([state.pending, token.node]) : token.node,
        };
      } else {
        if (tabs && token.position >= to) break;
        if (token.kind === 'newline')
          state = {
            column: state.continuationColumn,
            continuationColumn: state.continuationColumn,
            pending: undefined,
          };
        else {
          const column = (state.column + (state.pending ? this.width(state.pending) : 0)) % 8;
          if (tabs && token.position >= from)
            tabs.push({ position: token.position, spaces: 8 - column });
          state = { column: 0, continuationColumn: state.continuationColumn, pending: undefined };
        }
      }
    }
    return state;
  }

  /** Compute a transition iteratively so deeply nested ropes do not use the JS call stack. */
  private advance(node: InlineTextNode, initial: State): State {
    const hit = this.cached(node, initial);
    if (hit) return hit;
    if (!this.hasControls(node)) {
      const result = {
        ...initial,
        pending: initial.pending ? this.concat([initial.pending, node]) : node,
      };
      this.remember(node, initial, result);
      return result;
    }
    const frames: Frame[] = [{ node, initial, state: initial, next: 0 }];
    while (frames.length) {
      const frame = frames[frames.length - 1];
      if (!frame) break;
      const split = frame.node.kind === 'raw' ? this.split(frame.node) : undefined;
      if (frame.node.kind !== 'concat' && !split) {
        const result = this.scan(frame.node, frame.initial, 0, 0);
        this.remember(frame.node, frame.initial, result);
        frames.pop();
        const parent = frames[frames.length - 1];
        if (parent) parent.state = result;
        else return result;
        continue;
      }
      const parts = frame.node.kind === 'concat' ? frame.node.parts : (split ?? []);
      const part = parts[frame.next++];
      if (!part) {
        this.accounting.visits++;
        this.remember(frame.node, frame.initial, frame.state);
        frames.pop();
        const parent = frames[frames.length - 1];
        if (parent) parent.state = frame.state;
        else return frame.state;
        continue;
      }
      const known = this.cached(part, frame.state);
      if (known) frame.state = known;
      else if (!this.hasControls(part)) {
        const result = {
          ...frame.state,
          pending: frame.state.pending ? this.concat([frame.state.pending, part]) : part,
        };
        this.remember(part, frame.state, result);
        frame.state = result;
      } else frames.push({ node: part, initial: frame.state, state: frame.state, next: 0 });
    }
    return initial;
  }

  /** Resolve tabs in a source interval while reusing cached prefix transitions. */
  tabSpaces(
    node: InlineTextNode,
    start: number,
    end: number,
    initialColumn = 0,
    continuationColumn = 0,
  ): readonly InlineTabSpace[] {
    let state: State = {
      column: Number.isFinite(initialColumn) ? ((Math.trunc(initialColumn) % 8) + 8) % 8 : 0,
      continuationColumn: Number.isFinite(continuationColumn)
        ? ((Math.trunc(continuationColumn) % 8) + 8) % 8
        : 0,
      pending: undefined,
    };
    const tabs: InlineTabSpace[] = [];
    const pending: InlineTextNode[] = [node];
    while (pending.length) {
      const current = pending.pop();
      if (!current) break;
      this.accounting.visits++;
      if (current.start >= end) continue;
      if (current.end <= start) {
        state = this.advance(current, state);
        continue;
      }
      const split = current.kind === 'raw' ? this.split(current) : undefined;
      if (current.kind === 'concat' || split) {
        const parts = current.kind === 'concat' ? current.parts : (split ?? []);
        for (let at = parts.length - 1; at >= 0; at--) {
          const part = parts[at];
          if (part) pending.push(part);
        }
      } else state = this.scan(current, state, start, end, tabs);
    }
    return tabs;
  }
}
