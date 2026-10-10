import { randomUUID } from 'node:crypto';
import { writeSync } from 'node:fs';
import { WorkflowEngine, createAgentNodeExecutor, parseWorkflow } from '@relavium/core';
import {
  createClient,
  createRunHistoryStore,
  createRunLeasePort,
  createSessionStore,
  createSessionUsageStore,
  runMigrations,
} from '@relavium/db';
import { makeLlmError, type LlmProvider, type ModelPricing } from '@relavium/llm';
import { CHAT_TEXT_CAPABILITY_FLAGS } from '../../test-support.js';
import { createCliHost } from '../host.js';
import { buildChatSession } from '../../chat/session-host.js';
import { createSessionPersister } from '../../chat/persister.js';
import type { ResolvedChatConfig } from '../../config/resolve.js';

const [path, surface, route, cut, cap] = process.argv.slice(2);
if (path === undefined) throw new Error('missing crash worker database');
const client = createClient(path);
runMigrations(client.db, { dbPath: path });
let ownerId = 'session';
let invocations = 0;
let targeted = route !== 'summarizer';
let abortOwner: (() => void) | undefined;
const expectedRefusal = [
  'refuse-pending',
  'credentials',
  'cancel-before-invoke',
  'lock-hold',
].includes(cut ?? '');
const keyFor = () => {
  if (cut === 'credentials') throw new Error('synthetic credential refusal');
  return 'synthetic-test-key';
};
const model = route === 'failover' ? 'usage-fallback' : 'usage-primary';
const targetModel = (candidate: string) => targeted && candidate === model;
const announce = (kind: 'CUT' | 'DONE' | 'ENTERED' | 'INTERRUPTED' | 'LOCK_READY' | 'BUSY') =>
  writeSync(1, `${kind} ${ownerId} ${invocations}\n`);
function crashCut(): never {
  announce('CUT');
  // A synchronous host callback cannot await IPC. The parent kills only after this explicit barrier.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30_000);
  throw new Error('parent did not kill at the announced crash boundary');
}
const prices = new Map<string, ModelPricing>(
  ['usage-primary', 'usage-fallback'].map((id) => [
    id,
    {
      provider: 'openai',
      nativeId: id,
      displayName: id,
      contextWindowTokens: 100_000,
      maxOutputTokens: 1000,
      inputPerMtokMicrocents: 1_000_000,
      outputPerMtokMicrocents: 1_000_000,
      cachedInputPerMtokMicrocents: 1_000_000,
    },
  ]),
);
const commandWaiters = new Map<string, () => void>();
function command(name: string): Promise<void> {
  return new Promise((resolve) => {
    commandWaiters.set(name, resolve);
  });
}
if (cut === 'late-receipt' || cut?.startsWith('lock-') === true) {
  let input = '';
  process.stdin.setEncoding('utf8').on('data', (chunk: string) => {
    input += chunk;
    for (;;) {
      const boundary = input.indexOf('\n');
      if (boundary < 0) break;
      const name = input.slice(0, boundary);
      input = input.slice(boundary + 1);
      const resolve = commandWaiters.get(name);
      if (resolve === undefined) throw new Error('unexpected parent command');
      commandWaiters.delete(name);
      resolve();
    }
  });
}
let pendingLocked = false;
let busyFailures = 0;
const transaction = client.db.transaction.bind(client.db);
client.db.transaction = (body, config) => {
  try {
    return transaction(body, config);
  } catch (error) {
    if (
      pendingLocked &&
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'SQLITE_BUSY'
    ) {
      busyFailures++;
      announce('BUSY');
    }
    throw error;
  }
};
const provider: LlmProvider = {
  id: 'openai',
  customEndpoint: true,
  supports: CHAT_TEXT_CAPABILITY_FLAGS,
  generate: () => Promise.reject(new Error('unexpected generate')),
  stream: async function* (request) {
    await Promise.resolve();
    invocations++;
    if (cut === 'late-receipt') {
      const receipt = command('RECEIPT');
      void command('ABORT').then(() => abortOwner?.());
      announce('ENTERED');
      await receipt;
    }
    if (targetModel(request.model) && (cut === 'invoked' || cut === 'omit-pending')) crashCut();
    if (route === 'failover' && request.model === 'usage-primary') {
      yield {
        type: 'error',
        error: makeLlmError({
          provider: 'openai',
          kind: 'transport',
          message: 'synthetic failover',
        }),
      };
      return;
    }
    if (cut !== 'late-receipt') yield { type: 'text_delta', text: 'synthetic reply' };
    yield {
      type: 'stop',
      stopReason: 'stop',
      usage: { kind: 'complete', usage: { inputTokens: 3, outputTokens: 4 } },
    };
  },
};
const agent = {
  id: 'usage-agent',
  provider: 'openai' as const,
  model: 'usage-primary',
  system_prompt: 'offline',
  tools: [],
  retry: { max: 1, backoff: 'linear' as const },
  ...(route === 'failover'
    ? {
        fallback_chain: [{ provider: 'openai' as const, model: 'usage-fallback', max_attempts: 1 }],
      }
    : {}),
};

