import type { UserCommandOutcome } from '@relavium/core';
import type { ModelCatalogEntry } from '@relavium/llm';
import { describe, expect, it, vi } from 'vitest';

import type { RefreshReport } from '../../engine/model-refresh.js';
import type { HomeSnapshot } from '../../home/home-store.js';
import { createChatStore } from './chat-store.js';
import {
  createHomeController,
  type HomeChatSession,
  type HomeModelsPort,
} from './home-controller.js';
import type { MentionReader } from './mention.js';
import { INLINE_TRANSCRIPT_BOUND } from './session-view-model.js';

const EMPTY_HOME: HomeSnapshot = {
  attention: { gates: [], failedRuns: [] },
  recentSessions: [],
  recentRuns: [],
  recentAgents: [],
  unreadableRunIds: [],
  isEmpty: true,
};
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  let reject: (cause: unknown) => void = () => undefined;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function fixture(
  options: {
    mentionReader?: MentionReader;
    runShellCommand?: HomeChatSession['runShellCommand'];
    processLine?: HomeChatSession['processLine'];
    shouldStop?: HomeChatSession['shouldStop'];
    models?: HomeModelsPort;
  } = {},
) {
  const store = createChatStore(false, undefined, INLINE_TRANSCRIPT_BOUND);
  const session: HomeChatSession = {
    sessionId: 'completion-owner',
    store,
    processLine: options.processLine ?? (() => Promise.resolve()),
    shouldStop: options.shouldStop ?? (() => false),
    stopReason: () => 'clear',
    teardown: vi.fn(() => Promise.resolve()),
    ...(options.mentionReader === undefined ? {} : { mentionReader: options.mentionReader }),
    ...(options.runShellCommand === undefined ? {} : { runShellCommand: options.runShellCommand }),
  };
  const fresh: HomeChatSession = {
    ...session,
    sessionId: 'fresh-completion-owner',
    store: createChatStore(false, undefined, INLINE_TRANSCRIPT_BOUND),
    shouldStop: () => false,
    processLine: () => Promise.resolve(),
    teardown: vi.fn(() => Promise.resolve()),
  };
  let builds = 0;
  const startChat = vi.fn(() => Promise.resolve(builds++ === 0 ? session : fresh));
  const onError = vi.fn();
  const controller = createHomeController({
    startChat,
    homeStore: { read: () => EMPTY_HOME },
    onExit: vi.fn(),
    onError,
    doctorProbes: { keychain: () => undefined, config: () => undefined, toolHost: {} },
    ...(options.models === undefined ? {} : { models: options.models }),
  });
  const start = async (): Promise<void> => {
    controller.handlePaste('hello');
    controller.handleKey('', { return: true });
    await vi.waitFor(() => {
      expect(controller.getSnapshot().session).toBe(session);
      expect(controller.getSnapshot().submitBusy).toBe(false);
    });
  };
  return { controller, store, session, fresh, startChat, onError, start };
}

