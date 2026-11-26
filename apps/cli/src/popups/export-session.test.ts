/**
 * The in-chat `/export` popup on a manual clock (MVP-11 unit 6, 6.3; [ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
 * §3, §6, §10; OD-10): where the scaffold would go is worked out in the popup's own work and shown before anything is written, the write is a
 * confirmation line that only `Ctrl+Y` answers through the popup host's chord guard (unchanged: `popup-chord-step.test.ts` pins its layers), the
 * answer re-checks the turn and the target, the result is a persistent Done step, and nothing but the port's one `commit` is an effect: no
 * notification on success, no transcript (the port is a fake; nothing reaches a disk).
 */
import { describe, expect, it, vi } from 'vitest';

import { createChordGuard } from '../render/tui/chord-guard.js';
import { CTRL, ENTER, ESC } from './doctor.test-support.js';
import {
  EXPORT_FAILED,
  EXPORT_NEW_FILE,
  EXPORT_OVERWRITES,
  EXPORT_STEP,
  EXPORT_TARGET_CHANGED,
  EXPORT_TURN_IN_FLIGHT,
} from './export-popup.js';
import { POPUP_NOTICE_MAX_COLUMNS } from './geometry.js';
import { popupLegend } from './popup-reducer.js';
import type { SessionExportPort, SessionExportView } from './report-port.js';
import { reportRig, settleWork, type ReportRig } from './report.test-support.js';

const TARGET = '.relavium/workflows/fix-the-test.relavium.yaml';
const REVIEW = 'Exported workflow is a scaffold; review it before committing.';
/** Past the opening guard's settle (500 ms) and the line's dwell (800 ms), well inside its window. */
const PAST_THE_DWELL_MS = 900;
/** Past the lockout (2 s) that the last key before the open starts on a popup that opens on its line. */
const PAST_THE_LOCKOUT_MS = 2100;

/** A port over a target a test moves, every call recorded in order. */
function fakeExport(
  initial: SessionExportView = { target: TARGET, overwrites: false },
  over: { readonly commit?: () => { readonly target: string } } = {},
) {
  let view: SessionExportView | Error = initial;
  const calls: string[] = [];
  const prepare = vi.fn((): SessionExportView => {
    calls.push('prepare');
    if (view instanceof Error) throw view;
    return view;
  });
  const commit = vi.fn((): { readonly target: string } => {
    calls.push('commit');
    if (over.commit !== undefined) return over.commit();
    if (view instanceof Error) throw view;
    return { target: view.target };
  });
  const failure = vi.fn((cause: unknown) =>
    cause instanceof Error ? `the product’s words for ${cause.name}` : 'unexpected',
  );
  const port: SessionExportPort = { prepare, commit, failure, review: REVIEW };
  return {
    port,
    prepare,
    commit,
    failure,
    calls,
    move: (to: SessionExportView | Error) => (view = to),
  };
}

/** `/export` opened, its target landed and its frame acknowledged; `after` ms later (default: past the guards). */
async function opened(
  fake = fakeExport(),
  after = PAST_THE_DWELL_MS,
  owner?: { readonly failure: (cause: unknown) => void },
) {
  const r = reportRig();
  const result = r.open(
    {
      export: fake.port,
      ...(owner === undefined ? {} : { workOwner: { ...owner, enter: (op) => op() } }),
    },
    { kind: 'export' },
  );
  expect(result.opened).toBe(true);
  r.show();
  await settleWork();
  r.show();
  r.clock.advance(after);
  return { r, fake };
}

const ctrlY = (r: ReportRig, eventType?: 'press' | 'repeat'): boolean =>
  r.press('y', { ...CTRL, ...(eventType === undefined ? {} : { eventType }) });

