/**
 * Size bounds at the durable boundary (`CR-32`,
 * [ADR-0086](../../../../docs/decisions/0086-absolute-admission-ceilings-on-authored-values.md)).
 *
 * Three quantities were unbounded, and each fails differently when it grows: a single node's output (held in
 * memory for the whole run and re-serialised into every downstream template), the SUM of every node's output
 * (the workflow state a long graph accumulates), and one durable event (what the store is asked to write and
 * every consumer to receive).
 *
 * **This bounds by REJECTION, not truncation, and the distinction is the item's own wording.** The tool-result
 * bound in `tools/bounding.ts` truncates and spills, because a model-facing preview of a big file is still
 * useful. A workflow output is not a preview of anything: half a node's result silently flowing into the next
 * node's template is a wrong answer that looks like a right one. So an over-size output fails its node, with
 * the field, the size and the limit named.
 *
 * **The one thing a size bound may never do is stop a run from ending.** Exactly-one-terminal outranks every
 * ceiling here ([ADR-0036](../../../../docs/decisions/0036-run-loop-substrate-event-bus-and-execution-host.md)),
 * and [ADR-0078](../../../../docs/decisions/0078-ordered-durable-append-and-the-terminal-outbox.md) §6 already
 * narrows `#emitDurable`'s totality to the terminal arm for the same reason. A terminal event is therefore
 * measured but never refused — see {@link measureDraft}.
 */

import { utf8ByteLength } from '../tools/bounding.js';

/**
 * The three bounds, in one object for the same reason `ADMISSION_CEILINGS` is: a caller that wants to show
 * them should not have to know three identifier names.
 */
export const SIZE_BOUNDS = {
  /** One node's output, serialised. Held for the run and re-read by every downstream template. */
  nodeOutputBytes: 256 * 1024,
  /** Every node output in the run, summed — the workflow state a long graph accumulates. */
  workflowStateBytes: 4 * 1024 * 1024,
  /** One durable event, serialised. What the store writes and every consumer receives. */
  durableEventBytes: 1024 * 1024,
} as const;

/**
 * The serialised size of a value in UTF-8 bytes, or `undefined` when it cannot be serialised at all.
 *
 * `undefined` is not "zero" and callers must not treat it as such. A value that `JSON.stringify` refuses —
 * a cycle, a `BigInt` — is a value the durable log could not have carried either, so a size bound is the
 * wrong place to report it: the schema validation at the emit boundary already rejects it with a message
 * about the actual problem. Returning `undefined` lets this module decline to have an opinion rather than
 * inventing a size and possibly passing something that should fail for a different reason.
 *
 * `undefined` as the VALUE itself serialises to nothing and is genuinely zero bytes — the common case for a
 * node that produces no output — so that is distinguished here rather than folded in with the failures.
 */
export function serialisedByteLength(value: unknown): number | undefined {
  if (value === undefined) {
    return 0;
  }
  try {
    const json = JSON.stringify(value, inlineMediaReplacer);
    // `JSON.stringify` returns `undefined` (not a throw) for a function or a bare symbol.
    return json === undefined ? undefined : utf8ByteLength(json);
  } catch {
    return undefined;
  }
}

/**
 * A `JSON.stringify` replacer that measures an inline media part as the HANDLE it becomes, not as the base64
 * it currently is.
 *
 * **This is the difference between bounding the durable boundary and bounding something that never reaches
 * it**, and getting it wrong broke every media-producing node. A node that generates an image returns
 * `{ kind: 'base64', data }` in flight; `deInlineMedia` replaces that with a `media://sha256-…` handle of
 * about a hundred bytes before anything is persisted or delivered, and `state.output` keeps the raw form only
 * because the de-inline is non-mutating. Measuring the raw form therefore failed a 200 KiB image against a
 * 256 KiB "durable event" bound whose real payload was ~100 bytes — with a `validation` error the author
 * could not act on, because they cannot make a model return fewer bytes.
 *
 * The substitute is a fixed-length stand-in rather than the real digest: the handle's length is constant
 * (`media://` + a hex sha256), the value is not known until the store writes it, and a size estimate does not
 * need it. Inline bytes are bounded elsewhere and deliberately — `INLINE_MEDIA_CEILING` governs what may be
 * ingested, and generated media is exempt there precisely because the engine de-inlines it.
 */
const HANDLE_STAND_IN = `media://sha256-${'0'.repeat(64)}`;

function inlineMediaReplacer(_key: string, value: unknown): unknown {
  if (
    typeof value === 'object' &&
    value !== null &&
    'kind' in value &&
    (value as { kind?: unknown }).kind === 'base64' &&
    'data' in value
  ) {
    return { kind: 'base64', data: HANDLE_STAND_IN };
  }
  return value;
}

/** A size breach, shaped so a caller can build its own typed error without re-deriving the numbers. */
export interface SizeBreach {
  /** What was measured — `` node `x` output ``, `workflow state`, `` event `node:completed` ``. */
  readonly what: string;
  readonly bytes: number;
  readonly limit: number;
}

/** Render a breach as a user-facing, secret-free message: the subject, the size, the limit, in that order. */
export function describeBreach(breach: SizeBreach): string {
  return `${breach.what} is ${breach.bytes} bytes, above the limit of ${breach.limit}`;
}

/**
 * Measure one node's output against {@link SIZE_BOUNDS.nodeOutputBytes}.
 *
 * Returns the measured size alongside any breach, because the caller needs the number twice: once to refuse
 * this node, and once to add to the running workflow-state total when it does not.
 */
export function measureNodeOutput(
  nodeId: string,
  output: unknown,
): { readonly bytes: number; readonly breach?: SizeBreach } {
  const bytes = serialisedByteLength(output);
  if (bytes === undefined) {
    return { bytes: 0 }; // not measurable — the emit boundary's schema validation owns this case
  }
  return bytes > SIZE_BOUNDS.nodeOutputBytes
    ? {
        bytes,
        breach: { what: `node \`${nodeId}\` output`, bytes, limit: SIZE_BOUNDS.nodeOutputBytes },
      }
    : { bytes };
}

/** Measure the accumulated workflow state against {@link SIZE_BOUNDS.workflowStateBytes}. */
export function measureWorkflowState(totalBytes: number): SizeBreach | undefined {
  return totalBytes > SIZE_BOUNDS.workflowStateBytes
    ? { what: 'the workflow state', bytes: totalBytes, limit: SIZE_BOUNDS.workflowStateBytes }
    : undefined;
}

/**
 * Measure one durable event against {@link SIZE_BOUNDS.durableEventBytes}.
 *
 * **A terminal draft is measured and never refused**, and that is not a softening — it is the invariant every
 * other rule here defers to. A run that cannot publish its terminal is worse in every way than one that wrote
 * an oversized final event: the stream never closes, the lease is never released, and no surface can tell
 * whether the run finished. ADR-0078 §6 draws the same line for a store fault, for the same reason.
 *
 * Non-terminal drafts are refused, which is safe precisely because refusing one is itself a node failure that
 * produces a terminal.
 */
export function measureDraft(
  type: string,
  draft: unknown,
  isTerminal: boolean,
): SizeBreach | undefined {
  if (isTerminal) {
    return undefined;
  }
  const bytes = serialisedByteLength(draft);
  if (bytes === undefined || bytes <= SIZE_BOUNDS.durableEventBytes) {
    return undefined;
  }
  return { what: `event \`${type}\``, bytes, limit: SIZE_BOUNDS.durableEventBytes };
}
