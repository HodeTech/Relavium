import { buildAgentsModel, type AgentsModelItem } from '../../../history/agents-model.js';
import {
  buildDefinedModel,
  type DefinedEntry,
  type DefinedPort,
} from '../../../history/defined-model.js';
import type { AgentsPort } from '../../../home/agents-port.js';
import type { HomeWorkflowRun } from '../../../popups/home-port.js';
import { highlightedRow, type PopupFrame } from '../../../popups/popup-reducer.js';
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

const MATRIX_AGENTS: AgentsPort = {
  ...AGENTS_PORT,
  read: () => ({
    model: buildAgentsModel(AGENT_ITEMS),
    slugOf: (index: number) => AGENT_ITEMS[index]?.entry.slug,
    pathOf: (index: number) => AGENT_ITEMS[index]?.entry.path,
    definitionOf: () => undefined,
  }),
};

/** The long detail of review round 1 (P-3): 14 nodes and 7 inputs, more than the page holds, so the page overflows and says so. */
const LONG_DETAIL = {
  description: 'Drafts release notes for a version, then waits at two human gates.',
  inputs: Array.from({ length: 7 }, (_, at) => ({
    name: `argument-${String(at + 1)}`,
    type: 'string',
    required: at % 2 === 0,
  })),
  inputsMore: 0,
  nodes: Array.from({ length: 14 }, (_, at) => ({ id: `step-${String(at + 1)}` })),
  nodesMore: 0,
};

/** The Home that reads these popups' data: the clock is fixed, so an age reads the same in every cell on every day. */
const SETUP_DEPS = {
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
};

const SETUP: HomeSetup = { deps: SETUP_DEPS };

/** A catalogue of `entries` and nothing pinned or run: what the empty and the overflowing lists read. */
const definedOf = (entries: readonly DefinedEntry[]): DefinedPort => ({
  read: () => ({
    model: buildDefinedModel({
      entries,
      pins: [],
      lastRuns: new Map(),
      lastRunTimes: new Map(),
    }),
    slugOf: (index) => entries[index]?.slug,
    pathOf: (index) => entries[index]?.path,
  }),
});

/** Thirty-two workflows: more rows than the popup holds, so the list is windowed and marks what it hides on both sides (review round 1, O-9). */
const MANY_WORKFLOWS: readonly DefinedEntry[] = Array.from({ length: 32 }, (_, at) => ({
  slug: `workflow-${String(at + 1).padStart(2, '0')}`,
  name: undefined,
  nodeCount: 2,
  path: `.relavium/workflows/workflow-${String(at + 1).padStart(2, '0')}.relavium.yaml`,
  valid: true,
}));

/** A catalogue the Home could not read at all: the read throws, and the popup says so in its own words. */
const UNREADABLE_DEFINED: DefinedPort = {
  read: () => {
    throw new Error('the matrix cannot list the catalogue');
  },
};

const UNREADABLE_AGENTS: AgentsPort = {
  read: () => {
    throw new Error('the matrix cannot list the agents');
  },
};

const EMPTY_AGENTS: AgentsPort = {
  read: () => ({
    model: buildAgentsModel([]),
    slugOf: () => undefined,
    pathOf: () => undefined,
    definitionOf: () => undefined,
  }),
};

const withDeps = (deps: Partial<typeof SETUP_DEPS>): HomeSetup => ({
  deps: { ...SETUP_DEPS, ...deps },
});

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
  /** How many times `↓` is pressed once the popup is up (a bounded walk down the list). */
  readonly walk?: number;
  /** What the first frame shows, to wait for before the walk starts, when the landmark is only on screen after it. */
  readonly ready?: string;
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
      await settleOn(m, options.ready ?? options.landmark);
      await m.settle();
      for (let step = 0; step < (options.walk ?? 0); step += 1) {
        m.key(KEYS.down);
        await m.settle();
      }
      if (options.ready !== undefined) await settleOn(m, options.landmark);
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

/** `↓` until the highlight stands on the detail's first last run (the page opens on its title), a bounded walk. */
async function walkToFirstRun(m: HomeMount): Promise<void> {
  for (let step = 0; step < 60; step += 1) {
    const frame = m.popupFrame();
    if (frame !== undefined && highlightedRow(frame)?.id === 'run:0') break;
    m.key(KEYS.down);
    await m.settle();
  }
}

/** `/workflows` on a detail: the page as it opens (on its title), on a last run, with no run, or long enough to overflow. */
function workflowsDetailSurface(options: {
  readonly id: string;
  readonly title: string;
  readonly landmark: string;
  readonly legendRow: string | readonly string[];
  readonly selectedRow?: string;
  readonly setup?: HomeSetup;
  readonly walk?: boolean;
  readonly notes: string;
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
    notes: options.notes,
    open: async (m) => {
      await warm();
      recordBaseline(m);
      await typeKeys(m, '/workflows');
      await m.until(() => m.popupFrame() !== undefined, POPUP_WAIT_FLUSHES);
      await settleOn(m, 'alpha');
      await enterDetail(m, options.landmark);
      if (options.walk === true) await walkToFirstRun(m);
    },
  };
}

