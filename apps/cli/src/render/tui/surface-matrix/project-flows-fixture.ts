import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runHomeProjectInit } from '../../../home/project-init.js';
import { POPUP_SELECT_SETTLE_MS } from '../../../popups/opening-guard.js';
import { runExportCard, type ExportPort } from '../export-card.js';
import { bracketed } from '../harness-util.js';
import { runImportCard, type ImportPort } from '../import-card.js';
import { runPricingCard, type PricingPort } from '../pricing-card.js';
import { KEYS, type HomeMount, type NativePromptChannel } from './home-host.js';
import { pinnedNativePopupBox, recordNativePopups } from './native-popup-recorder.js';
import { recordBaseline } from './popup-fixture.js';
import type { PopupBox } from './properties.js';
import type { HomeSurface } from './surface-types.js';
import type { Variant } from './variants.js';

/**
 * The Home's flows that write, as the popups they are (MVP-11 unit 6, 6.3; ADR-0148 §1, §3, §6): `/init`'s confirmation, `/import`'s review
 * (after its path was given), the Defined tab's export review and `/pricing`'s first question, each run by the product's own run function on the
 * channel the Home wires, over scripted ports (nothing is written outside a temporary directory) and left open. Each is checked as every popup
 * is: its box from the slot's own geometry over the snapshot the channel shows NOW (so a drift between what the flow asked and what the frame
 * draws fails the box), the overlay layer, the dimmed backdrop, and its legend row whole on one row.
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

/** A flow left running: the matrix never answers it, and a rejection when the channel is disposed must not be unhandled. */
const leave = (running: Promise<unknown>): void => {
  running.catch(() => undefined);
};

/** Where the framed prompt the channel shows now is drawn in a cell, and its rows: the slot's own geometry and frame lines over it, pinned as the flow's earlier steps left it (`native-popup-recorder.ts`). */
export function liveNativePopupBox(variant: Variant): PopupBox {
  if (current === undefined) throw new Error('no flow is open');
  return pinnedNativePopupBox(current, current.ui.getSnapshot(), variant);
}

const IMPORT_PORT: ImportPort = {
  pathIssue: () => undefined,
  prepare: () => ({
    ok: true,
    offer: {
      kind: 'workflow',
      slug: 'nightly-report',
      source: 'shared/nightly-report.yaml',
      destination: '.relavium/workflows/nightly-report.relavium.yaml',
      target: '.relavium/workflows/nightly-report.relavium.yaml',
      bytes: 2048,
      warnings: ['The file names an http endpoint literally: check it before you run it.'],
    },
    commit: () => ({ ok: true, written: 'Imported nightly-report.' }),
  }),
};

const EXPORT_PORT: ExportPort = {
  prepare: (slug) => ({
    ok: true,
    offer: { kind: 'workflow', slug, destination: `${slug}.relavium.yaml`, bytes: 4096 },
    commit: () => ({ ok: true, written: `Wrote ${slug}.relavium.yaml.` }),
  }),
};

const PRICING_PORT: PricingPort = {
  models: () => [
    { modelId: 'claude-sonnet-4-5', provider: 'anthropic', hint: 'Anthropic · catalog price' },
    { modelId: 'gpt-5', provider: 'openai', hint: 'OpenAI · no price' },
  ],
  providers: () => ['anthropic', 'openai'],
  providerName: (slug) => (slug === 'openai' ? 'OpenAI' : 'Anthropic'),
  prepare: () => ({ ok: false, reason: 'The matrix writes nothing.' }),
};

/** `/init` over a temporary operator home and project, removed when the cell ends. */
async function openInit(m: HomeMount): Promise<void> {
  const channel = channelOf(m);
  const root = mkdtempSync(join(tmpdir(), 'relavium-matrix-init-'));
  m.defer(() => {
    rmSync(root, { recursive: true, force: true });
  });
  const home = join(root, 'home');
  const cwd = join(home, 'project');
  mkdirSync(cwd, { recursive: true });
  leave(
    runHomeProjectInit({
      cwd,
      home,
      flow: channel.flow,
      ui: channel.ui,
      flushVisible: () => Promise.resolve(),
      assertAdmitting: () => {},
    }),
  );
  await m.until(() => shownOn(channel));
}

