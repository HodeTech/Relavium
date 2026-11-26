import { describe, expect, it, vi } from 'vitest';

import type { DefaultModelSaveResult, SettingsPort } from '../../popups/settings-port.js';
import {
  createHomeController,
  type HomeController,
  type HomeControllerDeps,
  type HomeModelsPort,
} from './home-controller.js';

const snapshot = {
  attention: { failedRuns: [] },
  recentSessions: [],
  recentRuns: [],
  recentAgents: [],
  unreadableRuns: [],
  totals: { attention: 0, sessions: 0, runs: 0 },
  isEmpty: true,
};
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function deferred() {
  let resolve: () => void = () => {};
  let reject: (cause: Error) => void = () => {};
  const promise = new Promise<void>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function fixture(options: {
  owner: boolean;
  open?: () => Promise<void>;
  write?: HomeModelsPort['writeDefault'];
  admissionError?: Error;
}) {
  const failure = vi.fn();
  const entered: string[] = [];
  const enter = <T>(operation: () => Promise<T>): Promise<T> => {
    entered.push('enter');
    if (options.admissionError !== undefined) throw options.admissionError;
    return operation();
  };
  const onError = vi.fn();
  const models: HomeModelsPort = {
    load: () => ({
      entries: [
        {
          modelId: 'model',
          displayName: 'Model',
          provider: 'openai',
          pricingSource: 'catalog',
          priceKnown: true,
          available: true,
          deprecated: false,
        },
      ],
      refreshedAt: undefined,
    }),
    refresh: () => Promise.resolve({ providers: [] }),
    refreshIfStale: () => Promise.resolve(undefined),
    currentDefault: () => 'model',
    currentEffort: () => undefined,
    writeDefault: options.write ?? (() => undefined),
  };
  // The bare Home's `/models` popup is opened over the Home's own port: what it applies through is that port's writer (the popup's own
  // hand-off is `popups/models-session.test.ts`'s).
  const opened: SettingsPort[] = [];
  const deps: HomeControllerDeps = {
    openSettings: ({ chat }) => {
      opened.push(chat);
    },
    announce: () => {},
    homeStore: { read: () => snapshot },
    startChat: () => Promise.reject(new Error('unexpected chat')),
    onExit: () => {},
    onError,
    providerSetup: {
      initialKeyless: options.write === undefined,
      open: options.open ?? (() => Promise.resolve()),
    },
    models,
    ...(options.owner ? { workOwner: { enter, failure } } : {}),
  };
  return { controller: createHomeController(deps), failure, entered, onError, opened };
}

/**
 * `/models` from the palette, then the popup's `Enter` on the one model, as its hand-off reaches the Home's writer: the port the Home opened the
 * popup over, and the write started through it. The popup enters the hand-off on that port's owner (`startPopupWork`), which is the Home's.
 */
async function saveDefault(f: ReturnType<typeof fixture>): Promise<{
  readonly port: SettingsPort;
  readonly result: Promise<DefaultModelSaveResult | undefined>;
}> {
  const controller: HomeController = f.controller;
  controller.handleKey('/', {});
  for (const character of 'models') controller.handleKey(character, {});
  controller.handleKey('', { return: true });
  await flush();
  const port = f.opened.at(-1);
  if (port === undefined) throw new Error('the popup was not opened');
  return {
    port,
    result: Promise.resolve(port.models?.saveDefault?.({ modelId: 'model', provider: 'openai' })),
  };
}

describe('Home native action and default-write lifetime', () => {
  for (const owner of [false, true]) {
    it.each(['throw', 'reject'] as const)(
      `recovers a native action %s with phase-specific copy (owner=${String(owner)})`,
      async (outcome) => {
        const cause = new Error('PRIVATE_ACTION_FAILURE');
        const f = fixture({
          owner,
          open: () => {
            if (outcome === 'throw') throw cause;
            return Promise.reject(cause);
          },
        });
        f.controller.handleKey('', { return: true });
        expect(f.controller.getSnapshot().nativeActionBusy).toBe(outcome === 'reject');
        await flush();
        expect(f.controller.getSnapshot().nativeActionBusy).toBe(false);
        expect(f.controller.getSnapshot().notice).toBe(
          `Provider setup could not be ${outcome === 'throw' ? 'opened' : 'completed'}.`,
        );
        expect(f.failure).toHaveBeenCalledTimes(owner ? 1 : 0);
        if (owner) expect(f.failure).toHaveBeenCalledWith(cause);
        expect(f.onError).not.toHaveBeenCalled();
        await f.controller.teardownActive();
      },
    );

    it.each(['throw', 'reject'] as const)(
      `recovers a model-default %s without granting a default (owner=${String(owner)})`,
      async (outcome) => {
        const cause = new Error('PRIVATE_WRITE_FAILURE');
        const f = fixture({
          owner,
          write: () => {
            if (outcome === 'throw') throw cause;
            return Promise.reject(cause);
          },
        });
        // (That input is gated while a write runs is `home-models.test.ts`' case, over a writer the test holds open.)
        const { result } = await saveDefault(f);
        await expect(result).resolves.toEqual({ kind: 'refused', reason: 'failed' });
        expect(f.controller.getSnapshot().submitBusy).toBe(false);
        // Said by the popup on the host's channel, never as the Home's notice.
        expect(f.controller.getSnapshot().notice).toBeUndefined();
        // The writer's fault is the owner's first, however it came (a throw or a rejection).
        expect(f.failure).toHaveBeenCalledTimes(owner ? 1 : 0);
        if (owner) expect(f.failure).toHaveBeenCalledWith(cause);
        expect(f.onError).not.toHaveBeenCalled();
        await f.controller.teardownActive();
      },
    );

    it(`admits native work in the dispatch and joins it during immediate teardown (owner=${String(owner)})`, async () => {
      const pending = deferred();
      const open = vi.fn(() => pending.promise);
      const f = fixture({ owner, open });
      f.controller.handleKey('', { return: true });
      expect(open).toHaveBeenCalledOnce();
      expect(f.entered).toHaveLength(owner ? 1 : 0);
      let joined = false;
      const stop = f.controller.teardownActive().then(() => {
        joined = true;
      });
      const sealed = f.controller.getSnapshot();
      await flush();
      expect(joined).toBe(false);
      pending.resolve();
      await stop;
      expect(joined).toBe(true);
      expect(f.controller.getSnapshot()).toBe(sealed);
    });

    it(`hands the popup the Home's work owner, and a write that settles after teardown changes nothing (owner=${String(owner)})`, async () => {
      const pending = deferred();
      const write = vi.fn(() => pending.promise);
      const f = fixture({ owner, write });
      const { port, result } = await saveDefault(f);
      // The popup's hand-off enters the write on this owner, so the Home's teardown joins it (`startPopupWork`).
      expect(port.workOwner === undefined).toBe(!owner);
      expect(write).toHaveBeenCalledOnce();
      await f.controller.teardownActive();
      const sealed = f.controller.getSnapshot();
      pending.resolve();
      await result;
      await flush();
      expect(f.controller.getSnapshot()).toBe(sealed);
      expect(f.onError).not.toHaveBeenCalled();
    });
  }

  it('refuses native admission synchronously without starting the operation', async () => {
    const cause = new Error('PRIVATE_ADMISSION_FAILURE');
    const open = vi.fn(() => Promise.resolve());
    const f = fixture({ owner: true, open, admissionError: cause });
    f.controller.handleKey('', { return: true });
    expect(open).not.toHaveBeenCalled();
    expect(f.controller.getSnapshot().nativeActionBusy).toBe(false);
    expect(f.controller.getSnapshot().notice).toBe('Provider setup could not be opened.');
    expect(f.failure).toHaveBeenCalledExactlyOnceWith(cause);
    await f.controller.teardownActive();
  });

  it.each([
    { action: 'native', outcome: 'resolve' },
    { action: 'native', outcome: 'reject' },
    { action: 'default', outcome: 'resolve' },
    { action: 'default', outcome: 'reject' },
  ])(
    'routes an unexpected $action $outcome presentation failure to Home fatal handling',
    async ({ action, outcome }) => {
      const pending = deferred();
      const cause = new Error('PRIVATE_PRESENTATION_FAILURE');
      const f = fixture({
        owner: false,
        ...(action === 'native'
          ? { open: () => pending.promise }
          : { write: () => pending.promise }),
      });
      const started =
        action === 'default'
          ? (await saveDefault(f)).result
          : f.controller.handleKey('', { return: true });
      const unsubscribe = f.controller.subscribe(() => {
        throw cause;
      });
      if (outcome === 'resolve') pending.resolve();
      else pending.reject(new Error('PRIVATE_OPERATION_FAILURE'));
      await flush();
      await started;
      expect(f.onError).toHaveBeenCalledExactlyOnceWith(cause);
      unsubscribe();
      await f.controller.teardownActive();
    },
  );
});