const DETAIL_NOTES =
  'the body behind the popup: the empty, keyed landing; /workflows typed and routed, then Enter on the highlighted row opens its detail (the second step), a page that opens on its title';

const WORKFLOWS_DETAIL_SURFACES: readonly HomeSurface[] = [
  workflowsDetailSurface({
    id: 'home.workflows-detail',
    title: 'The /workflows popup: one workflow’s detail as it opens (inputs, nodes, last runs)',
    landmark: 'Last runs',
    // `↑/↓ select` (the last runs are rows to choose) is named where the width holds it, and is the first item to go.
    legendRow: [
      '[r] run · [x] export · [p] unpin · [Ctrl+C] close · Esc back',
      '↑/↓ select · [r] run · [x] export · [p] unpin · [Ctrl+C] close · Esc back',
    ],
    notes: DETAIL_NOTES,
  }),
  workflowsDetailSurface({
    id: 'home.workflows-detail-run',
    title:
      'The /workflows popup: one workflow’s detail with a last run walked onto (what Enter opens)',
    landmark: 'Last runs',
    legendRow: '[r] run · [x] export · [p] unpin · [Ctrl+C] close · Esc back',
    selectedRow: '41ae651d',
    walk: true,
    notes: `${DETAIL_NOTES}; ↓ until the first last run is highlighted`,
  }),
  workflowsDetailSurface({
    id: 'home.workflows-detail-long',
    title:
      'The /workflows popup: a detail of 14 nodes and 7 inputs, which overflows its page and names PgUp/PgDn',
    landmark: 'Drafts release notes',
    legendRow: 'PgUp/PgDn page · [r] run · [x] export · [Ctrl+C] close · Esc back',
    setup: {
      deps: { ...SETUP_DEPS, workflowReads: { describe: () => LONG_DETAIL, lastRuns: () => RUNS } },
    },
    notes: `${DETAIL_NOTES}; 14 nodes and 7 inputs make a page longer than the popup`,
  }),
  workflowsDetailSurface({
    id: 'home.workflows-detail-empty',
    title: 'The /workflows popup: a detail of a workflow with no run in this directory',
    landmark: 'No run of this workflow',
    legendRow: [
      '[r] run · [x] export · [p] unpin · [Ctrl+C] close · Esc back',
      '↑/↓ select · [r] run · [x] export · [p] unpin · [Ctrl+C] close · Esc back',
    ],
    setup: {
      deps: { ...SETUP_DEPS, workflowReads: { ...SETUP_DEPS.workflowReads, lastRuns: () => [] } },
    },
    notes: DETAIL_NOTES,
  }),
];

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
  ...WORKFLOWS_DETAIL_SURFACES,
  manageSurface({
    id: 'home.workflows-overflow',
    title: 'The /workflows popup: thirty-two workflows, windowed, with `▲ N more` and `▼ N more`',
    command: '/workflows',
    landmark: 'workflow-16',
    ready: 'workflow-01',
    legendRow: '↑/↓ select · Enter details · [r] run · [h] runs · Esc back to Home',
    selectedRow: 'workflow-16  2 nodes',
    setup: withDeps({ defined: definedOf(MANY_WORKFLOWS) }),
    walk: 15,
    notes:
      'the body behind the popup: the empty, keyed landing; /workflows typed and routed, then ↓ fifteen times, so the window has rows hidden above and below',
  }),
  manageSurface({
    id: 'home.workflows-empty',
    title: 'The /workflows popup: a project with no workflow',
    command: '/workflows',
    landmark: 'No workflows in this project.',
    legendRow: '[h] runs · Esc back to Home',
    setup: withDeps({ defined: definedOf([]) }),
  }),
  manageSurface({
    id: 'home.workflows-unreadable',
    title: 'The /workflows popup: a catalogue that could not be listed',
    command: '/workflows',
    landmark: 'could not be listed',
    // `[h] runs` does not need the catalogue, so it stays on a catalogue that could not be read.
    legendRow: '[h] runs · Esc back to Home',
    setup: withDeps({ defined: UNREADABLE_DEFINED }),
  }),
  manageSurface({
    id: 'home.agents-empty',
    title: 'The /agents popup: a project with no agent',
    command: '/agents',
    landmark: 'No agents in this project.',
    legendRow: 'Esc back to Home',
    setup: withDeps({ agents: EMPTY_AGENTS }),
  }),
  manageSurface({
    id: 'home.agents-unreadable',
    title: 'The /agents popup: a catalogue that could not be listed',
    command: '/agents',
    landmark: 'could not be listed',
    legendRow: 'Esc back to Home',
    setup: withDeps({ agents: UNREADABLE_AGENTS }),
  }),
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
