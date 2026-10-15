/**
 * The classified failure of the node-output media pin (`CR-54`,
 * [ADR-0043](../../../../docs/decisions/0043-media-egress-failover-rematerialization-ssrf.md) §3).
 *
 * Exists because the pin's failures were arriving at the wrong altitude. An unclassified throw escaped
 * `#settleCompleted` into `#onOutcome`'s bare catch and became `the engine failed while settling a node`
 * with **no `node:failed` at all** — a provider CDN hiccup, a DNS blip, an oversized video or a slow link
 * reported as an engine defect, on what is now the happy path of every Gemini video generation.
 *
 * The distinctions the user needs already exist one layer down: `SafeEgressError` separates a refused
 * target from an over-size body from a transient network fault, and `deInlineMedia` separates "no streaming
 * hook wired" from "unsupported mimeType". This carries them up instead of flattening them.
 *
 * **The classification is structural, not `instanceof`, and that is a boundary constraint rather than a
 * preference.** `SafeEgressError` lives in `@relavium/db`; `packages/core` cannot import it without
 * breaking the zero-platform-import rule (CLAUDE.md rule 5) and inverting the dependency direction. So the
 * shape is read through a type guard — a string `code` — with an explicit default of `internal` for
 * anything unrecognized. An unrecognized failure is reported as an engine fault, which is the honest
 * direction to be wrong in.
 *
 * The message never carries the url. A media url can embed a signed query token, and this string reaches a
 * durable event and a log (security-review.md §Media byte delivery) — so it names the REASON only, which is
 * also why the reason has to be this specific.
 */

import { MediaAdmissionError } from '@relavium/shared';

import { ADMISSION_CEILINGS } from '../limits.js';

import type { NodeFailure } from './node-executor.js';

/** Egress reasons that mean the target or its response was REFUSED — an authoring/config fault, not transient. */
const REFUSED_EGRESS_CODES: ReadonlySet<string> = new Set([
  'insecure_url',
  'blocked_host',
  'too_many_redirects',
  'too_large',
  'bad_status',
]);

/** Egress reasons that mean the transfer failed in flight — worth another attempt. */
const TRANSIENT_EGRESS_CODES: ReadonlySet<string> = new Set(['network', 'timeout']);

/** Own data code only; reflection faults and accessors do not match. A thrown value shaped like `@relavium/db`'s `SafeEgressError` (read structurally — see the module note). */
function egressCodeOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, 'code');
    if (descriptor === undefined || !('value' in descriptor)) return undefined;
    const code: unknown = descriptor.value;
    return typeof code === 'string' ? code : undefined;
  } catch {
    return undefined;
  }
}

type PinCode = 'cancelled' | 'validation' | 'internal' | 'provider_unavailable';
interface PinFailure extends NodeFailure {
  readonly code: PinCode;
  readonly retryable: false;
}
interface CapturedPinFailure {
  readonly nodeId: string;
  readonly failure: PinFailure;
}
// A prototype, public JS constructor call or mutable Error field cannot register this authority.
const PIN_FAILURES = new WeakMap<object, CapturedPinFailure>();

export class NodeMediaPinError extends Error {
  override readonly name = 'NodeMediaPinError';
  readonly failure: NodeFailure;

  private constructor(failure: NodeFailure) {
    super(failure.message);
    this.failure = failure;
  }

