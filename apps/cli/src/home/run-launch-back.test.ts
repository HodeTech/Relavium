/**
 * A step back to `/run`'s workflow list lands on the workflow that was chosen, not on its first row (MVP-11 Step 6, round 1: the list of a
 * project with many workflows threw the person back to the top each time they stepped back from an input). The launch is the real one, on the
 * real native prompt channel with a clock the test moves; the catalog holds workflow texts in memory and the host starts nothing.
 */
import { parseWorkflow } from '@relavium/core';
import type { Key } from 'ink';
import { describe, expect, it, vi } from 'vitest';

import { POPUP_SELECT_SETTLE_MS } from '../popups/opening-guard.js';
import { createNativePromptChannel } from '../render/tui/native-prompt-channel.js';
import type { NativePromptSnapshot } from '../render/tui/native-prompt-channel.js';
import { createRunLaunch, LAUNCH_CANCELLED, type LaunchCatalog } from './run-launch.js';

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
const ESC: Key = { ...none, escape: true };
const DOWN: Key = { ...none, downArrow: true };

/** A workflow with one number to ask. */
const workflow = (id: string): string => `schema_version: '1.0'
workflow:
  id: ${id}
  inputs:
    - { name: n, type: number, required: true }
  nodes:
    - { id: start, type: input }
    - { id: out, type: output }
  edges:
    - { from: start, to: out }
`;
const WORKFLOWS: Readonly<Record<string, string>> = {
  'a.yaml': workflow('alpha'),
  'b.yaml': workflow('bravo'),
  'c.yaml': workflow('charlie'),
};

const catalog: LaunchCatalog = {
  list: () =>
    Object.entries(WORKFLOWS).map(([path, yaml]) => {
      const definition = parseWorkflow(yaml, { source: path });
      return { path, slug: definition.workflow.id, name: undefined, tags: [], valid: true };
    }),
  load: (path) => ({
    definition: parseWorkflow(WORKFLOWS[path] ?? '', { source: path }),
    sourceDigest: 'd'.repeat(64),
    fsScope: { tier: 'sandboxed', fromRepository: false },
  }),
};

/** The launch on the real channel; `show` is the host's acknowledgement of the frame on screen. */
function rig() {
  let clock = 10_000;
  const channel = createNativePromptChannel({ now: () => clock });
  let visible: NativePromptSnapshot | undefined;
  channel.ui.bindVisibility((snapshot) => snapshot === visible);
  const host = { start: vi.fn(() => Promise.reject(new Error('nothing starts here'))) };
  const launch = createRunLaunch({ flow: channel.flow, host, catalog });
  const snapshot = (): NativePromptSnapshot => channel.ui.getSnapshot();
  return {
    launch,
    host,
    snapshot,
    show: (): void => {
      visible = snapshot();
      channel.ui.shown(visible);
      clock += POPUP_SELECT_SETTLE_MS + 1;
    },
    key: (key: Key): boolean => channel.ui.input('', key),
  };
}

/** Let the launch's effects run (each answer reaches the machine a few microtasks later). */
async function until(
  r: ReturnType<typeof rig>,
  holds: (snapshot: NativePromptSnapshot) => boolean,
): Promise<void> {
  for (let turn = 0; turn < 50 && !holds(r.snapshot()); turn += 1)
    await new Promise<void>((resolve) => setImmediate(resolve));
  expect(holds(r.snapshot()), `the prompt is ${r.snapshot().kind}: ${r.snapshot().message}`).toBe(
    true,
  );
}

const onList = (s: NativePromptSnapshot): boolean =>
  s.kind === 'select' && s.message === 'Run which workflow?';

describe('a step back to the workflow list lands on the workflow that was chosen', () => {
  it('Esc from the first input returns to the list with the chosen workflow highlighted, and it is the one asked about again', async () => {
    const r = rig();
    const opened = r.launch.open();
    await until(r, onList);
    r.show();
    expect(r.snapshot().selected, 'the first time it opens on the first row').toBe(0);
    r.key(DOWN);
    r.key(DOWN);
    expect(r.snapshot().options[r.snapshot().selected]?.label).toContain('charlie');
    r.key(ENTER);
    await until(r, (s) => s.kind === 'text');
    r.show();
    r.key(ESC);
    await until(r, onList);
    const back = r.snapshot();
    expect(back.options[back.selected]?.label, 'the list opens on charlie, not on alpha').toContain(
      'charlie',
    );
    expect(back.selected).toBe(2);
    // and `Enter` asks about charlie's input again: a bare chain of Enters changes nothing
    r.show();
    r.key(ENTER);
    await until(r, (s) => s.kind === 'text');
    expect(r.snapshot().popup?.stepIndex).toBe(1);
    r.key(ESC);
    await until(r, onList);
    r.key(ESC);
    expect(await opened).toBe(LAUNCH_CANCELLED);
    expect(r.host.start).not.toHaveBeenCalled();
  });

  it('a workflow the `/workflows` popup chose skips the list once, and a step back lands the list on it', async () => {
    const r = rig();
    const opened = r.launch.open('bravo');
    await until(r, (s) => s.kind === 'text');
    r.show();
    r.key(ESC);
    await until(r, onList);
    const back = r.snapshot();
    expect(back.options[back.selected]?.label).toContain('bravo');
    r.show();
    r.key(ESC);
    expect(await opened).toBe(LAUNCH_CANCELLED);
  });
});
