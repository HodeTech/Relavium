/**
 * A popup never asks for a decision that changes nothing ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
 * §3, dated note of 2026-11-27; MVP-11 unit 8 §6, OD-25, Part F): the rule `/mode` follows, applied to `/models` and `/effort`.
 *
 * - `/models`, second step: the same model with a changed effort or a changed scope is a REAL job and stays valid (so there is no "skip the second
 *   step when the model is the same"); a second step in which NOTHING changed (same model, same effort, same scope) closes with an "Already …"
 *   line and writes nothing: `This chat` (a tier is the session's, nothing else), the bare Home's default, and now a chat's `New chats` for what is
 *   already the default of new chats (no writer, no card, no config rewritten);
 * - `/effort`: `Enter` on the tier in force closes without a second step, said as "Already at reasoning effort …" (its own file pins the words).
 */
import { describe, expect, it } from 'vitest';

import {
  CATALOG,
  DOWN,
  ENTER,
  fakeModels,
  GRADED,
  LEFT,
  modelsRig,
  NO_TIER,
  OPENAI,
  settleWork,
  UP,
} from './models.test-support.js';
import { alreadyDefaultAnnouncement } from './models-popup.js';

/** Open `/models` over `fake`, let the popup appear and its settle pass. */
function opened(fake: ReturnType<typeof fakeModels>) {
  const rig = modelsRig(fake.member);
  const result = rig.open();
  if (!result.opened) throw new Error(`the popup did not open: ${result.reason}`);
  rig.settle();
  return rig;
}

/** Move the highlight of the list to the row of `id` with the arrows. */
function highlight(rig: ReturnType<typeof modelsRig>, id: string): void {
  for (let guard = 0; guard < 20 && rig.step()?.highlighted !== id; guard += 1) {
    const rows = rig.step()?.rows ?? [];
    const at = rows.indexOf(rig.step()?.highlighted ?? '');
    rig.press('', rows.indexOf(id) > at ? DOWN : UP);
  }
  if (rig.step()?.highlighted !== id) throw new Error(`could not highlight ${id}`);
}

/** The chat's second step for the model in force, with `New chats` chosen, answered: `Enter`, `↓`, `Enter` (each a deliberate press). */
async function saveForNewChats(rig: ReturnType<typeof modelsRig>): Promise<void> {
  rig.press('', ENTER); // the model highlighted: on to its form
  rig.press('', DOWN); // `New chats`
  rig.settle();
  rig.press('', ENTER);
  await settleWork();
}

