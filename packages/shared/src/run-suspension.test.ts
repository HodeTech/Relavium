import { expect, it } from 'vitest';
import { AllowanceQuoteResultSchema } from './budget-authorization.js';
import { RunEventSchema, type RunEvent } from './run-event.js';
import { RunSuspensionReducer, RunSuspensionCorruptionError } from './run-suspension.js';
const RUN = 'offline-run';
const TS = '2026-10-03T00:00:00.000Z';
let seq = 0;
const quoted = AllowanceQuoteResultSchema.parse({
  kind: 'quoted',
  quote: {
    amount: { kind: 'representable', microcents: 10 },
    provenance: {
      version: 1,
      route: 'text',
      calls: 1,
      attempts: 2,
      entries: [
        {
          index: 0,
          model: 'offline',
          provider: 'openai',
          endpoint: 'custom',
          attempts: 2,
          estimate: {
            kind: 'priced',
            microcents: 5,
            basis: {
              inputTokensEstimate: 2,
              outputTokensReservation: 3,
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
});
const allowance = { kind: 'frozen', quote: quoted };
const deadline = { timeoutMs: 500, timeoutAction: 'reject', expiresAt: '2026-10-03T00:00:00.500Z' };
function row(input: Record<string, unknown>): RunEvent {
  return RunEventSchema.parse({ timestamp: TS, sequenceNumber: seq++, runId: RUN, ...input });
}
function paused(gateId = 'g1', nodeId = 'agent', patch: Record<string, unknown> = {}): RunEvent {
  return row({
    type: 'budget:authorization',
    gateId,
    nodeId,
    authorization: { state: 'paused', allowance, spentMicrocents: 2, limitMicrocents: 1, ...patch },
  });
}
function decided(gateId = 'g1', nodeId = 'agent', patch: Record<string, unknown> = {}): RunEvent {
  return row({
    type: 'budget:authorization',
    gateId,
    nodeId,
    authorization: {
      state: 'decided',
      allowance,
      decision: 'approved',
      decidedBy: 'offline',
      approvedAmountMicrocents: 10,
      ...patch,
    },
  });
}
function humanPause(
  gateId = 'g1',
  nodeId = 'agent',
  patch: Record<string, unknown> = {},
): RunEvent {
  return row({
    type: 'human_gate:paused',
    gateId,
    nodeId,
    gateType: 'approval',
    message: 'offline',
    ...patch,
  });
}
function budgetPause(
  gateId = 'g1',
  nodeId = 'agent',
  patch: Record<string, unknown> = {},
): RunEvent {
  return row({
    type: 'budget:paused',
    gateId,
    nodeId,
    spentMicrocents: 2,
    limitMicrocents: 1,
    ...patch,
  });
}
function resume(
  gateId: string | undefined = 'g1',
  nodeId = 'agent',
  patch: Record<string, unknown> = {},
): RunEvent {
  return row({
    type: 'human_gate:resumed',
    ...(gateId === undefined ? {} : { gateId }),
    nodeId,
    decision: 'approved',
    decidedBy: 'offline',
    ...patch,
  });
}
function legacyResume(nodeId = 'agent', patch: Record<string, unknown> = {}): RunEvent {
  return row({
    type: 'human_gate:resumed',
    nodeId,
    decision: 'approved',
    decidedBy: 'offline',
    ...patch,
  });
}
function completed(nodeId = 'agent'): RunEvent {
  return row({
    type: 'node:completed',
    nodeId,
    output: { real: 'artifact' },
    tokensUsed: { input: 1, output: 1 },
    costMicrocents: 1,
    durationMs: 1,
  });
}
function fold(events: readonly RunEvent[]): RunSuspensionReducer {
  const r = new RunSuspensionReducer();
  for (const e of events) r.apply(e);
  return r;
}
function corruption(events: readonly RunEvent[], code: string): void {
  try {
    fold(events);
    throw new Error('expected corrupt log refusal');
  } catch (error) {
    expect(error).toBeInstanceOf(RunSuspensionCorruptionError);
    if (!(error instanceof RunSuspensionCorruptionError)) throw error;
    expect(error.code).toBe(code);
    expect(error.message).not.toContain('PRIVATE');
  }
}
it('authority pause alone restores scalar quote and exact absolute deadline', () => {
  const r = fold([paused('g1', 'agent', deadline)]);
  expect(r.pendingGates(RUN)).toMatchObject([
    { nodeId: 'agent', gateId: 'g1', isBudgetGate: true, allowance, ...deadline },
  ]);
  expect(r.isResumable(RUN)).toBe(true);
  expect(Object.isFrozen(r.pendingGates(RUN))).toBe(true);
  expect(Object.isFrozen(r.pendingGates(RUN)[0])).toBe(true);
});
it('absent deadlines remain absent', () => {
  expect(fold([paused()]).pendingGates(RUN)[0]).not.toHaveProperty('expiresAt');
});
it('matching paused companions preserve authority values and do not downgrade budget identity', () => {
  const r = fold([
    paused('g1', 'agent', deadline),
    budgetPause('g1', 'agent', { allowanceQuote: quoted }),
    humanPause('g1', 'agent', { ...deadline, allowanceQuote: quoted }),
  ]);
  expect(r.pendingGates(RUN)).toMatchObject([{ isBudgetGate: true, allowance, ...deadline }]);
});
it('same approval-type ordinary gate remains ordinary', () => {
  expect(fold([humanPause('ordinary')]).pendingGates(RUN)).toMatchObject([{ isBudgetGate: false }]);
});
for (const decision of ['approved', 'rejected'] as const)
  it(`authority ${decision} alone resolves without a fabricated output`, () => {
    const r = new RunSuspensionReducer();
    const effect = r.apply(
      decided(
        'g1',
        'agent',
        decision === 'rejected' ? { decision, approvedAmountMicrocents: undefined } : {},
      ),
    );
    expect(effect).toMatchObject({ kind: 'budget_decided', decision });
    expect(effect).not.toHaveProperty('output');
    expect(r.pendingGates(RUN)).toEqual([]);
    expect(r.resolvedGateIds(RUN)).toEqual(['g1']);
    expect(r.budgetRejections(RUN)).toHaveLength(decision === 'rejected' ? 1 : 0);
  });
it('matching authority and companions cannot resolve a later gate', () => {
  const pause = paused(),
    decision = decided(),
    companion = resume('g1', 'agent', { allowanceQuote: quoted, approvedAmountMicrocents: 10 });
  const r = fold([pause, decision, companion, paused('g2')]);
  for (const e of [
    pause,
    decision,
    companion,
    budgetPause('g1', 'agent', { allowanceQuote: quoted }),
    humanPause('g1'),
  ])
    expect(r.apply(e)).toBeUndefined();
  expect(r.pendingGates(RUN)).toMatchObject([{ gateId: 'g2' }]);
  expect(r.pendingGates(RUN)).toHaveLength(1);
});
it('identified historical duplicates after a real node terminal produce no node transition', () => {
  const pause = paused(),
    decision = decided(),
    companion = resume();
  const r = fold([pause, decision, companion, completed()]);
  for (const e of [pause, decision, companion, humanPause(), budgetPause()])
    expect(r.apply(e)).toBeUndefined();
  expect(r.pendingGates(RUN)).toEqual([]);
});
it('an identified first authority copy matching an already-resolved legacy decision is historical', () => {
  const r = fold([budgetPause(), humanPause(), resume(), completed()]);
  const e = decided('g1', 'agent', {
    allowance: { kind: 'legacy_no_allowance' },
    approvedAmountMicrocents: undefined,
  });
  expect(r.apply(e)).toBeUndefined();
  expect(r.pendingGates(RUN)).toEqual([]);
});
it('three parallel gates retain independent budget and ordinary identities', () => {
  const r = fold([
    paused('g1', 'one'),
    paused('g2', 'two'),
    humanPause('g3', 'three'),
    decided('g1', 'one'),
    resume('g1', 'one'),
  ]);
  expect(r.pendingGates(RUN)).toMatchObject([
    { gateId: 'g2', isBudgetGate: true },
    { gateId: 'g3', isBudgetGate: false },
  ]);
  expect(r.isResumable(RUN)).toBe(true);
});
it('ordinary sibling remains discoverable after a budget decision and each companion', () => {
  const r = fold([paused(), humanPause('h', 'human')]);
  r.apply(decided());
  expect(r.isResumable(RUN)).toBe(true);
  r.apply(resume());
  expect(r.pendingGates(RUN)).toMatchObject([{ gateId: 'h', isBudgetGate: false }]);
  expect(r.isResumable(RUN)).toBe(true);
});
it('legacy missing key resolves exactly the currently outstanding gate at its sequence position', () => {
  const r = fold([budgetPause('g1'), legacyResume(), budgetPause('g2')]);
  expect(r.pendingGates(RUN)).toMatchObject([{ gateId: 'g2' }]);
  expect(r.resolvedGateIds(RUN)).toEqual(['g1']);
});
it('legacy missing key does not search already-resolved historical gates', () => {
  corruption([budgetPause(), resume(), legacyResume()], 'legacy_gate_join_missing');
});
it('legacy missing key with no outstanding match refuses', () => {
  corruption([legacyResume()], 'legacy_gate_join_missing');
});
it('legacy missing key with multiple outstanding matches refuses', () => {
  corruption([humanPause('g1'), humanPause('g2'), legacyResume()], 'legacy_gate_join_ambiguous');
});
it('legacy joining is isolated by node and run', () => {
  const r = fold([humanPause('g1', 'one'), humanPause('g2', 'two'), legacyResume('one')]);
  expect(r.pendingGates(RUN)).toMatchObject([{ nodeId: 'two' }]);
  r.apply(
    row({
      type: 'human_gate:paused',
      runId: 'other',
      nodeId: 'one',
      gateId: 'g1',
      gateType: 'approval',
      message: 'offline',
    }),
  );
  expect(r.pendingGates('other')).toHaveLength(1);
});
it('gate id reuse on another node refuses before matching a convenient history', () => {
  corruption(
    [paused('PRIVATE-gate', 'one'), paused('PRIVATE-gate', 'two')],
    'gate_identity_conflict',
  );
});
it('identified wrong-node decision refuses', () => {
  corruption([paused(), resume('g1', 'different')], 'gate_identity_conflict');
});
it('identified unknown gate refuses', () => {
  corruption([paused(), resume('missing')], 'legacy_gate_join_missing');
});
for (const patch of [{ spentMicrocents: 3 }, { limitMicrocents: 3 }] as const)
  it(`conflicting money companion ${Object.keys(patch)[0]} refuses`, () => {
    corruption([paused(), budgetPause('g1', 'agent', patch)], 'gate_state_conflict');
  });
it('conflicting quote companion refuses', () => {
  if (quoted.kind !== 'quoted') throw new Error('expected quote');
  const changed = {
    ...quoted,
    quote: { ...quoted.quote, amount: { kind: 'representable', microcents: 11 } },
  };
  corruption(
    [paused(), budgetPause('g1', 'agent', { allowanceQuote: changed })],
    'gate_state_conflict',
  );
});
for (const patch of [
  { timeoutMs: 501 },
  { timeoutAction: 'approve' },
  { expiresAt: '2026-10-03T00:00:00.501Z' },
])
  it(`conflicting deadline ${Object.keys(patch)[0]} refuses`, () => {
    corruption(
      [paused('g1', 'agent', deadline), humanPause('g1', 'agent', { ...deadline, ...patch })],
      'gate_state_conflict',
    );
  });
it('contradictory persisted authoritative decisions refuse', () => {
  corruption(
    [
      paused(),
      decided(),
      decided('g1', 'agent', { decision: 'rejected', approvedAmountMicrocents: undefined }),
    ],
    'gate_state_conflict',
  );
});
for (const patch of [
  { decision: 'rejected' },
  { decidedBy: 'another' },
  { approvedAmountMicrocents: 9 },
  { payload: { private: 'PRIVATE' } },
])
  it(`conflicting budget decision companion ${Object.keys(patch)[0]} refuses`, () => {
    corruption([paused(), decided(), resume('g1', 'agent', patch)], 'gate_state_conflict');
  });
for (const identified of [false, true])
  it(`historical budget input is rejection, without output or payload (identified=${identified})`, () => {
    const r = fold([budgetPause(), humanPause('sibling', 'human')]);
    const input = identified
      ? resume('g1', 'agent', { decision: 'input_provided', payload: { private: 'PRIVATE' } })
      : legacyResume('agent', { decision: 'input_provided', payload: { private: 'PRIVATE' } });
    expect(r.apply(input)).toMatchObject({ kind: 'budget_decided', decision: 'rejected' });
    expect(r.budgetRejections(RUN)).toEqual([{ nodeId: 'agent', gateId: 'g1' }]);
    expect(r.resolvedGateIds(RUN)).toEqual(['g1']);
    expect(r.pendingGates(RUN)).toMatchObject([{ gateId: 'sibling' }]);
    if (identified) expect(r.apply(input)).toBeUndefined();
  });
for (const basis of ['native_frozen', 'native_legacy', 'companion_frozen'] as const)
  it(`budget input still refuses on a ${basis} gate`, () => {
    const pause =
      basis === 'native_frozen'
        ? paused()
        : basis === 'native_legacy'
          ? paused('g1', 'agent', { allowance: { kind: 'legacy_no_allowance' } })
          : budgetPause('g1', 'agent', { allowanceQuote: quoted });
    corruption(
      [pause, resume('g1', 'agent', { decision: 'input_provided', payload: 'PRIVATE' })],
      'gate_state_conflict',
    );
  });
for (const legacy of [false, true])
  for (const authorityFirst of [false, true])
    for (const matching of [false, true])
      it(`companion amount is checked in both orders (legacy=${legacy}, authorityFirst=${authorityFirst}, matching=${matching})`, () => {
        const p = legacy ? budgetPause() : paused();
        const a = legacy
          ? decided('g1', 'agent', {
              allowance: { kind: 'legacy_no_allowance' },
              approvedAmountMicrocents: undefined,
            })
          : decided();
        const c = resume('g1', 'agent', {
          approvedAmountMicrocents: matching ? (legacy ? undefined : 10) : 999,
        });
        const events = [p, ...(authorityFirst ? [a, c] : [c, a])];
        if (!matching) corruption(events, 'gate_state_conflict');
        else {
          const r = fold(events);
          expect(r.pendingGates(RUN)).toEqual([]);
          expect(r.budgetRejections(RUN)).toEqual([]);
        }
      });
it('legacy rejection is retained as a fatal budget cause while ordinary sibling remains resumable', () => {
  const r = fold([
    budgetPause(),
    humanPause('sibling', 'human'),
    legacyResume('agent', { decision: 'rejected' }),
  ]);
  expect(r.budgetRejections(RUN)).toEqual([{ nodeId: 'agent', gateId: 'g1' }]);
  expect(r.pendingGates(RUN)).toMatchObject([{ gateId: 'sibling' }]);
  expect(r.isResumable(RUN)).toBe(true);
});
it('ordinary payload and rejection preserve their human transition without budget fatality', () => {
  const r = fold([humanPause()]);
  expect(
    r.apply(legacyResume('agent', { decision: 'rejected', payload: { answer: 'human' } })),
  ).toMatchObject({ kind: 'human_decided', event: { payload: { answer: 'human' } } });
  expect(r.budgetRejections(RUN)).toEqual([]);
});
it('matching legacy companions with actual key-order-different payloads are idempotent', () => {
  const r = fold([humanPause(), resume('g1', 'agent', { payload: { a: 1, b: 2 } }), completed()]);
  expect(r.apply(resume('g1', 'agent', { payload: { b: 2, a: 1 } }))).toBeUndefined();
});
for (const amountFirst of [false, true]) {
  it(`a decided authority witnesses optional-amount duplicates after completion (amountFirst=${amountFirst})`, () => {
    const companions = [amountFirst, !amountFirst].map((withAmount) =>
      resume('g1', 'agent', withAmount ? { approvedAmountMicrocents: 10 } : {}),
    );
    const r = fold([paused(), humanPause('sibling', 'human'), decided()]);
    const first = companions[0];
    const second = companions[1];
    if (first === undefined || second === undefined) throw new Error('missing companion fixture');
    expect(r.apply(first)).toBeUndefined();
    r.apply(completed());
    expect(r.apply(second)).toBeUndefined();
    expect(r.pendingGates(RUN)).toMatchObject([{ gateId: 'sibling', isBudgetGate: false }]);
    expect(r.budgetRejections(RUN)).toEqual([]);
  });
  it(`without a decided authority optional-amount duplicates remain corrupt (amountFirst=${amountFirst})`, () => {
    corruption(
      [
        paused(),
        ...[amountFirst, !amountFirst].map((withAmount) =>
          resume('g1', 'agent', withAmount ? { approvedAmountMicrocents: 10 } : {}),
        ),
      ],
      'gate_state_conflict',
    );
  });
  for (const patch of [
    { approvedAmountMicrocents: 999 },
    { decidedBy: 'another-user' },
    { decision: 'rejected' },
    { payload: { private: 'PRIVATE' } },
  ]) {
    it(`a decided authority still refuses conflicting duplicate ${Object.keys(patch)[0]} (amountFirst=${amountFirst})`, () => {
      const matching = resume('g1', 'agent', amountFirst ? { approvedAmountMicrocents: 10 } : {});
      const contradictory = resume('g1', 'agent', {
        ...(!amountFirst ? { approvedAmountMicrocents: 10 } : {}),
        ...patch,
      });
      corruption(
        [paused(), decided(), matching, completed(), contradictory],
        'gate_state_conflict',
      );
    });
  }
}
it('a node terminal retires its suspension without reopening on a delayed pause companion', () => {
  const r = fold([paused(), completed()]);
  expect(r.pendingGates(RUN)).toEqual([]);
  expect(r.apply(humanPause())).toBeUndefined();
});
it('terminal runs are never discovered as resumable', () => {
  const r = fold([paused(), row({ type: 'run:cancelled', durationMs: 1 })]);
  expect(r.isResumable(RUN)).toBe(false);
});
it('pending media is discovered and cleared only for its own node terminal', () => {
  const r = fold([
    row({
      type: 'media_job:submitted',
      nodeId: 'image',
      jobId: 'offline-job',
      provider: 'openai',
      model: 'offline',
      modality: 'image',
      startedAt: TS,
      deadlineAt: '2026-10-03T00:01:00.000Z',
      units: 2,
      acceptedCostMicrocents: 10,
    }),
    completed('other'),
  ]);
  expect(r.isResumable(RUN)).toBe(true);
  expect(r.pendingMediaJobs(RUN)).toHaveLength(1);
  r.apply(completed('image'));
  expect(r.isResumable(RUN)).toBe(false);
});

it('an authoritative absence of deadline cannot acquire a deadline from a companion', () => {
  corruption([paused(), humanPause('g1', 'agent', deadline)], 'gate_state_conflict');
});
it('an authoritative decision preserves the existing absolute deadline rather than removing it', () => {
  corruption([paused('g1', 'agent', deadline), decided()], 'gate_state_conflict');
});
it('an authoritative pause cannot remove a legacy companion deadline', () => {
  corruption([humanPause('g1', 'agent', deadline), paused()], 'gate_state_conflict');
});
it('persisted JSON round trips normalize absent scalar optional keys before matching companions', () => {
  if (quoted.kind !== 'quoted') throw new Error('expected quote');
  const first = quoted.quote.provenance.entries[0];
  if (first === undefined) throw new Error('expected entry');
  const withAbsentOptions = {
    kind: 'quoted',
    quote: {
      ...quoted.quote,
      provenance: {
        ...quoted.quote.provenance,
        entries: [
          {
            ...first,
            estimate: {
              ...first.estimate,
              basis: { ...first.estimate.basis, contextTierAboveTokens: undefined },
            },
          },
        ],
      },
    },
  };
  const pause = paused('g1', 'agent', {
    allowance: { kind: 'frozen', quote: withAbsentOptions },
    timeoutMs: undefined,
    timeoutAction: undefined,
    expiresAt: undefined,
  });
  const raw: unknown = JSON.parse(JSON.stringify(pause));
  const persisted = RunEventSchema.parse(raw);
  const r = fold([pause]);
  expect(r.apply(persisted)).toBeUndefined();
  expect(r.apply(budgetPause('g1', 'agent', { allowanceQuote: quoted }))).toMatchObject({
    kind: 'paused',
  });
});

for (const terminal of ['node:completed', 'node:failed', 'node:skipped'] as const)
  it(`a delayed media submission cannot resurrect ${terminal}`, () => {
    const end =
      terminal === 'node:completed'
        ? completed('image')
        : terminal === 'node:failed'
          ? row({
              type: terminal,
              nodeId: 'image',
              error: { code: 'internal', message: 'offline', retryable: false },
            })
          : row({ type: terminal, nodeId: 'image', reason: 'branch_not_taken' });
    const submit = row({
      type: 'media_job:submitted',
      nodeId: 'image',
      jobId: 'offline-job',
      provider: 'openai',
      model: 'offline',
      modality: 'image',
      startedAt: TS,
      deadlineAt: '2026-10-03T00:01:00.000Z',
    });
    const r = fold([submit, end]);
    r.apply(submit);
    expect(r.pendingMediaJobs(RUN)).toEqual([]);
    expect(r.isResumable(RUN)).toBe(false);
  });
it('a previously unknown gate cannot pause a terminal node', () => {
  corruption([completed(), paused('unrecorded')], 'gate_state_conflict');
});
it('a previously unknown authority decision cannot alter a terminal node', () => {
  corruption([completed(), decided('unrecorded')], 'gate_state_conflict');
});
for (const legacy of [false, true])
  it(`a rejected budget node cannot acquire a delayed media suspension (legacy=${legacy})`, () => {
    const end = legacy
      ? resume('g1', 'agent', { decision: 'rejected' })
      : decided('g1', 'agent', { decision: 'rejected', approvedAmountMicrocents: undefined });
    const r = fold([legacy ? budgetPause() : paused(), humanPause('sibling', 'human'), end]);
    r.apply(
      row({
        type: 'media_job:submitted',
        nodeId: 'agent',
        jobId: 'offline-job',
        provider: 'openai',
        model: 'offline',
        modality: 'image',
        startedAt: TS,
        deadlineAt: '2026-10-03T00:01:00.000Z',
      }),
    );
    expect(r.pendingMediaJobs(RUN)).toEqual([]);
    expect(r.pendingGates(RUN)).toMatchObject([{ gateId: 'sibling' }]);
  });
