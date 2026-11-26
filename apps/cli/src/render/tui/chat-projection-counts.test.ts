/**
 * Two small figures the chat's projection words, pinned at their edges (MVP-11 unit 7, round 1: the mutation sweep's cp016, cp089 and cp092,
 * code that predates the unit but is the one the chat's status line reads): the context figure (`contextFullnessPercent`: the last turn's input as
 * a whole percentage of the window, from 0 to 100, absent without a turn or a window) and the count of tool calls a run left out of its row
 * (`entryLines`: one call omitted is still a count to show). `chat-status-line.test.ts` pins one mid-range figure and the ceiling, which is why
 * `* 100` loosened to `* 99` (18% either way at 180,000 of 1,000,000), the floor `Math.max(0, ...)` loosened to `Math.max(1, ...)` and
 * `omitted > 0` loosened to `omitted > 1` all survived.
 */
import { describe, expect, it } from 'vitest';

import { contextFullnessPercent, entryLines } from './chat-projection.js';
import {
  initialSessionViewState,
  INLINE_TRANSCRIPT_BOUND,
  type SessionViewState,
} from './session-view-model.js';

const withTokens = (lastInputTokens: number | undefined, window: number): SessionViewState => ({
  ...initialSessionViewState(
    { model: 'claude-sonnet-4-6', transcript: [] },
    INLINE_TRANSCRIPT_BOUND,
  ),
  ...(lastInputTokens === undefined ? {} : { lastInputTokens }),
  contextWindowTokens: window,
});

describe('the context figure is the last turn’s input as a whole percentage of the window', () => {
  it.each([
    [0, 1000, 0],
    [1, 3, 33],
    [1, 2, 50],
    [3, 4, 75],
    [9, 10, 90],
    [999, 1000, 100],
    [1000, 1000, 100],
    [180_000, 1_000_000, 18],
  ])('%i of %i tokens is %i%%', (input, window, percent) => {
    expect(contextFullnessPercent(withTokens(input, window))).toBe(percent);
  });

  it('a window that is exactly full is 100%, and one that is over it stays at 100%', () => {
    expect(contextFullnessPercent(withTokens(200_000, 200_000))).toBe(100);
    expect(contextFullnessPercent(withTokens(300_000, 200_000))).toBe(100);
  });

  it('is never below zero: a count that came back negative is 0%', () => {
    expect(contextFullnessPercent(withTokens(-5, 1000))).toBe(0);
    expect(contextFullnessPercent(withTokens(-1_000_000, 1000))).toBe(0);
  });

  it('an empty window is no figure, and neither is a turn that has not completed', () => {
    expect(contextFullnessPercent(withTokens(100, 0))).toBeUndefined();
    expect(contextFullnessPercent(withTokens(100, -1))).toBeUndefined();
    expect(contextFullnessPercent(withTokens(undefined, 1000))).toBeUndefined();
  });
});

describe('the calls a tools row left out are counted, one included', () => {
  const call = { id: 'call-1', toolId: 'read_file', resolved: true, success: true } as const;
  const tools = (omitted: number | undefined, calls = [call]) =>
    ({
      role: 'tools',
      text: '',
      calls,
      ...(omitted === undefined ? {} : { omitted }),
    }) as const;

  it('one omitted call is named on the row of the calls that were drawn', () => {
    const lines = entryLines(tools(1));
    expect(lines).toHaveLength(1);
    expect(lines[0]?.text).toContain(' · 1 omitted call');
  });

  it('more than one is named with its count', () => {
    const lines = entryLines(tools(7));
    expect(lines).toHaveLength(1);
    expect(lines[0]?.text).toContain(' · 7 omitted call');
  });

  it('none, zero, or no count says nothing about omitted calls', () => {
    for (const omitted of [undefined, 0]) {
      const lines = entryLines(tools(omitted));
      expect(lines.map((line) => line.text).join('\n'), `omitted=${String(omitted)}`).not.toContain(
        'omitted',
      );
    }
  });

  it('with no call drawn the count is a row of its own', () => {
    const lines = entryLines(tools(2, []));
    expect(lines).toHaveLength(1);
    expect(lines[0]?.style).toBe('notice');
    expect(lines[0]?.text).toContain('2 omitted call');
    expect(entryLines(tools(0, []))).toEqual([]);
  });
});
