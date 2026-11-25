/**
 * The `/cost` popup's state machine on a manual clock ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
 * §3, §6; MVP-11 step 4b): the spend read in the popup's own work, `[r]` offered only when something is held, the release a confirmed step that
 * only `Ctrl+Y` answers through the host's chord guard, the in-flight re-check at the answer, the result, and nothing written anywhere but the popup.
 * The host's own guard layers are pinned by `doctor-session.test.ts` and `popup-chord-step.test.ts`; what is pinned here is that THIS popup's
 * step is one, that nothing but the chord reaches the release, and what the answer does.
 */
import { describe, expect, it, vi } from 'vitest';

import { CliError } from '../process/errors.js';
import { COST_STEP } from './cost-popup.js';
import { CTRL, ENTER, ESC } from './doctor.test-support.js';
import { popupLegend } from './popup-reducer.js';
import { CHORD_STEP_WINDOW_MS } from './popup-host.js';
import {
  costReading,
  costRow,
  fakeCost,
  reportRig,
  settleWork,
  type ReportRig,
} from './report.test-support.js';

// Built at runtime (no contiguous secret literal: leakwatch).
const SECRET = ['sk', 'ant', 'cost', 'ABCDEF1234567890XYZ'].join('-');

const ctrlY = (r: ReportRig): boolean => r.press('y', CTRL);

/** Open `/cost`, show its frame and let the read land; the opening guard's settle time passes. */
async function opened(held = 450, options: { durabilityBroken?: boolean } = {}) {
  const r = reportRig();
  const fake = fakeCost({ held, ...options });
  r.open({ cost: fake.port }, { kind: 'cost', release: false });
  r.show();
  await settleWork();
  r.clock.advance(600);
  return { r, fake };
}

/** Press `[r]`, let its frame be acknowledged and wait out `after` ms: the dwell of the line. Returns the time of the acknowledgement. */
function arm(r: ReportRig, after = 0): number {
  r.press('r');
  r.show();
  const at = r.clock.now();
  r.clock.advance(after);
  return at;
}

