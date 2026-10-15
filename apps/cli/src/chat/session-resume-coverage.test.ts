import type { SessionHandle, SessionStreamHandleEvent } from '@relavium/core';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createClient,
  createSessionStore,
  createSessionUsageStore,
  runMigrations,
  type SessionUsageReceipt,
} from '@relavium/db';
import { describe, expect, it } from 'vitest';

import { chatResumeCommand } from '../commands/chat.js';
import { driveHome } from '../home/drive-home.js';
import { EXIT_CODES } from '../process/exit-codes.js';
import { formatSessionFooter } from '../render/tui/chat-projection.js';
import type { RootAppProps } from '../render/tui/home-app.js';
import type { SessionViewState } from '../render/tui/session-view-model.js';
import { captureIo } from '../test-support.js';
import { buildResumedChatSession } from './session-host.js';
import { scriptedResolver } from './test-support.js';

const timestamp = '2026-10-10T00:00:00.000Z';
const model = 'claude-sonnet-4-6';
type Outcome = 'positive' | 'zero' | 'unpriced' | 'incomplete';
const outcomes: Outcome[] = ['positive', 'zero', 'unpriced', 'incomplete'];
const cases = outcomes.flatMap((outcome) => [0, 10].map((tokens) => ({ outcome, tokens })));
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function fixture() {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'relavium-resume-coverage-')));
  const configPath = join(cwd, 'config.toml');
  writeFileSync(configPath, '');
  const client = createClient();
  runMigrations(client.db);
  const store = createSessionStore(client.db);
  const usage = createSessionUsageStore(client.db);
  const { io } = captureIo();
  let ordinal = 0;
  return {
    cwd,
    client,
    store,
    usage,
    io,
    global: { json: false, color: false, cwd, configPath, verbosity: 'normal' as const },
    now: () => Date.parse(timestamp),
    uuid: () => `resume-fixture-${++ordinal}`,
    openSessionStore: () => ({ store, db: client.db, close: () => {} }),
    begin: (sessionId: string) =>
      usage.beginInvocation({
        sessionId,
        model,
        producerId: 'other-live-host',
        dispatchId: 'concurrent-call',
        round: 0,
        chainAttempt: 1,
      }),
    settle: (sessionId: string, receipt: SessionUsageReceipt, outcome: Outcome) => {
      if (outcome === 'incomplete') {
        expect(
          usage.disposition(receipt, {
            kind: 'incomplete',
            evidence: { kind: 'missing', reason: 'not_reported' },
          }),
        ).toBe(true);
        usage.retire(receipt);
      } else {
        expect(
          store.recordSessionCost({
            id: 'concurrent-settlement',
            sessionId,
            model,
            inputTokens: 1,
            outputTokens: 1,
            costMicrocents: outcome === 'positive' ? 100000000 : 0,
            priced: outcome !== 'unpriced',
            ts: 1,
            usageReceipt: receipt,
          }),
        ).toBe(true);
      }
    },
    close: () => {
      client.sqlite.close();
      rmSync(cwd, { recursive: true, force: true });
    },
  };
}

function expectAtomicSeed(state: SessionViewState, outcome: Outcome) {
  expect(state.cumulativeCostMicrocents).toBe(outcome === 'positive' ? 100000000 : 0);
  expect(state.usageCoverage).toEqual({
    unverified: false,
    pendingInvocations: 0,
    unknownCalls: outcome === 'incomplete' ? 1 : 0,
  });
  expect(state.unpricedCalls).toBe(outcome === 'unpriced' ? 1 : 0);
  const footer = formatSessionFooter(state);
  if (outcome === 'positive') expect(footer).toContain('$1.0000');
  else if (outcome === 'unpriced') expect(footer).toContain('price unknown for 1 call');
  else if (outcome === 'incomplete') expect(footer).toContain('usage unknown for 1 call');
  else {
    expect(footer).toContain('$0.0000');
    expect(footer).not.toMatch(/usage unknown|price unknown|unverified/);
  }
  if (outcome !== 'zero') expect(footer).not.toContain('free');
}

