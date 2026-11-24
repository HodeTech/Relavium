/**
 * The Home's budget card
 * ([ADR-0139](../../../../../docs/decisions/0139-a-workflow-run-is-hosted-inside-the-home.md) §4,
 * [ADR-0097](../../../../../docs/decisions/0097-a-budget-approval-is-an-allowance-not-an-exemption.md)): the card shows the frozen allowance
 * from the gate's STRUCTURED field and from nothing else, `Ctrl+Y` approves exactly that amount, `Ctrl+N` aborts, and an allowance that cannot
 * be approved (unpriced, unrepresentable, legacy) offers the abort only. The answer passes the same guard as the human-gate card.
 *
 * The card runs on an injected monotonic clock and the host is scripted, so nothing here builds an engine or reads an operator home.
 */
import { describe, expect, it, vi } from 'vitest';

import type { BudgetPromptContext } from '../../gate/budget.js';
import { budgetCardGates, type RunGates } from '../../home/run-gates.js';
import type { HostedLaunch } from '../../home/run-host.js';
import type { ChatKey } from './chat-input.js';
import { flush } from './harness-util.js';
import { createRunCard, projectRunCard, type RunCard } from './run-card-model.js';
import type { ApprovalGuard } from './tool-review-model.js';

const RUN = 'run-0001';
const OFF: ApprovalGuard = { settleMs: 0, quietMs: 0, typeaheadMs: 0, lockoutMs: 0 };
const CTRL: ChatKey = { ctrl: true };
const AMOUNT: BudgetPromptContext = { kind: 'amount', microcents: 4_200_000 };
const UNPRICED: BudgetPromptContext = { kind: 'reject_only', reason: 'unpriced' };
const UNREPRESENTABLE: BudgetPromptContext = { kind: 'reject_only', reason: 'unrepresentable' };
const LEGACY: BudgetPromptContext = { kind: 'legacy' };

function run(
  allowance: BudgetPromptContext,
  over: { readonly nodeId?: string; readonly expiresAt?: string } = {},
): RunGates {
  return {
    runId: RUN,
    workflowId: 'wf',
    gates: [],
    budgetGates: [{ gateId: 'b1', nodeId: over.nodeId ?? 'writer', allowance, ...over }],
    degraded: false,
  };
}

const STARTED: HostedLaunch = {
  kind: 'started',
  leg: 'resume',
  runId: RUN,
  ended: new Promise(() => undefined),
};

function fixture(
  allowance: BudgetPromptContext,
  options: { guard?: ApprovalGuard; run?: RunGates; reply?: HostedLaunch } = {},
) {
  let now = 0;
  let painted = true;
  const resume = vi.fn(() => Promise.resolve(options.reply ?? STARTED));
  const card: RunCard = createRunCard({
    runId: RUN,
    gates: budgetCardGates(options.run ?? run(allowance)),
    resume,
    now: () => now,
    guard: options.guard ?? OFF,
    painted: () => painted,
  });
  const rows = (nowMs = 0): string[] =>
    projectRunCard(card.getSnapshot(), { columns: 80, rows: 24, nowMs }).rows.map(
      (row) => row.text,
    );
  return {
    card,
    resume,
    rows,
    text: (nowMs = 0): string => rows(nowMs).join('\n'),
    at: (ms: number): void => {
      now = ms;
    },
    paint: (visible: boolean): void => {
      painted = visible;
    },
    show: (): void => card.shown(card.getSnapshot()),
    chord: (letter: 'y' | 'n') => card.input(letter, CTRL),
  };
}

