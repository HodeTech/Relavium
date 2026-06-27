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

/** Narrow the capability's `unknown` result to the Relavium tool-result shape for assertion. */
const asResult = (value: unknown): McpToolResult => value as McpToolResult;

describe('inbound MCP — real stdio spawn (2.R Step 5)', () => {
  it('chat host: spawns the fixture, discovers + namespaces its tools, round-trips a real tools/call', async () => {
    const client = await connectAgentMcp([echoServer()], { cwd: process.cwd() });
    expect(client).toBeDefined();
    try {
      // Discovery: both fixture tools are namespaced `mcp_{server}_{tool}`, grouped under the server id.
      expect([...(client!.toolIdsByServer.get('echo') ?? [])].sort()).toEqual([
        'mcp_echo_add',
        'mcp_echo_echo',
      ]);
      expect(client!.toolDefs.map((d) => d.id).sort()).toEqual(['mcp_echo_add', 'mcp_echo_echo']);
      expect(client!.skipped).toEqual([]);

      // A real tools/call over the spawned child round-trips (echo returns its text verbatim).
      const echoed = asResult(
        await client!.capability.call({ server: 'echo', tool: 'echo', args: { text: 'pong' } }),
      );
      expect(echoed.isError).toBe(false);
      expect(echoed.content).toEqual([{ type: 'text', text: 'pong' }]);

      // The second tool proves multi-tool routing (args validated by the compiled inputSchema).
      const sum = asResult(
        await client!.capability.call({ server: 'echo', tool: 'add', args: { a: 2, b: 40 } }),
      );
      expect(sum.content).toEqual([{ type: 'text', text: '42' }]);
    } finally {
      await client!.close(); // tears the stdio child down (idempotent)
    }
  });

  it('run host: augments the declaring agent grant with the discovered ids and routes a real call', async () => {
    // The absolute spawn command + fixture path are machine-specific, so they're injected (double-quoted —
    // valid YAML flow scalars) rather than hard-coded; the parsed workflow stays immutable.
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
        `        - { id: echo, transport: stdio, command: "${process.execPath}", args: ["${FIXTURE}"] }`,
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

    const runtime = await connectWorkflowMcp(def, { cwd: process.cwd() });
    expect(runtime).toBeDefined();
    try {
      expect([...(runtime!.client.toolIdsByServer.get('echo') ?? [])].sort()).toEqual([
        'mcp_echo_add',
        'mcp_echo_echo',
      ]);

      // The run path unions the agent's declared grant with ITS server's discovered tool ids.
      const augmented = (runtime!.workflow.workflow.agents ?? []).find(
        (e): e is Agent => 'id' in e && e.id === 'scanner',
      )!;
      expect([...(augmented.tools ?? [])].sort()).toEqual([
        'mcp_echo_add',
        'mcp_echo_echo',
        'read_file',
      ]);

      const echoed = asResult(
        await runtime!.client.capability.call({
          server: 'echo',
          tool: 'echo',
          args: { text: 'wired' },
        }),
      );
      expect(echoed.content).toEqual([{ type: 'text', text: 'wired' }]);
    } finally {
      await runtime!.client.close();
    }
  });
});
