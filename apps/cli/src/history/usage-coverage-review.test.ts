import {
  createAgentNodeExecutor,
  createInMemoryHost,
  parseWorkflow,
  WorkflowEngine,
} from '@relavium/core';
import {
  createClient,
  InMemoryMediaStore,
  createRunHistoryStore,
  createRunHistoryReader,
  createRunLeasePort,
  createSessionStore,
  runEvents,
  runMigrations,
  UnreadableRunEventLogError,
} from '@relavium/db';
import type { LlmProvider, ModelPricing } from '@relavium/llm';
import type { RunEvent } from '@relavium/shared';
import { describe, expect, it } from 'vitest';

import { statusCommand } from '../commands/status.js';
import { createHistoryCheckpointer } from '../engine/checkpointer.js';
import { buildHomeSnapshot } from '../home/home-store.js';
import { formatCostShort } from '../render/tui/format.js';
import { captureIo, parseNdjson } from '../test-support.js';
import { readRunUsageCoverage } from './usage-coverage.js';

// Complete independent 1x1 RGB PNG: IHDR, zlib-compressed red pixel IDAT, IEND and CRCs.
const PNG_BYTES = Uint8Array.from(
  Buffer.from(
    '89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de0000000c49444154789c63f8cfc0000003010100c9fe92ef0000000049454e44ae426082',
    'hex',
  ),
);

