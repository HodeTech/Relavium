/**
 * `r` held down on a History run's detail does not type into the launch form's first field (MVP-11 unit 7, round 2: security F2). The
 * controller is real, the launch flow is `createRunLaunch` over the real native prompt channel on an injected clock and the Home's shared chord
 * history (which is where the controller leaves the key that opened the flow and the channel finds it), and the workflow asks one text input, so
 * the first thing the key opens is a text field. The held-key grid is the flow test's own: five initial delays by two rates.
 *
 * What is proved: a held `r` leaves the field empty once its second repeat has shown it is held, at every cell of the grid (the one character
 * its first repeat typed is taken back); a deliberate `r` typed after a pause still types, with or without letters after it; a terminal that reports
 * the repeat and a read that coalesced several are dropped at once; the key held in a Home whose controller recorded nothing (a flow no key
 * opened) types as it always did; and nothing starts. A masked first field (round 2 sitting #2, F2) gets the same rule: its bullets are only
 * what the person typed, and the secret the start is handed (read through its port, as the run core reads it) holds no stray character.
 */
import { parseWorkflow } from '@relavium/core';
import type { Key } from 'ink';
import { describe, expect, it, vi } from 'vitest';

import type { RunDetailLoad } from '../../history/run-detail-source.js';
import type { HomeSnapshot } from '../../home/home-store.js';
import type { HostedLaunch, HostedStartRequest, RunHostSnapshot } from '../../home/run-host.js';
import { createRunLaunch, type LaunchCatalog, type LaunchOptions } from '../../home/run-launch.js';
import { createChordHistory } from './chord-guard.js';
import {
  createHomeController,
  type HomeChatSession,
  type HomeControllerDeps,
} from './home-controller.js';
import { createNativePromptChannel, type NativePromptSnapshot } from './native-prompt-channel.js';
import { definedPortOver, historyListOfRun, runDetailRead } from './run-again.test-support.js';

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
const ENTER = { return: true } as const;
const CTRL: Key = { ...none, ctrl: true };

/** No input at all: the form opens on its confirmation card. */
const NO_INPUTS = `schema_version: '1.0'
workflow:
  id: nightly
  nodes:
    - { id: start, type: input }
    - { id: out, type: output }
  edges:
    - { from: start, to: out }
`;

/** One text input: the form's first prompt is a text field. */
const ONE_FIELD = `schema_version: '1.0'
workflow:
  id: nightly
  inputs:
    - { name: topic, type: string, required: true }
  nodes:
    - { id: start, type: input }
    - { id: out, type: output }
  edges:
    - { from: start, to: out }
`;

/** One masked input: the form's first prompt is a secret field, which shows bullets and keeps its buffer in the channel alone. */
const SECRET_FIELD = `schema_version: '1.0'
workflow:
  id: nightly
  inputs:
    - { name: token, type: secret, required: true }
  nodes:
    - { id: start, type: input }
    - { id: out, type: output }
  edges:
    - { from: start, to: out }
`;

const EMPTY: HomeSnapshot = {
  failedRuns: [],
  recentSessions: [],
  recentRuns: [],
  recentAgents: [],
  unreadableRuns: [],
  totals: { attention: 0, sessions: 0, runs: 0 },
  isEmpty: true,
};
const IDLE: RunHostSnapshot = { launching: false, active: undefined, last: undefined };

/** When the person presses `r`, on the injected clock: well after the Home's first frame. */
const PRESSED_AT = 10_000;
/** The form's first frame is measured and flushed this long after the key. */
const FRAME_AFTER_MS = 60;
/** How long a key is held in the grid, and the initial repeat delays and rates it is held at. */
const HOLD_MS = 4_000;
const INITIAL_DELAYS_MS = [0, 250, 500, 660, 1_800] as const;
const REPEAT_INTERVALS_MS = [30, 100] as const;

const catalogOf = (yaml: string): LaunchCatalog => ({
  list: () => [{ path: 'nightly.yaml', slug: 'nightly', name: undefined, tags: [], valid: true }],
  load: (path) => ({
    definition: parseWorkflow(yaml, { source: path }),
    sourceDigest: 'd'.repeat(64),
    fsScope: { tier: 'sandboxed', fromRepository: false },
  }),
});

