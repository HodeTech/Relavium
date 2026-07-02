import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BUILTIN_TOOLS, type SessionTurnPolicy } from '@relavium/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { applyChatMode, makeChatModeEnv } from './chat-mode-host.js';
import { type ApprovalPrompt } from './chat-mode.js';

let workspace: string;
beforeEach(async () => {
  workspace = await realpath(await mkdtemp(join(tmpdir(), 'relavium-modehost-')));
});
afterEach(async () => {
  await rm(workspace, { recursive: true, force: true }).catch(() => undefined);
});

/** A fake session that records every pushed turn policy. */
function fakeSession(): {
  session: { setTurnPolicy: (p: SessionTurnPolicy | undefined) => void };
  policies: (SessionTurnPolicy | undefined)[];
} {
  const policies: (SessionTurnPolicy | undefined)[] = [];
  return { session: { setTurnPolicy: (p) => policies.push(p) }, policies };
}

const prompt: ApprovalPrompt = () => Promise.resolve({ outcome: 'approve', scope: 'once' });

describe('makeChatModeEnv + applyChatMode', () => {
  it('derives the governed hide-set from the session tools and pushes the mapped policy on apply', () => {
    const { session, policies } = fakeSession();
    const env = makeChatModeEnv({ session, tools: BUILTIN_TOOLS, workspaceDir: workspace, prompt });
    applyChatMode(env, 'ask');
    expect(policies).toHaveLength(1);
    const policy = policies[0];
    expect(policy?.confirm).toBeDefined(); // the regime is active (fail-closed) in every mode
    expect(policy?.advertise?.('read_file')).toBe(true);
    expect(policy?.advertise?.('write_file')).toBe(false); // governed hidden in ask
  });

  it('applies a new policy on every mode change (accept-edits advertises all)', () => {
    const { session, policies } = fakeSession();
    const env = makeChatModeEnv({ session, tools: BUILTIN_TOOLS, workspaceDir: workspace, prompt });
    applyChatMode(env, 'ask');
    applyChatMode(env, 'accept-edits');
    expect(policies).toHaveLength(2);
    expect(policies[1]?.advertise).toBeUndefined(); // accept-edits advertises every granted tool
    expect(policies[1]?.confirm).toBeDefined();
  });

  it('shares ONE cache across mode changes — an "always" grant persists across re-applies', () => {
    const { session } = fakeSession();
    const env = makeChatModeEnv({ session, tools: BUILTIN_TOOLS, workspaceDir: workspace, prompt });
    applyChatMode(env, 'accept-edits');
    env.cache.rememberAlways('write_file');
    applyChatMode(env, 'ask'); // switch mode — a fresh policy, but over the SAME env/cache
    applyChatMode(env, 'accept-edits');
    expect(env.cache.isAlways('write_file')).toBe(true); // the cache lives on the env, not per-policy
  });

  it('isProtectedTarget resolves a preview path against the workspace and matches a protected target', () => {
    const { session } = fakeSession();
    const env = makeChatModeEnv({ session, tools: BUILTIN_TOOLS, workspaceDir: workspace, prompt });
    expect(env.isProtectedTarget({ path: '.git/config' })).toBe(true);
    expect(env.isProtectedTarget({ path: '.ssh/authorized_keys' })).toBe(true);
    expect(env.isProtectedTarget({ path: 'notes.md' })).toBe(false);
    expect(env.isProtectedTarget({})).toBe(false); // no path (egress/process preview) ⇒ never protected
    expect(env.isProtectedTarget({ command: 'ls' })).toBe(false);
  });

  it('auto uses isProtectedTarget: a protected write prompts, a normal write auto-approves', async () => {
    const { session, policies } = fakeSession();
    const promptSpy = vi.fn<ApprovalPrompt>(() => Promise.resolve({ outcome: 'reject' }));
    const env = makeChatModeEnv({
      session,
      tools: BUILTIN_TOOLS,
      workspaceDir: workspace,
      prompt: promptSpy,
    });
    applyChatMode(env, 'auto');
    const confirm = policies[0]?.confirm;
    expect(confirm).toBeDefined();
    // A normal write auto-approves without prompting…
    expect(
      await confirm!({ toolId: 'write_file', action: 'fs_write', preview: { path: 'ok.md' } }),
    ).toEqual({
      outcome: 'approve',
    });
    expect(promptSpy).not.toHaveBeenCalled();
    // …a protected write falls back to the prompt.
    await confirm!({ toolId: 'write_file', action: 'fs_write', preview: { path: '.git/config' } });
    expect(promptSpy).toHaveBeenCalledTimes(1);
  });
});
