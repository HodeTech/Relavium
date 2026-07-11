import { describe, expect, it } from 'vitest';

import {
  DISABLE_MOUSE,
  ENABLE_MOUSE,
  ENTER_ALT_SCREEN,
  EXIT_ALT_SCREEN,
  HIDE_CURSOR,
  SHOW_CURSOR,
} from './alt-screen.js';
import { createSuspendPort, suspendFullScreen, type SuspendFullScreenOptions } from './suspend.js';

/**
 * The suspend-full-screen primitive (2.6.F Step 5d, ADR-0068 §e). These pin the contract the `/scrollback` and
 * `/edit` hatches rest on: the writes land INSIDE ink's suspension (never before/after), the alt-buffer toggle is
 * SURFACE-DIVERGENT (ink owns 1049 on the Home, we own it on `relavium chat`), the mouse is always ours, and no
 * failure path can strand the terminal in a half-restored state.
 */

/** A recording fake of ink's `suspendTerminal`: it stamps the callback's boundaries into the SAME trace the control
 *  writes go to, so a test can assert that every write happened between `begin` and `end` (ink's frame-erase /
 *  input-pause window) rather than merely that it happened. */
const harness = (
  over: Partial<SuspendFullScreenOptions> = {},
): { opts: SuspendFullScreenOptions; trace: string[] } => {
  const trace: string[] = [];
  const opts: SuspendFullScreenOptions = {
    suspendTerminal: async (callback) => {
      trace.push('ink:begin');
      try {
        await callback();
      } finally {
        trace.push('ink:end');
      }
    },
    writeControl: (sequence) => trace.push(sequence),
    inkOwnsAltScreen: false, // the `relavium chat` default (the hoist owns 1049)
    altActive: true,
    mouseActive: true,
    ...over,
  };
  return { opts, trace };
};

const body = (trace: string[]) => (): Promise<void> => {
  trace.push('body');
  return Promise.resolve();
};

describe('suspendFullScreen — `relavium chat` (ink does NOT own the alt screen)', () => {
  it('exits + re-enters the alt buffer ITSELF, and does so INSIDE ink’s suspension window', async () => {
    const { opts, trace } = harness({ inkOwnsAltScreen: false });
    await suspendFullScreen(opts, body(trace));
    expect(trace).toEqual([
      'ink:begin', // ink erased its frame + paused input (raw mode + bracketed paste OFF)
      DISABLE_MOUSE,
      EXIT_ALT_SCREEN + SHOW_CURSOR, // ours: ink's render option is false on this surface
      'body',
      ENTER_ALT_SCREEN + HIDE_CURSOR,
      ENABLE_MOUSE,
      'ink:end', // ink resumes input, then force-redraws
    ]);
  });

  it('restores BOTH modes when the body throws, and rethrows the body’s error', async () => {
    const { opts, trace } = harness({ inkOwnsAltScreen: false });
    const boom = new Error('editor failed');
    await expect(
      suspendFullScreen(opts, () => {
        trace.push('body');
        return Promise.reject(boom);
      }),
    ).rejects.toBe(boom);
    expect(trace).toEqual([
      'ink:begin',
      DISABLE_MOUSE,
      EXIT_ALT_SCREEN + SHOW_CURSOR,
      'body',
      ENTER_ALT_SCREEN + HIDE_CURSOR, // the terminal is given back even on the failure path
      ENABLE_MOUSE,
      'ink:end',
    ]);
  });
});

describe('suspendFullScreen — the bare Home (ink OWNS the alt screen)', () => {
  it('never touches 1049 (ink’s begin/endSuspend do it) but still suspends the mouse — which ink never writes', async () => {
    const { opts, trace } = harness({ inkOwnsAltScreen: true });
    await suspendFullScreen(opts, body(trace));
    expect(trace).toEqual(['ink:begin', DISABLE_MOUSE, 'body', ENABLE_MOUSE, 'ink:end']);
    // The load-bearing negative: a 1049 write here would DOUBLE-toggle against ink and lose the frame.
    expect(trace).not.toContain(EXIT_ALT_SCREEN + SHOW_CURSOR);
    expect(trace).not.toContain(ENTER_ALT_SCREEN + HIDE_CURSOR);
  });
});

