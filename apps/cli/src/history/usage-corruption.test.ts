import { randomUUID } from 'node:crypto';
import {
  createClient,
  createRunHistoryReader,
  createRunHistoryStore,
  createSessionStore,
  runMigrations,
} from '@relavium/db';
import { isCorruptRunEventError, RunEventSchema } from '@relavium/shared';
import { describe, expect, it } from 'vitest';
import { statusCommand } from '../commands/status.js';
import { createHistoryCheckpointer } from '../engine/checkpointer.js';
import { buildHomeSnapshot } from '../home/home-store.js';
import { captureIo, parseNdjson } from '../test-support.js';
import { readRunUsageCoverage } from './usage-coverage.js';
const timestamp = '2026-10-11T00:00:00.000Z';

describe('schema-valid semantic usage corruption stays isolated to its run', () => {
  it.each(['duplicate basis', 'repeated ordinal', 'decreased ordinal'] as const)(
    '%s preserves healthy Home/status neighbors and refuses strict checkpoints',
    async (kind) => {
      const client = createClient();
      try {
        runMigrations(client.db);
        const store = createRunHistoryStore(client.db, {
          uuid: randomUUID,
          now: () => 1,
          workflow: {
            slug: 'coverage-corruption',
            name: 'coverage-corruption',
            definitionJson: '{}',
          },
        });
        const workflowId = await store.resolveWorkflowId('coverage-corruption');
        for (const runId of ['healthy', 'damaged']) {
          await store.persistEvent({
            type: 'run:started',
            runId,
            workflowId,
            inputs: {},
            executionMode: 'local',
            sequenceNumber: 0,
            timestamp,
          });
          await store.persistEvent({
            type: 'cost:coverage_started',
            runId,
            basis: 'complete',
            sequenceNumber: 1,
            timestamp,
          });
        }
        const reader = createRunHistoryReader(client.db);
        const sessions = createSessionStore(client.db);
        const invokeStatus = async (json: boolean) => {
          const { io, out, err } = captureIo();
          const exit = await statusCommand({
            io,
            global: {
              json,
              color: false,
              cwd: process.cwd(),
              configPath: undefined,
              verbosity: 'normal',
            },
            openDb: () => ({ db: client.db, close: () => {} }),
            readTerminalOutbox: () => Promise.resolve([]),
          });
          return { exit, out: out(), err: err() };
        };
        const baseline = buildHomeSnapshot({ sessions, runs: reader });
        expect(baseline.recentRuns.map((run) => run.runId)).toEqual(
          expect.arrayContaining(['healthy', 'damaged']),
        );
        expect(baseline.unreadableRunIds).toEqual([]);
        const baselineStatus = await invokeStatus(true);
        expect(baselineStatus.exit).toBe(0);
        expect(parseNdjson(baselineStatus.out)).toHaveLength(2);
        expect(await createHistoryCheckpointer(store).load('healthy')).toMatchObject({
          workflowId,
          usageCoverage: {
            coverage: { unverified: false, pendingInvocations: 0, unknownCalls: 0 },
          },
        });
        const envelope = { runId: 'damaged', timestamp };
        if (kind === 'duplicate basis') {
          await store.persistEvent(
            RunEventSchema.parse({
              ...envelope,
              sequenceNumber: 2,
              type: 'cost:coverage_started',
              basis: 'complete',
            }),
          );
        } else {
          const pending = {
            ...envelope,
            type: 'cost:usage_pending',
            nodeId: 'n',
            model: 'm',
            invocation: { producerId: 'p', ordinal: 2, dispatchId: 'd', round: 0, chainAttempt: 1 },
          };
          await store.persistEvent(RunEventSchema.parse({ ...pending, sequenceNumber: 2 }));
          await store.persistEvent(
            RunEventSchema.parse({
              ...pending,
              sequenceNumber: 3,
              invocation: { ...pending.invocation, ordinal: kind === 'repeated ordinal' ? 2 : 1 },
            }),
          );
        }
        const expectedError = {
          code: 'corrupt_run_event',
          runId: 'damaged',
          sequenceNumber: kind === 'duplicate basis' ? 2 : 3,
          eventType: kind === 'duplicate basis' ? 'cost:coverage_started' : 'cost:usage_pending',
        };
        // Each stored row is individually valid. The strict reconstruction interprets their sequence.
        const originalRows = store.loadRunEventLogForReplay('damaged');
        expect(originalRows.every((event) => RunEventSchema.safeParse(event).success)).toBe(true);
        let corruption: unknown;
        try {
          readRunUsageCoverage(reader, 'damaged');
        } catch (error) {
          corruption = error;
        }
        expect(isCorruptRunEventError(corruption)).toBe(true);
        expect(corruption).toMatchObject(expectedError);
        await expect(createHistoryCheckpointer(store).load('damaged')).rejects.toMatchObject(
          expectedError,
        );
        const home = buildHomeSnapshot({ sessions, runs: reader });
        expect(home.recentRuns.map((run) => run.runId)).toEqual(['healthy']);
        expect(home.recentRuns[0]?.usageCoverage).toEqual({
          unverified: false,
          pendingInvocations: 0,
          unknownCalls: 0,
        });
        expect(home.unreadableRunIds).toEqual(['damaged']);
        expect(home.isEmpty).toBe(false);
        const json = await invokeStatus(true);
        expect(json.exit).toBe(0);
        expect(json.err).toBe('');
        const records = parseNdjson(json.out);
        expect(records).toHaveLength(2);
        expect(records).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              runId: 'healthy',
              totalCostMicrocents: 0,
              usageCoverage: { unverified: false, pendingInvocations: 0, unknownCalls: 0 },
            }),
            expect.objectContaining({
              runId: 'damaged',
              totalCostMicrocents: 0,
              usageUnavailable: true,
              usageUnavailableReason: 'unreadable_event_log',
              usageCoverage: { unverified: true, pendingInvocations: 0, unknownCalls: 0 },
            }),
          ]),
        );
        const human = await invokeStatus(false);
        expect(human.exit).toBe(0);
        expect(human.err).toBe('');
        expect(human.out).toContain('healthy');
        expect(human.out).toContain('damaged');
        expect(human.out).toContain('usage coverage unavailable');
        expect(store.loadRunEventLogForReplay('damaged')).toEqual(originalRows);
        expect(await createHistoryCheckpointer(store).load('healthy')).toMatchObject({
          workflowId,
          usageCoverage: {
            coverage: { unverified: false, pendingInvocations: 0, unknownCalls: 0 },
          },
        });
      } finally {
        client.sqlite.close();
      }
    },
  );
});
