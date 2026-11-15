import type { LlmMessage } from '@relavium/llm';
import type {
  CompletedSessionTurn,
  SessionMessage,
  SessionToolHistoryEntry,
} from '@relavium/shared';
import { describe, expect, expectTypeOf, it } from 'vitest';

import { markUntrusted } from '../tools/untrusted.js';
import type { PreparedAgentTurnRequest } from './agent-turn.js';
import { prepareCompactionChunk, renderConversationToSummarise } from './session-compaction.js';
import { buildTurnMessages } from './turn-messages.js';
import {
  KNOWN_EMPTY_RECEIPTS,
  OMITTED_RECEIPTS,
  RECEIPT_BLOCK_CLOSING,
  RECEIPT_BLOCK_OPENING,
  RECEIPT_LIMITS,
  RECEIPT_NOTICE_INCOMPLETE,
  RECEIPT_NOTICE_LEGEND,
  RECEIPT_OTHER_TOOL,
  admitSuppliedSpans,
  deriveTurnReceipts,
  receiptBlockBytes,
  receiptLabel,
  receiptsFromToolHistory,
  renderReceiptNotice,
  renderTurnReceiptBlock,
  retainTurnReceipts,
  type ReceiptOutcome,
  type ReceiptRecord,
  type TurnReceipts,
} from './turn-receipts.js';
import { BUILTIN_TOOL_IDS } from '../tools/builtins.js';

const record = (label: string, outcome: ReceiptOutcome = 'ok'): ReceiptRecord => ({
  label,
  outcome,
});
const receipts = (
  records: readonly ReceiptRecord[],
  omitted: number | 'unknown' = 0,
  incomplete = omitted !== 0,
): TurnReceipts => ({ records, omitted, incomplete });

const entry = (
  id: string,
  name: string,
  outcome: ReceiptOutcome = 'ok',
): SessionToolHistoryEntry => ({
  call: { type: 'tool_call', id, name, argsBytes: 7 },
  result: { type: 'tool_result', toolCallId: id, resultBytes: 9, outcome },
});

// Durable-row builders that mirror what the CLI persister writes for a completed turn.
let sequence = 0;
const row = (role: SessionMessage['role'], content: SessionMessage['content']): SessionMessage => ({
  id: `row-${sequence}`,
  sessionId: 's',
  sequenceNumber: sequence++,
  role,
  content,
  timestamp: '2026-11-15T00:00:00.000Z',
});
const text = (value: string): SessionMessage['content'] => [{ type: 'text', text: value }];
const pairRows = (entries: readonly SessionToolHistoryEntry[]): SessionMessage[] =>
  entries.flatMap((e) => [row('assistant', [e.call]), row('tool', [e.result])]);
const turnOf = (...inner: SessionMessage[]): CompletedSessionTurn => {
  const user = row('user', text('q'));
  const terminal = row('assistant', text('a'));
  return { user, terminal, messages: [user, ...inner, terminal], legacyUserPrefix: [] };
};

describe('the closed receipt vocabulary (ADR-0128)', () => {
  it('keeps exact built-in ids and replaces every other name, whatever its syntax', () => {
    for (const id of BUILTIN_TOOL_IDS) expect(receiptLabel(id)).toBe(id);
    expect(BUILTIN_TOOL_IDS).toContain('mcp_call');
    for (const name of [
      'unknown_tool',
      'mcp__server__lookup',
      'sk-live-AbCdEf0123456789',
      'Read_File',
      'read_file ',
      '',
      'a'.repeat(128),
    ])
      expect(receiptLabel(name)).toBe(RECEIPT_OTHER_TOOL);
  });

  it('derives the outcome type from the durable schema, so a fifth value breaks the build', () => {
    expectTypeOf<ReceiptOutcome>().toEqualTypeOf<'ok' | 'error' | 'denied' | 'cancelled'>();
  });

  it('renders each recorded outcome verbatim and never merges two of them', () => {
    const block = renderTurnReceiptBlock(
      receipts([
        record('read_file', 'ok'),
        record('write_file', 'error'),
        record('read_media', 'denied'),
        record('run_command', 'cancelled'),
      ]),
    );
    expect(block).toBe(
      [
        `\n\n${RECEIPT_BLOCK_OPENING}`,
        '1. read_file — ok',
        '2. write_file — error',
        '3. read_media — denied',
        '4. run_command — cancelled',
        RECEIPT_BLOCK_CLOSING,
      ].join('\n'),
    );
  });
});

