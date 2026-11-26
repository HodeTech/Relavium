import { describe, expect, it } from 'vitest';

import { deriveSessionTitle } from '../../chat/session-title.js';
import { chatSessionTitle, headerRow } from './chat-layout.js';

/**
 * SE7-7 (the scoped security sitting of unit 7): the header's title was cut to the persister's 40 code points FIRST and scrubbed after, so a key that
 * straddled the cut was no longer a key to the scrubber and the front of its body reached the header (`xxxxxxxxxxxxxxxxxxxx sk-ant-api03-AAAAA…`).
 * The first line is now scrubbed whole (from a window, so a pasted log dump is not walked) and cut after, to the same 40 code points with the same
 * ellipsis, so the title of an ordinary message is exactly the one the persister derives.
 */
/** What the title of a pasted log dump may cost: the whole message is collapsed once (as the persister does) and only a window of it is scrubbed. */
const LOG_DUMP_BOUND_MS = 500;
const KEY = `${['sk', 'ant', 'api03'].join('-')}-${'A'.repeat(80)}`;
const BODY = /sk-ant|api03|AAAA/u;

describe('a key in the first message never reaches the header, wherever it falls against the 40-code-point cut', () => {
  it.each([1, 10, 20, 25, 30, 35, 38, 39, 40, 41, 60])(
    'a key that begins at code point %i',
    (start) => {
      const message = `${'x'.repeat(start - 1)} ${KEY} and more words after it`;
      const title = chatSessionTitle(message);
      expect(title).not.toMatch(BODY);
      expect(headerRow(title, 120).title).not.toMatch(BODY);
    },
  );

  it('a key whose body is far longer than the window is redacted, never partly shown', () => {
    const title = chatSessionTitle(
      `${'x'.repeat(20)} ${['sk', 'ant', 'api03'].join('-')}-${'A'.repeat(5000)}`,
    );
    expect(title).not.toMatch(BODY);
  });

  it('a key written after a newline is not in the first line the title reads, and is not drawn either', () => {
    expect(chatSessionTitle(`short question\n${KEY}`)).not.toMatch(BODY);
  });
});

describe('the title of an ordinary message is the one the persister derives', () => {
  it.each([
    'Refactor the billing module',
    '  Add   VAT\n\tto the invoice  ',
    'x'.repeat(100),
    'A longer first message that is well past the forty code points a title keeps, in words',
    `${'日本語の質問です。'.repeat(8)}`,
    `${'😀'.repeat(60)}`,
  ])('%#', (message) => {
    expect(chatSessionTitle(message)).toBe(deriveSessionTitle(message) ?? '');
  });

  it('keeps the host’s one ellipsis when it cuts, not three dots', () => {
    expect(chatSessionTitle('word '.repeat(30)).endsWith('…')).toBe(true);
    expect(chatSessionTitle('word '.repeat(30)).endsWith('...')).toBe(false);
  });

  it('is empty for a message that is blank or reads as nothing once scrubbed', () => {
    expect(chatSessionTitle('   \n ')).toBe('');
    expect(chatSessionTitle(String.fromCodePoint(0x202e))).toBe('');
  });

  it('does not scrub a pasted log dump whole: two million characters are collapsed once and only a window of them is scrubbed', () => {
    const start = performance.now();
    const title = chatSessionTitle(`error ${'line of a log dump '.repeat(110_000)}`);
    expect(performance.now() - start).toBeLessThan(LOG_DUMP_BOUND_MS);
    expect(Array.from(title).length).toBeLessThanOrEqual(41);
  });
});
