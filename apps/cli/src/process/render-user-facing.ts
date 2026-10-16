import type { UserFacingError } from './cli-error.js';
import type { CliIo } from './io.js';
import {
  sanitizeInline,
  sanitizeUntrusted,
  sanitizeUntrustedInline,
  stringifyJsonLine,
} from '../render/sanitize.js';

/** Pure diagnostic rendering: classification belongs to the owning boundary. */
export function renderUserFacing(
  userFacing: UserFacingError,
  value: unknown,
  opts: { readonly json: boolean; readonly verbose: boolean },
  io: CliIo,
): void {
  // The error boundary is shared by every command, including JSON diagnostics and verbose stacks. Keep the
  // structured envelope valid while also removing terminal/bidi controls before it reaches stderr.
  const code = sanitizeInline(userFacing.code);
  // The message can carry a provider/MCP/tool string, so it is redacted as well as control-stripped.
  const message = sanitizeUntrustedInline(userFacing.message);
  if (opts.json) {
    io.writeErr(stringifyJsonLine({ type: 'error', code, message }) + '\n');
  } else {
    io.writeErr(`relavium: ${message}\n`);
  }
  // The raw stack is a human-mode debugging affordance only — never under `--json`, where it would
  // mix non-JSON text into the structured stderr diagnostic (error-handling.md: a stack is not machine
  // output). Under `--json` the `{ type: 'error', … }` envelope is the whole stderr diagnostic.
  if (opts.verbose && !opts.json && value instanceof Error && value.stack !== undefined) {
    // A stack embeds the message, and often argument values with it — this is the likeliest leak of the four.
    io.writeErr(sanitizeUntrusted(value.stack) + '\n');
  }
}
