import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { BUILTIN_TOOLS, BUILTIN_TOOL_IDS } from './builtins.js';
import { ToolDeniedByUserError, ToolPolicyError } from './errors.js';
import { createToolRegistry } from './registry.js';
import type {
  ToolApprovalDecision,
  ToolApprovalRequest,
  ToolCallPart,
  ToolDef,
  ToolDispatchContext,
  ToolHost,
} from './types.js';
import { createInMemoryEffectJournal } from '../engine/execution-host.js';

/**
 * ADR-0118 §1: under an interactive approval regime an allowlist MISS is the host's decision. It reaches the confirm hook as a
 * request carrying the call's argv and `commandAdmitted: false`, instead of ending the turn with `command_not_allowed`. Without a
 * regime (a workflow) the allowlist stays the only authority and a miss still throws.
 */
function recordingHost(): {
  readonly host: ToolHost;
  readonly spawned: () => (readonly string[])[];
} {
  const calls: (readonly string[])[] = [];
  const host = {
    process: {
      spawn: (command: string, args: readonly string[]) => {
        calls.push([command, ...args]);
        return Promise.resolve({ exitCode: 0, stdout: 'ok', stderr: '', durationMs: 1 });
      },
    },
  } as unknown as ToolHost;
  return { host, spawned: () => calls };
}

function call(command: string, args: readonly string[]): ToolCallPart {
  return { type: 'tool_call', id: 'c1', name: 'run_command', args: { command, args } };
}

function context(
  allowedCommands: readonly string[],
  confirm: ((request: ToolApprovalRequest) => Promise<ToolApprovalDecision>) | undefined,
  regime = true,
): ToolDispatchContext {
  return {
    nodeId: 'n1',
    grantedToolIds: new Set(BUILTIN_TOOL_IDS),
    config: {},
    toolPolicy: { allowedCommands: [...allowedCommands] },
    fsScope: 'sandboxed',
    gateApproved: false,
    effects: createInMemoryEffectJournal({ kind: 'run', runId: 'r', nodeId: 'n1', attempt: 1 }),
    effectSlot: 0,
    ...(regime ? { approval: confirm === undefined ? {} : { confirm } } : {}),
  };
}

