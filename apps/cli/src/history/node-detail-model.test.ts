import type { StepDetailRecord, StepSummaryRecord } from '@relavium/db';
import type { RunEvent } from '@relavium/shared';
import { describe, expect, it } from 'vitest';

import {
  MAX_TIMELINE_ROWS,
  OUTPUT_PREVIEW_MAX_CHARS,
  OUTPUT_PREVIEW_MAX_LINES,
  boundText,
  buildNodeDetailModel,
  buildOutputPreview,
} from './node-detail-model.js';
import { NOT_RECORDED } from './run-detail-model.js';

const RUN_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const T = '2026-11-22T10:00:00.000Z';
const base = (sequenceNumber: number) => ({ runId: RUN_ID, timestamp: T, sequenceNumber });

const coverageStarted = (sequenceNumber: number): RunEvent => ({
  type: 'cost:coverage_started',
  ...base(sequenceNumber),
  basis: 'complete',
});
const started = (sequenceNumber: number, nodeId: string, attemptNumber?: number): RunEvent => ({
  type: 'node:started',
  ...base(sequenceNumber),
  nodeId,
  nodeType: 'agent',
  ...(attemptNumber === undefined ? {} : { attemptNumber }),
});
const settled = (
  sequenceNumber: number,
  nodeId: string,
  costMicrocents: number,
  options: {
    readonly model?: string;
    readonly attemptNumber?: number;
    readonly priced?: boolean;
  } = {},
): RunEvent => ({
  type: 'cost:attempt_settled',
  ...base(sequenceNumber),
  nodeId,
  model: options.model ?? 'model-a',
  attemptNumber: options.attemptNumber ?? 1,
  inputTokens: 1,
  outputTokens: 1,
  costMicrocents,
  cumulativeCostMicrocents: costMicrocents,
  priced: options.priced ?? true,
});
const completed = (sequenceNumber: number, nodeId: string): RunEvent => ({
  type: 'node:completed',
  ...base(sequenceNumber),
  nodeId,
  output: 'ok',
  tokensUsed: { input: 1, output: 1 },
  durationMs: 1500,
  toolActivity: [{ toolId: 'read_file', ok: true, durationMs: 4 }],
});
const retrying = (sequenceNumber: number, nodeId: string, attemptNumber: number): RunEvent => ({
  type: 'node:retrying',
  ...base(sequenceNumber),
  nodeId,
  attemptNumber,
  error: { code: 'tool_failed', message: 'boom', retryable: true },
  delayMs: 2000,
});

function stepSummary(overrides: Partial<StepSummaryRecord> = {}): StepSummaryRecord {
  return {
    nodeId: 'x',
    nodeType: 'agent',
    status: 'completed',
    attemptNumber: 1,
    costMicrocents: 0,
    inputTokens: 1,
    outputTokens: 2,
    ...overrides,
  };
}

function stepDetail(overrides: Partial<StepDetailRecord> = {}): StepDetailRecord {
  return { ...stepSummary({ attemptNumber: 2, durationMs: 1500 }), cachedTokens: 0, ...overrides };
}

/** A node `x` that retried once; its settled rows carry within-chain attempt numbers that reset (1, 2, then 1). */
const retriedNode: RunEvent[] = [
  coverageStarted(0),
  started(1, 'x', 1),
  settled(2, 'x', 1_000_000, { attemptNumber: 1, model: 'primary' }),
  settled(3, 'x', 2_000_000, { attemptNumber: 2, model: 'fallback' }),
  retrying(4, 'x', 1),
  started(5, 'x', 2),
  settled(6, 'x', 4_000_000, { attemptNumber: 1, model: 'primary' }),
  completed(7, 'x'),
];