describe('the report (ADR-0148 §10)', () => {
  it('reads in the work the popup starts: nothing is read while it opens or is drawn, and the step says loading until the reading lands', async () => {
    const r = reportRig();
    const fake = fakeCost({ held: 450 });
    r.open({ cost: fake.port }, { kind: 'cost', release: false });
    expect(fake.read).not.toHaveBeenCalled();
    expect(r.content().kind).toBe('loading');
    r.show();
    r.host.getSnapshot();
    expect(fake.read).not.toHaveBeenCalled();
    await settleWork();
    expect(fake.read).toHaveBeenCalledTimes(1);
    expect(r.content().kind).toBe('report');
    // Moving through it, drawing it again and a resize read nothing more.
    r.clock.advance(600);
    r.press('', { downArrow: true });
    r.show();
    r.host.resized(80, 24);
    expect(fake.read).toHaveBeenCalledTimes(1);
  });

  it('shows the total, the held estimate and the model, in the words of the notice', async () => {
    const { r } = await opened(450);
    const words = r.words();
    expect(words).toContain('Session cost: $0.0001');
    expect(words).toContain('claude-opus-4-8');
    expect(words).toContain('~$0.0000045 estimated, possibly billed');
  });

  it('offers [r] release held estimates only when something is held', async () => {
    const held = await opened(450);
    expect(held.r.controls()).toEqual(['r']);
    const frame = held.r.host.getSnapshot().frame;
    expect(frame && popupLegend(frame).items).toContainEqual({
      keys: 'r',
      verb: 'release held estimates',
    });

    const none = await opened(0);
    expect(none.r.controls()).toEqual([]);
    const bare = none.r.host.getSnapshot().frame;
    expect(bare && JSON.stringify(popupLegend(bare).items)).not.toContain('release');
    expect(none.r.words()).not.toContain('release');
    // The key does nothing at all there: no step, no release, no notification.
    none.r.press('r');
    expect(none.r.step()).toBe(COST_STEP.cost);
    expect(none.fake.calls).toEqual(['read']);
    expect(none.r.notifications.getSnapshot().current).toBeUndefined();
  });

  it('offers [r] for a record known not to be durable, even where the rows hold nothing', async () => {
    const { r } = await opened(0, { durabilityBroken: true });
    expect(r.controls()).toEqual(['r']);
    expect(r.words()).toContain('could not be written durably');
  });

  it('says a failed read by its CODE only, never its message, and tells the work owner', async () => {
    const r = reportRig();
    const failure = vi.fn();
    const read = vi.fn(() => {
      throw new CliError('invalid_invocation', `PRIVATE /tmp/session-db ${SECRET}`);
    });
    r.open(
      { cost: { read, release: vi.fn() }, workOwner: { failure, enter: (op) => op() } },
      { kind: 'cost', release: false },
    );
    r.show();
    await settleWork();
    expect(r.content().kind).toBe('error');
    expect(r.words()).toContain('Could not read the session cost: invalid_invocation');
    expect(r.words()).not.toContain('PRIVATE');
    expect(r.words()).not.toContain('/tmp');
    expect(r.words()).not.toContain(SECRET);
    expect(failure).toHaveBeenCalledOnce();
    expect(r.controls()).toEqual([]);
  });

  it('says a fault that is not ours as `unexpected error`', async () => {
    const r = reportRig();
    r.open(
      {
        cost: {
          read: () => {
            throw new TypeError('database is locked at /private/path');
          },
          release: vi.fn(),
        },
      },
      { kind: 'cost', release: false },
    );
    await settleWork();
    expect(r.words()).toContain('unexpected error');
    expect(r.words()).not.toContain('/private/path');
  });

  it('lands nothing in a popup that has closed or been replaced (a stale run)', async () => {
    const r = reportRig();
    let release: (reading: ReturnType<typeof costReading>) => void = () => undefined;
    const slow = {
      read: () =>
        new Promise<ReturnType<typeof costReading>>((resolve) => {
          release = resolve;
        }),
      release: vi.fn(),
    };
    const first = r.open({ cost: slow }, { kind: 'cost', release: false });
    r.show();
    await settleWork();
    r.press('', ESC); // `Esc` on the first step closes it
    expect(r.host.getSnapshot().open).toBe(false);
    // A second popup opens on the same host, with a reading of its own.
    const second = fakeCost({ held: 0 });
    r.open({ cost: second.port }, { kind: 'cost', release: false });
    r.show();
    await settleWork();
    const before = r.words();
    expect(first.opened && second.read.mock.calls.length).toBe(1);
    // The first popup's read lands late, with a held estimate: it lands nowhere.
    release(costReading(9_999));
    await settleWork();
    expect(r.words()).toBe(before);
    expect(r.controls()).toEqual([]);
  });

  it('writes nothing into a notification: open, use and close leave the hint row empty', async () => {
    const { r } = await opened(450);
    r.press('', { downArrow: true });
    r.press('', ESC);
    expect(r.host.getSnapshot().open).toBe(false);
    expect(r.notifications.getSnapshot().current).toBeUndefined();
  });
});

