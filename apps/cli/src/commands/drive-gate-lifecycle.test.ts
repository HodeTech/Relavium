import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as turn } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { reconstructCheckpointState, type RunStore } from '@relavium/core';
import {
  createClient,
  createRunHistoryStore,
  createRunLeasePort,
  runMigrations,
} from '@relavium/db';
import type { LlmProvider, ModelPricing } from '@relavium/llm';
import { buildEngine } from '../engine/build-engine.js';
import { createInkRenderer } from '../render/tui/ink-renderer.js';
import { runCommand } from './run.js';
import { createClackGatePrompter } from '../gate/clack-prompter.js';
import { captureIo, CHAT_TEXT_CAPABILITY_FLAGS } from '../test-support.js';
function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const model = 'gate-lifecycle-native-quote';
const price: ModelPricing = {
  provider: 'openai',
  nativeId: model,
  displayName: model,
  contextWindowTokens: 50000,
  maxOutputTokens: 1000,
  inputPerMtokMicrocents: 1000000,
  outputPerMtokMicrocents: 1000000,
  cachedInputPerMtokMicrocents: 1000000,
};
type Mode =
  | 'budget-suspend-signal'
  | 'human-suspend-signal'
  | 'siblings-suspend-signal'
  | 'dismiss-first-signal'
  | 'approve'
  | 'reject'
  | 'stable-pause'
  | 'suspend-error'
  | 'finalize-error-signal'
  | 'timeout-suspend-terminal'
  | 'timeout-prompt-terminal';
