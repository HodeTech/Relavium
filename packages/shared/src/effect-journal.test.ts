import { describe, expect, it } from 'vitest';

import {
  EFFECT_STATES,
  EFFECT_TIERS,
  EffectConflictError,
  ERROR_CODES,
  RETRYABLE_ERROR_CODES,
  effectScope,
  isEffectConflictError,
  unwiredEffectJournal,
  type EffectCorrelation,
} from './index.js';

describe('the effect journal contract (ADR-0080)', () => {
  it('drops the retry attempt from the scope — the gate must survive an attempt reset', () => {
    // THE property the resume gate turns on. The node-retry attempt resets to 1 on a crash-resume AND on a
    // budget approval, so a scope that included it would miss the very row the gate exists to find.
    const first: EffectCorrelation = { kind: 'run', runId: 'r1', nodeId: 'n1', attempt: 3 };
    const afterCrash: EffectCorrelation = { kind: 'run', runId: 'r1', nodeId: 'n1', attempt: 1 };
    expect(effectScope(first)).toBe(effectScope(afterCrash));
  });

  it('a run and a session can never collide in one scope', () => {
    // The discriminated union exists so a session never fabricates a runId (ADR-0024). The scope encoding
    // must preserve that separation rather than flattening both into one opaque string space.
    expect(effectScope({ kind: 'run', runId: 'x', nodeId: 'y', attempt: 1 })).not.toBe(
      effectScope({ kind: 'session', sessionId: 'x', turn: 1 }),
    );
    expect(effectScope({ kind: 'session', sessionId: 's1', turn: 2 })).toContain('session:');
  });

  it('two turns of one session are distinct scopes', () => {
    // A session's turn is part of its correlation the way a node is part of a run's — without it, every
    // effect a session ever dispatched would share one scope and the gate would refuse the second turn.
    expect(effectScope({ kind: 'session', sessionId: 's1', turn: 1 })).not.toBe(
      effectScope({ kind: 'session', sessionId: 's1', turn: 2 }),
    );
  });

  it('effect_needs_attention is an ErrorCode and is NOT retryable', () => {
    // Retrying is the duplicate the journal exists to prevent, so membership in the retryable set would
    // defeat the mechanism from inside the taxonomy every surface already switches on.
    expect(ERROR_CODES).toContain('effect_needs_attention');
    expect(RETRYABLE_ERROR_CODES as readonly string[]).not.toContain('effect_needs_attention');
  });

  it('pins the tier and state vocabularies', () => {
    // These are the words the canonical contract uses; a silent addition or rename would desync the ADR,
    // effect-journal.md and the store's CHECK constraint from each other.
    expect(EFFECT_TIERS).toEqual([1, 2, 3]);
    expect(EFFECT_STATES).toEqual([
      'prepared',
      'dispatched',
      'committed',
      'ambiguous',
      'needs_attention',
    ]);
  });

  it('the unwired journal REJECTS rather than silently doing nothing', async () => {
    // A no-op default is the fail-open this contract rejects: it would make a production wiring mistake
    // indistinguishable from a fixture that never had effects. Both arms must reject, and the message must
    // name the tool, because that is what turns the failure into a diagnosis.
    const port = unwiredEffectJournal();
    await expect(port.prepare(0, 'http_request', 3, 'digest')).rejects.toThrow(/http_request/);
    await expect(port.settle(0, 'http_request', 'committed')).rejects.toThrow(/journal/);
  });

  it('the conflict is typed and narrowable, carrying the identity that collided', () => {
    const error = new EffectConflictError({ scope: 'run:r1:n1', slot: 0, toolId: 'http_request' });
    expect(isEffectConflictError(error)).toBe(true);
    expect(isEffectConflictError(new Error('nope'))).toBe(false);
    expect(error.identity.toolId).toBe('http_request');
    expect(error.name).toBe('EffectConflictError');
  });
});
