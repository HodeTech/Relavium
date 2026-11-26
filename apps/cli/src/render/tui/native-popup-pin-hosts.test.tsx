/**
 * The popup of ONE flow does not jump between its steps (MVP-11 unit 6, round 1, O5; ADR-0148 §4), mounted in the Home over the fake terminal:
 * the first prompt takes its own place, a taller step grows DOWN from it, a shorter one never shrinks it, a wait between two steps keeps the
 * height of the step before it, the flow's next popup starts fresh, a resize drops the pin, and an inline popup is untouched. The box is read
 * off the screen the terminal shows (its top edge, its bottom rule), never from the geometry that drew it.
 *
 * The Home's channel runs on the real clock, so the one wait of a flow (its opening settle) is real and named.
 */
import { describe, expect, it } from 'vitest';

import { framedFlow, type FramedChordFlow } from '../../home/framed-flow.js';
import { POPUP_SELECT_SETTLE_MS } from '../../popups/opening-guard.js';
import { NATIVE_PROMPT_CANCEL } from './native-prompt-channel.js';
import { KEYS, mountHome, type HomeMount } from './surface-matrix/home-host.js';
import type { Variant } from './surface-matrix/variants.js';

/** A real wait past the flow's opening settle (the hosts' channel clock is the real one). */
const PAST_THE_SETTLE_MS = POPUP_SELECT_SETTLE_MS + 100;
const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const TITLE = '/pin';
const ALT: Variant = { renderer: 'alt', color: false, size: { cols: 80, rows: 24 } };
/** The popup's columns at 80 wide: a 68-column box with a margin of six on each side. */
const BOX = { left: 6, width: 68 } as const;

interface Box {
  readonly top: number;
  readonly height: number;
}

/** The popup on screen: its top edge (the title), down to its bottom rule (a row of nothing but the rule across the box's columns). */
function boxOf(rows: readonly string[]): Box | undefined {
  const across = (row: string): string => row.slice(BOX.left, BOX.left + BOX.width).trim();
  const top = rows.findIndex((row) => across(row).startsWith(`- ${TITLE} -`));
  if (top < 0) return undefined;
  const bottom = rows.findIndex((row, index) => index > top && /^-+$/u.test(across(row)));
  return bottom < 0 ? undefined : { top, height: bottom - top + 1 };
}

function flowOn(m: HomeMount, names: readonly string[]): FramedChordFlow {
  const channel = m.channel;
  if (channel === undefined) throw new Error('no channel');
  return framedFlow(channel.flow, {
    title: TITLE,
    origin: 'home',
    stepNames: names,
    progress: 'manual',
  });
}

/** Wait until the popup of `step` is on the screen and measured, then read its box. */
async function boxAt(m: HomeMount, marker: string): Promise<Box> {
  await m.until(() => m.frame().join('\n').includes(marker));
  await m.settle();
  const box = boxOf(m.frame());
  if (box === undefined) throw new Error(`no popup box on\n${m.frame().join('\n')}`);
  return box;
}

const lines = (count: number): string[] =>
  Array.from({ length: count }, (_, index) => `fact ${String(index)}`);
const OPTIONS = [{ value: 'a', label: 'Alpha' }];

