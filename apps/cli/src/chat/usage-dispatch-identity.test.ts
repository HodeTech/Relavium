import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import {
  createClient,
  createSessionStore,
  createSessionUsageStore,
  runMigrations,
} from '@relavium/db';
import type { StreamChunk } from '@relavium/llm';
import { AgentSchema, UsageInvocationSchema, type RunOrSessionEvent } from '@relavium/shared';
import { afterEach, expect, it, vi } from 'vitest';

import { agentRunCommand } from '../commands/agent-run.js';
import { openSessionStore } from '../history/session-open.js';
import { captureIo, parseNdjson } from '../test-support.js';
import { createSessionPersister } from './persister.js';
import { buildChatSession } from './session-host.js';
import { scriptedResolver, textTurn } from './test-support.js';

const completeCoverage = { unverified: false, pendingInvocations: 0, unknownCalls: 0 };
// 254 previously failed when the ordinal reached 10; 255 failed on the first call.
// A larger valid ID also guards against replacing the bug with a new authored-ID ceiling.
const cases = [
  { length: 254, calls: 10 },
  { length: 255, calls: 1 },
  { length: 1024, calls: 1 },
];
const directories: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function agentFixture(length: number) {
  const directory = mkdtempSync(join(tmpdir(), 'relavium-dispatch-identity-'));
  directories.push(directory);
  const id = 'a'.repeat(length);
  const authored = {
    id,
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    system_prompt: 'Offline identity regression.',
    tools: ['read_file'],
  };
  expect(AgentSchema.safeParse(authored).success).toBe(true);
  // Keep the filename short: the boundary under test is the valid ID inside real YAML.
  const path = join(directory, 'valid.agent.yaml');
  writeFileSync(
    path,
    `id: ${id}\nprovider: anthropic\nmodel: claude-sonnet-4-6\nsystem_prompt: Offline identity regression.\ntools:\n  - read_file\n`,
  );
  writeFileSync(join(directory, 'input.txt'), 'offline');
  return { directory, id, path };
}

function countedResolver(scripts: StreamChunk[][]) {
  const resolver = scriptedResolver(scripts);
  const provider = resolver.resolveProvider('anthropic');
  if (provider === undefined) throw new Error('missing scripted provider');
  const stream = vi.spyOn(provider, 'stream');
  return { resolver, stream };
}

function assertAccountingEvents(events: readonly RunOrSessionEvent[], calls: number) {
  const pending = events.filter((event) => event.type === 'cost:usage_pending');
  const actual = events.filter((event) => event.type === 'cost:updated');
  expect(pending).toHaveLength(calls);
  expect(actual).toHaveLength(calls);
  const identities = pending.map((event) => {
    expect(UsageInvocationSchema.safeParse(event.invocation).success).toBe(true);
    return JSON.stringify(event.invocation);
  });
  expect(new Set(identities).size).toBe(calls);
  expect(actual.map((event) => JSON.stringify(event.invocation))).toEqual(identities);
  expect(actual.at(-1)).toMatchObject({
    cumulativeCostMicrocents: 10500 * calls,
    usageCoverage: completeCoverage,
  });
}

