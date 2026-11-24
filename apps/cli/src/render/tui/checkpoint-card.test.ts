import { describe, expect, it } from 'vitest';

import { projectCheckpointCard, reduceCheckpointKey } from './checkpoint-card.js';

/** ADR-0136 §4, key by key: the stop keys are answers and never wait, one chord continues, and nothing else does anything. */
describe('the checkpoint card keys (ADR-0136 §4, ADR-0115 §1)', () => {
  it.each([
    ['Ctrl+Y', 'y', { ctrl: true }, 'continue'],
    ['Ctrl+N', 'n', { ctrl: true }, 'stop'],
    ['Esc', '', { escape: true }, 'stop'],
    ['Ctrl+C', 'c', { ctrl: true }, 'interrupt'],
  ] as const)('%s is %s', (_name, input, key, kind) => {
    expect(reduceCheckpointKey(input, key)).toEqual({ kind });
  });

  it('a bare letter answers nothing, whatever it spells (typing at a card is typing)', () => {
    for (const letter of ['y', 'n', 'c', 'a', 'g', 'r', 'Y', 'N', '1', '2', '3']) {
      expect(reduceCheckpointKey(letter, {}), letter).toEqual({ kind: 'none' });
    }
    expect(reduceCheckpointKey('\r', { return: true })).toEqual({ kind: 'none' });
  });

  it('an Alt chord or Ctrl+Alt is not an answer, and Ctrl+G and Ctrl+R (the approval card keys) are not either', () => {
    expect(reduceCheckpointKey('y', { meta: true })).toEqual({ kind: 'none' });
    expect(reduceCheckpointKey('y', { ctrl: true, meta: true })).toEqual({ kind: 'none' });
    expect(reduceCheckpointKey('n', { ctrl: true, meta: true })).toEqual({ kind: 'none' });
    expect(reduceCheckpointKey('g', { ctrl: true })).toEqual({ kind: 'none' });
    expect(reduceCheckpointKey('r', { ctrl: true })).toEqual({ kind: 'none' });
  });

  it('the stop keys win over the affirmative one: no key both stops and continues', () => {
    // Esc with a coincident ctrl flag is still a stop, never a continue.
    expect(reduceCheckpointKey('y', { ctrl: true, escape: true })).toEqual({ kind: 'stop' });
  });
});

describe('the checkpoint card text (ADR-0136 §4)', () => {
  const state = { rounds: 32, interval: 32, elapsedMs: 192_000 };

  it('says what happened and what a continue buys, and names the keys', () => {
    const view = projectCheckpointCard(state, 80);
    expect(view.rule).toContain(' Checkpoint ');
    expect(view.fact).toBe('This turn has used 32 tool rounds in 3m12s. Continue for 32 more?');
    expect(view.keys).toEqual([
      '[Ctrl+Y] Continue · [Ctrl+N] Stop here',
      'Esc / [Ctrl+C] stops the turn',
    ]);
  });

  it('is singular for one round, and says a short turn in seconds', () => {
    expect(projectCheckpointCard({ rounds: 1, interval: 1, elapsedMs: 4000 }, 80).fact).toBe(
      'This turn has used 1 tool round in 4s. Continue for 1 more?',
    );
  });

  it('never makes a row wider than the card, down to the 80-column floor and below', () => {
    for (const columns of [20, 40, 80, 120]) {
      const view = projectCheckpointCard(
        { rounds: 256, interval: 256, elapsedMs: 3_600_000 },
        columns,
      );
      expect(view.rule.length, `rule at ${String(columns)}`).toBeLessThanOrEqual(columns);
      for (const row of [view.fact, ...view.keys])
        expect(row.length, `${row} at ${String(columns)}`).toBeLessThanOrEqual(columns - 2);
    }
  });

  it('does not talk about money: a checkpoint is not a budget decision', () => {
    const view = projectCheckpointCard(state, 80);
    expect([view.rule, view.fact, ...view.keys].join('\n')).not.toMatch(/cost|budget|\$|token/iu);
  });
});
