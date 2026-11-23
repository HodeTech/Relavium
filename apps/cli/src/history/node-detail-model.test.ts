import type { StepDetailRecord, StepSummaryRecord } from '@relavium/db';
import type { RunEvent, ToolActivityEntry } from '@relavium/shared';
import * as scrubModule from '@relavium/llm/scrub-secrets';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { formatRunOutputs } from '../render/run-outputs.js';
import {
  MAX_KEY_SCRUB_CHARS,
  MAX_STORED_OUTPUT_BYTES,
  MAX_TIMELINE_ROWS,
  OUTPUT_PREVIEW_MAX_CHARS,
  OUTPUT_PREVIEW_MAX_LINES,
  boundText,
  buildNodeDetailModel,
  buildOutputPreview,
} from './node-detail-model.js';
import {
  DID_NOT_FINISH,
  DID_NOT_RUN,
  IN_PROGRESS,
  MAX_IDENTIFIER_CHARS,
  NOT_RECORDED,
  NOT_RECORDED_FOR_ATTEMPT,
  NOT_RECORDED_OLDER_LOG,
  SCRUB_INPUT_CHARS,
} from './run-detail-model.js';

// The real scrubber, counted: the walk's cost is the number of strings it hands the scrubber, so a test can say
// "the walk stopped" by how many it saw.
vi.mock('@relavium/llm/scrub-secrets', async (importOriginal) => {
  const actual = await importOriginal<typeof scrubModule>();
  return { ...actual, scrubSecrets: vi.fn(actual.scrubSecrets) };
});
const scrubCalls = (): number => vi.mocked(scrubModule.scrubSecrets).mock.calls.length;
/** The `model-N` names of every string handed to the scrubber since the mock was last cleared. */
const scrubbedModelNames = (): Set<string> => {
  const names = new Set<string>();
  for (const [text] of vi.mocked(scrubModule.scrubSecrets).mock.calls) {
    for (const match of text.matchAll(/model-\d+/gu)) names.add(match[0]);
  }
  return names;
};

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
    readonly inputTokens?: number;
    readonly outputTokens?: number;
  } = {},
): RunEvent => ({
  type: 'cost:attempt_settled',
  ...base(sequenceNumber),
  nodeId,
  model: options.model ?? 'model-a',
  attemptNumber: options.attemptNumber ?? 1,
  inputTokens: options.inputTokens ?? 1,
  outputTokens: options.outputTokens ?? 1,
  costMicrocents,
  cumulativeCostMicrocents: costMicrocents,
  priced: options.priced ?? true,
});
const completed = (sequenceNumber: number, nodeId: string, attemptNumber?: number): RunEvent => ({
  type: 'node:completed',
  ...base(sequenceNumber),
  nodeId,
  output: 'ok',
  tokensUsed: { input: 1, output: 1 },
  durationMs: 1500,
  ...(attemptNumber === undefined ? {} : { attemptNumber }),
  toolActivity: [{ toolId: 'read_file', ok: true, resultRecorded: true, durationMs: 4 }],
});
/** A node terminal in the shape of a log written before `toolActivity` existed, or with the given trace. */
const completedWithTrace = (
  sequenceNumber: number,
  nodeId: string,
  toolActivity?: ToolActivityEntry[],
): RunEvent => ({
  type: 'node:completed',
  ...base(sequenceNumber),
  nodeId,
  output: 'ok',
  tokensUsed: { input: 1, output: 1 },
  durationMs: 1500,
  ...(toolActivity === undefined ? {} : { toolActivity }),
});
const retrying = (sequenceNumber: number, nodeId: string, attemptNumber: number): RunEvent => ({
  type: 'node:retrying',
  ...base(sequenceNumber),
  nodeId,
  attemptNumber,
  error: { code: 'tool_failed', message: 'boom', retryable: true },
  delayMs: 2000,
});

/**
 * An event as a damaged or foreign `history.db` row could hand it to the model: the shape of `event` with the fields
 * of `patch` laid over it, whatever type they are. Typed as the intersection, so no cast is needed.
 */
function forged<T extends RunEvent, P extends object>(event: T, patch: P): T & P {
  return Object.assign({}, event, patch);
}

// A URL whose userinfo password is the secret. A cut that falls inside it, made BEFORE the scrubber reads the text,
// leaves a password prefix with no `@host` after it, which the scrubber no longer recognizes.
const USERINFO_URL = 'postgres://app:S3cr3tPassw0rdValue@db.internal';

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
  return {
    ...stepSummary({ attemptNumber: 2, durationMs: 1500 }),
    cachedTokens: 0,
    outputJson: null,
    outputByteLength: null,
    errorJson: null,
    errorByteLength: null,
    ...overrides,
  };
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
  completed(7, 'x', 2),
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

