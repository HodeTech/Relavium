import { describe, expect, it } from 'vitest';

import {
  classifyConnectFailure,
  McpConnectError,
  McpDuplicateServerError,
  McpHostUnavailableError,
  McpNoConnectionError,
} from './errors.js';

/**
 * The error taxonomy `#203`/`#204` asked for
 * ([ADR-0088](../../../docs/decisions/0088-the-mcp-boundary-is-hostile.md) §9).
 *
 * Two complaints, one file. `#203`: every identifier was interpolated into a sentence with no field, so the
 * package's OWN tests had to `rejects.toThrow(/"bad"/)` — regex-matching human prose to find a server id, which
 * a wording tweak breaks silently. `#204`: every connect failure collapsed into one message, so a user saw the
 * same line whether the fix was "install the package", "check the url", "upgrade Node", or "wait, npx is still
 * downloading".
 */

describe('structured fields (#203)', () => {
  it('carries the server id as a FIELD, not only in the sentence', () => {
    const err = new McpConnectError('github');
    expect(err.serverId).toBe('github');
    expect(err.message).toContain('github'); // the sentence still reads well for a human
  });

  it('gives the routing failures their own classes and fields', () => {
    expect(new McpNoConnectionError('fs').serverId).toBe('fs');
    expect(new McpDuplicateServerError('fs').serverId).toBe('fs');
    expect(new McpHostUnavailableError('mcp_fs_read').toolId).toBe('mcp_fs_read');
  });
});

describe('classifyConnectFailure (#204)', () => {
  it('reads `code` off a real Node system error — the spawn case', () => {
    // **Measured rather than assumed.** `code` is own-enumerable on a Node system error and `name` is NOT
    // (it lives on the prototype), which is why the classification reads properties directly instead of
    // spreading the error: a first version spread it and saw `name: undefined` for every built-in.
    const enoent = Object.assign(new Error('spawn npx ENOENT'), {
      errno: -2,
      code: 'ENOENT',
      syscall: 'spawn npx',
    });
    expect(classifyConnectFailure(enoent)).toBe('spawn_failed');
    expect(classifyConnectFailure(Object.assign(new Error('x'), { code: 'EACCES' }))).toBe(
      'spawn_failed',
    );
  });

  it('distinguishes a network failure from a spawn one', () => {
    for (const code of ['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EHOSTUNREACH', 'ETIMEDOUT']) {
      expect(classifyConnectFailure(Object.assign(new Error('x'), { code }))).toBe('network');
    }
  });

  it('reads OUR OWN egress refusal through its `name`, which lives on an own property', () => {
    const blocked = Object.assign(new Error('egress target is a private/loopback address'), {
      name: 'SafeEgressError',
      code: 'blocked_host',
    });
    expect(classifyConnectFailure(blocked)).toBe('blocked');
    const redirected = Object.assign(new Error('an MCP endpoint may not redirect'), {
      name: 'SafeEgressError',
      code: 'insecure_url',
    });
    expect(classifyConnectFailure(redirected)).toBe('redirect');
  });

  it('falls back to the MESSAGE only for the protocol case, never to distinguish the others', () => {
    // The SDK reports a version mismatch as a plain `Error`, so there is no shape to read — this arm is the
    // deliberate exception, and it must not be what decides any case a code could have decided.
    expect(classifyConnectFailure(new Error("Server's protocol version is not supported: 9"))).toBe(
      'protocol',
    );
    expect(classifyConnectFailure(new Error('something else entirely'))).toBe('unknown');
    // A code-bearing error is classified by its CODE even when the message mentions a protocol.
    expect(
      classifyConnectFailure(
        Object.assign(new Error('protocol version chatter'), { code: 'ECONNREFUSED' }),
      ),
    ).toBe('network');
  });

  it('is `unknown` for a non-object, rather than throwing', () => {
    expect(classifyConnectFailure(undefined)).toBe('unknown');
    expect(classifyConnectFailure('a string')).toBe('unknown');
    expect(classifyConnectFailure(null)).toBe('unknown');
  });
});

describe('the message a user actually reads', () => {
  it('appends an actionable hint for a spawn failure', () => {
    const err = new McpConnectError('gh', {
      cause: Object.assign(new Error('spawn npx ENOENT'), { code: 'ENOENT' }),
    });
    expect(err.reason).toBe('spawn_failed');
    expect(err.message).toMatch(/could not be started/);
  });

  it('adds NO hint where the underlying message already says everything', () => {
    // A blocked host and a refused redirect carry their own reason-only messages; a generic hint after one
    // would be noise, and `#204` asked for a diagnostic rather than more prose.
    const blocked = new McpConnectError('gh', {
      cause: Object.assign(new Error('blocked'), { name: 'SafeEgressError', code: 'blocked_host' }),
    });
    expect(blocked.reason).toBe('blocked');
    expect(blocked.message).toBe('MCP server "gh" could not be connected or listed.');
  });

  it('never carries the cause into the message — the cause stays opaque', () => {
    // `errors.ts`'s module contract: the message is secret-free, and `cause` MAY carry the spawned command.
    const err = new McpConnectError('gh', {
      cause: Object.assign(new Error('spawn /usr/local/bin/secret-tool ENOENT'), {
        code: 'ENOENT',
        spawnargs: ['--token', 'sk-live-abc'],
      }),
    });
    expect(err.message).not.toContain('sk-live-abc');
    expect(err.message).not.toContain('secret-tool');
  });
});
