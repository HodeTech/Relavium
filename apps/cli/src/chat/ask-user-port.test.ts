import type { AskUserAnswer, AskUserRequest } from '@relavium/core';
import { describe, expect, it, vi } from 'vitest';

import { askUserOption, createAskUserPort } from './ask-user-port.js';

const REQUEST: AskUserRequest = {
  questions: [
    {
      header: 'Pick',
      question: 'Which?',
      multiSelect: false,
      options: [
        { label: 'a', description: 'first' },
        { label: 'b', description: 'second' },
      ],
    },
  ],
};

describe('the ask-user port (ADR-0132 §7)', () => {
  it('a question asked before any store is bound is a host fault, never a card nobody can answer', async () => {
    const port = createAskUserPort();
    await expect(port.delegate(REQUEST)).rejects.toThrow(/no question card is bound/);
    // It is NOT an AbortError: the engine classifies it fatal and not retryable, rather than as a stop.
    await port.delegate(REQUEST).catch((error: unknown) => {
      expect(error instanceof Error && error.name).not.toBe('AbortError');
    });
  });

  it('routes to whichever store is bound when the question is asked, passing the request and the signal', async () => {
    const answer: AskUserAnswer = { kind: 'skipped' };
    const first = { requestQuestion: vi.fn(() => Promise.resolve(answer)) };
    const second = { requestQuestion: vi.fn(() => Promise.resolve(answer)) };
    const port = createAskUserPort();
    const delegate = port.delegate; // stable: the session holds this reference for its whole life
    port.bind(first);
    const controller = new AbortController();
    await delegate(REQUEST, controller.signal);
    expect(first.requestQuestion).toHaveBeenCalledWith(REQUEST, controller.signal);
    port.bind(second); // the last bind wins (a re-driven session)
    await delegate(REQUEST);
    expect(second.requestQuestion).toHaveBeenCalledTimes(1);
    expect(first.requestQuestion).toHaveBeenCalledTimes(1);
  });

  it('askUserOption gives the delegate only to a surface that can answer', () => {
    const port = createAskUserPort();
    expect(askUserOption(port, true)).toEqual({ askUser: port.delegate });
    expect(askUserOption(port, false)).toEqual({});
  });
});
