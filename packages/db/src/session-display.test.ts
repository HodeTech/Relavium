import type { AgentSessionRecord, SessionMessage } from '@relavium/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClient, runMigrations, type DbClient } from './client.js';
import { agentSessions } from './schema.js';
import {
  createSessionStore,
  SessionMessageBoundaryError,
  type SessionStore,
} from './session-store.js';

const timestamp = '2026-11-10T00:00:00.000Z';
const session: AgentSessionRecord = {
  id: 's',
  agentSlug: 'chat',
  context: { workingDir: '/workspace', fsScopeTier: 'project' },
  status: 'active',
  totalInputTokens: 0,
  totalOutputTokens: 0,
  totalCostMicrocents: 0,
  totalConservativeMicrocents: 0,
  createdAt: timestamp,
  updatedAt: timestamp,
};
const message = (
  sequenceNumber: number,
  role: SessionMessage['role'] = 'user',
): SessionMessage => ({
  id: `m${sequenceNumber}`,
  sessionId: 's',
  sequenceNumber,
  role,
  content:
    role === 'tool'
      ? [{ type: 'tool_result', toolCallId: 'session-tool:1:0', resultBytes: 0, outcome: 'ok' }]
      : [{ type: 'text', text: 'expanded private context' }],
  timestamp,
});
let client: DbClient, store: SessionStore;
beforeEach(() => {
  client = createClient(':memory:');
  runMigrations(client.db);
  store = createSessionStore(client.db);
  store.createSession(session);
});
afterEach(() => {
  vi.restoreAllMocks();
  client.sqlite.close();
});

describe('host-recorded display metadata (ADR-0123)', () => {
  it('atomically stores the explicit display independently of canonical text, including empty display', () => {
    const user = message(0),
      answer = message(1, 'assistant');
    store.writeTurn({
      messages: [{ message: user, meta: { userDisplayText: '' } }, { message: answer }],
      session,
    });
    expect(store.loadMessages('s')).toEqual([user, answer]);
    expect([...store.loadUserDisplayTexts('s', [0, 1])]).toEqual([[0, '']]);
    expect(store.loadUserDisplayTexts('another-session', [0, 1]).size).toBe(0);
  });

  it('leaves absent display absent and never infers from canonical content', () => {
    store.appendMessage(message(0));
    expect(store.loadUserDisplayTexts('s', [0]).size).toBe(0);
    expect(store.loadMessages('s')[0]?.content).toEqual(message(0).content);
  });

  it.each(['assistant', 'system', 'tool'] as const)(
    'rejects display on a valid %s row without publishing it',
    (role) => {
      expect(() => store.appendMessage(message(0, role), { userDisplayText: 'compact' })).toThrow(
        SessionMessageBoundaryError,
      );
      expect(store.loadMessages('s')).toEqual([]);
    },
  );

  it.each([
    { userDisplayText: 7 },
    { userDisplayText: null },
    { userDisplayText: 'compact', unknownDisplayField: 'PRIVATE' },
  ])('rejects non-string or unknown metadata with a fixed diagnostic', (meta) => {
    expect(() => {
      Reflect.apply(store.appendMessage, undefined, [message(0), meta]);
    }).toThrow('session message refused at the persistence boundary');
    expect(store.loadMessages('s')).toEqual([]);
  });

  it('rolls back a whole turn when another row has invalid display metadata', () => {
    expect(() =>
      store.writeTurn({
        messages: [
          { message: message(0), meta: { userDisplayText: 'compact' } },
          { message: message(1, 'assistant'), meta: { userDisplayText: 'wrong role' } },
        ],
      }),
    ).toThrow(SessionMessageBoundaryError);
    expect(store.loadMessages('s')).toEqual([]);
    expect(store.loadUserDisplayTexts('s', [0, 1]).size).toBe(0);
  });

  it.each(['PRIVATE', ''])(
    'validates selected non-user metadata before projecting away its role (%j)',
    (text) => {
      store.writeTurn({
        messages: [
          { message: message(0), meta: { userDisplayText: 'compact' } },
          { message: message(1, 'assistant') },
        ],
      });
      client.sqlite
        .prepare('UPDATE session_messages SET user_display_text = ? WHERE id = ?')
        .run(text, 'm1');
      expect(() => store.loadUserDisplayTexts('s', [0, 1])).toThrow(SessionMessageBoundaryError);
      expect([...store.loadUserDisplayTexts('s', [0])]).toEqual([[0, 'compact']]);
      expect(store.loadMessages('s')).toEqual([message(0), message(1, 'assistant')]);
    },
  );

  it('rejects a malformed stored display value without changing canonical machine reads', () => {
    store.appendMessage(message(0));
    client.sqlite
      .prepare('UPDATE session_messages SET user_display_text = ? WHERE id = ?')
      .run(Buffer.from('PRIVATE'), 'm0');
    const prepare = vi.spyOn(client.sqlite, 'prepare');
    expect(store.loadMessages('s')).toEqual([message(0)]);
    expect(prepare.mock.calls.some(([query]) => query.includes('user_display_text'))).toBe(false);
    expect(() => store.loadUserDisplayTexts('s', [0])).toThrow(
      'session message refused at the persistence boundary',
    );
    expect(store.loadMessages('s')).toEqual([message(0)]);
  });

  it('does no query for an empty selection and admits exactly 500 distinct safe numbers', () => {
    const query = vi.spyOn(client.sqlite, 'prepare');
    expect(store.loadUserDisplayTexts('s', []).size).toBe(0);
    expect(query).not.toHaveBeenCalled();
    expect(
      store.loadUserDisplayTexts(
        's',
        Array.from({ length: 500 }, (_, i) => i),
      ).size,
    ).toBe(0);
  });

  it.each(
    [
      [0, 0],
      [-1],
      [0.5],
      [Number.MAX_SAFE_INTEGER + 1],
      [Number.NaN],
      [Number.POSITIVE_INFINITY],
      Array.from({ length: 501 }, (_, i) => i),
    ].map((sequences) => [sequences] as const),
  )('refuses an invalid sequence selection before SQL', (sequences) => {
    const query = vi.spyOn(client.sqlite, 'prepare');
    expect(() => store.loadUserDisplayTexts('s', sequences)).toThrow(SessionMessageBoundaryError);
    expect(query).not.toHaveBeenCalled();
  });

  it('keeps the existing transcript revision trigger on direct display-column updates', () => {
    store.appendMessage(message(0), { userDisplayText: 'compact' });
    const revision = () =>
      client.db.select({ value: agentSessions.usageMutationRevision }).from(agentSessions).get()
        ?.value;
    const before = revision();
    expect(before).toBeTypeOf('number');
    client.sqlite
      .prepare('UPDATE session_messages SET user_display_text = ? WHERE id = ?')
      .run('changed', 'm0');
    expect(revision()).toBe((before ?? -1) + 1);
  });
});
