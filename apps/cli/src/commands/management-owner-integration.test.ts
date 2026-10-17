import { mkdtempSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient, runMigrations, createProviderStore } from '@relavium/db';
import type { LlmProvider, ModelListing } from '@relavium/llm';
import { describe, expect, it, vi } from 'vitest';
import { invocationFixture } from '../process/invocation.test-support.js';
import { CommandLifetime } from '../process/command-lifetime.js';
import { CliError } from '../process/cli-error.js';
import { captureIo, CHAT_TEXT_CAPABILITY_FLAGS } from '../test-support.js';
import { withModelsDeps, type ModelsDbPorts } from './dispatch.js';
import { createCommand } from './create.js';

const reactions = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
function gate() {
  let release: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
const global = {
  json: false,
  color: false,
  cwd: tmpdir(),
  configPath: undefined,
  verbosity: 'normal',
} as const;

describe('actual management dispatch ownership', () => {
  it.each(['signal', 'catalog-failure'] as const)(
    'retains the real SQLite handle behind sibling discovery on %s',
    async (end) => {
      const f = invocationFixture();
      const client = createClient(':memory:');
      runMigrations(client.db);
      const { io, out } = captureIo();
      const child = gate();
      const entered = gate();
      let providerSignal: unknown;
      const provider: LlmProvider = {
        id: 'anthropic',
        supports: CHAT_TEXT_CAPABILITY_FLAGS,
        generate: () => Promise.reject(new Error('not used')),
        stream: () => {
          throw new Error('not used');
        },
        listModels: async (_key, signal): Promise<ModelListing[]> => {
          providerSignal = signal;
          entered.release();
          await child.promise;
          return [{ id: 'synthetic-after-stop', displayName: 'Synthetic' }];
        },
      };
      const close = vi.fn();
      let catalogSignal: AbortSignal | undefined;
      const ports: ModelsDbPorts = {
        openDb: () => ({ db: client.db, close }),
        makeResolver: () => ({
          resolveProvider: () => provider,
          keyFor: (id) => {
            if (id !== 'anthropic') throw new CliError('invalid_invocation', 'no configured key');
            return 'synthetic-key';
          },
        }),
        refreshCatalog: (_home, _persist, lifecycle) => {
          const signal: unknown = Object.getOwnPropertyDescriptor(lifecycle ?? {}, 'signal')?.value;
          catalogSignal = signal instanceof AbortSignal ? signal : undefined;
          return end === 'catalog-failure'
            ? Promise.reject(new Error('PRIVATE_LOCAL_CATALOG_FAULT'))
            : Promise.resolve({ status: 'refreshed', models: 1, added: 0 });
        },
      };
      const command = withModelsDeps(
        { io, global, invocation: f.invocation },
        { refresh: true },
        ports,
      );
      // Observe either outcome before triggering native stop; no unhandled test promise.
      const outcome = command.then(
        (value) => ({ value }),
        (cause: unknown) => ({ cause }),
      );
      try {
        await entered.promise;
        if (end === 'signal') f.invocation.finiteExit.signal(15);
        await reactions();
        expect(catalogSignal).toBeInstanceOf(AbortSignal);
        expect(catalogSignal?.aborted).toBe(true);
        expect(providerSignal).toMatchObject({ aborted: true });
        expect(client.sqlite.open).toBe(true);
        expect(close, 'MANAGEMENT_DATABASE_WAITS_FOR_RAW_SIBLING').not.toHaveBeenCalled();
        expect(f.registry.activeOwners).toBe(1);
        expect(f.registry.observations.exitCode()).toBe(end === 'signal' ? 143 : 9);
        child.release();
        const result = await outcome;
        if (end === 'catalog-failure')
          expect(result).toMatchObject({ cause: { code: 'cli_internal' } });
        expect(close).toHaveBeenCalledOnce();
        expect(out()).toBe('');
        expect(
          createProviderStore(client.db, { uuid: () => 'unused', now: () => 0 }).get('anthropic'),
        ).toBeUndefined();
      } finally {
        child.release();
        await outcome;
        client.sqlite.close();
      }
    },
  );

  it('does not publish a scaffold when an injected wizard answer arrives after stop', async () => {
    const f = invocationFixture();
    const cwd = mkdtempSync(join(tmpdir(), 'relavium-owned-create-'));
    mkdirSync(join(cwd, '.relavium'));
    const { io } = captureIo();
    const lifetime = new CommandLifetime(f.invocation, io, () => () => undefined);
    const answer = gate();
    const command = lifetime.execute(() =>
      createCommand(
        { force: false },
        {
          io: lifetime.io,
          global: { ...global, cwd },
          commandLifetime: lifetime,
          prompter: {
            gather: async () => {
              await answer.promise;
              return {
                kind: 'agent',
                name: 'Late Answer',
                provider: 'anthropic',
                model: 'synthetic',
                systemPrompt: 'Synthetic',
                tools: [],
              };
            },
          },
        },
      ),
    );
    try {
      f.invocation.finiteExit.signal(15);
      answer.release();
      await command;
      expect(
        existsSync(join(cwd, '.relavium', 'agents', 'late-answer.agent.yaml')),
        'CREATE_LATE_ANSWER_CANNOT_WRITE',
      ).toBe(false);
      expect(f.registry.activeOwners).toBe(0);
    } finally {
      answer.release();
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
