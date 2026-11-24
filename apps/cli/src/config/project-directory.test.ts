/**
 * The project-directory rules take the operator home as an ARGUMENT and have no default for it (PR #102 review H2): a call that was
 * never handed one used to judge a path by the real home of whoever runs the process, so a test, a caller added later or an
 * indirect call (`create` once did) read `~/.relavium` without saying so. Each call site names the home it means; a command resolves
 * the process's own at its boundary.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isCliError } from '../process/errors.js';
import {
  PROJECT_DIRECTORY_REMEDY,
  assertProjectArtifactPath,
  resolveProjectDirectory,
} from './project-directory.js';

let root = '';
let home = '';
let project = '';
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'relavium-project-directory-')));
  home = join(root, 'home');
  project = join(root, 'project');
  mkdirSync(join(home, '.relavium'), { recursive: true });
  mkdirSync(join(project, '.relavium'), { recursive: true });
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const refusalOf = (run: () => unknown): string | undefined => {
  try {
    run();
    return undefined;
  } catch (cause) {
    if (!isCliError(cause)) throw cause;
    return cause.message;
  }
};

describe('the home is an argument, not a default', () => {
  it('both rules declare it as a required parameter (a default would make the declared length shorter)', () => {
    // `Function#length` counts the parameters before the first one with a default value: `home = homedir()` would make these 1 and 0.
    expect(assertProjectArtifactPath.length).toBe(2);
    expect(resolveProjectDirectory.length).toBe(3);
  });

  it('a path is judged against the home it is handed: the same path is a project inside one home and global state inside another', () => {
    const inside = join(project, '.relavium', 'agents', 'a.agent.yaml');
    expect(() => assertProjectArtifactPath(inside, home)).not.toThrow();
    // The project IS this home's global configuration: the same path now resolves into it.
    const alias = join(project, '.relavium', 'agents', 'b.agent.yaml');
    expect(refusalOf(() => assertProjectArtifactPath(alias, project))).toBe(
      'The project artifact resolves into home or global configuration. Use a project-owned path and remove links into global state.',
    );
  });

  it('resolveProjectDirectory refuses a working directory that is the handed home, and finds the project under any other', () => {
    expect(resolveProjectDirectory(project, home)).toBe(join(project, '.relavium'));
    expect(refusalOf(() => resolveProjectDirectory(project, project))).toBe(
      PROJECT_DIRECTORY_REMEDY,
    );
  });

  it('a home that cannot be resolved is a refusal, not a fall back to the real one', () => {
    writeFileSync(join(root, 'file'), 'x');
    expect(refusalOf(() => resolveProjectDirectory(project, join(root, 'file', 'nowhere')))).toBe(
      'The project directory could not be resolved safely. Check directory access and symbolic links, then retry.',
    );
  });
});
