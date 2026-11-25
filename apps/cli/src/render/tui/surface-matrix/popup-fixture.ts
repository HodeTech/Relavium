import {
  bodyPageRows,
  naturalBodyRows,
  popupBody,
  popupFrameLines,
  type PopupOrigin,
} from '../../../popups/frame-model.js';
import { INLINE_LIST_MAX_ROWS, popupGeometry, popupInnerWidth } from '../../../popups/geometry.js';
import {
  currentStep,
  openFrame,
  popupLegend,
  railOf,
  type PopupFrame,
  type PopupSpec,
} from '../../../popups/popup-reducer.js';
import { framedFlow } from '../../../home/framed-flow.js';
import { nativePopupFrameLines, nativePopupGeometry } from '../../../popups/popup-slot.js';
import { withGlyphForm } from '../glyphs.js';
import { NATIVE_PROMPT_RESIZED, type NativePromptSnapshot } from '../native-prompt-channel.js';
import type { NativePromptChannel } from './home-host.js';
import type { PopupBox } from './properties.js';
import type { ScreenCell } from './terminal.js';
import type { Variant } from './variants.js';

/**
 * The popup the TEST layer opens ([ADR-0148](../../../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
 * §1): a minimal report popup with a selected row, a control and the way back, so the surface matrix and the host tests exercise the popup
 * frame in every host and cell before any product command becomes a popup. It is NOT a product command (its title is no command's name).
 */
export const TEST_POPUP_TITLE = 'Test report';

/** What the popup's legend row says, written out here and not built by the legend builder (the builder is part of what is checked). */
export const TEST_POPUP_LEGEND_ROW = '↑/↓ select · [c] copy · Esc close';

export function testReportPopup(origin: PopupOrigin): PopupSpec {
  return {
    id: 'test-report',
    title: TEST_POPUP_TITLE,
    origin,
    steps: [
      {
        name: 'Report',
        content: {
          kind: 'list',
          rows: [
            { id: 'alpha', label: 'alpha check', status: 'completed', detail: 'ok' },
            { id: 'bravo', label: 'bravo check', status: 'warning', detail: 'warn' },
            { id: 'charlie', label: 'charlie check', status: 'failed', detail: 'failed' },
          ],
        },
        controls: [{ key: 'c', verb: 'copy' }],
        initialRow: 'alpha',
      },
    ],
  };
}

/** What each mount showed just before the test opened its popup: its rows (the popup-box property) and its cells with their styles (the backdrop-dim property). */
interface Baseline {
  readonly lines: readonly string[];
  readonly cells: readonly (readonly ScreenCell[])[] | undefined;
}
const BASELINES = new WeakMap<object, Baseline>();

/** Record what `mount` shows now, before a popup is opened over it. */
export function recordBaseline(mount: {
  readonly frame: () => string[];
  readonly cells?: () => ScreenCell[][];
}): void {
  BASELINES.set(mount, { lines: mount.frame(), cells: mount.cells?.() });
}

/** The frame `mount` showed before its popup opened, or `undefined` when none was recorded. */
export function baselineOf(mount: object): readonly string[] | undefined {
  return BASELINES.get(mount)?.lines;
}

/** The cells (with their styles) `mount` showed before its popup opened, or `undefined` when none were recorded. */
export function baselineCellsOf(mount: object): readonly (readonly ScreenCell[])[] | undefined {
  return BASELINES.get(mount)?.cells;
}

/** Where the test popup is drawn in a cell, and its rows: the one geometry function and the frame model, in the cell's glyph form. */
export function testPopupBox(origin: PopupOrigin): (variant: Variant) => PopupBox {
  return (variant) => popupBoxOf(openFrame(testReportPopup(origin), 1), variant);
}

/**
 * Where a popup's frame is drawn in a cell, and its rows, from the one geometry function and the frame model exactly as the slot draws them
 * (its rail, its legend judged on the page it draws, its body in the cell's glyph form, and the live notification in its legend row when
 * `notice` is given). A product popup's surface passes the frame its host has open.
 */
