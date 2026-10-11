import type { RunEvent } from '@relavium/shared';
import { describe, expect, it } from 'vitest';

import { createRunStore } from './run-store.js';

const TS = '2026-06-23T12:00:00.000Z';
const RUN = 'run-1';

const nodeStarted: RunEvent = {
  type: 'node:started',
  runId: RUN,
  timestamp: TS,
  sequenceNumber: 1,
  nodeId: 'a',
  nodeType: 'agent',
};
const token = (seq: number, t: string): RunEvent => ({
  type: 'agent:token',
  runId: RUN,
  timestamp: TS,
  sequenceNumber: seq,
  nodeId: 'a',
  token: t,
  model: 'm',
});

describe('createRunStore', () => {
  it('flushes a lifecycle event immediately (status feels instant)', () => {
    const store = createRunStore(true);
    let notified = 0;
    store.subscribe(() => (notified += 1));
    store.apply(nodeStarted);
    expect(notified).toBe(1); // flushed on apply, no frame needed
    expect(store.getSnapshot().state.nodes['a']?.status).toBe('running');
  });

  it('coalesces token bursts: tokens are reduced but only repaint on the next tick (no flood, no drop)', () => {
    const store = createRunStore(true);
    store.apply(nodeStarted);
    let notified = 0;
    store.subscribe(() => (notified += 1));
    store.apply(token(2, 'a'));
    store.apply(token(3, 'b'));
    store.apply(token(4, 'c'));
    expect(notified).toBe(0); // no repaint yet — coalesced
    // ...but every token was reduced (none dropped):
    store.tick();
    expect(notified).toBe(1); // a single coalesced repaint
    expect(store.getSnapshot().state.activeTokens).toBe('abc');
  });

  it('coalesces the whole high-frequency family (reasoning / tool_call / tool_result), not just tokens', () => {
    const store = createRunStore(true);
    store.apply(nodeStarted);
    let notified = 0;
    store.subscribe(() => (notified += 1));
    store.apply({
      type: 'agent:reasoning', // EA6 — a per-reasoning_delta firehose; must coalesce like a token
      runId: RUN,
      timestamp: TS,
      sequenceNumber: 2,
      nodeId: 'a',
      text: 'thinking',
      model: 'm',
    });
    store.apply({
      type: 'agent:tool_call',
      runId: RUN,
      timestamp: TS,
      sequenceNumber: 3,
      nodeId: 'a',
      model: 'm',
      toolId: 't',
    });
    store.apply({
      type: 'agent:tool_result',
      runId: RUN,
      timestamp: TS,
      sequenceNumber: 4,
      nodeId: 'a',
      toolId: 't',
      success: true,
      outputSummary: 'ok',
    });
    expect(notified).toBe(0); // coalesced — no immediate repaint per reasoning/tool event
    store.tick();
    expect(notified).toBe(1); // one repaint for the whole burst
  });

  it('keeps animating the spinner while a node is running (tick repaints even when not dirty)', () => {
    const store = createRunStore(true);
    store.apply(nodeStarted); // 'a' is running
    let notified = 0;
    store.subscribe(() => (notified += 1));
    store.tick();
    expect(notified).toBe(1); // repaints for the spinner even with no pending event
    expect(store.getSnapshot().tick).toBe(1);
  });

  it('does NOT flush on an idle tick — no dirty, no running node (the no-needless-repaint guarantee)', () => {
    const store = createRunStore(true);
    store.apply(nodeStarted);
    store.apply({
      type: 'node:completed',
      runId: RUN,
      timestamp: TS,
      sequenceNumber: 2,
      nodeId: 'a',
      output: null,
      tokensUsed: { input: 0, output: 0 },
      durationMs: 1,
    }); // 'a' no longer running, flush cleared dirty
    let notified = 0;
    store.subscribe(() => (notified += 1));
    store.tick();
    expect(notified).toBe(0); // idle → no repaint (CPU/flicker guard)
  });

  it('stops animating once a terminal summary is set (an abandoned running node does not keep ticking)', () => {
    const store = createRunStore(true);
    store.apply(nodeStarted); // 'a' is running and never reaches a node terminal...
    store.apply({ type: 'run:cancelled', runId: RUN, timestamp: TS, sequenceNumber: 2 }); // ...but the run terminates
    let notified = 0;
    store.subscribe(() => (notified += 1));
    store.tick();
    expect(notified).toBe(0); // summary set → no spinner repaint despite 'a' still 'running'
  });

  it('returns a stable snapshot reference between flushes (useSyncExternalStore contract)', () => {
    const store = createRunStore(true);
    store.apply(nodeStarted);
    const first = store.getSnapshot();
    expect(store.getSnapshot()).toBe(first); // same ref until the next flush
    store.apply({
      type: 'node:completed',
      runId: RUN,
      timestamp: TS,
      sequenceNumber: 2,
      nodeId: 'a',
      output: null,
      tokensUsed: { input: 0, output: 0 },
      durationMs: 1,
    });
    expect(store.getSnapshot()).not.toBe(first); // new ref after a flush
  });

  it('threads the color flag into the snapshot', () => {
    expect(createRunStore(false).getSnapshot().color).toBe(false);
    expect(createRunStore(true).getSnapshot().color).toBe(true);
  });

  it('produces the persistent final summary text', () => {
    const store = createRunStore(true);
    store.apply(nodeStarted);
    store.apply({
      type: 'run:completed',
      runId: RUN,
      timestamp: TS,
      sequenceNumber: 2,
      outputs: {},
      totalTokensUsed: { input: 1, output: 2 },
      totalCostMicrocents: 0,
      durationMs: 10,
    });
    expect(store.summaryText()).toContain('run completed');
  });
});

