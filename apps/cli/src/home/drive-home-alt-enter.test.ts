/**
 * The Home's alternate-screen enter is wired, not only written ([ADR-0068](../../../../docs/decisions/0068-full-screen-tui-renderer-ink7-harness.md)
 * §c, MVP-11 step 4, review round 3, mutation M2): the bare Home mounts ink with its own `alternateScreen` option, so ink writes the enter, and
 * `homeAfterInkEnter` (`render/alt-screen.ts`) makes that enter the full one (the cursor home and the clear follow it: a first frame drawn on a
 * shell's row snaps up at the first redraw). Every other Home test injects `deps.render`, so nothing ran the line of `driveHome` that hands
 * ink the wrapped stream. This one mounts the REAL ink over a fake terminal and reads the bytes the terminal gets, for both ownership shapes:
 * a Home that owns its streams (`deps.io.nativeStdout`) and one that writes to the process's (`process.stdout`, spied here).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createClient, createSessionStore, runMigrations } from '@relavium/db';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { scriptedResolver, textTurn } from '../chat/test-support.js';
import { invocationFixture } from '../process/invocation.test-support.js';
import { ENTER_ALT_SCREEN } from '../render/alt-screen.js';
import { OwnedTtyInput, OwnedTtyOutput } from '../test-support.js';
import { driveHome, type HomeDeps } from './drive-home.js';

vi.mock('../secrets/os-keychain.js', () => ({
  createOsKeychainStore: () => ({ get: () => null, set: () => undefined, delete: () => false }),
}));

/** A line of the Home's first frame. */
const FIRST_FRAME = 'Welcome to Relavium.';

/** What ink writes to enter the alternate screen on its own: the first half of {@link ENTER_ALT_SCREEN}. */
const INK_ENTER = '\u001b[?1049h';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

interface Mounted {
  /** The bytes the Home's own terminal got (the owned stream, or the process's under its spy). */
  readonly bytes: () => string;
  /** The bytes of the stream the Home was NOT given (a Home that owns its streams writes nothing to the process's). */
  readonly otherBytes: () => string;
  readonly stop: () => Promise<void>;
}

