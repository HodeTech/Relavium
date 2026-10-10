import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), 'relavium-resume-coverage-'));
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

describe('atomic resumed session display seed', () => {
  it.each(outcomes)(
    'actual chat-resume seeds %s after another exact receipt changes during the build',
    async (outcome) => {
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
            providers: scriptedResolver([]),
            buildResumedSession: async (options) => {
              const built = await buildResumedChatSession(options);
              expect(built.resumeState.cumulativeCostMicrocents).toBe(0);
              f.settle('session', receipt, outcome);
              return built;
            },
            drive: (context) => {
              inspected = true;
              expectAtomicSeed(context.store.getSnapshot().state, outcome);
              return Promise.resolve({ kind: 'exit' });
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

  it.each(outcomes)(
    'actual Home model reseat seeds %s after another exact receipt changes during the build',
    async (outcome) => {
      const f = fixture();
      let captured: RootAppProps | undefined;
      let receipt: SessionUsageReceipt | undefined;
      let resumed = false;
      const done = driveHome({
        ...f,
        io: { ...f.io, stdoutIsTty: true, stdinIsTty: true },
        providers: scriptedResolver([
          [
            { type: 'text_delta', text: 'offline' },
            {
              type: 'stop',
              stopReason: 'stop',
              usage: { kind: 'complete', usage: { inputTokens: 0, outputTokens: 0 } },
            },
          ],
        ]),
        buildResumedSession: async (options) => {
          const built = await buildResumedChatSession(options);
          expect(built.resumeState.cumulativeCostMicrocents).toBe(0);
          if (receipt === undefined) throw new Error('receipt must predate the resume load');
          f.settle(built.sessionId, receipt, outcome);
          resumed = true;
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
