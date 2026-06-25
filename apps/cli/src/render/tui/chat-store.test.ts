import type { SessionStreamHandleEvent } from '@relavium/core';
import { describe, expect, it } from 'vitest';

import { createChatStore } from './chat-store.js';

const started: SessionStreamHandleEvent = {
  type: 'session:started',
  sessionId: 'sess-1',
  sequenceNumber: 0,
  timestamp: '2026-06-25T00:00:00.000Z',
  agentRef: 'relavium-chat',
  model: 'claude-sonnet-4-6',
  context: { workingDir: '/w', fsScopeTier: 'sandboxed' },
};
const turnStarted: SessionStreamHandleEvent = {
  type: 'session:turn_started',
  sessionId: 'sess-1',
  sequenceNumber: 1,
  timestamp: '2026-06-25T00:00:01.000Z',
};
const token = (seq: number, text: string): SessionStreamHandleEvent => ({
  type: 'agent:token',
  sessionId: 'sess-1',
  sequenceNumber: seq,
  timestamp: '2026-06-25T00:00:02.000Z',
  nodeId: 'relavium-chat',
  token: text,
  model: 'claude-sonnet-4-6',
});

describe('createChatStore', () => {
  it('flushes a lifecycle event immediately (notifies subscribers, updates the snapshot)', () => {
    const store = createChatStore(false);
    let notified = 0;
    store.subscribe(() => (notified += 1));
    store.apply(started);
    expect(notified).toBe(1);
    expect(store.getSnapshot().state.model).toBe('claude-sonnet-4-6');
  });

  it('coalesces a high-frequency token event — dirty until the next tick, then repaints', () => {
    const store = createChatStore(false);
    store.apply(started); // running flag not yet set
    store.apply(turnStarted);
    let notified = 0;
    store.subscribe(() => (notified += 1));
    store.apply(token(2, 'hi')); // high-frequency ⇒ coalesced, no immediate flush
    expect(notified).toBe(0);
    expect(store.getSnapshot().state.liveTokens).toBe(''); // snapshot not yet refreshed
    store.tick();
    expect(notified).toBe(1); // the frame flush
    expect(store.getSnapshot().state.liveTokens).toBe('hi');
  });

  it('a tick with no pending state and an idle session does not repaint', () => {
    const store = createChatStore(false);
    store.apply(started); // idle, not running
    let notified = 0;
    store.subscribe(() => (notified += 1));
    store.tick();
    expect(notified).toBe(0); // nothing dirty, not running ⇒ no wasted repaint
  });

  it('repaints on tick while a turn is in flight (the live spinner animates)', () => {
    const store = createChatStore(false);
    store.apply(started);
    store.apply(turnStarted); // status running
    let notified = 0;
    store.subscribe(() => (notified += 1));
    store.tick();
    expect(notified).toBe(1);
    expect(store.getSnapshot().tick).toBe(1);
  });

  it('appendUser adds a user transcript entry and flushes', () => {
    const store = createChatStore(false);
    let notified = 0;
    store.subscribe(() => (notified += 1));
    store.appendUser('hello');
    expect(notified).toBe(1);
    expect(store.getSnapshot().state.transcript).toEqual([{ role: 'user', text: 'hello' }]);
  });

  it('unsubscribe stops further notifications', () => {
    const store = createChatStore(false);
    let notified = 0;
    const off = store.subscribe(() => (notified += 1));
    store.apply(started);
    off();
    store.appendUser('x');
    expect(notified).toBe(1); // only the pre-unsubscribe flush
  });
});
