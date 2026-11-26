import { parseWorkflow } from '@relavium/core';

import { retryRestoredHistory } from '../../../../chat/restore-history.js';
import {
  createRunLaunch,
  LAUNCH_CANCELLED,
  startedNotice,
  type LaunchCatalog,
} from '../../../../home/run-launch.js';
import {
  RESUME_RESTORING,
  RESUME_STEP,
  resumePopup,
  runSessionPicker,
} from '../../../../home/session-picker.js';
import {
  nativePopupFrameLines,
  nativePopupGeometry,
  PopupFrameView,
} from '../../../../popups/popup-slot.js';
import {
  createNativePromptChannel,
  type NativePromptSnapshot,
} from '../../native-prompt-channel.js';
import { RESUME_ALREADY_OPEN, RESUME_CANCELLED } from '../../home-controller.js';
import { legendStates } from '../frames.js';
import { label, type Producer, type Recorder, type StateRows } from '../golden.js';

/**
 * `/resume` and `/run` as popups (ADR-0148 §1, §3, §6; MVP-11 unit 6, 6.4): each step's legend row as the slot draws it at 80×24, driven
 * through the product's own flows on a real channel (a clock the recorder moves, the host's acknowledgement played by hand), and the words
 * each says in its one notification. No clock of the machine, no path, no environment: the frames depend on the flows alone.
 */

/** Let the flows' effects run (each answer reaches the launch's machine a few microtasks later). */
async function until(
  read: () => NativePromptSnapshot,
  holds: (s: NativePromptSnapshot) => boolean,
): Promise<NativePromptSnapshot> {
  for (let turn = 0; turn < 50 && !holds(read()); turn += 1)
    await new Promise<void>((resolve) => setImmediate(resolve));
  const snapshot = read();
  if (!holds(snapshot)) throw new Error(`the recorder did not reach its step (${snapshot.kind})`);
  return snapshot;
}

/** The frame of a framed native prompt at 80×24 (the overlay), through the slot's own geometry and frame lines, as the real view draws it. */
function frameOf(snapshot: NativePromptSnapshot, color: boolean) {
  const { geometry, layout } = nativePopupGeometry(
    snapshot,
    'overlay',
    { cols: 80, rows: 24 },
    color,
  );
  if (!geometry.fits || layout === undefined || !layout.fits) throw new Error('refused');
  return (
    <PopupFrameView
      lines={nativePopupFrameLines(snapshot, geometry, layout, color)}
      color={color}
      placement="replace"
      left={0}
      top={0}
      contentRef={() => undefined}
    />
  );
}

/** A channel whose every frame is acknowledged at once, on a clock that moves only when the recorder says so. */
function channel() {
  let clock = 1_000;
  const made = createNativePromptChannel({ now: () => clock, settleMs: 0 });
  made.ui.bindVisibility((snapshot) => snapshot === made.ui.getSnapshot());
  made.ui.subscribe(() => made.ui.shown(made.ui.getSnapshot()));
  const key = (input: string, flags: Partial<Parameters<typeof made.ui.input>[1]> = {}): void => {
    // The frame that is up was measured and flushed, and the key comes past every guard of it: a patient person's answer.
    made.ui.shown(made.ui.getSnapshot());
    clock += 3_000;
    made.ui.input(input, {
      upArrow: false,
      downArrow: false,
      leftArrow: false,
      rightArrow: false,
      pageDown: false,
      pageUp: false,
      home: false,
      end: false,
      return: false,
      escape: false,
      ctrl: false,
      shift: false,
      tab: false,
      backspace: false,
      delete: false,
      meta: false,
      super: false,
      hyper: false,
      capsLock: false,
      numLock: false,
      ...flags,
    });
  };
  return { made, key, read: () => made.ui.getSnapshot() };
}

const FORM = `schema_version: '1.0'
workflow:
  id: release-notes
  name: Release notes
  inputs:
    - { name: version, type: string, required: true }
    - { name: token, type: secret, required: true }
  agents:
    - id: writer
      model: claude-sonnet-4-6
      provider: anthropic
      system_prompt: synthetic
      tools: [write_file]
  nodes:
    - { id: start, type: input }
    - { id: work, type: agent, agent_ref: writer }
    - { id: out, type: output }
  edges:
    - { from: start, to: work }
    - { from: work, to: out }
`;

const CATALOG: LaunchCatalog = {
  list: () => [
    { path: 'release.yaml', slug: 'release-notes', name: 'Release notes', tags: [], valid: true },
  ],
  load: () => ({
    definition: parseWorkflow(FORM, { source: 'release.yaml' }),
    sourceDigest: 'd'.repeat(64),
    fsScope: { tier: 'sandboxed', fromRepository: false },
  }),
};

