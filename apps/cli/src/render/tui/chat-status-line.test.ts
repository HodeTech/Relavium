/**
 * The chat's status line as the chat builds it from the store's state ([ADR-0146](../../../../../docs/decisions/0146-the-home-and-the-chat-share-one-calm-layout-and-the-first-run-has-no-dead-end.md)
 * §2, MVP-11 step 7a): the data read from the state exactly as the old footer read it, the provider that is new, the cost in the two forms the
 * pure model takes, and the one-row guarantee in the state that used to wrap (usage unknown). The wording, the order of loss and the hostile
 * text are `status-line.test.ts`'s; this is the wiring between the state and that model.
 */
import { describe, expect, it } from 'vitest';

import { chatCostForms, chatStatusLine, contextFullnessPercent } from './chat-projection.js';
import {
  initialSessionViewState,
  INLINE_TRANSCRIPT_BOUND,
  type SessionViewState,
} from './session-view-model.js';
import { displayWidth } from './viewport.js';

const MODEL = 'claude-sonnet-4-6';

/** Microcents of an amount: the store holds USD × 100,000,000. */
const usd = (amount: number): number => Math.round(amount * 100_000_000);

const fresh = (over: Partial<SessionViewState> = {}): SessionViewState => ({
  ...initialSessionViewState({ model: MODEL, transcript: [] }, INLINE_TRANSCRIPT_BOUND),
  ...over,
});

const VERIFIED = { unverified: false, pendingInvocations: 0, unknownCalls: 0 };

describe('the chat’s cost in the two forms the status line takes', () => {
  it('is the amount alone in both forms when the accounting is complete', () => {
    expect(
      chatCostForms(fresh({ cumulativeCostMicrocents: usd(0.1235), usageCoverage: VERIFIED })),
    ).toEqual({ full: '$0.1235', short: '$0.1235', qualified: false });
  });

  it('keeps the qualifier of an unverified figure in the full form and the word `known` in the short one', () => {
    // No coverage yet is "usage unverified": the state a chat is in until its first usage arrives (it used to wrap the old footer to two rows).
    expect(chatCostForms(fresh({ cumulativeCostMicrocents: usd(0.1235) }))).toEqual({
      full: '$0.1235 known; usage unverified',
      short: '$0.1235 known',
      qualified: true,
    });
  });

  it.each([
    [
      'usage pending',
      { usageCoverage: { ...VERIFIED, pendingInvocations: 2 } },
      '$0.0500 known; 2 usage pending',
    ],
    [
      'usage unknown for a call',
      { usageCoverage: { ...VERIFIED, unknownCalls: 1 } },
      '$0.0500 known; usage unknown for 1 call',
    ],
    [
      'an unpriced call',
      { usageCoverage: VERIFIED, unpricedCalls: 3 },
      '$0.0500 known; price unknown for 3 calls',
    ],
  ])('is qualified by %s, and the short form is never a bare amount', (_name, over, full) => {
    const forms = chatCostForms(fresh({ cumulativeCostMicrocents: usd(0.05), ...over }));
    expect(forms.full).toBe(full);
    expect(forms.qualified).toBe(true);
    expect(forms.short).toBe('$0.0500 known');
    expect(forms.short, 'a bare amount would read as a verified one').not.toBe('$0.0500');
  });

  it('writes its short form from the first words of its full form: no notation of its own', () => {
    const forms = chatCostForms(fresh({ cumulativeCostMicrocents: usd(12.5) }));
    expect(forms.full.startsWith(forms.short)).toBe(true);
  });
});

describe('the context figure', () => {
  it('is the last turn’s input as a percentage of the window, clamped, and absent without a window or a turn', () => {
    expect(
      contextFullnessPercent(fresh({ lastInputTokens: 180_000, contextWindowTokens: 1_000_000 })),
    ).toBe(18);
    expect(
      contextFullnessPercent(fresh({ lastInputTokens: 1_500_000, contextWindowTokens: 1_000_000 })),
    ).toBe(100);
    expect(contextFullnessPercent(fresh({ contextWindowTokens: 1_000_000 }))).toBeUndefined();
    // A model the catalogue has no window for (a custom endpoint's, or none bound yet) has no figure to give.
    const unbound = initialSessionViewState(undefined, INLINE_TRANSCRIPT_BOUND);
    expect(contextFullnessPercent({ ...unbound, lastInputTokens: 100 })).toBeUndefined();
    expect(
      contextFullnessPercent({ ...unbound, lastInputTokens: 100, contextWindowTokens: 0 }),
    ).toBeUndefined();
  });
});

