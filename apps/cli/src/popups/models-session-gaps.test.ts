/**
 * The `/models` refresh row ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md) §3, §5;
 * [ADR-0064](../../../../docs/decisions/0064-live-model-catalog.md) §5c) where `models-session.test.ts` leaves it open (found by the step-5
 * round-1 mutation sweep): a refresh that FAULTED (the owner stopped, so it never landed) is over, not still in flight, so the row refreshes
 * again; nothing is stuck refreshing for the rest of the popup.
 */
import { describe, expect, it } from 'vitest';

import { DOWN, ENTER, fakeModels, modelsRig, settleWork, UP } from './models.test-support.js';
import { MODELS_REFRESH_ROW } from './models-popup.js';

describe('the refresh row after a refresh that failed', () => {
  it('refreshes again: the failed one is over, so the row is not held back as a refresh in flight', async () => {
    const fake = fakeModels();
    const rig = modelsRig(fake.member);
    const opened = rig.open();
    if (!opened.opened) throw new Error(`the popup did not open: ${opened.reason}`);
    rig.settle();
    await settleWork();
    // The refresh of stale providers the popup started on opening faults: the owner has it, and says so.
    fake.stale[0]?.reject(new Error('owner stopped'));
    await settleWork();
    expect(rig.failures).toHaveLength(1);
    for (let guard = 0; guard < 30 && rig.step()?.highlighted !== MODELS_REFRESH_ROW; guard += 1) {
      const rows = rig.step()?.rows ?? [];
      const at = rows.indexOf(rig.step()?.highlighted ?? '');
      rig.press('', rows.indexOf(MODELS_REFRESH_ROW) > at ? DOWN : UP);
    }
    expect(rig.step()?.highlighted).toBe(MODELS_REFRESH_ROW);
    rig.press('', ENTER);
    await settleWork();
    expect(fake.calls.filter((call) => call === 'refresh')).toHaveLength(1);
  });
});
