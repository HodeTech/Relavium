import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AgentSessionRecord, SessionMessage } from '@relavium/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { globalConfigDir } from '../config/paths.js';
import { openSessionStore } from './session-open.js';

/**
 * 2.M end-to-end: {@link openSessionStore} opens the durable session store over a real `history.db` under a
 * TEMP home (never the user's `~/.relavium/`), persists a session + a transcript message, and a FRESH
 * connection reads them back — the substrate `relavium chat-resume` (2.N) consumes. Also asserts the ADR-0050
 * unencrypted-at-rest posture is the same `0600`/`0700`-guarded file as run history (one db, no `sessions.db`).
 */

const ISO = '2026-06-25T12:00:00.000Z';

function makeSession(id: string): AgentSessionRecord {
  return {
    id,
    agentSlug: 'relavium-chat',
    context: { workingDir: '/workspace', fsScopeTier: 'sandboxed' },
    status: 'active',
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCostMicrocents: 0,
    createdAt: ISO,
    updatedAt: ISO,
  };
}

function makeMessage(
  sessionId: string,
  seq: number,
  role: 'user' | 'assistant',
  text: string,
): SessionMessage {
  return {
    id: `${sessionId}-m${seq}`,
    sessionId,
    sequenceNumber: seq,
    role,
    content: [{ type: 'text', text }],
    timestamp: ISO,
  };
}

describe('openSessionStore (2.M)', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'relavium-session-open-'));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('persists a session + transcript that a fresh connection reads back over the shared history.db', () => {
    const first = openSessionStore(home);
    try {
      first.store.createSession(makeSession('sess-e2e'));
      first.store.appendMessage(makeMessage('sess-e2e', 0, 'user', 'hello'));
      first.store.appendMessage(makeMessage('sess-e2e', 1, 'assistant', 'hi there'));
    } finally {
      first.close();
    }

    // A SEPARATE connection (the resume path's "new process") sees the durable rows.
    const second = openSessionStore(home);
    try {
      const full = second.store.loadFull('sess-e2e');
      expect(full?.session.agentSlug).toBe('relavium-chat');
      expect(full?.messages.map((m) => m.sequenceNumber)).toEqual([0, 1]);
      expect(full?.messages[1]?.role).toBe('assistant');
    } finally {
      second.close();
    }
  });

  it('writes the one history.db under the temp home with ADR-0050 0600/0700 permissions', () => {
    const opened = openSessionStore(home);
    try {
      opened.store.createSession(makeSession('sess-perms'));
      const dbPath = join(globalConfigDir(home), 'history.db');
      // ADR-0050: unencrypted at rest, guarded by OS file permissions — the file is 0600, its dir 0700.
      expect(statSync(dbPath).mode & 0o777).toBe(0o600);
      expect(statSync(globalConfigDir(home)).mode & 0o777).toBe(0o700);
    } finally {
      opened.close();
    }
  });
});
