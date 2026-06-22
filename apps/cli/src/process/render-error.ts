import { toUserFacing } from './errors.js';
import type { CliIo } from './io.js';

/**
 * Render a fatal error once, at the top-level boundary (error-handling.md: the internal →
 * user-facing mapping happens at the surface, once). Under `--json` a structured error
 * envelope is the machine output on **stdout**; otherwise a human line goes to **stderr** so
 * a pipe consumer's stdout stays clean. The original stack is written to stderr **only** under
 * `--verbose`, never as primary output.
 */
export function renderError(
  value: unknown,
  opts: { readonly json: boolean; readonly verbose: boolean },
  io: CliIo,
): void {
  const userFacing = toUserFacing(value);
  if (opts.json) {
    io.writeOut(
      JSON.stringify({ type: 'error', code: userFacing.code, message: userFacing.message }) + '\n',
    );
  } else {
    io.writeErr(`relavium: ${userFacing.message}\n`);
  }
  if (opts.verbose && value instanceof Error && value.stack !== undefined) {
    io.writeErr(value.stack + '\n');
  }
}
