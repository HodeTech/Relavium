import { LineCounter } from 'yaml';

import { decodeHardenedYaml } from '../yaml-decode.js';

/**
 * The session a workflow file was exported from, read back from the marker {@link sessionToWorkflow} writes:
 * `workflow.metadata.relaviumExport` with `source: 'session'` and a string `sessionId`. Anything else — a file that
 * does not decode, a hand-authored workflow, a marker of another shape — is `undefined`.
 *
 * It decodes with the one hardened profile every authored-YAML parser shares (ADR-0035) and does NOT validate the
 * workflow, on purpose: an export whose historical agent snapshot no longer passes validation is still that
 * session's export. The caller bounds the text's size before calling. Pure: no I/O.
 *
 * [sessionToWorkflow]: ./serializer.ts
 */
export function readSessionExportMarker(yamlText: string): string | undefined {
  let document: unknown;
  try {
    document = decodeHardenedYaml(yamlText, new LineCounter());
  } catch {
    return undefined;
  }
  const marker = field(field(field(document, 'workflow'), 'metadata'), 'relaviumExport');
  if (field(marker, 'source') !== 'session') return undefined;
  const sessionId = field(marker, 'sessionId');
  return typeof sessionId === 'string' ? sessionId : undefined;
}

/** `value[key]` when `value` is a plain mapping with `key` as an own data property; `undefined` otherwise. */
function field(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined || !('value' in descriptor)) return undefined;
  const found: unknown = descriptor.value;
  return found;
}
