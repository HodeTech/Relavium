import type { LegendKey } from './legend.js';

/**
 * The pin toggle of the Home's tab host ([ADR-0140](../../../../../docs/decisions/0140-management-browsers-the-run-drill-down-and-the-durable-run-detail.md)
 * §5, MVP-8 step 4): `p` on a Defined row pins or unpins its workflow, and `p` on a History row does the same for its run. PURE, like the
 * tabs it serves: the store is behind a {@link PinPort} (`home/pin-port.ts` over `createRunPinStore`), so the toggle is testable without a
 * database and a test of the whole wiring can hand it the real store.
 *
 * - **A pin is a mark and never a request.** Nothing here changes a run or a workflow; a failed pin leaves everything as it was and says why.
 * - **The cap is a reason, not a fault.** The store refuses a fifty-first pin with `'full'`; the toggle changes nothing and the tab's
 *   message row says why ({@link pinFullMessage}).
 * - **The key is the store's, never a label.** A workflow is pinned by its catalog slug and a run by its full run id; a row whose key cannot
 *   be spelled (a pin whose workflow left the catalog, an over-long ref) is removed by its row id, the one handle a stale pin has. The
 *   label a message names is the row's own sanitized label.
 * - **Every outcome is read again by the caller.** The toggle says what it did; the tab reads its rows again afterwards, so the row's pin
 *   word is the store's and not the toggle's guess.
 */

/** What the store answered to a pin: written, already there, or refused at the cap. The store's own words. */
export type PinStoreResult = 'pinned' | 'already-pinned' | 'full';

/** The store behind the toggle. Every method may throw; the toggle turns a throw into `failed`. */
export interface PinPort {
  /** Pin the workflow of this project that the catalog calls `slug`. */
  readonly pinWorkflow: (slug: string) => PinStoreResult;
  /** Remove the pin of that workflow; `true` when a pin was removed. */
  readonly unpinWorkflow: (slug: string) => boolean;
  /** Pin the run with this full id, under the store's run key (no project root). */
  readonly pinRun: (runId: string) => PinStoreResult;
  readonly unpinRun: (runId: string) => boolean;
  /** Remove the pin whose row has this id: the way out for a pin whose key cannot be spelled. */
  readonly unpinRow: (rowid: number) => boolean;
  /**
   * What the store holds now, for a refusal at the cap on the History tab (it lists run pins only, so the person needs the stored total to see
   * why a pin was refused). Absent ⇒ the refusal does not name the counts. May throw: the refusal then does not name them either.
   */
  readonly counts?: (() => PinCounts) | undefined;
}

/** What the pin store holds: every pin, and how many of them are run pins. */
export interface PinCounts {
  readonly total: number;
  readonly runs: number;
}

/** What a toggle did. `message` is the sentence for the tab's message row. */
export interface PinToggle {
  readonly outcome: 'pinned' | 'unpinned' | 'absent' | 'full' | 'failed';
  readonly message: string;
}

/** The key `p` is bound to on a tab that can pin; the test presses it. */
export const PIN_KEY: LegendKey = { keys: 'p', verb: 'pin' };

/** The most pins the store holds, as the reason says it. The store's own bound is the authority; this is the number the sentence names. */
export const PIN_LIMIT_WORDS = '50';

/** What the tab says when it has no store to pin through. */
export const PIN_UNAVAILABLE = 'Pinning is unavailable in this session.';

/**
 * What the store holds, for a refusal at the cap: the store caps the pins in TOTAL (runs and every project's workflows), so the tab lists
 * only some of them and the person needs the whole count to see why a pin was refused.
 */
export interface PinsStored {
  /** Every pin the store holds. */
  readonly total: number;
  /** The ones this project's list does not hold: other projects' workflow pins and run pins. */
  readonly elsewhere: number;
}

/** What the Defined tab calls the pins it does not list: the workflow pins of other projects, and the run pins. */
const ELSEWHERE_ON_DEFINED = 'in other projects or runs';
/** What the History tab calls the pins it does not list: the workflow pins. */
const ELSEWHERE_ON_HISTORY = 'of them workflows';

/** The reason for a refusal at the cap; with the store's counts when the caller has them. `others` names the pins the tab does not list. */
export function pinFullMessage(
  label: string,
  stored?: PinsStored,
  others: string = ELSEWHERE_ON_DEFINED,
): string {
  if (stored === undefined)
    return `Cannot pin ${label}: ${PIN_LIMIT_WORDS} pins is the limit. Unpin one first.`;
  return `Cannot pin ${label}: ${PIN_LIMIT_WORDS} is the limit; ${String(stored.total)} stored, ${String(stored.elsewhere)} ${others}.`;
}

