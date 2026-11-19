/**
 * ADR-0132 §1, §7 and ADR-0136 §2 at the COMMAND level: every path that builds a chat session hands it the question delegate AND
 * the continue-checkpoint hook exactly when a card can answer (one boolean feeds both), and binds the view store that draws them. The session builder and the card are tested elsewhere; this file
 * pins the wiring between them on each path the person can reach — a fresh chat, `/clear`, a `/models` reseat, `chat resume`
 * — because a missing option or a missing `bind` on ONE of them leaves that path unable to ask while the others work.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient, createSessionStore, runMigrations, type DbClient } from '@relavium/db';
import type { AskUserDelegate, AskUserRequest, ToolRoundLimitHook } from '@relavium/core';
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

/** The two interactive options a session is built with (they come from one boolean). */
interface InteractiveOptions {
  readonly askUser?: AskUserDelegate | undefined;
  readonly checkpoint?: ToolRoundLimitHook | undefined;
}

/**
 * Ask through the delegate AND the checkpoint hook the session was built with, and report whether each drew a card on THIS store.
 * 'card' means both did; a half-wired path (one option without the other) is reported as such, never as a pass.
 */
async function askOn(
  store: ChatStoreController,
  options: InteractiveOptions,
): Promise<
  'card' | 'no delegate' | 'unbound' | 'question without checkpoint' | 'checkpoint without question'
> {
  const { askUser, checkpoint } = options;
  if (askUser === undefined && checkpoint === undefined) return 'no delegate';
  if (askUser === undefined) return 'checkpoint without question';
  if (checkpoint === undefined) return 'question without checkpoint';
  const questionAbort = new AbortController();
  const asked = askUser(REQUEST, questionAbort.signal).catch(() => undefined);
  const questionDrawn = store.getSnapshot().question?.request === REQUEST;
  questionAbort.abort(); // cancel the question so the promise settles and the store is free for the next card
  await asked;
  const checkpointAbort = new AbortController();
  const held = checkpoint({ rounds: 1, interval: 1 }, checkpointAbort.signal).catch(
    () => undefined,
  );
  const checkpointDrawn = store.getSnapshot().checkpoint?.rounds === 1;
  checkpointAbort.abort();
  await held;
  // An unbound port rejects ("no question card is bound" / "no checkpoint card is bound"): no card is drawn on this store.
  return questionDrawn && checkpointDrawn ? 'card' : 'unbound';
}

describe('the ask_user delegate and the checkpoint hook on every build path (ADR-0132, ADR-0136)', () => {
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
    const fresh: InteractiveOptions[] = [];
    const resumed: InteractiveOptions[] = [];
    const d: ChatCommandDeps = {
      ...inertTerminal,
      io: { ...io, stdoutIsTty: interactive },
      global: { cwd, json, color: false, configPath: undefined, verbosity: 'normal' },
      providers: scriptedResolver([]),
      openSessionStore: () => ({ store, db: client.db, close: () => undefined }),
      uuid: () => `ask-wiring-${id++}`,
      drive,
      buildSession: (options) => {
        fresh.push({ askUser: options.askUser, checkpoint: options.checkpoint });
        return buildChatSession(options);
      },
      buildResumedSession: (options) => {
        resumed.push({ askUser: options.askUser, checkpoint: options.checkpoint });
        return buildResumedChatSession(options);
      },
    };
    return { d, fresh, resumed };
  }

  it('a fresh interactive chat is given the delegate and the checkpoint hook, and its store is bound to both', async () => {
    const seen: string[] = [];
    const f = dependencies(async (ctx) => {
      ctx.startSession();
      await ctx.onActivated?.(() => !ctx.shouldStop());
      seen.push(await askOn(ctx.store, f.fresh.at(-1) ?? {}));
      return { kind: 'exit' };
    });
    await chatCommand({ agent: undefined }, f.d);
    expect(seen).toEqual(['card']);
  });

  it.each([
    ['plain (no TTY)', false, false],
    ['--json', false, true],
  ])(
    'a %s chat is given NO delegate and NO checkpoint hook: the model is never offered the tool and the round limit stays a hard stop',
    async (_name, interactive, json) => {
      const seen: string[] = [];
      const f = dependencies(
        async (ctx) => {
          ctx.startSession();
          await ctx.onActivated?.(() => !ctx.shouldStop());
          seen.push(await askOn(ctx.store, f.fresh.at(-1) ?? {}));
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
      seen.push(await askOn(ctx.store, f.fresh.at(-1) ?? {}));
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
      seen.push(await askOn(ctx.store, f.resumed.at(-1) ?? {}));
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
        seen.push(await askOn(ctx.store, resumed.resumed.at(-1) ?? {}));
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
