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
  EXPORT_ALLOW_LABEL,
  EXPORT_DENY_LABEL,
  EXPORT_FAILED as HOME_EXPORT_FAILED,
} from '../render/tui/export-card.js';
import { FLOW_CLOSE_LABEL } from '../render/tui/flow-text.js';
import { glyph, withGlyphForm } from '../render/tui/glyphs.js';
import { legend } from '../render/tui/legend.js';
import {
  EXPORT_DENIED,
  EXPORT_DONE,
  EXPORT_FAILED,
  EXPORT_NEW_FILE,
  EXPORT_OVERWRITES,
  EXPORT_QUESTION,
  EXPORT_STEP,
  EXPORT_TARGET_CHANGED,
  EXPORT_TURN_IN_FLIGHT,
} from './export-popup.js';
import { fittedLegendItems, naturalBodyRows, popupBody } from './frame-model.js';
import { POPUP_NOTICE_MAX_COLUMNS, popupInnerWidth } from './geometry.js';
import { currentStep, popupLegend } from './popup-reducer.js';
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

  it('asks its question first (OB-2 b), then names the file project-relative, says it is a new file, and states the review sentence; its legend is the Defined export’s: `[Ctrl+Y] Write the file · [Ctrl+N] Write nothing · Esc denies`', async () => {
    const { r } = await opened();
    const words = r.words();
    // The question the Defined export asks (`Write workflow 'x' to a file in this directory?`), for a session: what `Ctrl+Y` answers.
    expect(words.split('\n')[0]).toBe(EXPORT_QUESTION);
    expect(EXPORT_QUESTION).toBe('Write this chat to a workflow file in the project?');
    expect(words.split('\n')[1]).toBe(TARGET);
    expect(words).toContain(EXPORT_NEW_FILE);
    expect(words).toContain(REVIEW);
    const frame = r.host.getSnapshot().frame;
    if (frame === undefined) throw new Error('no popup');
    expect(frame.spec.title).toBe('/export');
    expect(frame.spec.origin).toBe('chat');
    const parts = popupLegend(frame);
    // one answer, its explicit No and one way out, in the words of `/init`, `/import`, `/pricing` and the Defined tab's `x`: same effect,
    // same legend
    expect(parts.items).toEqual([
      { keys: 'Ctrl+Y', verb: EXPORT_ALLOW_LABEL },
      { keys: 'Ctrl+N', verb: EXPORT_DENY_LABEL },
    ]);
    expect(EXPORT_ALLOW_LABEL).toBe('Write the file');
    expect(EXPORT_DENY_LABEL).toBe('Write nothing');
    expect(legend(parts.items, parts.exit)).toBe(
      '[Ctrl+Y] Write the file · [Ctrl+N] Write nothing · Esc denies',
    );
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

  it('every untrusted fragment of the target and of a fault passes the full scrub (the fault of the look and of the write: MU-1 R2-27, R2-28)', async () => {
    const hostile = `.relavium/workflows/\u001b]52;c;cGF5bG9hZA==\u0007x\u202e[Ctrl+Y]\u200by${'z'.repeat(200)} · Esc close.relavium.yaml`;
    const { r } = await opened(fakeExport({ target: hostile, overwrites: false }));
    const words = r.words();
    for (const bad of ['\u001b', '\u0007', '\u202e', '\u200b', '[Ctrl+Y]', ' · Esc close'])
      expect(words, JSON.stringify(bad)).not.toContain(bad);
    // A fault's sentence, as the port says it, with an OSC, a bidi mark, a forged `[Ctrl+Y]`, a zero-width character and a forged way out: each
    // is scrubbed, and the word before them stays.
    const c = (code: number): string => String.fromCharCode(code);
    const HOSTILE = `bad${c(0x1b)}]52;c;cGF5${c(0x07)}${c(0x20_2e)} [Ctrl+Y] ${c(0x20_0b)} · Esc close`;
    const BAD = [c(0x1b), c(0x07), c(0x20_2e), c(0x20_0b), '[Ctrl+Y]', ' · Esc close'];
    // R2-27: the look (where the export would go) fails: the confirmation's error state.
    const look = fakeExport();
    look.move(new Error('no project'));
    look.failure.mockReturnValue(HOSTILE);
    const first = (await opened(look)).r;
    expect(first.content().kind).toBe('error');
    for (const bad of BAD) expect(first.words(), JSON.stringify(bad)).not.toContain(bad);
    expect(first.words()).toContain('bad');
    // R2-28: the write the file system refused: the failed Done step's sentence.
    const write = fakeExport(undefined, {
      commit: () => {
        throw new Error('read-only');
      },
    });
    write.failure.mockReturnValue(HOSTILE);
    const second = (await opened(write)).r;
    ctrlY(second);
    expect(second.step()).toBe(EXPORT_STEP.done);
    expect(second.content()).toMatchObject({ kind: 'done', tone: 'failed' });
    for (const bad of BAD) expect(second.words(), JSON.stringify(bad)).not.toContain(bad);
    expect(second.words()).toContain('bad');
  });

  it('R2-29 a resize below the floor while the line is up closes the popup unanswered, and writes nothing (as the other confirmation lines do)', async () => {
    const { r, fake } = await opened();
    r.host.resized(79, 24);
    expect(r.host.getSnapshot().open).toBe(false);
    expect(fake.commit).not.toHaveBeenCalled();
  });
});

