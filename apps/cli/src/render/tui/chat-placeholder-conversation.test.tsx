import './force-color.js';

import { cleanup } from 'ink-testing-library';
import { afterEach, describe, expect, it } from 'vitest';

import { hasConversation } from './chat-layout.js';
import { GLYPHS } from './glyphs.js';
import {
  mountHostedChat,
  mountStandaloneChat,
  type ChatMount,
  type ChatSetup,
} from './surface-matrix/chat-host.js';
import type { Variant } from './surface-matrix/variants.js';
import { initialSessionViewState, INLINE_TRANSCRIPT_BOUND } from './session-view-model.js';

/**
 * OB7-L9 (the observation of unit 7's chat half): the empty prompt invites `reply to continue` only when there is a conversation to reply to. The
 * predicate was `transcript.length === 0`, so the startup-mode notice of a brand-new first-run chat (a notice, not a conversation) made it
 * `reply to continue`, and the inline renderer's store, which holds only what is new since the terminal's own scrollback took the conversation (a
 * reseat, a resume), made it `type a message` while one exists. A conversation is a user or an assistant entry in the transcript, or the turns a
 * reseat or a resume carried in (`turnCount`). Tested in both hosts and both renderers over the real views.
 */
afterEach(cleanup);

const HOSTS = ['standalone-chat', 'chat'] as const;
const RENDERERS = ['alt', 'inline'] as const;

const variant = (renderer: 'alt' | 'inline'): Variant => ({
  renderer,
  color: false,
  size: { cols: 100, rows: 30 },
});

const STARTUP_NOTICE = 'Starting in ask mode. Shift+Tab changes it.';
const CLEARED_NOTICE = 'Started a fresh session. To continue the last one, start Relavium again.';

async function mountIn(
  host: (typeof HOSTS)[number],
  renderer: 'alt' | 'inline',
  setup: ChatSetup,
): Promise<ChatMount> {
  const full: ChatSetup = {
    ...setup,
    standalone: { provider: 'anthropic', ...setup.standalone },
    hosted: { session: { provider: 'anthropic' }, ...setup.hosted },
  };
  const mount =
    host === 'chat'
      ? await mountHostedChat(variant(renderer), full)
      : mountStandaloneChat(variant(renderer), full);
  await mount.settle();
  return mount;
}

const invitation = (mount: ChatMount): 'reply' | 'first' | 'none' => {
  const text = mount.text();
  if (text.includes('reply to continue')) return 'reply';
  if (text.includes('type a message')) return 'first';
  return 'none';
};

describe.each(HOSTS)('the placeholder of an empty prompt, in the %s host', (host) => {
  describe.each(RENDERERS)('%s renderer', (renderer) => {
    it('is `type a message` in a brand-new chat even when its startup-mode notice is the only entry', async () => {
      const m = await mountIn(host, renderer, {
        prepare: (store) => store.notice(STARTUP_NOTICE),
      });
      try {
        expect(m.store.getSnapshot().state.transcript.length).toBeGreaterThan(0);
        expect(invitation(m), m.text()).toBe('first');
      } finally {
        m.unmount();
      }
    });

    it('is `reply to continue` once a turn has been sent', async () => {
      const m = await mountIn(host, renderer, { prepare: (store) => store.appendUser('hi') });
      try {
        expect(invitation(m), m.text()).toBe('reply');
      } finally {
        m.unmount();
      }
    });

    it('is `type a message` after /clear: the fresh session’s transcript is the notice alone', async () => {
      const m = await mountIn(host, renderer, { prepare: (store) => store.notice(CLEARED_NOTICE) });
      try {
        expect(invitation(m), m.text()).toBe('first');
      } finally {
        m.unmount();
      }
    });

    it('is `reply to continue` after a reseat, whatever the renderer carried: the transcript (alt) or only the turns (inline)', async () => {
      const m = await mountIn(host, renderer, {
        seed: {
          model: 'claude-sonnet-4-6',
          turnCount: 3,
          transcript: [
            { role: 'user', text: 'earlier question' },
            { role: 'assistant', text: 'earlier answer' },
          ],
        },
        prepare: (store) =>
          store.notice(
            `${GLYPHS.modelSwitch.glyph} Model switched to claude-opus-4-6.`,
            'modelSwitch',
          ),
      });
      try {
        expect(invitation(m), m.text()).toBe('reply');
      } finally {
        m.unmount();
      }
    });

    it('is `reply to continue` after /resume of a session that has turns, with a restored transcript or without one', async () => {
      const resumed = await mountIn(host, renderer, {
        seed: {
          model: 'claude-sonnet-4-6',
          turnCount: 2,
          initialRestore: true,
          transcript: [
            { role: 'user', text: 'earlier question' },
            { role: 'assistant', text: 'earlier answer' },
          ],
        },
      });
      try {
        expect(invitation(resumed), resumed.text()).toBe('reply');
      } finally {
        resumed.unmount();
      }
      const bare = await mountIn(host, renderer, {
        seed: { model: 'claude-sonnet-4-6', turnCount: 2, transcript: [] },
      });
      try {
        expect(invitation(bare), bare.text()).toBe('reply');
      } finally {
        bare.unmount();
      }
    });
  });
});

describe('hasConversation: the pure predicate behind the placeholder', () => {
  const state = (
    transcript: readonly { readonly role: string }[],
    turnCount: number,
  ): Parameters<typeof hasConversation>[0] => ({ transcript, turnCount });

  it('is false for nothing, and for notices and tool rows alone', () => {
    expect(hasConversation(state([], 0))).toBe(false);
    expect(hasConversation(state([{ role: 'notice' }, { role: 'notice' }], 0))).toBe(false);
    expect(hasConversation(state([{ role: 'tools' }], 0))).toBe(false);
  });

  it('is true for a user or an assistant entry, or for carried turns', () => {
    expect(hasConversation(state([{ role: 'notice' }, { role: 'user' }], 0))).toBe(true);
    expect(hasConversation(state([{ role: 'assistant' }], 0))).toBe(true);
    expect(hasConversation(state([], 1))).toBe(true);
  });

  it('reads the real view state a store seeds', () => {
    expect(
      hasConversation(
        initialSessionViewState({ transcript: [], turnCount: 4 }, INLINE_TRANSCRIPT_BOUND),
      ),
    ).toBe(true);
    expect(
      hasConversation(initialSessionViewState({ transcript: [] }, INLINE_TRANSCRIPT_BOUND)),
    ).toBe(false);
  });
});
