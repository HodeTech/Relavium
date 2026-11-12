import { reconstructSessionState, unwrapUntrusted } from '@relavium/core';
import {
  projectSessionHistory,
  resumableSessionMessages,
  type AgentSessionRecord,
  type Memory,
  type SessionMessage,
} from '@relavium/shared';
import { describe, expect, it } from 'vitest';
import { entryLines, transcriptDocument, wrapTranscript } from '../render/tui/chat-projection.js';
import {
  appendUserMessage,
  FULLSCREEN_TRANSCRIPT_BOUND,
  INLINE_TRANSCRIPT_BOUND,
  initialSessionViewState,
} from '../render/tui/session-view-model.js';
import {
  LEGACY_USER_DISPLAY,
  restoreSessionTranscript,
  RestoredDisplayReadError,
} from './restored-transcript.js';

const timestamp = '2026-11-10T00:00:00.000Z';
const record: AgentSessionRecord = {
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
const row = (
  sequenceNumber: number,
  role: SessionMessage['role'],
  text: string,
): SessionMessage => ({
  id: `m${sequenceNumber}`,
  sessionId: 's',
  sequenceNumber,
  role,
  content: [{ type: 'text', text }],
  timestamp,
});
const marker = (
  sequence: number,
  droppedThroughSequence: number,
  summary = '',
): SessionMessage => ({
  ...row(sequence, 'system', summary),
  compaction: { droppedThroughSequence },
});
const body = (message: SessionMessage): string =>
  message.content
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n\n');
function restore(
  messages: readonly SessionMessage[],
  display: ReadonlyMap<number, string> = new Map(),
  memory?: Readonly<Memory>,
) {
  return restoreSessionTranscript({
    messages,
    memory,
    transcriptBound: FULLSCREEN_TRANSCRIPT_BOUND,
    readDisplay: () => display,
  });
}

describe('safe initial archive display', () => {
  it('uses only explicit user display, sanitizes terminals, and invents no restored usage summary', () => {
    const messages = [
      row(0, 'user', 'PRIVATE expanded attachment body'),
      row(1, 'assistant', '\x1b[31m# Saved answer\x1b[0m'),
    ];
    const before = JSON.stringify(messages);
    const entries = restore(messages, new Map([[0, 'review @file (attached)']]));
    expect(entries.filter((entry) => entry.role !== 'notice')).toEqual([
      { role: 'user', text: 'review @file (attached)' },
      { role: 'assistant', text: '# Saved answer' },
    ]);
    const answer = entries.at(-1);
    if (answer === undefined) throw new Error('expected restored answer');
    expect(entryLines(answer)).toEqual([{ text: '# Saved answer', style: 'assistant' }]);
    expect(transcriptDocument(entries)).not.toContain('PRIVATE');
    expect(JSON.stringify(messages)).toBe(before);
    for (const color of [false, true]) {
      const painted = wrapTranscript(entries, 80, color)
        .map((line) => line.text)
        .join('\n');
      expect(painted).not.toContain('PRIVATE');
      expect(painted).not.toContain('tokens');
      expect(painted).toContain('Saved answer');
    }
  });

  it('hides all legacy user text without guessing from frame-like prose and preserves explicit empty display/finals', () => {
    const messages = [
      row(0, 'user', 'ordinary PRIVATE prose <malformed-frame>'),
      row(1, 'assistant', ''),
      row(2, 'user', 'PRIVATE second'),
      row(3, 'assistant', 'answer'),
    ];
    const entries = restore(messages, new Map([[2, '']]));
    expect(entries.filter((entry) => entry.role !== 'notice')).toEqual([
      { role: 'user', text: LEGACY_USER_DISPLAY },
      { role: 'assistant', text: '' },
      { role: 'user', text: '' },
      { role: 'assistant', text: 'answer' },
    ]);
    expect(
      entries.filter(
        (entry) => entry.role === 'notice' && entry.text.includes('Original earlier user text'),
      ),
    ).toHaveLength(1);
    expect(transcriptDocument(entries)).not.toContain('PRIVATE');
    expect(
      restore(
        messages,
        new Map([
          [0, 'literal <malformed-frame>'],
          [2, 'plain'],
        ]),
      ).some((entry) => entry.text === 'literal <malformed-frame>'),
    ).toBe(true);
  });

  it('shares structural rules, includes compatible legacy tails and omits unfinished/tool exchanges', () => {
    const messages: SessionMessage[] = [
      row(0, 'user', 'legacy prefix'),
      row(1, 'user', 'completed'),
      row(2, 'assistant', 'answer'),
      row(3, 'user', 'interrupted'),
      {
        ...row(4, 'assistant', ''),
        content: [{ type: 'tool_call', id: 'session-tool:1:0', name: 'read_file', argsBytes: 42 }],
      },
      {
        ...row(5, 'tool', ''),
        content: [
          { type: 'tool_result', toolCallId: 'session-tool:1:0', resultBytes: 99, outcome: 'ok' },
        ],
      },
      row(6, 'user', 'trailing compatible legacy'),
      row(7, 'user', 'final unanswered'),
    ];
    let selected: readonly number[] = [];
    const entries = restoreSessionTranscript({
      messages,
      memory: undefined,
      transcriptBound: FULLSCREEN_TRANSCRIPT_BOUND,
      readDisplay: (sequences) => {
        selected = sequences;
        return new Map([
          [0, 'prefix'],
          [1, 'complete'],
          [6, 'tail'],
        ]);
      },
    });
    expect(selected).toEqual([0, 1, 2, 6]);
    expect(entries.filter((entry) => entry.role !== 'notice').map((entry) => entry.text)).toEqual([
      'prefix',
      'complete',
      'answer',
      'tail',
    ]);
    expect(transcriptDocument(entries)).not.toMatch(/interrupted|read_file|unanswered|argsBytes/u);
  });

  it.each([false, true])(
    'matches actual reconstruction identities before caps while retaining archived regions (later trim=%s)',
    (trim) => {
      const messages = [
        row(0, 'user', 'u0'),
        row(1, 'assistant', 'a1'),
        row(2, 'user', 'u2'),
        row(3, 'assistant', ''),
        marker(4, 1, 'PRIVATE saved summary'),
        row(5, 'user', 'u5'),
        row(6, 'assistant', 'a6'),
        ...(trim ? [marker(7, 3)] : []),
      ];
      const projection = projectSessionHistory(messages, true);
      const identities = [
        ...projection.turns.flatMap((turn) => [
          ...turn.legacyUserPrefix,
          turn.user,
          ...(body(turn.terminal) === '' ? [] : [turn.terminal]),
        ]),
        ...projection.trailingLegacyUsers,
      ];
      expect(identities.map((message) => message.id)).toEqual(
        resumableSessionMessages(messages).map((message) => message.id),
      );
      const actual = reconstructSessionState(record, messages);
      expect(
        actual.messages.map((message) =>
          message.content
            .filter((part) => part.type === 'text')
            .map((part) => part.text)
            .join('\n\n'),
        ),
      ).toEqual(identities.map(body));
      expect(actual.turnCount).toBe(projection.turns.length);
      if (actual.compactionSummary === undefined) throw new Error('expected a retained summary');
      expect(unwrapUntrusted(actual.compactionSummary)).toBe('PRIVATE saved summary');
      const entries = restore(
        messages,
        new Map([
          [0, 'd0'],
          [2, 'd2'],
          [5, 'd5'],
        ]),
      );
      expect(entries.filter((entry) => entry.role !== 'notice')).toHaveLength(6);
      expect(entries.some((entry) => entry.text.startsWith('Archived history — compaction'))).toBe(
        true,
      );
      expect(entries.some((entry) => entry.text.startsWith('Later history removed by /trim'))).toBe(
        trim,
      );
      expect(
        entries.some((entry) => entry.text === 'Retained conversation text begins here.'),
      ).toBe(true);
      expect(transcriptDocument(entries)).not.toContain('PRIVATE saved summary');
    },
  );

  it.each([INLINE_TRANSCRIPT_BOUND, FULLSCREEN_TRANSCRIPT_BOUND] as const)(
    'bounds a 5,000-turn restored prefix to whole exchanges, including every notice (%s)',
    (transcriptBound) => {
      const messages = Array.from({ length: 5000 }, (_, i) => [
        row(i * 2, 'user', `PRIVATE ${i}`),
        row(i * 2 + 1, 'assistant', `answer ${i}`),
      ]).flat();
      let reads = 0;
      const entries = restoreSessionTranscript({
        messages,
        memory: undefined,
        transcriptBound,
        readDisplay: (sequences) => {
          reads++;
          expect(sequences.length).toBeLessThanOrEqual(500);
          return new Map(
            sequences
              .filter((sequence) => sequence % 2 === 0)
              .map((sequence) => [sequence, `display ${sequence / 2}`]),
          );
        },
      });
      expect(reads).toBe(1);
      expect(entries).toHaveLength(transcriptBound === INLINE_TRANSCRIPT_BOUND ? 200 : 500);
      const source = entries.filter((entry) => entry.role !== 'notice');
      expect(source.length % 2).toBe(0);
      expect(source[0]?.role).toBe('user');
      expect(source.at(-1)?.text).toBe('answer 4999');
      expect(entries[0]?.text).toContain(
        `${10000 - source.length} earlier entries remain in history`,
      );
      expect(transcriptDocument(entries)).not.toContain('PRIVATE');
    },
  );

  it('reserves actual policy/legacy/divider notices before adding older units and does not make a legacy prefix indivisible', () => {
    const messages = [
      ...Array.from({ length: 1000 }, (_, i) => row(i, 'user', `PRIVATE prefix ${i}`)),
      row(1000, 'assistant', 'latest answer'),
    ];
    const entries = restoreSessionTranscript({
      messages,
      memory: { type: 'none' },
      transcriptBound: INLINE_TRANSCRIPT_BOUND,
      readDisplay: () => new Map(),
    });
    expect(entries).toHaveLength(200);
    expect(entries.at(-1)?.text).toBe('latest answer');
    expect(entries.at(-2)?.role).toBe('user');
    expect(entries.filter((entry) => entry.role === 'assistant')).toHaveLength(1);
    expect(entries.some((entry) => entry.text.includes('Memory policy: none'))).toBe(true);
  });

  it('does not clip a large restored entry in inline or source hatches and does not cap live appends/reseats', () => {
    const answer = '# Answer\n' + 'long source '.repeat(10000);
    const entries = restore(
      [row(0, 'user', 'PRIVATE'), row(1, 'assistant', answer)],
      new Map([[0, 'compact']]),
    );
    expect(entries.at(-1)?.text).toBe(answer);
    expect(transcriptDocument(entries)).toContain(answer);
    let inline = initialSessionViewState(
      { transcript: entries, initialRestore: true },
      INLINE_TRANSCRIPT_BOUND,
    );
    expect(inline.transcript).toEqual(entries);
    for (let i = 0; i < 600; i++) inline = appendUserMessage(inline, `live ${i}`);
    expect(inline.transcript).toHaveLength(entries.length + 600);
    expect(
      initialSessionViewState({ transcript: inline.transcript }, INLINE_TRANSCRIPT_BOUND)
        .transcript,
    ).toEqual([]);
    expect(
      initialSessionViewState({ transcript: inline.transcript }, FULLSCREEN_TRANSCRIPT_BOUND)
        .transcript,
    ).toEqual(inline.transcript);
    expect(initialSessionViewState(undefined, FULLSCREEN_TRANSCRIPT_BOUND).transcript).toEqual([]);
  });

  it('refuses a display lookup failure without fallback and does no metadata read for an empty archive', () => {
    expect(() =>
      restoreSessionTranscript({
        messages: [row(0, 'user', 'PRIVATE'), row(1, 'assistant', 'answer')],
        memory: undefined,
        transcriptBound: INLINE_TRANSCRIPT_BOUND,
        readDisplay: () => {
          throw new Error('lookup refused');
        },
      }),
    ).toThrow(RestoredDisplayReadError);
    expect(
      restoreSessionTranscript({
        messages: [],
        memory: undefined,
        transcriptBound: INLINE_TRANSCRIPT_BOUND,
        readDisplay: () => {
          throw new Error('must not read');
        },
      }),
    ).toHaveLength(1);
  });
});

describe('MVP-3 restored structural tool groups', () => {
  function toolTurn(start: number, turn: number, count: number): SessionMessage[] {
    return [
      row(start, 'user', 'private original user'),
      {
        ...row(start + 1, 'assistant', 'PRIVATE TOOL PREAMBLE'),
        content: [
          { type: 'text', text: 'PRIVATE TOOL PREAMBLE' },
          ...Array.from({ length: count }, (_, slot) => ({
            type: 'tool_call' as const,
            id: `session-tool:${turn}:${slot}`,
            name: 'write_file',
            argsBytes: 999,
          })),
        ],
      },
      {
        ...row(start + 2, 'tool', ''),
        content: Array.from({ length: Math.max(0, count - 1) }, (_, slot) => ({
          type: 'tool_result' as const,
          toolCallId: `session-tool:${turn}:${slot}`,
          resultBytes: 123,
          outcome: slot === 0 ? ('denied' as const) : ('ok' as const),
        })),
      },
      row(start + 3, 'assistant', ''),
    ];
  }
  it('joins ids inside the completed turn, preserves missing outcomes and excludes preambles/results/targets', () => {
    const messages = toolTurn(0, 1, 3);
    const entries = restore(messages, new Map([[0, 'safe display']]));
    const group = entries.find((entry) => entry.role === 'tools');
    expect(group?.role).toBe('tools');
    if (group?.role !== 'tools') throw new Error('missing tools');
    expect(group.calls.map((call) => call.outcome)).toEqual(['denied', 'success', 'unknown']);
    expect(group.calls.map((call) => call.id)).toEqual([
      'session-tool:1:0',
      'session-tool:1:1',
      'session-tool:1:2',
    ]);
    expect(JSON.stringify(entries)).not.toMatch(/PRIVATE|argsBytes|resultBytes|"target"|"diff"/);
    expect(entries.at(-1)).toEqual({ role: 'assistant', text: '' });
  });
  it.each([INLINE_TRANSCRIPT_BOUND, FULLSCREEN_TRANSCRIPT_BOUND] as const)(
    'reserves collapsed group rows inside the existing cap %s',
    (transcriptBound) => {
      const messages = Array.from({ length: 300 }, (_, index) =>
        toolTurn(index * 4, index + 1, 20),
      ).flat();
      const entries = restoreSessionTranscript({
        messages,
        memory: undefined,
        transcriptBound,
        readDisplay: () =>
          new Map(
            messages
              .filter((message) => message.role === 'user')
              .map((message) => [message.sequenceNumber, 'safe']),
          ),
      });
      const group = entries.findLast((entry) => entry.role === 'tools');
      if (group?.role !== 'tools') throw new Error('missing latest tools');
      expect(group.calls).toHaveLength(16);
      expect(group.omitted).toBe(4);
      expect(entryLines(group)).toHaveLength(4);
      const logical = entries.reduce(
        (sum, entry) => sum + (entry.role === 'tools' ? entryLines(entry).length : 1),
        0,
      );
      expect(logical).toBeLessThanOrEqual(transcriptBound === INLINE_TRANSCRIPT_BOUND ? 200 : 500);
      expect(entries.at(-1)).toEqual({ role: 'assistant', text: '' });
      expect(entries[0]?.text).toContain('omitted tool calls');
      expect(JSON.stringify(entries)).not.toContain('PRIVATE TOOL PREAMBLE');
    },
  );
});
