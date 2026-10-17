import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { createClient, createSessionStore, runMigrations } from '@relavium/db';
import { AgentSchema, RunOrSessionEventSchema } from '@relavium/shared';
import { expect, it, vi } from 'vitest';

import { buildChatSession, buildResumedChatSession } from '../chat/session-host.js';
import type { SessionWorkOwner } from '../chat/session-work-owner.js';
import { scriptedResolver, textTurn } from '../chat/test-support.js';
import { CliError, toUserFacing } from '../process/errors.js';
import { invocationFixture } from '../process/invocation.test-support.js';
import { captureIo } from '../test-support.js';
import { chatCommand, chatResumeCommand, driveJson } from './chat.js';

const cases = (['fresh', 'resumed'] as const).flatMap((entry) => [
  ...(['eof', 'exit', 'cancel'] as const).flatMap((ending) =>
    (['owned', 'ownerless', 'terminal-fault'] as const).map((mode) => ({ entry, ending, mode })),
  ),
  ...(['owned', 'terminal-fault'] as const).map((mode) => ({
    entry,
    ending: 'sigint' as const,
    mode,
  })),
]);

it.each(cases)(
  '$entry $ending $mode keeps real terminal custody',
  async ({ entry, ending, mode }) => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'relavium-json-terminal-')));
    const home = join(dir, 'home');
    mkdirSync(home);
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
    const client = createClient(':memory:');
    runMigrations(client.db);
    const store = createSessionStore(client.db);
    const f = invocationFixture();
    const captured = captureIo();
    const providers = scriptedResolver([textTurn('TERMINAL_PRECEDING_REPLY')]);
    const provider = providers.resolveProvider('anthropic');
    if (provider === undefined) throw new Error('Expected offline provider.');
    const stream = vi.spyOn(provider, 'stream');
    const cause = new CliError('output_unavailable', '');
    const faulted = mode === 'terminal-fault';
    const input =
      ending === 'sigint'
        ? new PassThrough()
        : Readable.from([ending === 'eof' ? 'hello\n' : `hello\n/${ending}\n`]);
    if (input instanceof PassThrough) input.write('hello\n');
    let interrupt: (() => void) | undefined;
    let owner: SessionWorkOwner | undefined;
    let sessionId = 'resumed-terminal';
    let ordinal = 0;
    let closes = 0;
    let terminalWrites = 0;
    let durableReplies = 0;
    let durableStatus: string | undefined;
    const iso = '2026-10-17T00:00:00.000Z';
    const agent = AgentSchema.parse({
      id: 'terminal',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      system_prompt: 'offline',
    });
    store.createSession({
      id: sessionId,
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
    try {
      const deps = {
        ...(mode === 'ownerless' ? {} : { invocation: f.invocation }),
        io: {
          ...captured.io,
          stdin: input,
          writeOut: (text: string) => {
            const event = RunOrSessionEventSchema.parse(JSON.parse(text));
            if (event.type === 'session:cancelled') {
              terminalWrites++;
              if (faulted) throw cause;
            }
            captured.io.writeOut(text);
          },
        },
        global: {
          cwd: dir,
          json: true,
          color: false,
          configPath: join(dir, 'absent-global.toml'),
          verbosity: 'normal' as const,
        },
        providers,
        now: () => Date.parse(iso),
        uuid: () => `terminal-${++ordinal}`,
        buildSession: async (options: Parameters<typeof buildChatSession>[0]) => {
          owner = options.workOwner;
          const built = await buildChatSession(options);
          sessionId = built.sessionId;
          return built;
        },
        buildResumedSession: (options: Parameters<typeof buildResumedChatSession>[0]) => {
          owner = options.workOwner;
          return buildResumedChatSession(options);
        },
        openSessionStore: () => ({
          db: client.db,
          store,
          close: () => {
            const row = store.loadFull(sessionId);
            durableReplies =
              row?.messages.filter((message) => message.role === 'assistant').length ?? 0;
            durableStatus = row?.session.status;
            closes++;
            client.sqlite.close();
          },
        }),
        lifecycle: {
          onProcessExit: () => () => {},
          onInterrupt: (listener: () => void) => {
            interrupt = listener;
            return () => {
              interrupt = undefined;
            };
          },
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
        drive: (context: Parameters<typeof driveJson>[0]) =>
          driveJson({
            ...context,
            processLine: async (line, display) => {
              await context.processLine(line, display);
              if (ending === 'sigint') {
                expect(interrupt).toBeDefined();
                interrupt?.();
              }
            },
          }),
      };
      const result = await (
        entry === 'fresh'
          ? chatCommand({ agent: undefined }, deps)
          : chatResumeCommand({ sessionId }, deps)
      ).catch((failure: unknown) => {
        expect(failure).toBe(cause);
        return toUserFacing(failure).exitCode;
      });
      expect(result, 'JSON_TERMINAL_ORIGINAL_OUTCOME').toBe(faulted ? 9 : 4);
      expect(terminalWrites, 'JSON_TERMINAL_ATTEMPTED_EXACTLY_ONCE').toBe(1);
      const events = captured
        .out()
        .trim()
        .split('\n')
        .map((line) => RunOrSessionEventSchema.parse(JSON.parse(line)));
      expect(
        events.filter((event) => event.type === 'session:cancelled'),
        'JSON_TERMINAL_REAL_DELIVERY',
      ).toHaveLength(faulted ? 0 : 1);
      if (!faulted) expect(events.at(-1)?.type).toBe('session:cancelled');
      expect(events.every((event) => 'sessionId' in event && event.sessionId === sessionId)).toBe(
        true,
      );
      expect(stream).toHaveBeenCalledOnce();
      expect(durableReplies).toBe(1);
      expect(durableStatus).toBe('ended');
      expect(closes).toBe(1);
      expect(client.sqlite.open).toBe(false);
      expect(owner !== undefined).toBe(mode !== 'ownerless');
      if (faulted) {
        const failure = owner?.firstFailure?.cause;
        expect(failure).toBeInstanceOf(CliError);
        if (!(failure instanceof CliError))
          throw new Error('Expected original output classification.');
        expect(failure.code).toBe('output_unavailable');
        expect(failure.cause).toBe(cause);
      } else expect(owner?.firstFailure).toBeUndefined();
      expect(f.registry.termination !== undefined).toBe(faulted);
      expect(f.registry.activeOwners).toBe(0);
    } finally {
      input.destroy();
      stream.mockRestore();
      if (client.sqlite.open) client.sqlite.close();
      vi.unstubAllEnvs();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
