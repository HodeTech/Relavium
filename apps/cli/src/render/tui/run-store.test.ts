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

  it('keeps animating the spinner while a node is running (tick repaints even when not dirty)', () => {
    const store = createRunStore(true);
    store.apply(nodeStarted); // 'a' is running
    let notified = 0;
    store.subscribe(() => (notified += 1));
    store.tick();
    expect(notified).toBe(1); // repaints for the spinner even with no pending event
    expect(store.getSnapshot().tick).toBe(1);
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
