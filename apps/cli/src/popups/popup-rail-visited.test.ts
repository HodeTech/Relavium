/**
 * The rail marks a step done only when the popup was on it ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
 * §1.2; MVP-11 step 4, review round 2, observation): `/cost --release` opens on its line and drew `✓ Cost ╌╌ ◉ Release` although the Cost
 * step was never seen. A step the popup opened past is drawn as a step not done (`○`) until the popup has been on it.
 */
import { describe, expect, it } from 'vitest';

import { withGlyphForm } from '../render/tui/glyphs.js';
import { exitKey } from '../render/tui/legend.js';
import { createChordHistory } from '../render/tui/chord-guard.js';
import { popupBody, popupFrameLines } from './frame-model.js';
import { popupGeometry } from './geometry.js';
import { createNotificationChannel } from './notifications.js';
import { createPopupHost } from './popup-host.js';
import { openFrame, railOf, visitStep, type PopupFrame, type PopupSpec } from './popup-reducer.js';

const spec = (rail: 'all' | 'path', initialStep: number): PopupSpec => ({
  id: 'rail',
  title: '/cost',
  origin: 'chat',
  rail,
  initialStep,
  steps: [
    { name: 'Cost', content: { kind: 'report', lines: ['Session cost: $0.0001'] } },
    {
      name: 'Release',
      content: { kind: 'report', lines: ['This lifts about $0.0000045.'] },
      back: 0,
      holds: 'chord',
      chord: { verb: 'release' },
    },
    { name: 'Done', content: { kind: 'report', lines: ['Released.'] }, back: 1, final: true },
  ],
});

/** The rail row the frame draws for `frame`, in the plain glyph forms (`ok`, `@`, `o`). */
function railRow(frame: PopupFrame): string {
  const rail = railOf(frame);
  const geometry = popupGeometry({
    columns: 80,
    rows: 24,
    kind: 'standard',
    placement: 'overlay',
    rail: true,
    bodyRows: 1,
  });
  if (!geometry.fits) throw new Error('fits');
  const lines = withGlyphForm(true, () =>
    popupFrameLines(
      {
        title: '/cost',
        origin: 'chat',
        steps: rail.names,
        stepIndex: rail.index,
        done: rail.done,
        legend: { items: [], exit: exitKey.close() },
      },
      popupBody({ kind: 'report', lines: ['x'] }, { selected: 0, offset: 0 }, geometry),
      geometry,
    ),
  );
  return (lines[1]?.text ?? '').trim();
}

describe('railOf and the frame: done means visited', () => {
  it.each(['all', 'path'] as const)(
    'rail %s: a popup that opens on its second step draws the first as not done',
    (rail) => {
      const opened = openFrame(spec(rail, 1), 1);
      expect(railOf(opened).done.slice(0, 1)).toEqual([false]);
      expect(railRow(opened)).toMatch(/^o Cost \.\. @ Release/u);
    },
  );

  it('a step the popup was on is done once it moves past it', () => {
    const atCost = openFrame(spec('path', 0), 1);
    const onward = visitStep({ ...atCost, stepIndex: 1 });
    expect(railOf(onward).done).toEqual([true, false]);
    expect(railRow(onward)).toBe('ok Cost .. @ Release');
  });

  it('opened past, then back and forward again: the step it went back to is done from then on', () => {
    const opened = openFrame(spec('path', 1), 1);
    const back = visitStep({ ...opened, stepIndex: 0 });
    const forward = visitStep({ ...back, stepIndex: 1 });
    expect(forward.visited).toEqual([1, 0]);
    expect(railRow(forward)).toBe('ok Cost .. @ Release');
  });

  it('a frame built with no record of its visits draws every earlier step done (the native prompt’s frames)', () => {
    const opened = openFrame(spec('all', 1), 1);
    const unrecorded: PopupFrame = {
      spec: opened.spec,
      runId: opened.runId,
      stepIndex: opened.stepIndex,
      steps: opened.steps,
    };
    expect(railOf(unrecorded).done.slice(0, 1)).toEqual([true]);
  });

  it('visitStep is the same frame when the step is already counted', () => {
    const frame = openFrame(spec('all', 0), 1);
    expect(visitStep(frame)).toBe(frame);
  });
});

describe('the host counts every step it moves to', () => {
  it('`/cost --release`: the first step is not done until the popup has been on it', () => {
    const host = createPopupHost({
      now: () => 10_000,
      schedule: () => () => undefined,
      notifications: createNotificationChannel({ schedule: () => () => undefined }),
      history: createChordHistory(),
      placement: 'overlay',
    });
    host.bindVisibility(() => true);
    host.bindOpenGate(() => undefined);
    const opened = host.openForUser(spec('path', 1));
    if (!opened.opened) throw new Error('open');
    const frame = (): PopupFrame => {
      const live = host.getSnapshot().frame;
      if (live === undefined) throw new Error('closed');
      return live;
    };
    expect(railOf(frame()).done).toEqual([false, false]);
    opened.context.goToStep(0);
    opened.context.goToStep(1);
    expect(railOf(frame()).done).toEqual([true, false]);
  });
});
