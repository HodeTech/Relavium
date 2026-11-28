import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient, createSessionStore, runMigrations, type DbClient } from '@relavium/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildChatSession,
  buildResumedChatSession,
  type BuildChatSessionOptions,
} from '../chat/session-host.js';
import { scriptedResolver, textTurn } from '../chat/test-support.js';
import type { GlobalOptions } from '../process/options.js';
import { captureIo } from '../test-support.js';
import {
  chatCommand,
  chatResumeCommand,
  type ChatCommandDeps,
  type ChatDriver,
  type ChatResumeCommandDeps,
} from './chat.js';

/**
 * Every session `chat.ts` builds says where its notices are read, and every `/doctor` it wires says it too (MVP-11 Step 2 review round 2,
 * Q1, N1): the fresh build, the resumed build, the `/clear` rebuild and the `/models` reseat each take a `noticeSurface` of their own, and
 * a call site that lost it fell back to the scripted wording with the whole suite green. The builds are recorded through the injected
 * builders, as `drive-home.test.ts` records the Home's; the `/doctor` of each rebuilt session names `/import` in the TUI and `relavium
 * import` on a plain chat. A new file: the pinned counts of `chat.test.ts` belong to the causal and secrets controls.
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

type Entry = 'fresh' | 'resumed';
type Replacement = 'none' | 'clear' | 'reseat';

describe('the notice surface of the sessions a chat builds', () => {
  let cwd: string;
  let home: string;
  let client: DbClient;
  const savedHome = new Map<string, string | undefined>();
  let run = 0;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'relavium-chat-rebuild-cwd-'));
    home = mkdtempSync(join(tmpdir(), 'relavium-chat-rebuild-home-'));
    for (const v of HOME_ENV_VARS) {
      savedHome.set(v, process.env[v]);
      process.env[v] = home; // the operator's real home is never read
    }
    // A global workflow is what makes `/doctor` warn, in the wording of the surface that prints it.
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

  /** One chat from `entry`, with a `replacement` after its first drive; the surfaces its builders were given and each drive's `/doctor`. */
  async function chat(
    interactive: boolean,
    entry: Entry,
    replacement: Replacement,
  ): Promise<{ readonly builds: (string | undefined)[]; readonly doctors: string[] }> {
    const { io, err } = captureIo();
    let tick = Date.parse('2026-06-25T00:00:00.000Z');
    let id = 0;
    run += 1;
    const builds: (string | undefined)[] = [];
    const doctors: string[] = [];
    const global: GlobalOptions = {
      json: false,
      color: false,
      cwd,
      configPath: undefined,
      verbosity: 'normal',
    };
    const openSessionStore: ChatCommandDeps['openSessionStore'] = () => ({
      store: createSessionStore(client.db),
      db: client.db,
      close: () => undefined,
    });
    const record = (options: BuildChatSessionOptions): void => {
      builds.push(options.noticeSurface);
    };
    let drives = 0;
    const doctorOf = async (ctx: Parameters<ChatDriver>[0]): Promise<string> => {
      const before = err();
      await ctx.processLine('/doctor');
      const shown = ctx.store.getSnapshot().state.transcript.map((entry) => entry.text);
      return [...shown, err().slice(before.length)].join('\n');
    };
    const drive: ChatDriver = async (ctx) => {
      ctx.startSession();
      await ctx.onActivated?.(() => !ctx.shouldStop());
      doctors.push(await doctorOf(ctx));
      if (drives++ === 0 && replacement !== 'none') {
        if (replacement === 'clear') return { kind: 'clear' };
        ctx.onReseat?.({ modelId: 'claude-opus-4-8', provider: 'anthropic' });
        return { kind: ctx.stopReason() };
      }
      await ctx.processLine('/exit');
      return { kind: ctx.stopReason() };
    };
    const common = {
      io: { ...io, stdoutIsTty: interactive },
      global,
      providers: scriptedResolver([textTurn('first'), textTurn('second')]),
      openSessionStore,
      ...(interactive ? INERT_HOIST : {}),
      now: () => tick++,
      uuid: () => `run${run}-id-${id++}`,
      buildSession: (options: BuildChatSessionOptions) => {
        record(options);
        return buildChatSession(options);
      },
      // A `/models` reseat resumes the session under the new model, so it is built here, for either entry.
      buildResumedSession: (options: Parameters<typeof buildResumedChatSession>[0]) => {
        builds.push(options.noticeSurface);
        return buildResumedChatSession(options);
      },
    };
    if (entry === 'fresh') {
      await chatCommand({ agent: undefined }, { ...common, drive } satisfies ChatCommandDeps);
    } else {
      // A saved session to resume: one plain chat that ends at once, over the same database.
      const seed: ChatCommandDeps = {
        ...common,
        io: { ...io, stdoutIsTty: false },
        drive: async (ctx) => {
          ctx.startSession();
          await ctx.onActivated?.(() => !ctx.shouldStop());
          await ctx.processLine('hello');
          await ctx.processLine('/exit');
          return { kind: ctx.stopReason() };
        },
        buildSession: (options) => buildChatSession(options),
      };
      await chatCommand({ agent: undefined }, seed);
      const sessionId = createSessionStore(client.db).listSessions()[0]?.id ?? '';
      expect(sessionId).not.toBe('');
      const resume: ChatResumeCommandDeps = {
        ...common,
        drive,
      };
      await chatResumeCommand({ sessionId }, resume);
    }
    return { builds, doctors };
  }

  const SHELL_IMPORT = 'relavium import';

  describe.each(['fresh', 'resumed'] as const)('a %s chat', (entry) => {
    it('on a plain chat builds with the shell wording, and its /doctor names the shell command', async () => {
      const { builds, doctors } = await chat(false, entry, 'none');
      expect(builds, 'the one build').toEqual(['shell']);
      expect(doctors).toHaveLength(1);
      expect(doctors[0]).toContain(SHELL_IMPORT);
      expect(doctors[0]).not.toContain('/import');
    });

    it.each(['none', 'clear', 'reseat'] as const)(
      'on the interactive chat, with %s after its first drive, builds with the TUI wording every time, and each /doctor names /import',
      async (replacement) => {
        const { builds, doctors } = await chat(true, entry, replacement);
        expect(builds, 'every build says tui').toEqual(
          replacement === 'none' ? ['tui'] : ['tui', 'tui'],
        );
        expect(doctors, 'one /doctor per drive').toHaveLength(replacement === 'none' ? 1 : 2);
        for (const doctor of doctors) {
          expect(doctor).toContain('/import');
          expect(doctor).not.toContain(SHELL_IMPORT);
        }
      },
    );
  });
});
