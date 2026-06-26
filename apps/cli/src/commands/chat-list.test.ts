import { createClient, createSessionStore, runMigrations, type DbClient } from '@relavium/db';
import type { AgentSessionRecord } from '@relavium/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { EXIT_CODES } from '../process/exit-codes.js';
import type { GlobalOptions } from '../process/options.js';
import type { OpenedSessionStore } from '../history/session-open.js';
import { captureIo, parseNdjson } from '../test-support.js';
import { chatListCommand, type ChatListCommandDeps } from './chat-list.js';

function globalOptions(json = false): GlobalOptions {
  return { json, color: false, cwd: process.cwd(), configPath: undefined, verbosity: 'normal' };
}

const CTX = { workingDir: '/workspace', fsScopeTier: 'sandboxed' as const };

function makeSession(overrides: Partial<AgentSessionRecord> = {}): AgentSessionRecord {
  return {
    id: 'sess-1',
    agentSlug: 'chatter',
    context: CTX,
    status: 'active',
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCostMicrocents: 0,
    createdAt: '2026-06-17T08:00:00.000Z',
    updatedAt: '2026-06-17T08:00:00.000Z',
    ...overrides,
  };
}

describe('chatListCommand (2.O)', () => {
  let client: DbClient;
  let opened: OpenedSessionStore;

  beforeEach(() => {
    client = createClient(':memory:');
    runMigrations(client.db);
    opened = { store: createSessionStore(client.db), db: client.db, close: () => {} };
  });
  afterEach(() => {
    client.sqlite.close();
  });

  function deps(io: ReturnType<typeof captureIo>['io'], json = false): ChatListCommandDeps {
    return { io, global: globalOptions(json), openSessionStore: () => opened };
  }

  it('reports an empty history clearly (exit 0)', () => {
    const { io, out } = captureIo();
    expect(chatListCommand(deps(io))).toBe(EXIT_CODES.success);
    expect(out()).toBe('No agent sessions yet.\n');
  });

  it('emits a pure-empty stdout for an empty history under --json (no human chrome leaks)', () => {
    const { io, out } = captureIo();
    expect(chatListCommand(deps(io, true))).toBe(EXIT_CODES.success);
    // The machine contract (ADR-0049): zero sessions ⇒ zero NDJSON lines, never the human "No agent sessions" line.
    expect(out()).toBe('');
  });

  it('lists sessions most-recently-updated first with id, agent, status, and title; closes the store', () => {
    let closed = false;
    opened = { ...opened, close: () => (closed = true) };
    opened.store.createSession(
      makeSession({ id: 'sess-old', updatedAt: '2026-06-17T08:00:00.000Z', title: 'First' }),
    );
    opened.store.createSession(
      makeSession({ id: 'sess-new', updatedAt: '2026-06-17T10:00:00.000Z', agentSlug: 'coder' }),
    );

    const { io, out } = captureIo();
    expect(chatListCommand(deps(io))).toBe(EXIT_CODES.success);
    const text = out();
    expect(text).toContain('Agent sessions (2):');
    // Title-ABSENT line asserted exactly (incl. trailing newline) so a stray title suffix would fail.
    expect(text).toContain('  sess-new  coder  active  2026-06-17T10:00:00.000Z\n');
    expect(text).toContain('  sess-old  chatter  active  2026-06-17T08:00:00.000Z  "First"\n');
    // Most-recent-first ordering: sess-new appears before sess-old.
    expect(text.indexOf('sess-new')).toBeLessThan(text.indexOf('sess-old'));
    // The store is closed on the POPULATED path too (not only the empty path) — no leaked SQLite handle.
    expect(closed).toBe(true);
  });

  it('emits one NDJSON record per session under --json (stdout pure, null-for-absent fields)', () => {
    // No modelId set: model_id FK-references model_catalog, which this in-memory store doesn't seed; the
    // null-for-absent mapping is what `toJson` exercises (the passthrough is a trivial `?? null`).
    opened.store.createSession(makeSession({ id: 'sess-1', title: 'Titled', status: 'ended' }));
    opened.store.createSession(
      makeSession({ id: 'sess-2', updatedAt: '2026-06-17T09:00:00.000Z' }),
    );

    const { io, out } = captureIo();
    expect(chatListCommand(deps(io, true))).toBe(EXIT_CODES.success);
    // Stdout is pure NDJSON: exactly one line per session, no human heading mixed in.
    expect(out().trimEnd().split('\n')).toHaveLength(2);
    expect(out()).not.toContain('Agent sessions');
    const records = parseNdjson(out());
    expect(records).toEqual([
      {
        sessionId: 'sess-2',
        agentSlug: 'chatter',
        title: null,
        status: 'active',
        modelId: null,
        createdAt: '2026-06-17T08:00:00.000Z',
        updatedAt: '2026-06-17T09:00:00.000Z',
        totalCostMicrocents: 0,
      },
      {
        sessionId: 'sess-1',
        agentSlug: 'chatter',
        title: 'Titled',
        status: 'ended',
        modelId: null,
        createdAt: '2026-06-17T08:00:00.000Z',
        updatedAt: '2026-06-17T08:00:00.000Z',
        totalCostMicrocents: 0,
      },
    ]);
  });

  it('closes the opened store even on the empty path', () => {
    let closed = false;
    opened = { ...opened, close: () => (closed = true) };
    const { io } = captureIo();
    chatListCommand(deps(io));
    expect(closed).toBe(true);
  });
});
