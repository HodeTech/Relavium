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

  it('accepts the remembered first-run skip as a boolean only (ADR-0146 §6), never a string or a value of the person', () => {
    for (const value of [true, false])
      expect(
        GlobalConfigSchema.safeParse({ preferences: { first_run_setup_skipped: value } }).success,
      ).toBe(true);
    for (const value of ['true', 1, 'sk-ant-api03-not-a-key', { skipped: true }, null])
      expect(
        GlobalConfigSchema.safeParse({ preferences: { first_run_setup_skipped: value } }).success,
      ).toBe(false);
  });
});
