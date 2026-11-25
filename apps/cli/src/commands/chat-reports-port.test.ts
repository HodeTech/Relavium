import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient, createSessionStore, runMigrations, type DbClient } from '@relavium/db';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { scriptedResolver, textTurn } from '../chat/test-support.js';
import type { ReportsPort } from '../popups/report-port.js';
import type { GlobalOptions } from '../process/options.js';
import { captureIo } from '../test-support.js';
import {
  chatCommand,
  type ChatCommandDeps,
  type ChatDriveContext,
  type ChatDriver,
} from './chat.js';

/**
 * The report popups' port a chat driver is handed ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
 * §10, MVP-11 step 4b): an interactive chat gets one, with its four members built over THIS session (its bound agent, its database and governor,
 * its project's catalog, the keys of a chat), and a plain or `--json` driver gets none, so each command prints exactly the text it printed before.
 * A new file: the pinned counts of `chat.test.ts` belong to the causal and secrets controls.
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

describe('the report port a chat driver is handed', () => {
  let cwd: string;
  let home: string;
  let client: DbClient;
  const savedHome = new Map<string, string | undefined>();
  let run = 0;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'relavium-chat-reports-port-cwd-'));
    home = mkdtempSync(join(tmpdir(), 'relavium-chat-reports-port-home-'));
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

  /** Drive one chat and hand `inspect` what the driver was given (its port, its session id and the store the session wrote to). */
  async function drive(
    interactive: boolean,
    json: boolean,
    inspect: (seen: {
      readonly reports: ReportsPort | undefined;
      readonly sessionId: string;
      /** The driver's own `ctx.boundAgent`: the one view the port's `agent` member has to be. */
      readonly boundAgent: ChatDriveContext['boundAgent'];
    }) => void | Promise<void>,
  ): Promise<void> {
    const { io } = captureIo();
    let tick = Date.parse('2026-06-25T00:00:00.000Z');
    let id = 0;
    run += 1;
    const driver: ChatDriver = async (ctx) => {
      ctx.startSession();
      await inspect({
        reports: ctx.reports,
        sessionId: ctx.handle.sessionId,
        boundAgent: ctx.boundAgent,
      });
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
      drive: driver,
      ...INERT_HOIST,
      now: () => tick++,
      uuid: () => `run${String(run)}-id-${String(id++)}`,
    };
    await chatCommand({ agent: undefined }, deps);
  }

  it('an interactive chat is handed all four members, on the stand-alone surface', async () => {
    await drive(true, false, async ({ reports, boundAgent }) => {
      expect(reports?.surface).toBe('standalone-chat');
      // Each member is the thing it names, built over THIS session: the agent is the very function the driver reads its bound agent through,
      // the cost port reads and releases, the catalog port reads (their behaviour is the tests below).
      expect(boundAgent).toBeDefined();
      expect(reports?.agent).toBe(boundAgent);
      expect(Object.keys(reports?.cost ?? {}).sort()).toEqual(['read', 'release']);
      expect(typeof reports?.cost?.read).toBe('function');
      expect(typeof reports?.cost?.release).toBe('function');
      expect(Object.keys(reports?.workflows ?? {})).toEqual(['read']);
      expect(typeof reports?.workflows?.read).toBe('function');
      // `[c] copy` rides the driver's one clipboard closure (the same OSC 52 path as `/copy` and the doctor's `[c]`), and the plain glyph form follows colour.
      expect(reports?.plainGlyphs).toBe(true);
      expect(await reports?.clipboard?.('copied text')).toEqual({
        kind: 'written',
        characters: 'copied text'.length,
      });
      expect(reports?.help?.keys.map((key) => key.keys)).toEqual([
        'Enter',
        'Ctrl+J',
        '↑/↓',
        'Ctrl+A/Ctrl+E',
        'Home/End',
        'Ctrl+←/Ctrl+→',
        'Alt+B/Alt+F',
        'Ctrl+W',
        'Ctrl+U',
        'Ctrl+K',
        '/',
        '@',
        'Ctrl+R',
        'Shift+Tab',
        'Ctrl+T',
        'Esc',
        'PgUp/PgDn',
        'Mouse wheel',
        'Mouse drag',
        'Ctrl+Z',
        'Ctrl+C',
      ]);
      // The same view `ctx.boundAgent` hands a driver that reads it directly.
      expect(reports?.agent?.().id).toBe('relavium-chat');
    });
  });

  it('a plain and a --json driver are handed none: each command prints its text there', async () => {
    await drive(false, false, ({ reports }) => {
      expect(reports).toBeUndefined();
    });
    await drive(true, true, ({ reports }) => {
      expect(reports).toBeUndefined();
    });
  });

  it('the cost read is one snapshot of this session’s database, and the release clears its durable record through the shared function', async () => {
    await drive(true, false, async ({ reports, sessionId }) => {
      const cost = reports?.cost ?? fail('no cost port');
      const before = await cost.read();
      expect(before.totalCostMicrocents).toBe(0);
      expect(before.rows).toEqual([]);
      // A held estimate lands in the durable record, as a commitment does: the read shows it, and the release clears it.
      createSessionStore(client.db).recordSessionConservativeCommitment({
        id: 'commitment-1',
        sessionId,
        model: 'claude-opus-4-8',
        estimateMicrocents: 450,
        ts: 1,
      });
      const held = await cost.read();
      expect(held.rows.map((row) => [row.model, row.conservativeMicrocents])).toEqual([
        ['claude-opus-4-8', 450],
      ]);
      const outcome = cost.release();
      expect(outcome.durable).toBe(450);
      const after = await cost.read();
      expect(after.rows.map((row) => row.conservativeMicrocents)).toEqual([0]);
      // Nothing is held now: a second release clears nothing.
      expect(cost.release().durable).toBe(0);
    });
  });

  it('the catalog read says no project, then lists what the project holds with an unreadable file kept and flagged', async () => {
    await drive(true, false, async ({ reports }) => {
      const workflows = reports?.workflows ?? fail('no workflows port');
      expect(await workflows.read()).toEqual({ kind: 'no-project' });
      mkdirSync(join(cwd, '.relavium', 'workflows'), { recursive: true });
      writeFileSync(join(cwd, '.relavium', 'workflows', 'broken.relavium.yaml'), 'not: [valid');
      const reading = await workflows.read();
      expect(reading.kind).toBe('catalog');
      if (reading.kind !== 'catalog') return;
      expect(reading.workflows.map((entry) => [entry.slug, entry.valid])).toEqual([
        ['broken', false],
      ]);
      expect(reading.agents).toEqual([]);
    });
  });
});

function fail(message: string): never {
  throw new Error(message);
}

describe('the ink driver hands the port to its chat', () => {
  it('createElement(ChatApp, { …, reports: ctx.reports }) is how `driveInk` mounts the chat, so a port a driver was given reaches the popups', () => {
    const file = ts.createSourceFile(
      'chat-ink.tsx',
      readFileSync(new URL('../render/tui/chat-ink.tsx', import.meta.url), 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    const handed: string[] = [];
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        node.expression.getText(file).endsWith('createElement') &&
        node.arguments[0]?.getText(file) === 'ChatApp'
      ) {
        const props = node.arguments[1];
        if (props !== undefined && ts.isObjectLiteralExpression(props))
          for (const property of props.properties)
            if (ts.isPropertyAssignment(property) && property.name.getText(file) === 'reports')
              handed.push(property.initializer.getText(file));
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
    expect(handed).toEqual(['ctx.reports']);
  });
});
