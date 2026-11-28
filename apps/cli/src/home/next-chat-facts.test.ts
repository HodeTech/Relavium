import type { LlmProviderId, ReasoningEffort } from '@relavium/shared';
import { describe, expect, it } from 'vitest';

import { resolveChatAgentSource } from '../chat/agent-source.js';
import { DEFAULT_CHAT_MODEL } from '../chat/default-agent.js';
import { KNOWN_PROVIDERS } from '../engine/providers.js';
import { sameStatusFacts, type HomeStatusFacts } from './home-status-facts.js';
import {
  nextChatFacts,
  nextChatSettings,
  statusDirectory,
  type NextChatSettings,
} from './next-chat-facts.js';

/**
 * The facts of the Home's status line are the facts of the chat a new start builds ([ADR-0146](../../../../docs/decisions/0146-the-home-and-the-chat-share-one-calm-layout-and-the-first-run-has-no-dead-end.md)
 * §2: "the defaults for the next chat"; MVP-11 unit 7, H1). A line that says `openai · gpt-5` while the chat dials Anthropic is worse than no
 * line, so each case here builds the agent the chat binds (`resolveChatAgentSource`, which `buildChatSession` calls) from the same inputs and
 * compares the provider, the model and the effort; `drive-home-status.test.ts` does the same through the real `driveHome`.
 */

type Chat = { -readonly [Key in keyof NextChatSettings]: NextChatSettings[Key] };
const settings = (over: Partial<Chat> = {}): NextChatSettings => ({
  defaultModel: undefined,
  defaultProvider: undefined,
  reasoningEffort: undefined,
  ...over,
});
const none = (): boolean => false;
const only =
  (...ids: LlmProviderId[]) =>
  (id: LlmProviderId): boolean =>
    ids.includes(id);

/** The agent a chat started from `chat` binds, by the function the session build resolves it with. */
function agentOf(chat: NextChatSettings, hasKey: (id: LlmProviderId) => boolean) {
  return resolveChatAgentSource(undefined, {
    cwd: '/work',
    projectConfigDir: undefined,
    homeDir: undefined,
    defaultModel: chat.defaultModel,
    hasKey,
    ...(chat.defaultProvider === undefined ? {} : { defaultProvider: chat.defaultProvider }),
    ...(chat.reasoningEffort === undefined ? {} : { reasoningEffort: chat.reasoningEffort }),
  }).agent;
}

const factsOf = (
  chat: NextChatSettings,
  hasKey: (id: LlmProviderId) => boolean,
  mode = 'ask',
): HomeStatusFacts => nextChatFacts({ settings: chat, mode, hasKey, directory: '~/acme-web' });

describe('the facts are what the chat a new start builds would use', () => {
  const cases: readonly {
    readonly name: string;
    readonly chat: NextChatSettings;
    readonly hasKey: (id: LlmProviderId) => boolean;
  }[] = [
    {
      name: 'a model and the provider it was saved with',
      chat: settings({ defaultModel: 'gpt-4o', defaultProvider: 'openai' }),
      hasKey: only('openai'),
    },
    {
      name: 'a model whose provider is inferred from its id',
      chat: settings({ defaultModel: 'claude-sonnet-4-6' }),
      hasKey: only('anthropic'),
    },
    {
      name: 'a model whose id says its provider only by the o-series rule',
      chat: settings({ defaultModel: 'o3-mini' }),
      hasKey: only('openai'),
    },
    {
      name: 'a model with a reasoning effort',
      chat: settings({
        defaultModel: 'gpt-5',
        defaultProvider: 'openai',
        reasoningEffort: 'high' satisfies ReasoningEffort,
      }),
      hasKey: only('openai'),
    },
    {
      name: 'no model, a key for OpenAI alone: the first provider that has a key, on its starter model',
      chat: settings(),
      hasKey: only('openai'),
    },
    {
      name: 'no model, keys for two: the first in the known order',
      chat: settings(),
      hasKey: only('deepseek', 'gemini'),
    },
    {
      name: 'no model, no key: Anthropic and its starter model, as the zero-config chat',
      chat: settings(),
      hasKey: none,
    },
    {
      name: 'a provider saved without a model, as the config layer never hands one on but a caller may',
      chat: settings({ defaultProvider: 'gemini' }),
      hasKey: only('gemini'),
    },
  ];

  it.each(cases)('$name', ({ chat, hasKey }) => {
    const facts = factsOf(chat, hasKey);
    const agent = agentOf(chat, hasKey);
    expect(facts.model).toBe(agent.model);
    expect(facts.provider).toBe(agent.provider);
    expect(facts.effort).toBe(agent.reasoning_effort);
  });

  it('with no key and no model it is Anthropic’s starter, the one table every first-run path reads', () => {
    const facts = factsOf(settings(), none);
    expect(facts).toMatchObject({ provider: 'anthropic', model: DEFAULT_CHAT_MODEL });
    expect(DEFAULT_CHAT_MODEL).toBe(KNOWN_PROVIDERS.anthropic.starterModel);
  });

  it('a model no provider can be inferred for names no provider: the build refuses it, and the line says nothing of one', () => {
    const chat = settings({ defaultModel: 'my-private-model' });
    expect(() => agentOf(chat, only('anthropic'))).toThrow(/cannot infer a provider/u);
    const facts = factsOf(chat, only('anthropic'));
    expect(facts.model).toBe('my-private-model');
    expect(facts.provider).toBeUndefined();
    expect('provider' in facts).toBe(false);
  });

  it('carries the starting mode and the directory it was given, and an effort only when one is set', () => {
    expect(factsOf(settings(), none, 'plan')).toEqual({
      provider: 'anthropic',
      model: DEFAULT_CHAT_MODEL,
      mode: 'plan',
      directory: '~/acme-web',
    });
    expect(factsOf(settings({ reasoningEffort: 'low' }), none).effort).toBe('low');
  });
});

