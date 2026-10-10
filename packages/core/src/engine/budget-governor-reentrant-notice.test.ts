import { describe, expect, it } from 'vitest';

import { prepareOutputCapPlan, type PricingOverlay } from '@relavium/llm';
import type { Budget } from '@relavium/shared';

import type { PreEgressInfo } from './agent-turn.js';
import {
  BudgetExceededError,
  BudgetGovernor,
  BudgetPauseError,
  type BudgetAdmission,
} from './budget-governor.js';

const MODEL = 'reentrant-notice-priced-model';
const OVERLAY: PricingOverlay = new Map([
  [
    MODEL,
    {
      provider: 'openai',
      nativeId: MODEL,
      displayName: 'Offline notice regression',
      contextWindowTokens: 10_000,
      maxOutputTokens: 10_000,
      inputPerMtokMicrocents: 1_000_000,
      outputPerMtokMicrocents: 1_000_000,
      cachedInputPerMtokMicrocents: 0,
    },
  ],
]);

function requestInfo(tokens: number, partial = false): PreEgressInfo {
  const identity = {
    model: MODEL,
    provider: 'openai' as const,
    endpoint: 'custom' as const,
    maxTokens: tokens,
    providerOptions: undefined,
  };
  return {
    ...identity,
    route: 'text',
    inputTokensEstimate: 0,
    maxTokensEstimate: undefined,
    outputCapPlan: prepareOutputCapPlan(identity),
    ...(partial ? { mediaUnitsEstimate: [{ modality: 'image' as const, units: 1 }] } : {}),
  };
}

type AdmissionOutcome =
  | { kind: 'admitted'; admission: BudgetAdmission | undefined }
  | { kind: 'refused'; error: unknown };

/** Attach the refusal handler synchronously, including when a notice re-enters before its caller returns. */
function observe(admission: Promise<BudgetAdmission | undefined>): Promise<AdmissionOutcome> {
  return admission.then<AdmissionOutcome, AdmissionOutcome>(
    (value) => ({ kind: 'admitted', admission: value }),
    (error: unknown) => ({ kind: 'refused', error }),
  );
}