it.each(cases)(
  'persisted chat accepts a valid $length-character agent ID across $calls invocations',
  async ({ length, calls }) => {
    const agent = agentFixture(length);
    const client = createClient();
    runMigrations(client.db);
    const store = createSessionStore(client.db);
    const usageStore = createSessionUsageStore(client.db);
    const { resolver, stream } = countedResolver(
      Array.from({ length: calls }, () => textTurn('offline reply')),
    );
    const notes: string[] = [];
    let uuid = 0;
    const built = await buildChatSession({
      chat: {
        defaultModel: undefined,
        defaultProvider: undefined,
        fsScope: undefined,
        maxTurns: undefined,
        maxMessages: undefined,
        autoCompact: undefined,
        compactThreshold: undefined,
        maxCostMicrocents: undefined,
        onExceed: undefined,
        strictCostCap: false,
        allowedCommands: undefined,
        allowedCommandGlobs: undefined,
        reasoningEffort: undefined,
      },
      agentRef: agent.path,
      cwd: agent.directory,
      projectConfigDir: undefined,
      now: () => 0,
      uuid: () => `chat-${++uuid}`,
      providers: resolver,
      onListenerError: (note) => notes.push(note),
    });
    const persister = createSessionPersister({
      usageStore,
      governor: built.governor,
      mode: 'fresh',
      attachUsageWriter: built.attachUsageWriter,
      store,
      handle: built.handle,
      attachEffectTurnAllocator: built.attachEffectTurnAllocator,
      attachDurabilityProbe: built.attachDurabilityProbe,
      sessionId: built.sessionId,
      agent: built.agent,
      context: built.context,
      now: () => 0,
      uuid: () => `message-${++uuid}`,
    });
    const events: RunOrSessionEvent[] = [];
    const off = built.handle.subscribe((event) => events.push(event));
    try {
      persister.start();
      built.session.start();
      expect(built.agent.id).toBe(agent.id);
      for (let call = 0; call < calls; call++) {
        persister.beginUserTurn('next');
        await built.session.sendMessage('next');
      }
      expect(events.filter((event) => event.type === 'session:turn_completed')).toHaveLength(calls);
      expect(
        events
          .filter((event) => event.type === 'session:turn_completed')
          .map((event) => event.stopReason),
      ).toEqual(Array.from({ length: calls }, () => 'stop'));
      expect(stream).toHaveBeenCalledTimes(calls);
      expect(notes).toEqual([]);
      expect(persister.durabilityFailure).toBeUndefined();
      assertAccountingEvents(events, calls);
      expect(store.loadSessionCostBreakdown(built.sessionId)).toMatchObject({
        totalCostMicrocents: 10500 * calls,
        coverage: completeCoverage,
        rows: [{ callCount: calls, costMicrocents: 10500 * calls }],
      });
    } finally {
      built.session.cancel();
      await built.whenHostSafeToClose();
      off();
      persister.close();
      client.sqlite.close();
    }
  },
);

it.each(cases)(
  'one-shot agent run accepts a valid $length-character agent ID across $calls invocations',
  async ({ length, calls }) => {
    const agent = agentFixture(length);
    vi.stubEnv('HOME', agent.directory);
    vi.stubEnv('USERPROFILE', agent.directory);
    const scripts = Array.from({ length: calls }, (_, index): StreamChunk[] =>
      index === calls - 1
        ? textTurn('offline reply')
        : [
            { type: 'tool_call_start', id: `read-${index}`, name: 'read_file' },
            {
              type: 'tool_call_delta',
              id: `read-${index}`,
              argsJsonDelta: JSON.stringify({ path: 'input.txt' }),
            },
            { type: 'tool_call_end', id: `read-${index}` },
            {
              type: 'stop',
              stopReason: 'tool_use',
              usage: { kind: 'complete', usage: { inputTokens: 10, outputTokens: 5 } },
            },
          ],
    );
    const { resolver, stream } = countedResolver(scripts);
    const { io, out, err } = captureIo();
    const sessionId = 'one-shot-identity';
    expect(
      await agentRunCommand(
        { agent: agent.path, input: [], allowMcpStdio: [] },
        {
          io: { ...io, stdin: Readable.from(['next']) },
          global: {
            json: true,
            color: false,
            cwd: agent.directory,
            configPath: undefined,
            verbosity: 'normal',
          },
          providers: resolver,
          now: () => 0,
          uuid: () => sessionId,
          buildSession: async (options) => {
            const built = await buildChatSession(options);
            expect(built.agent.id).toBe(agent.id);
            return built;
          },
        },
      ),
    ).toBe(0);
    expect(stream).toHaveBeenCalledTimes(calls);
    expect(err()).toBe('');
    const events = parseNdjson<RunOrSessionEvent>(out());
    expect(events.find((event) => event.type === 'session:turn_completed')).toMatchObject({
      stopReason: 'stop',
      usageCoverage: completeCoverage,
    });
    assertAccountingEvents(events, calls);
    const opened = openSessionStore(agent.directory);
    try {
      expect(opened.store.loadSessionCostBreakdown(sessionId)).toMatchObject({
        totalCostMicrocents: 10500 * calls,
        coverage: completeCoverage,
        rows: [{ callCount: calls, costMicrocents: 10500 * calls }],
      });
      expect(opened.store.listSessions()).toEqual([]);
    } finally {
      opened.close();
    }
  },
);
