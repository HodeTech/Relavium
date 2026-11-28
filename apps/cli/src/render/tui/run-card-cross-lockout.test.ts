/**
 * One lockout across the Home's cards
 * ([ADR-0139](../../../../../docs/decisions/0139-a-workflow-run-is-hosted-inside-the-home.md) §4).
 *
 * A key held down on a gate card answers it; the answer opens the next card (the MCP consent card of the resumed leg), and the held key's
 * auto-repeat arrives on it. The lockout that stops that is the approval guard's, and it is only as wide as the evidence it reads: a gate
 * card and the consent card that kept their own would each see a card that had never been answered. So both are built over the Home's
 * ONE chord history, and this file proves it with the two real surfaces (the gate card model and the native prompt channel's chord card)
 * on one injected clock, with the dwell, the quiet gap and the typeahead switched off so that the lockout is the only rule in play.
 *
 * The answer that opens the next card is not always followed by it at once: the `/run` confirmation's `Ctrl+Y` starts the run, and the MCP
 * consent card the start raises comes after `Starting the run…`; a gate's answer resumes a leg that connects its server first. The repeats of
 * a key held through that wait land on the wait as typing, and a wait longer than the lockout left nothing to hold the card (unit 6 round 1,
 * S1). The card's own opening now starts a lockout (`createChordCardGuard`), and the last part of this file holds the key through the REAL
 * `/run` launch (`createRunLaunch`, `askConsent`, the channel, the product's numbers) and through a gate's resume.
 */
import { parseWorkflow } from '@relavium/core';
import type { Key } from 'ink';
import { describe, expect, it, vi } from 'vitest';

import type { ConsentSubject } from '../../engine/mcp-consent-gate.js';
import { askConsent } from '../../home/consent-card.js';
import type { RunGate } from '../../home/run-gates.js';
import type { HostedLaunch, HostedStartRequest } from '../../home/run-host.js';
import { createRunLaunch, type LaunchCatalog } from '../../home/run-launch.js';
import { POPUP_SELECT_SETTLE_MS } from '../../popups/opening-guard.js';
import type { ChatKey } from './chat-input.js';
import { createChordHistory, type ChordHistory } from './chord-guard.js';
import { createNativePromptChannel, type NativePromptSnapshot } from './native-prompt-channel.js';
import { createRunCard } from './run-card-model.js';
import { APPROVAL_LOCKOUT_MS, type ApprovalGuard } from './tool-review-model.js';

