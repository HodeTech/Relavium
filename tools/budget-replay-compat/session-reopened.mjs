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
  for (const id of operations) {
    assert.equal(usage.loadCoverage(id).coverage.unverified, true, id);
    store.updateSession({ ...store.loadSession(id), updatedAt: '2026-10-10T00:00:02.000Z' });
    assert.equal(usage.loadCoverage(id).coverage.unverified, true, id);
    store.releaseSessionConservativeCommitments(id, 3);
    const snapshot = store.loadSessionCostBreakdown(id);
    assert.equal(snapshot.coverage.unverified, true, id);
    for (const model of snapshot.models) assert.equal(model.coverage.unverified, true, id);
    const row = client.sqlite
      .prepare(
        'SELECT usage_mutation_revision AS revision, usage_ack_revision AS ack, usage_unverified AS unverified FROM agent_sessions WHERE id=?',
      )
      .get(id);
    assert.equal(row.revision, row.ack, id);
    assert.equal(row.unverified, 1, id);
  }
  assert.equal(store.loadSession('zero-cost').totalCostMicrocents, 0);
  assert.equal(store.loadSessionCosts('zero-cost')[0].callCount, 1);
  writeFileSync(
    join(root, 'results/session-reopened.json'),
    `${JSON.stringify({ completed: true, operations, stickyOwners: operations.length, databaseClosed: true, zeroCostPreserved: true, oldCallCountPreserved: true })}\n`,
  );
} finally {
  client.sqlite.close();
}
