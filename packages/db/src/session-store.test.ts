import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AgentSchema, type AgentSessionRecord, type SessionMessage } from '@relavium/shared';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createClient, runMigrations, type DbClient } from './client.js';
import { agentSessions, llmProviders, modelCatalog, sessionMessages } from './schema.js';
import { createSessionStore, fromAgentSessionRow, type SessionStore } from './session-store.js';

/** Seed a provider + model_catalog row so a session/message `model_id` FK resolves (catalog UUID). */
function seedModelCatalog(client: DbClient): void {
  client.db
    .insert(llmProviders)
    .values({
      id: 'prov-1',
      name: 'anthropic',
      displayName: 'Anthropic',
      baseUrl: 'https://api.anthropic.com',
      createdAt: TS_MS,
      updatedAt: TS_MS,
    })
    .run();
  client.db
    .insert(modelCatalog)
    .values({
      id: 'model-1',
      providerId: 'prov-1',
      modelId: 'claude-opus-4-8',
      displayName: 'Opus 4.8',
      contextWindowTokens: 200_000,
      maxOutputTokens: 64_000,
      createdAt: TS_MS,
      updatedAt: TS_MS,
    })
    .run();
}

/**
 * 1.X session-persistence round-trip: persist an `agent_sessions` row + its append-only
 * `session_messages` transcript through the `SessionStore`, reload it (the resume path), and assert the
 * durable contract holds — gap-free ordering, cascade delete, the CHECK constraints, and durable content
 * (handle-only media, signature-less reasoning) surviving a round-trip.
 */

const TS_ISO = '2026-06-17T08:00:00.000Z';
const TS_MS = Date.parse(TS_ISO); // epoch-ms for raw inserts that bypass the mapper
const HANDLE = `media://sha256-${'a'.repeat(64)}`;
const CTX = { workingDir: '/workspace/s', fsScopeTier: 'sandboxed' as const };

const makeSession = (overrides: Partial<AgentSessionRecord> = {}): AgentSessionRecord => ({
  id: 'sess-1',
  agentSlug: 'chatter',
  context: CTX,
  status: 'active',
  totalInputTokens: 0,
  totalOutputTokens: 0,
  totalCostMicrocents: 0,
  createdAt: TS_ISO,
  updatedAt: TS_ISO,
  ...overrides,
});

const makeMessage = (seq: number, overrides: Partial<SessionMessage> = {}): SessionMessage => ({
  id: `msg-${seq}`,
  sessionId: 'sess-1',
  sequenceNumber: seq,
  role: 'user',
  content: [{ type: 'text', text: 'hi' }],
  timestamp: TS_ISO,
  ...overrides,
});

let client: DbClient;
let store: SessionStore;

beforeEach(() => {
  client = createClient(':memory:');
  runMigrations(client.db);
  store = createSessionStore(client.db);
});

afterEach(() => {
  client.sqlite.close();
});

