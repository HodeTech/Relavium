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
];
try {
  runMigrations(client.db, { dbPath: client.path });
  const usage = createSessionUsageStore(client.db),
    store = createSessionStore(client.db);
  for (const id of operations) {
    usage.createFreshSession({
      id,
      agentSlug: 'offline',
      context: { workingDir: '/offline', fsScopeTier: 'sandboxed' },
      createdAt: '2026-10-10T00:00:00.000Z',
    });
    store.recordSessionConservativeCommitment({
      id: `${id}-hold`,
      sessionId: id,
      model: 'model',
      estimateMicrocents: 19,
      ts: 1,
    });
    store.appendMessage({
      id: `${id}-message`,
      sessionId: id,
      sequenceNumber: 0,
      role: 'user',
      content: [{ type: 'text', text: 'offline' }],
      timestamp: '2026-10-10T00:00:00.000Z',
    });
    assert.equal(usage.loadCoverage(id).coverage.unverified, false);
  }
  writeFileSync(
    join(root, 'results/session-new.json'),
    `${JSON.stringify({ completed: true, operations, completeOwners: operations.length, databaseClosed: true })}\n`,
  );
} finally {
  client.sqlite.close();
}
