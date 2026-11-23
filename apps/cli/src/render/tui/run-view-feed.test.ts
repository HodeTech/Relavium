/**
 * Where a hosted leg's events go for the Home's run view
 * ([ADR-0139](../../../../../docs/decisions/0139-a-workflow-run-is-hosted-inside-the-home.md) §3): one store per leg, folded by the leg's one
 * reader, with a frame loop that runs only while the leg does. The timer is scripted, so nothing here sleeps.
 */
import type { RunEvent } from '@relavium/shared';
import { describe, expect, it, vi } from 'vitest';

import { createRunViewFeed } from './run-view-feed.js';

const TS = '2026-11-23T12:00:00.000Z';
const nodeStarted = (runId: string): RunEvent => ({
  type: 'node:started',
  runId,
  timestamp: TS,
  sequenceNumber: 1,
  nodeId: 'a',
  nodeType: 'agent',
});
const token = (runId: string, seq: number, text: string): RunEvent => ({
  type: 'agent:token',
  runId,
  timestamp: TS,
  sequenceNumber: seq,
  nodeId: 'a',
  token: text,
  model: 'm',
});

/** A frame timer that records what it started and stopped, and ticks only when the test says so. */
function scriptedFrames() {
  const loops: { readonly tick: () => void; stopped: boolean }[] = [];
  return {
    loops,
    everyFrame: (tick: () => void): (() => void) => {
      const loop = { tick, stopped: false };
      loops.push(loop);
      return () => {
        loop.stopped = true;
      };
    },
  };
}

describe('the run view feed', () => {
  it('calls the Home’s event hook once per event, after the store folded it, and still for a sealed leg', () => {
    const frames = scriptedFrames();
    const seen: (string | undefined)[] = [];
    const feed = createRunViewFeed({
      color: () => false,
      everyFrame: frames.everyFrame,
      onEvent: () => {
        seen.push(feed.storeFor('run-1')?.getSnapshot().state.nodes['a']?.status);
      },
    });
    const renderer = feed.renderer({ runId: 'run-1' });
    renderer.onEvent(nodeStarted('run-1'));
    expect(seen, 'one call, and the store had already folded the event').toEqual(['running']);
    renderer.onEvent(token('run-1', 2, 'x'));
    renderer.seal?.();
    renderer.onEvent(token('run-1', 3, 'y'));
    expect(seen, 'a sealed leg still wrote: the hook runs for its events too').toHaveLength(3);
  });

  it("folds a leg's events into the store the view reads, for that run only", () => {
    const frames = scriptedFrames();
    const feed = createRunViewFeed({ color: () => false, everyFrame: frames.everyFrame });
    const renderer = feed.renderer({ runId: 'run-1' });
    renderer.onEvent(nodeStarted('run-1'));
    const store = feed.storeFor('run-1');
    expect(store?.getSnapshot().state.nodes['a']?.status).toBe('running');
    expect(feed.storeFor('run-2'), 'a run this Home has not hosted has no output').toBeUndefined();
  });

  it('starts its frame loop with the leg and coalesces a token burst to the next frame, dropping none', () => {
    const frames = scriptedFrames();
    const feed = createRunViewFeed({ color: () => false, everyFrame: frames.everyFrame });
    const renderer = feed.renderer({ runId: 'run-1' });
    expect(frames.loops).toHaveLength(1);
    renderer.onEvent(nodeStarted('run-1'));
    const store = feed.storeFor('run-1');
    let repaints = 0;
    store?.subscribe(() => (repaints += 1));
    renderer.onEvent(token('run-1', 2, 'a'));
    renderer.onEvent(token('run-1', 3, 'b'));
    expect(repaints, 'a token burst waits for the frame').toBe(0);
    frames.loops[0]?.tick();
    expect(repaints).toBe(1);
    expect(store?.getSnapshot().state.activeTokens).toBe('ab');
  });

  it('finalize paints the last frame and stops the loop; a late event changes nothing', () => {
    const frames = scriptedFrames();
    const feed = createRunViewFeed({ color: () => false, everyFrame: frames.everyFrame });
    const renderer = feed.renderer({ runId: 'run-1' });
    renderer.onEvent(nodeStarted('run-1'));
    renderer.onEvent(token('run-1', 2, 'x'));
    const store = feed.storeFor('run-1');
    void renderer.finalize?.();
    expect(frames.loops[0]?.stopped).toBe(true);
    expect(store?.getSnapshot().state.activeTokens, 'the coalesced tail was flushed').toBe('x');
    renderer.onEvent(token('run-1', 3, 'late'));
    expect(store?.getSnapshot().state.activeTokens).toBe('x');
  });

  it('seal stops the loop and refuses further events, and is safe to repeat', () => {
    const frames = scriptedFrames();
    const feed = createRunViewFeed({ color: () => false, everyFrame: frames.everyFrame });
    const renderer = feed.renderer({ runId: 'run-1' });
    renderer.seal?.();
    renderer.seal?.();
    void renderer.finalize?.();
    expect(frames.loops[0]?.stopped).toBe(true);
    renderer.onEvent(nodeStarted('run-1'));
    expect(feed.storeFor('run-1')?.getSnapshot().state.nodes['a']).toBeUndefined();
  });

  it('keeps only the newest leg: a resumed run gets a new store, and the old loop is stopped first', () => {
    const frames = scriptedFrames();
    const feed = createRunViewFeed({ color: () => false, everyFrame: frames.everyFrame });
    const first = feed.renderer({ runId: 'run-1' });
    first.onEvent(nodeStarted('run-1'));
    const firstStore = feed.storeFor('run-1');
    const second = feed.renderer({ runId: 'run-1' });
    expect(frames.loops[0]?.stopped, "the older leg's loop ends when the next begins").toBe(true);
    expect(frames.loops[1]?.stopped).toBe(false);
    expect(feed.storeFor('run-1')).not.toBe(firstStore);
    first.onEvent(token('run-1', 2, 'stale'));
    second.onEvent(nodeStarted('run-1'));
    expect(
      feed.storeFor('run-1')?.getSnapshot().state.activeTokens,
      'a straggler event of the older leg does not reach the newer store',
    ).toBe('');
    // A different run replaces it altogether.
    feed.renderer({ runId: 'run-2' });
    expect(feed.storeFor('run-1')).toBeUndefined();
  });

  it('reads the colour decision when a leg starts, not when the feed is made', () => {
    const frames = scriptedFrames();
    let color = true;
    const feed = createRunViewFeed({ color: () => color, everyFrame: frames.everyFrame });
    color = false;
    feed.renderer({ runId: 'run-1' });
    expect(feed.storeFor('run-1')?.getSnapshot().color).toBe(false);
  });

  it('uses an unreferenced real timer by default and stops it', () => {
    vi.useFakeTimers();
    try {
      const feed = createRunViewFeed({ color: () => false });
      const renderer = feed.renderer({ runId: 'run-1' });
      renderer.onEvent(nodeStarted('run-1'));
      renderer.onEvent(token('run-1', 2, 'a'));
      let repaints = 0;
      feed.storeFor('run-1')?.subscribe(() => (repaints += 1));
      vi.advanceTimersByTime(200);
      expect(repaints, 'the default loop ticks the store').toBeGreaterThan(0);
      void renderer.finalize?.();
      const stopped = vi.getTimerCount();
      expect(stopped, 'no timer is left after the leg').toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
