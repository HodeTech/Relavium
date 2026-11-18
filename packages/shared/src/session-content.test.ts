import { describe, expect, it } from 'vitest';

import { DurableContentPartSchema } from './content.js';
import { SessionMessageSchema } from './session.js';
import {
  createSessionToolCallId,
  parseSessionToolCallId,
  SESSION_ASK_BOUNDS,
  SessionAskRecordSchema,
  SessionContentPartSchema,
  SessionToolCallPartSchema,
  SessionToolResultPartSchema,
  SessionToolHistorySchema,
} from './session-content.js';
import { utf8ByteLength } from './bytes.js';

const call = { type: 'tool_call', id: 'session-tool:7:0', name: 'read_file', argsBytes: 12 };
const result = { type: 'tool_result', toolCallId: call.id, resultBytes: 4, outcome: 'ok' };
const handle = { kind: 'handle', ref: `media://sha256-${'a'.repeat(64)}` };

describe('completed session tool history event boundary', () => {
  it('permits a boundary only on a system marker row', () => {
    const message = {
      id: 'm',
      sessionId: 's',
      sequenceNumber: 3,
      role: 'system',
      content: [],
      compaction: { droppedThroughSequence: 2 },
      timestamp: '2026-10-02T00:00:00.000Z',
    };
    expect(SessionMessageSchema.safeParse(message).success).toBe(true);
    for (const role of ['user', 'assistant', 'tool'])
      expect(SessionMessageSchema.safeParse({ ...message, role }).success).toBe(false);
  });
  it('admits only unique, paired, content-free dispatch structures', () => {
    expect(SessionToolHistorySchema.parse([{ call, result }])).toEqual([{ call, result }]);
    for (const entries of [
      [{ call, result: { ...result, toolCallId: 'session-tool:7:1' } }],
      [
        { call, result },
        { call, result },
      ],
      [{ call: { ...call, args: { secret: 'sentinel' } }, result }],
      [{ call, result: { ...result, result: 'sentinel' } }],
      [{ call, result, providerId: 'sentinel' }],
    ])
      expect(SessionToolHistorySchema.safeParse(entries).success).toBe(false);
  });
});

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

  it.each(['byteLength', 'durationMs'] as const)(
    'bounds session media %s to safe integers without narrowing generic durable media',
    (field) => {
      const media = { type: 'media', mimeType: 'audio/wav', source: handle };
      const valid = { ...media, [field]: Number.MAX_SAFE_INTEGER };
      const unsafe = { ...media, [field]: Number.MAX_SAFE_INTEGER + 1 };
      expect(SessionContentPartSchema.safeParse(valid).success).toBe(true);
      expect(SessionToolResultPartSchema.safeParse({ ...result, media: [valid] }).success).toBe(
        true,
      );
      expect(SessionContentPartSchema.safeParse(unsafe).success).toBe(false);
      expect(SessionToolResultPartSchema.safeParse({ ...result, media: [unsafe] }).success).toBe(
        false,
      );
      expect(DurableContentPartSchema.safeParse(unsafe).success).toBe(true);
    },
  );

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

