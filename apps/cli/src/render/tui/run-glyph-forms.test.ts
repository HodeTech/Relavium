import type { RunEvent } from '@relavium/shared';
import { describe, expect, it } from 'vitest';

import { createRunStore } from './run-store.js';

/**
 * The run view's glyphs are built outside any view: the reducer bakes a tool call and a tool result into the state, and the final summary is
 * written after the view is gone. The store knows the colour setting, so it asks for the glyph table's plain forms there
 * ([ADR-0145](../../../../../docs/decisions/0145-the-cli-has-one-surface-language.md) §5): with colour off the lines read `-> read_file` and
 * `ok completed read_file: done`; with colour on, `▸ read_file` and `✓ completed read_file: done`.
 */

const TS = '2026-06-23T12:00:00.000Z';
const RUN = 'run-1';
const base = { runId: RUN, timestamp: TS, nodeId: 'a' } as const;

const EVENTS: readonly RunEvent[] = [
  { ...base, type: 'node:started', sequenceNumber: 1, nodeType: 'agent' },
  { ...base, type: 'agent:tool_call', sequenceNumber: 2, model: 'm', toolId: 'read_file' },
  {
    ...base,
    type: 'agent:tool_result',
    sequenceNumber: 3,
    toolId: 'read_file',
    success: true,
    outputSummary: 'done',
  },
  {
    ...base,
    type: 'agent:tool_result',
    sequenceNumber: 4,
    toolId: 'write_file',
    success: false,
    outputSummary: 'denied by policy',
  },
  {
    ...base,
    type: 'node:completed',
    sequenceNumber: 5,
    output: null,
    tokensUsed: { input: 0, output: 0 },
    durationMs: 420,
  },
];

function stateOf(color: boolean) {
  const store = createRunStore(color);
  for (const event of EVENTS) store.apply(event);
  return store;
}

describe('the run store builds its glyphs in the form the colour setting asks for', () => {
  it('colour off: the tool lines and the final summary use the plain forms', () => {
    const store = stateOf(false);
    expect(store.getSnapshot().state.toolLines).toEqual([
      '-> read_file',
      'ok completed read_file: done',
      'x failed write_file: denied by policy',
    ]);
    const summary = store.summaryText();
    expect(summary).toContain('ok completed a (420ms)');
    expect(summary).not.toMatch(/[✓✗▸]/u);
  });

  it('colour on: the same lines use the Unicode glyphs', () => {
    const store = stateOf(true);
    expect(store.getSnapshot().state.toolLines).toEqual([
      '▸ read_file',
      '✓ completed read_file: done',
      '✗ failed write_file: denied by policy',
    ]);
    expect(store.summaryText()).toContain('✓ completed a (420ms)');
  });

  it('the form of one store does not leak into another', () => {
    const plain = stateOf(false);
    const coloured = stateOf(true);
    expect(plain.getSnapshot().state.toolLines[0]).toBe('-> read_file');
    expect(coloured.getSnapshot().state.toolLines[0]).toBe('▸ read_file');
  });
});
