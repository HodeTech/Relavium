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
      variables: {},
      mcpServers: [],
    });
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
