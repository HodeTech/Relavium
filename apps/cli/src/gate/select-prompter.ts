import type { CliIo } from '../process/io.js';
import type { GlobalOptions } from '../process/options.js';
import { detectOutputMode, isCiEnv } from '../process/output-mode.js';
import { createClackGatePrompter } from './clack-prompter.js';
import type { GatePrompter } from './prompter.js';

/**
 * The interactive {@link GatePrompter} for a run, or `undefined` when the environment can't prompt — CI /
 * `--json` / no-TTY, where the run instead exits with the gate-paused code `3` to be resumed out-of-band by
 * `relavium gate` (2.G). Mirrors `selectRenderer`: the SAME `detectOutputMode` decides, so the prompter is
 * present in exactly the mode the `ink` TUI renders (a real interactive TTY) and absent everywhere else.
 */
export function selectGatePrompter(io: CliIo, global: GlobalOptions): GatePrompter | undefined {
  const mode = detectOutputMode({
    stdoutIsTty: io.stdoutIsTty,
    json: global.json,
    ci: isCiEnv(io.env),
  });
  return mode === 'tui' ? createClackGatePrompter() : undefined;
}
