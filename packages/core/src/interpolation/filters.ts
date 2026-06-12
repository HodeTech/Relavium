/**
 * The pipe-filter registry (1.L2) — `| json`, `| length`, `| default(…)`, `| read_file`
 * (workflow-yaml-spec.md §Context-and-interpolation). Each filter is a pure transform over the value
 * resolved so far, except `read_file`, which calls the host-injected `readFile` capability so the
 * engine never imports `node:fs` (CLAUDE.md rule 5). A bad filter name, wrong arity, or wrong input
 * type fails with a typed, secret-free {@link InterpolationError} — never a thrown string or a crash.
 *
 * Filters are deterministic given their input (and, for `read_file`, a deterministic host reader), so
 * a re-resolved scope is identical — the property the checkpoint/idempotency model (1.R) relies on.
 */

import type { AbortSignalLike } from '@relavium/shared';

import { InterpolationError } from '../errors.js';

import type { ResolverCapabilities } from './scope.js';
import type { FilterArg, InterpolationReference, PipeFilter } from './references.js';

/**
 * A filter: the value so far, its parsed args, the host capabilities, the source ref (for errors), and
 * an optional `AbortSignal` (only `read_file` honors it). The result is `unknown` (which already
 * subsumes `Promise<unknown>`); the resolver `await`s it, so a filter may be sync (`json`/`length`/
 * `default`) or async (`read_file`).
 */
export type FilterFn = (
  value: unknown,
  args: readonly FilterArg[],
  caps: ResolverCapabilities,
  ref: InterpolationReference,
  signal?: AbortSignalLike,
) => unknown;

const FILTERS: Readonly<Record<string, FilterFn>> = {
  /** Serialize the value as pretty JSON — the supported way to embed an object/array in text. */
  json: (value, args, _caps, ref) => {
    requireArity('json', args, 0, ref);
    let serialized: string | undefined;
    try {
      serialized = JSON.stringify(value, null, 2);
    } catch (err) {
      // A circular structure or a BigInt makes JSON.stringify throw a raw TypeError whose message can
      // embed value-shape detail — keep it on `cause` for logs and surface a typed, secret-free error.
      throw new InterpolationError(
        'unserializable',
        `\`${ref.raw}\` could not be serialized as JSON`,
        {
          location: ref.raw,
          cause: err,
        },
      );
    }
    if (serialized === undefined) {
      // `undefined`, a function, or a lone symbol — there is nothing meaningful to embed.
      throw filterType('json', 'a JSON-serializable value', ref);
    }
    return serialized;
  },

  /** The count of a string's UTF-16 code units, an array's items, or an object's own keys. */
  length: (value, args, _caps, ref) => {
    requireArity('length', args, 0, ref);
    if (typeof value === 'string' || Array.isArray(value)) {
      return value.length;
    }
    if (typeof value === 'object' && value !== null) {
      return Object.keys(value).length;
    }
    throw filterType('length', 'a string, list, or object', ref);
  },

  /** Substitute a literal when the value resolved to nothing (`undefined`/`null`); else pass it through. */
  default: (value, args, _caps, ref) => {
    requireArity('default', args, 1, ref);
    if (value === undefined || value === null) {
      return (args[0] as FilterArg).value;
    }
    return value;
  },

  /** Read a workspace file's text via the host `readFile` capability (the engine never touches disk). */
  read_file: async (value, args, caps, ref, signal) => {
    requireArity('read_file', args, 0, ref);
    if (typeof value !== 'string') {
      throw filterType('read_file', 'a file path string', ref);
    }
    if (caps.readFile === undefined) {
      throw new InterpolationError(
        'read_file_unavailable',
        `the \`read_file\` filter needs a host file reader, which this run did not provide`,
        { location: ref.raw },
      );
    }
    try {
      return await caps.readFile(value, signal);
    } catch (err) {
      if (signal?.aborted === true || isAbortError(err)) {
        // A cancelled read is not an I/O failure — surface it as the run-wide abort, not read_file_failed.
        throw new InterpolationError('aborted', `\`read_file\` was aborted`, {
          location: ref.raw,
          cause: err,
        });
      }
      // The authored path / host error (which may carry an absolute path) stays on `cause` for logs;
      // the user-facing message names only the reference, never the path value.
      throw new InterpolationError('read_file_failed', `\`read_file\` could not read the file`, {
        location: ref.raw,
        cause: err,
      });
    }
  },
};

/** Look up a filter by name, or throw a typed `unknown_filter` error naming the offending reference. */
export function filterFn(filter: PipeFilter, ref: InterpolationReference): FilterFn {
  // `Object.hasOwn` so an inherited member of the registry object (`toString`, `constructor`,
  // `__proto__`) is never mistaken for a filter — a bare `FILTERS[name]` would return
  // `Object.prototype.toString` for `| toString` and then invoke it.
  const fn = Object.hasOwn(FILTERS, filter.name) ? FILTERS[filter.name] : undefined;
  if (fn === undefined) {
    throw new InterpolationError('unknown_filter', `unknown filter \`${filter.name}\``, {
      location: ref.raw,
    });
  }
  return fn;
}

function requireArity(
  name: string,
  args: readonly FilterArg[],
  arity: number,
  ref: InterpolationReference,
): void {
  if (args.length !== arity) {
    const expected = arity === 1 ? '1 argument' : `${arity} arguments`;
    throw new InterpolationError(
      'filter_arity',
      `filter \`${name}\` expects ${expected}, got ${args.length}`,
      { location: ref.raw },
    );
  }
}

function filterType(
  name: string,
  expected: string,
  ref: InterpolationReference,
): InterpolationError {
  return new InterpolationError('filter_type', `filter \`${name}\` expects ${expected}`, {
    location: ref.raw,
  });
}

/**
 * Whether a thrown value is a standard cancellation (`AbortError` from a host reader honoring a signal).
 * Checks the `name` structurally rather than via `instanceof Error`, because in the Tauri WebView a
 * `DOMException('…','AbortError')` is not an `Error` instance (CLAUDE.md rule 5 — the engine runs there).
 */
function isAbortError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'name' in err &&
    (err as { name?: unknown }).name === 'AbortError'
  );
}
