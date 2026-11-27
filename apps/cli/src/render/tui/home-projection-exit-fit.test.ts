import { describe, expect, it } from 'vitest';

import type { RunHostSnapshot } from '../../home/run-host.js';
import { exitGuardLines } from './home-projection.js';

// A case of the exit guard's legend fit. It lives in its own file because `home-projection.test.ts` is part of the usage-coverage cohort
// (`tools/usage-coverage-controls`: its collected case count is a pinned inventory); new cases go beside it, not into it.
const RUN_ID = '3f9a1c2e-5b7d-4e11-9a0c-77d2e3f4a5b6';
const running = (cancelling: boolean): RunHostSnapshot => ({
  launching: false,
  active: { leg: 'start', runId: RUN_ID, cancelling },
  last: undefined,
});

describe('the exit-guard card text: the stopping legend fits its width (ADR-0139 §6, unit 8)', () => {
  it('a stopping run’s legend drops its bound only when the whole of it is wider than the card: exactly as wide it stays whole, one column narrower it gives the bound up', () => {
    const whole = exitGuardLines('confirm', running(true), 13)[1] ?? '';
    expect(whole).toContain('(about 13s)');
    const exact = [...whole].length; // plain ASCII: columns are characters
    expect(exitGuardLines('confirm', running(true), 13, false, exact)[1]).toBe(whole);
    const narrower = exitGuardLines('confirm', running(true), 13, false, exact - 1)[1] ?? '';
    expect(narrower).not.toContain('(about');
    expect(narrower).toContain('Ctrl+Y');
    expect(narrower, 'the way back is never the part that is cut').toContain('stay');
  });
});
