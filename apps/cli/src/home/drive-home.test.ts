import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createClient,
  createSessionStore,
  runMigrations,
  type DbClient,
} from '@relavium/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { scriptedResolver, textTurn } from '../chat/test-support.js';
import type { OpenedSessionStore } from '../history/session-open.js';
import { EXIT_CODES } from '../process/exit-codes.js';
import type { CliIo } from '../process/io.js';
import type { GlobalOptions } from '../process/options.js';
import type { RootAppProps } from '../render/tui/home-app.js';
import { driveHome, type HomeDeps } from './drive-home.js';

/**
 * `driveHome` wires the durable db, the {@link createHomeStore} read seam, the deferred chat build, and the
 * single-ink mount into one lifecycle. These drive it through an **injected** ink mount (no real TTY) so the
 * contract is asserted directly: a clean Home exit resolves exit 0 and closes the shared db exactly once; an
 * escaping chat error rejects but STILL closes the db; and a deferred `startChat` builds a real chat session
 * (the default agent, the resolved chat config) and persists its row. The pure pieces (the gate, the strip
 * projection, the store) are unit-tested elsewhere — this covers only the imperative wiring `driveHome` owns.
 */
describe('driveHome (2.5.B / ADR-0054)', () => {
  let client: DbClient;
  let closeSpy: ReturnType<typeof vi.fn>;
  let cwd: string;

  const io: CliIo = {
    writeOut: () => undefined,
    writeErr: () => undefined,
    env: {},
    stdoutIsTty: true,
    stdinIsTty: true,
    stdin: { on: () => undefined } as unknown as NodeJS.ReadableStream,
  };

  beforeEach(() => {
    client = createClient(':memory:');
    runMigrations(client.db);
    closeSpy = vi.fn();
    cwd = mkdtempSync(join(tmpdir(), 'relavium-home-'));
  });
  afterEach(() => {
    client.sqlite.close();
  });

  const global: GlobalOptions = {
    json: false,
    color: false,
    get cwd() {
      return cwd;
    },
    configPath: join(tmpdir(), 'no-such-relavium-config.toml'), // absent ⇒ defaults (loadConfigFile tolerates ENOENT)
    verbosity: 'normal',
  };

  /** Build {@link HomeDeps} over the in-memory db with an injected ink mount that captures the {@link RootApp} props. */
  function makeDeps(
    render: (props: RootAppProps) => { unmount: () => void },
    overrides: Partial<HomeDeps> = {},
  ): HomeDeps {
    const opened: OpenedSessionStore = {
      store: createSessionStore(client.db),
      db: client.db,
      close: closeSpy,
    };
    return {
      io,
      global,
      providers: scriptedResolver([textTurn('hello from the agent')]),
      openSessionStore: () => opened,
      now: () => 1_750_000_000_000,
      uuid: () => 'sess-home-1',
      render,
      getSize: () => ({ cols: 120, rows: 40 }),
      subscribeResize: () => () => undefined,
      ...overrides,
    };
  }

  it('resolves exit 0 on a clean Home exit and closes the shared db exactly once', async () => {
    const unmount = vi.fn();
    const code = await driveHome(
      makeDeps((props) => {
        props.onExit(); // a clean Home exit (Ctrl-C / EOF in Home mode)
        return { unmount };
      }),
    );
    expect(code).toBe(EXIT_CODES.success);
    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(unmount).toHaveBeenCalledTimes(1);
  });

  it('rejects on an escaping chat error but STILL closes the shared db (the finally)', async () => {
    const unmount = vi.fn();
    const boom = new Error('a turn-core bug escaped');
    await expect(
      driveHome(
        makeDeps((props) => {
          props.onError(boom);
          return { unmount };
        }),
      ),
    ).rejects.toThrow('a turn-core bug escaped');
    expect(closeSpy).toHaveBeenCalledTimes(1); // the db is closed even on the failure path
    expect(unmount).toHaveBeenCalledTimes(1);
  });

  it('hands RootApp a homeStore that reads the live strip snapshot', async () => {
    let captured: RootAppProps | undefined;
    const code = await driveHome(
      makeDeps((props) => {
        captured = props;
        const snapshot = props.homeStore.read(); // exercises the real createHomeStore over the in-memory db
        expect(snapshot.attention.gates).toEqual([]);
        expect(snapshot.attention.failedRuns).toEqual([]);
        expect(snapshot.recentSessions).toEqual([]);
        expect(snapshot.isEmpty).toBe(true); // a fresh db ⇒ a first-run welcome strip, not a throw
        props.onExit();
        return { unmount: () => undefined };
      }),
    );
    expect(code).toBe(EXIT_CODES.success);
    expect(captured?.color).toBe(false);
  });

  it('startChat builds the default-agent session and persists its row; teardown closes cleanly', async () => {
    let captured: RootAppProps | undefined;
    // Hold the mount open (no onExit) so the test can drive startChat, then exit explicitly at the end.
    const drivePromise = driveHome(
      makeDeps((props) => {
        captured = props;
        return { unmount: () => undefined };
      }),
    );

    // The Promise executor (hence render) runs synchronously before driveHome awaits, so props are captured now.
    const props = captured;
    if (props === undefined) throw new Error('the injected render was never invoked');
    const session = await props.startChat();
    expect(typeof session.processLine).toBe('function');
    expect(session.shouldStop()).toBe(false);

    // persister.start() inserted the session row (the default chat agent slug) on the shared store.
    const sessions = createSessionStore(client.db);
    expect(sessions.loadSession('sess-home-1')?.id).toBe('sess-home-1');
    expect(sessions.loadSession('sess-home-1')?.status).toBe('active');

    // teardown marks the row 'ended' (the session's sole terminal) and is idempotent — a second call (an
    // error-path teardown racing an endChat) neither throws nor re-mutates.
    await expect(session.teardown()).resolves.toBeUndefined();
    expect(sessions.loadSession('sess-home-1')?.status).toBe('ended');
    await expect(session.teardown()).resolves.toBeUndefined();
    expect(sessions.loadSession('sess-home-1')?.status).toBe('ended');

    props.onExit(); // now let the mount resolve
    expect(await drivePromise).toBe(EXIT_CODES.success);
  });
});
