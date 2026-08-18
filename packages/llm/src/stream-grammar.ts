/**
 * The stream grammar, verified where the seam is crossed
 * ([ADR-0082](../../../docs/decisions/0082-the-stream-grammar-is-a-seam-obligation-and-every-attempt-has-a-deadline.md)
 * §1-§3).
 *
 * **Why here and not in the adapters.** The three shipped adapters already detect a truncated stream, and
 * they keep doing so — their errors are better attributed, because an adapter knows it was reading an SSE
 * stream. But `FallbackChain` accepts ANY `LLMProvider`: a cassette, a test double, and in Phase 2 a managed
 * gateway. A rule enforced only inside implementations we happen to own is a coincidence, not an obligation.
 * This is the trust boundary; the adapters are defence in depth.
 *
 * **Scope: ORDER, not shape.** Every chunk is assumed to satisfy `StreamChunkSchema` — that is a separate
 * seam obligation the conformance suite enforces. Parsing every chunk of every token stream through Zod is a
 * real per-chunk cost, and unlike the ordering check it is not a branch. A malformed chunk SHAPE is a bug
 * the conformance suite finds; well-shaped chunks in an impossible order are what silently become a wrong
 * answer, and that is what this is for.
 */

import { makeLlmError } from './llm-error.js';
import type { LlmError, ProviderId, StreamChunk } from './types.js';

/** `stop` and `error` are the two terminal arms; everything else commits the stream (ADR-0082 §1). */
function isTerminal(chunk: StreamChunk): boolean {
  return chunk.type === 'stop' || chunk.type === 'error';
}

function violation(provider: ProviderId, message: string): LlmError {
  return makeLlmError({ provider, kind: 'protocol', message });
}

function truncated(provider: ProviderId, message: string): LlmError {
  return makeLlmError({ provider, kind: 'transport', message });
}

/**
 * Wrap a provider's stream so the caller sees a grammar-checked one.
 *
 * Yields the source's chunks unchanged while they are well-formed. On a violation it yields a classified
 * `error` chunk **instead of** whatever the source was doing, and stops — so a downstream consumer that
 * already knows how to handle an `error` terminal needs no new branch.
 *
 * ### The classification table (ADR-0082 §2), evaluated in order
 *
 * | observed | classification |
 * |---|---|
 * | a chunk arrives after a terminal | `protocol` |
 * | a second terminal arrives | `protocol` |
 * | EOF, ≥1 non-terminal chunk seen, no terminal | `transport` |
 * | EOF, zero chunks at all | `transport` |
 * | EOF, exactly one terminal, last | well-formed — the terminal's own semantics apply |
 *
 * The rules in §1 overlap by design (an empty stream violates 1, 5 and 6 at once), so classification is a
 * table of DISJOINT observations rather than one class per rule.
 *
 * **An empty stream is `transport`, not `protocol`**, and that is deliberate: it is operationally
 * indistinguishable from a connection that opened and died. Classifying it as a violation also created a
 * live inconsistency — the adapters' retained no-terminal check fires unconditionally, so a zero-chunk
 * FIRST-PARTY stream already arrives here as a well-formed single `transport` error, while a foreign one
 * would have become `protocol`. Same fault, opposite verdict. `transport` removes the divergence with no
 * adapter change.
 *
 * ### Why the terminal is held
 *
 * "The terminal is the last chunk" cannot be checked when the terminal arrives — only the NEXT read tells
 * you. And the chain returns from an attempt the moment it sees an `error`, so `error → text_delta` and
 * `error → error` would never be read at all. So the terminal is buffered, one more read is taken, and only
 * then is it emitted: EOF confirms it; another chunk replaces it with a `protocol` failure.
 *
 * That extra read happens inside the caller's attempt deadline, so a provider that goes quiet immediately
 * after its terminal cannot hang the verification.
 */
export async function* verifyStreamGrammar(
  source: AsyncIterable<StreamChunk>,
  provider: ProviderId,
): AsyncGenerator<StreamChunk, void> {
  let held: StreamChunk | undefined;
  let sawAnyChunk = false;

  for await (const chunk of source) {
    if (held !== undefined) {
      // Something followed the terminal. Both rows collapse to the same verdict, and the message names
      // which one it was because a provider author needs to know.
      yield {
        type: 'error',
        error: violation(
          provider,
          isTerminal(chunk)
            ? `the provider emitted a second terminal (\`${chunk.type}\` after \`${held.type}\`) — a stream carries exactly one`
            : `the provider emitted a \`${chunk.type}\` chunk after the terminal \`${held.type}\` — the terminal must be last`,
        ),
      };
      return;
    }
    sawAnyChunk = true;
    if (isTerminal(chunk)) {
      held = chunk; // …not yielded yet: one more read has to confirm it was last
      continue;
    }
    yield chunk;
  }

  if (held !== undefined) {
    yield held; // EOF confirmed it — forward the terminal the source meant
    return;
  }
  // No terminal. Both remaining rows are `transport`: the bytes stopped arriving, whether after some
  // content or before any.
  yield {
    type: 'error',
    error: truncated(
      provider,
      sawAnyChunk
        ? 'the stream ended before a terminal chunk — the response was truncated'
        : 'the stream ended without producing any chunk at all',
    ),
  };
}
