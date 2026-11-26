import './force-color.js';

import { cleanup } from 'ink-testing-library';
import { afterEach, describe, expect, it } from 'vitest';

import { createChatStore } from './chat-store.js';
import {
  appendUserMessage,
  appendWarning,
  initialSessionViewState,
  INLINE_TRANSCRIPT_BOUND,
  reduceSessionEvent,
} from './session-view-model.js';
import {
  mountHostedChat,
  mountStandaloneChat,
  type ChatMount,
} from './surface-matrix/chat-host.js';
import type { Variant } from './surface-matrix/variants.js';

/**
 * OB7-L1 (the observation of unit 7's chat half): the leading row of the prompt block showed the newest warning forever (`⚠ @bigfile.txt: truncated to
 * fit…` over the turn that was sent with it, and over every turn after, until `/clear`). A warning answers a gesture the person made (an attachment cut
 * to fit, a mention that could not be read, a command refused); it is consumed when the next message is sent. A warning about the SESSION (an event
 * gap, an MCP tool the build skipped) stays: a message does not change it. Which are which is the `lifetime` of the note.
 */
afterEach(cleanup);

const ATTACHMENT = '@bigfile.txt: truncated to fit the 64 KiB limit';
const MCP = "MCP tool 'search' (server 'docs') skipped — not allowed";

describe('the store consumes a warning about a gesture when the next message is sent', () => {
  it('keeps the warning until a message is sent, consumes it then, and keeps a session-level warning', () => {
    const store = createChatStore(false, undefined, INLINE_TRANSCRIPT_BOUND);
    store.note(ATTACHMENT);
    store.note(MCP, 'session');
    expect(store.getSnapshot().state.warnings).toEqual([ATTACHMENT, MCP]);
    store.notice('some command output');
    expect(
      store.getSnapshot().state.warnings,
      'a notice is not a message: nothing is consumed',
    ).toEqual([ATTACHMENT, MCP]);
    store.appendUser('hello');
    expect(store.getSnapshot().state.warnings).toEqual([MCP]);
    store.appendUser('and again');
    expect(store.getSnapshot().state.warnings).toEqual([MCP]);
  });

  it('consumes a warning raised after the first message at the second', () => {
    const store = createChatStore(false, undefined, INLINE_TRANSCRIPT_BOUND);
    store.appendUser('first');
    store.note(ATTACHMENT);
    expect(store.getSnapshot().state.warnings).toEqual([ATTACHMENT]);
    store.appendUser('second');
    expect(store.getSnapshot().state.warnings).toEqual([]);
  });

  it('keeps an event gap, which is a fact about the session, over later messages', () => {
    const initial = initialSessionViewState(undefined, INLINE_TRANSCRIPT_BOUND);
    const started = reduceSessionEvent(initial, {
      type: 'session:turn_started',
      sessionId: 's',
      sequenceNumber: 1,
      timestamp: '2026-11-26T00:00:00.000Z',
    });
    const gapped = reduceSessionEvent(started, {
      type: 'session:turn_started',
      sessionId: 's',
      sequenceNumber: 9,
      timestamp: '2026-11-26T00:00:01.000Z',
    });
    expect(gapped.warnings.some((warning) => warning.includes('gap'))).toBe(true);
    const sent = appendUserMessage(appendWarning(gapped, ATTACHMENT), 'hello');
    expect(sent.warnings.some((warning) => warning.includes('gap'))).toBe(true);
    expect(sent.warnings).not.toContain(ATTACHMENT);
  });

  it('bounds the sticky list as it bounds the warnings, so neither grows without end', () => {
    let state = initialSessionViewState(undefined, INLINE_TRANSCRIPT_BOUND);
    for (let index = 0; index < 20; index += 1)
      state = appendWarning(state, `session fact ${String(index)}`, 'session');
    expect(state.warnings).toHaveLength(6);
    expect(state.stickyWarnings).toHaveLength(6);
  });
});

const variant = (renderer: 'alt' | 'inline'): Variant => ({
  renderer,
  color: false,
  size: { cols: 100, rows: 30 },
});

const HOSTS = ['standalone-chat', 'chat'] as const;
const RENDERERS = ['alt', 'inline'] as const;

/** The leading row of the prompt block: the row above the prompt row, the last row that starts with the prompt's `> `. */
function leadRow(mount: ChatMount): string {
  const rows = mount.frame();
  const prompt = rows.findLastIndex((row) => /^> /u.test(row));
  expect(prompt, mount.text()).toBeGreaterThan(0);
  return rows[prompt - 1] ?? '';
}

describe.each(HOSTS)('the leading row in the %s host', (host) => {
  it.each(RENDERERS)(
    'shows a warning about a gesture until the next message is sent, and not over the turns after it (%s renderer)',
    async (renderer) => {
      const setup = { prepare: (store: ChatMount['store']) => store.appendUser('first') };
      const m =
        host === 'chat'
          ? await mountHostedChat(variant(renderer), setup)
          : mountStandaloneChat(variant(renderer), setup);
      try {
        await m.settle();
        m.store.note(ATTACHMENT);
        const shown = await m.until(() => leadRow(m).includes('@bigfile.txt'));
        expect(shown, m.text()).toBe(true);
        expect(leadRow(m)).toContain('truncated to fit');
        m.store.appendUser('second');
        const gone = await m.until(() => !leadRow(m).includes('@bigfile.txt'));
        expect(gone, `the warning outlived the message it was waiting for:\n${m.text()}`).toBe(
          true,
        );
        expect(leadRow(m).trim()).toBe('');
        m.store.appendUser('third');
        await m.settle();
        expect(leadRow(m).trim(), 'and it does not come back').toBe('');
      } finally {
        m.unmount();
      }
    },
  );

  it.each(RENDERERS)(
    'keeps a session-level warning over the next message (%s renderer)',
    async (renderer) => {
      const setup = { prepare: (store: ChatMount['store']) => store.appendUser('first') };
      const m =
        host === 'chat'
          ? await mountHostedChat(variant(renderer), setup)
          : mountStandaloneChat(variant(renderer), setup);
      try {
        await m.settle();
        m.store.note(MCP, 'session');
        m.store.note(ATTACHMENT);
        await m.until(() => leadRow(m).includes('@bigfile.txt'));
        m.store.appendUser('second');
        // The attachment warning goes and the session one stays: wait for the first (a frame that has not changed yet still shows both), then read.
        const consumed = await m.until(() => !leadRow(m).includes('@bigfile.txt'));
        expect(consumed, m.text()).toBe(true);
        expect(leadRow(m)).toContain('skipped');
      } finally {
        m.unmount();
      }
    },
  );
});
