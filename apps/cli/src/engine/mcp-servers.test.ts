import { parseWorkflow, type WorkflowDefinition } from '@relavium/core';
import { McpError, type McpClient, type McpServerConfig } from '@relavium/mcp';
import type { Agent, McpServerRef } from '@relavium/shared';
import { describe, expect, it } from 'vitest';

import { CliError, isCliError } from '../process/errors.js';
import { captureIo } from '../test-support.js';
import {
  buildChildEnv,
  connectAgentMcp,
  connectWorkflowMcp,
  resolveStdioServerConfigs,
  surfaceMcpSkipped,
} from './mcp-servers.js';

/** A fake live client — the injected `startMcpClient` returns it, so no child is ever spawned. */
function fakeClient(overrides: Partial<McpClient> = {}): McpClient {
  return {
    capability: { call: () => Promise.resolve({ content: [], isError: false }) },
    toolDefs: [],
    toolIdsByServer: new Map(),
    skipped: [],
    close: () => Promise.resolve(),
    ...overrides,
  };
}

const stdioRef = (over: Partial<McpServerRef> = {}): McpServerRef => ({
  id: 'fs',
  transport: 'stdio',
  command: 'my-server',
  ...over,
});

describe('resolveStdioServerConfigs', () => {
  it('maps a stdio ref to a config carrying its id + allowlist (open is a deferred spawn closure)', () => {
    const configs = resolveStdioServerConfigs(
      [stdioRef({ tools_allowlist: ['read', 'write'] })],
      '/work',
    );
    expect(configs).toHaveLength(1);
    expect(configs[0]?.id).toBe('fs');
    expect(configs[0]?.toolsAllowlist).toEqual(['read', 'write']);
    expect(typeof configs[0]?.open).toBe('function'); // not invoked here — no spawn in a unit test
  });

  it('omits toolsAllowlist when the ref declares none (exactOptionalPropertyTypes — never an explicit undefined)', () => {
    const configs = resolveStdioServerConfigs([stdioRef()], '/work');
    expect('toolsAllowlist' in configs[0]!).toBe(false);
  });

  it('returns an empty list for undefined / empty mcp_servers', () => {
    expect(resolveStdioServerConfigs(undefined, '/work')).toEqual([]);
    expect(resolveStdioServerConfigs([], '/work')).toEqual([]);
  });

  it('rejects a network transport as a typed exit-2 CliError (stdio only until the Step-4 follow-up)', () => {
    // `sse`/`websocket` are valid schema transports but not yet wired — fail loud, never a silent skip.
    for (const transport of ['sse', 'websocket'] as const) {
      try {
        resolveStdioServerConfigs([{ id: 'x', transport, url: 'https://h/mcp' }], '/work');
        expect.unreachable('a network transport must throw');
      } catch (err) {
        expect(isCliError(err) && err.code).toBe('invalid_invocation');
        expect((err as Error).message).toContain(transport);
      }
    }
  });

  it('rejects a stdio ref with no command (defensive — the schema guarantees it, but the spawn must be total)', () => {
    // Construct the ref directly (bypassing the schema superRefine) to exercise the host-side guard.
    const bad: McpServerRef = { id: 'fs', transport: 'stdio' };
    expect(() => resolveStdioServerConfigs([bad], '/work')).toThrow(/requires a 'command'/);
  });

  it('rejects an env value carrying a {{…}} marker when NO secret resolver is wired', () => {
    try {
      resolveStdioServerConfigs([stdioRef({ env: { TOKEN: '{{secrets.gh}}' } })], '/work');
      expect.unreachable('a {{…}} env value must throw');
    } catch (err) {
      expect(isCliError(err) && err.code).toBe('invalid_invocation');
      // The error names the KEY, never the value — a placeholder is not a secret, but stay disciplined.
      expect((err as Error).message).toContain('TOKEN');
      expect((err as Error).message).not.toContain('secrets.gh');
    }
  });

  it('accepts a literal env value (the common case)', () => {
    expect(() =>
      resolveStdioServerConfigs([stdioRef({ env: { LOG_LEVEL: 'debug' } })], '/work'),
    ).not.toThrow();
  });
});

