/**
 * Whether work is in flight in a host RIGHT NOW ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
 * §2): a turn streaming, a submit settling (its auto-compaction included), a `!` command running, or (the Home) a native action holding the
 * keyboard. ONE function, read by both things that ask:
 *
 * - the **open gate** of each host (`chatPopupRefusal`, `homePopupRefusal`, through the one refusal of `popup-refusal.ts`): a popup does not
 *   open over any of it, and a refused open says so;
 * - the **release step of `/cost`** at the moment of its answer (`cost-session.ts`): the popup owns the keyboard, so nothing can start behind it,
 *   but an answer is never taken on a state read earlier, and a release is never carried out while any of this is in flight.
 *
 * One predicate, so the rule the gate applies and the rule the answer re-checks cannot drift apart; a data module (no `ink`, no `react`).
 */

/** The facts a host reads off its own state. */
export interface TurnFacts {
  /** The chat's store says a turn is `running`. */
  readonly running: boolean;
  /** A `!` shell command is in flight. */
  readonly shellBusy: boolean;
  /** A submit is in flight: a message turn, a slash command, the after-turn auto-compaction (the store's `running` covers only the streaming). */
  readonly submitBusy: boolean;
  /** A native action holds the keyboard and drops every key (the Home only). */
  readonly nativeActionBusy?: boolean | undefined;
}

/** Whether any of the facts holds: a turn, a submit, a shell command or a native action is in flight. */
export function turnInFlight(facts: TurnFacts): boolean {
  return facts.running || facts.shellBusy || facts.submitBusy || facts.nativeActionBusy === true;
}