describe('the release is a confirmed step (ADR-0148 §3, §6)', () => {
  it('[r] goes to a line that says what changes: the amount, that later turns can spend more, and that it cannot be undone', async () => {
    const { r, fake } = await opened(450);
    arm(r);
    expect(r.step()).toBe(COST_STEP.release);
    const line = r.words().replaceAll(/\s+/gu, ' ');
    expect(line).toContain('lifts about $0.0000045');
    expect(line).toContain('estimated-but-unconfirmed spend from this session’s cap');
    expect(line).toContain('later turns can spend that much more');
    expect(line).toContain('It cannot be undone.');
    expect(fake.release).not.toHaveBeenCalled();
    // The line names only its own answer and the way back.
    const frame = r.host.getSnapshot().frame;
    const legend = frame && popupLegend(frame);
    expect(legend?.items).toEqual([{ keys: 'Ctrl+Y', verb: 'release' }]);
  });

  it.each([
    ['Enter', '', ENTER],
    ['y', 'y', {}],
    ['a plain letter', 'r', {}],
    ['Ctrl+N', 'n', CTRL],
    ['Ctrl+G', 'g', CTRL],
    ['Ctrl+R', 'r', CTRL],
    ['Ctrl+C', 'c', CTRL],
  ])('%s releases nothing: only Ctrl+Y answers the line', (_name, input, key) => {
    return (async () => {
      const { r, fake } = await opened(450);
      arm(r, 900);
      r.press(input, key);
      expect(fake.release).not.toHaveBeenCalled();
      expect(fake.heldNow()).toBe(450);
      // Whatever it did to the popup, it did not carry the release out.
      expect(r.step()).not.toBe(COST_STEP.done);
    })();
  });

  it('a paste releases nothing, and disarms the line', async () => {
    const { r, fake } = await opened(450);
    arm(r, 900);
    r.host.paste('y');
    ctrlY(r);
    expect(fake.release).not.toHaveBeenCalled();
  });

  it('Ctrl+Y before the line was acknowledged on screen releases nothing, says so, and disarms', async () => {
    const { r, fake } = await opened(450);
    r.press('r'); // armed, its frame never acknowledged
    r.clock.advance(2000);
    ctrlY(r);
    expect(fake.release).not.toHaveBeenCalled();
    expect(r.step()).toBe(COST_STEP.cost);
    expect(r.notifications.getSnapshot().current?.text).toContain('Release not confirmed');
    expect(r.notifications.getSnapshot().current?.text).toContain('Nothing was released.');
  });

  it('Ctrl+Y 799 ms after the acknowledged frame releases nothing; 800 ms releases', async () => {
    const early = await opened(450);
    arm(early.r, 799);
    ctrlY(early.r);
    expect(early.fake.release).not.toHaveBeenCalled();
    expect(early.r.step()).toBe(COST_STEP.cost);

    const exact = await opened(450);
    arm(exact.r, 800);
    ctrlY(exact.r);
    expect(exact.fake.release).toHaveBeenCalledOnce();
    expect(exact.fake.heldNow()).toBe(0);
  });

  it('Ctrl+Y after the confirmation window releases nothing', async () => {
    const { r, fake } = await opened(450);
    arm(r, CHORD_STEP_WINDOW_MS + 1);
    ctrlY(r);
    expect(fake.release).not.toHaveBeenCalled();
  });

  it('a key typed after the line was armed makes Ctrl+Y release nothing', async () => {
    const { r, fake } = await opened(450);
    arm(r);
    r.press('x');
    r.clock.advance(1000);
    ctrlY(r);
    expect(fake.release).not.toHaveBeenCalled();
  });

  it('a resize below the floor while the line is up closes the popup unanswered, and releases nothing', async () => {
    const { r, fake } = await opened(450);
    arm(r, 900);
    r.host.resized(79, 24);
    expect(r.host.getSnapshot().open).toBe(false);
    expect(fake.release).not.toHaveBeenCalled();
  });

  it('`Esc` on the line goes back to the report and releases nothing', async () => {
    const { r, fake } = await opened(450);
    arm(r, 900);
    r.press('', ESC);
    expect(r.step()).toBe(COST_STEP.cost);
    expect(fake.release).not.toHaveBeenCalled();
  });

  it('a typed /cost --release opens ON the line, still needs the chord, and Esc goes back to the report', async () => {
    const r = reportRig();
    const fake = fakeCost({ held: 450 });
    r.open({ cost: fake.port }, { kind: 'cost', release: true });
    expect(r.step()).toBe(COST_STEP.release);
    r.show();
    await settleWork();
    expect(r.content(COST_STEP.release).kind).toBe('report');
    expect(r.words()).toContain('lifts about $0.0000045');
    // Not before its dwell: the frame of the line is acknowledged, and 799 ms later the chord is refused (it disarms the line).
    r.clock.advance(600);
    r.show();
    r.clock.advance(799);
    ctrlY(r);
    expect(fake.release).not.toHaveBeenCalled();
    expect(r.step()).toBe(COST_STEP.cost);

    const typed = reportRig();
    const answered = fakeCost({ held: 450 });
    typed.open({ cost: answered.port }, { kind: 'cost', release: true });
    typed.show();
    await settleWork();
    typed.clock.advance(600);
    typed.show();
    typed.clock.advance(900);
    ctrlY(typed);
    expect(answered.release).toHaveBeenCalledOnce();
    expect(typed.step()).toBe(COST_STEP.done);

    const back = reportRig();
    const again = fakeCost({ held: 450 });
    back.open({ cost: again.port }, { kind: 'cost', release: true });
    back.show();
    await settleWork();
    back.clock.advance(600);
    back.press('', ESC);
    expect(back.step()).toBe(COST_STEP.cost);
    expect(back.words()).toContain('Session cost:');
    expect(again.release).not.toHaveBeenCalled();
  });

  it('a typed /cost --release with nothing held says so and has no line to answer', async () => {
    const r = reportRig();
    const fake = fakeCost({ held: 0 });
    r.open({ cost: fake.port }, { kind: 'cost', release: true });
    r.show();
    await settleWork();
    expect(r.step()).toBe(COST_STEP.release);
    expect(r.content().kind).toBe('empty');
    expect(r.words()).toContain('Nothing is held against this session’s cap');
    r.clock.advance(2000);
    ctrlY(r);
    expect(fake.release).not.toHaveBeenCalled();
  });
});

