import { describe, expect, it, vi } from 'vitest';

import { HIDE_CURSOR, SHOW_CURSOR } from './alt-screen.js';
import { wireRunJobControl } from './run-job-control.js';
import type { JobControlLifecycle } from './suspend.js';

/**
 * G0's residue on the run/gate path. ink hides the cursor while it renders and `signal-exit`'s signal list
 * contains no `SIGTSTP`, so a Ctrl-Z during `relavium run` used to return the user to a shell with a
 * permanently invisible cursor — for the rest of that terminal's life, not just the run's.
 */
function harness(supported = true) {
  let onSuspend: (() => void) | undefined;
  let attaches = 0;
  let onContinue: (() => void) | undefined;
  const removeSuspend = vi.fn();
  const removeContinue = vi.fn();
  const suspendSelf = vi.fn();
  const written: string[] = [];
  const lifecycle: JobControlLifecycle = {
    supported,
    onSuspend: (listener) => {
      onSuspend = listener;
      attaches += 1;
      return removeSuspend;
    },
    onContinue: (listener) => {
      onContinue = listener;
      return removeContinue;
    },
    suspendSelf,
  };
  return {
    lifecycle,
    written,
    removeSuspend,
    removeContinue,
    suspendSelf,
    write: (text: string) => written.push(text),
    attaches: () => attaches,
    fireSuspend: () => onSuspend?.(),
    fireContinue: () => onContinue?.(),
    out: () => written.join(''),
  };
}

describe('wireRunJobControl (G0, the run/gate path)', () => {
  it('SHOWS the cursor before stopping, then re-raises so the process actually suspends', () => {
    const h = harness();
    const jc = wireRunJobControl({ write: h.write, lifecycle: h.lifecycle });
    try {
      h.fireSuspend();
      // Order matters: once stopped we run no code, so the restore has to precede the stop.
      expect(h.out()).toBe(SHOW_CURSOR);
      // Re-raised — swallowing Ctrl-Z would be worse than the bug: the user pressed a key that did nothing.
      expect(h.suspendSelf).toHaveBeenCalledTimes(1);
    } finally {
      jc.dispose();
    }
  });

  it('HIDES it again on SIGCONT, because ink resumes drawing', () => {
    const h = harness();
    const jc = wireRunJobControl({ write: h.write, lifecycle: h.lifecycle });
    try {
      h.fireSuspend();
      h.fireContinue();
      expect(h.out()).toBe(SHOW_CURSOR + HIDE_CURSOR);
    } finally {
      jc.dispose();
    }
  });

  it('DETACHES before re-raising, or the self-sent SIGTSTP re-enters this handler forever', () => {
    // `suspendSelf` sends SIGTSTP to our own pid, and a signal with a handler installed runs the handler
    // instead of taking the default stop action. Raising while still attached therefore re-enters this
    // function rather than stopping the process — an infinite loop, not a suspend.
    const h = harness();
    const order: string[] = [];
    const lifecycle = {
      ...h.lifecycle,
      suspendSelf: () => order.push('raise'),
    };
    const removeSuspendSpy = h.removeSuspend.mockImplementation(() => order.push('detach'));
    const jc = wireRunJobControl({ write: h.write, lifecycle });
    try {
      h.fireSuspend();
      expect(order).toEqual(['detach', 'raise']); // detach FIRST
      expect(removeSuspendSpy).toHaveBeenCalled();
      // SIGCONT puts it back, or a second Ctrl-Z would stop with no cursor restore.
      const before = h.attaches();
      h.fireContinue();
      expect(h.attaches()).toBe(before + 1);
    } finally {
      jc.dispose();
    }
  });

  it('does NOT stack a second listener when SIGCONT arrives twice', () => {
    // A spurious or duplicated SIGCONT with no SIGTSTP between them used to attach a SECOND listener while
    // overwriting the removal handle — leaking the first for the process's life and making the next Ctrl-Z run
    // the handler twice (two `SHOW_CURSOR` writes, two raises).
    const h = harness();
    const jc = wireRunJobControl({ write: h.write, lifecycle: h.lifecycle });
    try {
      const afterWiring = h.attaches();
      h.fireContinue();
      h.fireContinue();
      expect(h.attaches()).toBe(afterWiring); // still attached from wiring — nothing stacked
      // And exactly one detach still turns it off, which a leaked duplicate would defeat.
      h.fireSuspend();
      expect(h.removeSuspend).toHaveBeenCalledTimes(1);
      expect(h.suspendSelf).toHaveBeenCalledTimes(1);
    } finally {
      jc.dispose();
    }
  });

  it('dispose removes BOTH listeners — the leak shape suspend.ts already had', () => {
    const h = harness();
    const jc = wireRunJobControl({ write: h.write, lifecycle: h.lifecycle });
    jc.dispose();
    expect(h.removeSuspend).toHaveBeenCalledTimes(1);
    expect(h.removeContinue).toHaveBeenCalledTimes(1);
    // Idempotent: the caller's `finally` also runs on the throw path.
    jc.dispose();
    expect(h.removeSuspend).toHaveBeenCalledTimes(1);
    expect(h.removeContinue).toHaveBeenCalledTimes(1); // BOTH stay at one, not just the one we checked
  });

  it('is a no-op where job control does not exist, rather than half-wired', () => {
    const h = harness(false);
    const jc = wireRunJobControl({ write: h.write, lifecycle: h.lifecycle });
    h.fireSuspend();
    expect(h.out()).toBe('');
    expect(h.suspendSelf).not.toHaveBeenCalled();
    expect(() => jc.dispose()).not.toThrow();
  });
});
