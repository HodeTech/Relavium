/**
 * The engine-executed media attachment channel (`CR-50`,
 * [ADR-0089](../../../../docs/decisions/0089-media-correctness-four-boundaries.md) §1).
 *
 * A builtin that answers with MEDIA cannot put the bytes in its `tool_result`: `tool_result.media` is
 * handle-only and nothing lowers it (the chain's re-materialization walks top-level `media` parts and never
 * descends into a tool result; OpenAI's `role:'tool'` lowering filters the message to `tool_result` parts;
 * and ADR-0043 §1 forbids an adapter resolving a handle itself). ADR-0089 §1 routes the bytes over the
 * *media-input* rail instead — a top-level `media` part on a synthesized `user` message — so the tool result
 * itself stays a short text descriptor.
 *
 * This module is how the two travel together from a dispatch to the turn loop without either one becoming
 * an untyped side channel. The envelope is a private-symbol brand, so it cannot be forged by a tool result
 * that merely happens to have the right keys, and {@link takeMediaAttachment} splits it exactly once — the
 * descriptor continues down the `output_mapping` / bounding path as an ordinary value, and the media parts
 * ride {@link ToolDispatchOutcome.mediaAttachments}.
 *
 * The parts are {@link DurableMediaPart}s — handle-only BY TYPE, not by convention. A dispatch cannot smuggle
 * inline bytes through here even by mistake, which is what keeps the I3 boundary (`outputSummary`, the spill,
 * the durable event) byte-free without a second redaction pass.
 */

import type { DurableMediaPart } from '@relavium/shared';

import { ToolArgsInvalidError } from './errors.js';

const MEDIA_ATTACHMENT: unique symbol = Symbol('relavium.mediaAttachment');

/** A dispatch result paired with handle-only media the engine must deliver on a synthesized message. */
export interface WithMediaAttachment<T> {
  readonly [MEDIA_ATTACHMENT]: true;
  /** The ordinary dispatch result — what `output_mapping`, bounding and the tool result see. */
  readonly value: T;
  /** Handle-only media parts, delivered on a synthesized `user` message after the tool result. */
  readonly media: readonly DurableMediaPart[];
}

/**
 * Pair a dispatch result with media to deliver alongside it. `media` must be non-empty — an empty
 * attachment is a caller bug (it would synthesize a message with nothing in it), so it is rejected at the
 * construction site rather than silently producing an empty turn.
 */
export function attachMedia<T>(
  value: T,
  media: readonly DurableMediaPart[],
): WithMediaAttachment<T> {
  if (media.length === 0) {
    // A TYPED dispatch error, not a bare `Error`. A bare throw here was caught by the registry's
    // classification ladder and re-wrapped as a `recoverable` tool failure — inviting the model to retry an
    // engine invariant violation, which no retry can fix (error-handling.md).
    throw new ToolArgsInvalidError(
      'read_media',
      [],
      'attachMedia: media must be non-empty — use the bare value when there is none',
    );
  }
  return { [MEDIA_ATTACHMENT]: true, value, media };
}

/**
 * Split an envelope into its result and its media; a value that is not an envelope passes through with no
 * media. Total, and cheap on the dominant path (a shape test and one small object — the earlier claim of
 * "allocation-free" was simply wrong: both branches allocate a result object).
 *
 * **Top level only.** An envelope nested inside an array or an object property is NOT split — it would ride
 * on into `output_mapping`, bounding, the spill and the durable event, where `JSON.stringify` drops the
 * symbol and leaks `{ value, media: [...] }` into the tool result while delivering nothing. No producer
 * does this, and the shape is engine-internal, but the constraint is stated rather than assumed.
 */
export function takeMediaAttachment(result: unknown): {
  readonly value: unknown;
  readonly media: readonly DurableMediaPart[];
} {
  return isMediaAttachment(result)
    ? { value: result.value, media: result.media }
    : { value: result, media: [] };
}

function isMediaAttachment(value: unknown): value is WithMediaAttachment<unknown> {
  return typeof value === 'object' && value !== null && MEDIA_ATTACHMENT in value;
}
