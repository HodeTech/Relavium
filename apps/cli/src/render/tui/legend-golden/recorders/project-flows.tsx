import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Key } from 'ink';

import { runHomeProjectInit } from '../../../../home/project-init.js';
import {
  EXPORT_STEP,
  exportDoneContent,
  exportFailedContent,
  exportReviewContent,
  exportSpec,
  EXPORT_LOADING_CONTENT,
} from '../../../../popups/export-popup.js';
import { openFrame, withContent, type PopupFrame } from '../../../../popups/popup-reducer.js';
import {
  nativePopupFrameLines,
  nativePopupGeometry,
  PopupFrameView,
} from '../../../../popups/popup-slot.js';
import { createChordGuard, createChordHistory } from '../../chord-guard.js';
import { runExportCard } from '../../export-card.js';
import { runImportCard } from '../../import-card.js';
import {
  createNativePromptChannel,
  type NativePromptSnapshot,
} from '../../native-prompt-channel.js';
import { runPricingCard } from '../../pricing-card.js';
import { legendStates } from '../frames.js';
import { label, type Producer, type Recorder, type StateRows } from '../golden.js';
import { frameRows } from './popups.js';

/**
 * The legend rows of the Home's flows that write and of the in-chat `/export` confirmation, as popups (MVP-11 unit 6, 6.3; ADR-0148 §1, §3,
 * §6): every step each flow draws, captured from the flow's own run function on a channel with a manual clock (so the words are the flow's,
 * not a copy), and the `/export` popup's two steps in each of their states, drawn by the real frame view.
 */
export const PROJECT_FLOWS_PRODUCERS: readonly Producer[] = [
  {
    id: 'project-flow-popups',
    file: 'home/project-init.ts',
    describe:
      'the Home’s flows that write as popups (MVP-11 unit 6): /init’s confirmation and Done step, /import’s path, review and Done step, /pricing’s questions, confirmation and Done step, and the Defined tab’s export review and Done step, each with its rail and legend (`[Ctrl+Y] … · [Ctrl+N] … · Esc denies`, `Enter / Esc close`)',
  },
  {
    id: 'export-popup',
    file: 'popups/export-popup.ts',
    describe:
      'the in-chat /export confirmation popup (ADR-0148 §10): the file it would write and the review sentence on a `[Ctrl+Y] export · Esc cancel` line, and its result (written, a turn in flight, the target changed, a failure)',
  },
];

const none: Key = {
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
};
const ENTER: Key = { ...none, return: true };
const CTRL: Key = { ...none, ctrl: true };
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** The rows of one framed prompt as the overlay draws it at 80×24. */
function framedRows(snapshot: NativePromptSnapshot, color: boolean) {
  const { geometry, layout } = nativePopupGeometry(
    snapshot,
    'overlay',
    { cols: 80, rows: 24 },
    color,
  );
  if (!geometry.fits || layout === undefined || !layout.fits) throw new Error('refused');
  return nativePopupFrameLines(snapshot, geometry, layout, color);
}

