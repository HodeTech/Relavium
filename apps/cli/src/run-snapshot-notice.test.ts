import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { parseWorkflow, WorkflowEngine } from '@relavium/core';
import { createClient } from '@relavium/db';
import { RunEventSchema } from '@relavium/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { run } from './run.js';
import { captureIo } from './test-support.js';

const isolated = vi.hoisted(() => ({ home: '' }));
vi.mock('./secrets/os-keychain.js', () => ({
  createOsKeychainStore: () => ({ get: () => null, set: () => {}, delete: () => false }),
}));
vi.mock('node:os', async (original) => ({
  ...(await original<typeof import('node:os')>()),
  homedir: () => isolated.home,
}));

const AUTHORED = 'sk-nativeAuthoredSnapshotSynthetic123456789';
const INPUT = 'sk-nativeRuntimeInputSynthetic987654321';
const YAML = `schema_version: '1.0'
workflow:
  id: snapshot-native
  metadata:
    arbitraryPrivateProperty: '${AUTHORED}'
    preserved: [ordinary, '{{secrets.placeholder}}']
  inputs:
    - { name: token, type: secret, required: true }
  nodes:
    - { id: start, type: input }
    - { id: first, type: human_gate, gate_type: approval }
    - { id: second, type: human_gate, gate_type: approval }
    - { id: out, type: output }
  edges:
    - { from: start, to: first }
    - { from: first, to: second }
    - { from: second, to: out }
`;

function installStdin(): void {
  Object.defineProperty(process, 'stdin', {
    configurable: true,
    value: {
      isTTY: false,
      async *[Symbol.asyncIterator]() {
        yield await Promise.resolve(Buffer.from(`token=${INPUT}`));
      },
    },
  });
}

function nativeSnapshot(directory: string) {
  const client = createClient(join(directory, '.relavium', 'history.db'));
  try {
    const row: unknown = client.sqlite
      .prepare('SELECT id, workflow_definition_snapshot FROM runs')
      .get();
    if (
      typeof row !== 'object' ||
      row === null ||
      !('id' in row) ||
      typeof row.id !== 'string' ||
      !('workflow_definition_snapshot' in row) ||
      typeof row.workflow_definition_snapshot !== 'string'
    ) {
      throw new Error('missing native snapshot evidence');
    }
    const definition: unknown = JSON.parse(row.workflow_definition_snapshot);
    const persistedEvents = client.sqlite
      .prepare('SELECT payload_json FROM run_events ORDER BY seq')
      .all();
    return { runId: row.id, definition, persistedEvents };
  } finally {
    client.sqlite.close();
  }
}

const childHome = process.env['RELAVIUM_SNAPSHOT_TEST_HOME'];
const childRunId = process.env['RELAVIUM_SNAPSHOT_TEST_RUN_ID'];
const childMismatch = process.env['RELAVIUM_SNAPSHOT_TEST_MISMATCH'] === 'true';