describe('Home deferred results respect permanent controller stop', () => {
  it.each([
    { refused: false, stopped: false },
    { refused: false, stopped: true },
    { refused: true, stopped: false },
    { refused: true, stopped: true },
  ])('file read refused=$refused stopped=$stopped', async ({ refused, stopped }) => {
    const raw = deferred<{ content: string; sizeBytes: number }>();
    const read = vi.fn(() => raw.promise);
    const f = fixture({
      mentionReader: {
        list: () => Promise.resolve([{ name: 'late-read.ts', path: 'late-read.ts', type: 'file' }]),
        read,
      },
    });
    try {
      await f.start();
      f.controller.handleKey('@', {});
      await vi.waitFor(() => expect(f.controller.getSnapshot().mention?.loading).toBe(false));
      f.controller.handleKey('', { return: true });
      expect(read).toHaveBeenCalledOnce();
      if (stopped) await f.controller.teardownActive();
      if (refused) raw.reject(new Error('PRIVATE_FILE_READ_FAILURE'));
      else raw.resolve({ content: 'late read text', sizeBytes: 14 });
      await tick();
      if (stopped) {
        expect(f.controller.getSnapshot().attachments, 'HOME_STOPPED_FILE_ATTACHMENT').toEqual([]);
        expect(f.controller.getSnapshot().input.text).toBe('');
        expect(f.store.getSnapshot().state.warnings, 'HOME_STOPPED_FILE_WARNING').toEqual([]);
        f.controller.handlePaste('new work');
        f.controller.handleKey('', { return: true });
        expect(f.controller.getSnapshot().input.text, 'HOME_STOPPED_INPUT').toBe('');
        expect(f.startChat).toHaveBeenCalledOnce();
      } else if (refused) {
        expect(f.store.getSnapshot().state.warnings).toContain(
          '@ mention could not read that file (refused, binary, or too large)',
        );
      } else {
        expect(f.controller.getSnapshot().attachments).toEqual([
          { kind: 'file', path: 'late-read.ts', content: 'late read text', sizeBytes: 14 },
        ]);
        expect(f.controller.getSnapshot().input.text).toContain('late-read.ts');
      }
      expect(JSON.stringify(f.store.getSnapshot())).not.toContain('PRIVATE_');
      expect(f.onError).not.toHaveBeenCalled();
    } finally {
      raw.resolve({ content: '', sizeBytes: 0 });
      await f.controller.teardownActive();
    }
  });

  it.each([false, true])(
    'shell success after stopped=%s keeps cleanup separate from publication',
    async (stopped) => {
      const raw = deferred<UserCommandOutcome>();
      const runner = vi.fn(() => raw.promise);
      const f = fixture({ runShellCommand: runner });
      try {
        await f.start();
        f.controller.handlePaste('!synthetic');
        f.controller.handleKey('', { return: true });
        expect(runner).toHaveBeenCalledOnce();
        expect(f.controller.getSnapshot().shellBusy).toBe(true);
        if (stopped) await f.controller.teardownActive();
        raw.resolve({ kind: 'ran', exitCode: 0, stdout: 'late command text', stderr: '' });
        await tick();
        expect(f.controller.getSnapshot().shellBusy).toBe(false);
        if (stopped) {
          expect(f.controller.getSnapshot().attachments, 'HOME_STOPPED_SHELL_ATTACHMENT').toEqual(
            [],
          );
          expect(f.store.getSnapshot().state.transcript, 'HOME_STOPPED_SHELL_PREVIEW').toEqual([]);
        } else {
          expect(f.controller.getSnapshot().attachments).toHaveLength(1);
          expect(
            f.store
              .getSnapshot()
              .state.transcript.some((entry) => entry.text.includes('late command text')),
          ).toBe(true);
        }
        expect(f.onError).not.toHaveBeenCalled();
      } finally {
        raw.resolve({ kind: 'cancelled' });
        await f.controller.teardownActive();
      }
    },
  );

  it.each([false, true])(
    'model refresh after stopped=%s cannot start a new catalog read',
    async (stopped) => {
      const raw = deferred<RefreshReport | undefined>();
      const entry = (modelId: string): ModelCatalogEntry => ({
        modelId,
        provider: 'anthropic',
        displayName: modelId,
        pricingSource: 'catalog',
        priceKnown: true,
        available: true,
        deprecated: false,
      });
      let refreshed = false;
      const load = vi.fn(() => ({
        entries: [entry(refreshed ? 'new-result' : 'initial-cache')],
        refreshedAt: refreshed ? 2 : 1,
      }));
      const f = fixture({
        models: {
          load,
          refreshIfStale: () => raw.promise,
          refresh: () => Promise.resolve({ providers: [] }),
          currentDefault: () => undefined,
          currentEffort: () => undefined,
          writeDefault: vi.fn(),
        },
      });
      try {
        f.controller.handleKey('/', {});
        for (const ch of 'models') f.controller.handleKey(ch, {});
        f.controller.handleKey('', { return: true });
        expect(load).toHaveBeenCalledOnce();
        expect(f.controller.getSnapshot().modelPicker?.loading).toBe(true);
        if (stopped) await f.controller.teardownActive();
        refreshed = true;
        raw.resolve({ providers: [] });
        await tick();
        expect(load, 'HOME_STOPPED_CATALOG_READ').toHaveBeenCalledTimes(stopped ? 1 : 2);
        expect(
          f.controller.getSnapshot().modelPicker?.entries.map((value) => value.modelId),
        ).toEqual([stopped ? 'initial-cache' : 'new-result']);
        expect(f.onError).not.toHaveBeenCalled();
      } finally {
        raw.resolve(undefined);
        await f.controller.teardownActive();
      }
    },
  );

  it.each([false, true])(
    'a clear turn settling after stopped=%s cannot rebuild a session',
    async (stopped) => {
      const raw = deferred<void>();
      let clearing = false;
      const f = fixture({
        processLine: () => (clearing ? raw.promise : Promise.resolve()),
        shouldStop: () => clearing,
      });
      try {
        await f.start();
        clearing = true;
        f.controller.handlePaste('/clear');
        f.controller.handleKey('', { return: true });
        expect(f.controller.getSnapshot().submitBusy).toBe(true);
        if (stopped) await f.controller.teardownActive();
        raw.resolve(undefined);
        await tick();
        expect(f.startChat, 'HOME_STOPPED_CLEAR_REBUILD').toHaveBeenCalledTimes(stopped ? 1 : 2);
        if (!stopped) expect(f.controller.getSnapshot().session).toBe(f.fresh);
        expect(f.controller.getSnapshot().submitBusy).toBe(false);
        expect(f.onError).not.toHaveBeenCalled();
      } finally {
        raw.resolve(undefined);
        await f.controller.teardownActive();
      }
    },
  );
});
