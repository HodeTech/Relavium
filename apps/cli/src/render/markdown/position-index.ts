interface PositionBranch<T> {
  readonly branches: Map<number, PositionBranch<T>>;
  readonly values: Map<number, T>;
  readonly bits: Uint32Array;
  readonly version: number;
  count: number;
  nodes: number;
  revision: number;
}
let positionVersion = 0;

/** Seven fixed byte levels cover every safe integer UTF-16 source offset. */
export class PositionIndex<T extends NonNullable<unknown>> {
  private version = ++positionVersion;
  private root: PositionBranch<T> = this.branch();
  private measured = 0;
  private readonly accounting: { visits: number } | undefined;
  private entries = 0;

  constructor(accounting?: { visits: number }) {
    this.accounting = accounting;
  }

  get visits(): number {
    return this.measured;
  }
  set visits(value: number) {
    if (this.accounting) this.accounting.visits += value - this.measured;
    this.measured = value;
  }
  get size(): number {
    return this.entries;
  }
  get retained(): number {
    return this.root.nodes;
  }

  private branch(): PositionBranch<T> {
    return {
      branches: new Map(),
      values: new Map(),
      bits: new Uint32Array(8),
      version: this.version,
      count: 0,
      nodes: 1,
      revision: 0,
    };
  }

  private own(node: PositionBranch<T>): PositionBranch<T> {
    if (node.version === this.version) return node;
    this.visits += node.branches.size + node.values.size + 8;
    return {
      branches: new Map(node.branches),
      values: new Map(node.values),
      bits: node.bits.slice(),
      version: this.version,
      count: node.count,
      nodes: node.nodes,
      revision: node.revision,
    };
  }

  snapshot(): PositionIndex<T> {
    const copy = new PositionIndex<T>(this.accounting);
    copy.root = this.root;
    copy.entries = this.entries;
    this.version = ++positionVersion;
    return copy;
  }

  replaceRange(start: number, end: number, source: PositionIndex<T>): void {
    if (start >= end) return;
    // Borrowed branches become immutable in BOTH versions. Future source writes
    // must copy too, just as future destination writes copy foreign branches.
    source.version = ++positionVersion;
    const replace = (
      current: PositionBranch<T> | undefined,
      incoming: PositionBranch<T> | undefined,
      level: number,
      prefix: number,
    ): PositionBranch<T> | undefined => {
      this.visits++;
      const size = 256 ** (level + 1);
      if (prefix >= end || prefix + size <= start) return current;
      if (start <= prefix && prefix + size <= end) return incoming;
      const result = current ? this.own(current) : this.branch();
      for (let byte = 0; byte < 256; byte++) {
        const lower = prefix + byte * 256 ** level;
        if (lower >= end) break;
        if (lower + 256 ** level <= start) continue;
        this.visits++;
        const word = byte >>> 5;
        if (!level) {
          const old = result.values.has(byte);
          if (incoming?.values.has(byte)) {
            const value = incoming.values.get(byte);
            if (value !== undefined) result.values.set(byte, value);
            result.bits[word] = (result.bits[word] ?? 0) | (1 << (byte & 31));
            if (!old) result.count++;
          } else if (old) {
            result.values.delete(byte);
            result.bits[word] = (result.bits[word] ?? 0) & ~(1 << (byte & 31));
            result.count--;
          }
        } else {
          const old = result.branches.get(byte);
          const oldCount = old?.count ?? 0;
          const oldNodes = old?.nodes ?? 0;
          const child = replace(old, incoming?.branches.get(byte), level - 1, lower);
          result.count += (child?.count ?? 0) - oldCount;
          result.nodes += (child?.nodes ?? 0) - oldNodes;
          if (child?.count) {
            result.branches.set(byte, child);
            result.bits[word] = (result.bits[word] ?? 0) | (1 << (byte & 31));
          } else {
            result.branches.delete(byte);
            result.bits[word] = (result.bits[word] ?? 0) & ~(1 << (byte & 31));
          }
        }
      }
      result.revision++;
      return result.count ? result : undefined;
    };
    this.root = replace(this.root, source.root, 6, 0) ?? this.branch();
    this.entries = this.root.count;
  }

  private byte(position: number, level: number): number {
    return Math.floor(position / 256 ** level) % 256;
  }

  set(position: number, value: T): void {
    this.root = this.own(this.root);
    let node = this.root;
    const path: PositionBranch<T>[] = [];
    for (let level = 6; level >= 0; level--) {
      this.visits++;
      const byte = this.byte(position, level);
      path.push(node);
      const word = byte >>> 5;
      node.bits[word] = (node.bits[word] ?? 0) | (1 << (byte & 31));
      if (!level) {
        if (!node.values.has(byte)) {
          this.entries++;
          for (const ancestor of path) ancestor.count++;
        }
        node.values.set(byte, value);
        for (const ancestor of path) {
          this.visits++;
          ancestor.revision++;
        }
      } else {
        let child = node.branches.get(byte);
        if (!child) {
          child = this.branch();
          node.branches.set(byte, child);
          for (const ancestor of path) {
            this.visits++;
            ancestor.nodes++;
          }
        } else {
          child = this.own(child);
          node.branches.set(byte, child);
        }
        node = child;
      }
    }
  }

