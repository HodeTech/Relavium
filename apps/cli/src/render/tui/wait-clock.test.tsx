/**
 * The sheet host's one timer ([ADR-0147](../../../../../docs/decisions/0147-a-system-started-question-is-a-sheet-with-a-frame-and-a-wait-clock.md)
 * §2): one unref'd one-second timer, started only in the alternate screen while a sheet waits, re-rendering its host only when the quantised text
 * changes (once a second for the first minute, then once a minute), cleared when the sheet closes and when the host unmounts. Inline there is
 * no timer at all.
 *
 * Only the interval and the wall clock are faked: React and Ink keep their own scheduling.
 */
import { Text } from 'ink';
import { cleanup, render } from 'ink-testing-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { settleFrames } from './harness-util.js';
import { useWaitClock, WAIT_CLOCK_TICK_MS, type WaitClockForm } from './wait-clock.js';

const START = Date.parse('2026-11-27T09:00:00.000Z');
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
  vi.setSystemTime(START);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

let renders = 0;
/** Let `seconds` of the clock pass, one at a time, letting each repaint land before the next second. */
async function pass(seconds: number): Promise<void> {
  for (let i = 0; i < seconds; i += 1) {
    vi.advanceTimersByTime(WAIT_CLOCK_TICK_MS);
    await settleFrames(2);
  }
}
function Clock(props: Readonly<{ since: number | undefined; form: WaitClockForm }>) {
  renders += 1;
  const text = useWaitClock(props.since, props.form);
  return <Text>{text === '' ? '(no clock)' : text}</Text>;
}

describe('useWaitClock', () => {
  it('ticking: one repaint a second for the first minute, then one at each minute boundary', async () => {
    renders = 0;
    const view = render(<Clock since={START} form="ticking" />);
    await settleFrames(2);
    expect(view.lastFrame()).toBe('waiting 0:00');
    expect(vi.getTimerCount(), 'one timer, owned by the host').toBe(1);
    const first = renders;
    await pass(59);
    expect(view.lastFrame()).toBe('waiting 0:59');
    expect(renders - first, 'a repaint per second').toBe(59);
    const atMinute = renders;
    await pass(60); // to 1:59
    expect(view.lastFrame()).toBe('waiting 1m');
    expect(renders - atMinute, 'one repaint in a whole minute: at its boundary').toBe(1);
    await pass(10 * 60); // to 11:59
    expect(view.lastFrame()).toBe('waiting 11m');
    expect(renders - atMinute, 'then one a minute').toBe(11);
  });

  it('static (inline): the origin as `waiting since HH:MM`, and no timer at all', async () => {
    renders = 0;
    const view = render(<Clock since={START} form="static" />);
    await settleFrames(2);
    expect(view.lastFrame()).toMatch(/^waiting since \d\d:\d\d$/u);
    expect(vi.getTimerCount(), 'nothing repaints on a timer inline').toBe(0);
    const before = renders;
    await pass(10 * 60);
    expect(renders, 'not one repaint in ten minutes').toBe(before);
  });

  it('no sheet: no clock and no timer; the timer goes when the sheet closes and when the host unmounts', () => {
    const view = render(<Clock since={undefined} form="ticking" />);
    expect(view.lastFrame()).toBe('(no clock)');
    expect(vi.getTimerCount()).toBe(0);
    view.rerender(<Clock since={START} form="ticking" />);
    expect(vi.getTimerCount(), 'the sheet opened: its timer starts').toBe(1);
    view.rerender(<Clock since={undefined} form="ticking" />);
    expect(vi.getTimerCount(), 'the sheet closed: its timer is cleared').toBe(0);
    view.rerender(<Clock since={START} form="ticking" />);
    expect(vi.getTimerCount()).toBe(1);
    view.unmount();
    expect(vi.getTimerCount(), 'the host unmounted: its timer is cleared').toBe(0);
  });

  it('a new sheet has a new origin: the clock starts again from it', async () => {
    const view = render(<Clock since={START} form="ticking" />);
    await pass(30);
    expect(view.lastFrame()).toBe('waiting 0:30');
    view.rerender(<Clock since={Date.now()} form="ticking" />);
    await settleFrames(2);
    expect(view.lastFrame()).toBe('waiting 0:00');
    expect(vi.getTimerCount(), 'still one timer').toBe(1);
  });
});
