/**
 * The last step of `/init` ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md) §6): it says
 * what was created and names the project directory once. A review (MVP-11 Step 6, round 1) found `.relavium/` three times on one screen: in
 * the sentence, in the list of what was created, and as the target. The popup is the real one, on the real channel with a manual clock, over a
 * temporary project; nothing touches an operator's home or working directory.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Key } from 'ink';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createNativePromptChannel } from '../render/tui/native-prompt-channel.js';
import {
  INIT_CREATED,
  INIT_NEXT,
  INIT_NO_FILES_WRITTEN,
  runHomeProjectInit,
} from './project-init.js';

const none: Key = {
  upArrow: false,
  downArrow: false,
  leftArrow: false,
  rightArrow: false,
  pageDown: false,
  pageUp: false,
  home: false,
  end: false,
  return: false,
  escape: false,
  ctrl: false,
  shift: false,
  tab: false,
  backspace: false,
  delete: false,
  meta: false,
  super: false,
  hyper: false,
  capsLock: false,
  numLock: false,
};
const ENTER: Key = { ...none, return: true };
const CTRL: Key = { ...none, ctrl: true };

/** Where the manual clock is when the popup's first frame is shown, and long after it (past the opening settle and the chord's lockout). */
const SHOWN_AT = 10_000;
const PAST_THE_GUARDS_MS = 6000;
const WAIT_MS = 5000;

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** `/init` run to its Done step in a fresh folder; the step as the channel published it. */
async function doneStepOfInit() {
  let clock = SHOWN_AT;
  const channel = createNativePromptChannel({ now: () => clock });
  channel.ui.bindVisibility(() => true);
  const root = mkdtempSync(join(tmpdir(), 'relavium-init-done-'));
  roots.push(root);
  const home = join(root, 'home');
  const cwd = join(home, 'project');
  mkdirSync(cwd, { recursive: true });
  const result = runHomeProjectInit({
    cwd,
    home,
    flow: channel.flow,
    ui: channel.ui,
    flushVisible: () => Promise.resolve(),
    assertAdmitting: () => {},
  });
  await vi.waitFor(() => expect(channel.ui.getSnapshot().kind).toBe('chord'), {
    timeout: WAIT_MS,
    interval: 2,
  });
  channel.ui.shown(channel.ui.getSnapshot());
  clock += PAST_THE_GUARDS_MS;
  channel.ui.input('y', CTRL);
  await vi.waitFor(() => expect(channel.ui.getSnapshot().final).toBeDefined(), {
    timeout: WAIT_MS,
    interval: 2,
  });
  const step = channel.ui.getSnapshot();
  channel.ui.shown(step);
  clock += PAST_THE_GUARDS_MS;
  channel.ui.input('', ENTER);
  expect(await result).toBeUndefined();
  return { step, created: existsSync(join(cwd, '.relavium')) };
}

describe('the last step of /init says each directory once', () => {
  it('names the project directory in ONE row: not in the sentence, not again as the target', async () => {
    const { step, created } = await doneStepOfInit();
    expect(created, 'the directories were created').toBe(true);
    expect(step.final).toBe('ok');
    expect(step.message).toBe(INIT_CREATED);
    const rows = [step.message, ...step.details];
    // `.relavium/` standing alone (not the start of `.relavium/workflows/`): the project directory itself
    const alone = rows.filter((row) => /\.relavium\/(?![\w-])/u.test(row));
    expect(alone, `every row that names the project directory: ${JSON.stringify(rows)}`).toEqual([
      '.relavium/',
    ]);
    expect(
      step.options.map((option) => option.hint),
      'the target is no option hint either',
    ).toEqual([undefined]);
  });

  it('lists what was created, then what was not written and what to type next', async () => {
    const { step } = await doneStepOfInit();
    expect(step.details).toEqual([
      '.relavium/',
      '.relavium/workflows/',
      '.relavium/agents/',
      INIT_NO_FILES_WRITTEN,
      INIT_NEXT,
    ]);
  });
});
