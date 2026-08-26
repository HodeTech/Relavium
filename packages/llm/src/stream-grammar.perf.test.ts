/**
 * Stream-grammar verifier perf measurement — [ADR-0082](../../../docs/decisions/0082-the-stream-grammar-is-a-seam-obligation-and-every-attempt-has-a-deadline.md)
 * §12 acceptance item **18**, the one item on that list with no implementation until now.
 *
 * The ADR does not merely permit this measurement, it demands it, and says why in its own Consequences:
 * *"Measured rather than assumed (test 18); a boolean check is not where a streaming turn spends its time,
 * **but the claim should be evidence**."* Item 18's wording is equally explicit — the cost is
 * *"**measured** on a representative token stream, not asserted"*.
 *
 * Shaped after `packages/core/src/expression/sandbox.perf.test.ts`, the repo's existing perf precedent: it
 * LOGS the numbers for the record and asserts only an outlier-robust catastrophic-regression ceiling. The
 * verifier's cost is a per-chunk bookkeeping check, so a tight timing gate would be a flake generator on a
 * shared CI runner — the point is evidence that the check is nowhere near the cost of a network stream, not
 * a microbenchmark leaderboard.
 */
import { describe, expect, it } from 'vitest';

import { verifyStreamGrammar } from './stream-grammar.js';
import type { StreamChunk } from './types.js';

/** A representative assistant turn: a few hundred text deltas, then one terminal — the common shape. */
const DELTAS = 2_000;

/** Generous, machine-independent, and about catastrophe rather than precision (see the docblock). */
const MAX_MICROSECONDS_PER_CHUNK = 50;

function representativeStream(): readonly StreamChunk[] {
  const chunks: StreamChunk[] = [];
  for (let i = 0; i < DELTAS; i += 1) {
    // Varying text so the engine cannot fold this into one interned string; a real stream never repeats.
    chunks.push({ type: 'text_delta', text: `token-${String(i)} ` });
  }
  chunks.push({
    type: 'stop',
    stopReason: 'stop',
    usage: { inputTokens: 1_000, outputTokens: DELTAS },
  });
  return chunks;
}

async function* emit(chunks: readonly StreamChunk[]): AsyncGenerator<StreamChunk> {
  // One real `await` before the loop, mirroring `stream-grammar.test.ts`'s `from`. It makes the generator
  // genuinely async (a real provider stream is), and it satisfies `require-await`, which is what catches a
  // fake-async helper that would measure a cheaper thing than production does.
  await Promise.resolve();
  for (const chunk of chunks) {
    yield chunk;
  }
}

describe('stream-grammar verifier — perf (ADR-0082 §12.18)', () => {
  it('costs far less per chunk than a network stream, measured rather than asserted', async () => {
    const chunks = representativeStream();

    // One untimed pass first: the measurement must not also be paying for lazy compilation of the
    // generator's first call. The sandbox precedent separates cold start from steady state for the same
    // reason; here the cold pass is simply discarded.
    for await (const _warm of verifyStreamGrammar(emit(chunks), 'anthropic')) {
      void _warm;
    }

    const started = performance.now();
    let seen = 0;
    for await (const _chunk of verifyStreamGrammar(emit(chunks), 'anthropic')) {
      void _chunk;
      seen += 1;
    }
    const elapsedMs = performance.now() - started;
    const microsecondsPerChunk = (elapsedMs * 1_000) / seen;

    // The record ADR-0082 asked for. Logged, not silently discarded — the evidence IS the deliverable.
    console.log(
      `[ADR-0082 §12.18] verified ${String(seen)} chunks in ${elapsedMs.toFixed(2)}ms ` +
        `(${microsecondsPerChunk.toFixed(3)} µs/chunk)`,
    );

    // The verifier holds a terminal back until EOF confirms it (§7), so it emits every chunk it was given.
    expect(seen).toBe(chunks.length);
    expect(microsecondsPerChunk).toBeLessThan(MAX_MICROSECONDS_PER_CHUNK);
  });
});
