import { parseWorkflow } from '@relavium/core';
import type { SessionPage } from '@relavium/db';

import { retryRestoredHistory } from '../../../chat/restore-history.js';
import { createRunLaunch, type LaunchCatalog } from '../../../home/run-launch.js';
import {
  RESUME_RESTORING,
  RESUME_STEP,
  resumePopup,
  runSessionPicker,
} from '../../../home/session-picker.js';
import { displayRoots } from '../../display-roots.js';
import { NATIVE_PROMPT_RESIZED, type NativePromptSnapshot } from '../native-prompt-channel.js';
import type { HomeMount, HomeSetup, NativePromptChannel } from './home-host.js';
import { pinnedNativePopupBox, recordNativePopups } from './native-popup-recorder.js';
import { recordBaseline } from './popup-fixture.js';
import type { PopupBox } from './properties.js';
import type { HomeSurface } from './surface-types.js';
import type { Variant } from './variants.js';

/**
 * `/resume` and `/run` as the popups they are (ADR-0148 §1, §3; MVP-11 unit 6, 6.4), opened on the Home's native channel through the product's
 * own flows (`resumePopup` and `runSessionPicker`, the restore's retry question, `createRunLaunch`) over scripted ports: no database, no engine,
 * no run host. Each surface is checked as every popup is (its box over the body it recorded before it opened, the overlay layer, the dimmed
 * backdrop, its legend row); its box is computed from the frame the channel holds when the surface is open (the product popup's own snapshot,
 * through the slot's one geometry and frame model).
 */

const NATIVE: HomeSetup = { nativePrompt: true };

/** The snapshot each cell's surface left on the channel, by the cell's variant, and the channel it is on: what its box is computed from. */
const LIVE = new WeakMap<
  Variant,
  { readonly snapshot: NativePromptSnapshot; readonly channel: NativePromptChannel }
>();

