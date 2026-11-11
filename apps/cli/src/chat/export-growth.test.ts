import { appendFileSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MAX_SOURCE_CHARS, readSessionExportMarker } from '@relavium/core';
import { createClient, createSessionStore, runMigrations, type DbClient } from '@relavium/db';
import { AgentSchema } from '@relavium/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { exportSessionToProject } from './export.js';

const hooks = vi.hoisted(() => ({
  path: '',
  fd: -1,
  afterStat: undefined as (() => void) | undefined,
  bytesRead: 0,
}));
vi.mock('node:fs', async (original) => {
  const native = await original<typeof import('node:fs')>();
  return {
    ...native,
    openSync: (...args: Parameters<typeof native.openSync>) => {
      const fd = native.openSync(...args);
      if (args[0] === hooks.path) hooks.fd = fd;
      return fd;
    },
    fstatSync: (...args: Parameters<typeof native.fstatSync>) => {
      const stats = native.fstatSync(...args);
      // Return the real admitted stat, then grow that same real file before
      // ownExport gets the snapshot back. No timer or authored-source mutation.
      if (args[0] === hooks.fd) hooks.afterStat?.();
      return stats;
    },
    readFileSync: (...args: Parameters<typeof native.readFileSync>) => {
      const bytes = native.readFileSync(...args);
      if (args[0] === hooks.fd)
        hooks.bytesRead += typeof bytes === 'string' ? Buffer.byteLength(bytes) : bytes.length;
      return bytes;
    },
    readSync: (...args: Parameters<typeof native.readSync>) => {
      const count = native.readSync(...args);
      if (args[0] === hooks.fd) hooks.bytesRead += count;
      return count;
    },
  };
});

describe('own-export descriptor growth', () => {
  let client: DbClient;
  let store: ReturnType<typeof createSessionStore>;
  let cwd: string;
  const maxBytes = MAX_SOURCE_CHARS * 4;
  const exportSession = () =>
    exportSessionToProject({ store, sessionId: 's1', cwd, projectConfigDir: undefined });

  beforeEach(() => {
    hooks.path = '';
    hooks.fd = -1;
    hooks.afterStat = undefined;
    hooks.bytesRead = 0;
    cwd = mkdtempSync(join(tmpdir(), 'relavium-export-growth-'));
    client = createClient(':memory:');
    runMigrations(client.db);
    store = createSessionStore(client.db);
    const agent = AgentSchema.parse({
      id: 'coder',
      model: 'claude-sonnet-4-6',
      provider: 'anthropic',
      system_prompt: 'Be concise.',
    });
    store.createSession({
      id: 's1',
      agentSlug: agent.id,
      agentSnapshot: agent,
      title: 'My Session',
      context: { workingDir: cwd, fsScopeTier: 'sandboxed' },
      status: 'active',
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCostMicrocents: 0,
      totalConservativeMicrocents: 0,
      createdAt: '2026-11-11T00:00:00.000Z',
      updatedAt: '2026-11-11T00:00:00.000Z',
    });
  });
  afterEach(() => {
    hooks.afterStat = undefined;
    hooks.path = '';
    hooks.fd = -1;
    client.sqlite.close();
    rmSync(cwd, { recursive: true, force: true });
  });

  it('reads at most the existing byte ceiling plus one when an admitted file grows after fstat', () => {
    const first = exportSession();
    const original = readFileSync(first.path);
    hooks.path = first.path;
    const growth = Buffer.alloc(maxBytes + 1024, 0x78);
    let grew = false;
    hooks.afterStat = () => {
      hooks.afterStat = undefined;
      appendFileSync(first.path, growth);
      grew = true;
    };

    const next = exportSession();
    expect(grew).toBe(true);
    expect(next.workflowId).toBe('my-session-2');
    expect(next.path).not.toBe(first.path);
    expect(hooks.bytesRead).toBe(maxBytes + 1);
    // The rejected candidate retains the actual concurrently appended content.
    expect(statSync(first.path).size).toBe(original.length + growth.length);
    expect(readFileSync(first.path).equals(Buffer.concat([original, growth]))).toBe(true);
    expect(readSessionExportMarker(readFileSync(next.path, 'utf8'))).toBe('s1');
  });
});
