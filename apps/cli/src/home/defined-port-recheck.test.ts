/**
 * The Home's export card asks the rule about global state AGAIN at the write (PR #102 review, P2 table): the card stays open for as long
 * as a person takes, and the shell's check-to-write gap of microseconds is not this one. The import card's commit has always done it;
 * the export card's did not. Real files, real port, real commit: only the time between the card's answer and its Yes is arranged.
 */
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { GlobalOptions } from '../process/options.js';
import type { ExportPrepared } from '../render/tui/export-card.js';
import { createExportPort } from './defined-port.js';

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

let root = '';
let home = '';
let project = '';
let cwd = '';
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'relavium-export-recheck-')));
  home = join(root, 'home');
  project = join(root, 'project');
  // The Home runs in a subdirectory of the project, as a person's shell often is.
  cwd = join(project, 'work');
  mkdirSync(join(home, '.relavium'), { recursive: true });
  mkdirSync(join(project, '.relavium', 'workflows'), { recursive: true });
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(project, '.relavium', 'workflows', 'code-review.relavium.yaml'), WORKFLOW);
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const global = (): GlobalOptions => ({
  json: false,
  color: false,
  cwd,
  configPath: undefined,
  verbosity: 'normal',
});

function prepared(): Extract<ExportPrepared, { ok: true }> {
  const result = createExportPort({ global: global(), homeDir: home }).prepare('code-review');
  if (!result.ok) throw new Error(`the export was not prepared: ${result.reason}`);
  return result;
}

describe('the export card’s commit', () => {
  it('writes the destination it showed when nothing changed', () => {
    const result = prepared();
    expect(result.commit()).toEqual({
      ok: true,
      written: "Exported workflow 'code-review' to code-review.relavium.yaml.",
    });
    expect(readFileSync(join(cwd, 'code-review.relavium.yaml'), 'utf8')).toContain(
      'id: code-review',
    );
  });

  it.skipIf(process.platform === 'win32')(
    'refuses, in the rule’s own words and with nothing written, a destination that has since come to lead into global configuration',
    () => {
      const result = prepared();
      // The card is open for as long as a person takes. Meanwhile the project directory is moved aside and a link to the operator's own
      // global configuration (which holds a directory of the same name as the working directory) takes its place.
      mkdirSync(join(home, '.relavium', 'work'), { recursive: true });
      renameSync(project, join(root, 'project-moved'));
      symlinkSync(join(home, '.relavium'), project);
      const attempt = result.commit();
      expect(attempt).toEqual({
        ok: false,
        reason:
          'The project artifact resolves into home or global configuration. Use a project-owned path and remove links into global state.',
      });
      expect(
        readdirSync(join(home, '.relavium', 'work')),
        'nothing was written into global state',
      ).toEqual([]);
    },
  );
});
