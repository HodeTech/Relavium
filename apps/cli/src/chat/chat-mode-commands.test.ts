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
import type { CommandCardFacts } from './command-facts.js';

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
  readonly facts: () => CommandCardFacts | undefined;
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
    facts: () => prompt.mock.calls.at(-1)?.[4],
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

describe('auto has a hard edge: only a command the OPERATOR pre-approved runs without a card (ADR-0118 §1, round 2 ruling)', () => {
  it('an allowlisted command still shows a card: the list is the repository’s file, not the operator’s consent', async () => {
    const r = rig('auto');
    expect(await r.confirm(command(LS, true), undefined, undefined)).toEqual({
      outcome: 'approve',
    });
    expect(r.asked()).toBe(1);
    expect(r.facts()?.standing).toBe('allowlisted');
  });

  it('a command that is allowlisted AND remembered runs: the remembered grant is the operator’s', async () => {
    const r = rig('auto', { remembered: [LS] });
    await r.confirm(command(LS, true), undefined, undefined);
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

  describe('after the session approved a file write (the security sitting’s ruling on ADR-0118 §2)', () => {
    const WRITE: ToolApprovalRequest = {
      toolId: 'write_file',
      action: 'fs_write',
      preview: { path: 'package.json' },
    };

    it('a REMEMBERED command asks once, and the card says why', async () => {
      const r = rig('auto', { remembered: [LS] });
      await r.confirm(WRITE, undefined, undefined);
      expect(r.cache.wrote).toBe(true);
      await r.confirm(command(LS, false), undefined, undefined);
      expect(r.asked()).toBe(1);
      expect(r.facts()).toMatchObject({ standing: 'remembered', filesChanged: true });
    });

    it('before any write it runs unasked, and answering Session after the write ends the asking', async () => {
      const r = rig('auto', {
        remembered: [LS],
        answer: { outcome: 'approve', scope: 'always' },
        sessionGrants: true,
      });
      await r.confirm(command(LS, false), undefined, undefined);
      expect(r.asked()).toBe(0);
      await r.confirm(WRITE, undefined, undefined);
      const decision = await r.confirm(command(LS, false), undefined, undefined);
      expect(r.asked()).toBe(1);
      if (decision.outcome !== 'approve') throw new Error('expected an approval');
      decision.onDispatchSucceeded?.();
      await r.confirm(command(LS, false), undefined, undefined);
      expect(r.asked(), 'the session approval the person gave covers it from here on').toBe(1);
    });

    it('a session approval is not affected by a write: the person gave it knowingly', async () => {
      const r = rig('auto');
      r.cache.rememberAlwaysCommand(LS);
      await r.confirm(WRITE, undefined, undefined);
      await r.confirm(command(LS, false), undefined, undefined);
      expect(r.asked()).toBe(0);
    });

    it('a write that was refused does not count, and a plan-mode refusal does not either', async () => {
      const refused = rig('ask', { answer: { outcome: 'reject' } });
      await refused.confirm(WRITE, undefined, undefined);
      expect(refused.cache.wrote).toBe(false);
      const plan = rig('plan');
      await plan.confirm(WRITE, undefined, undefined);
      expect(plan.cache.wrote).toBe(false);
    });

    it('a write accepted in accept-edits counts for a later auto turn of the same session', async () => {
      const cache = new ApprovalCache();
      const edits = buildTurnPolicy('accept-edits', {
        governed: new Set(['run_command', 'write_file']),
        prompt: vi.fn<ApprovalPrompt>(() => Promise.resolve({ outcome: 'reject' })),
        cache,
      });
      await edits.confirm?.(WRITE, undefined, undefined);
      expect(cache.wrote).toBe(true);
    });
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
      filesChanged: false,
      grantOutdated: false,
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

describe('the command card hook, round 1 test review: what reaches the prompt and what a Remember is linked to', () => {
  const store = (
    overrides: {
      remember?: () => Promise<{ ok: boolean; reason?: string; id?: string }>;
      canRemember?: () => { ok: boolean };
    } = {},
  ) => ({
    matches: () => false,
    canRemember: overrides.canRemember ?? (() => ({ ok: true })),
    remember: overrides.remember ?? (() => Promise.resolve({ ok: true, id: 'grant-7' })),
  });
  function make(
    answer: ApprovalAnswer,
    grants: ReturnType<typeof store> | { matches: () => boolean },
  ) {
    const cache = new ApprovalCache();
    const prompt = vi.fn<ApprovalPrompt>(() => Promise.resolve(answer));
    const policy = buildTurnPolicy('ask', {
      governed: new Set(['run_command']),
      prompt,
      cache,
      commandSessionGrants: true,
      commandCwd: '/work/project',
      commandGrants: grants,
    });
    return { confirm: policy.confirm!, prompt, cache };
  }

  it('hands the prompt the abort signal and the live preview it was given', async () => {
    const r = make({ outcome: 'approve', scope: 'once' }, store());
    const controller = new AbortController();
    const live = {
      callId: 'c',
      preview: { kind: 'operation', target: 'npm test', fields: [] },
    } as const;
    await r.confirm(command(['npm', 'test'], false), controller.signal, live);
    expect(r.prompt.mock.calls[0]?.[2]).toBe(controller.signal);
    expect(r.prompt.mock.calls[0]?.[3]).toBe(live);
  });

  it('Remember is not offered over a preview that shows nothing, or a delivered saved result', async () => {
    const blank = make({ outcome: 'approve', scope: 'remember' }, store());
    await blank.confirm(
      {
        toolId: 'run_command',
        action: 'process',
        preview: { command: '[redacted]' },
        argv: ['x'],
        commandAdmitted: false,
      },
      undefined,
      undefined,
    );
    expect(blank.prompt.mock.calls[0]?.[4]?.offers).toEqual({ session: false, remember: false });
    const saved = make({ outcome: 'approve', scope: 'remember' }, store());
    await saved.confirm(command(['npm', 'test'], false), undefined, {
      callId: 'c',
      preview: { kind: 'saved-result', fields: [] },
    });
    expect(saved.prompt.mock.calls[0]?.[4]?.offers).toEqual({ session: false, remember: false });
  });

  it('a store that cannot say it can write, or has no remember, never offers Remember', async () => {
    const noCheck = make(
      { outcome: 'approve', scope: 'once' },
      { matches: () => false, remember: () => Promise.resolve({ ok: true }) },
    );
    await noCheck.confirm(command(['npm', 'test'], false), undefined, undefined);
    expect(noCheck.prompt.mock.calls[0]?.[4]?.offers.remember).toBe(false);
    const noRemember = make(
      { outcome: 'approve', scope: 'once' },
      { matches: () => false, canRemember: () => ({ ok: true }) },
    );
    await noRemember.confirm(command(['npm', 'test'], false), undefined, undefined);
    expect(noRemember.prompt.mock.calls[0]?.[4]?.offers.remember).toBe(false);
  });

  it('a Remember is linked to its grant, so withdrawing the grant withdraws this chat’s session approval of it', async () => {
    const r = make({ outcome: 'approve', scope: 'remember' }, store());
    const decision = await r.confirm(command(['npm', 'test'], false), undefined, undefined);
    if (decision.outcome === 'approve') decision.onDispatchSucceeded?.();
    expect(r.cache.isAlwaysCommand(['npm', 'test'])).toBe(true);
    expect(r.cache.forgetCommandsByGrant('another-grant')).toBe(0);
    expect(r.cache.isAlwaysCommand(['npm', 'test'])).toBe(true);
    expect(r.cache.forgetCommandsByGrant('grant-7')).toBe(1);
    expect(r.cache.isAlwaysCommand(['npm', 'test']), 'it asks again now').toBe(false);
  });

  it('a plain Session answer is not linked to any grant: withdrawing a grant leaves it', async () => {
    const r = make({ outcome: 'approve', scope: 'always' }, store());
    const decision = await r.confirm(command(['npm', 'test'], false), undefined, undefined);
    if (decision.outcome === 'approve') decision.onDispatchSucceeded?.();
    expect(r.cache.forgetCommandsByGrant('grant-7')).toBe(0);
    expect(r.cache.isAlwaysCommand(['npm', 'test'])).toBe(true);
  });

  it('a remember answer on a card that is not a command’s caches nothing: it is only ever Once there', async () => {
    const cache = new ApprovalCache();
    const prompt = vi.fn<ApprovalPrompt>(() =>
      Promise.resolve<ApprovalAnswer>({ outcome: 'approve', scope: 'remember' }),
    );
    const policy = buildTurnPolicy('ask', { governed: new Set(['fs_write']), prompt, cache });
    const decision = await policy.confirm!(
      {
        toolId: 'write_file',
        action: 'fs_write',
        preview: { path: 'a.txt' },
        unredactedPreview: { path: 'a.txt' },
      },
      undefined,
      undefined,
    );
    if (decision.outcome === 'approve') decision.onDispatchSucceeded?.();
    expect(cache.isAlways('write_file')).toBe(false);
  });

  it('a success tells the person where it went and that auto will run it unasked', async () => {
    const notes: string[] = [];
    const cache = new ApprovalCache();
    const policy = buildTurnPolicy('ask', {
      governed: new Set(['run_command']),
      prompt: () => Promise.resolve<ApprovalAnswer>({ outcome: 'approve', scope: 'remember' }),
      cache,
      commandSessionGrants: true,
      commandGrants: store(),
      notify: (message) => notes.push(message),
    });
    await policy.confirm!(command(['npm', 'test'], false), undefined, undefined);
    expect(notes).toEqual([
      'Allowed now and remembered for this project. This chat will not ask about it again; later chats ask in ask mode and run it unasked in auto mode. /permissions lists it and takes it back.',
    ]);
  });
});

describe('a remembered grant that a recorded file write outdated, a listed command, and a protected path from the cwd (ADR-0138, PR #101 review)', () => {
  type Standing = 'none' | 'fresh' | 'stale';
  const TEST = ['npm', 'test'] as const;
  const WRITE: ToolApprovalRequest = {
    toolId: 'write_file',
    action: 'fs_write',
    preview: { path: 'a.txt' },
    unredactedPreview: { path: 'a.txt' },
  };

  function build(
    mode: ChatMode,
    options: {
      readonly standing?: (argv: readonly string[]) => Standing;
      readonly answer?: ApprovalAnswer;
      readonly cwd?: string;
    } = {},
  ) {
    const standing = options.standing ?? ((): Standing => 'none');
    const cache = new ApprovalCache();
    const remember = vi.fn((argv: readonly string[]) => {
      void argv;
      return Promise.resolve({ ok: true, id: 'grant-9' });
    });
    const noteFileWrite = vi.fn(() => true);
    const prompt = vi.fn<ApprovalPrompt>(() =>
      Promise.resolve(options.answer ?? { outcome: 'approve', scope: 'once' }),
    );
    const policy = buildTurnPolicy(mode, {
      governed: new Set(['run_command', 'fs_write']),
      prompt,
      cache,
      commandSessionGrants: true,
      commandCwd: options.cwd ?? '/work/project',
      commandGrants: {
        matches: (argv) => standing(argv) !== 'none',
        standing,
        noteFileWrite,
        canRemember: () => ({ ok: true }),
        remember,
      },
    });
    if (policy.confirm === undefined) throw new Error('a policy always has a confirm hook');
    return {
      confirm: policy.confirm,
      prompt,
      remember,
      noteFileWrite,
      cache,
      facts: () => prompt.mock.calls.at(-1)?.[4],
    };
  }

  it('auto: a grant that stands runs unasked; one a write outdated asks, and its card says why and offers to renew it', async () => {
    const fresh = build('auto', { standing: () => 'fresh' });
    expect(await fresh.confirm(command(TEST, false), undefined, undefined)).toEqual({
      outcome: 'approve',
    });
    expect(fresh.prompt).not.toHaveBeenCalled();

    const stale = build('auto', { standing: () => 'stale' });
    await stale.confirm(command(TEST, false), undefined, undefined);
    expect(stale.prompt).toHaveBeenCalledTimes(1);
    expect(stale.facts()).toMatchObject({
      standing: 'remembered',
      grantOutdated: true,
      offers: { session: true, remember: true },
    });
  });

  it('ask and accept-edits ask about a command whatever the standing, so an outdated grant changes nothing there', async () => {
    for (const mode of ['ask', 'accept-edits'] as const) {
      for (const standing of ['none', 'fresh', 'stale'] as const) {
        const r = build(mode, { standing: () => standing });
        await r.confirm(command(TEST, false), undefined, undefined);
        expect(r.prompt, `${mode} ${standing}`).toHaveBeenCalledTimes(1);
      }
    }
  });

  it('Remember on an outdated grant renews it (the store is asked to remember again) and the chat stops asking, like any Remember', async () => {
    const r = build('auto', {
      standing: () => 'stale',
      answer: { outcome: 'approve', scope: 'remember' },
    });
    const decision = await r.confirm(command(TEST, false), undefined, undefined);
    expect(decision).toMatchObject({ outcome: 'approve' });
    expect(r.remember).toHaveBeenCalledTimes(1);
    expect(r.remember).toHaveBeenCalledWith(TEST);
    // The session approval a Remember leaves is committed once the call has really run.
    if (decision.outcome === 'approve') decision.onDispatchSucceeded?.();
    expect(r.cache.isAlwaysCommand(TEST)).toBe(true);
    await r.confirm(command(TEST, false), undefined, undefined);
    expect(r.prompt).toHaveBeenCalledTimes(1); // the second call needed no card
  });

  it('a listed command is offered Remember, and the grant it writes is the person’s own: auto does not run a listed command unasked', async () => {
    const r = build('auto', { answer: { outcome: 'approve', scope: 'remember' } });
    await r.confirm(command(LS, true), undefined, undefined);
    expect(r.facts()).toMatchObject({ standing: 'allowlisted', offers: { remember: true } });
    expect(r.remember).toHaveBeenCalledWith(LS);
    // Without a grant a listed command asks in auto, every time.
    const plain = build('auto');
    await plain.confirm(command(LS, true), undefined, undefined);
    await plain.confirm(command(LS, true), undefined, undefined);
    expect(plain.prompt).toHaveBeenCalledTimes(2);
  });

  it('a listed AND remembered command that a write has since changed says why it asks: the person’s grant is the standing on the card', async () => {
    const r = build('auto', { standing: () => 'stale' });
    await r.confirm(command(TEST, true), undefined, undefined);
    expect(r.facts()).toMatchObject({ standing: 'remembered', grantOutdated: true });
    const afterWrite = build('auto', { standing: () => 'fresh' });
    await afterWrite.confirm(WRITE, undefined, undefined); // auto approves the write
    await afterWrite.confirm(command(TEST, true), undefined, undefined);
    expect(afterWrite.facts()).toMatchObject({ standing: 'remembered', filesChanged: true });
  });

  it('a grant does not run an argument that reaches a protected path from the directory this chat runs in: `cat id_rsa` from ~/.ssh asks', async () => {
    const argv = ['cat', 'id_rsa'];
    const fromSsh = build('auto', { standing: () => 'fresh', cwd: '/home/u/.ssh' });
    await fromSsh.confirm(command(argv, false), undefined, undefined);
    expect(fromSsh.prompt).toHaveBeenCalledTimes(1);
    const fromProject = build('auto', { standing: () => 'fresh', cwd: '/home/u/project' });
    expect(await fromProject.confirm(command(argv, false), undefined, undefined)).toEqual({
      outcome: 'approve',
    });
    expect(fromProject.prompt).not.toHaveBeenCalled();
  });

  it('every approved file write is recorded for the project (once per write), and a refused write is not', async () => {
    const approving = build('accept-edits');
    await approving.confirm(WRITE, undefined, undefined);
    await approving.confirm(WRITE, undefined, undefined);
    expect(approving.noteFileWrite).toHaveBeenCalledTimes(2);
    // A card-approved write in `ask` counts too; a command approved on a card is not a write.
    const asked = build('ask');
    await asked.confirm(WRITE, undefined, undefined);
    await asked.confirm(command(TEST, false), undefined, undefined);
    expect(asked.noteFileWrite).toHaveBeenCalledTimes(1);
    const refusing = build('ask', { answer: { outcome: 'reject', reason: 'no' } });
    await refusing.confirm(WRITE, undefined, undefined);
    expect(refusing.noteFileWrite).not.toHaveBeenCalled();
    const plan = build('plan');
    await plan.confirm(WRITE, undefined, undefined);
    expect(plan.noteFileWrite).not.toHaveBeenCalled();
  });
});
