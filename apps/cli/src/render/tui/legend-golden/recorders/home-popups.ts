import {
  DOWN,
  ENTER,
  fakeAgents,
  fakeWorkflows,
  detailOf,
  homeRig,
  readyAgent,
  settleWork,
  workflowEntry,
  type HomeRig,
} from '../../../../popups/home-popups.test-support.js';
import type { HomeWorkflowRun } from '../../../../popups/home-port.js';
import {
  homePermissionsContent,
  permissionsControls,
  permissionsSpec,
} from '../../../../popups/permissions-popup.js';
import {
  floorPageRows,
  highlightedRow,
  openFrame,
  withContent,
  type PopupFrame,
} from '../../../../popups/popup-reducer.js';
import { label, type Producer, type Recorder, type StateRows } from '../golden.js';
import { frameRows } from './popups.js';
import { rolesOf } from './sheets.js';

/**
 * The legends of the Home's management popups ([MVP-11 unit 8](../../../../../../../docs/roadmap/phases/mvp-11/unit-8-plan.md) §4, OD-24; review
 * round 1, D-6): `/workflows` (the catalogue, a workflow's detail as it opens, with a last run highlighted, with none, long enough to page, unreadable),
 * `/agents` (the list, a ready agent's detail, one that does not parse), `/help` and the Home's `/permissions`. Each is the real session driven over
 * fake ports on a manual clock, the frame the host holds drawn by the frame model at 80×24, so the golden pins `[h] runs`, `[c] chat`, `[x] export`,
 * `[r] run`, the `Enter` verb a run row carries and the Home's way back (`Esc back to Home`), with the role each key takes.
 */

const NOW = Date.parse('2026-11-27T12:00:00Z');

const RUNS: readonly HomeWorkflowRun[] = [
  {
    runId: '41ae651d-5b7d-4e11-9a0c-77d2e3f4a5b6',
    status: 'paused',
    at: new Date(NOW - 5 * 60_000).toISOString(),
  },
  {
    runId: '092e6161-5b7d-4e11-9a0c-77d2e3f4a5b6',
    status: 'completed',
    at: new Date(NOW - 48 * 3_600_000).toISOString(),
  },
  {
    runId: 'fa7f8a61-5b7d-4e11-9a0c-77d2e3f4a5b6',
    status: 'failed',
    at: new Date(NOW - 96 * 3_600_000).toISOString(),
  },
];

/** The legend row of the frame the host has open, as drawn (colour off), and the role of each of its keys. */
function legendOf(rig: HomeRig): readonly string[] {
  const frame = rig.host.getSnapshot().frame;
  if (frame === undefined) throw new Error('no popup is open');
  const line = frameRows(frame, false).find((entry) => entry.kind === 'legend');
  return [line?.text.trim() ?? '(no legend)', rolesOf(line)];
}

/** The page the keys judge an overflow on is the one the frame is drawn in at 80×24 (the host's own binding, as the slot makes it). */
function bindFloorPage(rig: HomeRig): void {
  rig.host.bindPageRows(() => {
    const frame = rig.host.getSnapshot().frame;
    return frame === undefined ? 1 : floorPageRows(frame);
  });
}

/** The popup opened and its first read landed and shown. */
async function opened(
  rig: HomeRig,
  kind: 'workflows' | 'agents' | 'help',
  port: Parameters<HomeRig['open']>[1],
): Promise<HomeRig> {
  rig.open(kind, port);
  bindFloorPage(rig);
  await settleWork();
  rig.settle();
  return rig;
}

/** `Enter` on the highlighted row, and the detail's read landed and shown. */
async function enter(rig: HomeRig): Promise<void> {
  rig.press('', ENTER);
  await settleWork();
  rig.settle();
}

/** The one `↓` that lands on the first last run of a detail that fits (nothing is highlighted when it opens). */
function walkToFirstRun(rig: HomeRig): void {
  rig.press('', DOWN);
  const frame = rig.host.getSnapshot().frame;
  if (frame === undefined || highlightedRow(frame)?.id !== 'run:0')
    throw new Error('one ↓ did not land on the first last run');
}

const workflowsPort = (
  options: {
    readonly entries?: ReturnType<typeof workflowEntry>[];
    readonly runs?: boolean;
    readonly detail?: ReturnType<typeof detailOf>;
    readonly throws?: boolean;
  } = {},
) => {
  const fakes = fakeWorkflows(options.entries ?? [workflowEntry('alpha'), workflowEntry('beta')], {
    now: NOW,
    describe: () => {
      if (options.throws === true) throw new Error('the workflow could not be read');
      return options.detail ?? detailOf();
    },
  });
  if (options.runs !== false) fakes.runs.set('alpha', [...RUNS]);
  return fakes.port;
};

const LONG_DETAIL = detailOf({
  inputs: Array.from({ length: 7 }, (_, at) => ({
    name: `argument-${String(at + 1)}`,
    type: 'string',
    required: at % 2 === 0,
  })),
  nodes: Array.from({ length: 14 }, (_, at) => ({ id: `step-${String(at + 1)}` })),
});

