/**
 * Two guards of the Home's import port that the real command never lets a case through (MVP-11 unit 6, round 1: test gaps A01, A02, A04, and the
 * device-name rule). `prepareImport` is replaced here by a hostile PLAN (the one case a test cannot make by a real file: a destination the command
 * would have refused), so what the port draws as the Done step's target is read from the plan alone:
 *
 * - the target is the destination relative to the project's root, and where that cannot be said (a sibling of the root, anything above it, a path that is
 *   not relative on this platform) the port names the plan's own display text and never an absolute path;
 * - a workflow or an agent whose own id is a name Windows reserves for a device (`con`, `nul`, `com1`) is refused before the card asks, on every platform,
 *   with the command's sentence, and nothing is written.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { prepareImport, type ImportPlan } from '../commands/import.js';
import type { GlobalOptions } from '../process/options.js';
import type { ImportPrepared } from '../render/tui/import-card.js';
import { createImportPort } from './import-port.js';

vi.mock('../commands/import.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../commands/import.js')>();
  return { ...actual, prepareImport: vi.fn(actual.prepareImport) };
});

const AGENT = (id: string): string => `id: ${id}
provider: anthropic
model: claude-sonnet-4-6
system_prompt: Review the code.
`;

let root = '';
let home = '';
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'relavium-import-guards-'));
  home = mkdtempSync(join(tmpdir(), 'relavium-import-guards-home-'));
  mkdirSync(join(root, '.relavium'), { recursive: true });
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
const port = () => createImportPort({ global: global(), homeDir: home });
const everything = (dir: string, prefix = ''): string[] =>
  readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) =>
      entry.isDirectory()
        ? [
            `${prefix}${entry.name}/`,
            ...everything(join(dir, entry.name), `${prefix}${entry.name}/`),
          ]
        : [`${prefix}${entry.name}`],
    )
    .sort();

/** What the card is shown as the target for a plan whose destination is `target`: its `display` is the fallback the port may name instead. */
function targetFor(target: string, display: string): string {
  const projectConfigDir = join(root, '.relavium');
  const plan: ImportPlan = {
    kind: 'agent',
    slug: 'reviewer',
    source: 'incoming.agent.yaml',
    target,
    targetDisplay: display,
    projectConfigDir,
    content: AGENT('reviewer'),
    bytes: AGENT('reviewer').length,
    force: false,
    warnings: [],
  };
  vi.mocked(prepareImport).mockReturnValueOnce(plan);
  const result: ImportPrepared = port().prepare('incoming.agent.yaml');
  if (!result.ok) throw new Error(`the import was not prepared: ${result.reason}`);
  return result.offer.target;
}

describe('the Done step’s target is relative to the project’s root, or the display text, never an absolute path (A01, A02)', () => {
  it('a destination inside the root is named from the root, with / between its parts', () => {
    expect(targetFor(join(root, '.relavium', 'agents', 'reviewer.agent.yaml'), 'DISPLAY')).toBe(
      '.relavium/agents/reviewer.agent.yaml',
    );
  });

  it('a name that merely STARTS with two dots is a folder of the project, not a way out of it', () => {
    expect(targetFor(join(root, '..config', 'reviewer.agent.yaml'), 'DISPLAY')).toBe(
      '..config/reviewer.agent.yaml',
    );
  });

  // The root itself and the root's parent are directories that exist: the port's own occupant check refuses them before the target is named
  // (`takenReason`), so `projectRelative`'s `rel === ''` and `rel === '..'` arms cannot be reached through `prepare`, and are not pinned here.

  it('a sibling of the root is outside it (the relative path starts with ..${sep}): the display text is named', () => {
    const sibling = join(resolve(root, '..'), 'another-project', 'reviewer.agent.yaml');
    expect(targetFor(sibling, 'DISPLAY-SIBLING')).toBe('DISPLAY-SIBLING');
  });

  it('something above the root’s parent is outside it too', () => {
    expect(targetFor(join(resolve(root, '..', '..'), 'x.yaml'), 'DISPLAY-ABOVE')).toBe(
      'DISPLAY-ABOVE',
    );
  });

  // `relative` never answers an absolute path on POSIX; on Windows it does for another drive. This case is the one the platform can make.
  it.runIf(process.platform === 'win32')(
    'on Windows a destination on another drive is not relative to the root: the display text is named',
    () => {
      const other = root.startsWith('D:') ? 'E:' : 'D:';
      expect(targetFor(`${other}${sep}elsewhere${sep}reviewer.agent.yaml`, 'DISPLAY-DRIVE')).toBe(
        'DISPLAY-DRIVE',
      );
    },
  );
});

describe('an id Windows reserves for a device is refused before the card asks (any platform)', () => {
  it.each(['con', 'prn', 'aux', 'nul', 'com1', 'lpt9'])(
    'an agent whose id is %s is refused with the command’s sentence, and nothing is written',
    (id) => {
      writeFileSync(join(root, 'incoming.agent.yaml'), AGENT(id));
      const before = everything(root);
      const result = port().prepare('incoming.agent.yaml');
      expect(result.ok).toBe(false);
      expect(result.ok ? '' : result.reason).toContain(
        `'${id}' is a device name on Windows, so no file can be named after it`,
      );
      expect(everything(root), 'nothing was written').toEqual(before);
      expect(existsSync(join(root, '.relavium', 'agents', `${id}.agent.yaml`))).toBe(false);
    },
  );

  it('an ordinary id is not mistaken for one (the guard is the exact name)', () => {
    writeFileSync(join(root, 'incoming.agent.yaml'), AGENT('console'));
    expect(port().prepare('incoming.agent.yaml').ok).toBe(true);
  });
});
