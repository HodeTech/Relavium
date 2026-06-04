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

  it('accepts an http MCP registration with a url', () => {
    expect(
      GlobalConfigSchema.safeParse({
        mcp_servers: [{ name: 'remote', transport: 'http', url: 'http://localhost:4000' }],
      }).success,
    ).toBe(true);
  });

  it('enforces transport-specific required fields on MCP registrations', () => {
    expect(
      GlobalConfigSchema.safeParse({ mcp_servers: [{ name: 'x', transport: 'stdio' }] }).success,
    ).toBe(false); // stdio needs command
    expect(
      GlobalConfigSchema.safeParse({ mcp_servers: [{ name: 'x', transport: 'http' }] }).success,
    ).toBe(false); // http needs url
  });

  it('accepts project-scoped MCP registrations (merge with global)', () => {
    expect(
      ProjectConfigSchema.safeParse({
        mcp_servers: [{ name: 'local-fs', transport: 'stdio', command: 'npx' }],
      }).success,
    ).toBe(true);
  });

  it('rejects a malformed url in an http MCP registration', () => {
    expect(
      GlobalConfigSchema.safeParse({
        mcp_servers: [{ name: 'r', transport: 'http', url: 'not-a-url' }],
      }).success,
    ).toBe(false);
  });

  it('rejects an unsafe url scheme in an http MCP registration (SSRF guard)', () => {
    expect(
      GlobalConfigSchema.safeParse({
        mcp_servers: [{ name: 'r', transport: 'http', url: 'file:///etc/passwd' }],
      }).success,
    ).toBe(false);
  });

  it('rejects a url that embeds credentials in an http MCP registration', () => {
    expect(
      GlobalConfigSchema.safeParse({
        mcp_servers: [{ name: 'r', transport: 'http', url: 'https://user:pass@host' }],
      }).success,
    ).toBe(false);
  });
});
