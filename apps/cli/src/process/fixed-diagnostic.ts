import { CLI_ERROR_POLICY } from './cli-error.js';
import type { DiagnosticPolicy } from './diagnostic-policy.js';

export type FixedDiagnosticKind =
  | 'cli_internal'
  | 'output_unavailable'
  | 'background_failure'
  | 'background_suppressed';

/** Closed, authored constants only: no thrown value, stack, cause or coercion enters this projection. */
export function formatFixedDiagnostic(kind: FixedDiagnosticKind, policy: DiagnosticPolicy): string {
  const code = kind === 'output_unavailable' ? 'output_unavailable' : 'cli_internal';
  const message =
    kind === 'background_failure'
      ? 'A background operation failed. Inspect existing work before repeating paid or effectful operations.'
      : kind === 'background_suppressed'
        ? 'Further background failures suppressed. Inspect existing work before repeating paid or effectful operations.'
        : CLI_ERROR_POLICY[code].fixedMessage;
  // All fields are fixed ASCII constants, independently of user content and writable Error properties.
  return policy.json
    ? `${JSON.stringify({ type: 'error', code, message })}\n`
    : `relavium: ${message}\n`;
}
