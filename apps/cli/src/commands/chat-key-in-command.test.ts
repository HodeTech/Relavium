import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient, createSessionStore, runMigrations, type DbClient } from '@relavium/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { scriptedResolver } from '../chat/test-support.js';
import type { GlobalOptions } from '../process/options.js';
import { KEY_SHAPED_COMMAND_NOTICE } from '../render/provider-key-shape.js';
import { captureIo } from '../test-support.js';
import { chatCommand, type ChatCommandDeps, type ChatDriver } from './chat.js';

/**
 * A key typed into a chat's command line is answered with a fixed sentence and echoed nowhere (MVP-11 Step 2 review round 2, K3, A3, Q4). The
 * chat echoed `line.slice(0, 64)` as `unknown command '...'`, the validators 32 characters of a token and `/trim` 16 of its argument. One
 * handler serves the stand-alone chat and the chat the Home hosts (the Home answers a landing line first and hands a chat line down), so
 * the handler is the place to pin. A new file: the pinned counts of `chat.test.ts` belong to the causal and secrets controls.
 */
const HOME_ENV_VARS = ['HOME', 'USERPROFILE'] as const;
const FILL = 'aB3dE5fG7hJ9kL2mN4pQ6rS8tU0vW1xY';
/** A key of each of the four providers; each is built from pieces, so no file holds one whole. */
const KEYS = {
  Anthropic: `sk-ant-api03-${FILL}${FILL}`,
  OpenAI: `sk-proj-${FILL}${FILL}`,
  DeepSeek: `sk-${'0123456789abcdef'.repeat(2)}`,
  Gemini: `AIza${FILL}_-x`,
} as const;
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

describe('a key typed into a chat command line', () => {
  let cwd: string;
  let home: string;
  let client: DbClient;
  const savedHome = new Map<string, string | undefined>();
  let run = 0;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'relavium-chat-key-cwd-'));
    home = mkdtempSync(join(tmpdir(), 'relavium-chat-key-home-'));
    for (const v of HOME_ENV_VARS) {
      savedHome.set(v, process.env[v]);
      process.env[v] = home; // the operator's real home is never read
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

  /** Every line through the real handler; what the person could read (the transcript, stderr, stdout) and whether the chat stopped. */
  async function typed(
    interactive: boolean,
    lines: readonly string[],
  ): Promise<{ readonly text: string; readonly stopped: boolean }> {
    const { io, err, out } = captureIo();
    let tick = Date.parse('2026-06-25T00:00:00.000Z');
    let id = 0;
    run += 1;
    const seen: string[] = [];
    let stopped = false;
    const drive: ChatDriver = async (ctx) => {
      ctx.startSession();
      await ctx.onActivated?.(() => !ctx.shouldStop());
      for (const line of lines) await ctx.processLine(line);
      stopped = ctx.shouldStop();
      for (const entry of ctx.store.getSnapshot().state.transcript) seen.push(entry.text);
      return { kind: 'exit' };
    };
    const global: GlobalOptions = {
      json: false,
      color: false,
      cwd,
      configPath: undefined,
      verbosity: 'normal',
    };
    const deps: ChatCommandDeps = {
      io: { ...io, stdoutIsTty: interactive },
      global,
      providers: scriptedResolver([]),
      openSessionStore: () => ({
        store: createSessionStore(client.db),
        db: client.db,
        close: () => undefined,
      }),
      drive,
      ...INERT_HOIST,
      now: () => tick++,
      uuid: () => `run${run}-id-${id++}`,
    };
    await chatCommand({ agent: undefined }, deps);
    return { text: [...seen, err(), out()].join('\n'), stopped };
  }

  describe.each([
    ['the interactive chat', true],
    ['a plain chat', false],
  ] as const)('in %s', (_surface, interactive) => {
    describe.each(Object.entries(KEYS))('%s', (_provider, key) => {
      it.each([
        ['after a slash', `/${key}`],
        ['after a slash and a word', `/mode ${key}`],
        ['as the argument of a command that takes none', `/exit ${key}`],
        ['as the argument of /trim', `/trim ${key}`],
        ['after an unknown word', `/bogus ${key}`],
        ['on a later line', `/Foo\n${key}`],
      ])(
        '%s: a fixed sentence, nothing of the line echoed, and nothing run',
        async (_where, line) => {
          const { text, stopped } = await typed(interactive, [line]);
          expect(text).toContain(KEY_SHAPED_COMMAND_NOTICE);
          expect(text, 'no part of the key is in anything shown').not.toContain(key.slice(0, 20));
          expect(text, 'it is not answered as an unknown command').not.toContain('unknown command');
          expect(text).not.toContain('unknown argument');
          expect(text).not.toContain('must be a positive whole number');
          expect(stopped, '`/exit KEY` is not run: the key is not a command line').toBe(false);
        },
      );
    });

    it('still answers an ordinary unknown command, a bad argument and a bad /trim in their own words', async () => {
      const { text } = await typed(interactive, ['/bogus', '/exit now', '/trim abc']);
      expect(text).toContain("unknown command '/bogus'");
      expect(text).toContain("/exit: unknown argument 'now'");
      expect(text).toContain("/trim: <n> must be a positive whole number (got 'abc')");
      expect(text).not.toContain(KEY_SHAPED_COMMAND_NOTICE);
    });
  });

  it('the sentence names where keys go in words a chat can follow, and echoes nothing', () => {
    expect(KEY_SHAPED_COMMAND_NOTICE).toBe(
      'That looked like an API key, so the line was not run, shown or kept. Connect a provider from the Home with /providers.',
    );
  });
});
