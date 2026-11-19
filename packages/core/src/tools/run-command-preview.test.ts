import { describe, expect, it } from 'vitest';

import { BUILTIN_TOOLS, BUILTIN_TOOL_IDS } from './builtins.js';
import { createToolRegistry } from './registry.js';
import type {
  ToolApprovalLiveContext,
  ToolApprovalRequest,
  ToolDispatchContext,
  ToolHost,
} from './types.js';
import { createInMemoryEffectJournal } from '../engine/execution-host.js';

/**
 * What the approval card is given for a command (ADR-0118 §1): the whole command as one quoted line (a shortened target locks
 * Allow until the person has read it), one row per argument, and an event preview that tells `["cat","a b"]` from `["cat","a","b"]`.
 */
const host = {
  process: {
    spawn: () => Promise.resolve({ exitCode: 0, stdout: '', stderr: '', durationMs: 1 }),
  },
} as unknown as ToolHost;

async function asked(
  command: string,
  args: readonly string[],
): Promise<{
  readonly request: ToolApprovalRequest;
  readonly live: ToolApprovalLiveContext | undefined;
}> {
  let seen: { request: ToolApprovalRequest; live: ToolApprovalLiveContext | undefined } | undefined;
  const ctx = {
    nodeId: 'n1',
    grantedToolIds: new Set(BUILTIN_TOOL_IDS),
    config: {},
    toolPolicy: { allowedCommands: [] },
    fsScope: 'sandboxed',
    gateApproved: false,
    effects: createInMemoryEffectJournal({ kind: 'run', runId: 'r', nodeId: 'n1', attempt: 1 }),
    effectSlot: 0,
    approval: {
      confirm: (request: ToolApprovalRequest, _signal: unknown, live?: ToolApprovalLiveContext) => {
        seen = { request, live };
        return Promise.resolve({ outcome: 'approve' as const });
      },
    },
  } as unknown as ToolDispatchContext;
  await createToolRegistry({ tools: BUILTIN_TOOLS, host }).dispatch(
    { type: 'tool_call', id: 'c1', name: 'run_command', args: { command, args: [...args] } },
    ctx,
  );
  if (seen === undefined) throw new Error('the hook was not asked');
  return seen;
}

describe('the run_command approval preview (ADR-0118 §1)', () => {
  it('target is the whole command as one quoted line, and every argument is its own row', async () => {
    const { live } = await asked('cat', ['a b', 'c', '']);
    expect(live?.preview.target).toBe("cat 'a b' c ''");
    expect(live?.preview.fields).toEqual([
      { name: 'program', value: 'cat' },
      { name: 'argument 1', value: 'a b' },
      { name: 'argument 2', value: 'c' },
      { name: 'argument 3', value: '' },
    ]);
  });

  it('keeps a leading or trailing space and a quote visible in the quoted line', async () => {
    const { live } = await asked('echo', [' lead', 'trail ', "it's"]);
    expect(live?.preview.target).toContain("' lead'");
    expect(live?.preview.target).toContain("'trail '");
  });

  it('the event preview and the in-process copy are the quoted line too, so the two shapes of one string differ', async () => {
    const joined = await asked('cat', ['a b']);
    const split = await asked('cat', ['a', 'b']);
    expect(joined.request.preview.command).not.toBe(split.request.preview.command);
    expect(joined.request.unredactedPreview?.command).toBe("cat 'a b'");
    expect(split.request.unredactedPreview?.command).toBe('cat a b');
  });

  it('a program with no arguments is a one-row command', async () => {
    const { live, request } = await asked('ls', []);
    expect(live?.preview.target).toBe('ls');
    expect(live?.preview.fields).toEqual([{ name: 'program', value: 'ls' }]);
    expect(request.argv).toEqual(['ls']);
  });
});
