/**
 * What a command's row in the transcript says: the program and how many arguments it had, never the arguments (one may be a
 * credential, and the row stays in the transcript; the card and `/details` show them behind the reveal, ADR-0118 §1).
 */
import type { ToolPreview } from '@relavium/core';
import { describe, expect, it } from 'vitest';

import { createChatStore } from './chat-store.js';
import { INLINE_TRANSCRIPT_BOUND } from './session-view-model.js';

const SECRET = 'S3cr3tValue9Zq';

function rowOf(toolId: string, preview: ToolPreview): string | undefined {
  const store = createChatStore(false, undefined, INLINE_TRANSCRIPT_BOUND);
  store.applyToolLiveEvent({ phase: 'started', callId: 'c1', toolId });
  store.applyToolLiveEvent({ phase: 'preview', callId: 'c1', toolId, preview });
  return store.getSnapshot().toolDisplays.get('c1')?.target;
}

const command = (...argv: readonly string[]): ToolPreview => ({
  kind: 'operation',
  target: argv.join(' '),
  fields: argv.map((value) => ({ name: '', value })),
});

describe("a command's row names its program and counts its arguments", () => {
  it('says the program alone for none, one argument in the singular, and the count for more', () => {
    expect(rowOf('run_command', command('git'))).toBe('git');
    expect(rowOf('run_command', command('git', 'status'))).toBe('git (1 argument)');
    expect(rowOf('run_command', command('git', 'log', '-n'))).toBe('git (2 arguments)');
    expect(rowOf('run_command', command('git', 'a', 'b', 'c'))).toBe('git (3 arguments)');
  });

  it('never shows an argument, so a credential in one does not stay in the transcript', () => {
    const row = rowOf('run_command', command('tool', `password=${SECRET}`, 'other'));
    expect(row).toBe('tool (2 arguments)');
    expect(row).not.toContain(SECRET);
  });

  it('falls back to the preview target when a command has no field, and leaves any other tool its own target', () => {
    expect(rowOf('run_command', { kind: 'operation', target: 'git', fields: [] })).toBe('git');
    expect(rowOf('write_file', { kind: 'operation', target: 'src/a.ts', fields: [] })).toBe(
      'src/a.ts',
    );
    expect(rowOf('write_file', command('src/a.ts', 'x'))).toBe('src/a.ts x');
  });
});
