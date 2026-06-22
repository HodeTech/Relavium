/**
 * Deterministic CLI exit codes. Canonical home:
 * [commands.md](../../../../docs/reference/cli/commands.md#exit-codes). CI relies on these
 * being stable. Code `4` (chat-session-ended) is emitted by the chat REPL in workstream 2.M;
 * codes `0`/`1`/`3` are produced by `relavium run` once it drives the engine (2.D).
 */
export const EXIT_CODES = {
  /** Workflow completed successfully. */
  success: 0,
  /** Workflow failed (a node errored and exhausted retries/fallbacks). */
  workflowFailed: 1,
  /** Invalid invocation: bad arguments, command/workflow not found, or a schema error. */
  invalidInvocation: 2,
  /** Run paused at a human gate (CI / non-interactive mode) — resume with `relavium gate`. */
  gatePaused: 3,
  /** A chat session ended via `/exit` (interactive `relavium chat`) — wired at 2.M. */
  chatEnded: 4,
} as const;

export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];