describe('a flow’s popup keeps its place and never shrinks (the overlay)', () => {
  it('the first prompt is centred as it was; a taller step grows down from its row; a wait and a shorter step keep the height; the Done step too', async () => {
    const m = mountHome(ALT, { nativePrompt: true });
    try {
      await m.settle();
      const flow = flowOn(m, ['One', 'Two', 'Three']);
      flow.begin();
      const first = flow.at(0).select({ message: 'STEP-ONE', options: OPTIONS });
      const one = await boxAt(m, 'STEP-ONE');
      await pause(PAST_THE_SETTLE_MS);
      m.key(KEYS.enter);
      await first;
      const second = flow
        .at(1)
        .select({ message: 'STEP-TWO', options: OPTIONS, details: lines(6) });
      const two = await boxAt(m, 'STEP-TWO');
      expect(two.top, 'grows DOWN from the first step’s row').toBe(one.top);
      expect(two.height).toBeGreaterThan(one.height);
      m.key(KEYS.enter);
      await second;
      flow.at(2).busy('STEP-WAIT');
      const wait = await boxAt(m, 'STEP-WAIT');
      expect(wait).toEqual(two);
      const done = flow.done({ message: 'STEP-DONE', lines: ['one line'] });
      const last = await boxAt(m, 'STEP-DONE');
      expect(last, 'a shorter Done step keeps the box of the tallest step').toEqual(two);
      m.key(KEYS.enter);
      await done;
      await flow.end();
    } finally {
      m.unmount();
    }
  });

  it('a long list drawn in a window does not set the height of the steps after it: the step after it is the box the first step had', async () => {
    const m = mountHome(ALT, { nativePrompt: true });
    try {
      await m.settle();
      const flow = flowOn(m, ['One', 'List', 'Three']);
      flow.begin();
      const first = flow.at(0).select({ message: 'STEP-ONE', options: OPTIONS });
      const one = await boxAt(m, 'STEP-ONE');
      await pause(PAST_THE_SETTLE_MS);
      m.key(KEYS.enter);
      await first;
      const longList = Array.from({ length: 60 }, (_, index) => ({
        value: `m${String(index)}`,
        label: `Model ${String(index)}`,
      }));
      const second = flow.at(1).select({ message: 'STEP-LIST', options: longList });
      const list = await boxAt(m, 'STEP-LIST');
      expect(list.height, 'the list takes the rows the terminal gives').toBeGreaterThan(
        one.height + 6,
      );
      m.key(KEYS.enter);
      await second;
      const third = flow.at(2).select({ message: 'STEP-THREE', options: OPTIONS });
      const three = await boxAt(m, 'STEP-THREE');
      expect(three, 'back to the size and the row the short steps have').toEqual(one);
      m.key(KEYS.enter);
      await third;
      await flow.end();
    } finally {
      m.unmount();
    }
  });

  it('the popup of a step too tall to fit below the first row is placed by the geometry, and that row is kept', async () => {
    const m = mountHome(ALT, { nativePrompt: true });
    try {
      await m.settle();
      const flow = flowOn(m, ['One', 'Two', 'Three']);
      flow.begin();
      const first = flow.at(0).select({ message: 'STEP-ONE', options: OPTIONS });
      const one = await boxAt(m, 'STEP-ONE');
      await pause(PAST_THE_SETTLE_MS);
      m.key(KEYS.enter);
      await first;
      const second = flow
        .at(1)
        .select({ message: 'STEP-TWO', options: OPTIONS, details: lines(15) });
      const two = await boxAt(m, 'STEP-TWO');
      expect(two.top + two.height).toBeLessThanOrEqual(ALT.size.rows);
      expect(two.top).toBeLessThan(one.top);
      m.key(KEYS.enter);
      await second;
      const third = flow.at(2).select({ message: 'STEP-THREE', options: OPTIONS });
      const last = await boxAt(m, 'STEP-THREE');
      expect(last).toEqual(two);
      flow.cancel();
      expect(await third).toBe(NATIVE_PROMPT_CANCEL);
      await flow.end();
    } finally {
      m.unmount();
    }
  });

  it('the flow’s next popup starts fresh: it is the size and the row its own first prompt gives it', async () => {
    const m = mountHome(ALT, { nativePrompt: true });
    try {
      await m.settle();
      const tall = flowOn(m, ['One', 'Two']);
      tall.begin();
      const a = tall.at(0).select({ message: 'TALL-ONE', options: OPTIONS, details: lines(12) });
      const tallBox = await boxAt(m, 'TALL-ONE');
      tall.cancel();
      await a;
      await tall.end();
      await m.until(() => boxOf(m.frame()) === undefined);
      const small = flowOn(m, ['One', 'Two']);
      small.begin();
      const b = small.at(0).select({ message: 'SMALL-ONE', options: OPTIONS });
      const smallBox = await boxAt(m, 'SMALL-ONE');
      expect(smallBox.height).toBeLessThan(tallBox.height);
      small.cancel();
      await b;
      await small.end();
    } finally {
      m.unmount();
    }
  });

  it('a resize drops the pin: the popup is drawn as its own step sizes it in the new terminal', async () => {
    let size = { cols: 80, rows: 24 };
    const listeners = new Set<() => void>();
    const m = mountHome(
      { ...ALT, size },
      {
        nativePrompt: true,
        getSize: () => size,
        subscribeResize: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
    );
    try {
      await m.settle();
      const flow = flowOn(m, ['One', 'Two']);
      flow.begin();
      const first = flow
        .at(0)
        .select({ message: 'STEP-ONE', options: OPTIONS, details: lines(10) });
      await boxAt(m, 'STEP-ONE');
      await pause(PAST_THE_SETTLE_MS);
      m.key(KEYS.enter);
      await first;
      const second = flow.at(1).select({ message: 'STEP-TWO', options: OPTIONS });
      const pinned = await boxAt(m, 'STEP-TWO');
      size = { cols: 80, rows: 30 };
      m.resize(80, 30);
      for (const listener of [...listeners]) listener();
      await m.until(() => {
        const box = boxOf(m.frame());
        return box !== undefined && box.height < pinned.height;
      });
      const after = boxOf(m.frame());
      expect(
        after?.height,
        'a smaller step is no longer held at the tall one’s height',
      ).toBeLessThan(pinned.height);
      flow.cancel();
      await second;
      await flow.end();
    } finally {
      m.unmount();
    }
  });
});

describe('an inline popup is the block it was', () => {
  it('each step takes the rows its own content needs (no pin): the taller step, then a shorter one', async () => {
    const m = mountHome(
      { renderer: 'inline', color: false, size: { cols: 80, rows: 24 } },
      { nativePrompt: true },
    );
    try {
      await m.settle();
      const flow = flowOn(m, ['One', 'Two']);
      flow.begin();
      const first = flow.at(0).select({ message: 'STEP-ONE', options: OPTIONS, details: lines(8) });
      await m.until(() => m.frame().join('\n').includes('STEP-ONE'));
      await m.settle();
      const tall = m.frame().filter((row) => row.trim() !== '').length;
      await pause(PAST_THE_SETTLE_MS);
      m.key(KEYS.enter);
      await first;
      const second = flow.at(1).select({ message: 'STEP-TWO', options: OPTIONS });
      await m.until(() => m.frame().join('\n').includes('STEP-TWO'));
      await m.settle();
      const short = m.frame().filter((row) => row.trim() !== '').length;
      expect(short).toBeLessThan(tall);
      flow.cancel();
      await second;
      await flow.end();
    } finally {
      m.unmount();
    }
  });
});

describe('the notice drawn in place of a popup below the floor names the keys that act there', () => {
  const SMALL: Variant = { renderer: 'alt', color: false, size: { cols: 60, rows: 20 } };

  it('the Done step says `Esc close`: its `Enter` is not delivered to a frame nobody can see, so the notice must not promise it', async () => {
    const m = mountHome(SMALL, { nativePrompt: true });
    try {
      await m.settle();
      const flow = flowOn(m, ['One', 'Done']);
      flow.begin();
      const done = flow.done({ message: 'Created', lines: ['one line'] });
      await m.until(() => m.frame().join('\n').includes('Terminal too small'));
      await m.settle();
      const text = m.frame().join('\n');
      expect(text).toContain('Terminal too small for this popup');
      expect(text).toContain('Esc close');
      expect(text).not.toContain('Enter / Esc close');
      expect(text).not.toContain('Enter');
      await pause(PAST_THE_SETTLE_MS);
      m.key(KEYS.escape);
      await done;
      await flow.end();
    } finally {
      m.unmount();
    }
  });

  it('a chord step says what Esc really does there, `Esc denies`, and names no answer', async () => {
    const m = mountHome(SMALL, { nativePrompt: true });
    try {
      await m.settle();
      const flow = flowOn(m, ['One', 'Two']);
      flow.begin();
      const card = flow.at(1).chord({
        message: 'Create these?',
        details: ['x'],
        allow: 'Create them',
        deny: 'Create nothing',
      });
      await m.until(() => m.frame().join('\n').includes('Terminal too small'));
      await m.settle();
      const text = m.frame().join('\n');
      expect(text).toContain('Esc denies');
      expect(text).not.toMatch(/Ctrl\+Y|Ctrl\+N|Create them/u);
      flow.cancel();
      expect(await card).toBe(NATIVE_PROMPT_CANCEL);
      await flow.end();
    } finally {
      m.unmount();
    }
  });
});
