/**
 * The Home's import card when the file system refuses the write, and when the path is refused before anything is read (the export
 * card's twin, `defined-port-commit-faults.test.ts`): a raw errno out of `commitImport` (an unwritable directory, a read-only volume, a
 * full disk) is a refusal the person reads, not a fault that ends the Home. The sentences are fixed and quote neither the path nor the
 * error's own message; any other fault is a defect and is still thrown (ADR-0139: an unclassified fault ends the Home).
 *
 * `commitImport` is replaced here (the one fault a test cannot cause portably is a file system that refuses a write) and
 * `prepareImport` is wrapped so that a call to it can be counted; the port is the real one over a temporary project.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CliError } from '../process/errors.js';
import { commitImport, prepareImport } from '../commands/import.js';
import type { GlobalOptions } from '../process/options.js';
import type { ImportPrepared } from '../render/tui/import-card.js';
import { createImportPort } from './import-port.js';

vi.mock('../commands/import.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../commands/import.js')>();
  return { ...actual, commitImport: vi.fn(), prepareImport: vi.fn(actual.prepareImport) };
});

const AGENT = `id: reviewer
provider: anthropic
model: claude-sonnet-4-6
system_prompt: Review the code.
`;

/** A path and a message a refusal must never repeat: they stand for anything the operator's file system quotes. */
const SECRET_PATH = '/Users/SECRET-OPERATOR/private-vault/reviewer.agent.yaml';
const SECRET_MESSAGE = `EACCES: permission denied, open '${SECRET_PATH}'`;

let root = '';
let home = '';
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'relavium-import-faults-'));
  home = mkdtempSync(join(tmpdir(), 'relavium-import-faults-home-'));
  mkdirSync(join(root, '.relavium'), { recursive: true });
  writeFileSync(join(root, 'incoming.agent.yaml'), AGENT);
  vi.mocked(commitImport).mockReset();
  vi.mocked(prepareImport).mockClear();
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

const global = (): GlobalOptions => ({
  json: false,
  color: false,
  cwd: root,
  configPath: undefined,
  verbosity: 'normal',
});

/** The error `fs` raises: a message that quotes the path, and the errno `code`. */
function errnoError(code: string, message = SECRET_MESSAGE): Error {
  return Object.assign(new Error(message), {
    code,
    errno: -13,
    syscall: 'open',
    path: SECRET_PATH,
  });
}

/** The real port over the temporary project, prepared for the one file; the commit it returns is the real `commitOf`. */
function prepared(): Extract<ImportPrepared, { ok: true }> {
  const result = createImportPort({ global: global(), homeDir: home }).prepare(
    'incoming.agent.yaml',
  );
  if (!result.ok) throw new Error(`the import was not prepared: ${result.reason}`);
  return result;
}

const FIXED_REASONS: ReadonlyArray<readonly [string, string]> = [
  ['EACCES', 'The file could not be written: permission denied.'],
  ['EPERM', 'The file could not be written: permission denied.'],
  ['EROFS', 'The file could not be written: the file system is read-only.'],
  ['ENOSPC', 'The file could not be written: no space is left on the device.'],
  ['EDQUOT', 'The file could not be written: no space is left on the device.'],
  ['EMFILE', 'The file could not be written: too many files are open.'],
  ['ENFILE', 'The file could not be written: too many files are open.'],
  ['EIO', 'The file could not be written: the write failed (I/O error).'],
];

describe('a commit the file system refuses is a refusal with a fixed sentence', () => {
  it.each(FIXED_REASONS)(
    '%s returns ok:false with its sentence, and nothing of the error',
    (code, sentence) => {
      const commit = prepared().commit;
      vi.mocked(commitImport).mockImplementation(() => {
        throw errnoError(code);
      });
      const attempt = commit();
      expect(attempt).toEqual({ ok: false, reason: sentence });
      expect(vi.mocked(commitImport)).toHaveBeenCalledTimes(1);
      if (attempt.ok) return;
      expect(attempt.reason).not.toContain(SECRET_PATH);
      expect(attempt.reason).not.toContain('SECRET');
      expect(attempt.reason).not.toContain(root);
      expect(attempt.reason).not.toContain(SECRET_MESSAGE);
      expect(attempt.reason).not.toContain(code);
    },
  );

  it('a commit that writes still says where it wrote', () => {
    expect(prepared().commit()).toEqual({
      ok: true,
      written: "Imported agent 'reviewer' to .relavium/agents/reviewer.agent.yaml.",
    });
  });

  it('a refusal the command itself raises is shown in its own words, sanitized', () => {
    const commit = prepared().commit;
    vi.mocked(commitImport).mockImplementation(() => {
      throw new CliError(
        'invalid_invocation',
        'cannot write .relavium/agents/reviewer.agent.yaml: the target path is not a file',
      );
    });
    expect(commit()).toEqual({
      ok: false,
      reason: 'cannot write .relavium/agents/reviewer.agent.yaml: the target path is not a file',
    });
  });

  it.each([
    ['an error with no errno code', new Error('a bug in the writer')],
    ['an error with a code that is not a refusal of the file system', errnoError('ENOENT')],
    ['an error whose code is not a string', Object.assign(new Error('x'), { code: 13 })],
    ['a thrown string', 'EACCES'],
    ['a thrown null', null],
  ])(
    '%s is still thrown: it is a defect, and an unclassified fault ends the Home',
    (_name, fault) => {
      const commit = prepared().commit;
      vi.mocked(commitImport).mockImplementation(() => {
        // The thrown value is the whole point of the case: it is not always an Error.
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw fault;
      });
      try {
        commit();
        expect.unreachable('the commit did not throw');
      } catch (cause) {
        expect(cause).toBe(fault);
      }
    },
  );
});