describe('render grammar', () => {
  it('numbers records per turn block and renders no block for a turn without records', () => {
    expect(renderTurnReceiptBlock(KNOWN_EMPTY_RECEIPTS)).toBeUndefined();
    expect(renderTurnReceiptBlock(OMITTED_RECEIPTS)).toBeUndefined();
    const one = renderTurnReceiptBlock(receipts([record('git_status')])) ?? '';
    expect(one).toContain('\n1. git_status — ok\n');
    expect(one).not.toContain('2.');
  });

  it('states omitted earlier calls with the exact count, or with an unknown number', () => {
    expect(renderTurnReceiptBlock(receipts([record('read_file')], 3))).toContain(
      '[Earlier calls in this turn not listed: 3.]\n1. read_file — ok',
    );
    expect(renderTurnReceiptBlock(receipts([record('read_file')], 'unknown'))).toContain(
      '[Earlier calls in this turn not listed: unknown number.]',
    );
    expect(renderTurnReceiptBlock(receipts([record('read_file')]))).not.toContain('not listed');
  });

  it('builds one notice: the legend for any block, the incompleteness sentence for any gap', () => {
    expect(renderReceiptNotice([])).toBeUndefined();
    expect(renderReceiptNotice([KNOWN_EMPTY_RECEIPTS, KNOWN_EMPTY_RECEIPTS])).toBeUndefined();
    expect(renderReceiptNotice([receipts([record('read_file')])])).toBe(
      `${RECEIPT_NOTICE_LEGEND}\n\n`,
    );
    expect(renderReceiptNotice([OMITTED_RECEIPTS])).toBe(`${RECEIPT_NOTICE_INCOMPLETE}\n\n`);
    expect(renderReceiptNotice([receipts([record('read_file')], 2)])).toBe(
      `${RECEIPT_NOTICE_LEGEND} ${RECEIPT_NOTICE_INCOMPLETE}\n\n`,
    );
  });

  it('states what each outcome does not establish, and that a record is not a file’s state', () => {
    for (const word of ['ok:', 'error:', 'denied:', 'cancelled:'])
      expect(RECEIPT_NOTICE_LEGEND).toContain(word);
    expect(RECEIPT_NOTICE_LEGEND).toContain('partial effect');
    expect(RECEIPT_NOTICE_LEGEND).toContain('neither forbids nor permits');
    expect(RECEIPT_NOTICE_LEGEND).toContain('outcome is unknown');
    expect(RECEIPT_NOTICE_LEGEND).toContain('current state');
    expect(RECEIPT_NOTICE_INCOMPLETE).toContain('not evidence that no tool ran');
  });

  it('proves by construction that the per-turn byte cap can never bind', () => {
    const longest = [...BUILTIN_TOOL_IDS].sort((a, b) => b.length - a.length)[0] ?? '';
    const worst = receipts(
      Array.from({ length: RECEIPT_LIMITS.turnRecords }, () => record(longest, 'cancelled')),
      'unknown',
    );
    expect(receiptBlockBytes(worst)).toBeLessThanOrEqual(RECEIPT_LIMITS.turnBytes);
  });
});

