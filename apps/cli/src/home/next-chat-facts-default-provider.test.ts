/**
 * The facts of the Home's status line name the provider a new chat dials ([ADR-0146](../../../../docs/decisions/0146-the-home-and-the-chat-share-one-calm-layout-and-the-first-run-has-no-dead-end.md)
 * §2). An EXPLICIT `[chat].default_provider` is the person's own word and beats both the first provider that happens to have a key (when no model
 * is configured) and the provider the model's id would suggest (when one is): a line that said `gemini · ...` because Gemini was the only provider
 * with a key, while the chat dials the provider the person saved, would be worse than no line (MVP-11 unit 7, round 1: the mutation sweep's MU74,
 * where dropping the field from the call to `defaultChatModel` survived the whole suite).
 */
import { describe, expect, it } from 'vitest';

import { KNOWN_PROVIDERS } from '../engine/providers.js';
import { nextChatFacts } from './next-chat-facts.js';

const MODE = 'ask';
const DIRECTORY = '~/x';

describe('an explicit default provider is the provider of the next chat', () => {
  it('with no model: the saved provider and its starter model, not the first provider that has a key', () => {
    const facts = nextChatFacts({
      settings: { defaultModel: undefined, defaultProvider: 'openai', reasoningEffort: undefined },
      mode: MODE,
      hasKey: (id) => id === 'gemini',
      directory: DIRECTORY,
    });
    expect(facts.provider).toBe('openai');
    expect(facts.model, 'the starter model of the provider that was named').toBe(
      KNOWN_PROVIDERS.openai.starterModel,
    );
  });

  it('with no model and no saved provider: the first provider with a key (the choice the default agent makes)', () => {
    const facts = nextChatFacts({
      settings: { defaultModel: undefined, defaultProvider: undefined, reasoningEffort: undefined },
      mode: MODE,
      hasKey: (id) => id === 'gemini',
      directory: DIRECTORY,
    });
    expect(facts.provider).toBe('gemini');
    expect(facts.model).toBe(KNOWN_PROVIDERS.gemini.starterModel);
  });

  it('with a model: the saved provider, even where the model id would be read as another provider’s', () => {
    const facts = nextChatFacts({
      settings: { defaultModel: 'gpt-4o', defaultProvider: 'deepseek', reasoningEffort: undefined },
      mode: MODE,
      hasKey: () => true,
      directory: DIRECTORY,
    });
    expect(facts.provider).toBe('deepseek');
    expect(facts.model).toBe('gpt-4o');
  });

  it('with a model and no saved provider: the provider its id says (never back-filled from a key)', () => {
    const facts = nextChatFacts({
      settings: { defaultModel: 'gpt-4o', defaultProvider: undefined, reasoningEffort: undefined },
      mode: MODE,
      hasKey: (id) => id === 'deepseek',
      directory: DIRECTORY,
    });
    expect(facts.provider).toBe('openai');
    expect(facts.model).toBe('gpt-4o');
  });
});
