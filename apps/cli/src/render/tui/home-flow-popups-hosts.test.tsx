/**
 * The journeys of the flows that write, in the real hosts at 80×24 (the alternate screen's overlay and the inline renderer's floor; MVP-11
 * unit 6, 6.3; ADR-0148 §1, §3, §4, §6): `/init`, `/import`, `/pricing` and the Defined tab's `x` on the Home, typed as a person types them;
 * `/export` in the stand-alone chat and the chat the Home hosts. Each is drawn as a popup (its title, `step N of M`, the rail's names, its
 * legend row), is answered only by `Ctrl+Y` after its guards, ends in a Done step that `Enter` closes, and leaves no residue: the Home's notice,
 * the chat's transcript and the notification row are what they were before it opened.
 *
 * The hosts' clocks are the real one, so the waits are real and named. The ports are fakes that count their one write (the cards' own suites
 * drive the real ports); `/init` runs over a temporary directory.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { buildDefinedModel } from '../../history/defined-model.js';
import { runHomeProjectInit } from '../../home/project-init.js';
import { POPUP_SELECT_SETTLE_MS } from '../../popups/opening-guard.js';
import type { ReportsPort } from '../../popups/report-port.js';
import { runExportCard, type ExportPort } from './export-card.js';
import { bracketed } from './harness-util.js';
import { runImportCard, type ImportPort } from './import-card.js';
import { runPricingCard, type PricingPort } from './pricing-card.js';
import { mountHostedChat, mountStandaloneChat } from './surface-matrix/chat-host.js';
import { KEYS, mountHome, type HomeMount } from './surface-matrix/home-host.js';
import type { Variant } from './surface-matrix/variants.js';
import { APPROVAL_LOCKOUT_MS } from './tool-review-model.js';

/** Past the lockout the key that opened the flow (or answered the step before) starts, and the card's dwell, with room to spare. */
const PAST_THE_LOCKOUT_MS = APPROVAL_LOCKOUT_MS + 300;
/** Past the flow's opening settle. */
const PAST_THE_SETTLE_MS = POPUP_SELECT_SETTLE_MS + 100;
const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
/** A journey waits out real guards (the settle once, the lockout once): its own bound, named. */
const JOURNEY_TIMEOUT_MS = 15_000;

const VARIANTS: readonly Variant[] = [
  { renderer: 'alt', color: false, size: { cols: 80, rows: 24 } },
  { renderer: 'inline', color: false, size: { cols: 80, rows: 24 } },
];

type FlowName = 'init' | 'import' | 'pricing' | 'export';

/** What each flow's frames say: its title, the rail, the chord's legend row, the Done step's sentence, and where its chord is. */
const JOURNEY: Readonly<
  Record<
    FlowName,
    {
      readonly title: string;
      readonly names: readonly string[];
      readonly chordStep: number;
      readonly legend: string;
      readonly done: string;
    }
  >
> = {
  init: {
    title: '/init',
    names: ['Check', 'Confirm', 'Done'],
    chordStep: 2,
    legend: '[Ctrl+Y] Create them · [Ctrl+N] Create nothing · Esc denies',
    done: 'Created the project directories',
  },
  import: {
    title: '/import',
    names: ['Path', 'Review', 'Done'],
    chordStep: 2,
    legend: '[Ctrl+Y] Write the file · [Ctrl+N] Write nothing · Esc denies',
    done: "Imported workflow 'nightly-report'",
  },
  pricing: {
    title: '/pricing',
    names: ['Action', 'Model', 'Rates', 'Confirm', 'Done'],
    chordStep: 4,
    legend: '[Ctrl+Y] Record the price · [Ctrl+N] Write nothing · Esc denies',
    done: 'Recorded · gpt-5',
  },
  export: {
    title: 'Export',
    names: ['Review', 'Done'],
    chordStep: 1,
    legend: '[Ctrl+Y] Write the file · [Ctrl+N] Write nothing · Esc denies',
    done: "Exported workflow 'nightly'",
  },
};

