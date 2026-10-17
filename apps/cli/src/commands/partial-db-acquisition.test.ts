import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

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
    async ({ id, positionals, options, closeFails }) => {
      const root = mkdtempSync(join(tmpdir(), 'relavium-partial-db-'));
      const actual = await import('@relavium/db');
      let opened: ReturnType<typeof actual.createClient> | undefined;
      let release: (() => void) | undefined;
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
          const client = actual.createClient(...args);
          opened = client;
          const nativeClose = client.sqlite.close.bind(client.sqlite);
          release = () => {
            nativeClose();
          };
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
      try {
        const { executeCommand } = await import('./dispatch.js');
        const { CommandLifetime } = await import('../process/command-lifetime.js');
        const { invocationFixture } = await import('../process/invocation.test-support.js');
        const { captureIo } = await import('../test-support.js');
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
      } finally {
        if (opened?.sqlite.open) release?.(); // Harness disposal never acknowledges the failed owner.
        vi.doUnmock('@relavium/db');
        vi.resetModules();
        vi.unstubAllEnvs();
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
