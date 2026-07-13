import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { AgentSchema, type AgentSessionRecord, type SessionMessage } from '@relavium/shared';
import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createClient, runMigrations, type DbClient } from './client.js';
import {
  agentSessions,
  llmProviders,
  modelCatalog,
  sessionCosts,
  sessionMessages,
} from './schema.js';
import {
  createSessionStore,
  fromAgentSessionRow,
  LEGACY_COST_SENTINEL,
  type SessionStore,
} from './session-store.js';

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
    // …but NOT the cost total. `total_cost_microcents` has exactly ONE writer — `recordSessionCost` — which bumps it
    // additively in the same transaction as the `session_costs` row (ADR-0070 §2). It used to be SET blindly from
    // whatever cumulative the caller held, from five call sites, so a stale writer could permanently break the
    // invariant `SUM(session_costs) == total_cost_microcents`. `updateSession` must now leave it alone.
    expect(session?.totalCostMicrocents).toBe(0);
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
    // The per-message token/cost columns are GONE (ADR-0070 §5). They were writable through this API but the persister
    // never passed them, so every shipped row held 0 — and a per-message cost column is structurally incapable of
    // holding the truth for a turn whose tool loop billed two models. Money attribution is `session_costs`.
    store.createSession(makeSession());
    store.appendMessage(makeMessage(0, { role: 'assistant' }), {
      content: 'hi',
      finishReason: 'stop',
    });
    const row = client.db
      .select()
      .from(sessionMessages)
      .where(eq(sessionMessages.sessionId, 'sess-1'))
      .get();
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
        rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
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

/**
 * THE RECONCILIATION INVARIANT (ADR-0070 §3):
 *
 *   for every session:  SUM(session_costs.cost_microcents) == agent_sessions.total_cost_microcents
 *
 * It holds because both sides are fed by the SAME `cost:updated` egress, with the same arithmetic, in the SAME
 * transaction, from a SINGLE owner. This is a money surface: a breakdown whose rows do not sum to the number shown as
 * the total is worse than no breakdown at all.
 *
 * The end-state assertion alone would be necessary but NOT sufficient — it would still pass if a future refactor split
 * the two writes into two transactions, since both would normally succeed and the sums would agree anyway. So the
 * mechanism is pinned too.
 */
