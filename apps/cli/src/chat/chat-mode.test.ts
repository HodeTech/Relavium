import { BUILTIN_TOOLS, type ToolApprovalRequest, type ToolDef } from '@relavium/core';
import { describe, expect, it, vi } from 'vitest';

import {
  ApprovalCache,
  buildTurnPolicy,
  CHAT_MODES,
  DEFAULT_CHAT_MODE,
  governedToolIds,
  isGovernedTool,
  nextMode,
  parseMode,
  type ApprovalAnswer,
  type ApprovalPrompt,
} from './chat-mode.js';

function builtin(id: string): ToolDef {
  const def = BUILTIN_TOOLS.find((d) => d.id === id);
  if (def === undefined) throw new Error(`missing builtin ${id}`);
  return def;
}

const req = (over: Partial<ToolApprovalRequest> = {}): ToolApprovalRequest => ({
  toolId: 'write_file',
  action: 'fs_write',
  preview: { path: 'notes.md' },
  ...over,
});

describe('mode cycle + parsing', () => {
  it('cycles ask → plan → accept-edits → auto → ask (Shift+Tab order)', () => {
    expect(DEFAULT_CHAT_MODE).toBe('ask');
    expect(CHAT_MODES).toEqual(['ask', 'plan', 'accept-edits', 'auto']);
    expect(nextMode('ask')).toBe('plan');
    expect(nextMode('plan')).toBe('accept-edits');
    expect(nextMode('accept-edits')).toBe('auto');
    expect(nextMode('auto')).toBe('ask'); // wraps
  });

  it('parses a mode name, tolerating the spaced label, and rejects the unknown', () => {
    expect(parseMode('plan')).toBe('plan');
    expect(parseMode('  AUTO ')).toBe('auto');
    expect(parseMode('accept edits')).toBe('accept-edits'); // spaced label → kebab
    expect(parseMode('accept-edits')).toBe('accept-edits');
    expect(parseMode('yolo')).toBeUndefined();
  });
});

describe('isGovernedTool — mirrors the registry governedAction (advertise-filter hide set)', () => {
  it('governs write_file (fsWrite), http_request/web_search/mcp_call (egress), run_command (model command)', () => {
    expect(isGovernedTool(builtin('write_file'))).toBe(true);
    expect(isGovernedTool(builtin('http_request'))).toBe(true);
    expect(isGovernedTool(builtin('web_search'))).toBe(true);
    expect(isGovernedTool(builtin('mcp_call'))).toBe(true);
    expect(isGovernedTool(builtin('run_command'))).toBe(true);
    expect(isGovernedTool(builtin('git_commit'))).toBe(true);
  });

  it('does NOT govern the read-only tools (read_file, list_directory, git_status without a policyTarget)', () => {
    expect(isGovernedTool(builtin('read_file'))).toBe(false);
    expect(isGovernedTool(builtin('list_directory'))).toBe(false);
    expect(isGovernedTool(builtin('git_status'))).toBe(false); // spawnsProcess but NO policyTarget ⇒ read-only
    expect(isGovernedTool(builtin('read_clipboard'))).toBe(false); // os, non-governed
  });

  it('governs a discovered MCP tool (egress: mcp)', () => {
    const mcpTool: ToolDef = { ...builtin('mcp_call'), id: 'mcp__srv__do', source: 'mcp' };
    expect(governedToolIds([mcpTool, builtin('read_file')])).toEqual(new Set(['mcp__srv__do']));
  });
});

describe('ApprovalCache — session once/always memory', () => {
  it('remembers an always-approval by tool id; once caches nothing', () => {
    const cache = new ApprovalCache();
    expect(cache.isAlways('write_file')).toBe(false);
    cache.rememberAlways('write_file');
    expect(cache.isAlways('write_file')).toBe(true);
    expect(cache.isAlways('http_request')).toBe(false); // scoped per tool id
  });
});

