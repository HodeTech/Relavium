import { describe, expect, it } from 'vitest';

import { displayWidth } from '../render/tui/viewport.js';
import { resumeIntro } from './resume-intro.js';

/**
 * The line a resumed chat opens with says where the session lives ([ADR-0145](../../../../docs/decisions/0145-the-cli-has-one-surface-language.md) §8). A
 * resumed chat is anchored to its own directory, not to the one it was resumed from, so its commands run there; the command card names that
 * folder too (`. (project root: <folder>)`), and this line is where the person first reads it. The last words are the idle hint's (`/exit to end`).
 */
const LAUNCH = { cwd: '/work/project', home: '/home/me' } as const;

const intro = (directory: string, over: { turns?: number; sessionId?: string } = {}): string =>
  resumeIntro({
    sessionId: over.sessionId ?? 'sess-1',
    agentId: 'coder',
    turns: over.turns ?? 3,
    directory,
    launchRoots: LAUNCH,
  });

describe('resumeIntro', () => {
  it('says "this directory" when the session lives where the person launched the resume from', () => {
    expect(intro('/work/project')).toBe(
      'Resuming session sess-1 — coder, 3 prior turns, in this directory. Type a message, or /exit to end.',
    );
  });

  it.each([
    ['inside the project, from the project', '/work/project/packages/app', 'packages/app'],
    ['inside the home, from ~', '/home/me/other', '~/other'],
    ['outside both, whole', '/opt/shared/tools', '/opt/shared/tools'],
  ])('names a directory %s', (_name, directory, shown) => {
    expect(intro(directory)).toContain(`prior turns, in ${shown}. Type a message`);
  });

  it('says one prior turn, not "1 prior turns"', () => {
    expect(intro('/work/project', { turns: 1 })).toContain('1 prior turn, in');
    expect(intro('/work/project', { turns: 1 })).not.toContain('1 prior turns');
  });

  it('cuts a long directory at the front to one line, keeping the folder that tells it apart', () => {
    const long = `/opt/${'a-very-long-directory/'.repeat(8)}outside-cmd`;
    const text = intro(long);
    expect(text).toContain(', in …');
    expect(text).toContain('outside-cmd. Type a message');
    expect(text).not.toContain('\n');
    const place = text.slice(text.indexOf(', in ') + 5, text.indexOf('. Type a message'));
    expect(displayWidth(place)).toBeLessThanOrEqual(48);
  });

  it('shortens first and makes the text safe after: nothing in the id or the directory reaches the terminal as a control', () => {
    const text = intro('/work/pro\u0007ject/x', { sessionId: 'evil\u001b]0;x\u0007\nFAKE-ROW' });
    expect(text).toContain('in /work/project/x.');
    for (const character of ['\u001b', '\u0007', '\n'])
      expect(text, JSON.stringify(character)).not.toContain(character);
  });

  it('ends with the words the idle hint uses for leaving, and not with "to quit"', () => {
    expect(intro('/work/project').endsWith('Type a message, or /exit to end.')).toBe(true);
    expect(intro('/work/project')).not.toContain('to quit');
  });
});
