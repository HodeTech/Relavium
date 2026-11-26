/**
 * The in-chat `/export` preview skips the ids Windows reserves for a device exactly as the write does (MVP-11 unit 6, round 1: test gap Q02). A session
 * titled `aux` has `aux` as the first id to try; no file can be named after it on Windows, so the write goes to `aux-2`, and the preview, which is the
 * write's own plan read, must name that same file: a preview that named `aux.relavium.yaml` would ask the person to confirm a file the write never makes.
 * Every platform decides it the same way (the rule is the name, not the file system).
 */
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createClient,
  createSessionStore,
  runMigrations,
  type DbClient,
  type SessionStore,
} from '@relavium/db';
import { AgentSchema, type AgentSessionRecord, type SessionMessage } from '@relavium/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { exportSessionToProject, prepareSessionExport } from './export.js';

const ISO = '2026-11-26T00:00:00.000Z';
const AGENT = AgentSchema.parse({
  id: 'coder',
  model: 'claude-sonnet-4-6',
  provider: 'anthropic',
  system_prompt: 'You are concise.',
});

const record = (id: string, title: string): AgentSessionRecord => ({
  id,
  agentSlug: AGENT.id,
  agentSnapshot: AGENT,
  title,
  context: { workingDir: '/workspace', fsScopeTier: 'sandboxed' },
  status: 'active',
  totalInputTokens: 0,
  totalOutputTokens: 0,
  totalCostMicrocents: 0,
  totalConservativeMicrocents: 0,
  createdAt: ISO,
  updatedAt: ISO,
});

const message = (sessionId: string, seq: number, role: 'user' | 'assistant'): SessionMessage => ({
  id: `${sessionId}-m${String(seq)}`,
  sessionId,
  sequenceNumber: seq,
  role,
  content: [{ type: 'text', text: role === 'user' ? 'hello' : 'hi there' }],
  timestamp: ISO,
});

let client: DbClient;
let store: SessionStore;
let cwd: string;
let homeDir: string;
beforeEach(() => {
  client = createClient(':memory:');
  runMigrations(client.db);
  store = createSessionStore(client.db);
  cwd = mkdtempSync(join(tmpdir(), 'relavium-export-device-'));
  homeDir = mkdtempSync(join(tmpdir(), 'relavium-export-device-home-'));
  mkdirSync(join(cwd, '.relavium', 'workflows'), { recursive: true });
});
afterEach(() => {
  client.sqlite.close();
  rmSync(cwd, { recursive: true, force: true });
  rmSync(homeDir, { recursive: true, force: true });
});

const options = (sessionId: string) => ({
  store,
  sessionId,
  cwd,
  homeDir,
  projectConfigDir: join(cwd, '.relavium'),
});

describe('the preview skips a reserved device name as the write does', () => {
  it.each(['con', 'prn', 'aux', 'nul', 'com1', 'lpt9'])(
    'a session titled %s: the preview names %s-2, writes nothing, and the write goes to that very file',
    (name) => {
      store.createSession(record('s1', name));
      store.appendMessage(message('s1', 0, 'user'));
      store.appendMessage(message('s1', 1, 'assistant'));
      const preview = prepareSessionExport(options('s1'));
      expect(preview).toEqual({
        target: `.relavium/workflows/${name}-2.relavium.yaml`,
        workflowId: `${name}-2`,
        overwrites: false,
      });
      expect(readdirSync(join(cwd, '.relavium', 'workflows')), 'the preview wrote nothing').toEqual(
        [],
      );
      expect(exportSessionToProject(options('s1')).workflowId).toBe(preview.workflowId);
    },
  );

  it('a name that only contains one is no device name', () => {
    store.createSession(record('s2', 'console'));
    store.appendMessage(message('s2', 0, 'user'));
    expect(prepareSessionExport(options('s2')).workflowId).toBe('console');
  });
});