const STARTED: HostedLaunch = {
  kind: 'started',
  leg: 'start',
  runId: '0123456789abcdef-run',
  ended: new Promise(() => {}),
};

/** A Home on a History detail whose `r` opens the real launch flow, asking a text field first. */
async function mount(
  options: {
    readonly recordOpener?: boolean;
    /** The workflow has no input: the form opens on its confirmation card, not a text field. */
    readonly card?: boolean;
    /** The workflow's one input is a secret: the form's first prompt is a masked field. */
    readonly secret?: boolean;
    /** A launch that opens no flow (a refusal found before anything was asked): the key's record is then still on the history. */
    readonly launch?: (slug?: string, path?: string) => Promise<string>;
    /** `[r]` of the `/workflows` popup asks for the launch, not `r` on a History detail (the Home carries out what the popup asked for). */
    readonly via?: 'popup';
  } = {},
) {
  let clock = PRESSED_AT - 1_000;
  const chordHistory = createChordHistory();
  const channel = createNativePromptChannel({ now: () => clock, history: chordHistory });
  let visible: NativePromptSnapshot | undefined;
  channel.ui.bindVisibility((snapshot) => snapshot === visible);
  /** The masked values the start was handed, read through its port while it prepares, as the run core reads them. */
  let startedSecrets: Readonly<Record<string, string>> | undefined;
  const host = {
    start: vi.fn(async (request: HostedStartRequest) => {
      startedSecrets = (await request.secrets?.(['token'])) ?? {};
      return STARTED;
    }),
  };
  const launch = createRunLaunch({
    flow: channel.flow,
    host,
    catalog: catalogOf(
      options.card === true ? NO_INPUTS : options.secret === true ? SECRET_FIELD : ONE_FIELD,
    ),
  });
  /** What the Home asked its popup host to open (`/workflows`: the popup is the host's, and its `[r]` is a request the Home carries out). */
  const popups: Parameters<NonNullable<HomeControllerDeps['openHomePopup']>>[0][] = [];
  const open = vi.fn((slug?: string, path?: string, launchOptions?: LaunchOptions) => {
    if (options.launch !== undefined) return options.launch(slug, path);
    // A Home whose controller left no opener on the history: a flow no key opened (`/run` typed, a palette entry).
    if (options.recordOpener === false) chordHistory.openedBy = undefined;
    return launch.open(slug, path, launchOptions);
  });
  const controller = createHomeController({
    startChat: () => new Promise<HomeChatSession>(() => {}),
    history: {
      read: () => historyListOfRun(),
      cost: () => ({ kind: 'text', text: '$0.01' }),
      loadDetail: () => Promise.resolve<RunDetailLoad>({ kind: 'ready', detail: runDetailRead() }),
    },
    defined: definedPortOver([
      { slug: 'nightly', name: undefined, nodeCount: 2, path: 'nightly.yaml', valid: true },
    ]).port,
    launchRun: open,
    openHomePopup: (request) => {
      popups.push(request);
    },
    chordHistory,
    homeStore: { read: () => EMPTY },
    hostedRuns: { snapshot: () => IDLE, cancel: () => true, close: () => Promise.resolve() },
    schedule: () => () => {},
    now: () => clock,
    onExit: () => {},
    onError: (cause) => {
      throw cause;
    },
  });
  expect(controller.openScreen('tab-host', { tab: 'history' })).toBe(true);
  controller.handleKey('', ENTER);
  await new Promise((resolve) => setTimeout(resolve, 0));
  if (options.via === 'popup') {
    controller.closeScreen();
    for (const letter of '/workflows') controller.handleKey(letter, {});
    controller.handleKey('', ENTER);
  }
  const rig = {
    controller,
    channel,
    chordHistory,
    host,
    open,
    popups,
    at: (time: number): void => {
      clock = time;
    },
    display: (): string => channel.ui.getSnapshot().display,
    snapshot: (): NativePromptSnapshot => channel.ui.getSnapshot(),
    /** The host measured and flushed the frame on the channel now. */
    show: (): void => {
      visible = channel.ui.getSnapshot();
      channel.ui.shown(visible);
    },
    /** `r` pressed, and the form's first text field up for it. */
    pressR: async (): Promise<void> => {
      clock = PRESSED_AT;
      if (options.via === 'popup') popups[0]?.port.workflows?.run('nightly', 'nightly.yaml');
      else controller.handleKey('r', {});
      const first = options.card === true ? 'chord' : options.secret === true ? 'password' : 'text';
      for (let turn = 0; turn < 50 && channel.ui.getSnapshot().kind !== first; turn += 1)
        await new Promise<void>((resolve) => setImmediate(resolve));
      expect(channel.ui.getSnapshot().kind, 'the form’s first prompt is up').toBe(first);
    },
    /** A key reaches the open form at `time`. */
    key: (time: number, input: string, key: Key = none): void => {
      clock = time;
      channel.ui.input(input, key);
    },
    /**
     * `Enter` on the open field at `time`, the confirmation card shown, and a patient `Ctrl+Y` well past its guards: the masked values the start
     * was handed (the secret port the run core reads). What the channel kept in its buffer, read where the run reads it, never off a display.
     */
    startWith: async (time: number): Promise<Readonly<Record<string, string>>> => {
      clock = time;
      channel.ui.input('', { ...none, return: true });
      for (let turn = 0; turn < 50 && channel.ui.getSnapshot().kind !== 'chord'; turn += 1)
        await new Promise<void>((resolve) => setImmediate(resolve));
      expect(channel.ui.getSnapshot().kind, 'the confirmation card is up').toBe('chord');
      clock = time + FRAME_AFTER_MS;
      visible = channel.ui.getSnapshot();
      channel.ui.shown(visible);
      clock = time + 4_000;
      channel.ui.input('y', CTRL);
      await vi.waitFor(() => expect(startedSecrets).toBeDefined());
      expect(host.start).toHaveBeenCalledTimes(1);
      return startedSecrets ?? {};
    },
  };
  return rig;
}

