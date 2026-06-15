import type { CapabilityFlags, LlmProvider, ProviderId, StreamChunk } from '@relavium/llm';
import type { RunEvent } from '@relavium/shared';
import { beforeAll, describe, expect, it } from 'vitest';

import { parseWorkflow } from '../parser.js';
import { createExpressionSandbox, type ExpressionSandbox } from '../expression/sandbox.js';
import type { ToolDef as CoreToolDef, ToolRegistry, ToolResultPart } from '../tools/types.js';
import { markUntrusted } from '../tools/untrusted.js';
import { WorkflowEngine } from './engine.js';
import { createInMemoryHost } from './execution-host.js';
import { createStandardNodeExecutor } from './node-handlers/dispatcher.js';
import type { RunHandle } from './run-handle.js';

const CAPS: CapabilityFlags = {
  tools: true,
  streaming: true,
  parallelToolCalls: true,
  vision: false,
  promptCache: false,
  reasoning: true,
  media: {
    input: { image: false, audio: false, video: false, document: false },
    outputCombinations: [],
  },
};

async function* streamOf(chunks: readonly StreamChunk[]): AsyncGenerator<StreamChunk> {
  await Promise.resolve();
  for (const c of chunks) yield c;
}

function provider(chunks: StreamChunk[], id: ProviderId = 'anthropic'): LlmProvider {
  return {
    id,
    supports: CAPS,
    generate: () => {
      throw new Error('unused');
    },
    stream: () => streamOf(chunks),
  };
}

/** A provider that replays a different chunk list per call (call N → scripts[N]). */
function scriptedProvider(scripts: StreamChunk[][], id: ProviderId = 'anthropic'): LlmProvider {
  let call = 0;
  return {
    id,
    supports: CAPS,
    generate: () => {
      throw new Error('unused');
    },
    stream: () => streamOf(scripts[call++] ?? []),
  };
}

/** A registry that is never dispatched (the content-only e2e agents use no tools). */
const noToolRegistry: ToolRegistry = {
  has: () => false,
  list: () => [],
  dispatch: () => Promise.reject(new Error('no tool dispatch expected')),
};

/** A registry that returns a sanitized echo outcome (for the tool round-trip e2e). */
const echoRegistry: ToolRegistry = {
  has: () => true,
  list: () => ['echo'],
  dispatch: (call) => {
    const result: ToolResultPart = { type: 'tool_result', toolCallId: call.id, result: 'TOOL-OK' };
    return Promise.resolve({
      output: 'TOOL-OK',
      toolResult: markUntrusted(result),
      truncated: false,
      events: {
        call: { toolId: call.name, toolInput: {} },
        result: { toolId: call.name, success: true, outputSummary: 'TOOL-OK' },
      },
    });
  },
};

/** The matching LLM-visible tool def for the echo registry. */
const echoToolDef: CoreToolDef = {
  id: 'echo',
  source: 'builtin',
  description: 'echo',
  parseArgs: (raw) => raw,
  llmVisibleParams: { type: 'object' },
  policy: { fsScoped: false, spawnsProcess: false, requiresGateApproval: false },
  dispatch: () => Promise.reject(new Error('echoToolDef dispatch is not used directly')),
};

const WORKFLOW = parseWorkflow(
  `schema_version: '1.0'
workflow:
  id: e2e-agent
  inputs:
    - name: text
      type: string
  agents:
    - id: summarizer
      model: claude-opus-4-8
      provider: anthropic
      system_prompt: You summarize.
  nodes:
    - id: sum
      type: agent
      agent_ref: summarizer
      prompt_template: 'Summarize: {{inputs.text}}'
  edges: []
`,
);

async function drain(handle: RunHandle): Promise<RunEvent[]> {
  const events: RunEvent[] = [];
  for await (const event of handle.events) events.push(event);
  return events;
}

function assertGapFreeSeq(events: readonly RunEvent[]): void {
  const seqs = events.map((e) => e.sequenceNumber).sort((a, b) => a - b);
  seqs.forEach((seq, index) => expect(seq).toBe(index));
}

let sandbox: ExpressionSandbox;

beforeAll(async () => {
  sandbox = await createExpressionSandbox();
});

