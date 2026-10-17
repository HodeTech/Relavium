import { fileURLToPath } from 'node:url';
import { parseWorkflow, type WorkflowDefinition } from '@relavium/core';
import type { McpServerRef } from '@relavium/shared';
import type { StdioNativeLifetime } from '@relavium/mcp';
import { describe, expect, it } from 'vitest';
import { createCliInvocation } from '../process/invocation.js';
import {
  createNativeProcessController,
  type NativeProcessController,
} from '../process/native-process-owner.js';
import {
  WINDOWS_TEARDOWN_UNAVAILABLE_MESSAGE,
  WindowsTeardownUnavailableError,
} from '../process/windows-teardown.js';
import { CliError } from '../process/cli-error.js';
import { EgressWorkScope } from './egress-work.js';
import { connectAgentMcp, connectWorkflowMcp, resolveServerConfigs } from './mcp-servers.js';
import type { ResolvedStdioSpawn } from './mcp-consent.js';

const silentServer = fileURLToPath(
  new URL('../../../../packages/mcp/test-fixtures/silent-mcp-server.mjs', import.meta.url),
);
const ref: McpServerRef = {
  id: 'native-owner',
  transport: 'stdio',
  command: process.execPath,
  args: [silentServer],
  connect_timeout_ms: 10000,
};
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function workflow(server: McpServerRef = ref): WorkflowDefinition {
  return parseWorkflow(
    `schema_version: '1.0'
workflow:
  id: native-owner
  agents:
    - id: scanner
      model: gpt-4o
      provider: openai
      system_prompt: go
      mcp_servers: ${JSON.stringify([server])}
  nodes:
    - {id: start, type: input}
    - {id: agent, type: agent, agent_ref: scanner, prompt_template: go}
    - {id: out, type: output}
  edges:
    - {from: start, to: agent}
    - {from: agent, to: out}
`,
  );
}

