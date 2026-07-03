import type { GlobalConfig, ProjectConfig } from '@relavium/shared';
import { describe, expect, it } from 'vitest';

import { resolveConfig } from './resolve.js';

describe('resolveConfig', () => {
  it('returns empty defaults with no layers', () => {
    expect(resolveConfig({})).toEqual({
      updateChannel: undefined,
      defaultModel: undefined,
      fsScope: undefined,
      maxTokensEstimate: undefined,
      mediaCostEstimate: undefined,
      mediaGcGraceMs: undefined,
      chat: {
        defaultModel: undefined,
        fsScope: undefined,
        maxTurns: undefined,
        maxMessages: undefined,
        maxCostMicrocents: undefined,
        onExceed: undefined,
        allowedCommands: undefined,
        allowedCommandGlobs: undefined,
      },
      variables: {},
      mcpServers: [],
    });
  });

  it('resolves the [chat] `!`-shell allowlist per field (project REPLACES workspace, no merge — ADR-0061)', () => {
    const workspace: ProjectConfig = {
      chat: { allowed_commands: ['ls', 'pwd'], allowed_command_globs: ['git *'] },
    };
    const project: ProjectConfig = { chat: { allowed_commands: ['git status'] } };
    const resolved = resolveConfig({ workspace, project }).chat;
    expect(resolved.allowedCommands).toEqual(['git status']); // project REPLACES (never merges) the workspace list
    expect(resolved.allowedCommandGlobs).toEqual(['git *']); // absent on project ⇒ falls through to workspace
    // Absent everywhere ⇒ undefined ⇒ `!`-shell disabled (secure default).
    expect(resolveConfig({}).chat.allowedCommands).toBeUndefined();
  });

  it('resolves the [chat] block last-writer-wins (project > workspace), per field', () => {
    const workspace: ProjectConfig = {
      chat: { default_model: 'w-model', fs_scope: 'sandboxed', max_turns: 20, max_messages: 100 },
    };
    const project: ProjectConfig = {
      chat: { fs_scope: 'project', max_turns: 5, max_cost_microcents: 1000, on_exceed: 'warn' },
    };
    const resolved = resolveConfig({ workspace, project }).chat;
    expect(resolved.maxTurns).toBe(5); // project overrides workspace
    expect(resolved.fsScope).toBe('project'); // project overrides workspace
    expect(resolved.defaultModel).toBe('w-model'); // falls back to workspace (project omits it)
    expect(resolved.maxMessages).toBe(100); // falls back to workspace
    expect(resolved.maxCostMicrocents).toBe(1000); // only on project
    expect(resolved.onExceed).toBe('warn'); // only on project
  });

  it('resolves [chat] per field: a project block present but omitting a key falls through to workspace', () => {
    const workspace: ProjectConfig = { chat: { default_model: 'w-model', max_turns: 20 } };
    // project declares fs_scope only — max_turns/default_model must inherit from workspace per-field.
    const resolved = resolveConfig({ workspace, project: { chat: { fs_scope: 'project' } } }).chat;
    expect(resolved.maxTurns).toBe(20); // workspace max_turns flows through
    expect(resolved.defaultModel).toBe('w-model'); // workspace default_model flows through
    expect(resolved.fsScope).toBe('project'); // project still overrides the field it declares
  });

  it('resolves [chat] from a single layer (workspace-only and project-only), like the sister resolvers', () => {
    // Workspace-only: project absent ⇒ every field comes from workspace alone.
    const wsOnly = resolveConfig({
      workspace: { chat: { default_model: 'w-model', max_turns: 20 } },
    }).chat;
    expect(wsOnly.defaultModel).toBe('w-model');
    expect(wsOnly.maxTurns).toBe(20);
    expect(wsOnly.fsScope).toBeUndefined();
    // Project-only: workspace absent ⇒ every field comes from project alone.
    const pOnly = resolveConfig({ project: { chat: { max_turns: 5 } } }).chat;
    expect(pOnly.maxTurns).toBe(5);
    expect(pOnly.defaultModel).toBeUndefined();
  });

  it('treats [chat].max_cost_microcents=0 (unbounded) as a real value, not a fall-through to a lower layer', () => {
    // 0 means "unbounded" (a distinct sentinel) — `??` keeps it, so a project 0 must NOT inherit
    // workspace's 9999. (Guards against a future `??`→`||` regression that would leak the cap through.)
    const resolved = resolveConfig({
      workspace: { chat: { max_cost_microcents: 9999 } },
      project: { chat: { max_cost_microcents: 0 } },
    }).chat;
    expect(resolved.maxCostMicrocents).toBe(0);
  });

  it('resolves an absent [chat] block (every layer) to all-undefined — [chat] is project/workspace-scoped, not global', () => {
    const empty = resolveConfig({}).chat;
    expect(empty.maxTurns).toBeUndefined();
    expect(empty.defaultModel).toBeUndefined();
    expect(empty.maxCostMicrocents).toBeUndefined();
    // A global layer carries no [chat] block, so it cannot supply chat defaults.
    expect(
      resolveConfig({ global: { preferences: { default_model: 'g' } } }).chat.defaultModel,
    ).toBeUndefined();
  });

  it('resolves media_gc_grace_days (2.S/D11) DAYS → ms, last-writer-wins, absent ⇒ undefined', () => {
    const workspace: ProjectConfig = { defaults: { media_gc_grace_days: 30 } };
    const project: ProjectConfig = { defaults: { media_gc_grace_days: 3 } };
    const MS_PER_DAY = 24 * 60 * 60 * 1000;
    // project replaces workspace (last-writer-wins), and the days are normalized to milliseconds.
    expect(resolveConfig({ workspace, project }).mediaGcGraceMs).toBe(3 * MS_PER_DAY);
    expect(resolveConfig({ workspace }).mediaGcGraceMs).toBe(30 * MS_PER_DAY);
    expect(resolveConfig({}).mediaGcGraceMs).toBeUndefined(); // absent ⇒ the GC's built-in 7-day default applies
  });

  it('takes media_cost_estimate (2.S/D17) from the highest layer present — whole-object, not per-key merge', () => {
    const workspace: ProjectConfig = { defaults: { media_cost_estimate: { image: 2, audio: 5 } } };
    const project: ProjectConfig = { defaults: { media_cost_estimate: { image: 9 } } };
    // project replaces workspace (last-writer-wins like the other defaults), it does not merge audio in.
    expect(resolveConfig({ workspace, project }).mediaCostEstimate).toEqual({ image: 9 });
    expect(resolveConfig({ workspace }).mediaCostEstimate).toEqual({ image: 2, audio: 5 });
    expect(resolveConfig({}).mediaCostEstimate).toBeUndefined();
  });

  it('applies last-writer-wins precedence (project > workspace > global) for the default model', () => {
    const global: GlobalConfig = { preferences: { default_model: 'g' } };
    const workspace: ProjectConfig = { defaults: { model: 'w' } };
    const project: ProjectConfig = { defaults: { model: 'p' } };
    expect(resolveConfig({ global, workspace, project }).defaultModel).toBe('p');
    expect(resolveConfig({ global, workspace }).defaultModel).toBe('w');
    expect(resolveConfig({ global }).defaultModel).toBe('g');
  });

  it('takes fs_scope and max_tokens_estimate from the highest layer present', () => {
    const workspace: ProjectConfig = {
      defaults: { fs_scope: 'sandboxed', max_tokens_estimate: 1000 },
    };
    const project: ProjectConfig = { defaults: { fs_scope: 'project' } };
    const resolved = resolveConfig({ workspace, project });
    expect(resolved.fsScope).toBe('project'); // project overrides workspace
    expect(resolved.maxTokensEstimate).toBe(1000); // falls back to workspace
  });

  it('merges variables with project overriding workspace on a key collision', () => {
    const workspace: ProjectConfig = { variables: { a: 'w', b: 'w' } };
    const project: ProjectConfig = { variables: { b: 'p', c: 'p' } };
    expect(resolveConfig({ workspace, project }).variables).toEqual({ a: 'w', b: 'p', c: 'p' });
  });

  it('merges MCP servers across layers, a later layer winning by name', () => {
    const global: GlobalConfig = {
      mcp_servers: [{ name: 'fs', transport: 'stdio', command: 'global-cmd' }],
    };
    const project: ProjectConfig = {
      mcp_servers: [
        { name: 'fs', transport: 'stdio', command: 'project-cmd' },
        { name: 'gh', transport: 'stdio', command: 'gh-cmd' },
      ],
    };
    const merged = resolveConfig({ global, project }).mcpServers;
    expect(merged).toHaveLength(2);
    expect(merged.find((server) => server.name === 'fs')?.command).toBe('project-cmd');
    expect([...merged.map((server) => server.name)].sort((a, b) => a.localeCompare(b))).toEqual([
      'fs',
      'gh',
    ]);
  });
});
