import { createClient, runMigrations, type DbClient } from '@relavium/db';
import type { RunEvent } from '@relavium/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { logsCommand } from '../commands/logs.js';
import { captureIo, seedRun } from '../test-support.js';
import { createPlainRenderer } from './renderer.js';
import {
  formatRunOutputs,
  MAX_TOTAL_CHARS,
  MAX_VALUE_CHARS,
  MAX_VALUE_LINES,
} from './run-outputs.js';
import { renderFinalSummary } from './tui/final-summary.js';
import { initialRunViewState, reduceRunEvent } from './tui/run-view-model.js';

const TS = '2026-11-05T00:00:00.000Z';
/** A credential shape the shared scrubber masks (`sk-` + a long opaque body). */
const KEY = `sk-${'A'.repeat(32)}_${'B'.repeat(32)}`;

const completed = (outputs: Record<string, unknown>): RunEvent => ({
  type: 'run:completed',
  runId: 'run-1',
  timestamp: TS,
  sequenceNumber: 9,
  outputs,
  totalTokensUsed: { input: 1, output: 2 },
  totalCostMicrocents: 0,
  durationMs: 5,
});

describe('formatRunOutputs (MVP-A1)', () => {
  it('prints nothing for a run with no outputs', () => {
    expect(formatRunOutputs({}, '  ', 'run-1')).toEqual([]);
  });

  it('puts a one-line value beside its key and anything else as compact JSON, a masked secret still masked', () => {
    expect(
      formatRunOutputs(
        { summary: 'all green', count: 3, token: { secret: true, ref: 'inputs.token' } },
        '  ',
      ),
    ).toEqual([
      '  outputs:',
      '    summary: all green',
      '    count: 3',
      '    token: {"secret":true,"ref":"inputs.token"}',
    ]);
  });

  it('indents every row of a multi-line value under its key, so it cannot forge a summary row', () => {
    const lines = formatRunOutputs({ report: 'line one\n✓ forged-node\nline three' }, '  ');
    expect(lines).toEqual([
      '  outputs:',
      '    report:',
      '      line one',
      '      ✓ forged-node',
      '      line three',
    ]);
  });

  it('strips terminal controls and masks secret shapes in values, and collapses a key to one row', () => {
    const lines = formatRunOutputs(
      {
        'bad\nkey': `ok \u001b[31mred\u001b[0m \u001b]8;;https://x\u0007link\u001b]8;;\u0007 ${KEY}\rover`,
      },
      '  ',
    );
    const text = lines.join('\n');
    expect(text).not.toContain('\u001b');
    expect(text).not.toContain('\u0007');
    expect(text).not.toContain('\r');
    expect(text).not.toContain(KEY);
    expect(text).toContain('[REDACTED]');
    expect(lines[1]?.startsWith('    bad key:')).toBe(true);
  });

  it('bounds each value by lines and by characters, and says where the full record is', () => {
    const tall = Array.from({ length: MAX_VALUE_LINES + 10 }, (_, i) => `row ${String(i)}`).join(
      '\n',
    );
    const tallLines = formatRunOutputs({ tall }, '  ', 'run-7');
    expect(tallLines.filter((line) => line.startsWith('      row '))).toHaveLength(MAX_VALUE_LINES);
    expect(tallLines.at(-2)).toBe('      …');
    expect(tallLines.at(-1)).toBe(
      '    (outputs shortened — the full record: `relavium logs run-7 --json`)',
    );

    const wide = formatRunOutputs({ wide: 'x'.repeat(MAX_VALUE_CHARS + 50) }, '  ');
    expect(wide.join('').split('x')).toHaveLength(MAX_VALUE_CHARS + 1);
    expect(wide.at(-1)).toContain('`relavium logs <runId> --json`');
  });

  it('bounds the whole block, then lists the keys it had no room for', () => {
    const big = 'y'.repeat(MAX_VALUE_CHARS);
    const keys = Object.fromEntries(
      Array.from({ length: Math.ceil(MAX_TOTAL_CHARS / MAX_VALUE_CHARS) + 1 }, (_, i) => [
        `k${String(i)}`,
        big,
      ]),
    );
    const lines = formatRunOutputs(keys, '');
    expect(lines.join('').split('y').length - 1).toBe(MAX_TOTAL_CHARS);
    expect(lines).toContain(`  k${String(Object.keys(keys).length - 1)}: …`);
  });

  it('masks a key inside a non-string value before serializing it, so an escaped newline cannot hide it', () => {
    // JSON.stringify writes the newline as the two characters `\n`; masked after that, `nsk-…` had no boundary.
    for (const outputs of [
      { v: { text: `config:\n${KEY}` } },
      { fan: { writer: `Your key:\n${KEY}`, reviewer: 'ok' } },
      { tab: [`k\t${KEY}`] },
      { crlf: { t: `k\r\n${KEY}` } },
    ]) {
      const text = formatRunOutputs(outputs, '  ', 'run-3').join('\n');
      expect(text).not.toContain(KEY);
      expect(text).toContain('[REDACTED]');
      expect(text).toContain('(outputs masked — the full record: `relavium logs run-3 --json`)');
    }
    // An object key is masked too.
    expect(formatRunOutputs({ v: { [KEY]: 1 } }, '').join('\n')).not.toContain(KEY);
  });

  it('reads each field with its name, so a value named like an API-key header is masked wherever it sits', () => {
    // Masked leaf by leaf, neither `x-api-key` nor the opaque value is a shape alone; the scrubber's header rule
    // needs the name, the `:` and the value in one text, as a serialized object has them.
    const OPAQUE = '9f8e7d6c5b4a39281706f5e4d3c2b1a0';
    for (const name of ['x-api-key', 'X-Api-Key', 'api-key', 'x-goog-api-key']) {
      for (const outputs of [
        { v: { [name]: OPAQUE } },
        { request: { url: 'https://svc.internal/v1', headers: { [name]: OPAQUE } } },
        { v: [{ [name]: OPAQUE }] },
        { v: { [name]: Number('1234567890123456') } },
        { [name]: OPAQUE },
        { [name]: Number('1234567890123456') },
      ]) {
        const text = formatRunOutputs(outputs, '', 'run-6').join('\n');
        expect(text, `${name} in ${JSON.stringify(Object.keys(outputs))}`).not.toContain(
          OPAQUE.slice(0, 12),
        );
        expect(text).not.toContain('1234567890');
        expect(text).toContain('(outputs masked — the full record: `relavium logs run-6 --json`)');
      }
    }
    // The boundary: a name decides only through a shape the scrubber knows. Another name masks nothing, and a
    // value already masked leaf by leaf keeps its prose rather than being masked whole.
    expect(formatRunOutputs({ v: { note: OPAQUE } }, '')).toEqual([
      'outputs:',
      `  v: {"note":"${OPAQUE}"}`,
    ]);
    expect(formatRunOutputs({ v: { note: `see ${KEY} now` } }, '')[1]).toBe(
      '  v: {"note":"see [REDACTED] now"}',
    );
  });

  it('keeps an own __proto__ member, as JSON.parse makes one, rather than dropping it unsaid', () => {
    const parsed: unknown = JSON.parse('{"v":{"__proto__":{"x":"kept"},"y":1}}');
    if (typeof parsed !== 'object' || parsed === null) throw new Error('fixture');
    expect(formatRunOutputs(Object.fromEntries(Object.entries(parsed)), '')).toEqual([
      'outputs:',
      '  v: {"__proto__":{"x":"kept"},"y":1}',
    ]);
  });

  it('trims a final newline run in linear time, whatever newline run sits inside the value', () => {
    // `/\n+$/` retried from every newline of an interior run: 200,000 of them took about 13 s. A loop takes ms.
    const lines = formatRunOutputs({ v: `${'\n'.repeat(200_000)}x` }, '');
    expect(lines[1]).toBe('  v:');
  }, 5_000);

  it('masks each field of a record on its own, so a URL in one and an @ in the next stay whole', () => {
    // Masked as one JSON text, the URL rule ran from `https://` across the field boundary to the next `@`,
    // swallowed the email field and showed a fake host.
    expect(
      formatRunOutputs({ contact: { site: 'https://acme.com', email: 'info@acme.com' } }, ''),
    ).toEqual(['outputs:', '  contact: {"site":"https://acme.com","email":"info@acme.com"}']);
  });

  it('says when a value was masked and where the exact record is, even when the scrubber masked it whole', () => {
    // The shared scrubber's documented fail-closed residual reads a path-less URL, prose and a later `@` as URL
    // userinfo once whitespace is removed. The value is masked whole; the note keeps that from reading as silence.
    const prose = 'Docs are at https://acme.com and support is reachable at help@acme.com.';
    expect(formatRunOutputs({ summary: prose }, '', 'run-5')).toEqual([
      'outputs:',
      '  summary: [REDACTED]',
      '  (outputs masked — the full record: `relavium logs run-5 --json`)',
    ]);
  });

  it('says both causes when a block is shortened and masked', () => {
    const lines = formatRunOutputs({ a: KEY, b: 'x'.repeat(MAX_VALUE_CHARS + 1) }, '', 'run-4');
    expect(lines.at(-1)).toBe(
      '  (outputs shortened and masked — the full record: `relavium logs run-4 --json`)',
    );
  });

  it('reads a value the way JSON does: toJSON is honoured, and a cycle is said rather than thrown', () => {
    expect(formatRunOutputs({ at: { when: new Date(0) } }, '')).toEqual([
      'outputs:',
      '  at: {"when":"1970-01-01T00:00:00.000Z"}',
    ]);
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    expect(formatRunOutputs({ loop: cyclic }, '')).toEqual([
      'outputs:',
      '  loop: [unrepresentable value]',
    ]);
  });

  it('masks a key on the original text before clipping, so a cut can never leave a short unmasked prefix', () => {
    // Clipped first, the key would end as `sk-AAAA` — too short a fragment for the scrubber to recognize.
    const text = formatRunOutputs({ v: `${'x'.repeat(MAX_VALUE_CHARS - 8)} ${KEY}` }, '').join(
      '\n',
    );
    expect(text).not.toContain('sk-');
  });

  it('treats a final newline as the end of the value, not an empty row or a cut', () => {
    expect(formatRunOutputs({ a: 'one\ntwo\n' }, '')).toEqual([
      'outputs:',
      '  a:',
      '    one',
      '    two',
    ]);
    const forty = Array.from({ length: MAX_VALUE_LINES }, (_, i) => `r${String(i)}`).join('\n');
    expect(formatRunOutputs({ a: `${forty}\n` }, '').at(-1)).toBe(
      `    r${String(MAX_VALUE_LINES - 1)}`,
    );
  });

  it('never splits a code point at the bound', () => {
    // One ASCII unit first, so a UTF-16 code-unit cut would land in the middle of a pair.
    const lines = formatRunOutputs({ emoji: `a${'😀'.repeat(MAX_VALUE_CHARS)}` }, '');
    expect(lines.join('')).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u);
  });
});

