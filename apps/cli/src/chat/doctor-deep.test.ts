import type { LlmProvider, ProviderId } from '@relavium/llm';
import type { ManagerSkippedTool } from '@relavium/mcp';
import type { McpServerRef } from '@relavium/shared';
import { describe, expect, it, vi } from 'vitest';

import type { ProviderResolver } from '../engine/providers.js';
import { CHAT_TEXT_CAPABILITY_FLAGS } from '../test-support.js';
import { buildProviderProbe, mcpSessionChecks } from './doctor-deep.js';

// A test key assembled at runtime (no contiguous secret literal — leakwatch).
const TEST_KEY = ['sk', 'doctor', '90ABCDEF'].join('-');

// A REAL LlmProvider fixture (no double cast) — only `generate` is exercised; `stream` is a fail-loud stub.
const fakeProvider = (generate: LlmProvider['generate']): LlmProvider => ({
  id: 'anthropic',
  generate,
  stream: () => {
    throw new Error('stream is not exercised by the doctor probe');
  },
  supports: CHAT_TEXT_CAPABILITY_FLAGS,
});

const resolverWith = (
  providers: Partial<Record<ProviderId, LlmProvider | undefined>>,
  keys: Partial<Record<ProviderId, string>> = {},
): ProviderResolver => ({
  resolveProvider: (id) => providers[id],
  keyFor: (id) => {
    const key = keys[id];
    if (key === undefined) throw new Error(`no key for ${id}`);
    return key;
  },
});

const ref = (id: string): McpServerRef => ({ id });
const skip = (server: string, name: string, reason: string): ManagerSkippedTool => ({
  server,
  name,
  reason,
});

describe('buildProviderProbe', () => {
  it('warns when no candidate has a resolvable key', async () => {
    const probe = buildProviderProbe({ resolver: resolverWith({}), candidateIds: [] });
    const checks = await probe();
    expect(checks).toEqual([
      { id: 'provider', label: 'providers', status: 'warn', detail: 'no keys configured' },
    ]);
  });

  it('reports ok when the live ping succeeds', async () => {
    const generate = vi.fn().mockResolvedValue({});
    const probe = buildProviderProbe({
      resolver: resolverWith({ anthropic: fakeProvider(generate) }, { anthropic: TEST_KEY }),
      candidateIds: ['anthropic'],
    });
    const [check] = await probe();
    expect(check).toMatchObject({ id: 'provider:anthropic', status: 'ok' });
    expect(check?.detail).toContain('key works');
    // The key reached generate but never the detail.
    expect(generate).toHaveBeenCalledWith(expect.anything(), TEST_KEY);
  });

  it('redacts the key from a failing-ping detail', async () => {
    const generate = vi.fn().mockRejectedValue(new Error(`401 unauthorized for ${TEST_KEY}`));
    const probe = buildProviderProbe({
      resolver: resolverWith({ anthropic: fakeProvider(generate) }, { anthropic: TEST_KEY }),
      candidateIds: ['anthropic'],
    });
    const [check] = await probe();
    expect(check?.status).toBe('fail');
    expect(check?.detail).not.toContain(TEST_KEY);
    expect(check?.detail).toContain('90ABCDEF'.slice(-4)); // the last-4 hint survives
  });

  it('reports "no adapter" when the provider does not resolve', async () => {
    const probe = buildProviderProbe({
      resolver: resolverWith({ anthropic: undefined }, { anthropic: TEST_KEY }),
      candidateIds: ['anthropic'],
    });
    const [check] = await probe();
    expect(check).toMatchObject({ id: 'provider:anthropic', status: 'fail', detail: 'no adapter' });
  });

  it('skips a candidate whose key does not resolve (never pings it)', async () => {
    const generate = vi.fn();
    const probe = buildProviderProbe({
      resolver: resolverWith({ anthropic: fakeProvider(generate) }, {}), // no key configured
      candidateIds: ['anthropic'],
    });
    const [check] = await probe();
    expect(check).toMatchObject({ id: 'provider', status: 'warn', detail: 'no keys configured' });
    expect(generate).not.toHaveBeenCalled();
  });

  it('hard-bounds a hanging ping at the timeout (secret-free even if the abort error carries the key)', async () => {
    // The fake honors abort by rejecting with the KEY embedded — so if the hard race were broken and the abort
    // detail surfaced, the `not.toContain(TEST_KEY)` assertion would catch a leak. The hard outer race bounds the
    // probe regardless of whether the adapter honors the signal, so the detail is the timeout message.
    const generate: LlmProvider['generate'] = (req) =>
      new Promise((_resolve, reject) => {
        req.signal?.addEventListener('abort', () => reject(new Error(`aborted: ${TEST_KEY}`)));
      });
    const probe = buildProviderProbe({
      resolver: resolverWith({ anthropic: fakeProvider(generate) }, { anthropic: TEST_KEY }),
      candidateIds: ['anthropic'],
      timeoutMs: 5,
    });
    const [check] = await probe();
    expect(check?.status).toBe('fail');
    expect(check?.detail).toContain('timeout');
    expect(check?.detail).not.toContain(TEST_KEY);
  });

  it('hard-bounds a provider whose adapter IGNORES the abort signal (never hangs)', async () => {
    // A misbehaving adapter that never resolves and ignores the signal — the hard race still settles the probe.
    const generate: LlmProvider['generate'] = () => new Promise(() => {});
    const probe = buildProviderProbe({
      resolver: resolverWith({ anthropic: fakeProvider(generate) }, { anthropic: TEST_KEY }),
      candidateIds: ['anthropic'],
      timeoutMs: 5,
    });
    const [check] = await probe();
    expect(check).toMatchObject({ status: 'fail' });
    expect(check?.detail).toContain('timeout');
  });
});

describe('mcpSessionChecks (read-only session status — never connects)', () => {
  it('warns when the agent declares no MCP servers', () => {
    expect(mcpSessionChecks([], [])).toEqual([
      { id: 'mcp', label: 'MCP servers', status: 'warn', detail: 'none configured' },
    ]);
  });

  it('reports each declared server as connected (a live session means the fail-loud connect succeeded)', () => {
    const checks = mcpSessionChecks([ref('fs'), ref('github')], []);
    expect(checks).toEqual([
      { id: 'mcp:fs', label: 'fs', status: 'ok', detail: 'connected' },
      { id: 'mcp:github', label: 'github', status: 'ok', detail: 'connected' },
    ]);
  });

  it('surfaces a manager-skipped tool as a warning explaining the missing capability', () => {
    const checks = mcpSessionChecks([ref('fs')], [skip('fs', 'danger', 'not in allowlist')]);
    expect(checks).toContainEqual({
      id: 'mcp:skip:fs:danger',
      label: 'fs/danger',
      status: 'warn',
      detail: 'tool skipped — not in allowlist',
    });
  });

  it('uses the by-name ref when an entry has no inline id', () => {
    const byName: McpServerRef = { ref: 'shared-fs' };
    expect(mcpSessionChecks([byName], [])[0]).toMatchObject({ id: 'mcp:shared-fs', label: 'shared-fs' });
  });
});
