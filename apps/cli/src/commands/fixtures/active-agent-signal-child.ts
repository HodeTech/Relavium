/** Isolated OS-signal probe: shipping commands/host/SQLite and a real offline stdio MCP child. */
import { ChildProcess } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LlmProvider, StreamChunk } from '@relavium/llm';
import type { StdioNativeLifetime } from '@relavium/mcp';
import { AgentSchema } from '@relavium/shared';
import { buildChatSession, buildResumedChatSession } from '../../chat/session-host.js';
import { openSessionStore } from '../../history/session-open.js';
import { createCliInvocation } from '../../process/invocation.js';
import type { NativeProcessController } from '../../process/native-process-owner.js';
import { captureIo, CHAT_TEXT_CAPABILITY_FLAGS } from '../../test-support.js';
import { agentRunCommand } from '../agent-run.js';
import { chatCommand, chatResumeCommand, driveJson, drivePlain } from '../chat.js';

const mode = process.argv[2];
const root = process.argv[3];
if (mode === undefined || root === undefined)
  throw new Error('Isolated signal arguments required.');
const agentRun = mode.startsWith('agent-');
const resumed = mode.startsWith('resume-');
const json = mode.endsWith('-json');
const eof = mode.includes('-eof-');
const server = fileURLToPath(
  new URL('../../../../../packages/mcp/test-fixtures/echo-mcp-server.mjs', import.meta.url),
);
const agent = AgentSchema.parse({
  id: 'active-signal',
  provider: 'anthropic',
  model: 'claude-sonnet-4-6',
  system_prompt: 'offline signal regression',
  mcp_servers: [{ id: 'offline', transport: 'stdio', command: process.execPath, args: [server] }],
});
const agentPath = join(root, 'active.agent.yaml');
writeFileSync(agentPath, JSON.stringify(agent));
writeFileSync(join(root, 'config.toml'), '');
const invocation = createCliInvocation();
const captured = captureIo();
let lifetime: StdioNativeLifetime | undefined;
let nativePid: number | undefined;
let providerAborted = false;
let providerAcknowledged = false;
let nativeCloseHeld = false;
let nativeCloseDelivered = false;
let settled = false;
const outcome: { result?: number } = {};
let releaseProvider: () => void = () => {};
const providerRelease = new Promise<void>((resolve) => {
  releaseProvider = resolve;
});
let releaseNative: (() => void) | undefined;
const snapshot = () => ({
  mode,
  providerAborted,
  providerAcknowledged,
  nativeCloseHeld,
  nativeCloseDelivered,
  nativeAcknowledged: lifetime?.isClosed() === true,
  nativePid,
  activeOwners: invocation.registry.activeOwners,
  settled,
  result: outcome.result,
});
const report = (phase: string): void => {
  process.send?.({ phase, ...snapshot() });
};

