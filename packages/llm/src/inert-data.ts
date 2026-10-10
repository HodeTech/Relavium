import { UnsupportedRequestDataError } from './errors.js';

// Only our own array serializer shadows are exempt from caller metadata refusal.
const generatedArrays = new WeakSet<object>();
// Only a fresh ordinary allocation proves the absence of native boxed/Date internal slots.
// Still inspect all descriptors/prototypes on reuse; mutable SDK records may gain unsafe data.
const generatedRecords = new WeakSet<object>();
// Intrinsic brand probes do not consult caller prototypes, getters or conversion hooks.
const unsupportedBrands: readonly unknown[] = [
  Object.getOwnPropertyDescriptor(Boolean.prototype, 'valueOf')?.value,
  Object.getOwnPropertyDescriptor(Number.prototype, 'valueOf')?.value,
  Object.getOwnPropertyDescriptor(String.prototype, 'valueOf')?.value,
  Object.getOwnPropertyDescriptor(BigInt.prototype, 'valueOf')?.value,
  Object.getOwnPropertyDescriptor(Symbol.prototype, 'valueOf')?.value,
  Object.getOwnPropertyDescriptor(Date.prototype, 'getTime')?.value,
];

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
function properties(source: object, omitted?: ReadonlySet<string>): readonly Property[] {
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
  if (!array && !generatedRecords.has(source)) {
    for (const probe of unsupportedBrands) {
      if (typeof probe !== 'function') refuse();
      let branded = false;
      try {
        Reflect.apply(probe, source, []);
        branded = true;
      } catch {
        // An incompatible receiver is the expected negative result of an intrinsic brand check.
      }
      if (branded) refuse();
    }
  }
  const ownSerializer = Object.getOwnPropertyDescriptor(source, 'toJSON');
  if (ownSerializer === undefined) inheritedSerializer(source);
  const length: unknown = array
    ? Object.getOwnPropertyDescriptor(source, 'length')?.value
    : undefined;
  if (
    array &&
    (typeof length !== 'number' || !Number.isInteger(length) || length < 0 || length > 0xffff_ffff)
  )
    refuse();
  const result: Property[] = [];
  let indices = 0;
  for (const key of Reflect.ownKeys(source)) {
    if (typeof key !== 'string' || key === '__proto__') refuse();
    // Only internal request/cap ownership supplies these descriptor-separated exceptions.
    if (omitted?.has(key)) continue;
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
        typeof length !== 'number' ||
        index >= length
      )
        refuse();
      indices += 1;
    }
    result.push({ key, value });
  }
  if (array && indices !== length) refuse();
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
  generatedRecords.add(target);
  return target;
}

/**
 * Iterative DFS with one memo across the graph. Active ancestors are cycles; completed aliases
 * reuse the same destination. No recursion, per-occurrence expansion or new size/depth policy.
 */
export function copyInertData(value: unknown, freeze: boolean = true): unknown {
  return copyData(value, freeze);
}

/**
 * Internal typed-root bridge. The caller seeds a typed target and delegates every data property
 * to the same graph traversal; no parser reconstructs fields or drops future request members.
 * Omitted descriptors must already have been inspected by their owning live-signal/cap authority.
 */
export function copyInertDataInto(
  value: object,
  target: object,
  freeze: boolean,
  omissions: ReadonlyMap<object, ReadonlySet<string>>,
  additions?: ReadonlyMap<object, Readonly<Record<string, unknown>>>,
  exceptionEdges?: ReadonlyMap<object, { readonly parent: object; readonly key: string }>,
  exceptionAliases?: Set<object>,
): void {
  Object.setPrototypeOf(target, null);
  copyData(value, freeze, omissions, target, additions, exceptionEdges, exceptionAliases);
}

function copyData(
  value: unknown,
  freeze: boolean,
  omissions?: ReadonlyMap<object, ReadonlySet<string>>,
  target?: object,
  additions?: ReadonlyMap<object, Readonly<Record<string, unknown>>>,
  exceptionEdges?: ReadonlyMap<object, { readonly parent: object; readonly key: string }>,
  exceptionAliases?: Set<object>,
): unknown {
  try {
    if (typeof value !== 'object' || value === null) {
      if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint')
        refuse();
      return value;
    }
    const root = target ?? container(value);
    const memo = new Map<object, object>([[value, root]]);
    const active = new Set<object>([value]);
    const inspectedAliases = new Set<object>();
    const frames: Frame[] = [
      {
        source: value,
        target: root,
        properties: properties(value, omissions?.get(value)),
        next: 0,
      },
    ];
    while (frames.length > 0) {
      const frame = frames[frames.length - 1];
      if (frame === undefined) refuse();
      const property = frame.properties[frame.next];
      if (property === undefined) {
        for (const [key, added] of Object.entries(additions?.get(frame.source) ?? {})) {
          Object.defineProperty(frame.target, key, {
            value: added,
            enumerable: true,
            writable: true,
            configurable: true,
          });
        }
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
        const edge = exceptionEdges?.get(child);
        if (
          edge !== undefined &&
          (edge.parent !== frame.source || edge.key !== property.key) &&
          !inspectedAliases.has(child)
        ) {
          // An exception belongs to a slot, not to the object's identity. An alias through
          // ordinary request data must satisfy the full inert domain without that privilege.
          copyInertData(child);
          inspectedAliases.add(child);
          exceptionAliases?.add(child);
        }
        const existing = memo.get(child);
        if (existing !== undefined) copied = existing;
        else {
          copied = container(child);
          // A destination is always an object here; keep the narrowing explicit.
          if (typeof copied !== 'object' || copied === null) refuse();
          memo.set(child, copied);
          active.add(child);
          next = {
            source: child,
            target: copied,
            properties: properties(child, omissions?.get(child)),
            next: 0,
          };
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
