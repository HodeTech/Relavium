import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as turn } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { reconstructCheckpointState, type WorkflowEngine, type RunStore } from '@relavium/core';
import {
  createClient,
  createRunHistoryStore,
  createRunLeasePort,
  runMigrations,
} from '@relavium/db';
import type { LlmProvider, ModelPricing } from '@relavium/llm';
import { buildEngine } from '../engine/build-engine.js';
import { runCommand } from './run.js';
import { captureIo, CHAT_TEXT_CAPABILITY_FLAGS } from '../test-support.js';
function latch() {
  let release = () => {};
  const promise = new Promise<void>((done) => {
    release = done;
  });
  return { promise, release };
}
const model = 'round2-native-control';
const price: ModelPricing = {
  provider: 'openai',
  nativeId: model,
  displayName: model,
  contextWindowTokens: 50000,
  maxOutputTokens: 1000,
  inputPerMtokMicrocents: 1000000,
  outputPerMtokMicrocents: 1000000,
  cachedInputPerMtokMicrocents: 1000000,
};
for (const mode of [
  'invalid',
  'stale',
  'invalid-cancel',
  'stale-cancel',
  'approve',
  'reject',
  'ordinary',
] as const) {
  it(`native budget command retains pause and cancellation authority: ${mode}`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'contracts-native-r2-'));
    const dbPath = join(root, 'history.db');
    const db = createClient(dbPath);
    runMigrations(db.db, { dbPath });
    const prices = new Map([[model, price]]);
    const hold = latch(),
      entered = latch(),
      refused = latch(),
      terminalEntered = latch(),
      terminalRelease = latch();
    const observed: string[] = [];
    let engine: WorkflowEngine | undefined;
    let runId = '';
    let prompts = 0,
      calls = 0,
      closed = 0,
      lateWrites = 0;
    let settled = false;
    const isRefusal = mode.startsWith('invalid') || mode.startsWith('stale');
    const cancels = mode.endsWith('cancel');
    const provider: LlmProvider = {
      id: 'openai',
      customEndpoint: true,
      supports: CHAT_TEXT_CAPABILITY_FLAGS,
      generate: () => Promise.reject(new Error('unused')),
      stream: async function* () {
        calls++;
        await Promise.resolve();
        yield { type: 'text_delta', text: 'independent output' };
        yield { type: 'stop', stopReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    const nodes =
      mode === 'ordinary'
        ? [{ id: 'human', type: 'human_gate', gate_type: 'approval' }]
        : [
            { id: 'first', type: 'agent', agent_ref: 'a', prompt_template: 'one', max_tokens: 32 },
            ...(isRefusal
              ? [
                  {
                    id: 'second',
                    type: 'agent',
                    agent_ref: 'a',
                    prompt_template: 'two',
                    max_tokens: 32,
                  },
                ]
              : []),
          ];
    writeFileSync(
      join(root, 'test.relavium.yaml'),
      JSON.stringify({
        schema_version: '1.0',
        workflow: {
          id: 'round2-native',
          budget: {
            max_cost_microcents: 1,
            on_exceed: 'pause_for_approval',
            strict_cost_cap: true,
          },
          agents: [{ id: 'a', provider: 'openai', model, system_prompt: 's' }],
          nodes,
          edges: [],
        },
      }),
    );
    const capture = captureIo();
    const signalBefore = process.listenerCount('SIGINT');
    try {
      const execution = runCommand(
        { workflow: 'test.relavium.yaml', input: [], allowMcpStdio: [] },
        {
          io: {
            ...capture.io,
            writeErr: (s) => {
              capture.io.writeErr(s);
              if (s.includes('remains pending')) refused.release();
            },
          },
          global: {
            cwd: root,
            json: false,
            color: false,
            configPath: undefined,
            verbosity: 'normal',
          },
          providers: {
            resolveProvider: () => provider,
            keyFor: () => 'synthetic',
            endpointKind: () => 'custom',
          },
          openRunStore: (workflow) => {
            const store = createRunHistoryStore(db.db, {
              uuid: randomUUID,
              now: Date.now,
              projectRoot: root,
              workflow: {
                slug: workflow.workflow.id,
                name: 'r2',
                definitionJson: JSON.stringify(workflow),
              },
            });
            return {
              db: db.db,
              store,
              terminalOutboxPath: join(root, 'outbox'),
              close: () => {
                closed++;
                observed.push('close');
                db.sqlite.close();
              },
            };
          },
          buildEngine: async (options) => {
            if (!options?.host) throw new Error('missing actual host');
            const host = options.host;
            const store: RunStore = {
              ...host.store,
              persistEvent: async (event, context) => {
                if (event.type === 'run:started') runId = event.runId;
                if (event.type === 'run:paused') {
                  observed.push('pause-enter');
                  entered.release();
                  await hold.promise;
                }
                if (cancels && event.type === 'run:cancelled') {
                  terminalEntered.release();
                  await terminalRelease.promise;
                }
                try {
                  await host.store.persistEvent(event, context);
                  observed.push(event.type);
                } catch (error) {
                  lateWrites++;
                  throw error;
                }
              },
            };
            engine = await buildEngine({
              ...options,
              resolvePrice: prices,
              host: { ...host, store },
            });
            return engine;
          },
          selectGatePrompter: () => ({
            prompt: (_event, budget) => {
              prompts++;
              if (isRefusal) {
                if (mode.startsWith('stale'))
                  prices.set(model, { ...price, outputPerMtokMicrocents: 3000000 });
                return Promise.resolve({
                  decision: 'approved',
                  decidedBy: 'r2',
                  ...(mode.startsWith('stale') && budget?.kind === 'amount'
                    ? { approvedAmountMicrocents: budget.microcents }
                    : {}),
                });
              }
              return Promise.resolve({
                decision: mode === 'reject' ? 'rejected' : 'approved',
                decidedBy: 'r2',
                ...(mode !== 'reject' && budget?.kind === 'amount'
                  ? { approvedAmountMicrocents: budget.microcents }
                  : {}),
              });
            },
          }),
        },
      ).then((code) => {
        settled = true;
        return code;
      });
      if (isRefusal) {
        await refused.promise;
        await entered.promise;
        await turn();
        expect({ settled, open: db.sqlite.open, closed, prompts }).toEqual({
          settled: false,
          open: true,
          closed: 0,
          prompts: 1,
        });
        expect(process.listenerCount('SIGINT')).toBe(signalBefore + 1);
        if (cancels) {
          if (!engine) throw new Error('no engine');
          process.emit('SIGINT');
          await turn();
        }
      } else {
        hold.release();
      }
      hold.release();
      if (cancels) {
        // An already acknowledged pause must not outrank the requested cancellation.
        // Race against command settlement so the old premature exit fails without a timing guess.
        await Promise.race([terminalEntered.promise, execution]);
        expect({ settled, open: db.sqlite.open, closed }).toEqual({
          settled: false,
          open: true,
          closed: 0,
        });
        terminalRelease.release();
      }
      const code = await execution;
      await turn();
      await turn();
      const inspect = createClient(dbPath);
      try {
        const store = createRunHistoryStore(inspect.db, {
          uuid: randomUUID,
          now: Date.now,
          workflow: { slug: 'round2-native', name: 'r2', definitionJson: '{}' },
        });
        const events = store.loadRunEventLogForReplay(runId);
        const cp = reconstructCheckpointState(events);
        expect(lateWrites).toBe(0);
        expect(closed).toBe(1);
        expect(await createRunLeasePort(store).read(runId)).toBeUndefined();
        expect(process.listenerCount('SIGINT')).toBe(signalBefore);
        expect(
          events.every(
            (e, i) => i === 0 || e.sequenceNumber > (events[i - 1]?.sequenceNumber ?? -1),
          ),
        ).toBe(true);
        if (cancels) {
          expect(code).toBe(1);
          expect(events.at(-1)?.type).toBe('run:cancelled');
          expect(observed.indexOf('close')).toBeGreaterThan(observed.indexOf('run:cancelled'));
          expect(calls).toBe(0);
        } else if (isRefusal) {
          expect(code).toBe(3);
          expect(events.at(-1)?.type).toBe('run:paused');
          expect(cp?.pendingGates).toHaveLength(2);
          expect(prompts).toBe(1);
          expect(calls).toBe(0);
        } else {
          expect(code).toBe(mode === 'reject' ? 1 : 0);
          expect(events.at(-1)?.type).toBe(mode === 'reject' ? 'run:failed' : 'run:completed');
          expect(calls).toBe(mode === 'approve' ? 1 : 0);
        }
        if (isRefusal)
          expect(observed.indexOf('close')).toBeGreaterThan(observed.indexOf('run:paused'));
      } finally {
        inspect.sqlite.close();
      }
    } finally {
      hold.release();
      terminalRelease.release();
      if (db.sqlite.open) db.sqlite.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
}
