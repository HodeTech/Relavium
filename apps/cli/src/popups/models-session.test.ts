/**
 * The `/models` popup's answers ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md) §2, §3,
 * §5, §6; [ADR-0064](../../../../docs/decisions/0064-live-model-catalog.md) §5c; [ADR-0059](../../../../docs/decisions/0059-cli-mid-session-model-reseat.md)):
 * over a real popup host on a manual clock, with a `/models` member of fakes.
 *
 * What it pins: the popup opens on the model in force and reads the catalog when it opens, never while drawn; the refresh of stale providers
 * is the popup's work (after a macrotask, on the owner) and lands only in the popup that started it; the refresh row refreshes, one at a time; a
 * config or a catalog that cannot be read is the error state; `Enter` on a model goes to the form, `Esc` comes back; the form's `Enter` waits
 * out the opening guard, closes the popup and applies through the port: the reseat for another model, the session's tier for another tier,
 * nothing (said so) for nothing changed, the writer of the default for `New chats` and on the bare Home (handed off, its result announced,
 * a refusal included), and on the Home the default in force is never written again. Nothing is announced through the popup's own context.
 */
import { describe, expect, it } from 'vitest';

import { formOptionIndex, type PopupForm } from './frame-model.js';
import {
  BUDGET,
  DOWN,
  ENTER,
  ESC,
  fakeModels,
  GRADED,
  LEFT,
  model,
  modelsRig,
  NO_TIER,
  OPENAI,
  RIGHT,
  settleWork,
  UP,
} from './models.test-support.js';
import { MODELS_READ_FAILED, MODELS_REFRESH_ROW, MODELS_SETTINGS_FAILED } from './models-popup.js';

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

const formOf = (rig: ReturnType<typeof modelsRig>): PopupForm => {
  const content = rig.step()?.content;
  if (content?.kind !== 'form') throw new Error(`a form, not ${String(content?.kind)}`);
  return content;
};

describe('opening', () => {
  it('opens on the model in force, the catalog read once as it opens and the refresh of stale providers not yet started', () => {
    const fake = fakeModels();
    const rig = modelsRig(fake.member);
    expect(rig.open().opened).toBe(true);
    expect(rig.step()).toMatchObject({ index: 0, highlighted: GRADED });
    // The read is the key's handler's; the refresh waits for a macrotask (popup work, never while a frame is drawn).
    expect(fake.calls).toEqual(['load']);
  });

  it('opens on the alias of a dated pin in force', () => {
    const fake = fakeModels({
      entries: [model(OPENAI, 'openai'), model('claude-sonnet-4-5', 'anthropic')],
      current: 'claude-sonnet-4-5-20250929',
    });
    const rig = modelsRig(fake.member);
    rig.open();
    expect(rig.step()?.highlighted).toBe('claude-sonnet-4-5');
  });

  it('a config that cannot be read is the error state, with nothing to refresh, and nothing applies', async () => {
    const fake = fakeModels({ currentThrows: true });
    const rig = modelsRig(fake.member);
    rig.open();
    expect(rig.step()?.content).toBe(MODELS_SETTINGS_FAILED);
    await settleWork();
    expect(fake.calls).toEqual([]);
    rig.settle();
    rig.press('', ENTER);
    expect(rig.step()?.index).toBe(0);
  });

  it('a catalog that cannot be read is the error state, never a note', async () => {
    const fake = fakeModels({ loadThrows: true });
    const rig = modelsRig(fake.member);
    rig.open();
    expect(rig.step()?.content).toBe(MODELS_READ_FAILED);
    await settleWork();
    expect(fake.calls).toEqual(['load']);
    expect(rig.announced).toEqual([]);
  });

  it('opens nothing for a chat whose host bound no switch, or whose session has no tier setter (the routing never sends one: a wiring mistake)', () => {
    expect(modelsRig(fakeModels({ noSwitch: true }).member).open()).toEqual({
      opened: false,
      reason: 'closed',
    });
    expect(modelsRig(fakeModels({ noSetter: true }).member).open()).toEqual({
      opened: false,
      reason: 'closed',
    });
    expect(modelsRig(undefined).open()).toEqual({ opened: false, reason: 'closed' });
  });
});

