/**
 * The in-chat `/export` project write is held to the directory the confinement computed (the second security sitting on PR #102,
 * finding 1(c)). It used to name `.relavium/workflows` by the project's spelling at every step after the catalog scan had confined it, so
 * a directory swapped for a link in between sent the scaffold, or its temporary, out of the project. Now every file operation names the
 * canonical directory and a guard refuses the write once that directory stops resolving to itself. As for `writeAuthoredFile`, that
 * narrows a swap's window and does not close it (Node has no `openat`/`renameat`); the cases below assert what the guard DOES catch,
 * made deterministic by wrapping the calls the write makes.
 *
 * The same file holds the group a rewrite keeps (finding 5): a re-export of the session's own file carries the old file's group, or else
 * keeps only the owner's bits.
 */
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
} from 'node:fs';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createClient, createSessionStore, runMigrations, type DbClient } from '@relavium/db';
import { AgentSchema, type AgentSessionRecord, type SessionMessage } from '@relavium/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { isCliError } from '../process/errors.js';
import { exportSessionToProject } from './export.js';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    accessSync: vi.fn(actual.accessSync),
    mkdirSync: vi.fn(actual.mkdirSync),
  };
});
const realFs = await vi.importActual<typeof import('node:fs')>('node:fs');

const CHANGED =
  'The target directory was changed by something else while the file was being written, so nothing was written. Retry.';
const ISO = '2026-06-25T00:00:00.000Z';
const AGENT = AgentSchema.parse({
  id: 'coder',
  model: 'claude-opus-4-8',
  provider: 'anthropic',
  system_prompt: 'You are concise.',
});

let client: DbClient;
let store: ReturnType<typeof createSessionStore>;
let cwd = '';
let homeDir = '';
let outside = '';
let linked = false;

beforeEach(() => {
  for (const spy of [fs.accessSync, fs.mkdirSync]) vi.mocked(spy).mockReset();
  linked = false;
  client = createClient(':memory:');
  runMigrations(client.db);
  store = createSessionStore(client.db);
  const record: AgentSessionRecord = {
    id: 's1',
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
  };
  store.createSession(record);
  const message = (seq: number, role: 'user' | 'assistant', text: string): SessionMessage => ({
    id: `m${seq}`,
    sessionId: 's1',
    sequenceNumber: seq,
    role,
    content: [{ type: 'text', text }],
    timestamp: ISO,
  });
  store.appendMessage(message(0, 'user', 'hello'));
  store.appendMessage(message(1, 'assistant', 'hi there'));
  // Not made canonical on purpose: the project's spelling and the canonical path differ where the temporary directory is a link.
  const root = mkdtempSync(join(tmpdir(), 'relavium-export-project-pin-'));
  cwd = join(root, 'project');
  homeDir = join(root, 'home');
  outside = join(root, 'outside');
  for (const dir of [cwd, homeDir, outside]) mkdirSync(dir, { recursive: true });
  mkdirSync(join(cwd, '.relavium', 'workflows'), { recursive: true });
});
afterEach(() => {
  client.sqlite.close();
  rmSync(join(cwd, '..'), { recursive: true, force: true });
});

const workflows = (): string => join(cwd, '.relavium', 'workflows');
const moved = (): string => join(cwd, '.relavium', 'workflows-moved');
const exportNow = () =>
  exportSessionToProject({
    store,
    sessionId: 's1',
    cwd,
    homeDir,
    projectConfigDir: join(cwd, '.relavium'),
  });

function toLink(): void {
  if (linked) return;
  realFs.renameSync(workflows(), moved());
  realFs.symlinkSync(outside, workflows());
  linked = true;
}

function messageOf(run: () => unknown): string | undefined {
  try {
    run();
    return undefined;
  } catch (cause) {
    if (!isCliError(cause)) throw cause;
    return cause.message;
  }
}

