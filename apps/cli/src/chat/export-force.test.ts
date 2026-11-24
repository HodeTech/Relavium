/**
 * The in-chat session export under `--force` never opens the target by path (the security sitting on PR #102, M1). It used to look at
 * the target (`lstat`) and then open it with flag `w`: a link swapped in between was followed (the victim was overwritten 169 times in
 * 85,606 tries), a FIFO swapped in held the command for ever, and `w` truncates before it writes, so a failure half way left a damaged
 * file. It now takes the sequence `writeAuthoredFile` takes (`process/forced-write.ts`): look without following, replace a plain file
 * through a fresh temporary and a rename, otherwise create with `wx`.
 *
 * The interleavings are made deterministic by wrapping the two calls that would have followed the swap (`writeFileSync` by path, and the
 * `renameSync` over the target): the swap happens in the instant before the real call. A bounded random race (a child process that
 * alternates the final component) runs as well, in the spirit of the sitting's probe, but the deterministic cases are what kill a
 * regression: a race at 0.2% a try is not.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createClient, createSessionStore, runMigrations, type DbClient } from '@relavium/db';
import { AgentSchema, type AgentSessionRecord, type SessionMessage } from '@relavium/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { isCliError } from '../process/errors.js';
import { exportSession } from './export.js';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    fsyncSync: vi.fn(actual.fsyncSync),
    renameSync: vi.fn(actual.renameSync),
    writeFileSync: vi.fn(actual.writeFileSync),
  };
});
const realFs = await vi.importActual<typeof import('node:fs')>('node:fs');

const NOT_PLAIN =
  'The target exists and is a link or not a regular file, so nothing was written. Remove it or choose another path, then retry.';
const ISO = '2026-06-25T00:00:00.000Z';
const AGENT = AgentSchema.parse({
  id: 'coder',
  model: 'claude-opus-4-8',
  provider: 'anthropic',
  system_prompt: 'You are concise.',
});
const VICTIM = 'precious: do not touch\n';

let client: DbClient;
let store: ReturnType<typeof createSessionStore>;
let cwd = '';
let homeDir = '';
let target = '';
let victim = '';
let helper: ChildProcess | undefined;

beforeEach(() => {
  vi.mocked(fs.fsyncSync).mockReset();
  vi.mocked(fs.renameSync).mockReset();
  vi.mocked(fs.writeFileSync).mockReset();
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
  cwd = mkdtempSync(join(tmpdir(), 'relavium-export-force-'));
  homeDir = mkdtempSync(join(tmpdir(), 'relavium-export-force-home-'));
  target = join(cwd, 's1.relavium.yaml');
  victim = join(homeDir, 'victim.txt');
  writeFileSync(victim, VICTIM);
});
afterEach(() => {
  helper?.kill('SIGKILL');
  helper = undefined;
  client.sqlite.close();
  rmSync(cwd, { recursive: true, force: true });
  rmSync(homeDir, { recursive: true, force: true });
});

const forced = (): ReturnType<typeof exportSession> =>
  exportSession({ store, sessionId: 's1', cwd, homeDir, force: true });

function messageOf(run: () => unknown): string | undefined {
  try {
    run();
    return undefined;
  } catch (cause) {
    if (!isCliError(cause)) throw cause;
    return cause.message;
  }
}

/**
 * Make `swap` happen once, in the instant before the first call that would write to the target by its name: a `writeFileSync` of the
 * path itself (what the old `w` open was), or a `renameSync` onto it (what the replacement does last).
 */
function swapBeforeTheWrite(swap: () => void): void {
  let done = false;
  const once = (): void => {
    if (done) return;
    done = true;
    swap();
  };
  vi.mocked(fs.writeFileSync).mockImplementation((path, ...rest) => {
    if (path === target) once();
    (realFs.writeFileSync as (...a: unknown[]) => void)(path, ...rest);
  });
  vi.mocked(fs.renameSync).mockImplementation((from, to) => {
    if (to === target) once();
    realFs.renameSync(from, to);
  });
}

/** Put a link to the victim at the target's name, replacing whatever is there. */
function linkToVictim(): void {
  rmSync(target, { force: true });
  symlinkSync(victim, target);
}

