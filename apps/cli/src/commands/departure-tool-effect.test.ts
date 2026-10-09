import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { BUILTIN_TOOLS, createToolRegistry, WorkflowEngine } from '@relavium/core';
import {
  createClient,
  createEffectJournalStore,
  createRunHistoryStore,
  runMigrations,
} from '@relavium/db';
import { type RunEvent } from '@relavium/shared';
import { captureIo } from '../test-support.js';
import { createJsonRenderer } from '../render/renderer.js';
import { runCommand } from './run.js';

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

for (const combinedMoney of [false, true])
  it(`a real registry POST resolving after abort leaves its native prepared claim visible (money=${combinedMoney})`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'native-tool-departure-'));
    const path = join(dir, 'history.db');
    const client = createClient(path);
    runMigrations(client.db, { dbPath: path });
    writeFileSync(
      join(dir, 'w.relavium.yaml'),
      JSON.stringify({
        schema_version: '1.0',
        workflow: {
          id: 'native-tool-departure',
          nodes: [{ id: 'work', type: 'input' }],
          edges: [],
        },
      }),
    );
    const hostEntered = deferred(),
      rawRelease = deferred(),
      primaryTerminal = deferred();
    let closeCount = 0,
      settled = false,
      runId = '';
    let cancel: () => void = () => {
      throw new Error('handle not ready');
    };
    let fireGrace: () => void = () => {
      throw new Error('grace not armed');
    };
    let savedEvents: RunEvent[] = [];
    let savedState: string | undefined;
    const delivered: RunEvent[] = [];
    const io = captureIo();
    let execution: Promise<number> | undefined;
    try {
      execution = runCommand(
        { workflow: 'w.relavium.yaml', input: [], allowMcpStdio: [] },
        {
          io: io.io,
          global: {
            json: true,
            color: false,
            cwd: dir,
            configPath: undefined,
            verbosity: 'normal',
          },
          providers: {
            resolveProvider: () => {
              throw new Error('unused provider');
            },
            keyFor: () => 'synthetic',
          },
          openRunStore: (workflow) => {
            const store = createRunHistoryStore(client.db, {
              uuid: randomUUID,
              now: Date.now,
              projectRoot: dir,
              workflow: {
                slug: workflow.workflow.id,
                name: workflow.workflow.id,
                definitionJson: JSON.stringify(workflow),
              },
            });
            return {
              db: client.db,
              store,
              terminalOutboxPath: join(dir, 'outbox'),
              close: () => {
                closeCount++;
                savedEvents = store.loadRunEventLogForReplay(runId);
                const rows = createEffectJournalStore(client.db, {
                  uuid: randomUUID,
                  now: Date.now,
                }).unresolvedForRun(runId);
                expect(rows).toHaveLength(1);
                savedState = rows[0]?.state;
                client.sqlite.close();
              },
            };
          },
          buildEngine: (options = {}) => {
            const host = options.host;
            if (host === undefined) throw new Error('native host required');
            const registry = createToolRegistry({
              tools: BUILTIN_TOOLS,
              host: {
                egress: {
                  fetch: async () => {
                    hostEntered.resolve();
                    await rawRelease.promise;
                    return {
                      status: 200,
                      headers: {},
                      body: 'TARGET_WRITE_LANDED',
                      truncated: false,
                    };
                  },
                },
              },
            });
            const engine = new WorkflowEngine({
              ...options,
              host: {
                ...host,
                setTimer: (ms, fire, kind) => {
                  if (ms === 10000 && kind === 'deadline') {
                    fireGrace = fire;
                    return () => {};
                  }
                  return host.setTimer(ms, fire, kind);
                },
                store: {
                  ...host.store,
                  persistEvent: (event, context) => {
                    if (event.runId !== undefined) runId = event.runId;
                    if (event.type === 'cost:attempt_settled' && event.costMicrocents === 17)
                      return Promise.reject(new Error('PRIVATE late money refusal'));
                    return host.store.persistEvent(event, context);
                  },
                },
              },
              executor: {
                execute: async (ctx) => {
                  if (combinedMoney) {
                    const child = ctx.continueReceipt?.(async (receipt) => {
                      await rawRelease.promise;
                      receipt.money.record({
                        nodeId: 'wrong',
                        model: 'offline',
                        attemptNumber: 1,
                        inputTokens: 1,
                        outputTokens: 1,
                        costMicrocents: 17,
                        priced: true,
                      });
                      await receipt.money.join().catch(() => {});
                    });
                    if (child === undefined) throw new Error('receipt transfer required');
                    void child.catch(() => {});
                  }
                  if (ctx.effects === undefined) throw new Error('native effect journal required');
                  try {
                    await registry.dispatch(
                      {
                        type: 'tool_call',
                        name: 'http_request',
                        id: 'real-post',
                        args: { url: 'https://api.example/x', method: 'POST' },
                      },
                      {
                        nodeId: ctx.vertex.id,
                        grantedToolIds: new Set(['http_request']),
                        config: {},
                        toolPolicy: { allowedDomains: ['api.example'] },
                        fsScope: 'sandboxed',
                        gateApproved: false,
                        effects: ctx.effects,
                        effectSlot: 0,
                        signal: ctx.signal,
                      },
                    );
                    return { kind: 'completed', output: 'unexpected success after abort' };
                  } catch {
                    return {
                      kind: 'failed',
                      error: { code: 'cancelled', message: 'aborted', retryable: false },
                    };
                  }
                },
              },
            });
            return Promise.resolve(
              Object.assign(engine, {
                start: (args: Parameters<typeof engine.start>[0]) => {
                  const handle = WorkflowEngine.prototype.start.call(engine, args);
                  cancel = handle.cancel;
                  return handle;
                },
              }),
            );
          },
          selectRenderer: () => {
            const renderer = createJsonRenderer(io.io);
            return {
              ...renderer,
              onEvent: (event) => {
                renderer.onEvent(event);
                delivered.push(event);
                if (event.type === 'run:cancelled') primaryTerminal.resolve();
              },
            };
          },
          selectGatePrompter: () => undefined,
        },
      );
      void execution.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await hostEntered.promise;
      expect(
        createEffectJournalStore(client.db, { uuid: randomUUID, now: Date.now }).unresolvedForRun(
          runId,
        )[0]?.state,
      ).toBe('prepared');
      cancel();
      fireGrace();
      await primaryTerminal.promise;
      await setImmediate();
      expect(closeCount).toBe(0);
      expect(settled).toBe(false);
      const terminal = delivered.at(-1);
      expect(terminal).toMatchObject({ type: 'run:cancelled' });
      rawRelease.resolve();
      expect(await execution).toBe(combinedMoney ? 8 : 7);
      expect(closeCount).toBe(1);
      expect(savedState).toBe('prepared'); // post-abort guard ran before settle/discard
      expect(savedEvents.filter((event) => event.type === 'run:cancelled')).toEqual([terminal]);
      expect(delivered.at(-1)).toBe(terminal);
      expect(io.err()).toContain('inspect the target');
      expect(io.err()).not.toContain('PRIVATE');
      const warnings: unknown[] = io
        .err()
        .trim()
        .split('\n')
        .map((line): unknown => JSON.parse(line));
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatchObject({
        code: combinedMoney ? 'money_durability_uncertain' : 'effect_needs_attention',
        effectNeedsAttention: true,
      });
    } finally {
      rawRelease.resolve();
      await execution?.catch(() => {});
      if (closeCount === 0) client.sqlite.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
