/**
 * A stop (SIGTSTP) while a control write of the terminal is entered, on an OWNED Home with no Ink tree mounted (MVP-11 unit 6, round 2: D06, D07).
 * The owned Home lets its entered control writes land before the process stops, and after it continues: the stop waits for what was written
 * before it (`releaseWithoutInkAcknowledged`), and the suspension is not settled, so the terminal size is not refreshed, while what was written
 * during it is still in flight (`reclaimWithoutInkAcknowledged`). The control write here is the one the Home's mouse capture makes
 * (`setMouseCapture`); its delivery is the test's to give.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { createClient, createSessionStore, runMigrations } from '@relavium/db';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CliError } from '../process/cli-error.js';
import { invocationFixture } from '../process/invocation.test-support.js';
import type { CliIo } from '../process/io.js';
import type { RootAppProps } from '../render/tui/home-app.js';
import { OwnedTtyInput, OwnedTtyOutput } from '../test-support.js';
import { driveHome, type HomeDeps } from './drive-home.js';

const paths: string[] = [];
afterEach(() => {
  for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true });
});

/** A turn of the event loop: what a settled promise chain needs to run its continuations. */
const flush = async (): Promise<void> => {
  for (let turn = 0; turn < 5; turn += 1)
    await new Promise<void>((resolve) => setImmediate(resolve));
};

/** The owned Home over a temporary directory, its job control the test's, and every acknowledged control write held until the test delivers it. */
function rig(duringStop: (props: RootAppProps) => void = () => undefined) {
  const cwd = mkdtempSync(join(tmpdir(), 'relavium-home-job-control-'));
  paths.push(cwd);
  const db = createClient(':memory:');
  runMigrations(db.db);
  const fixture = invocationFixture();
  /** Once the Home is leaving, its teardown writes are delivered at once. */
  let leaving = false;
  /** Every control write the Home entered, and the way to deliver it. */
  const writes: Array<{ readonly text: string; readonly deliver: () => void }> = [];
  const io: CliIo = {
    nativeStdin: new OwnedTtyInput(),
    nativeStdout: new OwnedTtyOutput(),
    nativeStderr: new OwnedTtyOutput(),
    stdin: Readable.from([]),
    stdinIsTty: true,
    stdoutIsTty: true,
    env: {},
    writeOut: () => {},
    writeErr: () => {},
    writeOutAcknowledged: (text) =>
      new Promise<void>((resolve) => {
        if (leaving) resolve();
        else writes.push({ text, deliver: resolve });
      }),
    writeErrAcknowledged: async () => {},
  };
  let props: RootAppProps | undefined;
  let exitRenderer: () => void = () => {};
  const exited = new Promise<void>((resolve) => {
    exitRenderer = resolve;
  });
  let suspend: () => void = () => {
    throw new Error('the stop listener was never installed');
  };
  const suspendSelf = vi.fn(() => {
    if (props !== undefined) duringStop(props);
  });
  const refreshSize = vi.fn();
  const deps: HomeDeps = {
    invocation: fixture.invocation,
    io,
    buildSession: () => Promise.reject(new CliError('invalid_invocation', 'synthetic build stop')),
    global: {
      cwd,
      configPath: join(cwd, 'global.toml'),
      json: false,
      color: false,
      verbosity: 'normal',
    },
    keychain: { get: () => null, set: () => {}, delete: () => false },
    openSessionStore: (_home, captureClose) => {
      captureClose?.(() => db.sqlite.close());
      return { store: createSessionStore(db.db), db: db.db, close: () => db.sqlite.close() };
    },
    render: (captured) => {
      props = captured;
      captured.popups?.bindOpenGate(() => undefined);
      return {
        unmount: () => exitRenderer(),
        waitUntilExit: () => exited,
        waitUntilRenderFlush: async () => {},
      };
    },
    getSize: () => ({ cols: 80, rows: 24 }),
    subscribeResize: () => () => {},
    subscribeSignals: () => () => {},
    subscribeProcessExit: () => () => {},
    jobControlLifecycle: {
      supported: true,
      onSuspend: (listener) => {
        suspend = listener;
        return () => {};
      },
      onContinue: () => () => {},
      suspendSelf,
      refreshSize,
    },
    firstRunSetup: 'off',
    writeControl: () => {},
    exit: () => {},
  };
  const running = driveHome(deps);
  return {
    writes,
    suspendSelf,
    refreshSize,
    suspend: () => suspend(),
    async mounted(): Promise<RootAppProps> {
      await vi.waitFor(() => expect(props).toBeDefined());
      if (props === undefined) throw new Error('the Home was not mounted');
      return props;
    },
    /** Deliver whatever is still in flight, then leave the Home (two presses: the first arms, ADR-0115 §1). */
    async end(p: RootAppProps): Promise<void> {
      leaving = true;
      for (const write of writes) write.deliver();
      p.controller.handleKey('c', { ctrl: true });
      p.controller.handleKey('c', { ctrl: true });
      await running;
    },
  };
}

describe('a stop while a control write of the terminal is entered (an owned Home, no Ink tree)', () => {
  it('D06 the process does not stop until the control write entered before it was delivered', async () => {
    const r = rig();
    const p = await r.mounted();
    try {
      p.setMouseCapture?.(true); // the Home writes ENABLE_MOUSE: entered, and not delivered
      expect(r.writes, 'the write is in flight').toHaveLength(1);
      r.suspend();
      await flush();
      expect(
        r.suspendSelf,
        'the stop waits for the write entered before it',
      ).not.toHaveBeenCalled();
      r.writes[0]?.deliver();
      await flush();
      expect(r.suspendSelf, 'delivered: now the process stops').toHaveBeenCalledTimes(1);
    } finally {
      await r.end(p);
    }
  });

  it('D07 the suspension is not settled (the size is not refreshed) until the control write entered during the stop was delivered', async () => {
    const r = rig((props) => props.setMouseCapture?.(true)); // the continuation redraws: the Home writes as the process runs again
    const p = await r.mounted();
    try {
      r.suspend();
      await flush();
      expect(r.suspendSelf).toHaveBeenCalledTimes(1);
      expect(r.writes, 'a write was entered while the stop ran').toHaveLength(1);
      expect(r.refreshSize, 'not settled: that write is still in flight').not.toHaveBeenCalled();
      r.writes[0]?.deliver();
      await flush();
      expect(r.refreshSize, 'delivered: the suspension is settled').toHaveBeenCalledTimes(1);
    } finally {
      await r.end(p);
    }
  });
});
