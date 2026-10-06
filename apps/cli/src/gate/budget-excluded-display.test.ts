import { reconstructCheckpointState } from '@relavium/core';
import { createClient, createRunHistoryStore, runMigrations } from '@relavium/db';
import {
  BudgetAllowanceStateSchema,
  RunEventSchema,
  type BudgetAllowanceState,
  type HumanGatePausedEvent,
  type RunEvent,
} from '@relavium/shared';
import { describe, expect, it, vi } from 'vitest';

import { statusCommand } from '../commands/status.js';
import { createPlainRenderer } from '../render/renderer.js';
import { initialRunViewState, reduceRunEvent } from '../render/tui/run-view-model.js';
import { captureIo, parseNdjson, seedRun } from '../test-support.js';
import { budgetPromptContext, budgetPromptDetails, selectBudgetGate } from './budget.js';
import { createClackGatePrompter } from './clack-prompter.js';

const syntheticSecret = `sk-proj-${'a'.repeat(32)}`;
const excludedEntries = [
  {
    index: 1,
    provider: 'openai',
    endpoint: 'custom',
    model: 'model"\nApprove 999\u001b[2J\u202e',
    reason: 'unsupported',
  },
  {
    index: 2,
    provider: 'deepseek',
    endpoint: 'official',
    model: `${'x'.repeat(180)}PRIVATE_TAIL`,
    reason: 'unpriced_model',
  },
  {
    index: 3,
    provider: 'anthropic',
    endpoint: 'official',
    model: syntheticSecret,
    reason: 'unpriced_modality',
  },
];

function allowance(kind: number | 'unrepresentable' | 'unpriced' = 20): BudgetAllowanceState {
  return BudgetAllowanceStateSchema.parse({
    kind: 'frozen',
    quote:
      kind === 'unpriced'
        ? { kind, excludedEntries }
        : {
            kind: 'quoted',
            quote: {
              amount:
                typeof kind === 'number' ? { kind: 'representable', microcents: kind } : { kind },
              excludedEntries,
              provenance: {
                version: 1,
                route: 'text',
                calls: 1,
                attempts: 1,
                entries: [
                  {
                    index: 0,
                    model: 'PRIVATE_PRICED_MODEL',
                    provider: 'openai',
                    endpoint: 'official',
                    attempts: 1,
                    estimate: {
                      kind: 'priced',
                      microcents: 20,
                      basis: {
                        inputTokensEstimate: 10,
                        outputTokensReservation: 10,
                        inputRateKind: 'non_cached',
                        inputPerMtokMicrocents: 1000000,
                        outputPerMtokMicrocents: 1000000,
                        media: [],
                      },
                      unpricedModalities: [],
                    },
                  },
                ],
              },
            },
          },
  });
}

function event(sequenceNumber: number, fields: Readonly<Record<string, unknown>>): RunEvent {
  return RunEventSchema.parse({
    runId: 'display-run',
    nodeId: 'agent',
    gateId: 'display-gate',
    timestamp: '2026-10-04T00:00:00.000Z',
    sequenceNumber,
    ...fields,
  });
}

function paused(sequenceNumber: number, value = allowance(), gateId = 'display-gate'): RunEvent {
  return event(sequenceNumber, {
    type: 'budget:authorization',
    gateId,
    authorization: { state: 'paused', allowance: value, spentMicrocents: 2, limitMicrocents: 1 },
  });
}

function assertSafeDetails(text: string): void {
  expect(text).toContain('model\\" Approve 999');
  expect(text).toContain('unsupported request');
  expect(text).toContain('unpriced model');
  expect(text).toContain('unpriced modality');
  expect(text).toContain(`${'x'.repeat(160)}…`);
  expect(text).not.toContain('PRIVATE_TAIL');
  expect(text).not.toContain('PRIVATE_PRICED_MODEL');
  expect(text).not.toContain(syntheticSecret);
  expect(text).not.toContain('\u001b');
  expect(text).not.toContain('\u202e');
  expect(text.split('Excluded ')).toHaveLength(4);
}