function assertPublished(
  events: readonly SessionStreamHandleEvent[],
  durable: ReturnType<ReturnType<typeof createSessionStore>['loadSessionCostBreakdown']>,
) {
  const actualIndex = events.findIndex((event) => event.type === 'cost:updated');
  expect(actualIndex).toBeGreaterThan(0);
  for (const event of events.slice(actualIndex)) {
    expect(event.cumulativeCostMicrocents).toBe(durable.totalCostMicrocents);
    expect(event.usageCoverage).toEqual(durable.coverage);
    expect(event.cumulativeUnpricedCalls).toBe(
      durable.rows.reduce((sum, row) => sum + row.unpricedCalls, 0),
    );
  }
}

describe('atomic resumed session display after first subsequent attempt', () => {
  it.each(cases)(
    'actual chat-resume preserves $outcome after another exact receipt and a $tokens-token next call',
    async ({ outcome, tokens }) => {
      const f = fixture();
      try {
        f.usage.createFreshSession({
          id: 'session',
          agentSlug: 'offline',
          agentSnapshot: { id: 'a', provider: 'anthropic', model, system_prompt: 'offline' },
          context: { workingDir: f.cwd, fsScopeTier: 'sandboxed' },
          createdAt: timestamp,
        });
        const receipt = f.begin('session');
        let inspected = false;
        const code = await chatResumeCommand(
          { sessionId: 'session' },
          {
            ...f,
            providers: scriptedResolver([
              [
                { type: 'text_delta', text: 'next' },
                {
                  type: 'stop',
                  stopReason: 'stop',
                  usage: { kind: 'complete', usage: { inputTokens: tokens, outputTokens: tokens } },
                },
              ],
            ]),
            buildResumedSession: async (options) => {
              const built = await buildResumedChatSession(options);
              expect(built.resumeState.cumulativeCostMicrocents).toBe(0);
              f.settle('session', receipt, outcome);
              return built;
            },
            drive: async (context) => {
              inspected = true;
              expectAtomicSeed(context.store.getSnapshot().state, outcome);
              const observed: SessionStreamHandleEvent[] = [];
              const off = context.handle.subscribe((event) => {
                context.store.apply(event);
                observed.push(event);
              });
              context.startSession();
              await context.processLine('next');
              context.store.flush();
              expect(observed.filter((event) => event.type === 'cost:updated')).toHaveLength(1);
              expect(
                observed.every(
                  (event) =>
                    event.cumulativeCostMicrocents !== undefined &&
                    event.usageCoverage !== undefined &&
                    event.cumulativeUnpricedCalls !== undefined,
                ),
              ).toBe(true);
              expect(f.store.loadSessionCostBreakdown('session').totalCostMicrocents).toBe(
                (outcome === 'positive' ? 100000000 : 0) + tokens * 1800,
              );
              assertPublished(observed, f.store.loadSessionCostBreakdown('session'));
              expect(formatSessionFooter(context.store.getSnapshot().state)).not.toContain(
                'usage pending',
              );
              expect(context.store.getSnapshot().state.cumulativeCostMicrocents).toBe(
                f.store.loadSessionCostBreakdown('session').totalCostMicrocents,
              );
              off();
              return { kind: 'exit' };
            },
          },
        );
        expect(code).toBe(EXIT_CODES.chatEnded);
        expect(inspected).toBe(true);
      } finally {
        f.close();
      }
    },
  );

  it.each(cases)(
    'actual Home model reseat preserves $outcome after another exact receipt and a $tokens-token next call',
    async ({ outcome, tokens }) => {
      const f = fixture();
      let captured: RootAppProps | undefined;
      let receipt: SessionUsageReceipt | undefined;
      let resumed = false;
      let resumedHandle: SessionHandle | undefined;
      const done = driveHome({
        ...f,
        io: { ...f.io, stdoutIsTty: true, stdinIsTty: true },
        providers: scriptedResolver(
          Array.from({ length: 2 }, (_, index) => [
            { type: 'text_delta', text: 'offline' },
            {
              type: 'stop',
              stopReason: 'stop',
              usage: {
                kind: 'complete',
                usage: {
                  inputTokens: index === 0 ? 0 : tokens,
                  outputTokens: index === 0 ? 0 : tokens,
                },
              },
            },
          ]),
        ),
        buildResumedSession: async (options) => {
          const built = await buildResumedChatSession(options);
          expect(built.resumeState.cumulativeCostMicrocents).toBe(0);
          if (receipt === undefined) throw new Error('receipt must predate the resume load');
          f.settle(built.sessionId, receipt, outcome);
          resumed = true;
          resumedHandle = built.handle;
          return built;
        },
        render: (props) => {
          captured = props;
          props.onRendererReady?.(async (publish) => {
            await publish?.();
          });
          return {
            unmount: () => {},
            waitUntilRenderFlush: () => Promise.resolve(),
            waitUntilExit: () => new Promise(() => {}),
          };
        },
        getSize: () => ({ cols: 120, rows: 40 }),
        subscribeResize: () => () => {},
        subscribeSignals: () => () => {},
        subscribeProcessExit: () => () => {},
        jobControlLifecycle: {
          supported: false,
          onSuspend: () => () => {},
          onContinue: () => () => {},
          suspendSelf: () => {},
        },
        onboardingTerminalLifecycle: {
          onInput: () => () => {},
          isRawMode: () => false,
          setRawMode: () => {},
        },
        writeControl: () => {},
        exit: () => {},
      });
      try {
        if (captured === undefined) throw new Error('Home renderer was not mounted');
        const props = captured;
        const type = (text: string) => {
          for (const character of text) props.controller.handleKey(character, {});
        };
        type('first');
        props.controller.handleKey('', { return: true });
        await flush();
        const original = props.controller.getSnapshot().session;
        if (original === undefined) throw new Error('Home did not create a session');
        expect(original.store.getSnapshot().state.cumulativeCostMicrocents).toBe(0);
        receipt = f.begin(original.sessionId);
        props.controller.handleKey('/', {});
        type('models');
        props.controller.handleKey('', { return: true });
        await flush();
        expect(props.controller.getSnapshot().modelPicker).toBeDefined();
        type('claude-opus-4-8');
        props.controller.handleKey('', { return: true });
        expect(props.controller.getSnapshot().modelPicker?.phase).toBe('effort');
        props.controller.handleKey('', { return: true });
        await flush();
        const current = props.controller.getSnapshot().session;
        expect(resumed).toBe(true);
        expect(current).not.toBe(original);
        expect(current?.sessionId).toBe(original.sessionId);
        if (current === undefined) throw new Error('reseated session absent');
        expectAtomicSeed(current.store.getSnapshot().state, outcome);
        const observed: SessionStreamHandleEvent[] = [];
        if (resumedHandle === undefined) throw new Error('resumed handle absent');
        const off = resumedHandle.subscribe((event) => observed.push(event));
        type('next');
        props.controller.handleKey('', { return: true });
        await flush();
        current.store.flush();
        off();
        expect(observed.filter((event) => event.type === 'cost:updated')).toHaveLength(1);
        expect(
          observed.every(
            (event) =>
              event.cumulativeCostMicrocents !== undefined &&
              event.usageCoverage !== undefined &&
              event.cumulativeUnpricedCalls !== undefined,
          ),
        ).toBe(true);
        expect(f.store.loadSessionCostBreakdown(current.sessionId).totalCostMicrocents).toBe(
          (outcome === 'positive' ? 100000000 : 0) + tokens * 3000,
        );
        assertPublished(observed, f.store.loadSessionCostBreakdown(current.sessionId));
        expect(formatSessionFooter(current.store.getSnapshot().state)).not.toContain(
          'usage pending',
        );
        expect(current.store.getSnapshot().state.turnCount).toBe(2);
        expect(current.store.getSnapshot().state.cumulativeCostMicrocents).toBe(
          f.store.loadSessionCostBreakdown(current.sessionId).totalCostMicrocents,
        );
      } finally {
        captured?.controller.handleKey('c', { ctrl: true });
        await flush();
        captured?.controller.handleKey('c', { ctrl: true });
        await done;
        f.close();
      }
    },
  );
});