describe('SessionStore (1.X) — persist + resume', () => {
  it('round-trips a session and its ordered transcript (the resume path)', () => {
    store.createSession(makeSession({ title: 'My chat' }));
    store.appendMessage(makeMessage(0, { content: [{ type: 'text', text: 'hello' }] }));
    store.appendMessage(
      makeMessage(1, { role: 'assistant', content: [{ type: 'text', text: 'hi there' }] }),
    );

    const full = store.loadFull('sess-1');
    expect(full).toBeDefined();
    expect(full?.session).toEqual(makeSession({ title: 'My chat' }));
    expect(full?.messages.map((m) => m.sequenceNumber)).toEqual([0, 1]);
    expect(full?.messages[0]?.content).toEqual([{ type: 'text', text: 'hello' }]);
    expect(full?.messages[1]?.role).toBe('assistant');
  });

  it('round-trips a compaction boundary marker via the nullable column (ADR-0062)', () => {
    store.createSession(makeSession());
    // A normal row carries no compaction field; a marker row (role:'system') carries the boundary.
    store.appendMessage(makeMessage(0));
    store.appendMessage(
      makeMessage(1, {
        role: 'system',
        content: [{ type: 'text', text: 'summary of earlier turns' }],
        compaction: { droppedThroughSequence: 0 },
      }),
    );

    const messages = store.loadMessages('sess-1');
    // The normal row has NO compaction key (the column is NULL → omitted, honoring exactOptionalPropertyTypes).
    expect(messages[0]).not.toHaveProperty('compaction');
    // The marker round-trips the typed boundary — including droppedThroughSequence 0 (a falsy-but-valid
    // boundary the `?? null` / `=== null` mapper preserves, never coerces away).
    expect(messages[1]?.compaction).toEqual({ droppedThroughSequence: 0 });
    expect(messages[1]?.role).toBe('system');
  });

  it('round-trips a summary-less /trim marker (empty content + boundary, ADR-0062)', () => {
    store.createSession(makeSession());
    store.appendMessage(makeMessage(0));
    store.appendMessage(
      makeMessage(1, { role: 'assistant', content: [{ type: 'text', text: 'a' }] }),
    );
    // A /trim marker: role:'system', NO summary text (content:[]), a boundary through seq 0.
    store.appendMessage(
      makeMessage(2, { role: 'system', content: [], compaction: { droppedThroughSequence: 0 } }),
    );

    const marker = store.loadMessages('sess-1')[2];
    expect(marker?.content).toEqual([]); // empty content round-trips (a trim spends nothing, summarises nothing)
    expect(marker?.compaction).toEqual({ droppedThroughSequence: 0 });
  });

  it('returns undefined for an absent session', () => {
    expect(store.loadSession('nope')).toBeUndefined();
    expect(store.loadFull('nope')).toBeUndefined();
  });

  it('loadSession/loadFull exclude a soft-deleted session (no resurrect on resume)', () => {
    store.createSession(makeSession({ id: 'sess-del', deletedAt: '2026-06-17T09:00:00.000Z' }));
    expect(store.loadSession('sess-del')).toBeUndefined();
    expect(store.loadFull('sess-del')).toBeUndefined();
  });

  it('listSessions returns the non-deleted sessions, most-recently-updated first (2.O)', () => {
    // Three sessions at distinct updatedAt; insert out of order to prove the sort is by updated_at, not insert.
    store.createSession(makeSession({ id: 'sess-a', updatedAt: '2026-06-17T08:00:00.000Z' }));
    store.createSession(makeSession({ id: 'sess-c', updatedAt: '2026-06-17T10:00:00.000Z' }));
    store.createSession(makeSession({ id: 'sess-b', updatedAt: '2026-06-17T09:00:00.000Z' }));

    expect(store.listSessions().map((s) => s.id)).toEqual(['sess-c', 'sess-b', 'sess-a']);
  });

  it('listSessions excludes a soft-deleted session even when it is the most-recently-updated', () => {
    store.createSession(
      makeSession({ id: 'sess-live', title: 'Live', updatedAt: '2026-06-17T08:00:00.000Z' }),
    );
    // sess-gone sorts FIRST by updated_at — so its absence proves the WHERE runs, not just the ORDER BY.
    store.createSession(
      makeSession({
        id: 'sess-gone',
        updatedAt: '2026-06-17T10:00:00.000Z',
        deletedAt: '2026-06-17T11:00:00.000Z',
      }),
    );

    const listed = store.listSessions();
    expect(listed.map((s) => s.id)).toEqual(['sess-live']);
    expect(listed[0]).toEqual(
      makeSession({ id: 'sess-live', title: 'Live', updatedAt: '2026-06-17T08:00:00.000Z' }),
    );
  });

  it('listSessions is empty for a fresh store', () => {
    expect(store.listSessions()).toEqual([]);
  });

  it('listSessions({ limit }) bounds the read to the indexed top-N, newest-first (2.5.B Home)', () => {
    for (let i = 0; i < 5; i += 1) {
      store.createSession(
        makeSession({ id: `sess-${i}`, updatedAt: `2026-06-17T08:0${i}:00.000Z` }),
      );
    }
    // The top-2 by updated_at DESC are the two highest minute-stamps — the limit must not return all 5.
    expect(store.listSessions({ limit: 2 }).map((s) => s.id)).toEqual(['sess-4', 'sess-3']);
    expect(store.listSessions()).toHaveLength(5); // omitting the limit still returns the full list (chat-list)
  });

  it('listSessions falls back to unbounded for a non-integer / non-finite / ≤0 limit (never a bad SQL LIMIT)', () => {
    for (let i = 0; i < 3; i += 1) {
      store.createSession(
        makeSession({ id: `sess-${i}`, updatedAt: `2026-06-17T08:0${i}:00.000Z` }),
      );
    }
    // Only a finite positive integer bounds the read; NaN / Infinity / a fraction / ≤0 must NOT reach `LIMIT`.
    expect(store.listSessions({ limit: Number.NaN })).toHaveLength(3);
    expect(store.listSessions({ limit: Number.POSITIVE_INFINITY })).toHaveLength(3);
    expect(store.listSessions({ limit: 1.5 })).toHaveLength(3);
    expect(store.listSessions({ limit: 0 })).toHaveLength(3);
    expect(store.listSessions({ limit: -1 })).toHaveLength(3);
  });

  it('listSessions breaks an updated_at tie deterministically by id descending (not insert order)', () => {
    const tie = '2026-06-17T08:00:00.000Z';
    // Insert in an order (b, a, c) that neither id-asc nor id-desc matches, so passing proves the sort is by
    // id (descending), not the rows' insertion/rowid order: id-desc ⇒ [c, b, a]; insertion ⇒ [b, a, c].
    store.createSession(makeSession({ id: 'sess-b', updatedAt: tie }));
    store.createSession(makeSession({ id: 'sess-a', updatedAt: tie }));
    store.createSession(makeSession({ id: 'sess-c', updatedAt: tie }));

    expect(store.listSessions().map((s) => s.id)).toEqual(['sess-c', 'sess-b', 'sess-a']);
  });

  it('listSessions returns a row whose modelId references the model_catalog (FK-resolved passthrough)', () => {
    // modelId is the catalog UUID (FK → model_catalog.id), not a raw model string — mirrors the existing
    // FK round-trip test; this pins that listSessions' projection does not drop the column.
    seedModelCatalog(client);
    store.createSession(makeSession({ id: 'sess-m', modelId: 'model-1' }));

    expect(store.listSessions()[0]?.modelId).toBe('model-1');
  });

  it('updateSession overwrites mutable fields by id', () => {
    store.createSession(makeSession());
    store.updateSession(
      makeSession({
        status: 'ended',
        totalInputTokens: 10,
        totalCostMicrocents: 500,
        updatedAt: TS_ISO,
      }),
    );
    const session = store.loadSession('sess-1');
    expect(session?.status).toBe('ended');
    expect(session?.totalInputTokens).toBe(10);
    expect(session?.totalCostMicrocents).toBe(500);
  });

  it('cascades the transcript when the parent agent_sessions row is deleted', () => {
    store.createSession(makeSession());
    store.appendMessage(makeMessage(0));
    store.appendMessage(makeMessage(1));
    client.db.delete(agentSessions).where(eq(agentSessions.id, 'sess-1')).run();
    expect(store.loadMessages('sess-1')).toHaveLength(0);
  });

  it('rejects a duplicate (session_id, sequence_number) — the gap-free transcript invariant', () => {
    store.createSession(makeSession());
    store.appendMessage(makeMessage(0));
    expect(() => {
      store.appendMessage(makeMessage(0, { id: 'msg-dup' }));
    }).toThrow();
  });

  it('round-trips durable content (reasoning text + handle-only media), with no signature persisted', () => {
    store.createSession(makeSession());
    store.appendMessage(
      makeMessage(0, {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'thinking' },
          { type: 'media', mimeType: 'image/png', source: { kind: 'handle', ref: HANDLE } },
        ],
      }),
    );
    const messages = store.loadMessages('sess-1');
    const reasoning = messages[0]?.content[0];
    expect(reasoning).toEqual({ type: 'reasoning', text: 'thinking' });
    expect(reasoning !== undefined && 'signature' in reasoning).toBe(false);
    const media = messages[0]?.content[1];
    expect(media?.type).toBe('media');
    expect(media?.type === 'media' && media.source).toEqual({ kind: 'handle', ref: HANDLE });
  });

  it('persists optional denormalized metadata without changing the SessionMessage round-trip', () => {
    store.createSession(makeSession());
    store.appendMessage(makeMessage(0, { role: 'assistant' }), {
      content: 'hi',
      inputTokens: 12,
      outputTokens: 7,
      costMicrocents: 99,
      finishReason: 'stop',
    });
    const row = client.db
      .select()
      .from(sessionMessages)
      .where(eq(sessionMessages.sessionId, 'sess-1'))
      .get();
    expect(row?.inputTokens).toBe(12);
    expect(row?.outputTokens).toBe(7);
    expect(row?.costMicrocents).toBe(99);
    expect(row?.finishReason).toBe('stop');
    // The canonical SessionMessage carries only its durable fields — the metadata is not part of it.
    const [message] = store.loadMessages('sess-1');
    expect(message?.role).toBe('assistant');
    expect('finishReason' in (message ?? {})).toBe(false);
  });

  it('persists a modelId that references the model_catalog row (FK-resolved), and rejects an unknown one', () => {
    // modelId is a model_catalog id (a catalog UUID the host resolves, fallback-aware) — NOT a raw model
    // string — mirroring the run-side step_executions.model_id FK (database-schema.md §session_messages).
    seedModelCatalog(client);
    store.createSession(makeSession({ modelId: 'model-1' }));
    store.appendMessage(makeMessage(0, { role: 'assistant', modelId: 'model-1' }));
    expect(store.loadSession('sess-1')?.modelId).toBe('model-1');
    expect(store.loadMessages('sess-1')[0]?.modelId).toBe('model-1');
    // An unknown catalog id violates the model_catalog FK on BOTH tables (session + message).
    expect(() => {
      store.appendMessage(makeMessage(1, { role: 'assistant', modelId: 'ghost-model' }));
    }).toThrow();
    expect(() => {
      store.createSession(makeSession({ id: 'sess-2', modelId: 'ghost-model' }));
    }).toThrow();
  });

  it('round-trips the optional fields — agentSnapshot + exportedWorkflowPath (loadSession), deletedAt (mapper)', () => {
    const agentSnapshot = AgentSchema.parse({
      id: 'chatter',
      model: 'claude-opus-4-8',
      provider: 'anthropic',
      system_prompt: 'You are concise.',
    });
    store.createSession(
      makeSession({
        title: 'Exported chat',
        status: 'exported',
        agentSnapshot,
        exportedWorkflowPath: 'flows/chat.relavium.yaml',
      }),
    );
    const loaded = store.loadSession('sess-1');
    expect(loaded?.agentSnapshot).toEqual(agentSnapshot); // the JSON snapshot column round-trips
    expect(loaded?.exportedWorkflowPath).toBe('flows/chat.relavium.yaml');

    // A soft-deleted session is HIDDEN from loadSession (the exclusion test covers that), so the deletedAt
    // tombstone's epoch-ms→ISO round-trip is verified by reading the raw row through the mapper directly.
    store.createSession(makeSession({ id: 'sess-del', deletedAt: TS_ISO }));
    const rawRow = client.db
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.id, 'sess-del'))
      .get();
    expect(rawRow && fromAgentSessionRow(rawRow).deletedAt).toBe(TS_ISO);
  });

  it('updateSession preserves the immutable created_at while advancing updated_at', () => {
    const t1 = '2026-06-17T08:00:00.000Z';
    const t2 = '2026-06-17T09:30:00.000Z';
    store.createSession(makeSession({ createdAt: t1, updatedAt: t1 }));
    // A caller passing a DIFFERENT createdAt must NOT rewrite the stored creation timestamp.
    store.updateSession(makeSession({ status: 'ended', createdAt: t2, updatedAt: t2 }));
    const s = store.loadSession('sess-1');
    expect(s?.createdAt).toBe(t1); // frozen at creation
    expect(s?.updatedAt).toBe(t2); // advanced
    expect(s?.status).toBe('ended'); // a genuinely mutable field changed
  });

  it('round-trips multi-part content in order, and an empty content array', () => {
    store.createSession(makeSession());
    const parts: SessionMessage['content'] = [
      { type: 'text', text: 'first' },
      { type: 'reasoning', text: 'mid' },
      { type: 'media', mimeType: 'image/png', source: { kind: 'handle', ref: HANDLE } },
      { type: 'text', text: 'last' },
    ];
    store.appendMessage(makeMessage(0, { role: 'assistant', content: parts }));
    store.appendMessage(makeMessage(1, { role: 'user', content: [] }));
    const messages = store.loadMessages('sess-1');
    expect(messages[0]?.content.map((p) => p.type)).toEqual(['text', 'reasoning', 'media', 'text']);
    expect(messages[0]?.content[0]).toEqual({ type: 'text', text: 'first' });
    expect(messages[0]?.content[3]).toEqual({ type: 'text', text: 'last' });
    expect(messages[1]?.content).toEqual([]);
  });

  it('rejects on read a corrupt content_parts that bypassed the write path (inline base64 media)', () => {
    // The read-side security guarantee (ADR-0031): even if a base64/inline-media part is force-inserted into
    // content_parts (bypassing toSessionMessageRow), fromSessionMessageRow's Zod parse must reject it on load
    // so an inline-bytes part can never be RETURNED from the durable store.
    store.createSession(makeSession());
    client.db
      .insert(sessionMessages)
      .values({
        id: 'm-corrupt',
        sessionId: 'sess-1',
        sequenceNumber: 0,
        role: 'assistant',
        contentParts: JSON.stringify([
          { type: 'media', mimeType: 'image/png', source: { kind: 'base64', data: 'AAAA' } },
        ]),
        createdAt: TS_MS,
      })
      .run();
    expect(() => store.loadMessages('sess-1')).toThrow();
  });
});

