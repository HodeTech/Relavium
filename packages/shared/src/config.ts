import { z } from 'zod';

import { nonEmptyString } from './common.js';

/**
 * Configuration schemas (config-spec.md). Validation only — no file IO. The global
 * `config.toml` and the per-project `project.toml` / `workspace.toml` are stable,
 * versioned, committed formats; the per-project layer overrides the global one.
 */

export const UpdateChannelSchema = z.enum(['stable', 'beta']);

/** Filesystem permission tier (built-in-tools.md). */
export const FsScopeSchema = z.enum(['sandboxed', 'project', 'full']);

/** A global MCP server registration (`[[mcp_servers]]` in `config.toml`). */
export const McpServerRegistrationSchema = z.object({
  name: nonEmptyString,
  transport: z.enum(['stdio', 'http']),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  autostart: z.boolean().optional(),
  url: z.string().url().optional(),
  env: z.record(z.string()).optional(),
});

/** `~/.relavium/config.toml` — global preferences + MCP registrations. */
export const GlobalConfigSchema = z.object({
  update_channel: UpdateChannelSchema.optional(),
  preferences: z
    .object({
      default_model: z.string().optional(),
      theme: z.string().optional(),
    })
    .optional(),
  mcp_servers: z.array(McpServerRegistrationSchema).optional(),
});
export type GlobalConfig = z.infer<typeof GlobalConfigSchema>;

/** `project.toml` / `workspace.toml` — project defaults + shared variables. */
export const ProjectConfigSchema = z.object({
  defaults: z
    .object({
      model: z.string().optional(),
      fs_scope: FsScopeSchema.optional(),
    })
    .optional(),
  variables: z.record(z.string()).optional(),
});
export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;
