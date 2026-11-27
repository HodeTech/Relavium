import { buildAgentsModel, type AgentsModelItem } from '../../../history/agents-model.js';
import type { HomeWorkflowRun } from '../../../popups/home-port.js';
import type { PopupFrame } from '../../../popups/popup-reducer.js';
import { AGENTS_PORT, DEFINED_PORT, NOW_MS, PROJECT_PERMISSIONS_PORT } from './home-fixtures.js';
import { KEYS, type HomeMount, type HomeSetup } from './home-host.js';
import { popupBoxOf, recordBaseline } from './popup-fixture.js';
import type { PopupBox } from './properties.js';
import type { HomeSurface } from './surface-types.js';
import type { Variant } from './variants.js';

/**
 * The Home's management popups in the surface matrix ([MVP-11 unit 8](../../../../../../docs/roadmap/phases/mvp-11/unit-8-plan.md) §4, OD-24):
 * `/help`, `/agents`, `/workflows` and `/permissions`, each opened the way a person opens it (the command typed on the empty, keyed landing and
 * routed by the controller, then `Enter` where the step has a second one), over the ports the Home's own tests script. The body behind each
 * popup is that landing (recorded with `recordBaseline` before the popup opens), and the box is the frame the host has open, through the one
 * geometry function and the frame model, like every popup's.
 */

/** The popup's code is loaded on its first use (a dynamic import), so the wait for its first frame is longer than a render's. */
const POPUP_WAIT_FLUSHES = 400;

/**
 * The popups' code is loaded on first use (`home-port.ts`). A cell measures the popup, not the first load of its code (a cold import can outlast
 * any number of render flushes), so the code is loaded before the command is typed, as it already is in every later cell of a real session.
 */
const warm = (): Promise<unknown> => import('../../../popups/home-session.js');

const settleOn = (m: HomeMount, text: string): Promise<boolean> =>
  m.until(() => m.text().includes(text), POPUP_WAIT_FLUSHES);

/** Type a command into the landing key by key, as the controller reads them, then Enter: the line goes through the Home's own routing. */
async function typeKeys(m: HomeMount, line: string): Promise<void> {
  for (const letter of line) m.controller.handleKey(letter, {});
  m.controller.handleKey('', { return: true });
  await m.settle();
}

/** The box of the popup the host has open in this cell. */
export const homeManageBox = (variant: Variant, live?: PopupFrame, locked = false): PopupBox =>
  popupBoxOf(live, variant, undefined, locked);

/** Three runs of the workflow whose detail the surface opens: one parked, one finished, one failed. */
const RUNS: readonly HomeWorkflowRun[] = [
  {
    runId: '41ae651d-5b7d-4e11-9a0c-77d2e3f4a5b6',
    status: 'paused',
    at: new Date(NOW_MS - 5 * 60_000).toISOString(),
  },
  {
    runId: '092e6161-5b7d-4e11-9a0c-77d2e3f4a5b6',
    status: 'completed',
    at: new Date(NOW_MS - 48 * 3_600_000).toISOString(),
  },
  {
    runId: 'fa7f8a61-5b7d-4e11-9a0c-77d2e3f4a5b6',
    status: 'failed',
    at: new Date(NOW_MS - 96 * 3_600_000).toISOString(),
  },
];

/** The agents the matrix lists: a ready one, whose definition `[c]` binds, and one that does not parse. */
const AGENT_ITEMS: readonly AgentsModelItem[] = [
  {
    entry: {
      slug: 'commit-reviewer',
      name: 'Commit reviewer',
      path: '.relavium/agents/commit-reviewer.agent.yaml',
      valid: true,
    },
    agent: {
      model: 'claude-sonnet-5-5',
      provider: 'anthropic',
      system_prompt: 'You review git commits of the repository: a TypeScript monorepo.',
      tools: ['read_file', 'search_files', 'run_command'],
      temperature: 0.2,
      reasoning_effort: undefined,
    },
  },
  {
    entry: {
      slug: 'triage-bot',
      name: 'Bug triage',
      path: '.relavium/agents/triage-bot.agent.yaml',
      valid: false,
      error: 'agent.model: required',
    },
    agent: undefined,
  },
];

const MATRIX_AGENTS = {
  ...AGENTS_PORT,
  read: () => ({
    model: buildAgentsModel(AGENT_ITEMS),
    slugOf: (index: number) => AGENT_ITEMS[index]?.entry.slug,
    pathOf: (index: number) => AGENT_ITEMS[index]?.entry.path,
    definitionOf: () => undefined,
  }),
};

/** The Home that reads these popups' data: the clock is fixed, so an age reads the same in every cell on every day. */
const SETUP: HomeSetup = {
  deps: {
    agents: MATRIX_AGENTS,
    defined: DEFINED_PORT,
    permissions: PROJECT_PERMISSIONS_PORT,
    epochNow: () => NOW_MS,
    workflowReads: {
      describe: () => ({
        description: 'Drafts release notes for a version, then waits at two human gates.',
        inputs: [{ name: 'version', type: 'string', required: true }],
        inputsMore: 0,
        nodes: [
          { id: 'start' },
          { id: 'draft' },
          { id: 'approve', note: 'approval, 10 min' },
          { id: 'review' },
          { id: 'out' },
        ],
        nodesMore: 0,
      }),
      lastRuns: () => RUNS,
    },
  },
};

