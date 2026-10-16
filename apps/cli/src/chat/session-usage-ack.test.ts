import {
  createClient,
  createSessionStore,
  createSessionUsageStore,
  runMigrations,
} from '@relavium/db';
import type { RunOrSessionEvent } from '@relavium/shared';
import { expect, it, vi } from 'vitest';

import { INLINE_TRANSCRIPT_BOUND } from '../render/tui/session-view-model.js';
import { createChatStore } from '../render/tui/chat-store.js';
import { formatSessionFooter } from '../render/tui/chat-projection.js';
import { buildChatSession, type SessionUsageWriter } from './session-host.js';
import { createSessionPersister } from './persister.js';
import { scriptedResolver } from './test-support.js';

const chat = {
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
};

function gate() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function fixture(
  tokens: number,
  wrap: (writer: SessionUsageWriter) => SessionUsageWriter = (writer) => writer,
) {
  const client = createClient();
  runMigrations(client.db);
  const store = createSessionStore(client.db);
  const usage = createSessionUsageStore(client.db);
  const notes: string[] = [];
  const built = await buildChatSession({
    chat,
    agentRef: undefined,
    cwd: '/tmp',
    projectConfigDir: undefined,
    now: () => Date.parse('2026-10-10T00:00:00Z'),
    uuid: () => 'fresh',
    providers: scriptedResolver([
      [
        ...Array.from({ length: 40 }, () => ({ type: 'text_delta' as const, text: 'offline' })),
        {
          type: 'stop',
          stopReason: 'stop',
          usage: { kind: 'complete', usage: { inputTokens: tokens, outputTokens: tokens } },
        },
      ],
    ]),
    onListenerError: (note) => notes.push(note),
  });
  let seq = 0;
  const read = vi.fn(store.loadSessionCostBreakdown);
  const persister = createSessionPersister({
    usageStore: usage,
    governor: built.governor,
    mode: 'fresh',
    attachUsageWriter: (writer) => built.attachUsageWriter(wrap(writer)),
    store: { ...store, loadSessionCostBreakdown: read },
    handle: built.handle,
    attachEffectTurnAllocator: built.attachEffectTurnAllocator,
    attachDurabilityProbe: built.attachDurabilityProbe,
    sessionId: built.sessionId,
    agent: built.agent,
    context: built.context,
    now: () => Date.parse('2026-10-10T00:00:00Z'),
    uuid: () => `msg-${++seq}`,
  });
  const view = createChatStore(false, undefined, INLINE_TRANSCRIPT_BOUND);
  const events: RunOrSessionEvent[] = [];
  const off = built.handle.subscribe((event) => {
    events.push(event);
    view.apply(event);
  });
  persister.start();
  built.session.start();
  persister.beginUserTurn('next');
  return {
    client,
    store,
    built,
    persister,
    view,
    events,
    notes,
    read,
    snapshot: () => store.loadSessionCostBreakdown(built.sessionId),
    close: () => {
      off();
      persister.close();
      client.sqlite.close();
    },
  };
}

it.each([0, 10])(
  'native actual-write refusal keeps all events/footer pending (tokens=%s)',
  async (tokens) => {
    const f = await fixture(tokens);
    try {
      f.client.sqlite.exec(
        "CREATE TRIGGER refuse_actual BEFORE INSERT ON session_costs WHEN NEW.call_count > 0 BEGIN SELECT RAISE(ABORT, 'forced_actual_refusal'); END",
      );
      await expect(f.built.session.sendMessage('next')).rejects.toMatchObject({
        name: 'LedgerDurabilityError',
      });
      f.built.session.cancel();
      await expect(f.built.whenHostSafeToClose()).rejects.toThrow(
        'Session cost ledger could not be made durable.',
      );
      await expect(
        f.built.whenHostSafeToClose(),
        'SESSION_SETTLEMENT_FAILURE_REMAINS_AFTER_FIRST_JOIN',
      ).rejects.toThrow('Session cost ledger could not be made durable.');
      f.view.flush();
      expect(f.snapshot().coverage.pendingInvocations).toBe(1);
      expect(f.snapshot().totalCostMicrocents).toBe(0);
      expect(f.events.filter((event) => event.type === 'cost:updated')).toHaveLength(0);
      const pendingIndex = f.events.findIndex((event) => event.type === 'cost:usage_pending');
      expect(pendingIndex).toBeGreaterThan(0);
      for (const event of f.events.slice(pendingIndex)) {
        expect(event.usageCoverage).toEqual(f.snapshot().coverage);
        expect(event.cumulativeCostMicrocents).toBe(0);
      }
      expect(
        f.events.some(
          (event) => event.type === 'session:turn_completed' && event.error?.code === 'internal',
        ),
      ).toBe(true);
      expect(f.view.getSnapshot().state.usageCoverage).toEqual(f.snapshot().coverage);
      expect(formatSessionFooter(f.view.getSnapshot().state)).toContain('1 usage pending');
      expect(formatSessionFooter(f.view.getSnapshot().state)).not.toContain('free');
    } finally {
      f.close();
    }
  },
);

