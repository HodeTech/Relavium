import { describe, expect, it } from 'vitest';

import {
  interruptionMatchesTurnCompleted,
  SessionInterruptionSchema,
  SessionTurnCompletedEventSchema,
} from './run-event.js';
import { SessionMessageSchema, type SessionMessage } from './session.js';
import {
  completedSessionTurns,
  projectSessionHistory,
  resumableMessageSequences,
  resumableSessionMessages,
  resumableTurnBoundarySequences,
} from './session-history.js';

const TS = '2026-06-17T00:00:00.000Z';
let seq = 0;
const row = (over: Record<string, unknown> = {}): SessionMessage =>
  SessionMessageSchema.parse({
    id: `m-${seq}`,
    sessionId: 's',
    sequenceNumber: seq++,
    role: 'user',
    content: [{ type: 'text', text: 'hello' }],
    timestamp: TS,
    ...over,
  });
const call = (id: string, name = 'read_file'): SessionMessage =>
  row({
    role: 'assistant',
    content: [{ type: 'tool_call', id, name, argsBytes: 2 }],
  });
const result = (id: string, outcome = 'ok'): SessionMessage =>
  row({
    role: 'tool',
    content: [{ type: 'tool_result', toolCallId: id, resultBytes: 2, outcome }],
  });
const answer = (text: string): SessionMessage =>
  row({ role: 'assistant', content: [{ type: 'text', text }] });
const interruption = (reason: string, code?: string): SessionMessage =>
  row({
    role: 'system',
    content: [],
    interruption: code === undefined ? { reason } : { reason, code },
  });
const start = (): void => {
  seq = 0;
};

describe('the interruption value (ADR-0119 §2)', () => {
  it.each([
    [{ reason: 'aborted' }],
    [{ reason: 'denied' }],
    [{ reason: 'turn_limit' }],
    [{ reason: 'failed', code: 'tool_failed' }],
    [{ reason: 'failed', code: 'provider_unavailable' }],
  ])('accepts %j', (value) => {
    expect(SessionInterruptionSchema.safeParse(value).success).toBe(true);
  });

  const forged: [unknown, string][] = [
    [{ reason: 'failed' }, 'a failed interruption must carry its code'],
    [{ reason: 'aborted', code: 'tool_failed' }, 'only failed carries a code'],
    [{ reason: 'denied', code: 'tool_denied' }, 'only failed carries a code'],
    [{ reason: 'cancelled' }, 'an unknown reason'],
    [{ reason: 'failed', code: 'not_a_code' }, 'an unknown code'],
    [{ reason: 'aborted', extra: 1 }, 'an unknown field'],
    [{}, 'no reason'],
  ];
  it.each(forged)('refuses %j (%s)', (value) => {
    expect(SessionInterruptionSchema.safeParse(value).success).toBe(false);
  });
});

describe('the interruption row (ADR-0119 §2)', () => {
  const base = { role: 'system', content: [], interruption: { reason: 'aborted' } };
  it('is a system row with no content', () => {
    start();
    expect(SessionMessageSchema.safeParse({ ...row(base), timestamp: TS }).success).toBe(true);
  });
  it.each([
    ['a user row', { role: 'user' }],
    ['an assistant row', { role: 'assistant' }],
    ['a row that is also a boundary marker', { compaction: { droppedThroughSequence: 0 } }],
    ['a row with content', { content: [{ type: 'text', text: 'note' }] }],
  ])('is refused on %s', (_name, over) => {
    start();
    const candidate = {
      id: 'm',
      sessionId: 's',
      sequenceNumber: 0,
      timestamp: TS,
      ...base,
      ...over,
    };
    expect(SessionMessageSchema.safeParse(candidate).success).toBe(false);
  });
});

describe('session:turn_completed (ADR-0119)', () => {
  const event = (extra: Record<string, unknown>) => ({
    type: 'session:turn_completed',
    sessionId: 's',
    sequenceNumber: 1,
    timestamp: TS,
    stopReason: 'aborted',
    tokensUsed: { input: 1, output: 1 },
    ...extra,
  });
  it('carries the interruption the engine retained', () => {
    const parsed = SessionTurnCompletedEventSchema.parse(
      event({ toolHistory: [], interruption: { reason: 'aborted' } }),
    );
    expect(parsed.interruption).toEqual({ reason: 'aborted' });
  });
  it('refuses a malformed interruption', () => {
    expect(
      SessionTurnCompletedEventSchema.safeParse(event({ interruption: { reason: 'failed' } }))
        .success,
    ).toBe(false);
  });
  it('is optional: an ordinary completed turn carries none', () => {
    expect(SessionTurnCompletedEventSchema.parse(event({})).interruption).toBeUndefined();
  });
});

