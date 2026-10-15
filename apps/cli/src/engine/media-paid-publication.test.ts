import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createAgentNodeExecutor,
  createDispatchingNodeExecutor,
  parseWorkflow,
  WorkflowEngine,
  type RunHandle,
} from '@relavium/core';
import {
  createClient,
  createMediaReferenceStore,
  createRunHistoryStore,
  createRunLeasePort,
  mediaObjects,
  mediaReferences,
  runMigrations,
  runCosts,
} from '@relavium/db';
import type { ModelPricing } from '@relavium/llm';
import { createOpenAiAdapter } from '@relavium/llm/adapters';
import { collectDurableMediaHandles, type RunEvent } from '@relavium/shared';
import { expect, it, vi } from 'vitest';
import { createCliHost } from './host.js';

// Each case joins fresh file-backed SQLite migrations, installed synthetic SDK transport,
// actual CAS admission/readback and cleanup within the existing causal-control budget.
vi.setConfig({ testTimeout: 15_000, hookTimeout: 15_000 });

// Independently stated RIFF/WAVE PCM: mono, 8kHz, 16-bit, two sample words.
// Agent workflow requests expose output_modalities, so the actual adapter chooses its WAV default.
const bytes = Uint8Array.from(
  Buffer.from(
    '524946462800000057415645666d74201000000001000100401f0000803e000002001000646174610400000000000100',
    'hex',
  ),
);
const handle = `media://sha256-${createHash('sha256').update(bytes).digest('hex')}`;
const model = 'offline-paid-audio';
// Synthetic rates, not live provider prices: input=2 and output=3 microcents/token.
// Complete native usage below is 2 input + 3 output, independently expected charge 2*2+3*3=13.
const price: ModelPricing = {
  provider: 'openai',
  nativeId: model,
  displayName: model,
  contextWindowTokens: 10000,
  maxOutputTokens: 100,
  inputPerMtokMicrocents: 2000000,
  outputPerMtokMicrocents: 3000000,
  cachedInputPerMtokMicrocents: 2000000,
};
const prices = new Map([[model, price]]);
const workflow = parseWorkflow(
  JSON.stringify({
    schema_version: '1.0',
    workflow: {
      id: 'paid-media-publication',
      agents: [
        {
          id: 'speaker',
          provider: 'openai',
          model,
          system_prompt: 'Offline fixture.',
          max_tokens: 16,
        },
      ],
      nodes: [
        {
          id: 'speak',
          type: 'agent',
          agent_ref: 'speaker',
          prompt_template: 'Speak.',
          output_modalities: ['text', 'audio'],
        },
      ],
      edges: [],
      budget: { max_cost_microcents: 10000, on_exceed: 'fail' },
    },
  }),
);