describe('the chat’s status line from the state', () => {
  const FACTS = { mode: 'ask', provider: 'anthropic' } as const;

  it('reads provider, model, mode, turns, cost and context, in that order', () => {
    const state = fresh({
      turnCount: 42,
      cumulativeCostMicrocents: usd(0.1235),
      usageCoverage: VERIFIED,
      lastInputTokens: 180_000,
      contextWindowTokens: 1_000_000,
    });
    expect(chatStatusLine(state, FACTS, 120).text).toBe(
      'anthropic · claude-sonnet-4-6 · ask mode · 42 turns · $0.1235 · ctx 18% used',
    );
  });

  it('puts the effort after the mode, reading as the picker reads the tier', () => {
    const state = fresh({ turnCount: 1, usageCoverage: VERIFIED });
    expect(chatStatusLine(state, { ...FACTS, reasoningEffort: 'high' }, 120).text).toBe(
      'anthropic · claude-sonnet-4-6 · ask mode · effort high · 1 turn · $0.0000',
    );
  });

  it.each([
    ['ask', 'ask mode'],
    ['plan', 'plan mode'],
    ['accept-edits', 'accept-edits mode'],
    ['auto', 'auto mode'],
  ] as const)(
    'writes the mode %s as `%s`: never a bare word, with colour or without it',
    (mode, written) => {
      expect(chatStatusLine(fresh(), { ...FACTS, mode }, 120).text).toContain(` · ${written} · `);
    },
  );

  it('starts at the model where the host does not know the provider, and leaves out a model the session has not bound yet', () => {
    expect(
      chatStatusLine(fresh(), { mode: 'ask' }, 120).text.startsWith('claude-sonnet-4-6 · '),
    ).toBe(true);
    const unbound = initialSessionViewState(undefined, INLINE_TRANSCRIPT_BOUND);
    expect(chatStatusLine(unbound, { mode: 'ask' }, 120).text.startsWith('ask mode · ')).toBe(true);
  });

  it.each([80, 100, 120])(
    'is ONE row of at most %s columns in the usage-unknown state, however many things the line carries',
    (columns) => {
      // The state that used to wrap the footer onto a second row: no coverage yet, an effort, a long model id, a turn count and a context figure.
      const state = fresh({
        model: 'claude-sonnet-4-6-20251101-extended',
        turnCount: 1234,
        cumulativeCostMicrocents: usd(1234.5678),
        lastInputTokens: 900_000,
        contextWindowTokens: 1_000_000,
      });
      const { text } = chatStatusLine(state, { ...FACTS, reasoningEffort: 'high' }, columns);
      expect(text, 'no line break').not.toContain('\n');
      expect(displayWidth(text)).toBeLessThanOrEqual(columns);
      expect(text).toContain('ask mode');
      expect(text).toContain('effort high');
      expect(text, 'the cost is never dropped, and never a bare amount').toMatch(
        /\$1,?234\.5678 known/u,
      );
    },
  );

  it('uses the whole width: the chat draws at column 0, so its budget is the columns and not the Home’s 74 of 80', () => {
    const state = fresh({
      turnCount: 42,
      cumulativeCostMicrocents: usd(0.1235),
      usageCoverage: VERIFIED,
    });
    const full = chatStatusLine(state, { ...FACTS, reasoningEffort: 'high' }, 400);
    const width = displayWidth(full.text);
    expect(chatStatusLine(state, { ...FACTS, reasoningEffort: 'high' }, width).cut).toEqual([]);
    expect(chatStatusLine(state, { ...FACTS, reasoningEffort: 'high' }, width - 1).cut).toEqual([
      'turns',
    ]);
  });
});
