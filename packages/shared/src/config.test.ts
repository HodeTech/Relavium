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

  it('accepts the media_job poll/deadline defaults; rejects non-positive (1.AG/ADR-0045 §7)', () => {
    expect(
      ProjectConfigSchema.safeParse({
        defaults: {
          media_job_poll_initial_ms: 5000,
          media_job_poll_max_ms: 30000,
          media_job_deadline_ms: 1_800_000,
        },
      }).success,
    ).toBe(true);
    expect(
      ProjectConfigSchema.safeParse({ defaults: { media_job_poll_initial_ms: 0 } }).success,
    ).toBe(false); // positiveInt rejects 0
    expect(ProjectConfigSchema.safeParse({ defaults: { media_job_deadline_ms: -1 } }).success).toBe(
      false,
    );
    expect(
      ProjectConfigSchema.safeParse({ defaults: { media_job_poll_max_ms: 1.5 } }).success,
    ).toBe(false); // fractional rejected
  });

  it('rejects media_job_poll_max_ms < media_job_poll_initial_ms (cross-field refine)', () => {
    expect(
      ProjectConfigSchema.safeParse({
        defaults: { media_job_poll_initial_ms: 30000, media_job_poll_max_ms: 5000 },
      }).success,
    ).toBe(false);
  });

  it('rejects an unknown/typo config key (strict — ADR-0023 parity)', () => {
    expect(GlobalConfigSchema.safeParse({ updatechannel: 'stable' }).success).toBe(false); // top-level typo
    expect(
      GlobalConfigSchema.safeParse({ preferences: { theme: 'dark', themer: 'x' } }).success,
    ).toBe(false); // nested typo
    expect(ProjectConfigSchema.safeParse({ varaibles: { a: '1' } }).success).toBe(false);
    expect(ProjectConfigSchema.safeParse({ defaults: { modell: 'x' } }).success).toBe(false); // nested defaults typo
    expect(
      ProjectConfigSchema.safeParse({ chat: { default_model: 'm', maxx_messages: 1 } }).success,
    ).toBe(false); // [chat] typo
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

  it('accepts `allow_local_endpoint` on a network MCP registration (ADR-0053 §3)', () => {
    expect(
      GlobalConfigSchema.safeParse({
        mcp_servers: [
          {
            name: 'local',
            transport: 'http',
            url: 'http://localhost:4000/mcp',
            allow_local_endpoint: true,
          },
        ],
      }).success,
    ).toBe(true);
  });

  it('accepts a `websocket` MCP registration with a ws(s) url, rejecting a non-ws scheme (ADR-0052 §5)', () => {
    expect(
      GlobalConfigSchema.safeParse({
        mcp_servers: [{ name: 'live', transport: 'websocket', url: 'wss://host/mcp' }],
      }).success,
    ).toBe(true);
    expect(
      GlobalConfigSchema.safeParse({
        mcp_servers: [{ name: 'live', transport: 'websocket', url: 'https://host/mcp' }],
      }).success,
    ).toBe(false); // websocket → ws(s), not http(s)
    expect(
      GlobalConfigSchema.safeParse({ mcp_servers: [{ name: 'live', transport: 'websocket' }] })
        .success,
    ).toBe(false); // websocket needs url
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

  it('rejects an unknown/typo key in an MCP registration (strict — ADR-0033)', () => {
    // `autostrat` is a typo for `autostart`; McpServerRegistrationSchema.strict() rejects it
    // rather than silently dropping it (config files are strict per ADR-0033).
    expect(
      GlobalConfigSchema.safeParse({
        mcp_servers: [{ name: 'x', transport: 'stdio', command: 'npx', autostrat: true }],
      }).success,
    ).toBe(false);
  });

  it('accepts defaults.max_tokens_estimate (ADR-0028 pre-egress estimate)', () => {
    expect(
      ProjectConfigSchema.safeParse({ defaults: { model: 'gpt-4o', max_tokens_estimate: 4096 } })
        .success,
    ).toBe(true);
    // It is a positive integer.
    expect(ProjectConfigSchema.safeParse({ defaults: { max_tokens_estimate: 0 } }).success).toBe(
      false,
    );
  });

  it('accepts defaults.media_cost_estimate (1.AF/D17 per-modality unit counts) and rejects bad shapes', () => {
    expect(
      ProjectConfigSchema.safeParse({
        defaults: { media_cost_estimate: { image: 2, audio: 60, video: 10 } },
      }).success,
    ).toBe(true);
    // A partial subset is fine (only the declared modalities).
    expect(
      ProjectConfigSchema.safeParse({ defaults: { media_cost_estimate: { image: 1 } } }).success,
    ).toBe(true);
    // Non-negative integers — a negative count is rejected.
    expect(
      ProjectConfigSchema.safeParse({ defaults: { media_cost_estimate: { image: -1 } } }).success,
    ).toBe(false);
    // Strict: `document` is not a billed output modality (no such key).
    expect(
      ProjectConfigSchema.safeParse({ defaults: { media_cost_estimate: { document: 1 } } }).success,
    ).toBe(false);
  });

  it('accepts a [chat] block (agent-session defaults) and rejects a bad on_exceed', () => {
    expect(
      ProjectConfigSchema.safeParse({
        chat: {
          default_model: 'claude-sonnet-4-6',
          fs_scope: 'sandboxed',
          max_turns: 50,
          max_messages: 200,
          max_cost_microcents: 5000000,
          on_exceed: 'pause_for_approval',
        },
      }).success,
    ).toBe(true);
    expect(ProjectConfigSchema.safeParse({ chat: { on_exceed: 'explode' } }).success).toBe(false);
    // 0 = unbounded here (nonNegativeInt) — deliberately unlike the workflow budget's positiveInt.
    expect(ProjectConfigSchema.safeParse({ chat: { max_cost_microcents: 0 } }).success).toBe(true);
  });

  it('accepts [chat].max_turns (the hard turn cap → SessionDeps.maxTurns) as a positive int only', () => {
    // max_turns is the surface-mapped hard session turn cap, DISTINCT from max_messages (history-trim).
    expect(ProjectConfigSchema.safeParse({ chat: { max_turns: 10 } }).success).toBe(true);
    // positiveInt rejects 0 and negatives here at the config layer; only an ABSENT max_turns falls
    // back to the engine default downstream (0 never reaches the engine's `<= 0 ⇒ default` arm).
    expect(ProjectConfigSchema.safeParse({ chat: { max_turns: 0 } }).success).toBe(false);
    expect(ProjectConfigSchema.safeParse({ chat: { max_turns: -1 } }).success).toBe(false);
    expect(ProjectConfigSchema.safeParse({ chat: { max_turns: 1.5 } }).success).toBe(false);
    // .strict() still rejects an unknown/typo key alongside the new field.
    expect(ProjectConfigSchema.safeParse({ chat: { max_turns: 10, max_turn: 5 } }).success).toBe(
      false,
    );
  });
});
