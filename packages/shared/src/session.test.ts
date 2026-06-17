import { describe, expect, it } from 'vitest';

import { SessionContextSchema } from './run-event.js';
import {
  AgentSessionSchema,
  SessionMessageRoleSchema,
  SessionMessageSchema,
  SessionStatusSchema,
} from './session.js';

/** A syntactically valid canonical durable media handle (64 lowercase hex). */
const HANDLE = `media://sha256-${'a'.repeat(64)}`;
const TS = '2026-06-17T00:00:00.000Z';
const CTX = SessionContextSchema.parse({ workingDir: '/workspace/s', fsScopeTier: 'sandboxed' });

// `overrides` is intentionally loose so the reject tests can inject invalid data (a smuggled reasoning
// `signature`, inline base64 media, an unknown role) — the runtime `safeParse` is the real assertion.
const baseMessage = (overrides: Record<string, unknown> = {}): unknown => ({
  id: 'msg-1',
  sessionId: 'sess-1',
  sequenceNumber: 0,
  role: 'user',
  content: [{ type: 'text', text: 'hello' }],
  timestamp: TS,
  ...overrides,
});

const baseSession = (overrides: Record<string, unknown> = {}): unknown => ({
  id: 'sess-1',
  agentSlug: 'chatter',
  context: CTX,
  status: 'active',
  totalInputTokens: 0,
  totalOutputTokens: 0,
  totalCostMicrocents: 0,
  createdAt: TS,
  updatedAt: TS,
  ...overrides,
});

describe('SessionMessageSchema', () => {
  it('accepts a message for each role', () => {
    for (const role of SessionMessageRoleSchema.options) {
      expect(SessionMessageSchema.safeParse(baseMessage({ role })).success).toBe(true);
    }
  });

  it('accepts each durable content-part arm (text, tool_call, tool_result, reasoning, handle-media)', () => {
    const content = [
      { type: 'text', text: 'hi' },
      { type: 'tool_call', id: 'c1', name: 'read_file', args: { path: 'x' } },
      { type: 'tool_result', toolCallId: 'c1', result: { ok: true }, isError: false },
      { type: 'reasoning', text: 'thinking', redacted: false },
      { type: 'media', mimeType: 'image/png', source: { kind: 'handle', ref: HANDLE } },
    ];
    expect(SessionMessageSchema.safeParse(baseMessage({ content })).success).toBe(true);
  });

  it('accepts an optional modelId on an assistant turn', () => {
    const parsed = SessionMessageSchema.safeParse(
      baseMessage({ role: 'assistant', modelId: 'claude-opus-4-8' }),
    );
    expect(parsed.success).toBe(true);
  });

  it('strips a reasoning `signature` on parse — never persisted (ADR-0030)', () => {
    // A signature is a same-provider, same-turn continuity token; the durable reasoning arm has no
    // `signature` field, so an inbound one is stripped structurally rather than written to a row.
    const parsed = SessionMessageSchema.parse(
      baseMessage({
        role: 'assistant',
        content: [{ type: 'reasoning', text: 'thinking', signature: 'sig-should-not-survive' }],
      }),
    );
    const part = parsed.content[0];
    expect(part?.type).toBe('reasoning');
    expect(part !== undefined && 'signature' in part).toBe(false);
  });

  it('rejects inline base64 media — the durable form is handle-only (ADR-0031)', () => {
    const parsed = SessionMessageSchema.safeParse(
      baseMessage({
        content: [
          { type: 'media', mimeType: 'image/png', source: { kind: 'base64', data: 'aGVsbG8=' } },
        ],
      }),
    );
    expect(parsed.success).toBe(false);
  });

  it('rejects an empty id / sessionId, a negative sequenceNumber, and an unknown role', () => {
    expect(SessionMessageSchema.safeParse(baseMessage({ id: '' })).success).toBe(false);
    expect(SessionMessageSchema.safeParse(baseMessage({ sessionId: '' })).success).toBe(false);
    expect(SessionMessageSchema.safeParse(baseMessage({ sequenceNumber: -1 })).success).toBe(false);
    expect(SessionMessageSchema.safeParse(baseMessage({ role: 'root' })).success).toBe(false);
  });

  it('rejects a non-ISO timestamp', () => {
    expect(SessionMessageSchema.safeParse(baseMessage({ timestamp: 'not-a-date' })).success).toBe(
      false,
    );
  });

  it('pins the four transcript roles (an added/removed role must update this test)', () => {
    expect(SessionMessageRoleSchema.options).toEqual(['system', 'user', 'assistant', 'tool']);
  });
});

describe('AgentSessionSchema', () => {
  it('accepts a minimal valid session record', () => {
    expect(AgentSessionSchema.safeParse(baseSession()).success).toBe(true);
  });

  it('accepts the optional fields (agentId, agentSnapshot, title, modelId, exportedWorkflowPath, deletedAt)', () => {
    const full = baseSession({
      agentId: 'agent-uuid',
      title: 'My chat',
      modelId: 'claude-opus-4-8',
      status: 'exported',
      exportedWorkflowPath: 'flows/chat.relavium.yaml',
      deletedAt: TS,
      agentSnapshot: {
        id: 'chatter',
        model: 'claude-opus-4-8',
        provider: 'anthropic',
        system_prompt: 'You are concise.',
      },
    });
    expect(AgentSessionSchema.safeParse(full).success).toBe(true);
  });

  it('rejects a status outside the closed set', () => {
    expect(AgentSessionSchema.safeParse(baseSession({ status: 'paused' })).success).toBe(false);
  });

  it('rejects a missing context, an empty agentSlug, and a negative token/cost total', () => {
    const noContext = {
      id: 'sess-1',
      agentSlug: 'chatter',
      status: 'active',
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCostMicrocents: 0,
      createdAt: TS,
      updatedAt: TS,
    };
    expect(AgentSessionSchema.safeParse(noContext).success).toBe(false);
    expect(AgentSessionSchema.safeParse(baseSession({ agentSlug: '' })).success).toBe(false);
    expect(AgentSessionSchema.safeParse(baseSession({ totalInputTokens: -1 })).success).toBe(false);
    expect(AgentSessionSchema.safeParse(baseSession({ totalCostMicrocents: -1 })).success).toBe(
      false,
    );
  });
});

describe('SessionStatusSchema', () => {
  it('pins the four persisted statuses (distinct from the session:* event lifecycle)', () => {
    expect(SessionStatusSchema.options).toEqual(['active', 'idle', 'exported', 'ended']);
  });
});