describe('whatever a plan holds is shown sanitized, whoever composed it', () => {
  const ESC = '\u001b';
  const hostile = {
    kind: 'agent' as const,
    slug: `a${ESC}]0;pwned\u0007b`,
    source: `in${ESC}[2Jput.yaml`,
    target: '/p/.relavium/agents/x.agent.yaml',
    targetDisplay: `.relavium/agents/x${ESC}[31m.agent.yaml`,
    projectConfigDir: '/p/.relavium',
    content: 'id: x\n',
    bytes: 6,
    force: false,
    warnings: [`Warning: ${ESC}[31mred\n`],
  };

  it('the offer and the sentence for a written file carry none of it', () => {
    vi.mocked(prepareImport).mockImplementationOnce(() => hostile);
    const result = createImportPort({ global: global(), homeDir: home }).prepare('whatever.yaml');
    if (!result.ok) throw new Error(`not prepared: ${result.reason}`);
    // Not JSON.stringify: it would write the control characters as text and hide them.
    const drawn = [
      result.offer.slug,
      result.offer.source,
      result.offer.destination,
      ...result.offer.warnings,
    ].join('\n');
    expect(drawn).not.toContain(ESC);
    expect(drawn).not.toContain('\u0007');
    expect(result.offer.slug).toBe('ab');
    expect(result.offer.source).toBe('input.yaml');
    expect(result.offer.destination).toBe('.relavium/agents/x.agent.yaml');
    expect(result.offer.warnings).toEqual(['Warning: red']);
    const attempt = result.commit();
    expect(attempt.ok).toBe(true);
    if (!attempt.ok) return;
    expect(attempt.written).not.toContain(ESC);
    expect(attempt.written).toBe("Imported agent 'ab' to .relavium/agents/x.agent.yaml.");
  });

  it('a refusal after a hostile plan is sanitized too', () => {
    vi.mocked(prepareImport).mockImplementationOnce(() => hostile);
    const result = createImportPort({ global: global(), homeDir: home }).prepare('whatever.yaml');
    if (!result.ok) throw new Error(`not prepared: ${result.reason}`);
    vi.mocked(commitImport).mockImplementation(() => {
      throw new CliError('invalid_invocation', `cannot write x${ESC}[2J: nope`);
    });
    const attempt = result.commit();
    expect(attempt.ok).toBe(false);
    if (attempt.ok) return;
    expect(attempt.reason).not.toContain(ESC);
  });
});

describe('a path that is refused is refused before anything is read', () => {
  const port = () => createImportPort({ global: global(), homeDir: home });

  it.each([
    ['a control character', 'incoming.agent.yaml\u001b[0m'],
    ['a NUL', 'incoming.agent.yaml\u0000'],
    ['a newline', 'incoming.agent.yaml\n'],
    ['more than 1,024 characters', `${'a'.repeat(1025)}.yaml`],
    ['nothing at all', ''],
    ['only blanks', '   '],
  ])('%s never reaches the command’s first half', (_name, text) => {
    const result = port().prepare(text);
    expect(result.ok).toBe(false);
    expect(vi.mocked(prepareImport)).not.toHaveBeenCalled();
  });

  it('a path that is allowed does reach it, once, with force off and the Home’s own home', () => {
    expect(port().prepare('incoming.agent.yaml').ok).toBe(true);
    expect(vi.mocked(prepareImport)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(prepareImport).mock.calls[0]).toEqual([
      { path: 'incoming.agent.yaml', force: false },
      { global: global(), homeDir: home },
    ]);
  });

  it('a fault in the first half that is not the command’s refusal is a defect, and is thrown', () => {
    const bug = new TypeError('a bug in the parser');
    vi.mocked(prepareImport).mockImplementationOnce(() => {
      throw bug;
    });
    expect(() => port().prepare('incoming.agent.yaml')).toThrow(bug);
  });
});
