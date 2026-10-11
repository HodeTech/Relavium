import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from './frozen/packages/db/src/client.ts';
import { createSessionStore } from './frozen/packages/db/src/session-store.ts';

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
  const store = createSessionStore(client.db);
  store.recordSessionCost({
    id: 'old-zero',
    sessionId: 'zero-cost',
    model: 'model',
    inputTokens: 0,
    outputTokens: 0,
    costMicrocents: 0,
    priced: true,
    ts: 2,
  });
  store.updateSession({
    ...store.loadSession('owner-update'),
    updatedAt: '2026-10-10T00:00:01.000Z',
  });
  store.appendMessage({
    id: 'old-message',
    sessionId: 'message-insert',
    sequenceNumber: 1,
    role: 'assistant',
    content: [{ type: 'text', text: 'offline' }],
    timestamp: '2026-10-10T00:00:01.000Z',
  });
  // The predecessor has no delete/reparent facade; exercise its actual native connection against
  // the tables its store owns, retaining the same old executable/schema/dependency graph.
  client.sqlite.prepare('DELETE FROM session_messages WHERE session_id=?').run('message-delete');
  client.sqlite.prepare('DELETE FROM session_costs WHERE session_id=?').run('cost-delete');
  client.sqlite
    .prepare('UPDATE session_messages SET session_id=?, sequence_number=7 WHERE session_id=?')
    .run('reparent-to', 'reparent-from');
  store.createSession({
    ...store.loadSession('owner-update'),
    id: 'old-insert',
    totalCostMicrocents: 0,
    totalConservativeMicrocents: 0,
  });
  for (const id of operations) {
    const row = client.sqlite
      .prepare(
        'SELECT usage_mutation_revision AS revision, usage_ack_revision AS ack, usage_unverified AS unverified FROM agent_sessions WHERE id=?',
      )
      .get(id);
    assert.ok(row.unverified === 1 || row.revision !== row.ack, id);
  }
  writeFileSync(
    join(root, 'results/session-old.json'),
    `${JSON.stringify({ completed: true, operations, sourcePath: 'packages/db/src/session-store.ts', sourceBlob: '9b4c5a1b5235dc44b110e41d7cc71cad5d071162', databaseClosed: true })}\n`,
  );
} finally {
  client.sqlite.close();
}
