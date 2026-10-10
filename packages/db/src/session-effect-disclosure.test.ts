import { fork } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { effectScope, type AgentSessionRecord, type EffectCorrelation } from '@relavium/shared';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createClient, runMigrations, type Db, type DbClient } from './client.js';
import { createEffectJournalStore } from './effect-journal-store.js';
import { agentSessions, runEffects, sessionMessages } from './schema.js';
import { SessionEffectPrivacyError } from './session-effect-privacy.js';
import { createSessionStore, SessionMessageBoundaryError } from './session-store.js';

const timestamp = '2026-10-02T00:00:00.000Z';
const record: AgentSessionRecord = {
  id: 's1',
  agentSlug: 'chatter',
  context: { workingDir: '/workspace', fsScopeTier: 'sandboxed' },
  status: 'active',
  totalInputTokens: 0,
  totalOutputTokens: 0,
  totalCostMicrocents: 0,
  totalConservativeMicrocents: 0,
  createdAt: timestamp,
  updatedAt: timestamp,
};
let client: DbClient;
let root: string;
let counter: number;
const store = () =>
  createEffectJournalStore(client.db, { uuid: () => `e${String(++counter)}`, now: () => counter });
function effect(
  turn: number,
  slot = 0,
  id = `session-tool:${String(turn)}:${String(slot)}`,
  sessionId = 's1',
) {
  const correlation: EffectCorrelation = { kind: 'session', sessionId, turn };
  const identity = { scope: effectScope(correlation), slot, toolId: 'run_command' };
  store().prepare(
    identity,
    correlation,
    { providerAttempt: 1, toolCallId: id },
    3,
    'scrubbed-digest',
  );
  return identity;
}
function completed(turn: number, base: number, db: Db = client.db) {
  const session = createSessionStore(db);
  const id = `session-tool:${String(turn)}:0`;
  for (const message of [
    { role: 'user' as const, content: [{ type: 'text' as const, text: 'synthetic prompt' }] },
    {
      role: 'assistant' as const,
      content: [{ type: 'tool_call' as const, id, name: 'run_command', argsBytes: 7 }],
    },
    {
      role: 'tool' as const,
      content: [
        { type: 'tool_result' as const, toolCallId: id, resultBytes: 4, outcome: 'ok' as const },
      ],
    },
    { role: 'assistant' as const, content: [{ type: 'text' as const, text: '' }] },
  ]) {
    const sequenceNumber = base++;
    session.appendMessage({
      ...message,
      id: `m${String(sequenceNumber)}`,
      sessionId: 's1',
      sequenceNumber,
      timestamp,
    });
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'relavium-effect-disclosure-'));
  client = createClient(join(root, 'history.db'));
  counter = 0;
  runMigrations(client.db);
  createSessionStore(client.db).createSession(record);
});
afterEach(() => {
  vi.restoreAllMocks();
  client.sqlite.close();
  rmSync(root, { recursive: true, force: true });
});

