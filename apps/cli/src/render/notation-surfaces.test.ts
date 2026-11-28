import {
  BudgetAllowanceStateSchema,
  RunEventSchema,
  type BudgetAllowanceState,
} from '@relavium/shared';
import { describe, expect, it } from 'vitest';

import { capUsd } from '../chat/effort-notice.js';
import { budgetWarningText } from '../commands/chat.js';
import { catalogTokenRates } from '../commands/models-pricing.js';
import {
  assertBudgetDecision,
  budgetDecisionFromFlags,
  budgetPromptLabel,
  budgetResumeHints,
} from '../gate/budget.js';
import { classifyActiveRuns } from '../history/active-model.js';
import { buildDefinedModel } from '../history/defined-model.js';
import { buildHistoryRows } from '../history/history-model.js';
import { initialRunViewState, reduceRunEvent } from './tui/run-view-model.js';

/**
 * The money notation of ADR-0145 §8 on the surfaces that print it (MVP-11 Step 3): raw micro-cents appear in machine output and in the
 * one flag that takes them, and nowhere else. The notation's own properties are `notation.test.ts`'s.
 */

function frozen(amount: number): BudgetAllowanceState {
  return BudgetAllowanceStateSchema.parse({
    kind: 'frozen',
    quote: {
      kind: 'quoted',
      quote: {
        amount: { kind: 'representable', microcents: amount },
        provenance: {
          version: 1,
          route: 'text',
          calls: 1,
          attempts: 1,
          entries: [
            {
              index: 0,
              model: 'm',
              provider: 'openai',
              endpoint: 'official',
              attempts: 1,
              estimate: {
                kind: 'priced',
                microcents: amount,
                basis: {
                  inputTokensEstimate: 10,
                  outputTokensReservation: 10,
                  inputRateKind: 'non_cached',
                  inputPerMtokMicrocents: 1_000_000,
                  outputPerMtokMicrocents: 1_000_000,
                  media: [],
                },
                unpricedModalities: [],
              },
            },
          ],
        },
        excludedEntries: [],
      },
    },
  });
}

describe('the budget gate says the amount exactly and keeps the integer for the flag', () => {
  it.each([
    [0, 'allowance $0.0000'],
    [1, 'allowance $0.00000001'],
    [4_999_999, 'allowance $0.04999999'],
    [5_000_000, 'allowance $0.0500'],
    [5_000_001, 'allowance $0.05000001'],
  ])('the label of %i micro-cents is %s', (microcents, label) => {
    expect(budgetPromptLabel({ kind: 'amount', microcents })).toBe(label);
  });

  it('names a legacy gate without the word frozen', () => {
    expect(budgetPromptLabel({ kind: 'legacy' })).toBe('legacy gate: no budget allowance');
  });

  it('a wrong amount is refused with the exact USD and the whole corrected flag, never a bare integer in prose', () => {
    expect(() =>
      assertBudgetDecision(frozen(5_000_001), budgetDecisionFromFlags({ approveAmount: '5' })),
    ).toThrow(
      'the budget allowance is $0.05000001; --approve-amount must equal it exactly (--approve-amount 5000001)',
    );
  });

  it('the copyable commands keep the integer: it is the flag the person types', () => {
    expect(budgetResumeHints('run-1', 'gate-1', { kind: 'amount', microcents: 5_000_001 })).toEqual(
      [
        'approve: relavium budget resume run-1 --gate gate-1 --approve-amount 5000001',
        'reject: relavium budget resume run-1 --gate gate-1 --abort',
      ],
    );
  });
});

