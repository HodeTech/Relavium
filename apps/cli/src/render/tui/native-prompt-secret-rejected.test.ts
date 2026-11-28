/**
 * OB-5 (MVP-11 unit 6, review round 2): what a masked field says when its validator rejects a value. A flow may name its own product sentence
 * (`rejected`, the key step's `Paste your key to continue.`); the validator's reason is never drawn (it could echo the secret); a field whose
 * flow named none keeps the channel's own fixed sentence, and one field's sentence never leaks into the next.
 */
import type { Key } from 'ink';
import { describe, expect, it } from 'vitest';

import {
  createNativePromptChannel,
  NATIVE_PROMPT_SECRET_REJECTED,
} from './native-prompt-channel.js';

const NONE: Key = {
  upArrow: false,
  downArrow: false,
  leftArrow: false,
  rightArrow: false,
  pageDown: false,
  pageUp: false,
  home: false,
  end: false,
  return: false,
  escape: false,
  ctrl: false,
  shift: false,
  tab: false,
  backspace: false,
  delete: false,
  meta: false,
  super: false,
  hyper: false,
  capsLock: false,
  numLock: false,
};
const ENTER: Key = { ...NONE, return: true };
/** A validator whose reason carries what was typed: a surface that drew it would echo the secret. */
const echoing = (value: string): string | undefined =>
  value.startsWith('ok-') ? undefined : `rejected ${value}`;

describe('a masked field’s sentence for a rejected value', () => {
  it('is the flow’s product sentence where it names one, the channel’s own where it does not, and never the validator’s reason', async () => {
    const channel = createNativePromptChannel();
    channel.flow.begin();
    const first = channel.flow.password({
      message: 'Paste your key',
      validate: echoing,
      rejected: 'Paste your key to continue.',
    });
    channel.ui.paste('synthetic-secret-9184');
    channel.ui.input('\r', ENTER);
    expect(channel.ui.getSnapshot().error).toBe('Paste your key to continue.');
    expect(JSON.stringify(channel.ui.getSnapshot())).not.toContain('9184');
    channel.ui.input('', { ...NONE, backspace: true });
    for (let at = 0; at < 'synthetic-secret-918'.length; at += 1)
      channel.ui.input('', { ...NONE, backspace: true });
    channel.ui.paste('ok-first');
    channel.ui.input('\r', ENTER);
    expect(await first).toBe('ok-first');

    // The next field names no sentence: the channel's own, not the one the field before it named.
    const second = channel.flow.password({ message: 'Secret input', validate: echoing });
    channel.ui.paste('synthetic-secret-2207');
    channel.ui.input('\r', ENTER);
    expect(channel.ui.getSnapshot().error).toBe(NATIVE_PROMPT_SECRET_REJECTED);
    expect(NATIVE_PROMPT_SECRET_REJECTED).toBe('A valid value is required.');
    expect(JSON.stringify(channel.ui.getSnapshot())).not.toContain('2207');
    channel.flow.cancel();
    expect(typeof (await second)).toBe('symbol');
    await channel.flow.end();
  });
});