it.each(['success', 'metadata-conflict', 'retention-fault'] as const)(
  'MEDIA_PAID_PUBLICATION: actual agent SDK receipt survives %s with one charge',
  async (mode) => {
    const root = await mkdtemp(join(tmpdir(), 'relavium-paid-media-'));
    const client = createClient(join(root, 'history.db'));
    let run: RunHandle | undefined;
    try {
      runMigrations(client.db);
      const references = createMediaReferenceStore(client.db);
      if (mode === 'metadata-conflict')
        references.recordObject({
          handle,
          mimeType: 'audio/L16',
          modality: 'audio',
          byteLength: bytes.length,
        });
      const original = client.db.select().from(mediaObjects).all();
      const store = createRunHistoryStore(client.db, {
        uuid: randomUUID,
        now: Date.now,
        projectRoot: root,
        workflow: {
          slug: workflow.workflow.id,
          name: 'Paid media fixture',
          definitionJson: JSON.stringify(workflow),
        },
      });
      const host = createCliHost(store, {
        runLeases: createRunLeasePort(store),
        media: { casRoot: join(root, 'cas'), referenceDb: client.db },
      });
      const append = store.persistEvent.bind(store);
      let mediaAppends = 0;
      let mediaAcknowledged = false;
      store.persistEvent = async (event, context) => {
        const descriptors = collectDurableMediaHandles(event);
        if (descriptors.length > 0) {
          expect(mode, 'MEDIA_PAID_METADATA_BEFORE_APPEND').not.toBe('metadata-conflict');
          expect(descriptors, 'MEDIA_PAID_METADATA_BEFORE_APPEND').toEqual([
            { handle, mimeType: 'audio/wav', modality: 'audio', byteLength: bytes.length },
          ]);
          expect(references.describe(handle), 'MEDIA_PAID_METADATA_BEFORE_APPEND').toMatchObject({
            mimeType: 'audio/wav',
            byteLength: bytes.length,
          });
          expect(await host.mediaStore?.get(handle), 'MEDIA_PAID_METADATA_BEFORE_APPEND').toEqual(
            bytes,
          );
          if (mediaAppends === 0)
            expect(client.db.select().from(mediaReferences).all()).toEqual([]);
          mediaAppends++;
        }
        await append(event, context);
        if (descriptors.length > 0) mediaAcknowledged = true;
      };
      if (host.mediaReferences === undefined) throw new Error('Missing production media port');
      const retain = host.mediaReferences.recordRunMedia.bind(host.mediaReferences);
      const retained = vi
        .spyOn(host.mediaReferences, 'recordRunMedia')
        .mockImplementation((meta, runId) => {
          expect(mediaAcknowledged, 'MEDIA_PAID_RETENTION_AFTER_ACK').toBe(true);
          if (mode === 'retention-fault') throw new Error('Synthetic post-ACK retention fault');
          return retain(meta, runId);
        });
      const fetch = vi.fn<typeof globalThis.fetch>((_url, init) => {
        if (typeof init?.body !== 'string') throw new Error('Expected installed SDK JSON request');
        const wire: unknown = JSON.parse(init.body);
        expect(wire, 'MEDIA_PAID_NATIVE_REQUEST').toMatchObject({
          model,
          modalities: ['text', 'audio'],
          audio: { format: 'wav' },
        });
        return Promise.resolve(
          new Response(
            JSON.stringify({
              id: 'offline-paid-response',
              model,
              choices: [
                {
                  index: 0,
                  finish_reason: 'stop',
                  message: {
                    role: 'assistant',
                    content: null,
                    audio: { data: Buffer.from(bytes).toString('base64'), transcript: 'Fixture.' },
                  },
                },
              ],
              usage: {
                prompt_tokens: 2,
                completion_tokens: 3,
                total_tokens: 5,
                prompt_tokens_details: { cached_tokens: 0, audio_tokens: 0 },
                completion_tokens_details: {
                  reasoning_tokens: 0,
                  audio_tokens: 3,
                  accepted_prediction_tokens: 0,
                  rejected_prediction_tokens: 0,
                },
              },
            }),
            { headers: { 'content-type': 'application/json' } },
          ),
        );
      });
      const provider = createOpenAiAdapter({ fetch });
      const executor = createDispatchingNodeExecutor({
        agent: createAgentNodeExecutor({
          resolveProvider: () => provider,
          keyFor: () => 'synthetic-offline-key',
          sleep: () => Promise.resolve(),
          resolvePrice: prices,
          tools: [],
          registry: {
            has: () => false,
            list: () => [],
            dispatch: () => Promise.reject(new Error('Unexpected tool')),
          },
          newAbortController: host.newAbortController,
          setTimer: host.setTimer,
        }),
      });
      run = new WorkflowEngine({ host, executor, resolvePrice: prices }).start({ workflow });
      const live: RunEvent[] = [];
      for await (const event of run.events) live.push(event);
      expect(await run.depart(), 'MEDIA_PAID_DURABLE_RECEIPT').toMatchObject({
        kind: 'closed',
        moneyDurability: 'durable',
      });
      const rows = store.loadRunEventLogForReplay(run.runId);
      expect(fetch, 'MEDIA_PAID_ONE_NATIVE_CALL').toHaveBeenCalledTimes(1);
      expect(
        rows.filter((event) => event.type === 'node:retrying'),
        'MEDIA_PAID_ONE_NATIVE_CALL',
      ).toEqual([]);
      expect(
        rows.filter((event) => event.type === 'cost:attempt_settled'),
        'MEDIA_PAID_DURABLE_RECEIPT',
      ).toMatchObject([
        {
          nodeId: 'speak',
          model,
          attemptNumber: 1,
          inputTokens: 2,
          outputTokens: 3,
          costMicrocents: 13,
          cumulativeCostMicrocents: 13,
          // Native audio count units have no per-count rate in the existing pricing model.
          // The independently known token charge is preserved; no full audio-price claim.
          priced: false,
        },
      ]);
      // Existing unpriced-audio coverage reserves an estimate separately from realized token money.
      expect(rows.filter((event) => event.type === 'budget:estimate_committed')).toMatchObject([
        { cumulativeCostMicrocents: 13, cumulativeUnpricedCalls: 1 },
      ]);
      const terminals = rows.filter((event) =>
        ['run:completed', 'run:failed', 'run:cancelled'].includes(event.type),
      );
      expect(terminals, 'MEDIA_PAID_SINGLE_TERMINAL').toHaveLength(1);
      expect(terminals[0], 'MEDIA_PAID_PRESERVED_CHARGE').toMatchObject({
        type: mode === 'metadata-conflict' ? 'run:failed' : 'run:completed',
        cumulativeCostMicrocents: 13,
        cumulativeUnpricedCalls: 1,
        usageCoverage: { unverified: false, pendingInvocations: 0, unknownCalls: 0 },
      });
      expect(live.at(-1)).toEqual(terminals[0]);
      expect(store.loadRun(run.runId)?.totalCostMicrocents, 'MEDIA_PAID_PRESERVED_CHARGE').toBe(13);
      const costRows = client.db.select().from(runCosts).all();
      expect(
        costRows.filter((row) => row.costMicrocents !== 0),
        'MEDIA_PAID_SINGLE_COST_ROW',
      ).toMatchObject([{ runId: run.runId, costMicrocents: 13 }]);
      expect(
        costRows.reduce((sum, row) => sum + row.costMicrocents, 0),
        'MEDIA_PAID_PRESERVED_CHARGE',
      ).toBe(13);
      expect(references.describe(handle)?.allowedScopes, 'MEDIA_PAID_NO_AUTH').toEqual([]);
      expect(client.db.select().from(mediaReferences).all(), 'MEDIA_PAID_NO_AUTH').toEqual([]);
      if (mode === 'metadata-conflict') {
        expect(mediaAppends, 'MEDIA_PAID_CONFLICT_NO_PUBLICATION').toBe(0);
        expect(
          rows.some((event) => collectDurableMediaHandles(event).length > 0),
          'MEDIA_PAID_CONFLICT_NO_PUBLICATION',
        ).toBe(false);
        expect(rows.some((event) => event.type === 'node:completed')).toBe(false);
        expect(retained).not.toHaveBeenCalled();
        expect(client.db.select().from(mediaObjects).all()).toEqual(original);
      } else {
        expect(mediaAppends, 'MEDIA_PAID_METADATA_BEFORE_APPEND').toBeGreaterThan(0);
        expect(retained, 'MEDIA_PAID_RETENTION_AFTER_ACK').toHaveBeenCalled();
      }
    } finally {
      run?.cancel();
      await run?.depart();
      client.sqlite.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
