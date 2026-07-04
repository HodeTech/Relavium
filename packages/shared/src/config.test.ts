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

  it('rejects `env` on EVERY network MCP registration (env is injected only into a stdio child — fail-closed)', () => {
    // Mirrors the inline `McpServerRefSchema` guard for http AND websocket: a committed network registration
    // can't carry a dead `env` whose `{{secrets.*}}` would be silently discarded.
    for (const net of [
      { transport: 'http', url: 'https://docs.example/mcp' },
      { transport: 'websocket', url: 'wss://docs.example/ws' },
    ] as const) {
      expect(
        GlobalConfigSchema.safeParse({
          mcp_servers: [{ name: 'docs', ...net, env: { TOKEN: 'x' } }],
        }).success,
      ).toBe(false);
    }
    // env on a stdio registration is still accepted.
    expect(
      GlobalConfigSchema.safeParse({
        mcp_servers: [{ name: 'fs', transport: 'stdio', command: 'npx', env: { TOKEN: 'x' } }],
      }).success,
    ).toBe(true);
  });

  it('rejects the stdio-only fields `command`/`args` on a network MCP registration (symmetric with the inline schema)', () => {
    expect(
      GlobalConfigSchema.safeParse({
        mcp_servers: [{ name: 'docs', transport: 'http', url: 'https://h/mcp', command: 'npx' }],
      }).success,
    ).toBe(false);
    expect(
      GlobalConfigSchema.safeParse({
        mcp_servers: [{ name: 'docs', transport: 'websocket', url: 'wss://h/ws', args: ['--x'] }],
      }).success,
    ).toBe(false);
  });

  it('rejects a stray `url` on a stdio MCP registration (network-only — matches the inline ref schema)', () => {
    // The inline `McpServerRefSchema` rejects a url on stdio; the registration schema must agree so a committed
    // config can't carry a mis-declared stdio server (its scheme is irrelevant — its mere presence is the error).
    expect(
      GlobalConfigSchema.safeParse({
        mcp_servers: [{ name: 'fs', transport: 'stdio', command: 'npx', url: 'https://host/mcp' }],
      }).success,
    ).toBe(false);
  });

  it('rejects `allow_local_endpoint` on a stdio MCP registration (network-only — matches the inline ref schema)', () => {
    // The inline `McpServerRefSchema` (agent.ts) rejects the network-only flag on stdio; the registration
    // schema must agree, so a committed config can't carry a dead opt-in that an equivalent inline entry refuses.
    expect(
      GlobalConfigSchema.safeParse({
        mcp_servers: [
          { name: 'fs', transport: 'stdio', command: 'npx', allow_local_endpoint: true },
        ],
      }).success,
    ).toBe(false);
  });

  it('accepts the deprecated `sse` alias on a registration (symmetric with the inline agent schema, ADR-0052 §5)', () => {
    // `sse` is a deprecated alias of `http` (same http(s) url) — a `[[mcp_servers]]` registration accepts it
    // just like an inline `agent.mcp_servers` entry, so a server can be registered once and `ref`-reused.
    expect(
      GlobalConfigSchema.safeParse({
        mcp_servers: [{ name: 'legacy', transport: 'sse', url: 'https://host/sse' }],
      }).success,
    ).toBe(true);
    expect(
      GlobalConfigSchema.safeParse({
        mcp_servers: [{ name: 'legacy', transport: 'sse', url: 'wss://host/sse' }],
      }).success,
    ).toBe(false); // sse → http(s), not ws(s)
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

  it('accepts [chat].auto_compact + compact_threshold, bounding the threshold to (0, 1] (ADR-0062)', () => {
    expect(
      ProjectConfigSchema.safeParse({ chat: { auto_compact: false, compact_threshold: 0.9 } })
        .success,
    ).toBe(true);
    // A fraction in (0, 1]: 1 (compact only at the very edge) is allowed; 0 and >1 are not; a non-bool
    // auto_compact is rejected. Absent ⇒ the engine defaults (true / 0.8) apply downstream.
    expect(ProjectConfigSchema.safeParse({ chat: { compact_threshold: 1 } }).success).toBe(true);
    expect(ProjectConfigSchema.safeParse({ chat: { compact_threshold: 0 } }).success).toBe(false);
    expect(ProjectConfigSchema.safeParse({ chat: { compact_threshold: 1.5 } }).success).toBe(false);
    expect(ProjectConfigSchema.safeParse({ chat: { auto_compact: 'yes' } }).success).toBe(false);
  });

  it('accepts [chat].allowed_commands / allowed_command_globs (the `!`-shell allowlist — ADR-0061)', () => {
    expect(
      ProjectConfigSchema.safeParse({
        chat: { allowed_commands: ['git status', 'ls -la'], allowed_command_globs: ['git *'] },
      }).success,
    ).toBe(true);
    // Absent ⇒ `!`-shell disabled (secure-by-default) — a bare [chat] is still valid.
    expect(ProjectConfigSchema.safeParse({ chat: {} }).success).toBe(true);
    // An empty-string entry is rejected (nonEmptyString) — an empty allowlist entry can never match.
    expect(ProjectConfigSchema.safeParse({ chat: { allowed_commands: [''] } }).success).toBe(false);
    // A non-array is rejected.
    expect(
      ProjectConfigSchema.safeParse({ chat: { allowed_commands: 'git status' } }).success,
    ).toBe(false);
  });
});
