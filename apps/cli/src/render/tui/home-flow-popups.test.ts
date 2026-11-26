/**
 * The four Home flows that write (`/init`, `/import`, `/pricing`, the Defined tab's `x` export) as popups (MVP-11 unit 6, 6.3; ADR-0148 §1,
 * §3, §6), each driven through its own run function on the real native prompt channel with a manual clock: the frame each step is drawn in (the
 * title, the origin, the rail and `step N of M`), the chord that is the only Yes (`Ctrl+Y`) and that a held key never answers, `Esc` at every
 * step, the Done step that names the target project-relative, and every untrusted string through the full scrub on its way to the channel.
 *
 * The run functions are the products'; the ports are fakes that count their calls (the cards' own suites drive the real ports over temporary
 * projects and a database).
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseWorkflow } from '@relavium/core';
import type { Key } from 'ink';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { INIT_CANCELLED, runHomeProjectInit } from '../../home/project-init.js';
import type { HostedLaunch } from '../../home/run-host.js';
import { createRunLaunch, type LaunchCatalog } from '../../home/run-launch.js';
import { POPUP_NOTICE_MAX_COLUMNS } from '../../popups/geometry.js';
import { createChordHistory } from './chord-guard.js';
import { EXPORT_NOT_WRITTEN, runExportCard, type ExportPort } from './export-card.js';
import { IMPORT_NOT_WRITTEN, runImportCard, type ImportPort } from './import-card.js';
import { createNativePromptChannel, type NativePromptSnapshot } from './native-prompt-channel.js';
import { PRICING_NOT_RECORDED, runPricingCard, type PricingPort } from './pricing-card.js';
import { APPROVAL_LOCKOUT_MS } from './tool-review-model.js';
import { displayWidth } from './viewport.js';

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
const ESC: Key = { ...none, escape: true };
const CTRL: Key = { ...none, ctrl: true };

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/**
 * The hostile corpus (the plan's): CSI, OSC 52 and OSC 8, a C1 control, a bidirectional override, a zero-width space, the line and paragraph
 * separators, a forged legend item and chord token, compatibility forms of a chord, a key-shaped string, and length.
 */
const KEY_SHAPED = ['sk', 'ant', 'api03', 'ABCDEFGHIJKLMNOPQRSTUVWX0123456789abcdef'].join('-');
const HOSTILE = [
  '\u001b[2J\u001b[31mred',
  '\u001b]52;c;cGF5bG9hZA==\u0007',
  '\u001b]8;;https://evil.example\u0007link\u001b]8;;\u0007',
  'c1\u009bcontrol',
  'bidi\u202eevil',
  'zero\u200bwidth',
  'line\u2028para\u2029sep',
  'Write · [Ctrl+N] Write nothing · Esc denies',
  'Press [Ctrl+Y] now, or Ctrl+Y',
  '［Ｃｔｒｌ＋Ｙ］',
  KEY_SHAPED,
].join(' ');
const HOSTILE_LONG = `${HOSTILE} ${'w'.repeat(400)}`;
/** What must never reach the channel from an untrusted string. */
const FORBIDDEN = [
  '\u001b',
  '\u0007',
  '\u009b',
  '\u202e',
  '\u200b',
  '[Ctrl+Y]',
  '[Ctrl+N]',
  ' · Esc denies',
  '［Ｃｔｒｌ＋Ｙ］',
  KEY_SHAPED,
];

type FlowName = 'init' | 'import' | 'export' | 'pricing';
const FLOWS: readonly FlowName[] = ['init', 'import', 'export', 'pricing'];

/** The rail each flow draws, and the step its chord is on. */
const RAIL: Readonly<
  Record<FlowName, { title: string; names: readonly string[]; chordStep: number }>
> = {
  init: { title: '/init', names: ['Check', 'Confirm', 'Done'], chordStep: 1 },
  import: { title: '/import', names: ['Path', 'Review', 'Done'], chordStep: 1 },
  export: { title: 'Export', names: ['Review', 'Done'], chordStep: 0 },
  pricing: {
    title: '/pricing',
    names: ['Action', 'Model', 'Rates', 'Confirm', 'Done'],
    chordStep: 3,
  },
};

