import { describe, expect, it } from 'vitest';
import { GlobalConfigSchema } from './config.js';

describe('global operator state', () => {
  it('accepts only each provider’s own literal and a boolean acknowledgement', () => {
    expect(
      GlobalConfigSchema.safeParse({
        preferences: {
          standard_env_key_consent: {
            anthropic: 'ANTHROPIC_API_KEY',
            openai: 'OPENAI_API_KEY',
            gemini: 'GEMINI_API_KEY',
            deepseek: 'DEEPSEEK_API_KEY',
          },
          keychain_unavailable_acknowledged: true,
        },
      }).success,
    ).toBe(true);
    for (const consent of [
      { openai: 'GEMINI_API_KEY' },
      { gemini: 'GOOGLE_API_KEY' },
      { unknown: 'x' },
    ]) {
      expect(
        GlobalConfigSchema.safeParse({ preferences: { standard_env_key_consent: consent } })
          .success,
      ).toBe(false);
    }
    expect(
      GlobalConfigSchema.safeParse({ preferences: { keychain_unavailable_acknowledged: 'true' } })
        .success,
    ).toBe(false);
  });
});
