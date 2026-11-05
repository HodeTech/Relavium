import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

import { isCliError } from '../process/errors.js';
import { exportSessionToProject } from './export.js';

const ISO = '2026-11-05T00:00:00.000Z';
const AGENT = AgentSchema.parse({
  id: 'coder',
  model: 'claude-sonnet-4-6',
  provider: 'anthropic',
  system_prompt: 'You are concise.',
});

const record = (id: string): AgentSessionRecord => ({
  id,
  agentSlug: AGENT.id,
  agentSnapshot: AGENT,
  title: 'My Session',
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

/** A valid workflow whose `workflow.id` is `id` — what another author's file in the catalog looks like. */
const workflowYaml = (id: string): string => `schema_version: '1.0'
workflow:
  id: ${id}
  nodes:
    - { id: a, type: input }
    - { id: b, type: output }
  edges:
    - { from: a, to: b }
`;

describe('exportSessionToProject (MVP-A3)', () => {
  let client: DbClient;
  let store: SessionStore;
  let cwd: string;
  const workflows = (): string => join(cwd, '.relavium', 'workflows');
  const file = (id: string): string => join(workflows(), `${id}.relavium.yaml`);
  const idIn = (path: string): RegExpMatchArray | null =>
    readFileSync(path, 'utf8').match(/^ {2}id: (\S+)$/mu); // `workflow.id`: the one id at that depth

  beforeEach(() => {
    client = createClient(':memory:');
    runMigrations(client.db);
    store = createSessionStore(client.db);
    for (const id of ['s1', 's2']) {
      store.createSession(record(id));
      store.appendMessage(message(id, 0, 'user'));
      store.appendMessage(message(id, 1, 'assistant'));
    }
    cwd = mkdtempSync(join(tmpdir(), 'relavium-export-project-'));
  });
  afterEach(() => {
    client.sqlite.close();
    rmSync(cwd, { recursive: true, force: true });
  });

  const exportS1 = (projectConfigDir: string | undefined = join(cwd, '.relavium')) =>
    exportSessionToProject({ store, sessionId: 's1', cwd, projectConfigDir });

  it('writes into .relavium/workflows/ under the title slug, never a UUID file in the cwd', () => {
    const result = exportSessionToProject({
      store,
      sessionId: 's1',
      cwd,
      projectConfigDir: undefined,
    });
    expect(result.path).toBe(file('my-session'));
    expect(result.workflowId).toBe('my-session');
    expect(idIn(result.path)?.[1]).toBe('my-session');
    expect(existsSync(join(cwd, 's1.relavium.yaml'))).toBe(false);
  });

  it('never overwrites another workflow: the next free id, written into the file too', () => {
    mkdirSync(workflows(), { recursive: true });
    writeFileSync(file('my-session'), workflowYaml('my-session'));
    const result = exportS1();
    expect(result.workflowId).toBe('my-session-2');
    expect(result.path).toBe(file('my-session-2'));
    expect(idIn(result.path)?.[1]).toBe('my-session-2');
    expect(readFileSync(file('my-session'), 'utf8')).toBe(workflowYaml('my-session'));
  });

  it('treats a file stem and a differently named file’s workflow.id as taken', () => {
    mkdirSync(workflows(), { recursive: true });
    // `relavium run my-session` would resolve `my-session.relavium.yaml` before `my-session.yaml`: shadowing.
    writeFileSync(join(workflows(), 'my-session.yaml'), workflowYaml('something-else'));
    expect(exportS1().workflowId).toBe('my-session-2');
    // …and an id already claimed inside another file is not reused either.
    writeFileSync(join(workflows(), 'other.relavium.yaml'), workflowYaml('my-session-3'));
    expect(
      exportSessionToProject({
        store,
        sessionId: 's2',
        cwd,
        projectConfigDir: join(cwd, '.relavium'),
      }).workflowId,
    ).toBe('my-session-4');
  });

  it('rewrites this session’s own earlier export in place, and only this session’s', () => {
    const first = exportS1();
    writeFileSync(first.path, 'edited by hand');
    const again = exportSessionToProject({
      store,
      sessionId: 's1',
      cwd,
      projectConfigDir: join(cwd, '.relavium'),
      previous: first,
    });
    expect(again.path).toBe(first.path);
    expect(idIn(again.path)?.[1]).toBe('my-session');
    // Another session handed s1's result does not get to overwrite it.
    const other = exportSessionToProject({
      store,
      sessionId: 's2',
      cwd,
      projectConfigDir: join(cwd, '.relavium'),
      previous: first,
    });
    expect(other.workflowId).toBe('my-session-2');
    expect(idIn(first.path)?.[1]).toBe('my-session');
  });

  it('a parent that is not a directory is one invocation refusal, not a walk through every id', () => {
    const refusal = (): string => {
      let caught: unknown;
      try {
        exportSessionToProject({ store, sessionId: 's1', cwd, projectConfigDir: undefined });
      } catch (error) {
        caught = error;
      }
      if (!isCliError(caught)) throw new Error('expected a CliError');
      expect(caught.code).toBe('invalid_invocation');
      return caught.message;
    };
    // `.relavium` is a file: the mkdir fails ENOTDIR.
    writeFileSync(join(cwd, '.relavium'), '');
    expect(refusal()).toContain('a parent of the target path is not a directory');
    // `.relavium/workflows` is a file: the mkdir fails EEXIST — the code a target collision also uses, which is
    // why the mkdir has its own catch.
    rmSync(join(cwd, '.relavium'));
    mkdirSync(join(cwd, '.relavium'));
    writeFileSync(workflows(), '');
    expect(refusal()).toContain('a parent of the target path is not a directory');
  });

  it('refuses once every candidate id is taken, naming the escape hatch', () => {
    mkdirSync(workflows(), { recursive: true });
    for (let n = 1; n <= 100; n += 1) {
      writeFileSync(file(n === 1 ? 'my-session' : `my-session-${String(n)}`), '');
    }
    let caught: unknown;
    try {
      exportS1();
    } catch (error) {
      caught = error;
    }
    if (!isCliError(caught)) throw new Error('expected a CliError');
    expect(caught.code).toBe('invalid_invocation');
    expect(caught.message).toContain("no free workflow id near 'my-session'");
    expect(caught.message).toContain('relavium chat-export <sessionId> --out <path>');
  });
});
