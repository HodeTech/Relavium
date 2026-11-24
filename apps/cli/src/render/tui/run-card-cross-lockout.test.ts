/**
 * One lockout across the Home's cards
 * ([ADR-0139](../../../../../docs/decisions/0139-a-workflow-run-is-hosted-inside-the-home.md) §4).
 *
 * A key held down on a gate card answers it; the answer opens the next card (the MCP consent card of the resumed leg), and the held key's
 * auto-repeat arrives on it. The lockout that stops that is the approval guard's, and it is only as wide as the evidence it reads: a gate
 * card and the consent card that kept their own would each see a card that had never been answered. So both are built over the Home's
 * ONE chord history, and this file proves it with the two real surfaces (the gate card model and the native prompt channel's chord card)
 * on one injected clock, with the dwell, the quiet gap and the typeahead switched off so that the lockout is the only rule in play.
 */
import type { Key } from 'ink';
import { describe, expect, it, vi } from 'vitest';

import type { RunGate } from '../../home/run-gates.js';
import type { HostedLaunch } from '../../home/run-host.js';
import type { ChatKey } from './chat-input.js';
import { createChordHistory, type ChordHistory } from './chord-guard.js';
import { createNativePromptChannel } from './native-prompt-channel.js';
import { createRunCard } from './run-card-model.js';
import type { ApprovalGuard } from './tool-review-model.js';

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
  let now = 0;
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

  it('without the shared history each card is a card nobody has answered, and the held key answers the consent card', async () => {
    const r = rig(undefined);
    r.at(0);
    r.card.shown(r.card.getSnapshot());
    expect(r.card.input('y', CTRL)).toMatchObject({ kind: 'answered' });
    r.at(100);
    const consent = r.openConsent();
    r.at(700);
    r.channel.ui.input('y', CHANNEL_CTRL);
    expect(await consent, 'the control: this is the defect the shared history closes').toBe(
      'allow',
    );
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
    r.channel.ui.input('y', CHANNEL_CTRL);
    expect(await consent).toBe('allow');
    await r.channel.flow.end();

    r.at(500);
    r.card.shown(r.card.getSnapshot());
    expect(r.card.input('y', CTRL), 'a held key').toEqual({ kind: 'refused' });
    r.at(2_501);
    expect(r.card.input('y', CTRL)).toMatchObject({ kind: 'answered' });
  });
});
