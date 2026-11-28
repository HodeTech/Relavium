import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createClient, runMigrations, type DbClient } from './client.js';
import {
  createSessionStore,
  SessionMessageBoundaryError,
  type SessionStore,
} from './session-store.js';

/**
 * The record row's shape ([ADR-0148](../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md) §6) as far as the
 * step-5 round-1 mutation sweep found `migration-0023-upgrade.test.ts` and `session-store-record.test.ts` silent: a row that carries ONE record
 * field and no kind is refused by the CHECK, field by field (a mode alone, the other mode alone, an amount alone); the read side refuses the same
 * rows when the CHECKs were switched off (a half-set row never vanishes into a plain row); and a release of exactly one micro-cent is a release,
 * recorded.
 */
const TS = '2026-11-25T00:00:00.000Z';
const INSERT =
  'INSERT INTO session_messages (id, session_id, sequence_number, role, content_parts, interruption_reason, interruption_code, record_kind, record_from, record_to, record_microcents, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';

let client: DbClient;
let store: SessionStore;
beforeEach(() => {
  client = createClient(':memory:');
  runMigrations(client.db);
  store = createSessionStore(client.db);
  client.sqlite
    .prepare(
      'INSERT INTO agent_sessions (id, agent_slug, working_dir, fs_scope_tier, context_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    .run('s', 'chat', '/w', 'project', '{}', 0, 0);
});
afterEach(() => {
  client.sqlite.close();
});

/** One system row with exactly the record fields given (every other column as a record row has it). */
function add(
  sequence: number,
  fields: {
    readonly kind?: string;
    readonly from?: string;
    readonly to?: string;
    readonly microcents?: number;
  },
): void {
  client.sqlite
    .prepare(INSERT)
    .run(
      `m${String(sequence)}`,
      's',
      sequence,
      'system',
      '[]',
      null,
      null,
      fields.kind ?? null,
      fields.from ?? null,
      fields.to ?? null,
      fields.microcents ?? null,
      0,
    );
}

describe('a row with one record field and no kind is refused at rest', () => {
  it.each([
    ['a start mode alone', { from: 'ask' }],
    ['an end mode alone', { to: 'auto' }],
    ['an amount alone', { microcents: 5 }],
    ['an amount of zero alone', { microcents: 0 }],
  ] as const)('%s', (_name, fields) => {
    expect(() => add(0, fields)).toThrow(/CHECK/u);
    expect(client.sqlite.prepare('SELECT count(*) AS n FROM session_messages').get()).toEqual({
      n: 0,
    });
  });
});

describe('the read side refuses a one-field row with no kind even with the CHECKs switched off', () => {
  it.each([
    ['a start mode alone', { from: 'ask' }],
    ['an end mode alone', { to: 'auto' }],
    ['an amount alone', { microcents: 5 }],
  ] as const)('%s', (_name, fields) => {
    client.sqlite.pragma('ignore_check_constraints = ON');
    add(0, fields);
    client.sqlite.pragma('ignore_check_constraints = OFF');
    expect(() => store.loadMessages('s')).toThrow(SessionMessageBoundaryError);
  });
});

describe('a release of exactly one micro-cent', () => {
  it('clears it and appends one cost_release row naming exactly 1', () => {
    store.createSession({
      id: 'rel',
      agentSlug: 'chatter',
      context: { workingDir: '/workspace/s', fsScopeTier: 'sandboxed' },
      status: 'active',
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCostMicrocents: 0,
      totalConservativeMicrocents: 0,
      createdAt: TS,
      updatedAt: TS,
    });
    store.recordSessionConservativeCommitment({
      id: 'k',
      sessionId: 'rel',
      model: 'm',
      estimateMicrocents: 1,
      ts: 1,
    });
    const released = store.releaseSessionConservativeCommitments('rel', 9, {
      id: 'record-0',
      sequenceNumber: 0,
      timestamp: TS,
    });
    expect(released).toBe(1);
    expect(store.loadSession('rel')?.totalConservativeMicrocents).toBe(0);
    expect(store.loadMessages('rel')).toMatchObject([
      { id: 'record-0', record: { kind: 'cost_release', microcents: 1 } },
    ]);
  });
});
