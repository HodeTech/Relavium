/**
 * What the Home does around the global config's write (MVP-11 unit 6, round 1: test gaps D13, D14; ADR-0148 §6): a write behind a setup popup is
 * published only while the exact frame that says so is on screen, measured and flushed, and an open popup that is not a rewrite still goes
 * through the renderer's flush (the wait is drawn: `Saving preferences…`). The Home is the real `driveHome` with the renderer mocked as the
 * provider-setup tests mock it (`drive-home-providers.test.ts`), over a temporary operator home with no config (so no rewrite notice is needed and
 * what the writes do is read from the file); the visibility the renderer reports is the test's to take away.
 *
 * - D14: the write that needs no rewrite notice, with a popup open, still waits for the renderer's flush and draws `Saving preferences…`;
 * - D13: a write whose frame is not on screen when it is about to publish does not publish: it waits for the renderer again, and the file
 *   is written only once the frame is back.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { createClient, createSessionStore, runMigrations } from '@relavium/db';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CliError } from '../process/cli-error.js';
import type { CliIo } from '../process/io.js';
import { invocationFixture } from '../process/invocation.test-support.js';
import type { RootAppProps } from '../render/tui/home-app.js';
import { OwnedTtyInput, OwnedTtyOutput } from '../test-support.js';
import { driveHome, type HomeDeps } from './drive-home.js';
import {
  acknowledgePopupFrames,
  choose,
  closeDone,
  STEP_WAIT_MS,
} from './provider-popup.test-support.js';

const paths: string[] = [];
afterEach(() => {
  for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true });
});

/** The real Home over a temporary operator home with NO config and an environment key waiting for its consent. */
function setup(onFlush: (count: number, path: string) => void) {
  const cwd = mkdtempSync(join(tmpdir(), 'relavium-home-publication-'));
  paths.push(cwd);
  const path = join(cwd, 'global.toml');
  const db = createClient(':memory:');
  runMigrations(db.db);
  const fixture = invocationFixture();
  const input = new OwnedTtyInput();
  const output = new OwnedTtyOutput();
  const stderr = new OwnedTtyOutput();
  const io: CliIo = {
    nativeStdin: input,
    nativeStdout: output,
    nativeStderr: stderr,
    stdin: Readable.from([]),
    stdinIsTty: true,
    stdoutIsTty: true,
    env: { OPENAI_API_KEY: 'synthetic-env-secret-7139' },
    writeOut: () => {},
    writeErr: () => {},
    writeOutAcknowledged: async () => {},
    writeErrAcknowledged: async () => {},
  };
  let props: RootAppProps | undefined;
  /** What the renderer reports about the frame it shows: the test takes it away and gives it back. */
  const screen = { visible: true };
  let rendererExit: () => void = () => {};
  const exited = new Promise<void>((resolve) => {
    rendererExit = resolve;
  });
  const close = vi.fn(() => db.sqlite.close());
  const frames: string[] = [];
  const deps: HomeDeps = {
    invocation: fixture.invocation,
    io,
    buildSession: () => Promise.reject(new CliError('invalid_invocation', 'synthetic build stop')),
    global: { cwd, configPath: path, json: false, color: false, verbosity: 'normal' },
    keychain: {
      get: () => null,
      set: () => {
        throw new Error('unexpected key write');
      },
      delete: () => false,
    },
    openSessionStore: (_home, captureClose) => {
      captureClose?.(close);
      return { store: createSessionStore(db.db), db: db.db, close };
    },
    render: (captured) => {
      props = captured;
      captured.popups?.bindOpenGate(() => undefined);
      const ui = captured.nativePrompt;
      ui?.bindVisibility((expected) => screen.visible && ui.getSnapshot() === expected);
      if (ui !== undefined) acknowledgePopupFrames(ui);
      captured.nativePrompt?.subscribe(() =>
        frames.push(JSON.stringify(captured.nativePrompt?.getSnapshot())),
      );
      return {
        unmount: () => {
          captured.nativePrompt?.bindVisibility(undefined);
          rendererExit();
        },
        waitUntilExit: () => exited,
        waitUntilRenderFlush: async () => {},
      };
    },
    getSize: () => ({ cols: 80, rows: 24 }),
    subscribeResize: () => () => {},
    subscribeSignals: () => () => {},
    subscribeProcessExit: () => () => {},
    jobControlLifecycle: {
      supported: false,
      onSuspend: () => () => {},
      onContinue: () => () => {},
      suspendSelf: () => {},
    },
    writeControl: () => {},
    exit: () => {},
  };
  const running = driveHome(deps);
  let flushes = 0;
  const ready = async (): Promise<RootAppProps> => {
    await vi.waitFor(() => expect(props).toBeDefined());
    if (!props) throw new Error('missing Home mount');
    // The renderer's flush: every write behind an open popup goes through it, and the test sees each one.
    props.onRendererReady?.(async (publish) => {
      await publish?.();
      flushes += 1;
      onFlush(flushes, path);
    });
    return props;
  };
  const end = async (p: RootAppProps): Promise<void> => {
    p.controller.handleKey('c', { ctrl: true });
    p.controller.handleKey('c', { ctrl: true }); // two presses leave: the first arms (ADR-0115 §1)
    await running;
  };
  return {
    path,
    ready,
    end,
    frames,
    screen,
    get flushes() {
      return flushes;
    },
  };
}

