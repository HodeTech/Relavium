/**
 * Typed errors for the inbound MCP layer. Their `message` is **secret-free** (a server id / tool id / reason —
 * never an env value, a resolved secret, or a raw provider payload) so it is safe to surface in a log, an
 * event, or the `--json` stream. A `cause` chain (when present) is an **opaque diagnostic** for local
 * debugging: it carries no env/secret data, but it MAY carry the spawned command/args, so the host MUST NOT
 * surface `cause` verbatim in a structured `--json` envelope or a `RunEvent` — it strips it at that boundary.
 */

/** Base class for every `@relavium/mcp` error. */
export class McpError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'McpError';
  }
}

/**
 * Why a connect failed — the discriminant `#204` asks for, derived by inspecting the caught error's SHAPE at
 * the point of catch rather than by parsing a sentence.
 *
 * Every connect failure used to collapse into one message, so a user saw the same line whether the fix was
 * "install the npx package", "check your API key", "the server needs a newer Node", or "wait, npx is still
 * downloading". The reason a program can switch on it; the message is what a person reads.
 */
export type McpConnectReason =
  | 'spawn_failed' // the command does not exist or is not executable (ENOENT/EACCES)
  | 'network' // the socket was refused, reset, or the name did not resolve
  | 'blocked' // our own SSRF policy refused the target
  | 'redirect' // the endpoint redirected; an MCP server is the exact url its author declared
  | 'protocol' // the handshake completed but the server speaks something we cannot
  | 'unknown';

/**
 * Classify a caught connect failure into an {@link McpConnectReason}.
 *
 * **Shape, never message text.** A `code` on a Node system error, a `name` on a typed one — both are stable
 * contracts. Matching on a sentence is how a dependency's wording change silently reclassifies every failure,
 * which is the fragility `#203` names in the tests that had to regex-match a message to find a server id.
 */
export function classifyConnectFailure(cause: unknown): McpConnectReason {
  if (typeof cause !== 'object' || cause === null) return 'unknown';
  const name = readString(cause, 'name');
  const code = readString(cause, 'code');
  if (name === 'SafeEgressError') {
    // Our own egress refusal. `insecure_url` covers the redirect case, which carries its own message.
    return code === 'blocked_host' ? 'blocked' : 'redirect';
  }
  if (code === 'ENOENT' || code === 'EACCES' || code === 'EPERM') return 'spawn_failed';
  if (
    code === 'ECONNREFUSED' ||
    code === 'ECONNRESET' ||
    code === 'ENOTFOUND' ||
    code === 'EHOSTUNREACH' ||
    code === 'ETIMEDOUT'
  ) {
    return 'network';
  }
  // The SDK reports a protocol-version mismatch and a malformed initialize result as plain `Error`s, so this
  // arm reads the message deliberately and ONLY as a last resort — never to distinguish the arms above.
  const message = readString(cause, 'message');
  if (/protocol version|initialize result/i.test(message)) return 'protocol';
  return 'unknown';
}

/**
 * Read a string property off a caught value, INCLUDING one inherited from a prototype.
 *
 * **Measured, not assumed.** A first version spread the error (`{ ...cause }`) and read the copy. On a Node
 * system error `code` is own-enumerable and survives that, but `name` lives on the prototype and does NOT —
 * so the spread saw `name: undefined` for every built-in error. It happened to work for `SafeEgressError`
 * only because that class assigns `this.name` in its constructor, making it an own property. Depending on
 * one class's constructor style to classify every other class is the kind of accident that holds until
 * someone writes a normal `Error` subclass. A direct read sees both.
 *
 * It also avoids copying the rest of a spawn error — `path`, `spawnargs` — into a local object at all, which
 * for a package whose errors are contractually secret-free is the safer shape regardless.
 */
function readString(value: object, key: string): string {
  const raw: unknown = Reflect.get(value, key);
  return typeof raw === 'string' ? raw : '';
}

/** The hint a host appends for a reason, or `''` when the message already says everything useful. */
export function connectHint(reason: McpConnectReason): string {
  switch (reason) {
    case 'spawn_failed':
      return ' The command could not be started — check that it exists and is executable.';
    case 'network':
      return ' The endpoint could not be reached — check the url and that the server is running.';
    case 'protocol':
      return ' The server speaks a protocol version this client does not support.';
    case 'blocked':
    case 'redirect':
    case 'unknown':
      return '';
  }
}

/**
 * A declared MCP server could not be spawned/connected or failed `tools/list` at agent init. Fail-loud: a
 * declared capability that cannot be reached is a configuration error, not a silent capability loss
 * ([ADR-0052](../../../docs/decisions/0052-inbound-mcp-client-package-lifecycle-registration.md) §2). `cause`
 * is the underlying SDK/spawn error — opaque (see the module note); never surfaced verbatim downstream.
 */
export class McpConnectError extends McpError {
  /** WHICH server — a field, not a sentence to regex (`#203`). */
  readonly serverId: string;
  /** WHY, derived from the caught error's shape (`#204`). */
  readonly reason: McpConnectReason;

  constructor(serverId: string, options?: { cause?: unknown }) {
    const reason = classifyConnectFailure(options?.cause);
    super(
      `MCP server "${serverId}" could not be connected or listed.${connectHint(reason)}`,
      options,
    );
    this.name = 'McpConnectError';
    this.serverId = serverId;
    this.reason = reason;
  }
}

/**
 * An MCP-backed tool was dispatched but the host's `McpCapability` (`host.mcp`) is not wired — a host
 * assembly bug, surfaced as a tool execution error rather than a silent no-op.
 */
export class McpHostUnavailableError extends McpError {
  /** WHICH tool — a field, so a caller reads it rather than parsing the sentence (`#203`). */
  readonly toolId: string;

  constructor(toolId: string) {
    super(`the MCP capability is not wired on the host (tool "${toolId}")`);
    this.name = 'McpHostUnavailableError';
    this.toolId = toolId;
  }
}

/**
 * A routing failure: the capability was asked for a server it has no connection to.
 *
 * Its own class rather than a bare `McpError`, for `#203`'s reason — the manager's own test had to
 * `rejects.toThrow(/"bad"/)`, regex-matching a human sentence, because there was no field to read the failing
 * server id from. A wording tweak would have broken that test silently.
 */
export class McpNoConnectionError extends McpError {
  readonly serverId: string;

  constructor(serverId: string) {
    super(`no MCP connection for server "${serverId}"`);
    this.name = 'McpNoConnectionError';
    this.serverId = serverId;
  }
}

/** A duplicate server id in one declaration set — the routing key must be unique. */
export class McpDuplicateServerError extends McpError {
  readonly serverId: string;

  constructor(serverId: string) {
    super(`duplicate MCP server id "${serverId}"`);
    this.name = 'McpDuplicateServerError';
    this.serverId = serverId;
  }
}