// Withhold delivery of the real child's close event, after the OS has actually closed it.
// No fake close or fulfilled promise supplies the ACK. This process owns exactly one MCP child.
// eslint-disable-next-line @typescript-eslint/unbound-method -- captured intrinsic is invoked only with its actual child receiver below
const nativeEmit = ChildProcess.prototype.emit;
ChildProcess.prototype.emit = function (event: string | symbol, ...args: unknown[]): boolean {
  if (event === 'close' && this.pid === nativePid) {
    nativeCloseHeld = true;
    releaseNative = () => {
      releaseNative = undefined;
      nativeCloseDelivered = true;
      Reflect.apply(nativeEmit, this, [event, ...args]);
    };
    setImmediate(() => report('native-close-held'));
    return true;
  }
  const returned: unknown = Reflect.apply(nativeEmit, this, [event, ...args]);
  if (typeof returned !== 'boolean') throw new Error('Unexpected native event result.');
  return returned;
};
const observeNative = (native: NativeProcessController | undefined): NativeProcessController => {
  if (native === undefined) throw new Error('Shipping native controller required.');
  return {
    reserve: native.reserve,
    observeMcp: async () => {
      const reservation = await native.observeMcp();
      return {
        ...reservation,
        attach: (value) => {
          lifetime = value;
          reservation.attach(value);
        },
      };
    },
  };
};
const provider: LlmProvider = {
  id: 'anthropic',
  supports: CHAT_TEXT_CAPABILITY_FLAGS,
  generate: () => Promise.reject(new Error('Only streaming is supported by this probe.')),
  stream: async function* (request): AsyncGenerator<StreamChunk> {
    const signal = request.signal;
    if (signal === undefined || signal.aborted) throw new Error('Active egress signal required.');
    nativePid = lifetime?.readPid();
    if (nativePid === undefined) throw new Error('Real MCP child must precede provider entry.');
    process.kill(nativePid, 0); // Readiness proves an actually live child, not a remembered PID.
    const aborted = new Promise<void>((resolve) => {
      signal.addEventListener('abort', () => {
        providerAborted = true;
        resolve();
      });
    });
    yield { type: 'text_delta', text: 'ACTIVE_STREAM' };
    report('provider-active');
    if (eof) {
      await providerRelease;
      providerAcknowledged = true;
      report('provider-ack');
      yield {
        type: 'stop',
        stopReason: 'stop',
        usage: { kind: 'complete', usage: { inputTokens: 1, outputTokens: 1 } },
      };
      return;
    }
    await aborted;
    // The provider has observed cancellation but has not acknowledged actual work completion.
    await new Promise<void>((resolve) => setImmediate(resolve));
    report('provider-abort-held');
    await providerRelease;
    providerAcknowledged = true;
    report('provider-ack');
  },
};
process.on('message', (message: unknown) => {
  if (message === 'release-provider') releaseProvider();
  if (message === 'release-native') releaseNative?.();
});
process.on('exit', () => {
  writeFileSync(
    join(root, 'exit.json'),
    JSON.stringify({
      ...snapshot(),
      observedExit: invocation.registry.observations.exitCode(),
      stdout: captured.out(),
      stderr: captured.err(),
    }),
  );
});
if (resumed) {
  const opened = openSessionStore(root);
  const iso = new Date().toISOString();
  opened.store.createSession({
    id: 'active-resume',
    agentSlug: agent.id,
    agentSnapshot: agent,
    context: { workingDir: root, fsScopeTier: 'sandboxed' },
    status: 'ended',
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCostMicrocents: 0,
    totalConservativeMicrocents: 0,
    createdAt: iso,
    updatedAt: iso,
  });
  opened.close();
}
const deps = {
  invocation,
  io: { ...captured.io, stdin: process.stdin },
  global: {
    cwd: root,
    configPath: join(root, 'config.toml'),
    json,
    color: false,
    verbosity: 'normal' as const,
  },
  providers: { resolveProvider: () => provider, keyFor: () => 'synthetic-offline-key' },
  buildSession: (options: Parameters<typeof buildChatSession>[0]) =>
    buildChatSession({
      ...options,
      consentGate: () => Promise.resolve(new Map()),
      nativeProcesses: observeNative(options.nativeProcesses),
    }),
  buildResumedSession: (options: Parameters<typeof buildResumedChatSession>[0]) =>
    buildResumedChatSession({
      ...options,
      consentGate: () => Promise.resolve(new Map()),
      nativeProcesses: observeNative(options.nativeProcesses),
    }),
  drive: async (context: Parameters<typeof drivePlain>[0]) => {
    const outcome = await (json ? driveJson : drivePlain)(context);
    report('driver-settled');
    return outcome;
  },
};
const operation = agentRun
  ? agentRunCommand({ agent: agentPath, input: [], allowMcpStdio: [] }, deps)
  : resumed
    ? chatResumeCommand({ sessionId: 'active-resume' }, deps)
    : chatCommand({ agent: agentPath }, deps);
outcome.result = await operation;
settled = true;
report('settled');
process.exitCode = outcome.result;
process.disconnect();
