import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, realpath, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createClient,
  createEffectJournalPort,
  createEffectJournalStore,
  runMigrations,
} from '@relavium/db';
import {
  BUILTIN_TOOLS,
  createToolRegistry,
  type FsCapability,
  type ToolDispatchContext,
} from '@relavium/core';
import { randomUUID } from 'node:crypto';
import { decodeRetainedEffectEnvelope } from '@relavium/shared';
import { ApprovalCache, buildTurnPolicy, type ApprovalPrompt } from '../../chat/chat-mode.js';
import { describe, expect, it, vi } from 'vitest';
import {
  PreparedReplayReceipt as Receipt,
  type ReplayOperation,
  type ReplayCut,
  type ReplayVariant,
} from './fixtures/prepared-replay-contract.js';

const worker = fileURLToPath(new URL('./fixtures/prepared-replay-worker.ts', import.meta.url));
const register = fileURLToPath(
  new URL('../fixtures/usage-coverage-crash-register.mjs', import.meta.url),
);
function start(
  root: string,
  mode: 'crash' | 'resume',
  identity?: ReturnType<typeof Receipt.parse>,
  variant: ReplayVariant = 'same',
  operation: ReplayOperation = 'edit',
  cut: ReplayCut = 'after-settle',
) {
  const child = spawn(
    process.execPath,
    [
      '--experimental-strip-types',
      '--no-warnings',
      '--import',
      register,
      worker,
      root,
      mode,
      identity?.runId ?? '',
      identity?.gateId ?? '',
      variant,
      operation,
      cut,
    ],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );
  let output = '',
    error = '';
  let announced = false;
  let resolveReady: (receipt: ReturnType<typeof Receipt.parse>) => void = () => undefined;
  let rejectReady: (error: Error) => void = () => undefined;
  const ready = new Promise<ReturnType<typeof Receipt.parse>>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    output += chunk;
    const match = /^(?:CUT|DONE) (.+)$/m.exec(output);
    if (match?.[1] !== undefined && !announced) {
      announced = true;
      try {
        resolveReady(Receipt.parse(JSON.parse(match[1])));
      } catch (cause) {
        rejectReady(cause instanceof Error ? cause : new Error('invalid worker receipt'));
      }
    }
  });
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    error += chunk;
  });
  // Deadline only bounds a hung worker. The explicit real-operation stdout receipt determines the kill cut.
  const deadline = setTimeout(() => {
    rejectReady(new Error(`prepared replay worker deadline: ${error}`));
    child.kill('SIGKILL');
  }, 15_000);
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null; error: string }>(
    (resolve) => {
      child.once('error', rejectReady);
      child.once('close', (code, signal) => {
        clearTimeout(deadline);
        if (!announced) rejectReady(new Error(`worker exited before receipt: ${error}\n${output}`));
        resolve({ code, signal, error });
      });
    },
  );
  return { child, ready, closed };
}
async function expectTarget(root: string, expected: string | null) {
  const result = readFile(join(root, 'workspace', 'target.txt'), 'utf8');
  if (expected === null) await expect(result).rejects.toMatchObject({ code: 'ENOENT' });
  else expect(await result).toBe(expected);
}
async function atCut(
  operation: ReplayOperation,
  cut: ReplayCut,
  variant: ReplayVariant,
  check: (receipt: ReturnType<typeof Receipt.parse>) => void,
) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'relavium-prepared-replay-')));
  let crashing: ReturnType<typeof start> | undefined;
  let resumed: ReturnType<typeof start> | undefined;
  const before = operation === 'create' ? null : 'old\n';
  const after = operation === 'append' ? 'old\nnew\n' : 'new\n';
  const committed = cut === 'after-settle';
  const published = cut !== 'after-claim';
  try {
    await mkdir(join(root, 'workspace'));
    if (before !== null) await writeFile(join(root, 'workspace', 'target.txt'), before);
    crashing = start(root, 'crash', undefined, 'same', operation, cut);
    const stopped = await crashing.ready;
    expect(stopped).toMatchObject({
      pid: crashing.child.pid,
      stage: 'cut',
      operation,
      cut,
      preparations: 1,
      executionCalls: published ? 1 : 0,
      publications: published ? 1 : 0,
      settlements: committed ? 1 : 0,
      providerCalls: 2,
      agentExecutions: 1,
    });
    crashing.child.kill('SIGKILL');
    await crashing.closed;
    await expectTarget(root, published ? after : before);
    let retainedResultJson: string | undefined;
    const db = createClient(join(root, 'history.db'));
    try {
      expect(db.sqlite.prepare('SELECT count(*) FROM run_effects').pluck().get()).toBe(1);
      expect(db.sqlite.prepare('SELECT state FROM run_effects').pluck().get()).toBe(
        committed ? 'committed' : 'prepared',
      );
      expect(
        db.sqlite
          .prepare(
            "SELECT count(*) FROM run_events WHERE event_type = 'node:completed' AND json_extract(payload_json,'$.nodeId') = 'work'",
          )
          .pluck()
          .get(),
      ).toBe(0);
      if (committed && variant !== 'malformed') {
        const raw: unknown = db.sqlite.prepare('SELECT result_json FROM run_effects').pluck().get();
        if (typeof raw !== 'string') throw new Error('missing retained native result');
        const envelope = decodeRetainedEffectEnvelope(JSON.parse(raw));
        if (envelope === undefined || !envelope.hasValue)
          throw new Error('unusable native result fixture');
        retainedResultJson = JSON.stringify(envelope.value);
      }
      if (variant === 'malformed')
        db.sqlite.exec('UPDATE run_effects SET result_json = \'{"v":1,"value":"old evidence"}\'');
    } finally {
      db.sqlite.close();
    }
    resumed = start(root, 'resume', stopped, variant, operation, cut);
    const result = await resumed.ready;
    const closed = await resumed.closed;
    expect(closed.code, closed.error).toBe(0);
    expect(result).toMatchObject({
      pid: resumed.child.pid,
      stage: 'resume',
      operation,
      cut,
      preparations: variant === 'reordered' ? 1 : 0,
      executionCalls: 0,
      publications: 0,
      settlements: 0,
    });
    const finalDb = createClient(join(root, 'history.db'));
    try {
      expect(finalDb.sqlite.prepare('SELECT count(*) FROM run_effects').pluck().get()).toBe(1);
    } finally {
      finalDb.sqlite.close();
    }
    await expectTarget(root, published ? after : before);
    if (result.status === 'completed') expect(result.deliveredResultJson).toBe(retainedResultJson);
    check(result);
  } finally {
    crashing?.child.kill('SIGKILL');
    if (crashing !== undefined) await crashing.closed;
    resumed?.child.kill('SIGKILL');
    if (resumed !== undefined) await resumed.closed;
    await rm(root, { recursive: true, force: true });
  }
}
describe.each(['edit', 'append', 'overwrite', 'create'] as const)(
  'real prepared %s WorkflowEngine/SQLite crash boundaries',
  (operation) => {
    for (const cut of ['after-claim', 'after-publication'] as const)
      it(`${cut}: unresolved evidence blocks before any fresh executor/provider or publication`, async () => {
        await atCut(operation, cut, 'same', (result) =>
          expect(result).toMatchObject({
            status: 'failed',
            code: 'effect_needs_attention',
            agentExecutions: 0,
            providerCalls: 0,
          }),
        );
      }, 30_000);
    it('after real settlement but before node checkpoint: fresh process delivers retained result without another native operation', async () => {
      await atCut(operation, 'after-settle', 'same', (result) =>
        expect(result).toMatchObject({ status: 'completed', agentExecutions: 1, providerCalls: 3 }),
      );
    }, 30_000);
    it('different regenerated same-slot arguments conflict without republishing', async () => {
      await atCut(operation, 'after-settle', 'mismatch', (result) =>
        expect(result).toMatchObject({
          status: 'failed',
          code: 'effect_needs_attention',
          agentExecutions: 1,
          providerCalls: 2,
        }),
      );
    }, 30_000);
    it('malformed valid-JSON retained evidence blocks before any executor/provider invocation', async () => {
      await atCut(operation, 'after-settle', 'malformed', (result) =>
        expect(result).toMatchObject({
          status: 'failed',
          code: 'effect_needs_attention',
          agentExecutions: 0,
          providerCalls: 0,
        }),
      );
    }, 30_000);
  },
);
it('different regenerated edit ordering obtains no saved result or new publication', async () => {
  await atCut('edit', 'after-settle', 'reordered', (result) =>
    expect(result).toMatchObject({
      status: 'failed',
      code: 'tool_failed',
      agentExecutions: 1,
      providerCalls: 1,
    }),
  );
}, 30_000);