describe('agent_sessions CHECK constraints (raw insert bypassing the mapper)', () => {
  it('rejects a status outside the closed set', () => {
    expect(() => {
      client.db
        .insert(agentSessions)
        // @ts-expect-error — 'paused' is not a valid SessionStatus; the DB CHECK must still reject it.
        .values({
          id: 's2',
          agentSlug: 'x',
          status: 'paused',
          createdAt: TS_MS,
          updatedAt: TS_MS,
        })
        .run();
    }).toThrow();
  });

  it('rejects an fs_scope_tier outside the closed set', () => {
    expect(() => {
      client.db
        .insert(agentSessions)
        // @ts-expect-error — 'root' is not a valid FsScopeTier; the DB CHECK must still reject it.
        .values({
          id: 's3',
          agentSlug: 'x',
          fsScopeTier: 'root',
          createdAt: TS_MS,
          updatedAt: TS_MS,
        })
        .run();
    }).toThrow();
  });

  it('rejects a session_messages row whose session_id has no parent (FK enforcement)', () => {
    expect(() => {
      client.db
        .insert(sessionMessages)
        .values({
          id: 'm-orphan',
          sessionId: 'ghost',
          sequenceNumber: 0,
          role: 'user',
          createdAt: TS_MS,
        })
        .run();
    }).toThrow();
  });

  it('rejects an agent_sessions row whose agent_id has no parent (FK enforcement)', () => {
    expect(() => {
      client.db
        .insert(agentSessions)
        .values({
          id: 's5',
          agentSlug: 'x',
          agentId: 'ghost-agent',
          createdAt: TS_MS,
          updatedAt: TS_MS,
        })
        .run();
    }).toThrow();
  });
});

