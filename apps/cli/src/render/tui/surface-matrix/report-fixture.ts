// The popups' code is loaded by a dynamic import the first time a report is asked for, which a cold test process would spend longer on than the
// matrix's bounded wait for the first frame: the fixture loads it up front, so every cell sees the popup open as a warm process does.
import '../../../popups/report-session.js';

import type { SessionCostRow } from '@relavium/db';

import { boundAgentView } from '../../../chat/bound-agent-view.js';
import { buildDefaultChatAgent } from '../../../chat/default-agent.js';
import { CliError } from '../../../process/errors.js';
import type { CatalogEntry } from '../../../workflows/catalog.js';
import type {
  CostReading,
  ReportSurface,
  ReportsPort,
  WorkflowsReading,
} from '../../../popups/report-port.js';
import { CHAT_KEYS } from '../chat-keys.js';
import { KEYS } from './home-host.js';
import { popupBoxOf } from './popup-fixture.js';
import type { PopupBox } from './properties.js';
import type { Variant } from './variants.js';
import type { PopupFrame } from '../../../popups/popup-reducer.js';

/**
 * The four report popups in the surface matrix ([ADR-0148](../../../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
 * §10): `/agent`, `/cost` (with the release and its result), `/workflows` and `/help`, in the manner of `doctor-fixture.ts`. Each port is over
 * fakes (no database, no disk, no keychain), and each popup is opened the way a person opens it: the command typed, and the chat host's own routing
 * opens it. A state that needs data to be a certain way (a held estimate, a catalog, a read that never finishes or throws) is a fixture of the port.
 */

/** The states of the reports the matrix opens. */
export const REPORT_LANDMARKS = {
  agent: 'Agent · relavium-chat',
  cost: 'Session cost:',
  'cost-held': 'estimated, possibly billed',
  'cost-release': 'This lifts about',
  'cost-done': 'back to the cap.',
  'cost-loading': 'Reading the session cost',
  'cost-error': 'Could not read the session cost',
  workflows: 'Workflows (2):',
  'workflows-empty': 'No workflows or agents found in this project.',
  'workflows-loading': 'Reading the project catalog',
  'workflows-error': 'Could not list the workflows',
  help: 'Commands',
} as const;

export type ReportState = keyof typeof REPORT_LANDMARKS;

/** The line a person types to open each state. */
export const REPORT_COMMAND: Readonly<Record<ReportState, string>> = {
  agent: '/agent',
  cost: '/cost',
  'cost-held': '/cost',
  'cost-release': '/cost --release',
  'cost-done': '/cost --release',
  'cost-loading': '/cost',
  'cost-error': '/cost',
  workflows: '/workflows',
  'workflows-empty': '/workflows',
  'workflows-loading': '/workflows',
  'workflows-error': '/workflows',
  help: '/help',
};

const row = (over: Partial<SessionCostRow> & { model: string }): SessionCostRow => ({
  modelCatalogId: undefined,
  inputTokens: 1200,
  outputTokens: 800,
  conservativeMicrocents: 0,
  costMicrocents: 12_000,
  callCount: 3,
  unpricedCalls: 0,
  isLegacy: false,
  ...over,
});

const COMPLETE = { unverified: false, pendingInvocations: 0, unknownCalls: 0 } as const;

/** A reading of the session's spend: one model, and (`held`) an estimate held against the cap that the live governor holds too. */
function reading(held: boolean): CostReading {
  return {
    totalCostMicrocents: 12_000,
    rows: [row({ model: 'claude-opus-4-8', conservativeMicrocents: held ? 450 : 0 })],
    coverage: COMPLETE,
    models: [{ model: 'claude-opus-4-8', coverage: COMPLETE }],
    governor: held ? { microcents: 450, durabilityBroken: false } : undefined,
  };
}

const entry = (slug: string, valid = true): CatalogEntry => ({
  slug,
  name: undefined,
  tags: [],
  path: `.relavium/workflows/${slug}.relavium.yaml`,
  valid,
});

/** What each state's workflows read answers. */
function catalogReading(state: ReportState): WorkflowsReading | Promise<WorkflowsReading> {
  if (state === 'workflows-loading') return new Promise<WorkflowsReading>(() => {});
  if (state === 'workflows-error') return { kind: 'fault', reason: 'too many workflow files' };
  if (state === 'workflows-empty') return { kind: 'catalog', workflows: [], agents: [] };
  return {
    kind: 'catalog',
    workflows: [entry('deploy'), entry('broken', false)],
    agents: [entry('coder')],
  };
}

/** The reports' port for one cell: every member, with the one the state names set up the way the state needs (a fresh port per cell). */
export function reportsPortFor(surface: ReportSurface, state: ReportState): ReportsPort {
  // The held estimate is released by the cost popup's confirmed step, and the total it reads again afterwards holds none.
  let held = state !== 'cost';
  return {
    surface,
    agent: () =>
      boundAgentView(buildDefaultChatAgent('claude-opus-4-8', 'high', 'anthropic'), 'high'),
    cost: {
      read: () => {
        if (state === 'cost-loading') return new Promise<CostReading>(() => {});
        if (state === 'cost-error') throw new CliError('invalid_invocation', 'a path /tmp/x');
        return reading(held);
      },
      release: () => {
        held = false;
        return { durable: 450, live: 450 };
      },
    },
    workflows: { read: () => catalogReading(state) },
    help: { keys: Object.values(CHAT_KEYS) },
  };
}

/** The box of the report popup the host has open in this cell. */
export const reportPopupBox = (variant: Variant, live?: PopupFrame, locked = false): PopupBox =>
  popupBoxOf(live, variant, undefined, locked);

/**
 * Put the report popup of `state` on a mount of any chat host: the command typed and routed by the host, the popup's clock skipped past its settle
 * time and the release line's dwell (the frame is acknowledged by the real renderer first). Below the floor the keys find no frame to act on and
 * the notice stays, as it should.
 */
export async function driveReport(
  m: {
    readonly key: (bytes: string) => void;
    readonly settle: () => Promise<void>;
    readonly until: (predicate: () => boolean) => Promise<boolean>;
    readonly frame: () => string[];
    readonly skip: (ms: number) => void;
  },
  type: (line: string) => Promise<void>,
  state: ReportState,
): Promise<void> {
  const shows = (text: string) => (): boolean => m.frame().join('\n').includes(text);
  const landmark = REPORT_LANDMARKS[state];
  await type(REPORT_COMMAND[state]);
  await m.until(shows(state === 'cost-done' ? REPORT_LANDMARKS['cost-release'] : landmark));
  await m.settle();
  if (state !== 'cost-done') return;
  // The popup opened on its line from a typed command, so a `Ctrl+Y` held across the open is locked out for two seconds after the last key: the
  // answer of a patient press, past both that and the dwell.
  m.skip(2100);
  m.key(KEYS.ctrlY);
  await m.until(shows(landmark));
  await m.settle();
}
