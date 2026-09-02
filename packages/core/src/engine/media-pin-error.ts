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

import type { ErrorCode } from '@relavium/shared';

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

/** A thrown value shaped like `@relavium/db`'s `SafeEgressError` (read structurally — see the module note). */
function egressCodeOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return undefined;
  }
  const { code }: { readonly code: unknown } = error;
  return typeof code === 'string' ? code : undefined;
}

export class NodeMediaPinError extends Error {
  override readonly name = 'NodeMediaPinError';
  readonly failure: NodeFailure;

  constructor(message: string, code: ErrorCode, retryable = false) {
    super(message);
    this.failure = { code, message, retryable };
  }

  /**
   * Classify a pin failure. `aborted` wins outright (cancel-wins-all, ADR-0036) — a torn-down run must not
   * report a network error it only saw because it was being cancelled.
   */
  static from(error: unknown, nodeId: string, aborted: boolean): NodeMediaPinError {
    if (aborted) {
      return new NodeMediaPinError('the run was cancelled', 'cancelled');
    }
    if (error instanceof NodeMediaPinError) {
      return error;
    }
    const where = `node \`${nodeId}\` produced media that could not be re-hosted`;
    const egress = egressCodeOf(error);
    if (egress !== undefined && REFUSED_EGRESS_CODES.has(egress)) {
      // Non-retryable: the same url refused for the same reason on every attempt. The remedy is the
      // workflow or the policy, not another try.
      return new NodeMediaPinError(`${where}: the media url was refused (${egress})`, 'validation');
    }
    if (egress !== undefined && TRANSIENT_EGRESS_CODES.has(egress)) {
      return new NodeMediaPinError(
        `${where}: the media url could not be fetched (${egress})`,
        'provider_unavailable',
        true,
      );
    }
    return new NodeMediaPinError(`${where} (internal)`, 'internal');
  }
}
