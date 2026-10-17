import { mkdtemp } from 'node:fs/promises';
import { pendingTempDirCount } from '../render/editor.js';
vi.mock('node:fs/promises', { spy: true });
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient, createSessionStore, runMigrations } from '@relavium/db';
import { AgentSchema } from '@relavium/shared';
import { expect, it, vi } from 'vitest';
import { chatResumeCommand, type ChatDriveContext } from './chat.js';
import { driveInk } from '../render/tui/chat-ink.js';
import { invocationFixture } from '../process/invocation.test-support.js';
import { acknowledgeWrite, type CliIo } from '../process/io.js';
import { scriptedResolver, textTurn } from '../chat/test-support.js';
import { OwnedTtyInput, OwnedTtyOutput } from '../test-support.js';
const flush = () => new Promise<void>((r) => setImmediate(r));
it('actual owned /edit native temp creation fault versus missing editor control', async () => {
  for (const faulted of [false, true]) {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'relavium-r10-subscriber-')));
    const client = createClient(':memory:');
    runMigrations(client.db);
    const store = createSessionStore(client.db);
    const f = invocationFixture();
    const input = new OwnedTtyInput();
    const output = new OwnedTtyOutput();
    const stderr = new OwnedTtyOutput();
    let closed = 0;
    let faultHits = 0;
    let durableReplies = 0;
    let id = 0;
    const agent = AgentSchema.parse({
      id: 'reviewer',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      system_prompt: 'offline',
    });
    const iso = '2026-10-17T00:00:00.000Z';
    store.createSession({
      id: 'review-session',
      agentSlug: agent.id,
      agentSnapshot: agent,
      context: { workingDir: dir, fsScopeTier: 'sandboxed' },
      status: 'ended',
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCostMicrocents: 0,
      totalConservativeMicrocents: 0,
      createdAt: iso,
      updatedAt: iso,
    });
    const out: string[] = [];
    const err: string[] = [];
    const io: CliIo = {
      env: faulted ? { EDITOR: 'review-must-not-spawn' } : {},
      stdoutIsTty: true,
      stdinIsTty: true,
      stdin: input,
      nativeStdin: input,
      nativeStdout: output,
      nativeStderr: stderr,
      writeOut: (text) => {
        out.push(text);
      },
      writeErr: (text) => {
        err.push(text);
      },
      writeOutAcknowledged: async (text) => {
        await acknowledgeWrite(output, text);
      },
      writeErrAcknowledged: (text) => {
        err.push(text);
        return Promise.resolve();
      },
    };
    try {
      const result = await chatResumeCommand(
        { sessionId: 'review-session' },
        {
          invocation: f.invocation,
          io,
          global: {
            cwd: dir,
            json: false,
            color: false,
            configPath: join(dir, 'absent.toml'),
            verbosity: 'normal',
          },
          providers: scriptedResolver([textTurn('SUBSCRIBER_REPLY')]),
          now: () => 1750000000000,
          uuid: () => `r10-${++id}`,
          openSessionStore: () => ({
            db: client.db,
            store,
            close: () => {
              durableReplies =
                store.loadFull('review-session')?.messages.filter((m) => m.role === 'assistant')
                  .length ?? 0;
              closed++;
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
          jobControlLifecycle: {
            supported: false,
            onSuspend: () => () => {},
            onContinue: () => () => {},
            suspendSelf: () => {},
          },
          drive: async (ctx: ChatDriveContext) => {
            const beforeTemp = pendingTempDirCount();
            const driving = driveInk(ctx);
            try {
              await flush();
              await flush();
              await ctx.processLine('hello');
              await flush();
              if (faulted)
                vi.mocked(mkdtemp).mockImplementationOnce(() => {
                  faultHits++;
                  return Promise.reject(new TypeError('synthetic native temp invariant'));
                });
              await ctx.processLine('/edit');
              await flush();
              expect(f.registry.termination !== undefined).toBe(faulted);
              expect(pendingTempDirCount()).toBe(beforeTemp);
              if (!faulted)
                expect(
                  ctx.store
                    .getSnapshot()
                    .state.transcript.some((entry) => entry.text?.includes('set $EDITOR')),
                ).toBe(true);
            } finally {
              input.push('\x03');
              await flush();
              await driving;
            }
            return driving;
          },
        },
      );
      expect(result).toBe(faulted ? 9 : 4);
      expect(closed).toBe(1);
      expect(durableReplies).toBe(1);
      expect(f.registry.termination !== undefined).toBe(faulted);
      expect(f.registry.activeOwners).toBe(0);
      expect(faultHits).toBe(faulted ? 1 : 0);
      expect(err.join('')).not.toContain('background handler failed');
    } finally {
      vi.restoreAllMocks();
      input.destroy();
      output.destroy();
      stderr.destroy();
      if (client.sqlite.open) client.sqlite.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }
});