describe('the refresh (popup work; the list keeps its rows meanwhile)', () => {
  it('starts the refresh of stale providers after a macrotask, on the owner, and draws the list again from a second read', async () => {
    const fake = fakeModels();
    const rig = opened(fake);
    const before = rig.step()?.content;
    if (before?.kind !== 'list') throw new Error('a list');
    expect(before.heading?.text).toContain('refreshing…');
    await settleWork();
    expect(fake.calls).toEqual(['load', 'refreshIfStale']);
    fake.setEntries([...fake.member.load().entries, model('o3', 'openai')]);
    fake.stale[0]?.resolve({ providers: [{ provider: 'openai', status: 'failed', error: 'x' }] });
    await settleWork();
    const after = rig.step()?.content;
    if (after?.kind !== 'list') throw new Error('a list');
    expect(after.heading).toMatchObject({ status: 'warning' });
    expect(after.heading?.text).toContain("couldn't refresh OpenAI");
    expect(after.rows.map((row) => row.id)).toContain('o3');
  });

  it('the highlight stays on the model in force when the refreshed rows land (a new model sorts before it): a bare `Enter` chain still changes nothing', async () => {
    const fake = fakeModels();
    const rig = opened(fake);
    expect(rig.step()?.highlighted).toBe(GRADED);
    await settleWork();
    fake.setEntries([model('aaa-new-model', 'anthropic'), ...fake.member.load().entries]);
    fake.stale[0]?.resolve({ providers: [{ provider: 'anthropic', status: 'refreshed' }] });
    await settleWork();
    expect(rig.step()?.rows).toContain('aaa-new-model');
    expect(rig.step()?.highlighted).toBe(GRADED);
  });

  it('a result for a popup that has closed lands nowhere: the catalog is not read again', async () => {
    const fake = fakeModels();
    const rig = opened(fake);
    await settleWork();
    rig.press('', ESC);
    expect(rig.host.getSnapshot().open).toBe(false);
    fake.stale[0]?.resolve(undefined);
    await settleWork();
    // The popup's signal was aborted as it closed: the result is dropped before the catalog would be read again for it.
    expect(fake.calls).toEqual(['load', 'refreshIfStale']);
  });

  it('a refresh that fails is the owner’s fault, the list stays as it was and nothing is read again for it', async () => {
    const fake = fakeModels();
    const rig = opened(fake);
    await settleWork();
    fake.stale[0]?.reject(new Error('owner stopped'));
    await settleWork();
    expect(rig.failures).toHaveLength(1);
    expect(fake.calls).toEqual(['load', 'refreshIfStale']);
    const content = rig.step()?.content;
    expect(content?.kind).toBe('list');
    if (content?.kind === 'list') expect(content.heading?.text).not.toContain('refreshing');
  });

  it('`Enter` on the refresh row refreshes every provider (the list stays on its first step, saying so), one refresh at a time', async () => {
    const fake = fakeModels();
    const rig = opened(fake);
    await settleWork();
    fake.stale[0]?.resolve(undefined);
    await settleWork();
    highlight(rig, MODELS_REFRESH_ROW);
    rig.press('', ENTER);
    rig.press('', ENTER);
    await settleWork();
    expect(fake.calls.filter((call) => call === 'refresh')).toHaveLength(1);
    expect(rig.step()?.index).toBe(0);
    const refreshing = rig.step()?.content;
    if (refreshing?.kind !== 'list') throw new Error('a list');
    expect(refreshing.heading?.text).toContain('refreshing…');
    fake.forced[0]?.resolve({ providers: [] });
    await settleWork();
    const after = rig.step()?.content;
    if (after?.kind !== 'list') throw new Error('a list');
    expect(after.heading?.text).not.toContain('refreshing');
    // Once it has settled, the row refreshes again; nothing was switched, set or saved.
    rig.press('', ENTER);
    await settleWork();
    expect(fake.calls.filter((call) => call === 'refresh')).toHaveLength(2);
    expect(fake.switched).toEqual([]);
    expect(fake.saved).toEqual([]);
    // A letter is typing: `r` goes into the filter and refreshes nothing.
    rig.press('r', {});
    await settleWork();
    expect(fake.calls.filter((call) => call === 'refresh')).toHaveLength(2);
    expect(rig.step()?.state.filter).toBe('r');
  });
});