describe('the question record of an ask_user call (ADR-0133)', () => {
  const askCall = { ...call, name: 'ask_user' };
  const answered = {
    status: 'answered',
    items: [
      { header: 'Scope', question: 'Which module should change?', selected: ['alpha'] },
      { header: 'Note', question: 'Anything else?', selected: [], other: 'keep the API stable' },
    ],
  };
  const skipped = { status: 'skipped', items: [{ header: 'Scope', question: 'Which module?' }] };
  const askResult = { ...result, ask: answered };

  it('admits an answered record (a choice, text, or both) and a skipped one', () => {
    expect(SessionAskRecordSchema.parse(answered)).toEqual(answered);
    expect(SessionAskRecordSchema.parse(skipped)).toEqual(skipped);
    // A skip as the writer now stores it: headers only, since the person may never have been shown the question.
    const headersOnly = { status: 'skipped', items: [{ header: 'Scope' }, { header: 'Tests' }] };
    expect(SessionAskRecordSchema.parse(headersOnly)).toEqual(headersOnly);
    const both = {
      status: 'answered',
      items: [{ header: 'H', question: 'Q?', selected: ['a'], other: 'and more' }],
    };
    expect(SessionAskRecordSchema.safeParse(both).success).toBe(true);
  });

  it('refuses an answered item with no answer or no question text, and a skipped item with an answer', () => {
    for (const record of [
      // The card necessarily showed an answered question, so the record must keep it.
      { status: 'answered', items: [{ header: 'H', selected: ['a'] }] },
      { status: 'answered', items: [{ header: 'H', question: 'Q?' }] },
      { status: 'answered', items: [{ header: 'H', question: 'Q?', selected: [] }] },
      { status: 'skipped', items: [{ header: 'H', question: 'Q?', selected: ['a'] }] },
      { status: 'skipped', items: [{ header: 'H', question: 'Q?', other: 'x' }] },
      { status: 'skipped', items: [{ header: 'H', question: 'Q?', selected: [] }] },
    ])
      expect(SessionAskRecordSchema.safeParse(record).success).toBe(false);
  });

  it('is strict, non-empty and bounded in questions', () => {
    expect(SessionAskRecordSchema.safeParse({ ...skipped, extra: 1 }).success).toBe(false);
    expect(
      SessionAskRecordSchema.safeParse({
        status: 'skipped',
        items: [{ ...skipped.items[0], x: 1 }],
      }).success,
    ).toBe(false);
    expect(SessionAskRecordSchema.safeParse({ status: 'skipped', items: [] }).success).toBe(false);
    const item = { header: 'H', question: 'Q?' };
    const many = (count: number) => ({
      status: 'skipped',
      items: Array.from({ length: count }, () => item),
    });
    expect(
      SessionAskRecordSchema.safeParse(many(SESSION_ASK_BOUNDS.questionsPerRecord)).success,
    ).toBe(true);
    expect(
      SessionAskRecordSchema.safeParse(many(SESSION_ASK_BOUNDS.questionsPerRecord + 1)).success,
    ).toBe(false);
  });

  it('pins the byte and code-point ceilings to literal numbers', () => {
    expect(SESSION_ASK_BOUNDS).toEqual({
      headerBytes: 24,
      questionBytes: 150,
      labelBytes: 60,
      questionsPerRecord: 4,
      optionsPerQuestion: 4,
      ownTextCodePoints: 500,
    });
    const record = (item: object) => ({
      status: 'answered',
      items: [{ header: 'H', question: 'Q?', selected: ['a'], ...item }],
    });
    const edge = (field: string, limit: number) => {
      expect(SessionAskRecordSchema.safeParse(record({ [field]: 'x'.repeat(limit) })).success).toBe(
        true,
      );
      expect(
        SessionAskRecordSchema.safeParse(record({ [field]: 'x'.repeat(limit + 1) })).success,
      ).toBe(false);
    };
    edge('header', 24);
    edge('question', 150);
    expect(SessionAskRecordSchema.safeParse(record({ selected: ['x'.repeat(60)] })).success).toBe(
      true,
    );
    expect(SessionAskRecordSchema.safeParse(record({ selected: ['x'.repeat(61)] })).success).toBe(
      false,
    );
    expect(
      SessionAskRecordSchema.safeParse(record({ selected: ['a', 'b', 'c', 'd', 'e'] })).success,
    ).toBe(false);
    // Bytes, not code units: a 3-byte glyph repeated past the budget is refused although it is few characters.
    expect(utf8ByteLength('€'.repeat(9))).toBeGreaterThan(24);
    expect(SessionAskRecordSchema.safeParse(record({ header: '€'.repeat(9) })).success).toBe(false);
    expect(SessionAskRecordSchema.safeParse(record({ header: '€'.repeat(8) })).success).toBe(true);
    // The own text is bounded in CODE POINTS (an astral character is one).
    const own = (text: string) =>
      SessionAskRecordSchema.safeParse(record({ selected: undefined, other: text })).success;
    expect(own('x'.repeat(500))).toBe(true);
    expect(own('x'.repeat(501))).toBe(false);
    expect(own('😀'.repeat(500))).toBe(true);
    expect(own('😀'.repeat(501))).toBe(false);
  });

  it('refuses control characters, separators and unpaired surrogates in every string', () => {
    const bad = [
      'a\nb',
      'a\tb',
      `a${String.fromCharCode(27)}[31mb`,
      `a${String.fromCharCode(0x2028)}b`,
      `a${String.fromCharCode(0x2029)}b`,
      `a${String.fromCharCode(0xd800)}b`,
    ];
    for (const text of bad) {
      for (const field of ['header', 'question', 'other'])
        expect(
          SessionAskRecordSchema.safeParse({
            status: 'answered',
            items: [
              {
                header: 'H',
                question: 'Q?',
                selected: field === 'other' ? undefined : ['a'],
                other: field === 'other' ? text : undefined,
                ...(field === 'other' ? {} : { [field]: text }),
              },
            ],
          }).success,
        ).toBe(false);
      expect(
        SessionAskRecordSchema.safeParse({
          status: 'answered',
          items: [{ header: 'H', question: 'Q?', selected: [text] }],
        }).success,
      ).toBe(false);
    }
    expect(
      SessionAskRecordSchema.safeParse({
        status: 'skipped',
        items: [{ header: '', question: 'Q?' }],
      }).success,
    ).toBe(false);
  });

  it('rides on a tool result and is read back by the strict part and message schemas', () => {
    expect(SessionToolResultPartSchema.parse(askResult)).toEqual(askResult);
    expect(SessionContentPartSchema.parse(askResult)).toEqual(askResult);
    const row = {
      id: 'm',
      sessionId: 's',
      sequenceNumber: 4,
      role: 'tool',
      content: [askResult],
      timestamp: '2026-11-16T00:00:00.000Z',
    };
    expect(SessionMessageSchema.parse(row).content).toEqual([askResult]);
    expect(
      SessionToolResultPartSchema.safeParse({ ...askResult, ask: { ...answered, extra: 1 } })
        .success,
    ).toBe(false);
  });

  it('is accepted in a history entry only for a successful ask_user call', () => {
    expect(SessionToolHistorySchema.parse([{ call: askCall, result: askResult }])).toEqual([
      { call: askCall, result: askResult },
    ]);
    expect(SessionToolHistorySchema.safeParse([{ call, result: askResult }]).success).toBe(false); // read_file
    for (const outcome of ['error', 'denied', 'cancelled'])
      expect(
        SessionToolHistorySchema.safeParse([{ call: askCall, result: { ...askResult, outcome } }])
          .success,
      ).toBe(false);
  });
});
