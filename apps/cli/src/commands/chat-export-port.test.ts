import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient, createSessionStore, runMigrations, type DbClient } from '@relavium/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SESSION_EXPORT_REVIEW_SENTENCE } from '../chat/export.js';
import { scriptedResolver, textTurn } from '../chat/test-support.js';
import type { ReportsPort } from '../popups/report-port.js';
import { toUserFacing } from '../process/errors.js';
import type { GlobalOptions } from '../process/options.js';
import { captureIo } from '../test-support.js';
import {
  chatCommand,
  type ChatCommandDeps,
  type ChatDriver,
  type ChatDriveContext,
} from './chat.js';

/**
 * The in-chat `/export` popup's port as the chat's line handler builds it (MVP-11 unit 6, 6.3; ADR-0148 §10, OD-10): an interactive chat is
 * handed one over THIS session and the project the live config finds, whose `prepare` writes nothing and names the file the `commit` then
 * writes (project-relative), whose `commit` is the session's own `/export` write and leaves nothing in the transcript, and whose `failure`
 * says a fault in the product's words; a plain or `--json` chat is handed none (its `/export` prints as it always did: `chat.test.ts`). A new
 * file: the pinned counts of `chat.test.ts` belong to the causal and secrets controls.
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

/** Every file and directory under `dir`, recursively and sorted: the whole of "writes nothing". */
function tree(dir: string, prefix = ''): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) =>
      entry.isDirectory()
        ? [`${prefix}${entry.name}/`, ...tree(join(dir, entry.name), `${prefix}${entry.name}/`)]
        : [`${prefix}${entry.name}`],
    )
    .sort();
}

describe('the /export popup’s port, as the chat builds it', () => {
  let cwd: string;
  let home: string;
  let client: DbClient;
  const savedHome = new Map<string, string | undefined>();
  let run = 0;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'relavium-chat-export-port-cwd-'));
    home = mkdtempSync(join(tmpdir(), 'relavium-chat-export-port-home-'));
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

  /** Drive one chat that has had one turn, and hand `inspect` what the driver was given. */
  async function drive(
    interactive: boolean,
    json: boolean,
    inspect: (seen: {
      readonly reports: ReportsPort | undefined;
      readonly ctx: ChatDriveContext;
    }) => void | Promise<void>,
  ): Promise<void> {
    const { io } = captureIo();
    let tick = Date.parse('2026-11-26T00:00:00.000Z');
    let id = 0;
    run += 1;
    const driver: ChatDriver = async (ctx) => {
      ctx.startSession();
      await ctx.processLine('hello');
      await inspect({ reports: ctx.reports, ctx });
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
      providers: scriptedResolver([textTurn('hi there')]),
      openSessionStore: () => ({
        store: createSessionStore(client.db),
        db: client.db,
        close: () => undefined,
      }),
      drive: driver,
      ...INERT_HOIST,
      now: () => tick++,
      uuid: () => `run${String(run)}-id-${String(id++)}`,
    };
    await chatCommand({ agent: undefined }, deps);
  }

  it('an interactive chat is handed it: prepare writes nothing and names the file commit then writes, project-relative', async () => {
    await drive(true, false, ({ reports, ctx }) => {
      const port = reports?.export ?? fail('no export port');
      expect(port.review).toBe(SESSION_EXPORT_REVIEW_SENTENCE);
      const before = tree(cwd);
      const preview = port.prepare();
      expect(preview.overwrites).toBe(false);
      expect(preview.target).toMatch(/^\.relavium\/workflows\/[a-z0-9-]+\.relavium\.yaml$/u);
      expect(tree(cwd), 'the preview wrote nothing').toEqual(before);
      const notices = (): readonly string[] =>
        ctx.store
          .getSnapshot()
          .state.transcript.filter((entry) => entry.role === 'notice')
          .map((entry) => entry.text);
      const noticesBefore = notices();
      const written = port.commit();
      expect(written.target).toBe(preview.target);
      expect(existsSync(join(cwd, written.target))).toBe(true);
      // No residue (ADR-0148 §6): the popup's Done step says it; the transcript is as it was.
      expect(notices()).toEqual(noticesBefore);
      // The second time it is this session's own earlier export, rewritten in place.
      expect(port.prepare()).toEqual({ target: preview.target, overwrites: true });
    });
  });

  it('a fault says itself in the product’s words, never an absolute path', async () => {
    await drive(true, false, ({ reports }) => {
      const port = reports?.export ?? fail('no export port');
      // `.relavium/workflows` is a FILE: the catalog cannot be read, so neither the look nor the write can go on.
      mkdirSync(join(cwd, '.relavium'), { recursive: true });
      writeFileSync(join(cwd, '.relavium', 'workflows'), 'not a directory\n');
      let caught: unknown;
      try {
        port.prepare();
      } catch (cause) {
        caught = cause;
      }
      expect(caught).toBeDefined();
      const said = port.failure(caught);
      // The refusal's own sentence, as the one user-facing projection says it (the same words the plain chat's `/export` prints): not
      // merely "something".
      expect(said).toBe(toUserFacing(caught).message);
      expect(said).toBe('could not read the workflows catalog directory.');
      expect(said).not.toContain(cwd);
      expect(said).not.toContain(home);
      // A fault that is no refusal of ours (a defect, a database's own error) is said by a fixed sentence, never by its own message.
      const raw = `EACCES: permission denied, open '${join(home, 'private', 'x.relavium.yaml')}'`;
      const internal = port.failure(new Error(raw));
      expect(internal).toBe(toUserFacing(new Error(raw)).message);
      expect(internal).toBe(
        'An unexpected CLI failure occurred. Inspect existing work before repeating paid or effectful operations.',
      );
      expect(internal).not.toContain('EACCES');
      expect(internal).not.toContain(home);
      expect(internal).not.toContain('private');
    });
  });

  it('a plain and a --json chat are handed none: their /export writes and prints as before', async () => {
    await drive(false, false, ({ reports }) => {
      expect(reports?.export).toBeUndefined();
    });
    await drive(true, true, ({ reports }) => {
      expect(reports?.export).toBeUndefined();
    });
  });
});

function fail(message: string): never {
  throw new Error(message);
}
