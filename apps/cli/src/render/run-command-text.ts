import { sanitizeInline } from './sanitize.js';

/**
 * The one rule for naming a run in text a person may copy: a command line carries a run id only when the shell takes that id as one
 * plain word. Run ids the engine mints are UUIDs, but an id also arrives from a stream or a database row, and an id with a space, a
 * `;`, a backtick or a `$(` is not a word: a copied `relavium logs x; rm -rf ~` would run it. Every card, notice and final line that
 * names `relavium logs|status|gate <id>` uses this (the Home's cards, the final summary and the shared leg epilogue), so there is no
 * second check to drift.
 */

/**
 * A run id the shell takes as one plain word: letters, digits and `_ . : -`, never a leading dash, bounded. It is the predicate of
 * `resumeCommandBase` (`gate/budget.ts`) for the one identifier these texts name.
 */
const SHELL_INERT_ID = /^[A-Za-z0-9_.:][A-Za-z0-9_.:-]{0,159}$/;

/**
 * A run id as a card names it in prose: through the one-line floor, and with no backtick, because a backticked run of text in a card is
 * what a person copies as a command (an id of `` `touch x` `` would otherwise read as one). A UUID has none, so a real id is unchanged.
 */
export function displayRunId(runId: string): string {
  return sanitizeInline(runId).replaceAll('`', "'");
}

/**
 * The command that reads or continues a run, written as text the person may copy: `relavium logs <id>`, `relavium status <id>` or
 * `relavium gate <id>` for an id that is shell-inert, and for any other id the bare command with the id in prose, so a card never offers
 * a command line that carries a hostile id.
 */
export function relaviumRunCommand(command: 'logs' | 'status' | 'gate', runId: string): string {
  return SHELL_INERT_ID.test(runId)
    ? `\`relavium ${command} ${runId}\``
    : `\`relavium ${command}\` (for run ${displayRunId(runId)})`;
}
