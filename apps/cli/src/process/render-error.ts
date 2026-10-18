import { toUserFacing } from './errors.js';
import type { CliIo } from './io.js';
import { renderUserFacing } from './render-user-facing.js';

/**
 * Render a fatal error once, at the top-level boundary (error-handling.md: the internal →
 * user-facing mapping happens at the surface, once). A pre-run CLI fault is a **diagnostic**, so it
 * always goes to **stderr** — never stdout — keeping stdout a pure `RunRenderer` event stream
 * ([ADR-0049](../../../../docs/decisions/0049-cli-machine-output-contract.md)): under `--json` it is a
 * structured `{ type: 'error', code, message }` envelope (a CLI fault, distinct from the run-stream's
 * `run:failed`/`node:failed`); otherwise a `relavium: <message>` human line. So under `--json` a fault
 * leaves stdout empty and the exit code is the primary signal. This legacy renderer accepts only an own
 * data-string stack under `--verbose`; foreign/native accessors are never invoked. Production fatal
 * diagnostics use the separate fixed-message projection.
 */
export function renderError(
  value: unknown,
  opts: { readonly json: boolean; readonly verbose: boolean },
  io: CliIo,
): void {
  renderUserFacing(toUserFacing(value), value, opts, io);
}
