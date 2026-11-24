/**
 * The Home's import port ([ADR-0140](../../../../docs/decisions/0140-management-browsers-the-run-drill-down-and-the-durable-run-detail.md)
 * §9, MVP-8 step 5, increment 6): the path as a person types it, and what `prepare` and its commit do over a real temporary project. The
 * card that draws it is proved in `render/tui/import-card.test.ts`; the errno table and "no read for a path that is refused" are proved
 * in `import-port-faults.test.ts`, which has to replace the command's two halves.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { GlobalOptions } from '../process/options.js';
import type { ImportPrepared } from '../render/tui/import-card.js';
import {
  IMPORT_PATH_LIMIT,
  createImportPort,
  expandImportPath,
  importPathIssue,
} from './import-port.js';

const AGENT = `# a comment the canonical copy drops
id: reviewer
provider: anthropic
model: claude-sonnet-4-6
system_prompt: Review the code.
`;
const WORKFLOW = `schema_version: '1.0'
workflow:
  id: reviewer
  nodes:
    - { id: s, type: input }
    - { id: o, type: output }
  edges:
    - { from: s, to: o }
`;
const LITERAL = 'sk-importedSyntheticCredential123456789';
const AGENT_PATH = '.relavium/agents/reviewer.agent.yaml';

let root = '';
let home = '';
let outside = '';
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'relavium-import-port-'));
  home = mkdtempSync(join(tmpdir(), 'relavium-import-port-home-'));
  outside = mkdtempSync(join(tmpdir(), 'relavium-import-port-out-'));
  mkdirSync(join(root, '.relavium'), { recursive: true });
  writeFileSync(join(root, 'incoming.agent.yaml'), AGENT);
});
afterEach(() => {
  for (const dir of [root, home, outside]) rmSync(dir, { recursive: true, force: true });
});

const global = (): GlobalOptions => ({
  json: false,
  color: false,
  cwd: root,
  configPath: undefined,
  verbosity: 'normal',
});
const port = () => createImportPort({ global: global(), homeDir: home });
const target = (): string => join(root, AGENT_PATH);
/** Everything under the project, recursively and sorted. */
function tree(dir: string, prefix = ''): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) =>
      entry.isDirectory()
        ? [`${prefix}${entry.name}/`, ...tree(join(dir, entry.name), `${prefix}${entry.name}/`)]
        : [`${prefix}${entry.name}`],
    )
    .sort();
}
function prepared(pathText: string): Extract<ImportPrepared, { ok: true }> {
  const result = port().prepare(pathText);
  if (!result.ok) throw new Error(`the import was not prepared: ${result.reason}`);
  return result;
}
function refused(pathText: string): string {
  const result = port().prepare(pathText);
  if (result.ok) throw new Error('the import was prepared, and should have been refused');
  return result.reason;
}
const REPLACE = 'To replace it, run relavium import --force with the same file.';

