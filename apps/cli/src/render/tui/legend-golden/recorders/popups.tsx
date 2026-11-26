import { legendStates } from '../frames.js';
import { label, type Producer, type Recorder, type StateRows } from '../golden.js';

import { withGlyphForm } from '../../glyphs.js';
import type { NativePopupDescriptor, NativePromptSnapshot } from '../../native-prompt-channel.js';
import {
  bodyPageRows,
  naturalBodyRows,
  popupBody,
  popupFrameLines,
  popupNoticeLegend,
  popupNoticeLines,
  type PopupContent,
} from '../../../../popups/frame-model.js';
import { popupGeometry, popupInnerWidth } from '../../../../popups/geometry.js';
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
import {
  nativePopupFrameLines,
  nativePopupGeometry,
  PopupFrameView,
} from '../../../../popups/popup-slot.js';
import { NATIVE_PROMPT_RESIZED } from '../../native-prompt-channel.js';
import type { DoctorCheck } from '../../../../chat/doctor.js';
import {
  checksContent,
  doctorChecksControls,
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
import { copyControlsFor } from '../../../../popups/popup-copy.js';
import type { CostReading } from '../../../../popups/report-port.js';
import {
  workflowsContent,
  workflowsFailedContent,
  workflowsSpec,
  WORKFLOWS_LOADING_CONTENT,
} from '../../../../popups/workflows-popup.js';
import { CHAT_KEYS } from '../../chat-keys.js';
import { effortTiersFor } from '../../../../chat/effort-notice.js';
import { effortContent, effortInitialRow, effortSpec } from '../../../../popups/effort-popup.js';
import {
  MODELS_LOADING,
  MODELS_READ_FAILED,
  MODELS_SETTINGS_FAILED,
  MODELS_STEP,
  modelsListContent,
  modelsSpec,
  scopeForm,
  type CatalogStatus,
} from '../../../../popups/models-popup.js';
import { providerDisplayName } from '../../../../engine/providers.js';
import type { ModelCatalogEntry, ProviderId } from '@relavium/llm';
import { modeScopeForm, modeSpec, SCOPE_STEP } from '../../../../popups/mode-popup.js';
import type { PopupForm } from '../../../../popups/frame-model.js';
import type { ReasoningEffort } from '@relavium/shared';

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
    id: 'popup-native-framed',
    file: 'popups/native-popup-body.ts',
    describe:
      'every prompt kind of the native channel framed as a popup (MVP-11 unit 6): a select drawn whole and in a window (`PgUp/PgDn page`), a masked field after a resize, a wait, a chord step (`[Ctrl+Y]` and `[Ctrl+N]` on the legend row) by its `escape`, the session picker listed and failed, and a flow’s persistent Done step (`Enter / Esc close`), each with the descriptor’s words for the way back',
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
  {
    id: 'effort-popup',
    file: 'popups/effort-popup.ts',
    describe:
      'the /effort popup in a chat (ADR-0148 §3, §6): the tiers of a graded and of a budget model with the one in force marked, and a model with no tier',
  },
  {
    id: 'models-popup',
    file: 'popups/models-popup.ts',
    describe:
      'the /models popup (ADR-0148 §3, §6): the catalog list (the model in force, a model with no key under its heading, the line above it fresh, refreshing and failed, a typed filter), its loading, empty and two error states, and its second step in a chat (a provider change, the model in force, a chat with no default writer) and on the bare Home',
  },
  {
    id: 'popup-form',
    file: 'popups/frame-model.ts',
    describe:
      'a form step of a popup (ADR-0148 §1; the /models second step): `←/→` for its tabs and `↑/↓` for its radio group, each named only with a choice to make, then `Enter apply`',
  },
  {
    id: 'popup-effect',
    file: 'popups/frame-model.ts',
    describe:
      'a list step whose rows state their effect (ADR-0148 §3; the /mode first step): the highlighted row’s effect under the list, the room of the longest kept',
  },
  {
    id: 'mode-popup',
    file: 'popups/mode-popup.ts',
    describe:
      'the /mode popup in a chat (ADR-0148 §3, §6): the modes with the one in force marked and the highlighted one’s effect (`Enter next`), then where the chosen mode applies, with its effect stated for a mode that approves without a card (`↑/↓ apply to · Enter apply`)',
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

/**
 * The rows of the frame of `frame` (its current step), drawn by the frame model at 80×24 in the form colour asks for, as the slot draws them:
 * its body asked for at the inner width (a state's sentences wrap), its legend judged on the page it draws (unless `legendParts` is given).
 */
export function frameRows(
  frame: PopupFrame,
  color: boolean,
  legendParts?: { readonly items: readonly LegendItem[]; readonly exit: LegendExit },
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
    bodyRows: naturalBodyRows(state.content, body, undefined, popupInnerWidth(80, 'standard')),
  });
  if (!geometry.fits) throw new Error('refused');
  return withGlyphForm(!color, () =>
    popupFrameLines(
      {
        title: frame.spec.title,
        origin: frame.spec.origin,
        steps: rail.names,
        stepIndex: rail.index,
        legend:
          legendParts ??
          popupLegend(
            frame,
            bodyPageRows(state.content, body.filter !== undefined, geometry),
            geometry.innerWidth,
          ),
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

/** The frame of a native prompt the slot draws at 80×24 (the overlay), through the slot's own geometry and frame lines. */
function nativeFrameRows(snapshot: NativePromptSnapshot, color: boolean) {
  const { geometry, layout } = nativePopupGeometry(
    snapshot,
    'overlay',
    { cols: 80, rows: 24 },
    color,
  );
  if (!geometry.fits || layout === undefined || !layout.fits) throw new Error('refused');
  return nativePopupFrameLines(snapshot, geometry, layout, color);
}

/** Every framed kind's legend row (MVP-11 unit 6, 6.1), drawn by the real frame view through the slot's frame lines. */
const recordNativeFramed: Recorder = (): StateRows => {
  const named = (exitLabel: string): NativePopupDescriptor => ({
    title: '/flow',
    origin: 'home',
    stepIndex: 1,
    stepCount: 3,
    stepNames: ['Choose', 'Fill', 'Finish'],
    exitLabel,
    depth: 1,
  });
  const chord: NativePromptSnapshot = {
    ...NATIVE_BASE,
    kind: 'chord',
    message: "Import workflow 'deploy' into this project?",
    options: [
      { value: 'allow', label: 'Write the file' },
      { value: 'deny', label: 'Write nothing' },
    ],
    details: ['to          .relavium/workflows/deploy.relavium.yaml'],
  };
  const picker: NativePromptSnapshot = {
    ...NATIVE_BASE,
    kind: 'picker',
    message: 'Resume a session',
    options: [{ value: 's1', label: 'Fix the flaky test', hint: '2 days ago' }],
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
  const cases: readonly (readonly [string, NativePromptSnapshot])[] = [
    [
      label({ kind: 'select', list: 'whole', exit: 'skip for now' }),
      { ...NATIVE_BASE, popup: named('skip for now') },
    ],
    [
      label({ kind: 'select', list: 'window' }),
      {
        ...NATIVE_BASE,
        options: Array.from({ length: 40 }, (_, index) => ({
          value: `v${String(index)}`,
          label: `Option ${String(index)}`,
        })),
        selected: 20,
        popup: named('close'),
      },
    ],
    [
      label({ kind: 'password', after: 'resize' }),
      {
        ...NATIVE_BASE,
        kind: 'password',
        options: [],
        message: 'Paste your key',
        error: NATIVE_PROMPT_RESIZED,
        popup: named('close'),
      },
    ],
    [
      label({ kind: 'busy' }),
      {
        ...NATIVE_BASE,
        kind: 'busy',
        options: [],
        message: 'Checking your key',
        popup: named('close'),
      },
    ],
    [label({ kind: 'chord', escape: 'cancel' }), { ...chord, popup: named('close') }],
    [label({ kind: 'chord', escape: 'back' }), { ...chord, escape: 'back', popup: named('close') }],
    [label({ kind: 'picker', state: 'list' }), { ...picker, popup: named('close') }],
    [
      label({ kind: 'picker', state: 'failed', retry: 'yes' }),
      {
        ...picker,
        options: [],
        error: 'Session history could not be read',
        picker: { ...picker.picker!, retryable: true },
        popup: named('close'),
      },
    ],
    [
      label({ kind: 'picker', state: 'failed', retry: 'no' }),
      { ...picker, options: [], error: 'Filter must be one line', popup: named('close') },
    ],
    [
      label({ kind: 'done' }),
      {
        ...NATIVE_BASE,
        message: 'Created the project directories.',
        details: ['.relavium'],
        options: [{ value: 'done', label: 'Close' }],
        final: 'ok',
        popup: { ...named('skip for now'), stepIndex: 2 },
      },
    ],
  ];
  const states: Record<string, readonly string[]> = {};
  for (const [state, snapshot] of cases)
    Object.assign(
      states,
      legendStates(
        state,
        (color) => (
          <PopupFrameView
            lines={nativeFrameRows(snapshot, color)}
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
    withContent(
      openFrame(doctorSpec('home', false), 1),
      DOCTOR_STEP.checks,
      checksContent(view),
      doctorChecksControls(true),
    );
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
      withContent(
        base,
        DOCTOR_STEP.checks,
        {
          kind: 'error',
          what: 'The checks could not run.',
          next: '[r] runs them again.',
        },
        doctorChecksControls(false),
      ),
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

/** The `/effort` popup on a graded model (every tier a row) and a budget model (`off` and `on`), and a model with no tier to choose. */
const recordEffort: Recorder = (): StateRows => {
  const frameOf = (model: string, current: ReasoningEffort | undefined): PopupFrame => {
    const tiers = effortTiersFor(model);
    return openFrame(
      effortSpec(
        'chat',
        effortContent(model, tiers, current),
        effortInitialRow(model, tiers, current),
      ),
      1,
    );
  };
  return {
    ...frameStates(
      label({ model: 'graded', current: 'medium' }),
      frameOf('claude-sonnet-4-6', 'medium'),
    ),
    ...frameStates(
      label({ model: 'graded', current: 'none' }),
      frameOf('claude-sonnet-4-6', undefined),
    ),
    ...frameStates(
      label({ model: 'budget', current: 'on' }),
      frameOf('claude-sonnet-4-5', 'medium'),
    ),
    ...frameStates(label({ model: 'no-tier' }), frameOf('gpt-4o', undefined)),
  };
};

/** A catalog row of the `/models` recording: a priced model, its window and its price per million in and out (dollars). */
function modelRow(
  modelId: string,
  provider: ProviderId,
  window: number,
  input: number,
  output: number,
): ModelCatalogEntry {
  return {
    modelId,
    provider,
    displayName: modelId,
    contextWindowTokens: window,
    pricing: {
      provider,
      nativeId: modelId,
      displayName: modelId,
      contextWindowTokens: window,
      maxOutputTokens: 8192,
      inputPerMtokMicrocents: input * 100_000_000,
      outputPerMtokMicrocents: output * 100_000_000,
      cachedInputPerMtokMicrocents: input * 100_000_000,
    },
    pricingSource: 'catalog',
    priceKnown: true,
    available: true,
    deprecated: false,
  };
}

/**
 * The `/models` popup: its list in the states that change its words (the line above the rows fresh, refreshing and failed; a typed filter),
 * its loading, empty and error states, and the second step's form in a chat (another provider, the model in force, a chat that cannot save a
 * default) and on the bare Home.
 */
const recordModels: Recorder = (): StateRows => {
  const now = Date.UTC(2026, 10, 25, 12, 0, 0);
  const entries: readonly ModelCatalogEntry[] = [
    modelRow('claude-sonnet-4-6', 'anthropic', 200_000, 3, 15),
    modelRow('gpt-4o', 'openai', 128_000, 2.5, 10),
    {
      ...modelRow('gemini-2.5-pro', 'gemini', 1_048_576, 1.25, 10),
      available: false,
      unavailableReason: 'no-key',
    },
  ];
  const view = { entries, refreshedAt: now - 3 * 60_000 };
  const current = 'claude-sonnet-4-6';
  const list = (status: CatalogStatus): PopupContent =>
    modelsListContent(view, current, status, now, providerDisplayName);
  const first = (content: PopupContent, scope: 'chat' | 'home' = 'chat'): PopupFrame =>
    openFrame(modelsSpec(scope === 'home' ? 'home' : 'chat', scope, content, current), 1);
  const second = (
    entry: ModelCatalogEntry,
    scope: 'chat' | 'home',
    canSaveDefault = true,
  ): PopupFrame => {
    const form = scopeForm({
      entry,
      scope,
      current,
      currentProvider: 'anthropic',
      defaultProvider: 'anthropic',
      currentEffort: 'medium',
      canSaveDefault,
      providerName: providerDisplayName,
    });
    const opened = openFrame(
      modelsSpec(scope === 'home' ? 'home' : 'chat', scope, list({ kind: 'idle' }), current),
      1,
    );
    return { ...withContent(opened, MODELS_STEP.scope, form), stepIndex: MODELS_STEP.scope };
  };
  const [sonnet, gpt] = entries;
  if (sonnet === undefined || gpt === undefined) throw new Error('the recording has no catalog');
  return {
    ...frameStates(label({ step: 'model', line: 'fresh' }), first(list({ kind: 'idle' }))),
    ...frameStates(
      label({ step: 'model', line: 'refreshing' }),
      first(list({ kind: 'refreshing' })),
    ),
    ...frameStates(
      label({ step: 'model', line: 'failed' }),
      first(list({ kind: 'failed', providers: ['openai'] })),
    ),
    ...frameStates(
      label({ step: 'model', filter: 'typed' }),
      folded(first(list({ kind: 'idle' })), 'g'),
    ),
    ...frameStates(label({ step: 'model', content: 'loading' }), first(MODELS_LOADING)),
    ...frameStates(
      label({ step: 'model', content: 'empty' }),
      first(
        modelsListContent(
          { entries: [], refreshedAt: undefined },
          undefined,
          { kind: 'idle' },
          now,
          providerDisplayName,
        ),
      ),
    ),
    ...frameStates(label({ step: 'model', content: 'read-failed' }), first(MODELS_READ_FAILED)),
    ...frameStates(
      label({ step: 'model', content: 'settings-failed' }),
      first(MODELS_SETTINGS_FAILED),
    ),
    ...frameStates(
      label({ step: 'scope', host: 'chat', chosen: 'another-provider' }),
      second(gpt, 'chat'),
    ),
    ...frameStates(
      label({ step: 'scope', host: 'chat', chosen: 'in-force' }),
      second(sonnet, 'chat'),
    ),
    ...frameStates(
      label({ step: 'scope', host: 'chat', writer: 'none' }),
      second(gpt, 'chat', false),
    ),
    ...frameStates(
      label({ step: 'scope', host: 'home', chosen: 'another-provider' }),
      second(gpt, 'home'),
    ),
  };
};

/** The form of the `/models` second step, as a step after the first: with both fields, each alone, and as the first step (its `Esc close`). */
const recordForm: Recorder = (): StateRows => {
  const form: PopupForm = {
    kind: 'form',
    summary: 'gpt-5  400k context · $1.25 / $10 per M · openai',
    tabs: {
      label: 'Reasoning effort',
      verb: 'effort',
      initial: 'medium',
      options: ['low', 'medium', 'high'].map((id) => ({ id, label: id })),
    },
    radio: {
      label: 'Apply to',
      verb: 'scope',
      initial: 'chat',
      options: [
        {
          id: 'chat',
          label: 'This chat',
          detail: 'switches the model now; the conversation stays',
          warning:
            'This chat moves from Anthropic to OpenAI. Your messages and short tool receipts are sent to OpenAI.',
        },
        { id: 'new', label: 'New chats', detail: 'saves it as your default; this chat stays' },
      ],
    },
  };
  const later = (content: PopupForm): PopupFrame => ({
    ...openFrame(
      spec([
        step({ name: 'Model' }),
        step({ name: 'Effort & scope', content, enter: 'apply', legendKeep: ['Enter'] }),
      ]),
      1,
    ),
    stepIndex: 1,
  });
  return {
    ...frameStates(label({ step: 'second', fields: 'tabs+radio' }), later(form)),
    ...frameStates(label({ step: 'second', fields: 'radio' }), later({ ...form, tabs: undefined })),
    ...frameStates(label({ step: 'second', fields: 'tabs' }), later({ ...form, radio: undefined })),
    ...frameStates(
      label({ step: 'first', fields: 'tabs+radio' }),
      openFrame(spec([step({ content: form, enter: 'apply' })]), 1),
    ),
  };
};

/** A list whose rows state their effect: the highlighted row's effect under the list, and a highlighted row with none (the room kept blank). */
const recordEffect: Recorder = (): StateRows => {
  const rows: PopupContent = {
    kind: 'list',
    rows: [
      { id: 'ask', label: 'ask', detail: 'asks before every effect' },
      {
        id: 'auto',
        label: 'auto',
        detail: 'approves granted actions',
        effect:
          'Granted actions are approved without asking; a command still asks unless you remembered or approved it.',
      },
    ],
  };
  const on = (row: string): PopupFrame =>
    openFrame(spec([step({ content: rows, enter: 'apply', initialRow: row })]), 1);
  return {
    ...frameStates(label({ highlighted: 'with-effect' }), on('auto')),
    ...frameStates(label({ highlighted: 'without-effect' }), on('ask')),
  };
};

/** The `/mode` popup: its first step on the mode in force, and its second for a mode that states its effect (`auto`) and one that does not. */
const recordMode: Recorder = (): StateRows => {
  const opened = openFrame(modeSpec('chat', 'ask'), 1);
  const second = (mode: 'auto' | 'plan'): PopupFrame => ({
    ...withContent(opened, SCOPE_STEP, modeScopeForm(mode)),
    stepIndex: SCOPE_STEP,
  });
  return {
    ...frameStates(label({ step: 'mode', current: 'ask' }), opened),
    ...frameStates(label({ step: 'apply-to', mode: 'auto' }), second('auto')),
    ...frameStates(label({ step: 'apply-to', mode: 'plan' }), second('plan')),
  };
};

export const POPUP_RECORDERS: Readonly<Record<string, Recorder>> = {
  'popup-frame-legend': recordFrameLegend,
  'popup-native-legend': recordNativeLegend,
  'popup-native-framed': recordNativeFramed,
  'popup-notice': recordNotice,
  'doctor-popup': recordDoctor,
  'agent-popup': recordAgent,
  'cost-popup': recordCost,
  'workflows-popup': recordWorkflows,
  'help-popup': recordHelp,
  'effort-popup': recordEffort,
  'models-popup': recordModels,
  'popup-form': recordForm,
  'popup-effect': recordEffect,
  'mode-popup': recordMode,
};
