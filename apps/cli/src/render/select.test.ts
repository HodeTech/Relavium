import type { RunEvent } from '@relavium/shared';
import { describe, expect, it } from 'vitest';

import type { GlobalOptions } from '../process/options.js';
import { detectOutputMode } from '../process/output-mode.js';
import { captureIo } from '../test-support.js';
import { selectRenderer } from './select.js';

const TS = '2026-06-23T12:00:00.000Z';

function globalOptions(over: Partial<GlobalOptions>): GlobalOptions {
  return {
    json: false,
    color: true,
    cwd: '/',
    configPath: undefined,
    verbosity: 'normal',
    ...over,
  };
}

const COMPLETED: RunEvent = {
  type: 'run:completed',
  runId: 'r',
  timestamp: TS,
  sequenceNumber: 1,
  outputs: {},
  totalTokensUsed: { input: 1, output: 2 },
  totalCostMicrocents: 0,
  durationMs: 5,
};

describe('selectRenderer', () => {
  it('routes --json to the NDJSON renderer (one verbatim event per line, no finalize)', () => {
    const io = captureIo(); // stdoutIsTty: false
    const renderer = selectRenderer(io.io, globalOptions({ json: true }));
    renderer.onEvent(COMPLETED);
    expect(io.out()).toBe(`${JSON.stringify(COMPLETED)}\n`);
    expect(renderer.finalize).toBeUndefined(); // the NDJSON renderer needs no teardown
  });

  it('routes a non-TTY, non-json run to the plain line renderer', () => {
    const io = captureIo();
    const renderer = selectRenderer(io.io, globalOptions({ json: false }));
    renderer.onEvent(COMPLETED);
    expect(io.out()).toContain('done: run completed');
    expect(renderer.finalize).toBeUndefined();
  });

  it('detectOutputMode picks the TUI only for an interactive, non-CI, non-json TTY', () => {
    expect(detectOutputMode({ stdoutIsTty: true, json: false, ci: false })).toBe('tui');
    expect(detectOutputMode({ stdoutIsTty: true, json: true, ci: false })).toBe('plain'); // --json wins
    expect(detectOutputMode({ stdoutIsTty: true, json: false, ci: true })).toBe('plain'); // CI wins
    expect(detectOutputMode({ stdoutIsTty: false, json: false, ci: false })).toBe('plain'); // no TTY
  });
});