describe('the steps', () => {
  it('`Enter` on a model goes to its form; `Esc` comes back to the list with its highlight; `Esc` there closes and changes nothing', () => {
    const fake = fakeModels();
    const rig = opened(fake);
    highlight(rig, OPENAI);
    rig.press('', ENTER);
    expect(rig.step()?.index).toBe(1);
    expect(formOf(rig).summary).toContain('gpt-5');
    rig.press('', ESC);
    expect(rig.step()).toMatchObject({ index: 0, highlighted: OPENAI });
    rig.press('', ESC);
    expect(rig.host.getSnapshot().open).toBe(false);
    expect(fake.switched).toEqual([]);
    expect(fake.saved).toEqual([]);
    expect(rig.announced).toEqual([]);
  });

  it('a form entered again opens on its initial options: a scope or tier left on it for another model is not carried over', () => {
    const fake = fakeModels();
    const rig = opened(fake);
    highlight(rig, OPENAI);
    rig.press('', ENTER);
    const before = rig.host.getSnapshot().frame?.steps[1];
    rig.press('', RIGHT); // a tier
    rig.press('', DOWN); // "New chats"
    const moved = rig.host.getSnapshot().frame?.steps[1];
    expect(moved?.selected).toBe(1);
    expect(moved?.tab).not.toBe(before?.tab);
    rig.press('', ESC);
    highlight(rig, GRADED);
    rig.press('', ENTER);
    const again = rig.host.getSnapshot().frame?.steps[1];
    expect(again?.selected).toBe(0); // "This chat"
    expect(again?.tab).toBe(formOptionIndex(formOf(rig).tabs, undefined)); // the tier in force
  });

  it('a model this person cannot use cannot be highlighted, so it is never chosen', () => {
    const rig = opened(fakeModels());
    for (let i = 0; i < 10; i += 1) rig.press('', DOWN);
    expect(rig.step()?.highlighted).not.toBe('gemini-2.5-pro');
    expect(rig.step()?.highlighted).not.toBe('unavailable-section');
  });

  it('the filter finds a model by its provider', () => {
    const rig = opened(fakeModels());
    for (const letter of 'openai') rig.press(letter);
    // The row that refreshes the list stays under any filter (it was `Ctrl+R` on the picker this replaced).
    expect(rig.step()?.rows).toEqual([OPENAI, NO_TIER, MODELS_REFRESH_ROW]);
  });

  it('the filter finds a model by the name its provider gives it, which the row does not draw', () => {
    const fake = fakeModels({
      entries: [
        model(GRADED, 'anthropic', { displayName: 'Claude Sonnet 4.6' }),
        model(OPENAI, 'openai', { displayName: 'GPT-5' }),
      ],
    });
    const rig = opened(fake);
    for (const letter of 'sonnet 4.6') rig.press(letter);
    expect(rig.step()?.rows).toEqual([GRADED, MODELS_REFRESH_ROW]);
  });

  it('a filter that matches no model leaves the refresh row, which still asks the providers again', async () => {
    const fake = fakeModels();
    const rig = opened(fake);
    await settleWork();
    fake.stale[0]?.resolve(undefined); // the refresh the popup started on opening has landed: one refresh at a time
    await settleWork();
    for (const letter of 'zzzz') rig.press(letter);
    expect(rig.step()?.rows).toEqual([MODELS_REFRESH_ROW]);
    expect(rig.step()?.highlighted).toBe(MODELS_REFRESH_ROW);
    rig.settle();
    rig.press('', ENTER);
    await settleWork();
    expect(fake.calls).toContain('refresh');
  });

  it('an answer before the popup was seen and settled is dropped (the opening guard)', () => {
    const fake = fakeModels();
    const rig = modelsRig(fake.member);
    rig.open();
    rig.press('', ENTER);
    expect(rig.step()?.index).toBe(0);
  });
});

