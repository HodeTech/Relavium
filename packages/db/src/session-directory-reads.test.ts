import type { AgentSessionRecord } from '@relavium/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createClient, runMigrations, type DbClient } from './client.js';
import { SessionDiscoveryBoundaryError } from './session-discovery.js';
import { createSessionStore, type SessionStore } from './session-store.js';

/**
 * The sessions of ONE directory (MVP-11 unit 7: the Home reads this directory and says its true totals): the bounded
 * recency list filtered by `working_dir` and the read-only count of the same set, soft-deleted sessions excluded. The
 * directory is the one `/resume` calls "this directory" (`listSessionPage({ workingDir })`).
 */

const HERE = '/work/here';
const T0 = Date.parse('2026-11-20T10:00:00.000Z');
const ISO = (ms: number): string => new Date(ms).toISOString();

const session = (
  id: string,
  workingDir: string,
  updatedAtMs: number,
  overrides: Partial<AgentSessionRecord> = {},
): AgentSessionRecord => ({
  id,
  agentSlug: 'chatter',
  context: { workingDir, fsScopeTier: 'sandboxed' },
  status: 'active',
  totalInputTokens: 0,
  totalOutputTokens: 0,
  totalCostMicrocents: 0,
  totalConservativeMicrocents: 0,
  createdAt: ISO(T0),
  updatedAt: ISO(updatedAtMs),
  ...overrides,
});

describe('the sessions of one directory: listSessions({ workingDir }) and countSessions', () => {
  let client: DbClient;
  let store: SessionStore;

  beforeEach(() => {
    client = createClient(':memory:');
    runMigrations(client.db);
    store = createSessionStore(client.db);
    store.createSession(session('here-old', HERE, T0 + 1));
    store.createSession(session('here-new', HERE, T0 + 5));
    store.createSession(session('here-tie-a', HERE, T0 + 3));
    store.createSession(session('here-tie-b', HERE, T0 + 3));
    store.createSession(session('here-gone', HERE, T0 + 9, { deletedAt: ISO(T0 + 10) }));
    store.createSession(session('elsewhere', '/work/elsewhere', T0 + 7));
    store.createSession(session('below', `${HERE}/sub`, T0 + 8));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    client.sqlite.close();
  });

  it('lists only this directory’s sessions, newest first with the id tiebreak, bounded by the limit', () => {
    expect(store.listSessions({ workingDir: HERE }).map((s) => s.id)).toEqual([
      'here-new',
      'here-tie-b',
      'here-tie-a',
      'here-old',
    ]);
    expect(store.listSessions({ workingDir: HERE, limit: 2 }).map((s) => s.id)).toEqual([
      'here-new',
      'here-tie-b',
    ]);
    // The unfiltered list is what it was: every directory.
    expect(store.listSessions().map((s) => s.id)).toContain('elsewhere');
    expect(store.listSessions({ workingDir: '/work/none' })).toEqual([]);
  });

  it('counts exactly the sessions the unbounded list holds, soft-deleted excluded, another directory never', () => {
    expect(store.countSessions({ workingDir: HERE })).toBe(4);
    expect(store.countSessions({ workingDir: HERE })).toBe(
      store.listSessions({ workingDir: HERE }).length,
    );
    expect(store.countSessions({ workingDir: '/work/elsewhere' })).toBe(1);
    expect(store.countSessions({ workingDir: '/work/none' })).toBe(0);
  });

  it('refuses a directory that is not a non-empty string on both reads, never reading it as every directory', () => {
    for (const workingDir of ['', 42, null]) {
      // A caller in plain JavaScript can pass anything: each read refuses it rather than read every directory.
      for (const read of [
        (): unknown => Reflect.apply(store.countSessions, undefined, [{ workingDir }]),
        (): unknown => Reflect.apply(store.listSessions, undefined, [{ workingDir, limit: 3 }]),
      ]) {
        let refusal: unknown;
        try {
          read();
        } catch (error) {
          refusal = error;
        }
        expect(refusal, String(workingDir)).toBeInstanceOf(SessionDiscoveryBoundaryError);
      }
    }
    // A count needs a directory: an absent one is refused too. And a list handed the key with no value is refused, never unscoped.
    expect((): unknown => Reflect.apply(store.countSessions, undefined, [{}])).toThrow(
      SessionDiscoveryBoundaryError,
    );
    expect((): unknown =>
      Reflect.apply(store.listSessions, undefined, [{ workingDir: undefined, limit: 3 }]),
    ).toThrow(SessionDiscoveryBoundaryError);
  });

  it('binds the directory, never interpolating it, and the count is one statement that reads no transcript', () => {
    const hostile = `/work/it's"; DROP TABLE agent_sessions; --`;
    store.createSession(session('quoted', hostile, T0));
    const spy = vi.spyOn(client.sqlite, 'prepare');
    let counted: number;
    let listed: readonly AgentSessionRecord[];
    let statements: string[];
    try {
      counted = store.countSessions({ workingDir: hostile });
      listed = store.listSessions({ workingDir: hostile, limit: 5 });
      statements = spy.mock.calls.map(([source]) => source);
    } finally {
      spy.mockRestore();
    }
    expect(counted).toBe(1);
    expect(listed.map((s) => s.id)).toEqual(['quoted']);
    expect(statements).toHaveLength(2);
    for (const statement of statements) {
      expect(statement).not.toContain(hostile);
      expect(statement).not.toContain('DROP');
      expect(statement).not.toContain('session_messages');
    }
  });
});
