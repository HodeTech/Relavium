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
        reasoningEffort: undefined,
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

  it('resolves the [chat] `!`-shell allowlist as a COUPLED unit — a project that sets EITHER field owns the whole policy (ADR-0061)', () => {
    const workspace: ProjectConfig = {
      chat: { allowed_commands: ['ls', 'pwd'], allowed_command_globs: ['git *'] },
    };
    // The project narrows to `git status` and sets NO globs. It must NOT inherit the workspace's broad `git *`
    // glob — else `git push` would still be allowed, defeating the narrowing (a security regression).
    const project: ProjectConfig = { chat: { allowed_commands: ['git status'] } };
    const resolved = resolveConfig({ workspace, project }).chat;
    expect(resolved.allowedCommands).toEqual(['git status']); // project REPLACES (never merges) the workspace list
    expect(resolved.allowedCommandGlobs).toBeUndefined(); // NOT inherited — the project owns the whole allowlist
    // Symmetric: a project setting ONLY globs drops the workspace's exact commands too.
    const globsOnly = resolveConfig({
      workspace,
      project: { chat: { allowed_command_globs: ['npm run *'] } },
    }).chat;
    expect(globsOnly.allowedCommandGlobs).toEqual(['npm run *']);
    expect(globsOnly.allowedCommands).toBeUndefined();
    // A project that sets NEITHER allowlist field DOES fall through to the workspace, per field (both inherited).
    const inherited = resolveConfig({ workspace, project: { chat: { max_turns: 5 } } }).chat;
    expect(inherited.allowedCommands).toEqual(['ls', 'pwd']);
    expect(inherited.allowedCommandGlobs).toEqual(['git *']);
    // The `[]` OPT-OUT (ADR-0061): a project setting `allowed_commands: []` explicitly disables exact commands and
    // must NOT inherit the workspace's globs either — else `git push` would still run via the inherited `git *`.
    const optOut = resolveConfig({ workspace, project: { chat: { allowed_commands: [] } } }).chat;
    expect(optOut.allowedCommands).toEqual([]);
    expect(optOut.allowedCommandGlobs).toBeUndefined(); // NOT inherited — the opt-out is real
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

  it('resolves [chat].reasoning_effort (ADR-0066) last-writer-wins project > workspace, no global fallback', () => {
    const workspace: ProjectConfig = { chat: { reasoning_effort: 'low' } };
    const project: ProjectConfig = { chat: { reasoning_effort: 'high' } };
    expect(resolveConfig({ workspace, project }).chat.reasoningEffort).toBe('high'); // project wins
    // A project present but omitting it falls through to workspace (per-field, like the sibling keys).
    expect(
      resolveConfig({ workspace, project: { chat: { max_turns: 5 } } }).chat.reasoningEffort,
    ).toBe('low');
    // Absent everywhere ⇒ undefined (no global-layer fallback — that extra fallback is default_model's alone).
    expect(resolveConfig({}).chat.reasoningEffort).toBeUndefined();
    expect(
      resolveConfig({ global: { preferences: { default_model: 'g' } } }).chat.reasoningEffort,
    ).toBeUndefined();
  });

  it('resolves [chat].auto_compact + compact_threshold (ADR-0062) last-writer-wins, per field', () => {
    const workspace: ProjectConfig = { chat: { auto_compact: false, compact_threshold: 0.7 } };
    const project: ProjectConfig = { chat: { compact_threshold: 0.9 } };
    const resolved = resolveConfig({ workspace, project }).chat;
    expect(resolved.compactThreshold).toBe(0.9); // project overrides workspace
    expect(resolved.autoCompact).toBe(false); // falls back to workspace (project omits it)
    // Absent everywhere ⇒ undefined ⇒ the engine defaults (enabled / 0.8) apply downstream.
    expect(resolveConfig({}).chat.autoCompact).toBeUndefined();
    expect(resolveConfig({}).chat.compactThreshold).toBeUndefined();
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

  it('resolves an absent [chat] block: non-model fields stay undefined; default_model falls back to global [preferences] (ADR-0063)', () => {
    const empty = resolveConfig({}).chat;
    expect(empty.maxTurns).toBeUndefined();
    expect(empty.defaultModel).toBeUndefined();
    expect(empty.maxCostMicrocents).toBeUndefined();
    // A global layer carries no [chat] block, so it cannot supply the NON-model chat fields...
    const g = resolveConfig({ global: { preferences: { default_model: 'g' } } }).chat;
    expect(g.maxTurns).toBeUndefined();
    expect(g.maxCostMicrocents).toBeUndefined();
    // ...BUT chat.default_model DOES fall back to the global [preferences].default_model (the /models + wizard
    // write target, ADR-0063 §1) so a user's "preferred model everywhere" applies to chat when no [chat] overrides.
    expect(g.defaultModel).toBe('g');
  });

  it('resolves [chat].default_model precedence project > workspace > global [preferences] (ADR-0063 §1)', () => {
    const global: GlobalConfig = { preferences: { default_model: 'g' } };
    const workspace: ProjectConfig = { chat: { default_model: 'w' } };
    const project: ProjectConfig = { chat: { default_model: 'p' } };
    expect(resolveConfig({ global, workspace, project }).chat.defaultModel).toBe('p');
    expect(resolveConfig({ global, workspace }).chat.defaultModel).toBe('w');
    expect(resolveConfig({ global }).chat.defaultModel).toBe('g');
    // A present [chat].default_model is NEVER shadowed by the global — the global is only the lowest fallback.
    expect(
      resolveConfig({ global, project: { chat: { default_model: 'p' } } }).chat.defaultModel,
    ).toBe('p');
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
