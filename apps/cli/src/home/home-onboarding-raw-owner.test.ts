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
import type { RootAppProps } from '../render/tui/home-app.js';
import { captureIo, OwnedTtyInput, OwnedTtyOutput } from '../test-support.js';
import { driveHome } from './drive-home.js';
import { SessionHomeLifetime } from './session-home-lifetime.js';

vi.mock('../secrets/os-keychain.js', () => ({
  createOsKeychainStore: () => ({ get: () => null, set: () => undefined, delete: () => false }),
}));

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const scenarios = [
  'healthy',
  'owned-release',
  'owned-reclaim',
  'held-release',
  'held-reclaim',
  'known-release',
  'known-reclaim',
  'ownerless-release',
  'ownerless-reclaim',
] as const;

it.each(scenarios)('Home retains the original onboarding raw-mode fault: %s', async (scenario) => {
  const client = createClient(':memory:');
  runMigrations(client.db);
  const f = invocationFixture();
  const cwd = mkdtempSync(join(tmpdir(), 'relavium-home-raw-owner-'));
  const captured = captureIo();
  const input = new OwnedTtyInput();
  const output = new OwnedTtyOutput();
  const owned = !scenario.startsWith('ownerless-');
  const unexpected = scenario.startsWith('owned-') || scenario.startsWith('held-');
  const cause = scenario.startsWith('known-')
    ? new ConfigError('synthetic.toml', 'invalid shape')
    : new TypeError('PRIVATE_HOME_RAW_FAULT /private/terminal-detail');
  let originalOwner: InvocationWorkOwner | undefined;
  // eslint-disable-next-line @typescript-eslint/unbound-method -- Invoke the captured method with its original instance below.
  const execute = SessionHomeLifetime.prototype.execute;
  vi.spyOn(SessionHomeLifetime.prototype, 'execute').mockImplementation(function (
    this: SessionHomeLifetime,
    body,
  ) {
    originalOwner = this.surface.work;
    return execute.call(this, body);
  });
  let armed = false;
  let hits = 0;
  const rawMode = input.setRawMode.bind(input);
  vi.spyOn(input, 'setRawMode').mockImplementation((enabled) => {
    if (
      armed &&
      hits === 0 &&
      ((scenario.endsWith('-release') && !enabled) || (scenario.endsWith('-reclaim') && enabled))
    ) {
      hits++;
      throw cause;
    }
    return rawMode(enabled);
  });
  let answer: (value: symbol) => void = () => {};
  const pendingPrompt = new Promise<symbol>((resolve) => {
    answer = resolve;
  });
  let entered = false;
  let suspend = () => {};
  let props: RootAppProps | undefined;
  let unmount = () => {};
  const exited = new Promise<void>((resolve) => {
    unmount = resolve;
  });
  const selfStop = vi.fn();
  let closes = 0;
  let settled = false;
  const running = driveHome({
    ...(owned ? { invocation: f.invocation } : {}),
    // The compatibility driver uses this explicit control sink; owned cases keep their ACK seam.
    writeControl: (sequence) => captured.io.writeOut(sequence),
    io: {
      ...captured.io,
      stdoutIsTty: true,
      stdinIsTty: true,
      stdin: input,
      nativeStdin: input,
      nativeStdout: output,
      nativeStderr: output,
    },
    global: {
      cwd,
      configPath: join(cwd, 'absent.toml'),
      json: false,
      color: false,
      verbosity: 'normal',
    },
    providers: {
      resolveProvider: () => undefined,
      keyFor: () => {
        throw new Error('No synthetic key.');
      },
    },
    openSessionStore: () => ({
      db: client.db,
      store: createSessionStore(client.db),
      close: () => {
        closes++;
        client.sqlite.close();
      },
    }),
    onboardingPrompter: {
      intro: () => {},
      outro: () => {},
      note: () => {},
      select: () => {
        rawMode(true);
        entered = true;
        return pendingPrompt;
      },
      password: () => Promise.resolve(Symbol('unused')),
      isCancel: (value): value is symbol => typeof value === 'symbol',
    },
    // Owned cases exercise Home's default captured native terminal adapter. The
    // compatibility case binds an explicit port instead of touching the user's TTY.
    ...(owned
      ? {}
      : {
          onboardingTerminalLifecycle: {
            onInput: () => () => {},
            isRawMode: () => input.isRaw,
            setRawMode: (enabled: boolean) => {
              input.setRawMode(enabled);
            },
          },
        }),
    jobControlLifecycle: {
      supported: true,
      onSuspend: (callback) => {
        suspend = callback;
        return () => {};
      },
      onContinue: () => () => {},
      suspendSelf: selfStop,
    },
    subscribeSignals: () => () => {},
    subscribeProcessExit: () => () => {},
    getSize: () => ({ cols: 100, rows: 30 }),
    subscribeResize: () => () => {},
    render: (value) => {
      props = value;
      return {
        unmount: () => {
          rawMode(false); // Model the renderer's actual final raw-input release.
          unmount();
        },
        waitUntilExit: () => exited,
        waitUntilRenderFlush: () => Promise.resolve(),
      };
    },
  }).then((code) => {
    settled = true;
    return code;
  });

  try {
    await vi.waitFor(() => expect(entered).toBe(true));
    armed = true;
    suspend();
    await tick();
    await tick();
    expect(hits).toBe(scenario === 'healthy' ? 0 : 1);
    expect(
      f.registry.observations.hasInfrastructureFailure(),
      'HOME_UNKNOWN_NATIVE_RAW_FAILURE_REACHES_ORIGINAL_OWNER',
    ).toBe(unexpected);
    if (unexpected) {
      expect(originalOwner?.firstFailure?.cause).toBe(cause);
      expect(f.registry.termination).toBeDefined();
      expect(originalOwner?.signal.aborted).toBe(true);
      expect(props).toBeUndefined();
    } else {
      expect(originalOwner?.firstFailure).toBeUndefined();
      expect(f.registry.termination).toBeUndefined();
    }
    if (scenario.startsWith('held-')) {
      // A failed reversible operation is no prompt-release ACK. The original
      // native promise must still settle before Home closes its actual SQLite handle.
      expect(settled).toBe(false);
      expect(closes).toBe(0);
      expect(client.sqlite.open).toBe(true);
      expect(f.registry.activeOwners).toBeGreaterThan(0);
    }
    expect(selfStop).toHaveBeenCalledTimes(scenario.endsWith('-release') ? 0 : 1);

    armed = false;
    rawMode(false); // The scripted prompt explicitly completes its native release.
    answer(Symbol('cancel'));
    await tick();
    await tick();
    props?.controller.handleKey('c', { ctrl: true });
    expect(await running).toBe(unexpected ? 9 : 0);
    expect(input.isRaw).toBe(false);
    expect(closes).toBe(1);
    expect(client.sqlite.open).toBe(false);
    expect(f.registry.activeOwners).toBe(0);
    if (!owned) {
      expect(captured.out(), 'OWNERLESS_HOME_CAPTURES_TERMINAL_RESTORE').toContain(
        DISABLE_BRACKETED_PASTE,
      );
      expect(captured.out()).toContain(DISABLE_MOUSE);
    }
    expect(captured.out() + captured.err()).not.toContain('PRIVATE_HOME_RAW_FAULT');
  } finally {
    armed = false;
    rawMode(false);
    answer(Symbol('cancel'));
    await tick();
    props?.controller.handleKey('c', { ctrl: true });
    unmount();
    await running;
    vi.restoreAllMocks();
    input.destroy();
    output.destroy();
    if (client.sqlite.open) client.sqlite.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});
