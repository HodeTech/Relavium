import type { JsonSchema } from '@relavium/core';
import type { AbortSignalLike } from '@relavium/shared';

/**
 * The narrow, **SDK-type-free** seam between the inbound MCP layer and a live server connection
 * ([ADR-0052](../../../docs/decisions/0052-inbound-mcp-client-package-lifecycle-registration.md) §1). The
 * `@modelcontextprotocol/sdk` is fenced behind this interface (see `sdk-stdio.ts`), so the tool-shaping and
 * host wiring depend only on Relavium/Zod shapes and are testable against a fake connection — exactly as the
 * `@relavium/llm` seam fences the provider SDKs.
 */

/** A tool discovered from a server's `tools/list`, projected to Relavium shapes (no SDK type crosses here). */
export interface DiscoveredTool {
  readonly name: string;
  readonly description?: string;
  /** The server-reported JSON Schema for the tool's arguments — compiled to an executable validator (ADR-0052 §4). */
  readonly inputSchema: JsonSchema;
}

/** A text content part of a `tools/call` result. */
export interface McpTextContent {
  readonly type: 'text';
  readonly text: string;
}
/** A non-text content part (image/audio/resource/…) — its kind is carried; bytes are not (a later concern). */
export interface McpNonTextContent {
  readonly type: 'non_text';
  readonly kind: string;
}
export type McpContentPart = McpTextContent | McpNonTextContent;

/** The Relavium-shaped result of a `tools/call`. `isError` is the server's tool-level error flag (recoverable). */
export interface McpToolResult {
  readonly content: readonly McpContentPart[];
  readonly isError: boolean;
}

/**
 * A live connection to ONE MCP server — the seam the SDK adapter implements and a fake satisfies in tests.
 *
 * **Both round-trips take an optional `signal`** ([ADR-0088](../../../docs/decisions/0088-the-mcp-boundary-is-hostile.md) §1.2).
 * It was measured absent: `McpCapability.call(input, signal)` received the engine's signal and had nowhere to
 * put it, so an aborted `tools/call` was still pending 500 ms later and the only cancellation available was
 * tearing the whole connection down — which invalidates every other call to that server for the rest of the
 * session. The parameter is `AbortSignalLike` rather than a DOM `AbortSignal` because the engine's signal is
 * platform-free; each adapter bridges it at the SDK fence.
 */
export interface McpConnection {
  /** List the server's tools (the `tools/list` round-trip), bounded and cancellable. */
  listTools(signal?: AbortSignalLike): Promise<readonly DiscoveredTool[]>;
  /** Invoke one tool by its ORIGINAL (server) name with already-validated arguments. */
  callTool(name: string, args: unknown, signal?: AbortSignalLike): Promise<McpToolResult>;
  /** Tear the connection down (terminate the stdio child / close the socket). Idempotent. */
  close(): Promise<void>;
}
