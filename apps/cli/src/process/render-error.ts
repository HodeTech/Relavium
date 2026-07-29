import { toUserFacing } from './errors.js';
import type { CliIo } from './io.js';
import { sanitizeInline, stripTerminalControls } from '../render/sanitize.js';

/**
 * Render a fatal error once, at the top-level boundary (error-handling.md: the internal →
 * user-facing mapping happens at the surface, once). A pre-run CLI fault is a **diagnostic**, so it
 * always goes to **stderr** — never stdout — keeping stdout a pure `RunRenderer` event stream
 * ([ADR-0049](../../../../docs/decisions/0049-cli-machine-output-contract.md)): under `--json` it is a
 * structured `{ type: 'error', code, message }` envelope (a CLI fault, distinct from the run-stream's
 * `run:failed`/`node:failed`); otherwise a `relavium: <message>` human line. So under `--json` a fault
 * leaves stdout empty and the exit code is the primary signal. The original stack is written to stderr
 * **only** under `--verbose`, never as primary output.
 */
export function renderError(
  value: unknown,
  opts: { readonly json: boolean; readonly verbose: boolean },
  io: CliIo,
): void {
  const userFacing = toUserFacing(value);
  // The error boundary is shared by every command, including JSON diagnostics and verbose stacks. Keep the
  // structured envelope valid while also removing terminal/bidi controls before it reaches stderr.
  const code = sanitizeInline(userFacing.code);
  const message = sanitizeInline(userFacing.message);
  if (opts.json) {
    io.writeErr(JSON.stringify({ type: 'error', code, message }) + '\n');
  } else {
    io.writeErr(`relavium: ${message}\n`);
  }
  // The raw stack is a human-mode debugging affordance only — never under `--json`, where it would
  // mix non-JSON text into the structured stderr diagnostic (error-handling.md: a stack is not machine
  // output). Under `--json` the `{ type: 'error', … }` envelope is the whole stderr diagnostic.
  if (opts.verbose && !opts.json && value instanceof Error && value.stack !== undefined) {
    io.writeErr(stripTerminalControls(value.stack) + '\n');
  }
}