describe('the path as typed: bounded, no control characters, never empty', () => {
  it('accepts a path up to the bound and refuses one character over it', () => {
    expect(importPathIssue('a'.repeat(IMPORT_PATH_LIMIT))).toBeUndefined();
    expect(importPathIssue('a'.repeat(IMPORT_PATH_LIMIT + 1))).toBe(
      'The path is longer than 1,024 characters.',
    );
    expect(IMPORT_PATH_LIMIT).toBe(1024);
  });

  it.each([
    ['NUL', 'a\u0000b.yaml'],
    ['a tab', 'a\tb.yaml'],
    ['a newline', 'a\nb.yaml'],
    ['a carriage return', 'a\rb.yaml'],
    ['ESC (an ANSI sequence)', 'a\u001b[31mb.yaml'],
    ['DEL', 'a\u007fb.yaml'],
    ['a C1 control (NEL)', 'a\u0085b.yaml'],
    ['a C1 control (CSI)', 'a\u009bb.yaml'],
    ['the line separator U+2028', `a${String.fromCharCode(0x2028)}b.yaml`],
    ['the paragraph separator U+2029', `a${String.fromCharCode(0x2029)}b.yaml`],
  ])('refuses %s anywhere in the path', (_name, text) => {
    expect(importPathIssue(text)).toBe('The path has a control character in it.');
    // The port holds a caller that skips the field to the same rule, and never reads.
    expect(port().prepare(text)).toEqual({
      ok: false,
      reason: 'The path has a control character in it.',
    });
  });

  it.each(['', '   ', ' \u00a0 '])('refuses an empty path (%j)', (text) => {
    expect(importPathIssue(text)).toBe('Type the path of a workflow or agent YAML file.');
  });

  it('accepts what a path legitimately holds: spaces inside, non-ASCII, and a leading ~', () => {
    for (const text of ['my file.yaml', 'dökümanlar/ajan.yaml', '日本語/設定.yaml', '~/a b.yaml'])
      expect(importPathIssue(text), text).toBeUndefined();
  });

  it('drops blanks around the path and expands a leading ~ to the operator home, alone or before a separator', () => {
    expect(expandImportPath('  incoming.agent.yaml  ', '/home/op')).toBe('incoming.agent.yaml');
    expect(expandImportPath('~', '/home/op')).toBe('/home/op');
    expect(expandImportPath('~/in/a.yaml', '/home/op')).toBe(join('/home/op', 'in', 'a.yaml'));
    expect(expandImportPath(' ~/a.yaml ', '/home/op')).toBe(join('/home/op', 'a.yaml'));
    // Not another person's home, and not a ~ in the middle: those are names like any other.
    expect(expandImportPath('~other/a.yaml', '/home/op')).toBe('~other/a.yaml');
    expect(expandImportPath('x/~/a.yaml', '/home/op')).toBe('x/~/a.yaml');
    expect(expandImportPath('a~', '/home/op')).toBe('a~');
    expect(expandImportPath('/abs/a.yaml', '/home/op')).toBe('/abs/a.yaml');
    expect(expandImportPath('rel/a.yaml', '/home/op')).toBe('rel/a.yaml');
    if (sep === '\\') expect(expandImportPath('~\\a.yaml', 'C:\\op')).toBe('C:\\op\\a.yaml');
  });
});

