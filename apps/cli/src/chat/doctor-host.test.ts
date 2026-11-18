import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { McpServerRef } from '@relavium/shared';
import { describe, expect, it, vi } from 'vitest';

import type { ProviderResolver } from '../engine/providers.js';
import type { KeychainStore } from '../secrets/keychain.js';
import { assembleDoctorProbes } from './doctor-host.js';

const resolver: ProviderResolver = {
  resolveProvider: () => undefined,
  keyFor: () => {
    throw new Error('no key');
  },
};
const ref = (id: string): McpServerRef => ({ id });

describe('assembleDoctorProbes', () => {
  it('forwards the private home to ordinary filesystem reads without a native write profile', async () => {
    const root = mkdtempSync(join(tmpdir(), 'relavium-doctor-fs-'));
    try {
      const workspace = join(root, 'workspace');
      const home = join(root, 'home');
      mkdirSync(workspace);
      mkdirSync(home, { mode: 0o700 });
      writeFileSync(join(workspace, 'notes.txt'), 'doctor read control');
      const probes = assembleDoctorProbes({ cwd: workspace, operatorHomeDir: home, resolver });
      const fs = probes.toolHost?.fs;
      if (fs === undefined) throw new Error('Doctor did not expose its filesystem capability.');
      expect((await fs.readFile('notes.txt', {})).content).toBe('doctor read control');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it('builds every probe as a CLOSURE — no keychain read / config load / connect at construction', () => {
    const keychain: KeychainStore = {
      get: vi.fn(() => null),
      set: vi.fn(),
      delete: vi.fn(() => false),
    };
    const probes = assembleDoctorProbes({
      cwd: '/tmp/x',
      resolver,
      keychain,
      agentMcpServers: [ref('fs')],
    });
    // Assembling touched nothing — a regression here would read the keychain on every chat/Home start.
    expect(keychain.get).not.toHaveBeenCalled();
    // The read happens only when the probe RUNS.
    probes.keychain();
    expect(keychain.get).toHaveBeenCalledOnce();
  });

  it('the --deep MCP tier REPORTS the session status (read-only) — it never connects/spawns', async () => {
    // No startMcpClient / opener is injected or reachable: the tier is a pure function of the bound agent's
    // declared servers + the manager-skipped tools. A live session means all declared servers are connected.
    const probes = assembleDoctorProbes({
      cwd: '/tmp/x',
      resolver,
      agentMcpServers: [ref('fs'), ref('github')],
      mcpSkipped: [{ server: 'fs', name: 'danger', reason: 'not in allowlist' }],
    });
    const checks = await probes.deepMcp?.();
    expect(checks).toEqual([
      { id: 'mcp:fs', label: 'fs', status: 'ok', detail: 'connected' },
      { id: 'mcp:github', label: 'github', status: 'ok', detail: 'connected' },
      {
        id: 'mcp:skip:fs:danger',
        label: 'fs/danger',
        status: 'warn',
        detail: 'tool skipped — not in allowlist',
      },
    ]);
  });

  it('reports "none configured" when the bound agent declares no MCP servers (the Home default agent)', async () => {
    const probes = assembleDoctorProbes({ cwd: '/tmp/x', resolver });
    expect(await probes.deepMcp?.()).toEqual([
      { id: 'mcp', label: 'MCP servers', status: 'warn', detail: 'none configured' },
    ]);
  });
});