describe('the confirmation says where the scaffold goes before anything is written', () => {
  it('opens loading and works out the target in its own work: nothing is read while it opens or is drawn', async () => {
    const r = reportRig();
    const fake = fakeExport();
    r.open({ export: fake.port }, { kind: 'export' });
    expect(fake.prepare).not.toHaveBeenCalled();
    expect(r.content().kind).toBe('loading');
    expect(r.step()).toBe(EXPORT_STEP.review);
    r.show();
    r.host.getSnapshot();
    expect(fake.prepare).not.toHaveBeenCalled();
    await settleWork();
    expect(fake.calls).toEqual(['prepare']);
    expect(r.content().kind).toBe('report');
  });

  it('names the file project-relative, says it is a new file, and states the review sentence; its legend is `Ctrl+Y export · Esc cancel`', async () => {
    const { r } = await opened();
    const words = r.words();
    expect(words.split('\n')[0]).toBe(TARGET);
    expect(words).toContain(EXPORT_NEW_FILE);
    expect(words).toContain(REVIEW);
    const frame = r.host.getSnapshot().frame;
    if (frame === undefined) throw new Error('no popup');
    expect(frame.spec.title).toBe('/export');
    expect(frame.spec.origin).toBe('chat');
    const legend = popupLegend(frame);
    expect(legend.items).toEqual([{ keys: 'Ctrl+Y', verb: 'export' }]);
    expect(JSON.stringify(legend.exit)).toContain('cancel');
  });

  it('says so when the write rewrites this session’s own earlier export', async () => {
    const { r } = await opened(fakeExport({ target: TARGET, overwrites: true }));
    expect(r.words()).toContain(EXPORT_OVERWRITES);
    expect(r.words()).not.toContain(EXPORT_NEW_FILE);
  });

  it('a target that cannot be worked out is an error state in the product’s words, and offers no answer', async () => {
    const fake = fakeExport();
    fake.move(new Error('no project'));
    const owner = { failure: vi.fn() };
    const { r } = await opened(fake, PAST_THE_DWELL_MS, owner);
    expect(r.content().kind).toBe('error');
    expect(r.words()).toContain(EXPORT_FAILED);
    expect(r.words()).toContain('the product’s words for Error');
    expect(r.words()).not.toContain('no project');
    expect(owner.failure).toHaveBeenCalledTimes(1);
    const frame = r.host.getSnapshot().frame;
    expect(frame && popupLegend(frame).items).toEqual([]);
    ctrlY(r);
    expect(fake.commit).not.toHaveBeenCalled();
  });

  it('every untrusted fragment of the target and of a fault passes the full scrub', async () => {
    const hostile = `.relavium/workflows/\u001b]52;c;cGF5bG9hZA==\u0007x\u202e[Ctrl+Y]\u200by${'z'.repeat(200)} · Esc close.relavium.yaml`;
    const { r } = await opened(fakeExport({ target: hostile, overwrites: false }));
    const words = r.words();
    for (const bad of ['\u001b', '\u0007', '\u202e', '\u200b', '[Ctrl+Y]', ' · Esc close'])
      expect(words, JSON.stringify(bad)).not.toContain(bad);
  });
});

describe('only Ctrl+Y answers it, through the host’s chord guard', () => {
  it('Ctrl+Y after the guards writes once, and goes to the Done step that names the file; nothing is notified', async () => {
    const { r, fake } = await opened();
    ctrlY(r);
    expect(fake.calls).toEqual(['prepare', 'prepare', 'commit']);
    expect(r.step()).toBe(EXPORT_STEP.done);
    expect(r.words()).toBe(`Exported · ${TARGET}`);
    expect(r.notifications.getSnapshot().current).toBeUndefined();
    // the Done step takes no chord: a second Ctrl+Y writes nothing more, and Enter closes it
    ctrlY(r);
    expect(fake.commit).toHaveBeenCalledTimes(1);
    r.press('', ENTER);
    expect(r.host.getSnapshot().open).toBe(false);
  });

  it('Esc on the line cancels: nothing is written, the popup closes, and nothing is said', async () => {
    const { r, fake } = await opened();
    r.press('', ESC);
    expect(r.host.getSnapshot().open).toBe(false);
    expect(fake.commit).not.toHaveBeenCalled();
    expect(r.notifications.getSnapshot().current).toBeUndefined();
  });

  it('Enter, a letter and a paste write nothing (a key typed over the line disarms it and closes the popup)', async () => {
    for (const press of [
      (r: ReportRig) => r.press('', ENTER),
      (r: ReportRig) => r.press('y'),
      (r: ReportRig) => r.host.paste('\u0019'),
    ]) {
      const { r, fake } = await opened();
      press(r);
      ctrlY(r);
      expect(fake.commit).not.toHaveBeenCalled();
    }
  });

  it('Ctrl+Y inside the dwell writes nothing; the line has no step to go back to, so the popup closes and the host says why, in one short line', async () => {
    const { r, fake } = await opened(fakeExport(), 700);
    ctrlY(r);
    expect(fake.commit).not.toHaveBeenCalled();
    expect(r.host.getSnapshot().open).toBe(false);
    const said = r.notifications.getSnapshot().current?.text ?? '';
    expect(said).toBe('Nothing exported: too soon, wait 2 s.');
    expect(said.length).toBeLessThanOrEqual(POPUP_NOTICE_MAX_COLUMNS);
  });

  it('Ctrl+Y on a frame that is not on screen writes nothing', async () => {
    const r = reportRig();
    const fake = fakeExport();
    r.open({ export: fake.port }, { kind: 'export' });
    r.show();
    await settleWork();
    r.hide();
    r.clock.advance(PAST_THE_DWELL_MS);
    ctrlY(r);
    expect(fake.commit).not.toHaveBeenCalled();
  });
});