describe('AgentRunner end-to-end through the WorkflowEngine', () => {
  it('runs an agent node, streaming tokens + cost, to run:completed', async () => {
    const engine = new WorkflowEngine({
      host: createInMemoryHost(),
      executor: agentExecutor(() =>
        provider([
          { type: 'text_delta', text: 'a summary' },
          { type: 'stop', stopReason: 'stop', usage: { inputTokens: 8, outputTokens: 4 } },
        ]),
      ),
    });

    const events = await drain(
      engine.start({ workflow: WORKFLOW, inputs: { text: 'the report' } }),
    );
    const types = events.map((e) => e.type);

    // The canonical sequence by colon name, gap-free.
    expect(types).toContain('run:started');
    expect(types).toContain('node:started');
    expect(types).toContain('agent:token');
    expect(types).toContain('cost:updated');
    expect(types.at(-1)).toBe('run:completed');
    assertGapFreeSeq(events);

    // The agent's streamed token + the node output.
    const token = events.find((e) => e.type === 'agent:token');
    expect(token?.type === 'agent:token' && token.token).toBe('a summary');
    const completed = events.find((e) => e.type === 'node:completed');
    expect(completed?.type === 'node:completed' && completed.output).toBe('a summary');
  });

  it('drives the fallback chain and still completes when the primary errors pre-content', async () => {
    const primary = provider([
      {
        type: 'error',
        error: { kind: 'overloaded', retryable: true, provider: 'anthropic', message: 'busy' },
      },
    ]);
    const fallback = provider(
      [
        { type: 'text_delta', text: 'fallback wins' },
        { type: 'stop', stopReason: 'stop', usage: { inputTokens: 2, outputTokens: 2 } },
      ],
      'openai',
    );
    // The agent's fallback_chain adds a second provider id; resolveProvider maps both to stubs.
    const wf = parseWorkflow(
      `schema_version: '1.0'
workflow:
  id: e2e-fallback
  agents:
    - id: a
      model: claude-opus-4-8
      provider: anthropic
      system_prompt: hi
      fallback_chain:
        - model: claude-sonnet-4-6
          provider: openai
          max_attempts: 1
  nodes:
    - id: n
      type: agent
      agent_ref: a
      prompt_template: 'go'
  edges: []
`,
    );
    const engine = new WorkflowEngine({
      host: createInMemoryHost(),
      executor: agentExecutor((id) => (id === 'anthropic' ? primary : fallback)),
    });

    const events = await drain(engine.start({ workflow: wf }));
    expect(events.map((e) => e.type).at(-1)).toBe('run:completed');
    const completed = events.find((e) => e.type === 'node:completed');
    expect(completed?.type === 'node:completed' && completed.output).toBe('fallback wins');
  });

  it('streams a tool round-trip through the engine + bus, gap-free, to run:completed', async () => {
    const wf = parseWorkflow(
      `schema_version: '1.0'
workflow:
  id: e2e-tool
  agents:
    - id: a
      model: claude-opus-4-8
      provider: anthropic
      system_prompt: hi
      tools: [echo]
  nodes:
    - id: n
      type: agent
      agent_ref: a
      prompt_template: 'go'
  edges: []
`,
    );
    const engine = new WorkflowEngine({
      host: createInMemoryHost(),
      executor: agentExecutor(
        () =>
          scriptedProvider([
            // turn 1: a tool call
            [
              { type: 'tool_call_start', id: 'c1', name: 'echo' },
              { type: 'tool_call_end', id: 'c1' },
              { type: 'stop', stopReason: 'tool_use', usage: { inputTokens: 1, outputTokens: 1 } },
            ],
            // turn 2: the answer
            [
              { type: 'text_delta', text: 'answer' },
              { type: 'stop', stopReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } },
            ],
          ]),
        echoRegistry,
        [echoToolDef],
      ),
    });

    const events = await drain(engine.start({ workflow: wf }));
    const types = events.map((e) => e.type);
    // tool events flow through the #nodeEmit shared-fallthrough and the bus, in order, gap-free.
    expect(types).toContain('agent:tool_call');
    expect(types).toContain('agent:tool_result');
    expect(types.indexOf('agent:tool_call')).toBeLessThan(types.indexOf('agent:tool_result'));
    expect(types.at(-1)).toBe('run:completed');
    assertGapFreeSeq(events);
    const completed = events.find((e) => e.type === 'node:completed');
    expect(completed?.type === 'node:completed' && completed.output).toBe('answer');
  });

  it('runs two agent nodes concurrently against the shared executor, gap-free, with no cross-node bleed', async () => {
    const wf = parseWorkflow(
      `schema_version: '1.0'
workflow:
  id: e2e-concurrent
  max_parallel: 2
  agents:
    - id: a
      model: claude-opus-4-8
      provider: anthropic
      system_prompt: hi
  nodes:
    - id: n1
      type: agent
      agent_ref: a
      prompt_template: 'go1'
    - id: n2
      type: agent
      agent_ref: a
      prompt_template: 'go2'
  edges: []
`,
    );
    const engine = new WorkflowEngine({
      host: createInMemoryHost(),
      executor: agentExecutor(() =>
        // One executor instance serves both concurrent nodes; each builds its own chain + CostTracker.
        provider([
          { type: 'text_delta', text: 'done' },
          { type: 'stop', stopReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } },
        ]),
      ),
    });

    const events = await drain(engine.start({ workflow: wf }));
    expect(events.map((e) => e.type).at(-1)).toBe('run:completed');
    assertGapFreeSeq(events); // the bus serializes delivery across the two concurrent nodes
    expect(events.filter((e) => e.type === 'node:completed')).toHaveLength(2);
    // Each node's tokens carry its own nodeId — no cross-node emit/cost bleed on the shared executor.
    const tokenNodes = new Set(
      events
        .filter((e) => e.type === 'agent:token')
        .map((e) => (e.type === 'agent:token' ? e.nodeId : '')),
    );
    expect(tokenNodes).toEqual(new Set(['n1', 'n2']));
  });

  it('retries an agent node via the engine budget resolved from agent.retry (1.S #retryConfig agent fallback, ADR-0040 A.8)', async () => {
    // Call 1 errors retryably (chain exhausts → a retryable NodeFailure); call 2 succeeds. The node has NO
    // node.retry, so #retryConfig falls back to the AGENT's retry — proving the agent arm + A.8 precedence.
    const scripted = scriptedProvider([
      [
        {
          type: 'error',
          error: { kind: 'overloaded', retryable: true, provider: 'anthropic', message: 'busy' },
        },
      ],
      [
        { type: 'text_delta', text: 'recovered' },
        { type: 'stop', stopReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } },
      ],
    ]);
    const wf = parseWorkflow(
      `schema_version: '1.0'
workflow:
  id: e2e-agent-retry
  inputs:
    - name: text
      type: string
  agents:
    - id: flaky-sum
      model: claude-opus-4-8
      provider: anthropic
      system_prompt: You summarize.
      retry: { max: 2, backoff: linear, backoff_ms: 10 }
  nodes:
    - id: sum
      type: agent
      agent_ref: flaky-sum
      prompt_template: 'Summarize: {{inputs.text}}'
  edges: []
`,
    );
    const host = createInMemoryHost();
    const engine = new WorkflowEngine({
      host,
      executor: agentExecutor(() => scripted),
    });
    const events: RunEvent[] = [];
    for await (const event of engine.start({ workflow: wf, inputs: { text: 'x' } }).events) {
      events.push(event);
      if (event.type === 'node:retrying') {
        // Wait for the backoff timer to arm (it is armed in #dispatch's continuation, just after this event),
        // then fire it. A bounded guard fails fast instead of hanging if a regression never arms the timer.
        let waited = 0;
        while (host.armedCount() === 0) {
          waited += 1;
          if (waited > 1000) {
            throw new Error('backoff timer was never armed after node:retrying');
          }
          await Promise.resolve();
        }
        host.fireTimers();
      }
    }
    const retrying = events.filter((e) => e.type === 'node:retrying');
    expect(retrying).toHaveLength(1); // one re-dispatch (agent.retry max 2)
    expect(retrying[0]?.type === 'node:retrying' ? retrying[0].error.retryable : false).toBe(true);
    expect(events.map((e) => e.type).at(-1)).toBe('run:completed');
    expect(
      events.some(
        (e) => e.type === 'node:completed' && e.nodeId === 'sum' && e.attemptNumber === 2,
      ),
    ).toBe(true);
    assertGapFreeSeq(events);
  });
});