/** The four flows wired to the Home's own channel, over counting fakes and (`/init`) a temporary directory. */
function homeWithFlows(variant: Variant) {
  const commits = vi.fn();
  const root = mkdtempSync(join(tmpdir(), 'relavium-flow-hosts-'));
  const home = join(root, 'home');
  const cwd = join(home, 'project');
  mkdirSync(cwd, { recursive: true });
  const importPort: ImportPort = {
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
        warnings: [],
      },
      commit: () => {
        commits();
        return { ok: true, written: 'written' };
      },
    }),
  };
  const exportPort: ExportPort = {
    prepare: (slug) => ({
      ok: true,
      offer: { kind: 'workflow', slug, destination: `${slug}.relavium.yaml`, bytes: 4096 },
      commit: () => {
        commits();
        return { ok: true, written: 'written' };
      },
    }),
  };
  const pricingPort: PricingPort = {
    models: () => [{ modelId: 'gpt-5', provider: 'openai', hint: 'OpenAI · catalog price' }],
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
          { id: 'input', label: 'Input price', amount: '$3 per M', microcents: 300_000_000 },
          { id: 'output', label: 'Output price', amount: '$9 per M', microcents: 900_000_000 },
        ],
        keeps: true,
        replaces: undefined,
        fallback: undefined,
      },
      commit: () => {
        commits();
        return { ok: true, written: 'Set user pricing for gpt-5 (OpenAI).' };
      },
    }),
  };
  const m: HomeMount = mountHome(variant, {
    nativePrompt: true,
    deps: (context) => {
      const channel = context.channel;
      if (channel === undefined) throw new Error('no channel');
      return {
        initializeProject: () =>
          runHomeProjectInit({
            cwd,
            home,
            flow: channel.flow,
            ui: channel.ui,
            flushVisible: context.flushVisible,
            assertAdmitting: () => {},
          }),
        importDefined: () => runImportCard({ flow: channel.flow, port: importPort }),
        pricing: () => runPricingCard({ flow: channel.flow, port: pricingPort }),
        exportDefined: (slug) => runExportCard({ flow: channel.flow, port: exportPort }, slug),
        defined: {
          read: () => ({
            model: buildDefinedModel({
              entries: [
                {
                  slug: 'nightly',
                  name: undefined,
                  nodeCount: 1,
                  path: 'nightly.relavium.yaml',
                  valid: true,
                },
              ],
              pins: [],
            }),
            slugOf: (index) => (index === 0 ? 'nightly' : undefined),
            pathOf: (index) => (index === 0 ? 'nightly.relavium.yaml' : undefined),
          }),
        },
      };
    },
  });
  m.defer(() => {
    rmSync(root, { recursive: true, force: true });
  });
  const wrote = (): boolean => commits.mock.calls.length > 0 || existsSync(join(cwd, '.relavium'));
  return { m, commits, wrote };
}

/** Whether the prompt on the channel now is the frame on the terminal, measured and flushed. */
function shownNow(m: HomeMount): boolean {
  const channel = m.channel;
  if (channel === undefined) return false;
  try {
    channel.ui.assertVisible(channel.ui.getSnapshot());
    return true;
  } catch {
    return false;
  }
}

/** Type a command at the landing as a person does: the word, then `Enter` as a separate key. */
async function typed(m: HomeMount, line: string): Promise<void> {
  m.key(line);
  await m.until(() => m.controller.getSnapshot().input.text === line);
  m.key(KEYS.enter);
}

/** The prompt of `kind` is the frame on screen; then the settle passes. */
async function onScreen(m: HomeMount, check: () => boolean): Promise<void> {
  await m.until(check, 2000);
  await m.until(() => shownNow(m), 2000);
  await pause(PAST_THE_SETTLE_MS);
}

