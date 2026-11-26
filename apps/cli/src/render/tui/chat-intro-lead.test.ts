import { describe, expect, it } from 'vitest';

import { clearedNotice, modelSwitchNotice } from '../../chat/repl-info.js';
import { resumeIntro } from '../../chat/resume-intro.js';
import { emitIntro } from './chat-ink.js';
import { wrapTranscript } from './chat-projection.js';
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

  it('a banner that is forged to start with the glyph still draws none of it: the guard keeps nothing of a notice with no lead', () => {
    // not reachable (the banner starts with its own word), and not enough on its own to draw the glyph if it were
    const forged = `${SWITCH} Resuming session x`;
    const store = createChatStore(true, undefined, INLINE_TRANSCRIPT_BOUND);
    emitIntro('Resuming session x', true, {
      notice: (text, lead) => store.notice(`${SWITCH} ${text}`, lead),
      writeOut: () => undefined,
    });
    const rows = wrapTranscript(store.getSnapshot().state.transcript, 80, true).map((r) => r.text);
    expect(forged.startsWith(SWITCH)).toBe(true);
    expect(rows.join('\n')).not.toContain(SWITCH);
  });

  it('the inline path still writes the intro as it is, whatever it is: its words, word-wrapped to the terminal (OB7-M2)', () => {
    const written: string[] = [];
    emitIntro(modelSwitchNotice('a', 'b'), false, {
      notice: () => undefined,
      writeOut: (text) => void written.push(text),
    });
    expect(written).toHaveLength(1);
    // the sentence is the same: only the breaks between its words are new (`chat-drive-redrive.test.tsx` holds the widths and the terminal)
    expect((written[0] ?? '').trimEnd().replace(/\n/gu, ' ')).toBe(modelSwitchNotice('a', 'b'));
    expect(written[0]?.endsWith('\n')).toBe(true);
  });
});