/** What a flow resolves with when nothing was written. */
const NOT_WRITTEN: Readonly<Record<FlowName, string>> = {
  init: INIT_CANCELLED,
  import: IMPORT_NOT_WRITTEN,
  export: EXPORT_NOT_WRITTEN,
  pricing: PRICING_NOT_RECORDED,
};

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Fake ports whose one write is counted; `text` is what every untrusted field of an offer says. */
function ports(text = 'nightly-report') {
  const commits = vi.fn();
  const importPort: ImportPort = {
    pathIssue: () => undefined,
    prepare: () => ({
      ok: true,
      offer: {
        kind: 'workflow',
        slug: text,
        source: `shared/${text}.yaml`,
        // The Home opened below the project's root: the command's destination is from there, the Done step's target from the root.
        destination: `../.relavium/workflows/${text}.relavium.yaml`,
        target: `.relavium/workflows/${text}.relavium.yaml`,
        bytes: 2048,
        warnings: [`Warning: ${text}`],
      },
      commit: () => {
        commits();
        return { ok: true, written: `Imported ${text}.` };
      },
    }),
  };
  const exportPort: ExportPort = {
    prepare: (slug) => ({
      ok: true,
      offer: { kind: 'workflow', slug, destination: `${slug}.relavium.yaml`, bytes: 4096 },
      commit: () => {
        commits();
        return { ok: true, written: `Exported ${slug}.` };
      },
    }),
  };
  const pricingPort: PricingPort = {
    models: () => [{ modelId: 'gpt-5', provider: 'openai', hint: 'OpenAI · catalog price' }],
    providers: () => ['openai'],
    providerName: () => text,
    prepare: () => ({
      ok: true,
      offer: {
        kind: 'set',
        model: 'gpt-5',
        provider: 'openai',
        providerName: text,
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
        return { ok: true, written: `Set user pricing for ${text}.` };
      },
    }),
  };
  return { importPort, exportPort, pricingPort, commits };
}

/**
 * One flow over the real channel on a manual clock, its frame acknowledged by hand. The key that opened it is on the one key history as the
 * landing stamps its keys: a KEY, never a resolution (the Home no longer stamps it as an answer: a chord card's lockout runs from the moment the
 * card opened, `createChordCardGuard`, so a flow whose first prompt is its chord is locked by the card alone).
 */
