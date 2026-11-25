/**
 * The record row ([ADR-0148](../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md) §6): a content-free
 * system row that says the session's effective mode changed (`mode_change`) or its held estimates were released (`cost_release`). The
 * schema admits exactly those two shapes on a system row with no content, and refuses every forgery; the ONE history projection skips
 * the row, so it is never part of a turn, of a resumed context or of what a model is sent.
 */
import { describe, expect, it } from 'vitest';

import { CHAT_MODES } from './constants.js';
import {
  SESSION_RECORD_KINDS,
  SessionMessageSchema,
  SessionRecordSchema,
  type SessionMessage,
} from './session.js';
import {
  completedSessionTurns,
  projectSessionHistory,
  resumableMessageSequences,
  resumableSessionMessages,
  resumableTurnBoundarySequences,
} from './session-history.js';

const TS = '2026-11-25T00:00:00.000Z';
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
const record = (value: unknown, over: Record<string, unknown> = {}): unknown => ({
  id: 'r',
  sessionId: 's',
  sequenceNumber: 0,
  role: 'system',
  content: [],
  record: value,
  timestamp: TS,
  ...over,
});
const answer = (text: string): SessionMessage =>
  row({ role: 'assistant', content: [{ type: 'text', text }] });
const modeRow = (from: string, to: string): SessionMessage =>
  row({ role: 'system', content: [], record: { kind: 'mode_change', from, to } });
const releaseRow = (microcents: number): SessionMessage =>
  row({ role: 'system', content: [], record: { kind: 'cost_release', microcents } });

describe('the record schema', () => {
  it('admits a mode change between any two different modes, and a release of any non-negative integer amount', () => {
    for (const from of CHAT_MODES)
      for (const to of CHAT_MODES)
        if (from !== to)
          expect(
            SessionMessageSchema.safeParse(record({ kind: 'mode_change', from, to })).success,
            `${from} → ${to}`,
          ).toBe(true);
    for (const microcents of [0, 1, 123_456_789, Number.MAX_SAFE_INTEGER])
      expect(
        SessionMessageSchema.safeParse(record({ kind: 'cost_release', microcents })).success,
      ).toBe(true);
    expect(SESSION_RECORD_KINDS).toEqual(['mode_change', 'cost_release']);
  });

  it('round-trips the typed field unchanged', () => {
    const parsed = SessionMessageSchema.parse(
      record({ kind: 'mode_change', from: 'ask', to: 'auto' }),
    );
    expect(parsed.record).toEqual({ kind: 'mode_change', from: 'ask', to: 'auto' });
  });

  it.each([
    [
      'a record with content',
      record(
        { kind: 'mode_change', from: 'ask', to: 'auto' },
        { content: [{ type: 'text', text: 'injected' }] },
      ),
    ],
    [
      'a record with a compaction boundary',
      record(
        { kind: 'cost_release', microcents: 5 },
        { compaction: { droppedThroughSequence: 0 } },
      ),
    ],
    [
      'a record with an interruption',
      record({ kind: 'cost_release', microcents: 5 }, { interruption: { reason: 'aborted' } }),
    ],
    ['a user row', record({ kind: 'mode_change', from: 'ask', to: 'auto' }, { role: 'user' })],
    [
      'an assistant row',
      record({ kind: 'mode_change', from: 'ask', to: 'auto' }, { role: 'assistant' }),
    ],
    ['a tool row', record({ kind: 'cost_release', microcents: 5 }, { role: 'tool' })],
    ['a mode change to the same mode', record({ kind: 'mode_change', from: 'auto', to: 'auto' })],
    ['an unknown mode', record({ kind: 'mode_change', from: 'ask', to: 'yolo' })],
    ['an unknown from-mode', record({ kind: 'mode_change', from: 'Auto', to: 'ask' })],
    ['a mode change missing its end', record({ kind: 'mode_change', from: 'ask' })],
    [
      'a mode change carrying an amount',
      record({ kind: 'mode_change', from: 'ask', to: 'auto', microcents: 1 }),
    ],
    ['a release naming a mode', record({ kind: 'cost_release', microcents: 1, from: 'ask' })],
    ['a negative amount', record({ kind: 'cost_release', microcents: -1 })],
    ['a non-integer amount', record({ kind: 'cost_release', microcents: 1.5 })],
    ['a textual amount', record({ kind: 'cost_release', microcents: '5' })],
    ['a release with no amount', record({ kind: 'cost_release' })],
    ['an unknown kind', record({ kind: 'grant', from: 'ask', to: 'auto' })],
    ['a record that is not an object', record('mode_change')],
  ])('refuses %s', (_name, candidate) => {
    expect(SessionMessageSchema.safeParse(candidate).success).toBe(false);
  });

  it('refuses an unknown field on the record itself (strict, never stripped)', () => {
    expect(
      SessionRecordSchema.safeParse({ kind: 'mode_change', from: 'ask', to: 'plan', note: 'x' })
        .success,
    ).toBe(false);
  });
});

describe('the one history projection skips a record row', () => {
  /** The same transcript, without its record rows. */
  const withoutRecords = (messages: readonly SessionMessage[]): SessionMessage[] =>
    messages.filter((message) => message.record === undefined);

  it('between turns, inside an open exchange and after the last turn: the projection and every reader of it are unchanged', () => {
    seq = 0;
    const transcript = [
      modeRow('ask', 'auto'),
      row({ content: [{ type: 'text', text: 'first' }] }),
      answer('one'),
      releaseRow(4_200),
      modeRow('auto', 'plan'),
      row({ content: [{ type: 'text', text: 'second' }] }),
      // Not a shape the writer produces (a turn is written in one transaction), but the projection must hold even so.
      modeRow('plan', 'accept-edits'),
      answer('two'),
      modeRow('accept-edits', 'ask'),
    ];
    const plain = withoutRecords(transcript);
    expect(plain).toHaveLength(4);
    expect(projectSessionHistory(transcript)).toEqual(projectSessionHistory(plain));
    expect(completedSessionTurns(transcript, false)).toEqual(completedSessionTurns(plain, false));
    expect(resumableSessionMessages(transcript)).toEqual(resumableSessionMessages(plain));
    expect(resumableMessageSequences(transcript)).toEqual(resumableMessageSequences(plain));
    expect(resumableTurnBoundarySequences(transcript)).toEqual(
      resumableTurnBoundarySequences(plain),
    );
    // Two completed turns, each ended by its own answer; no record row is a terminal or a message the model sees.
    const turns = completedSessionTurns(transcript);
    expect(turns.map((turn) => turn.terminal.content)).toEqual([
      [{ type: 'text', text: 'one' }],
      [{ type: 'text', text: 'two' }],
    ]);
    expect(resumableSessionMessages(transcript).some((m) => m.record !== undefined)).toBe(false);
  });

  it('a record row is never the terminal of an open exchange (only an interruption row is)', () => {
    seq = 0;
    const transcript = [row({ content: [{ type: 'text', text: 'unanswered' }] }), releaseRow(1)];
    expect(completedSessionTurns(transcript)).toEqual([]);
    // The unanswered user rolls back exactly as it does without the record.
    expect(resumableSessionMessages(transcript)).toEqual(
      resumableSessionMessages(withoutRecords(transcript)),
    );
  });
});
