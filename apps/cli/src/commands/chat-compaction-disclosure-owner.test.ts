import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient, createSessionStore, runMigrations } from '@relavium/db';
import { AgentSchema } from '@relavium/shared';
import { expect, it, vi } from 'vitest';
import { chatCommand, chatResumeCommand, type ChatCommandDeps } from './chat.js';
import { buildChatSession, buildResumedChatSession } from '../chat/session-host.js';
import type { SessionWorkOwner } from '../chat/session-work-owner.js';
import { scriptedResolver, textTurn } from '../chat/test-support.js';
import { invocationFixture } from '../process/invocation.test-support.js';
import { acknowledgeWrite } from '../process/io.js';
import { captureIo, OwnedTtyOutput } from '../test-support.js';

/** Actual Writable acknowledgement, with only its native callback schedule controlled. */
class HeldOutput extends OwnedTtyOutput {
  #complete: ((error?: Error) => void) | undefined;
  #released = false;

  override _write(
    _chunk: unknown,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    if (this.#released) {
      callback();
      return;
    }
    this.#complete = (error) => {
      this.#complete = undefined;
      this.#released = true;
      callback(error);
    };
  }

  release(error?: Error): void {
    this.#complete?.(error);
  }
}

const nativeTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

const outcomes = [
  { cancel: false, failedDelivery: false },
  { cancel: false, failedDelivery: true },
  { cancel: true, failedDelivery: false },
  { cancel: true, failedDelivery: true },
] as const;
const cases = (['fresh', 'resume'] as const).flatMap((surface) => [
  ...outcomes.map((outcome) => ({ surface, ...outcome, continueAfterCancel: false })),
  { surface, cancel: true, failedDelivery: false, continueAfterCancel: true },
]);

