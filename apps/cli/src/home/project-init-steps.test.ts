/**
 * The steps of `/init` that the Done step's own test does not reach (MVP-11 unit 6, round 1: test gaps J01, J04, J12, J14). The popup is the real one, on
 * the real channel with a manual clock, over temporary folders; nothing touches an operator's home or working directory.
 *
 * - the refusal step (a folder that cannot be made a project): its words, its one way to close, no `.relavium` made, and either key closes it;
 * - only an `allow` creates: `Ctrl+N`, `Esc` and `Ctrl+C` on the confirmation each create nothing and say so in the one notification;
 * - the Done step's claim `No config or instruction files were written.` is a fact: the project holds directories only and the home holds nothing else;
 * - a write that is refused at the commit (the marker became a file after the card was drawn) is a FAILED Done step that says why, and creates nothing.
 */
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Key } from 'ink';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PROJECT_DIRECTORY_REMEDY } from '../config/project-directory.js';
import { flowText } from '../render/tui/flow-text.js';
import { createNativePromptChannel } from '../render/tui/native-prompt-channel.js';
import {
  INIT_CANCELLED,
  INIT_CLOSE_LABEL,
  INIT_CREATED,
  INIT_FAILED,
  INIT_REFUSED,
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
const ESCAPE: Key = { ...none, escape: true };
const CTRL: Key = { ...none, ctrl: true };

/** Where the manual clock is when the popup's first frame is shown, and the time that passes after it (past the opening settle and the chord's lockout). */
const SHOWN_AT = 10_000;
const PAST_THE_GUARDS_MS = 6000;
const WAIT_MS = 5000;

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Every file and directory under `dir`, recursively and sorted: the whole of "what was written". */
function tree(dir: string, prefix = ''): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) =>
      entry.isDirectory()
        ? [`${prefix}${entry.name}/`, ...tree(join(dir, entry.name), `${prefix}${entry.name}/`)]
        : [`${prefix}${entry.name}`],
    )
    .sort();
}

/** An operator home and a project folder inside it, with the real channel on a clock the test moves. */
function rig(folder: 'project' | 'home') {
  const root = mkdtempSync(join(tmpdir(), 'relavium-init-steps-'));
  roots.push(root);
  const home = join(root, 'home');
  const project = join(home, 'project');
  mkdirSync(project, { recursive: true });
  let clock = SHOWN_AT;
  const channel = createNativePromptChannel({ now: () => clock });
  channel.ui.bindVisibility(() => true);
  const cwd = folder === 'home' ? home : project;
  const result = runHomeProjectInit({
    cwd,
    home,
    flow: channel.flow,
    ui: channel.ui,
    flushVisible: () => Promise.resolve(),
    assertAdmitting: () => {},
  });
  return {
    home,
    project,
    channel,
    result,
    /** Wait for the step of `kind`, let it be painted, and let the guards pass. */
    async stepUp(kind: 'chord' | 'select') {
      await vi.waitFor(() => expect(channel.ui.getSnapshot().kind).toBe(kind), {
        timeout: WAIT_MS,
        interval: 2,
      });
      channel.ui.shown(channel.ui.getSnapshot());
      clock += PAST_THE_GUARDS_MS;
    },
    /** Wait for the last step (the persistent one), let it be painted, and let the guards pass; the step as published. */
    async lastStep() {
      await vi.waitFor(() => expect(channel.ui.getSnapshot().final).toBeDefined(), {
        timeout: WAIT_MS,
        interval: 2,
      });
      const step = channel.ui.getSnapshot();
      channel.ui.shown(step);
      clock += PAST_THE_GUARDS_MS;
      return step;
    },
  };
}

describe('a folder that cannot be made a project is a refusal step (J04)', () => {
  it.each([
    ['Esc', ESCAPE],
    ['Enter', ENTER],
  ])('%s closes it, and nothing is created', async (_name, key) => {
    const r = rig('home');
    await r.stepUp('select');
    const step = r.channel.ui.getSnapshot();
    expect(step.message).toBe(INIT_REFUSED);
    expect(step.final, 'drawn as what failed').toBe('failed');
    // The reason, in the product's words and through the scrub, under the sentence: why this folder cannot be a project.
    expect(step.details).toEqual([flowText(PROJECT_DIRECTORY_REMEDY)]);
    expect(step.details.join(' ')).toContain('global state');
    // One way to close it, and no way to go on.
    expect(step.options.map((option) => option.label)).toEqual([INIT_CLOSE_LABEL]);
    // On the first step (Check) of the popup.
    expect(step.popup).toMatchObject({ title: '/init', stepIndex: 0, stepCount: 3 });
    r.channel.ui.input('', key);
    expect(await r.result, 'the refusal said it all: no notification').toBeUndefined();
    expect(tree(r.home), 'the home holds nothing but the project folder it was made with').toEqual([
      'project/',
    ]);
  });
});

describe('only an allow creates (J01)', () => {
  it.each([
    ['Ctrl+N', 'n', CTRL],
    ['Esc', '', ESCAPE],
    ['Ctrl+C', 'c', CTRL],
  ])('%s on the confirmation creates nothing and says so once', async (_name, text, key) => {
    const r = rig('project');
    await r.stepUp('chord');
    expect(r.channel.ui.getSnapshot().kind).toBe('chord');
    r.channel.ui.input(text, key);
    expect(await r.result).toBe(INIT_CANCELLED);
    expect(tree(r.project)).toEqual([]);
  });
});

describe('the Done step’s claim of fact (J12)', () => {
  it('"No config or instruction files were written." is true: the project holds directories and nothing else, the home nothing besides', async () => {
    const r = rig('project');
    await r.stepUp('chord');
    r.channel.ui.input('y', CTRL);
    const step = await r.lastStep();
    expect(step.final).toBe('ok');
    expect(step.message).toBe(INIT_CREATED);
    // The words are pinned as written: a claim the person reads as a fact.
    expect(step.details).toContain('No config or instruction files were written.');
    r.channel.ui.input('', ENTER);
    expect(await r.result).toBeUndefined();
    // Every entry under the home is a directory (a name with a trailing slash): no file of any kind was written anywhere.
    const entries = tree(r.home);
    expect(entries).toEqual([
      'project/',
      'project/.relavium/',
      'project/.relavium/agents/',
      'project/.relavium/workflows/',
    ]);
    expect(entries.filter((entry) => !entry.endsWith('/'))).toEqual([]);
  });
});

describe('a write that is refused at the commit is a failed last step (J14)', () => {
  it('the marker became a file after the card was drawn: the step says so as what failed, with one way to close it, and the file is kept', async () => {
    const r = rig('project');
    await r.stepUp('chord');
    writeFileSync(join(r.project, '.relavium'), 'a file where the project directory would go');
    r.channel.ui.input('y', CTRL);
    const step = await r.lastStep();
    expect(step.final, 'drawn as what failed').toBe('failed');
    expect(step.message).toBe(INIT_FAILED);
    expect(step.details.join(' ')).toContain('The project .relavium marker is not a directory');
    expect(step.options.map((option) => option.label)).toEqual([INIT_CLOSE_LABEL]);
    r.channel.ui.input('', ENTER);
    expect(await r.result).toBeUndefined();
    expect(tree(r.project)).toEqual(['.relavium']);
  });
});