/** Drive the Home with NO injected renderer, over fake terminals, until its first frame is written. */
async function mountHome(shape: {
  readonly owned: boolean;
  readonly inline: boolean;
}): Promise<Mounted> {
  const cwd = mkdtempSync(join(tmpdir(), 'relavium-home-enter-'));
  cleanups.push(() => rmSync(cwd, { recursive: true, force: true }));
  const client = createClient(':memory:');
  runMigrations(client.db);
  const input = new OwnedTtyInput();
  // The Home's own terminal when it owns its streams: a handle-free TTY (an emitter with `isTTY`, `columns`, `rows`) that keeps every chunk.
  const owned = new OwnedTtyOutput();
  owned.columns = 100;
  owned.rows = 30;
  const stderr = new OwnedTtyOutput();
  // The process's own terminal otherwise: a spy on `process.stdout.write` that keeps what ink writes there (and writes nothing to the real one),
  // with the fields ink reads from a terminal. The process's stdin is replaced the same way for the run.
  const processChunks: string[] = [];
  const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    processChunks.push(typeof chunk === 'string' ? chunk : String(chunk));
    return true;
  });
  const fields = { isTTY: true, columns: 100, rows: 30 };
  const saved = Object.keys(fields).map(
    (field) => [field, Object.getOwnPropertyDescriptor(process.stdout, field)] as const,
  );
  for (const [field, value] of Object.entries(fields))
    Object.defineProperty(process.stdout, field, { value, configurable: true });
  const processInput = Object.getOwnPropertyDescriptor(process, 'stdin');
  if (!shape.owned) Object.defineProperty(process, 'stdin', { value: input, configurable: true });
  cleanups.push(() => {
    writeSpy.mockRestore();
    if (!shape.owned && processInput !== undefined)
      Object.defineProperty(process, 'stdin', processInput);
    for (const [field, descriptor] of saved) {
      if (descriptor === undefined) Reflect.deleteProperty(process.stdout, field);
      else Object.defineProperty(process.stdout, field, descriptor);
    }
  });
  let signal: ((signo: number) => void) | undefined;
  const fixture = shape.owned ? invocationFixture() : undefined;
  const deps: HomeDeps = {
    ...(fixture === undefined ? {} : { invocation: fixture.invocation }),
    io: {
      ...(shape.owned ? { nativeStdin: input, nativeStdout: owned, nativeStderr: stderr } : {}),
      stdin: input,
      env: {},
      stdoutIsTty: true,
      stdinIsTty: true,
      writeOut: () => undefined,
      writeErr: () => undefined,
      writeOutAcknowledged: () => Promise.resolve(),
      writeErrAcknowledged: () => Promise.resolve(),
    },
    global: {
      cwd,
      configPath: join(cwd, 'absent.toml'),
      json: false,
      color: false,
      verbosity: 'normal',
      noAltScreen: shape.inline,
    },
    keychain: { get: () => null, set: () => undefined, delete: () => false },
    providers: scriptedResolver([textTurn('ready')]),
    openSessionStore: () => ({
      store: createSessionStore(client.db),
      db: client.db,
      close: () => client.sqlite.close(),
    }),
    doctorProbes: { keychain: () => undefined, config: () => undefined, toolHost: {} },
    getSize: () => ({ cols: 100, rows: 30 }),
    subscribeResize: () => () => undefined,
    subscribeSignals: (onSignal) => {
      signal = onSignal;
      return () => undefined;
    },
    subscribeProcessExit: () => () => undefined,
    jobControlLifecycle: {
      supported: false,
      onSuspend: () => () => undefined,
      onContinue: () => () => undefined,
      suspendSelf: () => undefined,
    },
    onboardingPrompter: {
      intro: () => undefined,
      outro: () => undefined,
      note: () => undefined,
      select: () => Promise.resolve(Symbol('cancel')),
      password: () => Promise.resolve(Symbol('cancel')),
      isCancel: (value): value is symbol => typeof value === 'symbol',
    },
    writeControl: () => undefined,
    exit: () => undefined,
  };
  let failure: unknown;
  const running = driveHome(deps).catch((cause: unknown) => {
    failure = cause;
  });
  const ownBytes = (): string => (shape.owned ? owned.frames : processChunks).join('');
  await vi.waitFor(
    () => {
      if (failure !== undefined)
        throw failure instanceof Error ? failure : new Error('Home failed');
      expect(ownBytes()).toContain(FIRST_FRAME);
    },
    { timeout: 5000 },
  );
  return {
    bytes: ownBytes,
    otherBytes: () => (shape.owned ? processChunks : owned.frames).join(''),
    stop: async () => {
      if (shape.owned) signal?.(15);
      else {
        // The Home that is not given its lifetime ends on a signal by exiting the process: here it ends the way a person ends it, `Ctrl+C` twice.
        input.push('\u0003');
        await new Promise((resolve) => setTimeout(resolve, 50));
        input.push('\u0003');
      }
      await running;
    },
  };
}

describe('the Home hands ink a stream that makes its alternate-screen enter the full one (real ink, fake terminal)', () => {
  it.each([
    ['a Home that owns its streams', true],
    ['a Home on the process’s own stdout', false],
  ] as const)(
    '%s: the bytes written before its first frame hold the full enter',
    async (_name, owned) => {
      const home = await mountHome({ owned, inline: false });
      try {
        const bytes = home.bytes();
        const enterAt = bytes.indexOf(ENTER_ALT_SCREEN);
        expect(enterAt).toBeGreaterThanOrEqual(0);
        // Before the first frame, and the only enter: ink's own bytes are the first half of it, so a stream that did not wrap them has none of the second.
        expect(bytes.indexOf(FIRST_FRAME)).toBeGreaterThan(enterAt);
        expect(bytes.split(INK_ENTER)).toHaveLength(2);
        // A Home that owns its streams writes nothing to the process's.
        if (owned) expect(home.otherBytes()).toBe('');
      } finally {
        await home.stop();
      }
    },
  );

  it.each([
    ['a Home that owns its streams', true],
    ['a Home on the process’s own stdout', false],
  ] as const)(
    '%s, inline: the stream is not wrapped, and nothing enters the alternate screen',
    async (_name, owned) => {
      const home = await mountHome({ owned, inline: true });
      try {
        expect(home.bytes()).not.toContain(INK_ENTER);
        expect(home.bytes()).not.toContain(ENTER_ALT_SCREEN);
      } finally {
        await home.stop();
      }
    },
  );
});
