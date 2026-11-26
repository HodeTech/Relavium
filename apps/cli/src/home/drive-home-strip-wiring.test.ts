/**
 * `driveHome` wires the strip's idle refresh ([ADR-0140](../../../../docs/decisions/0140-management-browsers-the-run-drill-down-and-the-durable-run-detail.md)
 * §6) to the Active tab's change token.
 *
 * `home-strip-refresh.test.ts` drives the controller with a scripted `strip` port; the line that joins it to the real probe
 * (`strip: { token: changeToken, isClosed: () => dbClosed }`) is `driveHome`'s own, and the only thing that would notice it gone is this
 * file: a Home over a real `history.db` FILE with a second connection standing for another terminal. The observable is what the strip
 * shows. A commit by another connection moves `PRAGMA data_version`, so one idle interval later the strip shows the run it wrote; a write
 * through the Home's own connection moves nothing the probe sees, so it is not read at the tick (the tick reads through the token, never
 * on every interval). Without the `strip:` line the Home has no tick at all and the run never appears.
 *
 * Time moves only when the test says so (the controller's own timer is the one faked), and every home is a temporary directory handed to
 * the Home.
 */
import { mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { Readable } from 'node:stream';

import { createClient, createSessionStore, runMigrations, type DbClient } from '@relavium/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { scriptedResolver, textTurn } from '../chat/test-support.js';
import type { OpenedSessionStore } from '../history/session-open.js';
import type { CliIo } from '../process/io.js';
import type { GlobalOptions } from '../process/options.js';
import type { JobControlLifecycle } from '../render/suspend.js';
import type { RootAppProps } from '../render/tui/home-app.js';
import { STRIP_REFRESH_MS } from '../render/tui/home-controller.js';
import { runLabel } from '../render/tui/home-projection.js';
import { seedRun } from '../test-support.js';
import { driveHome, type HomeDeps } from './drive-home.js';

/** The bound of every wait in this file, in turns of the event loop. */
const WAIT_TURNS = 500;
const CTRL_C = { ctrl: true } as const;
const INERT_JOB_CONTROL: JobControlLifecycle = {
  supported: false,
  onSuspend: () => () => undefined,
  onContinue: () => () => undefined,
  suspendSelf: () => undefined,
};

let root: string;
let operatorHome: string;
/** The Home's own connection, and the one another terminal would write through. */
let client: DbClient;
let other: DbClient;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'relavium-strip-wired-'));
  operatorHome = mkdtempSync(join(tmpdir(), 'relavium-strip-wired-home-'));
  client = createClient(join(root, 'history.db'));
  runMigrations(client.db, { dbPath: client.path });
  other = createClient(client.path);
});
afterEach(() => {
  vi.useRealTimers();
  if (other.sqlite.open) other.sqlite.close();
  if (client.sqlite.open) client.sqlite.close();
  rmSync(root, { recursive: true, force: true });
  rmSync(operatorHome, { recursive: true, force: true });
  for (const parent of links.splice(0)) rmSync(parent, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const links: string[] = [];
/** A symlink to `dir`, in a directory of its own that the test removes. */
function linkTo(dir: string): string {
  const parent = mkdtempSync(join(tmpdir(), 'relavium-strip-wired-link-'));
  links.push(parent);
  const link = join(parent, 'here');
  symlinkSync(dir, link, 'junction');
  return link;
}

const turn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
/** Turn the event loop until `predicate` holds, and FAIL when it does not within {@link WAIT_TURNS}. */
async function until(predicate: () => boolean, what: string): Promise<void> {
  for (let n = 0; n < WAIT_TURNS; n += 1) {
    if (predicate()) return;
    await turn();
  }
  throw new Error(`${what} was not reached within ${String(WAIT_TURNS)} turns`);
}

/** The Home over an injected mount (no TTY), on `client`'s file, with only the controller's timers faked. */
async function mountHome(seed?: () => Promise<void>, cwd: string = root) {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  await seed?.();
  const opened: OpenedSessionStore = {
    store: createSessionStore(client.db),
    db: client.db,
    close: vi.fn(),
  };
  const io: CliIo = {
    writeOut: () => undefined,
    writeErr: () => undefined,
    writeOutAcknowledged: () => Promise.resolve(),
    writeErrAcknowledged: () => Promise.resolve(),
    env: {},
    stdoutIsTty: true,
    stdinIsTty: true,
    stdin: Readable.from([]),
  };
  const global: GlobalOptions = {
    json: false,
    color: false,
    cwd,
    configPath: join(tmpdir(), 'no-such-relavium-config.toml'),
    verbosity: 'normal',
  };
  let captured: RootAppProps | undefined;
  let acknowledgeExit: () => void = () => undefined;
  const exited = new Promise<void>((resolve) => {
    acknowledgeExit = resolve;
  });
  const deps: HomeDeps = {
    homeDir: operatorHome,
    outputStoreFactory: () => Promise.resolve(undefined),
    io,
    global,
    providers: scriptedResolver([textTurn('hello')]),
    keychain: { get: () => null, set: () => undefined, delete: () => false },
    openSessionStore: () => opened,
    now: () => 1_750_000_000_000,
    uuid: (() => {
      let n = 0;
      return () => `id-${String(n++)}`;
    })(),
    render: (props) => {
      captured = props;
      props.nativePrompt?.bindVisibility(
        (expected) => props.nativePrompt?.getSnapshot() === expected,
      );
      props.onRendererReady?.(async (publish) => {
        await publish?.();
      });
      return {
        unmount: () => acknowledgeExit(),
        waitUntilRenderFlush: () => Promise.resolve(),
        waitUntilExit: () => exited,
      };
    },
    getSize: () => ({ cols: 120, rows: 40 }),
    subscribeResize: () => () => undefined,
    subscribeSignals: () => () => undefined,
    subscribeProcessExit: () => () => undefined,
    jobControlLifecycle: INERT_JOB_CONTROL,
    writeControl: () => undefined,
    exit: () => undefined,
    firstRunSetup: 'off',
  };
  const running = driveHome(deps);
  await until(() => captured !== undefined, 'the Home mounting');
  const props = captured;
  if (props === undefined) throw new Error('Home not mounted');
  return {
    props,
    runIds: (): readonly string[] =>
      props.controller.getSnapshot().snapshot.recentRuns.map((run) => run.runId),
    /** The strip's Continue row of `runId`, as the Home read it. */
    row: (runId: string) =>
      props.controller.getSnapshot().snapshot.recentRuns.find((run) => run.runId === runId),
    leave: async (): Promise<number> => {
      props.controller.handleKey('c', CTRL_C);
      props.controller.handleKey('c', CTRL_C); // two presses leave: the first arms
      return running;
    },
  };
}

describe('driveHome wires the strip’s idle refresh to the Active tab’s change token', () => {
  it('shows a run another connection committed one interval later, and does not read for a write the probe cannot see', async () => {
    const home = await mountHome();
    expect(home.runIds(), 'the Home opened on an empty history').toEqual([]);

    // A write through the Home's own connection moves neither half of the token (`PRAGMA data_version` ignores its own connection and
    // nothing bumped the generation): the tick finds the token where the Home read it, and reads nothing.
    // (Each run is recorded for the directory the Home was opened in: the Home lists this directory's runs only, MVP-11 unit 7.)
    await seedRun(client.db, { slug: 'wf', runId: 'own-write', state: 'completed' });
    // A run records the canonical spelling of its directory (MVP-11 unit 7, round 2): a temp directory and its realpath differ on macOS.
    client.sqlite
      .prepare('UPDATE runs SET project_root = ? WHERE id = ?')
      .run(realpathSync.native(root), 'own-write');
    await vi.advanceTimersByTimeAsync(STRIP_REFRESH_MS * 3);
    expect(home.runIds(), 'the token did not move, so the strip was not read').toEqual([]);

    // Another terminal commits: `PRAGMA data_version` moves, and the next tick reads the strip (all of it, the own write too).
    await seedRun(other.db, { slug: 'wf', runId: 'another-terminal', state: 'completed' });
    other.sqlite
      .prepare('UPDATE runs SET project_root = ? WHERE id = ?')
      .run(realpathSync.native(root), 'another-terminal');
    await vi.advanceTimersByTimeAsync(STRIP_REFRESH_MS);
    expect(new Set(home.runIds())).toEqual(new Set(['own-write', 'another-terminal']));

    expect(await home.leave()).toBe(0);
  });
});

describe('driveHome tells the store which directory this Home is, so it lists that directory’s work only', () => {
  it('lists a run of this directory, and neither a run recorded for another directory nor one that recorded none, in any list or count', async () => {
    const elsewhere = join(operatorHome, 'code', 'other-app');
    const home = await mountHome(async () => {
      await seedRun(client.db, { slug: 'wf', runId: 'this-project', state: 'completed' });
      await seedRun(client.db, { slug: 'wf', runId: 'other-project', state: 'paused' });
      await seedRun(client.db, { slug: 'wf', runId: 'no-project', state: 'completed' });
      const record = client.sqlite.prepare('UPDATE runs SET project_root = ? WHERE id = ?');
      // The directory the Home was opened in (`global.cwd`), as a run records it: canonical (MVP-11 unit 7, round 2).
      record.run(realpathSync.native(root), 'this-project');
      record.run(elsewhere, 'other-project');
      // `no-project` recorded none: unknown is not this directory
    });
    expect(home.runIds()).toEqual(['this-project']);
    const snapshot = home.props.controller.getSnapshot().snapshot;
    expect(snapshot.totals).toEqual({ attention: 0, sessions: 0, runs: 1 });
    expect(snapshot.unreadableRuns).toEqual([]);
    expect(snapshot.attention.failedRuns).toEqual([]);
    const own = home.row('this-project');
    expect(own === undefined ? 'missing' : runLabel(own, Date.now())).not.toContain(
      'other project',
    );
    expect(await home.leave()).toBe(0);
  });

  it.each([
    ['a trailing slash', (dir: string): string => `${dir}${sep}`],
    ['a symlink', (dir: string): string => linkTo(dir)],
  ])(
    'opened through %s, lists the runs recorded under the canonical root, and none recorded under another spelling or `.` (MVP-11 unit 7, round 2)',
    async (_name, spell) => {
      const cwd = spell(root);
      const home = await mountHome(async () => {
        const record = client.sqlite.prepare('UPDATE runs SET project_root = ? WHERE id = ?');
        for (const [runId, stored] of [
          ['canonical', realpathSync.native(root)],
          ['as-typed', cwd],
          ['dot', '.'],
        ] as const) {
          await seedRun(client.db, { slug: 'wf', runId, state: 'completed' });
          record.run(stored, runId);
        }
      }, cwd);
      expect(home.runIds()).toEqual(['canonical']);
      expect(home.props.controller.getSnapshot().snapshot.totals).toEqual({
        attention: 0,
        sessions: 0,
        runs: 1,
      });
      expect(await home.leave()).toBe(0);
    },
  );
});