function channelOf(m: HomeMount): NativePromptChannel {
  const channel = m.channel;
  if (channel === undefined) throw new Error('the surface needs a native prompt channel');
  recordNativePopups(channel);
  return channel;
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

/** A flow left open: the matrix never answers it, and a rejection when the channel is disposed must not be unhandled. */
const leaveOpen = (running: Promise<unknown>): void => {
  running.catch(() => undefined);
};

/** Wait until the surface's prompt is on the terminal, and keep the snapshot its box is computed from. */
async function settled(
  m: HomeMount,
  holds: (snapshot: NativePromptSnapshot) => boolean,
): Promise<void> {
  const channel = channelOf(m);
  await m.until(() => holds(channel.ui.getSnapshot()) && shownOn(channel));
  LIVE.set(m.variant, { snapshot: channel.ui.getSnapshot(), channel });
}

/** Where the open native popup is drawn in a cell, and its rows: the slot's own geometry and frame lines over the snapshot the surface left, pinned as the flow's earlier steps left it (`native-popup-recorder.ts`). */
function liveBox(variant: Variant): PopupBox {
  const live = LIVE.get(variant);
  if (live === undefined) throw new Error('the surface left no popup on the channel');
  return pinnedNativePopupBox(live.channel, live.snapshot, variant);
}

// ---- /resume ------------------------------------------------------------------------------------------------------------------------

const SESSIONS: SessionPage = {
  sessions: [
    {
      id: 's1',
      title: 'Fix the flaky test',
      agentSlug: 'chat',
      updatedAt: '2026-11-23T00:00:00.000Z',
      workingDir: '/work/project',
    },
    {
      id: 's2',
      agentSlug: 'reviewer',
      updatedAt: '2026-11-22T00:00:00.000Z',
      workingDir: '/work/project',
    },
  ],
};

/** The `/resume` popup's first step: the picker, in the frame the Home holds from the picker to the restore. */
async function openResumePopup(m: HomeMount): Promise<void> {
  recordBaseline(m);
  const flow = resumePopup(channelOf(m).flow, 'home');
  flow.begin();
  leaveOpen(
    runSessionPicker({
      store: { listSessionPage: () => SESSIONS },
      cwd: '/work/project',
      paths: displayRoots('/work/project', '/home/ada'),
      now: () => Date.parse('2026-11-23T01:00:00.000Z'),
      assertAdmitting: () => {},
      runRead: (operation) => operation(),
      flow,
    }),
  );
  await settled(m, (snapshot) => snapshot.kind === 'picker' && snapshot.options.length === 2);
}

/** The `/resume` popup's second step when the saved display text could not be read: the retry question, its safe answer highlighted. */
async function openResumeRestore(m: HomeMount): Promise<void> {
  recordBaseline(m);
  const flow = resumePopup(channelOf(m).flow, 'home');
  flow.begin();
  flow.at(RESUME_STEP.restore).busy(RESUME_RESTORING);
  leaveOpen(retryRestoredHistory(flow));
  await settled(m, (snapshot) => snapshot.kind === 'select');
}

// ---- /run ---------------------------------------------------------------------------------------------------------------------------

/** A workflow with no input whose agent can write files: the confirmation is the first prompt (the Defined tab's `r`), with the host's passage. */
const RELEASE = `schema_version: '1.0'
workflow:
  id: release-notes
  name: Release notes
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

/** A workflow whose one input is a secret: its masked field is the first prompt. */
const SECRET = `schema_version: '1.0'
workflow:
  id: deploy
  name: Deploy
  inputs:
    - { name: token, type: secret, required: true }
  nodes:
    - { id: start, type: input }
    - { id: out, type: output }
  edges:
    - { from: start, to: out }
`;

const WORKFLOWS: Readonly<Record<string, string>> = {
  '.relavium/workflows/release-notes.relavium.yaml': RELEASE,
  '.relavium/workflows/deploy.relavium.yaml': SECRET,
};

/** The project's catalog, held in memory. */
const CATALOG: LaunchCatalog = {
  list: () =>
    Object.entries(WORKFLOWS).map(([path, yaml]) => {
      const definition = parseWorkflow(yaml, { source: path });
      return {
        path,
        slug: definition.workflow.id,
        name: definition.workflow.name,
        tags: [],
        valid: true,
      };
    }),
  load: (path) => ({
    definition: parseWorkflow(WORKFLOWS[path] ?? '', { source: path }),
    sourceDigest: 'd'.repeat(64),
    fsScope: { tier: 'sandboxed', fromRepository: false },
  }),
};

/** The `/run` popup opened at a workflow (the Defined tab's `r`), over a host that is never asked: the matrix answers nothing. */
function openRun(m: HomeMount, slug: string): void {
  recordBaseline(m);
  const launch = createRunLaunch({
    flow: channelOf(m).flow,
    host: { start: () => Promise.reject(new Error('the matrix starts no run')) },
    catalog: CATALOG,
  });
  leaveOpen(launch.open(slug));
}

/** The pasted key the secret surface's resize clears (it never reaches a frame: the field is drawn as bullets, then emptied). */
const MATRIX_SECRET = 'tok-matrix-00000000000000';

export const RESUME_RUN_SURFACES: readonly HomeSurface[] = [
  {
    host: 'home',
    id: 'home.resume-picker',
    title: 'The /resume popup’s first step: the session picker',
    exitKey: 'Esc',
    landmark: 'Resume a session',
    selectedRow: 'Fix the flaky test',
    legendRow: '↑/↓ select · Enter resume · Tab all directories · Esc close',
    belowFloor: /too small for this popup/iu,
    popup: liveBox,
    setup: NATIVE,
    notes:
      'the body behind the popup: the empty, keyed landing; the picker is opened through resumePopup and runSessionPicker',
    open: openResumePopup,
  },
  {
    host: 'home',
    id: 'home.resume-restore',
    title:
      'The /resume popup’s second step: the retry question of a history that could not be read',
    exitKey: 'Esc',
    landmark: 'Restore session history?',
    selectedRow: 'Return',
    legendRow: '↑/↓ select · Enter choose · Esc close',
    belowFloor: /too small for this popup/iu,
    popup: liveBox,
    setup: NATIVE,
    notes:
      'the body behind the popup: the empty, keyed landing; the restore step of resumePopup asks retryRestoredHistory',
    open: openResumeRestore,
  },
  {
    host: 'home',
    id: 'home.run-launch',
    title: 'The /run popup’s confirmation (its chord step, with what the run can do)',
    exitKey: 'Esc',
    landmark: 'Run Release notes?',
    legendRow: '[Ctrl+Y] Start it · [Ctrl+N] Cancel · Esc back · [Ctrl+C] denies',
    belowFloor: /too small for this popup/iu,
    popup: liveBox,
    setup: NATIVE,
    notes:
      'the body behind the popup: the empty, keyed landing; the launch is opened at its workflow, as the Defined tab’s r opens it',
    open: async (m) => {
      openRun(m, 'release-notes');
      await settled(m, (snapshot) => snapshot.kind === 'chord');
    },
  },
  {
    host: 'home',
    id: 'home.run-launch-secret',
    title: 'The /run popup’s masked input, after a resize cleared it',
    exitKey: 'Esc',
    landmark: NATIVE_PROMPT_RESIZED,
    legendRow: 'Enter continue · Esc back · [Ctrl+C] close',
    belowFloor: /too small for this popup/iu,
    popup: liveBox,
    setup: NATIVE,
    notes:
      'the body behind the popup: the empty, keyed landing; a key is pasted once the field is on screen, then the terminal is resized',
    open: async (m) => {
      openRun(m, 'deploy');
      const channel = channelOf(m);
      await m.until(() => channel.ui.getSnapshot().kind === 'password' && shownOn(channel));
      channel.ui.paste(MATRIX_SECRET);
      channel.ui.resized();
      await settled(m, (snapshot) => snapshot.error === NATIVE_PROMPT_RESIZED);
    },
  },
];
