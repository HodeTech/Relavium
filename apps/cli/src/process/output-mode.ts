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

/** The four signals that decide whether this process may ASK a question and get an answer. */
export interface InteractiveSignals {
  /** `process.stdout.isTTY` — a prompt with nowhere to render is not a prompt. */
  readonly stdoutIsTty: boolean;
  /** `process.stdin.isTTY` — a prompt reads keystrokes; a piped or drained stdin cannot answer. */
  readonly stdinIsTty: boolean;
  /** The resolved `--json` flag — a question in a machine-readable stream breaks ADR-0049's contract. */
  readonly json: boolean;
  /** The process env, for the `isCiEnv` floor — a CI runner may allocate a pseudo-TTY and still not answer. */
  readonly env: Readonly<Record<string, string | undefined>>;
}

/**
 * May this process ask an interactive question?
 *
 * **All four, and stdout alone is not enough.** `detectOutputMode` answers a RENDERING question and consults
 * stdout only; a prompt that reads keystrokes needs stdin too, `--json` owns stdout as a machine stream, and
 * `CI=true` with an attached pseudo-TTY would hang a pipeline on a question nobody answers.
 *
 * Extracted from the Home gate when
 * [ADR-0084](../../../../docs/decisions/0084-consent-before-a-local-mcp-spawn.md) §6 became a second caller
 * with the identical requirement. Two copies of a four-way predicate is how one of them silently loses a
 * signal — and a consent gate that prompted under `--json` would be exactly that.
 */
export function isInteractiveTerminal(signals: InteractiveSignals): boolean {
  return signals.stdoutIsTty && signals.stdinIsTty && !signals.json && !isCiEnv(signals.env);
}
