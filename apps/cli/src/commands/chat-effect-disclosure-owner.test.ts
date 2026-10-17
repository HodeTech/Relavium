import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createClient,
  createSessionStore,
  createEffectJournalStore,
  runMigrations,
} from '@relavium/db';
import { AgentSchema } from '@relavium/shared';
import { expect, it } from 'vitest';
import { chatResumeCommand } from './chat.js';
import { scriptedResolver } from '../chat/test-support.js';
import { invocationFixture } from '../process/invocation.test-support.js';
import { captureIo } from '../test-support.js';
import { CliError, toUserFacing } from '../process/errors.js';

const cases = [
  { owned: true, mode: 'healthy' },
  { owned: true, mode: 'throw' },
  { owned: true, mode: 'reject' },
  { owned: true, mode: 'held' },
  { owned: false, mode: 'healthy' },
  { owned: false, mode: 'throw' },
  { owned: false, mode: 'reject' },
] as const;
it.each(cases)(
  'actual resumed disclosure retains original output: owned=$owned mode=$mode',
  async ({ owned, mode }) => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'relavium-disclosure-owner-')));
    const client = createClient(':memory:');
    runMigrations(client.db);
    const store = createSessionStore(client.db);
    const f = invocationFixture();
    const captured = captureIo();
    const agent = AgentSchema.parse({
      id: 'notice-review',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      system_prompt: 'offline',
    });
    const stamp = '2026-10-17T00:00:00.000Z';
    store.createSession({
      id: 'notice-session',
      agentSlug: agent.id,
      agentSnapshot: agent,
      context: { workingDir: dir, fsScopeTier: 'sandboxed' },
      status: 'ended',
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCostMicrocents: 0,
      totalConservativeMicrocents: 0,
      createdAt: stamp,
      updatedAt: stamp,
    });
    const turn = store.reserveEffectTurnKey('notice-session');
    const journal = createEffectJournalStore(client.db, {
      uuid: () => 'notice-effect',
      now: () => 0,
    });
    const identity = { scope: `session:notice-session:${turn}`, slot: 0, toolId: 'run_command' };
    journal.prepare(
      identity,
      { kind: 'session', sessionId: 'notice-session', turn },
      { providerAttempt: 1, toolCallId: `session-tool:${turn}:0` },
      3,
      'digest',
    );
    journal.settle(identity, 'committed');
    let writes = 0;
    let closes = 0;
    let settle = false;
    let heldStarted = false;
    let enter = () => {};
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let retained: unknown;
    const action = chatResumeCommand(
      { sessionId: 'notice-session' },
      {
        ...(owned ? { invocation: f.invocation } : {}),
        io: {
          ...captured.io,
          writeErrAcknowledged: () => {
            writes++;
            enter();
            if (mode === 'healthy') return Promise.resolve();
            if (mode === 'held' || writes > 2) {
              heldStarted = true;
              return held;
            }
            const cause = new CliError('output_unavailable', '', {
              cause: new Error('SYNTHETIC_PRIVATE_DISCLOSURE_SINK'),
            });
            if (mode === 'throw') throw cause;
            return Promise.reject(cause);
          },
        },
        global: {
          cwd: dir,
          json: false,
          color: false,
          configPath: join(dir, 'absent.toml'),
          verbosity: 'normal',
        },
        providers: scriptedResolver([]),
        now: () => 0,
        uuid: () => 'notice-message',
        openSessionStore: () => ({
          db: client.db,
          store,
          close: () => {
            closes++;
            retained = client.sqlite.prepare('SELECT COUNT(*) AS count FROM run_effects').get();
            client.sqlite.close();
          },
        }),
        lifecycle: {
          onProcessExit: () => () => {},
          onInterrupt: () => () => {},
          onTerminationSignal: () => () => {},
          setRawMode: () => {},
          exit: () => {},
        },
        drive: async (ctx) => {
          ctx.startSession();
          await ctx.onActivated?.(() => !ctx.shouldStop());
          await ctx.processLine('/exit');
          return { kind: 'exit' };
        },
      },
    ).then(
      (value) => {
        settle = true;
        return { kind: 'value' as const, value };
      },
      (cause: unknown) => {
        settle = true;
        return { kind: 'failure' as const, cause };
      },
    );
    try {
      expect(await Promise.race([entered.then(() => 'notice'), action.then(() => 'command')])).toBe(
        'notice',
      );
      if (mode === 'held') {
        expect(settle, 'ACTUAL_DISCLOSURE_WRITE_MUST_JOIN_BEFORE_COMMAND_COMPLETION').toBe(false);
        expect(closes).toBe(0);
        expect(f.registry.activeOwners).toBeGreaterThan(0);
        release();
      }
      const outcome = await action;
      if (owned && (mode === 'throw' || mode === 'reject')) {
        expect(
          f.registry.observations.infrastructureCode(),
          'DISCLOSURE_FAILURE_REACHES_ORIGINAL_INVOCATION',
        ).toBe('output_unavailable');
        expect(f.registry.termination).toBeDefined();
        expect(writes, 'STOP_DOES_NOT_START_AN_UNOWNED_WARNING_TAIL').toBe(1);
        expect(heldStarted).toBe(false);
        // Command adapters classify an escaping stopped marker through the same fixed exit boundary.
        expect(
          outcome.kind === 'failure' ? toUserFacing(outcome.cause).exitCode : outcome.value,
        ).toBe(9);
      } else {
        expect(outcome).toEqual({ kind: 'value', value: 4 });
        expect(f.registry.observations.infrastructureCode()).toBeUndefined();
        expect(writes).toBe(mode === 'throw' || mode === 'reject' ? 3 : 1);
        expect(heldStarted).toBe(mode !== 'healthy');
      }
      expect(closes).toBe(1);
      expect(f.registry.activeOwners).toBe(0);
      expect(retained, 'NO_FAILED_DISCLOSURE_DELETES_ITS_AUDIT_ROW').toEqual({
        count: mode === 'throw' || mode === 'reject' ? 1 : 0,
      });
      expect(captured.out() + captured.err()).not.toContain('SYNTHETIC_PRIVATE_DISCLOSURE_SINK');
    } finally {
      release();
      await action;
      await f.registry.terminate({ kind: 'normal' });
      if (client.sqlite.open) client.sqlite.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
