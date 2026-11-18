/**
 * ADR-0132 §1, §7 at the COMMAND level: every path that builds a chat session hands it the question delegate exactly when
 * a card can answer, and binds the view store that draws it. The session builder and the card are tested elsewhere; this file
 * pins the wiring between them on each path the person can reach — a fresh chat, `/clear`, a `/models` reseat, `chat resume`
 * — because a missing option or a missing `bind` on ONE of them leaves that path unable to ask while the others work.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient, createSessionStore, runMigrations, type DbClient } from '@relavium/db';
import type { AskUserDelegate, AskUserRequest } from '@relavium/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildChatSession, buildResumedChatSession } from '../chat/session-host.js';
import * as osKeychain from '../secrets/os-keychain.js';
import { scriptedResolver } from '../chat/test-support.js';
import { captureIo } from '../test-support.js';
import type { ChatStoreController } from '../render/tui/chat-store.js';
import { chatCommand, chatResumeCommand, type ChatCommandDeps, type ChatDriver } from './chat.js';

const inertTerminal = {
  writeControl: (): void => undefined,
  lifecycle: {
    onProcessExit: (): (() => void) => () => undefined,
    onTerminationSignal: (): (() => void) => () => undefined,
    onInterrupt: (): (() => void) => () => undefined,
    setRawMode: (): void => undefined,
    exit: (): void => undefined,
  },
  jobControlLifecycle: {
    supported: false,
    onSuspend: (): (() => void) => () => undefined,
    onContinue: (): (() => void) => () => undefined,
    suspendSelf: (): void => undefined,
  },
} as const;

const REQUEST: AskUserRequest = {
  questions: [
    {
      header: 'Pick',
      question: 'Which file?',
      multiSelect: false,
      options: [
        { label: 'alpha.ts', description: 'The first file' },
        { label: 'beta.ts', description: 'The second file' },
      ],
    },
  ],
};

/** Ask through the delegate the session was built with, and report whether it drew a card on THIS store. */
async function askOn(
  store: ChatStoreController,
  delegate: AskUserDelegate | undefined,
): Promise<'card' | 'no delegate' | 'unbound'> {
  if (delegate === undefined) return 'no delegate';
  const pending = delegate(REQUEST).then(
    () => 'resolved' as const,
    (error: unknown) => (error instanceof Error ? error : new Error(String(error))),
  );
  const drawn = store.getSnapshot().question?.request === REQUEST;
  store.sealToolPreviews(); // cancel the question so the promise settles
  const outcome = await pending;
  if (drawn) return 'card';
  void outcome; // an unbound port rejects with "no question card is bound"; either way no card was drawn on this store
  return 'unbound';
}