describe('priced admission before reentrant host notices (ADR-0028)', () => {
  for (const policy of ['fail', 'pause_for_approval'] as const) {
    it(`${policy}: a partial-pricing callback cannot admit a sibling against the outer reservation`, async () => {
      let sibling: Promise<AdmissionOutcome> | undefined;
      let seenVerdict: string | undefined;
      const notices: { model: string; cap: number; modalities: readonly string[] | undefined }[] =
        [];
      const governor = new BudgetGovernor({
        budget: { max_cost_microcents: 1000, on_exceed: policy },
        resolvePrice: OVERLAY,
        emit: () => Promise.resolve(),
        onUnpriced: (model, cap, modalities) => {
          notices.push({ model, cap, modalities });
          seenVerdict = governor.evaluatePreEgress(requestInfo(600)).kind;
          sibling = observe(governor.checkPreEgress(requestInfo(600)));
        },
      });

      const outer = await governor.checkPreEgress(requestInfo(600, true));
      expect(outer?.reservedMicrocents).toBe(600);
      expect(notices).toEqual([{ model: MODEL, cap: 1000, modalities: ['image'] }]);
      expect(seenVerdict).toBe(policy === 'fail' ? 'fail' : 'pause');
      if (sibling === undefined) throw new Error('expected synchronous notice reentry');
      const outcome = await sibling;
      expect(outcome.kind).toBe('refused');
      if (outcome.kind === 'admitted') {
        outcome.admission?.release();
        throw new Error('sibling bypassed the live outer reservation');
      }
      expect(outcome.error).toBeInstanceOf(
        policy === 'fail' ? BudgetExceededError : BudgetPauseError,
      );
      outer?.release();
      const retry = await governor.checkPreEgress(requestInfo(600, true));
      expect(retry?.reservedMicrocents).toBe(600);
      expect(notices).toHaveLength(1);
      retry?.release();
    });

    it(`${policy}: a refused outer call still announces its gap without reserving its estimate`, async () => {
      let sibling: Promise<AdmissionOutcome> | undefined;
      let seenVerdict: string | undefined;
      let notices = 0;
      const governor = new BudgetGovernor({
        budget: { max_cost_microcents: 1000, on_exceed: policy },
        resolvePrice: OVERLAY,
        emit: () => Promise.resolve(),
        onUnpriced: () => {
          notices += 1;
          seenVerdict = governor.evaluatePreEgress(requestInfo(600)).kind;
          sibling = observe(governor.checkPreEgress(requestInfo(600)));
        },
      });
      governor.updateCost(200);

      await expect(governor.checkPreEgress(requestInfo(900, true))).rejects.toBeInstanceOf(
        policy === 'fail' ? BudgetExceededError : BudgetPauseError,
      );
      expect(notices).toBe(1);
      expect(seenVerdict).toBe('allow');
      if (sibling === undefined) throw new Error('expected refusal notice');
      const outcome = await sibling;
      expect(outcome.kind).toBe('admitted');
      if (outcome.kind !== 'admitted') throw new Error('refused outer call leaked a reservation');
      expect(outcome.admission?.reservedMicrocents).toBe(600);
      outcome.admission?.release();
    });
  }

  for (const rejectWrite of [false, true]) {
    it(`warn: notice reentry awaits the shared durable warning, rejection=${String(rejectWrite)}`, async () => {
      let finishWrite: (() => void) | undefined;
      const pendingWrite = new Promise<void>((resolve, reject) => {
        finishWrite = () =>
          rejectWrite ? reject(new Error('offline warning write failed')) : resolve();
      });
      let writes = 0;
      let sibling: Promise<AdmissionOutcome> | undefined;
      let seenVerdict: string | undefined;
      const governor = new BudgetGovernor({
        budget: { max_cost_microcents: 1000, on_exceed: 'warn' },
        resolvePrice: OVERLAY,
        emit: () => {
          writes += 1;
          return pendingWrite;
        },
        onUnpriced: () => {
          seenVerdict = governor.evaluatePreEgress(requestInfo(400)).kind;
          sibling = observe(governor.checkPreEgress(requestInfo(400)));
        },
      });
      governor.updateCost(500);

      const outer = observe(governor.checkPreEgress(requestInfo(600, true)));
      if (sibling === undefined || finishWrite === undefined)
        throw new Error('expected synchronous notice reentry and owned warning write');
      let siblingFinished = false;
      void sibling.then(() => {
        siblingFinished = true;
      });
      await Promise.resolve();
      await Promise.resolve();
      expect(seenVerdict).toBe('warn');
      expect(writes).toBe(1);
      expect(siblingFinished).toBe(false);
      finishWrite();
      const outcomes = await Promise.all([outer, sibling]);
      expect(outcomes.map((outcome) => outcome.kind)).toEqual(
        rejectWrite ? ['refused', 'refused'] : ['admitted', 'admitted'],
      );
      for (const outcome of outcomes) {
        if (outcome.kind === 'admitted') outcome.admission?.release();
        else expect(outcome.error).toHaveProperty('message', 'offline warning write failed');
      }
      // Both released/refused attempts restore the same headroom; no ghost reservation survives a failed write.
      expect(governor.evaluatePreEgress(requestInfo(500)).kind).toBe('allow');
      const retry = await governor.checkPreEgress(requestInfo(500));
      expect(retry?.reservedMicrocents).toBe(500);
      retry?.release();
    });
  }

  it('a throwing partial-pricing notice preserves and deduplicates the priced reservation', async () => {
    let notices = 0;
    let seenVerdict: string | undefined;
    const governor = new BudgetGovernor({
      budget: { max_cost_microcents: 1000, on_exceed: 'fail' } satisfies Budget,
      resolvePrice: OVERLAY,
      emit: () => Promise.resolve(),
      onUnpriced: () => {
        notices += 1;
        seenVerdict = governor.evaluatePreEgress(requestInfo(600)).kind;
        throw new Error('offline renderer failure');
      },
    });
    const admission = await governor.checkPreEgress(requestInfo(600, true));
    expect(admission?.reservedMicrocents).toBe(600);
    expect(seenVerdict).toBe('fail');
    await expect(governor.checkPreEgress(requestInfo(600, true))).rejects.toBeInstanceOf(
      BudgetExceededError,
    );
    expect(notices).toBe(1);
    admission?.release();
    const retry = await governor.checkPreEgress(requestInfo(600, true));
    expect(retry?.reservedMicrocents).toBe(600);
    retry?.release();
  });
});
