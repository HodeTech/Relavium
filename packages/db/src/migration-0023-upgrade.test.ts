import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectSessionHistory, SessionMessageSchema, type SessionMessage } from '@relavium/shared';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, describe, expect, it } from 'vitest';
import { createClient, type DbClient } from './client.js';
import { createSessionStore, SessionMessageBoundaryError } from './session-store.js';
import { createSessionUsageStore } from './session-usage-store.js';

/**
 * Migration 0023 ([ADR-0148](../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md) §6): the record row's
 * four columns, added in place (never a rebuild: the ADR-0104 triggers and the table's root page stay), CHECK-constrained so that only the
 * two closed shapes can be stored, and read back through the session store's explicit column list.
 */
const migrationsFolder = fileURLToPath(new URL('../drizzle', import.meta.url));
let client: DbClient | undefined, temporary: string | undefined;
afterEach(() => {
  client?.sqlite.close();
  if (temporary !== undefined) rmSync(temporary, { recursive: true, force: true });
});

/** A database as migration 0022 left it, holding one legacy session. */
function openOld(): DbClient {
  temporary = mkdtempSync(join(tmpdir(), 'relavium-migration-0023-'));
  const folder = join(temporary, 'old-migrations');
  mkdirSync(join(folder, 'meta'), { recursive: true });
  const metadata = readMigrationFiles({ migrationsFolder });
  const names = readdirSync(migrationsFolder)
    .filter((name) => /^\d{4}_.*\.sql$/u.test(name))
    .sort()
    .slice(0, 23);
  expect(names.at(-1)).toBe('0022_lethal_jackpot.sql');
  for (const name of names) copyFileSync(join(migrationsFolder, name), join(folder, name));
  writeFileSync(
    join(folder, 'meta/_journal.json'),
    JSON.stringify({
      version: '7',
      dialect: 'sqlite',
      entries: names.map((name, idx) => ({
        idx,
        version: '6',
        when: metadata[idx]?.folderMillis,
        tag: name.slice(0, -4),
        breakpoints: true,
      })),
    }),
  );
  client = createClient(join(temporary, 'history.db'));
  migrate(client.db, { migrationsFolder: folder });
  client.sqlite
    .prepare(
      'INSERT INTO agent_sessions (id, agent_slug, working_dir, fs_scope_tier, context_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    .run(
      'legacy',
      'chat',
      '/workspace',
      'project',
      JSON.stringify({ workingDir: '/workspace', fsScopeTier: 'project' }),
      0,
      0,
    );
  return client;
}

/** The 0022 binary's column set for a transcript row: what an older writer names. */
const OLD_INSERT =
  'INSERT INTO session_messages (id, session_id, sequence_number, role, content_parts, compaction_dropped_through_sequence, interruption_reason, interruption_code, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)';
const RECORD_INSERT =
  'INSERT INTO session_messages (id, session_id, sequence_number, role, content_parts, compaction_dropped_through_sequence, interruption_reason, interruption_code, record_kind, record_from, record_to, record_microcents, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';

const TS = '2026-11-25T00:00:00.000Z';