function start(name: FlowName, text?: string, options: { readonly initialized?: boolean } = {}) {
  let clock = 10_000;
  const history = createChordHistory();
  history.previousKeyAt = clock;
  const channel = createNativePromptChannel({ now: () => clock, history });
  channel.ui.bindVisibility(() => true);
  const fakes = ports(text);
  const root = mkdtempSync(join(tmpdir(), 'relavium-flow-popups-'));
  roots.push(root);
  const home = join(root, 'home');
  const cwd = join(home, 'project');
  mkdirSync(cwd, { recursive: true });
  if (options.initialized === true) mkdirSync(join(cwd, '.relavium'));
  /** Every snapshot the channel published from the flow's start (what each frame would draw). */
  const published: NativePromptSnapshot[] = [];
  channel.ui.subscribe(() => published.push(channel.ui.getSnapshot()));
  const result: Promise<string | undefined> = (() => {
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
        return runImportCard({ flow: channel.flow, port: fakes.importPort });
      case 'export':
        return runExportCard({ flow: channel.flow, port: fakes.exportPort }, text ?? 'nightly');
      case 'pricing':
        return runPricingCard({ flow: channel.flow, port: fakes.pricingPort });
    }
  })();
  const snap = (): NativePromptSnapshot => channel.ui.getSnapshot();
  const until = (check: (s: NativePromptSnapshot) => boolean): Promise<void> =>
    vi.waitFor(() => expect(check(snap())).toBe(true), { timeout: 5000, interval: 2 });
  const show = (): void => channel.ui.shown(snap());
  const key = (input: string, k: Key): boolean => channel.ui.input(input, k);
  /** Answer every step before the chord, each after its frame was shown and its settle passed; resolves on the chord, not yet shown. */
  const toChord = async (): Promise<void> => {
    if (name === 'import') {
      await until((s) => s.kind === 'text');
      show();
      clock += 1000;
      channel.ui.paste('shared/nightly-report.yaml');
      key('', ENTER);
    }
    if (name === 'pricing') {
      for (let step = 0; step < 8; step += 1) {
        await until((s) => s.kind === 'select' || s.kind === 'text' || s.kind === 'chord');
        if (snap().kind === 'chord') break;
        show();
        clock += 1000;
        if (/^Input price/u.test(snap().message)) channel.ui.paste('3');
        if (/^Output price/u.test(snap().message)) channel.ui.paste('9');
        key('', ENTER);
        await flush();
      }
    }
    await until((s) => s.kind === 'chord');
  };
  /** The Done step: wait for it, then close it with `Enter` after its frame was shown. */
  const closeDone = async (): Promise<NativePromptSnapshot> => {
    await until((s) => s.final !== undefined);
    const step = snap();
    show();
    clock += 1000;
    key('', ENTER);
    return step;
  };
  return {
    channel,
    history,
    result,
    snap,
    until,
    show,
    key,
    published,
    toChord,
    closeDone,
    commits: fakes.commits,
    /** Whether the flow wrote: a commit of its port, or (`/init`) the directory it creates. */
    wrote: (): boolean => fakes.commits.mock.calls.length > 0 || existsSync(join(cwd, '.relavium')),
    now: (): number => clock,
    at: (ms: number): void => {
      clock = ms;
    },
    advance: (ms: number): void => {
      clock += ms;
    },
  };
}

