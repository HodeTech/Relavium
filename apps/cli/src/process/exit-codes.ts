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
  /**
   * A chat session ended by the user — via `/exit`, `/cancel` (or Ctrl-C in TTY mode), or an input-stream
   * EOF — from a `relavium chat` (2.M) or `relavium chat-resume` (2.N) REPL (both drive the same loop).
   */
  chatEnded: 4,
  /**
   * The run produced a terminal, but whether that terminal reached the durable log is **not known**
   * ([ADR-0078](../../../../docs/decisions/0078-ordered-durable-append-and-the-terminal-outbox.md) §5).
   *
   * Distinct from `workflowFailed` on purpose, and the distinction is the whole point of `CR-92`: the run may
   * well have COMPLETED — the outputs are in the delivered terminal — and only its durable record is missing.
   * Reporting it as a failure would be as wrong as reporting it as a success. The terminal is held in the
   * host's terminal outbox and retried on the next `relavium` start; a caller scripting against this should
   * treat the run as done-but-unrecorded and re-check `relavium status` after a subsequent invocation.
   */
  durabilityUncertain: 5,
  /**
   * The run is owned by ANOTHER PROCESS — this invocation refused rather than becoming a second producer
   * ([ADR-0079](../../../../docs/decisions/0079-cross-process-run-ownership-lease-and-fencing-token.md) §7).
   *
   * Distinct from `invalidInvocation` because it is the only engine-state refusal that is **transient**. Every
   * other one — unknown run, wrong workflow, already terminal — is a mistake in the call and will fail
   * identically forever; this one resolves on its own when the other process finishes or its lease expires
   * (at most `RUN_LEASE_TTL_MS`). An automation loop has to be able to tell "try again shortly" from "never
   * call this again", and a single blanket code cannot express that.
   */
  runOwnedElsewhere: 6,
} as const;

export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];
