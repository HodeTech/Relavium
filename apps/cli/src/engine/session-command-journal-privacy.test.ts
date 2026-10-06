import {
  AgentSession,
  createAbortController,
  createToolRegistry,
  RunEventBus,
  createSessionEventSink,
  createSessionHandle,
  type ToolDef,
} from '@relavium/core';
import { describe, expect, it } from 'vitest';
import {
  AgentSchema,
  SessionContextSchema,
  type EffectCorrelation,
  type RunOrSessionEvent,
} from '@relavium/shared';
import {
  createClient,
  runMigrations,
  createEffectJournalStore,
  createEffectJournalPort,
} from '@relavium/db';

describe('R12 independent native SQLite plus actual session command registry privacy', () => {
  it('same session command result stays out of the native journal and committed identity refuses replay', async () => {
    const client = createClient();
    try {
      runMigrations(client.db);
      let ids = 0,
        calls = 0,
        turn = 0;
      const sentinel = 'R12_SYNTHETIC_PRIVATE_COMMAND_RESULT_987654';
      const store = createEffectJournalStore(client.db, {
        uuid: () => `r12-effect-${++ids}`,
        now: () => 6,
      });
      const rows: RunOrSessionEvent[] = [];
      const bus = new RunEventBus({ now: () => '2026-10-06T00:00:00.000Z' });
      bus.subscribe((e) => rows.push(e));
      const tool: ToolDef = {
        id: 'run_command',
        source: 'builtin',
        description: 'offline result counterfactual',
        llmVisibleParams: { type: 'object' },
        parseArgs: (x) => x,
        policy: { fsScoped: false, spawnsProcess: false, requiresGateApproval: false },
        effect: () => 1,
        dispatch: () => {
          calls++;
          return Promise.resolve({ exitCode: 0, stdout: sentinel, stderr: '', durationMs: 1 });
        },
      };
      const session = new AgentSession({
        sessionId: 'r12-native',
        agentRef: 'a',
        agent: AgentSchema.parse({
          id: 'a',
          provider: 'openai',
          model: 'r12-no-provider',
          system_prompt: 'offline',
        }),
        context: SessionContextSchema.parse({ workingDir: '/offline', fsScopeTier: 'sandboxed' }),
        deps: {
          resolveProvider: () => undefined,
          keyFor: () => {
            throw new Error('No provider permitted');
          },
          sleep: () => Promise.resolve(),
          newAbortController: createAbortController,
          tools: [tool],
          registry: createToolRegistry({ tools: [tool], host: {} }),
          reserveEffectTurnKey: () => ++turn,
          effects: (c) =>
            createEffectJournalPort(store, c, { providerAttempt: 1, toolCallId: 'fallback' }),
          emit: createSessionEventSink(bus, 'r12-native'),
          autoCompact: false,
        },
      });
      const handle = createSessionHandle(bus, 'r12-native', () => session.cancel());
      const primary: RunOrSessionEvent[] = [];
      const consume = (async () => {
        for await (const e of handle.events) primary.push(e);
      })();
      session.start();
      const outcome = await session.runUserCommand('local-only', []);
      session.cancel();
      await consume;
      expect(outcome.kind).toBe('ran');
      expect(calls).toBe(1);
      expect(primary).toEqual(rows);
      const correlation: EffectCorrelation = { kind: 'session', sessionId: 'r12-native', turn: 1 };
      expect(store.recordsFor(correlation)).toMatchObject([{ state: 'committed', tier: 1 }]);
      expect(store.recordsFor(correlation)[0]).not.toHaveProperty('result');
      expect(client.sqlite.prepare('SELECT result_json FROM run_effects').all()).toEqual([
        { result_json: null },
      ]);
      expect(client.sqlite.serialize().includes(Buffer.from(sentinel))).toBe(false);
      const port = createEffectJournalPort(store, correlation, {
        providerAttempt: 2,
        toolCallId: 'attempted-replay',
      });
      await expect(
        port.prepare(-1, 'run_command', 1, { command: 'local-only', args: [] }, undefined),
      ).rejects.toMatchObject({ name: 'EffectConflictError' });
      expect(calls).toBe(1);
    } finally {
      client.sqlite.close();
    }
  });
});