describe('live source: the typed toolHistory', () => {
  it('distinguishes a known-empty turn from a missing source', () => {
    expect(receiptsFromToolHistory([])).toEqual({ records: [], omitted: 0, incomplete: false });
    expect(receiptsFromToolHistory(undefined)).toEqual({
      records: [],
      omitted: 'unknown',
      incomplete: true,
    });
  });

  it('records mixed outcomes in order and substitutes every non-built-in name', () => {
    const live = receiptsFromToolHistory([
      entry('session-tool:1:0', 'read_file', 'ok'),
      entry('session-tool:1:1', 'echo', 'error'),
      entry('session-tool:1:2', 'sk-live-SECRET', 'denied'),
      entry('session-tool:1:3', 'unknown_tool', 'cancelled'),
    ]);
    expect(live.records).toEqual([
      record('read_file', 'ok'),
      record(RECEIPT_OTHER_TOOL, 'error'),
      record(RECEIPT_OTHER_TOOL, 'denied'),
      record(RECEIPT_OTHER_TOOL, 'cancelled'),
    ]);
    expect(JSON.stringify(live)).not.toContain('SECRET');
    expect(live.incomplete).toBe(false);
  });

  it('keeps the newest 32 records at exactly 32 and 33 and counts the omitted one', () => {
    const history = (count: number) =>
      Array.from({ length: count }, (_, i) => entry(`session-tool:1:${i}`, 'read_file'));
    expect(receiptsFromToolHistory(history(32))).toMatchObject({ omitted: 0, incomplete: false });
    const thirtyThree = receiptsFromToolHistory(history(33));
    expect(thirtyThree.records).toHaveLength(32);
    expect(thirtyThree).toMatchObject({ omitted: 1, incomplete: true });
  });

  it('refuses a duplicate or mismatched identity instead of guessing a pair', () => {
    expect(receiptsFromToolHistory([entry('a', 'read_file'), entry('a', 'write_file')])).toEqual(
      OMITTED_RECEIPTS,
    );
    const mismatched = entry('b', 'read_file');
    expect(
      receiptsFromToolHistory([
        { ...mismatched, result: { ...mismatched.result, toolCallId: 'c' } },
      ]),
    ).toEqual(OMITTED_RECEIPTS);
  });

  it('validates only the newest window yet counts the exact omitted number beyond it', () => {
    // 300 entries; the OLDEST shares an id with the newest. It lies beyond the inspected window, so no
    // uniqueness claim is made over it: the newest record renders once and the turn is incomplete.
    const history = Array.from({ length: 300 }, (_, i) => entry(`id-${i}`, 'read_file'));
    history[0] = entry('id-299', 'write_file');
    const live = receiptsFromToolHistory(history);
    expect(live.records).toHaveLength(RECEIPT_LIMITS.turnRecords);
    expect(live).toMatchObject({ omitted: 268, incomplete: true });
  });
});

