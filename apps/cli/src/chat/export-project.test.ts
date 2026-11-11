import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createClient,
  createSessionStore,
  runMigrations,
  type DbClient,
  type SessionStore,
} from '@relavium/db';
import { MAX_SOURCE_CHARS, readSessionExportMarker } from '@relavium/core';
import { AgentSchema, type AgentSessionRecord, type SessionMessage } from '@relavium/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { isCliError } from '../process/errors.js';
import { exportSessionToProject } from './export.js';

/** A hook on the temp file's creation: the moment between recognizing the own export and replacing it. */
const fsHooks = vi.hoisted(() => ({ onOpen: undefined as ((path: string) => void) | undefined }));
vi.mock('node:fs', async (original) => {
  const native = await original<typeof import('node:fs')>();
  return {
    ...native,
    openSync: (...args: Parameters<typeof native.openSync>) => {
      const [path] = args;
      if (typeof path === 'string') fsHooks.onOpen?.(path);
      return native.openSync(...args);
    },
  };
});

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

  it('leaves a workflow put at its export’s name after the check, and takes the next free id', () => {
    // Recognizing the file as this session's export and renaming over it are separate steps, and serializing a
    // long transcript in between takes long enough for an editor, a checkout or another process to put a
    // different workflow there. The rewrite re-checks the file first and leaves a changed one alone.
    const first = exportS1();
    fsHooks.onOpen = (path) => {
      if (!path.endsWith('.tmp')) return;
      fsHooks.onOpen = undefined;
      rmSync(first.path);
      writeFileSync(first.path, workflowYaml('hand-authored'));
    };
    try {
      const second = exportS1();
      expect(readFileSync(first.path, 'utf8')).toBe(workflowYaml('hand-authored'));
      expect(second.path).toBe(file('my-session-2'));
      expect(idIn(second.path)?.[1]).toBe('my-session-2');
      expect(readdirSync(workflows()).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    } finally {
      fsHooks.onOpen = undefined;
    }
  });

  it('rewrites this session’s own earlier export in place — recognized from the file, not from memory', () => {
    const first = exportS1();
    // A new REPL (a `/models` reseat, a `chat-resume`) holds no record of the first export; the file names s1.
    const again = exportS1();
    expect(again.path).toBe(first.path);
    expect(again.workflowId).toBe('my-session');
    expect(readdirSync(workflows()).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    // Another session's export is not s1's: s2 takes the next id and s1's file is untouched.
    const other = exportSessionToProject({
      store,
      sessionId: 's2',
      cwd,
      projectConfigDir: join(cwd, '.relavium'),
    });
    expect(other.workflowId).toBe('my-session-2');
    expect(readSessionExportMarker(readFileSync(first.path, 'utf8'))).toBe('s1');
  });

  it('skips a file the catalog scan did not see, because the write refuses an existing target', () => {
    // With no project config there is no catalog to consult; the `wx` create is what keeps the file.
    mkdirSync(workflows(), { recursive: true });
    writeFileSync(file('my-session'), workflowYaml('someone-else'));
    const result = exportSessionToProject({
      store,
      sessionId: 's1',
      cwd,
      projectConfigDir: undefined,
    });
    expect(result.workflowId).toBe('my-session-2');
    expect(readFileSync(file('my-session'), 'utf8')).toBe(workflowYaml('someone-else'));
  });

  it('treats an agent id, a differently-cased file name and a Windows device name as taken', () => {
    mkdirSync(join(cwd, '.relavium', 'agents'), { recursive: true });
    writeFileSync(
      join(cwd, '.relavium', 'agents', 'my-session.agent.yaml'),
      'id: my-session\nmodel: claude-sonnet-4-6\nprovider: anthropic\nsystem_prompt: x\n',
    );
    mkdirSync(workflows(), { recursive: true });
    writeFileSync(join(workflows(), 'My-Session-2.yaml'), workflowYaml('deploy-prod'));
    expect(exportS1().workflowId).toBe('my-session-3');

    store.createSession({ ...record('s3'), title: 'aux' });
    store.appendMessage(message('s3', 0, 'user'));
    expect(
      exportSessionToProject({
        store,
        sessionId: 's3',
        cwd,
        projectConfigDir: join(cwd, '.relavium'),
      }).workflowId,
    ).toBe('aux-2');
  });

  it('never overwrites a workflow that now sits where its earlier export was', () => {
    const first = exportS1();
    // The scaffold is renamed away and a hand-authored workflow takes the freed name.
    rmSync(first.path);
    writeFileSync(first.path, workflowYaml('my-session'));
    const again = exportS1();
    expect(again.workflowId).toBe('my-session-2');
    expect(readFileSync(first.path, 'utf8')).toBe(workflowYaml('my-session'));
  });

  it('finds its own export at whatever id the search gave it, even once a lower id is free again', () => {
    mkdirSync(workflows(), { recursive: true });
    writeFileSync(file('my-session'), workflowYaml('my-session'));
    expect(exportS1().workflowId).toBe('my-session-2');
    rmSync(file('my-session'));
    expect(exportS1().workflowId).toBe('my-session-2');
    expect(existsSync(file('my-session'))).toBe(false);
  });

  it.skipIf(process.platform === 'win32')(
    'refuses a workflows directory that resolves outside the project, even for its own export',
    () => {
      const first = exportS1();
      const outside = join(cwd, 'outside-workflows');
      renameSync(workflows(), outside);
      symlinkSync(outside, workflows());
      const before = readFileSync(join(outside, 'my-session.relavium.yaml'), 'utf8');
      store.appendMessage(message('s1', 2, 'user')); // a rewrite would now change the file
      let caught: unknown;
      try {
        exportS1();
      } catch (error) {
        caught = error;
      }
      if (!isCliError(caught)) throw new Error('expected a CliError');
      expect(caught.code).toBe('invalid_invocation');
      expect(readFileSync(join(outside, 'my-session.relavium.yaml'), 'utf8')).toBe(before);
      expect(first.workflowId).toBe('my-session');
    },
  );

  it.skipIf(process.platform === 'win32')(
    'never follows or replaces a link planted at its export’s name',
    () => {
      const first = exportS1();
      const outside = join(cwd, 'outside.relavium.yaml');
      renameSync(first.path, outside);
      symlinkSync(outside, first.path);
      const again = exportS1();
      expect(again.workflowId).toBe('my-session-2');
      expect(lstatSync(first.path).isSymbolicLink()).toBe(true);
      expect(readSessionExportMarker(readFileSync(outside, 'utf8'))).toBe('s1');
    },
  );

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
    // `.relavium` is a file: the actual catalog target is unresolved and refuses
    // before history access or attempting any candidate write (MVP-2 step 3).
    writeFileSync(join(cwd, '.relavium'), '');
    expect(refusal()).toContain('project artifact target could not be resolved safely');
    // `.relavium/workflows` is a file: the final candidate likewise refuses
    // before mkdir, instead of treating ENOTDIR as an ordinary name collision.
    rmSync(join(cwd, '.relavium'));
    mkdirSync(join(cwd, '.relavium'));
    writeFileSync(workflows(), '');
    expect(refusal()).toContain('project artifact target could not be resolved safely');
  });

  it.skipIf(process.platform === 'win32')(
    'keeps the permission bits of its own earlier export across the rewrite',
    () => {
      const first = exportS1();
      chmodSync(first.path, 0o600); // narrowed by the user: its transcript may be sensitive
      expect(exportS1().path).toBe(first.path);
      expect(statSync(first.path).mode & 0o777).toBe(0o600);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'rewrites its own export by replacing the file, never by writing into the old one',
    () => {
      // A write into the old file keeps its inode, and a crash part-way through it leaves a truncated export that
      // the next /export can no longer recognize. The rename puts a complete new file in its place.
      const first = exportS1();
      const before = statSync(first.path, { bigint: true }).ino;
      expect(exportS1().path).toBe(first.path);
      expect(statSync(first.path, { bigint: true }).ino).not.toBe(before);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'a dangling link where the workflows directory belongs is an invocation refusal, not an internal fault',
    () => {
      mkdirSync(join(cwd, '.relavium'));
      symlinkSync(join(cwd, 'nowhere'), workflows());
      let caught: unknown;
      try {
        exportS1();
      } catch (error) {
        caught = error;
      }
      if (!isCliError(caught)) throw new Error('expected a CliError');
      expect(caught.code).toBe('invalid_invocation');
      expect(caught.message).toContain('project artifact target could not be resolved safely');
    },
  );

  it('does not take as its own an export larger than the workflow parser accepts', () => {
    const first = exportS1();
    // Past the parser's character bound the file could not be run, and decoding it would cost seconds.
    writeFileSync(
      first.path,
      `${readFileSync(first.path, 'utf8')}\n# ${'x'.repeat(MAX_SOURCE_CHARS)}\n`,
    );
    expect(exportS1().workflowId).toBe('my-session-2');
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