it.each(cases)(
  '$surface chat retains compaction delivery: cancel=$cancel failedDelivery=$failedDelivery continue=$continueAfterCancel',
  async ({ surface, cancel, failedDelivery, continueAfterCancel }) => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'relavium-compaction-owner-')));
    const client = createClient(':memory:');
    runMigrations(client.db);
    const store = createSessionStore(client.db);
    if (surface === 'resume') {
      const stamp = '2026-10-17T00:00:00.000Z';
      const agent = AgentSchema.parse({
        id: 'compaction-owner',
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        system_prompt: 'Offline acknowledgement fixture.',
      });
      store.createSession({
        id: 'compaction-history',
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
      for (let seq = 0; seq < 4; seq++) {
        store.appendMessage({
          id: `history-${seq}`,
          sessionId: 'compaction-history',
          sequenceNumber: seq,
          role: seq % 2 === 0 ? 'user' : 'assistant',
          content: [{ type: 'text', text: `persisted message ${seq}` }],
          timestamp: stamp,
        });
      }
    }
    const output = new HeldOutput();
    const f = invocationFixture();
    const { io } = captureIo();
    const priorCalls = surface === 'fresh' ? 2 : 0;
    const scripts =
      surface === 'fresh'
        ? [
            textTurn('first persisted answer'),
            textTurn('second persisted answer'),
            textTurn(continueAfterCancel ? 'third admitted answer' : 'summary'),
          ]
        : [textTurn(continueAfterCancel ? 'third admitted answer' : 'summary')];
    const providers = scriptedResolver(scripts);
    const provider = providers.resolveProvider('anthropic');
    if (provider === undefined) throw new Error('The scripted provider must exist.');
    const stream = vi.spyOn(provider, 'stream');
    let enterDelivery = () => {};
    const deliveryEntered = new Promise<void>((resolve) => {
      enterDelivery = resolve;
    });
    let leaveDriver = () => {};
    const driverLeft = new Promise<void>((resolve) => {
      leaveDriver = resolve;
    });
    let owner: SessionWorkOwner | undefined;
    let closes = 0;
    let finished = false;
    let escaped: unknown;
    let id = 0;
    const dependencies: ChatCommandDeps = {
      invocation: f.invocation,
      io: {
        ...io,
        writeErrAcknowledged: (text) => {
          const acknowledgement = acknowledgeWrite(output, text);
          enterDelivery();
          return acknowledgement;
        },
      },
      global: {
        cwd: dir,
        configPath: join(dir, 'absent.toml'),
        json: false,
        color: false,
        verbosity: 'normal',
      },
      providers,
      buildSession: (options) => {
        owner = options.workOwner;
        return buildChatSession(options);
      },
      buildResumedSession: (options) => {
        owner = options.workOwner;
        return buildResumedChatSession(options);
      },
      now: () => 0,
      uuid: () => `compaction-owner-${++id}`,
      openSessionStore: () => ({
        store,
        db: client.db,
        close: () => {
          closes++;
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
      drive: async (context) => {
        context.startSession();
        await context.onActivated?.(() => !context.shouldStop());
        if (surface === 'fresh') {
          await context.processLine('one');
          await context.processLine('two');
        }
        const compaction = context.processLine('/compact');
        await deliveryEntered;
        if (cancel) context.onAbort?.();
        await compaction;
        if (continueAfterCancel) await context.processLine('three');
        if (!context.shouldStop()) await context.processLine('/exit');
        leaveDriver();
        return { kind: 'exit' };
      },
    };
    const run =
      surface === 'fresh'
        ? chatCommand({ agent: undefined }, dependencies)
        : chatResumeCommand({ sessionId: 'compaction-history' }, dependencies);
    const action = run.then(
      (code) => {
        finished = true;
        return code;
      },
      (cause: unknown) => {
        escaped = cause;
        finished = true;
        return f.registry.observations.exitCode();
      },
    );
    try {
      await deliveryEntered;
      // Cancellation must release the interactive compaction wait even while delivery stays owed.
      if (cancel) await driverLeft;
      await nativeTurn();
      expect(finished, 'COMPACTION_NATIVE_DELIVERY_REMAINS_OWNED').toBe(false);
      expect(closes).toBe(0);
      expect(client.sqlite.open).toBe(true);
      expect(f.registry.activeOwners).toBeGreaterThan(0);
      expect(output.listenerCount('error')).toBe(1);
      expect(output.listenerCount('close')).toBe(1);
      expect(stream).toHaveBeenCalledTimes(priorCalls + (continueAfterCancel ? 1 : 0));
      if (continueAfterCancel) {
        expect(
          client.sqlite
            .prepare(
              'SELECT count(*) AS count FROM session_messages WHERE role = ? AND content_parts LIKE ?',
            )
            .get('assistant', '%third admitted answer%'),
        ).toEqual({ count: 1 });
      }

      output.release(failedDelivery ? new Error('SYNTHETIC_PRIVATE_NATIVE_WRITE') : undefined);
      expect(await action).toBe(failedDelivery ? 9 : 4);
      await nativeTurn();
      expect(closes).toBe(1);
      expect(client.sqlite.open).toBe(false);
      expect(f.registry.activeOwners).toBe(0);
      expect(f.registry.observations.exitCode()).toBe(failedDelivery ? 9 : 4);
      expect(owner?.firstFailure?.cause).toEqual(
        failedDelivery ? expect.objectContaining({ code: 'output_unavailable' }) : undefined,
      );
      if (escaped !== undefined) expect(owner?.isStoppedFailure(escaped)).toBe(true);
      if (!failedDelivery) expect(escaped).toBeUndefined();
      expect(output.listenerCount('error')).toBe(0);
      expect(output.listenerCount('close')).toBe(0);
      expect(stream).toHaveBeenCalledTimes(
        priorCalls + (continueAfterCancel || (!cancel && !failedDelivery) ? 1 : 0),
      );
    } finally {
      output.release();
      await action;
      output.destroy();
      if (client.sqlite.open) client.sqlite.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