describe('the answer (what the release does, and what it will not do)', () => {
  it('releases the held estimates once and goes to a persistent result with the total read again', async () => {
    const { r, fake } = await opened(450);
    arm(r, 900);
    ctrlY(r);
    expect(fake.calls).toEqual(['read', 'release']);
    expect(r.step()).toBe(COST_STEP.done);
    expect(r.words()).toContain('Released ~$0.0000045 back to the cap.');
    await settleWork();
    // The refreshed total lands under the line, and there is nothing held now.
    expect(fake.calls).toEqual(['read', 'release', 'read']);
    expect(r.words()).toContain('Released ~$0.0000045 back to the cap.');
    expect(r.words()).toContain('Session cost: $0.0001');
    // No timer closes it: it stays until it is closed.
    r.clock.advance(60_000);
    expect(r.host.getSnapshot().open).toBe(true);
    expect(r.step()).toBe(COST_STEP.done);
    // A second Ctrl+Y releases nothing more.
    ctrlY(r);
    expect(fake.release).toHaveBeenCalledOnce();
  });

  it.each([
    ['Enter', '', ENTER],
    ['Esc', '', ESC],
  ])('%s closes the result, and nothing else is left behind', async (_name, input, key) => {
    const { r, fake } = await opened(450);
    arm(r, 900);
    ctrlY(r);
    await settleWork();
    r.clock.advance(600);
    r.press(input, key);
    expect(r.host.getSnapshot().open).toBe(false);
    expect(fake.release).toHaveBeenCalledOnce();
    expect(r.notifications.getSnapshot().current).toBeUndefined();
  });

  it('says nothing was released when nothing was held at the answer', async () => {
    const r = reportRig();
    const fake = fakeCost({ held: 450, release: () => ({ durable: 0, live: undefined }) });
    r.open({ cost: fake.port }, { kind: 'cost', release: false });
    r.show();
    await settleWork();
    r.clock.advance(600);
    arm(r, 900);
    ctrlY(r);
    expect(r.words()).toContain('Nothing was held against the cap, so nothing was released.');
    expect(fake.release).toHaveBeenCalledOnce();
  });

  it('reports the larger of the two halves: the live governor held what the record could not', async () => {
    const r = reportRig();
    const fake = fakeCost({ held: 450, release: () => ({ durable: 0, live: 700 }) });
    r.open({ cost: fake.port }, { kind: 'cost', release: false });
    r.show();
    await settleWork();
    r.clock.advance(600);
    arm(r, 900);
    ctrlY(r);
    expect(r.words()).toContain('Released ~$0.000007 back to the cap.');
  });

  it('releases nothing while a turn is in flight at the answer, says so, and leaves the line unanswerable', async () => {
    const { r, fake } = await opened(450);
    arm(r, 900);
    // No turn when it opened and none when the line was drawn; one is running at the moment of the answer.
    r.setTurn(true);
    ctrlY(r);
    expect(fake.release).not.toHaveBeenCalled();
    expect(fake.heldNow()).toBe(450);
    expect(r.step()).toBe(COST_STEP.release);
    expect(r.content().kind).toBe('empty');
    expect(r.words()).toContain('A turn is running, so nothing was released.');
    expect(r.notifications.getSnapshot().current?.text).toBe(
      'Nothing released: a turn is running.',
    );
    // The turn ends: the old line is gone, so the same key still releases nothing.
    r.setTurn(false);
    r.clock.advance(1000);
    ctrlY(r);
    expect(fake.release).not.toHaveBeenCalled();
  });

  it('asks the host at the answer, not at the open: a turn that was running when the popup opened but not at the answer releases', async () => {
    const r = reportRig({ turn: true });
    const fake = fakeCost({ held: 450 });
    r.open({ cost: fake.port }, { kind: 'cost', release: false });
    r.show();
    await settleWork();
    r.clock.advance(600);
    r.setTurn(false);
    arm(r, 900);
    ctrlY(r);
    expect(fake.release).toHaveBeenCalledOnce();
  });

  it('a release that throws goes to the owner, says so by words, and leaves the popup open on its result', async () => {
    const r = reportRig();
    const failure = vi.fn();
    const fake = fakeCost({
      held: 450,
      release: () => {
        throw new Error(`PRIVATE /tmp/db ${SECRET}`);
      },
    });
    r.open(
      { cost: fake.port, workOwner: { failure, enter: (op) => op() } },
      { kind: 'cost', release: false },
    );
    r.show();
    await settleWork();
    r.clock.advance(600);
    arm(r, 900);
    ctrlY(r);
    expect(r.step()).toBe(COST_STEP.done);
    expect(r.content().kind).toBe('error');
    expect(r.words()).toContain('The release could not be completed.');
    expect(r.words()).not.toContain('PRIVATE');
    expect(r.words()).not.toContain(SECRET);
    expect(failure).toHaveBeenCalledOnce();
    // The popup is not stuck: it closes.
    r.press('', ESC);
    expect(r.host.getSnapshot().open).toBe(false);
  });

  it('the rail follows the path: report, release line, result', async () => {
    const { r } = await opened(450);
    arm(r, 900);
    const frame = r.host.getSnapshot().frame;
    expect(frame?.stepIndex).toBe(COST_STEP.release);
    expect(frame && JSON.stringify(popupLegend(frame).exit)).toContain('cancel');
    ctrlY(r);
    const done = r.host.getSnapshot().frame;
    expect(done && popupLegend(done).exit).toMatchObject({ keys: ['Enter', 'Esc'], verb: 'close' });
  });
});

describe('the report is scrubbed (ADR-0145 §5)', () => {
  it('draws no escape, no forged key token or separator, no secret and no host glyph from a model id', async () => {
    const r = reportRig();
    const hostile = `evil\u001b[31m [Ctrl+Y] allow · ${SECRET} ✓ › ${'x'.repeat(5)}`;
    const reading = costReading(450, undefined, [
      costRow({ model: hostile, costMicrocents: 12_000, conservativeMicrocents: 450 }),
    ]);
    r.open({ cost: { read: () => reading, release: vi.fn() } }, { kind: 'cost', release: false });
    r.show();
    await settleWork();
    const words = r.words();
    expect(words).not.toContain('\u001b');
    expect(words).not.toContain('Ctrl+Y');
    expect(words).not.toContain(SECRET);
    expect(words).not.toContain(' · ');
    expect(words).not.toContain('✓');
    expect(words).not.toContain('›');
  });
});
