import type { ReasoningEffort } from '@relavium/shared';
import { describe, expect, it } from 'vitest';

import { effortToSend, gateReasoningEffort } from './reasoning-effort.js';

/**
 * THE EFFORT GATE — and it had **no test at all** before this, which is how F3 shipped.
 *
 * The old gate was pass-through-or-withhold: *"does this model reason?"* → yes → send whatever tier the user
 * picked, unexamined. But reasoning is not the question the wire asks. `gpt-5.4-pro` reasons **and rejects
 * `low`**. `gemini-2.5-pro` reasons and **cannot be turned off**. A boolean answers `true` to both, and the
 * rejected value goes straight to the provider — which is the 400 the maintainer reported.
 */

const tiers = (...list: ReasoningEffort[]): ReadonlySet<ReasoningEffort> => new Set(list);

describe('gateReasoningEffort — it CLAMPS now; it used to just pass through', () => {
  it('THE BUG: a tier the model rejects is WITHHELD, not sent', () => {
    // gpt-5.4-pro accepts {medium, high, max}. The old gate saw "reasons: true" and sent `low` anyway.
    const result = gateReasoningEffort('low', 'gpt-5.4-pro', () => tiers('medium', 'high', 'max'));
    expect(result).toEqual({
      kind: 'rejected',
      requested: 'low',
      accepted: ['medium', 'high', 'max'],
    });
    expect(effortToSend(result)).toBeUndefined(); // nothing reaches the wire
  });

  it('a rejected tier is NEVER promoted to a neighbour — that would change behaviour AND raise spend, silently', () => {
    // The tempting "fix" is to round `low` up to `medium` so the call succeeds. It must not: the user gets more
    // thinking than they asked for, pays more for it, and is told nothing. Withholding is honest; promotion is not.
    const result = gateReasoningEffort('low', 'm', () => tiers('high'));
    expect(result.kind).toBe('rejected');
    expect(effortToSend(result)).toBeUndefined();
  });

  it('an ACCEPTED tier is sent unchanged', () => {
    const result = gateReasoningEffort('high', 'm', () => tiers('medium', 'high', 'max'));
    expect(result).toEqual({ kind: 'send', effort: 'high' });
    expect(effortToSend(result)).toBe('high');
  });

  it('`off` is gated like any other tier — gemini-2.5-pro cannot be turned off, so `off` is withheld', () => {
    // Google: "N/A: Cannot disable thinking". The old code mapped off→MINIMAL and sent it, which neither disabled
    // thinking nor was a value the model takes — so a user who switched reasoning OFF was billed for reasoning.
    const proTiers = tiers('low', 'medium', 'high', 'max'); // no `off`
    expect(gateReasoningEffort('off', 'gemini-2.5-pro', () => proTiers).kind).toBe('rejected');
    // …while a model that CAN be disabled sends it.
    expect(
      effortToSend(gateReasoningEffort('off', 'gemini-2.5-flash', () => tiers('off', 'low'))),
    ).toBe('off');
  });
});

describe('the withhold cases — every one of them omits the field', () => {
  it('no tier requested ⇒ `unset`, and nothing is sent (the common path)', () => {
    expect(gateReasoningEffort(undefined, 'm', () => tiers('high'))).toEqual({ kind: 'unset' });
  });

  it('an EMPTY accepted set ⇒ `uncontrollable` — the model reasons but exposes no tier', () => {
    // `deepseek-reasoner`. Distinct from "does not reason", and the distinction matters: it tells the picker to
    // offer NOTHING rather than to offer everything, which is precisely the old behaviour.
    expect(gateReasoningEffort('high', 'deepseek-reasoner', () => new Set())).toEqual({
      kind: 'uncontrollable',
    });
  });

  it('an UNKNOWN model (no resolver, or a custom endpoint) ⇒ `uncontrollable` — the SAFE default', () => {
    // Guessing is what put a rejected value on the wire in the first place. A model we cannot describe gets no
    // reasoning field at all.
    expect(gateReasoningEffort('high', 'some-custom-model', () => undefined).kind).toBe(
      'uncontrollable',
    );
    expect(gateReasoningEffort('high', 'm', undefined).kind).toBe('uncontrollable');
  });

  it('`accepted` is carried on a rejection so a surface can say something ACTIONABLE', () => {
    // "gpt-5.4-pro does not accept `low` — it takes medium, high or max" beats "the request failed".
    const result = gateReasoningEffort('off', 'gpt-5.4-pro', () => tiers('medium', 'high', 'max'));
    expect(result.kind === 'rejected' && result.accepted).toEqual(['medium', 'high', 'max']);
  });
});
