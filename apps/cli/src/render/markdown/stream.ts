import { parseInline } from './inline.js';
import { layoutMarkdown } from './layout.js';
import { parseMarkdown } from './parser.js';
import type { MarkdownBlock, MarkdownDisplayLine, MarkdownSpan } from './types.js';

const LIVE_SOURCE_LIMIT = 4_000;
const TABLE_SOURCE_LIMIT = 65_536;
const TAIL_CONTEXT = 64;
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

function sourceTail(source: string, limit = LIVE_SOURCE_LIMIT): string {
  if (source.length <= limit) return source;
  const window = source.slice(-limit - TAIL_CONTEXT);
  const minimum = window.length - limit;
  for (const cluster of graphemes.segment(window)) {
    if (cluster.index >= minimum) return window.slice(cluster.index);
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
  let remaining = limit + TAIL_CONTEXT;
  const result: MarkdownSpan[] = [];
  for (let i = spans.length - 1; i >= 0 && remaining > 0; i--) {
    const span = spans[i];
    if (!span) continue;
    const text = span.text.slice(-remaining);
    remaining -= text.length;
    result.push({ ...span, text });
  }
  result.reverse();
  const text = result.map((span) => span.text).join('');
  let omit = text.length - sourceTail(text, limit).length;
  const clipped: MarkdownSpan[] = [];
  for (const span of result) {
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
  private escaped = false;
  work = 0;

  reset(): void {
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
    this.escaped = false;
  }

  append(source: string, offset: number): void {
    for (let i = 0; i < source.length; i++) {
      this.work++;
      const character = source[i] ?? '';
      const position = offset + i;
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
    const cutoff = offset + source.length - LIVE_SOURCE_LIMIT;
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

  private linkCharacter(character: string, position: number): void {
    if (!this.escaped && character === '<') {
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
        if (valid && target)
          this.links.push({
            start: link.start,
            image: link.image,
            labelEnd: link.labelEnd,
            targetStart: link.targetStart,
            finish: position + 1,
            target,
          });
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
        this.matches.push({ ...open, close: start, finish: start + length });
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
        const candidate = { marker: '`', start, end: start + length };
        this.ticks.set(length, candidate);
        this.tickStack.push(candidate);
      }
      return;
    }
    if (character === '~' && length < 2) return;
    if (character === '_' && /[\p{L}\p{N}]/u.test(this.beforeRun) && /[\p{L}\p{N}]/u.test(next))
      return;
    let used = 0;
    while (used < length) {
      this.work++;
      const count = length - used >= 2 ? 2 : 1;
      if (character === '~' && count === 1) break;
      const marker = character.repeat(count);
      const at = start + used;
      const open = this.pending.get(marker);
      if (open && at > open.end) {
        this.matches.push({ ...open, close: at, finish: at + count });
        for (const [key, candidate] of this.pending) {
          this.work++;
          if (candidate.start >= open.start) this.pending.delete(key);
        }
      } else if (!open && this.pending.size < 32) {
        this.pending.set(marker, { marker, start: at, end: at + count });
      }
      used += count;
    }
  }

  /** No source mutation: a trailing run is only classified when its next byte arrives. */
  project(source: string, offset: number): MarkdownSpan[] {
    const trailing: Match[] = [];
    if (this.runCharacter === '`') {
      const open = this.ticks.get(this.runLength);
      if (open)
        trailing.push({ ...open, close: this.runStart, finish: this.runStart + this.runLength });
    } else if (this.runLength) {
      const marker = this.runCharacter.repeat(this.runLength > 1 ? 2 : 1);
      const open = this.pending.get(marker);
      if (open && this.runStart > open.end)
        trailing.push({ ...open, close: this.runStart, finish: this.runStart + marker.length });
    }
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
        const text = source.slice(start - offset, link.finish - offset - 1);
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
        // Preserve both the link and delimiters inside its clipped label. The
        // complete target is already in this bounded suffix and stays visible.
        return parseInline(
          prefix +
            (link.image ? '![' : '[') +
            labelPrefix +
            '\0' +
            source.slice(labelStart - offset),
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
    return withPrefix(prefix, source.slice(start - offset));
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
  private inline = new InlineCheckpoint();
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
    this.clippedSource ??= sourceTail(this.sourceWindow);
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

  append(chunk: string): void {
    if (!chunk) return;
    const initialOffset = this.sourceLength;
    this.source.push(chunk);
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
        this.completeLine(line, initialOffset + i - line.length);
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
        source: sourceTail(block.source),
        text: sourceTail(block.text),
      };
    } else {
      this.semanticWork += block.text.length;
      const spans = clippedSpans(parseInline(block.text), LIVE_SOURCE_LIMIT);
      preview = {
        ...block,
        source: sourceTail(block.source),
        text: spans.map((span) => span.text).join(''),
        spans,
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
        const parsed = [...parseMarkdown(pending)];
        if (this.pendingSize > LIVE_SOURCE_LIMIT) {
          // The first visible line may start in a paragraph, heading or list.
          // Inline history is projected before the bounded geometry pass.
          let first = parsed[0];
          if (this.completed.length <= 1 && !pending.includes('\n')) {
            const original = parseMarkdown((this.completed[0] ?? this.linePrefix).slice(0, 256))[0];
            if (
              original &&
              (original.kind === 'heading' ||
                original.kind === 'list' ||
                original.kind === 'quote' ||
                original.kind === 'literal')
            )
              first = { ...original, source: pending, text: pending };
          }
          if (
            first &&
            first.kind !== 'literal' &&
            first.kind !== 'table' &&
            first.kind !== 'code' &&
            first.kind !== 'rule'
          ) {
            const spans = this.inline.project(first.text, this.sourceLength - pending.length);
            parsed[0] = { ...first, spans };
          }
        }
        blocks.push(
          ...parsed.map((block) => (block.kind === 'table' ? literal(block.source) : block)),
        );
      }
    }
    const stableLines = selected.flatMap((preview) => {
      if (preview.layout?.columns !== columns)
        preview.layout = { columns, lines: layoutMarkdown([preview.block], columns) };
      return preview.layout.lines;
    });
    const laidOut = [...stableLines, ...layoutMarkdown(blocks, columns)];
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
    this.inline = new InlineCheckpoint();
    this.cached = undefined;
    this.generation++;
    this.blockWork = 0;
    this.semanticWork = 0;
    this.lineWork = 0;
  }
}
