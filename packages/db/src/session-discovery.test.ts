import type { AgentSessionRecord } from '@relavium/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createClient, runMigrations, type DbClient } from './client.js';
import { createSessionStore, type SessionStore } from './session-store.js';
import { SessionDiscoveryBoundaryError } from './session-discovery.js';

const timestamp = '2026-11-10T00:00:00.000Z';
let client: DbClient, store: SessionStore;
beforeEach(() => {
  client = createClient(':memory:');
  runMigrations(client.db);
  store = createSessionStore(client.db);
});
afterEach(() => client.sqlite.close());
function seed(
  id: string,
  workingDir = '/workspace',
  title = id,
  changes: Partial<AgentSessionRecord> = {},
): void {
  store.createSession({
    id,
    agentSlug: 'chat',
    title,
    context: { workingDir, fsScopeTier: 'project' },
    status: 'active',
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCostMicrocents: 0,
    totalConservativeMicrocents: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...changes,
  });
}

describe('bounded indexed session discovery', () => {
  it('scopes in SQL, pages ties without duplicates and excludes tombstones', () => {
    for (const id of ['a', 'b', 'c', 'é', '中']) seed(id);
    seed('other', '/workspace-child');
    seed('deleted', '/workspace', 'deleted', { deletedAt: timestamp });
    const first = store.listSessionPage({ workingDir: '/workspace', limit: 2 });
    if (first.next === undefined) throw new Error('expected a second page');
    const second = store.listSessionPage({
      workingDir: '/workspace',
      limit: 2,
      cursor: first.next,
    });
    if (second.next === undefined) throw new Error('expected a third page');
    const third = store.listSessionPage({
      workingDir: '/workspace',
      limit: 2,
      cursor: second.next,
    });
    expect([...first.sessions, ...second.sessions, ...third.sessions].map((s) => s.id)).toEqual([
      '中',
      'é',
      'c',
      'b',
      'a',
    ]);
    expect(third.next).toBeUndefined();
    if (second.previous === undefined) throw new Error('expected a previous page');
    const back = store.listSessionPage({
      workingDir: '/workspace',
      limit: 2,
      cursor: second.previous,
      direction: 'backward',
    });
    expect(back.sessions).toEqual(first.sessions);
    expect(back.previous).toBeUndefined();
    expect(store.listSessionPage({ limit: 100 }).sessions).toHaveLength(6);
  });

  it.each([
    ['%', 'percent'],
    ['_', 'underscore'],
    ['\\', 'slash'],
  ])('treats title filter %j literally', (filter, id) => {
    seed('percent', '/workspace', '100% ready');
    seed('underscore', '/workspace', 'under_score');
    seed('slash', '/workspace', 'slash\\name');
    seed('normal');
    expect(store.listSessionPage({ title: filter }).sessions.map((s) => s.id)).toEqual([id]);
    expect(store.listSessionPage({ title: "%' OR 1=1 --" }).sessions).toEqual([]);
    expect(store.listSessionPage({ workingDir: "' OR 1=1 --" }).sessions).toEqual([]);
  });

  it.each([0, -1, 1.5, 101, Number.NaN, Number.POSITIVE_INFINITY])(
    'refuses invalid limit %s instead of an unbounded read',
    (limit) => {
      expect(() => store.listSessionPage({ limit })).toThrow(SessionDiscoveryBoundaryError);
    },
  );

  it('refuses invalid cursor/filter shape without echoing the supplied values', () => {
    expect(() =>
      store.listSessionPage({ cursor: { id: 'PRIVATE', updatedAt: 'not-an-iso-date' } }),
    ).toThrow('session discovery refused at the persistence boundary');
    expect(() => store.listSessionPage({ title: 'x'.repeat(257) })).toThrow(
      SessionDiscoveryBoundaryError,
    );
    expect(store.listSessionPage({ title: 'x'.repeat(256) }).sessions).toEqual([]);
  });

  it('loads a bounded discovery page without parsing snapshots or transcript bodies', () => {
    const insert = client.sqlite.prepare(
      'INSERT INTO agent_sessions (id, agent_slug, title, working_dir, context_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    client.sqlite.transaction(() => {
      for (let i = 0; i < 5000; i++)
        insert.run(
          `s-${String(i).padStart(5, '0')}`,
          'chat',
          'Saved session',
          '/workspace',
          JSON.stringify({ workingDir: '/workspace', fsScopeTier: 'project' }),
          Date.parse(timestamp),
          Date.parse(timestamp),
        );
    })();
    client.sqlite
      .prepare('UPDATE agent_sessions SET agent_snapshot = ?')
      .run('PRIVATE malformed snapshot');
    const page = store.listSessionPage({ workingDir: '/workspace', limit: 8 });
    expect(page.sessions).toHaveLength(8);
    expect(page.next).toBeDefined();
    expect(page.sessions[0]?.id).toBe('s-04999');
    const plan = client.sqlite
      .prepare(
        'EXPLAIN QUERY PLAN SELECT id, title FROM agent_sessions WHERE deleted_at IS NULL AND working_dir = ? ORDER BY updated_at DESC, id DESC LIMIT 9',
      )
      .all('/workspace');
    expect(JSON.stringify(plan)).toContain('idx_agent_sessions_working_dir_updated');
    expect(JSON.stringify(plan)).not.toContain('TEMP B-TREE');
  });
});