describe('buildChildEnv (secret interpolation, 2.R Step 4)', () => {
  it('resolves {{secrets.<name>}} into the child env value via the resolver (whole + embedded)', () => {
    const env = buildChildEnv(
      'fs',
      { TOKEN: '{{secrets.gh}}', AUTH: 'Bearer {{ secrets.gh }}' },
      (name) => (name === 'gh' ? 'ghp_resolved' : 'OTHER'),
    );
    expect(env).toEqual({ TOKEN: 'ghp_resolved', AUTH: 'Bearer ghp_resolved' });
  });

  it('passes a literal env value through unchanged', () => {
    expect(buildChildEnv('fs', { LOG: 'debug' }, () => 'x')).toEqual({ LOG: 'debug' });
  });

  it('propagates the resolver fail-closed throw (a missing secret fails the build, never a literal)', () => {
    expect(() =>
      buildChildEnv('fs', { TOKEN: '{{secrets.missing}}' }, () => {
        throw new CliError('invalid_invocation', "MCP secret 'missing' is not set");
      }),
    ).toThrow(/is not set/);
  });

  it('rejects a non-secret interpolation (only {{secrets.<name>}} is supported), even with a resolver', () => {
    try {
      buildChildEnv('fs', { HOST: '{{env.HOSTNAME}}' }, () => 'x');
      expect.unreachable('an unsupported interpolation must throw');
    } catch (err) {
      expect(isCliError(err) && err.code).toBe('invalid_invocation');
      expect((err as Error).message).toContain('HOST'); // names the key
      expect((err as Error).message).toContain('only {{secrets.<name>}}');
    }
  });

  it('rejects a {{secrets.…}} when no resolver is wired (the value is never passed literally)', () => {
    expect(() => buildChildEnv('fs', { TOKEN: '{{secrets.gh}}' })).toThrow(
      /unsupported interpolation/,
    );
  });
});

describe('connectAgentMcp', () => {
  it('returns undefined when the agent declares no servers (no client, nothing to tear down)', async () => {
    const client = await connectAgentMcp(undefined, { cwd: '/work' });
    expect(client).toBeUndefined();
  });

  it('starts the resolved stdio configs via the injected starter and returns the live client', async () => {
    let seen: readonly McpServerConfig[] | undefined;
    const expected = fakeClient({
      skipped: [{ server: 'fs', name: 'bad', reason: 'unsupported' }],
    });
    const client = await connectAgentMcp([stdioRef()], {
      cwd: '/work',
      startMcpClient: (servers) => {
        seen = servers;
        return Promise.resolve(expected);
      },
    });
    expect(seen?.[0]?.id).toBe('fs'); // the resolver's config reached the starter
    expect(client).toBe(expected);
  });

  it('wraps an McpError connect failure as a typed CliError with the secret-free message, no cause', async () => {
    const promise = connectAgentMcp([stdioRef()], {
      cwd: '/work',
      startMcpClient: () => Promise.reject(new McpError('spawn failed for "fs"')),
    });
    await expect(promise).rejects.toMatchObject({ code: 'invalid_invocation' });
    await promise.catch((err: unknown) => {
      expect((err as Error).message).toContain('spawn failed for "fs"');
      expect((err as Error).cause).toBeUndefined(); // the opaque cause chain is never attached
    });
  });

  it('rethrows a non-McpError failure unchanged (an unexpected fault is not masked as invalid_invocation)', async () => {
    const boom = new TypeError('unexpected');
    await expect(
      connectAgentMcp([stdioRef()], { cwd: '/work', startMcpClient: () => Promise.reject(boom) }),
    ).rejects.toBe(boom);
  });
});

