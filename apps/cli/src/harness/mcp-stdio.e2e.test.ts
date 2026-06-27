import { fileURLToPath } from 'node:url';

import { parseWorkflow } from '@relavium/core';
import type { McpToolResult } from '@relavium/mcp';
import type { Agent, McpServerRef } from '@relavium/shared';
import { describe, expect, it } from 'vitest';

import { connectAgentMcp, connectWorkflowMcp } from '../engine/mcp-servers.js';

/**
 * The 2.R Step 5 **real-spawn** MCP e2e — the inbound-MCP host path exercised against a genuine
 * `@modelcontextprotocol/sdk` server (NOT a fake `startMcpClient`). The CLI host actually spawns a stdio MCP
 * child (`node <fixture>`), runs the `initialize` + `tools/list` handshake, namespaces the discovered tools,
 * routes a real `tools/call`, and tears the child down — covering the seam (`@relavium/mcp` adapters +
 * `node:child_process`) end-to-end that the unit tests stub. Deterministic + offline: the fixture is a local
 * Node child, no LLM, no provider key, no network — so it runs on every PR like the rest of the harness.
 *
 * Two surfaces, two host entry points:
 *  - `connectAgentMcp`  — the **chat** host helper: returns the live client to wire onto the session.
 *  - `connectWorkflowMcp` — the **run** host helper: returns the client PLUS the workflow whose inline agent's
 *    `tools` grant is unioned with its server's discovered tool ids (the run-path's distinctive augmentation).
 *
 * The fixture lives in `packages/mcp/test-fixtures` (the only workspace where the SDK resolves — the seam
 * owner); we spawn it by absolute path with the SAME node binary that runs the test (`process.execPath`).
 */
const FIXTURE = fileURLToPath(
  new URL('../../../../packages/mcp/test-fixtures/echo-mcp-server.mjs', import.meta.url),
);

/** The echo fixture as an inline stdio `McpServerRef`, spawned with this process's node binary. */
const echoServer = (id = 'echo'): McpServerRef => ({
  id,
  transport: 'stdio',
  command: process.execPath,
  args: [FIXTURE],
});

/** Narrow an optional to its value (vitest's `expect(...).toBeDefined()` asserts but does NOT narrow the type). */
function defined<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`expected ${what} to be defined`);
  return value;
}

/** Verify the capability's `unknown` result really is the Relavium tool-result shape, narrowing it (no cast). */
function assertToolResult(value: unknown): asserts value is McpToolResult {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('content' in value) ||
    !('isError' in value) ||
    !Array.isArray(value.content) ||
    typeof value.isError !== 'boolean'
  ) {
    throw new Error('expected an McpToolResult { content[]; isError }');
  }
}

