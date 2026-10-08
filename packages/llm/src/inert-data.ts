import { UnsupportedRequestDataError } from './errors.js';

// Only our own array serializer shadows are exempt from caller metadata refusal.
const generatedArrays = new WeakSet<object>();

interface Property {
  readonly key: string;
  readonly value: unknown;
}

interface Frame {
  readonly source: object;
  readonly target: object;
  readonly properties: readonly Property[];
  next: number;
}

function refuse(): never {
  throw new UnsupportedRequestDataError();
}

function inheritedSerializer(source: object): void {
  let prototype: unknown = Object.getPrototypeOf(source);
  while (typeof prototype === 'object' && prototype !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, 'toJSON');
    if (descriptor !== undefined) {
      if (!('value' in descriptor) || typeof descriptor.value === 'function') refuse();
      return;
    }
    prototype = Object.getPrototypeOf(prototype);
  }
}

/** Inspect data descriptors only. Map/Set entries retain their existing ignored JSON semantics. */
function properties(source: object): readonly Property[] {
  const array = Array.isArray(source);
  const prototype: unknown = Object.getPrototypeOf(source);
  if (
    array
      ? prototype !== Array.prototype
      : prototype !== null &&
        prototype !== Object.prototype &&
        prototype !== Map.prototype &&
        prototype !== Set.prototype
  )
    refuse();
  const ownSerializer = Object.getOwnPropertyDescriptor(source, 'toJSON');
  if (ownSerializer === undefined) inheritedSerializer(source);
  const result: Property[] = [];
  let indices = 0;
  for (const key of Reflect.ownKeys(source)) {
    if (typeof key !== 'string' || key === '__proto__') refuse();
    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    if (descriptor === undefined || !('value' in descriptor)) refuse();
    const value: unknown = descriptor.value;
    if (array && key === 'length') continue;
    if (
      array &&
      generatedArrays.has(source) &&
      key === 'toJSON' &&
      descriptor.enumerable === false &&
      value === undefined
    )
      continue;
    if (!descriptor.enumerable || (key === 'toJSON' && typeof value === 'function')) refuse();
    if (array) {
      const index = Number(key);
      if (
        !Number.isSafeInteger(index) ||
        index < 0 ||
        String(index) !== key ||
        index >= source.length
      )
        refuse();
      indices += 1;
    }
    result.push({ key, value });
  }
  if (array && indices !== source.length) refuse();
  return result;
}

function container(source: object): object {
  if (Array.isArray(source)) {
    const target: unknown[] = [];
    Object.defineProperty(target, 'toJSON', { value: undefined, enumerable: false });
    generatedArrays.add(target);
    return target;
  }
  const target: Record<string, unknown> = {};
  Object.setPrototypeOf(target, null);
  return target;
}

/**
 * Iterative DFS with one memo across the graph. Active ancestors are cycles; completed aliases
 * reuse the same destination. No recursion, per-occurrence expansion or new size/depth policy.
 */
export function copyInertData(value: unknown, freeze: boolean = true): unknown {
  try {
    if (typeof value !== 'object' || value === null) {
      if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint')
        refuse();
      return value;
    }
    const root = container(value);
    const memo = new Map<object, object>([[value, root]]);
    const active = new Set<object>([value]);
    const frames: Frame[] = [
      { source: value, target: root, properties: properties(value), next: 0 },
    ];
    while (frames.length > 0) {
      const frame = frames[frames.length - 1];
      if (frame === undefined) refuse();
      const property = frame.properties[frame.next];
      if (property === undefined) {
        if (freeze) Object.freeze(frame.target);
        active.delete(frame.source);
        frames.pop();
        continue;
      }
      frame.next += 1;
      const child = property.value;
      let copied: unknown = child;
      let next: Frame | undefined;
      if (typeof child === 'object' && child !== null) {
        if (active.has(child)) refuse();
        const existing = memo.get(child);
        if (existing !== undefined) copied = existing;
        else {
          copied = container(child);
          // A destination is always an object here; keep the narrowing explicit.
          if (typeof copied !== 'object' || copied === null) refuse();
          memo.set(child, copied);
          active.add(child);
          next = { source: child, target: copied, properties: properties(child), next: 0 };
        }
      } else if (
        typeof child === 'function' ||
        typeof child === 'symbol' ||
        typeof child === 'bigint'
      )
        refuse();
      Object.defineProperty(frame.target, property.key, {
        value: copied,
        enumerable: true,
        writable: true,
        configurable: true,
      });
      if (next !== undefined) frames.push(next);
    }
    return root;
  } catch {
    // Proxy traps and descriptors may throw private content. Keep neither message nor cause.
    throw new UnsupportedRequestDataError();
  }
}
