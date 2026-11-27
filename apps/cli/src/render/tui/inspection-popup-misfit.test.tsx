/**
 * The two mutation tests of [ADR-0148](../../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md) §7,
 * committed as tests (unit 8 fix wave, S-6 and M-2): the page of the inspection popup is projected for a geometry, and a page fitted to one
 * geometry and drawn in another must never be acknowledged, or rows the person never saw would count as read and unlock Allow. The geometry is
 * injected here one column wider and one row taller than the box the popup draws; each must refuse the acknowledgement (the refusal is drawn
 * and `Ctrl+Y` answers nothing), and the untouched geometry, the control, is acknowledged and answered.
 *
 * What the refusal rests on, and what each test kills:
 * - The acknowledgement measures the popup's CONTENT node, which has no fixed size, inside the fixed box: a page taller than the box makes the
 *   content node overflow its parent, which `fitsTerminalBounds` refuses. The reference on the fixed outer box instead (mutant B04) measures
 *   the box's own height, which always fits, and the mis-fitted page is acknowledged.
 * - A body row is drawn without `truncate-end`: one cell too wide, it wraps, and the extra row is what the measurement sees. Cut by the
 *   renderer instead, the too-wide page would fit and be acknowledged with its last cell never shown.
 *
 * No real content makes a row wider than its measured width: `displayWidth` is Ink's own `string-width`, and Ink wraps by grapheme clusters
 * (a probe of 233 clusters, ZWJ sequences, keycaps, flags, tone modifiers, variation selectors, combining marks, Hangul jamo and conjuncts, at
 * two box widths, found none that wraps early), so the mis-fit is injected through the one geometry function every computation shares.
 */
import type { ToolApprovalRequest } from '@relavium/core';
import { render } from 'ink';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { OwnedTtyInput, OwnedTtyOutput, PlainTtyOutput } from '../../test-support.js';
import { ChatApp } from './chat-ink.js';
import { createChatStore } from './chat-store.js';
import { editedFilePreview } from './fixtures/edit-diff.js';
import { FULLSCREEN_TRANSCRIPT_BOUND } from './session-view-model.js';
import type { ApprovalGuard } from './tool-review-model.js';

/** How far the injected page is off the box it is drawn in: a column wider, a row taller. */
const misfit = vi.hoisted(() => ({ cols: 0, rows: 0 }));

vi.mock('./tool-review-screen.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./tool-review-screen.js')>();
  return {
    ...real,
    inspectionGeometry: (size: { readonly cols: number; readonly rows: number }) => {
      const geometry = real.inspectionGeometry(size);
      if (geometry === undefined) return undefined;
      return {
        ...geometry,
        page: { cols: geometry.page.cols + misfit.cols, rows: geometry.page.rows + misfit.rows },
      };
    },
  };
});

const cleanups: (() => void)[] = [];
afterEach(() => {
  misfit.cols = 0;
  misfit.rows = 0;
  for (const close of cleanups.splice(0)) close();
});

const REQUEST: ToolApprovalRequest = {
  toolId: 'edit_file',
  action: 'fs_write',
  preview: { path: 'src/app.ts' },
  unredactedPreview: { path: 'src/app.ts' },
};
/** Every layer of the approval guard off: only the acknowledgement stands between `Ctrl+Y` and an answer. */
const OFF: Required<ApprovalGuard> = {
  settleMs: 0,
  quietMs: 0,
  typeaheadMs: 0,
  lockoutMs: 0,
  confirmAlways: false,
};
const CTRL_Y = String.fromCharCode(25);

// eslint-disable-next-line no-control-regex -- stripping terminal control sequences from a captured frame
const CONTROL = /\u001b\[[0-9;?]*[A-Za-z]|\u001b[78]/gu;
const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The full view of a change whose long line fills every row it wraps to, in the alternate screen at 80×24. */
async function fullView(): Promise<{
  readonly answers: unknown[];
  readonly drawn: (needle: string) => boolean;
  readonly press: (key: string) => void;
}> {
  const input = new OwnedTtyInput();
  const output = new PlainTtyOutput();
  const stderr = new OwnedTtyOutput();
  output.columns = 80;
  output.rows = 24;
  const store = createChatStore(false, undefined, FULLSCREEN_TRANSCRIPT_BOUND, {
    approvalGuard: OFF,
  });
  const instance = render(
    createElement(ChatApp, {
      store,
      onSubmit: () => Promise.resolve(),
      shouldStop: () => false,
      onExit: () => {},
      onError: () => {},
      onModeChange: () => {},
      alternateScreen: true,
    }),
    {
      stdin: input,
      stdout: output,
      stderr,
      interactive: true,
      exitOnCtrlC: false,
      patchConsole: false,
      alternateScreen: true,
    },
  );
  cleanups.push(() => {
    store.sealToolPreviews();
    instance.unmount();
    input.destroy();
    output.destroy();
    stderr.destroy();
  });
  /** Whether any frame written holds `needle` (control sequences stripped). */
  const drawn = (needle: string): boolean =>
    output.frames.some((frame) => frame.replace(CONTROL, '').includes(needle));
  const answers: unknown[] = [];
  await pause(40);
  void store
    .requestApproval(REQUEST, true, undefined, {
      callId: 'misfit',
      preview: editedFilePreview(40, { 20: 'x'.repeat(300) }),
    })
    .then((answer) => answers.push(answer))
    .catch(() => undefined);
  await vi.waitFor(() => expect(drawn('Esc stops the turn')).toBe(true));
  await pause(60);
  input.push('v');
  await vi.waitFor(() => expect(store.getSnapshot().review?.screen).toBe('full'));
  await pause(150);
  return { answers, drawn, press: (key) => input.push(key) };
}

describe('ADR-0148 §7’s two mutation tests: a page fitted to another geometry is never acknowledged', () => {
  it('the control: the page fitted to its box is acknowledged, and Ctrl+Y answers from the popup', async () => {
    const view = await fullView();
    expect(view.drawn('Full diff')).toBe(true);
    expect(view.drawn('Review unavailable'), 'and never refused').toBe(false);
    view.press(CTRL_Y);
    await vi.waitFor(() => expect(view.answers).toEqual([{ outcome: 'approve', scope: 'once' }]));
  });

  it.each([
    ['a body row one cell too wide', 1, 0],
    ['one extra row', 0, 1],
  ] as const)(
    '%s: the acknowledgement is refused, the refusal is drawn and Ctrl+Y answers nothing',
    async (_label, cols, rows) => {
      misfit.cols = cols;
      misfit.rows = rows;
      const view = await fullView();
      await vi.waitFor(() =>
        expect(view.drawn('Review unavailable — enlarge terminal, narrow change')).toBe(true),
      );
      view.press(CTRL_Y);
      await pause(150);
      expect(
        view.answers,
        'Allow stays locked: no row of the mis-fitted page counts as seen',
      ).toEqual([]);
    },
  );
});