describe('the outputs reach every human run surface (MVP-A1)', () => {
  it('the TUI final summary ends with them on a completed run, and not on a failed one', () => {
    const done = reduceRunEvent(initialRunViewState(), completed({ answer: '42' }));
    expect(renderFinalSummary(done)).toContain('  outputs:\n    answer: 42\n');
    const failed = reduceRunEvent(initialRunViewState(), {
      type: 'run:failed',
      runId: 'run-1',
      timestamp: TS,
      sequenceNumber: 9,
      error: { code: 'internal', message: 'boom', retryable: false },
      partialOutputs: { answer: '42' },
    });
    expect(renderFinalSummary(failed)).not.toContain('outputs:');
  });

  it('the plain renderer prints them under its done line, sanitized', () => {
    const { io, out } = captureIo();
    createPlainRenderer(io).onEvent(completed({ answer: `42 ${KEY}` }));
    expect(out()).toBe(
      'done: run completed\n  outputs:\n    answer: 42 [REDACTED]\n' +
        '    (outputs masked — the full record: `relavium logs run-1 --json`)\n',
    );
  });

  describe('relavium logs <runId>', () => {
    let client: DbClient;
    beforeEach(() => {
      client = createClient(':memory:');
      runMigrations(client.db);
    });
    afterEach(() => {
      client.sqlite.close();
    });

    it('gives every replayed row the one-line floor — a stored field cannot forge a row or inject a control', async () => {
      await seedRun(client.db, {
        slug: 'demo',
        runId: 'run-2',
        state: 'paused',
        gate: {
          gateId: 'g1\u001b[2J\n[9] run:completed — completed',
          gateType: 'approval',
          message: 'ok?',
        },
      });
      const human = captureIo();
      logsCommand(
        { runId: 'run-2' },
        {
          io: human.io,
          global: {
            json: false,
            color: false,
            cwd: '/',
            configPath: undefined,
            verbosity: 'normal',
          },
          openDb: () => ({ db: client.db, close: () => undefined }),
        },
      );
      expect(human.out()).not.toContain('\u001b');
      expect(human.out()).toContain('— gate g1 [9] run:completed — completed (approval)');
      expect(
        human
          .out()
          .split('\n')
          .filter((line) => line.startsWith('[9] run:completed')),
      ).toEqual([]);
    });

    it('prints them under the run:completed row, and --json keeps the raw event', async () => {
      await seedRun(client.db, {
        slug: 'demo',
        runId: 'run-1',
        state: 'completed',
        outputs: { answer: `42\u001b[2J ${KEY}` },
      });
      const deps = (json: boolean, io: ReturnType<typeof captureIo>['io']) => ({
        io,
        global: {
          json,
          color: false,
          cwd: '/',
          configPath: undefined,
          verbosity: 'normal' as const,
        },
        openDb: () => ({ db: client.db, close: () => undefined }),
      });
      const human = captureIo();
      logsCommand({ runId: 'run-1' }, deps(false, human.io));
      expect(human.out()).toContain(
        'run:completed — completed\n    outputs:\n      answer: 42 [REDACTED]\n',
      );
      expect(human.out()).not.toContain('\u001b');

      const machine = captureIo();
      logsCommand({ runId: 'run-1' }, deps(true, machine.io));
      expect(machine.out()).not.toContain('outputs:\n');
      expect(machine.out()).toContain('"outputs":{"answer":');
    });
  });
});
