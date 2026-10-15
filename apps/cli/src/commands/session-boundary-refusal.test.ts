import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createClient,
  createSessionStore,
  runMigrations,
  SessionMessageBoundaryError,
} from '@relavium/db';
import { AgentSchema } from '@relavium/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { scriptedResolver } from '../chat/test-support.js';
import { toUserFacing } from '../process/errors.js';
import { EXIT_CODES } from '../process/exit-codes.js';
import type { GlobalOptions } from '../process/options.js';
import { renderError } from '../process/render-error.js';
import { captureIo } from '../test-support.js';
import { chatResumeCommand } from './chat.js';
import { chatExportCommand } from './chat-export.js';

const timestamp = '2026-06-25T00:00:00.000Z';
const agent = AgentSchema.parse({
  id: 'reader',
  model: 'claude-sonnet-4-6',
  provider: 'anthropic',
  system_prompt: 'Read carefully.',
});

describe('session message boundary refusals at CLI commands', () => {
  let cwd: string;
  let client: ReturnType<typeof createClient>;
  let store: ReturnType<typeof createSessionStore>;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'relavium-session-refusal-'));
    client = createClient(':memory:');
    runMigrations(client.db);
    store = createSessionStore(client.db);
    store.createSession({
      id: 's1',
      agentSlug: agent.id,
      agentSnapshot: agent,
      context: { workingDir: realpathSync.native(cwd), fsScopeTier: 'sandboxed' },
      status: 'active',
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCostMicrocents: 0,
      totalConservativeMicrocents: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    store.appendMessage({
      id: 'm1',
      sessionId: 's1',
      sequenceNumber: 0,
      role: 'user',
      content: [{ type: 'text', text: 'retained ordinary text' }],
      timestamp,
    });
  });
  afterEach(() => {
    client.sqlite.close();
    rmSync(cwd, { recursive: true, force: true });
  });

  function options(json: boolean): GlobalOptions {
    return { json, color: false, cwd, configPath: undefined, verbosity: 'normal' };
  }

  it('still exports a healthy transcript', () => {
    const { io, out } = captureIo();
    expect(
      chatExportCommand(
        { sessionId: 's1', force: false },
        {
          io,
          global: options(false),
          openSessionStore: () => ({ store, db: client.db, close: () => undefined }),
        },
      ),
    ).toBe(EXIT_CODES.success);
    expect(out()).toContain('Exported session s1');
    expect(existsSync(join(cwd, 's1.relavium.yaml'))).toBe(true);
  });

  it('still resumes a healthy transcript', async () => {
    const { io } = captureIo();
    expect(
      await chatResumeCommand(
        { sessionId: 's1' },
        {
          io,
          global: options(false),
          providers: scriptedResolver([]),
          openSessionStore: () => ({ store, db: client.db, close: () => undefined }),
          drive: async (ctx) => {
            ctx.startSession();
            await ctx.onActivated?.(() => !ctx.shouldStop());
            return { kind: 'exit' };
          },
        },
      ),
    ).toBe(EXIT_CODES.chatEnded);
  });

  for (const corrupt of ['message_invalid', 'metadata_invalid'] as const) {
    for (const command of ['chat-resume', 'chat-export'] as const) {
      for (const json of [false, true]) {
        it(`${command} renders ${corrupt} as a safe ${json ? 'JSON' : 'plain'} refusal without mutation`, async () => {
          const poison = 'PRIVATE_SESSION_CONTENT_AND_PROPERTY';
          if (corrupt === 'message_invalid') {
            client.sqlite
              .prepare('UPDATE session_messages SET content_parts = ? WHERE id = ?')
              .run(
                `[{"type":"text","text":"${poison}"}, {"type":"unexpected","value":"${poison}"}]`,
                'm1',
              );
          } else {
            client.sqlite
              .prepare('UPDATE session_messages SET content = ? WHERE id = ?')
              .run(poison, 'm1');
          }
          const before = client.sqlite
            .prepare('SELECT * FROM session_messages WHERE id = ?')
            .get('m1');
          const { io, out, err } = captureIo();
          const global = options(json);
          const openSessionStore = () => ({ store, db: client.db, close: () => undefined });
          let thrown: unknown;
          try {
            if (command === 'chat-resume') {
              await chatResumeCommand({ sessionId: 's1' }, { io, global, openSessionStore });
            } else {
              chatExportCommand(
                { sessionId: 's1', force: false },
                { io, global, openSessionStore },
              );
            }
          } catch (error) {
            thrown = error;
          }
          expect(thrown).toBeInstanceOf(SessionMessageBoundaryError);
          expect(toUserFacing(thrown).exitCode).toBe(EXIT_CODES.invalidInvocation);
          renderError(thrown, { json, verbose: false }, io);
          expect(out()).toBe('');
          expect(err()).not.toContain(poison);
          if (json) {
            expect(JSON.parse(err())).toEqual({
              type: 'error',
              code: 'invalid_invocation',
              message:
                'A session message has an invalid persistence format. Restore a safe history backup or start a new session.',
            });
          } else {
            expect(err()).toBe(
              'relavium: A session message has an invalid persistence format. Restore a safe history backup or start a new session.\n',
            );
          }
          expect(
            client.sqlite.prepare('SELECT * FROM session_messages WHERE id = ?').get('m1'),
          ).toEqual(before);
          expect(store.loadSession('s1')?.status).toBe('active');
          expect(existsSync(join(cwd, 's1.relavium.yaml'))).toBe(false);
        });
      }
    }
  }
});
