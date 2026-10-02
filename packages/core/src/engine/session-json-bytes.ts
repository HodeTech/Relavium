import { utf8ByteLength } from '@relavium/shared';

type Frame =
  | { readonly kind: 'value'; readonly value: unknown }
  | { readonly kind: 'array'; readonly value: readonly unknown[]; index: number }
  | {
      readonly kind: 'object';
      readonly value: Record<string, unknown>;
      readonly keys: readonly string[];
      index: number;
      emitted: number;
    };

function isPlainObject(value: object): value is Record<string, unknown> {
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === null || prototype === Object.prototype;
}

function isOmitted(value: unknown): boolean {
  return value === undefined || typeof value === 'function' || typeof value === 'symbol';
}

/**
 * Native JSON encoding for the ordinary case; an iterative count for deeply nested plain JSON data.
 * JSON.parse accepts nesting that JSON.stringify cannot traverse on the JavaScript call stack. Model
 * metadata must not turn that valid input into a failed correction. The fallback keeps only a depth
 * stack and ancestor set, never a serialized copy; native encoding still owns primitive/key escaping.
 * Exotic objects and custom toJSON hooks are handled by the native path, not reimplemented here.
 */
export function sessionJsonBytes(value: unknown): number | undefined {
  try {
    return utf8ByteLength(JSON.stringify(value) ?? '');
  } catch {
    try {
      return countPlainJson(value);
    } catch {
      return undefined;
    }
  }
}

function countPlainJson(value: unknown): number | undefined {
  const stack: Frame[] = [{ kind: 'value', value }];
  const ancestors = new Set<object>();
  let bytes = 0;
  while (stack.length > 0) {
    const frame = stack[stack.length - 1];
    if (frame === undefined) break;
    if (frame.kind === 'array') {
      if (frame.index === frame.value.length) {
        ancestors.delete(frame.value);
        stack.pop();
      } else {
        if (frame.index > 0) bytes += 1;
        const child: unknown = frame.value[frame.index];
        frame.index += 1;
        stack.push({ kind: 'value', value: isOmitted(child) ? null : child });
      }
      continue;
    }
    if (frame.kind === 'object') {
      const key = frame.keys[frame.index];
      if (key === undefined) {
        ancestors.delete(frame.value);
        stack.pop();
      } else {
        frame.index += 1;
        const child = frame.value[key];
        if (isOmitted(child)) continue;
        if (frame.emitted > 0) bytes += 1;
        frame.emitted += 1;
        bytes += utf8ByteLength(JSON.stringify(key)) + 1;
        stack.push({ kind: 'value', value: child });
      }
      continue;
    }
    stack.pop();
    const child = frame.value;
    if (typeof child !== 'object' || child === null) {
      bytes += utf8ByteLength(JSON.stringify(child) ?? '');
      continue;
    }
    if (ancestors.has(child)) return undefined;
    if ('toJSON' in child && typeof child.toJSON === 'function') return undefined;
    ancestors.add(child);
    bytes += 2; // Opening and closing delimiters; children supply separators.
    if (Array.isArray(child)) {
      stack.push({ kind: 'array', value: child, index: 0 });
    } else {
      if (!isPlainObject(child)) return undefined;
      stack.push({ kind: 'object', value: child, keys: Object.keys(child), index: 0, emitted: 0 });
    }
  }
  return Number.isSafeInteger(bytes) ? bytes : undefined;
}