describe('buildOutputPreview: the cost is a bound, not the stored document', () => {
  beforeEach(() => {
    vi.mocked(scrubModule.scrubSecrets).mockClear();
  });

  it('refuses a stored document above the size bound with a fixed sentence, without parsing it', () => {
    const eightMiB = JSON.stringify('x'.repeat(8 * 1024 * 1024 - 2));
    expect(Buffer.byteLength(eightMiB)).toBe(8 * 1024 * 1024);
    const parse = vi.spyOn(JSON, 'parse');
    try {
      const started = performance.now();
      const preview = buildOutputPreview(eightMiB);
      expect(preview.text).toBe('output too large to preview (8388608 bytes)');
      expect(preview).toMatchObject({ truncated: false, masked: false, lines: 1 });
      expect(parse).not.toHaveBeenCalled();
      expect(scrubCalls()).toBe(0);
      expect(performance.now() - started).toBeLessThan(500);
    } finally {
      parse.mockRestore();
    }
  });

  it('puts the line at exactly 1 MiB: that many bytes is read, one byte more is refused', () => {
    expect(MAX_STORED_OUTPUT_BYTES).toBe(1_048_576);
    const atBound = JSON.stringify('y'.repeat(MAX_STORED_OUTPUT_BYTES - 2));
    expect(Buffer.byteLength(atBound)).toBe(MAX_STORED_OUTPUT_BYTES);
    expect(buildOutputPreview(atBound)).toMatchObject({ truncated: true, chars: 4000 });
    expect(buildOutputPreview(atBound).text).toBe('y'.repeat(4000));
    const over = JSON.stringify('y'.repeat(MAX_STORED_OUTPUT_BYTES - 1));
    expect(buildOutputPreview(over).text).toBe(
      `output too large to preview (${MAX_STORED_OUTPUT_BYTES + 1} bytes)`,
    );
  });

  it('counts bytes, not characters: a document of multi-byte text over the bound is refused', () => {
    const wide = JSON.stringify('\u20ac'.repeat(400_000)); // 3 bytes each, 400,000 characters
    expect(wide.length).toBeLessThan(MAX_STORED_OUTPUT_BYTES);
    expect(buildOutputPreview(wide).text).toMatch(/^output too large to preview \(\d+ bytes\)$/u);
  });

  it('previews a large document under the bound, bounded, and quickly', () => {
    const rows = Array.from({ length: 30_000 }, (_, index) => ({ n: index, text: `row ${index}` }));
    const stored = JSON.stringify(rows);
    expect(Buffer.byteLength(stored)).toBeGreaterThan(500_000);
    expect(Buffer.byteLength(stored)).toBeLessThan(MAX_STORED_OUTPUT_BYTES);
    const started = performance.now();
    const preview = buildOutputPreview(stored);
    expect(performance.now() - started).toBeLessThan(500);
    expect(preview).toMatchObject({ truncated: true, lines: OUTPUT_PREVIEW_MAX_LINES });
    // The preview is the head of what a full pretty-print would show, cut at the line bound.
    expect(preview.text).toBe(
      JSON.stringify(rows, null, 2).split('\n').slice(0, OUTPUT_PREVIEW_MAX_LINES).join('\n'),
    );
  });

  it('stops walking once the preview is full: a first leaf that fills the bound means the rest is never visited', () => {
    const doc = {
      first: 'x'.repeat(10_000),
      rest: Array.from({ length: 5_000 }, (_, index) => `leaf ${index}`),
    };
    const preview = buildOutputPreview(JSON.stringify(doc));
    expect(preview).toMatchObject({ truncated: true, chars: OUTPUT_PREVIEW_MAX_CHARS });
    // The key `first`, the one leaf and the whole-text pass — not one call per leaf of `rest`.
    expect(scrubCalls()).toBeLessThan(10);
  });

  it('stops walking at the line bound too, when every leaf is short', () => {
    const preview = buildOutputPreview(
      JSON.stringify(Array.from({ length: 5_000 }, (_, index) => `leaf ${index}`)),
    );
    expect(preview).toMatchObject({ truncated: true, lines: OUTPUT_PREVIEW_MAX_LINES });
    expect(scrubCalls()).toBeLessThan(OUTPUT_PREVIEW_MAX_LINES + 10);
  });

  it('writes what it shows exactly as an indented JSON dump would, for every shape that fits', () => {
    const shapes: unknown[] = [
      { a: [1, 2], b: 'x', c: null, d: true, e: {}, f: [], g: { h: [{}, [], [[]]] } },
      [],
      {},
      [[[]], {}],
      42,
      null,
      false,
      { '': '', 'k "quoted"': 'line\nbreak', unicode: '\u20ac\u{1F600}' },
    ];
    for (const shape of shapes) {
      const preview = buildOutputPreview(JSON.stringify(shape));
      expect(preview.text).toBe(JSON.stringify(shape, null, 2));
      expect(preview.truncated).toBe(false);
    }
  });

  it('keeps an own `__proto__` member (it is only written, never assigned)', () => {
    const preview = buildOutputPreview('{"__proto__": {"polluted": 1}, "b": 2}');
    expect(preview.text).toBe('{\n  "__proto__": {\n    "polluted": 1\n  },\n  "b": 2\n}');
  });

  it('scrubs a long object key WHOLE and only then cuts it, and marks the cut', () => {
    const key = 'k'.repeat(MAX_KEY_SCRUB_CHARS + 500);
    const preview = buildOutputPreview(JSON.stringify({ [key]: 1 }));
    expect(preview.text).toBe(`{\n  "${'k'.repeat(MAX_KEY_SCRUB_CHARS)}…": 1\n}`);
    // The scrubber was handed the whole key every time it read the bare key, never a cut one.
    const bareKeyLengths = vi
      .mocked(scrubModule.scrubSecrets)
      .mock.calls.map(([text]) => text)
      .filter((text) => /^k+$/u.test(text))
      .map((text) => text.length);
    expect(bareKeyLengths.length).toBeGreaterThan(0);
    expect(new Set(bareKeyLengths)).toEqual(new Set([key.length]));
    // A key exactly at the bound is kept whole.
    const exact = 'e'.repeat(MAX_KEY_SCRUB_CHARS);
    expect(buildOutputPreview(JSON.stringify({ [exact]: 1 })).text).toBe(`{\n  "${exact}": 1\n}`);
  });

  it('still masks a secret-shaped key and a secret-shaped value that sit under the cap, in a document it stops early', () => {
    const secret = `sk-ant-api03-${'D'.repeat(40)}`;
    const preview = buildOutputPreview(
      JSON.stringify({
        [secret]: 'value',
        note: `held ${secret}`,
        filler: Array.from({ length: 2_000 }, (_, index) => `f${index}`),
      }),
    );
    expect(preview.text).not.toContain('sk-ant-api03');
    expect(preview.masked).toBe(true);
    expect(preview.truncated).toBe(true);
    expect(preview.text).toContain('"note": "held ');
  });

  it('says truncated when the walk stopped early, even if the whole-text pass then left the shown text under the bound', async () => {
    // The first leaf alone fills the character bound, so the walk stops and never writes `b`. The whole-text pass
    // is made to mask everything it is handed (only the pretty-printed whole carries a line break before a key),
    // leaving a short text that no bound would cut: the cut is still said.
    const real = await vi.importActual<typeof scrubModule>('@relavium/llm/scrub-secrets');
    vi.mocked(scrubModule.scrubSecrets).mockImplementation((text) =>
      text.includes('\n  "first"') ? '[REDACTED]' : real.scrubSecrets(text),
    );
    try {
      const preview = buildOutputPreview(JSON.stringify({ first: 'a'.repeat(4_500), b: 1 }));
      expect(preview.masked).toBe(true);
      expect(preview.text).toBe('[REDACTED]');
      expect(preview.chars).toBeLessThan(OUTPUT_PREVIEW_MAX_CHARS);
      expect(preview.truncated).toBe(true);
    } finally {
      vi.mocked(scrubModule.scrubSecrets).mockImplementation(real.scrubSecrets);
    }
  });
});

