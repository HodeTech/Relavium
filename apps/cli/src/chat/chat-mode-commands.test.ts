import type { ToolApprovalLiveContext, ToolApprovalRequest } from '@relavium/core';
import { describe, expect, it, vi } from 'vitest';

import {
  ApprovalCache,
  buildTurnPolicy,
  nonInteractiveApprovalPrompt,
  type ApprovalAnswer,
  type ApprovalPrompt,
} from './chat-mode.js';
import type { ChatMode } from '@relavium/shared';

/**
 * ADR-0118 §1's table for commands, row by row, through the real mode policy: what each mode does with a command that the allowlist
 * admitted, that a remembered grant covers, that was approved earlier this session, and with anything else.
 */
function command(argv: readonly string[], commandAdmitted: boolean): ToolApprovalRequest {
  return {
    toolId: 'run_command',
    action: 'process',
    preview: { command: argv.join(' ') },
    unredactedPreview: { command: argv.join(' ') },
    argv,
    commandAdmitted,
  };
}

interface Rig {
  readonly confirm: NonNullable<ReturnType<typeof buildTurnPolicy>['confirm']>;
  readonly prompt: ReturnType<typeof vi.fn>;
  readonly cache: ApprovalCache;
  readonly asked: () => number;
  readonly lastCacheable: () => boolean | undefined;
}

function rig(
  mode: ChatMode,
  options: {
    readonly remembered?: readonly (readonly string[])[];
    readonly answer?: ApprovalAnswer;
    readonly sessionGrants?: boolean;
    readonly canAsk?: boolean;
  } = {},
): Rig {
  const cache = new ApprovalCache();
  let cacheable: boolean | undefined;
  const prompt = vi.fn<ApprovalPrompt>((_request, isCacheable) => {
    cacheable = isCacheable;
    return Promise.resolve(options.answer ?? { outcome: 'approve', scope: 'once' });
  });
  const remembered = new Set((options.remembered ?? []).map((argv) => JSON.stringify(argv)));
  const policy = buildTurnPolicy(mode, {
    governed: new Set(['run_command']),
    prompt: options.canAsk === false ? nonInteractiveApprovalPrompt('here') : prompt,
    cache,
    commandGrants: { matches: (argv) => remembered.has(JSON.stringify(argv)) },
    ...(options.sessionGrants === undefined ? {} : { commandSessionGrants: options.sessionGrants }),
    ...(options.canAsk === undefined ? {} : { canAsk: options.canAsk }),
  });
  if (policy.confirm === undefined) throw new Error('a policy always has a confirm hook');
  return {
    confirm: policy.confirm,
    prompt,
    cache,
    asked: () => prompt.mock.calls.length,
    lastCacheable: () => cacheable,
  };
}

const LS = ['ls', '-la'] as const;

describe('ask and accept-edits keep asking for a command, however pre-approved (ADR-0118 §1)', () => {
  it.each<ChatMode>(['ask', 'accept-edits'])(
    '%s: an allowlisted command still shows a card',
    async (mode) => {
      const r = rig(mode);
      expect(await r.confirm(command(LS, true), undefined, undefined)).toEqual({
        outcome: 'approve',
      });
      expect(r.asked(), 'an allowlist removes the unknown, not the person’s per-call consent').toBe(
        1,
      );
    },
  );

  it.each<ChatMode>(['ask', 'accept-edits'])(
    '%s: a REMEMBERED command still shows a card',
    async (mode) => {
      const r = rig(mode, { remembered: [LS] });
      await r.confirm(command(LS, false), undefined, undefined);
      expect(r.asked()).toBe(1);
    },
  );

  it.each<ChatMode>(['ask', 'accept-edits'])(
    '%s: anything else shows a card, and a rejection is final for the call',
    async (mode) => {
      const r = rig(mode, { answer: { outcome: 'reject', reason: 'no' } });
      expect(await r.confirm(command(LS, false), undefined, undefined)).toEqual({
        outcome: 'reject',
        reason: 'no',
      });
      expect(r.asked()).toBe(1);
    },
  );

  it.each<ChatMode>(['ask', 'accept-edits'])(
    '%s: an exact argv approved earlier this session runs without a card',
    async (mode) => {
      const r = rig(mode);
      r.cache.rememberAlwaysCommand(LS);
      expect(await r.confirm(command(LS, false), undefined, undefined)).toEqual({
        outcome: 'approve',
      });
      expect(r.asked()).toBe(0);
      // ...and only that argv: another command, even a longer one, still asks.
      await r.confirm(command(['ls', '-la', '/'], false), undefined, undefined);
      expect(r.asked()).toBe(1);
    },
  );
});

describe('plan refuses a command with the mode’s fixed text, which returns to the model (ADR-0117)', () => {
  it('whatever its standing', async () => {
    const r = rig('plan', { remembered: [LS] });
    for (const admitted of [true, false]) {
      expect(await r.confirm(command(LS, admitted), undefined, undefined)).toEqual({
        outcome: 'reject',
        denialClass: 'mode',
        reason: 'plan mode is read-only',
      });
    }
    expect(r.asked()).toBe(0);
  });
});

