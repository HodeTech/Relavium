import { McpError, type McpClient, type McpServerConfig } from '@relavium/mcp';
import type { McpServerRef } from '@relavium/shared';
import { describe, expect, it } from 'vitest';

import { isCliError } from '../process/errors.js';
import { connectAgentMcp, resolveStdioServerConfigs } from './mcp-servers.js';

/** A fake live client — the injected `startMcpClient` returns it, so no child is ever spawned. */
function fakeClient(overrides: Partial<McpClient> = {}): McpClient {
  return {
    capability: { call: () => Promise.resolve({ content: [], isError: false }) },
    toolDefs: [],
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

  it('rejects an env value carrying a {{…}} marker (secret interpolation is a Step-4 follow-up)', () => {
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