describe('buildOutputPreview: the scrubber reads the text whole, and only then is it cut', () => {
  it('masks a URL password in an object key that a 256-cut would have split', () => {
    const key = `${'f'.repeat(MAX_KEY_SCRUB_CHARS - 30)}${USERINFO_URL}`;
    const preview = buildOutputPreview(JSON.stringify({ [key]: 1 }));
    expect(preview.text).not.toContain('S3cr3t');
    expect(preview.masked).toBe(true);
    // Still cut at the key bound, with the marker.
    expect(preview.text).toContain('…": 1');
  });

  it('masks a URL password in a top-level string that a 32768-cut would have split, behind controls the page strips', () => {
    // BELs are stripped from the shown text, so the cut point is far past the 4,000 characters a page shows;
    // only the scrub-then-cut order keeps the password prefix (which the strip pulls into view) out of it.
    const cut = 32_768;
    const text = `${'\u0007'.repeat(cut - 30)}${USERINFO_URL}`;
    const preview = buildOutputPreview(JSON.stringify(text));
    expect(preview.text).not.toContain('S3cr3t');
    expect(preview.text).toContain('postgres://');
    expect(preview.masked).toBe(true);
    expect(preview.truncated).toBe(true);
  });

  it('masks a URL password in a nested string leaf that a 32768-cut would have split', () => {
    const text = `${'\u0007'.repeat(32_768 - 30)}${USERINFO_URL}`;
    const preview = buildOutputPreview(JSON.stringify({ note: text }));
    expect(preview.text).not.toContain('S3cr3t');
    expect(preview.masked).toBe(true);
  });

  it('cuts a top-level string leaf only ABOVE 32,768 code units: exactly that many is kept whole, one more is cut and says so', () => {
    // BELs are stripped from the shown text, so what the page shows is what follows them: the leaf's own cut, not the
    // 4,000-character window, decides whether its last characters survive.
    const cut = 32_768;
    const exactText = `${'\u0007'.repeat(cut - 7)}visible`;
    expect(exactText).toHaveLength(cut);
    const exact = buildOutputPreview(JSON.stringify(exactText));
    expect(exact.text).toBe('visible');
    expect(exact.truncated).toBe(false);

    const overText = `${'\u0007'.repeat(cut - 6)}visible`;
    expect(overText).toHaveLength(cut + 1);
    const over = buildOutputPreview(JSON.stringify(overText));
    expect(over.text).toBe('visibl');
    expect(over.truncated).toBe(true);
  });
});