describe('session_costs — the ADR-0070 reconciliation invariant', () => {
  const sumRows = (sessionId: string): number =>
    store.loadSessionCosts(sessionId).reduce((n, r) => n + r.costMicrocents, 0);
  const total = (sessionId: string): number =>
    store.loadSession(sessionId)?.totalCostMicrocents ?? -1;

  const spend = (model: string, cost: number, opts: { priced?: boolean } = {}): void =>
    store.recordSessionCost({
      id: `sc-${model}-${cost}-${Math.random()}`,
      sessionId: 'sess-1',
      model,
      inputTokens: 10,
      outputTokens: 20,
      costMicrocents: cost,
      priced: opts.priced ?? true,
      ts: 1,
    });

  it('a real egress can NEVER fold into the legacy row — not even one whose model IS the sentinel string', () => {
    // The collision the `is_legacy` discriminator exists to make impossible. `model` is the RAW provider id, and a
    // custom/self-hosted model may be named anything, so a reserved "sentinel" string is not a defence — a user can
    // name a model `(pre-2.6.C)`. Had the unique index stayed `(session_id, model)`, this egress would have upserted
    // ONTO the backfilled aggregate: real money merged into the un-attributable bucket, the legacy row silently
    // growing, and `/cost` rendering the user's actual spend as "breakdown unavailable".
    store.createSession(makeSession());

    // The 0009 backfill's row, written exactly as the migration writes it: the whole legacy total, no breakdown.
    client.db
      .insert(sessionCosts)
      .values({
        id: 'legacy-row',
        sessionId: 'sess-1',
        model: LEGACY_COST_SENTINEL,
        inputTokens: 0,
        outputTokens: 0,
        costMicrocents: 4000,
        callCount: 0,
        unpricedCalls: 0,
        isLegacy: true,
        createdAt: 1,
        updatedAt: 1,
      })
      .run();
    client.db
      .update(agentSessions)
      .set({ totalCostMicrocents: 4000 })
      .where(eq(agentSessions.id, 'sess-1'))
      .run();

    spend(LEGACY_COST_SENTINEL, 600); // a REAL egress from a custom model with the unluckiest possible name

    const rows = store.loadSessionCosts('sess-1');
    expect(rows).toHaveLength(2); // TWO rows — they did not merge

    const legacy = rows.find((r) => r.isLegacy);
    const real = rows.find((r) => !r.isLegacy);
    expect(legacy?.costMicrocents).toBe(4000); // the aggregate is untouched: it can never grow
    expect(legacy?.callCount).toBe(0); // …and never claims calls it structurally cannot have
    expect(real?.costMicrocents).toBe(600); // the user's real spend is attributed to the user's real model
    expect(real?.callCount).toBe(1);

    expect(sumRows('sess-1')).toBe(4600);
    expect(total('sess-1')).toBe(4600); // THE INVARIANT still holds across the split
  });

  it('a TWO-MODEL turn (the tool loop failing over mid-turn) reconciles — the case no per-message column can hold', () => {
    store.createSession(makeSession());
    spend('claude-sonnet-4-6', 300); // tool-loop iteration 1
    spend('claude-opus-4-8', 700); // iteration 2 failed over to another model — SAME turn

    const rows = store.loadSessionCosts('sess-1');
    expect(rows).toHaveLength(2); // both models are represented; a single `model_id` column could not do this
    expect(sumRows('sess-1')).toBe(1000);
    expect(total('sess-1')).toBe(1000); // THE INVARIANT
  });

  it('folds repeat egresses of the SAME model ADDITIVELY — never absolutely', () => {
    // Additive is MANDATORY: a resume or an ADR-0059 reseat builds a fresh persister whose accumulators start at zero,
    // so an absolute write would zero every model row the prior process had already committed.
    store.createSession(makeSession());
    spend('claude-opus-4-8', 100);
    spend('claude-opus-4-8', 250);

    const [row] = store.loadSessionCosts('sess-1');
    expect(row?.costMicrocents).toBe(350);
    expect(row?.callCount).toBe(2);
    expect(row?.inputTokens).toBe(20); // tokens fold too
    expect(total('sess-1')).toBe(350); // THE INVARIANT
  });

  it('an UNPRICED egress reconciles at zero cost while still counting its call and its real tokens', () => {
    // 2.6.Q's F5: an unpriced model spends real tokens but we cannot price it. Both sides see 0, so the invariant
    // holds — and `unpricedCalls` makes the free-LOOKING row distinguishable from a genuinely free one.
    store.createSession(makeSession());
    spend('gpt-5.4-pro', 0, { priced: false });
    spend('gpt-5.4-pro', 0, { priced: false });

    const [row] = store.loadSessionCosts('sess-1');
    expect(row?.costMicrocents).toBe(0);
    expect(row?.callCount).toBe(2);
    expect(row?.unpricedCalls).toBe(2); // "price unknown for 2 of 2 calls"
    expect(row?.outputTokens).toBe(40); // the tokens were real
    expect(sumRows('sess-1')).toBe(total('sess-1')); // THE INVARIANT
  });

  it('a MIXED session — priced and unpriced, several models — still reconciles exactly', () => {
    store.createSession(makeSession());
    spend('claude-opus-4-8', 500);
    spend('gpt-5.4-pro', 0, { priced: false });
    spend('claude-opus-4-8', 250);
    spend('claude-sonnet-4-6', 125);

    expect(store.loadSessionCosts('sess-1')).toHaveLength(3);
    expect(sumRows('sess-1')).toBe(875);
    expect(total('sess-1')).toBe(875); // THE INVARIANT
  });

  it('orders by spend, descending — the /cost breakdown reads it straight off the covering index', () => {
    store.createSession(makeSession());
    spend('cheap', 10);
    spend('expensive', 900);
    spend('middling', 100);
    expect(store.loadSessionCosts('sess-1').map((r) => r.model)).toEqual([
      'expensive',
      'middling',
      'cheap',
    ]);
  });

  it('returns an EMPTY array — never null — for a session that has not spent', () => {
    store.createSession(makeSession());
    expect(store.loadSessionCosts('sess-1')).toEqual([]);
  });

  it('MECHANISM: both writes land in ONE transaction — an end-state check alone would not notice a split', () => {
    // If a future refactor moved the total-bump out of the transaction, the sums would still agree in the happy path
    // and every assertion above would stay green. Pin the mechanism: a failure INSIDE the transaction must roll BOTH
    // halves back, leaving the invariant intact rather than a row without its total (or a total without its row).
    store.createSession(makeSession());
    spend('claude-opus-4-8', 400);

    // A second write that violates the CHECK constraint must abort atomically.
    expect(() =>
      store.recordSessionCost({
        id: 'sc-bad',
        sessionId: 'sess-1',
        model: '', // violates `session_costs_model_nonempty`
        inputTokens: 1,
        outputTokens: 1,
        costMicrocents: 999,
        priced: true,
        ts: 2,
      }),
    ).toThrow();

    expect(sumRows('sess-1')).toBe(400); // the failed egress folded NOTHING
    expect(total('sess-1')).toBe(400); // …and did NOT bump the total either. THE INVARIANT SURVIVES.
  });

  it('cascades with the session — a deleted session leaves no orphan cost rows', () => {
    store.createSession(makeSession());
    spend('claude-opus-4-8', 100);
    client.db.delete(agentSessions).where(eq(agentSessions.id, 'sess-1')).run();
    expect(store.loadSessionCosts('sess-1')).toEqual([]);
  });

  it('a RESEAT (same sessionId, FRESH persister) folds ADDITIVELY — it must not zero the prior process', () => {
    store.createSession(makeSession());
    // process 1 (before the reseat)
    store.recordSessionCost({
      id: 'sc-1',
      sessionId: 'sess-1',
      model: 'sonnet',
      inputTokens: 1,
      outputTokens: 1,
      costMicrocents: 400,
      priced: true,
      ts: 1,
    });
    // process 2 (after the reseat: SAME sessionId, a brand-new persister whose accumulators start at zero)
    store.recordSessionCost({
      id: 'sc-2',
      sessionId: 'sess-1',
      model: 'opus',
      inputTokens: 1,
      outputTokens: 1,
      costMicrocents: 600,
      priced: true,
      ts: 2,
    });
    const rows = store.loadSessionCosts('sess-1');
    expect(rows).toHaveLength(2);
    expect(rows.reduce((n, r) => n + r.costMicrocents, 0)).toBe(1000);
    expect(store.loadSession('sess-1')?.totalCostMicrocents).toBe(1000); // NOT 600 (an absolute write would zero sonnet)
  });

  it('two sessions on the SAME model do not collide — the key is (session, model), not the model', () => {
    store.createSession(makeSession());
    store.createSession(makeSession({ id: 'sess-2' }));
    store.recordSessionCost({
      id: 'sc-3',
      sessionId: 'sess-1',
      model: 'opus',
      inputTokens: 1,
      outputTokens: 1,
      costMicrocents: 100,
      priced: true,
      ts: 1,
    });
    store.recordSessionCost({
      id: 'sc-4',
      sessionId: 'sess-2',
      model: 'opus',
      inputTokens: 1,
      outputTokens: 1,
      costMicrocents: 200,
      priced: true,
      ts: 1,
    });
    expect(store.loadSession('sess-1')?.totalCostMicrocents).toBe(100);
    expect(store.loadSession('sess-2')?.totalCostMicrocents).toBe(200); // no PK collision across sessions
    expect(store.loadSessionCosts('sess-1')).toHaveLength(1);
    expect(store.loadSessionCosts('sess-2')).toHaveLength(1);
  });
});

