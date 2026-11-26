/**
 * The Home's export card when the write itself is refused by the file system (LAUNCH-3, a review finding): a raw errno out of
 * `commitExport` (an unwritable directory, a read-only volume, a full disk) is a refusal the person reads on the Defined tab, not a fault
 * that ends the Home and its background run. The sentences are fixed and quote neither the path nor the error's own message; any
 * other fault is a defect and is still thrown (ADR-0139 decided that an unclassified fault ends the Home).
 *
 * `commitExport` is replaced here (the one fault a test cannot cause portably is a file system that refuses a write); the port, the
 * card and the Home controller are the real ones, and the controller has an invocation work owner, which is what ends a Home.
 *
 * MVP-11 unit 6 (6.3): the card is a popup now, so a refused write is said on its persistent Done step (what failed and why), not on the
 * tab's message row (ADR-0148 §6: no residue); the flow it runs on here answers `Ctrl+Y` and closes whatever step it is shown, and records
 * what each step said.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildDefinedModel } from '../history/defined-model.js';
import { commitExport } from '../commands/export.js';
import type { GlobalOptions } from '../process/options.js';
import {
  runExportCard,
  type ExportCardDeps,
  type ExportPrepared,
} from '../render/tui/export-card.js';
import { createHomeController, type HomeController } from '../render/tui/home-controller.js';
import type { HomeSnapshot } from './home-store.js';
import type { TabHostState } from '../render/tui/tab-host.js';
import { createExportPort } from './defined-port.js';

vi.mock('../commands/export.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../commands/export.js')>()),
  commitExport: vi.fn(),
}));

const WORKFLOW = `schema_version: '1.0'
workflow:
  id: code-review
  name: Code Review
  nodes:
    - { id: s, type: input }
    - { id: o, type: output }
  edges:
    - { from: s, to: o }
`;

/** A path and a message a refusal must never repeat: they stand for anything the operator's file system quotes. */
const SECRET_PATH = '/Users/SECRET-OPERATOR/private-vault/code-review.relavium.yaml';
const SECRET_MESSAGE = `EACCES: permission denied, open '${SECRET_PATH}'`;

let root = '';
let home = '';
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'relavium-commit-faults-'));
  home = mkdtempSync(join(tmpdir(), 'relavium-commit-faults-home-'));
  mkdirSync(join(root, '.relavium', 'workflows'), { recursive: true });
  writeFileSync(join(root, '.relavium', 'workflows', 'code-review.relavium.yaml'), WORKFLOW);
  vi.mocked(commitExport).mockReset();
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

/** The real port over the temporary project, prepared for the one workflow; the commit it returns is the real `commitOf`. */
function prepared(): Extract<ExportPrepared, { ok: true }> {
  const result = createExportPort({ global: global(), homeDir: home }).prepare('code-review');
  if (!result.ok) throw new Error(`the export was not prepared: ${result.reason}`);
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
      vi.mocked(commitExport).mockImplementation(() => {
        throw errnoError(code);
      });
      const attempt = commit();
      expect(attempt).toEqual({ ok: false, reason: sentence });
      expect(vi.mocked(commitExport)).toHaveBeenCalledTimes(1);
      if (attempt.ok) return;
      expect(attempt.reason).not.toContain(SECRET_PATH);
      expect(attempt.reason).not.toContain('SECRET');
      expect(attempt.reason).not.toContain(root);
      expect(attempt.reason).not.toContain(SECRET_MESSAGE);
      expect(attempt.reason).not.toContain(code);
    },
  );

  it('a commit that writes still says where it wrote', () => {
    const attempt = prepared().commit();
    expect(attempt).toEqual({
      ok: true,
      written: "Exported workflow 'code-review' to code-review.relavium.yaml.",
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
      vi.mocked(commitExport).mockImplementation(() => {
        // The thrown value is the whole point of the case: it is not always an Error.
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw fault;
      });
      expect(commit).toThrow();
      try {
        commit();
        expect.unreachable('the commit did not throw');
      } catch (cause) {
        expect(cause).toBe(fault);
      }
    },
  );
});

// ---------------------------------------------------------------------------------------------------------------------------------
// The card, in a Home that has a work owner: the owner's `failure` is what ends the Home and its run, so it is what is watched.
// ---------------------------------------------------------------------------------------------------------------------------------

const EMPTY: HomeSnapshot = {
  attention: { failedRuns: [] },
  recentSessions: [],
  recentRuns: [],
  recentAgents: [],
  unreadableRuns: [],
  totals: { attention: 0, sessions: 0, runs: 0 },
  isEmpty: true,
};
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
const ENTER = { return: true } as const;

