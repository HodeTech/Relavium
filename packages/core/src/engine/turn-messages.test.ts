import type { LlmMessage } from '@relavium/llm';
import { describe, expect, it } from 'vitest';

import { markUntrusted } from '../tools/untrusted.js';
import { buildTurnMessages } from './turn-messages.js';

const user = (text: string): LlmMessage => ({ role: 'user', content: [{ type: 'text', text }] });
const assistant = (text: string): LlmMessage => ({
  role: 'assistant',
  content: [{ type: 'text', text }],
});
const text = (messages: readonly LlmMessage[]) =>
  messages.map((message) => ({
    role: message.role,
    text: message.content.map((part) => (part.type === 'text' ? part.text : '')).join(''),
  }));

describe('one pure session request projection (ADR-0095)', () => {
  it('selects individual proven window turns without spanning intervening legacy text', () => {
    const pending = user('current');
    const messages = [
      user('legacy prefix'),
      user('q1'),
      assistant('a1'),
      user('legacy gap'),
      user('q2'),
      user('legacy tail'),
      pending,
    ];
    const options = {
      memory: { type: 'window' as const, window_size: 2 },
      completedTurnSpans: [
        { start: 1, end: 3 },
        { start: 4, end: 5 },
      ],
      pendingUser: pending,
    };
    expect(text(buildTurnMessages(markUntrusted('HOSTILE SUMMARY'), messages, options))).toEqual([
      { role: 'user', text: 'q1' },
      { role: 'assistant', text: 'a1' },
      { role: 'user', text: 'q2\n\ncurrent' },
    ]);
    expect(
      text(
        buildTurnMessages(undefined, messages, {
          ...options,
          memory: { type: 'window', window_size: 1 },
        }),
      ),
    ).toEqual([{ role: 'user', text: 'q2\n\ncurrent' }]);
  });

  it('includes an empty pending message separately from a completed empty-final turn', () => {
    const pending = user('');
    expect(
      text(
        buildTurnMessages(undefined, [user('completed'), pending], {
          memory: { type: 'window', window_size: 1 },
          completedTurnSpans: [{ start: 0, end: 1 }],
          pendingUser: pending,
        }),
      ),
    ).toEqual([{ role: 'user', text: 'completed\n\n' }]);
    expect(
      text(
        buildTurnMessages(markUntrusted('SUMMARY'), [user('archive'), pending], {
          memory: { type: 'none' },
          completedTurnSpans: [{ start: 0, end: 1 }],
          pendingUser: pending,
        }),
      ),
    ).toEqual([{ role: 'user', text: '' }]);
  });

  it.each(['none', 'window'] as const)(
    'does not invent a pending message or restore a summary under %s',
    (type) => {
      const messages = [user('completed')];
      const projected = buildTurnMessages(markUntrusted('SUMMARY'), messages, {
        memory: type === 'none' ? { type } : { type, window_size: 1 },
        completedTurnSpans: [{ start: 0, end: 1 }],
      });
      expect(text(projected)).toEqual(type === 'none' ? [] : [{ role: 'user', text: 'completed' }]);
    },
  );

  it('folds both text roles with explicit wire-visible separation', () => {
    expect(
      text(
        buildTurnMessages(undefined, [user('u1'), user('u2'), assistant('a1'), assistant('a2')]),
      ),
    ).toEqual([
      { role: 'user', text: 'u1\n\nu2' },
      { role: 'assistant', text: 'a1\n\na2' },
    ]);
    expect(text(buildTurnMessages(markUntrusted('SUMMARY'), [user('q')]))[0]?.text).toContain(
      'The user’s message follows.\n\nq',
    );
  });

  it('never mutates frozen archive messages or compounds summaries across requests', () => {
    const messages = [user('u1'), user('u2'), assistant('a')];
    for (const message of messages) {
      for (const part of message.content) Object.freeze(part);
      Object.freeze(message.content);
      Object.freeze(message);
    }
    Object.freeze(messages);
    const before = JSON.stringify(messages);
    const one = buildTurnMessages(markUntrusted('SUMMARY'), messages);
    const two = buildTurnMessages(markUntrusted('SUMMARY'), messages);
    expect(one).toEqual(two);
    const first = one[0]?.content[0];
    if (first?.type !== 'text') throw new Error('expected text');
    first.text = 'consumer mutation';
    expect(JSON.stringify(messages)).toBe(before);
    expect(text(two)[0]?.text).toContain('SUMMARY');
    expect(text(two)[0]?.text).toContain('u1\n\nu2');
  });
});