describe('connectWorkflowMcp (run path)', () => {
  // A minimal valid workflow whose inline `agents:` block is the parameter under test.
  const wf = (agentsYaml: string): WorkflowDefinition =>
    parseWorkflow(
      `schema_version: '1.0'\nworkflow:\n  id: wf\n  agents:\n${agentsYaml}  nodes:\n    - { id: s, type: input }\n    - { id: a, type: agent, agent_ref: scanner, prompt_template: go }\n    - { id: o, type: output }\n  edges:\n    - { from: s, to: a }\n    - { from: a, to: o }\n`,
    );
  const agentOf = (def: WorkflowDefinition, id: string): Agent =>
    (def.workflow.agents ?? []).find((e): e is Agent => 'id' in e && e.id === id)!;
  // A fake client whose per-server grouping the augmentation reads (the configs reaching it are ignored).
  const fakeStart =
    (toolIdsByServer: ReadonlyMap<string, readonly string[]>) => (): Promise<McpClient> =>
      Promise.resolve(fakeClient({ toolIdsByServer }));

  it('returns undefined when no inline agent declares a server', async () => {
    const def = wf(
      `    - { id: scanner, model: claude-sonnet-4-6, provider: anthropic, system_prompt: go }\n`,
    );
    expect(
      await connectWorkflowMcp(def, { cwd: '/w', startMcpClient: fakeStart(new Map()) }),
    ).toBeUndefined();
  });

  it('augments ONLY the declaring agent grant with ITS server tool ids (per-agent isolation)', async () => {
    const def = wf(
      [
        '    - id: scanner',
        '      model: claude-sonnet-4-6',
        '      provider: anthropic',
        '      system_prompt: go',
        '      tools: [read_file]',
        '      mcp_servers: [{ id: fs, transport: stdio, command: x }]',
        '    - id: other',
        '      model: claude-sonnet-4-6',
        '      provider: anthropic',
        '      system_prompt: go',
        '      tools: [git_status]',
        '',
      ].join('\n'),
    );
    const runtime = await connectWorkflowMcp(def, {
      cwd: '/w',
      startMcpClient: fakeStart(new Map([['fs', ['mcp_fs_read', 'mcp_fs_write']]])),
    });
    expect(runtime).toBeDefined();
    // The declaring agent's grant gains its server's ids (union with the original); the other is untouched.
    expect(agentOf(runtime!.workflow, 'scanner').tools).toEqual([
      'read_file',
      'mcp_fs_read',
      'mcp_fs_write',
    ]);
    expect(agentOf(runtime!.workflow, 'other').tools).toEqual(['git_status']);
  });

  it('shares ONE connection when two agents declare an identical server (dedup by id)', async () => {
    let startedWith: readonly McpServerConfig[] | undefined;
    const def = wf(
      [
        '    - { id: scanner, model: claude-sonnet-4-6, provider: anthropic, system_prompt: go, mcp_servers: [{ id: fs, transport: stdio, command: x }] }',
        '    - { id: writer, model: claude-sonnet-4-6, provider: anthropic, system_prompt: go, mcp_servers: [{ id: fs, transport: stdio, command: x }] }',
        '',
      ].join('\n'),
    );
    const runtime = await connectWorkflowMcp(def, {
      cwd: '/w',
      startMcpClient: (servers) => {
        startedWith = servers;
        return Promise.resolve(fakeClient({ toolIdsByServer: new Map([['fs', ['mcp_fs_read']]]) }));
      },
    });
    expect(startedWith).toHaveLength(1); // the duplicate `fs` declaration collapsed to one connection
    // BOTH agents are granted the shared server's tools.
    expect(agentOf(runtime!.workflow, 'scanner').tools).toEqual(['mcp_fs_read']);
    expect(agentOf(runtime!.workflow, 'writer').tools).toEqual(['mcp_fs_read']);
  });

  it('fails loud when two agents declare the same server id with conflicting settings', async () => {
    const def = wf(
      [
        '    - { id: scanner, model: claude-sonnet-4-6, provider: anthropic, system_prompt: go, mcp_servers: [{ id: fs, transport: stdio, command: x }] }',
        '    - { id: writer, model: claude-sonnet-4-6, provider: anthropic, system_prompt: go, mcp_servers: [{ id: fs, transport: stdio, command: DIFFERENT }] }',
        '',
      ].join('\n'),
    );
    await expect(
      connectWorkflowMcp(def, { cwd: '/w', startMcpClient: fakeStart(new Map()) }),
    ).rejects.toThrow(/conflicting settings/);
  });

  it('fails loud when two agents share a server id but declare DIFFERENT tools_allowlist (no escalation)', async () => {
    // One physical connection cannot honor two allowlists — collapsing them would grant BOTH agents the union,
    // escalating the narrower agent past its declared grant. `tools_allowlist` is part of the dedup identity.
    const narrowVsNarrow = wf(
      [
        '    - { id: scanner, model: claude-sonnet-4-6, provider: anthropic, system_prompt: go, mcp_servers: [{ id: fs, transport: stdio, command: x, tools_allowlist: [read, write] }] }',
        '    - { id: writer, model: claude-sonnet-4-6, provider: anthropic, system_prompt: go, mcp_servers: [{ id: fs, transport: stdio, command: x, tools_allowlist: [read] }] }',
        '',
      ].join('\n'),
    );
    await expect(
      connectWorkflowMcp(narrowVsNarrow, { cwd: '/w', startMcpClient: fakeStart(new Map()) }),
    ).rejects.toThrow(/conflicting settings/);

    // The escalation direction: absent allowlist (all tools) vs an explicit narrow — also a conflict.
    const absentVsNarrow = wf(
      [
        '    - { id: scanner, model: claude-sonnet-4-6, provider: anthropic, system_prompt: go, mcp_servers: [{ id: fs, transport: stdio, command: x }] }',
        '    - { id: writer, model: claude-sonnet-4-6, provider: anthropic, system_prompt: go, mcp_servers: [{ id: fs, transport: stdio, command: x, tools_allowlist: [read] }] }',
        '',
      ].join('\n'),
    );
    await expect(
      connectWorkflowMcp(absentVsNarrow, { cwd: '/w', startMcpClient: fakeStart(new Map()) }),
    ).rejects.toThrow(/conflicting settings/);
  });

  it('shares one connection when two agents share a server id with the SAME allowlist (order-insensitive)', async () => {
    // The allowlist is a set — declaration order must NOT spuriously conflict. `[read, write]` ≡ `[write, read]`.
    let startedWith: readonly McpServerConfig[] | undefined;
    const def = wf(
      [
        '    - { id: scanner, model: claude-sonnet-4-6, provider: anthropic, system_prompt: go, mcp_servers: [{ id: fs, transport: stdio, command: x, tools_allowlist: [read, write] }] }',
        '    - { id: writer, model: claude-sonnet-4-6, provider: anthropic, system_prompt: go, mcp_servers: [{ id: fs, transport: stdio, command: x, tools_allowlist: [write, read] }] }',
        '',
      ].join('\n'),
    );
    const runtime = await connectWorkflowMcp(def, {
      cwd: '/w',
      startMcpClient: (servers) => {
        startedWith = servers;
        return Promise.resolve(fakeClient({ toolIdsByServer: new Map([['fs', ['mcp_fs_read']]]) }));
      },
    });
    expect(startedWith).toHaveLength(1); // same set, different order ⇒ one shared connection (no false conflict)
    expect(agentOf(runtime!.workflow, 'scanner').tools).toEqual(['mcp_fs_read']);
  });

  it('isolates grants across agents declaring DIFFERENT servers (A gets fs only, B gets gh only)', async () => {
    const def = wf(
      [
        '    - { id: scanner, model: claude-sonnet-4-6, provider: anthropic, system_prompt: go, mcp_servers: [{ id: fs, transport: stdio, command: x }] }',
        '    - { id: writer, model: claude-sonnet-4-6, provider: anthropic, system_prompt: go, mcp_servers: [{ id: gh, transport: stdio, command: y }] }',
        '',
      ].join('\n'),
    );
    const runtime = await connectWorkflowMcp(def, {
      cwd: '/w',
      startMcpClient: fakeStart(
        new Map([
          ['fs', ['mcp_fs_read']],
          ['gh', ['mcp_gh_issue']],
        ]),
      ),
    });
    // Each agent is granted ONLY its own server's tools — never the other's.
    expect(agentOf(runtime!.workflow, 'scanner').tools).toEqual(['mcp_fs_read']);
    expect(agentOf(runtime!.workflow, 'writer').tools).toEqual(['mcp_gh_issue']);
  });

  it('leaves a $ref agent entry byte-identical, augmenting only the inline agent', async () => {
    const def = wf(
      [
        '    - { $ref: ./reviewer.agent.yaml }',
        '    - { id: scanner, model: claude-sonnet-4-6, provider: anthropic, system_prompt: go, mcp_servers: [{ id: fs, transport: stdio, command: x }] }',
        '',
      ].join('\n'),
    );
    const runtime = await connectWorkflowMcp(def, {
      cwd: '/w',
      startMcpClient: fakeStart(new Map([['fs', ['mcp_fs_read']]])),
    });
    const entries = runtime!.workflow.workflow.agents ?? [];
    expect(entries[0]).toEqual({ $ref: './reviewer.agent.yaml' }); // the $ref passes through untouched
    expect(agentOf(runtime!.workflow, 'scanner').tools).toEqual(['mcp_fs_read']);
  });
});

