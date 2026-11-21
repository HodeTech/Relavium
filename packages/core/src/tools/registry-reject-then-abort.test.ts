import { describe, expect, it } from 'vitest';

import { BUILTIN_TOOLS, BUILTIN_TOOL_IDS } from './builtins.js';
import { ToolCancelledError, ToolDeniedByUserError } from './errors.js';
import { createToolRegistry } from './registry.js';
import type { ToolApprovalDecision, ToolCallPart, ToolDispatchContext, ToolHost } from './types.js';
import { createInMemoryEffectJournal } from '../engine/execution-host.js';

/**
 * ADR-0115 §2: the CLI settles a pending approval as a user REJECTION and then signals the turn's abort, both in one synchronous
 * stack. The decision was made before any effect was admitted, so the call must be recorded as denied by the person, not as
 * cancelled ("execution state unknown"). The cancel precedence an APPROVE needs is not touched: an approval that resolves after
 * the signal aborted still cancels.
 */
function hostThatCounts(): { readonly host: ToolHost; readonly spawned: () => number } {
  let spawned = 0;
  const host = {
    process: {
      spawn: () => {
        spawned += 1;
        return Promise.resolve({ exitCode: 0, stdout: 'ok', stderr: '', durationMs: 1 });
      },
    },
  } as unknown as ToolHost;
  return { host, spawned: () => spawned };
}

const CALL: ToolCallPart = {
  type: 'tool_call',
  id: 'c1',
  name: 'run_command',
  args: { command: 'ls', args: ['-la'] },
};

function context(
  confirm: NonNullable<ToolDispatchContext['approval']>['confirm'],
  signal: AbortSignal,
): ToolDispatchContext {
  return {
    nodeId: 'n1',
    grantedToolIds: new Set(BUILTIN_TOOL_IDS),
    config: {},
    toolPolicy: { allowedCommands: ['ls -la'] },
    fsScope: 'sandboxed',
    gateApproved: false,
    effects: createInMemoryEffectJournal({ kind: 'run', runId: 'r', nodeId: 'n1', attempt: 1 }),
    effectSlot: 0,
    approval: { confirm },
    signal,
  } as ToolDispatchContext;
}

/** A confirm hook the "person" answers later: it settles with `decision` and, if asked, aborts in the same synchronous stack. */
function answeredLater(
  decision: ToolApprovalDecision,
  abortToo: boolean,
  controller: AbortController,
) {
  return () =>
    new Promise<ToolApprovalDecision>((resolve) => {
      setTimeout(() => {
        resolve(decision);
        if (abortToo) controller.abort();
      }, 1);
    });
}

async function dispatchOutcome(
  decision: ToolApprovalDecision,
  abortToo: boolean,
): Promise<{ readonly error: unknown; readonly spawned: number }> {
  const controller = new AbortController();
  const { host, spawned } = hostThatCounts();
  try {
    await createToolRegistry({ tools: BUILTIN_TOOLS, host }).dispatch(
      CALL,
      context(answeredLater(decision, abortToo, controller), controller.signal),
    );
    return { error: undefined, spawned: spawned() };
  } catch (error) {
    return { error, spawned: spawned() };
  }
}

describe('a rejection followed at once by an abort is a denial, not a cancellation (ADR-0115 §2)', () => {
  it('control: a rejection with no abort is a user denial and nothing runs', async () => {
    const { error, spawned } = await dispatchOutcome({ outcome: 'reject' }, false);
    expect(error).toBeInstanceOf(ToolDeniedByUserError);
    expect(spawned).toBe(0);
  });

  it('a rejection settled and then aborted in the same tick is still the person’s denial, and nothing runs', async () => {
    const { error, spawned } = await dispatchOutcome({ outcome: 'reject' }, true);
    expect(error, 'recorded as denied by the person, not as cancelled').toBeInstanceOf(
      ToolDeniedByUserError,
    );
    expect(error).not.toBeInstanceOf(ToolCancelledError);
    expect((error as ToolDeniedByUserError).reason).toBe('user_rejected');
    expect(spawned, 'the tool never ran').toBe(0);
  });

  it('a rejection with the person’s reason keeps its explanation through the abort', async () => {
    const { error } = await dispatchOutcome({ outcome: 'reject', reason: 'not this one' }, true);
    expect(error).toBeInstanceOf(ToolDeniedByUserError);
    expect((error as ToolDeniedByUserError).explanation).toBe('not this one');
  });

  it('an APPROVAL that resolves after the abort still cancels and runs nothing: the cancel precedence an approve needs is untouched', async () => {
    const { error, spawned } = await dispatchOutcome({ outcome: 'approve' }, true);
    expect(error).toBeInstanceOf(ToolCancelledError);
    expect(spawned).toBe(0);
  });

  describe('what the exception does NOT cover', () => {
    const approveNow = () => Promise.resolve<ToolApprovalDecision>({ outcome: 'approve' });

    it('once the effect slot has been admitted (a journaled tool), a refusal followed by an abort is a cancellation: the exception is for decisions made before any effect', async () => {
      const controller = new AbortController();
      const { host, spawned } = hostThatCounts();
      const ctx = {
        ...context(approveNow, controller.signal),
        beforeDispatch: () => {
          controller.abort();
          throw new ToolDeniedByUserError('run_command', 'user_rejected', 'revoked', {
            fatal: true,
          });
        },
      } as ToolDispatchContext;
      const error: unknown = await createToolRegistry({ tools: BUILTIN_TOOLS, host })
        .dispatch(CALL, ctx)
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ToolCancelledError);
      expect(spawned()).toBe(0);
    });

    it('only a decided rejection is exempt: a wiring-fault refusal (no_approval_hook) followed by an abort is still a cancellation', async () => {
      const controller = new AbortController();
      const { host } = hostThatCounts();
      const ctx = {
        ...context(approveNow, controller.signal),
        beforeDispatch: () => {
          controller.abort();
          throw new ToolDeniedByUserError('run_command', 'no_approval_hook', 'no hook');
        },
      } as ToolDispatchContext;
      const error: unknown = await createToolRegistry({ tools: BUILTIN_TOOLS, host })
        .dispatch(CALL, ctx)
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ToolCancelledError);
    });

    it('a refusal thrown from INSIDE the tool, once it has been handed the call, is still a cancellation after an abort: the exception is for decisions made before the tool runs', async () => {
      const controller = new AbortController();
      const host = {
        process: {
          spawn: () => {
            controller.abort();
            return Promise.reject(
              new ToolDeniedByUserError('run_command', 'user_rejected', 'from inside'),
            );
          },
        },
      } as unknown as ToolHost;
      const error: unknown = await createToolRegistry({ tools: BUILTIN_TOOLS, host })
        .dispatch(CALL, context(approveNow, controller.signal))
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ToolCancelledError);
    });
  });
});
