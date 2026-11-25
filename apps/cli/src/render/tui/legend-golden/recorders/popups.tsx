import { legendStates } from '../frames.js';
import { label, type Producer, type Recorder, type StateRows } from '../golden.js';

import { withGlyphForm } from '../../glyphs.js';
import type { NativePromptSnapshot } from '../../native-prompt-channel.js';
import {
  naturalBodyRows,
  popupBody,
  popupFrameLines,
  popupNoticeLegend,
  popupNoticeLines,
  type PopupContent,
} from '../../../../popups/frame-model.js';
import { popupGeometry } from '../../../../popups/geometry.js';
import { nativePopupLegend } from '../../../../popups/native-popup-body.js';
import {
  currentStep,
  foldPopupAction,
  openFrame,
  popupLegend,
  reducePopupKey,
  type PopupFrame,
  type PopupSpec,
  type PopupStep,
} from '../../../../popups/popup-reducer.js';
import { PopupFrameView } from '../../../../popups/popup-slot.js';
import type { LegendExit, LegendItem } from '../../legend.js';

/**
 * The legends of the popup frame ([ADR-0148](../../../../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
 * §1, §3): the reducer driver's legend by the state of its step (a list, a later step, a typed filter, a loading step, a report), the channel
 * driver's legend by the prompt it frames, and the notice drawn in a popup's place below the floor. Each is drawn by the real frame view
 * through the real frame model, at 80 columns, without colour and with it.
 */
export const POPUP_PRODUCERS: readonly Producer[] = [
  {
    id: 'popup-frame-legend',
    file: 'popups/popup-reducer.ts',
    describe:
      'the legend row of a popup (the reducer driver): the keys of its step and the way back, which is always last',
  },
  {
    id: 'popup-native-legend',
    file: 'popups/native-popup-body.ts',
    describe: 'the legend row of a native prompt a flow drew as a popup (the channel driver)',
  },
  {
    id: 'popup-notice',
    file: 'popups/frame-model.ts',
    describe: 'the notice and its way back drawn in place of a popup the terminal cannot hold',
  },
];

const LIST: PopupContent = {
  kind: 'list',
  rows: [
    { id: 'a', label: 'alpha' },
    { id: 'b', label: 'bravo' },
  ],
};

const step = (over: Partial<PopupStep> = {}): PopupStep => ({
  name: 'One',
  content: LIST,
  ...over,
});
const spec = (steps: readonly PopupStep[]): PopupSpec => ({
  id: 'golden',
  title: '/golden',
  origin: 'home',
  steps,
});

/** The rows of the frame of `frame` (its current step), drawn by the frame model at 80×24 in the form colour asks for. */
function frameRows(
  frame: PopupFrame,
  color: boolean,
  legendParts: { readonly items: readonly LegendItem[]; readonly exit: LegendExit } = popupLegend(
    frame,
  ),
) {
  const { spec: current, state } = currentStep(frame);
  const body = { ...state, filter: current.filter === true ? state.filter : undefined };
  const geometry = popupGeometry({
    columns: 80,
    rows: 24,
    kind: 'standard',
    placement: 'overlay',
    rail: frame.spec.steps.length > 1,
    bodyRows: naturalBodyRows(state.content, body),
  });
  if (!geometry.fits) throw new Error('refused');
  return withGlyphForm(!color, () =>
    popupFrameLines(
      {
        title: frame.spec.title,
        origin: frame.spec.origin,
        steps: frame.spec.steps.map((entry) => entry.name),
        stepIndex: frame.stepIndex,
        legend: legendParts,
      },
      popupBody(state.content, body, geometry),
      geometry,
    ),
  );
}

/** The legend rows of `frame`, drawn as the popup draws them (placed in the flow, so the golden reads the rows alone). */
function frameStates(state: string, frame: PopupFrame) {
  return legendStates(
    state,
    (color) => (
      <PopupFrameView
        lines={frameRows(frame, color)}
        color={color}
        placement="replace"
        left={0}
        top={0}
        contentRef={() => undefined}
      />
    ),
    { columns: 80 },
  );
}