describe.each(FLOWS)('%s as a popup', (name) => {
  it('draws every prompt in the popup frame: its title, from the Home, the rail’s names, `step N of M`', async () => {
    const f = start(name);
    await f.toChord();
    // `begin` publishes the flow's empty wait and `framedFlow` frames it in the same breath (one render draws the second): every snapshot
    // after that first one, which says nothing, is framed.
    const asked = [...f.published, f.snap()].filter((s) => s.active && s.message !== '');
    expect(asked.length).toBeGreaterThan(0);
    for (const shown of asked) {
      expect(shown.popup?.title).toBe(RAIL[name].title);
      expect(shown.popup?.origin).toBe('home');
      expect(shown.popup?.stepNames).toEqual(RAIL[name].names);
      expect(shown.popup?.stepCount).toBe(RAIL[name].names.length);
    }
    expect(f.snap().popup?.stepIndex, 'the chord is on its step').toBe(RAIL[name].chordStep);
    f.key('', ESC);
    expect(await f.result).toBe(NOT_WRITTEN[name]);
  });

  it('Ctrl+Y after the guards writes once, and the Done step on the rail’s last step names the target project-relative (never absolute, never ~)', async () => {
    const f = start(name);
    await f.toChord();
    f.show();
    f.advance(5000);
    f.key('y', CTRL);
    const done = await f.closeDone();
    expect(f.wrote()).toBe(true);
    expect(done.final).toBe('ok');
    expect(done.popup?.stepIndex).toBe(RAIL[name].names.length - 1);
    // The Done step draws its target once, as the first row under the sentence (never as the option's hint).
    expect(
      done.options[0]?.hint,
      'the one option names nothing: the target is a row',
    ).toBeUndefined();
    const target = done.details[0];
    if (name !== 'pricing') {
      expect(target, 'a flow that writes a file names it').toBeDefined();
      expect(target?.startsWith('/')).toBe(false);
      expect(target?.startsWith('~')).toBe(false);
      expect(target?.startsWith('..'), 'from the project’s root, not the working directory').toBe(
        false,
      );
      expect(target).not.toMatch(/^[A-Za-z]:[\\/]/u);
    }
    expect(await f.result, 'the Done step said it: no notification').toBeUndefined();
    expect(f.snap().active).toBe(false);
  });

  it.each(['Esc', 'Ctrl+N', 'Ctrl+C'] as const)(
    '%s on the chord writes nothing and resolves with one notification that fits the popup’s legend row',
    async (how) => {
      const f = start(name);
      await f.toChord();
      f.show();
      f.advance(5000);
      if (how === 'Esc') f.key('', ESC);
      else f.key(how === 'Ctrl+N' ? 'n' : 'c', CTRL);
      const said = await f.result;
      expect(said).toBe(NOT_WRITTEN[name]);
      expect(displayWidth(said ?? '')).toBeLessThanOrEqual(POPUP_NOTICE_MAX_COLUMNS);
      expect(f.wrote()).toBe(false);
      expect(f.snap().active).toBe(false);
    },
  );

  it('Esc at every step before the chord leaves or steps back, and nothing is ever written', async () => {
    const f = start(name);
    // The first prompt: `Esc` leaves the flow (it is the first step's way back).
    await f.until((s) => s.active && s.kind !== 'busy');
    f.key('', ESC);
    expect(await f.result).toBe(NOT_WRITTEN[name]);
    expect(f.wrote()).toBe(false);
  });

  it('a held Ctrl+Y on the chord, from the moment it appeared, never writes; one patient press after it was let go does', async () => {
    const DELAYS = [250, 600, 1000, 1400, 1800] as const;
    const RATES = [30, 100, 450, 1000, 1800] as const;
    const HELD_FOR_MS = 6000;
    const answered: string[] = [];
    for (const mode of ['press', 'repeat'] as const)
      for (const delay of DELAYS)
        for (const rate of RATES) {
          const f = start(name);
          await f.toChord();
          const t0 = f.now();
          // The key is down as the chord appears: its first event lands before the frame is on screen and is dropped as unseen.
          f.channel.ui.unseenInput('y', CTRL);
          f.at(t0 + 16);
          f.show();
          let last = t0;
          for (let at = t0 + delay; at <= t0 + HELD_FOR_MS; at += rate) {
            f.at(at);
            last = at;
            f.key('y', mode === 'repeat' ? { ...CTRL, eventType: 'repeat' } : CTRL);
          }
          await flush();
          if (f.wrote()) answered.push(`${mode} ${String(delay)}/${String(rate)}`);
          // Let go, wait out the lockout from the last repeat, press once: that is a Yes.
          f.at(last + APPROVAL_LOCKOUT_MS + 1);
          f.key('y', CTRL);
          await f.closeDone();
          expect(
            f.wrote(),
            `the patient press after ${mode} ${String(delay)}/${String(rate)}`,
          ).toBe(true);
          expect(await f.result).toBeUndefined();
        }
    expect(answered).toEqual([]);
  });
});

describe('/init in a folder that is already a project', () => {
  it('opens no popup at all: one notification says where the project is', async () => {
    const f = start('init', undefined, { initialized: true });
    expect(await f.result).toBe('Already initialized at .relavium/');
    expect(f.published, 'no frame was ever asked for').toEqual([]);
    expect(f.snap().active).toBe(false);
  });

  it('names the project directory relative to the working directory when that fits the notification row, else says it plainly', async () => {
    const { alreadyInitializedNotice, INIT_ALREADY_HERE } =
      await import('../../home/project-init.js');
    expect(alreadyInitializedNotice('/w/p', '/w/p/.relavium')).toBe(
      'Already initialized at .relavium/',
    );
    expect(alreadyInitializedNotice('/w/p/a/b', '/w/p/.relavium')).toBe(
      'Already initialized at ../../.relavium/',
    );
    const deep = `/w/${'d/'.repeat(30)}p`;
    expect(alreadyInitializedNotice(deep, '/w/.relavium')).toBe(INIT_ALREADY_HERE);
    expect(displayWidth(INIT_ALREADY_HERE)).toBeLessThanOrEqual(POPUP_NOTICE_MAX_COLUMNS);
  });
});

