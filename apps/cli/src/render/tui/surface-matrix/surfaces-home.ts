import type { ConsentSubject } from '../../../engine/mcp-consent-gate.js';
import { askConsent } from '../../../home/consent-card.js';
import { bracketed } from '../harness-util.js';
import { createRunStore, type RunStore } from '../run-store.js';
import { homeModelsPort } from './chat-host.js';
import { KEYS, type HomeMount, type HomeSetup } from './home-host.js';
import {
  openExportCard,
  openImportCard,
  openInitCard,
  openModeFlow,
  openPricingCard,
  openProviderSetup,
  openResumePicker,
} from './home-flows.js';
import {
  ACTIVE_PORT,
  AGENTS_PORT,
  APPROVAL_RUN,
  BUDGET_RUN,
  DEFINED_PORT,
  FIXTURE_RUN_IDS,
  historySetup,
  POPULATED_SNAPSHOT,
  PROJECT_PERMISSIONS_PORT,
  RUN,
  RUNNING_HOST,
  SESSIONS_PORT,
  TWO_GATES_RUN,
  parkedRunSetup,
} from './home-fixtures.js';
import {
  DOCTOR_FIXTURE,
  DOCTOR_LANDMARKS,
  doctorPopupBox,
  doctorPortFor,
  driveDoctor,
  type DoctorState,
} from './doctor-fixture.js';
import { PALETTE_LEGEND_ROW } from './palette-legend.js';
import {
  recordBaseline,
  TEST_POPUP_LEGEND_ROW,
  TEST_POPUP_TITLE,
  testPopupBox,
  testReportPopup,
} from './popup-fixture.js';
import type { HomeSurface } from './surface-types.js';

/**
 * The surfaces of the bare Home, each opened with the keys and the state a person reaches it by, over ports the Home's own component tests
 * script. A native prompt card is opened on the channel `driveHome` wires, with the card kind the production flow asks it for.
 */

const settleOn = (m: HomeMount, text: string): Promise<boolean> =>
  m.until(() => m.text().includes(text));

/** Type a line the way a person pastes it (a lone `/` would open the palette), then Enter. */
async function typeCommand(m: HomeMount, line: string): Promise<void> {
  m.key(bracketed(line));
  await m.until(() => m.controller.getSnapshot().input.text === line);
  m.key(KEYS.enter);
  await m.settle();
}

/** Open a card on the native channel and leave it unanswered: the promise is never awaited, so it must never be an unhandled rejection. */
function openCard(
  m: HomeMount,
  ask: (flow: NonNullable<HomeMount['channel']>['flow']) => Promise<unknown>,
): void {
  const channel = m.channel;
  if (channel === undefined) throw new Error('the surface needs a native prompt channel');
  channel.flow.begin();
  ask(channel.flow).catch(() => undefined);
}

const NATIVE: HomeSetup = { nativePrompt: true };

/**
 * Type a command into the landing key by key, as the controller reads them (a paste is refused below the floor; a key is not), then Enter: the
 * line goes through the Home's own routing, which opens a popup where the command has one.
 */
async function typeKeys(m: HomeMount, line: string): Promise<void> {
  for (const letter of line) m.controller.handleKey(letter, {});
  m.controller.handleKey('', { return: true });
  await m.settle();
}

/** The Home's `/doctor` popup in one state: the landing behind it, the command typed and routed, the popup's own rows in its box. */
function homeDoctorSurface(state: DoctorState, title: string): HomeSurface {
  return {
    host: 'home',
    id: `home.doctor-${state}`,
    title,
    exitKey: 'Esc',
    landmark: DOCTOR_LANDMARKS[state],
    ...(state === 'checks' ? { selectedRow: 'OS keychain' } : {}),
    belowFloor: /too small for this popup/iu,
    popup: doctorPopupBox,
    setup: () => ({ doctor: doctorPortFor('home', DOCTOR_FIXTURE[state]) }),
    notes:
      'the body behind the popup: the empty, keyed landing; the popup is opened by typing /doctor, through the Home’s routing',
    open: async (m) => {
      recordBaseline(m);
      await driveDoctor(m, () => typeKeys(m, '/doctor'), state);
    },
  };
}

