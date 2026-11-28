/**
 * The approval sheet's title line puts the host's numbers (`+1 -0 · 9 bytes`) flush right beside the target (ADR-0147 §1), and the target is
 * the model's text. A target that ends in a run of spaces and a string shaped like the numbers would sit exactly where the host's numbers do,
 * with the real ones pushed down to the summary row (unit 8 fix wave, S-10). So the numbers go on the title row only when the row holds no run
 * of two or more spaces, a run the target could use to imitate the gap; otherwise they stay on the summary row, after the tool's identity, where
 * they always were. Also the two-column gap itself (M-12, B11): one column is not a gap.
 */
import type { ToolApprovalRequest } from '@relavium/core';
import { render } from 'ink';
import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import { OwnedTtyInput, OwnedTtyOutput, PlainTtyOutput } from '../../test-support.js';
import { ChatApp } from './chat-ink.js';
import { createChatStore } from './chat-store.js';
import { editedFilePreview } from './fixtures/edit-diff.js';
import { FULLSCREEN_TRANSCRIPT_BOUND } from './session-view-model.js';
import { titleStatsGap } from './tool-review-view.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanups.splice(0)) close();
});

// eslint-disable-next-line no-control-regex -- stripping terminal control sequences from a captured frame
const CONTROL = /\u001b\[[0-9;?]*[A-Za-z]|\u001b[78]/gu;
const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('titleStatsGap', () => {
  const STATS = '+1 -0 · 9 bytes';

  it('two columns or more between the title row and the numbers, never one (B11)', () => {
    // At 80 columns the card's drawable width is 78.
    expect(titleStatsGap('x'.repeat(78 - STATS.length - 2), STATS, 80)).toBe(2);
    expect(titleStatsGap('x'.repeat(78 - STATS.length - 1), STATS, 80)).toBeUndefined();
    expect(titleStatsGap('x'.repeat(78 - STATS.length), STATS, 80)).toBeUndefined();
  });

  it('a title row with a run of two or more spaces keeps the numbers off it (S-10)', () => {
    expect(titleStatsGap('Edit src/app.ts', STATS, 80)).toBe(78 - 15 - STATS.length);
    expect(titleStatsGap('Edit notes  draft.md', STATS, 80)).toBeUndefined();
    expect(titleStatsGap(`Edit notes${' '.repeat(30)}${STATS}`, STATS, 80)).toBeUndefined();
    // One space between words is the title's own: the numbers still fit beside it.
    expect(titleStatsGap('Edit my notes.md', STATS, 80)).toBeDefined();
  });
});

describe('on the drawn card', () => {
  /** The approval card for an edit of `target`, at 80×24 in the alternate screen, as rows. */
  async function cardFor(target: string): Promise<readonly string[]> {
    const input = new OwnedTtyInput();
    const output = new PlainTtyOutput();
    const stderr = new OwnedTtyOutput();
    output.columns = 80;
    output.rows = 24;
    const store = createChatStore(false, undefined, FULLSCREEN_TRANSCRIPT_BOUND);
    const instance = render(
      createElement(ChatApp, {
        store,
        onSubmit: () => Promise.resolve(),
        shouldStop: () => false,
        onExit: () => {},
        onError: () => {},
        onModeChange: () => {},
        alternateScreen: true,
      }),
      {
        stdin: input,
        stdout: output,
        stderr,
        interactive: true,
        exitOnCtrlC: false,
        patchConsole: false,
        alternateScreen: true,
      },
    );
    cleanups.push(() => {
      store.sealToolPreviews();
      instance.unmount();
      input.destroy();
      output.destroy();
      stderr.destroy();
    });
    await pause(40);
    const request: ToolApprovalRequest = {
      toolId: 'edit_file',
      action: 'fs_write',
      preview: { path: target },
      unredactedPreview: { path: target },
    };
    void store
      .requestApproval(request, true, undefined, {
        callId: 'forge',
        preview: editedFilePreview(8, { 4: 'four' }, target),
      })
      .catch(() => undefined);
    let rows: readonly string[] = [];
    for (let tries = 0; tries < 60 && rows.length < 2; tries += 1) {
      await pause(20);
      rows = (
        output.frames
          .map((frame) => frame.replace(CONTROL, ''))
          .filter((frame) => frame.includes('Approval needed'))
          .at(-1) ?? ''
      ).split('\n');
    }
    return rows;
  }
  // The host's own numbers for this change (one line replaced: `line 4` by `four`).
  const REAL = 'edit_file · +1 -1 · 12 bytes';

  it.each([
    ['padded to fill the row', `notes${' '.repeat(36)}+1 -0 · 9 bytes`],
    ['padded short of the row', 'notes   +1 -0 · 9 bytes'],
  ])(
    'a target %s that ends in numbers: the host’s are on the summary row, never beside the forged ones',
    async (_label, target) => {
      const rows = await cardFor(target);
      const title = rows.find((row) => row.includes('notes')) ?? '';
      expect(title, rows.join('\n')).toContain('+1 -0 · 9 bytes');
      expect(title.match(/bytes/gu), 'the title row carries the target’s text only').toHaveLength(
        1,
      );
      expect(
        rows.some((row) => row.startsWith(REAL)),
        rows.join('\n'),
      ).toBe(true);
    },
  );

  it('a plain target keeps the numbers flush right on its title row (ADR-0147 §1)', async () => {
    const rows = await cardFor('src/app.ts');
    const title = rows.find((row) => row.startsWith('Edit src/app.ts')) ?? '';
    expect(title).toMatch(/^Edit src\/app\.ts {2,}\+1 -1 · 12 bytes$/u);
    expect(rows.some((row) => row.startsWith(REAL))).toBe(false);
  });
});
