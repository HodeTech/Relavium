import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient, createSessionStore, runMigrations, type DbClient } from '@relavium/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { scriptedResolver } from '../chat/test-support.js';
import type { GlobalOptions } from '../process/options.js';
import { captureIo } from '../test-support.js';
import { chatCommand, type ChatCommandDeps, type ChatDriver } from './chat.js';

/**
 * A stand-alone chat's answer to a word only the Home has (MVP-11 Step 2 review, C5 and T3). The handler asked for the `home-chat` surface,
 * so `/resume` (which the chat the Home hosts HAS) read as an unknown command in a stand-alone chat, and the one-line pointer had no way to
 * the Home. This file is new on purpose: the pinned counts of `chat.test.ts` and `run.test.ts` belong to the causal and secrets controls.
 */
const HOME_ENV_VARS = ['HOME', 'USERPROFILE'] as const;

function linesDriver(lines: readonly string[]): ChatDriver {
  return async (ctx) => {
    ctx.startSession();
    await ctx.onActivated?.(() => !ctx.shouldStop());
    for (const line of lines) {
      await ctx.processLine(line);
      if (ctx.shouldStop()) break;
    }
    return { kind: ctx.stopReason() };
  };
}

describe('a stand-alone chat and the words only the Home has', () => {
  let cwd: string;
  let home: string;
  let client: DbClient;
  const savedHome = new Map<string, string | undefined>();

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'relavium-home-only-cwd-'));
    home = mkdtempSync(join(tmpdir(), 'relavium-home-only-home-'));
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

  async function standalone(lines: readonly string[]): Promise<string> {
    const { io, err } = captureIo();
    let tick = Date.parse('2026-06-25T00:00:00.000Z');
    let id = 0;
    const global: GlobalOptions = {
      json: false,
      color: false,
      cwd,
      configPath: undefined,
      verbosity: 'normal',
    };
    const deps: ChatCommandDeps = {
      io,
      global,
      providers: scriptedResolver([]),
      openSessionStore: () => ({
        store: createSessionStore(client.db),
        db: client.db,
        close: () => undefined,
      }),
      drive: linesDriver(lines),
      now: () => tick++,
      uuid: () => `id-${id++}`,
    };
    await chatCommand({ agent: undefined }, deps);
    return err();
  }

  it.each(['providers', 'resume', 'init', 'import', 'pricing', 'run', 'agents'])(
    '/%s answers one line that names the Home and how to start it, and is not an unknown command',
    async (name) => {
      const text = await standalone([`/${name}`, '/exit']);
      expect(text).toContain(
        `/${name} is available from the Home: start Relavium without arguments.`,
      );
      expect(text).not.toContain('unknown command');
      expect(text).not.toMatch(/relavium (?:provider|chat|init|import|run)/iu);
    },
  );

  it('a Home word with arguments is still the pointer, not a dispatch', async () => {
    const text = await standalone(['/providers now', '/exit']);
    expect(text).toContain(
      '/providers is available from the Home: start Relavium without arguments.',
    );
  });

  it('a word nothing has is still an unknown command, and the chat’s own words are untouched', async () => {
    const text = await standalone(['/bogus', '/exit']);
    expect(text).toContain("unknown command '/bogus'");
    expect(text).not.toContain('available from the Home');
  });
});