/**
 * The refusal at the cap on the History tab: the same sentence the Defined tab gives, with the store's own counts (the total, and how many of
 * them are not runs, which this list does not hold). Without a count, or when the store cannot be read, the sentence without them.
 */
export function runPinFullMessage(port: PinPort, label: string): string {
  let stored: PinsStored | undefined;
  try {
    const counts = port.counts?.();
    if (counts !== undefined)
      stored = { total: counts.total, elsewhere: counts.total - counts.runs };
  } catch {
    stored = undefined;
  }
  return pinFullMessage(label, stored, ELSEWHERE_ON_HISTORY);
}

/**
 * What an unpin says when the store held no such pin any more (another process removed it, or the row was stale): nothing was removed, and
 * the sentence says so instead of reporting a removal that did not happen.
 */
export function pinAbsentMessage(label: string): string {
  return `Nothing was removed: ${label} is not pinned.`;
}

/** What a toggle that threw says: content-free, because the cause may quote a stored value. */
export function pinFailedMessage(label: string): string {
  return `Could not change the pin of ${label}.`;
}

/**
 * Carry out a toggle: `act` runs the store calls and says what the pin is now. A throw is `failed` and changes nothing the tab shows
 * (the tab reads the rows again, so it shows what the store holds).
 */
function toggle(label: string, act: () => 'pinned' | 'unpinned' | 'absent' | 'full'): PinToggle {
  try {
    const outcome = act();
    if (outcome === 'full') return { outcome, message: pinFullMessage(label) };
    if (outcome === 'absent') return { outcome, message: pinAbsentMessage(label) };
    return {
      outcome,
      message: outcome === 'pinned' ? `Pinned ${label}.` : `Unpinned ${label}.`,
    };
  } catch {
    // A pin is a convenience mark, never a safety path: its failure is a sentence, and the typed cause is not echoed.
    return { outcome: 'failed', message: pinFailedMessage(label) };
  }
}

function pinResult(result: PinStoreResult): 'pinned' | 'full' {
  return result === 'full' ? 'full' : 'pinned';
}

/** What an unpin did, as the store answered it: `unpinned` only when a pin was removed. */
function removed(wasRemoved: boolean): 'unpinned' | 'absent' {
  return wasRemoved ? 'unpinned' : 'absent';
}

/** The removal of a pin by its row id; a pin with no row id has nothing to remove. */
function unpinRowOf(port: PinPort, rowid: number | undefined): boolean {
  return rowid === undefined ? false : port.unpinRow(rowid);
}

/** A Defined row to toggle: its catalog slug when it has one, and the pin it carries when it is pinned. */
export interface WorkflowPinTarget {
  /** The row's sanitized label, for the sentence. */
  readonly label: string;
  /** The catalog entry's own slug; `undefined` for a pin whose workflow left the catalog. */
  readonly slug: string | undefined;
  readonly pinned: boolean;
  /** The pin's row id: present exactly when the row is pinned. */
  readonly rowid: number | undefined;
}

/** Pin or unpin a workflow. A catalog row goes through its slug (`pinItem`/`unpinItem`); a pin the catalog no longer has, by its row. */
export function toggleWorkflowPin(port: PinPort, target: WorkflowPinTarget): PinToggle {
  return toggle(target.label, () => {
    const { slug, rowid } = target;
    if (!target.pinned) {
      if (slug === undefined)
        throw new Error('a workflow with no catalog entry is not pinned here');
      return pinResult(port.pinWorkflow(slug));
    }
    // Removed through the key when there is one (the key is the authority: a row id names whatever sits at that row now); a pin the
    // catalog no longer has has no key to spell, and goes by its row. The store says whether it removed one: when it did not, the
    // sentence says nothing was removed.
    return removed(slug !== undefined ? port.unpinWorkflow(slug) : unpinRowOf(port, rowid));
  });
}

/** A History row to toggle. */
export interface RunPinTarget {
  readonly label: string;
  /** The full run id; `undefined` for an entry that names no readable run (a pin whose run is gone). */
  readonly runId: string | undefined;
  readonly pinned: boolean;
  readonly rowid: number | undefined;
}

/** Pin or unpin a run under its canonical key (the full id, no project root); an entry with no readable run is removed by its row. */
export function toggleRunPin(port: PinPort, target: RunPinTarget): PinToggle {
  return toggle(target.label, () => {
    const { runId, rowid } = target;
    if (!target.pinned) {
      if (runId === undefined) throw new Error('an entry with no run is not pinned here');
      return pinResult(port.pinRun(runId));
    }
    return removed(runId !== undefined ? port.unpinRun(runId) : unpinRowOf(port, rowid));
  });
}