for (const mode of [
  'budget-suspend-signal',
  'human-suspend-signal',
  'siblings-suspend-signal',
  'dismiss-first-signal',
  'approve',
  'reject',
  'stable-pause',
  'suspend-error',
  'finalize-error-signal',
  'timeout-suspend-terminal',
  'timeout-prompt-terminal',
] satisfies Mode[]) {
  it.skipIf(process.platform === 'win32' && mode.includes('signal'))(
    'interactive gate lifecycle: ' + mode,
    async () => {
      const directory = mkdtempSync(join(tmpdir(), 'gate-lifecycle-native-'));
      const dbPath = join(directory, 'native.db');
      const db = createClient(dbPath);
      runMigrations(db.db, { dbPath });
      const suspendEntered = deferred(),
        suspendRelease = deferred(),
        cancelEntered = deferred(),
        cancelRelease = deferred(),
        signalSeen = deferred(),
        cancelAck = deferred(),
        unexpectedPromptRelease = deferred(),
        deadlineArmed = deferred();
      const trace: string[] = [];
      const summaries: string[] = [];
      let runId = '',
        prompts = 0,
        calls = 0,
        closes = 0,
        lateWrites = 0,
        unmounts = 0,
        settled = false;
      let afterTerminalAck: unknown;
      const signalDuringSuspend = mode.endsWith('suspend-signal');
      const terminalDuringSuspend = mode === 'timeout-suspend-terminal';
      const terminalDuringPrompt = mode === 'timeout-prompt-terminal';
      const terminalExpected = terminalDuringSuspend || terminalDuringPrompt;
      const promptEntered = deferred();
      let fireGateDeadline: () => void = () => {
        throw new Error('deadline not armed');
      };
      const provider: LlmProvider = {
        id: 'openai',
        customEndpoint: true,
        supports: CHAT_TEXT_CAPABILITY_FLAGS,
        generate: () => Promise.reject(new Error('unused')),
        stream: async function* () {
          calls++;
          await Promise.resolve();
          yield { type: 'text_delta', text: 'bounded paid control' };
          yield { type: 'stop', stopReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } };
        },
      };
      const agent = {
        id: 'pay',
        type: 'agent',
        agent_ref: 'a',
        prompt_template: 'prove native quote',
        max_tokens: 16,
      };
      const nodes =
        mode === 'human-suspend-signal' || terminalExpected
          ? [
              {
                id: 'human',
                type: 'human_gate',
                gate_type: 'approval',
                ...(terminalExpected ? { timeout_ms: 2000, timeout_action: 'reject' } : {}),
              },
            ]
          : [
              agent,
              ...(mode === 'siblings-suspend-signal'
                ? [
                    { ...agent, id: 'sibling' },
                    { id: 'human', type: 'human_gate', gate_type: 'approval' },
                  ]
                : []),
            ];
      writeFileSync(
        join(directory, 'w.relavium.yaml'),
        JSON.stringify({
          schema_version: '1.0',
          workflow: {
            id: 'gate-lifecycle-native',
            budget: {
              max_cost_microcents: 1,
              on_exceed: 'pause_for_approval',
              strict_cost_cap: true,
            },
            agents: [{ id: 'a', provider: 'openai', model, system_prompt: 'go' }],
            nodes,
            edges: [],
          },
        }),
      );
      const io = captureIo();
      const signalBaseline = process.listenerCount('SIGINT');
      let execution: Promise<number> | undefined;
      let commandError: unknown;
      const suspendError = new Error('injected suspend rejection');
      const stopError = new Error('injected finalization rejection');
      try {
        execution = runCommand(
          { workflow: 'w.relavium.yaml', input: [], allowMcpStdio: [] },
          {
            io: io.io,
            global: {
              cwd: directory,
              json: false,
              color: false,
              configPath: undefined,
              verbosity: 'normal',
            },
            providers: {
              resolveProvider: () => provider,
              keyFor: () => 'synthetic-review-key',
              endpointKind: () => 'custom',
            },
            openRunStore: (workflow) => {
              const store = createRunHistoryStore(db.db, {
                uuid: randomUUID,
                now: Date.now,
                projectRoot: directory,
                workflow: {
                  slug: workflow.workflow.id,
                  name: 'r4',
                  definitionJson: JSON.stringify(workflow),
                },
              });
              return {
                db: db.db,
                store,
                terminalOutboxPath: join(directory, 'outbox'),
                close: () => {
                  closes++;
                  trace.push('close');
                  db.sqlite.close();
                },
              };
            },
            buildEngine: async (options) => {
              if (!options?.host) throw new Error('native host required');
              const host = options.host;
              const store: RunStore = {
                ...host.store,
                persistEvent: async (event, context) => {
                  if (event.type === 'run:started') runId = event.runId;
                  if (event.type === 'run:cancelled') {
                    trace.push('cancel-writer-enter');
                    cancelEntered.resolve();
                    await cancelRelease.promise;
                  }
                  try {
                    await host.store.persistEvent(event, context);
                    trace.push('acked-' + event.type);
                    if (event.type === 'run:cancelled' || event.type === 'run:failed')
                      cancelAck.resolve();
                  } catch (error) {
                    lateWrites++;
                    throw error;
                  }
                },
              };
              return buildEngine({
                ...options,
                resolvePrice: new Map([[model, price]]),
                host: {
                  ...host,
                  store,
                  setTimer: (...args: Parameters<typeof host.setTimer>) => {
                    const [ms, fire, kind] = args;
                    if (
                      terminalExpected &&
                      ms > 1000 &&
                      ms <= 2000 &&
                      (kind ?? 'work') === 'work'
                    ) {
                      fireGateDeadline = fire;
                      deadlineArmed.resolve();
                      return () => {};
                    }
                    return host.setTimer(...args);
                  },
                },
              });
            },
            selectRenderer: () =>
              createInkRenderer({
                color: false,
                mount: () => ({
                  unmount: () => {
                    unmounts++;
                    trace.push('unmount-' + unmounts);
                    if (unmounts === 1) suspendEntered.resolve();
                  },
                  waitUntilExit: () =>
                    unmounts === 1 &&
                    (signalDuringSuspend ||
                      terminalDuringSuspend ||
                      mode === 'finalize-error-signal')
                      ? suspendRelease.promise.then(() => {
                          if (mode === 'finalize-error-signal') throw stopError;
                        })
                      : mode === 'suspend-error' && unmounts === 1
                        ? Promise.reject(suspendError)
                        : Promise.resolve(),
                }),
                writeSummary: (text) => {
                  trace.push('summary');
                  summaries.push(text);
                },
              }),
            selectGatePrompter: () =>
              mode === 'stable-pause' || mode === 'finalize-error-signal'
                ? undefined
                : {
                    prompt: async (_event, budget) => {
                      prompts++;
                      trace.push('prompt-' + prompts);
                      if (terminalDuringPrompt) {
                        promptEntered.resolve();
                        return createClackGatePrompter({
                          note: () => {},
                          confirm: async () => {
                            await unexpectedPromptRelease.promise;
                            return Symbol('cancelled');
                          },
                          text: () => Promise.reject(new Error('unexpected text')),
                          isCancel: (value): value is symbol => typeof value === 'symbol',
                        }).prompt(_event, budget);
                      }
                      if (signalDuringSuspend || terminalDuringSuspend)
                        await unexpectedPromptRelease.promise;
                      if (mode === 'approve') {
                        expect(budget?.kind).toBe('amount');
                        return {
                          decision: 'approved',
                          decidedBy: 'test-human',
                          ...(budget?.kind === 'amount'
                            ? { approvedAmountMicrocents: budget.microcents }
                            : {}),
                        };
                      }
                      await Promise.resolve();
                      return mode === 'reject'
                        ? { decision: 'rejected', decidedBy: 'test-human' }
                        : null;
                    },
                  },
          },
        )
          .then((code) => {
            settled = true;
            return code;
          })
          .catch((error) => {
            commandError = error;
            settled = true;
            if (mode === 'suspend-error') return 1;
            throw error;
          });
        if (terminalDuringPrompt) {
          await promptEntered.promise;
          await deadlineArmed.promise;
          fireGateDeadline();
          await cancelAck.promise;
          await turn();
          await turn();
        } else if (terminalDuringSuspend) {
          await suspendEntered.promise;
          expect(prompts).toBe(0);
          await deadlineArmed.promise;
          fireGateDeadline();
          await cancelAck.promise;
          suspendRelease.resolve();
          await turn();
          await turn();
        } else if (signalDuringSuspend || mode === 'finalize-error-signal') {
          await suspendEntered.promise;
          expect(prompts).toBe(0);
          process.once('SIGINT', signalSeen.resolve);
          process.kill(process.pid, 'SIGINT');
          await signalSeen.promise;
          await cancelEntered.promise;
          expect({ open: db.sqlite.open, closes, settled, prompts }).toEqual({
            open: true,
            closes: 0,
            settled: false,
            prompts: 0,
          });
          suspendRelease.resolve();
          await turn();
          await turn();
        } else if (mode === 'dismiss-first-signal') {
          await cancelEntered.promise;
          process.once('SIGINT', signalSeen.resolve);
          process.kill(process.pid, 'SIGINT');
          await signalSeen.promise;
          await turn();
          expect({ open: db.sqlite.open, closes, settled, prompts }).toEqual({
            open: true,
            closes: 0,
            settled: false,
            prompts: 1,
          });
        } else cancelRelease.resolve();
        if (
          signalDuringSuspend ||
          mode === 'dismiss-first-signal' ||
          mode === 'finalize-error-signal'
        ) {
          expect(summaries).toHaveLength(0);
          expect(db.sqlite.open).toBe(true);
          expect(settled).toBe(false);
          cancelRelease.resolve();
        }
        if (signalDuringSuspend || terminalExpected) {
          await cancelAck.promise;
          await turn();
          afterTerminalAck = {
            prompts,
            settled,
            open: db.sqlite.open,
            closes,
            summaries: summaries.length,
          };
          unexpectedPromptRelease.resolve();
        }
        const exit = await execution;
        const reopened = createClient(dbPath);
        try {
          const store = createRunHistoryStore(reopened.db, {
            uuid: randomUUID,
            now: Date.now,
            workflow: { slug: 'gate-lifecycle-native', name: 'r4', definitionJson: '{}' },
          });
          const events = store.loadRunEventLogForReplay(runId);
          const terminal = events.at(-1)?.type;
          if (mode === 'suspend-error') expect(commandError).toBe(suspendError);
          expect(lateWrites).toBe(0);
          expect(closes).toBe(1);
          expect(await createRunLeasePort(store).read(runId)).toBeUndefined();
          expect(process.listenerCount('SIGINT')).toBe(signalBaseline);
          expect(summaries).toHaveLength(1);
          if (mode === 'stable-pause') {
            expect(exit).toBe(3);
            expect(terminal).toBe('run:paused');
            expect(reconstructCheckpointState(events)?.pendingGates).toHaveLength(1);
            expect(summaries[0]).toContain('run paused');
            expect(prompts).toBe(0);
          } else if (mode === 'approve') {
            expect(exit).toBe(0);
            expect(calls).toBe(1);
            expect(terminal).toBe('run:completed');
            expect(summaries[0]).toContain('run completed');
            expect(reconstructCheckpointState(events)?.resolvedBudgetGateIds).toHaveLength(1);
          } else if (mode === 'reject' || terminalExpected) {
            expect(exit).toBe(1);
            expect(calls).toBe(0);
            expect(terminal).toBe('run:failed');
            expect(summaries[0]).toContain('run failed');
            if (terminalExpected) {
              expect(events.at(-1)).toMatchObject({
                type: 'run:failed',
                error: { code: 'run_timeout' },
              });
              if (terminalDuringSuspend)
                expect(
                  prompts,
                  'acknowledged terminal during suspend must suppress first card',
                ).toBe(0);
              if (terminalDuringPrompt)
                expect(
                  afterTerminalAck,
                  'acknowledged terminal must release a pending card without extra user input',
                ).toMatchObject({ settled: true, open: false, closes: 1, summaries: 1 });
            }
          } else {
            expect(exit).toBe(1);
            expect(calls).toBe(0);
            expect(terminal).toBe('run:cancelled');
            expect(summaries[0]).toContain('run cancelled');
            expect(trace.indexOf('close')).toBeGreaterThan(trace.indexOf('acked-run:cancelled'));
            if (signalDuringSuspend)
              expect(prompts, 'cancellation during Ink suspend must suppress first card').toBe(0);
          }
        } finally {
          reopened.sqlite.close();
        }
      } finally {
        suspendRelease.resolve();
        cancelRelease.resolve();
        unexpectedPromptRelease.resolve();
        if (execution) await execution.catch(() => undefined);
        if (db.sqlite.open) db.sqlite.close();
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );
}
