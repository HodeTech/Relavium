// A deterministic stdio MCP **server that refuses to die politely** — the fixture the orphan-reap e2e needs.
//
// The MCP SDK's `StdioClientTransport.close()` is a ladder: `stdin.end()` → race(exit, 2 s) → `SIGTERM` →
// race(exit, 2 s) → `SIGKILL`. Every well-behaved server exits on the first rung, which is exactly why the
// happy-path fixture cannot prove anything about orphaning: it dies whatever the host does.
//
// This one ignores stdin EOF and traps `SIGTERM`/`SIGINT`/`SIGHUP`, so it survives every rung except the last.
// That makes it the only fixture that can tell the difference between "the host reaped the child" and "the
// child would have exited anyway" — which is what ADR-0088 §11 means by asserting on the actual child-process
// state rather than on a promise. `SIGKILL` is uncatchable, so the test still terminates.
//
// It speaks real MCP (one `ping` tool) so the host's connect + discovery succeed and the test reaches the
// teardown it is actually about.
import process from 'node:process';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.on(signal, () => {
    // Deliberately nothing. A real server doing cleanup here behaves the same way for the first few seconds.
  });
}
// Hold the loop open independently of stdin, so closing our stdin does not end the process either.
setInterval(() => {}, 1_000);

const server = new McpServer({ name: 'stubborn-fixture', version: '1.0.0' });
server.registerTool(
  'ping',
  { description: 'answers pong', inputSchema: { note: z.string().optional() } },
  () => ({ content: [{ type: 'text', text: 'pong' }] }),
);

try {
  await server.connect(new StdioServerTransport());
} catch (error) {
  process.stderr.write(`stubborn-mcp-server failed to start: ${String(error)}\n`);
  process.exit(1);
}
