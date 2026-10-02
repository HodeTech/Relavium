import { type AgentSessionRecord, type SessionMessage } from '@relavium/shared';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createClient, runMigrations, type DbClient } from './client.js';
import { sessionMessages } from './schema.js';
import {
  createSessionStore,
  SessionMessageBoundaryError,
  type SessionStore,
} from './session-store.js';

const timestamp = '2026-10-02T00:00:00.000Z';
const secret = 'session-boundary-secret-value';
const call = {
  type: 'tool_call' as const,
  id: 'session-tool:1:0',
  name: 'read_file',
  argsBytes: 12,
};
const result = {
  type: 'tool_result' as const,
  toolCallId: call.id,
  resultBytes: 4,
  outcome: 'ok' as const,
};
const session: AgentSessionRecord = {
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
function message(
  sequenceNumber: number,
  role: SessionMessage['role'],
  content: SessionMessage['content'],
): SessionMessage {
  return {
    id: `m${String(sequenceNumber)}`,
    sessionId: 's1',
    sequenceNumber,
    role,
    content,
    timestamp,
  };
}
let client: DbClient;
let store: SessionStore;
beforeEach(() => {
  client = createClient();
  runMigrations(client.db);
  store = createSessionStore(client.db);
  store.createSession(session);
});
afterEach(() => client.sqlite.close());

function refused(action: () => void): void {
  try {
    action();
    throw new Error('boundary unexpectedly accepted the input');
  } catch (error) {
    expect(error).toBeInstanceOf(SessionMessageBoundaryError);
    if (error instanceof SessionMessageBoundaryError) {
      expect(error.message).not.toContain(secret);
      expect(error.cause).toBeUndefined();
    }
  }
}

describe('the complete session store boundary (ADR-0095)', () => {
  it('round-trips only structural calls/results and canonical matching metadata', () => {
    store.appendMessage(message(0, 'assistant', [call]), { toolCalls: [call], name: call.name });
    store.appendMessage(message(1, 'tool', [result]), { toolCallId: call.id, content: '' });
    store.appendMessage(message(2, 'assistant', [{ type: 'text', text: '' }]), {
      content: '',
      finishReason: 'stop',
    });
    expect(store.loadMessages('s1').map((row) => row.content)).toEqual([
      [call],
      [result],
      [{ type: 'text', text: '' }],
    ]);
    const raw = client.db.select().from(sessionMessages).all();
    expect(JSON.stringify(raw)).not.toContain('args"');
    expect(JSON.stringify(raw)).not.toContain('result"');
  });

  it('refuses raw tool parts and unknown envelope fields instead of stripping them', () => {
    const rawCall = { ...call, args: { authorization: secret } };
    const rawResult = { ...result, result: secret };
    refused(() => store.appendMessage(message(0, 'assistant', [rawCall])));
    refused(() => store.appendMessage(message(0, 'tool', [rawResult])));
    const rawEnvelope = { ...message(0, 'assistant', [call]), [secret]: secret };
    refused(() => store.appendMessage(rawEnvelope));
    expect(store.loadMessages('s1')).toEqual([]);
  });

  it('refuses every metadata bypass including text, unknown property names and raw toolCalls', () => {
    const rawCall = { ...call, args: { authorization: secret } };
    for (const meta of [
      { content: secret },
      { toolCalls: [rawCall] },
      { toolCallId: secret },
      { name: secret },
      { finishReason: secret },
      { [secret]: secret },
      { toolCalls: [{ ...call, result: secret }] },
    ])
      refused(() => store.appendMessage(message(0, 'assistant', [call]), meta));
    expect(store.loadMessages('s1')).toEqual([]);
  });

  it('refuses valid-looking but mismatched canonical metadata', () => {
    for (const meta of [
      { toolCalls: [{ ...call, argsBytes: 13 }] },
      { toolCalls: [] },
      { name: 'write_file' },
      { toolCallId: 'session-tool:2:0' },
    ])
      refused(() => store.appendMessage(message(0, 'assistant', [call]), meta));
    refused(() => store.appendMessage(message(0, 'tool', [result]), { content: secret }));
  });

  it('retains the user’s own text rather than treating all sensitive content as a tool result', () => {
    store.appendMessage(message(0, 'user', [{ type: 'text', text: secret }]), { content: secret });
    expect(store.loadMessages('s1')[0]?.content).toEqual([{ type: 'text', text: secret }]);
  });

  it.each(['byteLength', 'durationMs'] as const)(
    'refuses unsafe tool-media %s on write and read, while retaining the maximum safe integer',
    (field) => {
      const media = {
        type: 'media' as const,
        mimeType: 'audio/wav',
        source: { kind: 'handle' as const, ref: `media://sha256-${'a'.repeat(64)}` },
        [field]: Number.MAX_SAFE_INTEGER,
      };
      const valid = { ...result, media: [media] };
      const unsafe = {
        ...result,
        media: [{ ...media, [field]: Number.MAX_SAFE_INTEGER + 1 }],
      };
      refused(() => store.appendMessage(message(0, 'tool', [unsafe])));
      expect(store.loadMessages('s1')).toEqual([]);
      store.appendMessage(message(0, 'tool', [valid]));
      expect(store.loadMessages('s1')[0]?.content).toEqual([valid]);
      client.db
        .update(sessionMessages)
        .set({ contentParts: JSON.stringify([unsafe]) })
        .where(eq(sessionMessages.id, 'm0'))
        .run();
      refused(() => {
        store.loadMessages('s1');
      });
    },
  );

  it.each(['content', 'toolCalls', 'toolCallId', 'name', 'finishReason'] as const)(
    'refuses corrupt %s metadata on read',
    (field) => {
      store.appendMessage(message(0, 'assistant', [call]));
      client.db
        .update(sessionMessages)
        .set({ [field]: secret })
        .where(eq(sessionMessages.id, 'm0'))
        .run();
      refused(() => {
        store.loadMessages('s1');
      });
      refused(() => {
        store.loadFull('s1');
      });
    },
  );

  it('refuses raw/corrupt JSON on read without leaking parser diagnostics', () => {
    store.appendMessage(message(0, 'assistant', [call]));
    for (const contentParts of [JSON.stringify([{ ...call, args: secret }]), secret]) {
      client.db
        .update(sessionMessages)
        .set({ contentParts })
        .where(eq(sessionMessages.id, 'm0'))
        .run();
      refused(() => {
        store.loadMessages('s1');
      });
    }
  });

  it('rolls back the whole turn when a later message has invalid metadata', () => {
    refused(() =>
      store.writeTurn({
        messages: [
          { message: message(0, 'user', [{ type: 'text', text: 'question' }]) },
          { message: message(1, 'assistant', [call]), meta: { content: secret } },
        ],
        session: { ...session, status: 'idle' },
      }),
    );
    expect(store.loadMessages('s1')).toEqual([]);
    expect(store.loadSession('s1')?.status).toBe('active');
  });
});
