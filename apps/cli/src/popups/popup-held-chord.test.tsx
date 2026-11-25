/**
 * A key held through a popup cannot answer its confirmation line, and a key that resolved nothing does not lock one
 * ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md) §3, §8; MVP-11 step 4, review round 1),
 * on the real `/doctor` and `/cost` popups through their test rigs (read only):
 *
 * - **A held `Ctrl+Y`** (an OS key repeat of about a second) that lands on the step that ARMS the line answers nothing there, and each of its
 *   repeats is a refused affirmative on the host's history, so the lockout restarts on every repeat and the first repeat on the line, however
 *   long after the line's frame, is refused. Nothing is sent, nothing is released.
 * - **A control letter resolves nothing** (`[r]` runs the quick check, `[d]` arms the line): it does not lock the line it leads to, so a patient
 *   `Ctrl+Y` 900 ms after the line's frame answers; a key that DID resolve something (`Enter` on a row) still locks it for the lockout.
 */
import { describe, expect, it } from 'vitest';

import { COST_STEP } from './cost-popup.js';
import { DOCTOR_STEP } from './doctor-popup.js';
import {
  CTRL,
  ENTER,
  ESC,
  doctorRig,
  recordingProvider,
  settleWork,
  stubProbes,
  stubResolver,
} from './doctor.test-support.js';
import { fakeCost, reportRig, type ReportRig } from './report.test-support.js';

// Built at runtime (no contiguous secret literal: leakwatch).
const KEY = ['sk', 'ant', 'held', 'ABCDEF1234567890'].join('-');

/** The doctor on the Home with one keyed provider, its checks landed and its settle time passed. */
async function doctorOpened() {
  const r = doctorRig();
  const anthropic = recordingProvider('anthropic');
  const seam = stubResolver({ keys: { anthropic: KEY }, providers: { anthropic } });
  expect(r.open({ probes: stubProbes(seam.resolver) }).opened).toBe(true);
  r.show();
  await settleWork();
  r.clock.advance(600);
  return { r, anthropic };
}

/** `/cost` with something held, its reading landed and its settle time passed. */
async function costOpened(): Promise<{ r: ReportRig; fake: ReturnType<typeof fakeCost> }> {
  const r = reportRig();
  const fake = fakeCost({ held: 450 });
  r.open({ cost: fake.port }, { kind: 'cost', release: false });
  r.show();
  await settleWork();
  r.clock.advance(600);
  return { r, fake };
}

describe('a Ctrl+Y held through the step that arms the line answers nothing (H1)', () => {
  it.each([900, 1000, 1500, 1800])(
    'the doctor: repeats every %i ms across [d] send nothing',
    async (every) => {
      const { r, anthropic } = await doctorOpened();
      // The key goes down on the checks step and repeats; `[d]` is pressed a moment after one repeat.
      r.clock.advance(every);
      r.press('y', CTRL);
      r.clock.advance(50);
      r.press('d');
      await settleWork();
      expect(r.step()).toBe(DOCTOR_STEP.line);
      r.show();
      for (let repeat = 0; repeat < 8; repeat += 1) {
        r.clock.advance(repeat === 0 ? every - 50 : every);
        r.press('y', CTRL);
        await settleWork();
      }
      expect(anthropic.requests).toHaveLength(0);
    },
  );

  it.each([900, 1000, 1500, 1800])(
    '/cost: repeats every %i ms across [r] release nothing',
    async (every) => {
      const { r, fake } = await costOpened();
      r.clock.advance(every);
      r.press('y', CTRL);
      r.clock.advance(50);
      r.press('r');
      expect(r.step()).toBe(COST_STEP.release);
      r.show();
      for (let repeat = 0; repeat < 8; repeat += 1) {
        r.clock.advance(repeat === 0 ? every - 50 : every);
        r.press('y', CTRL);
      }
      expect(fake.release).not.toHaveBeenCalled();
      expect(fake.heldNow()).toBe(450);
    },
  );

  it('each repeat on a step that is not a line is a resolution on the host’s history', async () => {
    const { r } = await doctorOpened();
    for (let repeat = 0; repeat < 3; repeat += 1) {
      r.clock.advance(1000);
      r.press('y', CTRL);
      expect(r.history.lastResolvedAt).toBe(r.clock.now());
    }
    expect(r.step()).toBe(DOCTOR_STEP.checks);
  });

  it('released for the whole lockout, a deliberate Ctrl+Y on a line armed afresh answers', async () => {
    const { r, anthropic } = await doctorOpened();
    r.clock.advance(1000);
    r.press('y', CTRL);
    r.clock.advance(2100);
    r.press('d');
    await settleWork();
    r.show();
    r.clock.advance(900);
    r.press('y', CTRL);
    expect(anthropic.requests).toHaveLength(1);
  });
});

describe('a control letter resolves nothing; a key that resolved something does lock the line (H2)', () => {
  it('[r], then [d] 600 ms later, then Ctrl+Y 900 ms after the line’s frame: the line is answered', async () => {
    const { r, anthropic } = await doctorOpened();
    r.press('r');
    await settleWork();
    r.clock.advance(600);
    r.press('d');
    await settleWork();
    r.show();
    r.clock.advance(900);
    r.press('y', CTRL);
    expect(anthropic.requests).toHaveLength(1);
  });

  it('Enter on a row, back, [d], then Ctrl+Y within two seconds of the Enter: refused early, nothing sent', async () => {
    const { r, anthropic } = await doctorOpened();
    r.press('', ENTER);
    expect(r.step()).toBe(DOCTOR_STEP.detail);
    const enteredAt = r.clock.now();
    r.clock.advance(100);
    r.press('', ESC);
    expect(r.step()).toBe(DOCTOR_STEP.checks);
    r.clock.advance(100);
    r.press('d');
    await settleWork();
    r.show();
    r.clock.advance(900);
    expect(r.clock.now() - enteredAt).toBeLessThan(2000);
    r.press('y', CTRL);
    expect(anthropic.requests).toHaveLength(0);
    expect(r.step()).toBe(DOCTOR_STEP.checks);
  });

  it('a control letter leaves the history’s last resolution where it was', async () => {
    const { r } = await doctorOpened();
    const before = r.history.lastResolvedAt;
    r.press('r');
    await settleWork();
    expect(r.history.lastResolvedAt).toBe(before);
  });
});