describe('a `r` held down on the detail types nothing into the form’s first field', () => {
  for (const initial of INITIAL_DELAYS_MS) {
    for (const interval of REPEAT_INTERVALS_MS) {
      it(`first repeat after ${String(initial)} ms, then every ${String(interval)} ms: the field is empty once the key is known to be held, and a deliberate key after it types`, async () => {
        const m = await mount();
        await m.pressR();
        expect(m.open).toHaveBeenCalledWith('nightly', 'nightly.yaml');
        let shown = false;
        let peak = 0;
        let last = PRESSED_AT;
        for (let at = PRESSED_AT + initial; at <= PRESSED_AT + initial + HOLD_MS; at += interval) {
          if (!shown && at >= PRESSED_AT + FRAME_AFTER_MS) {
            m.at(PRESSED_AT + FRAME_AFTER_MS);
            m.show(); // the form's first frame is on screen before this repeat
            shown = true;
          }
          m.key(at, 'r');
          last = at;
          peak = Math.max(peak, m.display().length);
        }
        expect(peak, 'at most the one character the first repeat typed, ever').toBeLessThanOrEqual(
          1,
        );
        expect(m.display(), 'taken back, and nothing typed after it').toBe('');
        expect(m.snapshot().kind, 'still the first field').toBe('text');
        expect(m.host.start).not.toHaveBeenCalled();
        // The key is let go: a deliberate `r` after a pause is the person’s own, and the letters after it follow.
        m.key(last + 400, 'r');
        expect(m.display()).toBe('r');
        m.key(last + 700, 'x');
        expect(m.display()).toBe('rx');
      });
    }
  }
});

describe('a `r` held down in the /workflows popup types nothing into the form’s first field either (MVP-11 unit 8)', () => {
  for (const initial of INITIAL_DELAYS_MS) {
    for (const interval of REPEAT_INTERVALS_MS) {
      it(`first repeat after ${String(initial)} ms, then every ${String(interval)} ms: the popup closed itself on the first press, so the field is empty once the key is known to be held`, async () => {
        const m = await mount({ via: 'popup' });
        await m.pressR();
        expect(m.open).toHaveBeenCalledWith('nightly', 'nightly.yaml', {
          opener: { origin: 'workflows' },
        });
        expect(m.snapshot().popup?.origin, 'the `/run` popup is stacked from /workflows').toBe(
          'workflows',
        );
        let shown = false;
        let peak = 0;
        for (let at = PRESSED_AT + initial; at <= PRESSED_AT + initial + HOLD_MS; at += interval) {
          if (!shown && at >= PRESSED_AT + FRAME_AFTER_MS) {
            m.at(PRESSED_AT + FRAME_AFTER_MS);
            m.show();
            shown = true;
          }
          m.key(at, 'r');
          peak = Math.max(peak, m.display().length);
        }
        expect(peak, 'at most the one character the first repeat typed, ever').toBeLessThanOrEqual(
          1,
        );
        expect(m.display(), 'taken back, and nothing typed after it').toBe('');
        expect(m.host.start).not.toHaveBeenCalled();
      });
    }
  }
});

