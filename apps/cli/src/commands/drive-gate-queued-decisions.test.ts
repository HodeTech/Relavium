import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as turn } from 'node:timers/promises';
import { expect, it } from 'vitest';
import type { RunStore, WorkflowEngine } from '@relavium/core';
import {
  createClient,
  createRunHistoryStore,
  createRunLeasePort,
  runMigrations,
} from '@relavium/db';
import type { LlmProvider, ModelPricing } from '@relavium/llm';

import { runCommand } from './run.js';
import { buildEngine } from '../engine/build-engine.js';
import { captureIo, CHAT_TEXT_CAPABILITY_FLAGS } from '../test-support.js';
import { createInkRenderer } from '../render/tui/ink-renderer.js';

function latch() {
  let release = (): void => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

const model = 'queued-decisions-native';
const pricing: ModelPricing = {
  provider: 'openai',
  nativeId: model,
  displayName: model,
  contextWindowTokens: 80000,
  maxOutputTokens: 2048,
  inputPerMtokMicrocents: 1000000,
  outputPerMtokMicrocents: 1000000,
  cachedInputPerMtokMicrocents: 1000000,
};

for (const scenario of [
  'budget-reject',
  'ordinary-reject',
  'budget-approve',
  'losing-reject',
] as const) {
  it(`preserves native authority for queued gates: ${scenario}`, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'queued-gates-'));
    const dbPath = join(directory, 'history.db');
    const client = createClient(dbPath);
    runMigrations(client.db, { dbPath });
    const paused = latch(),
      releasePause = latch(),
      firstPrompt = latch(),
      firstAnswer = latch();
    const releaseSurplus = latch(),
      terminalEntered = latch(),
      releaseTerminal = latch(),
      terminalAck = latch();
    const summaries: string[] = [];
    let nativeEngine: WorkflowEngine | undefined;
    let firstGate: { readonly gateId: string; readonly amount: number } | undefined;
    let runId = '',
      prompts = 0,
      calls = 0,
      closes = 0,
      writerErrors = 0,
      settled = false;
    let observedPrompts: number | undefined;
    let execution: Promise<number> | undefined;
    const initialSignals = process.listenerCount('SIGINT');
    const provider: LlmProvider = {
      id: 'openai',
      customEndpoint: true,
      supports: CHAT_TEXT_CAPABILITY_FLAGS,
      generate: () => Promise.reject(new Error('unused generate route')),
      stream: async function* () {
        calls++;
        // Keep the fake provider asynchronous behind the actual held pause writer barrier.
        await releasePause.promise;
        yield { type: 'stop', stopReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    writeFileSync(
      join(directory, 'flow.relavium.yaml'),
      JSON.stringify({
        schema_version: '1.0',
        workflow: {
          id: 'queued-gates',
          budget: {
            max_cost_microcents: 1,
            on_exceed: 'pause_for_approval',
            strict_cost_cap: true,
          },
          agents: [{ id: 'worker', provider: 'openai', model, system_prompt: 'go' }],
          nodes: ['one', 'two'].map((id) =>
            scenario === 'ordinary-reject'
              ? { id, type: 'human_gate', gate_type: 'approval' }
              : {
                  id,
                  type: 'agent',
                  agent_ref: 'worker',
                  prompt_template: 'bounded',
                  max_tokens: 16,
                },
          ),
          edges: [],
        },
      }),
    );
    try {
      execution = runCommand(
        { workflow: 'flow.relavium.yaml', input: [], allowMcpStdio: [] },
        {
          io: captureIo().io,
          global: {
            cwd: directory,
            json: false,
            color: false,
            configPath: undefined,
            verbosity: 'normal',
          },
          providers: {
            resolveProvider: () => provider,
            keyFor: () => 'synthetic-only',
            endpointKind: () => 'custom',
          },
          openRunStore: (workflow) => {
            const store = createRunHistoryStore(client.db, {
              uuid: randomUUID,
              now: Date.now,
              projectRoot: directory,
              workflow: {
                slug: workflow.workflow.id,
                name: 'queued',
                definitionJson: JSON.stringify(workflow),
              },
            });
            return {
              db: client.db,
              store,
              terminalOutboxPath: join(directory, 'outbox'),
              close: () => {
                closes++;
                client.sqlite.close();
              },
            };
          },
          buildEngine: async (options) => {
            if (!options?.host) throw new Error('actual host required');
            const host = options.host;
            const store: RunStore = {
              ...host.store,
              persistEvent: async (event, context) => {
                if (event.type === 'run:started') runId = event.runId;
                if (event.type === 'run:paused') {
                  paused.release();
                  await releasePause.promise;
                }
                if (event.type === 'run:failed') {
                  terminalEntered.release();
                  await releaseTerminal.promise;
                }
                try {
                  await host.store.persistEvent(event, context);
                  if (event.type === 'run:failed') terminalAck.release();
                } catch (error) {
                  writerErrors++;
                  throw error;
                }
              },
            };
            nativeEngine = await buildEngine({
              ...options,
              resolvePrice: new Map([[model, pricing]]),
              host: { ...host, store },
            });
            return nativeEngine;
          },
          selectRenderer: () =>
            createInkRenderer({
              color: false,
              writeSummary: (value) => {
                summaries.push(value);
              },
            }),
          selectGatePrompter: () => ({
            prompt: async (event, budget) => {
              prompts++;
              if (prompts === 1) {
                if (budget?.kind === 'amount')
                  firstGate = { gateId: event.gateId, amount: budget.microcents };
                firstPrompt.release();
                await firstAnswer.promise;
              } else if (scenario === 'budget-reject') await releaseSurplus.promise;
              if (
                scenario === 'budget-reject' ||
                scenario === 'ordinary-reject' ||
                (scenario === 'losing-reject' && prompts === 1)
              )
                return { decision: 'rejected', decidedBy: 'test-human' };
              if (budget?.kind !== 'amount') throw new Error('actual quoted amount required');
              return {
                decision: 'approved',
                approvedAmountMicrocents: budget.microcents,
                decidedBy: 'test-human',
              };
            },
          }),
        },
      ).then((code) => {
        settled = true;
        return code;
      });
      await paused.promise;
      await firstPrompt.promise;
      if (scenario === 'losing-reject') {
        if (!nativeEngine || !firstGate) throw new Error('actual first gate required');
        const winner = nativeEngine.resume(runId, firstGate.gateId, {
          decision: 'approved',
          approvedAmountMicrocents: firstGate.amount,
          decidedBy: 'competing-human',
        });
        releasePause.release();
        await winner; // Claim and durable approval precede the first card's late rejection.
      }
      firstAnswer.release();
      releasePause.release();
      if (scenario === 'budget-reject') {
        await terminalEntered.promise;
        expect({ open: client.sqlite.open, closes, settled }).toEqual({
          open: true,
          closes: 0,
          settled: false,
        });
        releaseTerminal.release();
        await terminalAck.promise;
        await turn();
        observedPrompts = prompts;
        releaseSurplus.release(); // Bounded baseline cleanup after observing the stale-card bug.
      }
      expect(await execution).toBe(scenario === 'budget-reject' ? 1 : 0);
      expect(closes).toBe(1);
      expect(writerErrors).toBe(0);
      expect(calls).toBe(scenario === 'ordinary-reject' || scenario === 'budget-reject' ? 0 : 2);
      expect(prompts).toBe(scenario === 'budget-reject' ? 1 : 2);
      const inspector = createClient(dbPath);
      try {
        const store = createRunHistoryStore(inspector.db, {
          uuid: randomUUID,
          now: Date.now,
          workflow: { slug: 'queued-gates', name: 'queued', definitionJson: '{}' },
        });
        const events = store.loadRunEventLogForReplay(runId);
        expect(events.at(-1)).toMatchObject(
          scenario === 'budget-reject'
            ? { type: 'run:failed', error: { code: 'budget_exceeded' } }
            : { type: 'run:completed' },
        );
        const authorizations = events.filter(
          (event) =>
            event.type === 'budget:authorization' && event.authorization.state === 'decided',
        );
        expect(authorizations).toHaveLength(
          scenario === 'ordinary-reject' ? 0 : scenario === 'budget-reject' ? 1 : 2,
        );
        if (scenario === 'losing-reject')
          expect(authorizations).toMatchObject([
            { authorization: { decision: 'approved', decidedBy: 'competing-human' } },
            { authorization: { decision: 'approved', decidedBy: 'test-human' } },
          ]);
        expect(await createRunLeasePort(store).read(runId)).toBeUndefined();
        expect(summaries).toHaveLength(1);
        expect(summaries[0]).toContain(
          scenario === 'budget-reject' ? 'run failed' : 'run completed',
        );
        expect(process.listenerCount('SIGINT')).toBe(initialSignals);
        if (scenario === 'budget-reject') expect(observedPrompts).toBe(1);
      } finally {
        inspector.sqlite.close();
      }
    } finally {
      firstAnswer.release();
      releasePause.release();
      releaseSurplus.release();
      releaseTerminal.release();
      if (execution) await execution.catch(() => undefined);
      if (client.sqlite.open) client.sqlite.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
