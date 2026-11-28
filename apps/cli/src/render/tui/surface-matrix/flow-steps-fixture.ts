import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runHomeProjectInit } from '../../../home/project-init.js';
import { runExportCard, type ExportPort } from '../export-card.js';
import { bracketed } from '../harness-util.js';
import { runImportCard, type ImportPort } from '../import-card.js';
import { runPricingCard, type PricingOffer, type PricingPort } from '../pricing-card.js';
import { KEYS, type HomeMount, type NativePromptChannel } from './home-host.js';
import { pinnedNativePopupBox, recordNativePopups } from './native-popup-recorder.js';
import { recordBaseline } from './popup-fixture.js';
import type { PopupBox } from './properties.js';
import type { HomeSurface } from './surface-types.js';
import type { Variant } from './variants.js';

/**
 * The steps of the Home's project flows that no other cell draws (MVP-11 unit 6, round 1: test gap "matrix"): the Done step of `/init`, `/import`,
 * `/pricing` and the `/workflows` popup's export, in both tones (what was written, and what was refused at the write), `/init`'s refusal step, `/import`'s
 * path field and `/pricing`'s rates. Each is the product's own run function on the channel the Home wires, over scripted ports and temporary
 * directories (nothing is written elsewhere), driven through the guards the person's answers pass: the process's own clock is moved on by what the
 * guards need (`skipClock`: the opening settle, a chord card's dwell and its two-second lockout) instead of waited for, so nine cells of a surface
 * cost milliseconds and not twenty seconds. Each is checked as every popup is: its box from the slot's own geometry over the snapshot the
 * channel shows NOW, the overlay layer, the dimmed backdrop, and its legend row whole on one row.
 */

/** The channel of the cell that is open now: the popup box is computed from what it shows (cells run one after another). */
let current: NativePromptChannel | undefined;

