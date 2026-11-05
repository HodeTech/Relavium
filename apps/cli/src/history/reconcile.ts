import { randomUUID } from 'node:crypto';

import { type NodeExecutor, WorkflowEngine } from '@relavium/core';
import { createRunHistoryStore, createRunLeasePort, type Db } from '@relavium/db';

import { createCliHost } from '../engine/host.js';

/**
 * The workflow scope the store is constructed with. The store reads its scope only to insert a `runs` row on
 * `run:started` and to mint a `workflows` row in `resolveWorkflowId`; `reconcile()` does neither, so these
 * values are never written.
 */
const RECONCILE_ONLY_SCOPE = {
  slug: 'relavium-reconcile-only',
  name: 'relavium-reconcile-only',
  definitionJson: '{}',
} as const;

/** The engine needs an executor; a reconcile-only engine starts no run, so any call to it is a wiring bug. */
const RECONCILE_ONLY_EXECUTOR: NodeExecutor = {
  execute: () => Promise.reject(new Error('a reconcile-only engine runs no node')),
};

/**
 * Settle the runs a dead process left behind, from a surface that has no engine of its own (2.6.G liveness,
 * #229). The Home calls this (through `openSessionStore`) when it opens, before its first read of the runs,
 * so a crashed run shows as failed rather than as a `running` row forever. `run`, `gate` and `budget resume`
 * call `engine.reconcile()` on the engine they already build.
 *
 * `reconcile()` first drains the terminal outbox (ADR-0078 §4), then writes `run:failed` for each interrupted
 * run: `internal`, or `budget_exceeded` after a recorded budget rejection. It leaves alone a run parked at a gate,
 * a run whose lease is live, which another process is executing (ADR-0079 §7), and a run whose held terminal it
 * could not write — every run, while the outbox exists but cannot be read. The store, the lease port and the
 * media-reference port are built over `db`, the same connection the caller reads from.
 *
 * `terminalOutboxPath` must belong to the same `~/.relavium` home as `db`: the drain DROPS an outbox entry
 * whose run is not open in `db`, so pairing one home's outbox with another home's database would delete
 * entries that still matter. `openSessionStore` makes that pairing; nothing else should.
 *
 * Best-effort and never rejects: a store fault here must not keep the Home from opening, and the next start
 * tries again.
 */
export async function reconcileInterruptedRuns(db: Db, terminalOutboxPath: string): Promise<void> {
  try {
    const store = createRunHistoryStore(db, {
      uuid: () => randomUUID(),
      now: () => Date.now(),
      workflow: RECONCILE_ONLY_SCOPE,
    });
    const host = createCliHost(store, {
      media: { referenceDb: db },
      terminalOutboxPath,
      runLeases: createRunLeasePort(store),
    });
    await new WorkflowEngine({ host, executor: RECONCILE_ONLY_EXECUTOR }).reconcile();
  } catch {
    // Best-effort, as documented above.
  }
}
