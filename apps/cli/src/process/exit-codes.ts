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
   * nothing to the outbox, so the retry promised above would never come — that case is code `6`, and the
   * discriminator is whether a terminal was delivered.
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
   *
   * Reached two ways: a resume REFUSED before it started (another process already held the lease), and a run
   * fenced out MID-FLIGHT, which closes its stream with no terminal and reports `uncertain`. Both mean the
   * same thing to a caller — this run is somebody else's right now — and neither has anything to retry
   * locally, which is what separates them from code `5`.
   */
  runOwnedElsewhere: 6,
  /**
   * An external effect from a PRIOR attempt of this run is unresolved, so a human must look at it before the
   * run can continue ([ADR-0080](../../../../docs/decisions/0080-durable-effect-journal-and-the-tiered-effect-contract.md) §2b;
   * [effect-journal.md](../../../../docs/reference/shared-core/effect-journal.md) §4, §8).
   *
   * Distinct from every code above it because the remedy is different in kind. `1` says the run failed and
   * can be re-run; `5` says a terminal may not have been recorded and to re-check after the next start; `6`
   * says wait and retry. This one says **do not retry** — a ticket may already be filed, a payment may
   * already have gone out — go look at the target, then resolve the row. Resuming again re-enters the same
   * gate and stops in the same place, by design.
   *
   * Deliberately NOT reported through `durability()`. That reads `uncertain` for ADR-0078's case — a
   * terminal that may not have reached the log — and its documented remedy ("held in the outbox and retried
   * on the next start") is false here: this run's terminal DID land durably, and nothing will drain. The
   * discriminator is the terminal's `ErrorCode`, not the durability disposition.
   */
  effectNeedsAttention: 7,
} as const;

export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];