/** The first run's consent to the environment key, answered, and its Done step closed: the two writes (the consent, the starter default) are made. */
async function grantTheEnvironmentKey(p: RootAppProps): Promise<void> {
  const ui = p.nativePrompt;
  if (ui === undefined) throw new Error('Native prompt missing');
  await vi.waitFor(() => expect(ui.getSnapshot().message).toContain('OPENAI_API_KEY'), {
    timeout: STEP_WAIT_MS,
  });
  await choose(ui, 'use');
  await closeDone(ui);
  await vi.waitFor(() => expect(ui.getSnapshot().active).toBe(false), { timeout: STEP_WAIT_MS });
}

describe('the Home publishes a config write behind its popup, through the renderer', () => {
  it('D14: a write that needs no rewrite notice, with a popup open, still goes through the renderer’s flush and draws the wait', async () => {
    const f = setup(() => undefined);
    const p = await f.ready();
    await grantTheEnvironmentKey(p);
    expect(existsSync(f.path)).toBe(true);
    expect(readFileSync(f.path, 'utf8')).toContain('OPENAI_API_KEY');
    // The consent and the starter default are two writes of a popup that is open: each waits for the renderer, and neither draws a rewrite notice.
    expect(f.flushes).toBeGreaterThanOrEqual(2);
    expect(f.frames.join(' ')).toContain('Saving preferences…');
    expect(f.frames.join(' ')).not.toContain('rewrites the global config');
    await f.end(p);
  }, 20_000);

  it('D13: a write whose frame is off the screen when it is about to publish waits for the renderer again, and is written only once the frame is back', async () => {
    let seenAtSecondFlush: string | null | undefined;
    const holder: { screen?: { visible: boolean } } = {};
    const f = setup((count, path) => {
      const screen = holder.screen;
      if (screen === undefined) return;
      // The first write's flush returns, and the terminal no longer shows the frame (a shrink, a lost screen) before the write publishes.
      if (count === 1) screen.visible = false;
      // The renderer is asked again: what is on the disk now, and the frame is back.
      if (count === 2) {
        seenAtSecondFlush = existsSync(path) ? readFileSync(path, 'utf8') : null;
        screen.visible = true;
      }
    });
    holder.screen = f.screen;
    const p = await f.ready();
    await grantTheEnvironmentKey(p);
    expect(
      seenAtSecondFlush,
      'nothing was published while the frame was off the screen',
    ).toBeNull();
    expect(readFileSync(f.path, 'utf8')).toContain('OPENAI_API_KEY');
    expect(f.flushes).toBeGreaterThanOrEqual(3);
    await f.end(p);
  }, 20_000);
});
