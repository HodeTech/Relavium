import { describe, expect, it } from 'vitest';

import { STARTING_CHAT_LINE } from './home-app.js';
import { EXIT_AGAIN, EXIT_TWICE } from './home-pages.js';

/**
 * The key that leaves the Home is of the `leave` class ([ADR-0145](../../../../../docs/decisions/0145-the-cli-has-one-surface-language.md) §2):
 * the first `Ctrl+C` arms and the second one exits the application, which is more than `close` (nothing changes). The words are the same as
 * before; the class is what the legend builder, the golden and every surface that names its leaving key agree on.
 */
describe('the Home’s leaving key', () => {
  it('is Ctrl+C, in the leave class, with the count in the verb', () => {
    expect(EXIT_TWICE).toMatchObject({ keys: 'Ctrl+C', verb: 'exit (twice)', class: 'leave' });
    expect(EXIT_AGAIN).toMatchObject({ keys: 'Ctrl+C', verb: 'exit (again)', class: 'leave' });
  });

  it('says the same words on the line under the echo of the first message', () => {
    expect(STARTING_CHAT_LINE).toBe('Starting chat… · [Ctrl+C] exit');
  });
});