describe('buildTurnPolicy — the mode → { advertise, confirm } mapping', () => {
  const deps = (over: Partial<Parameters<typeof buildTurnPolicy>[1]> = {}) => ({
    governed: governedToolIds(BUILTIN_TOOLS),
    prompt: vi.fn<ApprovalPrompt>(() => Promise.resolve({ outcome: 'approve', scope: 'once' })),
    cache: new ApprovalCache(),
    ...over,
  });

  it('ask: hides governed tools AND its confirm rejects every governed dispatch (two-layer)', async () => {
    const d = deps();
    const policy = buildTurnPolicy('ask', d);
    expect(policy.advertise?.('read_file')).toBe(true);
    expect(policy.advertise?.('git_status')).toBe(true); // read-only process tool stays advertised
    expect(policy.advertise?.('write_file')).toBe(false);
    expect(policy.advertise?.('http_request')).toBe(false);
    const decision = await policy.confirm!(req());
    expect(decision).toEqual({ outcome: 'reject', reason: 'not allowed in ask mode (read-only)' });
    expect(d.prompt).not.toHaveBeenCalled(); // ask never prompts
  });

  it('plan: same read-only posture as ask', async () => {
    const policy = buildTurnPolicy('plan', deps());
    expect(policy.advertise?.('write_file')).toBe(false);
    expect((await policy.confirm!(req())).outcome).toBe('reject');
  });

  it('accept-edits: advertises all + prompts; an "always" answer is cached so the next call skips the prompt', async () => {
    const prompt = vi.fn<ApprovalPrompt>(() =>
      Promise.resolve<ApprovalAnswer>({ outcome: 'approve', scope: 'always' }),
    );
    const d = deps({ prompt });
    const policy = buildTurnPolicy('accept-edits', d);
    expect(policy.advertise).toBeUndefined(); // every granted tool advertised
    expect(await policy.confirm!(req())).toEqual({ outcome: 'approve' });
    expect(prompt).toHaveBeenCalledTimes(1);
    // Second call to the SAME tool id is short-circuited by the always cache — no second prompt.
    expect(await policy.confirm!(req())).toEqual({ outcome: 'approve' });
    expect(prompt).toHaveBeenCalledTimes(1);
  });

  it('accept-edits: a "once" approval does NOT cache — the next call re-prompts', async () => {
    const prompt = vi.fn<ApprovalPrompt>(() =>
      Promise.resolve<ApprovalAnswer>({ outcome: 'approve', scope: 'once' }),
    );
    const policy = buildTurnPolicy('accept-edits', deps({ prompt }));
    await policy.confirm!(req());
    await policy.confirm!(req());
    expect(prompt).toHaveBeenCalledTimes(2);
  });

  it('accept-edits: a rejection is passed through with its reason', async () => {
    const prompt = vi.fn<ApprovalPrompt>(() =>
      Promise.resolve<ApprovalAnswer>({ outcome: 'reject', reason: 'nope' }),
    );
    const decision = await buildTurnPolicy('accept-edits', deps({ prompt })).confirm!(req());
    expect(decision).toEqual({ outcome: 'reject', reason: 'nope' });
  });

  it('auto: advertises all + auto-approves a normal target without prompting', async () => {
    const d = deps();
    const policy = buildTurnPolicy('auto', d);
    expect(policy.advertise).toBeUndefined();
    expect(await policy.confirm!(req())).toEqual({ outcome: 'approve' });
    expect(d.prompt).not.toHaveBeenCalled();
  });

  it('auto: a PROTECTED-path target falls back to an explicit prompt', async () => {
    const prompt = vi.fn<ApprovalPrompt>(() =>
      Promise.resolve<ApprovalAnswer>({ outcome: 'reject' }),
    );
    const policy = buildTurnPolicy('auto', {
      ...deps({ prompt }),
      isProtectedTarget: (preview) => preview.path === '.git/config',
    });
    // A normal write auto-approves…
    expect(await policy.confirm!(req({ preview: { path: 'ok.md' } }))).toEqual({
      outcome: 'approve',
    });
    expect(prompt).not.toHaveBeenCalled();
    // …but a protected-path write prompts.
    const decision = await policy.confirm!(req({ preview: { path: '.git/config' } }));
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(decision.outcome).toBe('reject');
  });
});
