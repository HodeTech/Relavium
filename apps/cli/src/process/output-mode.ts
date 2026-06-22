/**
 * Output-mode selection — the "Output modes" table in
 * [commands.md](../../../../docs/reference/cli/commands.md). Kept **pure** with injected
 * signals so it is unit-testable with no real TTY: the interactive `ink` TUI (workstream 2.E)
 * renders only when a TTY is attached **and** neither `--json` nor a CI environment forces
 * machine output; otherwise the line-buffered / NDJSON plain renderer (workstream 2.F).
 */
export type OutputMode = 'tui' | 'plain';

export interface OutputModeSignals {
  /** Whether a TTY is attached to stdout (`process.stdout.isTTY`). */
  readonly stdoutIsTty: boolean;
  /** The resolved `--json` global flag. */
  readonly json: boolean;
  /** Whether the process runs under CI. */
  readonly ci: boolean;
}

export function detectOutputMode(signals: OutputModeSignals): OutputMode {
  if (signals.json || signals.ci || !signals.stdoutIsTty) {
    return 'plain';
  }
  return 'tui';
}

/**
 * Whether the environment indicates CI. Mirrors the common convention: `CI` is set to a
 * non-empty, non-falsey value (`CI=true` in the commands.md table; `CI=false`/`0`/empty opt out).
 */
export function isCiEnv(env: Readonly<Record<string, string | undefined>>): boolean {
  const ci = env['CI'];
  return ci !== undefined && ci !== '' && ci !== 'false' && ci !== '0';
}
