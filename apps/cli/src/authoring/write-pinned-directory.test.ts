/**
 * A forced write goes through the CANONICAL directory the confinement computed, and refuses a directory that stopped resolving to
 * itself (the security sitting on PR #102, L1). `confineToProjectConfig` checked the directory by name, and the write then resolved the
 * same name AGAIN: a directory swapped for a link in between sent the write (and the temporary file beside it) out of the project.
 *
 * Each swap is made at a chosen step by wrapping the file-system call that step makes (`vi.mock` of `node:fs`, the way
 * `write-authored-file.test.ts` injects its faults), so the interleaving is the same on every run. Every case asserts the "nothing was
 * written" side: the directory the swap points at stays empty, and no temporary file is left in it.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createCommand } from '../commands/create.js';
import { commitImport, prepareImport } from '../commands/import.js';
import { isCliError } from '../process/errors.js';
import { captureIo } from '../test-support.js';
import type { GlobalOptions } from '../process/options.js';
import { confineCatalogTarget, writeAuthoredFile, type CreatePrompter } from './authoring.js';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    accessSync: vi.fn(actual.accessSync),
    mkdirSync: vi.fn(actual.mkdirSync),
  };
});

const CHANGED =
  'The target directory was changed by something else while the file was being written, so nothing was written. Retry.';

const AGENT = `id: evil
provider: anthropic
model: claude-sonnet-4-6
system_prompt: Review the code.
`;
const AGENT_CANONICAL =
  'id: evil\nmodel: claude-sonnet-4-6\nprovider: anthropic\nsystem_prompt: Review the code.\n';

let root = '';
let project = '';
let home = '';
let outside = '';
beforeEach(() => {
  vi.mocked(fs.accessSync).mockReset();
  vi.mocked(fs.mkdirSync).mockReset();
  // Not made canonical on purpose: on macOS the temporary directory is reached through a link (`/var` -> `/private/var`), so the project's
  // own spelling and the canonical one differ, as they do for a project reached through a link of its own.
  root = mkdtempSync(join(tmpdir(), 'relavium-pinned-'));
  project = join(root, 'project');
  home = join(root, 'home');
  outside = join(root, 'outside');
  for (const dir of [project, home, outside]) mkdirSync(dir, { recursive: true });
  mkdirSync(join(project, '.relavium', 'agents'), { recursive: true });
  writeFileSync(join(project, 'incoming.agent.yaml'), AGENT);
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const global = (cwd: string): GlobalOptions => ({
  json: false,
  color: false,
  cwd,
  configPath: undefined,
  verbosity: 'normal',
});

const agents = (): string => join(project, '.relavium', 'agents');
const moved = (): string => join(project, '.relavium', 'agents-moved');

/** What a person (or something else on the machine) does to the directory: the real one moves aside and a link to `elsewhere` takes its name. */
function swapDirectoryForLink(elsewhere: string): void {
  renameSync(agents(), moved());
  symlinkSync(elsewhere, agents());
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
  'a directory swapped for a link after the confinement',
  () => {
    it('before the write starts: refused in fixed words, nothing written through the link', () => {
      const confined = confineCatalogTarget({
        projectConfigDir: join(project, '.relavium'),
        cwd: project,
        target: join(project, '.relavium', 'agents', 'evil.agent.yaml'),
      });
      swapDirectoryForLink(outside);
      for (const force of [false, true]) {
        expect(
          messageOf(() =>
            writeAuthoredFile(
              confined.writeTarget,
              confined.targetDisplay,
              AGENT_CANONICAL,
              force,
              {
                pinDirectory: true,
              },
            ),
          ),
          `force=${String(force)}`,
        ).toBe(CHANGED);
      }
      expect(readdirSync(outside), 'nothing reached the directory the link points at').toEqual([]);
      expect(readdirSync(moved()), 'and the real directory was not written to either').toEqual([]);
    });

    it('without the pin the same write DOES follow the link: the pin is what refuses it', () => {
      const confined = confineCatalogTarget({
        projectConfigDir: join(project, '.relavium'),
        cwd: project,
        target: join(project, '.relavium', 'agents', 'evil.agent.yaml'),
      });
      swapDirectoryForLink(outside);
      writeAuthoredFile(confined.writeTarget, confined.targetDisplay, AGENT_CANONICAL, true);
      expect(readdirSync(outside)).toEqual(['evil.agent.yaml']);
    });

    it('the write is to the canonical directory, which is not the project’s spelling of it', () => {
      const confined = confineCatalogTarget({
        projectConfigDir: join(project, '.relavium'),
        cwd: project,
        target: join(project, '.relavium', 'agents', 'evil.agent.yaml'),
      });
      expect(confined.writeTarget).toBe(
        join(realpathSync(project), '.relavium', 'agents', 'evil.agent.yaml'),
      );
      // What is shown names the same directory by the person's own spelling, cwd-relative.
      expect(confined.targetDisplay).toBe(join('.relavium', 'agents', 'evil.agent.yaml'));
    });

    describe('inside commitImport, at the step the swap is made', () => {
      function plan(force: boolean) {
        return prepareImport(
          { path: 'incoming.agent.yaml', force },
          { global: global(project), homeDir: home },
        );
      }

      it('when the directories are created: refused, nothing written, nothing left', () => {
        const prepared = plan(false);
        vi.mocked(fs.mkdirSync).mockImplementationOnce((path, options) => {
          swapDirectoryForLink(outside);
          return fs.mkdirSync(path, options);
        });
        expect(messageOf(() => commitImport(prepared))).toBe(CHANGED);
        expect(readdirSync(outside)).toEqual([]);
        expect(readdirSync(moved())).toEqual([]);
      });

      it('between the look at the target and the temporary file: refused, the temporary is not left in the directory the link points at', () => {
        writeFileSync(join(agents(), 'evil.agent.yaml'), 'old\n');
        const prepared = plan(true);
        // `accessSync` is the step right before the temporary is created: the directory is swapped just after it, so the temporary lands
        // through the link, in `outside`, and the guard before the rename has to catch it and take it away again.
        vi.mocked(fs.accessSync).mockImplementationOnce((path, mode) => {
          fs.accessSync(path, mode);
          swapDirectoryForLink(outside);
        });
        expect(messageOf(() => commitImport(prepared))).toBe(CHANGED);
        expect(readdirSync(outside), 'no file and no temporary in the link’s target').toEqual([]);
        expect(
          readFileSync(join(moved(), 'evil.agent.yaml'), 'utf8'),
          'the old file is whole',
        ).toBe('old\n');
      });

      it('create writes through the same pin: a swap when the directories are created is refused, nothing written', async () => {
        const prompter: CreatePrompter = {
          gather: () =>
            Promise.resolve({
              kind: 'agent',
              name: 'Evil',
              provider: 'anthropic',
              model: 'claude-sonnet-4-6',
              systemPrompt: 'Review the code.',
              tools: [],
            }),
        };
        vi.mocked(fs.mkdirSync).mockImplementationOnce((path, options) => {
          swapDirectoryForLink(outside);
          return fs.mkdirSync(path, options);
        });
        const { io, out } = captureIo();
        let message: string | undefined;
        try {
          await createCommand(
            { force: false },
            { io, global: global(project), prompter, homeDir: home },
          );
        } catch (cause) {
          if (!isCliError(cause)) throw cause;
          message = cause.message;
        }
        expect(message).toBe(CHANGED);
        expect(out(), 'nothing was announced for a write that did not happen').toBe('');
        expect(readdirSync(outside)).toEqual([]);
        expect(readdirSync(moved())).toEqual([]);
      });

      it('the project reached through a link that is repointed after the check: the write still goes to the real project', () => {
        // The person's cwd is a link to the project (a project reached through a link of its own).
        const reached = join(root, 'reached');
        symlinkSync(project, reached);
        const decoy = join(root, 'decoy');
        mkdirSync(join(decoy, '.relavium', 'agents'), { recursive: true });
        const prepared = prepareImport(
          { path: 'incoming.agent.yaml', force: false },
          { global: global(reached), homeDir: home },
        );
        vi.mocked(fs.mkdirSync).mockImplementationOnce((path, options) => {
          unlinkSync(reached);
          symlinkSync(decoy, reached);
          return fs.mkdirSync(path, options);
        });
        commitImport(prepared);
        expect(readFileSync(join(agents(), 'evil.agent.yaml'), 'utf8')).toBe(AGENT_CANONICAL);
        expect(readdirSync(join(decoy, '.relavium', 'agents')), 'the decoy stayed empty').toEqual(
          [],
        );
        expect(existsSync(join(reached, '.relavium', 'agents', 'evil.agent.yaml'))).toBe(false);
      });
    });
  },
);