describe('native authored snapshot warning and resume identity', () => {
  let directory: string;
  let stdinDescriptor: PropertyDescriptor | undefined;
  beforeEach(() => {
    directory = childHome ?? mkdtempSync(join(tmpdir(), 'relavium-snapshot-native-'));
    isolated.home = directory;
    vi.stubEnv('HOME', directory);
    vi.stubEnv('USERPROFILE', directory);
    stdinDescriptor = Object.getOwnPropertyDescriptor(process, 'stdin');
    installStdin();
  });
  afterEach(() => {
    if (stdinDescriptor !== undefined) Object.defineProperty(process, 'stdin', stdinDescriptor);
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    if (childHome === undefined) rmSync(directory, { recursive: true, force: true });
  });

  if (childHome !== undefined) {
    it('fresh process resumes only the identical frozen authored definition', async () => {
      if (childRunId === undefined) throw new Error('missing owned child run id');
      if (childMismatch) {
        // Inject a changed caller copy at the real engine seam. The durable native snapshot
        // stays untouched; the engine must compare it and release its acquired lease on refusal.
        // eslint-disable-next-line @typescript-eslint/unbound-method -- Called only with the real engine receiver below.
        const original = WorkflowEngine.prototype.resumeFromCheckpoint;
        vi.spyOn(WorkflowEngine.prototype, 'resumeFromCheckpoint').mockImplementation(function (
          this: WorkflowEngine,
          input,
        ) {
          return original.call(this, {
            ...input,
            workflow: {
              ...input.workflow,
              workflow: {
                ...input.workflow.workflow,
                metadata: { arbitraryPrivateProperty: 'changed-caller-copy' },
              },
            },
          });
        });
      }
      const capture = captureIo();
      const exit = await run(
        [
          'node',
          'relavium',
          '--cwd',
          directory,
          'gate',
          childRunId,
          '--approve',
          '--secret-stdin',
          '--json',
        ],
        capture.io,
      );
      expect(exit, 'SNAPSHOT_NATIVE_STRICT_RESUME_IDENTITY').toBe(childMismatch ? 2 : 3);
      if (childMismatch) {
        expect(capture.err()).toContain('cannot resume run');
      } else {
        const events = capture
          .out()
          .trim()
          .split('\n')
          .map((line) => RunEventSchema.parse(JSON.parse(line)));
        expect(events).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ type: 'human_gate:paused', nodeId: 'second' }),
          ]),
        );
      }
      expect(nativeSnapshot(directory).definition, 'SNAPSHOT_NATIVE_RESUME_FIDELITY').toEqual(
        parseWorkflow(YAML),
      );
      expect(capture.out() + capture.err()).not.toContain(AUTHORED);
      expect(capture.out() + capture.err()).not.toContain(INPUT);
    });
  } else {
    for (const json of [false, true]) {
      it(`warns on authored content and preserves native snapshot through a fresh process resume (${json ? 'json' : 'human'})`, async () => {
        const path = join(directory, 'workflow.relavium.yaml');
        writeFileSync(path, YAML);
        const capture = captureIo();
        expect(
          await run(
            [
              'node',
              'relavium',
              '--cwd',
              directory,
              'run',
              path,
              '--secret-inputs-stdin',
              ...(json ? ['--json'] : []),
            ],
            capture.io,
          ),
        ).toBe(3);
        expect(capture.err(), 'SNAPSHOT_NATIVE_RUN_NOTICE').toContain(
          '1 string(s) matching known credential shapes',
        );
        expect(capture.out()).not.toContain('Warning:');
        expect(capture.out() + capture.err()).not.toContain(AUTHORED);
        expect(capture.out() + capture.err()).not.toContain(INPUT);
        expect(capture.err()).not.toContain('arbitraryPrivateProperty');
        if (json) {
          const events = capture
            .out()
            .trim()
            .split('\n')
            .map((line) => RunEventSchema.parse(JSON.parse(line)));
          expect(events.at(-1)?.type).toBe('run:paused');
        }
        const paused = nativeSnapshot(directory);
        expect(paused.definition, 'SNAPSHOT_NATIVE_WRITE_FIDELITY').toEqual(parseWorkflow(YAML));
        expect(JSON.stringify(paused.persistedEvents)).not.toContain(AUTHORED);
        expect(JSON.stringify(paused.persistedEvents)).not.toContain(INPUT);

        // The source file is no longer needed: a distinct OS process rebuilds from native history.
        rmSync(path);
        await resumeInChild(directory, paused.runId, true);
        await resumeInChild(directory, paused.runId, false);
        const resumed = nativeSnapshot(directory);
        expect(resumed.definition).toEqual(paused.definition);
        expect(JSON.stringify(resumed.persistedEvents)).not.toContain(AUTHORED);
        expect(JSON.stringify(resumed.persistedEvents)).not.toContain(INPUT);
      }, 30_000);
    }
  }
});

async function resumeInChild(directory: string, runId: string, mismatch: boolean): Promise<void> {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
  const config = join(directory, 'snapshot-source.vitest.mjs');
  // Explicit source aliases make the separate process independent of workspace dist/build state.
  writeFileSync(
    config,
    `const root = ${JSON.stringify(root)};
export default { root, resolve: { alias: [
  { find: /^@relavium\\/llm\\/adapters$/, replacement: root + '/packages/llm/src/adapters/index.ts' },
  ...['llm', 'shared', 'core', 'db', 'mcp'].map(name => ({find: new RegExp('^@relavium/' + name + '$'), replacement: root + '/packages/' + name + '/src/index.ts'}))
] }, test: { environment: 'node', include: ['apps/cli/src/run-snapshot-notice.test.ts'], pool: 'forks', maxWorkers: 1, fileParallelism: false, cache: false } };`,
  );
  const require = createRequire(import.meta.url);
  const vitest = join(dirname(require.resolve('vitest/package.json')), 'vitest.mjs');
  const result = await promisify(execFile)(process.execPath, [vitest, 'run', '--config', config], {
    cwd: root,
    env: {
      ...process.env,
      RELAVIUM_SNAPSHOT_TEST_HOME: directory,
      RELAVIUM_SNAPSHOT_TEST_RUN_ID: runId,
      RELAVIUM_SNAPSHOT_TEST_MISMATCH: String(mismatch),
    },
    timeout: 20_000,
  });
  expect(result.stdout, 'SNAPSHOT_NATIVE_CHILD_COMPLETED').toContain('1 passed');
}