/** The keys the composer took before the popup opened (the typed `/export` and its `Enter`): keys on the host's one history, never resolutions. */
function composerKeys(r: ReportRig, times: readonly number[]): void {
  const composer = createChordGuard({ now: r.clock.now, history: r.history });
  for (const at of times) {
    r.clock.advance(at - r.clock.now());
    composer.stamp();
  }
}

describe('a Ctrl+Y held through the open never writes (the held-key matrix)', () => {
  const DELAYS = [250, 600, 1000, 1400, 1800] as const;
  const RATES = [30, 100, 500, 1000, 1800] as const;
  const cases = DELAYS.flatMap((delay) =>
    RATES.flatMap((rate) =>
      (['press', 'repeat'] as const).map((eventType) => [delay, rate, eventType] as const),
    ),
  );
  it.each(cases)(
    'first repeat %i ms after the open, then every %i ms (%s events): nothing is written',
    async (delay, rate, eventType) => {
      const r = reportRig();
      const fake = fakeExport();
      // The key went down in the composer and repeats there; `/export` opens on its line between two repeats.
      composerKeys(r, [1000, 1000 + rate, 1000 + 2 * rate]);
      r.clock.advance(30);
      r.open({ export: fake.port }, { kind: 'export' });
      r.show();
      await settleWork();
      r.show();
      r.clock.advance(delay);
      for (let repeat = 0; repeat < 12; repeat += 1) {
        ctrlY(r, eventType);
        await settleWork();
        r.clock.advance(rate);
      }
      expect(fake.commit).not.toHaveBeenCalled();
    },
  );

  it('a patient press, after the lockout the last key before the open started, writes once', async () => {
    const r = reportRig();
    const fake = fakeExport();
    composerKeys(r, [1000]);
    const last = r.clock.now();
    r.clock.advance(30);
    r.open({ export: fake.port }, { kind: 'export' });
    r.show();
    await settleWork();
    r.show();
    r.clock.advance(last + PAST_THE_LOCKOUT_MS - r.clock.now());
    ctrlY(r);
    expect(fake.commit).toHaveBeenCalledTimes(1);
  });
});

describe('the answer re-checks what it was asked for', () => {
  it('a turn in flight at the answer writes nothing, and the Done step says so', async () => {
    const { r, fake } = await opened();
    r.setTurn(true);
    ctrlY(r);
    expect(fake.commit).not.toHaveBeenCalled();
    expect(r.step()).toBe(EXPORT_STEP.done);
    expect(r.words()).toBe(`${EXPORT_TURN_IN_FLIGHT.what}\n${EXPORT_TURN_IN_FLIGHT.next}`);
  });

  it.each([
    [
      'another file',
      { target: '.relavium/workflows/fix-the-test-2.relavium.yaml', overwrites: false },
    ],
    ['the same file, now an overwrite', { target: TARGET, overwrites: true }],
  ] as const)(
    'a target that moved since the step was drawn (%s) writes nothing, and the Done step says so',
    async (_case, moved) => {
      const { r, fake } = await opened();
      fake.move(moved);
      ctrlY(r);
      expect(fake.commit).not.toHaveBeenCalled();
      expect(r.words()).toBe(`${EXPORT_TARGET_CHANGED.what}\n${EXPORT_TARGET_CHANGED.next}`);
    },
  );

  it('a look that fails at the answer writes nothing, tells the owner and says it in the product’s words', async () => {
    const owner = { failure: vi.fn() };
    const { r, fake } = await opened(fakeExport(), PAST_THE_DWELL_MS, owner);
    fake.move(new TypeError('raw message with /Users/someone/secret'));
    ctrlY(r);
    expect(fake.commit).not.toHaveBeenCalled();
    expect(owner.failure).toHaveBeenCalledTimes(1);
    expect(r.words()).toContain(EXPORT_FAILED);
    expect(r.words()).toContain('the product’s words for TypeError');
    expect(r.words()).not.toContain('/Users/someone');
  });

  it('a write that throws tells the owner, and the Done step says it failed in the product’s words, never the fault’s message', async () => {
    const owner = { failure: vi.fn() };
    const fake = fakeExport(undefined, {
      commit: () => {
        throw new RangeError('EACCES /Users/someone/secret');
      },
    });
    const { r } = await opened(fake, PAST_THE_DWELL_MS, owner);
    ctrlY(r);
    expect(owner.failure).toHaveBeenCalledTimes(1);
    expect(r.step()).toBe(EXPORT_STEP.done);
    expect(r.content().kind).toBe('error');
    expect(r.words()).toContain('the product’s words for RangeError');
    expect(r.words()).not.toContain('/Users/someone');
  });

  it('a popup that closed before its look landed lands nothing', async () => {
    const r = reportRig();
    const fake = fakeExport();
    r.open({ export: fake.port }, { kind: 'export' });
    r.press('', ESC);
    await settleWork();
    expect(fake.prepare).not.toHaveBeenCalled();
    expect(r.host.getSnapshot().open).toBe(false);
  });
});
