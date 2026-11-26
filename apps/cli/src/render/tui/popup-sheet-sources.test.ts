/**
 * Which sheets each host watches for (ADR-0148 §2: a sheet that arrives over a popup wins, the popup closes unanswered and nothing is
 * restored), over real sources: a real chat store's approval, question and checkpoint cards, a real native prompt channel's card, and on the
 * Home the exit guard and a gate card. Each is bound as the host binds it (`bindPopupHost`) on a real popup host, and each arriving while a
 * popup is open must close it; one that was already there must not.
 */
import type { ToolApprovalRequest } from '@relavium/core';
import { createElement, Fragment } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { bindPopupHost, type PopupSheetSources } from '../../popups/popup-bind.js';
import { createPopupHost, type PopupCloseReason } from '../../popups/popup-host.js';
import type { PopupSpec } from '../../popups/popup-reducer.js';
import { chatSheetSources } from './chat-ink.js';
import { createChatStore, type ChatStoreController } from './chat-store.js';
import { createChordHistory } from './chord-guard.js';
import { homeSheetSources } from './home-app.js';
import {
  createHomeController,
  type HomeChatSession,
  type HomeController,
  type HomeControllerState,
} from './home-controller.js';
import type { HomeSnapshot } from '../../home/home-store.js';
import { createNativePromptChannel } from './native-prompt-channel.js';
import { createRunCard } from './run-card-model.js';
import { INLINE_TRANSCRIPT_BOUND } from './session-view-model.js';
import { mountStandaloneChat } from './surface-matrix/chat-host.js';
import { mountHome } from './surface-matrix/home-host.js';
import type { Variant } from './surface-matrix/variants.js';

const SPEC: PopupSpec = {
  id: 'test',
  title: '/test',
  origin: 'chat',
  steps: [{ name: 'Pick', content: { kind: 'list', rows: [{ id: 'one', label: 'one' }] } }],
};
const APPROVAL: ToolApprovalRequest = {
  toolId: 'write_file',
  action: 'fs_write',
  preview: { path: 'notes.md' },
};
const QUESTION = {
  questions: [
    {
      header: 'Pick',
      question: 'Which file?',
      multiSelect: false,
      options: [
        { label: 'alpha.ts', description: 'The first file' },
        { label: 'beta.ts', description: 'The second file' },
      ],
    },
  ],
};
const EMPTY: HomeSnapshot = {
  attention: { failedRuns: [] },
  recentSessions: [],
  recentRuns: [],
  recentAgents: [],
  unreadableRuns: [],
  totals: { attention: 0, sessions: 0, runs: 0 },
  isEmpty: true,
};

/** A popup host bound to `sources` as a host binds it, with a popup open on it; what closed it, and how. */
function boundWithPopup<Kind extends string>(sources: PopupSheetSources<Kind>) {
  const host = createPopupHost({ placement: 'overlay', settleMs: 0 });
  const cleanup = bindPopupHost({
    popups: host,
    acknowledgement: { visible: () => true, dispose: () => undefined },
    gate: () => undefined,
    onRevoke: () => undefined,
    watchSheets: sources,
  });
  const closed: PopupCloseReason[] = [];
  expect(host.openForUser(SPEC, { closed: (reason) => closed.push(reason) }).opened).toBe(true);
  return { host, closed, cleanup };
}

/** Each way a sheet arrives on a chat's sources: a card of its store, or a card of its native prompt channel. */
const CHAT_ARRIVALS = {
  'an approval card': (store: ChatStoreController) => {
    void store.requestApproval(APPROVAL, true).catch(() => undefined);
  },
  'a question card': (store: ChatStoreController) => {
    void store.requestQuestion(QUESTION).catch(() => undefined);
  },
  'a checkpoint card': (store: ChatStoreController) => {
    void store.requestCheckpoint({ rounds: 32, interval: 32 }).catch(() => undefined);
  },
} as const;

function openNativeCard(channel: ReturnType<typeof createNativePromptChannel>): void {
  channel.flow.begin();
  void channel.flow
    .select({ message: 'Pick one', options: [{ value: 'a', label: 'A' }] })
    .catch(() => undefined);
}

describe('the stand-alone chat’s sheets (chatSheetSources)', () => {
  const chat = () => {
    const history = createChordHistory();
    const store = createChatStore(false, undefined, INLINE_TRANSCRIPT_BOUND, { history });
    const channel = createNativePromptChannel({ history });
    return { store, channel, sources: chatSheetSources(store, channel.ui) };
  };

  it.each(Object.keys(CHAT_ARRIVALS) as (keyof typeof CHAT_ARRIVALS)[])(
    '%s arriving while a popup is open closes it unanswered',
    (name) => {
      const c = chat();
      const b = boundWithPopup(c.sources);
      CHAT_ARRIVALS[name](c.store);
      expect(b.host.getSnapshot().open).toBe(false);
      expect(b.closed).toEqual(['sheet']);
      b.cleanup();
    },
  );

  it('a native card arriving while a popup is open closes it unanswered', () => {
    const c = chat();
    const b = boundWithPopup(c.sources);
    openNativeCard(c.channel);
    expect(c.channel.ui.getSnapshot().active).toBe(true);
    expect(b.host.getSnapshot().open).toBe(false);
    expect(b.closed).toEqual(['sheet']);
    b.cleanup();
  });

  it('a card already open when the popup opened (a race) does not close it', () => {
    const c = chat();
    CHAT_ARRIVALS['a question card'](c.store);
    const b = boundWithPopup(c.sources);
    c.store.notice('something else changes');
    expect(b.host.getSnapshot().open).toBe(true);
    b.cleanup();
  });

  it('with no native channel only the store is watched', () => {
    const store = createChatStore(false, undefined, INLINE_TRANSCRIPT_BOUND);
    const b = boundWithPopup(chatSheetSources(store, undefined));
    CHAT_ARRIVALS['an approval card'](store);
    expect(b.host.getSnapshot().open).toBe(false);
  });

  it('after the cleanup a card arriving closes nothing (the host unmounted)', () => {
    const c = chat();
    const b = boundWithPopup(c.sources);
    b.cleanup();
    b.host.bindOpenGate(() => undefined);
    CHAT_ARRIVALS['a checkpoint card'](c.store);
    openNativeCard(c.channel);
    expect(b.host.getSnapshot().open).toBe(true);
  });
});