  /** Only finite engine-authored templates can enter the trusted capture. */
  static #create(nodeId: string, message: string, code: PinCode): NodeMediaPinError {
    const failure: PinFailure = Object.freeze({ code, message, retryable: false });
    const result = new NodeMediaPinError(failure);
    PIN_FAILURES.set(result, Object.freeze({ nodeId, failure }));
    return result;
  }

  /** Existing per-node and per-run media-part refusals, with their original wording. */
  static partsExceeded(nodeId: string, incoming: number, accumulated: number): NodeMediaPinError {
    const where = `node \`${nodeId}\` produced media that could not be re-hosted`;
    if (
      !Number.isSafeInteger(incoming) ||
      incoming < 0 ||
      !Number.isSafeInteger(accumulated) ||
      accumulated < 0 ||
      !Number.isSafeInteger(accumulated + incoming)
    )
      return NodeMediaPinError.#create(nodeId, `${where} (internal)`, 'internal');
    if (incoming > ADMISSION_CEILINGS.mediaPartsPerNodeOutput)
      return NodeMediaPinError.#create(
        nodeId,
        `node \`${nodeId}\` produced ${incoming} media parts to re-host, over its limit of ${ADMISSION_CEILINGS.mediaPartsPerNodeOutput}`,
        'validation',
      );
    if (accumulated + incoming > ADMISSION_CEILINGS.mediaPartsPerRun)
      return NodeMediaPinError.#create(
        nodeId,
        `this run has re-hosted ${accumulated} media parts and node \`${nodeId}\` adds ${incoming}, over the run limit of ${ADMISSION_CEILINGS.mediaPartsPerRun}`,
        'validation',
      );
    return NodeMediaPinError.#create(nodeId, `${where} (internal)`, 'internal');
  }

  /** Never inspect a thrown value's prototype, getters or public failure/message fields. */
  static #capture(error: unknown): CapturedPinFailure | undefined {
    if (typeof error !== 'object' || error === null) return undefined;
    return PIN_FAILURES.get(error);
  }

  static failureOf(error: unknown, nodeId: string): NodeFailure | undefined {
    const captured = NodeMediaPinError.#capture(error);
    return captured?.nodeId === nodeId ? captured.failure : undefined;
  }

  /**
   * Classify a pin failure. `aborted` wins outright (cancel-wins-all, ADR-0036) — a torn-down run must not
   * report a network error it only saw because it was being cancelled.
   */
  static from(error: unknown, nodeId: string, aborted: boolean): NodeMediaPinError {
    if (aborted) {
      return NodeMediaPinError.#create(nodeId, 'the run was cancelled', 'cancelled');
    }
    const where = `node \`${nodeId}\` produced media that could not be re-hosted`;
    const captured = NodeMediaPinError.#capture(error);
    if (captured !== undefined) {
      // A known pin error belongs only to its originating node. A wrong-node rethrow cannot
      // reinterpret mutable public fields as a fresh egress/admission reason.
      if (captured.nodeId !== nodeId)
        return NodeMediaPinError.#create(nodeId, `${where} (internal)`, 'internal');
      return NodeMediaPinError.#create(nodeId, captured.failure.message, captured.failure.code);
    }
    const admission = MediaAdmissionError.from(error);
    if (admission !== undefined) {
      const internal =
        admission.code === 'store_contract' ||
        admission.code === 'store_unavailable' ||
        admission.code === 'source_unavailable' ||
        admission.code === 'verifier_state';
      return NodeMediaPinError.#create(
        nodeId,
        `${where}: ${admission.message}`,
        internal ? 'internal' : 'validation',
      );
    }
    const egress = egressCodeOf(error);
    if (egress !== undefined && REFUSED_EGRESS_CODES.has(egress)) {
      // Non-retryable: the same url refused for the same reason on every attempt. The remedy is the
      // workflow or the policy, not another try.
      return NodeMediaPinError.#create(
        nodeId,
        `${where}: the media url was refused (${egress})`,
        'validation',
      );
    }
    if (egress !== undefined && TRANSIENT_EGRESS_CODES.has(egress)) {
      // **Transient in kind, and still NOT node-retryable.** `retryable: true` means one specific thing in
      // this engine — re-dispatch the whole node — and the node's own work already SUCCEEDED: the executor
      // returned, the model was called, the tokens were billed. Only the re-host that runs after it failed.
      // A review reproduced the cost of getting this wrong: an agent node with `retry` and a `MediaStore`
      // that fails once emitted `node:retrying` and called `execute()` a SECOND time, making a second paid,
      // non-deterministic generative call because of a CDN blip in a step downstream of it. That is exactly
      // the duplicate paid work ADR-0074/0077/0080 exist to prevent.
      //
      // The code stays `provider_unavailable` because it describes what happened truthfully; `retryable` is
      // the axis that decides re-dispatch, and `#shouldRetry` checks it before it looks at the code, so an
      // authored `retry_on` cannot override this either. A bounded retry around the RE-HOST alone — which
      // would not re-invoke the executor — is the right answer and is recorded as a follow-up.
      return NodeMediaPinError.#create(
        nodeId,
        `${where}: the media url could not be fetched (${egress}) — the node's own work succeeded, so it is not retried`,
        'provider_unavailable',
      );
    }
    return NodeMediaPinError.#create(nodeId, `${where} (internal)`, 'internal');
  }
}