describe('restored source: structural rows', () => {
  it('treats a turn with zero tool rows as ambiguous, never as known empty', () => {
    expect(deriveTurnReceipts([turnOf()])).toEqual([{ records: [], omitted: 0, incomplete: true }]);
  });

  it('derives records oldest first from matched adjacent pairs', () => {
    const [derived] = deriveTurnReceipts([
      turnOf(
        ...pairRows([
          entry('session-tool:2:0', 'list_directory'),
          entry('session-tool:2:1', 'write_file', 'error'),
          entry('session-tool:2:2', 'read_media', 'denied'),
        ]),
      ),
    ]);
    expect(derived).toEqual({
      records: [
        record('list_directory', 'ok'),
        record('write_file', 'error'),
        record('read_media', 'denied'),
      ],
      omitted: 0,
      incomplete: false,
    });
  });

  it('classifies a forged credential-like name and discards it', () => {
    const [derived] = deriveTurnReceipts([
      turnOf(...pairRows([entry('session-tool:3:0', 'AKIA-FORGED-0123456789')])),
    ]);
    expect(derived?.records).toEqual([record(RECEIPT_OTHER_TOOL)]);
    expect(JSON.stringify(derived)).not.toContain('AKIA');
  });

  it.each([
    [
      'an unpaired orphan row',
      () => [
        row('assistant', [entry('x', 'read_file').call]),
        ...pairRows([entry('y', 'read_file')]),
      ],
    ],
    [
      'a result that does not match its call',
      () => {
        const pair = entry('p', 'read_file');
        return [row('assistant', [pair.call]), row('tool', [{ ...pair.result, toolCallId: 'q' }])];
      },
    ],
    [
      'a duplicate id within the turn',
      () => pairRows([entry('d', 'read_file'), entry('d', 'write_file')]),
    ],
    [
      'rows of the wrong role',
      () => {
        const pair = entry('w', 'read_file');
        return [row('tool', [pair.call]), row('assistant', [pair.result])];
      },
    ],
    [
      'a multi-part row',
      () => {
        const pair = entry('m', 'read_file');
        return [row('assistant', [pair.call, pair.call]), row('tool', [pair.result])];
      },
    ],
  ])('degrades %s to an incomplete turn without failing', (_name, build) => {
    expect(deriveTurnReceipts([turnOf(...build())])).toEqual([OMITTED_RECEIPTS]);
  });

  it('refuses a stored outcome outside the closed vocabulary rather than rendering it', () => {
    const pair = entry('o', 'read_file');
    const forged = { ...pair.result, outcome: 'success' } as unknown as typeof pair.result;
    expect(
      deriveTurnReceipts([turnOf(row('assistant', [pair.call]), row('tool', [forged]))]),
    ).toEqual([OMITTED_RECEIPTS]);
  });

  it('may reuse an id in two different turns: ids are never used across turns', () => {
    const reused = deriveTurnReceipts([
      turnOf(...pairRows([entry('session-tool:1:0', 'read_file')])),
      turnOf(...pairRows([entry('session-tool:1:0', 'write_file')])),
    ]);
    expect(reused.map((r) => r.records.map((x) => x.label))).toEqual([
      ['read_file'],
      ['write_file'],
    ]);
  });

  it('retains the newest 32 of 40 records and counts the omitted eight exactly', () => {
    const entries = Array.from({ length: 40 }, (_, i) =>
      entry(`id-${i}`, i % 2 === 0 ? 'read_file' : 'write_file'),
    );
    const [derived] = deriveTurnReceipts([turnOf(...pairRows(entries))]);
    expect(derived?.records).toHaveLength(32);
    expect(derived).toMatchObject({ omitted: 8, incomplete: true });
    expect(derived?.records.at(-1)).toEqual(record('write_file'));
  });

  it('stops at the per-turn part budget at a whole-record boundary and calls the rest unknown', () => {
    const entries = Array.from({ length: 200 }, (_, i) => entry(`id-${i}`, 'read_file'));
    const [derived] = deriveTurnReceipts([turnOf(...pairRows(entries))]);
    expect(derived?.records).toHaveLength(RECEIPT_LIMITS.turnRecords);
    expect(derived).toMatchObject({ omitted: 'unknown', incomplete: true });
  });

  it('claims no uniqueness across the inspection boundary: an id on both sides renders once', () => {
    // 200 pairs = 400 parts; only the newest 128 pairs (256 parts) are inspected. The oldest pair reuses the
    // newest pair's id. It is never examined, so nothing is rejected and nothing is claimed about it.
    const entries = Array.from({ length: 200 }, (_, i) => entry(`id-${i}`, 'read_file'));
    entries[0] = entry('id-199', 'write_file');
    const [derived] = deriveTurnReceipts([turnOf(...pairRows(entries))]);
    expect(derived?.records.filter((r) => r.label === 'write_file')).toHaveLength(0);
    expect(derived).toMatchObject({ omitted: 'unknown', incomplete: true });
    // The same id INSIDE the inspected window is a real duplicate and degrades the turn.
    const inside = Array.from({ length: 200 }, (_, i) => entry(`id-${i}`, 'read_file'));
    inside[199] = entry('id-198', 'write_file');
    expect(deriveTurnReceipts([turnOf(...pairRows(inside))])).toEqual([OMITTED_RECEIPTS]);
  });

  it('spends the operation budget newest first, so only older turns become uninspected', () => {
    // 50 turns of 80 pairs = 160 parts each. 4,096 parts fully inspect the newest 25 (4,000), the 26th gets
    // the remaining 96 parts and is cut mid-turn, and the oldest 24 are never examined.
    const turns = Array.from({ length: 50 }, (_, t) =>
      turnOf(...pairRows(Array.from({ length: 80 }, (_, i) => entry(`t${t}-${i}`, 'read_file')))),
    );
    const derived = deriveTurnReceipts(turns);
    expect(derived.slice(-25).every((r) => r.records.length === 32 && r.omitted === 48)).toBe(true);
    expect(derived.at(-26)).toMatchObject({ omitted: 'unknown', incomplete: true });
    expect(derived.at(-26)?.records).toHaveLength(32);
    for (const older of derived.slice(0, 24)) expect(older).toEqual(OMITTED_RECEIPTS);
  });
});