/**
 * MIGRATION 0009's BACKFILL — the statement that makes the ADR-0070 invariant true for sessions that predate the
 * table (§4). It had ZERO coverage, and that is not a theoretical gap: while regenerating 0009 the
 * `--> statement-breakpoint` between the last DDL and this DML was lost, gluing the INSERT onto a `DROP COLUMN` so it
 * would never have run — and every test in the repo stayed green. A legacy user would have shipped with a session
 * whose total says $0.42 and whose breakdown is empty: the exact "invariant with a silent exception class" the ADR
 * exists to eliminate.
 *
 * Simulating the backfilled row (as the collision test above does) cannot catch that. This runs the REAL migration:
 * stage the schema at 0008, write a session that spent money back when no per-model attribution existed, then apply
 * 0009 and demand the row be there.
 */
describe('migrations 0009 + 0010 — the legacy backfill and its discriminator (ADR-0070 §4)', () => {
  // Resolved from THIS MODULE, exactly as `client.ts` resolves `MIGRATIONS_DIR` — never from `process.cwd()`. The cwd
  // is `packages/db` when the package's own vitest runs, but the REPO ROOT under the root `pnpm coverage`, so a
  // cwd-relative path passes locally and then fails on CI with an ENOENT on a path that does not exist. It did.
  const SHIPPED = fileURLToPath(new URL('../drizzle', import.meta.url));

  /** A migrations folder containing only `0000..maxIdx` — lets a test stand a DB up at an OLDER schema and then
   *  upgrade it, which is the only way to exercise a migration's DML against rows that already exist. */
  const stageUpTo = (maxIdx: number, dir: string): void => {
    const journal = JSON.parse(readFileSync(join(SHIPPED, 'meta', '_journal.json'), 'utf8')) as {
      entries: { idx: number; tag: string }[];
    };
    const kept = journal.entries.filter((e) => e.idx <= maxIdx);
    expect(kept).toHaveLength(maxIdx + 1); // the staging is real — fail loudly if a migration went missing
    mkdirSync(join(dir, 'meta'), { recursive: true });
    for (const e of kept) copyFileSync(join(SHIPPED, `${e.tag}.sql`), join(dir, `${e.tag}.sql`));
    writeFileSync(
      join(dir, 'meta', '_journal.json'),
      JSON.stringify({ ...journal, entries: kept }),
    );
  };

  /** A DB at `atIdx`, holding one session that spent `spend` back when nothing could attribute it. */
  const legacyDbAt = (atIdx: number, spend: number, dir: string): DbClient => {
    stageUpTo(8, dir); // BEFORE session_costs existed
    const c = createClient(':memory:');
    migrate(c.db, { migrationsFolder: dir });
    createSessionStore(c.db).createSession(
      makeSession({ id: 'legacy-1', totalCostMicrocents: spend }),
    );
    if (atIdx > 8) {
      const upgrade = mkdtempSync(join(tmpdir(), 'relavium-mig-up-'));
      try {
        stageUpTo(atIdx, upgrade);
        migrate(c.db, { migrationsFolder: upgrade });
      } finally {
        rmSync(upgrade, { recursive: true, force: true });
      }
    }
    return c;
  };

  it('a FRESH install (0008 → 0010 in one step) lands one is_legacy row with the whole pre-2.6.C total', () => {
    const staged = mkdtempSync(join(tmpdir(), 'relavium-mig-'));
    const legacy = legacyDbAt(8, 4200, staged);
    try {
      migrate(legacy.db, { migrationsFolder: SHIPPED }); // 0009 (CREATE + BACKFILL) then 0010 (the flag)

      const rows = createSessionStore(legacy.db).loadSessionCosts('legacy-1');
      expect(rows).toHaveLength(1); // the DML ran at all — a lost statement-breakpoint fails exactly here
      expect(rows[0]?.isLegacy).toBe(true); // flagged, so /cost discloses rather than implying a zero
      expect(rows[0]?.model).toBe(LEGACY_COST_SENTINEL); // …and labelled
      expect(rows[0]?.costMicrocents).toBe(4200); // the WHOLE legacy total, not a fraction
      expect(rows[0]?.callCount).toBe(0); // counts it structurally cannot have are not invented
      // THE INVARIANT — now true for a session that predates the table entirely, which is the point of §4.
      expect(rows.reduce((n, r) => n + r.costMicrocents, 0)).toBe(4200);
    } finally {
      legacy.sqlite.close();
      rmSync(staged, { recursive: true, force: true });
    }
  });

  it('an EXISTING 0009 database upgrades to 0010 — the already-backfilled rows get flagged, nothing is lost', () => {
    // THE REAL UPGRADE PATH, and the reason the discriminator is a second migration rather than an edit to 0009: by
    // the time review found the collision, 0009 had already been applied to real databases carrying real sessions.
    // Rewriting it would have changed its hash, so drizzle would replay it and `CREATE TABLE session_costs` would
    // fail against the table it had itself created — destroying a real chat history to fix a cosmetic bug.
    const staged = mkdtempSync(join(tmpdir(), 'relavium-mig-'));
    const legacy = legacyDbAt(9, 4200, staged); // stopped AT 0009: the row exists, unflagged, no is_legacy column
    try {
      migrate(legacy.db, { migrationsFolder: SHIPPED }); // 0010 alone: ADD COLUMN + reindex + flag

      const store9 = createSessionStore(legacy.db);
      const rows = store9.loadSessionCosts('legacy-1');
      expect(rows).toHaveLength(1);
      expect(rows[0]?.isLegacy).toBe(true); // 0010's UPDATE found the 0009-backfilled row
      expect(rows[0]?.costMicrocents).toBe(4200); // …and did not disturb the money
      expect(store9.loadSession('legacy-1')?.totalCostMicrocents).toBe(4200); // THE INVARIANT survives the upgrade

      // …and the collision is closed from here on: a real egress on the sentinel-named model gets its OWN row.
      store9.recordSessionCost({
        id: 'sc-1',
        sessionId: 'legacy-1',
        model: LEGACY_COST_SENTINEL,
        inputTokens: 5,
        outputTokens: 5,
        costMicrocents: 800,
        priced: true,
        ts: 2,
      });
      const after = store9.loadSessionCosts('legacy-1');
      expect(after).toHaveLength(2); // it did NOT fold into the legacy aggregate
      expect(after.find((r) => r.isLegacy)?.costMicrocents).toBe(4200); // the bucket never grew
      expect(after.find((r) => !r.isLegacy)?.costMicrocents).toBe(800);
      expect(store9.loadSession('legacy-1')?.totalCostMicrocents).toBe(5000);
    } finally {
      legacy.sqlite.close();
      rmSync(staged, { recursive: true, force: true });
    }
  });

  it('backfills NOTHING for a session that never spent — no empty legacy rows', () => {
    // The WHERE total_cost_microcents > 0 guard. Without it every zero-spend session would carry a $0 "breakdown
    // unavailable" row it does not need, and /cost would disclose a limitation that does not apply to it.
    const rows = store.loadSessionCosts('sess-never');
    store.createSession(makeSession({ id: 'sess-never' }));
    expect(rows).toEqual([]);
    expect(store.loadSessionCosts('sess-never')).toEqual([]);
  });
});
