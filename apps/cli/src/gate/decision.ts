import type { GateDecision } from '@relavium/shared';

/**
 * Pure {@link GateDecision} builders + the `relavium gate` flag→decision mapping (2.G) — framework-free
 * (no `commander`, no `@clack/prompts`), so both the interactive prompt and the out-of-band command build the
 * same shape and the logic is unit-testable without a TTY ([ADR-0047](../../../../docs/decisions/0047-cli-framework-commander-ink-clack.md)).
 */

/**
 * The `decidedBy` recorded for a decision made through the local CLI. A deterministic, **non-PII** marker —
 * the desktop/portal surfaces supply a real user id later, but the local CLI has no authenticated user, and
 * `human_gate:resumed.decidedBy` is persisted to the durable event log, so it must never carry PII (an OS
 * username, an email). The reserved `'timeout'` value (an auto-resolved gate) is the engine's, never ours.
 */
export const DECIDED_BY_CLI = 'cli';

/** Attach a non-empty, trimmed comment to a decision; omit the key entirely otherwise (exactOptionalPropertyTypes). */
function withComment(comment: string | undefined): { comment?: string } {
  const trimmed = comment?.trim();
  return trimmed !== undefined && trimmed !== '' ? { comment: trimmed } : {};
}

export function approvalDecision(comment?: string): GateDecision {
  return { decision: 'approved', decidedBy: DECIDED_BY_CLI, ...withComment(comment) };
}

export function rejectionDecision(comment?: string): GateDecision {
  return { decision: 'rejected', decidedBy: DECIDED_BY_CLI, ...withComment(comment) };
}

export function inputDecision(payload: unknown, comment?: string): GateDecision {
  return {
    decision: 'input_provided',
    decidedBy: DECIDED_BY_CLI,
    payload,
    ...withComment(comment),
  };
}

/**
 * Parse a `relavium gate --input <value>`: JSON when it parses (so `'{"k":1}'` / `'42'` / `'true'` / `'null'`
 * become a structured payload the gate node's downstream consumers can read), otherwise the raw string (so
 * `--input some-token` is the literal `"some-token"`). The result becomes the gate node's output verbatim.
 *
 * Note: the payload is the operator's *intended* gate input and is persisted to the durable event log
 * (`human_gate:resumed.payload`) and emitted on the `--json` stream — by design (the documented use is e.g.
 * `--input '{"api_key": "…"}'`). It is masked at the durable boundary only if the workflow types it `secret`
 * (ADR-0006/0036); a plain `--input` value is recorded as-is, the same as any other gate input across surfaces.
 */
export function parseGateInput(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/** The mutually-exclusive resolution flags `relavium gate` accepts. */
export interface GateFlags {
  readonly approve?: boolean;
  readonly reject?: boolean;
  readonly comment?: string;
  readonly input?: string;
}

/** A built decision, or a typed invalid-invocation message the command maps to exit 2. */
export type GateFlagResult =
  | { readonly ok: true; readonly decision: GateDecision }
  | { readonly ok: false; readonly error: string };

/**
 * Map the `gate` resolution flags to a {@link GateDecision}. Exactly one of `--approve` / `--reject` /
 * `--input` is required and they are mutually exclusive; `--comment` annotates an approve/reject rationale and
 * is invalid with `--input` (which carries a structured payload, not free text). A bad combination is an
 * invalid invocation (exit 2), surfaced as the `error` message — never a thrown string.
 */
export function decisionFromFlags(flags: GateFlags): GateFlagResult {
  const modes = [flags.approve === true, flags.reject === true, flags.input !== undefined].filter(
    Boolean,
  ).length;
  if (modes === 0) {
    return { ok: false, error: 'specify one of --approve, --reject, or --input' };
  }
  if (modes > 1) {
    return { ok: false, error: '--approve, --reject, and --input are mutually exclusive' };
  }
  if (flags.input !== undefined) {
    if (flags.comment !== undefined) {
      return {
        ok: false,
        error: '--comment is not valid with --input (the input payload carries the data)',
      };
    }
    return { ok: true, decision: inputDecision(parseGateInput(flags.input)) };
  }
  if (flags.approve === true) {
    return { ok: true, decision: approvalDecision(flags.comment) };
  }
  return { ok: true, decision: rejectionDecision(flags.comment) };
}
