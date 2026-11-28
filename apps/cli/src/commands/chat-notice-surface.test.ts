import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient, createSessionStore, runMigrations, type DbClient } from '@relavium/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { scriptedResolver, textTurn } from '../chat/test-support.js';
import type { GlobalOptions } from '../process/options.js';
import { captureIo } from '../test-support.js';
import { chatCommand, chatNoticeSurface, type ChatCommandDeps, type ChatDriver } from './chat.js';

/**
 * The wording of the effort notices a chat handler prints (MVP-11 Step 2 review, C6): the TUI's own commands in the interactive chat, and the
 * shell's in a plain or `--json` chat, which has no `/models` to open. The handler was fixed to the TUI wording for every driver. A new file:
 * the pinned counts of `chat.test.ts` and `run.test.ts` belong to the causal and secrets controls.
 */
const HOME_ENV_VARS = ['HOME', 'USERPROFILE'] as const;
// A model the catalog does not know: its reasoning control is unknown, which is the note whose remedy differs by surface.
const PROJECT_TOML =
  '[chat]\ndefault_model = "my-self-hosted-model"\ndefault_provider = "anthropic"\nreasoning_effort = "high"\n';

// The interactive path acquires the terminal (alternate screen, raw mode, job control): inert ports, so nothing reaches the real one.
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

describe('the effort notices a chat handler prints', () => {
  let cwd: string;
  let home: string;
  let client: DbClient;
  const savedHome = new Map<string, string | undefined>();
  let run = 0; // one database for the test: every call mints session ids of its own

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'relavium-chat-surface-cwd-'));
    home = mkdtempSync(join(tmpdir(), 'relavium-chat-surface-home-'));
    for (const v of HOME_ENV_VARS) {
      savedHome.set(v, process.env[v]);
      process.env[v] = home; // the operator's real home is never read
    }
    mkdirSync(join(cwd, '.relavium'));
    writeFileSync(join(cwd, '.relavium', 'project.toml'), PROJECT_TOML);
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

  /** Run `lines` through the real line handler and return everything the person could read, in-view or on stderr. */
  async function textOf(interactive: boolean, lines: readonly string[]): Promise<string> {
    const { io, err, out } = captureIo();
    let tick = Date.parse('2026-06-25T00:00:00.000Z');
    let id = 0;
    run += 1;
    const seen: string[] = [];
    const drive: ChatDriver = async (ctx) => {
      ctx.startSession();
      await ctx.onActivated?.(() => !ctx.shouldStop());
      for (const line of lines) await ctx.processLine(line);
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
      providers: scriptedResolver([textTurn('unused')]),
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
    expect(chatNoticeSurface(deps.io, global)).toBe(interactive ? 'tui' : 'shell');
    await chatCommand({ agent: undefined }, deps);
    return [...seen, err(), out()].join('\n');
  }

  const effortText = (interactive: boolean): Promise<string> => textOf(interactive, ['/effort']);
  /** The note the built session composes when the tier is withheld at the first send: the build site's `noticeSurface`. */
  const withheldText = (interactive: boolean): Promise<string> => textOf(interactive, ['hello']);

  it('a plain or --json chat reads the shell wording: a command a script can run', async () => {
    const text = await effortText(false);
    expect(text).toContain('Run `relavium models refresh`');
    expect(text).not.toMatch(/Open \/models|Ctrl\+R/u);
  });

  it('the interactive chat reads its own wording: the picker’s refresh, no shell command', async () => {
    const text = await effortText(true);
    expect(text).toContain('Open /models and choose "Refresh the list"');
    expect(text).not.toContain('relavium models refresh');
  });

  it('a session the chat builds says the withheld tier in the wording of its own surface', async () => {
    const shell = await withheldText(false);
    expect(shell).toContain('relavium models refresh');
    expect(shell).not.toMatch(/Open \/models|Ctrl\+R/u);
    const tui = await withheldText(true);
    expect(tui).toContain('Open /models and choose "Refresh the list"');
    expect(tui).not.toContain('relavium models refresh');
  });
});