/** The `/run` popup at each of its steps, and its last step when the host refuses the start. */
const recordRunPopup: Recorder = async (): Promise<StateRows> => {
  const { made, key, read } = channel();
  const launch = createRunLaunch({
    flow: made.flow,
    host: {
      start: () =>
        Promise.resolve({
          kind: 'refused',
          reason: 'rejected',
          message: 'The workflow file changed after you confirmed. Open the list again.',
        }),
    },
    catalog: CATALOG,
  });
  const steps: [string, NativePromptSnapshot][] = [];
  const opened = launch.open();
  steps.push([label({ step: 'workflow' }), await until(read, (s) => s.kind === 'select')]);
  key('', { return: true });
  steps.push([
    label({ step: 'inputs', field: 'text' }),
    await until(read, (s) => s.kind === 'text'),
  ]);
  key('v');
  key('', { return: true });
  steps.push([
    label({ step: 'inputs', field: 'secret' }),
    await until(read, (s) => s.kind === 'password'),
  ]);
  key('t');
  key('', { return: true });
  steps.push([label({ step: 'confirm' }), await until(read, (s) => s.kind === 'chord')]);
  key('y', { ctrl: true });
  steps.push([
    label({ step: 'confirm', after: 'refused' }),
    await until(read, (s) => s.kind === 'select' && s.final === 'failed'),
  ]);
  key('', { return: true });
  await opened;
  const states: Record<string, readonly string[]> = {};
  for (const [state, snapshot] of steps)
    Object.assign(
      states,
      legendStates(state, (color) => frameOf(snapshot, color), { columns: 80 }),
    );
  return {
    ...states,
    'notification started': startedNotice('Release notes', 'abcdef0123456789'),
    'notification started, a long name': startedNotice('A'.repeat(60), 'abcdef0123456789'),
    'notification cancelled': LAUNCH_CANCELLED,
  };
};

/** The `/resume` popup: its picker, the restore's wait and its retry question, in one frame. */
const recordResumePopup: Recorder = async (): Promise<StateRows> => {
  const { made, key, read } = channel();
  const flow = resumePopup(made.flow, 'home');
  flow.begin();
  const steps: [string, NativePromptSnapshot][] = [];
  const picked = runSessionPicker({
    store: {
      listSessionPage: () => ({
        sessions: [
          {
            id: 's1',
            title: 'Fix the flaky test',
            agentSlug: 'chat',
            updatedAt: '2026-11-23T00:00:00.000Z',
            workingDir: '/work/project',
          },
        ],
      }),
    },
    cwd: '/work/project',
    now: () => Date.parse('2026-11-23T01:00:00.000Z'),
    assertAdmitting: () => {},
    runRead: (operation) => operation(),
    flow,
  });
  steps.push([
    label({ step: 'session' }),
    await until(read, (s) => s.kind === 'picker' && s.options.length === 1),
  ]);
  key('', { return: true });
  await picked;
  flow.at(RESUME_STEP.restore).busy(RESUME_RESTORING);
  steps.push([label({ step: 'restore', state: 'wait' }), read()]);
  const retry = retryRestoredHistory(flow);
  steps.push([label({ step: 'restore', state: 'retry' }), read()]);
  key('', { return: true });
  await retry;
  await flow.end();
  const states: Record<string, readonly string[]> = {};
  for (const [state, snapshot] of steps)
    Object.assign(
      states,
      legendStates(state, (color) => frameOf(snapshot, color), { columns: 80 }),
    );
  return {
    ...states,
    'notification cancelled': RESUME_CANCELLED,
    'notification already open': RESUME_ALREADY_OPEN,
  };
};

export const RESUME_RUN_PRODUCERS: readonly Producer[] = [
  {
    id: 'run-launch-popup',
    file: 'home/run-launch.ts',
    describe:
      'the /run popup (MVP-11 unit 6): the picker, a field and a masked field on Inputs, the confirmation as its chord step (`[Ctrl+Y] Start it · [Ctrl+N] Cancel`), the last step of a start the host refused, and the notifications of a start and a cancel',
  },
  {
    id: 'resume-popup',
    file: 'home/session-picker.ts',
    describe:
      'the /resume popup (MVP-11 unit 6): the session picker, the restore’s wait (`Esc cancels it`) and its retry question in one frame, and the notifications of a cancelled resume and of the conversation already open',
  },
];

export const RESUME_RUN_RECORDERS = {
  'run-launch-popup': recordRunPopup,
  'resume-popup': recordResumePopup,
} as const satisfies Readonly<Record<string, Recorder>>;