describe('migration 0023 — record rows (ADR-0148 §6)', () => {
  it('keeps every legacy row byte-identical with NULL record columns, keeps the triggers and the root page, and an older writer still works', () => {
    const opened = openOld();
    const text = JSON.stringify([{ type: 'text', text: 'legacy private context' }]);
    const old = opened.sqlite.prepare(OLD_INSERT);
    old.run('old-user', 'legacy', 0, 'user', text, null, null, null, 0);
    old.run('old-interrupted', 'legacy', 1, 'system', '[]', null, 'failed', 'tool_failed', 0);
    old.run('old-marker', 'legacy', 2, 'system', '[]', 0, null, null, 0);
    const schemaOf = () =>
      opened.sqlite
        .prepare(
          "SELECT type, name, rootpage FROM sqlite_master WHERE tbl_name = 'session_messages' ORDER BY type, name",
        )
        .all();
    const before = schemaOf();
    expect(before.some((entry) => (entry as { type: string }).type === 'trigger')).toBe(true);
    migrate(opened.db, { migrationsFolder });
    expect(schemaOf()).toEqual(before);
    expect(
      opened.sqlite
        .prepare(
          'SELECT id, content_parts, interruption_reason AS r, interruption_code AS k, compaction_dropped_through_sequence AS c, record_kind AS rk, record_from AS rf, record_to AS rt, record_microcents AS rm FROM session_messages ORDER BY sequence_number',
        )
        .all(),
    ).toEqual([
      {
        id: 'old-user',
        content_parts: text,
        r: null,
        k: null,
        c: null,
        rk: null,
        rf: null,
        rt: null,
        rm: null,
      },
      {
        id: 'old-interrupted',
        content_parts: '[]',
        r: 'failed',
        k: 'tool_failed',
        c: null,
        rk: null,
        rf: null,
        rt: null,
        rm: null,
      },
      {
        id: 'old-marker',
        content_parts: '[]',
        r: null,
        k: null,
        c: 0,
        rk: null,
        rf: null,
        rt: null,
        rm: null,
      },
    ]);
    // An older binary names only the old column set.
    old.run('old-writer', 'legacy', 3, 'user', text, null, null, null, 0);
    const store = createSessionStore(opened.db);
    const loaded = store.loadMessages('legacy');
    expect(loaded.map((row) => row.id)).toEqual([
      'old-user',
      'old-interrupted',
      'old-marker',
      'old-writer',
    ]);
    expect(loaded.some((row) => 'record' in row)).toBe(false);
    expect(loaded[1]?.interruption).toEqual({ reason: 'failed', code: 'tool_failed' });
  });

  it('stores the two record shapes and refuses every forged shape at rest', () => {
    const opened = openOld();
    migrate(opened.db, { migrationsFolder });
    const insert = opened.sqlite.prepare(RECORD_INSERT);
    let sequence = 0;
    const add = (fields: {
      readonly role?: string;
      readonly content?: string | null;
      readonly compaction?: number | null;
      readonly reason?: string | null;
      readonly code?: string | null;
      readonly kind?: string | null;
      readonly from?: string | null;
      readonly to?: string | null;
      readonly microcents?: number | string | null;
    }): void => {
      insert.run(
        `m-${sequence}`,
        'legacy',
        sequence++,
        fields.role ?? 'system',
        fields.content === undefined ? '[]' : fields.content,
        fields.compaction ?? null,
        fields.reason ?? null,
        fields.code ?? null,
        fields.kind ?? null,
        fields.from ?? null,
        fields.to ?? null,
        fields.microcents ?? null,
        0,
      );
    };
    // valid
    add({ kind: 'mode_change', from: 'ask', to: 'auto' });
    add({ kind: 'mode_change', from: 'auto', to: 'plan' });
    add({ kind: 'mode_change', from: 'plan', to: 'accept-edits', content: null });
    add({ kind: 'cost_release', microcents: 0 });
    add({ kind: 'cost_release', microcents: 9_007_199_254_740_991 });
    add({ role: 'user', content: '[{"type":"text","text":"hi"}]' }); // an ordinary row: every record column NULL
    // forged
    const forged: readonly [string, Parameters<typeof add>[0]][] = [
      [
        'a record with content',
        { kind: 'cost_release', microcents: 1, content: '[{"type":"text","text":"injected"}]' },
      ],
      ['a record on a user row', { kind: 'mode_change', from: 'ask', to: 'auto', role: 'user' }],
      ['a record on an assistant row', { kind: 'cost_release', microcents: 1, role: 'assistant' }],
      ['a record on a tool row', { kind: 'cost_release', microcents: 1, role: 'tool' }],
      ['a record on a boundary marker', { kind: 'cost_release', microcents: 1, compaction: 0 }],
      [
        'a record on an interruption row',
        { kind: 'mode_change', from: 'ask', to: 'auto', reason: 'aborted' },
      ],
      [
        'a record on a failed interruption row',
        { kind: 'cost_release', microcents: 1, reason: 'failed', code: 'tool_failed' },
      ],
      ['a mode change to the same mode', { kind: 'mode_change', from: 'auto', to: 'auto' }],
      ['an unknown mode', { kind: 'mode_change', from: 'ask', to: 'yolo' }],
      ['an unknown from-mode', { kind: 'mode_change', from: 'ASK', to: 'auto' }],
      ['a mode change missing its start', { kind: 'mode_change', to: 'auto' }],
      ['a mode change missing its end', { kind: 'mode_change', from: 'ask' }],
      [
        'a mode change carrying an amount',
        { kind: 'mode_change', from: 'ask', to: 'auto', microcents: 1 },
      ],
      ['a release naming a mode', { kind: 'cost_release', microcents: 1, from: 'ask' }],
      ['a release naming an end mode', { kind: 'cost_release', microcents: 1, to: 'auto' }],
      ['a release with no amount', { kind: 'cost_release' }],
      ['a negative amount', { kind: 'cost_release', microcents: -1 }],
      ['a non-integer amount', { kind: 'cost_release', microcents: 1.5 }],
      ['a textual amount', { kind: 'cost_release', microcents: 'five' }],
      [
        'an amount past the safe integers',
        { kind: 'cost_release', microcents: 9_007_199_254_740_992 },
      ],
      ['an unknown kind', { kind: 'grant', from: 'ask', to: 'auto' }],
      ['fields with no kind (a half-set row)', { from: 'ask', to: 'auto' }],
      ['an amount with no kind', { microcents: 1 }],
    ];
    for (const [name, fields] of forged) expect(() => add(fields), name).toThrow(/CHECK/u);
    expect(opened.sqlite.prepare('SELECT count(*) AS n FROM session_messages').get()).toEqual({
      n: 6,
    });
  });

  it('round-trips a record row through the session store with its typed field, in loadMessages and loadFull', () => {
    const opened = openOld();
    migrate(opened.db, { migrationsFolder });
    const store = createSessionStore(opened.db);
    const base = { sessionId: 'legacy', role: 'system' as const, content: [], timestamp: TS };
    store.appendMessage({
      ...base,
      id: 'mode',
      sequenceNumber: 0,
      record: { kind: 'mode_change', from: 'ask', to: 'auto' },
    });
    store.appendMessage({
      ...base,
      id: 'release',
      sequenceNumber: 1,
      record: { kind: 'cost_release', microcents: 4_200 },
    });
    const expected = [
      { id: 'mode', record: { kind: 'mode_change', from: 'ask', to: 'auto' } },
      { id: 'release', record: { kind: 'cost_release', microcents: 4_200 } },
    ];
    expect(store.loadMessages('legacy')).toMatchObject(expected);
    expect(store.loadFull('legacy')?.messages).toMatchObject(expected);
    expect(
      opened.sqlite
        .prepare(
          'SELECT record_kind AS k, record_from AS f, record_to AS t, record_microcents AS m, content_parts AS c, role FROM session_messages ORDER BY sequence_number',
        )
        .all(),
    ).toEqual([
      { k: 'mode_change', f: 'ask', t: 'auto', m: null, c: '[]', role: 'system' },
      { k: 'cost_release', f: null, t: null, m: 4_200, c: '[]', role: 'system' },
    ]);
    // The store refuses an invalid record at its own boundary, before the database.
    expect(() =>
      store.appendMessage({
        ...base,
        id: 'forged',
        sequenceNumber: 2,
        record: { kind: 'mode_change', from: 'auto', to: 'auto' },
      }),
    ).toThrow(SessionMessageBoundaryError);
  });

  it.each([
    ['fields with no kind (a half-set row)', [null, 'ask', 'auto', null, '[]']],
    ['an amount with no kind', [null, null, null, 5, '[]']],
    ['a mode change carrying an amount', ['mode_change', 'ask', 'auto', 5, '[]']],
    ['a release naming a mode', ['cost_release', 'ask', null, 5, '[]']],
    ['an unknown kind', ['grant', 'ask', 'auto', null, '[]']],
    ['a mode change to the same mode', ['mode_change', 'auto', 'auto', null, '[]']],
    [
      'a record with content',
      ['cost_release', null, null, 5, '[{"type":"text","text":"SECRET-INJECTED-TEXT"}]'],
    ],
  ] as const)(
    'refuses to load a session whose record row was tampered with past the CHECKs: %s',
    (_name, [kind, from, to, microcents, content]) => {
      const opened = openOld();
      migrate(opened.db, { migrationsFolder });
      const store = createSessionStore(opened.db);
      // Whoever can edit history.db can switch the CHECKs off; the read side must still fail closed, with a fixed error that does not echo
      // the stored text, and never silently drop a field it was not built to carry.
      opened.sqlite.pragma('ignore_check_constraints = ON');
      opened.sqlite
        .prepare(RECORD_INSERT)
        .run(
          'tampered',
          'legacy',
          0,
          'system',
          content,
          null,
          null,
          null,
          kind,
          from,
          to,
          microcents,
          0,
        );
      opened.sqlite.pragma('ignore_check_constraints = OFF');
      let refusal: unknown;
      try {
        store.loadMessages('legacy');
      } catch (error) {
        refusal = error;
      }
      expect(refusal).toBeInstanceOf(SessionMessageBoundaryError);
      expect(String((refusal as Error).message)).not.toContain('SECRET-INJECTED-TEXT');
    },
  );

  it('an older reader (the 0022 explicit column list) reads a record row as an inert system row: the documented downgrade', () => {
    const opened = openOld();
    migrate(opened.db, { migrationsFolder });
    const store = createSessionStore(opened.db);
    const at = (sequenceNumber: number, over: Partial<SessionMessage>): SessionMessage => ({
      id: `m-${sequenceNumber}`,
      sessionId: 'legacy',
      sequenceNumber,
      role: 'user',
      content: [{ type: 'text', text: `t${sequenceNumber}` }],
      timestamp: TS,
      ...over,
    });
    store.writeTurn({
      messages: [
        at(0, {
          role: 'system',
          content: [],
          record: { kind: 'mode_change', from: 'ask', to: 'auto' },
        }),
        at(1, {}),
        at(2, { role: 'assistant' }),
        at(3, { role: 'system', content: [], record: { kind: 'cost_release', microcents: 7 } }),
      ].map((message) => ({ message })),
    });
    // The predecessor's `loadMessages` names the 0022 columns only, so it never reads a record column, and its mapper builds the row
    // without one: a system row with no content and no interruption, which the one history projection skips. No guard is built for it.
    const oldRows = opened.sqlite
      .prepare(
        'SELECT id, session_id, sequence_number, role, content_parts, compaction_dropped_through_sequence, interruption_reason, created_at FROM session_messages ORDER BY sequence_number',
      )
      .all() as {
      id: string;
      session_id: string;
      sequence_number: number;
      role: string;
      content_parts: string;
      compaction_dropped_through_sequence: number | null;
      interruption_reason: string | null;
      created_at: number;
    }[];
    const oldMessages = oldRows.map((row) =>
      SessionMessageSchema.parse({
        id: row.id,
        sessionId: row.session_id,
        sequenceNumber: row.sequence_number,
        role: row.role,
        content: JSON.parse(row.content_parts) as unknown,
        timestamp: new Date(row.created_at).toISOString(),
      }),
    );
    expect(oldMessages.filter((m) => m.role === 'system').map((m) => m.content)).toEqual([[], []]);
    const projected = projectSessionHistory(oldMessages);
    expect(projected.turns).toHaveLength(1);
    expect(projected.turns[0]?.messages.map((m) => m.id)).toEqual(['m-1', 'm-2']);
  });

  it('a record insert through the store keeps a fresh session’s usage coverage verified (ADR-0104: the trigger bump is acknowledged in the same transaction)', () => {
    const opened = openOld();
    migrate(opened.db, { migrationsFolder });
    const usage = createSessionUsageStore(opened.db);
    usage.createFreshSession({
      id: 'fresh',
      agentSlug: 'chat',
      context: { workingDir: '/workspace', fsScopeTier: 'project' },
      createdAt: TS,
    });
    const revisions = () =>
      opened.sqlite
        .prepare(
          "SELECT usage_mutation_revision AS revision, usage_ack_revision AS ack, usage_unverified AS unverified FROM agent_sessions WHERE id = 'fresh'",
        )
        .get() as { revision: number; ack: number; unverified: number };
    const before = revisions();
    expect(usage.loadCoverage('fresh')?.coverage.unverified).toBe(false);
    createSessionStore(opened.db).writeTurn({
      messages: [
        {
          message: {
            id: 'record',
            sessionId: 'fresh',
            sequenceNumber: 0,
            role: 'system',
            content: [],
            record: { kind: 'mode_change', from: 'ask', to: 'accept-edits' },
            timestamp: TS,
          },
        },
      ],
    });
    const after = revisions();
    // The insert DID move the revision (the trigger fired), and the same transaction acknowledged it.
    expect(after.revision).toBeGreaterThan(before.revision);
    expect(after.ack).toBe(after.revision);
    expect(after.unverified).toBe(0);
    expect(usage.loadCoverage('fresh')?.coverage.unverified).toBe(false);
  });
});
