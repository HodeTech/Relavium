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
    expect(out()).toBe('done: run completed\n  outputs:\n    answer: 42 [REDACTED]\n');
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
