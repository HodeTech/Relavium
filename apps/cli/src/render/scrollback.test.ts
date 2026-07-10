import { Writable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { PassThrough } from 'node:stream';

import {
  DUMP_FOOTER,
  DUMP_HEADER,
  DUMP_PROMPT,
  dumpToScrollback,
  nodeWaitForContinue,
  type DumpToScrollbackDeps,
  type InterruptSource,
  nodeWriteOut,
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

/** A fake SIGINT source: a suite must never raise a real signal at its own runner. */
const fakeInterrupts = (): InterruptSource & { raise: () => void; listeners: number } => {
  const handlers = new Set<() => void>();
  return {
    once: (_event, listener) => void handlers.add(listener),
    removeListener: (_event, listener) => void handlers.delete(listener),
    raise: () => {
      for (const h of [...handlers]) h();
    },
    get listeners() {
      return handlers.size;
    },
  };
};

/**
 * `nodeWaitForContinue` — the "Press Enter to return" wait. It runs INSIDE the suspension, where ink has detached its
 * own stdin listeners and turned raw mode off, so it owns stdin for the duration and must hand it back clean.
 */
describe('nodeWaitForContinue', () => {
  it('resolves on the first keypress and removes every listener it added', async () => {
    const stdin = new PassThrough();
    const interrupts = fakeInterrupts();
    const wait = nodeWaitForContinue(stdin, interrupts)();
    stdin.write('\n');
    await wait;
    expect(stdin.listenerCount('data')).toBe(0);
    expect(stdin.listenerCount('end')).toBe(0);
    expect(stdin.listenerCount('error')).toBe(0);
    expect(interrupts.listeners).toBe(0); // ink's resumeInput must find a quiet stream + no stray SIGINT handler
  });

  it('resolves on a real SIGINT — Ctrl-C at the prompt RETURNS to Relavium instead of hanging', async () => {
    // Raw mode is off for the whole suspension, so Ctrl-C is a signal, not a `\x03` byte on `data`. The surface's own
    // SIGINT handler is deliberately inert while suspended, so if this wait ignored the signal there would be no way
    // back but Enter (Step-5d-3 Sonnet review).
    const stdin = new PassThrough();
    const interrupts = fakeInterrupts();
    const wait = nodeWaitForContinue(stdin, interrupts)();
    interrupts.raise();
    await expect(wait).resolves.toBeUndefined();
    expect(interrupts.listeners).toBe(0);
  });

  it('resolves on `end` (a piped stdin) rather than hanging — the dump is already in the scrollback', async () => {
    const stdin = new PassThrough();
    const wait = nodeWaitForContinue(stdin, fakeInterrupts())();
    stdin.end();
    await expect(wait).resolves.toBeUndefined();
  });
});

/**
 * `nodeWriteOut` (2.6.F Step 6g, whole-phase Opus review). It is the only thing standing between a dying TTY and a
 * dead process: `process.stdout` surfaces an OS write fault as an ASYNCHRONOUS `'error'` event, and Node throws an
 * unhandled `'error'` as an uncaught exception — mid-suspension, with the terminal handed away. It had zero coverage.
 */
describe('nodeWriteOut — an async stdout error must not kill the suspension', () => {
  /** A Writable whose flush is deferred, so a test can fire `'error'` while the write is still in flight. */
  const deferredStream = (): Writable & { flush: () => void; written: string[] } => {
    let done: (() => void) | undefined;
    const written: string[] = [];
    const stream = new Writable({
      write(chunk: unknown, _enc: unknown, callback: () => void) {
        written.push(String(chunk));
        done = () => callback();
      },
    }) as Writable & { flush: () => void; written: string[] };
    stream.flush = () => done?.();
    stream.written = written;
    return stream;
  };

  it('an async `error` DURING the write is swallowed — an unhandled one would be an uncaught exception', () => {
    const stream = deferredStream();
    nodeWriteOut(stream)('hello');
    expect(stream.written).toEqual(['hello']);
    // No listener ⇒ Node throws. With ours attached, this is inert.
    expect(() => stream.emit('error', new Error('EPIPE'))).not.toThrow();
  });

  it('the listener is REMOVED once the write flushes — it must not swallow another writer’s errors forever', () => {
    const stream = deferredStream();
    const before = stream.listenerCount('error');
    nodeWriteOut(stream)('hello');
    expect(stream.listenerCount('error')).toBe(before + 1);
    stream.flush();
    expect(stream.listenerCount('error')).toBe(before);
  });

  it('a SYNCHRONOUS throw (an already-destroyed stream) removes the listener too, and does not escape', () => {
    const stream = new Writable({ write() {} });
    stream.write = () => {
      throw new Error('write after end');
    };
    const before = stream.listenerCount('error');
    expect(() => nodeWriteOut(stream)('hello')).not.toThrow();
    expect(stream.listenerCount('error')).toBe(before);
  });

  it('does not leak a listener per write across a long dump', () => {
    const stream = deferredStream();
    const write = nodeWriteOut(stream);
    for (let i = 0; i < 5; i += 1) {
      write(`line ${String(i)}`);
      stream.flush();
    }
    expect(stream.listenerCount('error')).toBe(0);
  });
});
