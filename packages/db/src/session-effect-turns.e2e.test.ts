import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { createClient, runMigrations } from './client.js';
import { agentSessions } from './schema.js';
import { createSessionStore } from './session-store.js';

const dist = new URL('../dist/index.js', import.meta.url);
const worker = fileURLToPath(new URL('./fixtures/session-key-allocator.mjs', import.meta.url));

/** Coexistence smoke across real SQLite connections/processes; BEGIN IMMEDIATE is the allocation boundary. */
describe('session effect-turn allocation across two real processes', () => {
  it('keeps all issued keys unique and durable while both processes allocate', async () => {
    if (!existsSync(fileURLToPath(dist)))
      throw new Error(
        'Build @relavium/db before running its two-process effect-turn integration test.',
      );
    const root = mkdtempSync(join(tmpdir(), 'relavium-session-key-processes-'));
    const path = join(root, 'history.db');
    const client = createClient(path);
    const children: ReturnType<typeof spawn>[] = [];
    const completions: Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
      out: string;
      err: string;
    }>[] = [];
    try {
      runMigrations(client.db, { dbPath: path });
      const timestamp = '2026-10-02T00:00:00.000Z';
      createSessionStore(client.db).createSession({
        id: 's1',
        agentSlug: 'chatter',
        context: { workingDir: '/workspace', fsScopeTier: 'sandboxed' },
        status: 'active',
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCostMicrocents: 0,
        totalConservativeMicrocents: 0,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      const ready = [];
      for (let i = 0; i < 2; i += 1) {
        const child = spawn(process.execPath, [worker, dist.href, path], {
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        children.push(child);
        let out = '';
        let err = '';
        let announced = false;
        let acceptReady: () => void = () => {};
        let rejectReady: (reason: Error) => void = () => {};
        ready.push(
          new Promise<void>((resolve, reject) => {
            acceptReady = resolve;
            rejectReady = reject;
          }),
        );
        child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
          out += chunk;
          if (!announced && out.startsWith('READY\n')) {
            announced = true;
            acceptReady();
          }
        });
        child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
          err += chunk;
        });
        child.stdin.on('error', (error: Error) => rejectReady(error));
        const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
        completions.push(
          new Promise((resolve, reject) => {
            child.once('error', (error) => {
              clearTimeout(timer);
              rejectReady(error);
              reject(error);
            });
            child.once('close', (code, signal) => {
              clearTimeout(timer);
              if (!announced) rejectReady(new Error(`worker exited before READY: ${err}`));
              resolve({ code, signal, out, err });
            });
          }),
        );
      }
      await Promise.all(ready);
      for (const child of children) child.stdin?.end('GO\n');
      const results = await Promise.all(completions);
      const keys: number[] = [];
      for (const result of results) {
        expect(result.signal, result.err).toBeNull();
        expect(result.code, result.err).toBe(0);
        const values: unknown = JSON.parse(result.out.slice('READY\n'.length));
        if (!Array.isArray(values)) throw new Error('worker did not return keys');
        const parsed: readonly unknown[] = values;
        for (const key of parsed) {
          if (typeof key !== 'number') throw new Error('worker returned a non-number key');
          keys.push(key);
        }
      }
      expect(keys.sort((a, b) => a - b)).toEqual(Array.from({ length: 200 }, (_, i) => i + 1));
      expect(
        client.db
          .select({ key: agentSessions.effectTurnHighWater })
          .from(agentSessions)
          .where(eq(agentSessions.id, 's1'))
          .get()?.key,
      ).toBe(200);
    } finally {
      for (const child of children)
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await Promise.allSettled(completions);
      client.sqlite.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);
});
