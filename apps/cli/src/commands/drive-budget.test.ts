import { createInMemoryHost, parseWorkflow } from '@relavium/core';
import type { LlmProvider, ModelPricing } from '@relavium/llm';
import type { RunEvent } from '@relavium/shared';
import { expect, it } from 'vitest';
import { buildEngine } from '../engine/build-engine.js';
import type { GatePrompter } from '../gate/prompter.js';
import { captureIo, CHAT_TEXT_CAPABILITY_FLAGS } from '../test-support.js';
import { driveRun } from './drive.js';
const MODEL = 'offline-budget-ui';
const PRICE: ModelPricing = {
  provider: 'openai',
  nativeId: MODEL,
  displayName: MODEL,
  contextWindowTokens: 100000,
  maxOutputTokens: 1000,
  inputPerMtokMicrocents: 1000000,
  outputPerMtokMicrocents: 1000000,
  cachedInputPerMtokMicrocents: 1000000,
};
for (const mode of ['approve', 'reject', 'stale', 'missing_amount', 'input'] as const) {
  it(`actual inline budget ${mode} keeps exact authority and zero unintended egress`, async () => {
    const prices = new Map([[MODEL, PRICE]]);
    const host = createInMemoryHost();
    let keyReads = 0;
    let calls = 0;
    const provider: LlmProvider = {
      id: 'openai',
      customEndpoint: true,
      supports: CHAT_TEXT_CAPABILITY_FLAGS,
      generate: () => Promise.reject(new Error('unexpected generate')),
      stream: async function* () {
        await Promise.resolve();
        calls++;
        yield { type: 'text_delta', text: 'ANSWER' };
        yield {
          type: 'stop',
          stopReason: 'stop',
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    };
    const engine = await buildEngine({
      host,
      resolvePrice: prices,
      providers: {
        resolveProvider: () => provider,
        keyFor: () => {
          keyReads++;
          return 'offline-key';
        },
        endpointKind: () => 'custom',
      },
    });
    const workflow = parseWorkflow(
      `schema_version: '1.0'\nworkflow:\n  id: budget-ui\n  budget: {max_cost_microcents: 1, on_exceed: pause_for_approval, strict_cost_cap: true}\n  agents:\n    - {id: worker,model: ${MODEL},provider: openai,system_prompt: go}\n  nodes:\n    - {id: agent,type: agent,agent_ref: worker,prompt_template: hello,max_tokens: 64}\n    - {id: out,type: output}\n  edges:\n    - {from: agent,to: out}\n`,
    );
    const handle = engine.start({ workflow, inputs: {} });
    let terminal: () => void = () => {};
    const settled = new Promise<void>((resolve) => {
      terminal = resolve;
    });
    const unsubscribe = handle.subscribe((e) => {
      if (['run:completed', 'run:failed', 'run:cancelled'].includes(e.type)) terminal();
    });
    const events: RunEvent[] = [];
    const { io, err } = captureIo();
    let prompts = 0;
    let approvedAmount: number | undefined;
    const prompter: GatePrompter = {
      prompt: async (e, budget) => {
        await Promise.resolve();
        prompts++;
        expect(budget?.kind).toBe('amount');
        if (budget?.kind !== 'amount') throw new Error('native scalar budget context missing');
        expect(budget.microcents).toBeGreaterThan(1);
        expect(keyReads).toBe(0);
        expect(calls).toBe(0);
        if (mode === 'stale') prices.set(MODEL, { ...PRICE, inputPerMtokMicrocents: 2000000 });
        if (mode === 'reject') return { decision: 'rejected', decidedBy: 'cli' };
        if (mode === 'missing_amount') return { decision: 'approved', decidedBy: 'cli' };
        if (mode === 'input')
          return {
            decision: 'input_provided',
            decidedBy: 'cli',
            payload: 'forbidden budget input',
          };
        approvedAmount = budget.microcents;
        return {
          decision: 'approved',
          decidedBy: 'cli',
          approvedAmountMicrocents: budget.microcents,
        };
      },
    };
    try {
      const result = await driveRun({
        engine,
        handle,
        makeRenderer: () => ({ onEvent: (e) => events.push(e) }),
        gatePrompter: prompter,
        io,
      });
      expect(prompts).toBe(1);
      if (mode === 'approve') {
        expect(result).toBe('completed');
        expect(keyReads).toBe(1);
        expect(calls).toBe(1);
        expect(
          events.find(
            (e) => e.type === 'budget:authorization' && e.authorization.state === 'decided',
          ),
        ).toMatchObject({
          type: 'budget:authorization',
          authorization: {
            state: 'decided',
            decision: 'approved',
            approvedAmountMicrocents: approvedAmount,
          },
        });
      } else if (mode === 'reject') {
        expect(result).toBe('failed');
        expect(keyReads).toBe(0);
        expect(calls).toBe(0);
        expect(handle.terminalError()).toBe('budget_exceeded');
      } else {
        expect(result).toBe('paused');
        expect(events.at(-1)).toMatchObject({ type: 'run:paused', runId: handle.runId });
        expect(keyReads).toBe(0);
        expect(calls).toBe(0);
        expect(err()).toContain('remains pending');
        const cp = await host.checkpointer.load(handle.runId);
        expect(cp?.pendingGates).toHaveLength(1);
        expect(cp?.pendingGates[0]?.isBudgetGate).toBe(true);
        expect(
          events.filter(
            (e) => e.type === 'budget:authorization' && e.authorization.state === 'decided',
          ),
        ).toEqual([]);
      }
    } finally {
      const final = await handle.depart();
      expect(final.kind).toBe(
        ['stale', 'missing_amount', 'input'].includes(mode) ? 'detached' : 'closed',
      );
      const before = events.length;
      handle.cancel();
      if (final.kind !== 'detached') await settled;
      else {
        await Promise.resolve();
        expect(events).toHaveLength(before);
        expect(events.some((e) => e.type === 'run:cancelled')).toBe(false);
      }
      unsubscribe();
      expect(host.armedCount()).toBe(0);
      expect(host.livenessCount()).toBe(0);
      expect(host.deadlineCount()).toBe(0);
    }
  });
}