describe('one retention rule', () => {
  const span = (n: number, r: TurnReceipts) => ({ start: n * 2, end: n * 2 + 2, receipts: r });
  const many = (count: number, label = 'read_file') =>
    receipts(Array.from({ length: count }, () => record(label)));

  it('keeps the newest 32 four-record turns and evicts the oldest one: no turn cap, no error', () => {
    const spans = Array.from({ length: 33 }, (_, i) => span(i, many(4)));
    const retained = retainTurnReceipts(spans);
    expect(retained).toHaveLength(33);
    expect(retained.slice(1).every((s) => s.receipts.records.length === 4)).toBe(true);
    expect(retained[0]?.receipts).toEqual(OMITTED_RECEIPTS);
  });

  it('evicts by bytes when many one-record turns stay under the record cap', () => {
    const spans = Array.from({ length: 120 }, (_, i) => span(i, many(1)));
    const retained = retainTurnReceipts(spans);
    const kept = retained.filter((s) => s.receipts.records.length > 0).length;
    expect(kept).toBeLessThan(120);
    expect(kept).toBeGreaterThan(80);
    // The kept turns are exactly the newest suffix, and together they fit.
    expect(retained.slice(120 - kept).every((s) => s.receipts.records.length > 0)).toBe(true);
    const bytes = retained.reduce((sum, s) => sum + receiptBlockBytes(s.receipts), 0);
    expect(bytes).toBeLessThanOrEqual(RECEIPT_LIMITS.totalBytes);
  });

  it('never skips a block that does not fit to keep a smaller older one', () => {
    const spans = [
      span(0, many(1)), // older and small: 111 records would fit if the larger block above were skipped
      span(1, many(30)), // the first block, walking newest first, that does not fit (140 > 128)
      span(2, many(30)),
      span(3, many(30)),
      span(4, many(30)),
      span(5, many(20)),
    ];
    const retained = retainTurnReceipts(spans);
    expect(retained.map((s) => s.receipts.records.length)).toEqual([0, 0, 30, 30, 30, 20]);
    expect(retained[0]?.receipts).toEqual(OMITTED_RECEIPTS);
    expect(retained[1]?.receipts).toEqual(OMITTED_RECEIPTS);
  });

  it('leaves turns without records untouched, even older than the cut, and never mutates its input', () => {
    const spans = [
      span(0, KNOWN_EMPTY_RECEIPTS),
      span(1, many(30)),
      span(2, many(30)),
      span(3, many(30)),
      span(4, many(30)),
      span(5, many(30)),
    ];
    const snapshot = JSON.stringify(spans);
    const retained = retainTurnReceipts(spans);
    expect(retained[0]).toBe(spans[0]);
    expect(retained[1]?.receipts).toEqual(OMITTED_RECEIPTS);
    expect(JSON.stringify(spans)).toBe(snapshot);
    expect(retained[5]).toBe(spans[5]);
  });
});

