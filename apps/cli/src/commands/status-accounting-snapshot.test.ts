import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createClient, createRunHistoryStore, runMigrations } from '@relavium/db';
import type { RunEvent } from '@relavium/shared';
import { describe, expect, it, vi } from 'vitest';

import { readRunUsageCoverage } from '../history/usage-coverage.js';
import { captureIo, parseNdjson } from '../test-support.js';
import { statusCommand } from './status.js';

describe('status accounting snapshot', () => {
  it.each(['before-status', 'before-step-select'] as const)(
    'keeps step state, amount and coverage together when another writer commits %s',
    async (schedule) => {
      const directory = mkdtempSync(join(tmpdir(), 'relavium-status-accounting-'));
      const client = createClient(join(directory, 'history.db'));
      const writer = createClient(client.path);
      try {
        runMigrations(client.db, { dbPath: client.path });
        let id = 0;
        const producer = createRunHistoryStore(writer.db, {
          uuid: () => `00000000-0000-4000-8000-${String(++id).padStart(12, '0')}`,
          now: () => 1,
          workflow: { slug: 'w', name: 'w', definitionJson: '{}' },
        });
        const workflowId = await producer.resolveWorkflowId('w');
        const envelope = {
          runId: 'r',
          timestamp: '2026-10-11T00:00:00.000Z',
          sequenceNumber: 0,
        };
        let sequenceNumber = 0;
        const put = (event: RunEvent): Promise<void> =>
          producer.persistEvent({ ...event, sequenceNumber: sequenceNumber++ });
        const invocation = {
          producerId: 'p',
          ordinal: 1,
          dispatchId: 'd',
          round: 0,
          chainAttempt: 1,
        };
        await put({
          ...envelope,
          type: 'run:started',
          workflowId,
          inputs: {},
          executionMode: 'local',
        });
        await put({ ...envelope, type: 'cost:coverage_started', basis: 'complete' });
        await put({ ...envelope, type: 'node:started', nodeId: 'n', nodeType: 'agent' });
        await put({ ...envelope, type: 'cost:usage_pending', nodeId: 'n', model: 'm', invocation });
        await put({
          ...envelope,
          type: 'cost:attempt_settled',
          nodeId: 'n',
          model: 'm',
          invocation,
          attemptNumber: 1,
          inputTokens: 0,
          outputTokens: 0,
          costMicrocents: 0,
          cumulativeCostMicrocents: 0,
          priced: true,
        });
        const commitLaterPrefix = (): Promise<void>[] => [
          put({
            ...envelope,
            type: 'cost:usage_pending',
            nodeId: 'n',
            model: 'm',
            invocation: { ...invocation, ordinal: 2, round: 1 },
          }),
          put({
            ...envelope,
            type: 'cost:attempt_settled',
            nodeId: 'n',
            model: 'm',
            invocation: { ...invocation, ordinal: 2, round: 1 },
            attemptNumber: 1,
            inputTokens: 10,
            outputTokens: 5,
            costMicrocents: 70_000,
            cumulativeCostMicrocents: 70_000,
            priced: true,
          }),
          put({
            ...envelope,
            type: 'cost:usage_pending',
            nodeId: 'n',
            model: 'm',
            invocation: { ...invocation, ordinal: 3, round: 2 },
          }),
          put({
            ...envelope,
            type: 'cost:usage_disposition',
            nodeId: 'n',
            model: 'm',
            invocation: { ...invocation, ordinal: 3, round: 2 },
            disposition: {
              kind: 'incomplete',
              evidence: { kind: 'missing', reason: 'not_reported' },
            },
          }),
          put({
            ...envelope,
            type: 'node:completed',
            nodeId: 'n',
            output: 'ok',
            durationMs: 1,
            cumulativeCostMicrocents: 70_000,
            tokensUsed: { input: 10, output: 5 },
          }),
        ];
        let injected = false;
        let writes: Promise<void>[] = [];
        if (schedule === 'before-status') await Promise.all(commitLaterPrefix());
        const prepare = client.sqlite.prepare.bind(client.sqlite);
        vi.spyOn(client.sqlite, 'prepare').mockImplementation((query) => {
          if (
            schedule === 'before-step-select' &&
            !injected &&
            /select.*from "step_executions"/i.test(query)
          ) {
            injected = true;
            writes = commitLaterPrefix();
            // Production persistEvent commits synchronously before its async acknowledgement.
            expect(producer.loadRun('r')?.totalCostMicrocents).toBe(70_000);
          }
          return prepare(query);
        });
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
        await Promise.all(writes);
        const after = schedule === 'before-status';
        expect(injected).toBe(!after);
        expect(parseNdjson(out())).toEqual([
          expect.objectContaining({
            runId: 'r',
            totalCostMicrocents: after ? 70_000 : 0,
            usageCoverage: {
              unverified: false,
              pendingInvocations: 0,
              unknownCalls: after ? 1 : 0,
            },
            steps: [
              expect.objectContaining({
                nodeId: 'n',
                status: after ? 'completed' : 'running',
                costMicrocents: after ? 70_000 : 0,
                usageCoverage: {
                  unverified: false,
                  pendingInvocations: 0,
                  unknownCalls: after ? 1 : 0,
                },
              }),
            ],
          }),
        ]);
        expect(producer.loadRun('r')?.totalCostMicrocents).toBe(70_000);
        expect(readRunUsageCoverage(producer, 'r').nodes.get('n')).toEqual({
          unverified: false,
          pendingInvocations: 0,
          unknownCalls: 1,
        });
      } finally {
        vi.restoreAllMocks();
        writer.sqlite.close();
        client.sqlite.close();
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );
});
