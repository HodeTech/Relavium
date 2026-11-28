import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient, createSessionStore, runMigrations, type DbClient } from '@relavium/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { scriptedResolver, textTurn } from '../chat/test-support.js';
import type { GlobalOptions } from '../process/options.js';
import { captureIo } from '../test-support.js';
import { chatCommand, type ChatCommandDeps, type ChatDriver } from './chat.js';

/**
 * `/doctor` in a chat reads the notice in the wording of the surface that prints it (MVP-11 Step 2 review round 2, N1): the interactive chat
 * and the Home name `/import`, a plain or `--json` chat is scripted output and names the shell command. The probes were assembled with the
 * TUI wording for every driver. A new file: the pinned counts of `chat.test.ts` belong to the causal and secrets controls.
 */
const HOME_ENV_VARS = ['HOME', 'USERPROFILE'] as const;
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

describe('the /doctor report a chat prints', () => {
  let cwd: string;
  let home: string;
  let client: DbClient;
  const savedHome = new Map<string, string | undefined>();
  let run = 0;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'relavium-chat-doctor-cwd-'));
    home = mkdtempSync(join(tmpdir(), 'relavium-chat-doctor-home-'));
    for (const v of HOME_ENV_VARS) {
      savedHome.set(v, process.env[v]);
      process.env[v] = home;
    }
    // A global workflow is what makes the `global-artifacts` check warn, and its remedy is the wording under test.
    mkdirSync(join(home, '.relavium', 'workflows'), { recursive: true });
    writeFileSync(join(home, '.relavium', 'workflows', 'global-flow.relavium.yaml'), 'name: x\n');
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

  async function doctorText(interactive: boolean, json: boolean): Promise<string> {
    const { io, err, out } = captureIo();
    let tick = Date.parse('2026-06-25T00:00:00.000Z');
    let id = 0;
    run += 1;
    const seen: string[] = [];
    const drive: ChatDriver = async (ctx) => {
      ctx.startSession();
      await ctx.onActivated?.(() => !ctx.shouldStop());
      await ctx.processLine('/doctor');
      for (const entry of ctx.store.getSnapshot().state.transcript) seen.push(entry.text);
      return { kind: 'exit' };
    };
    const global: GlobalOptions = {
      json,
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
    await chatCommand({ agent: undefined }, deps);
    return [...seen, err(), out()].join('\n');
  }

  it('a plain chat names the shell command a script can run, and no slash command', async () => {
    const text = await doctorText(false, false);
    expect(text).toContain('Workflows or agents in ~/.relavium/workflows');
    expect(text).toContain('relavium import');
    expect(text).not.toContain('/import');
  });

  it('a --json chat is scripted output too: the shell wording', async () => {
    const text = await doctorText(true, true);
    expect(text).toContain('relavium import');
    expect(text).not.toContain('/import');
  });

  it('the interactive chat names the Home’s /import, and no shell command', async () => {
    const text = await doctorText(true, false);
    expect(text).toContain('Workflows or agents in ~/.relavium/workflows');
    expect(text).toContain('/import');
    expect(text).not.toContain('relavium import');
  });
});
