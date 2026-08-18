/**
 * ADR-0082 §12's grammar acceptance — one test per row of §2's classification table, each driven by a fake
 * provider producing exactly that observation.
 *
 * Fakes, deliberately: the whole item is about not trusting the implementation. The three shipped adapters
 * already detect a truncated stream; what was missing is a check that holds for a provider we did not write.
 */

import { describe, expect, it } from 'vitest';

import { RETRYABLE_KINDS } from './llm-error.js';
import { verifyStreamGrammar } from './stream-grammar.js';
import type { LlmError, StreamChunk } from './types.js';

async function* from(chunks: readonly StreamChunk[]): AsyncGenerator<StreamChunk> {
  await Promise.resolve();
  for (const chunk of chunks) yield chunk;
}

async function verified(chunks: readonly StreamChunk[]): Promise<StreamChunk[]> {
  const out: StreamChunk[] = [];
  for await (const chunk of verifyStreamGrammar(from(chunks), 'anthropic')) out.push(chunk);
  return out;
}

/** The classified error a verified stream ended with, or `undefined` if it ended well-formed. */
function failureOf(chunks: readonly StreamChunk[]): LlmError | undefined {
  const last = chunks[chunks.length - 1];
  return last?.type === 'error' ? last.error : undefined;
}

const TEXT: StreamChunk = { type: 'text_delta', text: 'hello' };
const STOP: StreamChunk = {
  type: 'stop',
  stopReason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};
const ERR: StreamChunk = {
  type: 'error',
  error: {
    kind: 'overloaded',
    retryable: true,
    provider: 'anthropic',
    message: 'the provider was busy',
  },
};

describe('the classification table (ADR-0082 §2)', () => {
  it('a chunk AFTER the terminal is `protocol`', async () => {
    const out = await verified([TEXT, STOP, TEXT]);

    expect(failureOf(out)?.kind).toBe('protocol');
    expect(failureOf(out)?.message).toContain('after the terminal');
    // The held terminal is REPLACED, not emitted alongside — a consumer must never see a `stop` for a
    // stream that turned out to be malformed.
    expect(out.filter((c) => c.type === 'stop')).toHaveLength(0);
  });

  it('a SECOND terminal is `protocol` — including `error` → `error`', async () => {
    // The case the pre-lookahead chain could never see: it returned from the attempt the moment it read the
    // first `error`, so nothing downstream ever read what followed.
    for (const pair of [
      [STOP, STOP],
      [STOP, ERR],
      [ERR, ERR],
      [ERR, STOP],
    ] as const) {
      const out = await verified([TEXT, ...pair]);
      expect(failureOf(out)?.kind).toBe('protocol');
      expect(failureOf(out)?.message).toContain('second terminal');
    }
  });

  it('EOF after content with NO terminal is `transport` — never a success', async () => {
    // THE defect: `usage === undefined` meant "nothing to fold", and the chain read that as a successful
    // attempt whose partial text became a completed assistant answer.
    const out = await verified([TEXT, TEXT]);

    expect(failureOf(out)?.kind).toBe('transport');
    expect(failureOf(out)?.message).toContain('truncated');
    // …and the content it did produce is still forwarded — the caller decides what a partial answer is worth.
    expect(out.filter((c) => c.type === 'text_delta')).toHaveLength(2);
  });

  it('an EMPTY stream is `transport`, not `protocol`', async () => {
    // Operationally indistinguishable from a connection that opened and died. Classifying it as a violation
    // would also split first-party from foreign: the adapters' retained no-terminal check fires
    // unconditionally, so a zero-chunk first-party stream arrives here as a well-formed single `transport`
    // error, while a foreign one would have been `protocol`. Same fault, opposite verdict.
    const out = await verified([]);

    expect(out).toHaveLength(1);
    expect(failureOf(out)?.kind).toBe('transport');
    expect(failureOf(out)?.message).toContain('any chunk at all');
  });

  it('a well-formed stream passes through UNCHANGED — the negative control', async () => {
    // Without this every rule above is satisfied by a verifier that fails everything.
    const wellFormed: readonly StreamChunk[] = [TEXT, { type: 'text_delta', text: ' world' }, STOP];
    expect(await verified(wellFormed)).toEqual(wellFormed);
  });

  it('a bare terminal is well-formed — a content-free stop, and an immediate error', async () => {
    // An immediate provider `error` as the first and only chunk keeps its OWN kind. The verifier cannot
    // tell that from an adapter's synthesized truncation error, and must not try.
    expect(await verified([STOP])).toEqual([STOP]);
    expect(await verified([ERR])).toEqual([ERR]);
    expect(failureOf(await verified([ERR]))?.kind).toBe('overloaded');
  });

  it('`protocol` is not retryable (ADR-0082 §9)', async () => {
    // An implementation that cannot keep the grammar will not keep it on the second call: a node
    // re-dispatch burns the budget and names the wrong cause.
    expect(RETRYABLE_KINDS.has('protocol')).toBe(false);
    expect(failureOf(await verified([TEXT, STOP, TEXT]))?.retryable).toBe(false);
  });

  it('a THROW during the confirming read still forwards the terminal', async () => {
    // A review reproduced the earlier behaviour: the held `stop` — and the `usage` that prices the call —
    // was dropped and a raw unclassified `Error` escaped, turning a complete, already-billed answer into a
    // total failure with no path back. An SSE reader erroring while tearing down after `[DONE]` is a
    // realistic way to reach it. The terminal was validly received; only "was it last" is unconfirmed.
    async function* tornDown(): AsyncGenerator<StreamChunk> {
      await Promise.resolve();
      yield TEXT;
      yield STOP;
      throw new Error('the SSE reader failed during teardown');
    }
    const out: StreamChunk[] = [];
    for await (const chunk of verifyStreamGrammar(tornDown(), 'anthropic')) out.push(chunk);

    expect(out).toEqual([TEXT, STOP]);
  });

  it('…but a throw with NOTHING held still propagates — the negative control', async () => {
    // A mid-stream failure before any terminal is a real failure, and the chain's own `#errorOf` is what
    // classifies it. Swallowing it here would hide a genuine fault behind a truncated-looking success.
    async function* died(): AsyncGenerator<StreamChunk> {
      await Promise.resolve();
      yield TEXT;
      throw new Error('the connection dropped mid-stream');
    }
    await expect(async () => {
      for await (const chunk of verifyStreamGrammar(died(), 'anthropic')) void chunk;
    }).rejects.toThrow('the connection dropped mid-stream');
  });

  it('the terminal is held until EOF confirms it, and is not emitted early', async () => {
    // The mechanism rule 2 needs: "the terminal is last" is only knowable on the NEXT read. Asserted on
    // ORDER, so a verifier that emitted the terminal eagerly and appended a violation would fail here.
    const out = await verified([TEXT, STOP]);
    expect(out.map((c) => c.type)).toEqual(['text_delta', 'stop']);
  });
});