describe('a cap, a hold and an estimate are amounts that are never rounded', () => {
  it('the cap in the cost notice and in the budget warning', () => {
    expect(capUsd(5_000_000)).toBe('$0.0500');
    expect(capUsd(1)).toBe('$0.00000001');
    expect(
      budgetWarningText({
        spentMicrocents: 4_000_000,
        limitMicrocents: 5_000_001,
        thresholdPct: 80,
      }),
    ).toBe('budget warning: ~80% of the $0.05000001 cap reached');
  });

  it('the estimate held for a gate, in the run view', () => {
    const state = reduceRunEvent(
      initialRunViewState(),
      RunEventSchema.parse({
        type: 'budget:estimate_committed',
        runId: 'run-1',
        timestamp: '2026-11-24T12:00:00.000Z',
        sequenceNumber: 1,
        nodeId: 'writer',
        model: 'm',
        estimateMicrocents: 12_345,
        cumulativeConservativeMicrocents: 99_999_999,
      }),
    );
    expect(state.warnings).toEqual([
      'budget: ~$0.00012345 held as an estimate (possibly billed; ~$0.99999999 total)',
    ]);
  });
});

describe('a price is one notation per million', () => {
  it('the catalog fallback in a pricing sentence', () => {
    expect(
      catalogTokenRates({
        provider: 'openai',
        nativeId: 'm',
        displayName: 'M',
        contextWindowTokens: 1000,
        maxOutputTokens: 100,
        inputPerMtokMicrocents: 7_500_000,
        outputPerMtokMicrocents: 3_000_000_000,
        cachedInputPerMtokMicrocents: 0,
      }),
    ).toBe('input $0.075 per M, output $30 per M');
  });
});

describe('a project directory on a Home row is project-relative or from ~, shortened before it is scrubbed', () => {
  const paths = { cwd: '/home/ada/work/app', home: '/home/ada' } as const;
  const stored = {
    workflowId: 'wf',
    status: 'paused',
    executionMode: 'local',
    triggerType: 'manual',
    startedAt: '2026-11-22T11:00:00.000Z',
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCostMicrocents: 0,
    createdAt: '2026-11-22T11:00:00.000Z',
    updatedAt: '2026-11-22T11:02:05.000Z',
  } as const;
  const NOW = Date.parse('2026-11-22T12:00:00.000Z');

  it('the History tab: a run of another project shows from ~, and one outside the home stays whole', () => {
    const rows = buildHistoryRows({
      runs: [
        { ...stored, id: 'a', projectRoot: '/home/ada/other' },
        { ...stored, id: 'b', projectRoot: '/srv/shared/project' },
      ],
      nowMs: NOW,
      pinnedRunIds: new Set(),
      paths,
    });
    expect(rows.map((row) => row.projectRoot)).toEqual(['~/other', '/srv/shared/project']);
  });

  it('the History tab: without roots the root is shown as it is stored', () => {
    const [row] = buildHistoryRows({
      runs: [{ ...stored, id: 'a', projectRoot: '/home/ada/other' }],
      nowMs: NOW,
      pinnedRunIds: new Set(),
    });
    expect(row?.projectRoot).toBe('/home/ada/other');
  });

  it('a stored root with a terminal escape is shortened first and then scrubbed', () => {
    const [row] = buildHistoryRows({
      runs: [{ ...stored, id: 'a', projectRoot: '/home/ada/o\u001b[31mther' }],
      nowMs: NOW,
      pinnedRunIds: new Set(),
      paths,
    });
    expect(row?.projectRoot).toBe('~/other');
  });

  it('the Active tab: a paused run of another project names its root from ~', () => {
    const [row] = classifyActiveRuns({
      runs: [{ ...stored, id: 'run-a', projectRoot: '/home/ada/other' }],
      leases: new Map(),
      currentProjectRoot: '/home/ada/work/app',
      outboxHeldRunIds: new Set(),
      nowMs: NOW,
      leaseTtlMs: 60_000,
      paths,
    });
    expect(row?.projectRoot).toBe('~/other');
  });

  it('the `/workflows` popup: a pin of another project shows its root from ~', () => {
    const model = buildDefinedModel({
      entries: [],
      pins: [],
      otherPins: [
        {
          kind: 'workflow',
          ref: 'deploy',
          rowid: 1,
          oversized: false,
          projectRoot: '/home/ada/other',
        },
      ],
      paths,
    });
    expect(model.rows.map((row) => row.projectRoot)).toEqual(['~/other']);
  });
});
