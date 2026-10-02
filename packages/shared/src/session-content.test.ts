import { describe, expect, it } from 'vitest';

import { DurableContentPartSchema } from './content.js';
import {
  createSessionToolCallId,
  parseSessionToolCallId,
  SessionContentPartSchema,
  SessionToolCallPartSchema,
  SessionToolResultPartSchema,
} from './session-content.js';

const call = { type: 'tool_call', id: 'session-tool:7:0', name: 'read_file', argsBytes: 12 };
const result = { type: 'tool_result', toolCallId: call.id, resultBytes: 4, outcome: 'ok' };
const handle = { kind: 'handle', ref: `media://sha256-${'a'.repeat(64)}` };

describe('session structural content (ADR-0095)', () => {
  it('keeps structure and permits all four fixed outcomes', () => {
    expect(SessionToolCallPartSchema.parse(call)).toEqual(call);
    for (const outcome of ['ok', 'error', 'denied', 'cancelled']) {
      expect(SessionToolResultPartSchema.parse({ ...result, outcome })).toEqual({
        ...result,
        outcome,
      });
    }
    expect(
      SessionToolCallPartSchema.safeParse({ ...call, name: 'mcp_workspace_read_file' }).success,
    ).toBe(true);
    expect(SessionToolCallPartSchema.safeParse({ ...call, name: 'unknown_tool' }).success).toBe(
      true,
    );
  });

  it.each(['args', 'arguments', 'result', 'signature', 'outputSummary', 'providerExecuted'])(
    'refuses raw/extra %s instead of stripping it',
    (field) => {
      for (const part of [call, result]) {
        expect(
          SessionContentPartSchema.safeParse({ ...part, [field]: 'secret tool content' }).success,
        ).toBe(false);
      }
    },
  );

  it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    'refuses invalid size %s',
    (size) => {
      expect(SessionToolCallPartSchema.safeParse({ ...call, argsBytes: size }).success).toBe(false);
      expect(SessionToolResultPartSchema.safeParse({ ...result, resultBytes: size }).success).toBe(
        false,
      );
    },
  );

  it.each(['', 'raw.model.name', 'tool/name', 'x'.repeat(129)])(
    'refuses invalid tool name %s',
    (name) => {
      expect(SessionToolCallPartSchema.safeParse({ ...call, name }).success).toBe(false);
    },
  );

  it('records tool media only as handles and validated metadata', () => {
    const media = { type: 'media', mimeType: 'image/png', source: handle, byteLength: 32 };
    expect(SessionToolResultPartSchema.safeParse({ ...result, media: [media] }).success).toBe(true);
    for (const changed of [
      { ...media, transcript: 'secret output' },
      { ...media, name: 'secret filename' },
      { ...media, source: { ...handle, data: 'secret inline bytes' } },
      { ...media, source: { kind: 'base64', data: 'AAAA' } },
      { ...media, durationMs: 1 },
      { ...media, mimeType: 'text/plain' },
    ])
      expect(SessionToolResultPartSchema.safeParse({ ...result, media: [changed] }).success).toBe(
        false,
      );
  });

  it('retains user media hints but refuses unknown fields and signatures', () => {
    expect(
      SessionContentPartSchema.safeParse({
        type: 'media',
        mimeType: 'image/png',
        source: handle,
        name: 'user-file.png',
      }).success,
    ).toBe(true);
    expect(
      SessionContentPartSchema.safeParse({ type: 'text', text: 'hi', args: 'raw' }).success,
    ).toBe(false);
    expect(
      SessionContentPartSchema.safeParse({ type: 'reasoning', text: 'hi', signature: 'raw' })
        .success,
    ).toBe(false);
  });

  it('does not narrow generic durable run/event/IPC tool parts', () => {
    expect(
      DurableContentPartSchema.safeParse({
        type: 'tool_call',
        id: 'provider-id',
        name: 'read_file',
        args: { path: 'x' },
      }).success,
    ).toBe(true);
    expect(
      DurableContentPartSchema.safeParse({
        type: 'tool_result',
        toolCallId: 'provider-id',
        result: 'run result',
      }).success,
    ).toBe(true);
  });
});

describe('engine-assigned session tool-call id', () => {
  it('encodes the durable turn key and whole-turn slot without model strings', () => {
    expect(createSessionToolCallId(7, 0)).toBe('session-tool:7:0');
    expect(
      parseSessionToolCallId(
        createSessionToolCallId(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER),
      ),
    ).toEqual({ turnKey: Number.MAX_SAFE_INTEGER, slot: Number.MAX_SAFE_INTEGER });
    expect(createSessionToolCallId(8, 0)).not.toBe(createSessionToolCallId(7, 0));
  });
  it.each([
    'c1',
    'session-tool:0:0',
    'session-tool:01:0',
    'session-tool:1:01',
    'session-tool:1:-1',
    'session-tool:9007199254740992:0',
    'session-tool:1:9007199254740992',
    'session-tool:1:0:raw',
    'x'.repeat(1000),
  ])('refuses noncanonical id %s', (id) => {
    expect(parseSessionToolCallId(id)).toBeUndefined();
    expect(SessionToolCallPartSchema.safeParse({ ...call, id }).success).toBe(false);
  });
});