/** Answer the steps before the chord of `name`, each on its own frame, as a person does. */
async function toChord(m: HomeMount, name: FlowName): Promise<void> {
  const snap = () => m.channel?.ui.getSnapshot();
  if (name === 'export') {
    await typed(m, '/workflows');
    await m.until(() => m.text().includes('nightly'));
    await m.settle();
    m.key('x');
  } else await typed(m, `/${name}`);
  if (name === 'import') {
    await onScreen(m, () => snap()?.kind === 'text');
    m.key(bracketed('shared/nightly-report.yaml'));
    await m.until(() => snap()?.display === 'shared/nightly-report.yaml');
    m.key(KEYS.enter);
  }
  if (name === 'pricing') {
    // The opening settle is the flow's, once: after it, each step needs only its own frame on screen.
    await onScreen(m, () => snap()?.kind === 'select');
    for (let step = 0; step < 8; step += 1) {
      await m.until(() => ['select', 'text', 'chord'].includes(snap()?.kind ?? ''), 2000);
      if (snap()?.kind === 'chord') break;
      const before = snap();
      await m.until(() => shownNow(m), 2000);
      const message = before?.message ?? '';
      if (/^Input price/u.test(message)) m.key(bracketed('3'));
      if (/^Output price/u.test(message)) m.key(bracketed('9'));
      await m.settle();
      m.key(KEYS.enter);
      await m.until(() => snap() !== before, 2000);
    }
  }
  await m.until(() => snap()?.kind === 'chord', 2000);
}

describe.each(VARIANTS)('the Home’s flows that write, $renderer at 80×24', (variant) => {
  it.each(['init', 'import', 'pricing', 'export'] as const)(
    '%s: a popup from its first frame; Ctrl+Y after its guards writes once; the Done step closes on Enter; nothing is left behind',
    async (name) => {
      const { m, wrote } = homeWithFlows(variant);
      try {
        await m.settle();
        const noticeBefore = m.controller.getSnapshot().notice;
        const journey = JOURNEY[name];
        await toChord(m, name);
        await m.until(() => m.text().includes(journey.legend), 2000);
        const card = m.text();
        expect(card).toContain(journey.title);
        expect(card).toContain(
          `step ${String(journey.chordStep)} of ${String(journey.names.length)}`,
        );
        for (const step of journey.names) expect(card).toContain(step);
        expect(card).toContain(journey.legend);
        expect(wrote(), 'asking writes nothing').toBe(false);
        await m.until(() => shownNow(m), 2000);
        await pause(PAST_THE_LOCKOUT_MS);
        m.key(KEYS.ctrlY);
        await m.until(() => m.channel?.ui.getSnapshot().final === 'ok', 2000);
        await m.until(() => m.text().includes(journey.done), 2000);
        expect(wrote()).toBe(true);
        const done = m.text();
        expect(done).toContain(
          `step ${String(journey.names.length)} of ${String(journey.names.length)}`,
        );
        expect(done).toContain('Enter / Esc close');
        await m.until(() => shownNow(m), 2000);
        m.key(KEYS.enter);
        await m.until(() => m.controller.getSnapshot().nativeActionBusy === false, 2000);
        await m.settle();
        // No residue (ADR-0148 §6): the Home's notice as it was, no notification, the popup gone.
        expect(m.controller.getSnapshot().notice).toBe(noticeBefore);
        expect(m.notifications.getSnapshot().current).toBeUndefined();
        expect(m.text()).not.toContain(journey.done);
        expect(m.channel?.ui.getSnapshot().active).toBe(false);
      } finally {
        m.unmount();
      }
    },
    JOURNEY_TIMEOUT_MS,
  );

  it.each(['init', 'import', 'pricing', 'export'] as const)(
    '%s: a Ctrl+Y right after the card appeared writes nothing; Esc leaves it with one notification and no Home notice',
    async (name) => {
      const { m, wrote } = homeWithFlows(variant);
      try {
        await m.settle();
        await toChord(m, name);
        await m.until(() => shownNow(m), 2000);
        m.key(KEYS.ctrlY);
        await pause(150);
        expect(wrote()).toBe(false);
        expect(m.channel?.ui.getSnapshot().kind).toBe('chord');
        m.key(KEYS.escape);
        await m.until(() => m.controller.getSnapshot().nativeActionBusy === false, 2000);
        expect(wrote()).toBe(false);
        expect(m.controller.getSnapshot().notice).toBeUndefined();
        // One notification on the Home's channel. The Defined tab is a screen: its hint row is not drawn, so the channel holds it until the
        // screen is left (`notifications.ts`), and it waits there rather than showing.
        await m.until(() => {
          const now = m.notifications.getSnapshot();
          return now.current !== undefined || now.queued > 0;
        }, 2000);
        const now = m.notifications.getSnapshot();
        expect(now.current === undefined ? now.queued : 1).toBe(1);
        if (now.current !== undefined)
          expect(now.current.text).toMatch(
            /^(Nothing was written\.|Project initialization cancelled\.)$/u,
          );
        if (name === 'export') {
          const screen = m.controller.getSnapshot().screen;
          expect(screen?.kind === 'tab-host' && screen.host.defined?.message).toBeUndefined();
        }
      } finally {
        m.unmount();
      }
    },
    JOURNEY_TIMEOUT_MS,
  );
});