describe('actual registry and CLI provisional approval cache', () => {
  it.each(['approve', 'reject'] as const)(
    'an atomic replay race with saved %s never commits the first always answer',
    async (savedAnswer) => {
      // This exercises the real registry/SQLite/CLI policy interaction; the owned FS is an in-process test
      // capability. Native metadata/publication behavior belongs to the separate child populations above.
      const db = createClient(':memory:');
      runMigrations(db.db);
      try {
        const store = createEffectJournalStore(db.db, { uuid: randomUUID, now: () => 100 });
        const correlation = {
          kind: 'run',
          runId: 'approval-race',
          nodeId: 'n',
          attempt: 1,
        } as const;
        const effects = createEffectJournalPort(store, correlation, {
          providerAttempt: 1,
          toolCallId: 'engine',
        });
        const cache = new ApprovalCache();
        let current = 'old\n',
          executions = 0;
        const fs: FsCapability = {
          readFile: () => Promise.reject(new Error('unused read')),
          writeFile: () => Promise.reject(new Error('blind fallback')),
          listDirectory: () => Promise.resolve({ entries: [] }),
          prepareWrite: (request) => {
            if (request.kind !== 'write') return Promise.reject(new Error('unexpected edit'));
            const before = current;
            return Promise.resolve({
              path: request.path,
              before,
              after: request.content,
              execute: () => {
                current = request.content;
                executions++;
                return Promise.resolve({
                  path: request.path,
                  bytesWritten: Buffer.byteLength(current, 'utf8'),
                });
              },
              release: () => undefined,
            });
          },
        };
        const registry = createToolRegistry({ tools: BUILTIN_TOOLS, host: { fs } });
        const base: ToolDispatchContext = {
          nodeId: 'n',
          grantedToolIds: new Set(['write_file']),
          config: {},
          toolPolicy: {},
          fsScope: 'sandboxed',
          gateApproved: false,
          effects,
          effectSlot: 0,
          effectAttempt: { providerAttempt: 1, toolCallId: 'engine-outer' },
        };
        const call = {
          type: 'tool_call',
          id: 'provider-outer',
          name: 'write_file',
          args: { path: 'target.txt', content: 'new\n' },
        } as const;
        const kinds: string[] = [];
        const prompt = vi.fn<ApprovalPrompt>(async (_request, cacheable, _signal, live) => {
          kinds.push(live?.preview.kind ?? 'missing');
          expect(cache.isAlways('write_file')).toBe(false);
          if (kinds.length === 1) {
            expect(cacheable).toBe(true);
            // A competing real registry dispatch wins the exact identity while the first card is pending.
            await registry.dispatch(
              { ...call, id: 'provider-winner' },
              { ...base, effectAttempt: { providerAttempt: 1, toolCallId: 'engine-winner' } },
            );
            return { outcome: 'approve', scope: 'always' };
          }
          if (live?.preview.kind === 'saved-result') {
            expect(cacheable).toBe(false);
            return savedAnswer === 'reject'
              ? { outcome: 'reject' }
              : { outcome: 'approve', scope: 'always' };
          }
          return { outcome: 'approve', scope: 'always' };
        });
        const policy = buildTurnPolicy('accept-edits', {
          governed: new Set(['write_file']),
          cache,
          prompt,
        });
        if (policy.confirm === undefined) throw new Error('missing approval fixture');
        const raced = registry.dispatch(call, { ...base, approval: { confirm: policy.confirm } });
        if (savedAnswer === 'reject')
          await expect(raced).rejects.toMatchObject({ code: 'tool_denied' });
        else await raced;
        expect(kinds).toEqual(['operation', 'saved-result']);
        expect(cache.isAlways('write_file')).toBe(false);
        expect(executions).toBe(1);
        expect(store.recordsFor(correlation)).toHaveLength(1);
        expect(current).toBe('new\n');
        await registry.dispatch(
          { ...call, id: 'provider-later', args: { path: 'target.txt', content: 'later\n' } },
          {
            ...base,
            effectSlot: 1,
            effectAttempt: { providerAttempt: 1, toolCallId: 'engine-later' },
            approval: { confirm: policy.confirm },
          },
        );
        expect(prompt).toHaveBeenCalledTimes(3);
        expect(cache.isAlways('write_file')).toBe(true);
        expect(executions).toBe(2);
        await registry.dispatch(
          { ...call, id: 'provider-cached', args: { path: 'target.txt', content: 'cached\n' } },
          {
            ...base,
            effectSlot: 2,
            effectAttempt: { providerAttempt: 1, toolCallId: 'engine-cached' },
            approval: { confirm: policy.confirm },
          },
        );
        expect(prompt).toHaveBeenCalledTimes(3);
        expect(executions).toBe(3);
        expect(store.recordsFor(correlation)).toHaveLength(3);
      } finally {
        db.sqlite.close();
      }
    },
  );
});
