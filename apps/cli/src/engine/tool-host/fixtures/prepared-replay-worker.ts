import { randomUUID } from 'node:crypto';
import { writeSync } from 'node:fs';
import { join } from 'node:path';
import {
  WorkflowEngine,
  BUILTIN_TOOLS,
  createToolRegistry,
  createAgentNodeExecutor,
  createDispatchingNodeExecutor,
  createHumanGateNodeExecutor,
  parseWorkflow,
  type FsCapability,
} from '@relavium/core';
import {
  createClient,
  runMigrations,
  createRunHistoryStore,
  createRunLeasePort,
  createEffectJournalStore,
  createEffectJournalPort,
  createEffectResumePort,
} from '@relavium/db';
import type { LlmProvider, StreamChunk } from '@relavium/llm';
import type { EffectDispatchPort } from '@relavium/shared';
import { createNodeFsCapability } from '../fs.js';
import { createCliHost } from '../../host.js';
import { createHistoryCheckpointer } from '../../checkpointer.js';
import { CHAT_TEXT_CAPABILITY_FLAGS } from '../../../test-support.js';
import {
  PreparedReplayOperation,
  PreparedReplayCut,
  PreparedReplayVariant,
  PreparedReplayReceipt,
} from './prepared-replay-contract.js';

const [
  root,
  mode,
  existingRun,
  existingGate,
  rawVariant = 'same',
  rawOperation = 'edit',
  rawCut = 'after-settle',
] = process.argv.slice(2);
const variant = PreparedReplayVariant.parse(rawVariant);
const operation = PreparedReplayOperation.parse(rawOperation);
const cut = PreparedReplayCut.parse(rawCut);
if (variant === 'reordered' && operation !== 'edit')
  throw new Error('reordered fixture is edit-only');
if (root === undefined || (mode !== 'crash' && mode !== 'resume'))
  throw new Error('invalid replay worker invocation');
const dbPath = join(root, 'history.db');
const client = createClient(dbPath);
runMigrations(client.db, { dbPath });
// An injected native-store clock expires the proven-dead predecessor without a wall-clock sleep.
const now = Date.now() + (mode === 'resume' ? 10 * 60_000 : 0);
let preparations = 0;
let executionCalls = 0;
let publications = 0;
let agentExecutions = 0;
let settlements = 0;
let providerCalls = 0;
let deliveredResultJson: string | undefined;
let runId = existingRun ?? '';
let gateId = existingGate ?? '';
function receipt(stage: 'cut' | 'resume', status?: 'completed' | 'failed', code?: string) {
  return PreparedReplayReceipt.parse({
    pid: process.pid,
    stage,
    operation,
    cut,
    runId,
    gateId,
    preparations,
    executionCalls,
    publications,
    settlements,
    providerCalls,
    agentExecutions,
    deliveredResultJson,
    status,
    code,
  });
}
function crashCut(): never {
  writeSync(1, `CUT ${JSON.stringify(receipt('cut'))}\n`);
  // The parent kills only after observing the explicit real-operation boundary.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30_000);
  throw new Error('parent did not terminate at the announced prepared-write boundary');
}

