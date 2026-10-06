import type { GateDecision, HumanGatePausedEvent } from '@relavium/shared';

import type { BudgetPromptContext } from './budget.js';

/**
 * Resolves an interactive human gate during a live run (**2.G**). The interactive TUI path supplies a
 * `@clack/prompts`-backed implementation ({@link createClackGatePrompter}); the non-interactive paths
 * (CI / `--json` / no-TTY) supply **none** — the run instead exits with the gate-paused code `3` to be resumed
 * out-of-band by `relavium gate`. Framework-free (no `@clack/prompts` import here) so the run-driving core can
 * depend on the seam without pulling the prompt library — the clack impl lives in its own module, exactly as
 * the `ink` renderer is split from the `RunRenderer` seam.
 *
 * `prompt` returns the built {@link GateDecision}, or `null` when the user cancels the prompt itself
 * (Ctrl-C / ESC) — the run core then cooperatively cancels the whole run.
 * The optional signal invalidates an open card when the run cancels or terminates. Implementations
 * should release their input resources on abort and return null; the driver discards any late answer.
 */
export interface GatePrompter {
  prompt: (
    event: HumanGatePausedEvent,
    budget?: BudgetPromptContext,
    signal?: AbortSignal,
  ) => Promise<GateDecision | null>;
}