const openTab =
  (tab: 'defined' | 'active' | 'history' | 'agents' | 'sessions' | 'permissions') =>
  async (m: HomeMount): Promise<void> => {
    m.controller.openScreen('tab-host', { tab });
    await m.settle();
  };

/** The History tab over every directory, the cursor moved onto the fixture's failed run (the one with nodes), and its detail opened. */
async function openFailedRunDetail(m: HomeMount): Promise<void> {
  m.key('a'); // every directory: the fixture runs carry no project root of this one
  await settleOn(m, 'ship-it');
  const onFailedRun = (): boolean => m.text().includes(FIXTURE_RUN_IDS.failed);
  for (let presses = 0; presses < 8 && !onFailedRun(); presses += 1) {
    m.key(KEYS.down);
    await m.settle();
  }
  m.key(KEYS.enter);
  await settleOn(m, 'Nodes (4)');
}

/** A store that has seen a run start, three nodes begin and the last one stream a few lines (the run view's live output). */
function runStoreWithNodes(color: boolean): RunStore {
  const store = createRunStore(color);
  let seq = 0;
  const envelope = () => {
    seq += 1;
    return { runId: RUN, timestamp: '2026-11-23T12:00:00.000Z', sequenceNumber: seq };
  };
  store.apply({
    ...envelope(),
    type: 'run:started',
    workflowId: '00000000-0000-4000-8000-000000000001',
    inputs: {},
    executionMode: 'local',
  });
  for (let i = 0; i < 3; i += 1) {
    const nodeId = `node-${String(i)}`;
    store.apply({ ...envelope(), type: 'node:started', nodeId, nodeType: 'agent' });
    if (i < 2)
      store.apply({
        ...envelope(),
        type: 'node:completed',
        nodeId,
        output: null,
        tokensUsed: { input: 1, output: 2 },
        durationMs: 5,
      });
  }
  for (let line = 0; line < 4; line += 1)
    store.apply({
      ...envelope(),
      type: 'agent:token',
      nodeId: 'node-2',
      token: `streamed line ${String(line)}\n`,
      model: 'm',
    });
  store.tick();
  return store;
}

const SUBJECT: ConsentSubject = {
  serverId: 'files',
  provenance: 'inline',
  artifact: 'workflows/build.yaml',
  resolvedCommand: '/usr/local/bin/npx',
  authoredCommand: 'npx',
  args: ['-y', '@example/files-server', '--root', '.'],
  env: [['FILES_TOKEN', '<secret:files-token>']],
  cwd: '/work/project',
  digest: 'v1:0123456789abcdef0123456789abcdef',
  total: 1,
  index: 1,
  previouslyApprovedIn: undefined,
};

