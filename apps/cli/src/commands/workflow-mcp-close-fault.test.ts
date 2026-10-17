import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startMcpClient, type McpConnection } from '@relavium/mcp';
import { RunEventSchema } from '@relavium/shared';
import { expect, it, vi } from 'vitest';

import { openHistoryStore } from '../history/open.js';
import { invocationFixture } from '../process/invocation.test-support.js';
import { captureIo } from '../test-support.js';
import { runCommand } from './run.js';

it('starts the original fatal clock at a successful manager close fault before a held sibling joins', async () => {
  const root = mkdtempSync(join(tmpdir(), 'relavium-workflow-close-fault-'));
  const configPath = join(root, 'config.toml');
  writeFileSync(configPath, '');
  const workflow = join(root, 'close-fault.relavium.yaml');
  writeFileSync(
    workflow,
    `schema_version: '1.0'
workflow:
  id: close-fault
  agents:
    - id: unused
      provider: anthropic
      model: claude-sonnet-4-6
      system_prompt: synthetic
      mcp_servers: [{id: synthetic, transport: stdio, command: synthetic-never-spawned}]
  nodes:
    - {id: start, type: input}
    - {id: end, type: output}
  edges:
    - {from: start, to: end}
`,
  );
  const f = invocationFixture();
  const output = captureIo();
  let release = (): void => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered = (): void => undefined;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const fault = new Error('synthetic connection close failure');
  const bad = vi.fn(() => Promise.reject(fault));
  const pending = vi.fn(() => {
    entered();
    return held;
  });
  const connection = (close: McpConnection['close']): McpConnection => ({
    listTools: () => Promise.resolve([]),
    callTool: () => Promise.resolve({ content: [], isError: false }),
    close,
  });
  let store: ReturnType<typeof openHistoryStore> | undefined;
  let settled = false;
  const resolveProvider = vi.fn(() => undefined);
  const command = runCommand(
    { workflow, input: [], allowMcpStdio: [] },
    {
      invocation: f.invocation,
      io: output.io,
      global: { cwd: root, configPath, color: false, json: true, verbosity: 'normal' },
      providers: { resolveProvider, keyFor: () => 'synthetic-unused' },
      subscribeSignals: () => () => undefined,
      consentGate: () => Promise.resolve(new Map()),
      startMcpClient: (_configs, signal, work, lifecycle) =>
        startMcpClient(
          [
            { id: 'bad', open: () => Promise.resolve(connection(bad)) },
            { id: 'held', open: () => Promise.resolve(connection(pending)) },
          ],
          signal,
          work,
          lifecycle,
        ),
      openRunStore: (definition, _home, project, captureClose) => {
        store = openHistoryStore(definition, root, project, captureClose);
        return store;
      },
    },
  );
  void command.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  try {
    await started;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(bad).toHaveBeenCalledOnce();
    expect(pending).toHaveBeenCalledOnce();
    expect(resolveProvider).not.toHaveBeenCalled();
    const events = output
      .out()
      .trim()
      .split('\n')
      .map((line) => RunEventSchema.parse(JSON.parse(line)));
    expect(events.some((event) => event.type === 'run:completed')).toBe(true);
    expect(
      f.registry.observations.hasInfrastructureFailure(),
      'WORKFLOW_MCP_CLOSE_FAULT_STARTS_FATAL_BEFORE_HELD_SIBLING',
    ).toBe(true);
    expect(f.registry.budget.deadline()).toBe(3000);
    expect(settled).toBe(false);
    expect(store?.db.$client.open).toBe(true);
    f.advance(3000);
    expect(await f.invocation.finiteExit.exited).toBe(9);
    expect(store?.db.$client.open).toBe(true);
    release();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(f.registry.budget.deadline()).toBe(3000);
    expect(settled).toBe(false);
    expect(
      store?.db.$client.open,
      'WORKFLOW_REJECTED_MCP_CLOSE_NEVER_ACKNOWLEDGES_DATABASE_RELEASE',
    ).toBe(true);
  } finally {
    release();
    // Harness disposal cannot certify the intentionally retained product close obligation.
    store?.close();
    rmSync(root, { recursive: true, force: true });
  }
});
