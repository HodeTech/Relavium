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
   *
   * **Scoped to ADR-0078's case: a terminal was PRODUCED and its write did not land.** A run fenced out
   * mid-flight (ADR-0079 §5) shares the `uncertain` disposition but produces no terminal at all and writes
   * nothing to the outbox, so the retry promised above would never come — that case is code `6` when
   * final receipt health does not require `8` or `7`. The discriminator is actual terminal delivery.
   */
  durabilityUncertain: 5,
  /** Ownership refusal or terminal-free fencing; inspect current history before resuming (ADR-0079). */
  runOwnedElsewhere: 6,
  /**
   * A prior or admitted external effect needs human inspection (ADR-0080/0103). Final joined effect
   * health can require this disposition without changing the actual terminal. Money uncertainty wins.
   * Follow the canonical commands.md remedy; automatic repetition can duplicate an external effect.
   */
  effectNeedsAttention: 7,
  /** Required money receipts were not durably acknowledged; never automatically repeat paid work. */
  moneyDurabilityUncertain: 8,
} as const;

export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];
