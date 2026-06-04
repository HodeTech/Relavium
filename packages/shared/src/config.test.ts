import { describe, expect, it } from 'vitest';

import { GlobalConfigSchema, ProjectConfigSchema } from './config.js';

describe('config schemas', () => {
  it('accepts a global config.toml shape', () => {
    expect(
      GlobalConfigSchema.safeParse({
        update_channel: 'stable',
        preferences: { default_model: 'claude-sonnet-4-6', theme: 'dark' },
        mcp_servers: [
          {
            name: 'filesystem',
            transport: 'stdio',
            command: 'npx',
            args: ['-y', 'x'],
            autostart: true,
          },
        ],
      }).success,
    ).toBe(true);
  });

  it('rejects an unknown update_channel', () => {
    expect(GlobalConfigSchema.safeParse({ update_channel: 'nightly' }).success).toBe(false);
  });

  it('accepts a project.toml / workspace.toml shape', () => {
    expect(
      ProjectConfigSchema.safeParse({
        defaults: { model: 'gpt-4o', fs_scope: 'sandboxed' },
        variables: { focus_area: 'security and type safety' },
      }).success,
    ).toBe(true);
  });

  it('rejects an unknown fs_scope tier', () => {
    expect(ProjectConfigSchema.safeParse({ defaults: { fs_scope: 'everything' } }).success).toBe(
      false,
    );
  });

  it('accepts empty configs (every field optional)', () => {
    expect(GlobalConfigSchema.safeParse({}).success).toBe(true);
    expect(ProjectConfigSchema.safeParse({}).success).toBe(true);
  });
});