describe('auto has a hard edge: only a pre-approved command runs without a card (ADR-0118 §1)', () => {
  it('an allowlisted command runs', async () => {
    const r = rig('auto');
    expect(await r.confirm(command(LS, true), undefined, undefined)).toEqual({
      outcome: 'approve',
    });
    expect(r.asked()).toBe(0);
  });

  it('a remembered command runs', async () => {
    const r = rig('auto', { remembered: [LS] });
    expect(await r.confirm(command(LS, false), undefined, undefined)).toEqual({
      outcome: 'approve',
    });
    expect(r.asked()).toBe(0);
  });

  it('a command approved earlier this session runs', async () => {
    const r = rig('auto');
    r.cache.rememberAlwaysCommand(LS);
    await r.confirm(command(LS, false), undefined, undefined);
    expect(r.asked()).toBe(0);
  });

  it('anything else asks, and a rejection refuses it', async () => {
    const r = rig('auto', { answer: { outcome: 'reject' } });
    expect(await r.confirm(command(LS, false), undefined, undefined)).toEqual({
      outcome: 'reject',
    });
    expect(r.asked()).toBe(1);
  });

  it('a remembered grant for ANOTHER argv does not cover this one (an exact match, never a prefix)', async () => {
    const r = rig('auto', { remembered: [['npm', 'test']] });
    await r.confirm(command(['npm', 'test', '--', '--exec=x'], false), undefined, undefined);
    expect(r.asked()).toBe(1);
  });

  it('a non-command governed action keeps auto’s old rule: it is approved', async () => {
    const r = rig('auto');
    const request: ToolApprovalRequest = {
      toolId: 'write_file',
      action: 'fs_write',
      preview: { path: 'x.txt' },
    };
    expect(await r.confirm(request, undefined, undefined)).toEqual({ outcome: 'approve' });
  });
});

describe('the session cache is keyed by the exact argv, never by tool id (ADR-0118 §2)', () => {
  it('an “always” answer approves that argv only, and never the tool', async () => {
    const r = rig('ask', { answer: { outcome: 'approve', scope: 'always' }, sessionGrants: true });
    const decision = await r.confirm(command(['cat', 'a b'], false), undefined, undefined);
    expect(r.lastCacheable()).toBe(true);
    expect(decision.outcome).toBe('approve');
    // Not remembered until the dispatch SUCCEEDED (the engine calls this after a real, successful, non-replay call).
    expect(r.cache.isAlwaysCommand(['cat', 'a b'])).toBe(false);
    if (decision.outcome === 'approve') decision.onDispatchSucceeded?.();
    expect(r.cache.isAlwaysCommand(['cat', 'a b'])).toBe(true);
    expect(r.cache.isAlwaysCommand(['cat', 'a', 'b']), 'one argument with a space is not two').toBe(
      false,
    );
    expect(r.cache.isAlwaysCommand(['cat']), 'nor a prefix').toBe(false);
    expect(r.cache.isAlways('run_command'), 'and the TOOL is never approved for the session').toBe(
      false,
    );
  });

  it('while the command card does not word “this exact command”, no session answer is offered or kept', async () => {
    const r = rig('ask', { answer: { outcome: 'approve', scope: 'always' } }); // commandSessionGrants off
    const decision = await r.confirm(command(LS, false), undefined, undefined);
    expect(r.lastCacheable()).toBe(false);
    expect(decision.outcome).toBe('approve');
    if (decision.outcome === 'approve') decision.onDispatchSucceeded?.();
    expect(r.cache.isAlwaysCommand(LS)).toBe(false);
  });

  it('a delivered saved result is never remembered for the session', async () => {
    const r = rig('ask', { answer: { outcome: 'approve', scope: 'always' }, sessionGrants: true });
    const live = {
      callId: 'c',
      preview: { kind: 'saved-result' },
    } as unknown as ToolApprovalLiveContext;
    await r.confirm(command(LS, false), undefined, live);
    expect(r.lastCacheable()).toBe(false);
  });

  it('a process request with no argv (hand-built) is asked, and remembered by nothing', async () => {
    const r = rig('ask', { answer: { outcome: 'approve', scope: 'always' }, sessionGrants: true });
    const request: ToolApprovalRequest = {
      toolId: 'run_command',
      action: 'process',
      preview: { command: 'ls' },
    };
    const decision = await r.confirm(request, undefined, undefined);
    expect(decision.outcome).toBe('approve');
    if (decision.outcome === 'approve') decision.onDispatchSucceeded?.();
    expect(r.cache.isAlways('run_command')).toBe(false);
  });
});

describe('with no one to ask, nothing runs without a card, in any mode (ADR-0118 §1, headless)', () => {
  it.each<ChatMode>(['ask', 'accept-edits', 'auto'])(
    '%s degrades to a refusal that says it is unavailable',
    async (mode) => {
      const r = rig(mode, { canAsk: false, remembered: [LS] });
      const decision = await r.confirm(command(LS, true), undefined, undefined);
      expect(decision).toMatchObject({ outcome: 'reject', denialClass: 'unavailable' });
    },
  );
});