describe('applying in a chat (the popup closes first)', () => {
  it('`This chat` with another model is the host’s reseat, with the tier chosen; nothing is announced (the reseat writes its marker)', () => {
    const fake = fakeModels();
    const rig = opened(fake);
    highlight(rig, OPENAI);
    rig.press('', ENTER);
    rig.press('', RIGHT);
    rig.press('', UP); // another provider: "This chat" is chosen, not pre-selected (ADR-0148 §3)
    rig.settle(); // the form as it is now is seen and settles (its own frame)
    rig.press('', ENTER);
    expect(rig.host.getSnapshot().open).toBe(false);
    expect(fake.switched).toEqual([
      { modelId: OPENAI, provider: 'openai', reasoningEffort: 'high' },
    ]);
    expect(fake.calls.filter((call) => call !== 'load' && call !== 'refreshIfStale')).toEqual([
      'switch',
    ]);
    expect(rig.announced).toEqual([]);
  });

  it('a model with no tier is switched to with none (the reseat drops the old tier)', () => {
    const fake = fakeModels();
    const rig = opened(fake);
    highlight(rig, NO_TIER);
    rig.press('', ENTER);
    rig.press('', UP); // another provider: "This chat" is chosen, not pre-selected (ADR-0148 §3)
    rig.settle();
    rig.press('', ENTER);
    expect(fake.switched).toEqual([{ modelId: NO_TIER, provider: 'openai' }]);
  });

  it('with no tier in force the form opens on a stand-in: left alone, a bare chain sets nothing and says only that this is the model', async () => {
    const fake = fakeModels({ effort: undefined });
    const rig = opened(fake);
    await settleWork();
    rig.press('', ENTER);
    rig.settle();
    rig.press('', ENTER);
    expect(rig.host.getSnapshot().open).toBe(false);
    expect(fake.tiers).toEqual([]);
    expect(rig.announced).toEqual([`Already on ${GRADED}.`]);
  });

  it('with no tier in force, another model is switched to with the tier the form showed (ADR-0066 §6), and with the one it was moved to', () => {
    const left = fakeModels({ effort: undefined });
    const a = opened(left);
    highlight(a, OPENAI);
    a.press('', ENTER);
    a.press('', UP); // another provider: "This chat" is chosen (ADR-0148 §3)
    a.settle();
    a.press('', ENTER);
    expect(left.switched).toEqual([
      { modelId: OPENAI, provider: 'openai', reasoningEffort: 'medium' },
    ]);
    const moved = fakeModels({ effort: undefined });
    const b = opened(moved);
    highlight(b, OPENAI);
    b.press('', ENTER);
    b.press('', RIGHT);
    b.press('', UP);
    b.settle();
    b.press('', ENTER);
    expect(moved.switched).toEqual([
      { modelId: OPENAI, provider: 'openai', reasoningEffort: 'high' },
    ]);
  });

  it('`This chat` with the model in force and another tier is the session’s tier, said as `/effort` says it', () => {
    const fake = fakeModels();
    const rig = opened(fake);
    rig.press('', ENTER);
    rig.press('', LEFT);
    rig.settle(); // the form as it is now is seen and settles (its own frame)
    rig.press('', ENTER);
    expect(fake.tiers).toEqual(['low']);
    expect(fake.switched).toEqual([]);
    expect(rig.announced).toEqual(['Reasoning effort: low · applies to the next message']);
  });

  it('a bare `Enter` chain changes nothing and says so: the model in force with its tier', () => {
    const fake = fakeModels();
    const rig = opened(fake);
    rig.press('', ENTER);
    rig.settle();
    rig.press('', ENTER);
    expect(fake.tiers).toEqual([]);
    expect(fake.switched).toEqual([]);
    expect(fake.saved).toEqual([]);
    expect(rig.announced).toEqual(['Already at reasoning effort medium.']);
  });

  it('the model in force with no tier: nothing changes, and says so', () => {
    const fake = fakeModels({ current: NO_TIER, provider: 'openai' });
    const rig = opened(fake);
    rig.press('', ENTER);
    rig.settle();
    rig.press('', ENTER);
    expect(fake.calls.filter((call) => call !== 'load' && call !== 'refreshIfStale')).toEqual([]);
    expect(rig.announced).toEqual(['Already on gpt-4o.']);
  });

  it('`New chats` hands off to the writer once the key was handled, and announces its result; this chat is untouched', async () => {
    const fake = fakeModels();
    const rig = opened(fake);
    highlight(rig, BUDGET);
    rig.press('', ENTER);
    rig.press('', DOWN);
    rig.settle(); // the form as it is now is seen and settles (its own frame)
    rig.press('', ENTER);
    expect(rig.host.getSnapshot().open).toBe(false);
    // Handed off: the writer runs after a macrotask, never inside the key's handler.
    expect(fake.saved).toEqual([]);
    await settleWork();
    expect(fake.saved).toEqual([
      { modelId: BUDGET, provider: 'anthropic', reasoningEffort: 'medium' },
    ]);
    await settleWork();
    // `Default model: claude-sonnet-4-5 · applies to new chats` is 55 columns: the shorter sentence is said whole.
    expect(rig.announced).toEqual(['Default for new chats: claude-sonnet-4-5']);
    expect(fake.switched).toEqual([]);
    expect(fake.tiers).toEqual([]);
  });

  it('a refused default is said, and a writer that throws anyway is said as a failed save and is the owner’s fault (nobody is left without word)', async () => {
    const refused = fakeModels({
      save: () => Promise.resolve({ kind: 'refused', reason: 'symlink' }),
    });
    const rig = opened(refused);
    rig.press('', ENTER);
    rig.press('', DOWN);
    rig.settle(); // the form as it is now is seen and settles (its own frame)
    rig.press('', ENTER);
    await settleWork();
    await settleWork();
    expect(rig.announced).toEqual(['Default not saved: the config is a symbolic link']);

    const thrown = fakeModels({ save: () => Promise.reject(new Error('a defect')) });
    const other = opened(thrown);
    other.press('', ENTER);
    other.press('', DOWN);
    other.settle(); // the form as it is now is seen and settles (its own frame)
    other.press('', ENTER);
    await settleWork();
    await settleWork();
    expect(other.announced).toEqual(['The default model could not be saved']);
    expect(other.failures).toHaveLength(1);
  });

  it('the hand-off is entered on the port’s owner, so the host’s teardown joins the write; an owner that refuses starts no write, and says so', async () => {
    const fake = fakeModels();
    const rig = opened(fake);
    await settleWork();
    const before = rig.entered.length;
    rig.press('', ENTER);
    rig.press('', DOWN);
    rig.settle(); // the form as it is now is seen and settles (its own frame)
    rig.press('', ENTER);
    expect(rig.entered.length).toBe(before + 1);
    await settleWork();
    expect(fake.saved).toHaveLength(1);

    const refusing = fakeModels();
    const closing = modelsRig(refusing.member, { refuseEntry: true });
    closing.open();
    closing.settle();
    closing.press('', ENTER);
    closing.press('', DOWN);
    closing.settle(); // the form as it is now is seen and settles (its own frame)
    closing.press('', ENTER);
    await settleWork();
    expect(refusing.saved).toEqual([]);
    expect(closing.announced).toEqual(['The default model could not be saved']);
    expect(closing.failures.length).toBeGreaterThan(0);
  });

  it('a chat that cannot save a default offers no `New chats`: its `Enter` is this chat', () => {
    const fake = fakeModels({ noWriter: true });
    const rig = opened(fake);
    highlight(rig, OPENAI);
    rig.press('', ENTER);
    expect(formOf(rig).radio).toBeUndefined();
    rig.settle();
    rig.press('', ENTER);
    expect(fake.switched).toHaveLength(1);
  });
});

