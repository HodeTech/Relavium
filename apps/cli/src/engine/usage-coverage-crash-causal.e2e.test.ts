import { isUsageCoverageComplete } from '@relavium/shared';
import { describe, expect, it } from 'vitest';
import { atCut } from './fixtures/usage-coverage-worker-control.js';

describe('ADR-0104 invoked crash pending durability', () => {
  for (const cap of ['uncapped', 'capped'])
    for (const surface of ['run', 'session'] as const) {
      it(`${surface} ${cap}: actual invocation survives SIGKILL as pending uncertainty`, async () => {
        await atCut(surface, 'primary', 'invoked', cap, (state, barrier) => {
          expect(barrier.kind).toBe('CUT');
          expect(barrier.invocations).toBe(1);
          expect(state.coverage).toEqual({
            unverified: false,
            pendingInvocations: 1,
            unknownCalls: 0,
          });
          expect(state.models).toEqual([
            {
              model: 'usage-primary',
              coverage: { unverified: false, pendingInvocations: 1, unknownCalls: 0 },
            },
          ]);
          expect(state.actual).toBe(0);
          expect(state.calls).toBe(0);
          expect(isUsageCoverageComplete(state.coverage)).toBe(false);
        });
      }, 20_000);
    }
});
