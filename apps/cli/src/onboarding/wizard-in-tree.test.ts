import { Readable } from 'node:stream';
import { createClient, createProviderStore, runMigrations } from '@relavium/db';
import { describe, expect, it, vi } from 'vitest';
import { SessionWorkOwner } from '../chat/session-work-owner.js';
import { invocationFixture } from '../process/invocation.test-support.js';
import type { CliIo } from '../process/io.js';
import { createNativePromptChannel } from '../render/tui/native-prompt-channel.js';
import { runOnboardingWizard } from './wizard.js';

const io: CliIo = {
  env: {},
  stdoutIsTty: true,
  stdinIsTty: true,
  stdin: Readable.from([]),
  writeOut: () => {},
  writeErr: () => {},
  writeOutAcknowledged: async () => {},
  writeErrAcknowledged: async () => {},
};
const key = {
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
const next = async (): Promise<void> => {
  await new Promise<void>((resolve) => setImmediate(resolve));
};

describe('in-tree onboarding', () => {
  it('shows the actual destination and fixed failure copy without exposing any key part', async () => {
    const client = createClient(':memory:');
    runMigrations(client.db);
    try {
      const channel = createNativePromptChannel();
      const signal = channel.flow.begin();
      const set = vi.fn();
      const writeDefaultModel = vi.fn();
      const frames: string[] = [];
      channel.ui.subscribe(() => frames.push(JSON.stringify(channel.ui.getSnapshot())));
      const running = runOnboardingWizard({
        initialProvider: 'openai',
        native: {
          flow: channel.flow,
          signal,
          assertAdmitting: () => signal.throwIfAborted(),
          endpointContext: () => 'Custom destination: https://custom.example',
        },
        io,
        store: createProviderStore(client.db, { uuid: () => 'id', now: () => 1 }),
        keychain: { get: () => null, set, delete: () => false },
        resolver: { resolveProvider: () => undefined, keyFor: () => '' },
        validate: () =>
          Promise.resolve({
            ok: false,
            reason: 'auth',
            detail: 'reflected synthetic-secret-4829',
          }),
        writeDefaultModel,
      });
      expect(channel.ui.getSnapshot().note).toContain('https://custom.example');
      channel.ui.paste('synthetic-secret-4829');
      channel.ui.input('\r', { ...key, return: true });
      await next();
      expect(channel.ui.getSnapshot().message).toContain('authentication failed');
      expect(frames.join(' ')).not.toContain('synthetic-secret');
      expect(frames.join(' ')).not.toContain('4829');
      channel.flow.cancel();
      await running;
      await channel.flow.end();
      expect(set).not.toHaveBeenCalled();
      expect(writeDefaultModel).not.toHaveBeenCalled();
    } finally {
      client.sqlite.close();
    }
  });
  it('cancels busy validation without admitting late key or default writes while retaining the producer', async () => {
    const client = createClient(':memory:');
    runMigrations(client.db);
    const fixture = invocationFixture();
    const owner = new SessionWorkOwner(fixture.invocation, 'home', {
      cancel: () => {},
      cleanup: async () => {},
    });
    try {
      const channel = createNativePromptChannel();
      const signal = channel.flow.begin();
      const set = vi.fn();
      const writeDefaultModel = vi.fn();
      let resolve: () => void = () => {};
      const pending = new Promise<{ ok: true; reason: 'ok'; detail: string }>((done) => {
        resolve = () => done({ ok: true, reason: 'ok', detail: 'ok' });
      });
      const running = runOnboardingWizard({
        initialProvider: 'openai',
        native: {
          flow: channel.flow,
          signal,
          assertAdmitting: () => signal.throwIfAborted(),
          endpointContext: () => 'custom',
        },
        workOwner: owner,
        io,
        store: createProviderStore(client.db, { uuid: () => 'id', now: () => 1 }),
        keychain: { get: () => null, set, delete: () => false },
        resolver: { resolveProvider: () => undefined, keyFor: () => '' },
        validate: () => pending,
        writeDefaultModel,
      });
      channel.ui.paste('synthetic-key');
      channel.ui.input('\r', { ...key, return: true });
      await next();
      expect(channel.ui.getSnapshot().kind).toBe('busy');
      channel.flow.cancel();
      await running;
      await channel.flow.end();
      expect(set).not.toHaveBeenCalled();
      expect(writeDefaultModel).not.toHaveBeenCalled();
      let closed = false;
      const closing = owner.close().then(() => {
        closed = true;
      });
      await next();
      expect(closed).toBe(false);
      resolve();
      await closing;
      expect(owner.firstFailure).toBeUndefined();
      expect(set).not.toHaveBeenCalled();
      expect(writeDefaultModel).not.toHaveBeenCalled();
    } finally {
      client.sqlite.close();
    }
  });
  it.each([
    [{ kind: 'saved', durability: 'confirmed' }, 'Your default model is'],
    [{ kind: 'saved', durability: 'unconfirmed' }, 'crash durability could not be confirmed'],
    [{ kind: 'ephemeral' }, 'invocation only'],
    [{ kind: 'cancelled' }, 'default was not saved'],
  ] as const)('stores the key and reports the actual default result', async (result, expected) => {
    const client = createClient(':memory:');
    runMigrations(client.db);
    try {
      const channel = createNativePromptChannel();
      const signal = channel.flow.begin();
      const set = vi.fn();
      const writeDefaultModel = vi.fn(() => Promise.resolve(result));
      const frames: string[] = [];
      channel.ui.subscribe(() => frames.push(JSON.stringify(channel.ui.getSnapshot())));
      const running = runOnboardingWizard({
        initialProvider: 'openai',
        native: {
          flow: channel.flow,
          signal,
          assertAdmitting: () => signal.throwIfAborted(),
          endpointContext: () => 'official',
        },
        io,
        store: createProviderStore(client.db, { uuid: () => 'id', now: () => 1 }),
        keychain: { get: () => null, set, delete: () => false },
        resolver: { resolveProvider: () => undefined, keyFor: () => '' },
        validate: () =>
          Promise.resolve({ ok: true, reason: 'ok', detail: 'synthetic-secret-4829' }),
        writeDefaultModel,
      });
      channel.ui.paste('synthetic-secret-4829');
      channel.ui.input('\r', { ...key, return: true });
      await running;
      expect(set).toHaveBeenCalledWith(expect.any(String), 'synthetic-secret-4829');
      expect(writeDefaultModel).toHaveBeenCalledOnce();
      expect(channel.ui.getSnapshot().note).toContain(expected);
      expect(frames.join(' ')).not.toContain('synthetic-secret');
      expect(frames.join(' ')).not.toContain('4829');
      await channel.flow.end();
    } finally {
      client.sqlite.close();
    }
  });
  it('passes cancellation admission to delayed default publication', async () => {
    const client = createClient(':memory:');
    runMigrations(client.db);
    try {
      const channel = createNativePromptChannel();
      const signal = channel.flow.begin();
      let resume: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        resume = resolve;
      });
      const publish = vi.fn();
      const running = runOnboardingWizard({
        initialProvider: 'openai',
        native: {
          flow: channel.flow,
          signal,
          assertAdmitting: () => signal.throwIfAborted(),
          endpointContext: () => 'official',
        },
        io,
        store: createProviderStore(client.db, { uuid: () => 'id', now: () => 1 }),
        keychain: { get: () => null, set: () => {}, delete: () => false },
        resolver: { resolveProvider: () => undefined, keyFor: () => '' },
        validate: () => Promise.resolve({ ok: true, reason: 'ok', detail: 'ok' }),
        writeDefaultModel: async (_model, _provider, admit) => {
          await gate;
          admit?.();
          publish();
          return { kind: 'saved', durability: 'confirmed' };
        },
      });
      channel.ui.paste('a-secret');
      channel.ui.input('\r', { ...key, return: true });
      await next();
      channel.flow.cancel();
      resume();
      await running;
      expect(publish).not.toHaveBeenCalled();
      await channel.flow.end();
    } finally {
      client.sqlite.close();
    }
  });
});