/**
 * 2.5.I — `loadFull` reads its session row and its transcript inside ONE deferred read transaction, so the
 * pair is a single consistent snapshot even while another connection (a second `relavium` process, or a
 * `run` sharing this `history.db`) commits between the two SELECTs. WAL snapshot isolation needs a shared
 * FILE — two `:memory:` connections are separate databases — so these use a temp-file DB with two
 * connections and interleave a real committed write mid-read.
 */
describe('SessionStore — loadFull snapshot isolation (2.5.I)', () => {
  let dir: string;
  let writer: DbClient;
  let reader: DbClient;
  let writerStore: SessionStore;
  let readerStore: SessionStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'relavium-session-snap-'));
    const path = join(dir, 'history.db');
    writer = createClient(path);
    runMigrations(writer.db);
    reader = createClient(path); // a second connection on the SAME file (WAL shared readers)
    writerStore = createSessionStore(writer.db);
    readerStore = createSessionStore(reader.db);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // Best-effort teardown: close both connections and remove the temp dir even if a close throws
    // (nested finally so the dir is always swept regardless of which close fails).
    try {
      writer.sqlite.close();
    } finally {
      try {
        reader.sqlite.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it('loadFull routes its two reads through ONE db.transaction (guards the wrapper is not removed)', () => {
    // Bind the regression to the real method: spy the reader connection's `transaction` (in place, so the
    // store's captured handle sees it) and assert loadFull opens exactly one — deleting the wrapper from
    // loadFull drops this to zero. The default spy calls through, so the reads still run and return.
    writerStore.createSession(makeSession());
    writerStore.appendMessage(makeMessage(0));
    const txnSpy = vi.spyOn(reader.db, 'transaction');

    const full = readerStore.loadFull('sess-1');
    expect(full?.messages.map((m) => m.sequenceNumber)).toEqual([0]);
    expect(txnSpy).toHaveBeenCalledTimes(1);

    // Sanity: the single-read methods do NOT open a transaction, so the assertion above is meaningful
    // (it is loadFull's wrapper being counted, not an incidental transaction).
    txnSpy.mockClear();
    readerStore.loadSession('sess-1');
    readerStore.loadMessages('sess-1');
    expect(txnSpy).not.toHaveBeenCalled();
  });

  it("loadFull's read transaction hides a concurrent writer's mid-read commit (no torn read)", () => {
    // Session v1 with two messages; totalOutputTokens reflects them.
    writerStore.createSession(makeSession({ totalOutputTokens: 2 }));
    writerStore.appendMessage(makeMessage(0));
    writerStore.appendMessage(makeMessage(1, { role: 'assistant' }));

    // Reproduce loadFull's structure (read session, then read messages) inside the reader's OWN read
    // transaction — exactly what loadFull wraps — and commit an append + a session-total bump on the OTHER
    // connection BETWEEN the two reads. The deferred transaction pinned its snapshot at read 1, so read 2
    // must not observe the interleaved write.
    const snapshot = reader.db.transaction(() => {
      const session = readerStore.loadSession('sess-1'); // read 1 — pins the WAL snapshot
      writerStore.appendMessage(makeMessage(2, { role: 'user' })); // concurrent, auto-committed
      writerStore.updateSession(
        makeSession({ totalOutputTokens: 3, updatedAt: '2026-06-17T09:00:00.000Z' }),
      );
      const messages = readerStore.loadMessages('sess-1'); // read 2 — same snapshot
      return { session, messages };
    });

    // Consistent: session v1 (totalOutputTokens 2) paired with exactly its two messages — the mid-read
    // append (seq 2) and the total bump are invisible to the pinned snapshot.
    expect(snapshot.session?.totalOutputTokens).toBe(2);
    expect(snapshot.messages.map((m) => m.sequenceNumber)).toEqual([0, 1]);

    // The write really committed: a fresh loadFull after the transaction sees the bump + the new message.
    const after = readerStore.loadFull('sess-1');
    expect(after?.session.totalOutputTokens).toBe(3);
    expect(after?.messages.map((m) => m.sequenceNumber)).toEqual([0, 1, 2]);
  });

  it('WITHOUT a read transaction the same interleave tears (why loadFull wraps its reads)', () => {
    writerStore.createSession(makeSession({ totalOutputTokens: 2 }));
    writerStore.appendMessage(makeMessage(0));
    writerStore.appendMessage(makeMessage(1, { role: 'assistant' }));

    // Two INDEPENDENT reads (no surrounding transaction) with a committed write between them.
    const session = readerStore.loadSession('sess-1'); // read 1 — no snapshot held
    writerStore.appendMessage(makeMessage(2, { role: 'user' }));
    writerStore.updateSession(
      makeSession({ totalOutputTokens: 3, updatedAt: '2026-06-17T09:00:00.000Z' }),
    );
    const messages = readerStore.loadMessages('sess-1'); // read 2 — sees the post-write transcript

    // Torn: the stale session (totalOutputTokens 2) is paired with the 3-message post-write transcript —
    // the mismatch loadFull's transaction prevents.
    expect(session?.totalOutputTokens).toBe(2);
    expect(messages.map((m) => m.sequenceNumber)).toEqual([0, 1, 2]);
  });
});