describe('the Home’s sheets (homeSheetSources)', () => {
  /** The Home as its host reads it: a real controller's state, a field of which a test sets, told to every listener. */
  const home = () => {
    const real = createHomeController({
      startChat: () => new Promise<never>(() => {}),
      homeStore: { read: () => EMPTY },
      schedule: () => () => {},
      onExit: () => {},
      onError: (cause) => {
        throw cause;
      },
    });
    let state: HomeControllerState = real.getSnapshot();
    const listeners = new Set<() => void>();
    const controller: Pick<HomeController, 'getSnapshot' | 'subscribe'> = {
      getSnapshot: () => state,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    };
    const history = createChordHistory();
    const channel = createNativePromptChannel({ history });
    const store = createChatStore(false, undefined, INLINE_TRANSCRIPT_BOUND, { history });
    const session: HomeChatSession = {
      store,
      sessionId: 'live',
      processLine: () => Promise.resolve(),
      shouldStop: () => false,
      stopReason: () => 'exit',
      teardown: () => Promise.resolve(),
    };
    return {
      channel,
      store,
      sources: homeSheetSources(controller, channel.ui),
      patch: (next: Partial<HomeControllerState>): void => {
        state = { ...state, ...next };
        for (const listener of [...listeners]) listener();
      },
      chatInFront: (): void => {
        state = { ...state, mode: 'chat', session };
        for (const listener of [...listeners]) listener();
      },
    };
  };

  it('the exit guard arriving while a popup is open closes it unanswered', () => {
    const h = home();
    const b = boundWithPopup(h.sources);
    h.patch({ exitGuard: 'confirm' });
    expect(b.host.getSnapshot().open).toBe(false);
    expect(b.closed).toEqual(['sheet']);
  });

  it('a gate card arriving while a popup is open closes it unanswered', () => {
    const h = home();
    const b = boundWithPopup(h.sources);
    const card = createRunCard({
      runId: 'r1',
      gates: [],
      resume: () => Promise.reject(new Error('not answered here')),
    });
    h.patch({ screen: { kind: 'gate-card', runId: 'r1', card, back: 'landing', from: 'landing' } });
    expect(b.host.getSnapshot().open).toBe(false);
    expect(b.closed).toEqual(['sheet']);
    card.dispose();
  });

  it('a native card arriving while a popup is open closes it unanswered', () => {
    const h = home();
    const b = boundWithPopup(h.sources);
    openNativeCard(h.channel);
    expect(b.host.getSnapshot().open).toBe(false);
    expect(b.closed).toEqual(['sheet']);
  });

  it.each(Object.keys(CHAT_ARRIVALS) as (keyof typeof CHAT_ARRIVALS)[])(
    '%s of the chat in front arriving while a popup is open closes it unanswered (the store is followed into a new session)',
    (name) => {
      const h = home();
      const b = boundWithPopup(h.sources);
      h.chatInFront(); // a chat comes to the front: no sheet yet, the popup stays
      expect(b.host.getSnapshot().open).toBe(true);
      CHAT_ARRIVALS[name](h.store);
      expect(b.host.getSnapshot().open).toBe(false);
      expect(b.closed).toEqual(['sheet']);
    },
  );

  it('a sheet already there when the popup opened (the exit guard) does not close it', () => {
    const h = home();
    h.patch({ exitGuard: 'confirm' });
    const b = boundWithPopup(h.sources);
    h.patch({ notice: 'something else changes' });
    expect(b.host.getSnapshot().open).toBe(true);
  });

  it('after the cleanup nothing that arrives closes the popup', () => {
    const h = home();
    const b = boundWithPopup(h.sources);
    b.cleanup();
    h.patch({ exitGuard: 'confirm' });
    openNativeCard(h.channel);
    expect(b.host.getSnapshot().open).toBe(true);
  });

  it('a change that is no sheet (a notice, a palette) closes nothing', () => {
    const h = home();
    const b = boundWithPopup(h.sources);
    const sheetArrived = vi.spyOn(b.host, 'sheetArrived');
    h.patch({ notice: 'a notice' });
    h.patch({ exitGuard: undefined });
    expect(sheetArrived).not.toHaveBeenCalled();
    expect(b.host.getSnapshot().open).toBe(true);
  });
});

describe('each host binds its popup host while it is mounted, and unbinds it when its root unmounts', () => {
  const VARIANT: Variant = { renderer: 'alt', color: false, size: { cols: 80, rows: 24 } };
  it.each(['the stand-alone chat', 'the Home'] as const)('%s', async (which) => {
    const m = which === 'the Home' ? mountHome(VARIANT) : mountStandaloneChat(VARIANT);
    try {
      await m.settle();
      expect(m.popups.openForUser(SPEC).opened, 'bound: its gate lets it open').toBe(true);
      m.popups.closeAll('command');
      // The root goes (the popup host itself lives on): the binding's cleanup has run.
      m.rerender(createElement(Fragment));
      await m.settle();
      expect(m.popups.openForUser(SPEC)).toEqual({ opened: false, reason: 'closed' });
    } finally {
      m.unmount();
    }
  });
});