/** A workflow with no inputs: `/run` started on it from the Defined tab (`r`) opens on its confirmation. */
const NO_INPUTS = `schema_version: '1.0'
workflow:
  id: no-inputs
  nodes:
    - { id: start, type: input }
    - { id: out, type: output }
  edges:
    - { from: start, to: out }
`;

const NO_INPUTS_CATALOG: LaunchCatalog = {
  list: () => [
    { path: 'no-inputs.yaml', slug: 'no-inputs', name: undefined, tags: [], valid: true },
  ],
  load: (path) => ({
    definition: parseWorkflow(NO_INPUTS, { source: path }),
    sourceDigest: 'd'.repeat(64),
    fsScope: { tier: 'sandboxed', fromRepository: false },
  }),
};

describe('a chord card that is the first prompt of a flow is locked from the moment it appeared (nothing stamps the key that opened it)', () => {
  it.each(['init', 'export'] as const)(
    '%s: a Ctrl+Y held at a slow repeat from the moment the card appeared never writes, past the dwell and the quiet gap; a patient press after it does',
    async (name) => {
      // Before unit 6's round 1 the held key wrote here unless the Home stamped the key that opened the flow as an answer; that stamp is gone.
      const f = start(name);
      await f.toChord();
      const t0 = f.now();
      f.channel.ui.unseenInput('y', CTRL);
      f.at(t0 + 16);
      f.show();
      let last = t0;
      for (let at = t0 + 250; at <= t0 + 6000; at += 450) {
        f.at(at);
        last = at;
        f.key('y', CTRL);
      }
      await flush();
      expect(f.wrote()).toBe(false);
      f.at(last + APPROVAL_LOCKOUT_MS);
      f.key('y', CTRL);
      await f.closeDone();
      expect(f.wrote()).toBe(true);
      expect(await f.result).toBeUndefined();
    },
  );

  /**
   * Unit 6 round 1, S2/A1: `r` on a Defined row starts the launch on that workflow, and one with no inputs opens on its `Ctrl+Y` confirmation,
   * which no answer came before (`r` is a screen's key: nothing stamped it at all). A held `Ctrl+Y` started the run in 17 of 25 initial delays
   * and repeat gaps; the card's own lockout now holds it, and one patient press after the key was let go starts it once.
   */
  it.each(['legacy', 'kitty'] as const)(
    '/run by `r` on a workflow with no inputs: a held Ctrl+Y (%s repeats) from the moment the confirmation appeared never starts the run',
    async (mode) => {
      const DELAYS = [250, 600, 1000, 1400, 1800] as const;
      const RATES = [30, 100, 450, 1000, 1800] as const;
      const HELD_FOR_MS = 6000;
      const started: string[] = [];
      for (const delay of DELAYS)
        for (const rate of RATES) {
          let clock = 10_000;
          const history = createChordHistory();
          const channel = createNativePromptChannel({ now: () => clock, history });
          /** The frame the host measured and flushed (none yet). */
          const screen: { frame?: NativePromptSnapshot } = {};
          channel.ui.bindVisibility((snapshot) => snapshot === screen.frame);
          const start = vi.fn(
            (): Promise<HostedLaunch> =>
              Promise.resolve({
                kind: 'started',
                leg: 'start',
                runId: '0123456789abcdef-run',
                ended: new Promise(() => undefined),
              }),
          );
          const launch = createRunLaunch({
            flow: channel.flow,
            host: { start },
            catalog: NO_INPUTS_CATALOG,
          });
          const t0 = clock;
          const opened = launch.open('no-inputs', 'no-inputs.yaml');
          await vi.waitFor(() => expect(channel.ui.getSnapshot().kind).toBe('chord'), {
            timeout: 5000,
            interval: 2,
          });
          // The key is down as the confirmation appears: its first event lands before the frame is on screen.
          channel.ui.unseenInput('y', CTRL);
          clock = t0 + 16;
          screen.frame = channel.ui.getSnapshot();
          channel.ui.shown(screen.frame);
          let last = t0;
          for (let at = t0 + delay; at <= t0 + HELD_FOR_MS; at += rate) {
            clock = at;
            last = at;
            channel.ui.input('y', mode === 'kitty' ? { ...CTRL, eventType: 'repeat' } : CTRL);
          }
          await flush();
          if (start.mock.calls.length > 0) started.push(`${String(delay)}/${String(rate)}`);
          clock = last + APPROVAL_LOCKOUT_MS + 1;
          channel.ui.input('y', CTRL);
          expect(await opened, `the patient press after ${String(delay)}/${String(rate)}`).toMatch(
            /^Started /u,
          );
          expect(start).toHaveBeenCalledTimes(1);
        }
      expect(started).toEqual([]);
    },
  );
});

