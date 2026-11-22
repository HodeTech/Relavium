import { TOOL_ACTIVITY_MAX_ENTRIES } from '@relavium/shared';
import { describe, expect, it } from 'vitest';

import { ToolActivityTracker } from './tool-activity.js';

describe('ToolActivityTracker (ADR-0140 §4)', () => {
  it('a node that made no tool call takes an empty trace and no truncated count', () => {
    const tracker = new ToolActivityTracker();
    expect(tracker.take('n')).toEqual({ toolActivity: [] });
    tracker.reset('n');
    expect(tracker.take('n')).toEqual({ toolActivity: [] });
  });

  it('pairs a result with its call: ok follows success, durationMs is the gap between the two', () => {
    const tracker = new ToolActivityTracker();
    tracker.recordCall('n', 'read_file', 100);
    tracker.recordResult('n', 'read_file', true, 130);
    tracker.recordCall('n', 'run_command', 140);
    tracker.recordResult('n', 'run_command', false, 141);
    // A failed RESULT is ok:false WITH a duration — distinct from an unpaired call below.
    expect(tracker.take('n')).toEqual({
      toolActivity: [
        { toolId: 'read_file', ok: true, durationMs: 30 },
        { toolId: 'run_command', ok: false, durationMs: 1 },
      ],
    });
  });

  it('pairs FIFO: a result takes the OLDEST unpaired call of the same tool, in call order', () => {
    const tracker = new ToolActivityTracker();
    tracker.recordCall('n', 'read_file', 100);
    tracker.recordCall('n', 'read_file', 110);
    tracker.recordResult('n', 'read_file', true, 150); // pairs with the call at 100
    tracker.recordResult('n', 'read_file', false, 200); // pairs with the call at 110
    expect(tracker.take('n').toolActivity).toEqual([
      { toolId: 'read_file', ok: true, durationMs: 50 },
      { toolId: 'read_file', ok: false, durationMs: 90 },
    ]);
  });

  it('keeps two PARALLEL calls of one tool apart — the first result never pairs with the second call', () => {
    const tracker = new ToolActivityTracker();
    tracker.recordCall('n', 'web_fetch', 0);
    tracker.recordCall('n', 'web_fetch', 5);
    tracker.recordResult('n', 'web_fetch', true, 20);
    // Only the first call is paired so far: the second is still unpaired and must say so.
    const afterOne = tracker.take('n').toolActivity;
    expect(afterOne).toEqual([
      { toolId: 'web_fetch', ok: true, durationMs: 20 },
      { toolId: 'web_fetch', ok: false },
    ]);
  });

  it('does not cross tools: a result pairs only with a call of its own tool id', () => {
    const tracker = new ToolActivityTracker();
    tracker.recordCall('n', 'read_file', 0);
    tracker.recordCall('n', 'run_command', 1);
    tracker.recordResult('n', 'run_command', true, 9);
    expect(tracker.take('n').toolActivity).toEqual([
      { toolId: 'read_file', ok: false },
      { toolId: 'run_command', ok: true, durationMs: 8 },
    ]);
  });

  it('does not cross nodes: a result pairs only with a call of its own node', () => {
    const tracker = new ToolActivityTracker();
    tracker.recordCall('a', 'read_file', 0);
    tracker.recordResult('b', 'read_file', true, 10); // node b never called it
    tracker.recordCall('b', 'read_file', 20);
    tracker.recordResult('b', 'read_file', true, 25);
    expect(tracker.take('a').toolActivity).toEqual([{ toolId: 'read_file', ok: false }]);
    expect(tracker.take('b').toolActivity).toEqual([
      { toolId: 'read_file', ok: true, durationMs: 5 },
    ]);
  });

  it('an unpaired call is ok:false with NO durationMs key at all', () => {
    const tracker = new ToolActivityTracker();
    tracker.recordCall('n', 'run_command', 7);
    const [entry] = tracker.take('n').toolActivity;
    expect(entry).toEqual({ toolId: 'run_command', ok: false });
    expect(entry).not.toHaveProperty('durationMs');
  });

  it('ignores a result that has no matching call, and one that arrives after its call was paired', () => {
    const tracker = new ToolActivityTracker();
    tracker.recordResult('n', 'read_file', true, 5); // no call at all
    tracker.recordCall('n', 'read_file', 10);
    tracker.recordResult('n', 'read_file', true, 20);
    tracker.recordResult('n', 'read_file', false, 99); // the only call is already paired
    expect(tracker.take('n')).toEqual({
      toolActivity: [{ toolId: 'read_file', ok: true, durationMs: 10 }],
    });
  });

  it('keeps the first 50 calls and counts the rest: 50 calls truncate nothing, 51 truncate one', () => {
    const fifty = new ToolActivityTracker();
    for (let index = 0; index < TOOL_ACTIVITY_MAX_ENTRIES; index += 1) {
      fifty.recordCall('n', `tool-${index}`, index);
    }
    const exact = fifty.take('n');
    expect(exact.toolActivity).toHaveLength(TOOL_ACTIVITY_MAX_ENTRIES);
    expect(exact).not.toHaveProperty('toolActivityTruncated');

    const tracker = new ToolActivityTracker();
    for (let index = 0; index < TOOL_ACTIVITY_MAX_ENTRIES + 1; index += 1) {
      tracker.recordCall('n', `tool-${index}`, index);
    }
    const snapshot = tracker.take('n');
    expect(snapshot.toolActivity).toHaveLength(TOOL_ACTIVITY_MAX_ENTRIES);
    expect(snapshot.toolActivity[0]?.toolId).toBe('tool-0');
    expect(snapshot.toolActivity.at(-1)?.toolId).toBe(`tool-${TOOL_ACTIVITY_MAX_ENTRIES - 1}`);
    expect(snapshot.toolActivityTruncated).toBe(1);
  });

  it('counts every call beyond the bound, and ignores the result of one that was not kept', () => {
    const tracker = new ToolActivityTracker();
    for (let index = 0; index < TOOL_ACTIVITY_MAX_ENTRIES + 7; index += 1) {
      tracker.recordCall('n', 'bash', index);
    }
    // The first 50 calls are still unpaired, so this result pairs with the FIRST kept call (FIFO) — it cannot
    // reach a dropped one — and the dropped ones leave no entry however many results arrive.
    tracker.recordResult('n', 'bash', true, 1000);
    const snapshot = tracker.take('n');
    expect(snapshot.toolActivityTruncated).toBe(7);
    expect(snapshot.toolActivity).toHaveLength(TOOL_ACTIVITY_MAX_ENTRIES);
    expect(snapshot.toolActivity[0]).toEqual({ toolId: 'bash', ok: true, durationMs: 1000 });
    expect(snapshot.toolActivity[1]).toEqual({ toolId: 'bash', ok: false });
  });

  it('clamps a negative gap to 0: a clock that stepped back never makes a negative duration', () => {
    const tracker = new ToolActivityTracker();
    tracker.recordCall('n', 'read_file', 500);
    tracker.recordResult('n', 'read_file', true, 400);
    expect(tracker.take('n').toolActivity).toEqual([
      { toolId: 'read_file', ok: true, durationMs: 0 },
    ]);
  });

  it('writes a whole-number duration even from a fractional clock reading', () => {
    const tracker = new ToolActivityTracker();
    tracker.recordCall('n', 'read_file', 10.25);
    tracker.recordResult('n', 'read_file', true, 20.75);
    expect(tracker.take('n').toolActivity).toEqual([
      { toolId: 'read_file', ok: true, durationMs: 10 },
    ]);
  });

  it('take clears the node: a second take, or a late result, finds nothing', () => {
    const tracker = new ToolActivityTracker();
    tracker.recordCall('n', 'read_file', 0);
    expect(tracker.take('n').toolActivity).toHaveLength(1);
    expect(tracker.take('n')).toEqual({ toolActivity: [] });
    tracker.recordResult('n', 'read_file', true, 9); // a straggler after the terminal: nothing to pair with
    expect(tracker.take('n')).toEqual({ toolActivity: [] });
  });

  it('reset starts a new attempt: calls, results and the count of the earlier attempt are gone', () => {
    const tracker = new ToolActivityTracker();
    for (let index = 0; index < TOOL_ACTIVITY_MAX_ENTRIES + 3; index += 1) {
      tracker.recordCall('n', 'attempt-one', index);
    }
    tracker.reset('n'); // attempt 2 starts
    tracker.recordCall('n', 'attempt-two', 100);
    // A late result of attempt one's tool must not pair with, or be counted into, attempt two.
    tracker.recordResult('n', 'attempt-one', true, 101);
    tracker.recordResult('n', 'attempt-two', true, 105);
    expect(tracker.take('n')).toEqual({
      toolActivity: [{ toolId: 'attempt-two', ok: true, durationMs: 5 }],
    });
  });

  it('reset touches only its own node', () => {
    const tracker = new ToolActivityTracker();
    tracker.recordCall('a', 'read_file', 0);
    tracker.recordCall('b', 'read_file', 0);
    tracker.reset('a');
    expect(tracker.take('a').toolActivity).toEqual([]);
    expect(tracker.take('b').toolActivity).toEqual([{ toolId: 'read_file', ok: false }]);
  });

  it('is content-free: the entries hold only toolId, ok and durationMs', () => {
    const tracker = new ToolActivityTracker();
    tracker.recordCall('n', 'run_command', 0);
    tracker.recordResult('n', 'run_command', true, 3);
    for (const entry of tracker.take('n').toolActivity) {
      expect(Object.keys(entry).sort()).toEqual(['durationMs', 'ok', 'toolId']);
    }
  });
});
