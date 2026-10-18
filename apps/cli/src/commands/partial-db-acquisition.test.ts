import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { dbFaultAcquisitionCases } from './db-fault-acquisition.test-support.js';

const runCase = dbFaultAcquisitionCases();
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
  it.each([
    ...routes.flatMap((route) =>
      [false, true].map((closeFails) => ({ ...route, closeFails, closeRecovers: false })),
    ),
    {
      id: 'logs',
      positionals: ['synthetic-run'],
      options: {},
      closeFails: true,
      closeRecovers: true,
    },
  ])(
    '$id joins actual SQLite after setup fails; close failure=$closeFails; retry recovers=$closeRecovers',
    ({ id, positionals, options, closeFails, closeRecovers }) =>
      runCase({ prefix: 'relavium-partial-db-', closeFails, closeRecovers }, async (fixture) => {
        const { root, assertCurrent } = fixture;
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
        fixture.disposeCommand(async () => {
          // Stop admission before any pending route import resumes. A proved failed
          // native close intentionally has no product ACK; harness disposal below is distinct.
          void f.registry.terminate({ kind: 'infrastructure', code: 'cli_internal' });
          f.advance(3_000);
          if (!fixture.native()?.sqlite.open) await outcome;
        });
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(captured.out()).toBe('');
        expect(f.registry.observations.exitCode()).toBe(9);
        expect(f.registry.budget.deadline()).toBe(3_000);
        if (closeFails && !closeRecovers) {
          expect(settled, 'PARTIAL_DATABASE_FAILURE_RETAINS_ACTUAL_NATIVE_CLOSE').toBe(false);
          expect(fixture.native()?.sqlite.open).toBe(true);
          expect(f.registry.activeOwners).toBe(1);
          expect(removeSignals).not.toHaveBeenCalled();
          expect(fixture.closeAttempts()).toBe(2); // Opener's immediate release and adopted actual-handle cleanup.
          f.advance(3_000);
          expect(await f.invocation.finiteExit.exited).toBe(9);
          expect(f.registry.activeOwners).toBe(1);
          expect(fixture.native()?.sqlite.open).toBe(true);
        } else {
          expect(await outcome).toMatchObject({ code: 'cli_internal', exitCode: 9 });
          expect(fixture.native()?.sqlite.open).toBe(false);
          expect(f.registry.activeOwners).toBe(0);
          expect(removeSignals).toHaveBeenCalledOnce();
          expect(fixture.closeAttempts(), 'COMMAND_LIFETIME_RETRIES_EXACT_NATIVE_CLOSE').toBe(
            closeRecovers ? 2 : 1,
          );
        }
      }),
  );
});
