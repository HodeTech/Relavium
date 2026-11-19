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

  it('a command request whose admitted flag is ABSENT is not pre-approved: auto asks', async () => {
    const r = rig('auto');
    await r.confirm(
      {
        toolId: 'run_command',
        action: 'process',
        preview: { command: 'ls -la' },
        argv: ['ls', '-la'],
      },
      undefined,
      undefined,
    );
    expect(r.asked()).toBe(1);
  });

  it.each([false, true])(
    'a command request that does not carry its argv asks, even with commandAdmitted %s: it cannot be judged pre-approved',
    async (admitted) => {
      const r = rig('auto');
      const request: ToolApprovalRequest = {
        toolId: 'run_command',
        action: 'process',
        preview: { command: 'rm -rf x' },
        commandAdmitted: admitted,
      };
      await r.confirm(request, undefined, undefined);
      expect(r.asked()).toBe(1);
    },
  );

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

  it('a command card never offers a session answer over a preview that shows nothing (all redaction markers)', async () => {
    const r = rig('ask', { sessionGrants: true });
    await r.confirm(
      {
        toolId: 'run_command',
        action: 'process',
        preview: { command: '[redacted]' },
        unredactedPreview: { command: 'secret-token' },
        argv: ['secret-token'],
        commandAdmitted: false,
      },
      undefined,
      undefined,
    );
    expect(r.lastCacheable()).toBe(false);
    await r.confirm(command(LS, false), undefined, undefined);
    expect(r.lastCacheable(), 'a readable preview is offered it').toBe(true);
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

describe('the command card: facts, offers and the Remember answer (ADR-0118 §1, §2)', () => {
  const PROJECT = '/work/project';

  /** A rig whose prompt records the facts it was given and answers as told. */
  function cardRig(options: {
    readonly mode?: ChatMode;
    readonly answer: ApprovalAnswer;
    readonly store?: {
      readonly matches?: (argv: readonly string[]) => boolean;
      readonly canRemember?: () => { readonly ok: boolean };
      readonly remember?: (
        argv: readonly string[],
      ) => Promise<{ readonly ok: boolean; readonly reason?: string }>;
    };
    readonly sessionGrants?: boolean;
  }) {
    const cache = new ApprovalCache();
    const notes: string[] = [];
    const prompt = vi.fn<ApprovalPrompt>(() => Promise.resolve(options.answer));
    const policy = buildTurnPolicy(options.mode ?? 'ask', {
      governed: new Set(['run_command']),
      prompt,
      cache,
      commandSessionGrants: options.sessionGrants ?? true,
      commandCwd: PROJECT,
      notify: (message) => notes.push(message),
      ...(options.store === undefined
        ? {}
        : {
            commandGrants: {
              matches: options.store.matches ?? (() => false),
              ...(options.store.canRemember === undefined
                ? {}
                : { canRemember: options.store.canRemember }),
              ...(options.store.remember === undefined ? {} : { remember: options.store.remember }),
            },
          }),
    });
    if (policy.confirm === undefined) throw new Error('a policy always has a confirm hook');
    return { confirm: policy.confirm, prompt, cache, notes };
  }
  const writable = { canRemember: () => ({ ok: true }) };
  const asked = (r: ReturnType<typeof cardRig>) => r.prompt.mock.calls[0]?.[4];

  it('gives the card its facts: standing, directory, and the answers it may offer', async () => {
    const r = cardRig({
      answer: { outcome: 'approve', scope: 'once' },
      store: { ...writable, remember: () => Promise.resolve({ ok: true }) },
    });
    await r.confirm(command(['npm', 'test'], false), undefined, undefined);
    expect(asked(r)).toEqual({
      standing: 'not-pre-approved',
      runsCode: false,
      protectedPath: false,
      cwd: PROJECT,
      offers: { session: true, remember: true },
    });
    expect(r.prompt.mock.calls[0]?.[1], 'the cacheable flag is the session offer').toBe(true);
  });

  it.each([
    [{ commandAdmitted: true }, 'allowlisted'],
    [{ remembered: true }, 'remembered'],
  ] as const)('says %j as the standing %s', async (change, standing) => {
    const r = cardRig({
      answer: { outcome: 'approve', scope: 'once' },
      store: { matches: () => 'remembered' in change },
    });
    await r.confirm(command(['npm', 'test'], 'commandAdmitted' in change), undefined, undefined);
    expect(asked(r)?.standing).toBe(standing);
  });

  it('Remember writes the grant for this exact argv, then behaves as Session: the same command does not ask again', async () => {
    const remember = vi.fn(() => Promise.resolve({ ok: true }));
    const r = cardRig({
      answer: { outcome: 'approve', scope: 'remember' },
      store: { ...writable, remember },
    });
    const decision = await r.confirm(command(['npm', 'test'], false), undefined, undefined);
    expect(remember).toHaveBeenCalledExactlyOnceWith(['npm', 'test']);
    if (decision.outcome !== 'approve') throw new Error('expected an approval');
    decision.onDispatchSucceeded?.();
    expect(r.cache.isAlwaysCommand(['npm', 'test'])).toBe(true);
    expect(await r.confirm(command(['npm', 'test'], false), undefined, undefined)).toEqual({
      outcome: 'approve',
    });
    expect(r.prompt).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['no-key', 'the OS keychain is not available'],
    ['unwritable', 'could not be written'],
    ['full', 'is full'],
    ['unreadable', 'could not be read'],
    [undefined, 'it could not be written'],
  ])(
    'a Remember that cannot be written (%s) approves this call once and says why, without the command',
    async (reason, phrase) => {
      const r = cardRig({
        answer: { outcome: 'approve', scope: 'remember' },
        store: {
          ...writable,
          remember: () =>
            Promise.resolve({ ok: false, ...(reason === undefined ? {} : { reason }) }),
        },
      });
      const decision = await r.confirm(
        command(['npm', 'test', 'SECRET-ARG'], false),
        undefined,
        undefined,
      );
      expect(decision.outcome).toBe('approve');
      if (decision.outcome === 'approve') decision.onDispatchSucceeded?.();
      expect(
        r.cache.isAlwaysCommand(['npm', 'test', 'SECRET-ARG']),
        'a failed Remember is not a Session either',
      ).toBe(false);
      expect(r.notes).toHaveLength(1);
      expect(r.notes[0]).toContain(phrase);
      expect(r.notes[0]).not.toContain('SECRET-ARG');
    },
  );

  it('Remember is not offered without a store that can write, for a code carrier, or for a protected path; an answer that was not offered is Once', async () => {
    const remember = vi.fn(() => Promise.resolve({ ok: true }));
    const cases: readonly {
      argv: readonly string[];
      store: NonNullable<Parameters<typeof cardRig>[0]['store']>;
      offers: unknown;
    }[] = [
      {
        argv: ['npm', 'test'],
        store: { matches: () => false },
        offers: { session: true, remember: false },
      },
      {
        argv: ['npm', 'test'],
        store: { canRemember: () => ({ ok: false }), remember },
        offers: { session: true, remember: false },
      },
      {
        argv: ['bash', '-c', 'make'],
        store: { ...writable, remember },
        offers: { session: true, remember: false },
      },
      {
        argv: ['cat', '.env'],
        store: { ...writable, remember },
        offers: { session: false, remember: false },
      },
    ];
    for (const item of cases) {
      const r = cardRig({ answer: { outcome: 'approve', scope: 'remember' }, store: item.store });
      const decision = await r.confirm(command(item.argv, false), undefined, undefined);
      expect(asked(r)?.offers).toEqual(item.offers);
      if (decision.outcome === 'approve') decision.onDispatchSucceeded?.();
      expect(r.cache.isAlwaysCommand(item.argv)).toBe(false);
    }
    expect(remember, 'nothing was written for any of them').not.toHaveBeenCalled();
  });

  it('a Session answer to a card that did not offer it is Once: a protected path is answered once only', async () => {
    const r = cardRig({ answer: { outcome: 'approve', scope: 'always' } });
    const decision = await r.confirm(command(['cat', '.env'], false), undefined, undefined);
    expect(asked(r)?.protectedPath).toBe(true);
    if (decision.outcome === 'approve') decision.onDispatchSucceeded?.();
    expect(r.cache.isAlwaysCommand(['cat', '.env'])).toBe(false);
  });

  it('a code carrier is answered Once or Session, and says so', async () => {
    const r = cardRig({
      answer: { outcome: 'approve', scope: 'always' },
      store: { ...writable, remember: () => Promise.resolve({ ok: true }) },
    });
    const decision = await r.confirm(
      command(['env', 'FOO=1', 'make'], false),
      undefined,
      undefined,
    );
    expect(asked(r)?.runsCode).toBe(true);
    if (decision.outcome === 'approve') decision.onDispatchSucceeded?.();
    expect(r.cache.isAlwaysCommand(['env', 'FOO=1', 'make'])).toBe(true);
  });

  it('a denial is a denial: nothing is written and nothing is remembered', async () => {
    const remember = vi.fn(() => Promise.resolve({ ok: true }));
    const r = cardRig({
      answer: { outcome: 'reject', reason: 'no' },
      store: { ...writable, remember },
    });
    expect(await r.confirm(command(['npm', 'test'], false), undefined, undefined)).toEqual({
      outcome: 'reject',
      reason: 'no',
    });
    expect(remember).not.toHaveBeenCalled();
  });

  it('with the session offer off the card offers neither Session nor Remember', async () => {
    const r = cardRig({
      answer: { outcome: 'approve', scope: 'once' },
      sessionGrants: false,
      store: { ...writable, remember: () => Promise.resolve({ ok: true }) },
    });
    await r.confirm(command(['npm', 'test'], false), undefined, undefined);
    expect(asked(r)?.offers).toEqual({ session: false, remember: false });
  });

  it('auto asks for an unknown command with the same facts, and Remember there also writes the grant', async () => {
    const remember = vi.fn(() => Promise.resolve({ ok: true }));
    const r = cardRig({
      mode: 'auto',
      answer: { outcome: 'approve', scope: 'remember' },
      store: { ...writable, remember },
    });
    await r.confirm(command(['npm', 'test'], false), undefined, undefined);
    expect(asked(r)?.offers.remember).toBe(true);
    expect(remember).toHaveBeenCalledOnce();
  });
});