describe('applying on the bare Home (the default of new chats)', () => {
  it('another model is handed off to the writer, its tier with it', async () => {
    const fake = fakeModels({ scope: 'home' });
    const rig = opened(fake);
    highlight(rig, OPENAI);
    rig.press('', ENTER);
    expect(formOf(rig).radio).toBeUndefined();
    rig.settle();
    rig.press('', ENTER);
    await settleWork();
    await settleWork();
    expect(fake.saved).toEqual([
      { modelId: OPENAI, provider: 'openai', reasoningEffort: 'medium' },
    ]);
    expect(rig.announced).toEqual(['Default model: gpt-5 · applies to new chats']);
  });

  it('the default in force with its tier is not written again (a bare `Enter` chain changes nothing)', async () => {
    const fake = fakeModels({ scope: 'home' });
    const rig = opened(fake);
    rig.press('', ENTER);
    rig.settle();
    rig.press('', ENTER);
    await settleWork();
    expect(fake.saved).toEqual([]);
    expect(rig.announced).toEqual(['Already the default: claude-sonnet-4-6']);
  });

  it('the default in force with another tier is written (the tier is part of the default)', async () => {
    const fake = fakeModels({ scope: 'home' });
    const rig = opened(fake);
    rig.press('', ENTER);
    rig.press('', RIGHT);
    rig.settle(); // the form as it is now is seen and settles (its own frame)
    rig.press('', ENTER);
    await settleWork();
    expect(fake.saved).toEqual([
      { modelId: GRADED, provider: 'anthropic', reasoningEffort: 'high' },
    ]);
  });
});
