import { isCiEnv } from '../process/output-mode.js';

/**
 * The signals that gate the bare-invocation Home (2.5.B / [ADR-0054](../../../../docs/decisions/0054-cli-bare-invocation-interactive-home.md)).
 * A pure predicate over the `io` seam so the decision is unit-tested without a process.
 */
export interface HomeGateSignals {
  /** `process.stdout.isTTY` — the Home is a TUI; without a TTY stdout there is nothing to render. */
  readonly stdoutIsTty: boolean;
  /** `process.stdin.isTTY` — the Home reads keystrokes; a piped/redirected stdin cannot drive it. */
  readonly stdinIsTty: boolean;
  /** The resolved `--json` flag — machine output wins over the TUI, so `--json` keeps the help meta-op. */
  readonly json: boolean;
  /** The process env — for the `isCiEnv` floor (CI=1 / any truthy CI, a pseudo-TTY runner). */
  readonly env: Readonly<Record<string, string | undefined>>;
}

/**
 * Whether a bare `relavium` (no subcommand) should open the interactive Home instead of printing help. The Home
 * opens ONLY when the process is genuinely interactive: stdout AND stdin are a TTY, `--json` is off, and the
 * process is not under CI (the existing `isCiEnv` helper catches `CI=1` / any truthy `CI`, so a CI runner that
 * allocates a pseudo-TTY cannot accidentally stall a pipeline on the Home). Every other path keeps the
 * byte-for-byte `helpInformation()` + exit 0 meta-op contract (ADR-0049). Lives in the bare-invocation branch of
 * `run.ts` — NOT a `commander` default action (which would swallow the unknown-command error).
 */
export function shouldOpenHome(signals: HomeGateSignals): boolean {
  return signals.stdoutIsTty && signals.stdinIsTty && !signals.json && !isCiEnv(signals.env);
}
