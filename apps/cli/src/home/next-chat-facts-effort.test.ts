/**
 * CO72 (unit 7, round 1): the Home and the chat it starts word the effort the same way. The chat's status line words a tier through
 * `effortRowLabel` (`on` for a budget-reasoning model's bound tier, the tier's own name for every other); the Home passed the raw tier, so after
 * `/models` chose a budget model the Home said `effort medium` and the chat it started said `effort on`. The facts are the next chat's, so their
 * words are the chat's.
 */
import type { ReasoningEffort } from '@relavium/shared';
import { describe, expect, it } from 'vitest';

import { chatStatusLine } from '../render/tui/chat-status.js';
import {
  initialSessionViewState,
  INLINE_TRANSCRIPT_BOUND,
} from '../render/tui/session-view-model.js';
import { statusLine } from '../render/tui/status-line.js';
import { nextChatFacts, type NextChatSettings } from './next-chat-facts.js';

const factsFor = (model: string, effort: ReasoningEffort, provider: 'anthropic' | 'openai') =>
  nextChatFacts({
    settings: { defaultModel: model, defaultProvider: provider, reasoningEffort: effort },
    mode: 'ask',
    hasKey: () => true,
    directory: '~/acme-web',
  });

/** The effort word of a line: the one word that follows `effort `. */
const effortWords = (text: string): string | undefined => /effort (\S+)/u.exec(text)?.[1];

/** The chat's status line for a chat bound to `model` and `effort`, drawn wide enough to lose nothing. */
function chatLine(model: string, effort: ReasoningEffort, provider: string): string {
  const state = {
    ...initialSessionViewState({ model, transcript: [] }, INLINE_TRANSCRIPT_BOUND),
  };
  return chatStatusLine(state, { mode: 'ask', reasoningEffort: effort, provider }, 200).text;
}

describe('the Home words the next chat’s effort as the chat does (CO72)', () => {
  it('a budget-reasoning model’s bound tier reads `on` in the facts, in the Home’s line and in the chat’s line', () => {
    // `claude-sonnet-4-5` reasons by budget: its picker has `off` and `on`, and the saved `medium` is the bound `on` tier.
    const facts = factsFor('claude-sonnet-4-5', 'medium', 'anthropic');
    expect(facts.effort).toBe('on');
    const home = statusLine({ surface: 'home', ...facts }, 200).text;
    expect(effortWords(home)).toBe('on');
    expect(effortWords(chatLine('claude-sonnet-4-5', 'medium', 'anthropic'))).toBe('on');
  });

  it('a graded model keeps the tier’s own name, in the facts, in the Home’s line and in the chat’s line', () => {
    const facts = factsFor('gpt-5', 'high', 'openai');
    expect(facts.effort).toBe('high');
    const home = statusLine({ surface: 'home', ...facts }, 200).text;
    expect(effortWords(home)).toBe('high');
    expect(effortWords(chatLine('gpt-5', 'high', 'openai'))).toBe('high');
  });

  it('a budget model’s tier that is not the bound one keeps its name, as the picker words it', () => {
    expect(factsFor('claude-sonnet-4-5', 'high', 'anthropic').effort).toBe('high');
  });

  it('no effort set ⇒ no effort in the facts', () => {
    const settings: NextChatSettings = {
      defaultModel: 'claude-sonnet-4-5',
      defaultProvider: 'anthropic',
      reasoningEffort: undefined,
    };
    const facts = nextChatFacts({ settings, mode: 'ask', hasKey: () => true, directory: '~' });
    expect('effort' in facts).toBe(false);
  });
});