/** The chat's `/export` port: a fake whose one write is counted. */
function exportPort() {
  const commit = vi.fn(() => ({ target: '.relavium/workflows/fix-the-test.relavium.yaml' }));
  const port: ReportsPort = {
    surface: 'standalone-chat',
    export: {
      prepare: () => ({
        target: '.relavium/workflows/fix-the-test.relavium.yaml',
        overwrites: false,
      }),
      commit,
      failure: () => 'The export failed.',
      review: 'Exported workflow is a scaffold; review it before committing.',
    },
  };
  return { port, commit };
}

describe.each(VARIANTS)('/export in a chat, $renderer at 80×24', (variant) => {
  it.each(['standalone-chat', 'chat'] as const)(
    'in the %s host: a typed /export opens the confirmation (never dispatched), Ctrl+Y after its guards writes once, the Done step names the file, and the transcript is as it was',
    async (host) => {
      const { port, commit } = exportPort();
      const m =
        host === 'chat'
          ? await mountHostedChat(variant, { reports: { ...port, surface: 'home-chat' } })
          : mountStandaloneChat(variant, { reports: port });
      try {
        await m.settle();
        const transcriptBefore = JSON.stringify(m.store.getSnapshot().state.transcript);
        await m.typeLine('/export');
        await m.until(() => m.text().includes('fix-the-test.relavium.yaml'), 2000);
        const card = m.text();
        expect(card).toContain('/export');
        expect(card).toContain('A new file in the project.');
        expect(card).toContain('Ctrl+Y');
        expect(card).toContain('Write the file');
        expect(m.submitted, 'the line is the popup’s, never the chat’s dispatch').toEqual([]);
        await pause(PAST_THE_LOCKOUT_MS);
        m.key(KEYS.ctrlY);
        await m.until(() => m.text().includes('Exported this chat as a workflow'), 2000);
        expect(m.text(), 'the file is on a row of its own').toContain('.relavium/workflows/');
        expect(commit).toHaveBeenCalledTimes(1);
        await m.settle();
        m.key(KEYS.enter);
        await m.until(() => m.popups.getSnapshot().open === false, 2000);
        expect(JSON.stringify(m.store.getSnapshot().state.transcript)).toBe(transcriptBefore);
        expect(m.notifications.getSnapshot().current).toBeUndefined();
      } finally {
        m.unmount();
      }
    },
    JOURNEY_TIMEOUT_MS,
  );
});
