import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

let rawCase: Promise<void> | undefined;
let currentSignal: AbortSignal | undefined;
beforeEach((context) => {
  currentSignal = context.signal;
});
afterEach(async () => {
  // A Vitest deadline rejects its wrapper, not this scenario's late module continuation.
  // Do not let the next case replace mocks/environment before the raw case cleans up.
  await rawCase?.catch(() => undefined);
  rawCase = undefined;
});
beforeAll(async () => {
  // Source transformation is setup; the unchanged five-second case tests native custody.
  await import('./dispatch.js');
  await import('./gate.js');
});

const routes = [
  { id: 'gate.list', positionals: [], options: {} },
  { id: 'list', positionals: [], options: {} },
  { id: 'logs', positionals: ['synthetic-run'], options: {} },
  { id: 'status', positionals: ['synthetic-run'], options: {} },
  { id: 'chat-list', positionals: [], options: {} },
  { id: 'chat-export', positionals: ['synthetic-session'], options: {} },
  { id: 'models', positionals: [], options: {} },
  {
    id: 'models.pricing',
    positionals: ['synthetic-model'],
    options: { provider: 'anthropic', clear: true },
  },
  { id: 'provider.list', positionals: [], options: {} },
];

describe('management custody before local database setup', () => {
  it.each(routes.flatMap((route) => [false, true].map((closeFails) => ({ ...route, closeFails }))))(
    '$id joins actual SQLite after setup fails; close failure=$closeFails',
    ({ id, positionals, options, closeFails }) => {
      const signal = currentSignal;
      if (signal === undefined) throw new Error('Synthetic case context was not captured');
      rawCase = (async () => {
        const root = mkdtempSync(join(tmpdir(), 'relavium-partial-db-'));
        let sealed = false;
        const assertCurrent = (): void => {
          signal.throwIfAborted();
          if (sealed) throw new Error('Synthetic database case no longer admits work');
        };
        let disposeCommand: (() => Promise<void>) | undefined;
        let opened: ReturnType<typeof import('@relavium/db').createClient> | undefined;
        const nativeDisposals = new Set<() => void>();
        let primary: { readonly cause: unknown } | undefined;
        const failures: unknown[] = [];
        try {
          const actual = await import('@relavium/db');
          assertCurrent();
          let closeAttempts = 0;
          const setupFailure = new Error('synthetic database setup failure');
          const closeFailure = new Error('synthetic native close failure');
          vi.stubEnv('HOME', root);
          vi.stubEnv('USERPROFILE', root);
          writeFileSync(join(root, 'config.toml'), '');
          mkdirSync(join(root, '.relavium', 'workflows'), { recursive: true });
          writeFileSync(
            join(root, '.relavium', 'workflows', 'synthetic.relavium.yaml'),
            `schema_version: '1.0'
workflow:
  id: synthetic
  nodes:
    - { id: start, type: input }
    - { id: end, type: output }
  edges:
    - { from: start, to: end }
`,
          );
          vi.doMock('@relavium/db', () => ({
            ...actual,
            createClient: (...args: Parameters<typeof actual.createClient>) => {
              assertCurrent();
              const client = actual.createClient(...args);
              opened = client;
              const nativeClose = client.sqlite.close.bind(client.sqlite);
              nativeDisposals.add(() => {
                if (client.sqlite.open) nativeClose();
              });
              client.sqlite.close = () => {
                closeAttempts++;
                if (closeFails) throw closeFailure;
                return nativeClose();
              };
              return client;
            },
            runMigrations: () => {
              throw setupFailure;
            },
          }));
          vi.resetModules();
          const { executeCommand } = await import('./dispatch.js');
          assertCurrent();
          const { CommandLifetime } = await import('../process/command-lifetime.js');
          assertCurrent();
          const { invocationFixture } = await import('../process/invocation.test-support.js');
          assertCurrent();
          const { captureIo } = await import('../test-support.js');
          assertCurrent();
          const f = invocationFixture();
          const captured = captureIo();
          const removeSignals = vi.fn();
          const lifetime = new CommandLifetime(f.invocation, captured.io, () => removeSignals);
          let settled = false;
          const command = lifetime.execute(() =>
            executeCommand(
              id,
              { positionals, options },
              {
                io: lifetime.io,
                invocation: f.invocation,
                commandLifetime: lifetime,
                global: {
                  cwd: root,
                  configPath: join(root, 'config.toml'),
                  json: true,
                  color: false,
                  verbosity: 'normal',
                },
              },
            ),
          );
          const outcome = command.then(
            (value) => {
              settled = true;
              return value;
            },
            (cause: unknown) => {
              settled = true;
              return cause;
            },
          );
          disposeCommand = async () => {
            // Stop admission before any pending route import resumes. A proved failed
            // native close intentionally has no product ACK; harness disposal below is distinct.
            void f.registry.terminate({ kind: 'infrastructure', code: 'cli_internal' });
            f.advance(3_000);
            if (!opened?.sqlite.open) await outcome;
          };
          await new Promise<void>((resolve) => setImmediate(resolve));
          expect(captured.out()).toBe('');
          expect(f.registry.observations.exitCode()).toBe(9);
          expect(f.registry.budget.deadline()).toBe(3_000);
          if (closeFails) {
            expect(settled, 'PARTIAL_DATABASE_FAILURE_RETAINS_ACTUAL_NATIVE_CLOSE').toBe(false);
            expect(opened?.sqlite.open).toBe(true);
            expect(f.registry.activeOwners).toBe(1);
            expect(removeSignals).not.toHaveBeenCalled();
            expect(closeAttempts).toBe(2); // Opener's immediate release and adopted actual-handle cleanup.
            f.advance(3_000);
            expect(await f.invocation.finiteExit.exited).toBe(9);
            expect(f.registry.activeOwners).toBe(1);
            expect(opened?.sqlite.open).toBe(true);
          } else {
            expect(await outcome).toMatchObject({ code: 'cli_internal', exitCode: 9 });
            expect(opened?.sqlite.open).toBe(false);
            expect(f.registry.activeOwners).toBe(0);
            expect(removeSignals).toHaveBeenCalledOnce();
            expect(closeAttempts).toBe(1);
          }
        } catch (cause) {
          primary = { cause };
        } finally {
          sealed = true;
          try {
            await disposeCommand?.();
          } catch (cause) {
            failures.push(cause);
          }
          // Every exact captured native handle is administrative disposal, never a product ACK.
          for (const close of nativeDisposals) {
            try {
              close();
            } catch (cause) {
              failures.push(cause);
            }
          }
          for (const cleanup of [
            () => vi.doUnmock('@relavium/db'),
            () => vi.resetModules(),
            () => vi.unstubAllEnvs(),
            () => rmSync(root, { recursive: true, force: true }),
          ]) {
            try {
              cleanup();
            } catch (cause) {
              failures.push(cause);
            }
          }
        }
        if (primary !== undefined) throw primary.cause;
        if (failures.length !== 0)
          throw new AggregateError(failures, 'Synthetic database fixture cleanup failed');
      })();
      return rawCase;
    },
  );
});
