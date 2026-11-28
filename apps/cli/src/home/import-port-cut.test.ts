/**
 * The bounds of a refusal's cut in the import port (`cutAtWord`, `closedWithin`, `openParentheses` of `import-port.ts`): a reason is whole at the
 * bound, one column over it is cut to the bound with an ellipsis, and a `)` with no `(` before it is no negative depth (it once made the cut
 * throw a `RangeError`, which ended the Home on a path a person had typed: MVP-11 unit 6, round 2).
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { GlobalOptions } from '../process/options.js';
import { createImportPort } from './import-port.js';

let root = '';
let home = '';
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'relavium-import-cut-'));
  home = mkdtempSync(join(tmpdir(), 'relavium-import-cut-home-'));
  mkdirSync(join(root, '.relavium'), { recursive: true });
});
afterEach(() => {
  for (const dir of [root, home]) rmSync(dir, { recursive: true, force: true });
});
const global = (): GlobalOptions => ({
  json: false,
  color: false,
  cwd: root,
  configPath: undefined,
  verbosity: 'normal',
});
/** The refusal for a file that is not there: `no file at <path>` (11 columns of words, then the path as typed). */
function refused(pathText: string): string {
  const result = createImportPort({ global: global(), homeDir: home }).prepare(pathText);
  if (result.ok) throw new Error('the import was prepared, and should have been refused');
  return result.reason;
}
const WORDS = 'no file at '.length;
/** The most columns a refusal shows. */
const REASON_BOUND = 240;

describe('the bounds of a refusal’s cut (240 columns)', () => {
  it('a reason of exactly the bound is whole; one column over is cut to exactly the bound, ending with an ellipsis', () => {
    const exact = 'd'.repeat(REASON_BOUND - WORDS);
    expect(refused(exact)).toBe(`no file at ${exact}`);
    const over = refused('d'.repeat(REASON_BOUND + 1 - WORDS));
    expect(over.length, 'the ellipsis fills the last column of the bound').toBe(REASON_BOUND);
    expect(over.endsWith('d…')).toBe(true);
  });

  it('a stray `)` before any `(` is no negative depth: the cut closes nothing and does not throw', () => {
    const reason = refused(`) ${'abcdefgh '.repeat(40).trimEnd()}.yaml`);
    expect(reason.length).toBeLessThanOrEqual(REASON_BOUND);
    expect(reason.endsWith('…')).toBe(true);
    expect(reason).not.toMatch(/…\)/u);
  });
});