it.each([0, 10])(
  'native actual ACK alone publishes one tuple after a held write (tokens=%s)',
  async (tokens) => {
    const entered = gate();
    const release = gate();
    const f = await fixture(tokens, (writer) => ({
      ...writer,
      record: async (draft, cumulative) => {
        entered.release();
        await release.promise;
        await writer.record(draft, cumulative);
      },
    }));
    const sending = f.built.session.sendMessage('next');
    try {
      await entered.promise;
      f.view.flush();
      expect(f.snapshot().coverage.pendingInvocations).toBe(1);
      expect(f.view.getSnapshot().state.usageCoverage).toEqual(f.snapshot().coverage);
      expect(formatSessionFooter(f.view.getSnapshot().state)).toContain('1 usage pending');
      expect(f.events.filter((event) => event.type === 'cost:updated')).toHaveLength(0);
      // Forty token frames reuse the pending snapshot: start, turn entry, pending = three reads.
      expect(f.read).toHaveBeenCalledTimes(3);
      release.release();
      await sending;
      f.built.session.cancel();
      await f.built.whenHostSafeToClose();
      f.view.flush();
      const actual = f.events.filter((event) => event.type === 'cost:updated');
      expect(actual).toHaveLength(1);
      expect(actual[0]?.invocation).toBeDefined();
      expect(actual[0]?.cumulativeCostMicrocents).toBe(f.snapshot().totalCostMicrocents);
      expect(f.snapshot().totalCostMicrocents).toBe(tokens === 0 ? 0 : 18000);
      const settledIndex = f.events.findIndex((event) => event.type === 'cost:updated');
      for (const event of f.events.slice(settledIndex)) {
        expect(event.usageCoverage).toEqual(f.snapshot().coverage);
        expect(event.cumulativeCostMicrocents).toBe(f.snapshot().totalCostMicrocents);
        expect(event.cumulativeUnpricedCalls).toBe(0);
      }
      expect(f.snapshot().rows.reduce((sum, row) => sum + row.callCount, 0)).toBe(1);
      expect(f.read).toHaveBeenCalledTimes(6);
      expect(f.view.getSnapshot().state.cumulativeCostMicrocents).toBe(
        f.snapshot().totalCostMicrocents,
      );
      expect(formatSessionFooter(f.view.getSnapshot().state)).not.toMatch(
        /usage pending|usage unknown|unverified/,
      );
    } finally {
      release.release();
      await sending;
      f.close();
    }
  },
);

it('a throwing subscriber cannot undo the native ACK or masquerade as a ledger failure', async () => {
  const f = await fixture(10);
  const off = f.built.handle.subscribe((event) => {
    if (event.type === 'cost:updated') throw new Error('observer broke');
  });
  try {
    await f.built.session.sendMessage('next');
    f.built.session.cancel();
    await f.built.whenHostSafeToClose();
    expect(f.notes).toHaveLength(1);
    expect(f.snapshot().coverage.pendingInvocations).toBe(0);
    expect(f.snapshot().totalCostMicrocents).toBe(18000);
    expect(f.persister.durabilityFailure).toBeUndefined();
    expect(f.events.filter((event) => event.type === 'cost:updated')).toHaveLength(1);
  } finally {
    off();
    f.close();
  }
});

it('a post-ACK snapshot failure is a host publication failure and preserves the sole actual write', async () => {
  let failRead = false;
  const f = await fixture(10, (writer) => ({
    ...writer,
    record: async (draft, cumulative) => {
      await writer.record(draft, cumulative);
      failRead = true;
    },
    readSnapshot: () => {
      if (failRead) {
        failRead = false;
        throw new Error('projection unavailable');
      }
      if (writer.readSnapshot === undefined) throw new Error('native snapshot missing');
      return writer.readSnapshot();
    },
  }));
  try {
    await f.built.session.sendMessage('next');
    f.built.session.cancel();
    await expect(f.built.whenHostSafeToClose()).rejects.toMatchObject({
      name: 'Error',
      message: 'session accounting publication failed',
    });
    expect(f.persister.durabilityFailure).toBeUndefined();
    expect(f.snapshot().coverage.pendingInvocations).toBe(0);
    expect(f.snapshot().totalCostMicrocents).toBe(18000);
    expect(f.snapshot().rows.reduce((sum, row) => sum + row.callCount, 0)).toBe(1);
    expect(f.events.filter((event) => event.type === 'cost:updated')).toHaveLength(0);
  } finally {
    f.close();
  }
});

it('a failed pending snapshot cannot publish cached complete coverage on following token frames', async () => {
  let failRead = false;
  const f = await fixture(10, (writer) => ({
    ...writer,
    begin: async (draft) => {
      const invocation = await writer.begin(draft);
      failRead = true;
      return invocation;
    },
    readSnapshot: () => {
      if (failRead) {
        failRead = false;
        throw new Error('pending projection unavailable');
      }
      if (writer.readSnapshot === undefined) throw new Error('native snapshot missing');
      return writer.readSnapshot();
    },
  }));
  try {
    await f.built.session.sendMessage('next');
    f.built.session.cancel();
    await expect(f.built.whenHostSafeToClose()).rejects.toMatchObject({
      message: 'session accounting publication failed',
    });
    const tokens = f.events.filter((event) => event.type === 'agent:token');
    expect(tokens).toHaveLength(40);
    expect(tokens.every((event) => event.usageCoverage?.unverified === true)).toBe(true);
    expect(f.snapshot().coverage.pendingInvocations).toBe(0);
    expect(f.snapshot().totalCostMicrocents).toBe(18000);
    expect(f.persister.durabilityFailure).toBeUndefined();
  } finally {
    f.close();
  }
});
