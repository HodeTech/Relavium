import { afterEach, describe, expect, it } from 'vitest';

import { chatGrid, MARGIN_WORDS } from './chat-grid.js';
import type { TranscriptEntry } from './session-view-model.js';
import { mountStandaloneChat, type ChatMount } from './surface-matrix/chat-host.js';

/**
 * The inline renderer on the grid (MVP-11 unit 9, plan §3.3 and §4 invariant 6, OQ7): each row it prints through `<Static>` is the margin in its
 * WORD form and the content, a wrapped row hangs, and one blank row separates the turns exactly as the full-screen viewport does (the inline
 * renderer prints one entry at a time, so each entry is handed the one before it). The words are a closed, ASCII set: `you` on the first row of
 * the person's turn and of the question record, `agent` on the first row of a reply, `tool` on each tool row, `model` on the model-switch
 * notice, none on an ordinary notice.
 */

const mounts: ChatMount[] = [];
afterEach(() => {
  for (const mount of mounts.splice(0)) mount.unmount();
});

const TRANSCRIPT: readonly TranscriptEntry[] = [
  { role: 'user', text: 'one' },
  { role: 'assistant', text: 'two' },
  {
    role: 'tools',
    text: '',
    calls: [{ id: 'c', toolId: 'read_file', resolved: true, success: true, outcome: 'success' }],
  },
  { role: 'notice', text: 'an ordinary notice' },
  { role: 'notice', text: '› Asked: Scope — which?\n  └ alpha', hostLead: 'yourTurn' },
  { role: 'notice', text: '⇄ model changed a → b', hostLead: 'modelSwitch' },
  { role: 'user', text: 'three' },
];

describe.each([true, false])('the inline transcript, colour %s', (color) => {
  it.each([80, 100])(
    'at %i columns: word, padding, content; a blank row before each turn and reply',
    async (cols) => {
      const mount = mountStandaloneChat(
        { renderer: 'inline', color, size: { cols, rows: 40 } },
        { seed: { initialRestore: true, transcript: TRANSCRIPT } },
      );
      mounts.push(mount);
      await mount.until(() => mount.frame().join('\n').includes('three'));
      await mount.settle();
      const frame = mount.frame().map((row) => row.trimEnd());
      const first = frame.findIndex((row) => row.endsWith('one'));
      expect(first, frame.join('\n')).toBeGreaterThanOrEqual(0);
      const margin = chatGrid(cols).margin;
      const word = (role: keyof typeof MARGIN_WORDS, content: string): string =>
        `${MARGIN_WORDS[role].padEnd(margin)}${content}`;
      const tool = color ? 'read_file ✓ completed' : 'read_file ok completed';
      expect(frame.slice(first, first + 10)).toEqual([
        word('yourTurn', 'one'),
        '',
        word('agent', 'two'),
        word('toolCall', tool),
        `${' '.repeat(margin)}an ordinary notice`,
        word('yourTurn', 'Asked: Scope — which?'),
        `${' '.repeat(margin)}  └ alpha`,
        word('modelSwitch', 'model changed a → b'),
        '',
        word('yourTurn', 'three'),
      ]);
    },
  );
});
