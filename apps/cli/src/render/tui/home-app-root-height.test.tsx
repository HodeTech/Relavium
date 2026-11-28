// Chalk's level is read once, when it is first imported: the matrix's own first import (see `force-color.ts`).
import './force-color.js';

/**
 * The landing root's height while a native card takes the rows (`landingRootHeight`, `home-app.tsx`; MVP-11 step 4, review round 3, HA06): a
 * card the screen cannot hold is drawn as its one-row notice, and the root is ONE row then, never the screen's height. A root of the screen's
 * height writes a row for every row of the terminal (the notice and blank rows under it), so inline, where the live region grows from the
 * shell's cursor, it would push the person's scrollback up by the terminal's height for a one-line notice.
 *
 * The overlay's root (`minHeight: rows − 1` while a popup is open in the alternate screen, HA07) is not pinned: a root of `rows` and one of
 * `rows − 1` write the same bytes at 80×24 in both renderers (ink writes no blank row below the last one drawn), so the mutant is unobservable.
 */
import { describe, expect, it } from 'vitest';

import type { ConsentSubject } from '../../engine/mcp-consent-gate.js';
import { askConsent } from '../../home/consent-card.js';
import { mountHome } from './surface-matrix/home-host.js';

const SUBJECT: ConsentSubject = {
  serverId: 'files',
  provenance: 'inline',
  artifact: 'workflows/build.yaml',
  resolvedCommand: '/usr/local/bin/npx',
  authoredCommand: 'npx',
  args: ['-y', '@example/files-server'],
  env: [],
  cwd: '/work/project',
  digest: 'v1:0123456789abcdef0123456789abcdef',
  total: 1,
  index: 1,
  previouslyApprovedIn: undefined,
};

/** The rows the last frame wrote: what lies between the last synchronized-update begin and its end, by its line feeds. */
function lastFrameRows(raw: string): readonly string[] {
  const begin = raw.lastIndexOf('\u001b[?2026h');
  const end = raw.indexOf('\u001b[?2026l', begin);
  return raw.slice(begin, end).split('\n').slice(0, -1);
}

describe('a native card the screen cannot hold: the landing root is one row (HA06)', () => {
  it.each(['inline', 'alt'] as const)(
    '%s at 70×20: the frame is the one-row notice, with no blank row under it',
    async (renderer) => {
      const m = mountHome(
        { renderer, color: false, size: { cols: 70, rows: 20 } },
        { nativePrompt: true },
      );
      try {
        await m.settle();
        const channel = m.channel;
        if (channel === undefined) throw new Error('no native channel');
        channel.flow.begin();
        askConsent(channel.flow, SUBJECT).catch(() => undefined);
        await m.until(() => m.text().includes('Esc denies'));
        await m.settle();
        const rows = lastFrameRows(m.raw());
        expect(rows).toHaveLength(1);
        expect(rows[0]).toContain('Terminal too small');
      } finally {
        m.unmount();
      }
    },
  );
});