describe('a `r` held down on the detail types nothing into a masked first field either (round 2 sitting #2, F2)', () => {
  for (const initial of INITIAL_DELAYS_MS) {
    for (const interval of REPEAT_INTERVALS_MS) {
      it(`first repeat after ${String(initial)} ms, then every ${String(interval)} ms: no bullet is left once the key is known to be held, and the secret started is only what was typed after it`, async () => {
        const m = await mount({ secret: true });
        await m.pressR();
        let shown = false;
        let peak = 0;
        let last = PRESSED_AT;
        for (let at = PRESSED_AT + initial; at <= PRESSED_AT + initial + HOLD_MS; at += interval) {
          if (!shown && at >= PRESSED_AT + FRAME_AFTER_MS) {
            m.at(PRESSED_AT + FRAME_AFTER_MS);
            m.show();
            shown = true;
          }
          m.key(at, 'r');
          last = at;
          peak = Math.max(peak, m.display().length);
        }
        expect(peak, 'at most the one bullet the first repeat typed, ever').toBeLessThanOrEqual(1);
        expect(m.display(), 'taken back: the field shows no bullet').toBe('');
        expect(m.snapshot().kind, 'still the masked field').toBe('password');
        expect(m.host.start).not.toHaveBeenCalled();
        m.key(last + 400, 'r');
        expect(m.display(), 'a deliberate key after the hold is one bullet').toBe('•');
        m.key(last + 700, 'x');
        expect(m.display()).toBe('••');
        expect(await m.startWith(last + 1_000), 'the buffer holds no stray character').toEqual({
          token: 'rx',
        });
      });
    }
  }

  it('one `r` typed 700 ms after the form opened is the first character of the secret', async () => {
    const m = await mount({ secret: true });
    await m.pressR();
    m.at(PRESSED_AT + FRAME_AFTER_MS);
    m.show();
    m.key(PRESSED_AT + 700, 'r');
    expect(m.display()).toBe('•');
    m.key(PRESSED_AT + 920, 'e');
    m.key(PRESSED_AT + 1_140, 'l');
    expect(m.display()).toBe('•••');
    expect(await m.startWith(PRESSED_AT + 1_500)).toEqual({ token: 'rel' });
  });

  it('`rr` typed in a burst at the start costs both, as in a text field: the one bullet left is the `x` typed after them', async () => {
    const m = await mount({ secret: true });
    await m.pressR();
    m.at(PRESSED_AT + FRAME_AFTER_MS);
    m.show();
    m.key(PRESSED_AT + 600, 'r');
    m.key(PRESSED_AT + 680, 'r');
    expect(m.display(), 'the burst is a chain: nothing of it is left').toBe('');
    m.key(PRESSED_AT + 800, 'x');
    expect(m.display(), 'exactly one bullet, and it is the x').toBe('•');
    expect(await m.startWith(PRESSED_AT + 1_200)).toEqual({ token: 'x' });
  });
});

