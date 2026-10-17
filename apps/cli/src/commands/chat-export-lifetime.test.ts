import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient, createSessionStore, runMigrations } from '@relavium/db';
import { AgentSchema } from '@relavium/shared';
import { expect, it, vi } from 'vitest';
import { chatExportCommand } from './chat-export.js';
import { CommandLifetime } from '../process/command-lifetime.js';
import { invocationFixture } from '../process/invocation.test-support.js';
import { CliError, toUserFacing } from '../process/errors.js';
import { captureIo } from '../test-support.js';

it.each(['unexpected_native_clock', 'known_storage_refusal'] as const)(
  'owned post-write provenance: %s',
  async (mode) => {
    const dir = mkdtempSync(join(tmpdir(), 'relavium-r10-export-'));
    const client = createClient(':memory:');
    let closed = false;
    try {
      runMigrations(client.db);
      const store = createSessionStore(client.db);
      const iso = '2026-10-17T00:00:00.000Z';
      store.createSession({
        id: 'r10-export',
        agentSlug: 'reviewer',
        agentSnapshot: AgentSchema.parse({
          id: 'reviewer',
          provider: 'anthropic',
          model: 'fixture',
          system_prompt: 'offline',
        }),
        context: { workingDir: dir, fsScopeTier: 'sandboxed' },
        status: 'active',
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCostMicrocents: 0,
        totalConservativeMicrocents: 0,
        createdAt: iso,
        updatedAt: iso,
      });
      const captured = captureIo();
      const fixture = invocationFixture();
      const lifetime = new CommandLifetime(fixture.invocation, captured.io, () => () => {});
      let rawCause: unknown;
      // eslint-disable-next-line @typescript-eslint/unbound-method -- The captured native method is explicitly invoked with its original Date receiver below.
      const nativeToISOString = Date.prototype.toISOString;
      const timestampObserver = vi
        .spyOn(Date.prototype, 'toISOString')
        .mockImplementation(function (this: Date) {
          try {
            return nativeToISOString.call(this);
          } catch (cause) {
            rawCause = cause;
            throw cause;
          }
        });
      let clockCalls = 0;
      let updateCalls = 0;
      const actualUpdate = store.updateSession.bind(store);
      store.updateSession = (record) => {
        updateCalls += 1;
        if (mode === 'known_storage_refusal') {
          rawCause = new CliError('storage_unavailable', '');
          throw rawCause;
        }
        actualUpdate(record);
      };
      let failed: unknown;
      const result = await lifetime
        .execute(() =>
          Promise.resolve(
            chatExportCommand(
              { sessionId: 'r10-export', force: false },
              {
                commandLifetime: lifetime,
                io: lifetime.io,
                global: {
                  cwd: dir,
                  json: false,
                  color: false,
                  configPath: undefined,
                  verbosity: 'normal',
                },
                now: () => {
                  clockCalls += 1;
                  if (mode === 'unexpected_native_clock') {
                    // The actual production update timestamp invokes native toISOString with this clock value.
                    return Number.NaN;
                  }
                  return Date.parse(iso);
                },
                openSessionStore: (_home, captureClose) => {
                  const close = () => {
                    client.sqlite.close();
                    closed = true;
                  };
                  captureClose?.(close);
                  return { store, db: client.db, close };
                },
              },
            ),
          ),
        )
        .catch((cause: unknown) => {
          failed = cause;
          return toUserFacing(cause).exitCode;
        });
      expect(readFileSync(join(dir, 'r10-export.relavium.yaml'), 'utf8')).toContain('reviewer');
      expect(captured.err().includes('could not mark the session exported')).toBe(
        mode === 'known_storage_refusal',
      );
      expect(result).toBe(mode === 'unexpected_native_clock' ? 9 : 0);
      expect(fixture.registry.termination !== undefined).toBe(mode === 'unexpected_native_clock');
      if (mode === 'unexpected_native_clock')
        expect(toUserFacing(failed).code).toBe('cli_internal');
      expect(fixture.registry.activeOwners).toBe(0);
      expect(closed).toBe(true);
      expect(updateCalls).toBe(mode === 'unexpected_native_clock' ? 0 : 1);
      expect(clockCalls).toBe(1);
      expect(toUserFacing(rawCause).code).toBe(
        mode === 'unexpected_native_clock' ? 'cli_internal' : 'storage_unavailable',
      );
      if (mode === 'unexpected_native_clock') expect(rawCause).toBeInstanceOf(RangeError);
      timestampObserver.mockRestore();
    } finally {
      vi.restoreAllMocks();
      if (!closed) client.sqlite.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