describe('inbound MCP — real stdio spawn (2.R Step 5)', () => {
  it('chat host: spawns the fixture, discovers + namespaces its tools, round-trips a real tools/call', async () => {
    const client = defined(
      await connectAgentMcp([echoServer()], { cwd: process.cwd() }),
      'mcp client',
    );
    try {
      // Discovery: every fixture tool is namespaced `mcp_{server}_{tool}`, grouped under the server id.
      expect([...(client.toolIdsByServer.get('echo') ?? [])].sort()).toEqual([
        'mcp_echo_add',
        'mcp_echo_echo',
        'mcp_echo_whoami',
      ]);
      expect(client.toolDefs.map((d) => d.id).sort()).toEqual([
        'mcp_echo_add',
        'mcp_echo_echo',
        'mcp_echo_whoami',
      ]);
      expect(client.skipped).toEqual([]);

      // A real tools/call over the spawned child round-trips (echo returns its text verbatim).
      const echoed = await client.capability.call({
        server: 'echo',
        tool: 'echo',
        args: { text: 'pong' },
      });
      assertToolResult(echoed);
      expect(echoed.isError).toBe(false);
      expect(echoed.content).toEqual([{ type: 'text', text: 'pong' }]);

      // The second tool proves multi-tool routing (args validated by the compiled inputSchema).
      const sum = await client.capability.call({
        server: 'echo',
        tool: 'add',
        args: { a: 2, b: 40 },
      });
      assertToolResult(sum);
      expect(sum.content).toEqual([{ type: 'text', text: '42' }]);
    } finally {
      await client.close(); // tears the stdio child down (idempotent)
    }
  });

  it('run host: augments the declaring agent grant with the discovered ids and routes a real call', async () => {
    // The absolute spawn command + fixture path are machine-specific, so they're injected via JSON.stringify
    // (a valid YAML flow scalar that escapes Windows backslashes correctly); the parsed workflow stays immutable.
    const def = parseWorkflow(
      [
        "schema_version: '1.0'",
        'workflow:',
        '  id: wf',
        '  agents:',
        '    - id: scanner',
        '      model: claude-sonnet-4-6',
        '      provider: anthropic',
        '      system_prompt: go',
        '      tools: [read_file]',
        '      mcp_servers:',
        `        - { id: echo, transport: stdio, command: ${JSON.stringify(process.execPath)}, args: [${JSON.stringify(FIXTURE)}] }`,
        '  nodes:',
        '    - { id: s, type: input }',
        '    - { id: a, type: agent, agent_ref: scanner, prompt_template: go }',
        '    - { id: o, type: output }',
        '  edges:',
        '    - { from: s, to: a }',
        '    - { from: a, to: o }',
        '',
      ].join('\n'),
    );

    const runtime = defined(
      await connectWorkflowMcp(def, { cwd: process.cwd() }),
      'workflow runtime',
    );
    try {
      expect([...(runtime.client.toolIdsByServer.get('echo') ?? [])].sort()).toEqual([
        'mcp_echo_add',
        'mcp_echo_echo',
        'mcp_echo_whoami',
      ]);

      // The run path unions the agent's declared grant with ITS server's discovered tool ids.
      const scanner = (runtime.workflow.workflow.agents ?? []).find(
        (e): e is Agent => 'id' in e && e.id === 'scanner',
      );
      const augmented = defined(scanner, 'augmented scanner agent');
      expect([...(augmented.tools ?? [])].sort()).toEqual([
        'mcp_echo_add',
        'mcp_echo_echo',
        'mcp_echo_whoami',
        'read_file',
      ]);

      const echoed = await runtime.client.capability.call({
        server: 'echo',
        tool: 'echo',
        args: { text: 'wired' },
      });
      assertToolResult(echoed);
      expect(echoed.content).toEqual([{ type: 'text', text: 'wired' }]);
    } finally {
      await runtime.client.close();
    }
  });

  it('chat host: resolves {{secrets.*}} into the spawned child env (the last hop of the secret-custody chain)', async () => {
    // The secret custody chain end-to-end against a REAL process: a `{{secrets.t}}` env placeholder is resolved
    // by the injected resolver, the host injects it into the spawned child's env, and the child's `whoami` tool
    // round-trips exactly that value back — proving the resolved secret reaches the process (and only there).
    const server: McpServerRef = {
      id: 'echo',
      transport: 'stdio',
      command: process.execPath,
      args: [FIXTURE],
      env: { MCP_FIXTURE_TOKEN: '{{secrets.t}}' },
    };
    const client = defined(
      await connectAgentMcp([server], {
        cwd: process.cwd(),
        resolveSecret: (name) => (name === 't' ? 'SENTINEL-abc123' : ''),
      }),
      'mcp client',
    );
    try {
      // The env injection must not perturb discovery: `whoami` is admitted as a callable LLM tool (not skipped),
      // so the round-trip below proves custody, not merely the direct-dispatch path bypassing the grant.
      expect(client.skipped).toEqual([]);
      expect(client.toolDefs.map((d) => d.id)).toContain('mcp_echo_whoami');

      const who = await client.capability.call({ server: 'echo', tool: 'whoami', args: {} });
      assertToolResult(who);
      expect(who.content).toEqual([{ type: 'text', text: 'SENTINEL-abc123' }]);
    } finally {
      await client.close();
    }
  });
});
