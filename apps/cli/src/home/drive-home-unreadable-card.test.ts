/**
 * `driveHome` wires the card of an unreadable run (MVP-11 unit 7): `Enter` on the row of a run whose log has a damaged row opens its read-only
 * card on the Home's popup host. `home-unreadable-card-route.test.ts` drives the controller with a scripted opener and
 * `popups/unreadable-run-hosts.test.tsx` the mounted Home with the matrix's wiring; the line that joins the controller to the card is
 * `driveHome`'s own (`openUnreadableRun: ...`), and the only thing that would notice it gone is this file: a Home over a real `history.db` FILE
 * whose one run of this directory holds a row that does not parse, found unreadable by the Home's own read, then `↓` and `Enter`.
 *
 * Time moves only when the test says so (the controller's own timer is the one faked), and every home is a temporary directory.
 */
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { createClient, createSessionStore, runMigrations, type DbClient } from '@relavium/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { scriptedResolver, textTurn } from '../chat/test-support.js';
import type { OpenedSessionStore } from '../history/session-open.js';
import type { CliIo } from '../process/io.js';
import type { GlobalOptions } from '../process/options.js';
import type { JobControlLifecycle } from '../render/suspend.js';
import type { RootAppProps } from '../render/tui/home-app.js';
import { seedRun } from '../test-support.js';
import { driveHome, type HomeDeps } from './drive-home.js';

/**
 * The bound of every wait in this file: at least this many turns of the event loop AND this long. A bound in turns alone passed on a fast
 * machine and failed on a slow CI runner (`the card was not reached within 500 turns`): the awaited step needs real time, not turns.
 */
const WAIT_TURNS = 500;
const WAIT_MS = 15_000;
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
  vi.restoreAllMocks();
});

const turn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
/** Turn the event loop until `predicate` holds, and FAIL when it does not within {@link WAIT_TURNS}. */
async function until(predicate: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + WAIT_MS;
  for (let n = 0; n < WAIT_TURNS || Date.now() < deadline; n += 1) {
    if (predicate()) return;
    await turn();
  }
  throw new Error(
    `${what} was not reached within ${String(WAIT_TURNS)} turns and ${String(WAIT_MS)} ms`,
  );
}

/** The Home over an injected mount (no TTY), on `client`'s file, with only the controller's timers faked; `controls` collects what it writes to the terminal. */
async function mountHome(seed?: () => Promise<void>, controls?: string[]) {
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
    cwd: root,
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
      // The renderer is injected, so nothing binds the popup host's gate: this Home's host lets every open through.
      props.popups?.bindOpenGate(() => undefined);
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
    writeControl: (sequence) => {
      controls?.push(sequence);
    },
    exit: () => undefined,
    firstRunSetup: 'off',
    // the keys are driven with no renderer: the Home's pages swap instead of sliding (MVP-11 unit 7)
    pageSlide: false,
  };
  const running = driveHome(deps);
  await until(() => captured !== undefined, 'the Home mounting');
  const props = captured;
  if (props === undefined) throw new Error('Home not mounted');
  // The host's evidence that the frames are on screen: this file proves the wiring, not the painting.
  props.controller.bindHomeFrame(() => true);
  return {
    props,
    leave: async (): Promise<number> => {
      props.controller.handleKey('c', CTRL_C);
      props.controller.handleKey('c', CTRL_C); // two presses leave: the first arms
      return running;
    },
  };
}

