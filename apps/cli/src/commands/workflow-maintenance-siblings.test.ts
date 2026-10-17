import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createClient,
  createMediaReferenceStore,
  createRunHistoryStore,
  FilesystemMediaStore,
  runMigrations,
} from '@relavium/db';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { sweepHostMediaBestEffort } from '../engine/media-gc.js';
import { invocationFixture } from '../process/invocation.test-support.js';
import { captureIo } from '../test-support.js';
import { runCommand } from './run.js';

const reads = vi.hoisted(() => ({ afterRead: vi.fn<(path: string) => Promise<void>>() }));
vi.mock('node:fs/promises', async (original) => {
  const native = await original<typeof import('node:fs/promises')>();
  return {
    ...native,
    readdir: async (...args: Parameters<typeof native.readdir>) => {
      const raw = native.readdir(...args);
      // The fixture holds the adapter continuation after starting the real native read.
      void raw.catch(() => undefined);
      await reads.afterRead(String(args[0]));
      return raw;
    },
  };
});

beforeEach(() => {
  reads.afterRead.mockResolvedValue(undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  reads.afterRead.mockReset();
});

function deferred() {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const handle = (digit: string) => 'media://sha256-' + digit.repeat(64);

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'relavium-maintenance-siblings-')));
  const client = createClient();
  runMigrations(client.db);
  const configPath = join(root, 'config.toml');
  const workflow = join(root, 'maintenance.relavium.yaml');
  writeFileSync(configPath, '');
  writeFileSync(
    workflow,
    JSON.stringify({
      schema_version: '1.0',
      workflow: {
        id: 'maintenance-siblings',
        nodes: [
          { id: 'input', type: 'input' },
          { id: 'out', type: 'output' },
        ],
        edges: [{ from: 'input', to: 'out' }],
      },
    }),
  );
  const owned = invocationFixture();
  const casRoot = join(root, 'cas');
  const state = { settled: false, closes: 0 };
  return {
    client,
    owned,
    casRoot,
    state,
    start() {
      const action = runCommand(
        { workflow, input: [], allowMcpStdio: [] },
        {
          invocation: owned.invocation,
          subscribeSignals: () => () => undefined,
          io: captureIo().io,
          global: { cwd: root, configPath, json: true, color: false, verbosity: 'normal' },
          providers: {
            resolveProvider: () => {
              throw new Error('No provider is needed.');
            },
            keyFor: () => {
              throw new Error('No key is needed.');
            },
          },
          openRunStore: (definition, _home, _cwd, captureClose) => {
            const close = () => {
              state.closes += 1;
              client.sqlite.close();
            };
            captureClose?.(close);
            return {
              db: client.db,
              close,
              terminalOutboxPath: join(root, 'outbox'),
              store: createRunHistoryStore(client.db, {
                uuid: randomUUID,
                now: Date.now,
                workflow: {
                  slug: definition.workflow.id,
                  name: definition.workflow.id,
                  definitionJson: JSON.stringify(definition),
                },
              }),
            };
          },
          sweepMedia: (args) =>
            sweepHostMediaBestEffort({
              ...args,
              casRoot,
              graceMs: 0,
              orphanMinAgeMs: 0,
              now: () => 10_000,
            }),
        },
      ).then((code) => {
        state.settled = true;
        return code;
      });
      void action.catch(() => undefined);
      return action;
    },
    dispose() {
      if (client.sqlite.open) client.sqlite.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

const deletionCases = (['grace', 'orphan'] as const).flatMap((batch) =>
  (['healthy', 'rejected', 'synchronous'] as const).map((outcome) => ({ batch, outcome })),
);
it.each(deletionCases)(
  '$batch GC joins entered deletions through a $outcome sibling',
  async ({ batch, outcome }) => {
    const f = fixture();
    const entered = deferred();
    const held = deferred();
    const handles = [handle('a'), handle('b')];
    if (batch === 'grace') {
      const refs = createMediaReferenceStore(f.client.db, () => 0);
      for (const value of handles)
        refs.recordObject({
          handle: value,
          mimeType: 'audio/L16',
          modality: 'audio',
          byteLength: 2,
        });
    }
    const listing = vi
      .spyOn(FilesystemMediaStore.prototype, 'listHandles')
      .mockResolvedValue(
        batch === 'orphan' ? handles.map((value) => ({ handle: value, mtimeMs: 0 })) : [],
      );
    let calls = 0;
    let completed = 0;
    const deletion = vi.spyOn(FilesystemMediaStore.prototype, 'delete').mockImplementation(() => {
      calls += 1;
      if (calls === 1) {
        entered.resolve();
        return held.promise.then(() => {
          completed += 1;
        });
      }
      if (outcome === 'synchronous') throw new Error('Synthetic deletion entry refusal.');
      return outcome === 'rejected'
        ? Promise.reject(new Error('Synthetic deletion refusal.'))
        : Promise.resolve();
    });
    const action = f.start();
    try {
      await entered.promise;
      await tick();
      expect(calls).toBe(2);
      expect(completed).toBe(0);
      expect(f.state.settled, 'GC_DELETE_SIBLINGS_BEFORE_WORKFLOW_RELEASE').toBe(false);
      expect(f.state.closes).toBe(0);
      expect(f.client.sqlite.open).toBe(true);
      expect(f.owned.registry.activeOwners).toBeGreaterThan(0);
    } finally {
      held.resolve();
      try {
        await action;
      } finally {
        deletion.mockRestore();
        listing.mockRestore();
        f.dispose();
      }
    }
    expect(completed).toBe(1);
    expect(await action).toBe(0);
    expect(f.state.closes).toBe(1);
    expect(f.owned.registry.activeOwners).toBe(0);
  },
);

it.each([false, true])(
  'default GC joins shard continuation when a sibling rejects=%s',
  async (fail) => {
    const f = fixture();
    const entered = deferred();
    const held = deferred();
    mkdirSync(join(f.casRoot, 'aa'), { recursive: true });
    mkdirSync(join(f.casRoot, 'bb'), { recursive: true });
    writeFileSync(join(f.casRoot, 'aa', '0'.repeat(62)), 'inert young orphan');
    reads.afterRead.mockImplementation(async (path) => {
      if (path === join(f.casRoot, 'aa')) {
        entered.resolve();
        await held.promise;
      }
      if (path === join(f.casRoot, 'bb') && fail)
        throw Object.assign(new Error('Synthetic shard refusal.'), { code: 'EIO' });
    });
    const action = f.start();
    try {
      await entered.promise;
      await tick();
      expect(f.state.settled, 'GC_SHARD_SIBLINGS_BEFORE_WORKFLOW_RELEASE').toBe(false);
      expect(f.state.closes).toBe(0);
      expect(f.client.sqlite.open).toBe(true);
      expect(f.owned.registry.activeOwners).toBeGreaterThan(0);
    } finally {
      held.resolve();
      try {
        await action;
      } finally {
        f.dispose();
      }
    }
    expect(await action).toBe(0);
    expect(f.state.closes).toBe(1);
    expect(f.owned.registry.activeOwners).toBe(0);
  },
);
