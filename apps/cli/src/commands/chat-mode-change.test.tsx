import { cleanup, render as renderCapture } from 'ink-testing-library';
import { useStdout } from 'ink';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import { ChatApp } from '../render/tui/chat-ink.js';
import { MODE_CHANGE_RUNNING_NOTICE } from '../render/tui/chat-input.js';
import { waitFor } from '../render/tui/harness-util.js';
import {
  realModeControl,
  TURN_COMPLETED,
  TURN_STARTED,
  type RealModeControl,
} from './chat-mode-control.test-support.js';

// D64 round 2, D6: the engine takes its turn policy ONCE, when a turn starts, so a mode picked mid-turn cannot reach
// the running turn. The footer used to change at once anyway — `auto` -> `ask` showed "ask mode" while later writes
// of that same turn were still approved without a card. A mode change now waits for the turn to end, and says so.
const notices = (control: RealModeControl): string[] =>
  control.store
    .getSnapshot()
    .state.transcript.flatMap((entry) => (entry.role === 'notice' ? [entry.text] : []));

// ink-testing-library supplies an EventEmitter capture, not a native Writable; declare its working output capability
// the way the other mounted-ChatApp suites do.
function WritableCapture(props: { readonly children: ReactElement }): ReactElement {
  const { stdout } = useStdout();
  Object.defineProperty(stdout, 'writable', { value: true });
  return props.children;
}
const render = (tree: ReactElement): ReturnType<typeof renderCapture> =>
  renderCapture(<WritableCapture>{tree}</WritableCapture>);

const controls: RealModeControl[] = [];
async function modeControl(): Promise<RealModeControl> {
  const made = await realModeControl();
  controls.push(made);
  return made;
}
afterEach(async () => {
  cleanup();
  for (const made of controls.splice(0)) await made.dispose();
});

describe('the chat mode control while a turn runs (D6)', () => {
  it('names the notice the way the card names Esc', () => {
    expect(MODE_CHANGE_RUNNING_NOTICE).toBe(
      'Mode changes apply between turns \u00b7 Esc stops the running turn',
    );
  });

  it('applies a mode change between turns: the footer, the turn policy, and no notice', async () => {
    const m = await modeControl();
    expect(m.store.getSnapshot().mode).toBe('ask');
    const before = m.policyPushes();
    m.control.onModeChange('plan');
    expect(m.store.getSnapshot().mode).toBe('plan');
    expect(m.policyPushes(), 'the new mode reaches the session').toBe(before + 1);
    expect(notices(m)).toEqual([]);
  });

  it('refuses a mode change while a turn runs: footer and policy stay, a notice says why', async () => {
    const m = await modeControl();
    m.store.apply(TURN_STARTED);
    expect(m.store.getSnapshot().state.status).toBe('running');
    const before = m.policyPushes();
    m.control.onModeChange('auto');
    expect(
      m.store.getSnapshot().mode,
      'the footer must not claim a mode the turn is not under',
    ).toBe('ask');
    expect(m.policyPushes(), 'no policy is pushed for a turn that has already taken its own').toBe(
      before,
    );
    expect(notices(m)).toEqual([MODE_CHANGE_RUNNING_NOTICE]);
  });

  it('applies the mode again as soon as the turn has ended', async () => {
    const m = await modeControl();
    m.store.apply(TURN_STARTED);
    m.control.onModeChange('auto');
    m.store.apply(TURN_COMPLETED);
    expect(m.store.getSnapshot().state.status).toBe('idle');
    const before = m.policyPushes();
    m.control.onModeChange('auto');
    expect(m.store.getSnapshot().mode).toBe('auto');
    expect(m.policyPushes()).toBe(before + 1);
  });
});

describe('Shift+Tab in the mounted standalone chat while a turn runs (D6)', () => {
  const SHIFT_TAB = '\x1b[Z';
  async function mounted(m: RealModeControl): Promise<ReturnType<typeof render>> {
    const h = render(
      <ChatApp
        store={m.store}
        onSubmit={async () => {}}
        shouldStop={() => false}
        onExit={() => {}}
        onError={() => {}}
        onModeChange={m.control.onModeChange}
      />,
    );
    await waitFor(() => (h.lastFrame() ?? '').length > 0);
    return h;
  }

  it('cycles the mode when idle', async () => {
    const m = await modeControl();
    const h = await mounted(m);
    const before = m.policyPushes();
    h.stdin.write(SHIFT_TAB);
    await waitFor(() => m.store.getSnapshot().mode === 'plan');
    expect(m.policyPushes()).toBe(before + 1);
    expect(notices(m)).toEqual([]);
  });

  it('leaves the mode alone and says why while a turn runs', async () => {
    const m = await modeControl();
    const h = await mounted(m);
    m.store.apply(TURN_STARTED);
    const before = m.policyPushes();
    h.stdin.write(SHIFT_TAB);
    await waitFor(() => notices(m).length === 1);
    expect(notices(m)).toEqual([MODE_CHANGE_RUNNING_NOTICE]);
    expect(m.store.getSnapshot().mode).toBe('ask');
    expect(m.policyPushes()).toBe(before);
  });
});