describe.skipIf(process.platform === 'win32')(
  'a link swapped in at the target, after the look',
  () => {
    it('over a plain file that was there at the look: the replacement takes the name, the victim is untouched', () => {
      writeFileSync(target, 'old scaffold\n');
      swapBeforeTheWrite(linkToVictim);
      forced();
      expect(readFileSync(victim, 'utf8'), 'the file the link led to').toBe(VICTIM);
      expect(lstatSync(target).isFile(), 'the name now holds the new file, not the link').toBe(
        true,
      );
      expect(readFileSync(target, 'utf8')).toContain('schema_version:');
      expect(readdirSync(cwd), 'no temporary is left').toEqual(['s1.relavium.yaml']);
    });

    it('where nothing was at the look: refused in fixed words, the victim untouched, the link left as it was', () => {
      swapBeforeTheWrite(linkToVictim);
      expect(messageOf(forced)).toBe(NOT_PLAIN);
      expect(readFileSync(victim, 'utf8')).toBe(VICTIM);
      expect(lstatSync(target).isSymbolicLink()).toBe(true);
    });

    it('a link there from the start is refused at the look, victim untouched', () => {
      symlinkSync(victim, target);
      expect(messageOf(forced)).toBe(NOT_PLAIN);
      expect(readFileSync(victim, 'utf8')).toBe(VICTIM);
    });

    it(
      'under a bounded random race (a child that alternates a plain file and a link) the victim never changes',
      { timeout: 8000 },
      () => {
        const script = `
      const fs = require('node:fs'); const path = require('node:path');
      const [dir, victim, ms] = process.argv.slice(1);
      const t = path.join(dir, 's1.relavium.yaml'), f = path.join(dir, '.f'), l = path.join(dir, '.l');
      const end = Date.now() + Number(ms);
      while (Date.now() < end) {
        try { fs.writeFileSync(f, 'plain'); fs.renameSync(f, t); } catch {}
        try { fs.symlinkSync(victim, l); fs.renameSync(l, t); } catch {}
      }`;
        helper = spawn(process.execPath, ['-e', script, cwd, victim, '700'], { stdio: 'ignore' });
        const end = Date.now() + 700;
        let tries = 0;
        let refused = 0;
        while (Date.now() < end && tries < 2000) {
          tries += 1;
          try {
            forced();
          } catch {
            refused += 1;
          }
          expect(readFileSync(victim, 'utf8'), `after try ${String(tries)}`).toBe(VICTIM);
        }
        expect(tries).toBeGreaterThan(0);
        expect(refused).toBeLessThanOrEqual(tries);
      },
    );
  },
);

describe.skipIf(process.platform === 'win32')('a FIFO at the target', () => {
  function canMakeFifo(): boolean {
    const probe = mkdtempSync(join(tmpdir(), 'relavium-fifo-probe-'));
    try {
      execFileSync('mkfifo', [join(probe, 'f')], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    } finally {
      rmSync(probe, { recursive: true, force: true });
    }
  }
  const fifoOk = canMakeFifo();

  /** A helper that reads the FIFO after a second: an open for writing is held until then, so waiting shows as elapsed time, not as a hang. */
  function lateReader(path: string): void {
    helper = spawn('sh', ['-c', 'sleep 1; cat "$1" >/dev/null', 'sh', path], { stdio: 'ignore' });
  }

  it.skipIf(!fifoOk)(
    'there from the start is refused at once, never opened',
    { timeout: 6000 },
    () => {
      execFileSync('mkfifo', [target]);
      lateReader(target);
      const started = Date.now();
      expect(messageOf(forced)).toBe(NOT_PLAIN);
      expect(Date.now() - started, 'did not wait for a reader').toBeLessThan(800);
      expect(lstatSync(target).isFIFO(), 'and it was not replaced').toBe(true);
    },
  );

  it.skipIf(!fifoOk)(
    'swapped in after the look is replaced by the rename, with no wait',
    { timeout: 6000 },
    () => {
      writeFileSync(target, 'old scaffold\n');
      swapBeforeTheWrite(() => {
        unlinkSync(target);
        execFileSync('mkfifo', [target]);
        lateReader(target);
      });
      const started = Date.now();
      forced();
      expect(Date.now() - started, 'the write did not wait on the FIFO').toBeLessThan(800);
      expect(lstatSync(target).isFile()).toBe(true);
      expect(readFileSync(target, 'utf8')).toContain('schema_version:');
    },
  );
});

describe('a failure half way never leaves a damaged file', () => {
  it('the old scaffold survives a flush that fails, whole, and no temporary is left', () => {
    writeFileSync(target, 'old scaffold\n');
    vi.mocked(fs.fsyncSync).mockImplementationOnce(() => {
      throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
    });
    let thrown: unknown;
    try {
      forced();
    } catch (cause) {
      thrown = cause;
    }
    expect(
      isCliError(thrown) && thrown.code,
      'the storage refusal the export always raised for ENOSPC',
    ).toBe('storage_unavailable');
    expect(readFileSync(target, 'utf8'), 'not truncated, not half written').toBe('old scaffold\n');
    expect(readdirSync(cwd)).toEqual(['s1.relavium.yaml']);
  });

  it.skipIf(process.platform === 'win32')(
    'a plain file is replaced and keeps its permission bits',
    () => {
      writeFileSync(target, 'old scaffold\n');
      fs.chmodSync(target, 0o664);
      forced();
      expect(readFileSync(target, 'utf8')).toContain('schema_version:');
      expect(fs.statSync(target).mode & 0o777).toBe(0o664);
    },
  );
});