describe('suspendFullScreen — the inline renderer and the mouse-off case', () => {
  it('inline (no alt buffer, no mouse): writes NOTHING — it is purely ink handing back raw mode (what `/edit` needs)', async () => {
    const { opts, trace } = harness({ altActive: false, mouseActive: false });
    await suspendFullScreen(opts, body(trace));
    expect(trace).toEqual(['ink:begin', 'body', 'ink:end']);
  });

  it('alt-on with the mouse OFF (the `--no-mouse` shape): toggles 1049 only', async () => {
    const { opts, trace } = harness({
      altActive: true,
      mouseActive: false,
      inkOwnsAltScreen: false,
    });
    await suspendFullScreen(opts, body(trace));
    expect(trace).toEqual([
      'ink:begin',
      EXIT_ALT_SCREEN + SHOW_CURSOR,
      'body',
      ENTER_ALT_SCREEN + HIDE_CURSOR,
      'ink:end',
    ]);
  });

  it('mouse-on with the alt buffer OFF: suspends the mouse, never the buffer', async () => {
    const { opts, trace } = harness({ altActive: false, mouseActive: true });
    await suspendFullScreen(opts, body(trace));
    expect(trace).toEqual(['ink:begin', DISABLE_MOUSE, 'body', ENABLE_MOUSE, 'ink:end']);
  });
});

describe('suspendFullScreen — a write that throws can never leave a HALF-restored terminal', () => {
  it('the FIRST release write throws ⇒ nothing was changed ⇒ nothing is restored (no phantom alt re-enter)', async () => {
    const trace: string[] = [];
    const boom = new Error('stdout closed');
    const opts: SuspendFullScreenOptions = {
      suspendTerminal: async (callback) => {
        trace.push('ink:begin');
        try {
          await callback();
        } finally {
          trace.push('ink:end');
        }
      },
      writeControl: (sequence) => {
        if (sequence === DISABLE_MOUSE && !trace.includes(DISABLE_MOUSE)) throw boom;
        trace.push(sequence);
      },
      inkOwnsAltScreen: false,
      altActive: true,
      mouseActive: true,
    };
    await expect(suspendFullScreen(opts, body(trace))).rejects.toBe(boom);
    // The body never ran, the buffer was never exited — so restoring anything would corrupt a terminal that is
    // still exactly as ink left it.
    expect(trace).toEqual(['ink:begin', 'ink:end']);
  });

  it('the alt-EXIT write throws ⇒ the mouse (already suspended) is still restored', async () => {
    const trace: string[] = [];
    const boom = new Error('stdout closed');
    const opts: SuspendFullScreenOptions = {
      suspendTerminal: async (callback) => {
        trace.push('ink:begin');
        try {
          await callback();
        } finally {
          trace.push('ink:end');
        }
      },
      writeControl: (sequence) => {
        if (sequence === EXIT_ALT_SCREEN + SHOW_CURSOR) throw boom;
        trace.push(sequence);
      },
      inkOwnsAltScreen: false,
      altActive: true,
      mouseActive: true,
    };
    await expect(suspendFullScreen(opts, body(trace))).rejects.toBe(boom);
    expect(trace).toEqual(['ink:begin', DISABLE_MOUSE, ENABLE_MOUSE, 'ink:end']);
    // Never re-enters a buffer it failed to exit.
    expect(trace).not.toContain(ENTER_ALT_SCREEN + HIDE_CURSOR);
  });

  it('the alt RE-ENTER write throws ⇒ the mouse is STILL restored (a stranded DECSET-1000 is the worst outcome)', async () => {
    const trace: string[] = [];
    const boom = new Error('stdout closed');
    const opts: SuspendFullScreenOptions = {
      suspendTerminal: async (callback) => {
        trace.push('ink:begin');
        try {
          await callback();
        } finally {
          trace.push('ink:end');
        }
      },
      writeControl: (sequence) => {
        if (sequence === ENTER_ALT_SCREEN + HIDE_CURSOR) throw boom;
        trace.push(sequence);
      },
      inkOwnsAltScreen: false,
      altActive: true,
      mouseActive: true,
    };
    await expect(suspendFullScreen(opts, body(trace))).rejects.toBe(boom);
    expect(trace).toEqual([
      'ink:begin',
      DISABLE_MOUSE,
      EXIT_ALT_SCREEN + SHOW_CURSOR,
      'body',
      ENABLE_MOUSE, // the isolated reclaim — reached despite the throw above it
      'ink:end',
    ]);
  });

  it('DOUBLE FAULT: the body throws AND the re-enter write throws ⇒ the BODY’s error survives, mouse still restored', async () => {
    // The Step-5d-1 Opus review's one surviving finding. A `finally` would let the restore-write error REPLACE the
    // body's, so a failing `/edit` on a closed stdout would tell the user "stdout closed" instead of "could not
    // start $EDITOR". The root cause must win (error-handling.md), and the mouse must come back regardless.
    const trace: string[] = [];
    const bodyError = new Error('could not start $EDITOR');
    const writeError = new Error('stdout closed');
    const opts: SuspendFullScreenOptions = {
      suspendTerminal: async (callback) => {
        trace.push('ink:begin');
        try {
          await callback();
        } finally {
          trace.push('ink:end');
        }
      },
      writeControl: (sequence) => {
        if (sequence === ENTER_ALT_SCREEN + HIDE_CURSOR) throw writeError;
        trace.push(sequence);
      },
      inkOwnsAltScreen: false,
      altActive: true,
      mouseActive: true,
    };
    await expect(
      suspendFullScreen(opts, () => {
        trace.push('body');
        return Promise.reject(bodyError);
      }),
    ).rejects.toBe(bodyError); // NOT writeError — the secondary failure is dropped, never the root cause
    expect(trace).toContain(ENABLE_MOUSE); // and the worst-to-strand mode is restored despite the double fault
  });
});

