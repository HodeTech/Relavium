/**
 * The opening guard on the Home's management popups ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
 * §3; review round 1 of MVP-11 unit 8, O4 and O6): what keeps a key typed before a popup appeared from answering it. `opening-guard.test.ts` drives
 * the three rules on the guard alone; this file proves the Home's popups are under them, through the real host and the real sessions:
 *
 * 1. a key that arrived before the first frame was shown does nothing, whatever it is (a highlight does not move, nothing is asked of the Home);
 * 2. an answer needs the popup to have been on screen for the settle (an arrow key moves at once);
 * 3. a key that arrived in the very instant the popup appeared is a key that was already on its way: it is not an answer, and it does not move
 *    the highlight either.
 */
import { describe, expect, it } from 'vitest';

import { POPUP_SELECT_SETTLE_MS } from './opening-guard.js';
import {
  DOWN,
  ENTER,
  fakeAgents,
  fakeWorkflows,
  homeRig,
  settleWork,
  workflowEntry,
  type HomeRig,
} from './home-popups.test-support.js';

/** The `/workflows` popup with three workflows, its read landed but its first frame not yet shown. */
async function workflowsNotShown() {
  const fakes = fakeWorkflows([
    workflowEntry('alpha'),
    workflowEntry('beta'),
    workflowEntry('gamma'),
  ]);
  const rig = homeRig();
  rig.open('workflows', { workflows: fakes.port });
  await settleWork();
  return { rig, fakes };
}

/** The frame is on screen: this is the instant the popup appeared. */
const shown = (rig: HomeRig): void => rig.host.shown(rig.host.getSnapshot());

describe('rule 1: a key that arrived before the first frame was shown does nothing', () => {
  it('/workflows: an arrow key, `Enter` and `[r]` pressed on a frame nobody has seen move nothing, open nothing and ask nothing', async () => {
    const { rig, fakes } = await workflowsNotShown();
    const first = rig.highlighted();
    expect(first).toBeDefined();
    rig.press('', DOWN);
    rig.press('', ENTER);
    rig.press('r');
    rig.press('h');
    expect(rig.highlighted(), 'the highlight did not move').toBe(first);
    expect(rig.step(), 'no detail was opened').toBe(0);
    expect(fakes.asked, 'nothing was asked of the Home').toEqual([]);
    // The same keys on the frame that is shown, once the settle has passed, do what they say: the guard was the only thing in the way.
    shown(rig);
    rig.clock.advance(POPUP_SELECT_SETTLE_MS + 200);
    rig.press('', DOWN);
    expect(rig.highlighted(), 'now the arrow key moves').not.toBe(first);
  });

  it('/agents: the same, `Enter` opens no detail', async () => {
    const fakes = fakeAgents();
    const rig = homeRig();
    rig.open('agents', { agents: fakes.port });
    await settleWork();
    rig.press('', ENTER);
    rig.press('c');
    expect(rig.step(), 'no detail was opened').toBe(0);
    expect(fakes.chats, 'no chat was asked for').toEqual([]);
  });
});

describe('rule 3: a key that arrived in the very instant the popup appeared is not an answer, and moves nothing', () => {
  it('/workflows: an arrow key at the instant the frame is shown is dropped; one a millisecond later moves; an answer waits out the settle', async () => {
    const { rig, fakes } = await workflowsNotShown();
    const first = rig.highlighted();
    shown(rig);
    rig.press('', DOWN);
    expect(
      rig.highlighted(),
      'a key at the very instant of the frame is a key already on its way',
    ).toBe(first);
    rig.clock.advance(1);
    rig.press('', DOWN);
    expect(rig.highlighted(), 'a millisecond later it is a person’s key').not.toBe(first);
    // An answer is rule 2's: not before the popup has been on screen for the settle, and then it counts.
    rig.press('r');
    expect(fakes.asked, 'half a second has not passed').toEqual([]);
    rig.clock.advance(POPUP_SELECT_SETTLE_MS);
    rig.press('r');
    expect(fakes.asked).toHaveLength(1);
  });
});