describe('admitting host-supplied receipt metadata', () => {
  const geometry = { start: 0, end: 2 };
  it('returns frozen copies that a caller can no longer alter', () => {
    const supplied = receipts([record('read_file')]);
    const [admitted] = admitSuppliedSpans([{ ...geometry, receipts: supplied }]) ?? [];
    expect(admitted?.receipts).toEqual(supplied);
    expect(admitted?.receipts).not.toBe(supplied);
    expect(Object.isFrozen(admitted?.receipts)).toBe(true);
    expect(Object.isFrozen(admitted?.receipts.records)).toBe(true);
  });

  it.each([
    ['a null value', null],
    [
      'a record count over the per-turn cap',
      receipts(Array.from({ length: 33 }, () => record('read_file'))),
    ],
    [
      'a label outside the closed set',
      { records: [{ label: 'sk-secret', outcome: 'ok' }], omitted: 0, incomplete: false },
    ],
    [
      'an outcome outside the closed set',
      { records: [{ label: 'read_file', outcome: 'success' }], omitted: 0, incomplete: false },
    ],
    ['a negative omitted count', { records: [], omitted: -1, incomplete: true }],
    ['a fractional omitted count', { records: [], omitted: 1.5, incomplete: true }],
    [
      'an unsafe omitted count',
      { records: [], omitted: Number.MAX_SAFE_INTEGER + 1, incomplete: true },
    ],
    ['a string omitted count', { records: [], omitted: '3', incomplete: true }],
    ['omitted records on a complete turn', { records: [], omitted: 2, incomplete: false }],
    ['a non-boolean incomplete flag', { records: [], omitted: 0, incomplete: 'no' }],
    ['a non-array record list', { records: 'x', omitted: 0, incomplete: false }],
    ['a non-object record', { records: [1], omitted: 0, incomplete: false }],
  ])('refuses %s', (_name, bad) => {
    expect(admitSuppliedSpans([{ ...geometry, receipts: bad }])).toBeUndefined();
  });

  it('rejects an oversized record list before walking it', () => {
    const huge = new Array<unknown>(2 ** 31);
    const started = performance.now();
    expect(
      admitSuppliedSpans([
        { ...geometry, receipts: { records: huge, omitted: 0, incomplete: false } },
      ]),
    ).toBeUndefined();
    expect(performance.now() - started).toBeLessThan(250);
  });

  it('refuses more than 128 records or more than the byte budget in total', () => {
    const five = Array.from({ length: 5 }, () =>
      receipts(Array.from({ length: 30 }, () => record('read_file'))),
    );
    expect(
      admitSuppliedSpans(five.map((r, i) => ({ start: i, end: i + 1, receipts: r }))),
    ).toBeUndefined();
    const oneEach = Array.from({ length: 110 }, (_, i) => ({
      start: i,
      end: i + 1,
      receipts: receipts([record('read_file')]),
    }));
    expect(admitSuppliedSpans(oneEach)).toBeUndefined();
    expect(admitSuppliedSpans(oneEach.slice(0, 60))).toHaveLength(60);
  });
});