describe.skipIf(process.platform === 'win32')(
  'the project write is held to the confined directory',
  () => {
    it('a directory swapped for a link when the directories are created: refused, nothing written, nothing left', () => {
      vi.mocked(fs.mkdirSync).mockImplementationOnce((path, options) => {
        toLink();
        return fs.mkdirSync(path, options);
      });
      expect(messageOf(exportNow)).toBe(CHANGED);
      expect(readdirSync(outside)).toEqual([]);
      expect(readdirSync(moved())).toEqual([]);
    });

    it('the session’s own earlier export, rewritten while the directory is swapped away: refused, nothing is written or left in the victim directory', () => {
      const first = exportNow();
      const name = first.path.slice(first.path.lastIndexOf('/') + 1);
      // The victim directory holds a HARD LINK to the very file the rewrite recognized: the same device, inode, size and times, so the
      // rewrite's own identity checks cannot tell it from the file they were taken from. Only the directory guard stands between the
      // temporary file and the victim directory.
      const victim = join(outside, name);
      fs.linkSync(first.path, victim);
      const before = readFileSync(victim, 'utf8');
      // The temporary is created just after the permission check; the link is in place for it, and for the pin that looks before the rename.
      vi.mocked(fs.accessSync).mockImplementationOnce((path, mode) => {
        fs.accessSync(path, mode);
        toLink();
      });
      expect(messageOf(exportNow)).toBe(CHANGED);
      expect(readdirSync(outside), 'no temporary in the directory the link points at').toEqual([
        name,
      ]);
      expect(readFileSync(victim, 'utf8'), 'and the file there was not replaced').toBe(before);
      expect(readdirSync(moved()), 'the earlier export is where it was').toEqual([name]);
    });

    it('a project reached through a link that is repointed after the confinement: the write still goes to the real project', () => {
      const root = join(cwd, '..');
      const reached = join(root, 'reached');
      symlinkSync(cwd, reached);
      const decoy = join(root, 'decoy');
      mkdirSync(join(decoy, '.relavium', 'workflows'), { recursive: true });
      vi.mocked(fs.mkdirSync).mockImplementationOnce((path, options) => {
        realFs.unlinkSync(reached);
        realFs.symlinkSync(decoy, reached);
        return fs.mkdirSync(path, options);
      });
      exportSessionToProject({
        store,
        sessionId: 's1',
        cwd: reached,
        homeDir,
        projectConfigDir: join(reached, '.relavium'),
      });
      expect(readdirSync(workflows())).toEqual(['my-session.relavium.yaml']);
      expect(readdirSync(join(decoy, '.relavium', 'workflows')), 'the decoy stayed empty').toEqual(
        [],
      );
    });

    it('writes by the canonical directory and reports by the project’s own spelling', () => {
      const result = exportNow();
      expect(result.path).toBe(join(workflows(), 'my-session.relavium.yaml'));
      expect(readFileSync(result.path, 'utf8')).toContain('schema_version:');
    });

    it('a directory that is a link INSIDE the project is followed, and written through its real path', () => {
      rmSync(workflows(), { recursive: true });
      mkdirSync(join(cwd, '.relavium', 'shared'));
      symlinkSync(join(cwd, '.relavium', 'shared'), workflows());
      const result = exportNow();
      expect(result.path).toBe(join(workflows(), 'my-session.relavium.yaml'));
      expect(readdirSync(join(cwd, '.relavium', 'shared'))).toEqual(['my-session.relavium.yaml']);
    });
  },
);

describe.skipIf(process.platform === 'win32')(
  'a rewrite of the session’s own export keeps its group',
  () => {
    it('really keeps a group the process belongs to (skipped when there is no second one)', () => {
      const first = exportNow();
      const directoryGroup = statSync(workflows()).gid;
      const other = process.getgroups?.().find((gid) => gid !== directoryGroup);
      if (other === undefined) return;
      fs.chownSync(first.path, -1, other);
      chmodSync(first.path, 0o660);
      const again = exportNow();
      expect(again.path).toBe(first.path);
      expect(statSync(again.path).gid, 'the group of the file that was rewritten').toBe(other);
      expect(statSync(again.path).mode & 0o777).toBe(0o660);
    });
  },
);
