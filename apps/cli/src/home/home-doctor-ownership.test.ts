import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient, createSessionStore, runMigrations } from '@relavium/db';
import { expect, it, vi } from 'vitest';

import { ConfigError } from '../config/errors.js';
import { invocationFixture } from '../process/invocation.test-support.js';
import type { InvocationWorkOwner } from '../process/invocation-work-owner.js';
import { DISABLE_MOUSE } from '../render/alt-screen.js';
import { DISABLE_BRACKETED_PASTE } from '../render/tui/home-input.js';
import type { ProviderResolver } from '../engine/providers.js';
import { hanging, recordingProvider } from '../popups/doctor.test-support.js';
import type { RootAppProps } from '../render/tui/home-app.js';
import { captureIo } from '../test-support.js';
import { driveHome } from './drive-home.js';
import { SessionHomeLifetime } from './session-home-lifetime.js';

vi.mock('../secrets/os-keychain.js', () => ({
  createOsKeychainStore: () => ({ get: () => null, set: () => undefined, delete: () => false }),
}));

/**
 * The Home's `/doctor` is a popup (ADR-0148 §8, MVP-11 Step 4b): its work is the Home's own, entered on the original owner. What this file
 * pins is that ownership, through the real `driveHome`: a fault that escapes the doctor's work (a listener of the popup that throws as its
 * checks land) reaches the ORIGINAL Home and its exit code, an ownerless Home survives it, a configuration the doctor could not read is a row
 * and never a fault, and a deep request still in flight (one that ignores its abort) keeps the Home from finishing until it settles. The
 * report reaches the popup and nothing reaches the Home's notice.
 */
const cases = [
  'healthy',
  'publication-fault',
  'known-refusal',
  'held-deep',
  'ownerless-publication-fault',
] as const;

const KEY = ['sk', 'ant', 'home', 'owner', 'ABCDEF123456'].join('-');

