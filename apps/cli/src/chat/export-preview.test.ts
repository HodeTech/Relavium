/**
 * `prepareSessionExport` (MVP-11 unit 6, 6.3; ADR-0148 §10, OD-10): what the in-chat `/export` would write, worked out and NOT written, so its
 * popup can show the file before the person confirms it. It is the write's own plan, read: the preview names exactly the file the write then
 * goes to (a new file, or this session's own earlier export rewritten in place), refuses what the write refuses before writing, writes
 * nothing itself, and names the file relative to the project's root wherever the chat was opened. The review notice the plain chat prints is
 * pinned byte for byte, and the popup's sentence is the same words.
 */
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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
import {
  exportedTarget,
  exportSessionToProject,
  prepareSessionExport,
  SESSION_EXPORT_REVIEW_NOTICE,
  SESSION_EXPORT_REVIEW_SENTENCE,
  type ExportToProjectOptions,
} from './export.js';

const ISO = '2026-11-26T00:00:00.000Z';
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

const workflowYaml = (id: string): string => `schema_version: '1.0'
workflow:
  id: ${id}
  nodes:
    - { id: a, type: input }
    - { id: b, type: output }
  edges:
    - { from: a, to: b }
`;

/** Every file and directory under `dir`, recursively and sorted: the whole of "writes nothing". */
function tree(dir: string, prefix = ''): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) =>
      entry.isDirectory()
        ? [`${prefix}${entry.name}/`, ...tree(join(dir, entry.name), `${prefix}${entry.name}/`)]
        : [`${prefix}${entry.name}`],
    )
    .sort();
}

let client: DbClient;
let store: SessionStore;
let cwd: string;
let homeDir: string;
const workflows = (): string => join(cwd, '.relavium', 'workflows');
const options = (sessionId = 's1', at = cwd): ExportToProjectOptions => ({
  store,
  sessionId,
  cwd: at,
  homeDir,
  projectConfigDir: join(cwd, '.relavium'),
});

beforeEach(() => {
  client = createClient(':memory:');
  runMigrations(client.db);
  store = createSessionStore(client.db);
  for (const id of ['s1', 's2']) {
    store.createSession(record(id));
    store.appendMessage(message(id, 0, 'user'));
    store.appendMessage(message(id, 1, 'assistant'));
  }
  cwd = mkdtempSync(join(tmpdir(), 'relavium-export-preview-'));
  homeDir = mkdtempSync(join(tmpdir(), 'relavium-export-preview-home-'));
  mkdirSync(workflows(), { recursive: true });
});
afterEach(() => {
  client.sqlite.close();
  rmSync(cwd, { recursive: true, force: true });
  rmSync(homeDir, { recursive: true, force: true });
});

describe('the preview names the file the write then goes to, and writes nothing', () => {
  it('a first export: a new file under the title’s slug, project-relative', () => {
    const before = tree(cwd);
    expect(prepareSessionExport(options())).toEqual({
      target: '.relavium/workflows/my-session.relavium.yaml',
      workflowId: 'my-session',
      overwrites: false,
    });
    expect(tree(cwd), 'the preview wrote nothing').toEqual(before);
    const written = exportSessionToProject(options());
    expect(exportedTarget(options(), written)).toBe('.relavium/workflows/my-session.relavium.yaml');
  });

  it('a second export of the same session: its own earlier file, rewritten in place', () => {
    exportSessionToProject(options());
    const before = tree(cwd);
    expect(prepareSessionExport(options())).toEqual({
      target: '.relavium/workflows/my-session.relavium.yaml',
      workflowId: 'my-session',
      overwrites: true,
    });
    expect(tree(cwd)).toEqual(before);
  });

  it('never another session’s file or another author’s: the next free id, as the write takes it', () => {
    exportSessionToProject(options('s2'));
    writeFileSync(join(workflows(), 'my-session-2.relavium.yaml'), workflowYaml('my-session-2'));
    const preview = prepareSessionExport(options());
    expect(preview).toEqual({
      target: '.relavium/workflows/my-session-3.relavium.yaml',
      workflowId: 'my-session-3',
      overwrites: false,
    });
    const written = exportSessionToProject(options());
    expect(exportedTarget(options(), written)).toBe(preview.target);
  });

  it.each([
    [
      'a file that is no workflow',
      () => writeFileSync(join(workflows(), 'my-session.relavium.yaml'), 'not a workflow at all\n'),
    ],
    ['a directory', () => mkdirSync(join(workflows(), 'my-session.relavium.yaml'))],
  ] as const)(
    '%s at a candidate’s name is passed over, as the write’s `wx` passes it',
    (_case, occupy) => {
      occupy();
      const preview = prepareSessionExport(options());
      expect(preview.target).toBe('.relavium/workflows/my-session-2.relavium.yaml');
      expect(exportedTarget(options(), exportSessionToProject(options()))).toBe(preview.target);
    },
  );

  it('from a subdirectory of the project the file is still named from the project’s root, never absolute', () => {
    const sub = join(cwd, 'src', 'deep');
    mkdirSync(sub, { recursive: true });
    const preview = prepareSessionExport(options('s1', sub));
    expect(preview.target).toBe('.relavium/workflows/my-session.relavium.yaml');
    const written = exportSessionToProject(options('s1', sub));
    expect(exportedTarget(options('s1', sub), written)).toBe(preview.target);
    expect(preview.target.startsWith('/')).toBe(false);
    expect(preview.target).not.toContain('..');
  });

  it('refuses before writing what the write refuses: an unknown session, in the same words', () => {
    const before = tree(cwd);
    let preview: unknown;
    try {
      prepareSessionExport(options('no-such-session'));
    } catch (cause) {
      preview = cause;
    }
    let write: unknown;
    try {
      exportSessionToProject(options('no-such-session'));
    } catch (cause) {
      write = cause;
    }
    expect(isCliError(preview) && preview.message).toBe(isCliError(write) && write.message);
    expect(tree(cwd)).toEqual(before);
  });
});

describe('the review notice (the plain, --json and one-shot paths print it unchanged)', () => {
  it('is byte for byte what it was', () => {
    expect(SESSION_EXPORT_REVIEW_NOTICE).toBe(
      'note: exported workflow is a scaffold; conversation context is not reproduced. Compaction summaries, trimming and omitted context may not transfer. Review retained user/assistant text, @-attached files, !-shell output and authored agent literals before committing. Historical agent snapshots may require edits to pass current validation before running.\n',
    );
  });

  it('the popup’s sentence is the same words, as a sentence of their own', () => {
    expect(SESSION_EXPORT_REVIEW_SENTENCE).toBe(
      'Exported workflow is a scaffold; conversation context is not reproduced. Compaction summaries, trimming and omitted context may not transfer. Review retained user/assistant text, @-attached files, !-shell output and authored agent literals before committing. Historical agent snapshots may require edits to pass current validation before running.',
    );
  });
});
