import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createClient, createSessionStore, runMigrations, type DbClient } from '@relavium/db';
import { AgentSchema, type AgentSessionRecord, type SessionMessage } from '@relavium/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isCliError } from '../process/errors.js';
import { exportSession } from './export.js';

const ISO = '2026-06-25T00:00:00.000Z';
const CTX = { workingDir: '/workspace', fsScopeTier: 'sandboxed' as const };
const AGENT = AgentSchema.parse({
  id: 'coder',
  model: 'claude-opus-4-8',
  provider: 'anthropic',
  system_prompt: 'You are concise.',
});

function record(overrides: Partial<AgentSessionRecord> = {}): AgentSessionRecord {
  return {
    id: 's1',
    agentSlug: AGENT.id,
    agentSnapshot: AGENT,
    title: 'My Session',
    context: CTX,
    status: 'active',
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCostMicrocents: 0,
    createdAt: ISO,
    updatedAt: ISO,
    ...overrides,
  };
}

const message = (seq: number, role: 'user' | 'assistant', text: string): SessionMessage => ({
  id: `m${seq}`,
  sessionId: 's1',
  sequenceNumber: seq,
  role,
  content: [{ type: 'text', text }],
  timestamp: ISO,
});

describe('exportSession (2.P)', () => {
  let client: DbClient;
  let store: ReturnType<typeof createSessionStore>;
  let cwd: string;

  beforeEach(() => {
    client = createClient(':memory:');
    runMigrations(client.db);
    store = createSessionStore(client.db);
    cwd = mkdtempSync(join(tmpdir(), 'relavium-export-'));
  });
  afterEach(() => {
    client.sqlite.close();
    rmSync(cwd, { recursive: true, force: true });
  });

  function seedOneTurn(): void {
    store.createSession(record());
    store.appendMessage(message(0, 'user', 'hello'));
    store.appendMessage(message(1, 'assistant', 'hi there'));
  }

  it('writes a .relavium.yaml scaffold named from the UNIQUE session id, and returns the path', () => {
    seedOneTurn();
    const result = exportSession({ store, sessionId: 's1', cwd, force: false });

    expect(result.workflowId).toBe('my-session'); // the IN-FILE id is the title-slug (renameable on the canvas)
    expect(result.path).toBe(join(cwd, 's1.relavium.yaml')); // the FILENAME is the collision-free session id
    expect(result.sequenceNumber).toBe(2); // one past the persisted MAX (1)
    expect(existsSync(result.path)).toBe(true);

    const yaml = readFileSync(result.path, 'utf8');
    expect(yaml).toContain('schema_version:');
    expect(yaml).toContain('id: my-session');
    expect(yaml).toContain('type: agent'); // the one completed turn becomes an agent node
    expect(yaml).toContain('relaviumExport'); // the full transcript is preserved in metadata
    expect(yaml).toContain('hello'); // the transcript is in the metadata
  });

  it('keys the default filename on the session id, so same-titled sessions never collide', () => {
    store.createSession(record({ id: 's1', title: 'Same Title' }));
    store.createSession(record({ id: 's2', title: 'Same Title' }));
    const a = exportSession({ store, sessionId: 's1', cwd, force: false });
    const b = exportSession({ store, sessionId: 's2', cwd, force: false });
    expect(a.path).toBe(join(cwd, 's1.relavium.yaml'));
    expect(b.path).toBe(join(cwd, 's2.relavium.yaml'));
    expect(a.path).not.toBe(b.path); // distinct files despite the shared title — no silent clobber
  });

  it('honors --out (relative to cwd) and auto-creates the parent directory', () => {
    seedOneTurn();
    const result = exportSession({
      store,
      sessionId: 's1',
      cwd,
      outPath: 'flows/out.yaml',
      force: false,
    });
    expect(result.path).toBe(join(cwd, 'flows/out.yaml'));
    expect(existsSync(result.path)).toBe(true); // the missing flows/ dir was created (mkdir -p)
  });

  it('writes to an absolute --out path', () => {
    seedOneTurn();
    const out = join(cwd, 'explicit.relavium.yaml');
    const result = exportSession({ store, sessionId: 's1', cwd, outPath: out, force: false });
    expect(result.path).toBe(out);
    expect(existsSync(out)).toBe(true);
  });

  it('refuses to overwrite an existing file without force (exit-2 fault)', () => {
    seedOneTurn();
    const path = join(cwd, 's1.relavium.yaml');
    writeFileSync(path, 'pre-existing', 'utf8');
    expect(() => exportSession({ store, sessionId: 's1', cwd, force: false })).toThrow(
      /already exists — pass --force/,
    );
    expect(readFileSync(path, 'utf8')).toBe('pre-existing'); // untouched
  });

  it('overwrites an existing file with force', () => {
    seedOneTurn();
    const path = join(cwd, 's1.relavium.yaml');
    writeFileSync(path, 'pre-existing', 'utf8');
    exportSession({ store, sessionId: 's1', cwd, force: true });
    expect(readFileSync(path, 'utf8')).toContain('schema_version:'); // replaced with the scaffold
  });

  it('rejects an unknown sessionId as a clean exit-2 invocation fault', () => {
    expect(() => exportSession({ store, sessionId: 'ghost', cwd, force: false })).toThrow(
      /no session found with id ghost/,
    );
  });

  it('remaps a directory target (EISDIR under --force) to a clean exit-2 fault, not a raw crash', () => {
    seedOneTurn();
    mkdirSync(join(cwd, 's1.relavium.yaml')); // occupy the default path with a DIRECTORY
    let thrown: unknown;
    try {
      exportSession({ store, sessionId: 's1', cwd, force: true });
    } catch (err) {
      thrown = err;
    }
    expect(isCliError(thrown)).toBe(true); // a typed invocation fault (exit 2), not a raw EISDIR (exit 1)
    expect(isCliError(thrown) && thrown.message).toMatch(/not a file/);
  });

  it('remaps a file-as-path-component target (ENOTDIR under --out) to a clean exit-2 fault, not a raw crash', () => {
    seedOneTurn();
    writeFileSync(join(cwd, 'conflict'), 'x', 'utf8'); // a regular FILE used as a NON-terminal path component
    let thrown: unknown;
    try {
      // mkdirSync(dirname(path)) on `<cwd>/conflict/deeper` must traverse THROUGH the file `conflict` ⇒ ENOTDIR
      // (a file as the terminal component would be EEXIST instead — the middle component is what forces ENOTDIR).
      exportSession({
        store,
        sessionId: 's1',
        cwd,
        outPath: 'conflict/deeper/sub.yaml',
        force: true,
      });
    } catch (err) {
      thrown = err;
    }
    expect(isCliError(thrown)).toBe(true); // the sibling ENOTDIR arm maps to exit 2, like EISDIR
    expect(isCliError(thrown) && thrown.message).toMatch(/not a file/);
  });

  it('exports a session with no completed turns as a minimal input→output scaffold', () => {
    store.createSession(record({ id: 's1', title: 'Empty' }));
    const result = exportSession({ store, sessionId: 's1', cwd, force: false });
    expect(result.sequenceNumber).toBe(0); // empty transcript ⇒ next seq 0
    const yaml = readFileSync(result.path, 'utf8');
    expect(yaml).toContain('type: input');
    expect(yaml).toContain('type: output');
    expect(yaml).not.toContain('type: agent'); // no completed turn ⇒ no agent node
  });
});