it('isolates a resumed run before sequence, coverage correlation and notification changes', () => {
  const store = createRunStore(false);
  const invocation = {
    producerId: 'same-producer',
    ordinal: 1,
    dispatchId: 'dispatch',
    round: 0,
    chainAttempt: 1,
  };
  const base = { timestamp: TS, nodeId: 'worker', model: 'model' };
  // A session envelope cannot latch the run owner, even if it arrives first.
  store.apply({
    ...base,
    type: 'cost:usage_pending',
    sessionId: 'session',
    sequenceNumber: 900,
    invocation,
  });
  store.apply({ ...base, type: 'cost:usage_pending', runId: RUN, sequenceNumber: 20, invocation });
  const owned = store.getSnapshot();
  expect(owned.state.usageCoverage?.pendingInvocations).toBe(1);
  let notified = 0;
  store.subscribe(() => {
    notified += 1;
  });
  store.apply({
    type: 'run:started',
    runId: 'foreign',
    sequenceNumber: 1000,
    timestamp: TS,
    workflowId: '00000000-0000-4000-8000-000000000001',
    inputs: {},
    executionMode: 'local',
  });
  store.apply({
    ...base,
    type: 'cost:usage_disposition',
    runId: 'foreign',
    sequenceNumber: 1001,
    invocation,
    disposition: { kind: 'incomplete', evidence: { kind: 'missing', reason: 'not_reported' } },
  });
  store.apply({
    ...base,
    type: 'cost:usage_disposition',
    sessionId: 'session',
    sequenceNumber: 1002,
    invocation,
    disposition: { kind: 'not_invoked', reason: 'cancelled' },
  });
  expect(store.getSnapshot()).toBe(owned);
  expect(notified).toBe(0);
  store.apply({
    ...base,
    type: 'cost:usage_disposition',
    runId: RUN,
    sequenceNumber: 21,
    invocation,
    disposition: { kind: 'incomplete', evidence: { kind: 'missing', reason: 'not_reported' } },
  });
  expect(store.getSnapshot().state.lastSequenceNumber).toBe(21);
  expect(store.getSnapshot().state.usageCoverage).toMatchObject({
    pendingInvocations: 0,
    unknownCalls: 1,
  });
  expect(notified).toBe(1);
});