export function popupBoxOf(
  frame: PopupFrame | undefined,
  variant: Variant,
  notice?: string,
): PopupBox {
  if (frame === undefined) throw new Error('no popup is open in this cell');
  const placement = variant.renderer === 'alt' ? 'overlay' : 'replace';
  const { spec: step, state: opened } = currentStep(frame);
  const state = { ...opened, filter: step.filter === true ? opened.filter : undefined };
  const rail = railOf(frame);
  const kind = frame.spec.kind ?? 'standard';
  const geometry = popupGeometry({
    columns: variant.size.cols,
    rows: variant.size.rows,
    kind,
    placement,
    rail: rail.names.length > 1,
    bodyRows: naturalBodyRows(
      state.content,
      state,
      placement === 'replace' ? INLINE_LIST_MAX_ROWS : undefined,
      popupInnerWidth(variant.size.cols, kind),
    ),
  });
  if (!geometry.fits) throw new Error('the popup does not fit this cell');
  const rows = withGlyphForm(!variant.color, () =>
    popupFrameLines(
      {
        title: frame.spec.title,
        origin: frame.spec.origin,
        steps: rail.names,
        stepIndex: rail.index,
        done: rail.done,
        legend: popupLegend(
          frame,
          bodyPageRows(state.content, state.filter !== undefined, geometry),
          geometry.innerWidth,
        ),
        notice,
      },
      popupBody(state.content, state, geometry),
      geometry,
    ),
  ).map((line) => line.text);
  return {
    placement,
    top: geometry.top,
    left: geometry.left,
    width: geometry.width,
    height: geometry.height,
    rows,
  };
}

// ---- The native prompt channel framed as a popup (MVP-11 unit 6, 6.1) -------------------------------------------------------------

/**
 * Each prompt kind a flow of the native prompt channel asks, drawn in the popup frame through `framedFlow` (ADR-0148 §1): a choice whose
 * hint wraps (a provider's endpoint), a text field, a masked field after a resize cleared it, a wait, a chord step whose facts wrap, the session
 * picker, and a flow's persistent Done step. They are the test layer's (`/flow` is no command); the flows of the product use the same frame.
 */
export type NativePopupKind = 'select' | 'text' | 'password' | 'busy' | 'chord' | 'picker' | 'done';
export const NATIVE_POPUP_KINDS: readonly NativePopupKind[] = [
  'select',
  'text',
  'password',
  'busy',
  'chord',
  'picker',
  'done',
];

/** The rail of the test flow (no name of it is a word of a selected row). */
const NATIVE_STEP_NAMES = ['Choose', 'Fill', 'Finish'] as const;
export const NATIVE_POPUP_TITLE = '/flow';

const GEMINI_HINT = 'Official endpoint: https://generativelanguage.googleapis.com';
const CHORD_DETAILS = [
  'from        ~/Downloads/deploy.relavium.yaml',
  'to          .relavium/workflows/deploy.relavium.yaml',
  'Canonical YAML: comments are dropped and values are kept as written. The file you named is not changed.',
] as const;
const DONE_LINES = ['.relavium/workflows', '.relavium/agents'] as const;

/** What only each kind's frame says: its landmark. */
export const NATIVE_POPUP_LANDMARK: Readonly<Record<NativePopupKind, string>> = {
  select: 'Which provider?',
  text: 'Path of the workflow',
  password: 'Paste your Anthropic API key',
  busy: 'Checking your Anthropic key',
  chord: "Import workflow 'deploy'",
  picker: 'Resume a session',
  done: 'Created the project directories.',
};