describe('request projection (ADR-0095 §4 with ADR-0128 receipts)', () => {
  const user = (value: string): LlmMessage => ({
    role: 'user',
    content: [{ type: 'text', text: value }],
  });
  const assistant = (value: string): LlmMessage => ({
    role: 'assistant',
    content: [{ type: 'text', text: value }],
  });
  const joined = (messages: readonly LlmMessage[]) =>
    messages.map((m) => ({
      role: m.role,
      text: m.content.map((p) => (p.type === 'text' ? p.text : '')).join(''),
    }));
  const spanOf = (start: number, end: number, r: TurnReceipts) => ({ start, end, receipts: r });
  const block = (lines: string) =>
    `\n\n${RECEIPT_BLOCK_OPENING}\n${lines}\n${RECEIPT_BLOCK_CLOSING}`;

  it('is byte-identical to the text-only request when no turn has records or gaps', () => {
    const pending = user('now');
    const messages = [user('q1'), assistant('a1'), pending];
    const withSpans = buildTurnMessages(undefined, messages, {
      completedTurnSpans: [spanOf(0, 2, KNOWN_EMPTY_RECEIPTS)],
      pendingUser: pending,
    });
    const without = buildTurnMessages(undefined, messages, {
      completedTurnSpans: [],
      pendingUser: pending,
    });
    expect(withSpans).toEqual(without);
  });

  it('attaches the block after that turn’s user text, with the legend at the head', () => {
    const pending = user('now');
    const built = buildTurnMessages(undefined, [user('q1'), assistant('a1'), pending], {
      completedTurnSpans: [
        spanOf(0, 2, receipts([record('read_file'), record('write_file', 'error')])),
      ],
      pendingUser: pending,
    });
    expect(joined(built)).toEqual([
      {
        role: 'user',
        text: `${RECEIPT_NOTICE_LEGEND}\n\nq1${block('1. read_file — ok\n2. write_file — error')}`,
      },
      { role: 'assistant', text: 'a1' },
      { role: 'user', text: 'now' },
    ]);
    // The legend and the block are separate text parts of the SAME user message.
    expect(built[0]?.content.map((p) => p.type)).toEqual(['text', 'text', 'text']);
  });

  it('orders the compaction summary, then the notice, then the user text', () => {
    const pending = user('now');
    const built = buildTurnMessages(
      markUntrusted('SUMMARY-BODY'),
      [user('q1'), assistant('a1'), pending],
      {
        completedTurnSpans: [spanOf(0, 2, OMITTED_RECEIPTS)],
        pendingUser: pending,
      },
    );
    const text = joined(built)[0]?.text ?? '';
    expect(text.indexOf('SUMMARY-BODY')).toBeLessThan(text.indexOf(RECEIPT_NOTICE_INCOMPLETE));
    expect(text.indexOf(RECEIPT_NOTICE_INCOMPLETE)).toBeLessThan(text.indexOf('q1'));
  });

  it('keeps the association for an empty-final turn after adjacent-role folding', () => {
    const pending = user('next');
    const built = buildTurnMessages(undefined, [user('empty-final'), pending], {
      completedTurnSpans: [spanOf(0, 1, receipts([record('write_file')]))],
      pendingUser: pending,
    });
    expect(built).toHaveLength(1);
    const text = joined(built)[0]?.text ?? '';
    expect(text.indexOf('empty-final')).toBeLessThan(text.indexOf('1. write_file — ok'));
    expect(text.indexOf('1. write_file — ok')).toBeLessThan(text.indexOf('next'));
  });

  it('includes no receipt, block or notice under memory none', () => {
    const pending = user('now');
    const built = buildTurnMessages(undefined, [user('q1'), assistant('a1'), pending], {
      memory: { type: 'none' },
      completedTurnSpans: [spanOf(0, 2, receipts([record('read_file')], 2))],
      pendingUser: pending,
    });
    expect(joined(built)).toEqual([{ role: 'user', text: 'now' }]);
  });

  it('evaluates window incompleteness over only the selected turns', () => {
    const pending = user('now');
    const messages = [user('old'), assistant('a0'), user('q1'), assistant('a1'), pending];
    const spans = [spanOf(0, 2, OMITTED_RECEIPTS), spanOf(2, 4, receipts([record('read_file')]))];
    const narrow = joined(
      buildTurnMessages(undefined, messages, {
        memory: { type: 'window', window_size: 1 },
        completedTurnSpans: spans,
        pendingUser: pending,
      }),
    );
    expect(narrow[0]?.text).toContain(RECEIPT_NOTICE_LEGEND);
    expect(narrow[0]?.text).not.toContain(RECEIPT_NOTICE_INCOMPLETE);
    expect(narrow[0]?.text).not.toContain('old');
    const wide = joined(
      buildTurnMessages(undefined, messages, {
        memory: { type: 'window', window_size: 2 },
        completedTurnSpans: spans,
        pendingUser: pending,
      }),
    );
    expect(wide[0]?.text).toContain(RECEIPT_NOTICE_INCOMPLETE);
  });

  it.each([{ type: 'summary' as const }, undefined])(
    'follows retained history under %o',
    (memory) => {
      const pending = user('now');
      const built = buildTurnMessages(undefined, [user('q1'), assistant('a1'), pending], {
        ...(memory === undefined ? {} : { memory }),
        completedTurnSpans: [spanOf(0, 2, receipts([record('read_file')]))],
        pendingUser: pending,
      });
      expect(joined(built)[0]?.text).toContain('1. read_file — ok');
    },
  );

  it('owns fresh copies: mutating the request cannot reach the archive or the span metadata', () => {
    const pending = user('now');
    const messages = [user('q1'), assistant('a1'), pending];
    const spans = [spanOf(0, 2, receipts([record('read_file')]))];
    const before = JSON.stringify({ messages, spans });
    const built = buildTurnMessages(undefined, messages, {
      completedTurnSpans: spans,
      pendingUser: pending,
    });
    for (const message of built)
      for (const part of message.content) if (part.type === 'text') part.text = 'MUTATED';
    built[0]?.content.push({ type: 'text', text: 'EXTRA' });
    expect(JSON.stringify({ messages, spans })).toBe(before);
  });
});

