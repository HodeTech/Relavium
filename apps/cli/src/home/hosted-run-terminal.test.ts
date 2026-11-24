/**
 * What a departed hosted leg tells the Home ([ADR-0139](../../../../docs/decisions/0139-a-workflow-run-is-hosted-inside-the-home.md)
 * §3, §6): one test per disposition, the sanitize floor on the run id, and the proof that the card is data
 * only. The mapping is the shell's own (`outcomeToExitCode`), so each case also names the exit code the same
 * leg would have had in `relavium run` or `relavium gate`.
 */
import type { RunDeparture } from '@relavium/core';
import type { ErrorCode } from '@relavium/shared';
import { describe, expect, it } from 'vitest';

import { outcomeToExitCode } from '../commands/drive.js';
import { describeHostedRunTerminal, type HostedRunTerminalInput } from './hosted-run-terminal.js';

type Departure = Exclude<RunDeparture, { readonly kind: 'continue' }>;

const DETACHED: Departure = {
  kind: 'detached',
  moneyDurability: 'durable',
  effectNeedsAttention: false,
};

function leg(over: Partial<HostedRunTerminalInput>): HostedRunTerminalInput {
  return {
    leg: 'start',
    runId: 'run-hosted-1',
    outcome: 'completed',
    durability: 'durable',
    terminalError: undefined,
    departure: DETACHED,
    ...over,
  };
}

/** Every string a card carries, so a rule is asserted over all of them and none is skipped. */
function texts(input: HostedRunTerminalInput): string[] {
  const card = describeHostedRunTerminal(input);
  return card.remedy === undefined ? [card.headline] : [card.headline, card.remedy];
}