export const HOME_SURFACES: readonly HomeSurface[] = [
  {
    host: 'home',
    id: 'home.popup',
    title: 'A popup over the landing (the test layer’s report popup)',
    exitKey: 'Esc',
    landmark: TEST_POPUP_TITLE,
    selectedRow: 'alpha check',
    legendRow: TEST_POPUP_LEGEND_ROW,
    belowFloor: /too small for this popup/iu,
    popup: testPopupBox('home'),
    notes:
      'the body behind the popup: the empty, keyed landing (the banner, the wordmark, the hints, and the prompt with its cursor)',
    open: async (m) => {
      recordBaseline(m);
      m.popups.openForUser(testReportPopup('home'));
      await settleOn(m, TEST_POPUP_TITLE);
    },
  },
  {
    host: 'home',
    id: 'home.popup-populated',
    title: 'A popup over the populated landing (its strip and its attention row)',
    exitKey: 'Esc',
    landmark: TEST_POPUP_TITLE,
    selectedRow: 'alpha check',
    belowFloor: /too small for this popup/iu,
    popup: testPopupBox('home'),
    setup: () => ({ snapshot: POPULATED_SNAPSHOT }),
    notes:
      'the body behind the popup: the landing with its banner, the failed-run attention row, the strips of conversations, runs and agents, and the prompt with its cursor',
    open: async (m) => {
      await m.until(() => m.homePainted());
      recordBaseline(m);
      m.popups.openForUser(testReportPopup('home'));
      await settleOn(m, TEST_POPUP_TITLE);
    },
  },
  {
    host: 'home',
    id: 'home.popup-selected-row',
    title: 'A popup over the populated landing with a strip row selected (the ↓ flow)',
    exitKey: 'Esc',
    landmark: TEST_POPUP_TITLE,
    selectedRow: 'alpha check',
    belowFloor: /too small for this popup/iu,
    popup: testPopupBox('home'),
    setup: () => ({ snapshot: POPULATED_SNAPSHOT }),
    notes:
      'the body behind the popup: the populated landing with the failed run focused, so its row is bold and inverse (a popup cannot open over a tab screen, which owns the keyboard)',
    open: async (m) => {
      await m.until(() => m.homePainted());
      m.key(KEYS.down);
      await m.until(() => m.controller.getSnapshot().stripFocus !== undefined && m.homePainted());
      recordBaseline(m);
      m.popups.openForUser(testReportPopup('home'));
      await settleOn(m, TEST_POPUP_TITLE);
    },
  },
  {
    host: 'home',
    id: 'home.empty-keyed',
    title: 'The empty Home with a provider key',
    exitKey: 'Ctrl+C',
    landmark: 'Welcome to Relavium',
    open: async () => {},
  },
  {
    host: 'home',
    id: 'home.empty-keyless',
    title: 'The empty Home with no provider key (first run)',
    exitKey: 'Ctrl+C',
    landmark: 'No provider key yet',
    setup: { keyless: true },
    open: async () => {},
  },
  {
    host: 'home',
    id: 'home.populated-parked-run',
    title: 'The populated Home: a parked run, a failed run, conversations and agents',
    exitKey: 'Ctrl+C',
    landmark: 'Attention',
    setup: () => parkedRunSetup(APPROVAL_RUN, 'approval'),
    open: async () => {},
  },
  {
    host: 'home',
    id: 'home.strip-focus',
    title: 'The populated Home with a strip row focused (the ↓ flow)',
    exitKey: 'Esc',
    landmark: 'Esc return to prompt',
    selectedRow: 'ship-it  ·  failed',
    setup: () => ({ snapshot: POPULATED_SNAPSHOT }),
    open: async (m) => {
      await m.until(() => m.homePainted());
      m.key(KEYS.down);
      await m.until(() => m.controller.getSnapshot().stripFocus !== undefined);
    },
  },
  {
    host: 'home',
    id: 'home.strip-focus-parked',
    title: 'The populated Home with the parked run focused (the ↓ flow on an Attention row)',
    exitKey: 'Esc',
    landmark: 'Esc return to prompt',
    selectedRow: 'run-0001  ·  ship-it',
    setup: () => parkedRunSetup(APPROVAL_RUN, 'approval'),
    open: async (m) => {
      await m.until(() => m.homePainted());
      m.key(KEYS.down);
      await m.until(
        () => m.controller.getSnapshot().stripFocus?.id !== undefined && m.homePainted(),
      );
    },
  },
  {
    host: 'home',
    id: 'home.loading',
    title: 'The Home while a chat is being built (the typed message echoed)',
    exitKey: 'Ctrl+C',
    landmark: 'hello there',
    open: async (m) => {
      for (const letter of 'hello there') m.controller.handleKey(letter, {});
      m.controller.handleKey('', { return: true });
      await m.until(() => m.controller.getSnapshot().mode === 'loading');
    },
  },
  {
    host: 'home',
    id: 'home.palette',
    title: 'The / palette on the landing',
    exitKey: 'Esc',
    landmark: 'select · Enter run',
    legendRow: PALETTE_LEGEND_ROW,
    selectedRow: '/run  ',
    open: async (m) => {
      m.key('/');
      await m.until(() => m.controller.getSnapshot().palette !== undefined);
    },
  },
  {
    host: 'home',
    id: 'home.help',
    title: 'The /help screen',
    exitKey: 'Esc',
    landmark: 'Keys of the Home',
    open: async (m) => {
      m.controller.openScreen('help');
      await settleOn(m, 'Keys of the Home');
    },
  },
  {
    host: 'home',
    id: 'home.notice',
    // `/doctor` is a popup now (ADR-0148 §8) and writes no notice; a command that answers in a line still does.
    title: 'A command’s one-line answer as the Home’s notice (`/clear` with no conversation)',
    exitKey: 'Ctrl+C',
    landmark: 'no conversation to clear',
    open: async (m) => {
      await typeCommand(m, '/clear');
      await m.until(() => m.controller.getSnapshot().notice !== undefined);
    },
  },
  homeDoctorSurface('checks', 'The /doctor popup: the quick tier’s checks'),
  homeDoctorSurface('detail', 'The /doctor popup: a row’s detail step'),
  homeDoctorSurface('line', 'The /doctor popup: the deep tier’s confirmation line'),
  homeDoctorSurface('running', 'The /doctor popup: the deep tier running'),
  homeDoctorSurface('done', 'The /doctor popup: the deep result, with its age'),
  homeDoctorSurface('empty', 'The /doctor popup: a line with nothing to send'),
  homeDoctorSurface('error', 'The /doctor popup: checks that could not run'),
  {
    host: 'home',
    id: 'home.tab-defined',
    title: 'The Defined tab (workflows)',
    exitKey: 'Esc',
    landmark: 'alpha',
    selectedRow: ['beta  1 node', 'Defined'],
    setup: { deps: { defined: DEFINED_PORT } },
    open: openTab('defined'),
  },
  {
    host: 'home',
    id: 'home.tab-active',
    title: 'The Active tab (runs in flight)',
    exitKey: 'Esc',
    landmark: 'hostrun1',
    selectedRow: ['running  hostrun1', 'Active'],
    setup: { deps: { active: ACTIVE_PORT } },
    open: async (m) => {
      await openTab('active')(m);
      await settleOn(m, 'hostrun1');
    },
  },
  {
    host: 'home',
    id: 'home.tab-history',
    title: 'The History tab (finished runs)',
    exitKey: 'Esc',
    landmark: 'ship-it',
    setup: historySetup,
    open: async (m) => {
      await openTab('history')(m);
      m.key('a'); // every directory: the fixture runs carry no project root of this one
      await settleOn(m, 'ship-it');
    },
  },
  {
    host: 'home',
    id: 'home.run-detail',
    title: 'The History tab’s run detail (a failed run and its nodes)',
    exitKey: 'Esc',
    landmark: 'Nodes (4)',
    setup: historySetup,
    open: async (m) => {
      await openTab('history')(m);
      await openFailedRunDetail(m);
    },
  },
  {
    host: 'home',
    id: 'home.node-detail',
    title: 'The node page of a run’s detail',
    exitKey: 'Esc',
    landmark: 'Order in the workflow',
    setup: historySetup,
    open: async (m) => {
      await openTab('history')(m);
      await openFailedRunDetail(m);
      const line = (): string =>
        m.frame().find((row) => row.startsWith('› ') || row.startsWith('> ')) ?? '';
      for (let presses = 0; presses < 12 && !/completed\s+plan/u.test(line()); presses += 1) {
        const before = line();
        m.key(KEYS.down);
        await m.until(() => line() !== before);
      }
      m.key(KEYS.enter);
      await settleOn(m, 'Order in the workflow');
    },
  },
  {
    host: 'home',
    id: 'home.tab-agents',
    title: 'The Agents tab (the project’s agents)',
    exitKey: 'Esc',
    landmark: 'reviewer',
    selectedRow: ['reviewer  Reviewer', 'Defined'],
    setup: { deps: { agents: AGENTS_PORT } },
    open: openTab('agents'),
  },
  {
    host: 'home',
    id: 'home.tab-sessions',
    title: 'The Sessions tab (saved conversations)',
    exitKey: 'Esc',
    landmark: 'Fix the flaky test',
    selectedRow: ['Fix the flaky test  chat', 'Sessions'],
    setup: { deps: { sessions: SESSIONS_PORT } },
    open: openTab('sessions'),
  },
  {
    host: 'home',
    id: 'home.tab-permissions',
    title: 'The Permissions tab (remembered commands)',
    exitKey: 'Esc',
    landmark: 'npm, 1 argument',
    selectedRow: ['npm, 1 argument', 'Permissions'],
    setup: { deps: { permissions: PROJECT_PERMISSIONS_PORT } },
    open: openTab('permissions'),
  },
  {
    host: 'home',
    id: 'home.run-view',
    title: 'The run view of a hosted run',
    exitKey: 'Esc',
    landmark: 'streamed line',
    setup: {
      deps: {
        hostedRuns: {
          snapshot: () => RUNNING_HOST,
          cancel: () => false,
          close: () => Promise.resolve(),
        },
      },
    },
    open: async (m) => {
      m.controller.openScreen('run-view', {
        runId: RUN,
        store: runStoreWithNodes(m.variant.color),
      });
      await settleOn(m, 'streamed line');
    },
  },
  {
    host: 'home',
    id: 'home.gate-card',
    title: 'The gate card of a parked run',
    exitKey: 'Esc',
    landmark: 'Ship the release?',
    setup: () => parkedRunSetup(APPROVAL_RUN, 'approval'),
    open: async (m) => {
      await m.until(() => m.homePainted());
      m.key(KEYS.down);
      await m.until(
        () => m.controller.getSnapshot().stripFocus?.id !== undefined && m.homePainted(),
      );
      m.key(KEYS.enter);
      await m.until(() => m.controller.getSnapshot().screen?.kind === 'gate-card');
    },
  },
  {
    host: 'home',
    id: 'home.gate-card-list',
    title: 'The gate card of a run parked at two gates (the list, the cursor on the first)',
    exitKey: 'Esc',
    landmark: 'Ship the release?',
    selectedRow: 'g1 · approval',
    setup: () => parkedRunSetup(TWO_GATES_RUN, 'approval'),
    open: async (m) => {
      await m.until(() => m.homePainted());
      m.key(KEYS.down);
      await m.until(
        () => m.controller.getSnapshot().stripFocus?.id !== undefined && m.homePainted(),
      );
      m.key(KEYS.enter);
      await m.until(() => m.controller.getSnapshot().screen?.kind === 'gate-card');
    },
  },
  {
    host: 'home',
    id: 'home.budget-card',
    title: 'The budget card of a parked run',
    exitKey: 'Esc',
    landmark: /budget|Budget/u,
    setup: () => parkedRunSetup(BUDGET_RUN, 'budget'),
    open: async (m) => {
      await m.until(() => m.homePainted());
      m.key(KEYS.down);
      await m.until(
        () => m.controller.getSnapshot().stripFocus?.id !== undefined && m.homePainted(),
      );
      m.key(KEYS.enter);
      await m.until(() => m.controller.getSnapshot().screen?.kind === 'gate-card');
    },
  },
  {
    host: 'home',
    id: 'home.mcp-consent-card',
    title: 'The MCP consent card (a chord card)',
    exitKey: 'Esc',
    landmark: 'Allow MCP server',
    setup: NATIVE,
    open: async (m) => {
      openCard(m, (flow) => askConsent(flow, SUBJECT));
      await settleOn(m, 'Allow MCP server');
    },
  },
  {
    host: 'home',
    id: 'home.exit-guard',
    title: 'The exit-guard card (leaving with a run executing)',
    exitKey: 'Esc',
    landmark: 'A workflow run is executing',
    setup: {
      deps: {
        hostedRuns: {
          snapshot: () => RUNNING_HOST,
          cancel: () => true,
          close: () => Promise.resolve(),
        },
      },
    },
    open: async (m) => {
      await m.settle();
      m.key(KEYS.ctrlD);
      await m.until(() => m.controller.getSnapshot().exitGuard === 'confirm');
    },
  },
  {
    host: 'home',
    id: 'home.model-picker',
    title: 'The /models picker (the next session’s default)',
    exitKey: 'Esc',
    landmark: 'Claude Sonnet 4.5',
    selectedRow: 'Claude Sonnet 4.5 · ',
    setup: { deps: { models: homeModelsPort } },
    open: async (m) => {
      await typeCommand(m, '/models');
      await settleOn(m, 'Claude Sonnet 4.5');
    },
  },
  {
    host: 'home',
    id: 'home.mode-flow',
    title: 'The /mode flow (the startup default), a native card',
    exitKey: 'Esc',
    landmark: /startup/u,
    setup: NATIVE,
    open: async (m) => {
      openModeFlow(m);
      await m.until(() => /startup/u.test(m.text()));
    },
  },
  {
    host: 'home',
    id: 'home.init-card',
    title: 'The /init card (what will be created, and the question)',
    exitKey: 'Esc',
    landmark: 'Create these project directories?',
    setup: NATIVE,
    open: async (m) => {
      openInitCard(m);
      await settleOn(m, 'Create these project directories?');
    },
  },
  {
    host: 'home',
    id: 'home.import-card',
    title: 'The /import card (what would be written, a chord card)',
    exitKey: 'Esc',
    landmark: "Import workflow 'nightly-report'",
    setup: NATIVE,
    open: async (m) => {
      const { answer } = openImportCard(m);
      await settleOn(m, 'Path of the workflow');
      await m.settle();
      answer();
      await settleOn(m, "Import workflow 'nightly-report'");
    },
  },
  {
    host: 'home',
    id: 'home.export-card',
    title: 'The Defined tab’s export card (where a workflow would be written, a chord card)',
    exitKey: 'Esc',
    landmark: "Write workflow 'nightly-report'",
    setup: NATIVE,
    open: async (m) => {
      openExportCard(m);
      await settleOn(m, "Write workflow 'nightly-report'");
    },
  },
  {
    host: 'home',
    id: 'home.pricing-card',
    title: 'The /pricing form (its first question)',
    exitKey: 'Esc',
    landmark: 'Model pricing: what do you want to do?',
    setup: NATIVE,
    open: async (m) => {
      openPricingCard(m);
      await settleOn(m, 'Model pricing: what do you want to do?');
    },
  },
  {
    host: 'home',
    id: 'home.resume-picker',
    title: 'The /resume picker',
    exitKey: 'Esc',
    landmark: 'Resume a session',
    selectedRow: 'Fix the flaky test · ',
    setup: NATIVE,
    open: async (m) => {
      openResumePicker(m);
      await settleOn(m, 'Resume a session');
    },
  },
  {
    host: 'home',
    id: 'home.native-provider-list',
    title: 'The provider setup’s list of providers (/providers)',
    exitKey: 'Esc',
    landmark: /Anthropic/u,
    setup: NATIVE,
    open: async (m) => {
      openProviderSetup(m, { mode: 'explicit' });
      await m.until(() => /Anthropic/u.test(m.text()));
    },
  },
  {
    host: 'home',
    id: 'home.native-key-step',
    title: 'The provider setup’s key step (a masked field)',
    exitKey: 'Esc',
    landmark: /API key|key for/u,
    setup: NATIVE,
    open: async (m) => {
      openProviderSetup(m, { mode: 'explicit' });
      await m.until(() => /Anthropic/u.test(m.text()));
      await m.settle();
      m.key(KEYS.enter);
      await m.until(() => /API key|key for/u.test(m.text()));
    },
  },
  {
    host: 'home',
    id: 'home.native-env-consent',
    title: 'The provider setup’s consent to use a key found in the environment',
    exitKey: 'Esc',
    landmark: 'Allow this source?',
    setup: NATIVE,
    open: async (m) => {
      openProviderSetup(m, { mode: 'automatic', env: { OPENAI_API_KEY: 'sk-matrix-0000' } });
      await settleOn(m, 'Allow this source?');
    },
  },
  {
    host: 'home',
    id: 'home.native-keychain-card',
    title: 'The provider setup’s card for an unavailable keychain',
    exitKey: 'Esc',
    landmark: /keychain/iu,
    setup: NATIVE,
    open: async (m) => {
      openProviderSetup(m, { mode: 'explicit', keychain: 'unavailable' });
      await m.until(() => /Anthropic/u.test(m.text()));
      await m.settle();
      m.key(KEYS.enter);
      await m.until(() => /keychain/iu.test(m.text()));
    },
  },
  {
    host: 'home',
    id: 'home.native-failed-check-card',
    title: 'The provider setup’s card for a key the provider refused',
    exitKey: 'Esc',
    landmark: /refused|rejected|did not work|failed/iu,
    setup: NATIVE,
    open: async (m) => {
      openProviderSetup(m, { mode: 'explicit', rejectKeys: true });
      await m.until(() => /Anthropic/u.test(m.text()));
      await m.settle();
      m.key(KEYS.enter);
      await m.until(() => /API key|key for/u.test(m.text()));
      await m.settle();
      m.key(bracketed('sk-ant-matrix-0000000000000000000000'));
      await m.settle();
      m.key(KEYS.enter);
      await m.until(() => /refused|rejected|did not work|failed/iu.test(m.text()));
    },
  },
];
