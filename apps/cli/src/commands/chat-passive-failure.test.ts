import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createClient, createSessionStore, runMigrations } from '@relavium/db';
import { AgentSchema } from '@relavium/shared';
import { expect, it, vi } from 'vitest';
import { chatResumeCommand, drivePlain, driveJson, type ChatDriveContext } from './chat.js';
import { driveInk } from '../render/tui/chat-ink.js';
import { invocationFixture } from '../process/invocation.test-support.js';
import { CliError } from '../process/errors.js';
import { acknowledgeWrite, type CliIo } from '../process/io.js';
import { scriptedResolver, textTurn } from '../chat/test-support.js';
import { OwnedTtyInput, OwnedTtyOutput } from '../test-support.js';
const flush = () => new Promise<void>((r) => setImmediate(r));
it.each(['plain', 'json', 'ink'] as const)(
  'actual owned chat resume %s passive subscriber faults versus clean control',
  async (mode) => {
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
        env: {},
        stdoutIsTty: mode === 'ink',
        stdinIsTty: mode === 'ink',
        stdin: mode === 'ink' ? input : Readable.from(['hello\n/exit\n']),
        ...(mode === 'ink'
          ? { nativeStdin: input, nativeStdout: output, nativeStderr: stderr }
          : {}),
        writeOut: (text) => {
          if (faulted && mode !== 'ink' && faultHits === 0 && text.includes('SUBSCRIBER_REPLY')) {
            faultHits++;
            throw new CliError('output_unavailable', '');
          }
          out.push(text);
        },
        writeErr: (text) => {
          err.push(text);
        },
        writeOutAcknowledged: async (text) => {
          if (mode === 'ink') await acknowledgeWrite(output, text);
          else out.push(text);
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
              json: mode === 'json',
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
            drive:
              mode === 'json'
                ? driveJson
                : mode === 'plain'
                  ? drivePlain
                  : async (ctx: ChatDriveContext) => {
                      const apply = ctx.store.apply.bind(ctx.store);
                      const spy = vi.spyOn(ctx.store, 'apply').mockImplementation((event) => {
                        if (faulted && event.type === 'session:turn_started') {
                          faultHits++;
                          throw new Error('synthetic projection invariant');
                        }
                        apply(event);
                      });
                      const driving = driveInk(ctx);
                      try {
                        await flush();
                        await flush();
                        await ctx.processLine('hello');
                        await flush();
                        expect(f.registry.termination !== undefined).toBe(faulted);
                        spy.mockRestore();
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
        expect(durableReplies).toBe(faulted ? 0 : 1);
        expect(f.registry.termination !== undefined).toBe(faulted);
        expect(f.registry.activeOwners).toBe(0);
        expect(faultHits).toBe(faulted ? 1 : 0);
        expect(err.join('')).not.toContain('background handler failed');
        if (!faulted && mode !== 'ink') expect(out.join('')).toContain('SUBSCRIBER_REPLY');
      } finally {
        vi.restoreAllMocks();
        input.destroy();
        output.destroy();
        stderr.destroy();
        if (client.sqlite.open) client.sqlite.close();
        rmSync(dir, { recursive: true, force: true });
      }
    }
  },
);
