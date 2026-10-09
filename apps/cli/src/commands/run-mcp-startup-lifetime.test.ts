import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { startMcpClient } from '@relavium/mcp';
import { captureIo } from '../test-support.js';
import { runCommand } from './run.js';

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
it('failed MCP startup keeps the command and signal guard until its admitted raw cleanup ACK', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'run-mcp-startup-'));
  writeFileSync(
    join(dir, 'w.relavium.yaml'),
    JSON.stringify({
      schema_version: '1.0',
      workflow: {
        id: 'startup-lifetime',
        agents: [
          {
            id: 'a',
            provider: 'openai',
            model: 'gpt-4o',
            system_prompt: 'offline',
            mcp_servers: [{ id: 'offline', transport: 'http', url: 'https://offline.invalid/mcp' }],
          },
        ],
        nodes: [{ id: 'work', type: 'agent', agent_ref: 'a', prompt_template: 'go' }],
        edges: [],
      },
    }),
  );
  const admitted = deferred(),
    release = deferred(),
    boundedFailure = deferred();
  const baseline = process.listenerCount('SIGINT');
  let settled = false,
    builds = 0,
    opens = 0;
  const { io } = captureIo();
  const execution = runCommand(
    { workflow: 'w.relavium.yaml', input: [], allowMcpStdio: [] },
    {
      io,
      global: { json: true, color: false, cwd: dir, configPath: undefined, verbosity: 'normal' },
      providers: {
        keyFor: () => 'synthetic',
        resolveProvider: () => {
          throw new Error('unused provider');
        },
      },
      openRunStore: () => {
        opens++;
        throw new Error('startup failure must not open history');
      },
      buildEngine: () => {
        builds++;
        throw new Error('startup failure must not build engine');
      },
      startMcpClient: async (servers, signal, options) => {
        try {
          return await startMcpClient(
            servers.map((server) => ({
              ...server,
              open: (_signal, work) => {
                if (work?.retainWork === undefined) throw new Error('pre-handle lifetime lost');
                void work.retainWork(() => release.promise);
                admitted.resolve();
                return Promise.reject(new Error('PRIVATE bounded connect refusal'));
              },
            })),
            signal,
            options,
          );
        } finally {
          boundedFailure.resolve();
        }
      },
    },
  );
  const rejected = expect(execution).rejects.toMatchObject({ code: 'invalid_invocation' });
  void execution.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  try {
    await admitted.promise;
    await boundedFailure.promise;
    await setImmediate();
    expect(settled).toBe(false);
    expect(process.listenerCount('SIGINT')).toBeGreaterThan(baseline);
    expect({ builds, opens }).toEqual({ builds: 0, opens: 0 });
    release.resolve();
    await rejected;
    expect(process.listenerCount('SIGINT')).toBe(baseline);
  } finally {
    release.resolve();
    await rejected;
    rmSync(dir, { recursive: true, force: true });
  }
});
