import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient, createSessionStore, runMigrations } from '@relavium/db';
import { afterEach, expect, it, vi } from 'vitest';

import { scriptedResolver, textTurn } from '../chat/test-support.js';
import { openDoctor } from '../popups/doctor-port.js';
import { openReport } from '../popups/report-port.js';
import { invocationFixture } from '../process/invocation.test-support.js';
import type { InvocationWorkOwner } from '../process/invocation-work-owner.js';
import type { RootAppProps } from '../render/tui/home-app.js';
import { captureIo } from '../test-support.js';
import { driveHome } from './drive-home.js';
import { SessionHomeLifetime } from './session-home-lifetime.js';

vi.mock('../secrets/os-keychain.js', () => ({
  createOsKeychainStore: () => ({ get: () => null, set: () => undefined, delete: () => false }),
}));
// The loaders the Home's one open adapter calls, as they are, unless a test makes one reject (a chunk that could not be loaded).
vi.mock('../popups/doctor-port.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../popups/doctor-port.js')>();
  return { ...actual, openDoctor: vi.fn(actual.openDoctor) };
});
vi.mock('../popups/report-port.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../popups/report-port.js')>();
  return { ...actual, openReport: vi.fn(actual.openReport) };
});

/**
 * A popup's code is loaded the first time it is asked for (ADR-0148 §8, §10), and a load that fails is a fault of the Home's own: it reaches
 * the ORIGINAL Home's work owner (and so its exit code), never a handler that swallows it. Driven through the real `driveHome`: the bare
 * Home's `/doctor` and a report (`/help`) over the chat the Home hosts, each with its loader rejecting.
 */
const ENTER = { return: true } as const;
const CTRL_C = { ctrl: true } as const;

afterEach(() => {
  vi.restoreAllMocks();
});

it.each(['doctor on the bare Home', 'a report over the chat the Home hosts'] as const)(
  'a popup whose code cannot load is the Home’s own fault, on its original owner: %s',
  async (which) => {
    const client = createClient(':memory:');
    runMigrations(client.db);
    const sessions = createSessionStore(client.db);
    const f = invocationFixture();
    const cwd = mkdtempSync(join(tmpdir(), 'relavium-home-popup-load-'));
    const homeDir = mkdtempSync(join(tmpdir(), 'relavium-home-popup-operator-'));
    const captured = captureIo();
    const cause = new TypeError('PRIVATE_POPUP_CHUNK_LOAD_FAULT');
    if (which === 'doctor on the bare Home') vi.mocked(openDoctor).mockRejectedValueOnce(cause);
    else vi.mocked(openReport).mockRejectedValueOnce(cause);
    let owner: InvocationWorkOwner | undefined;
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Preserve the original method and explicitly restore its actual receiver with call() below.
    const execute = SessionHomeLifetime.prototype.execute;
    vi.spyOn(SessionHomeLifetime.prototype, 'execute').mockImplementation(function (
      this: SessionHomeLifetime,
      body,
    ) {
      owner = this.surface.work;
      return execute.call(this, body);
    });
    let props: RootAppProps | undefined;
    let unmount = () => {};
    const exited = new Promise<void>((resolve) => {
      unmount = resolve;
    });
    let uuid = 0;
    const running = driveHome({
      invocation: f.invocation,
      writeControl: (sequence) => captured.io.writeOut(sequence),
      io: { ...captured.io, stdoutIsTty: true, stdinIsTty: true },
      global: {
        cwd,
        configPath: join(cwd, 'absent.toml'),
        json: false,
        color: false,
        verbosity: 'normal',
      },
      homeDir,
      outputStoreFactory: () => Promise.resolve(undefined),
      providers: scriptedResolver([textTurn('hello from the agent')]),
      doctorProbes: { keychain: () => {}, config: () => {}, toolHost: {} },
      openSessionStore: () => ({
        db: client.db,
        store: sessions,
        close: () => {
          client.sqlite.close();
        },
      }),
      now: () => 1_750_000_000_000,
      uuid: () => `id-${String(uuid++)}`,
      render: (value) => {
        props = value;
        // No Home root is mounted here, so nothing binds the popup host's gate as RootApp does, and a host with none opens nothing: open.
        value.popups?.bindOpenGate(() => undefined);
        value.onRendererReady?.(async (publish) => {
          await publish?.();
        });
        return {
          unmount,
          waitUntilExit: () => exited,
          waitUntilRenderFlush: () => Promise.resolve(),
        };
      },
      getSize: () => ({ cols: 120, rows: 40 }),
      subscribeResize: () => () => {},
      subscribeSignals: () => () => {},
      subscribeProcessExit: () => () => {},
      jobControlLifecycle: {
        supported: false,
        onSuspend: () => () => {},
        onContinue: () => () => {},
        suspendSelf: () => {},
      },
    });
    try {
      if (props === undefined) throw new Error('Expected the actual Home mount.');
      const controller = props.controller;
      const popups = props.popups;
      if (popups === undefined) throw new Error('Expected the Home’s popup host.');
      // No renderer is mounted here: the test is the frame that is "on screen".
      popups.bindVisibility(() => true);
      if (which === 'doctor on the bare Home') {
        controller.handleKey('/', {});
        for (const char of 'doctor') controller.handleKey(char, {});
        controller.handleKey('', ENTER);
        await vi.waitFor(() => expect(vi.mocked(openDoctor)).toHaveBeenCalledTimes(1));
      } else {
        for (const char of 'hello') controller.handleKey(char, {});
        controller.handleKey('', ENTER);
        await vi.waitFor(() => expect(controller.getSnapshot().mode).toBe('chat'), {
          timeout: 5000,
        });
        await vi.waitFor(() => expect(controller.getSnapshot().submitBusy).toBe(false), {
          timeout: 5000,
        });
        controller.handlePaste('/help');
        controller.handleKey('', ENTER);
        await vi.waitFor(() => expect(vi.mocked(openReport)).toHaveBeenCalledTimes(1));
      }
      await vi.waitFor(() =>
        expect(owner?.firstFailure?.cause, 'THE_LOAD_FAULT_REACHES_THE_ORIGINAL_OWNER').toBe(cause),
      );
      expect(popups.getSnapshot().open).toBe(false);
      expect(controller.getSnapshot().notice).toBeUndefined();
      // The fault is the Home's: with a chat in front the Home ends on it by itself, and a bare Home ends on the person's two presses (the
      // first arms, ADR-0115 §1). Either way it ends with the fault's code.
      controller.handleKey('c', CTRL_C);
      controller.handleKey('c', CTRL_C);
      expect(await running, 'THE_FAULT_IS_THE_HOME’S_EXIT_CODE').toBe(9);
      expect(f.registry.observations.infrastructureCode()).toBe('cli_internal');
      expect(captured.out() + captured.err()).not.toContain('PRIVATE_POPUP_CHUNK_LOAD_FAULT');
    } finally {
      unmount();
      await running.catch(() => undefined);
      if (client.sqlite.open) client.sqlite.close();
      rmSync(cwd, { recursive: true, force: true });
      rmSync(homeDir, { recursive: true, force: true });
    }
  },
);