function channelOf(m: HomeMount): NativePromptChannel {
  if (m.channel === undefined) throw new Error('the surface needs a native prompt channel');
  current = m.channel;
  recordNativePopups(m.channel);
  return m.channel;
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

/** A flow left running: the matrix never finishes it, and a rejection when the channel is disposed must not be unhandled. */
const leave = (running: Promise<unknown>): void => {
  running.catch(() => undefined);
};

/** Where the framed prompt the channel shows now is drawn in a cell, and its rows: the slot's own geometry and frame lines over it. */
export function liveFlowStepBox(variant: Variant): PopupBox {
  if (current === undefined) throw new Error('no flow is open');
  return pinnedNativePopupBox(current, current.ui.getSnapshot(), variant);
}

/**
 * What the guards of a person's answer need, passed at once. The channel's clock is the process's (`performance.now`), so a cell moves it on by
 * what it would otherwise sleep: past the flow's opening settle (500 ms), a chord card's dwell and its lockout (2 s from the card's opening).
 * The clock only ever moves forward during the cell, and is the real one again when the cell ends.
 */
const GUARDS_PASSED_MS = 2600;
let clockSkipped = 0;
let clockInstalled: (() => number) | undefined;
function skipClock(m: HomeMount, ms: number = GUARDS_PASSED_MS): void {
  if (clockInstalled === undefined) {
    const real = performance.now.bind(performance);
    clockInstalled = real;
    performance.now = (): number => real() + clockSkipped;
    m.defer(() => {
      performance.now = real;
      clockInstalled = undefined;
      clockSkipped = 0;
    });
  }
  clockSkipped += ms;
}

/** A frame is shown and the prompt of `kind` is on it (below the floor nothing is ever on screen, and the cell stops there). */
const promptShown = (m: HomeMount, channel: NativePromptChannel, kind: string): Promise<boolean> =>
  m.until(() => channel.ui.getSnapshot().kind === kind && shownOn(channel));

/** The last step is on screen (a persistent Done, or a refusal: the snapshot says how it ended). */
const lastStepShown = (m: HomeMount, channel: NativePromptChannel): Promise<boolean> =>
  m.until(() => channel.ui.getSnapshot().final !== undefined && shownOn(channel));

// ── /init ────────────────────────────────────────────────────────────────────────

interface InitFolders {
  readonly home: string;
  readonly project: string;
}

/** A temporary operator home with a project folder in it, removed when the cell ends. */
function initFolders(m: HomeMount): InitFolders {
  const root = mkdtempSync(join(tmpdir(), 'relavium-matrix-init-steps-'));
  m.defer(() => {
    rmSync(root, { recursive: true, force: true });
  });
  const home = join(root, 'home');
  const project = join(home, 'project');
  mkdirSync(project, { recursive: true });
  return { home, project };
}

function runInit(m: HomeMount, channel: NativePromptChannel, cwd: string, home: string): void {
  leave(
    runHomeProjectInit({
      cwd,
      home,
      flow: channel.flow,
      ui: channel.ui,
      // The renderer's own flush yields to it: a flush that resolves at once would spin the wait for the busy frame to be measured.
      flushVisible: () => m.settle(),
      assertAdmitting: () => {},
    }),
  );
}

/** `/init` to its last step: the card, the guards passed, `Ctrl+Y`; `spoil` runs once the card is on screen (what changes under it). */
async function initToLastStep(m: HomeMount, spoil?: (project: string) => void): Promise<void> {
  const channel = channelOf(m);
  const { home, project } = initFolders(m);
  runInit(m, channel, project, home);
  if (!(await promptShown(m, channel, 'chord'))) return;
  spoil?.(project);
  skipClock(m);
  m.key(KEYS.ctrlY);
  await lastStepShown(m, channel);
}

// ── /import, the Defined export, /pricing: scripted ports ───────────────────────────

const IMPORT_OFFER = {
  kind: 'workflow',
  slug: 'nightly-report',
  source: 'shared/nightly-report.yaml',
  destination: '.relavium/workflows/nightly-report.relavium.yaml',
  target: '.relavium/workflows/nightly-report.relavium.yaml',
  bytes: 2048,
  warnings: [],
} as const;

const WRITE_REFUSED = 'The file could not be written: permission denied.';

function importPort(commit: 'written' | 'refused'): ImportPort {
  return {
    pathIssue: () => undefined,
    prepare: () => ({
      ok: true,
      offer: IMPORT_OFFER,
      commit: () =>
        commit === 'written'
          ? { ok: true, written: 'Imported nightly-report.' }
          : { ok: false, reason: WRITE_REFUSED },
    }),
  };
}

function exportPort(commit: 'written' | 'refused'): ExportPort {
  return {
    prepare: (slug) => ({
      ok: true,
      offer: { kind: 'workflow', slug, destination: `${slug}.relavium.yaml`, bytes: 4096 },
      commit: () =>
        commit === 'written'
          ? { ok: true, written: `Wrote ${slug}.relavium.yaml.` }
          : { ok: false, reason: WRITE_REFUSED },
    }),
  };
}

const PRICE_OFFER: PricingOffer = {
  kind: 'set',
  model: 'claude-sonnet-4-5',
  provider: 'anthropic',
  providerName: 'Anthropic',
  prices: [
    { id: 'input', label: 'Input price', amount: '$3/Mtok', microcents: 300_000_000 },
    { id: 'output', label: 'Output price', amount: '$15/Mtok', microcents: 1_500_000_000 },
  ],
  keeps: false,
  replaces: undefined,
  fallback: undefined,
};

function pricingPort(commit: 'written' | 'refused'): PricingPort {
  return {
    models: () => [
      { modelId: 'claude-sonnet-4-5', provider: 'anthropic', hint: 'Anthropic · catalog price' },
      { modelId: 'gpt-5', provider: 'openai', hint: 'OpenAI · no price' },
    ],
    providers: () => ['anthropic', 'openai'],
    providerName: (slug) => (slug === 'openai' ? 'OpenAI' : 'Anthropic'),
    prepare: () => ({
      ok: true,
      offer: PRICE_OFFER,
      commit: () =>
        commit === 'written'
          ? { ok: true, written: 'Recorded: input $3/Mtok, output $15/Mtok.' }
          : { ok: false, reason: WRITE_REFUSED },
    }),
  };
}

/** `/import` to the review (the path typed and entered), the guards passed, `Ctrl+Y`, and the last step. */
async function importToLastStep(m: HomeMount, commit: 'written' | 'refused'): Promise<void> {
  const channel = channelOf(m);
  leave(runImportCard({ flow: channel.flow, port: importPort(commit) }));
  if (!(await promptShown(m, channel, 'text'))) return;
  skipClock(m);
  m.key(bracketed('shared/nightly-report.yaml'));
  await m.until(() => channel.ui.getSnapshot().display === 'shared/nightly-report.yaml');
  m.key(KEYS.enter);
  if (!(await promptShown(m, channel, 'chord'))) return;
  skipClock(m);
  m.key(KEYS.ctrlY);
  await lastStepShown(m, channel);
}

/** The `/workflows` popup's `[x]` to its review, the guards passed, `Ctrl+Y`, and the last step. */
async function exportToLastStep(m: HomeMount, commit: 'written' | 'refused'): Promise<void> {
  const channel = channelOf(m);
  leave(runExportCard({ flow: channel.flow, port: exportPort(commit) }, 'nightly-report'));
  if (!(await promptShown(m, channel, 'chord'))) return;
  skipClock(m);
  m.key(KEYS.ctrlY);
  await lastStepShown(m, channel);
}

/** The price fields `/pricing` asks for, one prompt each (`commands/pricing-fields.ts`: input, output, cached, image, audio, video). */
const PRICING_FIELD_COUNT = 6;

/** Answer the prompt on screen with `key` (its guards passed), and wait for the NEXT frame to be on screen; `false` when it never is (below the floor). */
async function answerWith(
  m: HomeMount,
  channel: NativePromptChannel,
  key: string,
): Promise<boolean> {
  const before = channel.ui.getSnapshot();
  skipClock(m);
  m.key(key);
  return m.until(() => channel.ui.getSnapshot() !== before && shownOn(channel));
}

/** `/pricing` as far as the first price field (the action, the model), or (`last`) every field left empty, the confirmation and the last step. */
async function pricingTo(
  m: HomeMount,
  commit: 'written' | 'refused',
  upTo: 'rates' | 'last',
): Promise<void> {
  const channel = channelOf(m);
  leave(runPricingCard({ flow: channel.flow, port: pricingPort(commit) }));
  // The action (`Set a price` is the cursor's), then the model (the first of the list is the cursor's): the first price field is next.
  if (!(await promptShown(m, channel, 'select'))) return;
  if (!(await answerWith(m, channel, KEYS.enter))) return;
  if (!(await answerWith(m, channel, KEYS.enter))) return;
  if (upTo === 'rates') return;
  // Every price left empty ("not set"): Enter on each field, and the confirmation is next.
  for (let field = 0; field < PRICING_FIELD_COUNT; field += 1) {
    if (!(await answerWith(m, channel, KEYS.enter))) return;
  }
  if (!(await promptShown(m, channel, 'chord'))) return;
  skipClock(m);
  m.key(KEYS.ctrlY);
  await lastStepShown(m, channel);
}

/** The legend of a last step (a Done step in either tone, a refusal): its one way to close it. */
const DONE_LEGEND = 'Enter / Esc close';
const NATIVE = { nativePrompt: true } as const;
const NOTES =
  'the body behind the popup: the empty, keyed landing; the flow is the product’s own run function on the channel the Home wires, over scripted ports, its guards passed by moving the process clock on';
const BELOW = /too small for this popup/iu;

/** One cell of this fixture: the common parts of an entry are written once. */
function stepSurface(
  entry: Pick<HomeSurface, 'id' | 'title' | 'landmark' | 'legendRow' | 'selectedRow'>,
  open: (m: HomeMount) => Promise<void>,
): HomeSurface {
  return {
    host: 'home',
    exitKey: 'Esc',
    belowFloor: BELOW,
    popup: liveFlowStepBox,
    setup: NATIVE,
    notes: NOTES,
    ...entry,
    open: async (m) => {
      recordBaseline(m);
      await open(m);
    },
  };
}

export const FLOW_STEP_SURFACES: readonly HomeSurface[] = [
  stepSurface(
    {
      id: 'home.init-done',
      title: 'The /init popup’s Done step: what was created and that no file was written',
      landmark: 'Created the project directories',
      legendRow: DONE_LEGEND,
    },
    (m) => initToLastStep(m),
  ),
  stepSurface(
    {
      id: 'home.init-done-failed',
      title: 'The /init popup’s failed Done step: the write was refused (the marker became a file)',
      landmark: 'Project initialization did not complete.',
      legendRow: DONE_LEGEND,
    },
    (m) =>
      initToLastStep(m, (project) => {
        writeFileSync(join(project, '.relavium'), 'a file where the project directory would go');
      }),
  ),
  stepSurface(
    {
      id: 'home.init-refused',
      title:
        'The /init popup’s refusal step: a folder that cannot be a project (the operator home)',
      landmark: 'Cannot initialize this folder.',
      legendRow: DONE_LEGEND,
    },
    async (m) => {
      const channel = channelOf(m);
      const { home } = initFolders(m);
      runInit(m, channel, home, home);
      await lastStepShown(m, channel);
    },
  ),
  stepSurface(
    {
      id: 'home.import-path',
      title: 'The /import popup’s first step: the path field',
      landmark: 'Path of the workflow or agent YAML to import',
      legendRow: 'Enter continue · Esc close',
    },
    async (m) => {
      const channel = channelOf(m);
      leave(runImportCard({ flow: channel.flow, port: importPort('written') }));
      await promptShown(m, channel, 'text');
    },
  ),
  stepSurface(
    {
      id: 'home.import-done',
      title: 'The /import popup’s Done step: what was imported, the file, and what to type next',
      landmark: "Imported workflow 'nightly-report'",
      legendRow: DONE_LEGEND,
    },
    (m) => importToLastStep(m, 'written'),
  ),
  stepSurface(
    {
      id: 'home.import-done-failed',
      title: 'The /import popup’s failed Done step: the write was refused',
      landmark: 'Not imported.',
      legendRow: DONE_LEGEND,
    },
    (m) => importToLastStep(m, 'refused'),
  ),
  stepSurface(
    {
      id: 'home.pricing-rates',
      title: 'The /pricing popup’s rates: the first price field',
      landmark: 'Input price',
      legendRow: 'Enter continue · Esc back · [Ctrl+C] close',
    },
    (m) => pricingTo(m, 'written', 'rates'),
  ),
  stepSurface(
    {
      id: 'home.pricing-done',
      title: 'The /pricing popup’s Done step: what was recorded, with the core’s own sentence',
      landmark: 'Recorded · claude-sonnet-4-5',
      legendRow: DONE_LEGEND,
    },
    (m) => pricingTo(m, 'written', 'last'),
  ),
  stepSurface(
    {
      id: 'home.pricing-done-failed',
      title: 'The /pricing popup’s failed Done step: the write was refused',
      landmark: 'Not recorded.',
      legendRow: DONE_LEGEND,
    },
    (m) => pricingTo(m, 'refused', 'last'),
  ),
  stepSurface(
    {
      id: 'home.export-done',
      title: 'The `/workflows` popup’s export Done step: what was exported and the file',
      landmark: "Exported workflow 'nightly-report'",
      legendRow: DONE_LEGEND,
    },
    (m) => exportToLastStep(m, 'written'),
  ),
  stepSurface(
    {
      id: 'home.export-done-failed',
      title: 'The `/workflows` popup’s export, its failed Done step: the write was refused',
      landmark: 'Not exported.',
      legendRow: DONE_LEGEND,
    },
    (m) => exportToLastStep(m, 'refused'),
  ),
];
