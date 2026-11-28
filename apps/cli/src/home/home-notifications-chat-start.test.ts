/**
 * The Home's notifications are about the Home (MVP-11 unit 7, round 1: CO76): what it said on its own channel (`Enter` on an empty prompt's
 * `Type a message to chat · [/] commands`, the default `/models` saved for new chats, what a provider run did not say itself) is withdrawn when a
 * chat comes in front, or the chat's hint row reads the Home's words for about three seconds in place of its own (`[/] commands · [Ctrl+C] back
 * to Home (twice)`), the way back included. `driveHome` itself is run, because the wiring is its own: the Home's announcements carry the Home
 * as their source on the channel, and the controller withdraws that source as the chat starts. The run is scripted, nothing sleeps.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { createClient, createSessionStore, runMigrations, type DbClient } from '@relavium/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { scriptedResolver, textTurn } from '../chat/test-support.js';
import type { OpenedSessionStore } from '../history/session-open.js';
import type { CliIo } from '../process/io.js';
import type { JobControlLifecycle } from '../render/suspend.js';
import type { RootAppProps } from '../render/tui/home-app.js';
import { EMPTY_PROMPT_ENTER_NOTICE } from '../render/tui/home-controller.js';
import { driveHome, type HomeDeps } from './drive-home.js';

/** The bound of every wait, in turns of the event loop. */
const WAIT_TURNS = 500;
const CTRL_C = { ctrl: true } as const;
const ENTER = { return: true } as const;
const TAB = { tab: true } as const;
const INERT_JOB_CONTROL: JobControlLifecycle = {
  supported: false,
  onSuspend: () => () => undefined,
  onContinue: () => () => undefined,
  suspendSelf: () => undefined,
};

let root: string;
let operatorHome: string;
let client: DbClient;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'relavium-home-notify-'));
  operatorHome = mkdtempSync(join(tmpdir(), 'relavium-home-notify-home-'));
  client = createClient(':memory:');
  runMigrations(client.db);
});
afterEach(() => {
  if (client.sqlite.open) client.sqlite.close();
  rmSync(root, { recursive: true, force: true });
  rmSync(operatorHome, { recursive: true, force: true });
});

const turn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
async function until(predicate: () => boolean, what: string): Promise<void> {
  for (let n = 0; n < WAIT_TURNS; n += 1) {
    if (predicate()) return;
    await turn();
  }
  throw new Error(`${what} was not reached within ${String(WAIT_TURNS)} turns`);
}

async function mountHome() {
  const opened: OpenedSessionStore = {
    store: createSessionStore(client.db),
    db: client.db,
    close: () => undefined,
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
  let captured: RootAppProps | undefined;
  let acknowledgeExit: () => void = () => undefined;
  const exited = new Promise<void>((resolve) => {
    acknowledgeExit = resolve;
  });
  let uuid = 0;
  const deps: HomeDeps = {
    homeDir: operatorHome,
    outputStoreFactory: () => Promise.resolve(undefined),
    io,
    global: {
      json: false,
      color: false,
      cwd: root,
      configPath: join(tmpdir(), 'no-such-relavium-config.toml'),
      verbosity: 'normal',
    },
    providers: scriptedResolver([textTurn('hello')]),
    keychain: { get: () => null, set: () => undefined, delete: () => false },
    openSessionStore: () => opened,
    now: () => 1_750_000_000_000,
    uuid: () => `id-${String(uuid++)}`,
    render: (props) => {
      captured = props;
      props.nativePrompt?.bindVisibility(
        (expected) => props.nativePrompt?.getSnapshot() === expected,
      );
      props.popups?.bindOpenGate(() => undefined);
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
    pageSlide: false,
  };
  const running = driveHome(deps);
  await until(() => captured !== undefined, 'the Home mounting');
  const props = captured;
  if (props === undefined) throw new Error('Home not mounted');
  return { props, running };
}

describe('the Home’s notifications are withdrawn when a chat comes in front', () => {
  it('`Enter` on an empty prompt says how to start; `Tab` and `Enter` start the chat, and the chat’s hint row is its own at once', async () => {
    const { props, running } = await mountHome();
    const current = (): string | undefined => props.notifications?.getSnapshot().current?.text;
    expect(props.controller.getSnapshot().keyless, 'a Home with a key').toBe(false);
    props.controller.handleKey('', ENTER);
    expect(current()).toBe(EMPTY_PROMPT_ENTER_NOTICE);
    props.controller.handleKey('', TAB); // the example, filled in
    props.controller.handleKey('', ENTER);
    expect(props.controller.getSnapshot().mode, 'the chat is starting').not.toBe('home');
    expect(current(), 'the Home’s word is withdrawn with the chat’s start').toBeUndefined();
    await until(() => props.controller.getSnapshot().mode === 'chat', 'the chat in front');
    expect(current()).toBeUndefined();

    // Back at the Home, a word of the Home's is said there again as ever.
    props.controller.handleKey('c', CTRL_C);
    props.controller.handleKey('c', CTRL_C); // two presses leave the chat (ADR-0115 §1)
    await until(() => props.controller.getSnapshot().mode === 'home', 'the Home again');
    props.controller.handleKey('', ENTER);
    expect(current()).toBe(EMPTY_PROMPT_ENTER_NOTICE);
    props.controller.handleKey('c', CTRL_C);
    props.controller.handleKey('c', CTRL_C);
    expect(await running).toBe(0);
  });
});