describe('summariser input carries the same projection', () => {
  const user = (value: string): LlmMessage => ({
    role: 'user',
    content: [{ type: 'text', text: value }],
  });
  const assistant = (value: string): LlmMessage => ({
    role: 'assistant',
    content: [{ type: 'text', text: value }],
  });
  const render = (message: LlmMessage): string =>
    message.content.map((p) => (p.type === 'text' ? p.text : '')).join('');

  it('appends each turn’s block after its user text, behind one notice, and changes nothing without receipts', () => {
    const foldable = [user('q1'), assistant('a1')];
    expect(render(renderConversationToSummarise(undefined, foldable))).toBe(
      'User: q1\n\nAssistant: a1',
    );
    const out = render(
      renderConversationToSummarise(undefined, foldable, [
        receipts([record('read_file', 'denied')]),
        undefined,
      ]),
    );
    expect(out.startsWith(RECEIPT_NOTICE_LEGEND)).toBe(true);
    expect(out).toContain(`User: q1${block1()}`);
    expect(out.endsWith('Assistant: a1')).toBe(true);
  });

  it('keeps a turn whose user text is empty when it still has records', () => {
    const out = render(
      renderConversationToSummarise(undefined, [user('')], [receipts([record('write_file')])]),
    );
    expect(out).toContain('User: \n\n');
    expect(out).toContain('1. write_file — ok');
  });

  function block1(): string {
    return `\n\n${RECEIPT_BLOCK_OPENING}\n1. read_file — denied\n${RECEIPT_BLOCK_CLOSING}`;
  }
});

describe('oversized-message summarisation never clips a record', () => {
  // A fake measurement: the "request" is the rendered text and it fits when it is short enough.
  const prepare = (message: LlmMessage): PreparedAgentTurnRequest =>
    ({
      text: message.content.map((p) => (p.type === 'text' ? p.text : '')).join(''),
    }) as unknown as PreparedAgentTurnRequest;
  const run = (limit: number, withReceipts = true) => {
    const huge: LlmMessage = {
      role: 'user',
      content: [{ type: 'text', text: 'x'.repeat(10_000) }],
    };
    const chunk = prepareCompactionChunk(
      [huge],
      0,
      undefined,
      prepare,
      (prepared) => (prepared as unknown as { text: string }).text.length <= limit,
      withReceipts ? [receipts([record('read_file'), record('write_file', 'error')])] : undefined,
    );
    return (chunk.prepared as unknown as { text: string }).text;
  };

  it('truncates only the message text and keeps every record whole beside it', () => {
    const out = run(1_400);
    expect(out.length).toBeLessThanOrEqual(1_400);
    expect(out).toMatch(/\[engine: omitted \d+ character\(s\) from this message\]/);
    expect(out).toContain('\n1. read_file — ok\n2. write_file — error\n');
    expect(out).toContain(RECEIPT_BLOCK_CLOSING);
    // The text is clipped, never the records: no line of the block is cut short.
    for (const line of out.split('\n').filter((l) => /^\d+\. /.test(l)))
      expect(line).toMatch(/^\d+\. [a-z_]+ — (ok|error|denied|cancelled)$/);
  });

  it('drops the message’s receipts whole, disclosed by the notice, before it fails to fit', () => {
    const out = run(330);
    expect(out.length).toBeLessThanOrEqual(330);
    expect(out).not.toContain('read_file');
    expect(out).not.toContain(RECEIPT_BLOCK_OPENING);
    expect(out).toContain(RECEIPT_NOTICE_INCOMPLETE);
  });

  it('keeps the existing does-not-fit failure when even the empty message cannot fit', () => {
    expect(() => run(40)).toThrowError(/do not fit/);
  });

  it('is unchanged for a message without receipts', () => {
    const out = run(1_400, false);
    expect(out).not.toContain(RECEIPT_NOTICE_LEGEND);
    expect(out).not.toContain(RECEIPT_NOTICE_INCOMPLETE);
  });
});
