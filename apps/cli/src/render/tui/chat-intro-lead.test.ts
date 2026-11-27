import { describe, expect, it } from 'vitest';

import { clearedNotice, modelSwitchNotice } from '../../chat/repl-info.js';
import { resumeIntro } from '../../chat/resume-intro.js';
import { emitIntro } from './chat-ink.js';
import { transcriptRows } from './chat-projection.js';
import { chatGrid } from './chat-grid.js';
import { createChatStore } from './chat-store.js';
import { INLINE_TRANSCRIPT_BOUND } from './session-view-model.js';

/**
 * The scoped security sitting of unit 7, an improvement: `emitIntro` used to flag EVERY full-screen intro (the resume banner, the `/clear` notice, the
 * model switch) as leading with the host's `⇄`, so the guard kept a `⇄` at the start of a line of text that is not a model switch. Only the model-switch
 * notice leads with it, so only it is given the lead; the others are given none, and the guard keeps nothing of them.
 */
const SWITCH = String.fromCodePoint(0x21c4);

function noticesOf(intro: string): { text: string; lead: string | undefined }[] {
  const out: { text: string; lead: string | undefined }[] = [];
  emitIntro(intro, true, {
    notice: (text, lead) => void out.push({ text, lead }),
    writeOut: () => undefined,
  });
  return out;
}

describe('which full-screen intro may lead with the model-switch glyph', () => {
  it('the model-switch notice leads with it', () => {
    const switched = modelSwitchNotice('claude-a', 'claude-b');
    expect(switched.startsWith(SWITCH)).toBe(true);
    expect(noticesOf(switched)).toEqual([{ text: switched, lead: 'modelSwitch' }]);
  });

  it('the resume banner and the /clear notice lead with nothing', () => {
    const banner = resumeIntro({
      sessionId: 'sess-1',
      agentId: 'coder',
      turns: 2,
      directory: '/work/project',
      launchRoots: { cwd: '/work/project', home: '/home/me' },
    });
    for (const text of [banner, clearedNotice('home'), clearedNotice('standalone-chat')]) {
      const [only] = noticesOf(text);
      expect(only?.lead, text).toBeUndefined();
    }
  });

  it('a banner that is forged to start with the glyph still draws no mark: a notice with no lead has no margin role on any row', () => {
    // not reachable (the banner starts with its own word), and not enough on its own to draw the mark if it were. Moved in unit 9: the guard is
    // structural now (the grid): the glyph is not blanked, it stays TEXT in the content column, and the margin, the only place a mark is drawn,
    // carries no role, because only the host's `hostLead` gives one.
    const forged = `${SWITCH} Resuming session x`;
    const store = createChatStore(true, undefined, INLINE_TRANSCRIPT_BOUND);
    emitIntro('Resuming session x', true, {
      notice: (text, lead) => store.notice(`${SWITCH} ${text}`, lead),
      writeOut: () => undefined,
    });
    const rows = transcriptRows(store.getSnapshot().state.transcript, chatGrid(80), true);
    expect(forged.startsWith(SWITCH)).toBe(true);
    expect(rows.map((row) => row.margin)).toEqual(rows.map(() => undefined));
    expect(rows[0]?.text).toBe(forged); // the words as they are, in the content column
  });

  it('the inline path writes the intro in the content column, its words word-wrapped to it (OB7-M2), and the model switch with the role word in the margin', () => {
    const written: string[] = [];
    emitIntro(modelSwitchNotice('a', 'b'), false, {
      notice: () => undefined,
      writeOut: (text) => void written.push(text),
    });
    expect(written).toHaveLength(1);
    // Moved in unit 9: the intro stands on the grid. The margin is blank except on the first row of the model-switch notice, which the inline renderer
    // marks with its word `model` where the sentence began with the glyph; the glyph leaves the text. (`chat-drive-redrive.test.tsx` holds the widths.)
    const grid = chatGrid(80);
    const rows = (written[0] ?? '').trimEnd().split('\n');
    expect(rows[0]?.slice(0, grid.margin)).toBe('model'.padEnd(grid.margin));
    for (const row of rows.slice(1))
      expect(row.slice(0, grid.margin)).toBe(' '.repeat(grid.margin));
    // the sentence is the same: only the glyph that led it and the breaks between its words are new
    expect(rows.map((row) => row.slice(grid.margin)).join(' ')).toBe(
      modelSwitchNotice('a', 'b').slice(`${SWITCH} `.length),
    );
    expect(written[0]?.endsWith('\n')).toBe(true);
  });

  it('the inline resume banner and the /clear notice have a blank margin: only the model switch is marked', () => {
    for (const text of [clearedNotice('home'), 'Resuming session x']) {
      const written: string[] = [];
      emitIntro(text, false, {
        notice: () => undefined,
        writeOut: (out) => void written.push(out),
      });
      const rows = (written[0] ?? '').trimEnd().split('\n');
      for (const row of rows)
        expect(row.slice(0, chatGrid(80).margin), text).toBe(' '.repeat(chatGrid(80).margin));
    }
  });
});
