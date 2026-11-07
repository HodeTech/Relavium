import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createClient, createSessionStore, runMigrations, type DbClient } from '@relavium/db';
import type { ProviderId } from '@relavium/llm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { scriptedResolver, textTurn } from '../chat/test-support.js';
import type { ProviderResolver } from '../engine/providers.js';
import { EXIT_CODES } from '../process/exit-codes.js';
import { isCliError } from '../process/errors.js';
import type { GlobalOptions } from '../process/options.js';
import { captureIo } from '../test-support.js';
import {
  chatCommand,
  chatResumeCommand,
  type ChatDriver,
  type ChatResumeCommandDeps,
} from './chat.js';

/**
 * MVP-A4 on resume: a session whose provider has lost its key. An interactive resume opens anyway, says so, and
 * refuses a message until a key exists — so `/models` can still move the conversation to a provider that has one.
 * A non-interactive resume, where `/models` does not exist, is refused before anything starts.
 */

const HOME_ENV_VARS = ['HOME', 'USERPROFILE'] as const;

/** The interactive path enters the alternate screen; keep its control writes and signal hooks off the real tty. */
const INERT_HOIST = {
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

function globalOptions(cwd: string): GlobalOptions {
  return { json: false, color: false, cwd, configPath: undefined, verbosity: 'normal' };
}

/** A scripted resolver whose key answer the test controls, counting the provider requests it served. */
function keyedResolver(hasKey: (id: ProviderId) => boolean): {
  readonly providers: ProviderResolver;
  readonly requests: () => number;
} {
  const base = scriptedResolver([[...textTurn('again')]]);
  let requests = 0;
  return {
    providers: {
      ...base,
      hasKey,
      resolveProvider: (id) => {
        const provider = base.resolveProvider(id);
        if (provider === undefined) return undefined;
        return {
          ...provider,
          stream: (request, signal) => {
            requests += 1;
            return provider.stream(request, signal);
          },
        };
      },
    },
    requests: () => requests,
  };
}

describe('chat-resume when the session’s provider has no key (MVP-A4)', () => {
  let client: DbClient;
  let cwd: string;
  let home: string;
  const savedHome = new Map<string, string | undefined>();

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'relavium-resume-key-cwd-'));
    home = mkdtempSync(join(tmpdir(), 'relavium-resume-key-home-'));
    for (const v of HOME_ENV_VARS) {
      savedHome.set(v, process.env[v]);
      process.env[v] = home;
    }
    client = createClient(':memory:');
    runMigrations(client.db);
  });
  afterEach(() => {
    client.sqlite.close();
    for (const v of HOME_ENV_VARS) {
      const prev = savedHome.get(v);
      if (prev === undefined) delete process.env[v];
      else process.env[v] = prev;
    }
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  /** One completed turn on the default Anthropic agent, persisted as session `id-0`. */
  const seedSession = async (): Promise<ReturnType<typeof createSessionStore>> => {
    const store = createSessionStore(client.db);
    const { io } = captureIo();
    let id = 0;
    const lines = ['hello', '/exit'];
    const drive: ChatDriver = async (ctx) => {
      ctx.startSession();
      await ctx.onActivated?.(() => !ctx.shouldStop());
      for (const line of lines) {
        await ctx.processLine(line);
        if (ctx.shouldStop()) break;
      }
      return { kind: ctx.stopReason() };
    };
    expect(
      await chatCommand(
        { agent: undefined },
        {
          io,
          global: globalOptions(cwd),
          providers: scriptedResolver([textTurn('hi')]),
          openSessionStore: () => ({ store, db: client.db, close: () => undefined }),
          drive,
          now: () => Date.parse('2026-06-25T00:00:00.000Z'),
          uuid: () => `id-${String(id++)}`,
        },
      ),
    ).toBe(EXIT_CODES.chatEnded);
    return store;
  };

  /** Resume `id-0` interactively, typing `lines`, and report the notices and user turns the view showed. */
  const resumeInteractively = async (
    store: ReturnType<typeof createSessionStore>,
    providers: ProviderResolver,
    lines: readonly string[],
    between?: () => void,
  ): Promise<{
    readonly code: number;
    readonly notices: readonly string[];
    readonly userTurns: readonly string[];
  }> => {
    const { io } = captureIo();
    let id = 0;
    let notices: readonly string[] = [];
    let userTurns: readonly string[] = [];
    const drive: ChatDriver = async (ctx) => {
      ctx.startSession();
      await ctx.onActivated?.(() => !ctx.shouldStop());
      for (const line of lines) {
        await ctx.processLine(line);
        between?.();
        if (ctx.shouldStop()) break;
      }
      const { transcript } = ctx.store.getSnapshot().state;
      notices = transcript.filter((entry) => entry.role === 'notice').map((entry) => entry.text);
      userTurns = transcript.filter((entry) => entry.role === 'user').map((entry) => entry.text);
      return { kind: ctx.stopReason() };
    };
    const deps: ChatResumeCommandDeps = {
      ...INERT_HOIST,
      io: { ...io, stdoutIsTty: true }, // interactive ⇒ the deferred refusal
      global: globalOptions(cwd),
      providers,
      openSessionStore: () => ({ store, db: client.db, close: () => undefined }),
      drive,
      now: () => Date.parse('2026-06-25T01:00:00.000Z'),
      uuid: () => `r-${String(id++)}`,
    };
    const code = await chatResumeCommand({ sessionId: 'id-0' }, deps);
    return { code, notices, userTurns };
  };

  it('opens an interactive resume, names both remedies, and sends nothing while the key is missing', async () => {
    const store = await seedSession();
    const persistedBefore = store.loadFull('id-0')?.messages.length;
    const { providers, requests } = keyedResolver(() => false);

    const { code, notices, userTurns } = await resumeInteractively(store, providers, [
      'hello again',
      '/compact',
      '/exit',
    ]);

    expect(code).toBe(EXIT_CODES.chatEnded); // opened and ended normally — not refused with exit 2
    const missing = notices.filter((text) => text.includes("no API key for provider 'anthropic'"));
    expect(missing).toHaveLength(3); // on open, for the refused message, and for /compact's summary call
    expect(notices.some((text) => /compaction failed/iu.test(text))).toBe(false);
    for (const text of missing) {
      expect(text).toContain('`relavium provider set-key anthropic`');
      expect(text).toContain('/models');
    }
    expect(requests()).toBe(0); // nothing reached the provider
    expect(store.loadFull('id-0')?.messages.length).toBe(persistedBefore); // nor the transcript
    expect(userTurns).not.toContain('hello again'); // nor the view, as a turn that was never sent
  });

  it('lets the next message through once a key exists', async () => {
    const store = await seedSession();
    let keyed = false;
    const { providers, requests } = keyedResolver(() => keyed);

    // The key is stored (say, in another terminal) after the first, refused message.
    const { code } = await resumeInteractively(
      store,
      providers,
      ['refused', 'sent', '/exit'],
      () => {
        keyed = true;
      },
    );

    expect(code).toBe(EXIT_CODES.chatEnded);
    expect(requests()).toBe(1);
    const users = (store.loadFull('id-0')?.messages ?? []).filter((m) => m.role === 'user');
    expect(users.map((m) => m.content)).not.toContainEqual([{ type: 'text', text: 'refused' }]);
    expect(users.map((m) => m.content)).toContainEqual([{ type: 'text', text: 'sent' }]);
  });

  it('refuses a NON-interactive resume before it starts, with the remedy', async () => {
    const store = await seedSession();
    const { io } = captureIo();
    const { providers } = keyedResolver(() => false);
    const caught = await chatResumeCommand(
      { sessionId: 'id-0' },
      {
        io, // not a TTY ⇒ the plain driver, which has no /models
        global: globalOptions(cwd),
        providers,
        openSessionStore: () => ({ store, db: client.db, close: () => undefined }),
        now: () => Date.parse('2026-06-25T01:00:00.000Z'),
        uuid: () => 'n-0',
      },
    ).then(
      () => undefined,
      (error: unknown) => error,
    );
    if (!isCliError(caught)) throw new Error('expected a CliError refusal');
    expect(caught.code).toBe('invalid_invocation');
    expect(caught.message).toContain('set-key anthropic');
  });
});
