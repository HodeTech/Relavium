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
 * `/effort <tier>` typed on a model whose reasoning control is unknown reads in the wording of the surface that prints it (MVP-11 Step 2
 * review round 2, Q1): the refresh is `relavium models refresh` on a plain or `--json` chat and the picker's `Ctrl+R` in the interactive one.
 * The typed path hands an empty list of tiers to the rejected-tier note, which then speaks the unavailable-control sentence, and nothing
 * pinned the surface it was given there. A new file: the pinned counts of `chat.test.ts` belong to the causal and secrets controls.
 */
const HOME_ENV_VARS = ['HOME', 'USERPROFILE'] as const;
const PROJECT_TOML =
  '[chat]\ndefault_model = "my-self-hosted-model"\ndefault_provider = "anthropic"\n';
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

describe('/effort <tier> on a model whose control is unknown', () => {
  let cwd: string;
  let home: string;
  let client: DbClient;
  const savedHome = new Map<string, string | undefined>();
  let run = 0;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'relavium-effort-typed-cwd-'));
    home = mkdtempSync(join(tmpdir(), 'relavium-effort-typed-home-'));
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

  async function typedText(interactive: boolean): Promise<string> {
    const { io, err, out } = captureIo();
    let tick = Date.parse('2026-06-25T00:00:00.000Z');
    let id = 0;
    run += 1;
    const seen: string[] = [];
    const drive: ChatDriver = async (ctx) => {
      ctx.startSession();
      await ctx.onActivated?.(() => !ctx.shouldStop());
      await ctx.processLine('/effort high');
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
      ...(interactive ? INERT_HOIST : {}),
      now: () => tick++,
      uuid: () => `run${run}-id-${id++}`,
    };
    await chatCommand({ agent: undefined }, deps);
    return [...seen, err(), out()].join('\n');
  }

  it('says the shell’s refresh on a plain or --json chat', async () => {
    const text = await typedText(false);
    expect(text).toContain('Run `relavium models refresh`');
    expect(text).not.toMatch(/Open \/models|Ctrl\+R/u);
  });

  it('says the picker’s refresh on the interactive chat', async () => {
    const text = await typedText(true);
    expect(text).toContain('Open /models and press Ctrl+R');
    expect(text).not.toContain('relavium models refresh');
  });
});
