/**
 * What `/import` says when it refuses a path, as a person reads it (MVP-11 unit 6, round 2: OB-6, CO-5): the thing that is not a file is named,
 * a syntax error is said once, two readings that both failed are each one issue, and a path outside the project is shown as it was typed, not
 * as the `../../..` ladder the command names it by. The cut of a long reason is `import-port-cut.test.ts`'s.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { GlobalOptions } from '../process/options.js';
import { createImportPort } from './import-port.js';

let root = '';
let home = '';
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'relavium-import-refusals-'));
  home = mkdtempSync(join(tmpdir(), 'relavium-import-refusals-home-'));
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
function refused(pathText: string): string {
  const result = createImportPort({ global: global(), homeDir: home }).prepare(pathText);
  if (result.ok) throw new Error('the import was prepared, and should have been refused');
  return result.reason;
}
const occurrences = (text: string, part: string): number => text.split(part).length - 1;
/** Whether every `(` of `text` has its `)`, and no `)` comes before its `(`. */
function balanced(text: string): boolean {
  let open = 0;
  for (const character of text) {
    if (character === '(') open += 1;
    if (character === ')') open -= 1;
    if (open < 0) return false;
  }
  return open === 0;
}

describe('a path that is not a file says which thing it is', () => {
  it.each(['.', './', './/'])(
    'OB-6a the working directory (typed as %j) is named, not left as an empty subject before `is not a regular file`',
    (typed) => {
      const reason = refused(typed);
      expect(reason).toBe('That path is not a regular file');
      expect(reason.startsWith(' '), 'no empty subject').toBe(false);
    },
  );

  it('OB-6a a directory the person named keeps its own name in the sentence', () => {
    expect(refused('.relavium')).toBe('.relavium is not a regular file');
  });
});

describe('a file both readings refuse says what is wrong once', () => {
  it('OB-6b a YAML syntax error is said once, with its position, not once as a workflow and again as an agent', () => {
    writeFileSync(join(root, 'broken.yaml'), 'id: x\nprovider: [unclosed\n  - a\nmodel: 3\n');
    const reason = refused('broken.yaml');
    const syntax = 'must be sufficiently indented and end with a ]';
    expect(occurrences(reason, syntax), reason).toBe(1);
    expect(reason).toMatch(
      /^broken\.yaml is not a valid workflow or agent \(.+ \(line \d+, column \d+\)\)\.$/su,
    );
    expect(occurrences(reason, 'broken.yaml'), 'the file is named once').toBe(1);
    expect(balanced(reason)).toBe(true);
  });

  it('OB-6c two readings that fail on different grounds are one issue each, whole and closed, never an agent’s list cut in the middle of a phrase', () => {
    writeFileSync(
      join(root, 'badid.yaml'),
      "schema_version: '1.0'\nworkflow:\n  id: Bad_ID\n  nodes: []\n  edges: []\n",
    );
    const reason = refused('badid.yaml');
    expect(reason).toMatch(/^badid\.yaml is not a valid workflow \(id: must be kebab-case /u);
    // the agent reading's second and third issues are not listed (nor cut): the first issue says what that reading refused
    expect(reason).not.toContain('model: missing');
    expect(reason).not.toContain('provider: missing');
    expect(reason).toMatch(
      /\) or agent \(id: missing — expected string \(and \d+ more issues?\)\)\.$/u,
    );
    expect(reason.length).toBeLessThanOrEqual(240);
    expect(balanced(reason)).toBe(true);
  });

  it('OB-6c an agent-shaped file with a bad id is told the same way: the first issue of each reading', () => {
    writeFileSync(join(root, 'badagent.yaml'), 'id: Bad_ID\n');
    const reason = refused('badagent.yaml');
    expect(reason).toMatch(
      /^badagent\.yaml is not a valid workflow \(.+\) or agent \(id: must be kebab-case /u,
    );
    expect(reason).not.toContain('invalid agent');
    expect(reason).not.toContain('provider:');
    expect(balanced(reason)).toBe(true);
    expect(reason.endsWith(').')).toBe(true);
  });

  it('OB-6c a reason with a shape the sentence does not have is said as the command said it', () => {
    writeFileSync(join(root, 'plain.relavium.yaml'), 'id: Bad_ID\n');
    const reason = refused('plain.relavium.yaml');
    expect(reason).not.toContain('is not a valid workflow');
    expect(reason.length).toBeGreaterThan(0);
  });
});

describe.skipIf(process.platform === 'win32')(
  'a path outside the project is named as it was typed',
  () => {
    it('OB-6d an absolute path is shown whole, not as the ladder of `..` the command names it by', () => {
      expect(refused('/relavium-nonexistent/x.yaml')).toBe(
        'no file at /relavium-nonexistent/x.yaml',
      );
    });

    it('OB-6d `~` stays `~`, not the climb from the working directory to the operator home', () => {
      expect(refused('~/nonexistent.yaml')).toBe('no file at ~/nonexistent.yaml');
    });

    it('OB-6d a path that stays in the project is shown as the command shows it (clean, from the working directory)', () => {
      expect(refused('./sub/../nope.yaml')).toBe('no file at nope.yaml');
    });

    it('OB-6d a typed path is scrubbed and bounded like any text a person wrote', () => {
      const rlo = String.fromCharCode(0x202e);
      const reason = refused(
        `/relavium-nonexistent/evil${rlo}gnp/${'a-very-long-directory-name/'.repeat(20)}x.yaml`,
      );
      expect(reason).not.toContain(rlo);
      expect(reason.startsWith('no file at /relavium-nonexistent/evil')).toBe(true);
      expect(reason.length).toBeLessThanOrEqual(240);
      expect(reason.endsWith('…')).toBe(true);
    });
  },
);