function agentExecutor(
  resolveProvider: (id: ProviderId) => LlmProvider | undefined,
  registry: ToolRegistry = noToolRegistry,
  tools: CoreToolDef[] = [],
) {
  return createStandardNodeExecutor({
    sandbox,
    agent: {
      resolveProvider,
      registry,
      tools,
      keyFor: () => 'k',
      sleep: () => Promise.resolve(),
      now: () => 1,
    },
  });
}

describe('AgentRunner resource governance end-to-end (ADR-0028, 1.AC)', () => {
  function budgetWorkflow(onExceed: string): ReturnType<typeof parseWorkflow> {
    return parseWorkflow(
      `schema_version: '1.0'
workflow:
  id: e2e-budget
  budget:
    max_cost_microcents: 1
    on_exceed: ${onExceed}
  agents:
    - id: a
      model: claude-opus-4-8
      provider: anthropic
      system_prompt: hi
  nodes:
    - id: n
      type: agent
      agent_ref: a
      prompt_template: 'go'
  edges: []
`,
    );
  }

  function cheapProvider(): LlmProvider {
    return provider([
      { type: 'text_delta', text: 'ok' },
      { type: 'stop', stopReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } },
    ]);
  }

  it('warns and continues when on_exceed is warn', async () => {
    const engine = new WorkflowEngine({
      host: createInMemoryHost(),
      executor: agentExecutor(() => cheapProvider()),
    });
    const events = await drain(
      engine.start({ workflow: budgetWorkflow('warn'), inputs: { text: 'x' } }),
    );
    expect(events.at(-1)?.type).toBe('run:completed');
    const warning = events.find((e) => e.type === 'budget:warning');
    expect(warning).toBeDefined();
    // The warning fires before any spend, so the observed spent/limit fraction is 0%.
    expect(warning?.type === 'budget:warning' && warning.thresholdPct).toBe(0);
  });

  it('fails the run when on_exceed is fail', async () => {
    const engine = new WorkflowEngine({
      host: createInMemoryHost(),
      executor: agentExecutor(() => cheapProvider()),
    });
    const events = await drain(
      engine.start({ workflow: budgetWorkflow('fail'), inputs: { text: 'x' } }),
    );
    expect(events.at(-1)?.type).toBe('run:failed');
    const terminal = events.at(-1);
    expect(terminal?.type === 'run:failed' && terminal.error.code).toBe('budget_exceeded');
    expect(events.some((e) => e.type === 'node:failed')).toBe(true);
  });

  it('pauses and resumes when on_exceed is pause_for_approval', async () => {
    const engine = new WorkflowEngine({
      host: createInMemoryHost(),
      executor: agentExecutor(() => cheapProvider()),
    });
    const handle = engine.start({
      workflow: budgetWorkflow('pause_for_approval'),
      inputs: { text: 'x' },
    });
    const events: RunEvent[] = [];
    for await (const event of handle.events) {
      events.push(event);
      if (event.type === 'budget:paused') {
        await engine.resume(handle.runId, event.gateId, {
          decision: 'approved',
          decidedBy: 'user-1',
        });
      }
    }
    expect(events.at(-1)?.type).toBe('run:completed');
    expect(events.some((e) => e.type === 'budget:paused')).toBe(true);
    // run:paused is emitted, but a synchronous resume may settle the run before the event surfaces,
    // so we only assert the budget gate fired and the run ultimately completed.
  });

  it('fails the run when a paused budget gate is rejected', async () => {
    const engine = new WorkflowEngine({
      host: createInMemoryHost(),
      executor: agentExecutor(() => cheapProvider()),
    });
    const handle = engine.start({
      workflow: budgetWorkflow('pause_for_approval'),
      inputs: { text: 'x' },
    });
    const events: RunEvent[] = [];
    for await (const event of handle.events) {
      events.push(event);
      if (event.type === 'budget:paused') {
        await engine.resume(handle.runId, event.gateId, {
          decision: 'rejected',
          decidedBy: 'user-1',
        });
      }
    }
    expect(events.at(-1)?.type).toBe('run:failed');
    const terminal = events.at(-1);
    expect(terminal?.type === 'run:failed' && terminal.error.code).toBe('budget_exceeded');
  });

  it('fails the run when timeout_ms elapses', async () => {
    const base = createInMemoryHost();
    const host = {
      ...base,
      // Fire any timeout immediately, deterministically.
      setTimer: (_ms: number, onFire: () => void) => {
        onFire();
        return () => {};
      },
    };
    const engine = new WorkflowEngine({
      host,
      executor: agentExecutor(() => cheapProvider()),
    });
    const wf = parseWorkflow(
      `schema_version: '1.0'
workflow:
  id: e2e-timeout
  timeout_ms: 1
  agents:
    - id: a
      model: claude-opus-4-8
      provider: anthropic
      system_prompt: hi
  nodes:
    - id: n
      type: agent
      agent_ref: a
      prompt_template: 'go'
  edges: []
`,
    );
    const events = await drain(engine.start({ workflow: wf, inputs: { text: 'x' } }));
    expect(events.some((e) => e.type === 'run:timeout')).toBe(true);
    expect(events.at(-1)?.type).toBe('run:failed');
    const terminal = events.at(-1);
    expect(terminal?.type === 'run:failed' && terminal.error.code).toBe('run_timeout');
  });
});
