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
  railOf,
  reducePopupKey,
  withContent,
  type PopupFrame,
  type PopupSpec,
  type PopupStep,
} from '../../../../popups/popup-reducer.js';
import { PopupFrameView } from '../../../../popups/popup-slot.js';
import type { DoctorCheck } from '../../../../chat/doctor.js';
import {
  checksContent,
  consentContent,
  detailContent,
  doctorSpec,
  DOCTOR_LOADING,
  DOCTOR_STEP,
  type DoctorView,
} from '../../../../popups/doctor-popup.js';
import { boundAgentView } from '../../../../chat/bound-agent-view.js';
import { buildDefaultChatAgent } from '../../../../chat/default-agent.js';
import { agentContent, agentSpec, agentUnreadableContent } from '../../../../popups/agent-popup.js';
import {
  COST_LOADING_CONTENT,
  COST_STEP,
  costControls,
  costReportContent,
  costSpec,
  releaseContent,
  releaseDoneContent,
  releaseFailedContent,
  turnInFlightContent,
} from '../../../../popups/cost-popup.js';
import { costReadFailedContent } from '../../../../popups/cost-session.js';
import { helpContent, helpSpec } from '../../../../popups/help-popup.js';
import { copyControlsFor } from '../../../../popups/report-copy.js';
import type { CostReading } from '../../../../popups/report-port.js';
import {
  workflowsContent,
  workflowsFailedContent,
  workflowsSpec,
  WORKFLOWS_LOADING_CONTENT,
} from '../../../../popups/workflows-popup.js';
import { CHAT_KEYS } from '../../chat-keys.js';

