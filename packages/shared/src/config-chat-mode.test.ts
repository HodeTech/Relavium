import { describe, expect, it } from 'vitest';

import { CHAT_MODES } from './constants.js';
import { GlobalConfigSchema, ProjectConfigSchema } from './config.js';

describe('starting chat mode configuration (ADR-0116)', () => {
  it.each(CHAT_MODES)('accepts operator mode %s and a Boolean hint', (mode) => {
    expect(
      GlobalConfigSchema.parse({
        preferences: { default_mode: mode, default_mode_hint_shown: true },
      }).preferences,
    ).toEqual({ default_mode: mode, default_mode_hint_shown: true });
  });

  it.each(['ask', 'plan'])('accepts repository mode %s', (mode) => {
    expect(ProjectConfigSchema.parse({ chat: { default_mode: mode } }).chat?.default_mode).toBe(
      mode,
    );
  });

  // accept-edits dispatches fs_write without a card (ADR-0130 §3), so a repository file cannot select it
  // any more than it can select auto: a cloned repo must not start the chat in a cardless write mode.
  it.each(['auto', 'accept-edits', 'AUTO', '', false, 1, null])(
    'refuses repository mode %s',
    (mode) => {
      expect(
        ProjectConfigSchema.safeParse({ chat: { default_mode: mode } }).success,
        'W2_STARTUP_REPOSITORY_AUTO_REFUSAL',
      ).toBe(false);
    },
  );

  it.each([true, false])('refuses repository hint acknowledgement %s', (shown) => {
    expect(
      ProjectConfigSchema.safeParse({ chat: { default_mode_hint_shown: shown } }).success,
    ).toBe(false);
    expect(
      ProjectConfigSchema.safeParse({ preferences: { default_mode_hint_shown: shown } }).success,
    ).toBe(false);
  });

  it('retains strict operator fields and hint types', () => {
    expect(GlobalConfigSchema.safeParse({ chat: { default_mode: 'auto' } }).success).toBe(false);
    expect(
      GlobalConfigSchema.safeParse({ preferences: { default_mode: 'unknown-mode' } }).success,
    ).toBe(false);
    expect(
      GlobalConfigSchema.safeParse({ preferences: { default_mode_hint_shown: 'true' } }).success,
    ).toBe(false);
  });
});