/** What each select of the flow said (the Done step is a select): its message, lines and tone. */
const shownSteps: { message: string; details: readonly string[]; final: string | undefined }[] = [];

/** A card whose person answers `Ctrl+Y` and closes the Done step: the real card, the real port, no terminal. */
const yes: ExportCardDeps['flow'] = {
  begin: () => new AbortController().signal,
  end: () => Promise.resolve(),
  cancel: () => undefined,
  popup: () => undefined,
  note: () => undefined,
  busy: () => undefined,
  pick: () => Promise.resolve('close'),
  select: (options) => {
    shownSteps.push({
      message: options.message,
      details: options.details ?? [],
      final: options.final,
    });
    return Promise.resolve('close');
  },
  confirm: () => Promise.resolve(false),
  text: () => Promise.resolve(''),
  password: () => Promise.resolve(''),
  chord: () => Promise.resolve('allow'),
};

function mountHome() {
  const failure = vi.fn<(cause: unknown) => void>();
  const entered = vi.fn();
  const enter = <T>(operation: () => Promise<T>): Promise<T> => {
    entered();
    return operation();
  };
  const onError = vi.fn<(cause: unknown) => void>();
  const onExit = vi.fn();
  const port = createExportPort({ global: global(), homeDir: home });
  const controller = createHomeController({
    workOwner: { enter, failure },
    defined: {
      read: () => ({
        model: buildDefinedModel({
          entries: [
            {
              slug: 'code-review',
              name: 'Code Review',
              nodeCount: 2,
              path: 'code-review.relavium.yaml',
              valid: true,
            },
          ],
          pins: [],
        }),
        slugOf: (index) => (index === 0 ? 'code-review' : undefined),
        pathOf: (index) => (index === 0 ? 'code-review.relavium.yaml' : undefined),
      }),
    },
    exportDefined: (slug) => runExportCard({ flow: yes, port }, slug),
    startChat: () => new Promise<never>(() => {}),
    homeStore: { read: () => EMPTY },
    schedule: () => () => {},
    onExit,
    onError,
  });
  return { controller, failure, entered, onError, onExit };
}

const messageOf = (c: HomeController): string | undefined => {
  const screen = c.getSnapshot().screen;
  const host: TabHostState | undefined = screen?.kind === 'tab-host' ? screen.host : undefined;
  return host?.defined?.message;
};

/** `/workflows`, then `x` on the first row: the card is answered Yes, and the commit runs. */
async function exportFirstRow(controller: HomeController): Promise<void> {
  controller.handlePaste('/workflows');
  controller.handleKey('', ENTER);
  await flush();
  controller.handleKey('x', {});
  await flush();
  await flush();
}

describe('in a Home with a work owner, an errno from the write does not end the Home', () => {
  it.each(FIXED_REASONS)(
    '%s: the popup’s Done step says it, and the owner is told nothing',
    async (code, sentence) => {
      shownSteps.length = 0;
      const m = mountHome();
      vi.mocked(commitExport).mockImplementation(() => {
        throw errnoError(code);
      });
      await exportFirstRow(m.controller);
      expect(vi.mocked(commitExport)).toHaveBeenCalledTimes(1);
      expect(shownSteps).toEqual([
        { message: 'Not exported.', details: [sentence], final: 'failed' },
      ]);
      expect(messageOf(m.controller), 'nothing is left on the tab’s row').toBeUndefined();
      expect(m.failure, 'the work owner was not told of a fault').not.toHaveBeenCalled();
      expect(m.onError).not.toHaveBeenCalled();
      expect(m.onExit).not.toHaveBeenCalled();
      expect(m.controller.getSnapshot().nativeActionBusy).toBe(false);
      expect(m.controller.getSnapshot().screen?.kind, 'the tab is still there').toBe('tab-host');
      expect(JSON.stringify(m.controller.getSnapshot())).not.toContain('SECRET');
    },
  );

  it('a fault that is no errno still reaches the owner: the double is wired, so the silence above is a result', async () => {
    const m = mountHome();
    const bug = new Error('a bug in the writer');
    vi.mocked(commitExport).mockImplementation(() => {
      throw bug;
    });
    await exportFirstRow(m.controller);
    expect(m.entered, 'the action ran under the owner').toHaveBeenCalledTimes(1);
    expect(m.failure).toHaveBeenCalledTimes(1);
    expect(m.failure).toHaveBeenCalledWith(bug);
    expect(m.controller.getSnapshot().notice).toBe('Export could not be completed.');
  });
});