function framedStates(state: string, snapshot: NativePromptSnapshot) {
  return legendStates(
    state,
    (color) => (
      <PopupFrameView
        lines={framedRows(snapshot, color)}
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

type FlowName = 'init' | 'import' | 'pricing' | 'export';

/**
 * Run `name` on a channel with a manual clock, answering every step with what a person types and `Ctrl+Y` at the chord, and capture the
 * snapshot of each step it draws (by its rail step and kind), the Done step included.
 */
async function capture(name: FlowName): Promise<Map<string, NativePromptSnapshot>> {
  let clock = 10_000;
  const history = createChordHistory();
  const opener = createChordGuard({ now: () => clock, history });
  opener.resolved(opener.stamp());
  const channel = createNativePromptChannel({ now: () => clock, history });
  channel.ui.bindVisibility(() => true);
  const root = mkdtempSync(join(tmpdir(), 'relavium-golden-flows-'));
  const home = join(root, 'home');
  const cwd = join(home, 'project');
  mkdirSync(cwd, { recursive: true });
  const seen = new Map<string, NativePromptSnapshot>();
  const offer = { kind: 'workflow' as const, slug: 'nightly-report', bytes: 2048 };
  const running = (() => {
    switch (name) {
      case 'init':
        return runHomeProjectInit({
          cwd,
          home,
          flow: channel.flow,
          ui: channel.ui,
          flushVisible: () => Promise.resolve(),
          assertAdmitting: () => {},
        });
      case 'import':
        return runImportCard({
          flow: channel.flow,
          port: {
            pathIssue: () => undefined,
            prepare: () => ({
              ok: true,
              offer: {
                ...offer,
                source: 'shared/nightly-report.yaml',
                destination: '.relavium/workflows/nightly-report.relavium.yaml',
                target: '.relavium/workflows/nightly-report.relavium.yaml',
                warnings: [],
              },
              commit: () => ({ ok: true, written: 'written' }),
            }),
          },
        });
      case 'export':
        return runExportCard(
          {
            flow: channel.flow,
            port: {
              prepare: (slug) => ({
                ok: true,
                offer: { ...offer, slug, destination: `${slug}.relavium.yaml` },
                commit: () => ({ ok: true, written: 'written' }),
              }),
            },
          },
          'nightly-report',
        );
      case 'pricing':
        return runPricingCard({
          flow: channel.flow,
          port: {
            models: () => [
              { modelId: 'gpt-5', provider: 'openai', hint: 'OpenAI · catalog price' },
            ],
            providers: () => ['openai'],
            providerName: () => 'OpenAI',
            prepare: () => ({
              ok: true,
              offer: {
                kind: 'set',
                model: 'gpt-5',
                provider: 'openai',
                providerName: 'OpenAI',
                prices: [
                  { id: 'input', label: 'Input price', amount: '$3 per M', microcents: 3e8 },
                  { id: 'output', label: 'Output price', amount: '$9 per M', microcents: 9e8 },
                ],
                keeps: true,
                replaces: undefined,
                fallback: undefined,
              },
              commit: () => ({ ok: true, written: 'Set user pricing for gpt-5 (OpenAI).' }),
            }),
          },
        });
    }
  })();
  try {
    for (let step = 0; step < 16; step += 1) {
      await flush();
      const now = channel.ui.getSnapshot();
      if (!now.active) break;
      const key = `${String(now.popup?.stepIndex ?? 0)} ${now.final === undefined ? now.kind : 'done'}`;
      if (!seen.has(key)) seen.set(key, now);
      channel.ui.shown(now);
      clock += 3000;
      if (now.final !== undefined) {
        // The Done step closes the flow: what the channel shows while the flow ends is not a step of it.
        channel.ui.input('', ENTER);
        break;
      }
      if (now.kind === 'select') channel.ui.input('', ENTER);
      else if (now.kind === 'chord') channel.ui.input('y', CTRL);
      else if (now.kind === 'text') {
        if (/^Input price/u.test(now.message)) channel.ui.paste('3');
        else if (/^Output price/u.test(now.message)) channel.ui.paste('9');
        else if (name === 'import') channel.ui.paste('shared/nightly-report.yaml');
        channel.ui.input('', ENTER);
      }
    }
    await running;
  } finally {
    channel.ui.dispose();
    rmSync(root, { recursive: true, force: true });
  }
  return seen;
}

const recordProjectFlows: Recorder = async (): Promise<StateRows> => {
  const states: Record<string, readonly string[]> = {};
  for (const name of ['init', 'import', 'pricing', 'export'] as const)
    for (const [step, snapshot] of await capture(name))
      Object.assign(states, framedStates(label({ flow: name, step }), snapshot));
  return states;
};

const recordExportPopup: Recorder = (): StateRows => {
  const opened = openFrame(exportSpec('chat'), 1);
  const view = { target: '.relavium/workflows/fix-the-test.relavium.yaml', overwrites: false };
  const review = 'Exported workflow is a scaffold; review it before committing.';
  const at = (step: number, content: Parameters<typeof withContent>[2]): PopupFrame => ({
    ...withContent(opened, step, content),
    stepIndex: step,
  });
  return {
    ...frameStates(
      label({ step: 'export', content: 'loading' }),
      at(EXPORT_STEP.review, EXPORT_LOADING_CONTENT),
    ),
    ...frameStates(
      label({ step: 'export', content: 'new-file' }),
      at(EXPORT_STEP.review, exportReviewContent(view, review)),
    ),
    ...frameStates(
      label({ step: 'export', content: 'overwrites' }),
      at(EXPORT_STEP.review, exportReviewContent({ ...view, overwrites: true }, review)),
    ),
    ...frameStates(
      label({ step: 'done', content: 'written' }),
      at(EXPORT_STEP.done, exportDoneContent(view.target)),
    ),
    ...frameStates(
      label({ step: 'done', content: 'failed' }),
      at(EXPORT_STEP.done, exportFailedContent('The workflow file could not be written.')),
    ),
  };
};

export const PROJECT_FLOWS_RECORDERS: Readonly<Record<string, Recorder>> = {
  'project-flow-popups': recordProjectFlows,
  'export-popup': recordExportPopup,
};