describe('content-free disclosure snapshot and exact retention (ADR-0098)', () => {
  it('discloses committed evidence left by a real SIGKILL before any transcript persisted, then advances the key', async () => {
    const script = join(root, 'crash-after-settle.cjs');
    const nativeModule = createRequire(import.meta.url).resolve('better-sqlite3');
    // Native committed writes reproduce the exact crash window; no provider, key or external tool is involved.
    writeFileSync(
      script,
      `
const Database = require(${JSON.stringify(nativeModule)});
const db = new Database(process.argv[2]);
db.pragma('journal_mode = WAL');
db.pragma('secure_delete = ON');
db.pragma('busy_timeout = 5000');
const issued = db.transaction(() => db.prepare("UPDATE agent_sessions SET effect_turn_high_water = effect_turn_high_water + 1 WHERE id = 's1' RETURNING effect_turn_high_water AS key").get()).immediate();
const key = issued.key;
const scope = 'session:s1:' + key;
db.prepare('INSERT INTO run_effects (id, scope, slot, tool_id, tier, state, args_digest, attempt_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)').run('crash-effect', scope, 0, 'run_command', 3, 'prepared', 'synthetic-digest', JSON.stringify({providerAttempt:1, toolCallId:'session-tool:'+key+':0'}), 0, 0);
db.prepare("UPDATE run_effects SET state = 'committed', result_json = NULL WHERE id = 'crash-effect' AND state = 'prepared'").run();
process.send({key});
setInterval(() => {}, 1000);
`,
    );
    const child = fork(script, [client.path], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('owned crash probe did not settle')), 8000);
        child.once('error', reject);
        child.once('exit', () => reject(new Error('owned crash probe exited before settlement')));
        child.once('message', (message: unknown) => {
          if (
            message !== null &&
            typeof message === 'object' &&
            'key' in message &&
            message.key === 1
          )
            resolve();
          else reject(new Error('invalid crash probe acknowledgement'));
        });
      });
      child.kill('SIGKILL');
      await exited;
      expect(child.signalCode).toBe('SIGKILL');
      expect(createSessionStore(client.db).loadMessages('s1')).toEqual([]);
      const snapshot = store().readSessionDisclosureSnapshot('s1');
      expect(snapshot.disclosures).toEqual([
        { toolId: 'run_command', state: 'committed', reason: 'turn_incomplete' },
      ]);
      expect(store().sweepCommittedForSession('s1', snapshot.committed).deleted).toBe(1);
      expect(store().readSessionDisclosureSnapshot('s1').disclosures).toEqual([]);
      expect(createSessionStore(client.db).reserveEffectTurnKey('s1')).toBe(2);
    } finally {
      clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await exited;
      }
    }
  });

  it.each(['missing-terminal', 'orphan-call', 'abandoned'] as const)(
    'discloses a schema-valid call without completed-turn proof (%s)',
    (mode) => {
      const identity = effect(1);
      store().settle(identity, 'committed');
      const session = createSessionStore(client.db);
      const callId = 'session-tool:1:0';
      const messages = [
        ...(mode === 'orphan-call'
          ? []
          : [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'unfinished' }] }]),
        {
          role: 'assistant' as const,
          content: [{ type: 'tool_call' as const, id: callId, name: 'run_command', argsBytes: 2 }],
        },
        ...(mode === 'orphan-call'
          ? []
          : [
              {
                role: 'tool' as const,
                content: [
                  {
                    type: 'tool_result' as const,
                    toolCallId: callId,
                    resultBytes: 2,
                    outcome: 'ok' as const,
                  },
                ],
              },
            ]),
        ...(mode === 'abandoned'
          ? [
              {
                role: 'user' as const,
                content: [{ type: 'text' as const, text: 'different turn' }],
              },
              {
                role: 'assistant' as const,
                content: [{ type: 'text' as const, text: 'completed later' }],
              },
            ]
          : []),
      ];
      messages.forEach((message, sequenceNumber) =>
        session.appendMessage({
          ...message,
          id: `partial-${String(sequenceNumber)}`,
          sessionId: 's1',
          sequenceNumber,
          timestamp,
        }),
      );
      const snapshot = store().readSessionDisclosureSnapshot('s1');
      expect(snapshot.disclosures).toEqual([
        { toolId: 'run_command', state: 'committed', reason: 'unattributable' },
      ]);
      expect(snapshot.committed).toHaveLength(1);
      expect(client.db.select().from(runEffects).all()).toHaveLength(1);
    },
  );

  it('joins ALL history after compaction and distinguishes incomplete, legacy, command and unresolved effects', () => {
    const finished = effect(2);
    store().settle(finished, 'committed', 'not retained');
    completed(2, 0);
    createSessionStore(client.db).appendMessage({
      id: 'marker',
      sessionId: 's1',
      sequenceNumber: 4,
      role: 'system',
      content: [{ type: 'text', text: 'summary' }],
      compaction: { droppedThroughSequence: 3 },
      timestamp,
    });
    const crashed = effect(7);
    store().settle(crashed, 'committed');
    const legacy = effect(3, 0, 'session');
    store().settle(legacy, 'committed');
    const command = effect(8, -1, 'session-command:8:1');
    store().settle(command, 'committed');
    effect(9);
    const ambiguous = effect(10, -1, 'session-command:10:1');
    store().settle(ambiguous, 'ambiguous');
    // This legacy result must not be selected, parsed or exposed even before maintenance clears it.
    client.db
      .update(runEffects)
      .set({ resultJson: 'SYNTHETIC_PRIVATE_RESULT' })
      .where(eq(runEffects.scope, crashed.scope))
      .run();
    const prepare = vi.spyOn(client.sqlite, 'prepare');
    const snapshot = store().readSessionDisclosureSnapshot('s1');
    expect(snapshot.committed).toHaveLength(4);
    expect(snapshot.disclosures).toEqual([
      { toolId: 'run_command', state: 'committed', reason: 'turn_incomplete' },
      { toolId: 'run_command', state: 'committed', reason: 'unattributable' },
      { toolId: 'run_command', state: 'prepared', reason: 'unresolved' },
      { toolId: 'run_command', state: 'ambiguous', reason: 'unresolved' },
    ]);
    const effectQuery = prepare.mock.calls.find(
      ([query]) => query.startsWith('select') && query.includes('run_effects'),
    );
    expect(effectQuery?.[0]).not.toContain('result_json');
    expect(JSON.stringify(snapshot)).not.toContain('PRIVATE_RESULT');
    expect(store().sweepCommittedForSession('s1', snapshot.committed)).toEqual({
      deleted: 4,
      checkpoint: 'complete',
    });
    expect(
      store()
        .readSessionDisclosureSnapshot('s1')
        .disclosures.map((x) => x.state),
    ).toEqual(['prepared', 'ambiguous']);
  });

  it('treats corrupt or mismatched attempt identities conservatively, without parser diagnostics', () => {
    const malformed = effect(1);
    store().settle(malformed, 'committed');
    client.db
      .update(runEffects)
      .set({ attemptJson: '{SYNTHETIC_SECRET' })
      .where(eq(runEffects.scope, malformed.scope))
      .run();
    const mismatch = effect(2, 0, 'session-tool:1:0');
    store().settle(mismatch, 'committed');
    completed(1, 0);
    const nameMismatch = effect(3);
    store().settle(nameMismatch, 'committed');
    completed(3, 4);
    client.db
      .update(runEffects)
      .set({ toolId: 'http_request' })
      .where(eq(runEffects.scope, nameMismatch.scope))
      .run();
    expect(
      store()
        .readSessionDisclosureSnapshot('s1')
        .disclosures.map((x) => x.reason),
    ).toEqual(['unattributable', 'unattributable', 'unattributable']);
  });

  it('refuses an unreadable historical transcript rather than consuming its audit evidence', () => {
    const crashed = effect(1);
    store().settle(crashed, 'committed');
    completed(2, 0);
    client.db
      .update(sessionMessages)
      .set({ contentParts: '{SYNTHETIC_SECRET' })
      .where(eq(sessionMessages.id, 'm1'))
      .run();
    expect(() => store().readSessionDisclosureSnapshot('s1')).toThrow(SessionMessageBoundaryError);
    expect(client.db.select().from(runEffects).all()).toHaveLength(1);
  });

  it('rejects reads and sweeps inside an outer transaction, including a native BEGIN', () => {
    const identity = effect(1);
    store().settle(identity, 'committed');
    const snapshot = store().readSessionDisclosureSnapshot('s1');
    client.db.transaction(() => {
      expect(() => store().readSessionDisclosureSnapshot('s1')).toThrow(SessionEffectPrivacyError);
      expect(() => store().sweepCommittedForSession('s1', snapshot.committed)).toThrow(
        SessionEffectPrivacyError,
      );
      expect(() => runMigrations(client.db)).toThrow(SessionEffectPrivacyError);
    });
    client.sqlite.exec('BEGIN');
    try {
      expect(() => store().readSessionDisclosureSnapshot('s1')).toThrow(SessionEffectPrivacyError);
    } finally {
      client.sqlite.exec('ROLLBACK');
    }
    expect(client.db.select().from(runEffects).all()).toHaveLength(1);
  });

  it('retains post-read commits, changed states, foreign scopes and same-id replacement rows', () => {
    const old = effect(1);
    store().settle(old, 'committed');
    const changed = effect(2);
    store().settle(changed, 'committed');
    const prepared = effect(3);
    const foreign = effect(1, 0, 'session-tool:1:0', 's10');
    store().settle(foreign, 'committed');
    const snapshot = store().readSessionDisclosureSnapshot('s1');
    const oldRow = snapshot.committed.find((x) => x.identity.scope === old.scope);
    if (oldRow === undefined) throw new Error('missing fixture');
    client.db.delete(runEffects).where(eq(runEffects.id, oldRow.id)).run();
    const reused = createEffectJournalStore(client.db, { uuid: () => oldRow.id, now: () => 100 });
    const replacement = { ...old, scope: 'session:s1:4' };
    reused.prepare(
      replacement,
      { kind: 'session', sessionId: 's1', turn: 4 },
      { providerAttempt: 1, toolCallId: 'session-tool:4:0' },
      3,
      'new digest',
    );
    reused.settle(replacement, 'committed');
    store().settle(prepared, 'committed');
    client.db
      .update(runEffects)
      .set({ state: 'needs_attention' })
      .where(eq(runEffects.scope, changed.scope))
      .run();
    const foreignRow = store().readSessionDisclosureSnapshot('s10').committed;
    expect(
      store().sweepCommittedForSession('s1', [...snapshot.committed, ...foreignRow]).deleted,
    ).toBe(0);
    expect(client.db.select().from(runEffects).all()).toHaveLength(4);
  });

  it('rolls back ALL chunks when a later chunk cannot be deleted and counts actual deletions', () => {
    for (let turn = 1; turn <= 101; turn++) {
      const id = effect(turn);
      store().settle(id, 'committed');
    }
    const snapshot = store().readSessionDisclosureSnapshot('s1');
    const last = snapshot.committed.at(-1);
    if (last === undefined) throw new Error('missing fixture');
    expect(last.identity.scope).toBe('session:s1:101');
    client.sqlite.exec(
      "CREATE TEMP TRIGGER refuse_late_delete BEFORE DELETE ON run_effects WHEN OLD.scope = 'session:s1:101' BEGIN SELECT RAISE(ABORT, 'synthetic refusal'); END",
    );
    expect(() => store().sweepCommittedForSession('s1', snapshot.committed)).toThrow();
    expect(client.db.select().from(runEffects).all()).toHaveLength(101);
    expect(
      client.db.select({ key: agentSessions.effectTurnHighWater }).from(agentSessions).get(),
    ).toEqual({ key: 0 }); // Seeding and every deletion chunk roll back together.
    client.sqlite.exec('DROP TRIGGER refuse_late_delete');
    expect(store().sweepCommittedForSession('s1', snapshot.committed).deleted).toBe(101);
    expect(store().sweepCommittedForSession('s1', snapshot.committed).deleted).toBe(0);
    expect(createSessionStore(client.db).reserveEffectTurnKey('s1')).toBe(102);
  });

  it('keeps the effects and transcript on the SAME read snapshot across a concurrent completion', () => {
    const id = effect(1);
    store().settle(id, 'committed');
    const other = createClient(join(root, 'history.db'));
    const prepare = client.sqlite.prepare.bind(client.sqlite);
    let injected = false;
    vi.spyOn(client.sqlite, 'prepare').mockImplementation((query) => {
      if (!injected && query.startsWith('select') && query.includes('session_messages')) {
        injected = true;
        completed(1, 0, other.db);
      }
      return prepare(query);
    });
    try {
      expect(store().readSessionDisclosureSnapshot('s1').disclosures).toEqual([
        { toolId: 'run_command', state: 'committed', reason: 'turn_incomplete' },
      ]);
      vi.restoreAllMocks();
      expect(store().readSessionDisclosureSnapshot('s1').disclosures).toEqual([]);
    } finally {
      other.sqlite.close();
    }
  });
});
