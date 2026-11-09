import { describe, expect, it } from 'vitest';

import { stripTerminalControls } from './sanitize.js';
import { MAX_PENDING_TERMINAL_CONTROL, TerminalStream } from './terminal-stream.js';

describe('terminal control framing before incremental markdown', () => {
  it('matches the shared floor for every split of complete and incomplete controls', () => {
    for (const source of [
      'a\x1b[31mb\x1b[0mc',
      'a\x1b]8;;https://x.test\x07label\x1b]8;;\x07z',
      'a\x1bPbody\x1b\\z',
      'a\x1b]body\x1b[31mz',
      'a\x1b[broken\nz',
      'a\x1b]unfinished',
      'a\x1b',
      'a\x1b[3',
      'a\x1b\x1b[31mb',
      'a\u202e中\t👩‍💻\n',
    ]) {
      for (let split = 0; split <= source.length; split += 1) {
        const stream = new TerminalStream();
        const result =
          stream.append(source.slice(0, split)) +
          stream.append(source.slice(split)) +
          stream.finish();
        expect(result, `${JSON.stringify(source)} @ ${split}`).toBe(stripTerminalControls(source));
      }
    }
  });

  it('withholds an OSC body until its terminal, never parsing a disguised table or link', () => {
    const stream = new TerminalStream();
    expect(stream.append('hello\x1b]52;c;**hidden**\n| a |')).toBe('hello');
    expect(stream.append('\x07safe')).toBe('safe');
  });

  it('bounds unfinished control buffering and resets for the next segment', () => {
    const stream = new TerminalStream();
    expect(stream.append('\x1b]' + 'x'.repeat(MAX_PENDING_TERMINAL_CONTROL))).toBe('');
    expect(stream.overflowed).toBe(true);
    expect(stream.append('still hidden')).toBe('');
    stream.finish();
    expect(stream.append('next')).toBe('next');
  });
});