describe('/models, a chat’s `New chats`: what already is the default of new chats is not saved again', () => {
  it('the default model, its provider and its tier are the choice: the popup closes with the one line, and the writer never runs', async () => {
    const fake = fakeModels({
      current: GRADED,
      defaultModel: GRADED,
      defaultProvider: 'anthropic',
      defaultEffort: 'medium', // the form opens on the tier in force, `medium`
    });
    const rig = opened(fake);
    await saveForNewChats(rig);
    expect(rig.host.getSnapshot().open).toBe(false);
    expect(fake.saved).toEqual([]);
    expect(fake.calls).not.toContain('saveDefault');
    expect(rig.announced).toEqual([alreadyDefaultAnnouncement(GRADED)]);
    expect(rig.announced).toEqual([`Already the default: ${GRADED}`]);
    expect(fake.switched).toEqual([]);
    expect(fake.tiers).toEqual([]);
  });

  it('the same model with ANOTHER tier is a real job: the writer runs with the changed tier (the same-model path stays valid)', async () => {
    const fake = fakeModels({
      current: GRADED,
      defaultModel: GRADED,
      defaultProvider: 'anthropic',
      defaultEffort: 'medium',
    });
    const rig = opened(fake);
    rig.press('', ENTER);
    rig.press('', LEFT); // medium → low
    rig.press('', DOWN); // `New chats`
    rig.settle();
    rig.press('', ENTER);
    await settleWork();
    expect(fake.saved).toEqual([
      { modelId: GRADED, provider: 'anthropic', reasoningEffort: 'low' },
    ]);
  });

  it('the same model with a default that is ANOTHER provider’s is a real job (new chats would move back)', async () => {
    const fake = fakeModels({
      current: GRADED,
      defaultModel: GRADED,
      defaultProvider: 'openai',
      defaultEffort: 'medium',
    });
    const rig = opened(fake);
    await saveForNewChats(rig);
    expect(fake.saved).toHaveLength(1);
  });

  it('another model than the default is a real job, whatever the tier', async () => {
    const fake = fakeModels({
      current: GRADED,
      defaultModel: OPENAI,
      defaultProvider: 'openai',
      defaultEffort: 'medium',
    });
    const rig = opened(fake);
    await saveForNewChats(rig);
    expect(fake.saved).toEqual([
      { modelId: GRADED, provider: 'anthropic', reasoningEffort: 'medium' },
    ]);
  });

  it('a port that cannot say the default tier never claims nothing changed: the save goes on to the writer as it always did', async () => {
    const fake = fakeModels({
      current: GRADED,
      defaultModel: GRADED,
      defaultProvider: 'anthropic',
    });
    const rig = opened(fake);
    await saveForNewChats(rig);
    expect(fake.saved).toHaveLength(1);
    expect(rig.announced.join(' ')).not.toContain('Already');
  });

  it('a default model the port cannot read is not guessed to be the choice', async () => {
    const fake = fakeModels({ current: GRADED, defaultEffort: 'medium' });
    const rig = opened(fake);
    await saveForNewChats(rig);
    expect(fake.saved).toHaveLength(1);
  });

  it('a model with no tier to choose: the default model and provider alone decide', async () => {
    const fake = fakeModels({
      current: NO_TIER,
      provider: 'openai',
      defaultModel: NO_TIER,
      defaultProvider: 'openai',
    });
    const rig = opened(fake);
    highlight(rig, NO_TIER);
    rig.press('', ENTER);
    rig.press('', DOWN); // `New chats`
    rig.settle();
    rig.press('', ENTER);
    await settleWork();
    expect(fake.saved).toEqual([]);
    expect(rig.announced).toEqual([alreadyDefaultAnnouncement(NO_TIER)]);
  });

  it('a default read that throws is a change, never a no-op: the writer runs', async () => {
    const fake = fakeModels({
      current: GRADED,
      defaultProvider: 'anthropic',
      defaultEffort: 'medium',
    });
    const throwing = {
      ...fake.member,
      defaultModel: (): string => {
        throw new Error('the config does not parse');
      },
    };
    const rig = modelsRig(throwing);
    expect(rig.open().opened).toBe(true);
    rig.settle();
    await saveForNewChats(rig);
    expect(fake.saved).toHaveLength(1);
  });
});

describe('/models, This chat: a second step in which nothing changed closes with its “Already …” line (unchanged behaviour, pinned for the rule)', () => {
  it('the model in force at its tier: a bare Enter chain changes nothing and says so', () => {
    const fake = fakeModels();
    const rig = opened(fake);
    rig.press('', ENTER);
    rig.settle();
    rig.press('', ENTER);
    expect(rig.host.getSnapshot().open).toBe(false);
    expect(fake.tiers).toEqual([]);
    expect(fake.switched).toEqual([]);
    expect(fake.saved).toEqual([]);
    expect(rig.announced).toEqual(['Already at reasoning effort medium.']);
  });

  it('the model in force with no tier to choose: nothing changes, said so', () => {
    const fake = fakeModels({ current: NO_TIER, provider: 'openai' });
    const rig = opened(fake);
    rig.press('', ENTER);
    rig.settle();
    rig.press('', ENTER);
    expect(fake.calls.filter((call) => call !== 'load' && call !== 'refreshIfStale')).toEqual([]);
    expect(rig.announced).toEqual(['Already on gpt-4o.']);
  });
});

describe('/models on the bare Home: the default already in force is never written again', () => {
  it('the model and the tier in force: closes with “Already the default”, no writer', async () => {
    const fake = fakeModels({ scope: 'home', current: GRADED, effort: 'medium' });
    const rig = modelsRig(fake.member);
    expect(rig.open().opened).toBe(true);
    rig.settle();
    rig.press('', ENTER);
    rig.settle();
    rig.press('', ENTER);
    await settleWork();
    expect(fake.saved).toEqual([]);
    expect(rig.announced).toEqual([alreadyDefaultAnnouncement(GRADED)]);
    expect(CATALOG.length).toBeGreaterThan(0);
  });
});
