/**
 * What each host reads off its own state for the one refusal of the open gate (`popup-refusal.ts`; ADR-0148 §2): every fact a host has
 * reaches the reason it stands for. The order of the reasons is the refusal's own table test; this pins the hosts' wiring of the facts, so a
 * fact dropped from a host's reading (a card, a sheet, a turn, the armed keymap, an overlay, a chat being built) fails here.
 */
import type { ToolApprovalRequest } from '@relavium/core';
import { describe, expect, it } from 'vitest';

import type { HomeSnapshot } from '../../home/home-store.js';
import type { PopupRefusal } from '../../popups/popup-host.js';
import { chatPopupRefusal } from './chat-ink.js';
import { createChatStore, type ChatStoreController } from './chat-store.js';
import { homePopupRefusal } from './home-app.js';
import {
  createHomeController,
  type HomeChatSession,
  type HomeControllerState,
} from './home-controller.js';
import type { NativePromptSnapshot } from './native-prompt-channel.js';
import { NO_OVERLAYS, type OverlayFlags } from './overlay-flags.js';
import { createRunCard } from './run-card-model.js';
import { INLINE_TRANSCRIPT_BOUND } from './session-view-model.js';

const IDLE_TURN = { running: false, shellBusy: false, submitBusy: false } as const;

describe('the stand-alone chat’s facts (chatPopupRefusal)', () => {
  const refusal = (
    overlays: Partial<OverlayFlags>,
    turn: Partial<typeof IDLE_TURN> = {},
    interruptArmed = false,
  ): PopupRefusal | undefined =>
    chatPopupRefusal({
      overlays: { ...NO_OVERLAYS, ...overlays },
      turn: { ...IDLE_TURN, ...turn },
      interruptArmed,
    });

  it('opens with nothing in front', () => {
    expect(refusal({})).toBeUndefined();
  });

  it.each(['approval', 'review', 'question', 'checkpoint'] as const)(
    'a %s card is a card',
    (card) => {
      expect(refusal({ [card]: true })).toBe('card-open');
    },
  );

  it('a native card is a sheet', () => {
    expect(refusal({ nativePrompt: true })).toBe('sheet-open');
  });

  it.each(['running', 'shellBusy', 'submitBusy'] as const)('%s is a turn', (fact) => {
    expect(refusal({}, { [fact]: true })).toBe('turn-running');
  });

  it('the armed interrupt keymap is armed', () => {
    expect(refusal({}, {}, true)).toBe('armed');
  });

  it.each(['palette', 'search', 'mention', 'modelPicker', 'chatSheet'] as const)(
    'an open %s is another overlay',
    (overlay) => {
      expect(refusal({ [overlay]: true })).toBe('overlay-open');
    },
  );
});

describe('the Home’s facts (homePopupRefusal)', () => {
  const EMPTY: HomeSnapshot = {
    attention: { gates: [], failedRuns: [] },
    recentSessions: [],
    recentRuns: [],
    recentAgents: [],
    unreadableRunIds: [],
    isEmpty: true,
  };
  const controller = () =>
    createHomeController({
      startChat: () => new Promise<never>(() => {}),
      homeStore: { read: () => EMPTY },
      schedule: () => () => {},
      onExit: () => {},
      onError: (cause) => {
        throw cause;
      },
    });
  const landing = (): HomeControllerState => controller().getSnapshot();
  const withChat = (store: ChatStoreController): HomeControllerState => {
    const session: HomeChatSession = {
      store,
      sessionId: 'live',
      processLine: () => Promise.resolve(),
      shouldStop: () => false,
      stopReason: () => 'exit',
      teardown: () => Promise.resolve(),
    };
    return { ...landing(), mode: 'chat', session };
  };
  const NATIVE_CARD: NativePromptSnapshot = {
    active: true,
    kind: 'select',
    message: 'Pick one',
    note: '',
    options: [{ value: 'a', label: 'A' }],
    selected: 0,
    display: '',
    error: '',
    escape: 'cancel',
    details: [],
  };
  const APPROVAL: ToolApprovalRequest = {
    toolId: 'write_file',
    action: 'fs_write',
    preview: { path: 'notes.md' },
  };

  it('opens on the bare, idle landing', () => {
    expect(homePopupRefusal(landing(), undefined)).toBeUndefined();
  });

  it('a chat being built is starting', () => {
    expect(homePopupRefusal({ ...landing(), mode: 'loading' }, undefined)).toBe('starting');
  });

  it('a card of the chat in front is a card', () => {
    const approval = createChatStore(false, undefined, INLINE_TRANSCRIPT_BOUND);
    void approval.requestApproval(APPROVAL, true).catch(() => undefined);
    expect(homePopupRefusal(withChat(approval), undefined)).toBe('card-open');
    const checkpoint = createChatStore(false, undefined, INLINE_TRANSCRIPT_BOUND);
    void checkpoint.requestCheckpoint({ rounds: 32, interval: 32 }).catch(() => undefined);
    expect(homePopupRefusal(withChat(checkpoint), undefined)).toBe('card-open');
    const question = createChatStore(false, undefined, INLINE_TRANSCRIPT_BOUND);
    void question
      .requestQuestion({
        questions: [
          {
            header: 'Pick',
            question: 'Which?',
            multiSelect: false,
            options: [
              { label: 'a', description: 'A' },
              { label: 'b', description: 'B' },
            ],
          },
        ],
      })
      .catch(() => undefined);
    expect(homePopupRefusal(withChat(question), undefined)).toBe('card-open');
  });

  it('a native card, the exit guard and a gate card are sheets', () => {
    expect(homePopupRefusal(landing(), NATIVE_CARD)).toBe('sheet-open');
    expect(homePopupRefusal({ ...landing(), exitGuard: 'confirm' }, undefined)).toBe('sheet-open');
    const card = createRunCard({
      runId: 'r1',
      gates: [],
      resume: () => Promise.reject(new Error('not answered here')),
    });
    const screen = {
      kind: 'gate-card',
      runId: 'r1',
      card,
      back: 'landing',
      from: 'landing',
    } as const;
    expect(homePopupRefusal({ ...landing(), screen }, undefined)).toBe('sheet-open');
    card.dispose();
  });

  it('a turn, a submit, a ! command and a native action are a turn', () => {
    const store = createChatStore(false, undefined, INLINE_TRANSCRIPT_BOUND);
    const snapshot = store.getSnapshot();
    const running: ChatStoreController = {
      ...store,
      getSnapshot: () => ({ ...snapshot, state: { ...snapshot.state, status: 'running' } }),
    };
    expect(homePopupRefusal(withChat(running), undefined)).toBe('turn-running');
    expect(homePopupRefusal({ ...landing(), submitBusy: true }, undefined)).toBe('turn-running');
    expect(homePopupRefusal({ ...landing(), shellBusy: true }, undefined)).toBe('turn-running');
    expect(homePopupRefusal({ ...landing(), nativeActionBusy: true }, undefined)).toBe(
      'turn-running',
    );
  });

  it('the armed interrupt keymap is armed', () => {
    expect(homePopupRefusal({ ...landing(), interruptArmed: true }, undefined)).toBe('armed');
  });

  it('an open palette is another overlay', () => {
    const c = controller();
    c.handleKey('/', {});
    expect(c.getSnapshot().palette).toBeDefined();
    expect(homePopupRefusal(c.getSnapshot(), undefined)).toBe('overlay-open');
  });
});