/**
 * One popup surface: the command typed on the landing, the popup's own rows in its box. `steps` are the keys of the later steps (`Enter` to the
 * detail), pressed through the controller as a person would and settled one at a time.
 */
function manageSurface(options: {
  readonly id: string;
  readonly title: string;
  readonly command: string;
  readonly landmark: string;
  readonly legendRow: string | readonly string[];
  readonly selectedRow?: string | readonly string[];
  readonly setup?: HomeSetup;
  readonly notes?: string;
}): HomeSurface {
  return {
    host: 'home',
    id: options.id,
    title: options.title,
    exitKey: 'Esc',
    landmark: options.landmark,
    legendRow: options.legendRow,
    ...(options.selectedRow === undefined ? {} : { selectedRow: options.selectedRow }),
    belowFloor: /too small for this popup/iu,
    popup: homeManageBox,
    setup: options.setup ?? SETUP,
    notes:
      options.notes ??
      'the body behind the popup: the empty, keyed landing; the popup is opened by typing the command, through the Home’s routing',
    open: async (m) => {
      await warm();
      recordBaseline(m);
      await typeKeys(m, options.command);
      await m.until(() => m.popupFrame() !== undefined, POPUP_WAIT_FLUSHES);
      await settleOn(m, options.landmark);
      await m.settle();
    },
  };
}

/** The key that opens a row's detail, then the settle that lets the read land. */
async function enterDetail(m: HomeMount, landmark: string): Promise<void> {
  m.skip(1_000); // past the popup's opening guard: an answer counts
  m.key(KEYS.enter); // the key as a terminal sends it: the Home's one input owner gives it to the popup
  await settleOn(m, landmark);
  await m.settle();
}

/** `/workflows` on the catalogue and on a detail. */
function workflowsDetailSurface(): HomeSurface {
  return {
    host: 'home',
    id: 'home.workflows-detail',
    title: 'The /workflows popup: one workflow’s detail (inputs, nodes, last runs)',
    exitKey: 'Esc',
    landmark: 'Last runs',
    legendRow: '[r] run · [x] export · [p] unpin · [Ctrl+C] close · Esc back',
    selectedRow: '41ae651d',
    belowFloor: /too small for this popup/iu,
    popup: homeManageBox,
    setup: SETUP,
    notes:
      'the body behind the popup: the empty, keyed landing; /workflows typed and routed, then Enter on the highlighted row opens its detail (the second step)',
    open: async (m) => {
      await warm();
      recordBaseline(m);
      await typeKeys(m, '/workflows');
      await m.until(() => m.popupFrame() !== undefined, POPUP_WAIT_FLUSHES);
      await settleOn(m, 'alpha');
      await enterDetail(m, 'Last runs');
    },
  };
}

/** `/agents` on a detail. */
function agentsDetailSurface(): HomeSurface {
  return {
    host: 'home',
    id: 'home.agents-detail',
    title: 'The /agents popup: one agent’s detail',
    exitKey: 'Esc',
    landmark: 'System prompt',
    // Inline the page is shorter than the detail and scrolls (the second form); on the alternate screen it fits whole.
    legendRow: [
      '[c] chat · [Ctrl+C] close · Esc back',
      '↑/↓ scroll · [c] chat · [Ctrl+C] close · Esc back',
    ],
    belowFloor: /too small for this popup/iu,
    popup: homeManageBox,
    setup: SETUP,
    notes:
      'the body behind the popup: the empty, keyed landing; /agents typed and routed, then Enter on the first agent opens its detail',
    open: async (m) => {
      await warm();
      recordBaseline(m);
      await typeKeys(m, '/agents');
      await m.until(() => m.popupFrame() !== undefined, POPUP_WAIT_FLUSHES);
      await settleOn(m, 'commit-reviewer');
      await enterDetail(m, 'System prompt');
    },
  };
}

export const HOME_MANAGE_SURFACES: readonly HomeSurface[] = [
  manageSurface({
    id: 'home.help',
    title: 'The /help popup: the Home’s keys and commands on one page',
    command: '/help',
    landmark: 'Keys',
    // Inline the page is shorter than the content and scrolls (the second form); on the alternate screen it fits whole.
    legendRow: ['[c] copy · Esc back to Home', '↑/↓ scroll · [c] copy · Esc back to Home'],
  }),
  manageSurface({
    id: 'home.agents-list',
    title: 'The /agents popup: the project’s agents',
    command: '/agents',
    landmark: 'commit-reviewer',
    legendRow: '↑/↓ select · Enter details · Esc back to Home',
    selectedRow: 'Commit reviewer',
  }),
  agentsDetailSurface(),
  manageSurface({
    id: 'home.workflows-list',
    title: 'The /workflows popup: the catalogue',
    command: '/workflows',
    landmark: 'alpha',
    legendRow: '↑/↓ select · Enter details · [r] run · [h] runs · Esc back to Home',
    selectedRow: 'beta   1 node',
  }),
  workflowsDetailSurface(),
  manageSurface({
    id: 'home.permissions-popup',
    title:
      'The /permissions popup on the Home: the remembered commands and the repository’s allowlist',
    command: '/permissions',
    landmark: 'This repository',
    legendRow: '↑/↓ select · [d] / Del withdraw (then Enter) · Esc back to Home',
    selectedRow: 'npm, 1 argument',
  }),
];
