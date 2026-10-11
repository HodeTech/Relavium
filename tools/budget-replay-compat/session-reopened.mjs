import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createClient,
  runMigrations,
  createSessionStore,
  createSessionUsageStore,
} from '@relavium/db';

const root = fileURLToPath(new URL('.', import.meta.url));
const client = createClient(join(root, 'databases/session-round-trip.sqlite'));
const operations = [
  'zero-cost',
  'owner-update',
  'message-insert',
  'message-delete',
  'cost-delete',
  'reparent-from',
  'reparent-to',
  'old-insert',
];
try {
  runMigrations(client.db, { dbPath: client.path });
  const store = createSessionStore(client.db),
    usage = createSessionUsageStore(client.db);
  const cases = [];
  for (const id of operations) {
    const before = usage.loadCoverage(id);
    // Both actual current writer operations run before the sticky-taint oracle. Numeric
    // revision==ack is a necessary acknowledgement witness, never proof of complete history.
    store.updateSession({ ...store.loadSession(id), updatedAt: '2026-10-10T00:00:02.000Z' });
    const afterWrite = usage.loadCoverage(id);
    const released = store.releaseSessionConservativeCommitments(id, 3);
    const snapshot = store.loadSessionCostBreakdown(id);
    const row = client.sqlite
      .prepare(
        'SELECT usage_mutation_revision AS revision, usage_ack_revision AS ack, usage_unverified AS unverified FROM agent_sessions WHERE id=?',
      )
      .get(id);
    const assertions = {
      oldWriteVisibleBeforeNewWrite: before.coverage.unverified === true,
      newWritePreservesTaint: afterWrite.coverage.unverified === true,
      estimateReleasePreservesAggregateTaint: snapshot.coverage.unverified === true,
      estimateReleasePreservesModelTaint: snapshot.models.every(
        (model) => model.coverage.unverified === true,
      ),
      finalRevisionAcknowledged: row.revision === row.ack,
      stickyTaintPersisted: row.unverified === 1,
      estimateReleaseDoesNotInventMoney: snapshot.totalCostMicrocents === 0,
      noInventedUnknownCalls: snapshot.coverage.unknownCalls === 0,
    };
    const passed = Object.values(assertions).every(Boolean);
    cases.push({
      id,
      status: passed ? 'passed' : 'failed',
      assertions,
      before,
      afterWrite,
      released,
      snapshot,
      row,
      ...(passed ? {} : { failure: 'USAGE_SESSION_REVISION_TAINT_LOST' }),
    });
  }
  assert.equal(store.loadSession('zero-cost').totalCostMicrocents, 0);
  assert.equal(store.loadSessionCosts('zero-cost')[0].callCount, 1);
  writeFileSync(
    join(root, 'results/session-reopened.json'),
    `${JSON.stringify({ completed: true, operations, stickyOwners: cases.filter((item) => item.status === 'passed').length, databaseClosed: true, zeroCostPreserved: true, oldCallCountPreserved: true, cases })}\n`,
  );
  assert.ok(
    cases.every((item) => item.status === 'passed'),
    'USAGE_SESSION_REVISION_TAINT_LOST',
  );
} finally {
  client.sqlite.close();
}