describe('only Ctrl+Y answers it, through the host’s chord guard', () => {
  it('Ctrl+Y after the guards writes once, and goes to the Done step that names the file; nothing is notified', async () => {
    const { r, fake } = await opened();
    ctrlY(r);
    expect(fake.calls).toEqual(['prepare', 'prepare', 'commit']);
    expect(r.step()).toBe(EXPORT_STEP.done);
    // what was exported, then the file on a row of its own (as every flow's last step names its target), once
    expect(r.words()).toBe(`${EXPORT_DONE}\n${TARGET}`);
    expect(r.words().split(TARGET)).toHaveLength(2);
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
    // No time is named (OB-2 d, CO-2): the same layer as the doctor's and `/cost`'s lines, through the one phrase table.
    expect(said).toBe('Nothing exported: too soon.');
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

describe('the result says it in the Defined export’s words, with the file on a row of its own', () => {
  it('a failed write says `Not exported.` as the Defined tab does: one name is one text', () => {
    expect(EXPORT_FAILED).toBe(HOME_EXPORT_FAILED);
    expect(EXPORT_FAILED).toBe('Not exported.');
  });

  it('the file of a write that was made is its own row, through the full scrub (the Done step draws no hostile text)', async () => {
    const hostile = `.relavium/workflows/\u001b]52;c;cGF5bG9hZA==\u0007x\u202e[Ctrl+Y]\u200by ${'z'.repeat(150)}.relavium.yaml`;
    const { r } = await opened(fakeExport({ target: hostile, overwrites: false }));
    ctrlY(r);
    expect(r.step()).toBe(EXPORT_STEP.done);
    const rows = r.words().split('\n');
    expect(rows[0], 'what was exported, then the file').toBe(EXPORT_DONE);
    expect(rows.length).toBeGreaterThan(1);
    for (const bad of ['\u001b', '\u0007', '\u202e', '\u200b', '[Ctrl+Y]'])
      expect(r.words(), JSON.stringify(bad)).not.toContain(bad);
  });
});

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
    expect(r.content()).toMatchObject({ kind: 'done', tone: 'failed' });
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

/** The inner width of a standard popup at the floor (80 columns): the row the frame draws the body and the legend in. */
const FLOOR_INNER = popupInnerWidth(80, 'standard');

/** The current step's body rows, kind and text, as the frame draws them at the floor, in the plain glyph form or not. */
function bodyRows(r: ReportRig, ascii = false): { readonly kind: string; readonly text: string }[] {
  const frame = r.host.getSnapshot().frame;
  if (frame === undefined) throw new Error('no popup');
  const { spec, state } = currentStep(frame);
  const page = { bodyRows: 18, listRows: 18, innerWidth: FLOOR_INNER };
  // As the slot draws it: a filter line only on a step that has one.
  const shown = { ...state, filter: spec.filter === true ? state.filter : undefined };
  return withGlyphForm(ascii, () =>
    popupBody(state.content, shown, page).lines.map(({ kind, text }) => ({ kind, text })),
  );
}

/** The legend row of the current step at the floor, fitted as the frame fits it, with the host's lock as it is now. */
function legendRow(r: ReportRig): string {
  const frame = r.host.getSnapshot().frame;
  if (frame === undefined) throw new Error('no popup');
  const parts = popupLegend(frame, 18, FLOOR_INNER, r.host.lock.read());
  return legend(fittedLegendItems(parts, FLOOR_INNER), parts.exit);
}

describe('the Done step has the one Done shape of the flows: a mark, the sentence, the file once, one `Close` (OB-2 a, CO-4)', () => {
  it('a write that was made: `✓` and the sentence in the done tone, the file on a row of its own, once, and `› Close`; `ok` and `>` in the plain form', async () => {
    const { r } = await opened();
    ctrlY(r);
    expect(r.step()).toBe(EXPORT_STEP.done);
    expect(withGlyphForm(false, () => bodyRows(r))).toEqual([
      { kind: 'done', text: `✓ ${EXPORT_DONE}` },
      { kind: 'row', text: TARGET },
      { kind: 'selected', text: `› ${FLOW_CLOSE_LABEL}` },
    ]);
    expect(bodyRows(r, true)).toEqual([
      { kind: 'done', text: `ok ${EXPORT_DONE}` },
      { kind: 'row', text: TARGET },
      { kind: 'selected', text: `> ${FLOW_CLOSE_LABEL}` },
    ]);
    // The mark and the option are the native flows' (`native-popup-body.ts`): one glyph table, one word for the way out of a Done step.
    expect(withGlyphForm(false, () => [glyph('completed'), glyph('selection')])).toEqual([
      '✓',
      '›',
    ]);
    expect(FLOW_CLOSE_LABEL).toBe('Close');
    expect(legendRow(r)).toBe('Enter / Esc close');
    r.press('', ENTER);
    expect(r.host.getSnapshot().open).toBe(false);
  });

  it('a write that failed: `✗` and `Not exported.` in the failed tone, the reason in the product’s words, and `› Close`; `x` in the plain form', async () => {
    const fake = fakeExport(undefined, {
      commit: () => {
        throw new RangeError('EACCES');
      },
    });
    const { r } = await opened(fake);
    ctrlY(r);
    expect(withGlyphForm(false, () => bodyRows(r))).toEqual([
      { kind: 'failed', text: `✗ ${EXPORT_FAILED}` },
      { kind: 'row', text: 'the product’s words for RangeError' },
      { kind: 'selected', text: `› ${FLOW_CLOSE_LABEL}` },
    ]);
    expect(bodyRows(r, true)[0]).toEqual({ kind: 'failed', text: `x ${EXPORT_FAILED}` });
    r.press('', ESC);
    expect(r.host.getSnapshot().open).toBe(false);
  });

  it.each([
    ['a turn in flight', EXPORT_TURN_IN_FLIGHT],
    ['a target that moved', EXPORT_TARGET_CHANGED],
  ] as const)(
    'nothing written because of %s: the same failed shape, its sentence and what to do, and `› Close`',
    async (why, words) => {
      const { r, fake } = await opened();
      if (why === 'a turn in flight') r.setTurn(true);
      else fake.move({ target: `${TARGET}.moved`, overwrites: false });
      ctrlY(r);
      expect(fake.commit).not.toHaveBeenCalled();
      expect(withGlyphForm(false, () => bodyRows(r))).toEqual([
        { kind: 'failed', text: `✗ ${words.what}` },
        { kind: 'row', text: words.next },
        { kind: 'selected', text: `› ${FLOW_CLOSE_LABEL}` },
      ]);
    },
  );

  it('asks the geometry for every row it draws, and, in a body too short for it, cuts the sentence and keeps `› Close` (the way out is always drawn)', async () => {
    const fake = fakeExport(undefined, {
      commit: () => {
        throw new RangeError('EACCES');
      },
    });
    fake.failure.mockReturnValue(`the write failed ${'because '.repeat(30)}`);
    const { r } = await opened(fake);
    ctrlY(r);
    const frame = r.host.getSnapshot().frame;
    if (frame === undefined) throw new Error('no popup');
    const { state } = currentStep(frame);
    const whole = bodyRows(r);
    expect(whole.length).toBeGreaterThan(3);
    expect(
      naturalBodyRows(state.content, { ...state, filter: undefined }, undefined, FLOOR_INNER),
    ).toBe(whole.length);
    const short = withGlyphForm(false, () =>
      popupBody(
        state.content,
        { ...state, filter: undefined },
        { bodyRows: 2, listRows: 2, innerWidth: FLOOR_INNER },
      ).lines.map(({ kind, text }) => ({ kind, text })),
    );
    expect(short).toEqual([
      { kind: 'failed', text: `✗ ${EXPORT_FAILED}…` },
      { kind: 'selected', text: `› ${FLOW_CLOSE_LABEL}` },
    ]);
  });
});

describe('`Ctrl+N` is the line’s explicit No: named on its legend, it writes nothing and is no key typed over it (OB-2 c)', () => {
  it('after the guards: the popup closes, nothing is written, and it says `Nothing exported.` (never `a key was typed`)', async () => {
    const { r, fake } = await opened();
    r.press('n', CTRL);
    expect(r.host.getSnapshot().open).toBe(false);
    expect(fake.commit).not.toHaveBeenCalled();
    expect(r.notifications.getSnapshot().current?.text).toBe(EXPORT_DENIED);
    expect(EXPORT_DENIED).toBe('Nothing exported.');
    // It answered the line (No), as an `Esc` that closes does: a resolution on the host's one key history, which locks a card that opens next.
    expect(r.history.lastResolvedAt).toBe(r.clock.now());
    // A Ctrl+Y after it finds no popup: nothing more is written.
    ctrlY(r);
    expect(fake.commit).not.toHaveBeenCalled();
  });

  it.each([
    ['inside the dwell', 100, {}],
    ['as a held key’s repeat', PAST_THE_DWELL_MS, { eventType: 'repeat' as const }],
  ])('a No needs no wait: %s it denies the same way', async (_case, after, event) => {
    const { r, fake } = await opened(fakeExport(), after);
    r.press('n', { ...CTRL, ...event });
    expect(r.host.getSnapshot().open).toBe(false);
    expect(fake.commit).not.toHaveBeenCalled();
    expect(r.notifications.getSnapshot().current?.text).toBe(EXPORT_DENIED);
  });

  it('on a frame nobody has seen yet (the opening guard drops every answer there): it still denies', async () => {
    const r = reportRig();
    const fake = fakeExport();
    r.open({ export: fake.port }, { kind: 'export' });
    await settleWork();
    r.press('n', CTRL);
    expect(r.host.getSnapshot().open).toBe(false);
    expect(fake.commit).not.toHaveBeenCalled();
    expect(r.notifications.getSnapshot().current?.text).toBe(EXPORT_DENIED);
  });

  it('at 80 columns the legend keeps `[Ctrl+Y] Write the file (wait)` and `Esc denies` while the lockout holds (`[Ctrl+N]` gives way first, as on the native chord cards), and names all three once it is over', async () => {
    const r = reportRig();
    const fake = fakeExport();
    // The `Enter` that typed `/export`: the popup opens on its line, armed against it (the lockout runs 2 s from it).
    composerKeys(r, [1000]);
    r.open({ export: fake.port }, { kind: 'export' });
    r.show();
    await settleWork();
    r.show();
    r.clock.advance(PAST_THE_DWELL_MS);
    expect(r.host.lock.read()).toBe(true);
    expect(legendRow(r)).toBe('[Ctrl+Y] Write the file (wait) · Esc denies');
    r.clock.advance(PAST_THE_LOCKOUT_MS - PAST_THE_DWELL_MS);
    expect(r.host.lock.read()).toBe(false);
    expect(legendRow(r)).toBe('[Ctrl+Y] Write the file · [Ctrl+N] Write nothing · Esc denies');
  });
});