describe('driveHome wires the card of an unreadable run to its row', () => {
  it('opens the card of a run whose log has a damaged row, over the Home’s popup host, on Enter; Esc closes it, the focus on the row', async () => {
    const home = await mountHome(async () => {
      await seedRun(client.db, { slug: 'release-notes', runId: 'damaged-run', state: 'completed' });
      // A run records the canonical spelling of its directory (MVP-11 unit 7, round 2): a temp directory and its realpath differ on macOS.
      client.sqlite
        .prepare('UPDATE runs SET project_root = ? WHERE id = ?')
        .run(realpathSync.native(root), 'damaged-run');
      // A type this binary knows, with a body that does not parse: damaged, not newer.
      client.sqlite
        .prepare(
          'INSERT INTO run_events (id, run_id, seq, event_type, payload_json, ts) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run('damaged-row-1', 'damaged-run', 99, 'node:started', '{"type":"node:started"}', 0);
    });
    const { controller, popups } = home.props;
    expect(controller.getSnapshot().snapshot.unreadableRuns).toMatchObject([
      { runId: 'damaged-run', workflowSlug: 'release-notes', reason: 'corrupt-row' },
    ]);

    controller.handleKey('', { downArrow: true });
    await until(() => controller.getSnapshot().stripFocus?.id === 'damaged-run', 'the focus');
    controller.handleKey('', { return: true });
    await until(() => popups?.getSnapshot().frame?.spec.id === 'unreadable-run', 'the card');

    const content = popups?.getSnapshot().frame?.steps[0]?.content;
    const text = content?.kind === 'report' ? content.lines.join('\n') : '';
    expect(popups?.getSnapshot().frame?.spec.origin).toBe('home');
    expect(text).toContain('Run damaged- cannot be read');
    expect(text).toContain('Run id    damaged-run');
    expect(text).toContain('Workflow  release-notes');
    expect(text).toContain("This run's log has a damaged row.");
    expect(controller.getSnapshot().notice).toBeUndefined();
    expect(controller.getSnapshot().screen).toBeUndefined();

    popups?.input('', { escape: true });
    expect(popups?.getSnapshot().open).toBe(false);
    expect(controller.getSnapshot().stripFocus?.id).toBe('damaged-run');
    expect(await home.leave()).toBe(0);
  });

  it('offers `[c] copy` on the card, and the copy goes through the Home’s own clipboard: OSC 52 over its terminal sink, the whole run id in it', async () => {
    const controls: string[] = [];
    const home = await mountHome(async () => {
      await seedRun(client.db, { slug: 'release-notes', runId: 'damaged-run', state: 'completed' });
      client.sqlite
        .prepare('UPDATE runs SET project_root = ? WHERE id = ?')
        .run(realpathSync.native(root), 'damaged-run');
      client.sqlite
        .prepare(
          'INSERT INTO run_events (id, run_id, seq, event_type, payload_json, ts) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run('damaged-row-1', 'damaged-run', 99, 'node:started', '{"type":"node:started"}', 0);
    }, controls);
    const { controller, popups } = home.props;
    controller.handleKey('', { downArrow: true });
    await until(() => controller.getSnapshot().stripFocus?.id === 'damaged-run', 'the focus');
    controller.handleKey('', { return: true });
    await until(() => popups?.getSnapshot().frame?.spec.id === 'unreadable-run', 'the card');
    expect(popups?.getSnapshot().frame?.spec.steps[0]?.controls).toEqual([
      { key: 'c', verb: 'copy' },
    ]);
    const before = controls.length;
    // The popup's first frame is on screen (the renderer is injected, so the test says so), and its settle time has passed.
    popups?.bindVisibility(() => true);
    const shown = popups?.getSnapshot();
    if (shown !== undefined) popups?.shown(shown);
    const settledAt = performance.now() + 600;
    while (performance.now() < settledAt) await turn();
    popups?.input('c', {});
    await until(() => controls.length > before, 'the copy');
    const sequence = controls.at(-1) ?? '';
    const payload = /\]52;c;([A-Za-z0-9+/=]+)/u.exec(sequence)?.[1] ?? '';
    const text = Buffer.from(payload, 'base64').toString('utf8');
    expect(text).toContain('Run id    damaged-run');
    expect(text).toContain('Run damaged- cannot be read');
    expect(text).toContain('Other runs are not affected.');
    popups?.input('', { escape: true });
    expect(await home.leave()).toBe(0);
  });
});