describe('buildOutputPreview: a member whose NAME labels a credential has its value masked (the final summary`s rule)', () => {
  it('masks the value of `?token=` and `x-api-key`, keeps a non-credential key`s value, and says it masked', () => {
    const preview = buildOutputPreview(
      JSON.stringify({
        '?token=': 'opaqueSECRETvalue',
        'x-api-key': 'opaqueOTHERvalue',
        title: 'plain text',
      }),
    );
    expect(preview.text).not.toContain('opaqueSECRETvalue');
    expect(preview.text).not.toContain('opaqueOTHERvalue');
    expect(preview.text).toContain('"title": "plain text"');
    expect(preview.masked).toBe(true);
  });

  it('masks it for a member below the top level, and for a non-string value', () => {
    const preview = buildOutputPreview(
      JSON.stringify({
        outer: { '?token=': 'opaqueSECRETvalue', 'x-api-key': 12345, keep: 12345 },
      }),
    );
    expect(preview.text).not.toContain('opaqueSECRETvalue');
    expect(preview.text).toContain('"x-api-key": "[REDACTED]"');
    expect(preview.text).toContain('"keep": 12345');
  });

  it('agrees with the final summary on the same document: both mask the value, both keep a plain key', () => {
    const document = { '?token=': 'opaqueSECRETvalue', title: 'plain text' };
    const shown = formatRunOutputs({ result: document }, '').join('\n');
    expect(shown).not.toContain('opaqueSECRETvalue');
    expect(shown).toContain('plain text');
    const preview = buildOutputPreview(JSON.stringify(document));
    expect(preview.text).not.toContain('opaqueSECRETvalue');
    expect(preview.text).toContain('plain text');
  });

  it('does not take a secret-shaped key for a label: the key is masked and the value stays', () => {
    const secret = `sk-ant-api03-${'D'.repeat(40)}`;
    const preview = buildOutputPreview(JSON.stringify({ [secret]: 'plain value' }));
    expect(preview.text).not.toContain('sk-ant-api03');
    expect(preview.text).toContain('plain value');
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

  it('masks an authored model that is shaped like a key, as it masks a stored one', () => {
    const secret = `sk-ant-api03-${'M'.repeat(40)}`;
    const model = buildNodeDetailModel({
      detail: stepDetail(),
      attempts: [],
      events: [],
      authored: { agentSlug: 'writer', model: `custom/${secret}` },
    });
    expect(model.authored.model).toBeDefined();
    expect(model.authored.model).not.toContain('sk-ant-api03');
    expect(JSON.stringify(model.authored)).not.toContain(secret);
    expect(model.authored.agent).toBe('writer');
  });

  it('masks the value of an output whose node id labels a credential, whole, as the final summary does for the output of that name', () => {
    for (const value of ['opaqueMEMBER', 12_345, true, null]) {
      const model = buildNodeDetailModel({
        detail: stepDetail({ nodeId: 'x-api-key', outputJson: JSON.stringify(value) }),
        attempts: [],
        events: [],
      });
      const summary = formatRunOutputs({ 'x-api-key': value }, '')[1] ?? '';
      expect(model.outputPreview, String(value)).toMatchObject({ masked: true, truncated: false });
      expect(model.outputPreview?.text).not.toContain('opaqueMEMBER');
      // The page shows exactly what the summary shows after `x-api-key: `.
      expect(summary).toBe(`  x-api-key: ${model.outputPreview?.text ?? ''}`);
    }
    // A node whose id labels nothing keeps its value, and an object under a credential-named id is walked member by member.
    const plain = buildNodeDetailModel({
      detail: stepDetail({ nodeId: 'writer', outputJson: JSON.stringify('opaqueMEMBER') }),
      attempts: [],
      events: [],
    });
    expect(plain.outputPreview).toMatchObject({ text: 'opaqueMEMBER', masked: false });
    const object = buildNodeDetailModel({
      detail: stepDetail({
        nodeId: 'x-api-key',
        outputJson: JSON.stringify({ title: 'plain text' }),
      }),
      attempts: [],
      events: [],
    });
    expect(object.outputPreview?.text).toContain('"title": "plain text"');
  });

  it('masks an over-long value under a credential-named node id whole, and does not call it cut', () => {
    const model = buildNodeDetailModel({
      detail: stepDetail({ nodeId: 'x-api-key', outputJson: JSON.stringify('o'.repeat(9_000)) }),
      attempts: [],
      events: [],
    });
    expect(model.outputPreview).toMatchObject({
      text: '[REDACTED]',
      truncated: false,
      masked: true,
    });
  });

  it('says only the size of an output or an error the read refused (null text with a byte length)', () => {
    // The detail read size-gates each document in SQL: an over-bound one arrives as null text and its byte length.
    const model = buildNodeDetailModel({
      detail: stepDetail({
        status: 'failed',
        outputJson: null,
        outputByteLength: 3_000_000,
        errorJson: null,
        errorByteLength: 2_000_000,
      }),
      attempts: [],
      events: [],
    });
    expect(model.outputPreview).toEqual({
      text: 'output too large to preview (3000000 bytes)',
      truncated: false,
      lines: 1,
      chars: 'output too large to preview (3000000 bytes)'.length,
      masked: false,
    });
    expect(model.error).toEqual({ message: 'error record too large to show (2000000 bytes)' });
    // A text that was returned is previewed as text, whatever byte length rides with it.
    const returned = buildNodeDetailModel({
      detail: stepDetail({
        outputJson: JSON.stringify('shown'),
        outputByteLength: 7,
        errorJson: JSON.stringify({ code: 'tool_failed' }),
        errorByteLength: 25,
      }),
      attempts: [],
      events: [],
    });
    expect(returned.outputPreview?.text).toBe('shown');
    expect(returned.error).toEqual({ code: 'tool_failed' });
  });

  it('has no error and no preview when the attempt recorded neither', () => {
    const model = buildNodeDetailModel({ detail: stepDetail(), attempts: [], events: [] });
    expect(model.error).toBeUndefined();
    expect(model.outputPreview).toBeUndefined();
  });

  it('carries the inspected attempt`s status and duration, the node`s tokens, and no cached count (the column is never written)', () => {
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
    });
    // No settled row, and the node completed: the step row's figures. `toEqual` on the whole object: a `cached`
    // key, even `0`, would state "0 cached" as a fact.
    expect(model.tokens).toEqual({ source: 'step', input: 11, output: 22, text: '↑11 ↓22' });
    expect('cached' in model.tokens).toBe(false);
  });

  it('shows the tokens of every settled call of the node beside its cost: a failed node with one billed attempt', () => {
    const model = buildNodeDetailModel({
      // `failStepRow` writes no tokens, so the failed attempt's step row reads 0 / 0.
      detail: stepDetail({ status: 'failed', attemptNumber: 1, inputTokens: 0, outputTokens: 0 }),
      attempts: [],
      events: [
        coverageStarted(0),
        started(1, 'x'),
        settled(2, 'x', 3_000_000, { inputTokens: 120, outputTokens: 45 }),
      ],
    });
    expect(model.tokens).toEqual({ source: 'attempts', input: 120, output: 45, text: '↑120 ↓45' });
    expect(model.cost).toMatchObject({ source: 'attempts', microcents: 3_000_000 });
    expect(model.attempts[0]?.tokens).toEqual(model.tokens);
  });

  it('sums every attempt for the node, keeps each attempt`s own figure, and says `not recorded` for an attempt with none', () => {
    const model = buildNodeDetailModel({
      detail: stepDetail({ attemptNumber: 2, inputTokens: 30, outputTokens: 6 }),
      attempts: [
        stepSummary({ attemptNumber: 1, status: 'failed', inputTokens: 0, outputTokens: 0 }),
        stepSummary({ attemptNumber: 2, inputTokens: 30, outputTokens: 6 }),
      ],
      events: [
        coverageStarted(0),
        started(1, 'x', 1),
        settled(2, 'x', 1_000_000, { inputTokens: 100, outputTokens: 20 }),
        retrying(3, 'x', 1),
        started(4, 'x', 2),
        settled(5, 'x', 2_000_000, { inputTokens: 30, outputTokens: 6 }),
        completed(6, 'x', 2),
      ],
    });
    expect(model.tokens).toEqual({ source: 'attempts', input: 130, output: 26, text: '↑130 ↓26' });
    expect(model.attempts.map((attempt) => attempt.tokens.text)).toEqual(['↑100 ↓20', '↑30 ↓6']);
    // An attempt that failed with no settled call has nothing to show: not ↑0 ↓0.
    const bare = buildNodeDetailModel({
      detail: stepDetail({ status: 'failed', attemptNumber: 1, inputTokens: 0, outputTokens: 0 }),
      attempts: [],
      events: [coverageStarted(0), started(1, 'x')],
    });
    expect(bare.tokens).toEqual({ source: 'none', text: NOT_RECORDED });
    expect(bare.attempts[0]?.tokens).toEqual({ source: 'none', text: NOT_RECORDED });
  });

  it('shows an attempt row left running under a finished run as stopped, and as running otherwise', () => {
    const detail = stepDetail({ status: 'running' });
    expect(
      buildNodeDetailModel({ detail, attempts: [], events: [], runFinished: true }).status,
    ).toBe('stopped');
    expect(buildNodeDetailModel({ detail, attempts: [], events: [] }).status).toBe('running');
  });

  it('shows the tool activity of the terminal that closed the inspected attempt', () => {
    const model = buildNodeDetailModel({ detail: stepDetail(), attempts: [], events: retriedNode });
    expect(model.toolActivity).toMatchObject({
      recorded: true,
      entries: [
        {
          toolId: 'read_file',
          ok: true,
          resultRecorded: true,
          durationMs: 4,
          outcome: 'ok',
          text: 'ok in 4ms',
        },
      ],
    });
    // No terminal event yet: nothing is claimed about the cause.
    expect(
      buildNodeDetailModel({ detail: stepDetail(), attempts: [], events: [started(1, 'x')] })
        .toolActivity,
    ).toEqual({ recorded: false, text: NOT_RECORDED });
    // A terminal with no `toolActivity` field is a log written before the field existed; an empty array is a
    // node that made no tool call.
    const attemptOne = stepDetail({ attemptNumber: 1 });
    expect(
      buildNodeDetailModel({
        detail: attemptOne,
        attempts: [],
        events: [started(1, 'x'), completedWithTrace(2, 'x')],
      }).toolActivity,
    ).toEqual({ recorded: false, text: NOT_RECORDED_OLDER_LOG });
    expect(
      buildNodeDetailModel({
        detail: attemptOne,
        attempts: [],
        events: [started(1, 'x'), completedWithTrace(2, 'x', [])],
      }).toolActivity,
    ).toEqual({ recorded: true, entries: [], truncated: 0, text: 'no tool calls' });
  });

  it('keeps a trace to the attempt its terminal closed: attempt 1 of a node that completed on attempt 2 has none', () => {
    const attempts = [
      stepSummary({ attemptNumber: 1, status: 'failed' }),
      stepSummary({ attemptNumber: 2 }),
    ];
    const forAttempt = (attemptNumber: number) =>
      buildNodeDetailModel({
        detail: stepDetail({ attemptNumber }),
        attempts,
        events: retriedNode,
      }).toolActivity;
    expect(forAttempt(1)).toEqual({ recorded: false, text: NOT_RECORDED_FOR_ATTEMPT });
    expect(forAttempt(2)).toMatchObject({
      recorded: true,
      entries: [{ toolId: 'read_file', outcome: 'ok' }],
    });
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

  it('scrubs the stored text a timeline row shows (an error code, a reason, a decision, a gate type, a modality) whole, then cuts it', () => {
    const secret = `sk-ant-api03-${'T'.repeat(40)}`;
    const text = `bad\u001b[31m ${secret}`;
    const events: RunEvent[] = [
      started(1, 'x'),
      forged(
        {
          type: 'node:retrying',
          ...base(2),
          nodeId: 'x',
          attemptNumber: 1,
          error: { code: 'internal', message: 'boom', retryable: true },
          delayMs: 10,
        },
        { error: { code: text, message: 'boom', retryable: true } },
      ),
      forged(
        {
          type: 'node:failed',
          ...base(3),
          nodeId: 'x',
          error: { code: 'internal', message: 'boom', retryable: false },
        },
        { error: { code: text, message: 'boom', retryable: false } },
      ),
      forged(
        { type: 'node:skipped', ...base(4), nodeId: 'x', reason: 'branch_not_taken' },
        { reason: text },
      ),
      forged(
        {
          type: 'human_gate:paused',
          ...base(5),
          nodeId: 'x',
          gateId: 'g',
          gateType: 'approval',
          message: 'm',
        },
        { gateType: text },
      ),
      forged(
        {
          type: 'human_gate:resumed',
          ...base(6),
          nodeId: 'x',
          decision: 'approved',
          decidedBy: 'cli',
        },
        { decision: text },
      ),
      forged(
        {
          type: 'media_job:submitted',
          ...base(7),
          nodeId: 'x',
          jobId: 'j',
          provider: 'openai',
          model: 'image-model',
          modality: 'image',
          startedAt: T,
          deadlineAt: T,
        },
        { modality: text },
      ),
    ];
    const model = buildNodeDetailModel({ detail: stepDetail(), attempts: [], events });
    const details = model.timeline.map((row) => row.detail ?? '');
    expect(details).toHaveLength(7);
    for (const detail of details.slice(1)) {
      expect(detail).not.toContain('sk-ant-api03');
      expect(detail).not.toContain('\u001b');
      expect(detail).toContain('bad');
    }
    // A plain stored value is unchanged, and a long one is cut to 128 code points after the mask, with the marker.
    const failedWith = (code: string): string | undefined =>
      buildNodeDetailModel({
        detail: stepDetail(),
        attempts: [],
        events: [
          started(1, 'x'),
          forged(
            {
              type: 'node:failed',
              ...base(2),
              nodeId: 'x',
              error: { code: 'internal', message: 'boom', retryable: false },
            },
            { error: { code, message: 'boom', retryable: false } },
          ),
        ],
      }).timeline[1]?.detail;
    expect(failedWith('tool_failed')).toBe('tool_failed');
    expect(failedWith('c'.repeat(300))).toBe(`${'c'.repeat(MAX_IDENTIFIER_CHARS)}…`);
    // A URL password that a cut at 128 would have split is masked before the cut.
    expect(failedWith(`${'c'.repeat(MAX_IDENTIFIER_CHARS - 30)}${USERINFO_URL}`)).not.toContain(
      'S3cr3t',
    );
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
  it('shows a node with settled rows AND a boundary cost by the settled sum, exact, never the boundary figure', () => {
    // The realistic shape: the writer stores the node's boundary cost on the step row AND the log settled calls.
    const model = buildNodeDetailModel({
      detail: stepDetail({ costMicrocents: 9_000_000 }),
      attempts: [stepSummary({ attemptNumber: 1, costMicrocents: 9_000_000 })],
      events: [coverageStarted(0), started(1, 'x'), settled(2, 'x', 3_000_000), completed(3, 'x')],
    });
    expect(model.cost).toMatchObject({
      source: 'attempts',
      microcents: 3_000_000,
      approximate: false,
    });
    expect(model.cost.text).toBe('$0.0300');
    expect(model.cost.text.startsWith('~')).toBe(false);
  });

  it('counts a settled row that precedes every node:started in the node total and its models, but in no attempt', () => {
    const model = buildNodeDetailModel({
      detail: stepDetail({ attemptNumber: 1 }),
      attempts: [stepSummary({ attemptNumber: 1 })],
      events: [
        coverageStarted(0),
        settled(1, 'x', 1_000_000, { model: 'before-start' }),
        started(2, 'x'),
        settled(3, 'x', 2_000_000, { model: 'after-start' }),
        completed(4, 'x'),
      ],
    });
    expect(model.cost).toMatchObject({ source: 'attempts', microcents: 3_000_000 });
    expect(model.modelsUsed).toEqual(['before-start', 'after-start']);
    expect(model.attempts[0]?.cost).toMatchObject({ microcents: 2_000_000 });
  });

  it('cuts each model name and each authored name to 128 characters, and lists at most 20 models', () => {
    const long = 'm'.repeat(MAX_IDENTIFIER_CHARS + 50);
    const events: RunEvent[] = [started(1, 'x')];
    for (let index = 0; index < 30; index++) {
      events.push(settled(2 + index, 'x', 1, { model: `model-${index}` }));
    }
    events.push(settled(40, 'x', 1, { model: long }));
    const model = buildNodeDetailModel({
      detail: stepDetail(),
      attempts: [],
      events,
      authored: { agentSlug: long, model: `${long}\u001b[31m` },
    });
    expect(model.modelsUsed).toHaveLength(20);
    expect(model.modelsUsed[0]).toBe('model-0');
    const clipped = buildNodeDetailModel({
      detail: stepDetail(),
      attempts: [],
      events: [started(1, 'x'), settled(2, 'x', 1, { model: long })],
    });
    expect(clipped.modelsUsed).toEqual([`${'m'.repeat(MAX_IDENTIFIER_CHARS)}…`]);
    expect(model.authored.agent).toBe(`${'m'.repeat(MAX_IDENTIFIER_CHARS)}…`);
    expect(model.authored.model).toBe(`${'m'.repeat(MAX_IDENTIFIER_CHARS)}…`);
  });

  it('clips a stored error code and node id to 128 characters and masks a secret in the code', () => {
    const secret = `sk-ant-api03-${'F'.repeat(40)}`;
    const model = buildNodeDetailModel({
      detail: stepDetail({
        status: 'failed',
        errorJson: JSON.stringify({
          code: `${'c'.repeat(300)}`,
          message: 'boom',
          nodeId: `${'n'.repeat(300)}`,
        }),
      }),
      attempts: [],
      events: [],
    });
    expect(model.error?.code).toBe(`${'c'.repeat(MAX_IDENTIFIER_CHARS)}…`);
    expect(model.error?.nodeId).toBe(`${'n'.repeat(MAX_IDENTIFIER_CHARS)}…`);
    const masked = buildNodeDetailModel({
      detail: stepDetail({
        status: 'failed',
        errorJson: JSON.stringify({ code: `bad ${secret}`, message: 'boom' }),
      }),
      attempts: [],
      events: [],
    });
    expect(masked.error?.code).not.toContain('sk-ant-api03');
  });

  it('falls back to an attempt`s own step row for its tokens when the attempt completed with no settled call (source step)', () => {
    // Two attempts with no settled call at all, both completed (a resume re-dispatch): each attempt row falls back
    // to ITS OWN step row, not to the node's, and a failed attempt's `0` stays "not recorded".
    const model = buildNodeDetailModel({
      detail: stepDetail({ attemptNumber: 1, inputTokens: 7, outputTokens: 3 }),
      attempts: [
        stepSummary({ attemptNumber: 1, inputTokens: 7, outputTokens: 3 }),
        stepSummary({ attemptNumber: 2, inputTokens: 30, outputTokens: 6 }),
      ],
      events: [coverageStarted(0), started(1, 'x', 1), started(2, 'x', 2)],
    });
    expect(model.attempts[0]?.tokens).toEqual({
      source: 'step',
      input: 7,
      output: 3,
      text: '↑7 ↓3',
    });
    expect(model.attempts[1]?.tokens).toEqual({
      source: 'step',
      input: 30,
      output: 6,
      text: '↑30 ↓6',
    });
    const failedFirst = buildNodeDetailModel({
      detail: stepDetail({ attemptNumber: 1 }),
      attempts: [
        stepSummary({ attemptNumber: 1, status: 'failed', inputTokens: 9, outputTokens: 9 }),
        stepSummary({ attemptNumber: 2, inputTokens: 30, outputTokens: 6 }),
      ],
      events: [coverageStarted(0), started(1, 'x', 1), started(2, 'x', 2)],
    });
    expect(failedFirst.attempts[0]?.tokens).toEqual({ source: 'none', text: NOT_RECORDED });
    expect(failedFirst.attempts[1]?.tokens).toMatchObject({ source: 'step', text: '↑30 ↓6' });
  });

  it('judges the whole node by its LAST attempt row, even when the page inspects an earlier attempt', () => {
    // Attempt 1 failed (a failed row carries no tokens) and attempt 2 completed with 30 / 6. The page inspects
    // attempt 1, whose own status is `failed`; the node as a whole COMPLETED, so its tokens come from the step rows.
    const model = buildNodeDetailModel({
      detail: stepDetail({ attemptNumber: 1, status: 'failed', inputTokens: 0, outputTokens: 0 }),
      attempts: [
        stepSummary({ attemptNumber: 1, status: 'failed', inputTokens: 0, outputTokens: 0 }),
        stepSummary({ attemptNumber: 2, inputTokens: 30, outputTokens: 6 }),
      ],
      events: [coverageStarted(0), started(1, 'x', 1), started(2, 'x', 2)],
    });
    expect(model.status).toBe('failed');
    expect(model.tokens).toEqual({ source: 'step', input: 30, output: 6, text: '↑30 ↓6' });
    // ...while the inspected attempt's own row has nothing to show.
    expect(model.attempts[0]?.tokens).toEqual({ source: 'none', text: NOT_RECORDED });
  });

  it('says why an absent figure is absent: did not run, did not finish, in progress, and not recorded for a finished attempt', () => {
    const absent = (
      overrides: Partial<StepDetailRecord>,
      runFinished: boolean,
    ): readonly string[] => {
      const model = buildNodeDetailModel({
        detail: stepDetail({ attemptNumber: 1, inputTokens: 0, outputTokens: 0, ...overrides }),
        attempts: [],
        events: [coverageStarted(0), started(1, 'x', 1)],
        runFinished,
      });
      return [
        model.tokens.text,
        model.cost.text,
        model.toolActivity.text,
        model.attempts[0]?.tokens.text ?? '',
        model.attempts[0]?.cost.text ?? '',
      ];
    };
    expect(absent({ status: 'skipped' }, true)).toEqual(Array(5).fill(DID_NOT_RUN));
    expect(absent({ status: 'running' }, true)).toEqual(Array(5).fill(DID_NOT_FINISH));
    expect(absent({ status: 'running' }, false)).toEqual(Array(5).fill(IN_PROGRESS));
    // A failed attempt (and a completed node with no step figure to show) is genuinely absent.
    expect(absent({ status: 'failed' }, true)).toEqual(Array(5).fill(NOT_RECORDED));
    expect(absent({ status: 'failed' }, false)).toEqual(Array(5).fill(NOT_RECORDED));
  });

  it('gives the whole node the sentence of its last attempt and the inspected attempt the sentence of its own row', () => {
    // Attempt 1 failed (finished); attempt 2 is still running. Inspecting attempt 1: its own row and trace say
    // `not recorded`, the node as a whole is in progress.
    const model = buildNodeDetailModel({
      detail: stepDetail({ attemptNumber: 1, status: 'failed', inputTokens: 0, outputTokens: 0 }),
      attempts: [
        stepSummary({ attemptNumber: 1, status: 'failed', inputTokens: 0, outputTokens: 0 }),
        stepSummary({ attemptNumber: 2, status: 'running', inputTokens: 0, outputTokens: 0 }),
      ],
      events: [coverageStarted(0), started(1, 'x', 1), started(2, 'x', 2)],
    });
    expect(model.tokens).toEqual({ source: 'none', text: IN_PROGRESS });
    expect(model.cost).toMatchObject({ source: 'none', text: IN_PROGRESS });
    expect(model.toolActivity).toEqual({ recorded: false, text: NOT_RECORDED });
    expect(model.attempts.map((attempt) => attempt.tokens.text)).toEqual([
      NOT_RECORDED,
      IN_PROGRESS,
    ]);
    expect(model.attempts.map((attempt) => attempt.cost.text)).toEqual([NOT_RECORDED, IN_PROGRESS]);
  });

  it('does not touch a figure that exists: a stopped attempt with a settled call keeps its tokens and cost', () => {
    const model = buildNodeDetailModel({
      detail: stepDetail({ attemptNumber: 1, status: 'running' }),
      attempts: [],
      events: [
        coverageStarted(0),
        started(1, 'x', 1),
        settled(2, 'x', 3_000_000, { inputTokens: 9, outputTokens: 4 }),
      ],
      runFinished: true,
    });
    expect(model.status).toBe('stopped');
    expect(model.tokens).toMatchObject({ source: 'attempts', text: '↑9 ↓4' });
    expect(model.cost).toMatchObject({ source: 'attempts', microcents: 3_000_000 });
    expect(model.toolActivity).toEqual({ recorded: false, text: DID_NOT_FINISH });
  });

  it('bounds and scrubs the model of a timeline row and of the models list: a name at the scrub bound is clipped, a secret masked, one above it refused', () => {
    const secret = `sk-ant-api03-${'M'.repeat(40)}`;
    const huge = 'm'.repeat(SCRUB_INPUT_CHARS);
    const model = buildNodeDetailModel({
      detail: stepDetail(),
      attempts: [],
      events: [
        started(1, 'x'),
        settled(2, 'x', 1, { model: huge }),
        settled(3, 'x', 1, { model: `leaky ${secret}` }),
      ],
    });
    const rows = model.timeline.filter((row) => row.label === 'Model call settled');
    expect(rows[0]?.detail?.split(' · ')[0]).toBe(`${'m'.repeat(MAX_IDENTIFIER_CHARS)}…`);
    expect(rows[1]?.detail).not.toContain('sk-ant-api03');
    expect(rows[1]?.detail).toContain('leaky');
    // The same field in the models list gets the same treatment (it is the one stored value).
    expect(model.modelsUsed[0]).toBe(`${'m'.repeat(MAX_IDENTIFIER_CHARS)}…`);
    expect(model.modelsUsed[1]).not.toContain('sk-ant-api03');
    // A plain model name and a one-line floor still hold.
    const plain = buildNodeDetailModel({
      detail: stepDetail(),
      attempts: [],
      events: [started(1, 'x'), settled(2, 'x', 1, { model: 'claude\u001b[31m\nmodel' })],
    });
    expect(plain.timeline[1]?.detail?.split(' · ')[0]).toBe('claude model');
    // Above the scrub bound the name is neither scrubbed nor shown in part, in the row and in the list alike.
    const refused = buildNodeDetailModel({
      detail: stepDetail(),
      attempts: [],
      events: [started(1, 'x'), settled(2, 'x', 1, { model: 'm'.repeat(200_000) })],
    });
    expect(refused.timeline[1]?.detail?.split(' · ')[0]).toBe(
      'text too large to show (200000 bytes)',
    );
    expect(refused.modelsUsed).toEqual(['text too large to show (200000 bytes)']);
  });

  it('lists ONE attempt for two step rows under one attempt number, keeps the later row, and counts one row`s tokens', () => {
    // A re-dispatched node (a budget-approved redispatch, a resume of a node left running): two rows, one number, two
    // node:started groups. The attempts list must not show attempt 1 twice, and the step-row fallback must not add the
    // attempt's tokens to themselves.
    const row = (overrides: Partial<StepSummaryRecord> = {}): StepSummaryRecord =>
      stepSummary({ attemptNumber: 1, inputTokens: 7, outputTokens: 3, ...overrides });
    const model = buildNodeDetailModel({
      detail: stepDetail({ attemptNumber: 1, inputTokens: 7, outputTokens: 3 }),
      attempts: [row(), row()],
      events: [coverageStarted(0), started(1, 'x', 1), started(2, 'x', 1)],
    });
    expect(model.attempts.map((attempt) => attempt.attempt)).toEqual([1]);
    expect(model.attempts[0]?.tokens).toEqual({
      source: 'step',
      input: 7,
      output: 3,
      text: '↑7 ↓3',
    });
    // The node's own figure is one row's, not their sum (↑14 ↓6).
    expect(model.tokens).toEqual({ source: 'step', input: 7, output: 3, text: '↑7 ↓3' });

    // The LATER row is the one kept: the first dispatch was left running, the second completed.
    const later = buildNodeDetailModel({
      detail: stepDetail({ attemptNumber: 1 }),
      attempts: [
        row({ status: 'running', inputTokens: 0, outputTokens: 0 }),
        row({ status: 'completed', inputTokens: 9, outputTokens: 4 }),
      ],
      events: [coverageStarted(0), started(1, 'x', 1), started(2, 'x', 1)],
    });
    expect(later.attempts).toHaveLength(1);
    expect(later.attempts[0]).toMatchObject({
      attempt: 1,
      status: 'completed',
      tokens: { source: 'step', input: 9, output: 4 },
    });
  });

  it('reads the node`s boundary cost over every STORED row of an attempt, even one the collapse drops: the earlier row`s figure survives a later row`s zero', () => {
    // A re-dispatch under one attempt number: the earlier row holds the node-wide boundary figure, the later row (the
    // one the attempt keeps) holds the column's default `0`. The figure is read over the stored rows, not the kept one.
    const row = (costMicrocents: number): StepSummaryRecord =>
      stepSummary({ attemptNumber: 1, costMicrocents });
    const model = buildNodeDetailModel({
      detail: stepDetail({ attemptNumber: 1 }),
      attempts: [row(4_000_000), row(0)],
      events: [coverageStarted(0), started(1, 'x', 1), started(2, 'x', 1), completed(3, 'x', 1)],
    });
    expect(model.attempts).toHaveLength(1);
    expect(model.cost).toMatchObject({
      source: 'boundary',
      microcents: 4_000_000,
      approximate: true,
      text: '~$0.0400',
    });
  });

  it('builds the page from capped input: only the first 20 distinct models are scrubbed, however many rows the log holds', () => {
    // 100 node boundaries come first, so the first 100 timeline rows are the node:started rows, which carry no stored
    // text: every model name the page scrubs is one the models list asked for.
    const events: RunEvent[] = [coverageStarted(0)];
    for (let index = 1; index <= MAX_TIMELINE_ROWS; index++) events.push(started(index, 'x', 1));
    for (let index = 0; index < 500; index++) {
      events.push(settled(MAX_TIMELINE_ROWS + 1 + index, 'x', 1, { model: `model-${index}` }));
    }
    vi.mocked(scrubModule.scrubSecrets).mockClear();
    const model = buildNodeDetailModel({ detail: stepDetail(), attempts: [], events });
    expect(model.modelsUsed).toEqual(Array.from({ length: 20 }, (_, index) => `model-${index}`));
    expect(scrubbedModelNames()).toEqual(
      new Set(Array.from({ length: 20 }, (_, index) => `model-${index}`)),
    );
    // The timeline is cut to its bound and counts the rest.
    expect(model.timeline).toHaveLength(MAX_TIMELINE_ROWS);
    expect(model.timelineOmitted).toBe(500);
  });

  it('builds the timeline from capped input: only the rows it shows are scrubbed, and the rest are counted', () => {
    // 500 settled rows with 500 names: the timeline shows the node:started row and the first 99 settled rows, and the
    // models list the first 20 names, which are among them. Nothing else is handed to the scrubber.
    const events: RunEvent[] = [started(1, 'x', 1)];
    for (let index = 0; index < 500; index++) {
      events.push(settled(2 + index, 'x', 1, { model: `model-${index}` }));
    }
    vi.mocked(scrubModule.scrubSecrets).mockClear();
    const model = buildNodeDetailModel({ detail: stepDetail(), attempts: [], events });
    expect(model.timeline).toHaveLength(MAX_TIMELINE_ROWS);
    expect(model.timelineOmitted).toBe(501 - MAX_TIMELINE_ROWS);
    expect(model.timeline[1]?.detail).toBe('model-0 · $0.0000');
    expect(model.timeline.at(-1)?.detail).toBe(`model-${MAX_TIMELINE_ROWS - 2} · $0.0000`);
    expect(scrubbedModelNames()).toEqual(
      new Set(Array.from({ length: MAX_TIMELINE_ROWS - 1 }, (_, index) => `model-${index}`)),
    );
  });

  it('bounds and scrubs the node id and type the page is labelled with', () => {
    const secret = `sk-ant-api03-${'N'.repeat(40)}`;
    const huge = buildNodeDetailModel({
      detail: stepDetail({
        nodeId: 'n'.repeat(SCRUB_INPUT_CHARS),
        nodeType: 't'.repeat(SCRUB_INPUT_CHARS),
      }),
      attempts: [],
      events: [],
    });
    expect(huge.label).toBe(`${'n'.repeat(MAX_IDENTIFIER_CHARS)}…`);
    expect(huge.nodeType).toBe(`${'t'.repeat(MAX_IDENTIFIER_CHARS)}…`);
    // The raw id survives only as the lookup identity.
    expect(huge.nodeId).toHaveLength(SCRUB_INPUT_CHARS);
    // Above the scrub bound a label is neither scrubbed nor shown in part.
    const oversized = buildNodeDetailModel({
      detail: stepDetail({ nodeId: 'n'.repeat(200_000), nodeType: 't'.repeat(200_000) }),
      attempts: [],
      events: [],
    });
    expect(oversized.label).toBe('text too large to show (200000 bytes)');
    expect(oversized.nodeType).toBe('text too large to show (200000 bytes)');
    expect(oversized.nodeId).toHaveLength(200_000);
    const masked = buildNodeDetailModel({
      detail: stepDetail({ nodeId: `node ${secret}`, nodeType: `type ${secret}` }),
      attempts: [],
      events: [],
    });
    expect(masked.label).not.toContain('sk-ant-api03');
    expect(masked.label.startsWith('node ')).toBe(true);
    expect(masked.nodeType).not.toContain('sk-ant-api03');
  });
});