const check = (
  id: string,
  status: DoctorCheck['status'],
  label: string,
  detail: string,
): DoctorCheck => ({
  id,
  label,
  status,
  detail,
});
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
  {
    id: 'doctor-popup',
    file: 'popups/doctor-popup.ts',
    describe:
      'the /doctor popup (ADR-0148 §8): its checks, a row’s detail, its confirmation line and the deep tier, each with its legend and its words',
  },
  {
    id: 'agent-popup',
    file: 'popups/agent-popup.ts',
    describe:
      'the /agent popup (ADR-0148 §10): the bound agent’s fields as a read-only report, and the state when its view cannot be made; its legend is the way back alone',
  },
  {
    id: 'cost-popup',
    file: 'popups/cost-popup.ts',
    describe:
      'the /cost popup (ADR-0148 §10): the report with and without the `[r] release held estimates` control, the release’s confirmation line (`[Ctrl+Y] release`), its empty and turn-in-flight states, its result and its failed state, and the states of the read',
  },
  {
    id: 'workflows-popup',
    file: 'popups/workflows-popup.ts',
    describe:
      'the /workflows popup in a chat (ADR-0148 §10): the catalog report, an empty project, no project, the fault and the state of the scan',
  },
  {
    id: 'help-popup',
    file: 'popups/help-popup.ts',
    describe:
      'the /help popup in a chat (ADR-0148 §10): the commands of the chat’s palette and the chat’s keys as one scrollable report',
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
export function frameRows(
  frame: PopupFrame,
  color: boolean,
  legendParts: { readonly items: readonly LegendItem[]; readonly exit: LegendExit } = popupLegend(
    frame,
  ),
) {
  const { spec: current, state } = currentStep(frame);
  const body = { ...state, filter: current.filter === true ? state.filter : undefined };
  const rail = railOf(frame);
  const geometry = popupGeometry({
    columns: 80,
    rows: 24,
    kind: 'standard',
    placement: 'overlay',
    rail: rail.names.length > 1,
    bodyRows: naturalBodyRows(state.content, body),
  });
  if (!geometry.fits) throw new Error('refused');
  return withGlyphForm(!color, () =>
    popupFrameLines(
      {
        title: frame.spec.title,
        origin: frame.spec.origin,
        steps: rail.names,
        stepIndex: rail.index,
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

/**
 * The `/doctor` popup in each state that changes its words or its legend, as the session puts them there: the quick tier loading and done
 * (warning, and failed with a kept deep result), a row's detail on the Home and in a chat, the confirmation line being prepared, drawn and with
 * nothing to send, the deep tier running, and the checks that could not run.
 */
const recordDoctor: Recorder = (): StateRows => {
  const KEYED: DoctorView = {
    quick: [
      check('keychain', 'ok', 'OS keychain', 'reachable'),
      check('config', 'ok', 'config', 'valid'),
      check('tools', 'ok', 'wired tools', 'fs, process'),
      check('provider-keys', 'warn', 'provider keys', 'no provider has a key'),
    ],
  };
  const checksFrame = (view: DoctorView): PopupFrame =>
    withContent(openFrame(doctorSpec('home', false), 1), DOCTOR_STEP.checks, checksContent(view));
  const at = (frame: PopupFrame, step: number, content?: Parameters<typeof withContent>[2]) =>
    ({
      ...(content === undefined ? frame : withContent(frame, step, content)),
      stepIndex: step,
    }) satisfies PopupFrame;
  const base = checksFrame(KEYED);
  const deep: DoctorView = {
    ...KEYED,
    deep: {
      checks: [check('provider:openai', 'fail', 'OpenAI', 'key test failed — 401')],
      ageMs: 65_000,
    },
  };
  return {
    ...frameStates(
      label({ step: 'checks', content: 'loading' }),
      openFrame(doctorSpec('home', false), 1),
    ),
    ...frameStates(label({ step: 'checks', outcome: 'warning' }), base),
    ...frameStates(label({ step: 'checks', outcome: 'failed', deep: 'kept' }), checksFrame(deep)),
    ...frameStates(
      label({ step: 'detail', surface: 'home' }),
      at(
        base,
        DOCTOR_STEP.detail,
        detailContent(
          'quick',
          check('provider-keys', 'warn', 'provider keys', 'no provider has a key'),
          'home',
          { offered: false },
        ),
      ),
    ),
    ...frameStates(
      label({ step: 'detail', surface: 'home-chat' }),
      at(
        base,
        DOCTOR_STEP.detail,
        detailContent(
          'quick',
          check('provider-keys', 'warn', 'provider keys', 'no provider has a key'),
          'home-chat',
          { offered: false },
        ),
      ),
    ),
    ...frameStates(label({ step: 'line', content: 'loading' }), at(base, DOCTOR_STEP.line)),
    ...frameStates(
      label({ step: 'line', content: 'drawn' }),
      at(
        base,
        DOCTOR_STEP.line,
        consentContent(
          [{ providerId: 'anthropic', origin: 'https://api.anthropic.com' }],
          [],
          'home',
        ),
      ),
    ),
    ...frameStates(
      label({ step: 'line', content: 'nothing-to-send' }),
      at(base, DOCTOR_STEP.line, consentContent([], [], 'home')),
    ),
    ...frameStates(
      label({ step: 'checks', content: 'deep-running' }),
      withContent(base, DOCTOR_STEP.checks, { kind: 'loading', what: DOCTOR_LOADING.deep }),
    ),
    ...frameStates(
      label({ step: 'checks', content: 'error' }),
      withContent(base, DOCTOR_STEP.checks, {
        kind: 'error',
        what: 'The checks could not run.',
        next: '[r] runs them again.',
      }),
    ),
  };
};

/** One reading of a session's spend for the recorders: one model, and (`held`) an estimate held against the cap. */
function costReading(held: boolean): CostReading {
  const complete = { unverified: false, pendingInvocations: 0, unknownCalls: 0 };
  return {
    totalCostMicrocents: 12_000,
    rows: [
      {
        model: 'claude-opus-4-8',
        modelCatalogId: undefined,
        inputTokens: 1200,
        outputTokens: 800,
        conservativeMicrocents: held ? 450 : 0,
        costMicrocents: 12_000,
        callCount: 3,
        unpricedCalls: 0,
        isLegacy: false,
      },
    ],
    coverage: complete,
    models: [{ model: 'claude-opus-4-8', coverage: complete }],
    governor: held ? { microcents: 450, durabilityBroken: false } : undefined,
  };
}

/** The `/agent` popup: its one read-only step, and the state of a view that could not be made. */
const recordAgent: Recorder = (): StateRows => {
  const view = boundAgentView(buildDefaultChatAgent('claude-sonnet-4-6'), undefined);
  const frame = (content: PopupContent): PopupFrame => openFrame(agentSpec('chat', content), 1);
  return {
    ...frameStates(label({ content: 'report' }), frame(agentContent(view))),
    ...frameStates(label({ content: 'error' }), frame(agentUnreadableContent())),
  };
};

/** The `/cost` popup in each state that changes its words or its legend, as its session puts them there. */
const recordCost: Recorder = (): StateRows => {
  const spec = costSpec('chat', false);
  const opened = openFrame(spec, 1);
  const reportOf = (held: boolean): PopupFrame => {
    const reading = costReading(held);
    return withContent(opened, COST_STEP.cost, costReportContent(reading), costControls(reading));
  };
  const at = (frame: PopupFrame, step: number, content: PopupContent): PopupFrame => ({
    ...withContent(frame, step, content),
    stepIndex: step,
  });
  const held = reportOf(true);
  const outcome = { durable: 450, live: 450 };
  return {
    ...frameStates(
      label({ step: 'cost', content: 'loading' }),
      withContent(opened, COST_STEP.cost, COST_LOADING_CONTENT),
    ),
    ...frameStates(label({ step: 'cost', content: 'nothing-held' }), reportOf(false)),
    ...frameStates(label({ step: 'cost', content: 'held' }), held),
    ...frameStates(
      label({ step: 'cost', content: 'error' }),
      withContent(opened, COST_STEP.cost, costReadFailedContent(new Error('x')), []),
    ),
    ...frameStates(
      label({ step: 'release', content: 'line' }),
      at(held, COST_STEP.release, releaseContent(costReading(true))),
    ),
    ...frameStates(
      label({ step: 'release', content: 'loading' }),
      at(opened, COST_STEP.release, COST_LOADING_CONTENT),
    ),
    ...frameStates(
      label({ step: 'release', content: 'nothing-held' }),
      at(held, COST_STEP.release, releaseContent(costReading(false))),
    ),
    ...frameStates(
      label({ step: 'release', content: 'turn-in-flight' }),
      at(held, COST_STEP.release, turnInFlightContent()),
    ),
    ...frameStates(
      label({ step: 'done', content: 'released' }),
      at(held, COST_STEP.done, releaseDoneContent(outcome, undefined)),
    ),
    ...frameStates(
      label({ step: 'done', content: 'released-with-total' }),
      at(held, COST_STEP.done, releaseDoneContent(outcome, costReading(false))),
    ),
    ...frameStates(
      label({ step: 'done', content: 'failed' }),
      at(held, COST_STEP.done, releaseFailedContent()),
    ),
  };
};

/** The `/workflows` popup: the catalog, nothing in it, no project, the fault, and the scan. */
const recordWorkflows: Recorder = (): StateRows => {
  // As the session lands it: `[c] copy` arrives with a catalog, and not with the loading, empty or failed states.
  const frame = (content: PopupContent): PopupFrame =>
    withContent(openFrame(workflowsSpec('chat'), 1), 0, content, copyControlsFor(content));
  const entry = (slug: string, valid = true) => ({
    slug,
    name: undefined,
    tags: [],
    path: `${slug}.relavium.yaml`,
    valid,
  });
  return {
    ...frameStates(label({ content: 'loading' }), frame(WORKFLOWS_LOADING_CONTENT)),
    ...frameStates(
      label({ content: 'catalog' }),
      frame(
        workflowsContent({
          kind: 'catalog',
          workflows: [entry('deploy'), entry('broken', false)],
          agents: [entry('coder')],
        }),
      ),
    ),
    ...frameStates(
      label({ content: 'empty-project' }),
      frame(workflowsContent({ kind: 'catalog', workflows: [], agents: [] })),
    ),
    ...frameStates(
      label({ content: 'no-project' }),
      frame(workflowsContent({ kind: 'no-project' })),
    ),
    ...frameStates(
      label({ content: 'fault' }),
      frame(workflowsContent({ kind: 'fault', reason: 'too many workflow files' })),
    ),
    ...frameStates(label({ content: 'not-run' }), frame(workflowsFailedContent())),
  };
};

/** The `/help` popup of a chat on each of the two surfaces that have one. */
const recordHelp: Recorder = (): StateRows => {
  const states: Record<string, readonly string[]> = {};
  for (const surface of ['standalone-chat', 'home-chat'] as const)
    Object.assign(
      states,
      frameStates(
        label({ surface }),
        openFrame(helpSpec('chat', helpContent(surface, Object.values(CHAT_KEYS))), 1),
      ),
    );
  return states;
};

export const POPUP_RECORDERS: Readonly<Record<string, Recorder>> = {
  'popup-frame-legend': recordFrameLegend,
  'popup-native-legend': recordNativeLegend,
  'popup-notice': recordNotice,
  'doctor-popup': recordDoctor,
  'agent-popup': recordAgent,
  'cost-popup': recordCost,
  'workflows-popup': recordWorkflows,
  'help-popup': recordHelp,
};
