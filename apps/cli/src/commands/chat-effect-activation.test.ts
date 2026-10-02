import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createClient,
  createEffectJournalStore,
  createSessionStore,
  runMigrations,
  type DbClient,
} from '@relavium/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isValidElement } from 'react';

import { scriptedResolver, textTurn } from '../chat/test-support.js';
import type { GlobalOptions } from '../process/options.js';
import { driveInk } from '../render/tui/chat-ink.js';
import { captureIo } from '../test-support.js';
import {
  chatCommand,
  chatResumeCommand,
  driveJson,
  drivePlain,
  type ChatDriveContext,
  type ChatResumeCommandDeps,
} from './chat.js';

const renderer = vi.hoisted(() => ({ render: vi.fn() }));
vi.mock('ink', async (importOriginal) => ({
  ...(await importOriginal<typeof import('ink')>()),
  render: renderer.render,
}));

// Only the renderer is replaced. The command, resume builder, driver, notice store and SQLite journal are real.
const INERT_TERMINAL = {
  writeControl: () => undefined,
  lifecycle: {
    onProcessExit: () => () => undefined,
    onTerminationSignal: () => () => undefined,
    onInterrupt: () => () => undefined,
    setRawMode: () => undefined,
    exit: () => undefined,
  },
  jobControlLifecycle: {
    supported: false,
    onSuspend: () => () => undefined,
    onContinue: () => () => undefined,
    suspendSelf: () => undefined,
  },
};

let client: DbClient;
let root: string;
let deps: ChatResumeCommandDeps;
const rows = () => client.sqlite.prepare('SELECT * FROM run_effects').all();

function isCallback(value: unknown): value is () => void {
  return typeof value === 'function';
}

function mountedCallbacks(node: unknown): { activate: () => void; exit: () => void } {
  if (!isValidElement<Record<string, unknown>>(node)) throw new Error('expected a React element');
  const { onActivated, onExit } = node.props;
  if (!isCallback(onActivated) || !isCallback(onExit))
    throw new Error('expected activation and exit callbacks');
  return { activate: () => onActivated(), exit: () => onExit() };
}

async function waitForRender(): Promise<void> {
  await vi.waitFor(() => expect(renderer.render).toHaveBeenCalledTimes(1));
}

beforeEach(async () => {
  renderer.render.mockReset();
  root = mkdtempSync(join(tmpdir(), 'relavium-chat-effect-activation-'));
  const configPath = join(root, 'config.toml');
  writeFileSync(configPath, '');
  client = createClient();
  runMigrations(client.db);
  const store = createSessionStore(client.db);
  const global: GlobalOptions = {
    cwd: root,
    configPath,
    json: false,
    color: false,
    verbosity: 'normal',
    noAltScreen: true,
  };
  let id = 0;
  const captured = captureIo();
  const shared = {
    global,
    openSessionStore: () => ({ store, db: client.db, close: () => undefined }),
    now: () => 0,
    uuid: () => `activation-${String(id++)}`,
  };
  expect(
    await chatCommand(
      { agent: undefined },
      {
        ...shared,
        io: captured.io,
        providers: scriptedResolver([textTurn('done')]),
        drive: async (ctx) => {
          ctx.startSession();
          await ctx.processLine('hello');
          await ctx.processLine('/exit');
          return { kind: 'exit' };
        },
      },
    ),
  ).toBe(4);
  const turn = store.reserveEffectTurnKey('activation-0');
  const journal = createEffectJournalStore(client.db, { uuid: () => 'effect', now: () => 0 });
  const identity = {
    scope: `session:activation-0:${String(turn)}`,
    slot: 0,
    toolId: 'run_command',
  };
  journal.prepare(
    identity,
    { kind: 'session', sessionId: 'activation-0', turn },
    { providerAttempt: 1, toolCallId: `session-tool:${String(turn)}:0` },
    3,
    'digest',
  );
  journal.settle(identity, 'committed');
  deps = {
    ...shared,
    ...INERT_TERMINAL,
    io: { ...captureIo().io, stdoutIsTty: true, stdinIsTty: true },
    providers: scriptedResolver([]),
    drive: driveInk,
  };
});

afterEach(() => {
  vi.restoreAllMocks();
  client.sqlite.close();
  rmSync(root, { recursive: true, force: true });
});

