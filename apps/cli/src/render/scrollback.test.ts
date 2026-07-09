import { describe, expect, it } from 'vitest';

import {
  DUMP_FOOTER,
  DUMP_HEADER,
  DUMP_PROMPT,
  dumpToScrollback,
  type DumpToScrollbackDeps,
} from './scrollback.js';

/**
 * The `/scrollback` dump (2.6.F Step 5d, ADR-0068 §e). The load-bearing properties: the transcript is sanitized AT
 * THIS boundary (it is written as raw bytes to a terminal), the whole dump is ONE write (no interleaving), and the
 * caller waits for the user before the full-screen view repaints over it.
 */

const harness = (
  over: Partial<DumpToScrollbackDeps> = {},
): { deps: DumpToScrollbackDeps; trace: string[] } => {
  const trace: string[] = [];
  const deps: DumpToScrollbackDeps = {
    writeOut: (text) => trace.push(text),
    waitForContinue: () => {
      trace.push('waited');
      return Promise.resolve();
    },
    ...over,
  };
  return { deps, trace };
};

describe('dumpToScrollback', () => {
  it('prints the banners around the transcript, then WAITS before the caller repaints', async () => {
    const { deps, trace } = harness();
    await dumpToScrollback(deps, ['> hi', 'hello there']);
    expect(trace).toEqual([
      `${DUMP_HEADER}\n> hi\nhello there\n${DUMP_FOOTER}\n${DUMP_PROMPT}\n`,
      'waited', // the dump is useless if the full-screen frame repaints over it first
    ]);
  });

  it('emits the whole dump in ONE write, so another stdout writer cannot interleave mid-transcript', async () => {
    const { deps, trace } = harness();
    await dumpToScrollback(deps, ['a', 'b', 'c', 'd']);
    expect(trace.filter((t) => t !== 'waited')).toHaveLength(1);
  });

  it('an EMPTY transcript still prints the banners (a silent no-op would read as a broken command)', async () => {
    const { deps, trace } = harness();
    await dumpToScrollback(deps, []);
    expect(trace[0]).toBe(`${DUMP_HEADER}\n${DUMP_FOOTER}\n${DUMP_PROMPT}\n`);
    expect(trace).toContain('waited');
  });

  it('SECURITY: sanitizes at ITS OWN boundary — an ANSI escape in a line can never reach the terminal', async () => {
    const { deps, trace } = harness();
    // A model that emitted a cursor jump + a colour + a bidi override: all stripped before the terminal sees them.
    await dumpToScrollback(deps, ['\x1b[31mred\x1b[0m', 'jump\x1b[2Jhere', 'rtl‮override']);
    const written = trace[0] ?? '';
    expect(written).toContain('red');
    expect(written).toContain('jumphere');
    expect(written).toContain('rtloverride');
    expect(written).not.toContain('\x1b'); // no escape byte survives
    expect(written).not.toContain('‮'); // no Trojan-Source reordering survives
  });

  it('keeps newlines inside a single entry (a multi-line assistant answer stays multi-line)', async () => {
    const { deps, trace } = harness();
    await dumpToScrollback(deps, ['line one\nline two']);
    expect(trace[0]).toBe(`${DUMP_HEADER}\nline one\nline two\n${DUMP_FOOTER}\n${DUMP_PROMPT}\n`);
  });

  it('propagates a waitForContinue rejection (the caller’s suspension still restores the terminal)', async () => {
    const boom = new Error('stdin closed');
    const { deps } = harness({ waitForContinue: () => Promise.reject(boom) });
    await expect(dumpToScrollback(deps, ['x'])).rejects.toBe(boom);
  });
});