describe('boundText', () => {
  it('keeps exactly the line bound and cuts the next line, saying so', () => {
    const exact = Array.from({ length: OUTPUT_PREVIEW_MAX_LINES }, (_, i) => `line ${i}`).join(
      '\n',
    );
    expect(boundText(exact)).toMatchObject({ truncated: false, lines: OUTPUT_PREVIEW_MAX_LINES });
    expect(boundText(exact).text).toBe(exact);

    const over = `${exact}\nextra`;
    const cut = boundText(over);
    expect(cut).toMatchObject({ truncated: true, lines: OUTPUT_PREVIEW_MAX_LINES });
    expect(cut.text).toBe(exact);
  });

  it('keeps exactly the character bound and cuts the next character, saying so', () => {
    const exact = 'a'.repeat(OUTPUT_PREVIEW_MAX_CHARS);
    expect(boundText(exact)).toMatchObject({
      truncated: false,
      chars: OUTPUT_PREVIEW_MAX_CHARS,
      lines: 1,
    });
    const cut = boundText(`${exact}b`);
    expect(cut).toMatchObject({ truncated: true, chars: OUTPUT_PREVIEW_MAX_CHARS });
    expect(cut.text).toBe(exact);
  });

  it('counts a line break as one character toward the character bound', () => {
    const cut = boundText('ab\ncd', 40, 3);
    expect(cut).toMatchObject({ text: 'ab\n', truncated: true, chars: 3, lines: 2 });
  });

  it('counts code points, never splitting a surrogate pair', () => {
    const cut = boundText('\u{1F600}'.repeat(5), 40, 3);
    expect(cut.text).toBe('\u{1F600}'.repeat(3));
    expect(cut).toMatchObject({ truncated: true, chars: 3 });
  });

  it('does not count final newlines as lines or as a reason to cut', () => {
    expect(boundText('a\nb\n\n\n', 2, 100)).toMatchObject({
      text: 'a\nb',
      truncated: false,
      lines: 2,
    });
    expect(boundText('\n\n')).toEqual({ text: '', truncated: false, lines: 0, chars: 0 });
    expect(boundText('')).toEqual({ text: '', truncated: false, lines: 0, chars: 0 });
  });

  it('walks only as far as the bound, so a very large value costs a bound, not its length', () => {
    const started = performance.now();
    const cut = boundText('x'.repeat(50_000_000));
    expect(cut).toMatchObject({ truncated: true, chars: OUTPUT_PREVIEW_MAX_CHARS });
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe('buildOutputPreview', () => {
  it('shows a string output as itself, keeping its own line breaks', () => {
    expect(buildOutputPreview(JSON.stringify('first\nsecond'))).toEqual({
      text: 'first\nsecond',
      truncated: false,
      lines: 2,
      chars: 12,
      masked: false,
    });
  });

  it('shows any other output as indented JSON', () => {
    const preview = buildOutputPreview(JSON.stringify({ a: [1, 2], b: 'x' }));
    expect(preview.text).toBe(JSON.stringify({ a: [1, 2], b: 'x' }, null, 2));
    expect(preview.masked).toBe(false);
  });

  it('masks a secret in a string leaf and in a key, before it can be bounded away from its context', () => {
    const secret = `sk-ant-api03-${'A'.repeat(40)}`;
    const leaf = buildOutputPreview(JSON.stringify({ note: `the key is ${secret}` }));
    expect(leaf.text).not.toContain('sk-ant-api03');
    expect(leaf.masked).toBe(true);
    const key = buildOutputPreview(JSON.stringify({ [secret]: 'value' }));
    expect(key.text).not.toContain('sk-ant-api03');
    expect(key.masked).toBe(true);
    const plain = buildOutputPreview(JSON.stringify(secret));
    expect(plain.text).not.toContain('sk-ant-api03');
    expect(plain.masked).toBe(true);
  });

  it('masks a secret that follows a line break inside a leaf, which a pass over the escaped JSON text would miss', () => {
    // `JSON.stringify` turns the line break into the two characters `\n`, so the key has no word boundary left
    // for a scrubber that only reads the serialized whole; each leaf is therefore scrubbed on its own first.
    const secret = `sk-ant-api03-${'C'.repeat(40)}`;
    const preview = buildOutputPreview(JSON.stringify({ note: `first line\n${secret}` }));
    expect(preview.text).not.toContain('sk-ant-api03');
    expect(preview.masked).toBe(true);
  });

  it('strips terminal controls but keeps line breaks', () => {
    const preview = buildOutputPreview(JSON.stringify('a\u001b[2Jb\nc\u0007d'));
    expect(preview.text).toBe('ab\ncd');
  });

  it('bounds a long output at the line and character bounds and flags it', () => {
    const many = buildOutputPreview(
      JSON.stringify(Array.from({ length: 200 }, (_, i) => `row ${i}`).join('\n')),
    );
    expect(many).toMatchObject({ truncated: true, lines: OUTPUT_PREVIEW_MAX_LINES });
    const long = buildOutputPreview(JSON.stringify('y'.repeat(10_000)));
    expect(long).toMatchObject({ truncated: true, chars: OUTPUT_PREVIEW_MAX_CHARS });
  });

  it('says so, and does not throw, for a document it cannot read', () => {
    expect(buildOutputPreview('{not json')).toMatchObject({
      text: '[the stored output could not be read]',
      masked: false,
    });
  });
});

describe('buildNodeDetailModel', () => {
  it('groups each attempt`s cost by the node:started boundaries even though the settled rows` own attempt numbers reset', () => {
    const model = buildNodeDetailModel({
      detail: stepDetail(),
      attempts: [
        stepSummary({ attemptNumber: 1, status: 'failed' }),
        stepSummary({ attemptNumber: 2 }),
      ],
      events: retriedNode,
    });
    expect(
      model.attempts.map((attempt) => [attempt.attempt, attempt.status, attempt.cost.text]),
    ).toEqual([
      [1, 'failed', '$0.0300'],
      [2, 'completed', '$0.0400'],
    ]);
    expect(model.attempts[0]?.cost).toMatchObject({ source: 'attempts', microcents: 3_000_000 });
    expect(model.attempts[1]?.cost).toMatchObject({ source: 'attempts', microcents: 4_000_000 });
    // The node total is the sum of both attempts.
    expect(model.cost).toMatchObject({
      source: 'attempts',
      microcents: 7_000_000,
      approximate: false,
    });
  });

  it('says `not recorded` for an attempt the log holds no settled call for, and keeps the node boundary cost', () => {
    const model = buildNodeDetailModel({
      detail: stepDetail({ attemptNumber: 1, costMicrocents: 5_000_000 }),
      attempts: [stepSummary({ attemptNumber: 1, costMicrocents: 5_000_000 })],
      events: [coverageStarted(0), started(1, 'x')],
    });
    expect(model.attempts[0]?.cost).toEqual({
      source: 'none',
      approximate: false,
      unpricedCalls: 0,
      text: NOT_RECORDED,
    });
    expect(model.cost).toMatchObject({ source: 'boundary', approximate: true, text: '~$0.0500' });
  });

  it('lists the models the node actually ran on, distinct, in first-use order, sanitized', () => {
    const model = buildNodeDetailModel({
      detail: stepDetail(),
      attempts: [],
      events: [
        started(1, 'x', 1),
        settled(2, 'x', 1, { model: 'fallback\u001b[31m' }),
        settled(3, 'x', 1, { model: 'primary' }),
        settled(4, 'x', 1, { model: 'fallback\u001b[31m' }),
        settled(5, 'other', 1, { model: 'unrelated' }),
      ],
    });
    expect(model.modelsUsed).toEqual(['fallback', 'primary']);
  });

  it('keeps the authored agent and model apart from the models used, and sanitizes them', () => {
    const model = buildNodeDetailModel({
      detail: stepDetail(),
      attempts: [],
      events: retriedNode,
      authored: { agentSlug: 'writer\nagent', model: 'planned-model\u001b[0m' },
    });
    expect(model.authored).toEqual({ agent: 'writer agent', model: 'planned-model' });
    expect(model.modelsUsed).toEqual(['primary', 'fallback']);
    expect(
      buildNodeDetailModel({ detail: stepDetail(), attempts: [], events: [] }).authored,
    ).toEqual({});
  });

  it('shows the error sanitized and scrubbed, and the output as a bounded preview', () => {
    const model = buildNodeDetailModel({
      detail: stepDetail({
        status: 'failed',
        errorJson: JSON.stringify({
          code: 'tool_failed',
          message: `denied\u001b[31m\nkey sk-ant-api03-${'B'.repeat(40)}`,
        }),
        outputJson: JSON.stringify('partial\noutput'),
      }),
      attempts: [],
      events: [],
    });
    expect(model.error?.code).toBe('tool_failed');
    expect(model.error?.message).not.toContain('\u001b');
    expect(model.error?.message).not.toContain('\n');
    expect(model.error?.message).not.toContain('sk-ant-api03');
    expect(model.outputPreview?.text).toBe('partial\noutput');
  });

  it('has no error and no preview when the attempt recorded neither', () => {
    const model = buildNodeDetailModel({ detail: stepDetail(), attempts: [], events: [] });
    expect(model.error).toBeUndefined();
    expect(model.outputPreview).toBeUndefined();
  });

  it('carries the inspected attempt`s status, duration, tokens and cached tokens', () => {
    const model = buildNodeDetailModel({
      detail: stepDetail({ cachedTokens: 7, inputTokens: 11, outputTokens: 22 }),
      attempts: [],
      events: [],
    });
    expect(model).toMatchObject({
      status: 'completed',
      glyph: '✓',
      attemptNumber: 2,
      durationMs: 1500,
      durationText: '1.5s',
      tokens: { input: 11, output: 22, cached: 7 },
    });
  });

  it('shows an attempt row left running under a finished run as stopped, and as running otherwise', () => {
    const detail = stepDetail({ status: 'running' });
    expect(
      buildNodeDetailModel({ detail, attempts: [], events: [], runFinished: true }).status,
    ).toBe('stopped');
    expect(buildNodeDetailModel({ detail, attempts: [], events: [] }).status).toBe('running');
  });

  it('shows the tool activity of the node`s last terminal event', () => {
    const model = buildNodeDetailModel({ detail: stepDetail(), attempts: [], events: retriedNode });
    expect(model.toolActivity).toMatchObject({
      recorded: true,
      entries: [{ toolId: 'read_file', ok: true, durationMs: 4, outcome: 'ok' }],
    });
    expect(
      buildNodeDetailModel({ detail: stepDetail(), attempts: [], events: [started(1, 'x')] })
        .toolActivity,
    ).toEqual({ recorded: false, text: NOT_RECORDED });
  });

  it('builds the timeline from this node`s durable events only, in sequence order, with no invented Scheduled row', () => {
    const model = buildNodeDetailModel({
      detail: stepDetail(),
      attempts: [],
      events: [
        // Out of order on purpose, and another node's event in the middle.
        completed(7, 'x'),
        started(1, 'x', 1),
        started(3, 'other'),
        settled(2, 'x', 1_000_000, { model: 'primary' }),
        retrying(4, 'x', 1),
        started(5, 'x', 2),
        settled(6, 'x', 0, { model: 'free-ish', priced: false }),
      ],
    });
    expect(model.timeline.map((row) => [row.sequenceNumber, row.label, row.detail])).toEqual([
      [1, 'Started', 'attempt 1'],
      [2, 'Model call settled', 'primary · $0.0100'],
      [4, 'Retrying', 'attempt 1 failed (tool_failed); next in 2.0s'],
      [5, 'Started', 'attempt 2'],
      [6, 'Model call settled', 'free-ish · price unknown'],
      [7, 'Completed', '1.5s'],
    ]);
    expect(model.timeline.some((row) => /schedul/i.test(row.label))).toBe(false);
    expect(model.timelineOmitted).toBe(0);
  });

  it('bounds the timeline and counts what it left out', () => {
    const events: RunEvent[] = [started(0, 'x')];
    for (let i = 1; i <= MAX_TIMELINE_ROWS + 25; i++) events.push(settled(i, 'x', 1));
    const model = buildNodeDetailModel({ detail: stepDetail(), attempts: [], events });
    expect(model.timeline).toHaveLength(MAX_TIMELINE_ROWS);
    expect(model.timelineOmitted).toBe(26);
  });

  it('sanitizes the node id and type it labels the page with', () => {
    const model = buildNodeDetailModel({
      detail: stepDetail({ nodeId: 'bad\u001b[2J\nid', nodeType: 'agent\u001b[0m' }),
      attempts: [],
      events: [],
    });
    expect(model.label).toBe('bad id');
    expect(model.nodeType).toBe('agent');
    expect(model.nodeId).toBe('bad\u001b[2J\nid');
  });
});