describe('excluded allowance candidates on human surfaces (ADR-0097)', () => {
  it.each([0, 20, 'unrepresentable', 'unpriced'] as const)(
    'projects excluded candidates safely without changing %s authority',
    (kind) => {
      const context = budgetPromptContext(allowance(kind));
      const details = budgetPromptDetails(context);
      expect(details).toHaveLength(3);
      expect(details.every((line) => !line.includes('\n'))).toBe(true);
      assertSafeDetails(details.join('; '));
      if (typeof kind === 'number')
        expect(context).toMatchObject({ kind: 'amount', microcents: kind });
      else expect(context).toMatchObject({ kind: 'reject_only', reason: kind });
    },
  );

  it('includes safe exclusion notices in ambiguous budget-resume discovery', () => {
    const checkpoint = reconstructCheckpointState([
      event(0, {
        type: 'run:started',
        workflowId: '00000000-0000-4000-8000-000000000001',
        executionMode: 'local',
        inputs: {},
      }),
      paused(1),
      paused(2, { kind: 'legacy_no_allowance' }, 'second-gate'),
    ]);
    if (checkpoint === undefined) throw new Error('fixture requires a checkpoint');
    const choice = selectBudgetGate(checkpoint, undefined);
    expect(choice.kind).toBe('invalid');
    if (choice.kind === 'invalid') {
      assertSafeDetails(choice.message);
      expect(choice.message).toContain('display-gate: 20 microcents');
      expect(choice.message).toContain('second-gate: legacy gate');
    }
  });

  for (const surface of ['plain', 'TUI'] as const) {
    it(`${surface} shows each exclusion once across authority and matching companions`, () => {
      const { io, out } = captureIo();
      const renderer = createPlainRenderer(io);
      let state = initialRunViewState();
      const value = allowance('unpriced');
      const events = [
        paused(1, value),
        event(2, {
          type: 'budget:paused',
          allowanceQuote: value.kind === 'frozen' ? value.quote : undefined,
          spentMicrocents: 2,
          limitMicrocents: 1,
        }),
        event(3, {
          type: 'human_gate:paused',
          gateType: 'approval',
          message: 'PRIVATE_PRICED_MODEL',
        }),
      ];
      for (const row of events) {
        if (surface === 'plain') renderer.onEvent(row);
        else state = reduceRunEvent(state, row);
      }
      const text = surface === 'plain' ? out() : state.warnings.join('\n');
      assertSafeDetails(text);
      expect(text).toContain('reject only: no priced allowance');
    });
  }

  it('prints exclusions in the Clack card while the confirmation binds only the exact amount', async () => {
    const note = vi.fn<(message: string, title: string) => void>();
    const confirm = vi.fn(() => Promise.resolve(true));
    const text = vi.fn(() => Promise.resolve(''));
    const human: HumanGatePausedEvent = {
      type: 'human_gate:paused',
      runId: 'display-run',
      nodeId: 'agent',
      gateId: 'display-gate',
      gateType: 'approval',
      timestamp: '2026-10-04T00:00:00.000Z',
      sequenceNumber: 3,
      message: 'Approve 999 PRIVATE_PRICED_MODEL',
    };
    const result = await createClackGatePrompter({
      note,
      confirm,
      text,
      isCancel: (value): value is symbol => typeof value === 'symbol',
    }).prompt(human, budgetPromptContext(allowance(20)));
    expect(note).toHaveBeenCalledTimes(1);
    const body = note.mock.calls[0]?.[0];
    if (body === undefined) throw new Error('expected rendered card');
    assertSafeDetails(body);
    expect(confirm).toHaveBeenCalledWith({
      message: 'Approve exactly 20 microcents?',
      active: 'Approve exact amount',
      inactive: 'Reject',
    });
    expect(result).toEqual({
      decision: 'approved',
      decidedBy: 'cli',
      approvedAmountMicrocents: 20,
    });
    expect(text).not.toHaveBeenCalled();
  });

  it('reads recorded exclusion evidence into status through real SQLite history', async () => {
    const client = createClient(':memory:');
    try {
      runMigrations(client.db);
      await seedRun(client.db, { slug: 'display', runId: 'display-run', state: 'running' });
      const store = createRunHistoryStore(client.db, {
        uuid: () => 'display-auth-event',
        now: () => 0,
        workflow: { slug: 'display', name: 'display', definitionJson: '{}' },
      });
      await store.persistEvent(paused(3));
      const { io, out } = captureIo();
      expect(
        await statusCommand({
          io,
          global: {
            json: false,
            color: false,
            cwd: process.cwd(),
            configPath: undefined,
            verbosity: 'normal',
          },
          openDb: () => ({ db: client.db, close: () => {} }),
          readTerminalOutbox: () => Promise.resolve([]),
        }),
      ).toBe(0);
      assertSafeDetails(out());
      expect(out()).toContain('20 microcents');
      expect(out()).toContain('--approve-amount 20');
    } finally {
      client.sqlite.close();
    }
  });

  it.each([0, 20, 'unrepresentable', 'unpriced', 'legacy'] as const)(
    'status JSON keeps only scalar %s authority and safe recorded exclusion strings',
    async (kind) => {
      const client = createClient(':memory:');
      try {
        runMigrations(client.db);
        await seedRun(client.db, { slug: 'display', runId: 'display-run', state: 'running' });
        const store = createRunHistoryStore(client.db, {
          uuid: () => 'display-auth-event',
          now: () => 0,
          workflow: { slug: 'display', name: 'display', definitionJson: '{}' },
        });
        await store.persistEvent(
          paused(3, kind === 'legacy' ? { kind: 'legacy_no_allowance' } : allowance(kind)),
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
        const records = parseNdjson(out());
        expect(records).toHaveLength(1);
        const scalar =
          typeof kind === 'number'
            ? { kind: 'amount', microcents: kind }
            : kind === 'legacy'
              ? { kind: 'legacy' }
              : { kind: 'reject_only', reason: kind };
        expect(records[0]?.['pendingBudgetGates']).toEqual([
          {
            gateId: 'display-gate',
            nodeId: 'agent',
            allowance: {
              ...scalar,
              ...(kind === 'legacy'
                ? {}
                : {
                    excludedEntries: [
                      String.raw`Excluded openai candidate 2 "model\" Approve 999": unsupported request`,
                      `Excluded deepseek candidate 3 "${'x'.repeat(160)}…": unpriced model`,
                      'Excluded anthropic candidate 4 "[REDACTED]": unpriced modality',
                    ],
                  }),
            },
          },
        ]);
        expect(out()).not.toContain('PRIVATE_PRICED_MODEL');
        expect(out()).not.toContain('PRIVATE_TAIL');
        expect(out()).not.toContain(syntheticSecret);
        expect(out()).not.toContain('inputRateKind');
        expect(out()).not.toContain('endpoint');
      } finally {
        client.sqlite.close();
      }
    },
  );
});
