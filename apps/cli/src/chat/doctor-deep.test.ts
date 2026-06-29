import type { LlmProvider, ProviderId } from '@relavium/llm';
import type { McpClient, McpServerConfig } from '@relavium/mcp';
import { describe, expect, it, vi } from 'vitest';

import type { ProviderResolver } from '../engine/providers.js';
import { buildMcpProbe, buildProviderProbe } from './doctor-deep.js';

// A test key assembled at runtime (no contiguous secret literal — leakwatch).
const TEST_KEY = ['sk', 'doctor', '90ABCDEF'].join('-');

const fakeProvider = (generate: LlmProvider['generate']): LlmProvider =>
  ({ generate }) as unknown as LlmProvider;

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

const fakeClient = (toolCount: number, onClose: () => void = () => {}): McpClient =>
  ({
    capability: {},
    toolDefs: Array.from({ length: toolCount }, (_, i) => ({ name: `t${i}` })),
    toolIdsByServer: new Map(),
    skipped: [],
    close: () => {
      onClose();
      return Promise.resolve();
    },
  }) as unknown as McpClient;

const server = (id: string): McpServerConfig => ({ id }) as unknown as McpServerConfig;

describe('buildProviderProbe', () => {
  it('warns when no provider key is configured', async () => {
    const probe = buildProviderProbe({ resolver: resolverWith({}), configuredIds: [] });
    const checks = await probe();
    expect(checks).toEqual([
      { id: 'provider', label: 'providers', status: 'warn', detail: 'no keys configured' },
    ]);
  });

  it('reports ok when the live ping succeeds', async () => {
    const generate = vi.fn().mockResolvedValue({});
    const probe = buildProviderProbe({
      resolver: resolverWith({ anthropic: fakeProvider(generate) }, { anthropic: TEST_KEY }),
      configuredIds: ['anthropic'],
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
      configuredIds: ['anthropic'],
    });
    const [check] = await probe();
    expect(check?.status).toBe('fail');
    expect(check?.detail).not.toContain(TEST_KEY);
    expect(check?.detail).toContain('90ABCDEF'.slice(-4)); // the last-4 hint survives
  });

  it('reports "no adapter" when the provider does not resolve', async () => {
    const probe = buildProviderProbe({
      resolver: resolverWith({ anthropic: undefined }, { anthropic: TEST_KEY }),
      configuredIds: ['anthropic'],
    });
    const [check] = await probe();
    expect(check).toMatchObject({ id: 'provider:anthropic', status: 'fail', detail: 'no adapter' });
  });

  it('reports "no key resolved" when keyFor throws', async () => {
    const probe = buildProviderProbe({
      resolver: resolverWith({ anthropic: fakeProvider(vi.fn()) }, {}),
      configuredIds: ['anthropic'],
    });
    const [check] = await probe();
    expect(check).toMatchObject({ status: 'fail', detail: 'no key resolved' });
  });

  it('aborts a hanging ping at the timeout and reports a (redacted) failure', async () => {
    const generate: LlmProvider['generate'] = (req) =>
      new Promise((_resolve, reject) => {
        req.signal?.addEventListener('abort', () => reject(new Error('request aborted')));
      });
    const probe = buildProviderProbe({
      resolver: resolverWith({ anthropic: fakeProvider(generate) }, { anthropic: TEST_KEY }),
      configuredIds: ['anthropic'],
      timeoutMs: 5,
    });
    const [check] = await probe();
    expect(check?.status).toBe('fail');
    expect(check?.detail).not.toContain(TEST_KEY);
  });
});

describe('buildMcpProbe', () => {
  it('warns when no MCP server is configured', async () => {
    const probe = buildMcpProbe({ servers: [] });
    expect(await probe()).toEqual([
      { id: 'mcp', label: 'MCP servers', status: 'warn', detail: 'none configured' },
    ]);
  });

  it('reports ok with the tool count and closes the client', async () => {
    const close = vi.fn();
    const probe = buildMcpProbe({
      servers: [server('fs')],
      startMcpClient: () => Promise.resolve(fakeClient(3, close)),
    });
    const [check] = await probe();
    expect(check).toMatchObject({ id: 'mcp:fs', status: 'ok', detail: '3 tool(s)' });
    expect(close).toHaveBeenCalledOnce();
  });

  it('reports a (sanitized, single-line) failure on a connect error', async () => {
    const probe = buildMcpProbe({
      servers: [server('flaky')],
      startMcpClient: () => Promise.reject(new Error('connect failed:\nECONNREFUSED')),
    });
    const [check] = await probe();
    expect(check?.status).toBe('fail');
    expect(check?.detail).not.toContain('\n');
    expect(check?.detail).toContain('ECONNREFUSED');
  });

  it('times out a hung connect without leaking', async () => {
    const probe = buildMcpProbe({
      servers: [server('hung')],
      startMcpClient: () => new Promise<McpClient>(() => {}), // never resolves
      timeoutMs: 5,
    });
    const [check] = await probe();
    expect(check).toMatchObject({ id: 'mcp:hung', status: 'fail' });
    expect(check?.detail).toContain('timeout');
  });

  it('closes a late-resolving client after a timeout (no process leak)', async () => {
    const close = vi.fn();
    let resolveLate: (client: McpClient) => void = () => {};
    const probe = buildMcpProbe({
      servers: [server('slow')],
      startMcpClient: () =>
        new Promise<McpClient>((resolve) => {
          resolveLate = resolve;
        }),
      timeoutMs: 5,
    });
    const [check] = await probe();
    expect(check?.status).toBe('fail');
    resolveLate(fakeClient(1, close)); // the connect finally resolves, after the probe gave up
    await Promise.resolve();
    await Promise.resolve();
    expect(close).toHaveBeenCalledOnce();
  });

  it('gives a per-server verdict (one dead server never masks another)', async () => {
    const probe = buildMcpProbe({
      servers: [server('ok'), server('bad')],
      startMcpClient: (servers) =>
        servers[0]?.id === 'ok'
          ? Promise.resolve(fakeClient(2))
          : Promise.reject(new Error('boom')),
    });
    const checks = await probe();
    expect(checks.map((c) => `${c.id}:${c.status}`)).toEqual(['mcp:ok:ok', 'mcp:bad:fail']);
  });
});