/** Each kind's legend row, written out here and not built by the legend builder (the builder is part of what is checked). */
export const NATIVE_POPUP_LEGEND_ROW: Readonly<Record<NativePopupKind, string>> = {
  select: '↑/↓ select · Enter choose · Esc close',
  text: 'Enter continue · Esc close',
  password: 'Enter continue · Esc close',
  busy: 'Esc cancels it',
  chord: '[Ctrl+Y] Write the file · [Ctrl+N] Write nothing · Esc denies',
  // The picker's legend fitted to the popup's inner width (66 and 74 columns): its paging item goes first, the way back never.
  picker: '↑/↓ select · Enter resume · Tab all directories · Esc close',
  done: 'Enter / Esc close',
};

/** The words only each kind's selected row has (none where the kind draws no selection). */
export const NATIVE_POPUP_SELECTED_ROW: Readonly<Record<NativePopupKind, string | undefined>> = {
  select: 'Google Gemini',
  text: undefined,
  password: undefined,
  busy: undefined,
  chord: undefined,
  picker: 'Fix the flaky test',
  done: 'Done',
};

/** The step each kind is drawn on. */
const STEP_OF: Readonly<Record<NativePopupKind, number>> = {
  select: 0,
  text: 1,
  password: 1,
  busy: 1,
  chord: 1,
  picker: 0,
  done: 2,
};

/** The pasted key the password surface's resize clears (it never reaches a frame: the field is drawn as bullets, then emptied). */
const MATRIX_SECRET = 'sk-matrix-0000000000000000';

const PICKER_ROWS = [
  { value: 's1', label: 'Fix the flaky test', hint: '2 days ago · 14 messages' },
  { value: 's2', label: 'Plan the release', hint: '3 days ago · 3 messages' },
] as const;

/**
 * The snapshot each kind leaves on the channel, as the channel publishes it: what the box of the surface is computed from, so a drift between
 * what the flow asked and what the frame draws fails the popup-box property.
 */
export function nativePopupSnapshot(
  kind: NativePopupKind,
  origin: PopupOrigin,
): NativePromptSnapshot {
  const base: NativePromptSnapshot = {
    active: true,
    kind: 'busy',
    message: '',
    note: '',
    options: [],
    selected: 0,
    display: '',
    error: '',
    escape: 'cancel',
    details: [],
    popup: {
      title: NATIVE_POPUP_TITLE,
      origin,
      stepIndex: STEP_OF[kind],
      stepCount: NATIVE_STEP_NAMES.length,
      stepNames: [...NATIVE_STEP_NAMES],
      exitLabel: 'close',
      depth: 1,
    },
  };
  switch (kind) {
    case 'select':
      return {
        ...base,
        kind: 'select',
        message: NATIVE_POPUP_LANDMARK.select,
        options: [
          { value: 'gemini', label: 'Google Gemini', hint: GEMINI_HINT },
          {
            value: 'anthropic',
            label: 'Anthropic',
            hint: 'Official endpoint: https://api.anthropic.com',
          },
        ],
      };
    case 'text':
      return {
        ...base,
        kind: 'text',
        message: 'Path of the workflow or agent YAML to import (~ is your home)',
      };
    case 'password':
      return {
        ...base,
        kind: 'password',
        note: 'Stored in your OS keychain, never on disk. Sent only to api.anthropic.com, once, to check it.',
        message: NATIVE_POPUP_LANDMARK.password,
        error: NATIVE_PROMPT_RESIZED,
      };
    case 'busy':
      return { ...base, message: 'Checking your Anthropic key · one request to api.anthropic.com' };
    case 'chord':
      return {
        ...base,
        kind: 'chord',
        message: "Import workflow 'deploy' into this project?",
        options: [
          { value: 'allow', label: 'Write the file' },
          { value: 'deny', label: 'Write nothing' },
        ],
        details: [...CHORD_DETAILS],
      };
    case 'picker':
      return {
        ...base,
        kind: 'picker',
        message: NATIVE_POPUP_LANDMARK.picker,
        options: [...PICKER_ROWS],
        picker: {
          allDirectories: false,
          page: 1,
          cursor: 0,
          loading: false,
          hasNext: false,
          hasPrevious: false,
          retryable: false,
        },
      };
    case 'done':
      return {
        ...base,
        kind: 'select',
        message: NATIVE_POPUP_LANDMARK.done,
        details: [...DONE_LINES],
        options: [{ value: 'done', label: 'Done', hint: '.relavium' }],
        escape: 'back',
        final: 'ok',
      };
  }
}

