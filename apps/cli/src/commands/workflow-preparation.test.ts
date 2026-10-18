import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { WorkflowEngine, createInMemoryHost } from '@relavium/core';
import { McpAbortedError, startMcpClient, type McpConnection } from '@relavium/mcp';
import { createCliInvocation } from '../process/invocation.js';
import { toUserFacing } from '../process/errors.js';
import { captureIo } from '../test-support.js';
import { runCommand, type RunCommandDeps } from './run.js';
import type { ResolvedStdioSpawn } from '../engine/mcp-consent.js';

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  let reject: (cause: unknown) => void = () => undefined;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
function fixture(kind: 'secret' | 'plain' | 'mcp') {
  const root = mkdtempSync(join(tmpdir(), 'relavium-owned-preparation-'));
  const path = join(root, 'workflow.relavium.yaml');
  const configPath = join(root, 'config.toml');
  writeFileSync(configPath, ''); // Never read the operator global config.
  writeFileSync(
    path,
    JSON.stringify({
      schema_version: '1.0',
      workflow: {
        id: 'owned-preparation',
        nodes: [{ id: 'input', type: 'input' }],
        edges: [],
        ...(kind === 'secret'
          ? { inputs: [{ name: 'token', type: 'secret', required: true }] }
          : {}),
        ...(kind === 'mcp'
          ? {
              agents: [
                {
                  id: 'unused',
                  provider: 'openai',
                  model: 'offline',
                  system_prompt: 'offline',
                  mcp_servers: [
                    {
                      id: 'offline',
                      transport: 'stdio',
                      command: process.execPath,
                      env: { TOKEN: '{{secrets.token}}' },
                    },
                  ],
                },
              ],
            }
          : {}),
      },
    }),
  );
  const captured = captureIo();
  const invocation = createCliInvocation({ exit: vi.fn(), setExitCode: vi.fn() });
  const engine = new WorkflowEngine({
    host: createInMemoryHost(),
    executor: {
      execute: () => Promise.resolve({ kind: 'completed', output: 'offline' }),
    },
  });
  const keyFor = vi.fn(() => 'synthetic-unused');
  const resolveSecret = vi.fn(() => 'synthetic-unused');
  const providers = { resolveProvider: () => undefined, keyFor };
  const build = vi.fn(() => Promise.resolve(engine));
  const keys = vi.fn(() => ({ providers, mcpSecretResolver: resolveSecret }));
  const deps: RunCommandDeps = {
    invocation,
    io: captured.io,
    global: { json: true, color: false, verbosity: 'normal', cwd: root, configPath },
    providers,
    buildEngine: build,
    resolveKeys: keys,
  };
  const before = process.listeners('SIGINT');
  const interrupt = () => {
    const listeners = process.listeners('SIGINT').filter((listener) => !before.includes(listener));
    expect(listeners).toHaveLength(1);
    listeners[0]?.('SIGINT');
  };
  return {
    root,
    path,
    invocation,
    engine,
    deps,
    build,
    keys,
    keyFor,
    resolveSecret,
    interrupt,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

describe('early workflow preparation ownership', () => {
  it('retains cooperative cancellation for a genuine typed MCP abort without hiding a competing fault', async () => {
    const f = fixture('mcp');
    try {
      const code = await runCommand(
        { workflow: f.path, input: [], allowMcpStdio: [] },
        {
          ...f.deps,
          consentGate: () => Promise.resolve(new Map()),
          startMcpClient: () => {
            f.interrupt();
            return Promise.reject(new McpAbortedError('offline', 'connect'));
          },
        },
      );
      expect(code).toBe(1);
      expect(f.build).not.toHaveBeenCalled();
      expect(f.invocation.registry.activeOwners).toBe(0);
      expect(f.invocation.registry.termination).toBeUndefined();
      expect(f.invocation.registry.observations.exitCode()).toBe(1);
    } finally {
      f.cleanup();
    }
  });
  it('keeps synchronous MCP-warning cancellation outside storage error classification', async () => {
    const f = fixture('mcp');
    const close = vi.fn(() => Promise.resolve());
    const open = vi.fn(() => {
      throw new Error('Storage must not open after cancellation.');
    });
    const connection: McpConnection = {
      listTools: () => Promise.resolve([{ name: 'blocked', inputSchema: { type: 'object' } }]),
      callTool: () => Promise.resolve({ content: [], isError: false }),
      close,
    };
    let warnings = 0;
    try {
      const code = await runCommand(
        { workflow: f.path, input: [], allowMcpStdio: [] },
        {
          ...f.deps,
          openRunStore: open,
          io: {
            ...f.deps.io,
            writeErr: (text) => {
              f.deps.io.writeErr(text);
              warnings++;
              f.interrupt();
            },
          },
          consentGate: () => Promise.resolve(new Map()),
          startMcpClient: () =>
            startMcpClient([
              { id: 'offline', toolsAllowlist: [], open: () => Promise.resolve(connection) },
            ]),
        },
      ).catch((cause: unknown) => toUserFacing(cause).exitCode);
      expect(warnings).toBe(1);
      expect(code, 'WORKFLOW_STOP_ORIGIN').toBe(1);
      expect(f.invocation.registry.observations.exitCode()).toBe(1);
      expect(open).not.toHaveBeenCalled();
      expect(f.build).not.toHaveBeenCalled();
      expect(close).toHaveBeenCalledOnce();
      expect(f.invocation.registry.activeOwners).toBe(0);
    } finally {
      f.cleanup();
    }
  });
  it('holds secret stdin ownership and refuses later services after its real late settlement', async () => {
    const f = fixture('secret');
    const read = deferred<string>();
    let settled = false;
    const pending = runCommand(
      { workflow: f.path, input: [], allowMcpStdio: [], secretInputsStdin: true },
      { ...f.deps, readSecretInput: () => read.promise },
    );
    void pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    try {
      expect(f.invocation.registry.activeOwners).toBe(2);
      f.interrupt();
      await turn();
      expect(settled).toBe(false);
      expect(f.keys).not.toHaveBeenCalled();
      expect(f.build).not.toHaveBeenCalled();
      read.resolve('token=synthetic');
      expect(await pending).toBe(1);
      expect(f.keys).not.toHaveBeenCalled();
      expect(f.build).not.toHaveBeenCalled();
      expect(f.invocation.registry.activeOwners).toBe(0);
    } finally {
      read.resolve('token=synthetic');
      await pending.catch(() => undefined);
      f.cleanup();
    }
  });
  it('preserves an unrelated stdin failure racing a first Ctrl-C as infrastructure', async () => {
    const f = fixture('secret');
    const read = deferred<string>();
    const fault = new Error('PRIVATE_STDIN_AFTER_CANCEL');
    const pending = runCommand(
      { workflow: f.path, input: [], allowMcpStdio: [], secretInputsStdin: true },
      { ...f.deps, readSecretInput: () => read.promise },
    );
    const refusal = expect(pending).rejects.toBe(fault);
    try {
      f.interrupt();
      read.reject(fault);
      await refusal;
      expect(toUserFacing(fault)).toMatchObject({ code: 'cli_internal', exitCode: 9 });
      expect(f.invocation.registry.observations.exitCode()).toBe(9);
      expect(f.keys).not.toHaveBeenCalled();
      expect(f.invocation.registry.activeOwners).toBe(0);
    } finally {
      read.resolve('token=synthetic');
      await pending.catch(() => undefined);
      f.cleanup();
    }
  });
  it.each(['build', 'outbox'] as const)(
    'does not start a run after cancellation during held %s preparation',
    async (stage) => {
      const f = fixture('plain');
      const entered = deferred<void>();
      const release = deferred<void>();
      const start = vi.spyOn(f.engine, 'start');
      if (stage === 'outbox')
        vi.spyOn(f.engine, 'drainTerminalOutbox').mockImplementation(async () => {
          entered.resolve();
          await release.promise;
          return [];
        });
      const pending = runCommand(
        { workflow: f.path, input: [], allowMcpStdio: [] },
        {
          ...f.deps,
          buildEngine: async () => {
            if (stage === 'build') {
              entered.resolve();
              await release.promise;
            }
            return f.engine;
          },
        },
      );
      try {
        await entered.promise;
        f.interrupt();
        await turn();
        expect(start).not.toHaveBeenCalled();
        expect(f.invocation.registry.activeOwners).toBe(2);
        release.resolve();
        expect(await pending).toBe(1);
        expect(start).not.toHaveBeenCalled();
        expect(f.invocation.registry.activeOwners).toBe(0);
      } finally {
        release.resolve();
        await pending.catch(() => undefined);
        f.cleanup();
      }
    },
  );
  it.each([false, true])(
    'a custom consent gate settling after stop cannot enter secrets or MCP (reject=%s)',
    async (reject) => {
      const f = fixture('mcp');
      const entered = deferred<void>();
      const consent = deferred<ReadonlyMap<string, ResolvedStdioSpawn>>();
      const start = vi.fn(() => Promise.reject(new Error('MCP must not be entered.')));
      const fault = new Error('PRIVATE_CONSENT_AFTER_CANCEL');
      const pending = runCommand(
        { workflow: f.path, input: [], allowMcpStdio: [] },
        {
          ...f.deps,
          consentGate: () => {
            entered.resolve();
            return consent.promise;
          },
          startMcpClient: start,
        },
      );
      // Attach rejection observation before releasing the custom factory.
      const result = pending.then(
        (code) => code,
        (cause: unknown) => toUserFacing(cause),
      );
      try {
        await entered.promise;
        f.interrupt();
        await turn();
        expect(start).not.toHaveBeenCalled();
        expect(f.resolveSecret).not.toHaveBeenCalled();
        if (reject) consent.reject(fault);
        else consent.resolve(new Map());
        if (reject) expect(await result).toMatchObject({ code: 'cli_internal', exitCode: 9 });
        else expect(await result).toBe(1);
        expect(start).not.toHaveBeenCalled();
        expect(f.resolveSecret).not.toHaveBeenCalled();
        expect(f.build).not.toHaveBeenCalled();
        expect(f.invocation.registry.activeOwners).toBe(0);
      } finally {
        consent.resolve(new Map());
        await result;
        f.cleanup();
      }
    },
  );
});
