import { describe, expect, it } from 'vitest';

import { isCliError } from '../process/errors.js';
import { KeychainUnavailableError, type KeychainStore } from './keychain.js';
import { createMcpSecretResolver, mcpSecretAccount, mcpSecretEnvVar } from './mcp-secret.js';

/** An in-memory keychain fake seeded with the given accounts; never touches the real OS keychain. */
function fakeKeychain(entries: Record<string, string> = {}): KeychainStore & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    get: (account) => {
      reads.push(account);
      return entries[account] ?? null;
    },
    set: () => undefined,
    delete: () => false,
  };
}

describe('mcpSecretAccount / mcpSecretEnvVar', () => {
  it('derives the isolated keychain account and the env-var fallback name', () => {
    expect(mcpSecretAccount('github-token')).toBe('mcp-secret:github-token');
    expect(mcpSecretEnvVar('github-token')).toBe('RELAVIUM_MCP_GITHUB_TOKEN');
    expect(mcpSecretEnvVar('gh.api')).toBe('RELAVIUM_MCP_GH_API'); // non-alphanumerics → underscore
  });
});

describe('createMcpSecretResolver', () => {
  it('resolves from the isolated mcp-secret:* keychain account first', () => {
    const keychain = fakeKeychain({ 'mcp-secret:gh': 'ghp_keychain' });
    const resolve = createMcpSecretResolver({}, keychain);
    expect(resolve('gh')).toBe('ghp_keychain');
    expect(keychain.reads).toEqual(['mcp-secret:gh']); // read the isolated account, nothing else
  });

  it('falls back to RELAVIUM_MCP_<NAME> when the keychain has no entry', () => {
    const keychain = fakeKeychain(); // empty
    const resolve = createMcpSecretResolver({ RELAVIUM_MCP_GH: 'ghp_env' }, keychain);
    expect(resolve('gh')).toBe('ghp_env');
  });

  it('NEVER resolves a provider-key account or RELAVIUM_<PROVIDER>_API_KEY (namespace isolation)', () => {
    // The exfil scenario: an imported agent names `anthropic` hoping to read the provider key. The resolver
    // reads ONLY `mcp-secret:anthropic` (empty) + `RELAVIUM_MCP_ANTHROPIC` — never `anthropic:default` nor
    // `RELAVIUM_ANTHROPIC_API_KEY`. So the provider key cannot leak into a (possibly hostile) MCP server.
    const keychain = fakeKeychain({ 'anthropic:default': 'sk-PROVIDER-SECRET' });
    const resolve = createMcpSecretResolver(
      { RELAVIUM_ANTHROPIC_API_KEY: 'sk-PROVIDER-SECRET' },
      keychain,
    );
    expect(() => resolve('anthropic')).toThrow(/not set/); // fail-closed — the provider key is unreachable
    expect(keychain.reads).toEqual(['mcp-secret:anthropic']); // only the isolated account was queried
  });

  it('fails closed (typed exit-2 CliError, no secret value) when neither source has the secret', () => {
    const resolve = createMcpSecretResolver({}, fakeKeychain());
    try {
      resolve('missing');
      expect.unreachable('a missing secret must throw');
    } catch (err) {
      expect(isCliError(err) && err.code).toBe('invalid_invocation');
      const msg = (err as Error).message;
      expect(msg).toContain('mcp-secret:missing'); // names the keychain account
      expect(msg).toContain('RELAVIUM_MCP_MISSING'); // and the env var
    }
  });

  it('treats an unavailable keychain backend as absence — falls through to the env var', () => {
    const throwing: KeychainStore = {
      get: () => {
        throw new KeychainUnavailableError('locked');
      },
      set: () => undefined,
      delete: () => false,
    };
    const resolve = createMcpSecretResolver({ RELAVIUM_MCP_GH: 'ghp_env' }, throwing);
    expect(resolve('gh')).toBe('ghp_env'); // a locked keychain is not a fault — the env var serves
  });

  it('rejects an invalid secret name (defensive charset guard) before touching any source', () => {
    const keychain = fakeKeychain();
    const resolve = createMcpSecretResolver({}, keychain);
    expect(() => resolve('bad name')).toThrow(/invalid MCP secret name/);
    expect(() => resolve('a/b')).toThrow(/invalid MCP secret name/);
    expect(keychain.reads).toEqual([]); // never queried — fails on the name first
  });

  it('works env-only (no keychain) — the headless / CI path', () => {
    const resolve = createMcpSecretResolver({ RELAVIUM_MCP_GH: 'ghp_env' });
    expect(resolve('gh')).toBe('ghp_env');
  });
});