it.each(cases)('actual Home doctor retains original publication and work: %s', async (mode) => {
  vi.useFakeTimers({ toFake: ['performance'] });
  const client = createClient(':memory:');
  runMigrations(client.db);
  const sessions = createSessionStore(client.db);
  const f = invocationFixture();
  const cwd = mkdtempSync(join(tmpdir(), 'relavium-home-doctor-owner-'));
  const captured = captureIo();
  const cause = new TypeError('PRIVATE_HOME_DOCTOR_LOCAL_FAULT /private/doctor-detail');
  const owned = mode !== 'ownerless-publication-fault';
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
  const stall = hanging();
  const anthropic = recordingProvider('anthropic', () => stall.promise);
  const resolver: ProviderResolver = {
    resolveProvider: (id) => (id === 'anthropic' ? anthropic : undefined),
    keyFor: () => KEY,
    hasKey: (id) => id === 'anthropic',
    endpointContext: () => 'Official endpoint: https://api.anthropic.com',
  };
  let props: RootAppProps | undefined;
  let unmount = () => {};
  const exited = new Promise<void>((resolve) => {
    unmount = resolve;
  });
  let closes = 0;
  let settled = false;
  let hits = 0;
  const running = driveHome({
    ...(owned ? { invocation: f.invocation } : {}),
    // The compatibility driver uses this explicit control sink; owned cases keep their ACK seam.
    writeControl: (sequence) => captured.io.writeOut(sequence),
    io: { ...captured.io, stdoutIsTty: true, stdinIsTty: true },
    global: {
      cwd,
      configPath: join(cwd, 'absent.toml'),
      json: false,
      color: false,
      verbosity: 'normal',
    },
    providers: resolver,
    doctorProbes: {
      keychain: () => {},
      config: () => {
        if (mode === 'known-refusal') throw new ConfigError('synthetic.toml', 'invalid shape');
      },
      toolHost: {},
      providers: resolver,
    },
    openSessionStore: () => ({
      db: client.db,
      store: sessions,
      close: () => {
        closes++;
        client.sqlite.close();
      },
    }),
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
  }).then((code) => {
    settled = true;
    return code;
  });
  let remove = () => {};
  try {
    if (props === undefined) throw new Error('Expected actual Home mount.');
    const controller = props.controller;
    const popups = props.popups;
    if (popups === undefined) throw new Error('Expected the Home’s popup host.');
    // No renderer is mounted here: the test is the frame that is "on screen", acknowledged when it says so.
    popups.bindVisibility(() => true);
    const checks = () => popups.getSnapshot().frame?.steps[0]?.content;
    remove = popups.subscribe(() => {
      const content = checks();
      if (content?.kind === 'list' && hits === 0) {
        hits++;
        if (mode === 'publication-fault' || mode === 'ownerless-publication-fault') throw cause;
      }
    });
    controller.handleKey('/', {});
    for (const char of 'doctor') controller.handleKey(char, {});
    controller.handleKey('', { return: true });
    await vi.waitFor(() => expect(hits).toBe(1));
    expect(controller.getSnapshot().notice, 'DOCTOR_WRITES_NO_HOME_NOTICE').toBeUndefined();
    if (mode === 'known-refusal') {
      const content = checks();
      expect(
        content?.kind === 'list' ? content.rows.map((row) => row.detail).join(' ') : '',
      ).toContain('invalid shape');
    }
    if (mode === 'held-deep') {
      popups.shown(popups.getSnapshot());
      vi.advanceTimersByTime(600);
      popups.input('d', {});
      await vi.waitFor(() =>
        expect(popups.getSnapshot().frame?.steps[2]?.content.kind).toBe('report'),
      );
      popups.shown(popups.getSnapshot());
      vi.advanceTimersByTime(900);
      popups.input('y', { ctrl: true });
      expect(anthropic.requests).toHaveLength(1);
      // Leaving the Home closes the popup and aborts the run; the request ignores its abort, so it is still the Home's work.
      remove();
      popups.closeAll('escape');
      expect(anthropic.requests[0]?.signal?.aborted).toBe(true);
      controller.handleKey('c', { ctrl: true });
      controller.handleKey('c', { ctrl: true }); // two presses leave: the first arms (ADR-0115 §1)
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(settled, 'DOCTOR_RAW_REQUEST_MUST_JOIN_ORIGINAL_HOME').toBe(false);
      expect(closes).toBe(0);
      expect(client.sqlite.open).toBe(true);
      expect(f.registry.activeOwners).toBeGreaterThan(0);
      stall.release();
    } else {
      remove();
      popups.closeAll('escape');
      controller.handleKey('c', { ctrl: true });
      controller.handleKey('c', { ctrl: true }); // two presses leave: the first arms (ADR-0115 §1)
    }
    const faulted = mode === 'publication-fault';
    expect(await running, 'DOCTOR_PUBLICATION_FAILURE_REACHES_ORIGINAL_HOME').toBe(faulted ? 9 : 0);
    if (faulted) {
      expect(owner?.firstFailure?.cause).toBe(cause);
      expect(f.registry.observations.infrastructureCode()).toBe('cli_internal');
    } else {
      expect(owner?.firstFailure).toBeUndefined();
      expect(f.registry.observations.infrastructureCode()).toBeUndefined();
    }
    expect(closes).toBe(1);
    expect(client.sqlite.open).toBe(false);
    expect(f.registry.activeOwners).toBe(0);
    if (!owned) {
      expect(captured.out(), 'OWNERLESS_HOME_CAPTURES_TERMINAL_RESTORE').toContain(
        DISABLE_BRACKETED_PASTE,
      );
      expect(captured.out()).toContain(DISABLE_MOUSE);
    }
    expect(captured.out() + captured.err()).not.toContain('PRIVATE_HOME_DOCTOR');
  } finally {
    remove();
    stall.release();
    unmount();
    await running;
    vi.restoreAllMocks();
    vi.useRealTimers();
    if (client.sqlite.open) client.sqlite.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});