describe('suspendFullScreen — re-entrancy is the SURFACE’s job to gate', () => {
  it('propagates ink’s "already suspended" throw rather than swallowing it (beginSuspend throws by design)', async () => {
    const already = new Error('The terminal is already suspended.');
    const trace: string[] = [];
    const opts: SuspendFullScreenOptions = {
      suspendTerminal: () => Promise.reject(already), // beginSuspend threw before the callback ran
      writeControl: (sequence) => trace.push(sequence),
      inkOwnsAltScreen: false,
      altActive: true,
      mouseActive: true,
    };
    await expect(suspendFullScreen(opts, body(trace))).rejects.toBe(already);
    expect(trace).toEqual([]); // no write escaped the failed suspension
  });
});

/**
 * `createSuspendPort().isSuspended()` (Step-5d-3 Sonnet review). Not diagnostic — LOAD-BEARING. During a suspension
 * ink has raw mode OFF, so a keyboard Ctrl-C reaches the process as a real SIGINT. The chat's SIGINT handler must
 * yield while a hatch owns the terminal, or it tears the session down behind the suspension's back and its pending
 * reclaim later re-enters the alt buffer on the user's SHELL. The flag is owned by the PORT, wrapped around the ink
 * call it hands out, so no caller can forget to maintain it.
 */
describe('createSuspendPort — the suspension window', () => {
  it('is false before, TRUE for exactly the callback, and false after', async () => {
    const port = createSuspendPort();
    const seen: boolean[] = [];
    port.attach(async (callback) => {
      seen.push(port.isSuspended()); // ink has begun: the window is open
      await callback();
    });
    expect(port.isSuspended()).toBe(false);
    await port.current()?.(() => {
      seen.push(port.isSuspended()); // inside the body: still open
      return Promise.resolve();
    });
    expect(port.isSuspended()).toBe(false);
    expect(seen).toEqual([true, true]);
  });

  it('CLOSES the window when the suspension throws (a stuck flag would deafen the surface to SIGINT forever)', async () => {
    const port = createSuspendPort();
    const boom = new Error('editor failed');
    port.attach(() => Promise.reject(boom));
    await expect(port.current()?.(() => Promise.resolve())).rejects.toBe(boom);
    expect(port.isSuspended()).toBe(false);
  });

  it('is false when nothing is attached (a plain / --json driver never suspends)', () => {
    const port = createSuspendPort();
    expect(port.isSuspended()).toBe(false);
    expect(port.current()).toBeUndefined();
  });
});