describe('turn identity with an interruption row (ADR-0119 §3)', () => {
  it('ends an interrupted turn at its interruption row, which is the turn terminal', () => {
    start();
    const user = row();
    const c1 = call('session-tool:1:0');
    const r1 = result('session-tool:1:0');
    const marker = interruption('failed', 'tool_failed');
    const turns = completedSessionTurns([user, c1, r1, marker]);
    expect(turns).toHaveLength(1);
    expect(turns[0]?.terminal).toBe(marker);
    expect(turns[0]?.interruption).toEqual({ reason: 'failed', code: 'tool_failed' });
    expect(turns[0]?.messages).toEqual([user, c1, r1, marker]);
  });

  it('yields an interrupted turn’s user message only, and its marker row as the boundary slot', () => {
    start();
    const user = row(); // 0
    const c1 = call('session-tool:1:0'); // 1
    const r1 = result('session-tool:1:0'); // 2
    const marker = interruption('aborted'); // 3
    const next = row({ content: [{ type: 'text', text: 'again' }] }); // 4
    const reply = answer('done'); // 5
    const all = [user, c1, r1, marker, next, reply];
    expect(resumableSessionMessages(all)).toEqual([user, next, reply]);
    expect(resumableMessageSequences(all)).toEqual([0, 4, 5]);
    // one boundary slot per turn: the interruption row for the first, the answer for the second
    expect(resumableTurnBoundarySequences(all)).toEqual([3, 5]);
  });

  it('does not mistake a crash remnant for an interrupted turn, whatever follows it', () => {
    start();
    const remnantUser = row();
    const c1 = call('session-tool:1:0');
    const r1 = result('session-tool:1:0');
    // no terminal row; a NEW user abandons it, exactly as before
    const next = row({ content: [{ type: 'text', text: 'second' }] });
    const reply = answer('ok');
    const turns = completedSessionTurns([remnantUser, c1, r1, next, reply]);
    expect(turns).toHaveLength(1);
    expect(turns[0]?.user).toBe(next);
    expect(turns[0]?.interruption).toBeUndefined();
    // a trailing remnant is rolled back
    start();
    expect(
      completedSessionTurns([row(), call('session-tool:1:0'), result('session-tool:1:0')]),
    ).toEqual([]);
  });

  it('ignores an interruption row with no open exchange, and a system row without one', () => {
    start();
    const orphan = interruption('denied');
    const plain = row({ role: 'system', content: [{ type: 'text', text: 'summary' }] });
    const user = row();
    const reply = answer('hi');
    const turns = completedSessionTurns([orphan, plain, user, reply]);
    expect(turns).toHaveLength(1);
    expect(turns[0]?.user).toBe(user);
  });

  it('keeps a completed turn after an interrupted one and counts both', () => {
    start();
    const all = [
      row(),
      interruption('turn_limit'),
      row({ content: [{ type: 'text', text: 'two' }] }),
      answer('answered'),
    ];
    const projection = projectSessionHistory(all);
    expect(projection.turns.map((turn) => turn.interruption?.reason)).toEqual([
      'turn_limit',
      undefined,
    ]);
    expect(projection.trailingLegacyUsers).toEqual([]);
  });

  it('honours a compaction boundary by turn: an interrupted turn below it is dropped whole', () => {
    start();
    const oldUser = row();
    const oldMarker = interruption('aborted'); // seq 1
    const kept = row({ content: [{ type: 'text', text: 'kept' }] }); // seq 2
    const keptMarker = interruption('denied'); // seq 3
    const boundary = row({
      role: 'system',
      content: [],
      compaction: { droppedThroughSequence: 1 },
    });
    const all = [oldUser, oldMarker, kept, keptMarker, boundary];
    const retained = completedSessionTurns(all);
    expect(retained.map((turn) => turn.user)).toEqual([kept]);
    // export/disclosure pass `false` and see the whole history
    expect(completedSessionTurns(all, false)).toHaveLength(2);
  });

  it('does not let an interruption row stand in for an assistant answer on a later user', () => {
    start();
    const all = [row(), interruption('aborted'), row(), interruption('failed', 'internal')];
    expect(completedSessionTurns(all).map((turn) => turn.interruption?.reason)).toEqual([
      'aborted',
      'failed',
    ]);
  });
});

describe('interruptionMatchesTurnCompleted — the cross-field rule (ADR-0119)', () => {
  const error = (code: string) => ({ code, message: 'x', retryable: false }) as never;
  const check = (stopReason: string, interruption: unknown, code?: string) =>
    interruptionMatchesTurnCompleted({
      stopReason,
      ...(code === undefined ? {} : { error: error(code) }),
      ...(interruption === undefined ? {} : { interruption }),
    } as never);

  it('accepts an event without an interruption, whatever else it carries', () => {
    expect(check('stop', undefined)).toBe(true);
    expect(check('error', undefined, 'tool_failed')).toBe(true);
  });
  it('accepts each reason on the event shape the engine emits for it', () => {
    expect(check('aborted', { reason: 'aborted' })).toBe(true);
    expect(check('error', { reason: 'failed', code: 'tool_failed' }, 'tool_failed')).toBe(true);
    expect(check('error', { reason: 'denied' }, 'tool_denied')).toBe(true);
    expect(check('error', { reason: 'turn_limit' }, 'turn_limit')).toBe(true);
  });
  it.each([
    ['an abort that also carries an error', 'aborted', { reason: 'aborted' }, 'cancelled'],
    ['an abort on a normal stop', 'stop', { reason: 'aborted' }, undefined],
    ['a failure on a normal stop', 'stop', { reason: 'failed', code: 'tool_failed' }, undefined],
    [
      'a failure naming another code',
      'error',
      { reason: 'failed', code: 'tool_failed' },
      'internal',
    ],
    ['a denial under another code', 'error', { reason: 'denied' }, 'tool_failed'],
    ['a limit under another code', 'error', { reason: 'turn_limit' }, 'tool_denied'],
    ['an error turn with no error at all', 'error', { reason: 'denied' }, undefined],
    ['a failure with neither a code nor an error', 'error', { reason: 'failed' }, undefined],
    [
      'a failure on an abort stop with its code',
      'aborted',
      { reason: 'failed', code: 'tool_failed' },
      'tool_failed',
    ],
    ['a denial on a normal stop with its code', 'stop', { reason: 'denied' }, 'tool_denied'],
    ['a limit on an abort stop with its code', 'aborted', { reason: 'turn_limit' }, 'turn_limit'],
  ] as const)('refuses %s', (_name, stopReason, interruption, code) => {
    expect(check(stopReason, interruption, code)).toBe(false);
  });
});
