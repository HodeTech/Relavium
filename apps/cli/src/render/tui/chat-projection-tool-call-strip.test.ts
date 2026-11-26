import { describe, expect, it } from 'vitest';

import { formatToolCall } from './chat-projection.js';
import type { ToolDisplay } from './tool-display.js';

const display = (over: Partial<ToolDisplay>): ToolDisplay => ({
  callId: 'tc-1',
  toolId: 'edit_file',
  outcome: 'success',
  ...over,
});

/**
 * The scoped security sitting of unit 7, an improvement: `formatToolCall` trusted its caller to have scrubbed the call's target (the store bounds
 * and sanitises it when it builds the display). The line draws the model's tool id and a path a tool names, so it strips terminal controls from both
 * itself: a display built elsewhere, or a store that changes, cannot put an escape sequence, a bell or a second row into the host's `▸` row.
 */
// eslint-disable-next-line no-control-regex -- asserting the ABSENCE of control bytes
const CONTROL = /[\x00-\x08\x0a-\x1f\x7f-\x9f]/u;

describe('the tool call line strips terminal controls from the id and from the target', () => {
  it('strips an escape sequence, an OSC string, a bell and a newline from a target a display carries', () => {
    const line = formatToolCall(
      { id: 'tc-1', toolId: 'edit_file', resolved: true, success: true },
      display({ target: 'src/\u001b[31ma\u001b]0;pwned\u0007b\nSECOND ROW.ts' }),
    );
    expect(line).not.toMatch(CONTROL);
    expect(line).not.toContain('pwned');
    expect(line.split('\n')).toHaveLength(1);
    expect(line).toContain('src/ab SECOND ROW.ts');
  });

  it('strips them from the id, as before', () => {
    const line = formatToolCall({
      id: 'tc-1',
      toolId: '\u001b[31mread\u001b]0;x\u0007\nfile',
      resolved: false,
    });
    expect(line).toBe('▸ read file …');
  });

  it('leaves an ordinary target as it is, with the host’s arrow', () => {
    const line = formatToolCall(
      { id: 'tc-1', toolId: 'edit_file', resolved: true, success: true },
      display({ target: 'src/app.ts' }),
    );
    expect(line).toContain(' → src/app.ts');
  });
});