describe('a deliberate `r` still types', () => {
  it.each([300, 700, 1_500])(
    'one `r` typed %i ms after the form opened, with letters after it, is the first letter of the value',
    async (pause) => {
      const m = await mount();
      await m.pressR();
      m.at(PRESSED_AT + FRAME_AFTER_MS);
      m.show();
      m.key(PRESSED_AT + pause, 'r');
      expect(m.display()).toBe('r');
      m.key(PRESSED_AT + pause + 220, 'e');
      m.key(PRESSED_AT + pause + 440, 'l');
      expect(m.display()).toBe('rel');
    },
  );

  it('two `r`s typed 400 ms apart are two letters', async () => {
    const m = await mount();
    await m.pressR();
    m.at(PRESSED_AT + FRAME_AFTER_MS);
    m.show();
    m.key(PRESSED_AT + 500, 'r');
    m.key(PRESSED_AT + 900, 'r');
    expect(m.display()).toBe('rr');
  });

  it('a different letter first ends the rule: an `r` held after it is the person’s own typing', async () => {
    const m = await mount();
    await m.pressR();
    m.at(PRESSED_AT + FRAME_AFTER_MS);
    m.show();
    m.key(PRESSED_AT + 400, 'x');
    for (let n = 0; n < 4; n += 1) m.key(PRESSED_AT + 600 + n * 30, 'r');
    expect(m.display()).toBe('xrrrr');
  });

  it('a paste ends the rule: what a person pastes is their own, and `r`s after it are typing', async () => {
    const m = await mount();
    await m.pressR();
    m.at(PRESSED_AT + FRAME_AFTER_MS);
    m.show();
    m.at(PRESSED_AT + 300);
    m.channel.ui.paste('ab');
    m.key(PRESSED_AT + 500, 'r');
    m.key(PRESSED_AT + 530, 'r');
    expect(m.display()).toBe('abrr');
  });

  it('a flow no key opened types every letter, however fast', async () => {
    const m = await mount({ recordOpener: false });
    await m.pressR();
    m.at(PRESSED_AT + FRAME_AFTER_MS);
    m.show();
    for (let n = 0; n < 4; n += 1) m.key(PRESSED_AT + 500 + n * 30, 'r');
    expect(m.display()).toBe('rrrr');
  });
});

describe('what a terminal says, and what a busy loop coalesces', () => {
  it('a repeat the terminal reports as one is dropped at once, from the first', async () => {
    const m = await mount();
    await m.pressR();
    m.at(PRESSED_AT + FRAME_AFTER_MS);
    m.show();
    for (let n = 0; n < 20; n += 1) {
      m.key(PRESSED_AT + 500 + n * 33, 'r', { ...none, eventType: 'repeat' });
      expect(m.display()).toBe('');
    }
  });

  it('a read that holds the key several times over is dropped whole, and the repeats after it', async () => {
    const m = await mount();
    await m.pressR();
    m.at(PRESSED_AT + FRAME_AFTER_MS);
    m.show();
    m.key(PRESSED_AT + 900, 'rrrrrrrr');
    expect(m.display()).toBe('');
    m.key(PRESSED_AT + 933, 'r');
    m.key(PRESSED_AT + 966, 'rrr');
    expect(m.display()).toBe('');
  });

  it('repeats that arrive before the form’s first frame count toward the chain, so the first one typed afterwards is not mistaken for a letter', async () => {
    const m = await mount();
    await m.pressR();
    // The frame is acknowledged late: every repeat of the first 400 ms was dropped unseen by the opening guard.
    for (let at = PRESSED_AT + 30; at < PRESSED_AT + 400; at += 30) m.key(at, 'r');
    expect(m.display()).toBe('');
    m.at(PRESSED_AT + 400);
    m.show();
    for (let at = PRESSED_AT + 420; at < PRESSED_AT + 1_500; at += 30) {
      m.key(at, 'r');
      expect(m.display()).toBe('');
    }
  });

  it('keys the host dropped unseen keep the chain going, and one of them takes back the character a seen repeat typed', async () => {
    const m = await mount();
    await m.pressR();
    m.at(PRESSED_AT + FRAME_AFTER_MS);
    m.show();
    m.key(PRESSED_AT + 500, 'r'); // the candidate, typed
    expect(m.display()).toBe('r');
    m.at(PRESSED_AT + 533);
    m.channel.ui.unseenInput('r', none); // the host could not show the frame for this one
    expect(m.display(), 'the unseen repeat showed the key is held').toBe('');
  });
});

