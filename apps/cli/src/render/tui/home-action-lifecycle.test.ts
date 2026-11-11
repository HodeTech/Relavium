import { describe, expect, it, vi } from 'vitest';

import {
  createHomeController,
  type HomeController,
  type HomeControllerDeps,
  type HomeModelsPort,
} from './home-controller.js';

const snapshot = {
  attention: { gates: [], failedRuns: [] },
  recentSessions: [],
  recentRuns: [],
  recentAgents: [],
  unreadableRunIds: [],
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
  const deps: HomeControllerDeps = {
    homeStore: { read: () => snapshot },
    doctorProbes: { keychain: () => {}, config: () => {}, toolHost: {} },
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
  return { controller: createHomeController(deps), failure, entered, onError };
}

async function openModels(controller: HomeController): Promise<void> {
  controller.handleKey('/', {});
  for (const character of 'models') controller.handleKey(character, {});
  controller.handleKey('', { return: true });
  await flush();
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
        await openModels(f.controller);
        f.entered.length = 0;
        f.controller.handleKey('', { return: true });
        expect(f.controller.getSnapshot().submitBusy).toBe(outcome === 'reject');
        await flush();
        expect(f.controller.getSnapshot().submitBusy).toBe(false);
        expect(f.controller.getSnapshot().modelPicker?.hint).toBe(
          'could not save the default model — check your config file.',
        );
        expect(f.failure).toHaveBeenCalledTimes(owner && outcome === 'reject' ? 1 : 0);
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

    it(`admits a pending default write before same-dispatch teardown (owner=${String(owner)})`, async () => {
      const pending = deferred();
      const write = vi.fn(() => pending.promise);
      const f = fixture({ owner, write });
      await openModels(f.controller);
      f.entered.length = 0;
      f.controller.handleKey('', { return: true });
      expect(write).toHaveBeenCalledOnce();
      expect(f.entered).toHaveLength(owner ? 1 : 0);
      await f.controller.teardownActive();
      const sealed = f.controller.getSnapshot();
      pending.resolve();
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

  it('observes an already-started write when owner admission refuses synchronously', async () => {
    const pending = deferred();
    const cause = new Error('PRIVATE_ADMISSION_FAILURE');
    const f = fixture({ owner: true, write: () => pending.promise, admissionError: cause });
    await openModels(f.controller);
    f.failure.mockClear();
    f.controller.handleKey('', { return: true });
    expect(f.controller.getSnapshot().submitBusy).toBe(false);
    expect(f.controller.getSnapshot().modelPicker?.hint).toContain('could not save');
    expect(f.failure).toHaveBeenCalledExactlyOnceWith(cause);
    pending.reject(new Error('PRIVATE_LATE_WRITE_FAILURE'));
    await flush();
    expect(f.onError).not.toHaveBeenCalled();
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
      if (action === 'default') await openModels(f.controller);
      f.controller.handleKey('', { return: true });
      const unsubscribe = f.controller.subscribe(() => {
        throw cause;
      });
      if (outcome === 'resolve') pending.resolve();
      else pending.reject(new Error('PRIVATE_OPERATION_FAILURE'));
      await flush();
      expect(f.onError).toHaveBeenCalledExactlyOnceWith(cause);
      unsubscribe();
      await f.controller.teardownActive();
    },
  );
});