const recordWorkflows: Recorder = async (): Promise<StateRows> => {
  const out: Record<string, readonly string[]> = {};
  const list = await opened(homeRig(), 'workflows', { workflows: workflowsPort() });
  out[label({ popup: 'workflows', step: 'list' })] = legendOf(list);
  const empty = await opened(homeRig(), 'workflows', { workflows: workflowsPort({ entries: [] }) });
  out[label({ popup: 'workflows', step: 'list', content: 'empty' })] = legendOf(empty);
  const detail = await opened(homeRig(), 'workflows', { workflows: workflowsPort() });
  await enter(detail);
  out[label({ popup: 'workflows', step: 'detail' })] = legendOf(detail);
  walkToFirstRun(detail);
  out[label({ popup: 'workflows', step: 'detail', highlighted: 'last run' })] = legendOf(detail);
  const bare = await opened(homeRig(), 'workflows', { workflows: workflowsPort({ runs: false }) });
  await enter(bare);
  out[label({ popup: 'workflows', step: 'detail', content: 'no run' })] = legendOf(bare);
  const long = await opened(homeRig(), 'workflows', {
    workflows: workflowsPort({ detail: LONG_DETAIL }),
  });
  await enter(long);
  out[label({ popup: 'workflows', step: 'detail', content: 'overflows' })] = legendOf(long);
  // The highlight on a line of text, and (End) on the last run of the overflowing page: `Enter open run` is the run's own, kept before `↑/↓ scroll`.
  long.press('', { downArrow: true });
  out[label({ popup: 'workflows', step: 'detail', content: 'overflows', highlighted: 'a line' })] =
    legendOf(long);
  long.press('', { end: true });
  out[
    label({ popup: 'workflows', step: 'detail', content: 'overflows', highlighted: 'last run' })
  ] = legendOf(long);
  const failed = await opened(homeRig(), 'workflows', {
    workflows: workflowsPort({ throws: true }),
  });
  await enter(failed);
  out[label({ popup: 'workflows', step: 'detail', content: 'unreadable' })] = legendOf(failed);
  return out;
};

const recordAgents: Recorder = async (): Promise<StateRows> => {
  const out: Record<string, readonly string[]> = {};
  const list = await opened(homeRig(), 'agents', {
    agents: fakeAgents([readyAgent('commit-reviewer')]).port,
  });
  out[label({ popup: 'agents', step: 'list' })] = legendOf(list);
  await enter(list);
  out[label({ popup: 'agents', step: 'detail', agent: 'ready' })] = legendOf(list);
  const empty = await opened(homeRig(), 'agents', { agents: fakeAgents([]).port });
  out[label({ popup: 'agents', step: 'list', content: 'empty' })] = legendOf(empty);
  return out;
};

const recordHelp: Recorder = async (): Promise<StateRows> => {
  const help = await opened(homeRig(), 'help', {
    help: { keys: [{ keys: 'Ctrl+K', verb: 'commands' }] },
  });
  return { [label({ popup: 'help' })]: legendOf(help) };
};

/** The bare Home's `/permissions`: the remembered commands and the repository's allowlist, with `[d]` while a command is there to withdraw. */
const recordPermissions: Recorder = (): StateRows => {
  const remembered = { id: 'a', label: 'npm, 1 argument', remembered: '2026-11-20 09:12Z' };
  const frameOf = (rows: readonly (typeof remembered)[]): PopupFrame => {
    const snapshot = { project: { ok: true as const, rows }, session: undefined };
    return withContent(
      openFrame(permissionsSpec('home', { kind: 'loading', what: 'Reading' }, []), 1),
      0,
      homePermissionsContent(snapshot),
      permissionsControls(snapshot),
    );
  };
  const out: Record<string, readonly string[]> = {};
  for (const [name, frame] of [
    ['remembered', frameOf([remembered])],
    ['none', frameOf([])],
  ] as const) {
    const line = frameRows(frame, false).find((entry) => entry.kind === 'legend');
    out[label({ popup: 'permissions', surface: 'home', content: name })] = [
      line?.text.trim() ?? '(no legend)',
      rolesOf(line),
    ];
  }
  return out;
};

export const HOME_POPUPS_PRODUCERS: readonly Producer[] = [
  {
    id: 'home-popups',
    file: 'popups/home-workflows-popup.ts',
    describe:
      'The Home’s management popups (MVP-11 unit 8): the legend row and the roles of its keys for /workflows (the catalogue, empty, a detail as it opens, with a last run highlighted, with none, overflowing, unreadable), /agents (the list, a ready agent’s detail, empty), /help and the Home’s /permissions (remembered commands, none): `[r] run`, `[h] runs`, `[x] export`, `[c] chat`, the `Enter` verb of a last run and `Esc back to Home`.',
  },
];

export const HOME_POPUPS_RECORDERS: Readonly<Record<string, Recorder>> = {
  'home-popups': async (): Promise<StateRows> => ({
    ...(await recordWorkflows()),
    ...(await recordAgents()),
    ...(await recordHelp()),
    ...(await recordPermissions()),
  }),
};
