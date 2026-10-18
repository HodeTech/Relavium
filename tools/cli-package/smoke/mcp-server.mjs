import { Buffer } from 'node:buffer';
import { appendFileSync, existsSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
const log = process.env.RELAVIUM_PACKAGE_SMOKE_MCP_LOG;
if (!log) throw new Error('Explicit MCP fixture log required');
const record = (value) => {
  const line = JSON.stringify(value) + '\n';
  if (
    Buffer.byteLength(line) > 65536 ||
    (existsSync(log) && statSync(log).size + Buffer.byteLength(line) > 262144)
  )
    throw new Error('MCP fixture record byte ceiling exceeded');
  appendFileSync(log, line, { mode: 0o600 });
};
record({ operation: 'started', pid: process.pid });
const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => {
  if (Buffer.byteLength(line) > 65536) throw new Error('MCP fixture line ceiling');
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    record({ operation: 'initialize', params: message.params });
    process.stdout.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          protocolVersion: message.params.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: 'installed-package-smoke', version: '1.0.0' },
        },
      }) + '\n',
    );
  } else if (message.method === 'tools/list') {
    record({ operation: 'tools/list' });
    process.stdout.write(
      JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { tools: [] } }) + '\n',
    );
  } else if (message.id !== undefined) {
    throw new Error('Unexpected MCP fixture request');
  }
});
lines.on('close', () => {
  record({ operation: 'closed' });
});