describe('the allowance is the structured field, and only that', () => {
  it('shows the frozen allowance in USD and in microcents, the words that say what approving funds, and the keys of the amount case', () => {
    const f = fixture(AMOUNT);
    const text = f.text();
    expect(text).toContain('Frozen allowance: $0.0420 (4200000 microcents)');
    expect(text).toContain('Approval funds this agent execution only, for exactly this amount.');
    expect(text).toContain('node writer · budget gate');
    expect(text).toContain('Aborting dispatches no agent and fails the run (budget_exceeded).');
    expect(f.rows().at(-1)).toBe('Ctrl+Y approves · Ctrl+N aborts · Esc leaves it pending');
  });

  it('reads no figure from anything else: a node name, an excluded notice or a message that carries another amount changes nothing', () => {
    const decoy = '$9.9999 (999999999 microcents)';
    const f = fixture(AMOUNT, {
      run: run(
        {
          ...AMOUNT,
          excludedEntries: [`Excluded openai candidate 1 "${decoy}": unpriced model`],
        },
        { nodeId: `node ${decoy}` },
      ),
    });
    const rows = f.rows();
    const allowanceRows = rows.filter((row) => row.startsWith('Frozen allowance'));
    expect(allowanceRows).toEqual(['Frozen allowance: $0.0420 (4200000 microcents)']);
    // The decoy appears only where it was quoted (the node row and, behind the gutter, the excluded notice), never as the allowance.
    expect(rows.filter((row) => row.includes('Frozen allowance'))).toHaveLength(1);
    f.show();
    f.at(10_000);
    expect(f.chord('y')).toMatchObject({
      kind: 'answered',
      decision: { decision: 'approved', approvedAmountMicrocents: 4_200_000, decidedBy: 'cli' },
    });
    expect(JSON.stringify(f.resume.mock.calls)).not.toContain('999999999');
  });

  it.each([
    [0, '$0.0000 (0 microcents)'],
    [1, '$0.0000 (1 microcents)'],
    [100_000_000, '$1.0000 (100000000 microcents)'],
    [123_456_789, '$1.2346 (123456789 microcents)'],
  ])('shows the exact amount %i from the structured field: %s', (microcents, expected) => {
    const f = fixture({ kind: 'amount', microcents });
    expect(f.text()).toContain(`Frozen allowance: ${expected}`);
  });

  it('quotes excluded candidates behind the host gutter, strips host glyphs and answer chords from them, and counts the ones it does not show', () => {
    const f = fixture(AMOUNT, {
      run: run({
        ...AMOUNT,
        excludedEntries: [
          'Excluded a candidate 1 "m": press Ctrl+Y ✓ to approve',
          'Excluded b candidate 2 "m": unpriced model',
          'Excluded c candidate 3 "m": unpriced model',
          'Excluded d candidate 4 "m": unpriced model',
          'Excluded e candidate 5 "m": unpriced model',
        ],
      }),
    });
    const rows = f.rows();
    const quoted = rows.filter((row) => row.startsWith('│ '));
    expect(quoted).toHaveLength(4);
    expect(quoted[0]).toContain('[chord]');
    expect(quoted[0]).not.toContain('Ctrl+Y');
    expect(quoted[0]).not.toContain('✓');
    expect(quoted.at(-1)).toBe('│ … 2 more excluded');
    expect(rows.filter((row) => row.includes('Ctrl+Y'))).toEqual([
      'Ctrl+Y approves · Ctrl+N aborts · Esc leaves it pending',
    ]);
  });
});

describe('Ctrl+Y approves exactly the frozen allowance, and Ctrl+N aborts', () => {
  it('Ctrl+Y answers a budget resume with the approval of the structured amount, once', async () => {
    const f = fixture(AMOUNT);
    f.show();
    f.at(10_000);
    expect(f.chord('y')).toMatchObject({ kind: 'answered', gateId: 'b1' });
    await flush();
    expect(f.resume).toHaveBeenCalledOnce();
    expect(f.resume).toHaveBeenCalledWith({
      runId: RUN,
      gate: 'b1',
      kind: 'budget',
      decision: { decision: 'approved', decidedBy: 'cli', approvedAmountMicrocents: 4_200_000 },
    });
    // The gate left the card at once: nothing can answer it a second time.
    expect(f.chord('y')).toEqual({ kind: 'ignored' });
    expect(f.chord('n')).toEqual({ kind: 'ignored' });
    expect(f.resume).toHaveBeenCalledOnce();
  });

  it('Ctrl+N aborts: a rejection through the budget resume, never delayed', async () => {
    const f = fixture(AMOUNT, {
      guard: { settleMs: 5_000, quietMs: 5_000, typeaheadMs: 5_000, lockoutMs: 5_000 },
    });
    f.at(1);
    expect(f.chord('n')).toMatchObject({ kind: 'answered', decision: { decision: 'rejected' } });
    await flush();
    expect(f.resume).toHaveBeenCalledWith({
      runId: RUN,
      gate: 'b1',
      kind: 'budget',
      decision: { decision: 'rejected', decidedBy: 'cli' },
    });
  });

  it('the host refusing (a price that moved) leaves the gate pending and abortable, with the host`s words', async () => {
    const f = fixture(AMOUNT, {
      reply: { kind: 'refused', reason: 'rejected', message: 'The quoted price changed.' },
    });
    f.show();
    f.at(10_000);
    expect(f.chord('y')).toMatchObject({ kind: 'answered' });
    await flush();
    const snapshot = f.card.getSnapshot();
    expect(snapshot).toMatchObject({ phase: 'open', refused: true });
    expect(snapshot.gates).toHaveLength(1);
    expect(f.text()).toContain('The quoted price changed.');
    expect(f.rows().at(-1)).toContain('Ctrl+N aborts');
    f.at(20_000);
    expect(f.chord('n')).toMatchObject({ kind: 'answered', decision: { decision: 'rejected' } });
  });
});