/** `/import`: the path field, answered once its frame is on screen and the flow's opening settle has passed, then the review. */
async function openImport(m: HomeMount): Promise<void> {
  const channel = channelOf(m);
  leave(runImportCard({ flow: channel.flow, port: IMPORT_PORT }));
  // Below the floor the field is never on screen: the notice stays, and nothing is typed into a field nobody sees.
  if (!(await m.until(() => shownOn(channel)))) return;
  await new Promise((resolve) => setTimeout(resolve, POPUP_SELECT_SETTLE_MS + 100));
  m.key(bracketed('shared/nightly-report.yaml'));
  await m.until(() => channel.ui.getSnapshot().display === 'shared/nightly-report.yaml');
  m.key(KEYS.enter);
  await m.until(() => channel.ui.getSnapshot().kind === 'chord' && shownOn(channel));
}

/** The Defined tab's `x`: its review. */
async function openExport(m: HomeMount): Promise<void> {
  const channel = channelOf(m);
  leave(runExportCard({ flow: channel.flow, port: EXPORT_PORT }, 'nightly-report'));
  await m.until(() => shownOn(channel));
}

/** `/pricing`: its first question. */
async function openPricing(m: HomeMount): Promise<void> {
  const channel = channelOf(m);
  leave(runPricingCard({ flow: channel.flow, port: PRICING_PORT }));
  await m.until(() => shownOn(channel));
}

const NATIVE = { nativePrompt: true } as const;
const NOTES =
  'the body behind the popup: the empty, keyed landing; the flow is run by its own run function on the channel the Home wires';

export const PROJECT_FLOW_SURFACES: readonly HomeSurface[] = [
  {
    host: 'home',
    id: 'home.init-card',
    title: 'The /init popup: what will be created, and the Ctrl+Y that creates it',
    exitKey: 'Esc',
    landmark: 'Create these project directories?',
    // Captured while the card's lockout holds its `Ctrl+Y` (`(wait)`, dim); once the lock has opened, the row reads as it always did.
    legendRow: [
      '[Ctrl+Y] Create them (wait) · [Ctrl+N] Create nothing · Esc denies',
      '[Ctrl+Y] Create them · [Ctrl+N] Create nothing · Esc denies',
    ],
    belowFloor: /too small for this popup/iu,
    popup: liveNativePopupBox,
    setup: NATIVE,
    notes: NOTES,
    open: async (m) => {
      recordBaseline(m);
      await openInit(m);
    },
  },
  {
    host: 'home',
    id: 'home.import-card',
    title: 'The /import popup’s review (what would be written, a chord step)',
    exitKey: 'Esc',
    landmark: "Import workflow 'nightly-report'",
    // Captured while the card's lockout holds its `Ctrl+Y` (`(wait)`, dim): at 80 columns the longer part drops `[Ctrl+N]` (Esc refuses too);
    // once the lock has opened, the row is whole again.
    legendRow: [
      '[Ctrl+Y] Write the file (wait) · Esc denies',
      '[Ctrl+Y] Write the file (wait) · [Ctrl+N] Write nothing · Esc denies',
      '[Ctrl+Y] Write the file · [Ctrl+N] Write nothing · Esc denies',
    ],
    belowFloor: /too small for this popup/iu,
    popup: liveNativePopupBox,
    setup: NATIVE,
    notes: NOTES,
    open: async (m) => {
      recordBaseline(m);
      await openImport(m);
    },
  },
  {
    host: 'home',
    id: 'home.export-card',
    title: 'The Defined tab’s export popup (where a workflow would be written, a chord step)',
    exitKey: 'Esc',
    landmark: "Write workflow 'nightly-report'",
    // Captured while the card's lockout holds its `Ctrl+Y` (`(wait)`, dim): at 80 columns the longer part drops `[Ctrl+N]` (Esc refuses too);
    // once the lock has opened, the row is whole again.
    legendRow: [
      '[Ctrl+Y] Write the file (wait) · Esc denies',
      '[Ctrl+Y] Write the file (wait) · [Ctrl+N] Write nothing · Esc denies',
      '[Ctrl+Y] Write the file · [Ctrl+N] Write nothing · Esc denies',
    ],
    belowFloor: /too small for this popup/iu,
    popup: liveNativePopupBox,
    setup: NATIVE,
    notes: NOTES,
    open: async (m) => {
      recordBaseline(m);
      await openExport(m);
    },
  },
  {
    host: 'home',
    id: 'home.pricing-card',
    title: 'The /pricing popup (its first question)',
    exitKey: 'Esc',
    landmark: 'Model pricing: what do you want to do?',
    selectedRow: 'Set a price',
    legendRow: '↑/↓ select · Enter choose · Esc close',
    belowFloor: /too small for this popup/iu,
    popup: liveNativePopupBox,
    setup: NATIVE,
    notes: NOTES,
    open: async (m) => {
      recordBaseline(m);
      await openPricing(m);
    },
  },
];
