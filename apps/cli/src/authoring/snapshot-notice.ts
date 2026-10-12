import { types } from 'node:util';

import { parseTemplate } from '@relavium/core';
import { scrubSecrets } from '@relavium/llm';

import type { CliIo } from '../process/io.js';

const MAX_NODES = 4_096;
const MAX_DEPTH = 64;
const MAX_STRING_CHARS = 16_384;
const MAX_TOTAL_CHARS = 262_144;

/**
 * Best-effort notice for an already parsed authored definition, never resolved inputs. This
 * does not redact or certify the document: faithful snapshots and resume identity are retained.
 * The LLM scrubber owns the finite credential shapes; a changed string counts once, regardless
 * of how many matches it contains. Property names are scanned too, but never rendered.
 * Recognized bare references without paths or filters are projected to an already masked span
 * for the probe only, so e.g. Bearer {{secrets.token}} is not called a credential literal.
 * A reference that itself contains a recognized credential shape is never exempted.
 *
 * Work after property enumeration is bounded by nodes/depth/string budgets. Native record-key
 * enumeration itself is bounded by the callers' parser source ceiling, not by MAX_NODES.
 * Arrays use indexed descriptors, so sparse/huge lengths cannot allocate an all-keys list.
 * Only inert own enumerable data is visited; accessors, cycles, proxies and unfamiliar objects
 * cause an incomplete notice. Proxies are detected without invoking their traps.
 */
export function warnSnapshotLiterals(definition: unknown, io: Pick<CliIo, 'writeErr'>): void {
  const seen = new WeakSet<object>();
  let nodes = 0;
  let chars = 0;
  let matches = 0;
  let incomplete = false;

  function scanString(value: string): boolean {
    if (value.length > MAX_STRING_CHARS || chars + value.length > MAX_TOTAL_CHARS) {
      incomplete = true;
      return false;
    }
    chars += value.length;
    const probe = parseTemplate(value)
      .map((segment) => {
        if (segment.kind === 'literal') return segment.text;
        const reference = segment.reference;
        return reference.kind !== 'unknown' &&
          reference.path.length === 0 &&
          reference.filters.length === 0 &&
          scrubSecrets(reference.raw) === reference.raw
          ? '[REDACTED]'
          : reference.raw;
      })
      .join('');
    if (scrubSecrets(probe) !== probe) matches += 1;
    return true;
  }

  function visit(value: unknown, depth: number): void {
    if (nodes >= MAX_NODES) {
      incomplete = true;
      return;
    }
    nodes += 1;
    if (depth > MAX_DEPTH) {
      incomplete = true;
      return;
    }
    if (typeof value === 'string') {
      scanString(value);
      return;
    }
    if (value === null || typeof value !== 'object') return;
    if (types.isProxy(value) || seen.has(value)) {
      incomplete = true;
      return;
    }
    seen.add(value);
    const prototype: unknown = Object.getPrototypeOf(value);
    if (Array.isArray(value)) {
      if (prototype !== Array.prototype) {
        incomplete = true;
        return;
      }
      for (let index = 0; index < value.length; index += 1) {
        if (nodes >= MAX_NODES) {
          incomplete = true;
          break;
        }
        visitProperty(value, String(index), depth);
      }
    } else if (prototype === Object.prototype || prototype === null) {
      for (const key in value) {
        if (nodes >= MAX_NODES) {
          incomplete = true;
          break;
        }
        if (scanString(key)) {
          visitProperty(value, key, depth);
        } else {
          // Even an oversized key consumes a node; do not look up its descriptor/value.
          nodes += 1;
        }
      }
    } else {
      incomplete = true;
    }
  }

  function visitProperty(value: object, key: string, depth: number): void {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
      nodes += 1;
      incomplete = true;
      return;
    }
    const child: unknown = descriptor.value;
    visit(child, depth + 1);
  }

  visit(definition, 0);
  if (matches > 0) {
    io.writeErr(
      `Warning: authored definition has ${matches} string(s) matching known credential shapes. Authored content is preserved in files and run snapshots; review literals before sharing or running. This check is best effort.\n`,
    );
  }
  if (incomplete) {
    io.writeErr(
      'Warning: authored credential scan is incomplete (scan limit or unsupported structure). Review authored content before sharing or running; unexamined content may contain credentials.\n',
    );
  }
}