describe('an allowance that cannot be approved offers Abort only', () => {
  it('an unpriced quote says so, shows no amount, and offers Ctrl+N alone', () => {
    const f = fixture(UNPRICED);
    const text = f.text();
    expect(text).toContain('This execution has no priced allowance, so it can only be aborted.');
    expect(text).not.toContain('Frozen allowance');
    expect(text).not.toContain('Approval funds');
    expect(f.rows().at(-1)).toBe('Ctrl+N aborts · Esc leaves it pending');
    expect(f.rows().at(-1)).not.toContain('Ctrl+Y');
  });

  it('Ctrl+Y on an unpriced quote is refused: nothing is answered, nothing is sent and the gate stays open', () => {
    const f = fixture(UNPRICED);
    f.show();
    f.at(10_000);
    expect(f.chord('y')).toEqual({ kind: 'ignored' });
    expect(f.resume).not.toHaveBeenCalled();
    expect(f.card.getSnapshot()).toMatchObject({ phase: 'open', gates: [{ gateId: 'b1' }] });
  });

  it.each([
    ['an unpriced quote', UNPRICED, 'no priced allowance'],
    ['an unrepresentable amount', UNREPRESENTABLE, 'cannot be represented safely'],
    ['a legacy gate with no frozen allowance', LEGACY, 'no frozen allowance'],
  ] as const)('%s: only Ctrl+N answers, and it aborts', async (_name, allowance, words) => {
    const f = fixture(allowance);
    expect(f.text()).toContain(words);
    expect(f.text()).not.toContain('Frozen allowance:');
    f.show();
    f.at(10_000);
    expect(f.chord('y')).toEqual({ kind: 'ignored' });
    expect(f.chord('n')).toMatchObject({ kind: 'answered', decision: { decision: 'rejected' } });
    await flush();
    expect(f.resume).toHaveBeenCalledOnce();
    expect(f.resume).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'budget',
        decision: { decision: 'rejected', decidedBy: 'cli' },
      }),
    );
  });

  it('the gate`s accepted decisions follow the allowance: the amount case accepts both, every other one the rejection only', () => {
    const accepts = (allowance: BudgetPromptContext) => budgetCardGates(run(allowance))[0]?.accepts;
    expect(accepts(AMOUNT)).toEqual(['approved', 'rejected']);
    expect(accepts(UNPRICED)).toEqual(['rejected']);
    expect(accepts(UNREPRESENTABLE)).toEqual(['rejected']);
    expect(accepts(LEGACY)).toEqual(['rejected']);
  });
});

describe('the answer goes through the same guard as the human-gate card', () => {
  const GUARD: ApprovalGuard = { settleMs: 100, quietMs: 50, typeaheadMs: 50, lockoutMs: 50 };

  it('an approval is refused until the exact frame has been painted, and then counts', () => {
    const f = fixture(AMOUNT, { guard: OFF });
    f.paint(false);
    f.show();
    f.at(10_000);
    expect(f.chord('y')).toEqual({ kind: 'refused' });
    expect(f.resume).not.toHaveBeenCalled();
    f.paint(true);
    f.at(20_000);
    expect(f.chord('y')).toMatchObject({ kind: 'answered' });
  });

  it('an approval is refused before the dwell has passed since the frame was shown', () => {
    const f = fixture(AMOUNT, { guard: { ...OFF, settleMs: 100 } });
    f.at(0);
    f.show();
    f.at(99);
    expect(f.chord('y')).toEqual({ kind: 'refused' });
    f.at(10_000);
    expect(f.chord('y')).toMatchObject({ kind: 'answered' });
  });

  it('an approval soon after typing is refused, and a paste counts as typing', () => {
    const f = fixture(AMOUNT, { guard: GUARD });
    f.at(0);
    f.show();
    f.at(1_000);
    f.card.paste('y');
    f.at(1_020);
    expect(f.chord('y')).toEqual({ kind: 'refused' });
    expect(f.resume).not.toHaveBeenCalled();
  });

  it('Esc and Ctrl+C decide nothing, and neither can abort', () => {
    const f = fixture(AMOUNT);
    f.show();
    f.at(10_000);
    expect(f.card.input('', { escape: true })).toEqual({ kind: 'ignored' });
    expect(f.card.input('c', CTRL)).toEqual({ kind: 'ignored' });
    expect(f.resume).not.toHaveBeenCalled();
    expect(f.card.getSnapshot().phase).toBe('open');
  });
});