const RUN = 'run-0001';
/** Only the lockout (the product's own 2 s) is on. */
const LOCKOUT_ONLY: ApprovalGuard = { settleMs: 0, quietMs: 0, typeaheadMs: 0 };
const CTRL: ChatKey = { ctrl: true };
/** The same chord as the native channel takes it (ink's whole `Key`). */
const CHANNEL_CTRL: Key = {
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
  ctrl: true,
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
const STARTED: HostedLaunch = {
  kind: 'started',
  leg: 'resume',
  runId: RUN,
  ended: new Promise(() => undefined),
};

function gate(id: string): RunGate {
  return {
    runId: RUN,
    gateId: id,
    nodeId: `node-${id}`,
    gateType: 'approval',
    message: `Approve ${id}?`,
    accepts: ['approved', 'rejected'],
  };
}

/** A gate card and the native channel over one clock; `history` is what the Home shares (or `undefined`: each keeps its own). */
function rig(history: ChordHistory | undefined) {
  // The gate card opened two seconds before the person answers it at 0: its own lockout runs from its appearance (MVP-11 unit 7, round 1),
  // so an answer at the very moment it opened would be refused.
  let now = -APPROVAL_LOCKOUT_MS;
  const resume = vi.fn(() => Promise.resolve(STARTED));
  const card = createRunCard({
    runId: RUN,
    gates: [gate('a')],
    resume,
    now: () => now,
    guard: LOCKOUT_ONLY,
    ...(history === undefined ? {} : { history }),
    painted: () => true,
  });
  const channel = createNativePromptChannel({
    now: () => now,
    guard: LOCKOUT_ONLY,
    ...(history === undefined ? {} : { history }),
  });
  channel.ui.bindVisibility((snapshot) => snapshot === channel.ui.getSnapshot());
  return {
    card,
    resume,
    channel,
    at: (ms: number): void => {
      now = ms;
    },
    /** The consent card of the leg the answer started: opened, and its frame acknowledged. */
    openConsent: (): Promise<unknown> => {
      channel.flow.begin();
      const answer = channel.flow.chord({
        message: 'Allow MCP server?',
        allow: 'Allow',
        deny: 'Refuse',
      });
      channel.ui.shown(channel.ui.getSnapshot());
      return answer;
    },
  };
}

describe('a key held through a gate card answer cannot answer the consent card the answer opens', () => {
  it('refuses the held Ctrl+Y on the consent card, and every refused repeat restarts the window', async () => {
    const r = rig(createChordHistory());
    r.at(0);
    r.card.shown(r.card.getSnapshot());
    expect(r.card.input('y', CTRL)).toMatchObject({ kind: 'answered', gateId: 'a' });

    r.at(100);
    const consent = r.openConsent();
    let settled: unknown = 'pending';
    void consent.then((value) => {
      settled = value;
    });

    r.at(700); // the first auto-repeat of the key that is still down
    r.channel.ui.input('y', CHANNEL_CTRL);
    await Promise.resolve();
    expect(settled, 'refused: the card stays open').toBe('pending');
    expect(r.channel.ui.getSnapshot().kind).toBe('chord');

    r.at(2_500); // 1.8 s after the refused repeat: still inside the window that repeat restarted
    r.channel.ui.input('y', CHANNEL_CTRL);
    await Promise.resolve();
    expect(settled).toBe('pending');

    r.at(4_400); // 1.9 s after the last refusal: still inside it
    r.channel.ui.input('y', CHANNEL_CTRL);
    await Promise.resolve();
    expect(settled).toBe('pending');

    r.at(6_401); // the key was let go for the whole window: a deliberate press answers
    r.channel.ui.input('y', CHANNEL_CTRL);
    expect(await consent).toBe('allow');
  });

  it('without the shared history the consent card is still locked from the moment it opened: the held key is refused, each repeat restarts it', async () => {
    // Before unit 6's round 1 this was the control that showed the hole the shared history closes (the held key answered the consent card).
    // The card's own opening now starts a lockout too, so the held key is refused even by a card that saw no answer before it; what the shared
    // history still carries is the other way round (below) and the typing evidence every card reads.
    const r = rig(undefined);
    r.at(0);
    r.card.shown(r.card.getSnapshot());
    expect(r.card.input('y', CTRL)).toMatchObject({ kind: 'answered' });
    r.at(100);
    const consent = r.openConsent();
    let settled: unknown = 'pending';
    void consent.then((value) => {
      settled = value;
    });
    r.at(700); // the first auto-repeat: 600 ms after the card opened
    r.channel.ui.input('y', CHANNEL_CTRL);
    await Promise.resolve();
    expect(settled, 'refused: the card stays open').toBe('pending');
    r.at(2_500); // 1.8 s after the refused repeat, which restarted the window
    r.channel.ui.input('y', CHANNEL_CTRL);
    await Promise.resolve();
    expect(settled).toBe('pending');
    r.at(2_500 + APPROVAL_LOCKOUT_MS); // let go for the whole window: a deliberate press answers
    r.channel.ui.input('y', CHANNEL_CTRL);
    expect(await consent).toBe('allow');
  });

  it('a rejection on the consent card is never delayed by the lockout: refusing is the safe answer', async () => {
    const r = rig(createChordHistory());
    r.at(0);
    r.card.shown(r.card.getSnapshot());
    r.card.input('y', CTRL);
    r.at(100);
    const consent = r.openConsent();
    r.at(200);
    r.channel.ui.input('n', CHANNEL_CTRL);
    expect(await consent).toBe('deny');
  });

  it('the lockout runs the other way too: a consent answer locks the gate card that follows', async () => {
    const history = createChordHistory();
    const r = rig(history);
    r.at(0);
    const consent = r.openConsent();
    // The consent card's own lockout runs from the moment it opened: a deliberate `Ctrl+Y` comes once it has passed.
    const answeredAt = APPROVAL_LOCKOUT_MS;
    r.at(answeredAt);
    r.channel.ui.input('y', CHANNEL_CTRL);
    expect(await consent).toBe('allow');
    await r.channel.flow.end();

    r.at(answeredAt + 500);
    r.card.shown(r.card.getSnapshot());
    expect(r.card.input('y', CTRL), 'a held key').toEqual({ kind: 'refused' });
    r.at(answeredAt + 500 + APPROVAL_LOCKOUT_MS + 1);
    expect(r.card.input('y', CTRL)).toMatchObject({ kind: 'answered' });
  });
});

/** An operating system's initial repeat delays and repeat gaps, and how long the key stays down after the card that follows the wait appeared. */
const DELAYS = [250, 660, 1000, 1800] as const;
const RATES = [30, 100, 450, 1000, 1800] as const;
const ACKS = [16, 900] as const;
const HELD_ON_THE_CARD_MS = 8000;
/** A legacy terminal's repeat (the same key again), a kitty repeat event, and a legacy repeat one in five of which lands unseen on the card. */
const HOLDS = ['legacy', 'kitty', 'legacy, some unseen'] as const;
/** How long the wait between the answer and the card it raises lasts. */
const WAITS = [300, 700, 1500, 2500, 5000] as const;
/** Each case below runs forty held keys through a real launch: room for a loaded machine. */
const MATRIX_TIMEOUT_MS = 60_000;

const STARTED_RUN: HostedLaunch = {
  kind: 'started',
  leg: 'start',
  runId: RUN,
  ended: new Promise(() => undefined),
};
const CHANNEL_CTRL_REPEAT: Key = { ...CHANNEL_CTRL, eventType: 'repeat' };
const CHANNEL_ENTER: Key = { ...CHANNEL_CTRL, ctrl: false, return: true };
const CHANNEL_NONE: Key = { ...CHANNEL_CTRL, ctrl: false };

const SUBJECT: ConsentSubject = {
  serverId: 'files',
  provenance: 'inline',
  artifact: 'workflows/build.yaml',
  resolvedCommand: '/usr/local/bin/npx',
  authoredCommand: 'npx',
  args: ['-y', '@example/files-server'],
  env: [],
  cwd: '/work/project',
  digest: 'v1:0123456789abcdef0123456789abcdef',
  total: 1,
  index: 1,
  previouslyApprovedIn: undefined,
};

/** One number: the `/run` confirmation follows its one field. */
const ONE_FIELD = `schema_version: '1.0'
workflow:
  id: one-field
  inputs:
    - { name: n, type: number, required: true }
  nodes:
    - { id: start, type: input }
    - { id: out, type: output }
  edges:
    - { from: start, to: out }
`;

function catalogOf(workflows: Readonly<Record<string, string>>): LaunchCatalog {
  return {
    list: () =>
      Object.entries(workflows).map(([path, yaml]) => {
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
      definition: parseWorkflow(workflows[path] ?? '', { source: path }),
      sourceDigest: 'd'.repeat(64),
      fsScope: { tier: 'sandboxed', fromRepository: false },
    }),
  };
}

const turns = async (count = 30): Promise<void> => {
  for (let turn = 0; turn < count; turn += 1)
    await new Promise<void>((resolve) => setImmediate(resolve));
};

/**
 * The Home's channel with the product's numbers on a clock the test moves, the host's routing played by hand: `show` is "this exact snapshot
 * was just measured and flushed", and a key on a frame that is not (a new card before its acknowledgement) goes to `unseenInput`, as the hosts
 * send it.
 */
function hostedChannel(history: ChordHistory) {
  let clock = 10_000;
  const channel = createNativePromptChannel({ now: () => clock, history });
  let visible: NativePromptSnapshot | undefined;
  channel.ui.bindVisibility((snapshot) => snapshot === visible);
  return {
    channel,
    now: (): number => clock,
    at: (ms: number): void => {
      clock = ms;
    },
    show: (): void => {
      visible = channel.ui.getSnapshot();
      channel.ui.shown(visible);
    },
    deliver: (input: string, key: Key): void => {
      if (visible === channel.ui.getSnapshot()) channel.ui.input(input, key);
      else channel.ui.unseenInput(input, key);
    },
  };
}
type HostedChannel = ReturnType<typeof hostedChannel>;

/**
 * What happens on the screen around a held key, in time order: the wait's frame is acknowledged 16 ms after `from`, the card is opened by
 * `open` at `opensAt` and acknowledged `ack` later. The returned function runs every event due by `at` (each on its own time) and says
 * whether the card is open.
 */
function screenEvents(
  h: HostedChannel,
  timing: { readonly from: number; readonly opensAt: number; readonly ack: number },
  open: () => Promise<void>,
): (at: number) => Promise<boolean> {
  const events: readonly { readonly at: number; readonly run: () => Promise<void> }[] = [
    { at: timing.from + 16, run: () => Promise.resolve(h.show()) },
    { at: timing.opensAt, run: open },
    { at: timing.opensAt + timing.ack, run: () => Promise.resolve(h.show()) },
  ];
  let next = 0;
  return async (at) => {
    for (let event = events[next]; event !== undefined && event.at <= at; event = events[next]) {
      h.at(event.at);
      await event.run();
      next += 1;
    }
    return next > 1;
  };
}

/**
 * Hold `Ctrl+Y` from `from` to `opensAt + HELD_ON_THE_CARD_MS` through {@link screenEvents}; in the `some unseen` hold one repeat in five on the
 * card is dropped as unseen. Returns the time of the last repeat, with every event of the screen run.
 */
async function holdThroughTheWait(
  h: HostedChannel,
  timing: { readonly from: number; readonly opensAt: number; readonly ack: number },
  key: { readonly delay: number; readonly rate: number; readonly hold: (typeof HOLDS)[number] },
  open: () => Promise<void>,
): Promise<number> {
  const due = screenEvents(h, timing, open);
  const repeat = key.hold === 'kitty' ? CHANNEL_CTRL_REPEAT : CHANNEL_CTRL;
  let last = timing.from;
  let index = 0;
  for (
    let at = timing.from + key.delay;
    at <= timing.opensAt + HELD_ON_THE_CARD_MS;
    at += key.rate, index += 1
  ) {
    const onTheCard = await due(at);
    h.at(at);
    last = at;
    if (key.hold === 'legacy, some unseen' && onTheCard && index % 5 === 1)
      h.channel.ui.unseenInput('y', CHANNEL_CTRL);
    else h.deliver('y', repeat);
  }
  await due(Number.POSITIVE_INFINITY);
  return last;
}

describe('a Ctrl+Y held through the wait an answer starts never answers the consent card that wait raises (unit 6 round 1, S1)', () => {
  /**
   * The REAL `/run` launch over the real channel: the field is answered, the confirmation answered by one deliberate `Ctrl+Y` past its guards,
   * and the key stays down. The start (`Starting the run…`) raises the MCP consent card on the same channel after `wait` ms, as the host's
   * consent prompter does when the leg connects a server. Before the card's own lockout, a wait longer than the confirmation's lockout let the
   * held key allow the server in up to 20 of 30 cases (the round's measurement: 690 of 4,200 configurations on this rig).
   */
  it.each(WAITS.flatMap((wait) => HOLDS.map((hold) => [wait, hold] as const)))(
    '/run: the start waits %i ms before the consent card, %s repeats: never allowed while held; one patient press after it is let go is',
    async (wait, hold) => {
      const allowedWhileHeld: string[] = [];
      for (const ack of ACKS)
        for (const delay of DELAYS)
          for (const rate of RATES) {
            const h = hostedChannel(createChordHistory());
            let raise = (): void => {};
            const raised = new Promise<void>((resolve) => {
              raise = resolve;
            });
            const decisions: string[] = [];
            const start = vi.fn(async (request: HostedStartRequest): Promise<HostedLaunch> => {
              await raised; // the leg connects its server: the consent card comes after the wait
              // As the host's consent prompter asks: on the leg's signal, so a stopped leg closes the card.
              const signal = request.signal === undefined ? {} : { signal: request.signal };
              decisions.push(await askConsent(h.channel.flow, SUBJECT, signal));
              return STARTED_RUN;
            });
            const launch = createRunLaunch({
              flow: h.channel.flow,
              host: { start },
              catalog: catalogOf({ 'one.yaml': ONE_FIELD }),
            });
            const opened = launch.open();
            await turns();
            expect(h.channel.ui.getSnapshot().kind).toBe('select');
            h.show();
            h.at(h.now() + POPUP_SELECT_SETTLE_MS + 1);
            h.channel.ui.input('', CHANNEL_ENTER);
            await turns();
            expect(h.channel.ui.getSnapshot().kind).toBe('text');
            h.show();
            h.channel.ui.input('3', CHANNEL_NONE);
            h.show();
            h.channel.ui.input('', CHANNEL_ENTER);
            await turns();
            expect(h.channel.ui.getSnapshot().kind).toBe('chord');
            h.show();
            h.at(h.now() + APPROVAL_LOCKOUT_MS + 1);
            const confirmedAt = h.now();
            h.channel.ui.input('y', CHANNEL_CTRL); // the deliberate press that starts the run; the key stays down after it
            await turns();
            expect(start).toHaveBeenCalledTimes(1);
            expect(h.channel.ui.getSnapshot().message).toBe('Starting the run…');
            const last = await holdThroughTheWait(
              h,
              { from: confirmedAt, opensAt: confirmedAt + wait, ack },
              { delay, rate, hold },
              async () => {
                raise();
                await turns();
                expect(h.channel.ui.getSnapshot().kind).toBe('chord');
              },
            );
            await turns();
            if (decisions.length > 0)
              allowedWhileHeld.push(`ack ${String(ack)}, ${String(delay)}/${String(rate)}`);
            h.at(last + APPROVAL_LOCKOUT_MS + 1);
            h.channel.ui.input('y', CHANNEL_CTRL);
            await turns();
            expect(decisions, `the patient press after ${String(delay)}/${String(rate)}`).toEqual([
              'allow',
            ]);
            expect(await opened).not.toBe('');
          }
      expect(allowedWhileHeld).toEqual([]);
    },
    MATRIX_TIMEOUT_MS,
  );

  /**
   * A gate card answered by a deliberate `Ctrl+Y`, the key held down: the resumed leg's flow opens (a wait) and its consent card comes `wait` ms
   * after the answer. Over the Home's one history, the answer's lockout covered only the first two seconds; the card's own covers the rest.
   */
  it.each(WAITS.flatMap((wait) => HOLDS.map((hold) => [wait, hold] as const)))(
    'a gate card’s answer: the resume waits %i ms before the consent card, %s repeats: never allowed while held; one patient press after it is let go is',
    async (wait, hold) => {
      const allowedWhileHeld: string[] = [];
      for (const ack of ACKS)
        for (const delay of DELAYS)
          for (const rate of RATES) {
            const history = createChordHistory();
            const h = hostedChannel(history);
            const card = createRunCard({
              runId: RUN,
              gates: [gate('a')],
              resume: vi.fn(() => Promise.resolve(STARTED)),
              now: h.now,
              history,
              painted: () => true,
            });
            card.shown(card.getSnapshot());
            h.at(h.now() + 5000);
            const answeredAt = h.now();
            expect(card.input('y', CTRL)).toMatchObject({ kind: 'answered' });
            h.channel.flow.begin(); // the resumed leg's flow: a wait while it connects its server
            let consent: Promise<string> | undefined;
            const last = await holdThroughTheWait(
              h,
              { from: answeredAt, opensAt: answeredAt + wait, ack },
              { delay, rate, hold },
              () => {
                consent = askConsent(h.channel.flow, SUBJECT);
                return Promise.resolve();
              },
            );
            if (consent === undefined) throw new Error('the consent card never opened');
            const asked = consent;
            let answer: unknown = 'pending';
            void asked.then((value) => {
              answer = value;
            });
            await turns(3);
            if (answer !== 'pending')
              allowedWhileHeld.push(`ack ${String(ack)}, ${String(delay)}/${String(rate)}`);
            h.at(last + APPROVAL_LOCKOUT_MS + 1);
            h.channel.ui.input('y', CHANNEL_CTRL);
            expect(await asked, `the patient press after ${String(delay)}/${String(rate)}`).toBe(
              'allow',
            );
            await h.channel.flow.end();
          }
      expect(allowedWhileHeld).toEqual([]);
    },
    MATRIX_TIMEOUT_MS,
  );
});
