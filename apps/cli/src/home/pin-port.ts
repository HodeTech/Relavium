import type { RunPinStore } from '@relavium/db';

import type { PinPort } from '../render/tui/tab-host-pin.js';

/**
 * The pin toggle's store, over the Home's own `createRunPinStore` ([ADR-0140](../../../../docs/decisions/0140-management-browsers-the-run-drill-down-and-the-durable-run-detail.md)
 * §5, MVP-8 step 4). Thin on purpose: the keys are the store's.
 *
 * - **A workflow** is pinned under `{ kind: 'workflow', projectRoot, ref: slug }`, where the root is the project the Home is in, found
 *   afresh for every call (the same root the Defined tab lists the pins of), and the store makes it canonical.
 * - **A run** is pinned under `{ kind: 'run', projectRoot: '', ref: <the full run id> }`: a run id is global, so a second spelling of one
 *   run would be a second pin.
 * - **A row** is removed by its row id, for a pin whose key cannot be spelled back.
 */
export interface PinPortDeps {
  readonly store: Pick<RunPinStore, 'pinItem' | 'unpinItem' | 'unpinByRow'>;
  /** The directory a workflow pin is keyed by: the project root, or the working directory when there is no project. May throw. */
  readonly workflowRoot: () => string;
  /** Epoch milliseconds, for the pin's time. */
  readonly now: () => number;
}

export function createPinPort(deps: PinPortDeps): PinPort {
  return {
    pinWorkflow: (slug) =>
      deps.store.pinItem({
        kind: 'workflow',
        projectRoot: deps.workflowRoot(),
        ref: slug,
        at: deps.now(),
      }),
    unpinWorkflow: (slug) =>
      deps.store.unpinItem({ kind: 'workflow', projectRoot: deps.workflowRoot(), ref: slug }),
    pinRun: (runId) =>
      deps.store.pinItem({ kind: 'run', projectRoot: '', ref: runId, at: deps.now() }),
    unpinRun: (runId) => deps.store.unpinItem({ kind: 'run', projectRoot: '', ref: runId }),
    // A row id is good for the listing it came from, no longer: SQLite hands the number of a deleted last row to the next insert, and
    // `VACUUM` may renumber the table, so another process's write between the list and this call can make it name a different pin
    // (`unpinByRow` removes what the number names NOW). It is the only handle a pin whose key cannot be spelled has, and the window is
    // one list read to one key press; the register records it (deferred-tasks.md, "MVP-8 step 4 review").
    unpinRow: (rowid) => deps.store.unpinByRow(rowid),
  };
}