describe('an allowlist miss under an approval regime reaches the host (ADR-0118 §1)', () => {
  it('asks with the exact argv and commandAdmitted false, and runs the command when the host approves', async () => {
    const { host, spawned } = recordingHost();
    const seen: ToolApprovalRequest[] = [];
    await createToolRegistry({ tools: BUILTIN_TOOLS, host }).dispatch(
      call('cat', ['a b', 'c']),
      context([], (request) => {
        seen.push(request);
        return Promise.resolve({ outcome: 'approve' });
      }),
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]?.argv).toEqual(['cat', 'a b', 'c']);
    expect(seen[0]?.commandAdmitted).toBe(false);
    expect(spawned()).toEqual([['cat', 'a b', 'c']]);
  });

  it('hands the host a frozen argv: a hook that mutates it cannot change what is spawned', async () => {
    const { host, spawned } = recordingHost();
    let attempt: unknown = 'not attempted';
    await createToolRegistry({ tools: BUILTIN_TOOLS, host }).dispatch(
      call('ls', ['-la']),
      context([], (request) => {
        expect(Object.isFrozen(request.argv)).toBe(true);
        try {
          (request.argv as string[])[0] = 'rm';
          attempt = 'mutated';
        } catch (error) {
          attempt = error;
        }
        return Promise.resolve({ outcome: 'approve' });
      }),
    );
    expect(attempt).toBeInstanceOf(TypeError);
    expect(spawned()).toEqual([['ls', '-la']]);
  });

  it('a tool that spawns a process AND writes is classified as a write, so the hook never sees a command: the allowlist stays its authority', async () => {
    const hybrid = {
      id: 'plugin_hybrid',
      description: 'a hand-built tool that is both a write and a process',
      argsSchema: z.object({}).strict(),
      parseArgs: (args: unknown) => z.object({}).strict().parse(args),
      llmVisibleParams: { type: 'object', properties: {}, additionalProperties: false },
      policy: { fsScoped: false, fsWrite: true, spawnsProcess: true, requiresGateApproval: false },
      policyTarget: () => ({ command: 'rm', argv: ['rm', 'x'] }),
      dispatch: () => Promise.resolve('ran'),
    } as unknown as ToolDef;
    const { host } = recordingHost();
    const seen: ToolApprovalRequest[] = [];
    const error: unknown = await createToolRegistry({ tools: [hybrid], host })
      .dispatch(
        { type: 'tool_call', id: 'c1', name: 'plugin_hybrid', args: {} },
        {
          ...context(['ls'], (request) => {
            seen.push(request);
            return Promise.resolve({ outcome: 'approve' });
          }),
          grantedToolIds: new Set(['plugin_hybrid']),
        },
      )
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ToolPolicyError);
    expect(
      seen,
      'nothing was asked: a miss is not a card for a tool the hook sees as a write',
    ).toEqual([]);
  });

  it('a hand-built target with no argv reaches the hook as the one-element argv of its program, never as an empty one', async () => {
    const bare = {
      id: 'plugin_bare',
      description: 'a hand-built process tool whose target carries only a program name',
      argsSchema: z.object({}).strict(),
      parseArgs: (args: unknown) => z.object({}).strict().parse(args),
      llmVisibleParams: { type: 'object', properties: {}, additionalProperties: false },
      policy: { fsScoped: false, spawnsProcess: true, requiresGateApproval: false },
      policyTarget: () => ({ command: 'ls' }),
      dispatch: () => Promise.resolve('ran'),
    } as unknown as ToolDef;
    const seen: ToolApprovalRequest[] = [];
    await createToolRegistry({ tools: [bare], host: recordingHost().host }).dispatch(
      { type: 'tool_call', id: 'c1', name: 'plugin_bare', args: {} },
      {
        ...context([], (request) => {
          seen.push(request);
          return Promise.resolve({ outcome: 'approve' });
        }),
        grantedToolIds: new Set(['plugin_bare']),
      },
    );
    expect(seen[0]?.argv).toEqual(['ls']);
    expect(seen[0]?.commandAdmitted).toBe(false);
  });

  it('says commandAdmitted true for a command the allowlist admits, and compares element by element', async () => {
    const { host } = recordingHost();
    const seen: ToolApprovalRequest[] = [];
    const confirm = (request: ToolApprovalRequest): Promise<ToolApprovalDecision> => {
      seen.push(request);
      return Promise.resolve({ outcome: 'approve' });
    };
    const registry = createToolRegistry({ tools: BUILTIN_TOOLS, host });
    await registry.dispatch(call('cat', ['a', 'b']), context(['cat a b'], confirm));
    await registry.dispatch(call('cat', ['a b']), context(['cat a b'], confirm));
    expect(seen.map((r) => r.commandAdmitted)).toEqual([true, false]);
    expect(seen.map((r) => r.argv)).toEqual([
      ['cat', 'a', 'b'],
      ['cat', 'a b'],
    ]);
  });

  it('a rejection runs nothing and is the person’s denial, not a policy error', async () => {
    const { host, spawned } = recordingHost();
    const error: unknown = await createToolRegistry({ tools: BUILTIN_TOOLS, host })
      .dispatch(
        call('rm', ['-rf', 'x']),
        context([], () => Promise.resolve({ outcome: 'reject' })),
      )
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ToolDeniedByUserError);
    expect(error).not.toBeInstanceOf(ToolPolicyError);
    expect(spawned()).toEqual([]);
  });

  it('a regime with NO hook still fails closed on a miss: nothing runs', async () => {
    const { host, spawned } = recordingHost();
    const error: unknown = await createToolRegistry({ tools: BUILTIN_TOOLS, host })
      .dispatch(call('ls', []), context([], undefined))
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ToolDeniedByUserError);
    expect((error as ToolDeniedByUserError).reason).toBe('no_approval_hook');
    expect(spawned()).toEqual([]);
  });

  it('WITHOUT a regime (a workflow) a miss still throws command_not_allowed and nothing runs', async () => {
    const { host, spawned } = recordingHost();
    const error: unknown = await createToolRegistry({ tools: BUILTIN_TOOLS, host })
      .dispatch(call('ls', []), context([], undefined, false))
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ToolPolicyError);
    expect((error as ToolPolicyError).reason).toBe('command_not_allowed');
    expect(spawned()).toEqual([]);
  });

  it('the display preview carries no argv: only path, command and host may cross to the event', async () => {
    const { host } = recordingHost();
    let request: ToolApprovalRequest | undefined;
    await createToolRegistry({ tools: BUILTIN_TOOLS, host }).dispatch(
      call('cat', ['a', 'b']),
      context([], (r) => {
        request = r;
        return Promise.resolve({ outcome: 'approve' });
      }),
    );
    expect(Object.keys(request?.preview ?? {}).sort()).toEqual(['command']);
    expect(request?.preview).not.toHaveProperty('argv');
  });

  it('a non-command request carries neither field', async () => {
    const host = {
      os: { readClipboard: () => Promise.resolve('x') },
    } as unknown as ToolHost;
    let request: ToolApprovalRequest | undefined;
    await createToolRegistry({ tools: BUILTIN_TOOLS, host })
      .dispatch(
        { type: 'tool_call', id: 'k', name: 'read_clipboard', args: {} },
        context([], (r) => {
          request = r;
          return Promise.resolve({ outcome: 'reject' });
        }),
      )
      .catch(() => undefined);
    expect(request?.action).toBe('os');
    expect(request).not.toHaveProperty('argv');
    expect(request).not.toHaveProperty('commandAdmitted');
  });
});
