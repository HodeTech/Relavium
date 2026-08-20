import type { CliIo } from '../process/io.js';
import type { GlobalOptions } from '../process/options.js';
import { isInteractiveTerminal } from '../process/output-mode.js';
import { createClackGatePrompter } from './clack-prompter.js';
import type { GatePrompter } from './prompter.js';

/**
 * The interactive {@link GatePrompter} for a run, or `undefined` when the environment can't prompt — CI /
 * `--json` / no-TTY, where the run instead exits with the gate-paused code `3` to be resumed out-of-band by
 * `relavium gate` (2.G).
 *
 * `isInteractiveTerminal`, not `detectOutputMode`: this asked a RENDERING question to decide a PROMPTING one,
 * so it consulted stdout and missed stdin entirely — with stdout on a TTY and stdin piped, it handed back a
 * clack prompter whose raw-mode setup throws rather than pausing the run cleanly. The four-way predicate is
 * shared with the Home gate and the MCP consent gate
 * ([ADR-0084](../../../../docs/decisions/0084-consent-before-a-local-mcp-spawn.md) §6), which is the point:
 * three copies of it is how one of them silently loses a signal.
 */
export function selectGatePrompter(io: CliIo, global: GlobalOptions): GatePrompter | undefined {
  return isInteractiveTerminal({
    stdoutIsTty: io.stdoutIsTty,
    stdinIsTty: io.stdinIsTty,
    json: global.json,
    env: io.env,
  })
    ? createClackGatePrompter()
    : undefined;
}
