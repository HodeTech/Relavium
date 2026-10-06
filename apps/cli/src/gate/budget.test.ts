import { reconstructCheckpointState, type CheckpointState } from '@relavium/core';
import {
  BudgetAllowanceStateSchema,
  RunEventSchema,
  type BudgetAllowanceState,
  type RunEvent,
} from '@relavium/shared';
import { describe, expect, it } from 'vitest';
import {
  assertBudgetDecision,
  budgetDecisionFromFlags,
  budgetIdentifier,
  resumeCommandBase,
  budgetPromptContext,
  budgetResumeHints,
  selectBudgetGate,
} from './budget.js';

function allowance(amount: number | 'unrepresentable' = 20): BudgetAllowanceState {
  return BudgetAllowanceStateSchema.parse({
    kind: 'frozen',
    quote: {
      kind: 'quoted',
      quote: {
        amount:
          typeof amount === 'number'
            ? { kind: 'representable', microcents: amount }
            : { kind: amount },
        provenance: {
          version: 1,
          route: 'text',
          calls: 1,
          attempts: 1,
          entries: [
            {
              index: 0,
              model: 'PRIVATE_MODEL',
              provider: 'openai',
              endpoint: 'custom',
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
        excludedEntries: [],
      },
    },
  });
}
function row(seq: number, fields: Readonly<Record<string, unknown>>): RunEvent {
  return RunEventSchema.parse({
    type: 'run:started',
    runId: 'budget-ui',
    timestamp: '2026-10-03T00:00:00.000Z',
    sequenceNumber: seq,
    ...fields,
  });
}
function checkpoint(extra: readonly RunEvent[]): CheckpointState {
  const result = reconstructCheckpointState([
    row(0, {
      type: 'run:started',
      workflowId: '00000000-0000-4000-8000-000000000001',
      inputs: {},
      executionMode: 'local',
    }),
    ...extra,
  ]);
  if (result === undefined) throw new Error('fixture requires actual checkpoint');
  return result;
}
function paused(seq: number, gateId = 'budget-gate', nodeId = 'agent', a = allowance()): RunEvent {
  return row(seq, {
    type: 'budget:authorization',
    gateId,
    nodeId,
    authorization: {
      state: 'paused',
      allowance: a,
      spentMicrocents: 2,
      limitMicrocents: 1,
    },
  });
}
describe('budget operator transport and recorded authority', () => {
  it('refuses a resolved ordinary human gate while another budget gate remains resumable', () => {
    const cp = checkpoint([
      row(1, {
        type: 'human_gate:paused',
        nodeId: 'human',
        gateId: 'ordinary',
        gateType: 'approval',
        message: 'review',
      }),
      row(2, {
        type: 'human_gate:resumed',
        nodeId: 'human',
        gateId: 'ordinary',
        decision: 'approved',
        decidedBy: 'cli',
      }),
      paused(3),
    ]);
    expect(cp.resolvedGateIds).toContain('ordinary');
    expect(cp.resolvedBudgetGateIds).not.toContain('ordinary');
    expect(selectBudgetGate(cp, 'ordinary')).toMatchObject({ kind: 'invalid' });
    expect(selectBudgetGate(cp, 'budget-gate')).toEqual({ kind: 'resume', gateId: 'budget-gate' });
  });

  it.each(['native', 'legacy'] as const)(
    'preserves resolved %s budget idempotency from recorded kind evidence',
    (kind) => {
      const pause =
        kind === 'native'
          ? paused(1)
          : row(1, {
              type: 'budget:paused',
              nodeId: 'agent',
              gateId: 'budget-gate',
              spentMicrocents: 2,
              limitMicrocents: 1,
            });
      const decision =
        kind === 'native'
          ? row(2, {
              type: 'budget:authorization',
              nodeId: 'agent',
              gateId: 'budget-gate',
              authorization: {
                state: 'decided',
                allowance: allowance(),
                decision: 'approved',
                decidedBy: 'cli',
                approvedAmountMicrocents: 20,
              },
            })
          : row(2, {
              type: 'human_gate:resumed',
              nodeId: 'agent',
              decision: 'approved',
              decidedBy: 'cli',
            });
      const cp = checkpoint([pause, decision, paused(3, 'next-budget', 'next-agent')]);
      const { resolvedBudgetGateIds, ...legacyCheckpoint } = cp;
      expect(resolvedBudgetGateIds).toContain('budget-gate');
      expect(selectBudgetGate(cp, 'budget-gate')).toMatchObject({ kind: 'idempotent' });
      expect(selectBudgetGate(legacyCheckpoint, 'budget-gate')).toMatchObject({
        kind: 'invalid',
      });
    },
  );

  it.each([
    '',
    '-1',
    '+1',
    '1.0',
    '1e3',
    '0x10',
    ' 1',
    '1 ',
    'NaN',
    'Infinity',
    '9007199254740992',
    '1_000',
  ])('rejects unsafe/nondecimal amount %j before any consumer', (raw) => {
    expect(() => budgetDecisionFromFlags({ approveAmount: raw })).toThrow(/safe integer/);
  });
  it.each(['0', '20', '9007199254740991'])(
    'acknowledges exact decimal scalar %s including zero',
    (raw) => {
      expect(budgetDecisionFromFlags({ approveAmount: raw })).toEqual({
        decision: 'approved',
        decidedBy: 'cli',
        approvedAmountMicrocents: Number(raw),
      });
    },
  );
  it('requires exactly one decision and abort carries no amount', () => {
    expect(() => budgetDecisionFromFlags({})).toThrow(/exactly one/);
    expect(() => budgetDecisionFromFlags({ approveAmount: '0', abort: true })).toThrow(
      /exactly one/,
    );
    expect(budgetDecisionFromFlags({ abort: true })).toEqual({
      decision: 'rejected',
      decidedBy: 'cli',
    });
  });
  it('selects an authority-only budget crash without a human companion and excludes ordinary gates', () => {
    const cp = checkpoint([
      paused(1),
      row(2, {
        type: 'human_gate:paused',
        gateId: 'ordinary',
        nodeId: 'human',
        gateType: 'approval',
        message: 'ordinary',
      }),
    ]);
    expect(selectBudgetGate(cp, undefined)).toEqual({
      kind: 'resume',
      gateId: 'budget-gate',
    });
    expect(selectBudgetGate(cp, 'ordinary')).toMatchObject({ kind: 'invalid' });
  });
  it('multiple budget choices display exact A without model provenance', () => {
    const cp = checkpoint([paused(1), paused(2, 'budget-two', 'agent-two', allowance(0))]);
    const choice = selectBudgetGate(cp, undefined);
    expect(choice.kind).toBe('invalid');
    if (choice.kind === 'invalid') {
      expect(choice.message).toContain('budget-gate: 20 microcents');
      expect(choice.message).toContain('budget-two: 0 microcents');
      expect(choice.message).not.toContain('PRIVATE_MODEL');
    }
    expect(selectBudgetGate(cp, 'budget-two')).toEqual({
      kind: 'resume',
      gateId: 'budget-two',
    });
  });
  it('wrong A keeps recorded amount intact and exposes exact frozen remedy', () => {
    const a = allowance();
    expect(() => assertBudgetDecision(a, budgetDecisionFromFlags({ approveAmount: '21' }))).toThrow(
      /20 microcents/,
    );
    expect(budgetPromptContext(a)).toEqual({ kind: 'amount', microcents: 20 });
    expect(() =>
      assertBudgetDecision(a, budgetDecisionFromFlags({ approveAmount: '20' })),
    ).not.toThrow();
  });
  it('zero must be explicit and reject-only/unfrozen never get a fabricated A', () => {
    expect(() =>
      assertBudgetDecision(allowance(0), {
        decision: 'approved',
        decidedBy: 'cli',
      }),
    ).toThrow(/0 microcents/);
    expect(() =>
      assertBudgetDecision(allowance(0), budgetDecisionFromFlags({ approveAmount: '0' })),
    ).not.toThrow();
    expect(() =>
      assertBudgetDecision(
        allowance('unrepresentable'),
        budgetDecisionFromFlags({ approveAmount: '0' }),
      ),
    ).toThrow(/Reject|reject only/);
    expect(() =>
      assertBudgetDecision(
        { kind: 'legacy_no_allowance' },
        budgetDecisionFromFlags({ approveAmount: '0' }),
      ),
    ).toThrow(/no frozen amount/);
    expect(() =>
      assertBudgetDecision(allowance('unrepresentable'), budgetDecisionFromFlags({ abort: true })),
    ).not.toThrow();
  });
  it('budget identifiers normalize then redact and bound hostile values', () => {
    const id = 'sk-ant-' + 'q'.repeat(40) + '\x1b[2J\u202e\nforged';
    const safe = budgetIdentifier(id);
    expect(safe).not.toContain('q'.repeat(40));
    expect(safe).not.toContain('\x1b');
    expect(safe).not.toContain('\u202e');
    expect(safe).not.toContain('\n');
    expect(budgetIdentifier('a'.repeat(20000))).toHaveLength(161);
  });
});

describe('copyable budget operator commands', () => {
  it('shows complete approval and rejection for ordinary native identifiers', () => {
    expect(budgetResumeHints('run-id', 'gate-id', { kind: 'amount', microcents: 0 })).toEqual([
      'approve: relavium budget resume run-id --gate gate-id --approve-amount 0',
      'reject: relavium budget resume run-id --gate gate-id --abort',
    ]);
  });
  it.each([
    'gate; echo HOSTILE',
    'gate$(echo HOSTILE)',
    "gate' HOSTILE",
    'gate with spaces',
    '--help',
    '-q',
    'a'.repeat(200),
    'sk-ant-' + 'q'.repeat(40),
  ])('never emits an executable fragment or a rewritten gate id for %j', (gateId) => {
    const hints = budgetResumeHints('run-id', gateId, {
      kind: 'amount',
      microcents: 20,
    });
    expect(hints).toEqual([
      'Use relavium budget resume with the recorded run and gate IDs and --approve-amount 20 or --abort.',
    ]);
    expect(hints.join(' ')).not.toContain('HOSTILE');
    expect(hints.join(' ')).not.toContain('q'.repeat(40));
  });
});

describe('secret resume command bases', () => {
  it('preserves the actual selected gate in each transport', () => {
    expect(resumeCommandBase('human', 'run-id', 'selected-gate')).toBe(
      'relavium gate run-id --gate selected-gate',
    );
    expect(resumeCommandBase('budget', 'run-id', 'selected-gate')).toBe(
      'relavium budget resume run-id --gate selected-gate',
    );
  });
  it.each([
    'gate; echo HOSTILE',
    'gate$(echo HOSTILE)',
    "gate' HOSTILE",
    'gate with spaces',
    '--help',
    '-q',
    'a'.repeat(200),
    'sk-ant-' + 'q'.repeat(40),
  ])('never inserts hostile or rewritten secret hint identifier %j', (id) => {
    expect(resumeCommandBase('human', 'run-id', id)).toBeUndefined();
    expect(resumeCommandBase('budget', id, 'gate-id')).toBeUndefined();
  });
});
