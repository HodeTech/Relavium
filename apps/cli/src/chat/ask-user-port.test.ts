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
    const first = {
      requestQuestion: vi.fn(() => Promise.resolve(answer)),
      requestCheckpoint: vi.fn(() => Promise.resolve('stop' as const)),
    };
    const second = {
      requestQuestion: vi.fn(() => Promise.resolve(answer)),
      requestCheckpoint: vi.fn(() => Promise.resolve('stop' as const)),
    };
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

  it('askUserOption gives the delegate and the checkpoint hook only to a surface that can answer', () => {
    const port = createAskUserPort();
    expect(askUserOption(port, true)).toEqual({
      askUser: port.delegate,
      checkpoint: port.checkpoint,
    });
    expect(askUserOption(port, false)).toEqual({});
  });

  it('a checkpoint reached before any store is bound is a rejection, which the engine ends as a classified stop: it fails closed', async () => {
    const port = createAskUserPort();
    await expect(
      port.checkpoint({ rounds: 32, interval: 32 }, new AbortController().signal),
    ).rejects.toThrow(/no checkpoint card is bound/);
  });

  it('routes a checkpoint to the bound store with the info and the turn signal, and returns its answer', async () => {
    const host = {
      requestQuestion: vi.fn(() => Promise.resolve({ kind: 'skipped' } as const)),
      requestCheckpoint: vi.fn(() => Promise.resolve('continue' as const)),
    };
    const port = createAskUserPort();
    const hook = port.checkpoint; // stable for the session's life
    port.bind(host);
    const controller = new AbortController();
    await expect(hook({ rounds: 32, interval: 32 }, controller.signal)).resolves.toBe('continue');
    expect(host.requestCheckpoint).toHaveBeenCalledWith(
      { rounds: 32, interval: 32 },
      controller.signal,
    );
  });
});