describe('surfaceMcpSkipped', () => {
  it('writes one stderr note per dropped tool (name + server + reason), nothing on an empty list', () => {
    const { io, err, out } = captureIo();
    surfaceMcpSkipped(io, []);
    expect(err()).toBe(''); // nothing dropped ⇒ silent (the common case)

    surfaceMcpSkipped(io, [
      { server: 'fs', name: 'danger', reason: 'not in tools_allowlist' },
      { server: 'gh', name: 'bad-id!', reason: 'unsafe LLM tool name' },
    ]);
    const lines = err().trimEnd().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("MCP tool 'danger' (server 'fs')");
    expect(lines[0]).toContain('not in tools_allowlist');
    expect(lines[1]).toContain("MCP tool 'bad-id!' (server 'gh')");
    expect(out()).toBe(''); // diagnostics stay on stderr — stdout (the --json stream) is untouched
  });

  it('sanitizes a hostile server-controlled tool name + reason (no terminal-escape injection reaches the TTY)', () => {
    // `name`/`reason` are server-controlled and the MCP server is in-threat-model untrusted (ADR-0052 §4): a
    // crafted tool returning ANSI/OSC control bytes must NOT write them raw to the operator's terminal.
    const { io, err } = captureIo();
    surfaceMcpSkipped(io, [
      { server: 'fs', name: 'evil\x1b[2J\x1b]0;pwned\x07', reason: 'bad\x1b[31m schema\x1b[0m' },
    ]);
    const written = err();
    // eslint-disable-next-line no-control-regex -- asserting the ABSENCE of control bytes is the point
    expect(/[\x00-\x1f\x7f]/.test(written.replace(/\n$/, ''))).toBe(false); // none survived (besides the \n)
    expect(written).not.toContain('\x1b'); // the ESC that opens every escape sequence is gone
  });
});
