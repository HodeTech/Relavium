import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient, createSessionStore, runMigrations } from '@relavium/db';
import { expect, it, vi } from 'vitest';

import * as doctor from '../chat/doctor.js';
import { scriptedResolver } from '../chat/test-support.js';
import { ConfigError } from '../config/errors.js';
import { invocationFixture } from '../process/invocation.test-support.js';
import type { InvocationWorkOwner } from '../process/invocation-work-owner.js';
import { DISABLE_MOUSE } from '../render/alt-screen.js';
import { DISABLE_BRACKETED_PASTE } from '../render/tui/home-input.js';
import type { RootAppProps } from '../render/tui/home-app.js';
import { captureIo } from '../test-support.js';
import { driveHome } from './drive-home.js';
import { SessionHomeLifetime } from './session-home-lifetime.js';

vi.mock('../secrets/os-keychain.js', () => ({
  createOsKeychainStore: () => ({ get: () => null, set: () => undefined, delete: () => false }),
}));

const cases = [
  'healthy',
  'checking-fault',
  'publication-fault',
  'formatter-fault',
  'known-refusal',
  'held-report',
  'late-rejection',
  'ownerless-publication-fault',
] as const;

it.each(cases)('actual Home doctor retains original publication and work: %s', async (mode) => {
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
  let releaseReport: (report: doctor.DoctorReport) => void = () => {};
  let rejectReport: (reason: unknown) => void = () => {};
  const held = new Promise<doctor.DoctorReport>((resolve, reject) => {
    releaseReport = resolve;
    rejectReport = reject;
  });
  let reportEntered = () => {};
  const entered = new Promise<void>((resolve) => {
    reportEntered = resolve;
  });
  const report: doctor.DoctorReport = { checks: [] };
  if (mode === 'held-report' || mode === 'late-rejection')
    vi.spyOn(doctor, 'runDoctorChecks').mockImplementation(() => {
      reportEntered();
      return held;
    });
  if (mode === 'formatter-fault')
    vi.spyOn(doctor, 'formatDoctorReport').mockImplementation(() => {
      throw cause;
    });
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
    providers: scriptedResolver([]),
    doctorProbes: {
      keychain: () => {},
      config: () => {
        if (mode === 'known-refusal') throw new ConfigError('synthetic.toml', 'invalid shape');
      },
      toolHost: {},
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
    onboardingTerminalLifecycle: {
      onInput: () => () => {},
      isRawMode: () => false,
      setRawMode: () => {},
    },
  }).then((code) => {
    settled = true;
    return code;
  });
  let remove = () => {};
  try {
    if (props === undefined) throw new Error('Expected actual Home mount.');
    const controller = props.controller;
    remove = controller.subscribe(() => {
      const text = controller.getSnapshot().notice;
      const match =
        mode === 'checking-fault'
          ? text === 'doctor: checking…'
          : text?.includes('all checks passed');
      if (match && hits === 0) {
        hits++;
        if (['checking-fault', 'publication-fault', 'ownerless-publication-fault'].includes(mode))
          throw cause;
      }
    });
    controller.handleKey('/', {});
    for (const char of 'doctor') controller.handleKey(char, {});
    controller.handleKey('', { return: true });
    if (mode === 'held-report' || mode === 'late-rejection') {
      expect(await Promise.race([entered.then(() => 'report'), running.then(() => 'exit')])).toBe(
        'report',
      );
      controller.handleKey('c', { ctrl: true });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(settled, 'DOCTOR_RAW_REPORT_MUST_JOIN_ORIGINAL_HOME').toBe(false);
      expect(closes).toBe(0);
      expect(client.sqlite.open).toBe(true);
      expect(f.registry.activeOwners).toBeGreaterThan(0);
      if (mode === 'late-rejection') rejectReport(cause);
      else releaseReport(report);
    } else if (mode === 'formatter-fault') {
      await vi.waitFor(() =>
        expect(
          owner?.firstFailure !== undefined ||
            controller.getSnapshot().notice === 'doctor: check failed',
        ).toBe(true),
      );
      remove();
      controller.handleKey('c', { ctrl: true });
    } else if (mode === 'known-refusal') {
      await vi.waitFor(() => expect(controller.getSnapshot().notice).toContain('check(s) failed'));
      expect(controller.getSnapshot().notice).toContain('invalid shape');
      remove();
      controller.handleKey('c', { ctrl: true });
    } else {
      await vi.waitFor(() => expect(hits).toBe(1));
      remove();
      controller.handleKey('c', { ctrl: true });
    }
    const faulted = [
      'checking-fault',
      'publication-fault',
      'formatter-fault',
      'late-rejection',
    ].includes(mode);
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
    releaseReport(report);
    unmount();
    await running;
    vi.restoreAllMocks();
    if (client.sqlite.open) client.sqlite.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});