const nativeFs = createNodeFsCapability({
  tier: 'sandboxed',
  workspaceDir: join(root, 'workspace'),
  operatorHomeDir: root,
  readOnly: false,
});
const fs: FsCapability = {
  readFile: (...args) => nativeFs.readFile(...args),
  writeFile: (...args) => nativeFs.writeFile(...args),
  listDirectory: (...args) => nativeFs.listDirectory(...args),
  acknowledgeReadResult: (...args) => nativeFs.acknowledgeReadResult?.(...args),
  promoteReadScope: (...args) => nativeFs.promoteReadScope?.(...args),
  releaseReadScope: (...args) => nativeFs.releaseReadScope?.(...args),
  prepareWrite: async (...args) => {
    preparations++;
    if (nativeFs.prepareWrite === undefined) throw new Error('missing prepared filesystem');
    const held = await nativeFs.prepareWrite(...args);
    return {
      path: held.path,
      before: held.before,
      after: held.after,
      execute: async (...execution) => {
        executionCalls++;
        const result = await held.execute(...execution);
        publications++;
        if (mode === 'crash' && cut === 'after-publication') crashCut();
        return result;
      },
      release: () => held.release(),
    };
  },
};
const tools = BUILTIN_TOOLS.filter((tool) =>
  ['read_file', 'list_directory', 'edit_file', 'write_file'].includes(tool.id),
);
const registry = createToolRegistry({ tools, host: { fs } });
function fixtureCall(
  read: boolean,
  changed: string,
): { name: string; args: Record<string, unknown> } {
  let call: { name: string; args: Record<string, unknown> };
  if (read) {
    call =
      operation === 'create'
        ? { name: 'list_directory', args: { path: '.' } }
        : { name: 'read_file', args: { path: 'target.txt' } };
  } else if (operation === 'edit') {
    call = {
      name: 'edit_file',
      args: { path: 'target.txt', old_string: 'old', new_string: changed },
    };
  } else {
    const args: Record<string, unknown> = { path: 'target.txt', content: `${changed}\n` };
    if (operation === 'append') args['append'] = true;
    if (operation === 'overwrite') args['append'] = false;
    call = { name: 'write_file', args };
  }
  return call;
}
const provider: LlmProvider = {
  id: 'openai',
  customEndpoint: true,
  supports: CHAT_TEXT_CAPABILITY_FLAGS,
  generate: () => Promise.reject(new Error('unexpected generate')),
  stream: async function* (request): AsyncGenerator<StreamChunk> {
    await Promise.resolve();
    providerCalls++;
    if (providerCalls <= 2) {
      const read = providerCalls === 1 && variant !== 'reordered';
      const changed = variant === 'mismatch' ? 'different' : 'new';
      const call = fixtureCall(read, changed);
      yield { type: 'tool_call_start', id: `provider-${String(providerCalls)}`, name: call.name };
      yield {
        type: 'tool_call_delta',
        id: `provider-${String(providerCalls)}`,
        argsJsonDelta: JSON.stringify(call.args),
      };
      yield { type: 'tool_call_end', id: `provider-${String(providerCalls)}` };
      yield {
        type: 'stop',
        stopReason: 'tool_use',
        usage: { kind: 'complete', usage: { inputTokens: 1, outputTokens: 1 } },
      };
    } else {
      const delivered = request.messages
        .flatMap((message) => message.content)
        .findLast((part) => part.type === 'tool_result' && part.toolCallId === 'provider-2');
      if (delivered?.type !== 'tool_result') throw new Error('missing model-facing effect result');
      deliveredResultJson = JSON.stringify(delivered.result);
      yield { type: 'text_delta', text: 'done' };
      yield {
        type: 'stop',
        stopReason: 'stop',
        usage: { kind: 'complete', usage: { inputTokens: 1, outputTokens: 1 } },
      };
    }
  },
};
const workflow = parseWorkflow(
  JSON.stringify({
    schema_version: '1.0',
    workflow: {
      id: 'prepared-replay',
      agents: [
        {
          id: 'editor',
          provider: 'openai',
          model: 'offline-model',
          system_prompt: 'offline',
          tools: ['read_file', 'list_directory', 'edit_file', 'write_file'],
          retry: { max: 1, backoff: 'linear' },
        },
      ],
      nodes: [
        { id: 'gate', type: 'human_gate', gate_type: 'approval' },
        { id: 'work', type: 'agent', agent_ref: 'editor', prompt_template: 'replace old with new' },
      ],
      edges: [{ from: 'gate', to: 'work' }],
    },
  }),
);
const store = createRunHistoryStore(client.db, {
  uuid: randomUUID,
  now: () => now,
  workflow: {
    slug: workflow.workflow.id,
    name: workflow.workflow.id,
    definitionJson: JSON.stringify(workflow),
  },
});
const journal = createEffectJournalStore(client.db, { uuid: randomUUID, now: () => now });
const baseHost = createCliHost(store, {
  runLeases: createRunLeasePort(store),
  checkpointer: createHistoryCheckpointer(store),
});
const agentExecutor = createAgentNodeExecutor({
  resolveProvider: () => provider,
  keyFor: () => 'offline-key',
  sleep: () => Promise.resolve(),
  tools,
  registry,
});
const engine = new WorkflowEngine({
  host: { ...baseHost, clock: { now: () => new Date(now).toISOString() } },
  executor: createDispatchingNodeExecutor({
    human_in_the_loop: createHumanGateNodeExecutor(),
    agent: {
      execute: (ctx) => {
        agentExecutions++;
        return agentExecutor.execute(ctx);
      },
    },
  }),
  effectResume: createEffectResumePort(journal),
  effectJournal: (correlation): EffectDispatchPort => {
    const port = createEffectJournalPort(journal, correlation, {
      providerAttempt: 1,
      toolCallId: 'run',
    });
    return {
      inspectReplay: (...args) => port.inspectReplay(...args),
      prepare: async (...args) => {
        const verdict = await port.prepare(...args);
        if (mode === 'crash' && cut === 'after-claim' && verdict.outcome === 'proceed') crashCut();
        return verdict;
      },
      discard: (...args) => port.discard(...args),
      settle: async (...args) => {
        await port.settle(...args);
        settlements++;
        if (mode === 'crash' && cut === 'after-settle' && args[2] === 'committed') crashCut();
      },
    };
  },
});
try {
  if (mode === 'crash') {
    const handle = engine.start({ workflow });
    runId = handle.runId;
    for await (const event of handle.events) {
      if (event.type === 'run:paused') {
        gateId = event.gateIds[0] ?? '';
        await engine.resume(runId, gateId, { decision: 'approved', decidedBy: 'fixture' });
      }
      if (event.type === 'run:failed') throw new Error(JSON.stringify(event.error));
    }
    throw new Error('worker completed without reaching committed-effect crash cut');
  }
  if (
    existingRun === undefined ||
    existingRun.length === 0 ||
    existingGate === undefined ||
    existingGate.length === 0
  )
    throw new Error('missing resume identity');
  const handle = await engine.resumeFromCheckpoint({
    runId: existingRun,
    workflow,
    gateId: existingGate,
    decision: { decision: 'approved', decidedBy: 'fixture' },
  });
  const events = [];
  for await (const event of handle.events) events.push(event);
  const failed = events.find((event) => event.type === 'run:failed');
  await handle.depart();
  writeSync(
    1,
    `DONE ${JSON.stringify(receipt('resume', failed === undefined ? 'completed' : 'failed', failed?.error.code))}\n`,
  );
} finally {
  client.sqlite.close();
}
