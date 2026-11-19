import type { ToolApprovalRequest } from '@relavium/core';
import { describe, expect, it, vi } from 'vitest';

import { applyChatMode, makeChatModeEnv } from './chat-mode-host.js';
import type { ApprovalAnswer, ApprovalPrompt, CommandGrantsPort } from './chat-mode.js';

/**
 * The host glue (ADR-0118 §1): the working directory a command runs in, the "session / remember" offer and the channel a failed
 * Remember is reported on reach the turn policy that decides a command, through `makeChatModeEnv` and `applyChatMode`.
 */
const REQUEST: ToolApprovalRequest = {
  toolId: 'run_command',
  action: 'process',
  preview: { command: 'npm test' },
  unredactedPreview: { command: 'npm test' },
  argv: ['npm', 'test'],
  commandAdmitted: false,
};

function wire(options: {
  readonly answer: ApprovalAnswer;
  readonly commandGrants?: CommandGrantsPort;
  readonly commandSessionGrants?: boolean;
}) {
  const prompt = vi.fn<ApprovalPrompt>(() => Promise.resolve(options.answer));
  const notes: string[] = [];
  const policies: unknown[] = [];
  const env = makeChatModeEnv({
    session: { setTurnPolicy: (policy) => void policies.push(policy) },
    tools: [],
    workspaceDir: '/work/project',
    prompt,
    notify: (message) => notes.push(message),
    ...(options.commandGrants === undefined ? {} : { commandGrants: options.commandGrants }),
    ...(options.commandSessionGrants === undefined
      ? {}
      : { commandSessionGrants: options.commandSessionGrants }),
  });
  applyChatMode(env, 'ask');
  const policy = policies.at(-1) as { confirm: (request: ToolApprovalRequest) => Promise<unknown> };
  return { prompt, notes, confirm: policy.confirm };
}

describe('the chat-mode host passes the command card its context', () => {
  it('the card is given the session workspace as the directory the command runs in', async () => {
    const w = wire({ answer: { outcome: 'approve', scope: 'once' }, commandSessionGrants: true });
    await w.confirm(REQUEST);
    expect(w.prompt.mock.calls[0]?.[4]?.cwd).toBe('/work/project');
  });

  it('a protected path is judged against that directory: .env in the workspace is protected', async () => {
    const w = wire({ answer: { outcome: 'approve', scope: 'once' }, commandSessionGrants: true });
    await w.confirm({ ...REQUEST, argv: ['cat', '.env'] });
    expect(w.prompt.mock.calls[0]?.[4]?.protectedPath).toBe(true);
  });

  it('without the session offer a command card offers neither Session nor Remember', async () => {
    const w = wire({
      answer: { outcome: 'approve', scope: 'once' },
      commandGrants: {
        matches: () => false,
        canRemember: () => ({ ok: true }),
        remember: () => Promise.resolve({ ok: true }),
      },
    });
    await w.confirm(REQUEST);
    expect(w.prompt.mock.calls[0]?.[4]?.offers).toEqual({ session: false, remember: false });
  });

  it('a Remember that cannot be written is reported on the notice channel it was given', async () => {
    const w = wire({
      answer: { outcome: 'approve', scope: 'remember' },
      commandSessionGrants: true,
      commandGrants: {
        matches: () => false,
        canRemember: () => ({ ok: true }),
        remember: () => Promise.resolve({ ok: false, reason: 'unwritable' }),
      },
    });
    await w.confirm(REQUEST);
    expect(w.notes).toHaveLength(1);
    expect(w.notes[0]).toContain('could not be written');
  });
});

describe('where no one can answer, run_command is not advertised (ADR-0118 §4)', () => {
  it('a non-interactive host hides the governed tools from the model, as plan does', () => {
    const policies: { advertise?: (id: string) => boolean }[] = [];
    const env = makeChatModeEnv({
      interactive: false,
      session: { setTurnPolicy: (policy) => void policies.push(policy as never) },
      tools: [
        {
          id: 'run_command',
          policy: { spawnsProcess: true, fsScoped: false, requiresGateApproval: false },
          policyTarget: () => ({ kind: 'process', command: 'npm' }),
        } as never,
        { id: 'read_file', policy: { fsScoped: true } } as never,
      ],
      workspaceDir: '/work/project',
      prompt: () => Promise.resolve({ outcome: 'reject' }),
    });
    applyChatMode(env, 'ask');
    const advertise = policies.at(-1)?.advertise;
    expect(advertise?.('run_command'), 'hidden').toBe(false);
    expect(advertise?.('read_file'), 'a plain read stays').toBe(true);
  });
});
