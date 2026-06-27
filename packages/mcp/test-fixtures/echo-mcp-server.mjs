// A deterministic, dependency-light stdio MCP **server** used by the real-spawn e2e (2.R Step 5).
//
// It is NOT part of the shipped package — it is a test fixture the CLI host actually spawns over stdio
// (`node <this file>`) so the inbound-MCP client path (spawn → initialize → tools/list → tools/call →
// teardown) is exercised against a genuine `@modelcontextprotocol/sdk` server, not a fake. It lives under
// `packages/mcp` because that is the only workspace where the SDK resolves (the seam owner); the SDK +
// `node:*` confinement that the four `sdk-*.ts` adapters enforce does not apply to a standalone test process.
//
// Three tools, all deterministic and offline:
//   - `echo`    → returns its `text` argument verbatim (the round-trip proof);
//   - `add`     → returns `a + b` as text (a second tool, so multi-tool discovery is asserted);
//   - `whoami`  → returns the `MCP_FIXTURE_TOKEN` env var the host injected — proves a `{{secrets.*}}` value
//                 actually reaches the spawned child process (the last hop of the secret-custody chain).
//
// Fail-fast: any startup error exits non-zero so the spawning host's fail-loud connect surfaces it.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'echo-fixture', version: '1.0.0' });

server.registerTool(
  'echo',
  { description: 'Echo the provided text back unchanged.', inputSchema: { text: z.string() } },
  ({ text }) => ({ content: [{ type: 'text', text }] }),
);

server.registerTool(
  'add',
  {
    description: 'Add two integers and return the sum as text.',
    inputSchema: { a: z.number(), b: z.number() },
  },
  ({ a, b }) => ({ content: [{ type: 'text', text: String(a + b) }] }),
);

server.registerTool(
  'whoami',
  {
    description: 'Return the MCP_FIXTURE_TOKEN env var the host injected into this child process.',
  },
  () => ({ content: [{ type: 'text', text: process.env.MCP_FIXTURE_TOKEN ?? '' }] }),
);

await server.connect(new StdioServerTransport());