const timestamp = '2026-10-10T00:00:00.000Z';
function deferred() {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('W8 review: actual persisted usage projections', () => {
  it.each([
    { imageRate: undefined, formatted: '$0.0000 known; price unknown for 1 call' },
    { imageRate: 0, formatted: 'free' },
    { imageRate: 120_000, formatted: '$0.0012' },
  ])(
    'preserves native media step coverage with image rate $imageRate through durable readers',
    async ({ imageRate, formatted }) => {
      const priced = imageRate !== undefined;
      const expectedCostMicrocents = imageRate ?? 0;
      const client = createClient();
      const releaseTerminal = deferred();
      const terminalEntered = deferred();
      let drained: Promise<void> | undefined;
      try {
        runMigrations(client.db);
        const model = 'offline-native-image';
        const workflow = parseWorkflow(
          JSON.stringify({
            schema_version: '1.0',
            workflow: {
              id: 'native-image-coverage',
              agents: [{ id: 'a', provider: 'openai', model, system_prompt: 'offline' }],
              nodes: [
                {
                  id: 'image',
                  type: 'agent',
                  agent_ref: 'a',
                  prompt_template: 'offline image',
                  output_modalities: ['image'],
                  count: 1,
                },
              ],
              edges: [],
            },
          }),
        );
        let sequence = 0;
        const store = createRunHistoryStore(client.db, {
          uuid: () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`,
          now: () => Date.parse(timestamp),
          workflow: {
            slug: workflow.workflow.id,
            name: workflow.workflow.id,
            definitionJson: JSON.stringify(workflow),
          },
        });
        const mediaStore = new InMemoryMediaStore();
        const imageHandle = await mediaStore.put(PNG_BYTES, 'image/png');
        const base = createInMemoryHost({
          store,
          runLeases: createRunLeasePort(store),
          mediaStore,
        });
        const host = {
          ...base,
          store: {
            ...store,
            persistEvent: async (...args: Parameters<typeof store.persistEvent>) => {
              if (args[0].type === 'run:completed' || args[0].type === 'run:failed') {
                terminalEntered.resolve();
                await releaseTerminal.promise;
              }
              await store.persistEvent(...args);
            },
          },
        };
        let calls = 0;
        const provider: LlmProvider = {
          id: 'openai',
          supports: {
            tools: false,
            streaming: false,
            parallelToolCalls: false,
            vision: false,
            promptCache: false,
            reasoning: false,
            media: {
              input: { image: false, audio: false, video: false, document: false },
              outputCombinations: [['image']],
              surface: 'generative',
            },
          },
          generate: () => Promise.reject(new Error('text path forbidden')),
          stream: () => {
            throw new Error('text stream forbidden');
          },
          generateMedia: (request) => {
            calls += 1;
            expect(request.count).toBe(1);
            return Promise.resolve({
              media: {
                type: 'media',
                mimeType: 'image/png',
                source: { kind: 'handle', ref: imageHandle },
              },
              raw: undefined,
            });
          },
        };
        const price: ModelPricing = {
          provider: 'openai',
          nativeId: model,
          displayName: model,
          contextWindowTokens: 10000,
          maxOutputTokens: 1000,
          inputPerMtokMicrocents: 0,
          outputPerMtokMicrocents: 0,
          cachedInputPerMtokMicrocents: 0,
          ...(imageRate === undefined ? {} : { mediaOutputRates: { image: imageRate } }),
        };
        const resolvePrice = new Map([[model, price]]);
        const executor = createAgentNodeExecutor({
          resolveProvider: () => provider,
          resolveMediaSurface: () => 'generative',
          resolvePrice,
          registry: {
            has: () => false,
            list: () => [],
            dispatch: () => Promise.reject(new Error('tool path forbidden')),
          },
          tools: [],
          keyFor: () => 'offline-fixture',
          sleep: () => Promise.resolve(),
          newAbortController: host.newAbortController,
          setTimer: host.setTimer,
        });
        const engine = new WorkflowEngine({ host, executor, resolvePrice });
        const handle = engine.start({ workflow });
        const publicEvents: RunEvent[] = [];
        drained = (async () => {
          for await (const event of handle.events) publicEvents.push(event);
        })();
        await terminalEntered.promise;
        expect(calls).toBe(1);
        const durable = store.loadRunEventLogForReplay(handle.runId);
        expect(durable.some((event) => event.type === 'node:completed')).toBe(true);
        expect(durable.some((event) => event.type === 'cost:usage_pending')).toBe(false);
        expect(durable.some((event) => event.type === 'cost:usage_disposition')).toBe(false);
        expect(durable.some((event) => event.type === 'cost:attempt_settled')).toBe(false);
        const usage = readRunUsageCoverage(store, handle.runId);
        expect(usage).toMatchObject({
          totalCostMicrocents: expectedCostMicrocents,
          unpricedCalls: priced ? 0 : 1,
          usageCoverage: { unverified: false, pendingInvocations: 0, unknownCalls: 0 },
        });
        expect(
          formatCostShort(usage.totalCostMicrocents, usage.usageCoverage, usage.unpricedCalls),
        ).toBe(formatted);
        const home = buildHomeSnapshot({
          sessions: createSessionStore(client.db),
          runs: createRunHistoryReader(client.db),
        });
        expect(home.recentRuns).toContainEqual(
          expect.objectContaining({
            runId: handle.runId,
            totalCostMicrocents: expectedCostMicrocents,
            unpricedCalls: priced ? 0 : 1,
            usageCoverage: usage.usageCoverage,
          }),
        );
        const { io, out } = captureIo();
        expect(
          await statusCommand({
            io,
            global: {
              json: true,
              color: false,
              cwd: process.cwd(),
              configPath: undefined,
              verbosity: 'normal',
            },
            openDb: () => ({ db: client.db, close: () => {} }),
            readTerminalOutbox: () => Promise.resolve([]),
          }),
        ).toBe(0);
        expect(parseNdjson(out())).toContainEqual(
          expect.objectContaining({
            runId: handle.runId,
            totalCostMicrocents: expectedCostMicrocents,
            unpricedCalls: priced ? 0 : 1,
            usageCoverage: usage.usageCoverage,
            steps: [
              expect.objectContaining({
                nodeId: 'image',
                status: 'completed',
                costMicrocents: expectedCostMicrocents,
                usageCoverage: usage.usageCoverage,
              }),
            ],
          }),
        );
        expect(usage.nodes.get('image')).toEqual(usage.usageCoverage);
        releaseTerminal.resolve();
        await drained;
        expect(await handle.depart()).toMatchObject({ kind: 'closed', moneyDurability: 'durable' });
        expect(publicEvents.filter((event) => event.type === 'cost:updated')).toMatchObject([
          { inputTokens: 0, outputTokens: 0, costMicrocents: expectedCostMicrocents },
        ]);
        const finalUsage = readRunUsageCoverage(store, handle.runId);
        expect(finalUsage.unpricedCalls).toBe(priced ? 0 : 1);
      } finally {
        releaseTerminal.resolve();
        await drained;
        client.sqlite.close();
      }
    },
  );

  it('uses max(snapshot, ledger) across an ahead-of-ledger unpriced snapshot and refuses future replay', async () => {
    const client = createClient();
    try {
      runMigrations(client.db);
      let id = 0;
      const store = createRunHistoryStore(client.db, {
        uuid: () => `00000000-0000-4000-8000-${String(++id).padStart(12, '0')}`,
        now: () => 1,
        workflow: { slug: 'queued-ledger', name: 'queued-ledger', definitionJson: '{}' },
      });
      const workflowId = await store.resolveWorkflowId('queued-ledger');
      await store.persistEvent({
        type: 'run:started',
        runId: 'r',
        workflowId,
        inputs: {},
        executionMode: 'local',
        timestamp,
        sequenceNumber: 0,
      });
      await store.persistEvent({
        type: 'cost:coverage_started',
        runId: 'r',
        basis: 'complete',
        timestamp,
        sequenceNumber: 1,
      });
      await store.persistEvent({
        type: 'node:started',
        runId: 'r',
        nodeId: 'n',
        nodeType: 'agent',
        timestamp,
        sequenceNumber: 2,
        cumulativeUnpricedCalls: 2,
      });
      expect(readRunUsageCoverage(store, 'r').unpricedCalls).toBe(2);
      for (let seq = 3; seq < 5; seq += 1) {
        await store.persistEvent({
          type: 'cost:attempt_settled',
          attemptNumber: seq - 2,
          runId: 'r',
          nodeId: 'n',
          model: 'm',
          timestamp,
          sequenceNumber: seq,
          inputTokens: 0,
          outputTokens: 0,
          costMicrocents: 0,
          cumulativeCostMicrocents: 0,
          priced: false,
          cumulativeUnpricedCalls: 2,
        });
        expect(readRunUsageCoverage(store, 'r').unpricedCalls).toBe(2);
      }
      client.db
        .insert(runEvents)
        .values({
          id: 'future',
          runId: 'r',
          seq: 5,
          eventType: 'future:usage',
          payloadJson: JSON.stringify({
            type: 'future:usage',
            runId: 'r',
            sequenceNumber: 5,
            timestamp,
          }),
          ts: 1,
        })
        .run();
      expect(() => readRunUsageCoverage(store, 'r')).toThrow(UnreadableRunEventLogError);
      await expect(createHistoryCheckpointer(store).load('r')).rejects.toThrow(
        UnreadableRunEventLogError,
      );
    } finally {
      client.sqlite.close();
    }
  });
});