const consent = (): Promise<ReadonlyMap<string, ResolvedStdioSpawn>> => Promise.resolve(new Map());

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 10000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('MCP native ownership transition did not complete');
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('MCP CLI bridge to actual creation-owned native lifetime', () => {
  it.each(['agent', 'workflow'] as const)(
    '%s forwards the same controller through config.open before an actual SDK handshake',
    async (surface) => {
      const invocation = createCliInvocation();
      const native = createNativeProcessController(invocation.registry);
      const work = new EgressWorkScope();
      const abort = new AbortController();
      let lifetime: StdioNativeLifetime | undefined;
      const nativeProcesses: NativeProcessController = {
        reserve: native.reserve,
        observeMcp: async () => {
          const observer = await native.observeMcp();
          return {
            ...observer,
            attach: (value) => {
              lifetime = value;
              observer.attach(value);
            },
          };
        },
      };
      const options = {
        cwd: process.cwd(),
        consentGate: consent,
        connectSignal: abort.signal,
        nativeProcesses,
        work,
      };
      const beforeExitListeners = process.listenerCount('exit');
      const opening =
        surface === 'agent'
          ? connectAgentMcp([ref], options)
          : connectWorkflowMcp(workflow(), options);
      const outcome = opening.catch((error: unknown) => error);
      let pid: number | undefined;
      try {
        await until(() => lifetime?.readPid() !== undefined);
        pid = lifetime?.readPid();
        if (pid === undefined || lifetime === undefined)
          throw new Error('missing SDK native owner');
        expect(invocation.registry.activeOwners).toBe(1);
        expect(lifetime.isClosed()).toBe(false);
        expect(alive(pid)).toBe(true);
        // Finite exit delegates to the exact reservation, even before a client handle exists.
        // It neither launches an async helper nor certifies close from a successful kill request.
        invocation.registry.reapNativeAtExit();
        expect(lifetime.isClosed()).toBe(false);
        expect(invocation.registry.activeOwners).toBe(1);
        expect(invocation.registry.termination).toBeUndefined();
        abort.abort();
        await outcome;
        await lifetime.whenClosed;
        work.seal();
        await work.done;
        await tick();
        expect(alive(pid)).toBe(false);
        expect(lifetime.readPid()).toBeUndefined();
        expect(invocation.registry.activeOwners).toBe(0);
        expect(process.listenerCount('exit')).toBe(beforeExitListeners);
      } finally {
        abort.abort();
        if (pid !== undefined && alive(pid)) process.kill(pid, 'SIGKILL');
        await outcome;
        await lifetime?.close();
        work.seal();
        await work.done;
      }
    },
    15000,
  );

  it('abandons a reserved but unattached native owner when the actual MCP work retainer refuses entry', async () => {
    const invocation = createCliInvocation();
    const before = process.listenerCount('exit');
    const configs = resolveServerConfigs(
      [ref],
      process.cwd(),
      undefined,
      {},
      undefined,
      createNativeProcessController(invocation.registry),
    );
    const refusal = new Error('host work admission refused');
    await expect(
      configs[0]?.open(undefined, {
        retainWork: () => {
          throw refusal;
        },
      }),
    ).rejects.toBeDefined();
    await tick();
    expect(invocation.registry.activeOwners).toBe(0);
    expect(process.listenerCount('exit')).toBe(before);
    expect(invocation.registry.termination).toBeUndefined();
  });

  it.each(['agent', 'workflow'] as const)(
    '%s preserves fixed Windows facility refusal through the actual MCP manager wrapper',
    async (surface) => {
      const nativeProcesses: NativeProcessController = {
        reserve: () => Promise.reject(new Error('unexpected direct process reservation')),
        observeMcp: () =>
          Promise.reject(
            new WindowsTeardownUnavailableError({ cause: new Error('PRIVATE_NATIVE_CANARY') }),
          ),
      };
      const options = { cwd: process.cwd(), consentGate: consent, nativeProcesses };
      const outcome = await (
        surface === 'agent'
          ? connectAgentMcp([ref], options)
          : connectWorkflowMcp(workflow(), options)
      ).catch((error: unknown) => error);
      expect(outcome).toBeInstanceOf(CliError);
      expect(outcome).toMatchObject({
        code: 'internal',
        exitCode: 1,
        message: WINDOWS_TEARDOWN_UNAVAILABLE_MESSAGE,
      });
      expect(outcome).not.toHaveProperty('cause');
      expect(String(outcome)).not.toContain('PRIVATE_NATIVE_CANARY');
    },
  );

  it.each(['agent', 'workflow'] as const)(
    '%s refuses consent before native facility admission or SDK work',
    async (surface) => {
      const refusal = new Error('consent refused before native admission');
      const nativeProcesses: NativeProcessController = {
        reserve: () => Promise.reject(new Error('unexpected process reservation')),
        observeMcp: () => Promise.reject(new Error('unexpected native facility admission')),
      };
      const options = {
        cwd: process.cwd(),
        nativeProcesses,
        consentGate: () => Promise.reject(refusal),
      };
      await expect(
        surface === 'agent'
          ? connectAgentMcp([ref], options)
          : connectWorkflowMcp(workflow(), options),
      ).rejects.toBe(refusal);
    },
  );

  it('invalid child environment is refused before native facility admission', () => {
    const nativeProcesses: NativeProcessController = {
      reserve: () => Promise.reject(new Error('unexpected process reservation')),
      observeMcp: () => Promise.reject(new Error('unexpected native facility admission')),
    };
    expect(() =>
      resolveServerConfigs(
        [{ ...ref, env: { NODE_OPTIONS: '--require PRIVATE_ENV_CANARY' } }],
        process.cwd(),
        undefined,
        {},
        undefined,
        nativeProcesses,
      ),
    ).toThrow(CliError);
  });

  it('network config opens never acquire a native process reservation or carry an observer', async () => {
    const refusal = new Error('network opener stopped before I/O');
    const nativeProcesses: NativeProcessController = {
      reserve: () => Promise.reject(new Error('unexpected network process reservation')),
      observeMcp: () => Promise.reject(new Error('unexpected network native observer')),
    };
    const configs = resolveServerConfigs(
      [{ id: 'remote', transport: 'http', url: 'https://example.com/mcp' }],
      process.cwd(),
      undefined,
      {
        http: (_serverId, spec) => {
          expect(spec).not.toHaveProperty('nativeObserver');
          return Promise.reject(refusal);
        },
      },
      undefined,
      nativeProcesses,
    );
    await expect(configs[0]?.open()).rejects.toBe(refusal);
  });
});
