import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient, createSessionStore, runMigrations, type DbClient } from '@relavium/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { scriptedResolver, textTurn } from '../chat/test-support.js';
import type { DoctorPort } from '../popups/doctor-port.js';
import type { GlobalOptions } from '../process/options.js';
import { captureIo } from '../test-support.js';
import { chatCommand, type ChatCommandDeps, type ChatDriver } from './chat.js';

/**
 * The `/doctor` popup's port a chat driver is handed ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
 * §8): an interactive chat gets one (its session's probes, the stand-alone surface, the session's id for the MCP rows it may show again, the
 * provider seam in its probes), and a plain or `--json` driver gets none, so it prints the text report exactly as before. One scope for the
 * process: a `/clear` mounts a new chat, and the kept deep result and the run in flight are still the host's. A new file: the pinned counts of
 * `chat.test.ts` belong to the causal and secrets controls.
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

describe('the /doctor port a chat driver is handed', () => {
  let cwd: string;
  let home: string;
  let client: DbClient;
  const savedHome = new Map<string, string | undefined>();
  let run = 0;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'relavium-chat-doctor-port-cwd-'));
    home = mkdtempSync(join(tmpdir(), 'relavium-chat-doctor-port-home-'));
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

  async function portsOf(interactive: boolean, json: boolean, clears = 0) {
    const { io } = captureIo();
    let tick = Date.parse('2026-06-25T00:00:00.000Z');
    let id = 0;
    run += 1;
    const seen: { readonly port: DoctorPort | undefined }[] = [];
    let remaining = clears;
    const drive: ChatDriver = async (ctx) => {
      ctx.startSession();
      seen.push({ port: ctx.doctor });
      if (remaining > 0) {
        remaining -= 1;
        await ctx.processLine('/clear');
        return { kind: ctx.stopReason() };
      }
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
      uuid: () => `run${String(run)}-id-${String(id++)}`,
    };
    await chatCommand({ agent: undefined }, deps);
    return seen;
  }

  it('an interactive chat is handed the port of its session, on the stand-alone surface, with the provider seam', async () => {
    const [first] = await portsOf(true, false);
    expect(first?.port?.surface).toBe('standalone-chat');
    expect(first?.port?.probes.providers).toBeDefined();
    expect(first?.port?.probes.deepMcp).toBeDefined();
  });

  it('a plain and a --json driver are handed none: /doctor prints the text report there', async () => {
    expect((await portsOf(false, false))[0]?.port).toBeUndefined();
    expect((await portsOf(true, true))[0]?.port).toBeUndefined();
  });

  it('a /clear keeps the host’s scope (the kept result and the run in flight are the process’s), and moves the MCP rows’ key to the new session', async () => {
    const seen = await portsOf(true, false, 1);
    expect(seen).toHaveLength(2);
    const [before, after] = seen;
    // Compared as a fact, not as objects: a failure must not try to print a whole session's wiring.
    expect(after?.port?.scope === before?.port?.scope, 'one scope for the process').toBe(true);
    expect(after?.port?.resultKey).not.toBe(before?.port?.resultKey);
  });
});