  delete(position: number): void {
    const path: { node: PositionBranch<T>; byte: number }[] = [];
    this.root = this.own(this.root);
    let node = this.root;
    for (let level = 6; level >= 0; level--) {
      this.visits++;
      const byte = this.byte(position, level);
      path.push({ node, byte });
      if (!level) {
        if (!node.values.delete(byte)) return;
        this.entries--;
        for (const ancestor of path) {
          this.visits++;
          ancestor.node.count--;
          ancestor.node.revision++;
        }
      } else {
        let child = node.branches.get(byte);
        if (!child) return;
        child = this.own(child);
        node.branches.set(byte, child);
        node = child;
      }
    }
    for (let at = path.length - 1; at >= 0; at--) {
      const entry = path[at];
      if (!entry) break;
      entry.node.bits[entry.byte >>> 5] =
        (entry.node.bits[entry.byte >>> 5] ?? 0) & ~(1 << (entry.byte & 31));
      if (at === path.length - 1) entry.node.values.delete(entry.byte);
      else {
        const removed = entry.node.branches.get(entry.byte)?.nodes ?? 0;
        entry.node.branches.delete(entry.byte);
        for (let ancestor = 0; ancestor <= at; ancestor++) {
          this.visits++;
          const parent = path[ancestor];
          if (parent) parent.node.nodes -= removed;
        }
      }
      if (entry.node.bits.some((word) => word !== 0)) break;
    }
  }

  /** Count positions in a half-open interval using whole-subtree summaries. */
  countRange(start: number, end: number): number {
    if (start >= end) return 0;
    const count = (node: PositionBranch<T>, level: number, prefix: number): number => {
      this.visits++;
      const size = 256 ** (level + 1);
      if (prefix >= end || prefix + size <= start) return 0;
      if (start <= prefix && prefix + size <= end) return node.count;
      let total = 0;
      for (let byte = 0; byte < 256; byte++) {
        this.visits++;
        const lower = prefix + byte * 256 ** level;
        if (lower >= end) break;
        if (lower + 256 ** level <= start) continue;
        if (!level) total += node.values.has(byte) ? 1 : 0;
        else {
          const child = node.branches.get(byte);
          if (child) total += count(child, level - 1, lower);
        }
      }
      return total;
    };
    return count(this.root, 6, 0);
  }

  /**
   * Create once for an associative immutable aggregate. The returned reader
   * shares unchanged branch summaries across versions. Value mutations require
   * set(key, value) even when object identity stays the same; snapshots share
   * value references, so callers retain immutable values for persistent reads.
   * Traversal is measured here; map/combine account for their own work.
   */
  createFold<U>(
    map: (value: T) => U,
    combine: (left: U, right: U) => U,
    empty: U,
  ): (version: PositionIndex<T>) => U {
    const cache = new WeakMap<PositionBranch<T>, { revision: number; value: U }>();
    return (version) => {
      const read = (node: PositionBranch<T>, level: number): U => {
        version.visits++;
        const saved = cache.get(node);
        if (saved?.revision === node.revision) return saved.value;
        let value = empty;
        for (let word = 0; word < 8; word++) {
          version.visits++;
          let bits = node.bits[word] ?? 0;
          while (bits !== 0) {
            version.visits++;
            const bit = 31 - Math.clz32(bits & -bits);
            const byte = word * 32 + bit;
            if (!level) {
              const entry = node.values.get(byte);
              if (entry !== undefined) value = combine(value, map(entry));
            } else {
              const child = node.branches.get(byte);
              if (child) value = combine(value, read(child, level - 1));
            }
            bits &= bits - 1;
          }
        }
        cache.set(node, { revision: node.revision, value });
        return value;
      };
      return read(version.root, 6);
    };
  }

  private greatest(bits: Uint32Array, maximum: number): number {
    if (maximum < 0) return -1;
    let word = maximum >>> 5;
    const bit = maximum & 31;
    let value = (bits[word] ?? 0) & (bit === 31 ? 0xffffffff : 2 ** (bit + 1) - 1);
    for (; word >= 0; word--) {
      this.visits++;
      if (value) return word * 32 + 31 - Math.clz32(value);
      value = bits[word - 1] ?? 0;
    }
    return -1;
  }

  floor(position: number): T | undefined {
    const find = (node: PositionBranch<T>, level: number, limited: boolean): T | undefined => {
      let byte = this.greatest(node.bits, limited ? this.byte(position, level) : 255);
      while (byte >= 0) {
        this.visits++;
        if (!level) return node.values.get(byte);
        const child = node.branches.get(byte);
        if (!child) return undefined;
        const value = find(child, level - 1, limited && byte === this.byte(position, level));
        if (value !== undefined) return value;
        byte = this.greatest(node.bits, byte - 1);
      }
      return undefined;
    };
    return find(this.root, 6, true);
  }

  private least(bits: Uint32Array, minimum: number): number {
    if (minimum > 255) return -1;
    let word = minimum >>> 5;
    let value = (bits[word] ?? 0) & (0xffffffff << (minimum & 31));
    for (; word < 8; word++) {
      this.visits++;
      if (value) return word * 32 + 31 - Math.clz32(value & -value);
      value = bits[word + 1] ?? 0;
    }
    return -1;
  }

  ceiling(position: number): T | undefined {
    const find = (node: PositionBranch<T>, level: number, limited: boolean): T | undefined => {
      let byte = this.least(node.bits, limited ? this.byte(position, level) : 0);
      while (byte >= 0) {
        this.visits++;
        if (!level) return node.values.get(byte);
        const child = node.branches.get(byte);
        if (!child) return undefined;
        const value = find(child, level - 1, limited && byte === this.byte(position, level));
        if (value !== undefined) return value;
        byte = this.least(node.bits, byte + 1);
      }
      return undefined;
    };
    return find(this.root, 6, true);
  }
}
