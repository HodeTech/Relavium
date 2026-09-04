import { isAbsolute } from 'node:path';

import { describe, expect, it } from 'vitest';

import { sourceLabel } from './source-label.js';

describe('sourceLabel', () => {
  // The parsers put this into error messages the CLI promotes to the user, so an absolute path here is a
  // disclosure in something that also reaches logs and `--json` consumers.
  it('is relative to the caller`s cwd for a file inside it', () => {
    expect(sourceLabel('/work/project', '/work/project/flows/a.yaml')).toBe('flows/a.yaml');
  });

  it('never returns an absolute path, whatever it is given', () => {
    // The property that matters, asserted directly. The `isAbsolute` branch exists for the Windows case —
    // `relative()` returns an ABSOLUTE path across drives — which cannot be reproduced here, because
    // `node:path` resolves to its posix implementation and reads `C:\\work` as an ordinary filename. So the
    // guard is pinned by its contract rather than by that one platform's trigger.
    for (const [cwd, file] of [
      ['/work/project', '/work/project/a.yaml'],
      ['/work/project', '/etc/passwd'],
      ['/work/project', '/work/project'],
      ['/', '/a.yaml'],
    ] as ReadonlyArray<readonly [string, string]>) {
      expect(isAbsolute(sourceLabel(cwd, file))).toBe(false);
      expect(sourceLabel(cwd, file)).not.toBe('');
    }
  });

  it('falls back to the basename when the two paths are equal (relative returns "")', () => {
    expect(sourceLabel('/work/a.yaml', '/work/a.yaml')).toBe('a.yaml');
  });

  it('does not disclose the directory above the cwd beyond the relative hops', () => {
    const label = sourceLabel('/work/project', '/work/other/a.yaml');
    expect(label).not.toContain('/work/other');
    expect(label.startsWith('..')).toBe(true);
  });
});
