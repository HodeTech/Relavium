import { describe, expect, it } from 'vitest';

import type { DiscoveredTool, McpConnection, McpToolResult } from './connection.js';
import { startMcpClient } from './manager.js';

interface FakeOpts {
  readonly onCall?: (name: string, args: unknown) => Promise<McpToolResult>;
  readonly onClose?: () => void;
  readonly listThrows?: boolean;
}

function fakeConnection(tools: readonly DiscoveredTool[], opts: FakeOpts = {}): McpConnection {
  return {
    listTools: () =>
      opts.listThrows ? Promise.reject(new Error('tools/list failed')) : Promise.resolve(tools),
    callTool: (name, args) =>
      opts.onCall
        ? opts.onCall(name, args)
        : Promise.resolve({ content: [{ type: 'text', text: name }], isError: false }),
    close: () => {
      opts.onClose?.();
      return Promise.resolve();
    },
  };
}

const t = (name: string): DiscoveredTool => ({
  name,
  inputSchema: { type: 'object', properties: {} },
});

describe('startMcpClient', () => {
  it('connects all servers and aggregates their namespaced toolDefs', async () => {
    const client = await startMcpClient([
      { id: 'github', open: () => Promise.resolve(fakeConnection([t('create_issue')])) },
      { id: 'fs', open: () => Promise.resolve(fakeConnection([t('read_file'), t('write')])) },
    ]);
    expect(client.toolDefs.map((d) => d.id).sort()).toEqual([
      'mcp_fs_read_file',
      'mcp_fs_write',
      'mcp_github_create_issue',
    ]);
    await client.close();
  });

  it('routes a tool call to the owning connection (by server id)', async () => {
    const calls: string[] = [];
    const conn = (id: string): McpConnection =>
      fakeConnection([t('x')], {
        onCall: (name) => {
          calls.push(`${id}:${name}`);
          return Promise.resolve({ content: [], isError: false });
        },
      });
    const client = await startMcpClient([
      { id: 'a', open: () => Promise.resolve(conn('a')) },
      { id: 'b', open: () => Promise.resolve(conn('b')) },
    ]);
    await client.capability.call({ server: 'b', tool: 'x', args: {} });
    expect(calls).toEqual(['b:x']);
    await client.close();
  });

  it('fails loud if a server cannot be opened, tearing down already-opened connections', async () => {
    let closed = false;
    const ok = fakeConnection([t('x')], { onClose: () => (closed = true) });
    await expect(
      startMcpClient([
        { id: 'ok', open: () => Promise.resolve(ok) },
        { id: 'bad', open: () => Promise.reject(new Error('spawn failed')) },
      ]),
    ).rejects.toThrow(/"bad"/); // McpConnectError names the server id
    expect(closed).toBe(true); // the already-opened 'ok' connection was torn down
  });

  it('fails loud if tools/list fails at discovery', async () => {
    await expect(
      startMcpClient([
        { id: 's', open: () => Promise.resolve(fakeConnection([], { listThrows: true })) },
      ]),
    ).rejects.toThrow(/"s"/);
  });

  it('rejects a duplicate server id (the routing key must be unique)', async () => {
    await expect(
      startMcpClient([
        { id: 'x', open: () => Promise.resolve(fakeConnection([])) },
        { id: 'x', open: () => Promise.resolve(fakeConnection([])) },
      ]),
    ).rejects.toThrow(/duplicate MCP server id/);
  });

  it('rejects a call to an unknown server', async () => {
    const client = await startMcpClient([
      { id: 'a', open: () => Promise.resolve(fakeConnection([t('x')])) },
    ]);
    await expect(client.capability.call({ server: 'nope', tool: 'x', args: {} })).rejects.toThrow(
      /no MCP connection/,
    );
    await client.close();
  });

  it('close() tears down every connection; skipped tools are tagged per server', async () => {
    const closes: string[] = [];
    const client = await startMcpClient([
      {
        id: 'a',
        toolsAllowlist: ['keep'],
        open: () =>
          Promise.resolve(
            fakeConnection([t('keep'), t('drop')], { onClose: () => closes.push('a') }),
          ),
      },
    ]);
    expect(client.toolDefs.map((d) => d.id)).toEqual(['mcp_a_keep']);
    expect(client.skipped).toEqual([
      { server: 'a', name: 'drop', reason: 'not in the server tools_allowlist' },
    ]);
    await client.close();
    expect(closes).toEqual(['a']);
  });
});