function hasControl(text: string): boolean {
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

describe('the disposition of a departed hosted leg', () => {
  it('completed: a run:completed whose record is durable', () => {
    const card = describeHostedRunTerminal(leg({}));
    expect(card).toMatchObject({ disposition: 'completed', safety: undefined });
    expect(card.headline).toBe('Run run-hosted-1 completed.');
    expect(card.remedy).toBeUndefined();
  });

  it('failed: a run:failed names the log, whatever its stored error code', () => {
    const card = describeHostedRunTerminal(leg({ outcome: 'failed' }));
    expect(card).toMatchObject({ disposition: 'failed', safety: undefined });
    expect(card.headline).toBe('Run run-hosted-1 failed.');
    expect(card.remedy).toBe('Read `relavium logs run-hosted-1` for the cause.');
  });

  it('failed: a stream that ended with no outcome is a failure that says so', () => {
    const card = describeHostedRunTerminal(leg({ outcome: undefined }));
    expect(card).toMatchObject({ disposition: 'failed', safety: undefined });
    expect(card.headline).toBe('Run run-hosted-1 ended without recording an outcome.');
  });

  it('cancelled: a run:cancelled says it cannot be resumed and offers no remedy', () => {
    const card = describeHostedRunTerminal(leg({ outcome: 'cancelled' }));
    expect(card).toMatchObject({ disposition: 'cancelled', safety: undefined });
    expect(card.headline).toBe(
      'Run run-hosted-1 was cancelled; a cancelled run cannot be resumed.',
    );
    expect(card.remedy).toBeUndefined();
  });

  it('paused: a leg that handed off at a gate is waiting for an answer', () => {
    const card = describeHostedRunTerminal(leg({ outcome: 'paused' }));
    expect(card).toMatchObject({ disposition: 'paused', safety: undefined });
    expect(card.headline).toBe('Run run-hosted-1 is paused and waiting for an answer.');
    expect(card.remedy).toBe('Open the run to continue it.');
  });

  it.each([
    {
      name: 'money not confirmed (8)',
      safety: 8,
      over: { departure: { ...DETACHED, moneyDurability: 'uncertain' } satisfies Departure },
      says: 'Do not repeat paid work',
    },
    {
      name: 'an effect needs attention (7)',
      safety: 7,
      over: { departure: { ...DETACHED, effectNeedsAttention: true } satisfies Departure },
      says: 'Do not retry',
    },
    {
      name: 'a terminal delivered and held (5)',
      safety: 5,
      over: { durability: 'uncertain' as const },
      says: 'held and retried',
    },
  ])('uncertain: $name', ({ safety, over, says }) => {
    const card = describeHostedRunTerminal(leg(over));
    expect(card).toMatchObject({ disposition: 'uncertain', safety });
    expect(card.remedy).toContain(says);
    // The remedy never invites an automatic repeat of paid or effectful work.
    expect(card.remedy).not.toMatch(/\bretry (it|the run)\b/iu);
  });

  it('uncertain: money and effect together carry both remedies, money first', () => {
    const card = describeHostedRunTerminal(
      leg({ departure: { ...DETACHED, moneyDurability: 'uncertain', effectNeedsAttention: true } }),
    );
    expect(card).toMatchObject({ disposition: 'uncertain', safety: 8 });
    expect(card.remedy).toContain('Do not repeat paid work');
    expect(card.remedy).toContain('inspect the target and resolve the effect record');
  });

  it('uncertain: the legacy terminal effect code reads as an effect that needs attention', () => {
    const card = describeHostedRunTerminal(
      leg({ outcome: 'failed', terminalError: 'effect_needs_attention' }),
    );
    expect(card).toMatchObject({ disposition: 'uncertain', safety: 7 });
  });

  it('taken over: a fence with no terminal is another process now, and says to read the log', () => {
    const card = describeHostedRunTerminal(leg({ outcome: undefined, durability: 'uncertain' }));
    expect(card).toMatchObject({ disposition: 'taken_over', safety: 6 });
    expect(card.headline).toContain('taken over by another process');
    expect(card.remedy).toBe('Read `relavium logs run-hosted-1` for what actually happened.');
  });

  it('taken over: a buffered stale pause is still a fence, not a pause', () => {
    const card = describeHostedRunTerminal(leg({ outcome: 'paused', durability: 'uncertain' }));
    expect(card).toMatchObject({ disposition: 'taken_over', safety: 6 });
  });

  it('settled: a resume leg whose stream closed with no event found the run already settled', () => {
    const card = describeHostedRunTerminal(leg({ leg: 'resume', outcome: undefined }));
    expect(card).toMatchObject({ disposition: 'settled', safety: undefined });
    expect(card.headline).toBe('Run run-hosted-1 was already settled; nothing to resume.');
  });

  it('settled is a resume rule only: a start leg with no outcome is a failure', () => {
    expect(describeHostedRunTerminal(leg({ leg: 'start', outcome: undefined })).disposition).toBe(
      'failed',
    );
  });
});

describe('the card agrees with the shell and is data only', () => {
  const grid: readonly HostedRunTerminalInput[] = (
    ['completed', 'failed', 'cancelled', 'paused', undefined] as const
  ).flatMap((outcome) =>
    (['durable', 'uncertain'] as const).flatMap((durability) =>
      (['start', 'resume'] as const).flatMap((kind) =>
        [DETACHED, { ...DETACHED, moneyDurability: 'uncertain' } as const].map(
          (departure): HostedRunTerminalInput => leg({ leg: kind, outcome, durability, departure }),
        ),
      ),
    ),
  );

  it('carries the safety code the shell would exit with, exactly when the shell exits with one', () => {
    for (const input of grid) {
      const exit = outcomeToExitCode(
        input.outcome,
        input.durability,
        input.terminalError,
        input.departure,
        input.leg === 'resume',
      );
      const card = describeHostedRunTerminal(input);
      const safety = exit === 8 || exit === 7 || exit === 5 || exit === 6 ? exit : undefined;
      expect(card.safety, JSON.stringify(input)).toBe(safety);
      expect(card.disposition === 'uncertain' || card.disposition === 'taken_over').toBe(
        safety !== undefined,
      );
    }
  });

  it('is frozen, and reads nothing but the plain facts it is given', () => {
    const card = describeHostedRunTerminal(leg({}));
    expect(Object.isFrozen(card)).toBe(true);
    expect(Object.keys(card).sort()).toEqual(['disposition', 'headline', 'remedy', 'safety']);
  });

  it('says the same words for the same disposition whatever the stored terminal error is', () => {
    const errors: readonly ErrorCode[] = ['internal', 'run_timeout', 'budget_exceeded'];
    const cards = errors.map((terminalError) =>
      describeHostedRunTerminal(leg({ outcome: 'failed', terminalError })),
    );
    for (const card of cards) expect(card).toEqual(cards[0]);
  });
});

describe('the sanitize floor on the run id', () => {
  const HOSTILE = '\u001b[31mrun\u001b[0m\u0007-\u009b2J\nforged: \u202edone\ttab';
  const everyDisposition: readonly [string, Partial<HostedRunTerminalInput>][] = [
    ['completed', {}],
    ['failed', { outcome: 'failed' }],
    ['no outcome', { outcome: undefined }],
    ['cancelled', { outcome: 'cancelled' }],
    ['paused', { outcome: 'paused' }],
    ['money', { departure: { ...DETACHED, moneyDurability: 'uncertain' } }],
    ['effect', { departure: { ...DETACHED, effectNeedsAttention: true } }],
    ['held terminal', { durability: 'uncertain' }],
    ['taken over', { outcome: undefined, durability: 'uncertain' }],
    ['settled', { leg: 'resume', outcome: undefined }],
  ];

  it.each(everyDisposition)(
    'an id with control characters, an escape and a newline cannot reach the %s card raw',
    (_name, over) => {
      const strings = texts(leg({ ...over, runId: HOSTILE }));
      expect(strings.length).toBeGreaterThan(0);
      for (const text of strings) {
        expect(hasControl(text), JSON.stringify(text)).toBe(false);
        expect(text).not.toContain('\u001b');
        expect(text).not.toContain('\u202e');
      }
      // Every headline names the run, so the collapsed newline and tab are visible as plain spaces.
      expect(strings[0]).toContain('forged: ');
    },
  );
});
