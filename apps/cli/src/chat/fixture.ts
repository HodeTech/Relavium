import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  CapabilityFlagsSchema,
  ProviderIdSchema,
  StreamChunkSchema,
  type CapabilityFlags,
  type LlmProvider,
  type StreamChunk,
} from '@relavium/llm';
import { z } from 'zod';

import type { ProviderResolver } from '../engine/providers.js';
import { CliError } from '../process/errors.js';

/**
 * `agent run --fixture` cassette replay (2.Q) — the on-disk form of the in-memory `scriptedProvider`, so a
 * one-shot `relavium agent run` is deterministic and fully offline (no key, no network). It is the CLI's
 * small, dependency-free analogue of the `@relavium/llm` conformance replay; every recorded chunk is a
 * Relavium-owned `StreamChunk`, never a vendor SDK shape (the seam holds, ADR-0011). The format is documented
 * in [agent-run-fixture.md](../../../../docs/reference/cli/agent-run-fixture.md).
 */

/** A cassette: the recorded `StreamChunk[]` per `provider.stream()` call, answered as `provider`. */
export const CassetteSchema = z.object({
  schema_version: z.literal('1.0'),
  provider: ProviderIdSchema,
  model: z.string().optional(),
  /** One entry per `stream()` call in the turn (call N → `calls[N]`); each is the ordered chunk list. */
  calls: z.array(z.array(StreamChunkSchema)),
});
export type Cassette = z.infer<typeof CassetteSchema>;

/** The replay provider's reported capabilities — permissive (text + tools + streaming) so the chain never pre-skips it. */
const REPLAY_CAPABILITIES: CapabilityFlags = CapabilityFlagsSchema.parse({
  tools: true,
  streaming: true,
  parallelToolCalls: false,
  vision: false,
  promptCache: false,
  reasoning: false,
  media: {
    input: { image: false, audio: false, video: false, document: false },
    outputCombinations: [['text']],
    surface: 'chat',
  },
});

/**
 * Read + validate a cassette from `fixturePath` (absolute, or relative to `cwd`). Bad JSON, an unknown
 * `schema_version`, or a chunk that fails `StreamChunkSchema` is a clean exit-2 invocation fault — never a
 * raw crash. The chunk validation is the boundary guarantee that a malformed cassette cannot reach the engine.
 */
export function loadCassette(fixturePath: string, cwd: string): Cassette {
  const path = resolve(cwd, fixturePath);
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    throw new CliError('invalid_invocation', `cannot read fixture ${path}`, { cause: err });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new CliError('invalid_invocation', `fixture ${path} is not valid JSON`, { cause: err });
  }
  const result = CassetteSchema.safeParse(parsed);
  if (!result.success) {
    throw new CliError(
      'invalid_invocation',
      `fixture ${path} is not a valid cassette: ${result.error.issues[0]?.message ?? 'schema mismatch'}`,
    );
  }
  return result.data;
}

async function* streamOf(chunks: readonly StreamChunk[]): AsyncGenerator<StreamChunk> {
  await Promise.resolve();
  for (const chunk of chunks) yield chunk;
}

/**
 * A replay {@link LlmProvider} over a cassette: call N of `stream()` replays `cassette.calls[N]`. An
 * unscripted call throws (an extra LLM invocation is a fixture/agent mismatch, never a silent empty turn).
 * `generate` is never used (the session path streams); the key is a fixed non-secret marker (offline).
 */
export function cassetteProvider(cassette: Cassette): LlmProvider {
  let call = 0;
  return {
    id: cassette.provider,
    supports: REPLAY_CAPABILITIES,
    generate: () => {
      throw new Error('agent run --fixture replays the streaming path, not generate()');
    },
    stream: () => {
      const chunks = cassette.calls[call];
      call += 1;
      if (chunks === undefined) {
        throw new Error(
          `fixture cassette: unexpected stream call #${call} (only ${cassette.calls.length} recorded)`,
        );
      }
      return streamOf(chunks);
    },
  };
}

/** A {@link ProviderResolver} that answers the cassette's `provider` with the replay provider; a fixed dummy key. */
export function cassetteResolver(cassette: Cassette): ProviderResolver {
  const provider = cassetteProvider(cassette);
  return {
    resolveProvider: (id) => (id === cassette.provider ? provider : undefined),
    keyFor: () => 'fixture-key',
  };
}
