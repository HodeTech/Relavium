/**
 * `CR-32`'s size bounds (ADR-0086), tested for the three properties that carry the item.
 *
 * A breach REJECTS rather than truncates; the three quantities are measured independently; and a TERMINAL
 * event is never refused, because exactly-one-terminal outranks every ceiling here. A test suite that only
 * checked "big things are refused" would pass against an implementation that also refused a terminal — which
 * would leave a run unable to end, the one outcome worse than an oversized event.
 */

import { describe, expect, it } from 'vitest';

import {
  describeBreach,
  measureDraft,
  measureNodeOutput,
  measureWorkflowState,
  serialisedByteLength,
  SIZE_BOUNDS,
} from './size-bounds.js';

/** A string whose JSON encoding is at least `bytes` long (the quotes make it 2 longer; harmless here). */
const ofSize = (bytes: number): string => 'x'.repeat(bytes);

describe('serialisedByteLength', () => {
  it('reports zero for an absent output and a real size for a present one', () => {
    // `undefined` is genuinely nothing — the common case for a node that produces no output — and must not
    // be confused with the "cannot measure" answer below.
    expect(serialisedByteLength(undefined)).toBe(0);
    expect(serialisedByteLength('ab')).toBe(4); // `"ab"` — the quotes are part of what the store writes
  });

  it('returns undefined — not zero — for a value it cannot serialise', () => {
    // **The distinction that keeps this module honest.** A cycle or a BigInt is a value the durable log
    // could not have carried either, and the emit boundary's schema validation rejects it with a message
    // about the ACTUAL problem. Reporting zero here would let it sail past a size check and then fail with a
    // confusing error; reporting a made-up size would fail it for the wrong reason.
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(serialisedByteLength(cyclic)).toBeUndefined();
    expect(serialisedByteLength(() => undefined)).toBeUndefined();
  });
});

describe('measureNodeOutput', () => {
  it('admits an output at the bound and refuses the one past it, naming the node', () => {
    const under = measureNodeOutput('n1', ofSize(SIZE_BOUNDS.nodeOutputBytes - 10));
    expect(under.breach).toBeUndefined();
    expect(under.bytes).toBeGreaterThan(0);

    const over = measureNodeOutput('n1', ofSize(SIZE_BOUNDS.nodeOutputBytes + 10));
    expect(over.breach?.what).toContain('n1');
    expect(over.breach?.limit).toBe(SIZE_BOUNDS.nodeOutputBytes);
    // The message carries the size AND the limit — a refusal that hides the number leaves an author unable
    // to tell whether they are 10 bytes over or 10 megabytes.
    expect(describeBreach(over.breach!)).toContain(String(SIZE_BOUNDS.nodeOutputBytes));
  });

  it('returns a size even when it refuses, so the caller does not measure twice', () => {
    const over = measureNodeOutput('n1', ofSize(SIZE_BOUNDS.nodeOutputBytes + 10));
    expect(over.bytes).toBeGreaterThan(SIZE_BOUNDS.nodeOutputBytes);
  });

  it('does not refuse an unmeasurable value — that is the emit boundary\u2019s job', () => {
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(measureNodeOutput('n1', cyclic).breach).toBeUndefined();
  });
});

describe('measureWorkflowState', () => {
  it('is a separate bound from the per-node one', () => {
    // Many outputs, each individually legal, can still exhaust the run. Sharing one number would make the
    // per-node bound either useless (if set at the state limit) or absurd (if the state limit were per node).
    expect(measureWorkflowState(SIZE_BOUNDS.workflowStateBytes)).toBeUndefined();
    expect(measureWorkflowState(SIZE_BOUNDS.workflowStateBytes + 1)?.limit).toBe(
      SIZE_BOUNDS.workflowStateBytes,
    );
    expect(SIZE_BOUNDS.workflowStateBytes).toBeGreaterThan(SIZE_BOUNDS.nodeOutputBytes);
  });
});

describe('measureDraft', () => {
  it('refuses an oversized NON-terminal event', () => {
    const draft = { type: 'node:completed', output: ofSize(SIZE_BOUNDS.durableEventBytes + 10) };
    expect(measureDraft('node:completed', draft, false)?.limit).toBe(SIZE_BOUNDS.durableEventBytes);
  });

  it('never refuses a TERMINAL event, however large (ADR-0036, ADR-0078 §6)', () => {
    // **The assertion the whole module defers to.** A run that cannot publish its terminal is worse in every
    // way than one that wrote an oversized final event: the stream never closes, the lease is never
    // released, and no surface can tell whether the run finished. This is the case an implementation that
    // "bounds everything" gets wrong, and the reason a size rule can never be the last word.
    const huge = { type: 'run:completed', outputs: ofSize(SIZE_BOUNDS.durableEventBytes * 4) };
    expect(measureDraft('run:completed', huge, true)).toBeUndefined();
  });

  it('admits a non-terminal event at the bound', () => {
    expect(measureDraft('node:started', { a: ofSize(100) }, false)).toBeUndefined();
  });
});