describe('the ask_user delegate on every build path (ADR-0132)', () => {
  let cwd: string;
  let home: string;
  let client: DbClient;
  const saved = new Map<string, string | undefined>();
  beforeEach(() => {
    cwd = realpathSync(mkdtempSync(join(tmpdir(), 'relavium-ask-wiring-work-')));
    home = realpathSync(mkdtempSync(join(tmpdir(), 'relavium-ask-wiring-home-')));
    for (const key of ['HOME', 'USERPROFILE']) {
      saved.set(key, process.env[key]);
      process.env[key] = home;
    }
    client = createClient(':memory:');
    runMigrations(client.db);
    vi.spyOn(osKeychain, 'createOsKeychainStore').mockReturnValue({
      get: () => null,
      set: () => undefined,
      delete: () => false,
    });
  });
  afterEach(() => {
    client.sqlite.close();
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function dependencies(drive: ChatDriver, interactive = true, json = false) {
    const { io } = captureIo();
    let id = 0;
    const store = createSessionStore(client.db);
    const fresh: (AskUserDelegate | undefined)[] = [];
    const resumed: (AskUserDelegate | undefined)[] = [];
    const d: ChatCommandDeps = {
      ...inertTerminal,
      io: { ...io, stdoutIsTty: interactive },
      global: { cwd, json, color: false, configPath: undefined, verbosity: 'normal' },
      providers: scriptedResolver([]),
      openSessionStore: () => ({ store, db: client.db, close: () => undefined }),
      uuid: () => `ask-wiring-${id++}`,
      drive,
      buildSession: (options) => {
        fresh.push(options.askUser);
        return buildChatSession(options);
      },
      buildResumedSession: (options) => {
        resumed.push(options.askUser);
        return buildResumedChatSession(options);
      },
    };
    return { d, fresh, resumed };
  }

  it('a fresh interactive chat is given the delegate and its store is bound to it', async () => {
    const seen: string[] = [];
    const f = dependencies(async (ctx) => {
      ctx.startSession();
      await ctx.onActivated?.(() => !ctx.shouldStop());
      seen.push(await askOn(ctx.store, f.fresh.at(-1)));
      return { kind: 'exit' };
    });
    await chatCommand({ agent: undefined }, f.d);
    expect(seen).toEqual(['card']);
  });

  it.each([
    ['plain (no TTY)', false, false],
    ['--json', false, true],
  ])(
    'a %s chat is given NO delegate, so the model is never offered the tool',
    async (_name, interactive, json) => {
      const seen: string[] = [];
      const f = dependencies(
        async (ctx) => {
          ctx.startSession();
          await ctx.onActivated?.(() => !ctx.shouldStop());
          seen.push(await askOn(ctx.store, f.fresh.at(-1)));
          return { kind: 'exit' };
        },
        interactive,
        json,
      );
      await chatCommand({ agent: undefined }, f.d);
      expect(seen).toEqual(['no delegate']);
    },
  );

  it('/clear builds a new session: it gets its own delegate, bound to ITS store', async () => {
    const seen: string[] = [];
    let drives = 0;
    const f = dependencies(async (ctx) => {
      drives += 1;
      ctx.startSession();
      await ctx.onActivated?.(() => !ctx.shouldStop());
      seen.push(await askOn(ctx.store, f.fresh.at(-1)));
      return { kind: drives === 1 ? 'clear' : 'exit' };
    });
    await chatCommand({ agent: undefined }, f.d);
    expect(f.fresh).toHaveLength(2);
    expect(seen).toEqual(['card', 'card']);
  });

  it('a /models reseat builds a RESUMED session: it gets the delegate, bound to the reseated store', async () => {
    const seen: string[] = [];
    let drives = 0;
    const f = dependencies(async (ctx) => {
      drives += 1;
      ctx.startSession();
      await ctx.onActivated?.(() => !ctx.shouldStop());
      if (drives === 1) {
        ctx.onReseat?.({ modelId: 'claude-opus-4-8', provider: 'anthropic' });
        return { kind: ctx.stopReason() };
      }
      seen.push(await askOn(ctx.store, f.resumed.at(-1)));
      return { kind: 'exit' };
    });
    await chatCommand({ agent: undefined }, f.d);
    expect(f.resumed).toHaveLength(1);
    expect(seen).toEqual(['card']);
  });

  it('`chat resume` gives the resumed session the delegate, bound to its store — and none without a terminal', async () => {
    const first = dependencies(async (ctx) => {
      ctx.startSession();
      await ctx.onActivated?.(() => !ctx.shouldStop());
      return { kind: 'exit' };
    });
    await chatCommand({ agent: undefined }, first.d);
    const elsewhere = join(home, 'elsewhere');
    mkdirSync(elsewhere);

    for (const interactive of [true, false]) {
      const seen: string[] = [];
      const resumed = dependencies(async (ctx) => {
        ctx.startSession();
        await ctx.onActivated?.(() => !ctx.shouldStop());
        seen.push(await askOn(ctx.store, resumed.resumed.at(-1)));
        return { kind: 'exit' };
      }, interactive);
      await chatResumeCommand(
        { sessionId: 'ask-wiring-0' },
        { ...resumed.d, global: { ...resumed.d.global, cwd: elsewhere } },
      );
      expect(seen).toEqual([interactive ? 'card' : 'no delegate']);
    }
  });
});