describe('nextChatSettings: the rule `startChat` applies to the fresh read and the startup snapshot', () => {
  const startup = settings({
    defaultModel: 'gpt-4o',
    defaultProvider: 'openai',
    reasoningEffort: 'medium',
  });

  it('with no fresh model the startup pair stands, and so does its effort', () => {
    expect(nextChatSettings(settings(), startup)).toEqual(startup);
    expect(nextChatSettings(undefined, startup)).toEqual(startup);
  });

  it('a fresh model takes ITS provider, and a fresh model with none is left to be inferred: never the startup provider (review M5)', () => {
    const fresh = settings({ defaultModel: 'claude-sonnet-4-6' });
    const next = nextChatSettings(fresh, startup);
    expect(next.defaultModel).toBe('claude-sonnet-4-6');
    expect(next.defaultProvider).toBeUndefined();
    const named = nextChatSettings(
      settings({ defaultModel: 'claude-sonnet-4-6', defaultProvider: 'anthropic' }),
      startup,
    );
    expect(named.defaultProvider).toBe('anthropic');
  });

  it('the effort is the fresh one, else the startup one', () => {
    expect(nextChatSettings(settings({ reasoningEffort: 'high' }), startup).reasoningEffort).toBe(
      'high',
    );
    expect(nextChatSettings(settings(), startup).reasoningEffort).toBe('medium');
    expect(nextChatSettings(settings(), settings()).reasoningEffort).toBeUndefined();
  });
});

describe('sameStatusFacts', () => {
  const base: HomeStatusFacts = {
    provider: 'anthropic',
    model: 'm',
    mode: 'ask',
    directory: '~/x',
  };

  it('compares every field, so a change of any one is a change', () => {
    expect(sameStatusFacts(base, { ...base })).toBe(true);
    for (const over of [
      { provider: 'openai' },
      { provider: undefined },
      { model: 'n' },
      { mode: 'plan' },
      { effort: 'high' },
      { directory: '~/y' },
    ])
      expect(sameStatusFacts(base, { ...base, ...over }), JSON.stringify(over)).toBe(false);
  });

  it('knows an absent set from a present one', () => {
    expect(sameStatusFacts(undefined, undefined)).toBe(true);
    expect(sameStatusFacts(base, undefined)).toBe(false);
    expect(sameStatusFacts(undefined, base)).toBe(false);
  });
});

describe('statusDirectory: the working directory as the line names it', () => {
  it('is from `~` inside the operator home, and the last name behind `…/` outside it: never absolute', () => {
    expect(statusDirectory('/home/dev/acme-web', '/home/dev')).toBe('~/acme-web');
    expect(statusDirectory('/home/dev', '/home/dev')).toBe('~');
    expect(statusDirectory('/srv/app', '/home/dev')).toBe('…/app');
    expect(statusDirectory('/srv/app', undefined)).toBe('…/app');
  });

  it('reads a backslash by the machine’s own rules (SE7-8): a name on POSIX, a separator on Windows', () => {
    // A POSIX directory whose NAME holds backslashes is one name, never `…/Library` or a path inside the home.
    const hostile = '/home/dev/a\\..\\..\\Library';
    expect(statusDirectory(hostile, '/home/dev', 'linux')).toBe('~/a\\..\\..\\Library');
    expect(statusDirectory(hostile, '/home/dev', 'darwin')).toBe('~/a\\..\\..\\Library');
    expect(statusDirectory('/srv/x\\y', '/home/dev', 'linux')).toBe('…/x\\y');
    // On a Windows host the same text is a path with separators, and the drive is dropped.
    expect(statusDirectory('C:\\Users\\dev\\acme', 'C:\\Users\\dev', 'win32')).toBe('~/acme');
  });

  it('with no platform given uses the one this machine runs on', () => {
    expect(statusDirectory('/home/dev/a\\b', '/home/dev')).toBe(
      statusDirectory('/home/dev/a\\b', '/home/dev', process.platform),
    );
  });
});