function folded(
  frame: PopupFrame,
  input: string,
  key: Parameters<typeof reducePopupKey>[1] = {},
): PopupFrame {
  const fold = foldPopupAction(frame, reducePopupKey(input, key, currentStep(frame).spec), 2);
  if (fold.kind !== 'frame') throw new Error(`the recorder expected a frame, got ${fold.kind}`);
  return fold.frame;
}

const recordFrameLegend: Recorder = (): StateRows => {
  const list = openFrame(
    spec([step({ enter: 'apply', controls: [{ key: 'c', verb: 'copy' }] })]),
    1,
  );
  const twoSteps = openFrame(
    spec([step({ name: 'Model' }), step({ name: 'Effort & scope', enter: 'apply' })]),
    1,
  );
  const filtered = folded(openFrame(spec([step({ filter: true })]), 1), 'a');
  return {
    ...frameStates(label({ step: 'list', enter: 'apply', control: 'c' }), list),
    ...frameStates(label({ step: 'first-of-two' }), twoSteps),
    ...frameStates(label({ step: 'second-of-two' }), { ...twoSteps, stepIndex: 1 }),
    ...frameStates(label({ filter: 'typed' }), filtered),
    ...frameStates(
      label({ content: 'loading' }),
      openFrame(spec([step({ content: { kind: 'loading', what: 'Checking' } })]), 1),
    ),
    ...frameStates(
      label({ content: 'report' }),
      openFrame(spec([step({ content: { kind: 'report', lines: ['one line'] } })]), 1),
    ),
    ...frameStates(
      label({ content: 'empty' }),
      openFrame(
        spec([step({ content: { kind: 'empty', what: 'Nothing yet.', next: 'Use /init.' } })]),
        1,
      ),
    ),
  };
};

const NATIVE_BASE: NativePromptSnapshot = {
  active: true,
  kind: 'select',
  message: 'Which one?',
  note: '',
  options: [
    { value: 'a', label: 'First' },
    { value: 'b', label: 'Second' },
  ],
  selected: 0,
  display: '',
  error: '',
  escape: 'cancel',
  details: [],
  popup: {
    placement: 'overlay',
    title: '/flow',
    origin: 'home',
    stepIndex: 0,
    stepCount: 2,
    exitLabel: 'close',
    depth: 1,
  },
};

const recordNativeLegend: Recorder = (): StateRows => {
  const states: Record<string, readonly string[]> = {};
  const kinds: readonly NativePromptSnapshot['kind'][] = ['select', 'text', 'password', 'busy'];
  for (const kind of kinds)
    for (const escape of ['cancel', 'back'] as const) {
      const snapshot: NativePromptSnapshot = { ...NATIVE_BASE, kind, escape };
      const frame = openFrame(spec([step()]), 1);
      Object.assign(
        states,
        legendStates(
          label({ kind, escape }),
          (color) => (
            <PopupFrameView
              lines={frameRows(frame, color, nativePopupLegend(snapshot))}
              color={color}
              placement="replace"
              left={0}
              top={0}
              contentRef={() => undefined}
            />
          ),
          { columns: 80 },
        ),
      );
    }
  return states;
};

const recordNotice: Recorder = (): StateRows => {
  const states: Record<string, readonly string[]> = {};
  const first = popupLegend(openFrame(spec([step()]), 1));
  const later = popupLegend({ ...openFrame(spec([step(), step()]), 1), stepIndex: 1 });
  for (const [name, parts] of [
    ['first-step', first],
    ['later-step', later],
  ] as const)
    for (const reason of ['below-floor', 'no-room'] as const)
      Object.assign(
        states,
        legendStates(
          label({ step: name, reason }),
          (color) => (
            <PopupFrameView
              lines={withGlyphForm(!color, () =>
                popupNoticeLines(reason, popupNoticeLegend(parts), 60),
              )}
              color={color}
              placement="replace"
              left={0}
              top={0}
              contentRef={() => undefined}
            />
          ),
          { columns: 80 },
        ),
      );
  return states;
};

export const POPUP_RECORDERS: Readonly<Record<string, Recorder>> = {
  'popup-frame-legend': recordFrameLegend,
  'popup-native-legend': recordNativeLegend,
  'popup-notice': recordNotice,
};
