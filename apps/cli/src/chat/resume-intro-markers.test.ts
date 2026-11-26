import { describe, expect, it } from 'vitest';

import { emitIntro } from '../render/tui/chat-ink.js';
import { wrapTranscript } from '../render/tui/chat-projection.js';
import { createChatStore } from '../render/tui/chat-store.js';
import { INLINE_TRANSCRIPT_BOUND } from '../render/tui/session-view-model.js';
import { resumeIntro } from './resume-intro.js';

/**
 * SE7-4 (the scoped security sitting of unit 7): the resume banner carries two stored strings, the session id (`history.db` accepts any non-empty
 * text) and the directory the session started in, and the inline renderer writes the banner to the terminal BEFORE Ink mounts, so it never passes the
 * transcript's row guard. A glyph of the speaker marker's set (`›`, `▸`, `⇄`) in either would put the host's mark into the terminal's history in
 * words that are not the host's. Both go through `blankMarkerGlyphs`, as the model-switch notice's ids do. The glyphs are built from code points.
 */
const MARKERS = [0x203a, 0x25b8, 0x21c4].map((code) => String.fromCodePoint(code));
const ALL = MARKERS.join('');

const LAUNCH = { cwd: '/work/project', home: '/home/me' } as const;

const banner = (over: { sessionId?: string; directory?: string } = {}): string =>
  resumeIntro({
    sessionId: over.sessionId ?? 'sess-1',
    agentId: 'coder',
    turns: 3,
    directory: over.directory ?? '/work/project',
    launchRoots: LAUNCH,
  });

const hasMarker = (text: string): boolean => MARKERS.some((marker) => text.includes(marker));

describe('the resume banner carries no glyph of the speaker marker (SE7-4)', () => {
  it('blanks them in the session id, keeping the rest of the id', () => {
    const text = banner({ sessionId: `a${MARKERS[0]}b${MARKERS[1]}c${MARKERS[2]}d` });
    expect(hasMarker(text)).toBe(false);
    expect(text).toContain('Resuming session a b c d — coder');
  });

  it('blanks them in the directory, wherever the directory is shown', () => {
    for (const directory of [
      `/opt/${ALL}/tools`, // outside both roots, whole
      `/work/project/${ALL}/app`, // inside the project
      `/home/me/${ALL}`, // inside the home
    ]) {
      const text = banner({ directory });
      expect(hasMarker(text), directory).toBe(false);
      expect(text, directory).toContain('Type a message, or /exit to end.');
    }
  });

  it('leaves an ordinary id and directory exactly as they were', () => {
    expect(banner({ sessionId: '0b1f-ac', directory: '/work/project/packages/app' })).toBe(
      'Resuming session 0b1f-ac — coder, 3 prior turns, in packages/app. Type a message, or /exit to end.',
    );
  });

  it('reaches the terminal without one on the inline path: the bytes written before Ink mounts', () => {
    const written: string[] = [];
    emitIntro(banner({ sessionId: ALL, directory: `/opt/${ALL}` }), false, {
      notice: () => undefined,
      writeOut: (text) => void written.push(text),
    });
    expect(written).toHaveLength(1);
    expect(hasMarker(written.join(''))).toBe(false);
  });

  it('reaches the transcript without one on the full-screen path: the rows the viewport draws', () => {
    const store = createChatStore(true, undefined, INLINE_TRANSCRIPT_BOUND);
    emitIntro(banner({ sessionId: ALL, directory: `/opt/${ALL}` }), true, {
      notice: (text, lead) => store.notice(text, lead),
      writeOut: () => undefined,
    });
    const rows = wrapTranscript(store.getSnapshot().state.transcript, 100, true).map(
      (row) => row.text,
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some(hasMarker)).toBe(false);
  });
});