async function runWorkflow() {
  const workflow = parseWorkflow(
    JSON.stringify({
      schema_version: '1.0',
      workflow: {
        id: 'usage-crash',
        agents: [agent],
        ...(cap === 'capped'
          ? { budget: { max_cost_microcents: 1_000_000, on_exceed: 'fail', strict_cost_cap: true } }
          : {}),
        nodes: [
          {
            id: 'work',
            type: 'agent',
            agent_ref: agent.id,
            prompt_template: 'fixture',
            max_tokens: 64,
          },
        ],
        edges: [],
      },
    }),
  );
  const native = createRunHistoryStore(client.db, {
    uuid: randomUUID,
    now: Date.now,
    workflow: {
      slug: workflow.workflow.id,
      name: workflow.workflow.id,
      definitionJson: JSON.stringify(workflow),
    },
  });
  if (cut === 'refuse-pending')
    client.sqlite.exec(
      `CREATE TRIGGER refuse_pending BEFORE INSERT ON run_events WHEN NEW.event_type = 'cost:usage_pending' BEGIN SELECT RAISE(ABORT, 'pending refused'); END`,
    );
  const host = createCliHost(native, { runLeases: createRunLeasePort(native) });
  const engine = new WorkflowEngine({
    host: {
      ...host,
      store: {
        ...host.store,
        persistEvent: async (event, context) => {
          if (cut === 'omit-pending' && event.type === 'cost:usage_pending') return;
          await host.store.persistEvent(event, context);
          if (event.type === 'cost:usage_pending' && cut === 'cancel-before-invoke') abortOwner?.();
          if (event.type === 'cost:usage_pending' && targetModel(event.model) && cut === 'pending')
            crashCut();
          if (
            event.type === 'cost:attempt_settled' &&
            targetModel(event.model) &&
            cut === 'settled'
          )
            crashCut();
        },
      },
    },
    executor: createAgentNodeExecutor({
      resolveProvider: () => provider,
      keyFor,
      sleep: () => Promise.resolve(),
      tools: [],
      registry: {
        has: () => false,
        list: () => [],
        dispatch: () => Promise.reject(new Error('unexpected tool')),
      },
      resolvePrice: prices,
    }),
    resolvePrice: prices,
  });
  const handle = engine.start({ workflow });
  ownerId = handle.runId;
  abortOwner = () => handle.cancel();
  for await (const event of handle.events) {
    if (event.type === 'run:failed' && !expectedRefusal)
      throw new Error(JSON.stringify(event.error));
  }
  announce('DONE');
}

async function runSession() {
  const chat: ResolvedChatConfig = {
    defaultModel: undefined,
    defaultProvider: undefined,
    fsScope: undefined,
    maxTurns: undefined,
    maxMessages: undefined,
    autoCompact: false,
    compactThreshold: undefined,
    maxCostMicrocents: cap === 'capped' ? 1_000_000 : undefined,
    onExceed: 'fail',
    strictCostCap: true,
    allowedCommands: undefined,
    allowedCommandGlobs: undefined,
    reasoningEffort: undefined,
  };
  const built = await buildChatSession({
    chat,
    agent,
    agentRef: undefined,
    cwd: process.cwd(),
    projectConfigDir: undefined,
    now: Date.now,
    uuid: () => ownerId,
    disableMcp: true,
    resolvePrice: prices,
    providers: { resolveProvider: () => provider, keyFor },
    onListenerError: (note) => {
      if (!expectedRefusal) throw new Error(note);
    },
  });
  abortOwner = () => built.session.abort();
  const nativeUsage = createSessionUsageStore(client.db);
  const nativeCosts = createSessionStore(client.db);
  const persister = createSessionPersister({
    usageStore: {
      ...nativeUsage,
      beginInvocation: (input, owner) => {
        const receipt = nativeUsage.beginInvocation(input, owner);
        if (cut === 'cancel-before-invoke') abortOwner?.();
        if (targetModel(input.model) && cut === 'pending') crashCut();
        return receipt;
      },
    },
    store: {
      ...nativeCosts,
      recordSessionCost: (entry) => {
        const recorded = nativeCosts.recordSessionCost(entry);
        if (targetModel(entry.model) && cut === 'settled') crashCut();
        return recorded;
      },
    },
    mode: 'fresh',
    attachUsageWriter: (writer) =>
      built.attachUsageWriter({
        ...writer,
        begin: async (draft) => {
          if (cut?.startsWith('lock-') !== true) return writer.begin(draft);
          const proceed = command('PROCEED');
          announce('LOCK_READY');
          await proceed;
          client.sqlite.pragma('busy_timeout = 10');
          pendingLocked = true;
          try {
            return await writer.begin(draft);
          } finally {
            pendingLocked = false;
          }
        },
      }),
    governor: built.governor,
    attachDurabilityProbe: built.attachDurabilityProbe,
    attachEffectTurnAllocator: built.attachEffectTurnAllocator,
    handle: built.handle,
    sessionId: built.sessionId,
    agent: built.agent,
    context: built.context,
    now: Date.now,
    uuid: randomUUID,
  });
  persister.start();
  built.session.start();
  if (cut === 'refuse-pending')
    client.sqlite.exec(
      `CREATE TRIGGER refuse_pending BEFORE INSERT ON session_usage_invocations BEGIN SELECT RAISE(ABORT, 'pending refused'); END`,
    );
  persister.beginUserTurn('first question');
  await built.session.sendMessage('first question');
  if (route === 'summarizer') {
    persister.beginUserTurn('second question');
    await built.session.sendMessage('second question');
    targeted = true;
    await built.session.compact('manual');
  }
  if (cut === 'late-receipt') announce('INTERRUPTED');
  await built.whenHostSafeToClose();
  persister.close();
  if (cut === 'lock-hold' && busyFailures !== 5)
    throw new Error(`expected five native busy attempts, received ${busyFailures}`);
  if (cut === 'lock-release' && (busyFailures < 1 || busyFailures >= 5))
    throw new Error('native retry did not recover within its budget');
  announce('DONE');
  process.stdin.pause();
}

try {
  if (surface === 'run') await runWorkflow();
  else if (surface === 'session') await runSession();
  else throw new Error('unknown crash worker surface');
} finally {
  client.sqlite.close();
}
