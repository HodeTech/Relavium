import { PassThrough } from 'node:stream';
import { confirm, isCancel, text } from '@clack/prompts';
import { expect, it } from 'vitest';
import type { HumanGatePausedEvent } from '@relavium/shared';

import { createClackGatePrompter } from './clack-prompter.js';
import type { BudgetPromptContext } from './budget.js';

const gate: HumanGatePausedEvent = {
  type: 'human_gate:paused',
  runId: 'prompt-lifecycle',
  nodeId: 'human',
  gateId: 'gate',
  gateType: 'approval',
  message: 'A bounded synthetic gate',
  sequenceNumber: 0,
  timestamp: '2026-10-06T00:00:00.000Z',
};

class SyntheticInput extends PassThrough {
  readonly isTTY = true;
  isRaw = false;
  setRawMode(value: boolean): this {
    this.isRaw = value;
    return this;
  }
}

for (const gateType of ['approval', 'input'] as const) {
  it(`aborts actual Clack ${gateType} and releases its synthetic input resources`, async () => {
    const input = new SyntheticInput();
    const output = new PassThrough();
    output.resume();
    const controller = new AbortController();
    const prompter = createClackGatePrompter({
      note: () => {},
      confirm: (options) => confirm({ ...options, input, output }),
      text: (options) => text({ ...options, input, output }),
      isCancel,
    });
    const pending = prompter.prompt({ ...gate, gateType }, undefined, controller.signal);
    try {
      expect(input.isRaw).toBe(true);
      expect(input.listenerCount('keypress')).toBeGreaterThan(0);
      expect(output.listenerCount('resize')).toBeGreaterThan(0);
      controller.abort();
      expect(input.isRaw).toBe(false);
      expect(input.listenerCount('keypress')).toBe(0);
      expect(output.listenerCount('resize')).toBe(0);
      expect(await pending).toBeNull();
    } finally {
      // This also releases the old, un-abortable implementation during causal verification.
      input.emit('keypress', '\u0003', { name: 'c', ctrl: true, sequence: '\u0003' });
      await pending;
      input.destroy();
      output.destroy();
    }
  });
}

type Route =
  | 'approval'
  | 'review'
  | 'input'
  | 'rejection-comment'
  | 'amount'
  | 'legacy'
  | 'reject-only';
for (const route of [
  'approval',
  'review',
  'input',
  'rejection-comment',
  'amount',
  'legacy',
  'reject-only',
] satisfies Route[]) {
  it(`forwards cancellation to ${route} and refuses a late decision`, async () => {
    const controller = new AbortController();
    let release: (value: boolean | string | symbol) => void = () => {};
    const answer = new Promise<boolean | string | symbol>((resolve) => {
      release = resolve;
    });
    let confirms = 0;
    let texts = 0;
    const seen: Array<AbortSignal | undefined> = [];
    const prompter = createClackGatePrompter({
      note: () => {},
      confirm: async (options) => {
        confirms++;
        seen.push(options.signal);
        if (route === 'rejection-comment') return false;
        const value = await answer;
        if (typeof value !== 'boolean' && typeof value !== 'symbol')
          throw new Error('wrong fixture answer');
        return value;
      },
      text: async (options) => {
        texts++;
        seen.push(options.signal);
        const value = await answer;
        if (typeof value !== 'string' && typeof value !== 'symbol')
          throw new Error('wrong fixture answer');
        return value;
      },
      isCancel: (value): value is symbol => typeof value === 'symbol',
    });
    const budget: BudgetPromptContext | undefined =
      route === 'amount'
        ? { kind: 'amount', microcents: 0 }
        : route === 'legacy'
          ? { kind: 'legacy' }
          : route === 'reject-only'
            ? { kind: 'reject_only', reason: 'unpriced' }
            : undefined;
    const pending = prompter.prompt(
      {
        ...gate,
        gateType: route === 'input' ? 'input' : route === 'review' ? 'review' : 'approval',
      },
      budget,
      controller.signal,
    );
    await Promise.resolve();
    try {
      expect(seen.length).toBe(route === 'rejection-comment' ? 2 : 1);
      expect(seen.every((signal) => signal === controller.signal)).toBe(true);
      controller.abort();
      release(route === 'input' || route === 'rejection-comment' ? 'late untrusted input' : true);
      expect(await pending).toBeNull();
      expect(confirms).toBe(route === 'input' ? 0 : 1);
      expect(texts).toBe(route === 'input' || route === 'rejection-comment' ? 1 : 0);
    } finally {
      release(Symbol('fixture cancelled'));
      await pending;
    }
  });
}

it('does not open any card for a signal cancelled before prompt entry', async () => {
  const controller = new AbortController();
  controller.abort();
  const unexpected = (): never => {
    throw new Error('a cancelled prompt must not enter Clack');
  };
  const prompter = createClackGatePrompter({
    note: unexpected,
    confirm: unexpected,
    text: unexpected,
    isCancel,
  });
  expect(await prompter.prompt(gate, undefined, controller.signal)).toBeNull();
  expect(
    await prompter.prompt(gate, { kind: 'amount', microcents: 0 }, controller.signal),
  ).toBeNull();
});