/** Whether the prompt on the channel now is the frame on the terminal, measured and flushed. */
function shownOn(channel: NativePromptChannel): boolean {
  try {
    channel.ui.assertVisible(channel.ui.getSnapshot());
    return true;
  } catch {
    return false;
  }
}

/** A prompt left open: the matrix never answers it, and a rejection when the channel is disposed must not be unhandled. */
const leaveOpen = (running: Promise<unknown>): void => {
  running.catch(() => undefined);
};

/**
 * Open the prompt of `kind` on `channel` through `framedFlow`, as a flow of the product does, and leave it open. The password surface pastes a
 * key once its frame is on screen and is then told of a resize, so its field shows the line that says the key was cleared.
 */
export async function openNativePopup(
  mount: {
    readonly channel: NativePromptChannel | undefined;
    readonly until: (predicate: () => boolean, maxFlushes?: number) => Promise<boolean>;
  },
  kind: NativePopupKind,
  origin: PopupOrigin,
): Promise<void> {
  const channel = mount.channel;
  if (channel === undefined) throw new Error('the surface needs a native prompt channel');
  const flow = framedFlow(channel.flow, {
    title: NATIVE_POPUP_TITLE,
    origin,
    stepNames: NATIVE_STEP_NAMES,
    progress: 'manual',
  });
  const expected = nativePopupSnapshot(kind, origin);
  flow.begin();
  const on = flow.at(STEP_OF[kind]);
  switch (kind) {
    case 'select':
      leaveOpen(on.select({ message: expected.message, options: expected.options }));
      break;
    case 'text':
      leaveOpen(on.text({ message: expected.message }));
      break;
    case 'password':
      flow.note(expected.note);
      leaveOpen(on.password({ message: expected.message }));
      await mount.until(() => shownOn(channel));
      channel.ui.paste(MATRIX_SECRET);
      channel.ui.resized();
      break;
    case 'busy':
      on.busy(expected.message);
      break;
    case 'chord':
      leaveOpen(
        on.chord({
          message: expected.message,
          details: expected.details,
          allow: 'Write the file',
          deny: 'Write nothing',
        }),
      );
      break;
    case 'picker':
      leaveOpen(
        on.pick({
          message: expected.message,
          load: () => Promise.resolve({ options: [...PICKER_ROWS] }),
        }),
      );
      await mount.until(() => channel.ui.getSnapshot().options.length > 0);
      break;
    case 'done':
      leaveOpen(
        flow.done({ message: expected.message, lines: [...DONE_LINES], target: '.relavium' }),
      );
      break;
  }
  await mount.until(() => shownOn(channel));
}

/** Where the framed prompt of `kind` is drawn in a cell, and its rows: the slot's own geometry and frame lines over the expected snapshot. */
export function nativePopupBox(
  kind: NativePopupKind,
  origin: PopupOrigin,
): (variant: Variant) => PopupBox {
  return (variant) => {
    const placement = variant.renderer === 'alt' ? 'overlay' : 'replace';
    const snapshot = nativePopupSnapshot(kind, origin);
    const { geometry, layout } = nativePopupGeometry(
      snapshot,
      placement,
      variant.size,
      variant.color,
    );
    if (!geometry.fits || layout === undefined || !layout.fits)
      throw new Error('the framed prompt does not fit this cell');
    return {
      placement,
      top: geometry.top,
      left: geometry.left,
      width: geometry.width,
      height: geometry.height,
      rows: nativePopupFrameLines(snapshot, geometry, layout, variant.color).map(
        (line) => line.text,
      ),
    };
  };
}