describe('actual Ink driver activation owns session effect disclosure (ADR-0098)', () => {
  it('retains incomplete-turn evidence when renderer setup throws before mounting', async () => {
    let callbacks: ReturnType<typeof mountedCallbacks> | undefined;
    renderer.render.mockImplementation((node: unknown) => {
      callbacks = mountedCallbacks(node);
      throw new Error('renderer setup failed');
    });
    await expect(chatResumeCommand({ sessionId: 'activation-0' }, deps)).rejects.toThrow(
      'renderer setup failed',
    );
    expect(renderer.render).toHaveBeenCalledTimes(1);
    // Even a stale callback retained by a failed renderer cannot claim an active transcript later.
    callbacks?.activate();
    expect(rows()).toHaveLength(1);
  });

  it('waits for a committed mount, discloses before deletion, and activates only once', async () => {
    let callbacks: ReturnType<typeof mountedCallbacks> | undefined;
    const unmount = vi.fn();
    let ctx: ChatDriveContext | undefined;
    deps = {
      ...deps,
      drive: (current) => {
        ctx = current;
        return driveInk(current);
      },
    };
    renderer.render.mockImplementation((node: unknown) => {
      callbacks = mountedCallbacks(node);
      return { unmount };
    });
    const done = chatResumeCommand({ sessionId: 'activation-0' }, deps);
    await waitForRender();
    expect(rows()).toHaveLength(1); // render() returning is not an activation acknowledgement.
    if (ctx === undefined || callbacks === undefined) throw new Error('driver was not rendered');
    const notice = vi.spyOn(ctx.store, 'notice');
    notice.mockImplementation((text) => {
      expect(rows()).toHaveLength(1);
      expect(text).toContain('landed in a turn that did not complete');
    });
    callbacks.activate();
    expect(rows()).toEqual([]);
    callbacks.activate();
    expect(notice).toHaveBeenCalledTimes(1);
    callbacks.exit();
    expect(await done).toBe(4);
    expect(unmount).toHaveBeenCalledTimes(1);
    callbacks.activate();
    expect(notice).toHaveBeenCalledTimes(1);
  });

  it.each(['before mount', 'during disclosure'] as const)(
    'preserves evidence when the driver exits %s',
    async (exitAt) => {
      let callbacks: ReturnType<typeof mountedCallbacks> | undefined;
      let ctx: ChatDriveContext | undefined;
      deps = {
        ...deps,
        drive: (current) => {
          ctx = current;
          return driveInk(current);
        },
      };
      renderer.render.mockImplementation((node: unknown) => {
        callbacks = mountedCallbacks(node);
        return { unmount: vi.fn() };
      });
      const done = chatResumeCommand({ sessionId: 'activation-0' }, deps);
      await waitForRender();
      if (ctx === undefined || callbacks === undefined) throw new Error('driver was not rendered');
      const exit = callbacks.exit;
      const notice = vi.spyOn(ctx.store, 'notice');
      if (exitAt === 'before mount') exit();
      else notice.mockImplementation(() => exit());
      callbacks.activate();
      expect(await done).toBe(4);
      expect(rows()).toHaveLength(1);
      expect(notice).toHaveBeenCalledTimes(exitAt === 'before mount' ? 0 : 1);
    },
  );

  it('retains newly committed evidence if the standalone reseat renderer cannot mount', async () => {
    let drives = 0;
    deps = {
      ...deps,
      drive: (ctx) => {
        if (drives++ > 0) return driveInk(ctx);
        ctx.startSession();
        ctx.onActivated?.(() => !ctx.shouldStop());
        expect(rows()).toEqual([]);
        const turn = createSessionStore(client.db).reserveEffectTurnKey(ctx.handle.sessionId);
        const identity = {
          scope: `session:${ctx.handle.sessionId}:${String(turn)}`,
          slot: 0,
          toolId: 'run_command',
        };
        const journal = createEffectJournalStore(client.db, {
          uuid: () => 'reseat-effect',
          now: () => 0,
        });
        journal.prepare(
          identity,
          { kind: 'session', sessionId: ctx.handle.sessionId, turn },
          { providerAttempt: 1, toolCallId: `session-tool:${String(turn)}:0` },
          3,
          'digest',
        );
        journal.settle(identity, 'committed');
        ctx.onReseat?.({ modelId: 'claude-opus-4-8', provider: 'anthropic' });
        return Promise.resolve({ kind: ctx.stopReason() });
      },
    };
    renderer.render.mockImplementation(() => {
      throw new Error('reseat renderer setup failed');
    });
    await expect(chatResumeCommand({ sessionId: 'activation-0' }, deps)).rejects.toThrow(
      'reseat renderer setup failed',
    );
    expect(drives).toBe(2);
    expect(rows()).toHaveLength(1);
  });

  it.each([false, true])(
    'actual headless driver discloses before retention (json=%s)',
    async (json) => {
      const captured = captureIo();
      const notices: string[] = [];
      expect(
        await chatResumeCommand(
          { sessionId: 'activation-0' },
          {
            ...deps,
            global: { ...deps.global, json },
            drive: json ? driveJson : drivePlain,
            io: {
              ...captured.io,
              writeErr: (text) => {
                if (text.includes('external effect')) {
                  expect(rows()).toHaveLength(1);
                  notices.push(text);
                }
                captured.io.writeErr(text);
              },
            },
          },
        ),
      ).toBe(4);
      expect(notices).toHaveLength(1);
      expect(rows()).toEqual([]);
      expect(captured.out()).not.toContain('external effect');
      expect(renderer.render).not.toHaveBeenCalled();
    },
  );
});
