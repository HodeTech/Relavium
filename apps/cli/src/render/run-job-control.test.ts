import { describe, expect, it, vi } from 'vitest';

import { HIDE_CURSOR, SHOW_CURSOR } from './alt-screen.js';
import { wireRunJobControl } from './run-job-control.js';
import type { JobControlLifecycle } from './suspend.js';
import { WorkflowTerminal } from '../commands/workflow-terminal.js';
import { invocationFixture } from '../process/invocation.test-support.js';
import { captureIo } from '../test-support.js';

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
  it('reports suspend-listener removal faults at the signal owner instead of throwing', async () => {
    const h = harness();
    const primary = new Error('PRIVATE_SIGNAL_REMOVE');
    const failure = vi.fn();
    const control = wireRunJobControl({
      write: h.write,
      lifecycle: h.lifecycle,
      onFailure: failure,
    });
    h.removeSuspend.mockImplementationOnce(() => {
      throw primary;
    });
    expect(() => h.fireSuspend()).not.toThrow();
    expect(failure).toHaveBeenCalledExactlyOnceWith(primary);
    expect(h.suspendSelf).not.toHaveBeenCalled();
    control.dispose();
    await control.released;
  });

  it('reports a failed reattach from SIGCONT without throwing from its native callback', () => {
    const h = harness();
    const primary = new Error('PRIVATE_SIGNAL_ATTACH');
    const failure = vi.fn();
    let entries = 0;
    const control = wireRunJobControl({
      write: h.write,
      lifecycle: {
        ...h.lifecycle,
        onSuspend: (listener) => {
          if (++entries === 2) throw primary;
          return h.lifecycle.onSuspend(listener);
        },
      },
      onFailure: failure,
    });
    h.fireSuspend();
    expect(() => h.fireContinue()).not.toThrow();
    expect(failure).toHaveBeenCalledExactlyOnceWith(primary);
    control.dispose();
  });

  it.each(['suspend', 'continue'] as const)(
    'reports a native %s cursor write failure while retaining actual terminal restoration',
    async (phase) => {
      const h = harness();
      const f = invocationFixture();
      const captured = captureIo();
      const cause = new Error('PRIVATE_NATIVE_CURSOR_WRITE');
      let release: () => void = () => undefined;
      const inputReleased = new Promise<void>((resolve) => {
        release = resolve;
      });
      const fail = vi.fn();
      const terminal = new WorkflowTerminal(
        f.registry,
        { ...captured.io, stdoutIsTty: true },
        () => undefined,
        fail,
      );
      terminal.createRenderer(() => ({
        onEvent: () => undefined,
        releaseInput: () => inputReleased,
      }));
      const onFailure = vi.fn((failure: unknown) => {
        fail(failure);
        terminal.seal();
      });
      const control = terminal.createJobControl((adopt) =>
        wireRunJobControl({
          adopt,
          lifecycle: h.lifecycle,
          onFailure,
          write: (text) => {
            if (text === (phase === 'suspend' ? SHOW_CURSOR : HIDE_CURSOR)) throw cause;
            h.write(text);
          },
        }),
      );
      if (phase === 'continue') h.fireSuspend();
      expect(phase === 'suspend' ? h.fireSuspend : h.fireContinue).not.toThrow();
      expect(onFailure).toHaveBeenCalledExactlyOnceWith(cause);
      expect(fail).toHaveBeenCalledExactlyOnceWith(cause);
      expect(h.suspendSelf).toHaveBeenCalledTimes(phase === 'suspend' ? 0 : 1);
      await control.released;
      let finished = false;
      const done = terminal.finish().then(() => {
        finished = true;
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(finished, 'CURSOR_WRITE_REFUSAL_RETAINS_TERMINAL_RELEASE').toBe(false);
      expect(f.registry.activeOwners).toBe(1);
      h.fireSuspend();
      h.fireContinue();
      expect(onFailure).toHaveBeenCalledOnce();
      release();
      await done;
      expect(f.registry.activeOwners).toBe(0);
      expect(captured.out()).toBe(SHOW_CURSOR + SHOW_CURSOR);
    },
  );

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

  it('observes the original failed self-stop before recovery can reattach', () => {
    const h = harness();
    const cause = new TypeError('private self-stop fault');
    h.suspendSelf.mockImplementation(() => {
      throw cause;
    });
    const observed: unknown[] = [];
    const jc = wireRunJobControl({
      write: h.write,
      lifecycle: h.lifecycle,
      onFailure: (original) => {
        observed.push(original);
        expect(h.attaches()).toBe(1);
        jc.dispose();
      },
    });
    h.fireSuspend();
    expect(observed).toEqual([cause]);
    expect(h.attaches()).toBe(1);
    h.fireSuspend();
    h.fireContinue();
    expect(h.suspendSelf).toHaveBeenCalledTimes(1);
    expect(h.out()).toBe(SHOW_CURSOR);
    expect(h.removeSuspend).toHaveBeenCalledTimes(1);
    expect(h.removeContinue).toHaveBeenCalledTimes(1);
  });

  it('preserves ownerless reversible recovery after a self-stop refusal', () => {
    const h = harness();
    h.suspendSelf.mockImplementationOnce(() => {
      throw new Error('self-stop refused');
    });
    const jc = wireRunJobControl({ write: h.write, lifecycle: h.lifecycle });
    try {
      h.fireSuspend();
      expect(h.attaches()).toBe(2);
      h.fireSuspend();
      expect(h.suspendSelf).toHaveBeenCalledTimes(2);
      h.fireContinue();
      expect(h.out()).toBe(SHOW_CURSOR + SHOW_CURSOR + HIDE_CURSOR);
    } finally {
      jc.dispose();
    }
    expect(h.removeSuspend).toHaveBeenCalledTimes(3);
    expect(h.removeContinue).toHaveBeenCalledTimes(1);
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

  it('releases the first listener when registering the second listener fails', () => {
    const h = harness();
    const lifecycle = {
      ...h.lifecycle,
      onContinue: () => {
        throw new Error('continue registration failed');
      },
    };
    expect(() => wireRunJobControl({ write: h.write, lifecycle })).toThrow(
      'continue registration failed',
    );
    expect(h.removeSuspend).toHaveBeenCalledTimes(1);
  });

  it('attempts both removals and retires callbacks when one removal fails', () => {
    const h = harness();
    h.removeSuspend.mockImplementationOnce(() => {
      throw new Error('suspend removal failed');
    });
    const jc = wireRunJobControl({ write: h.write, lifecycle: h.lifecycle });
    try {
      jc.dispose();
      expect.unreachable('The failed native removal must remain classified.');
    } catch (error) {
      expect(error).toMatchObject({
        code: 'cli_internal',
        exitCode: 9,
        cause: { message: 'suspend removal failed' },
      });
    }
    expect(h.removeContinue).toHaveBeenCalledTimes(1);
    h.fireContinue();
    h.fireSuspend();
    expect(h.out()).toBe('');
    expect(h.suspendSelf).not.toHaveBeenCalled();
    expect(() => jc.dispose()).not.toThrow();
    expect(h.removeSuspend).toHaveBeenCalledTimes(2);
    expect(h.removeContinue).toHaveBeenCalledTimes(1);
  });
});