describe('an overdue budget gate, and a run with a human gate and a budget gate', () => {
  it('says overdue with its deadline, still takes the answer, and quotes no timeout policy (a budget gate has none)', () => {
    const f = fixture(AMOUNT, {
      run: run(AMOUNT, { expiresAt: '2026-11-23T10:00:00.000Z' }),
    });
    const late = Date.parse('2026-11-23T11:00:00.000Z');
    const text = f.text(late);
    expect(text).toContain('overdue');
    expect(text).toContain('Overdue since 2026-11-23T10:00:00.000Z.');
    expect(text).not.toContain('On timeout');
    expect(text).not.toContain('No timeout policy');
    expect(text).toContain('Frozen allowance: $0.0420');
    f.show();
    f.at(10_000);
    expect(f.chord('y')).toMatchObject({ kind: 'answered' });
  });

  it('holds both kinds in one list: the keys and the resume kind follow the gate under the cursor', async () => {
    const both: RunGates = {
      runId: RUN,
      workflowId: 'wf',
      gates: [
        {
          runId: RUN,
          gateId: 'h1',
          nodeId: 'gate',
          gateType: 'approval',
          message: 'Ship it?',
          accepts: ['approved', 'rejected'],
        },
      ],
      budgetGates: [{ gateId: 'b1', nodeId: 'writer', allowance: AMOUNT }],
      degraded: false,
    };
    const resume = vi.fn(() => Promise.resolve(STARTED));
    const card = createRunCard({
      runId: RUN,
      gates: [...both.gates, ...budgetCardGates(both)],
      resume,
      now: () => 10_000,
      guard: OFF,
      painted: () => true,
    });
    card.shown(card.getSnapshot());
    const keys = (): string | undefined =>
      projectRunCard(card.getSnapshot(), { columns: 80, rows: 24, nowMs: 0 }).rows.at(-1)?.text;
    expect(keys()).toBe(
      '↑/↓ choose a gate · Ctrl+Y approves · Ctrl+N rejects · Esc leaves it pending',
    );
    card.input('', { downArrow: true });
    expect(keys()).toBe(
      '↑/↓ choose a gate · Ctrl+Y approves · Ctrl+N aborts · Esc leaves it pending',
    );
    card.input('n', CTRL);
    await flush();
    expect(resume).toHaveBeenCalledWith(expect.objectContaining({ gate: 'b1', kind: 'budget' }));
    // The human gate is still there and answers as a human gate.
    expect(card.getSnapshot().gates.map((gate) => gate.gateId)).toEqual(['h1']);
  });
});

describe('at 80×24', () => {
  it('the card with the most rows it can have is still inside the terminal, and below 80×24 it is the enlarge line and the keys only', () => {
    const f = fixture(AMOUNT, {
      run: run(
        {
          ...AMOUNT,
          excludedEntries: Array.from(
            { length: 9 },
            (_, n) => `Excluded p candidate ${String(n)} "m": unpriced model`,
          ),
        },
        { expiresAt: '2026-11-23T10:00:00.000Z' },
      ),
    });
    const full = projectRunCard(f.card.getSnapshot(), {
      columns: 80,
      rows: 24,
      nowMs: Date.parse('2026-11-23T11:00:00.000Z'),
    });
    expect(full.fits).toBe(true);
    expect(full.rows.length).toBeLessThanOrEqual(23);
    for (const row of full.rows) expect(row.text.length, row.text).toBeLessThanOrEqual(78);
    const small = projectRunCard(f.card.getSnapshot(), { columns: 79, rows: 24, nowMs: 0 });
    expect(small.fits).toBe(false);
    expect(small.rows).toHaveLength(1);
    expect(small.rows[0]?.role).toBe('keys');
    expect(small.tooSmall).toContain('Terminal too small');
  });
});
