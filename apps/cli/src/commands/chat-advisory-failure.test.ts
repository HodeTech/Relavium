import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createClient, createSessionStore, runMigrations } from '@relavium/db';
import { AgentSchema } from '@relavium/shared';
import { expect, it, vi } from 'vitest';

import { buildResumedChatSession } from '../chat/session-host.js';
import type { SessionWorkOwner } from '../chat/session-work-owner.js';
import { scriptedResolver, textTurn } from '../chat/test-support.js';
import { CliError, toUserFacing } from '../process/errors.js';
import { invocationFixture } from '../process/invocation.test-support.js';
import { captureIo } from '../test-support.js';
import { chatResumeCommand, driveJson, drivePlain } from './chat.js';

const cases = (['plain', 'json'] as const).flatMap((mode) =>
  (['budget', 'unpriced', 'effort'] as const).map((notice) => ({ mode, notice })),
);

it.each(cases)(
  'owned $mode $notice notification failure versus healthy command',
  async ({ mode, notice }) => {
    for (const faulted of [false, true]) {
      const dir = realpathSync(mkdtempSync(join(tmpdir(), 'relavium-advisory-owner-')));
      const client = createClient(':memory:');
      runMigrations(client.db);
      const store = createSessionStore(client.db);
      const f = invocationFixture();
      const captured = captureIo();
      const cause = new CliError('output_unavailable', '');
      const providers = scriptedResolver([textTurn('ADVISORY_REPLY')]);
      const provider = providers.resolveProvider('anthropic');
      if (provider === undefined) throw new Error('Expected offline provider.');
      const stream = vi.spyOn(provider, 'stream');
      let owner: SessionWorkOwner | undefined;
      let faultHits = 0;
      let closed = 0;
      let durableReplies = 0;
      let id = 0;
      const pattern =
        notice === 'budget'
          ? 'budget warning'
          : notice === 'unpriced'
            ? 'has no price'
            : 'needs a larger max_tokens';
      const agent = AgentSchema.parse({
        id: 'advisory',
        provider: 'anthropic',
        model:
          notice === 'unpriced'
            ? 'synthetic-uncatalogued'
            : notice === 'effort'
              ? 'claude-haiku-4-5'
              : 'claude-sonnet-4-6',
        ...(notice === 'effort' ? { reasoning_effort: 'high', max_tokens: 10 } : {}),
        system_prompt: 'offline',
      });
      const iso = '2026-10-17T00:00:00.000Z';
      store.createSession({
        id: 'advisory-session',
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
      mkdirSync(join(dir, '.relavium'));
      writeFileSync(
        join(dir, '.relavium', 'project.toml'),
        '[chat]\nmax_cost_microcents = 1\non_exceed = "warn"\n',
      );
      try {
        const result = await chatResumeCommand(
          { sessionId: 'advisory-session' },
          {
            invocation: f.invocation,
            io: {
              ...captured.io,
              stdin: Readable.from(['hello\n/exit\n']),
              writeErr: (text) => {
                if (faulted && text.includes(pattern)) {
                  faultHits++;
                  throw cause;
                }
                captured.io.writeErr(text);
              },
            },
            global: {
              cwd: dir,
              json: mode === 'json',
              color: false,
              configPath: join(dir, 'absent-global.toml'),
              verbosity: 'normal',
            },
            providers,
            now: () => Date.parse(iso),
            uuid: () => `advisory-message-${++id}`,
            buildResumedSession: (options) => {
              owner = options.workOwner;
              return buildResumedChatSession(options);
            },
            openSessionStore: () => ({
              db: client.db,
              store,
              close: () => {
                durableReplies =
                  store.loadFull('advisory-session')?.messages.filter((m) => m.role === 'assistant')
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
            drive: mode === 'json' ? driveJson : drivePlain,
          },
        ).catch((failure: unknown) => {
          expect(failure).toBe(cause);
          return toUserFacing(failure).exitCode;
        });
        expect(owner).toBeDefined();
        expect(result, 'ADVISORY_ORIGINAL_OWNER_OUTCOME').toBe(faulted ? 9 : 4);
        expect(owner?.firstFailure?.cause, 'ADVISORY_ORIGINAL_CAUSE').toBe(
          faulted ? cause : undefined,
        );
        expect(faultHits).toBe(faulted ? 1 : 0);
        expect(stream).toHaveBeenCalledTimes(faulted ? 0 : 1);
        expect(durableReplies).toBe(faulted ? 0 : 1);
        expect(closed).toBe(1);
        expect(client.sqlite.open).toBe(false);
        expect(f.registry.termination !== undefined).toBe(faulted);
        expect(f.registry.activeOwners).toBe(0);
        if (!faulted) {
          expect(captured.err()).toContain(pattern);
          expect(captured.out()).toContain('ADVISORY_REPLY');
        }
      } finally {
        stream.mockRestore();
        if (client.sqlite.open) client.sqlite.close();
        rmSync(dir, { recursive: true, force: true });
      }
    }
  },
);
