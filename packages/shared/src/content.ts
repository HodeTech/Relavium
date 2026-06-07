import { z } from 'zod';

import { nonEmptyString } from './common.js';

/**
 * Cross-package runtime contract types the `@relavium/llm` seam — and, later, the session
 * message schemas — build on. They live in `@relavium/shared`, the base of the dependency graph
 * (`shared → llm → core`), so the seam can re-export `ContentPart` without `@relavium/shared`
 * ever importing from `@relavium/llm` (which would invert the package dependency). See
 * [ADR-0011](../../../docs/decisions/0011-internal-llm-abstraction.md).
 */

/**
 * A normalized message content part — the one shape every provider's content is folded into,
 * shared by an LLM message (the seam's `LlmMessage`) and a persisted session message. `args`
 * and `result` are opaque (`unknown`): the engine and adapters own their JSON shapes, not this
 * contract.
 */
export const ContentPartSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({
    type: z.literal('tool_call'),
    id: nonEmptyString,
    name: nonEmptyString,
    args: z.unknown(),
    // The provider ran this tool on its own side (server-side / built-in tool, e.g. web search). The
    // engine's ToolDispatcher does NOT execute it and does not apply its allowlist to it — it only
    // records/forwards. Omitted (or false) means an engine-executed call. See ADR-0030 / ADR-0029.
    providerExecuted: z.boolean().optional(),
  }),
  z.object({
    type: z.literal('tool_result'),
    toolCallId: nonEmptyString,
    result: z.unknown(),
    isError: z.boolean().optional(),
    // The provider produced this result (the counterpart of a provider-executed tool_call). ADR-0030.
    providerExecuted: z.boolean().optional(),
  }),
  // Reasoning / "thinking" content (ADR-0030). EPHEMERAL: `signature` is a same-provider, same-turn
  // continuity token — it is never persisted to a session, never replayed across a provider boundary
  // on fallback, and never written to a run event or log. The engine does not interpret it; only the
  // originating adapter feeds it back. `redacted` marks a provider-withheld block (data, no text).
  z.object({
    type: z.literal('reasoning'),
    text: z.string(),
    signature: z.string().optional(),
    redacted: z.boolean().optional(),
  }),
]);
export type ContentPart = z.infer<typeof ContentPartSchema>;

/**
 * The minimal structural cancellation handle the seam and the engine thread through. A real
 * `AbortSignal` (Node ≥15, browsers, Bun) structurally satisfies it, so the platform-free code —
 * `shared`, `core`, and the `@relavium/llm` **seam** — needs neither the DOM lib nor `@types/node`
 * (the strict base's `lib: ["ES2023"]` has no `AbortSignal`); cancellation is expressed in this type
 * instead. (`@relavium/llm`'s *adapters* import the provider SDKs and so do pull in `@types/node`,
 * but the seam types never name a Node/DOM type — enforced by tsconfig.seam.json.) The surface
 * passes a real signal; engine code only observes `aborted` and (de)registers an abort listener.
 */
export interface AbortSignalLike {
  readonly aborted: boolean;
  addEventListener(type: 'abort', listener: () => void): void;
  removeEventListener(type: 'abort', listener: () => void): void;
}