describe('prepare reads and validates through the command’s own first half, and writes nothing', () => {
  it('a relative path is read from the Home’s working directory', () => {
    const before = tree(root);
    const result = prepared('incoming.agent.yaml');
    expect(result.offer).toEqual({
      kind: 'agent',
      slug: 'reviewer',
      source: 'incoming.agent.yaml',
      destination: AGENT_PATH,
      bytes: Buffer.byteLength(
        'id: reviewer\nmodel: claude-sonnet-4-6\nprovider: anthropic\nsystem_prompt: Review the code.\n',
        'utf8',
      ),
      warnings: [],
    });
    expect(tree(root), 'preparing writes nothing').toEqual(before);
  });

  it('an absolute path is read as it is, and its source is shown relative to the working directory', () => {
    writeFileSync(join(outside, 'far.agent.yaml'), AGENT);
    const result = prepared(join(outside, 'far.agent.yaml'));
    expect(result.offer.source).toBe(join('..', outside.split(sep).pop() ?? '', 'far.agent.yaml'));
    expect(result.offer.destination).toBe(AGENT_PATH);
  });

  it('a leading ~ is the operator home the port was given, never the process’s', () => {
    writeFileSync(join(home, 'in-home.agent.yaml'), AGENT);
    mkdirSync(join(home, 'nested'), { recursive: true });
    writeFileSync(join(home, 'nested', 'deep.agent.yaml'), AGENT);
    const viaTilde = prepared('~/in-home.agent.yaml');
    expect(viaTilde.offer.kind).toBe('agent');
    expect(viaTilde.offer.source).toBe(
      join('..', home.split(sep).pop() ?? '', 'in-home.agent.yaml'),
    );
    expect(prepared('~/nested/deep.agent.yaml').offer.slug).toBe('reviewer');
    expect(prepared(' ~/in-home.agent.yaml ').offer.slug, 'blanks around it are dropped').toBe(
      'reviewer',
    );
    // `~` alone is the home directory, which is not a file; ~other is a relative name.
    expect(refused('~')).toMatch(/is not a regular file$/u);
    expect(refused('~other/x.yaml')).toBe('no file at ~other/x.yaml');
    expect(refused('~/missing.yaml')).toMatch(/^no file at \.\..*missing\.yaml$/u);
  });

  it.each([
    ['a missing file', 'nope.yaml', 'no file at nope.yaml'],
    ['a directory', '.relavium', '.relavium is not a regular file'],
  ])('%s is the command’s own refusal, in its words', (_name, path, reason) => {
    expect(refused(path)).toBe(reason);
  });

  it('a file that is not a workflow or an agent is refused with the parser’s words, and nothing is written', () => {
    writeFileSync(join(root, 'mystery.yaml'), 'foo: bar\n');
    writeFileSync(join(root, 'broken.agent.yaml'), 'id: 123\nthis: is: not: valid');
    const before = tree(root);
    expect(refused('mystery.yaml')).toMatch(
      /^mystery\.yaml is not a valid workflow \(.+\) or agent \(/su,
    );
    expect(refused('broken.agent.yaml').length).toBeGreaterThan(0);
    expect(tree(root)).toEqual(before);
  });

  it('a reason is bounded, so a long path in a refusal cannot fill the screen', () => {
    const reason = refused(`${'d/'.repeat(300)}missing.yaml`);
    expect(reason.length).toBeLessThanOrEqual(240);
    expect(reason.endsWith('…')).toBe(true);
  });

  it.skipIf(process.platform === 'win32')(
    'a file whose name holds a bidi override is offered without it, in the source and the refusal alike',
    () => {
      const rlo = String.fromCharCode(0x202e);
      writeFileSync(join(root, `evil${rlo}gnp.agent.yaml`), AGENT);
      const result = prepared(`evil${rlo}gnp.agent.yaml`);
      expect(result.offer.source).toBe('evilgnp.agent.yaml');
      expect(result.offer.source).not.toContain(rlo);
    },
  );

  it('a path with a bidi override is shown without it', () => {
    const rlo = String.fromCharCode(0x202e);
    const reason = refused(`evil${rlo}gnp.yaml`);
    expect(reason).toContain('evil');
    expect(reason).not.toContain(rlo);
  });
});

describe.skipIf(process.platform === 'win32')(
  'a catalog directory that is a link: the card shows where the file really goes',
  () => {
    it('a link that stays inside the project: the `to` row is the real directory, and the write lands there', () => {
      mkdirSync(join(root, '.relavium', 'shared'), { recursive: true });
      symlinkSync(join(root, '.relavium', 'shared'), join(root, '.relavium', 'agents'));
      const result = prepared('incoming.agent.yaml');
      expect(result.offer.destination).toBe('.relavium/shared/reviewer.agent.yaml');
      expect(result.commit()).toEqual({
        ok: true,
        written: "Imported agent 'reviewer' to .relavium/shared/reviewer.agent.yaml.",
      });
      expect(readdirSync(join(root, '.relavium', 'shared'))).toEqual(['reviewer.agent.yaml']);
    });

    it('a link that leaves the project is refused before the card asks (here by the id check, which scans the directory first), and nothing is written there', () => {
      symlinkSync(outside, join(root, '.relavium', 'agents'));
      expect(refused('incoming.agent.yaml')).toBe('could not read the agents catalog directory.');
      expect(readdirSync(outside)).toEqual([]);
    });
  },
);

describe('the card never overwrites: whatever holds the place is a refusal before it asks', () => {
  it('an id the project already has names the shell command that replaces it', () => {
    mkdirSync(join(root, '.relavium', 'agents'), { recursive: true });
    writeFileSync(target(), AGENT);
    const before = tree(root);
    expect(refused('incoming.agent.yaml')).toBe(
      `agent 'reviewer' already exists in this project, and this card never overwrites. ${REPLACE}`,
    );
    expect(tree(root)).toEqual(before);
    expect(readFileSync(target(), 'utf8')).toBe(AGENT);
  });

  it('an id the other kind has is refused in the command’s words, and no --force is offered for it', () => {
    mkdirSync(join(root, '.relavium', 'workflows'), { recursive: true });
    writeFileSync(join(root, '.relavium', 'workflows', 'reviewer.relavium.yaml'), WORKFLOW);
    const reason = refused('incoming.agent.yaml');
    expect(reason).toBe(
      "'reviewer' already exists as a workflow in this project — an id must be unique across agents and workflows; rename one.",
    );
    expect(reason).not.toContain('--force');
  });

  it('a file that sits at the destination without being a valid entry is refused too', () => {
    mkdirSync(join(root, '.relavium', 'agents'), { recursive: true });
    writeFileSync(target(), 'not an agent at all\n');
    expect(refused('incoming.agent.yaml')).toBe(
      `${AGENT_PATH} already exists, and this card never overwrites. ${REPLACE}`,
    );
    expect(readFileSync(target(), 'utf8')).toBe('not an agent at all\n');
  });

  it('a directory at the destination is refused, and no --force is suggested for it', () => {
    mkdirSync(target(), { recursive: true });
    const reason = refused('incoming.agent.yaml');
    expect(reason).toBe(
      `${AGENT_PATH} already exists and is not a regular file, and this card never overwrites. Move it aside, then import again.`,
    );
    expect(reason).not.toContain('--force');
  });

  it.skipIf(process.platform === 'win32')(
    'a link at the destination is refused before the card asks, and what it points at is never written',
    () => {
      mkdirSync(join(root, '.relavium', 'agents'), { recursive: true });
      const victim = join(outside, 'victim.yaml');
      writeFileSync(victim, 'untouched\n');
      symlinkSync(victim, target());
      expect(refused('incoming.agent.yaml')).toBe(
        `${AGENT_PATH} already exists and is not a regular file, and this card never overwrites. Move it aside, then import again.`,
      );
      expect(readFileSync(victim, 'utf8')).toBe('untouched\n');
      expect(readFileSync(victim, 'utf8')).not.toContain('reviewer');
    },
  );

  it.skipIf(process.platform === 'win32')(
    'a dangling link at the destination is refused too, and nothing is created through it',
    () => {
      mkdirSync(join(root, '.relavium', 'agents'), { recursive: true });
      const missing = join(outside, 'missing.yaml');
      symlinkSync(missing, target());
      // The command's own destination rule refuses a link it cannot resolve, in its words, before the card could.
      expect(refused('incoming.agent.yaml')).toMatch(
        /^The project artifact target could not be resolved safely\./u,
      );
      expect(existsSync(missing)).toBe(false);
    },
  );
});

describe('the commit writes exactly the prepared bytes, once, and says where', () => {
  it('writes the canonical content and returns the sentence the Home shows', () => {
    const result = prepared('incoming.agent.yaml');
    expect(existsSync(target())).toBe(false);
    const attempt = result.commit();
    expect(attempt).toEqual({
      ok: true,
      written: `Imported agent 'reviewer' to ${AGENT_PATH}.`,
    });
    const written = readFileSync(target());
    expect(written.toString('utf8')).toBe(
      'id: reviewer\nmodel: claude-sonnet-4-6\nprovider: anthropic\nsystem_prompt: Review the code.\n',
    );
    expect(written).toHaveLength(result.offer.bytes);
  });

  it('keeps a literal as written and shows the command’s notice without the value', () => {
    writeFileSync(join(root, 'secret.agent.yaml'), AGENT.replace('Review the code.', LITERAL));
    const result = prepared('secret.agent.yaml');
    expect(result.offer.warnings).toHaveLength(1);
    expect(result.offer.warnings[0]).toBe(
      'Warning: authored definition has 1 string(s) matching known credential shapes. Authored content is preserved in files and run snapshots; review literals before sharing or running. This check is best effort.',
    );
    expect(JSON.stringify(result.offer)).not.toContain(LITERAL);
    expect(result.commit().ok).toBe(true);
    expect(readFileSync(target(), 'utf8')).toContain(LITERAL);
  });

  it('a file that appeared since the card was drawn is kept, and the refusal is in the card’s words', () => {
    const result = prepared('incoming.agent.yaml');
    mkdirSync(join(root, '.relavium', 'agents'), { recursive: true });
    writeFileSync(target(), 'someone else wrote this\n');
    expect(result.commit()).toEqual({
      ok: false,
      reason: `${AGENT_PATH} already exists, and this card never overwrites. ${REPLACE}`,
    });
    expect(readFileSync(target(), 'utf8')).toBe('someone else wrote this\n');
  });

  it('an id that appeared since under another name is refused at the write, in the words the prepare used, and nothing is written', () => {
    const result = prepared('incoming.agent.yaml');
    mkdirSync(join(root, '.relavium', 'agents'), { recursive: true });
    // Another valid file declares the same id; the name `wx` guards is free, so only the id's rule can refuse.
    writeFileSync(join(root, '.relavium', 'agents', 'renamed.agent.yaml'), AGENT);
    const before = tree(root);
    const sentence = `agent 'reviewer' already exists in this project, and this card never overwrites. ${REPLACE}`;
    expect(result.commit()).toEqual({ ok: false, reason: sentence });
    expect(existsSync(target()), 'the destination was not created').toBe(false);
    expect(tree(root)).toEqual(before);
    // The prepare says the very same thing about that project now.
    expect(refused('incoming.agent.yaml')).toBe(sentence);
  });

  it('the other kind’s id that appeared since is refused at the write in the command’s words, and nothing is written', () => {
    const result = prepared('incoming.agent.yaml');
    mkdirSync(join(root, '.relavium', 'workflows'), { recursive: true });
    writeFileSync(join(root, '.relavium', 'workflows', 'reviewer.relavium.yaml'), WORKFLOW);
    const before = tree(root);
    const attempt = result.commit();
    expect(attempt).toEqual({
      ok: false,
      reason:
        "'reviewer' already exists as a workflow in this project — an id must be unique across agents and workflows; rename one.",
    });
    expect(existsSync(target())).toBe(false);
    expect(tree(root)).toEqual(before);
  });

  it('a directory that appeared since is kept, with no --force suggested', () => {
    const result = prepared('incoming.agent.yaml');
    mkdirSync(target(), { recursive: true });
    const attempt = result.commit();
    expect(attempt.ok).toBe(false);
    if (attempt.ok) return;
    expect(attempt.reason).toBe(
      `${AGENT_PATH} already exists and is not a regular file, and this card never overwrites. Move it aside, then import again.`,
    );
  });

  it.skipIf(process.platform === 'win32')(
    'a link that appeared since is not written through, and what it points at is untouched',
    () => {
      const result = prepared('incoming.agent.yaml');
      mkdirSync(join(root, '.relavium', 'agents'), { recursive: true });
      const victim = join(outside, 'victim.yaml');
      writeFileSync(victim, 'untouched\n');
      symlinkSync(victim, target());
      const attempt = result.commit();
      expect(attempt.ok).toBe(false);
      expect(readFileSync(victim, 'utf8')).toBe('untouched\n');
    },
  );

  it.skipIf(process.platform === 'win32')(
    'a link put in the destination’s directory since the card was drawn, into global configuration, is refused again at the write',
    () => {
      const result = prepared('incoming.agent.yaml');
      // The card is open for as long as a person takes; meanwhile the project's `.relavium` becomes a link to the operator's own.
      mkdirSync(join(home, '.relavium', 'agents'), { recursive: true });
      rmSync(join(root, '.relavium'), { recursive: true, force: true });
      symlinkSync(join(home, '.relavium'), join(root, '.relavium'));
      const attempt = result.commit();
      expect(attempt.ok).toBe(false);
      if (attempt.ok) return;
      expect(attempt.reason).toBe(
        'The project artifact resolves into home or global configuration. Use a project-owned path and remove links into global state.',
      );
      expect(readdirSync(join(home, '.relavium', 'agents')), 'nothing was written there').toEqual(
        [],
      );
    },
  );

  it.skipIf(process.platform === 'win32')(
    'a link put in the destination’s directory since the card was drawn, out of the project, is refused at the write in fixed words, and nothing is written there',
    () => {
      const result = prepared('incoming.agent.yaml');
      // The card is open for as long as a person takes; meanwhile the project's `agents` becomes a link to a directory elsewhere.
      symlinkSync(outside, join(root, '.relavium', 'agents'));
      const attempt = result.commit();
      expect(attempt).toEqual({
        ok: false,
        reason: 'The target directory is a link that leaves the project: .relavium/agents.',
      });
      expect(readdirSync(outside), 'nothing was written through the link').toEqual([]);
    },
  );

  it('a destination whose parent is a file is the command’s refusal, not a claim that the file is taken', () => {
    const result = prepared('incoming.agent.yaml');
    writeFileSync(join(root, '.relavium', 'agents'), 'a file where the catalog directory goes\n');
    const attempt = result.commit();
    expect(attempt.ok).toBe(false);
    if (attempt.ok) return;
    expect(attempt.reason).not.toContain('this card never overwrites');
    expect(readFileSync(join(root, '.relavium', 'agents'), 'utf8')).toBe(
      'a file where the catalog directory goes\n',
    );
  });
});