describe('the key that opened the form is left on the Home’s key history, and taken once by the flow it opened', () => {
  it('the controller leaves a plain `r` and the moment it was pressed, and the flow takes it when it begins', async () => {
    const refused = await mount({ launch: () => Promise.resolve('A run is already executing.') });
    expect(refused.chordHistory.openedBy, 'nothing before the key').toBeUndefined();
    refused.at(PRESSED_AT);
    refused.controller.handleKey('r', {});
    expect(refused.chordHistory.openedBy, 'left for a flow that has not begun').toEqual({
      input: 'r',
      at: PRESSED_AT,
    });
    const m = await mount();
    await m.pressR();
    expect(m.chordHistory.openedBy, 'taken by the flow it opened, once').toBeUndefined();
  });

  it('a chord, an Alt chord and a chunk of text open nothing and leave nothing', async () => {
    const m = await mount();
    m.controller.handleKey('r', { ctrl: true });
    m.controller.handleKey('r', { meta: true });
    m.controller.handleKey('rr', {});
    expect(m.chordHistory.openedBy).toBeUndefined();
    expect(m.open).not.toHaveBeenCalled();
  });

  it('the `/workflows` popup’s `[r]` leaves the same record: the one rule covers every key that opens the form', async () => {
    const refused = await mount({ launch: () => Promise.resolve('A run is already executing.') });
    refused.controller.closeScreen();
    for (const letter of '/workflows') refused.controller.handleKey(letter, {});
    refused.controller.handleKey('', ENTER);
    expect(refused.popups.map((request) => request.kind)).toEqual(['workflows']);
    // The popup closed itself and handed the Home its request; the key that made it is the popup's `[r]`, at this moment.
    refused.at(PRESSED_AT);
    refused.popups[0]?.port.workflows?.run('nightly', 'nightly.yaml');
    expect(refused.chordHistory.openedBy).toEqual({ input: 'r', at: PRESSED_AT });
    expect(refused.open).toHaveBeenCalledWith('nightly', 'nightly.yaml', {
      opener: { origin: 'workflows' },
    });
  });
});

describe('a launch refused before any flow began leaves no key record for the next flow (round 2 sitting #2, F5)', () => {
  it.each([500, 1_500])(
    'a text flow begun %i ms after a refused `r` keeps `rrx` typed in a burst, whole',
    async (later) => {
      const m = await mount({ launch: () => Promise.resolve('A run is already executing.') });
      m.at(PRESSED_AT);
      m.controller.handleKey('r', {});
      await vi.waitFor(() => expect(m.open).toHaveBeenCalledTimes(1));
      await vi.waitFor(() => expect(m.controller.getSnapshot().nativeActionBusy).toBe(false));
      expect
        .soft(m.chordHistory.openedBy, 'the refused launch took its key record with it')
        .toBe(undefined);
      // Another flow begins on the same channel (a `/init` name, a pricing id: any text field no key opened), and the person types fast.
      const begin = PRESSED_AT + later;
      m.at(begin);
      m.channel.flow.begin();
      const answer = m.channel.flow.text({ message: 'Name' });
      m.key(begin + 100, 'r');
      m.key(begin + 180, 'r');
      m.key(begin + 260, 'x');
      expect(m.display(), 'no stale opener: the burst is the person’s').toBe('rrx');
      m.key(begin + 400, '', { ...none, return: true });
      expect(await answer).toBe('rrx');
      await m.channel.flow.end();
    },
  );
});

describe('the chain a held `r` makes is still typing for the confirmation card’s guards', () => {
  it('a `Ctrl+Y` shortly after the last repeat of a held `r` answers nothing, though the chain typed nothing anywhere', async () => {
    const m = await mount({ card: true });
    await m.pressR();
    m.at(PRESSED_AT + FRAME_AFTER_MS);
    m.show(); // the card is on screen, and its dwell and lockout run out well before the chain does
    let last = PRESSED_AT;
    for (let at = PRESSED_AT + 1_600; at <= PRESSED_AT + 4_000; at += 30) {
      m.key(at, 'r');
      last = at;
    }
    expect(m.snapshot().kind, 'the held key answered nothing').toBe('chord');
    // Past the quiet gap (300 ms), inside the typeahead window (1.5 s): only the chain counted as typing keeps the chord from answering.
    m.key(last + 600, 'y', CTRL);
    expect(m.snapshot().kind, 'the card is still asking').toBe('chord');
    expect(m.host.start).not.toHaveBeenCalled();
    // Left alone for the whole window, the patient press answers.
    m.key(last + 600 + 2_100, 'y', CTRL);
    await vi.waitFor(() => expect(m.host.start).toHaveBeenCalledTimes(1));
  });
});
