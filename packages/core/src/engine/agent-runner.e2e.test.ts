import type { CapabilityFlags, LlmProvider, ProviderId, StreamChunk } from '@relavium/llm';
import type { RunEvent } from '@relavium/shared';
import { beforeAll, describe, expect, it } from 'vitest';

import { parseWorkflow } from '../parser.js';
import { createExpressionSandbox, type ExpressionSandbox } from '../expression/sandbox.js';
import type { ToolDef as CoreToolDef, ToolRegistry, ToolResultPart } from '../tools/types.js';
import { markUntrusted } from '../tools/untrusted.js';
import { WorkflowEngine } from './engine.js';
import { createAbortController, createInMemoryHost } from './execution-host.js';
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

/** A budget workflow whose model is UNPRICED — a custom id neither the catalog nor a user prices. */
function unpricedBudgetWorkflow(strict: boolean): ReturnType<typeof parseWorkflow> {
  return parseWorkflow(
    `schema_version: '1.0'
workflow:
  id: e2e-budget-unpriced
  inputs:
    - { name: text, type: string }
  budget:
    max_cost_microcents: 1000000
    on_exceed: warn${strict ? '\n    strict_cost_cap: true' : ''}
  agents:
    - id: a
      model: my-self-hosted-model
      provider: openai
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

function budgetWorkflow(onExceed: string): ReturnType<typeof parseWorkflow> {
  return parseWorkflow(
    `schema_version: '1.0'
workflow:
  id: e2e-budget
  inputs:
    - { name: text, type: string }
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

/** Two independently-admissible calls whose combined worst-case output cost exceeds the authored cap (G38). */
function parallelBudgetWorkflow(): ReturnType<typeof parseWorkflow> {
  return parseWorkflow(
    `schema_version: '1.0'
workflow:
  id: e2e-budget-parallel-admission
  max_parallel: 2
  budget:
    max_cost_microcents: 750000
    on_exceed: fail
  agents:
    - id: a
      model: claude-haiku-4-5
      provider: anthropic
      system_prompt: hi
      max_tokens: 1000
  nodes:
    - id: n1
      type: agent
      agent_ref: a
      prompt_template: 'one'
    - id: n2
      type: agent
      agent_ref: a
      prompt_template: 'two'
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

describe('AgentRunner resource governance end-to-end (ADR-0028, 1.AC)', () => {
  it('keeps the true in-provider attempt admission while a max_parallel sibling is denied (G38)', async () => {
    // Haiku's 1,000-output-token worst case is 500,000µ¢. Each branch fits a 750,000µ¢ cap in isolation,
    // but two max_parallel:2 TRUE provider attempts must NOT both reach egress: their combined reservation is
    // 1,000,000µ¢. The first stream deliberately remains in-flight while the sibling reaches its own actual
    // attempt boundary; this proves the ledger is not merely a transient loop-top probe. Before G38 this goes red
    // with two provider calls and run:completed at 1,000,200µ¢ (the 1-input-token charge is included).
    let calls = 0;
    let signalFirstStarted: (() => void) | undefined;
    const firstStarted = new Promise<void>((resolve) => {
      signalFirstStarted = () => resolve();
    });
    let releaseFirst: (() => void) | undefined;
    const firstMayFinish = new Promise<void>((resolve) => {
      releaseFirst = () => resolve();
    });
    let signalSecondProviderCall: (() => void) | undefined;
    const secondProviderCall = new Promise<void>((resolve) => {
      signalSecondProviderCall = () => resolve();
    });
    const providerWithCount: LlmProvider = {
      id: 'anthropic',
      supports: CAPS,
      generate: () => {
        throw new Error('unused');
      },
      stream: () => {
        calls += 1;
        if (calls === 1) {
          return (async function* (): AsyncGenerator<StreamChunk> {
            if (signalFirstStarted === undefined)
              throw new Error('first-attempt barrier was not initialized');
            signalFirstStarted();
            await firstMayFinish;
            yield { type: 'text_delta', text: 'ok' };
            yield {
              type: 'stop',
              stopReason: 'stop',
              usage: { inputTokens: 1, outputTokens: 1000 },
            };
          })();
        }
        signalSecondProviderCall?.();
        return streamOf([
          { type: 'text_delta', text: 'ok' },
          { type: 'stop', stopReason: 'stop', usage: { inputTokens: 1, outputTokens: 1000 } },
        ]);
      },
    };
    const engine = new WorkflowEngine({
      host: createInMemoryHost(),
      executor: agentExecutor(() => providerWithCount),
    });

    const handle = engine.start({ workflow: parallelBudgetWorkflow() });
    const events: RunEvent[] = [];
    let signalSiblingDenied: (() => void) | undefined;
    const siblingDenied = new Promise<void>((resolve) => {
      signalSiblingDenied = () => resolve();
    });
    const consume = (async (): Promise<void> => {
      for await (const event of handle.events) {
        events.push(event);
        if (event.type === 'node:failed' && event.error.code === 'budget_exceeded') {
          signalSiblingDenied?.();
        }
      }
    })();

    try {
      await firstStarted;
      const release = releaseFirst;
      if (release === undefined) throw new Error('first-attempt barrier was not initialized');
      // Race the sibling's budget failure against an observable second seam invocation WHILE the first provider is
      // still blocked. Before G38, the old released probe reaches `stream()` first; the repaired ledger instead
      // emits the sibling's budget failure before a second provider call exists.
      const boundary = await Promise.race([
        siblingDenied.then(() => 'denied' as const),
        secondProviderCall.then(() => 'second_provider_call' as const),
      ]);
      expect(boundary).toBe('denied');
      expect(calls).toBe(1);
    } finally {
      releaseFirst?.();
    }
    await consume;

    expect(calls).toBe(1);
    expect(events.at(-1)?.type).toBe('run:failed');
    const terminal = events.at(-1);
    expect(terminal?.type === 'run:failed' && terminal.error.code).toBe('budget_exceeded');
    assertGapFreeSeq(events);
  });

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
    // `spentMicrocents` remains the honest realized 0, but G47 projects the post-call total for the warning
    // threshold; the 1µ¢ cap is therefore fully exceeded (clamped to the event schema's 100%).
    expect(warning?.type === 'budget:warning' && warning.thresholdPct).toBe(100);
  });

  it('an UNPRICED model reaches the onUnpriced sink THROUGH WorkflowEngine (ADR-0071 §K7)', async () => {
    // THE bug two commits missed: WorkflowEngine took `onUnpriced` in its deps and then never stored or forwarded
    // it, so the notice was DEAD on `relavium run` / `relavium gate` — the batch surfaces, where an unattended run
    // is the highest-risk place for a cap to silently not apply. The sink is injected here exactly as the CLI
    // injects it, and the model is unpriced, so a working forward is the only way this array is non-empty.
    const unpriced: string[] = [];
    const engine = new WorkflowEngine({
      host: createInMemoryHost(),
      executor: agentExecutor(() =>
        provider(
          [
            { type: 'text_delta', text: 'ok' },
            { type: 'stop', stopReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } },
          ],
          'openai',
        ),
      ),
      onUnpriced: (model) => unpriced.push(model),
    });
    const events = await drain(
      engine.start({ workflow: unpricedBudgetWorkflow(false), inputs: { text: 'x' } }),
    );
    expect(events.at(-1)?.type).toBe('run:completed'); // unpriced degrades to allow — the run still finishes
    expect(unpriced).toEqual(['my-self-hosted-model']); // …but the notice fired, through the engine boundary
  });

  it('strict_cost_cap BLOCKS an unpriced model through WorkflowEngine, regardless of on_exceed', async () => {
    const engine = new WorkflowEngine({
      host: createInMemoryHost(),
      executor: agentExecutor(() =>
        provider(
          [
            { type: 'text_delta', text: 'ok' },
            { type: 'stop', stopReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } },
          ],
          'openai',
        ),
      ),
    });
    const events = await drain(
      engine.start({ workflow: unpricedBudgetWorkflow(true), inputs: { text: 'x' } }),
    );
    // on_exceed is `warn`, but strict overrides it: an unpriceable model is a HARD pre-egress fail.
    expect(events.at(-1)?.type).toBe('run:failed');
    const terminal = events.at(-1);
    expect(terminal?.type === 'run:failed' && terminal.error.code).toBe('budget_exceeded');
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

  it('pauses, and on approve CONTINUES the deferred LLM call (H3 — not a {decision} short-circuit)', async () => {
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
    // H3: approving a budget pause must CONTINUE the call — the agent node re-dispatches (a one-shot
    // pre-egress bypass) and completes with the MODEL's output, never a `{decision:'approved'}`
    // short-circuit. So 'n' starts twice (initial + post-approval re-dispatch) and its node:completed
    // carries the streamed 'ok'. Before the fix the node was marked completed with the gate decision and
    // the LLM call never issued.
    const nStarted = events.filter((e) => e.type === 'node:started' && e.nodeId === 'n');
    expect(nStarted.length).toBe(2);
    const nDone = events.find((e) => e.type === 'node:completed' && e.nodeId === 'n');
    expect(nDone?.type === 'node:completed' ? nDone.output : undefined).toBe('ok');
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

  it('an approved over-budget node does NOT re-pause on an above-chain retry (H3 × ADR-0040)', async () => {
    // Regression for the bypass-through-retry fix: the budget approval is consumed ONCE per dispatch and
    // threaded through every node-retry attempt. With max_cost_microcents: 1 EVERY pre-egress check would
    // trip, so a re-armed check on the retry would pause again. The approved node's first (post-approval)
    // attempt fails retryably; the retry must run uncapped and complete — NOT trip a SECOND budget:paused.
    // Before the fix the bypass was consumed on attempt 1 only, so the retry re-paused.
    const scripted = scriptedProvider([
      [
        {
          type: 'error',
          error: { kind: 'overloaded', retryable: true, provider: 'anthropic', message: 'busy' },
        },
      ],
      [
        { type: 'text_delta', text: 'ok' },
        { type: 'stop', stopReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } },
      ],
    ]);
    const wf = parseWorkflow(
      `schema_version: '1.0'
workflow:
  id: e2e-budget-retry
  inputs:
    - { name: text, type: string }
  budget:
    max_cost_microcents: 1
    on_exceed: pause_for_approval
  agents:
    - id: a
      model: claude-opus-4-8
      provider: anthropic
      system_prompt: hi
      retry: { max: 2, backoff: linear, backoff_ms: 10 }
  nodes:
    - id: n
      type: agent
      agent_ref: a
      prompt_template: 'go'
  edges: []
`,
    );
    const host = createInMemoryHost();
    const engine = new WorkflowEngine({ host, executor: agentExecutor(() => scripted) });
    const handle = engine.start({ workflow: wf, inputs: { text: 'x' } });
    const events: RunEvent[] = [];
    for await (const event of handle.events) {
      events.push(event);
      if (event.type === 'budget:paused') {
        await engine.resume(handle.runId, event.gateId, {
          decision: 'approved',
          decidedBy: 'user-1',
        });
      }
      if (event.type === 'node:retrying') {
        // Arm-then-fire the backoff timer (armed in #dispatch's continuation, just after this event).
        let waited = 0;
        while (host.armedCount() === 0) {
          waited += 1;
          if (waited > 1000) throw new Error('backoff timer was never armed after node:retrying');
          await Promise.resolve();
        }
        host.fireTimers();
      }
    }
    // Exactly ONE budget:paused (the initial over-budget check) — the retry did NOT re-pause.
    expect(events.filter((e) => e.type === 'budget:paused')).toHaveLength(1);
    // The retryable failure surfaced as exactly one node:retrying, then the node completed on attempt 2.
    expect(events.filter((e) => e.type === 'node:retrying')).toHaveLength(1);
    expect(events.at(-1)?.type).toBe('run:completed');
    const done = events.find((e) => e.type === 'node:completed' && e.nodeId === 'n');
    expect(done?.type === 'node:completed' ? done.output : undefined).toBe('ok');
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
  inputs:
    - { name: text, type: string }
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

/**
 * [ADR-0082](../../../../docs/decisions/0082-the-stream-grammar-is-a-seam-obligation-and-every-attempt-has-a-deadline.md)
 * §4 — rule 7's node-retry half, through the REAL engine.
 *
 * **Why the real engine and not a unit stub.** The defect lived in the seam between three layers that each
 * looked correct alone: the chain refuses to fail over past content, `throwMappedChainError` copies
 * `error.retryable` onto the turn error, and `#shouldRetry` gates on that boolean. `timeout` and `transport`
 * are both in `RETRYABLE_KINDS`, so a content-committed transient failure was re-dispatched — a second
 * answer and a second charge for a call the user had already seen output from. Only a test that spans all
 * three layers can see it.
 */
describe('a content-committed failure is never node-retried (ADR-0082 §4)', () => {
  const RETRY_WORKFLOW = parseWorkflow(
    `schema_version: '1.0'
workflow:
  id: e2e-agent-retry
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
      retry: { max: 3, backoff: linear, backoff_ms: 1 }
  edges: []
`,
  );

  const TIMEOUT: StreamChunk = {
    type: 'error',
    error: {
      kind: 'timeout',
      retryable: true,
      provider: 'anthropic',
      message: 'the provider stopped responding',
    },
  };

  /** Run the retrying workflow against a provider that counts its stream calls. */
  async function runCounting(
    chunks: StreamChunk[],
  ): Promise<{ calls: number; events: RunEvent[] }> {
    let calls = 0;
    const host = createInMemoryHost();
    const engine = new WorkflowEngine({
      host,
      executor: agentExecutor(() => ({
        id: 'anthropic',
        supports: CAPS,
        generate: () => {
          throw new Error('unused');
        },
        stream: () => {
          calls += 1;
          return streamOf(chunks);
        },
      })),
    });
    const handle = engine.start({ workflow: RETRY_WORKFLOW, inputs: { text: 'the report' } });
    const events: RunEvent[] = [];
    for await (const event of handle.events) {
      events.push(event);
      if (event.type === 'node:retrying') {
        // The backoff timer is armed asynchronously AFTER the event, so poll rather than fire blind.
        let waited = 0;
        while (host.armedCount() === 0) {
          waited += 1;
          if (waited > 1000) throw new Error('backoff timer was never armed after node:retrying');
          await Promise.resolve();
        }
        host.fireTimers();
      }
    }
    return { calls, events };
  }

  it('a timeout AFTER content produces exactly one provider call, despite retry.max = 3', async () => {
    const { calls, events } = await runCounting([
      { type: 'text_delta', text: 'the user already saw this' },
      TIMEOUT,
    ]);

    expect(calls).toBe(1);
    expect(events.filter((e) => e.type === 'node:retrying')).toHaveLength(0);
    expect(events.some((e) => e.type === 'run:failed')).toBe(true);
  });

  it('a timeout in a LATER TOOL ROUND is not retried either — commitment is a TURN fact', async () => {
    // The gap a review measured, and the reason the carrier could not stay per-`stream()`-call. A tool-using
    // turn calls `chain.stream()` once PER ROUND, so round 1's failure carries no chain-level commitment
    // however much round 0 already streamed. Before the fix: six provider calls, the same assistant text
    // pushed to the user three times, and `echo` dispatched three times — verbatim the harm ADR-0082 §4
    // exists to remove, with only ADR-0080's effect journal between it and a duplicated side effect.
    const toolWf = parseWorkflow(
      `schema_version: '1.0'
workflow:
  id: e2e-agent-retry-tools
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
      retry: { max: 3, backoff: linear, backoff_ms: 1 }
  edges: []
`,
    );
    let calls = 0;
    const host = createInMemoryHost();
    const engine = new WorkflowEngine({
      host,
      executor: agentExecutor(
        () => ({
          id: 'anthropic',
          supports: CAPS,
          generate: () => {
            throw new Error('unused');
          },
          stream: () => {
            calls += 1;
            // Round 0 streams text AND a tool call; round 1 times out having produced nothing itself.
            return streamOf(
              calls % 2 === 1
                ? [
                    { type: 'text_delta', text: 'the user already saw this' },
                    { type: 'tool_call_start', id: 'c1', name: 'echo' },
                    { type: 'tool_call_end', id: 'c1' },
                    {
                      type: 'stop',
                      stopReason: 'tool_use',
                      usage: { inputTokens: 1, outputTokens: 1 },
                    },
                  ]
                : [TIMEOUT],
            );
          },
        }),
        echoRegistry,
        [echoToolDef],
      ),
    });

    const events: RunEvent[] = [];
    const handle = engine.start({ workflow: toolWf });
    for await (const event of handle.events) {
      events.push(event);
      if (event.type === 'node:retrying') {
        let waited = 0;
        while (host.armedCount() === 0) {
          waited += 1;
          if (waited > 1000) throw new Error('backoff timer was never armed after node:retrying');
          await Promise.resolve();
        }
        host.fireTimers();
      }
    }

    expect(calls).toBe(2); // round 0 + the failing round 1 — and then it STOPS
    expect(events.filter((e) => e.type === 'node:retrying')).toHaveLength(0);
    // The user saw the assistant's text exactly once, and the tool ran exactly once.
    expect(events.filter((e) => e.type === 'agent:token')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'agent:tool_call')).toHaveLength(1);
  });

  it('…and a timeout BEFORE content IS retried — the negative control', async () => {
    // Without this the assertion above is satisfied by an implementation that disabled node retry outright,
    // which would break every transient-failure recovery the budget exists for.
    const { calls, events } = await runCounting([TIMEOUT]);

    expect(calls).toBe(3); // the full budget
    expect(events.filter((e) => e.type === 'node:retrying')).toHaveLength(2);
  });
});

describe('AgentRunner — the ADR-0082 deadline ports actually reach the chain (workflow path)', () => {
  it('arms the attempt deadline from `AgentRunnerDeps.setTimer`, and a hung provider fails the node', async () => {
    // The workflow twin of `agent-session.test.ts`'s forwarding test, and it is a SEPARATE test because the
    // two paths express "both or neither" differently: `agent-session.ts` gates BOTH keys on `setTimer`
    // being present, while `chainCapabilities()` here spreads them INDEPENDENTLY. Same runtime outcome,
    // two code paths — so one test cannot cover both, and neither was covered at all.
    //
    // Drop `setTimer` from `chainCapabilities()` and this hangs: every workflow agent node reverts to an
    // unbounded provider wait, with the CLI host's source-grep guard still green.
    const armed: number[] = [];
    const hung: LlmProvider = {
      id: 'anthropic',
      supports: CAPS,
      // THROWS rather than hangs — this node streams, and the file's other doubles all throw here. A
      // hanging `generate` would read as coverage of a path this test never takes.
      generate: () => {
        throw new Error('unused — this node streams');
      },
      stream: () => ({
        [Symbol.asyncIterator]: () => ({ next: () => new Promise<never>(() => undefined) }),
      }),
    };

    const engine = new WorkflowEngine({
      host: createInMemoryHost(),
      executor: createStandardNodeExecutor({
        sandbox,
        agent: {
          resolveProvider: () => hung,
          registry: noToolRegistry,
          tools: [],
          keyFor: () => 'k',
          sleep: () => Promise.resolve(),
          now: () => 1,
          newAbortController: createAbortController,
          attemptTimeoutMs: 45_000,
          // Trips each attempt's deadline on the next microtask — a chain attempt opens its own scope, so
          // firing only the first would leave a retry waiting on a timer nothing fires.
          setTimer: (ms: number, onFire: () => void) => {
            armed.push(ms);
            queueMicrotask(onFire);
            return () => undefined;
          },
        },
      }),
    });

    const handle = engine.start({ workflow: WORKFLOW, inputs: { text: 'the report' } });
    // Drain bounded microtasks BEFORE draining the run, so a missing timer port reddens on an assertion in
    // ~0 ms instead of hanging out the 5 s vitest budget. The two failures then read differently: "the port
    // was not forwarded" (`armed` empty) versus "the run deadlocked for an unrelated reason" (`armed`
    // populated, the drain never ends) — a bare timeout cannot tell those apart.
    for (let i = 0; i < 500 && armed.length === 0; i += 1) await Promise.resolve();

    // **A NON-DEFAULT value, and that is the whole point.** Asserting 120_000 here would be hollow:
    // `DEFAULT_ATTEMPT_TIMEOUT_MS` is exactly what `FallbackChain` falls back to when `attemptTimeoutMs`
    // is ABSENT (`fallback-chain.ts`), so the assertion would pass whether or not the third port is
    // forwarded. Measured: with both `attemptTimeoutMs` forwarding lines deleted, the whole core suite —
    // this test included — stayed green. Asserting a value only the port can deliver break-verifies it.
    expect(armed.length).toBeGreaterThan(0); // the timer port arrived — the assertion no guard made
    expect(armed.every((ms) => ms === 45_000)).toBe(true); // …and so did the timeout port, intact

    const events = await drain(handle);
    const terminal = events.at(-1);
    expect(terminal?.type).toBe('run:failed');
    // …classified, not merely failed. ADR-0082 §5 maps a deadline abort to `timeout`, which
    // `codeForLlmError` maps to the retryable `provider_unavailable`. Asserting only `run:failed` would stay
    // green if a regression reclassified the deadline as a non-retryable `internal` — the exact property
    // CR-21's acceptance names. The session twin asserts the code; this one did not.
    expect(terminal?.type === 'run:failed' && terminal.error.code).toBe('provider_unavailable');
    assertGapFreeSeq(events);
  });
});