describe('every untrusted string passes the full scrub before it reaches the channel', () => {
  it.each(['import', 'export', 'pricing'] as const)(
    '%s: an id, a path, a provider and a notice that hold the corpus reach the chord card, the Done step and every other prompt without it',
    async (name) => {
      const f = start(name, HOSTILE_LONG);
      await f.toChord();
      f.show();
      f.advance(5000);
      f.key('y', CTRL);
      const done = await f.closeDone();
      await f.result;
      const everything = [...f.published, done].map((s) =>
        JSON.stringify([s.message, s.note, s.details, s.options, s.error]),
      );
      for (const drawn of everything)
        for (const bad of FORBIDDEN) expect(drawn, JSON.stringify(bad)).not.toContain(bad);
    },
  );

  it('/pricing and /import: a refusal that quotes the corpus is drawn without it, under the product’s own sentence', async () => {
    let clock = 10_000;
    const channel = createNativePromptChannel({ now: () => clock });
    channel.ui.bindVisibility(() => true);
    const refusing: PricingPort = {
      ...ports().pricingPort,
      prepare: () => ({ ok: false, reason: HOSTILE_LONG }),
    };
    const pricing = runPricingCard({ flow: channel.flow, port: refusing });
    for (let step = 0; step < 10; step += 1) {
      await flush();
      const now = channel.ui.getSnapshot();
      if (now.kind === 'select' && now.options.some((option) => option.value === 'close')) break;
      channel.ui.shown(now);
      clock += 1000;
      if (/^Input price/u.test(now.message)) channel.ui.paste('3');
      if (/^Output price/u.test(now.message)) channel.ui.paste('9');
      channel.ui.input('', ENTER);
    }
    const refusal = JSON.stringify(channel.ui.getSnapshot().details);
    expect(refusal).toContain('w'.repeat(40));
    for (const bad of FORBIDDEN) expect(refusal, JSON.stringify(bad)).not.toContain(bad);
    channel.ui.input('', ESC);
    expect(await pricing).toBeUndefined();

    const importing = createNativePromptChannel({ now: () => clock });
    importing.ui.bindVisibility(() => true);
    const imported = runImportCard({
      flow: importing.flow,
      port: { pathIssue: () => undefined, prepare: () => ({ ok: false, reason: HOSTILE_LONG }) },
    });
    await flush();
    importing.ui.shown(importing.ui.getSnapshot());
    clock += 1000;
    importing.ui.paste('x.yaml');
    importing.ui.input('', ENTER);
    await flush();
    const reason = JSON.stringify(importing.ui.getSnapshot().details);
    expect(reason).toContain('w'.repeat(40));
    for (const bad of FORBIDDEN) expect(reason, JSON.stringify(bad)).not.toContain(bad);
    importing.ui.input('', ESC);
    expect(await imported).toBeUndefined();
  });

  it('/pricing: a model id that the scrub would draw otherwise than it is stored is refused before the card asks', async () => {
    const { pricingModelIdFault } = await import('./pricing-card.js');
    for (const id of [
      'gpt-[Ctrl+Y]',
      'model-Ctrl+Y',
      'ｇｐｔ-5',
      `a${String.fromCodePoint(0x301)}b`,
      '✓-model',
    ])
      expect(pricingModelIdFault(id), id).toBe('unsafe');
    expect(pricingModelIdFault('gpt-5.5')).toBeUndefined();
    expect(pricingModelIdFault(`q${String.fromCodePoint(0x301)}`)).toBeUndefined();
  });
});
