import {
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MAX_SOURCE_CHARS } from '@relavium/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { isCliError } from '../process/errors.js';
import { EXIT_CODES } from '../process/exit-codes.js';
import { MAX_CATALOG_FILES, MAX_CATALOG_SCAN_BYTES, discoverCatalog } from './catalog.js';

vi.mock('node:fs', async (original) => {
  const native = await original<typeof import('node:fs')>();
  return {
    ...native,
    openSync: vi.fn(native.openSync),
    readSync: vi.fn(native.readSync),
    readdirSync: vi.fn(native.readdirSync),
  };
});

const VALID_WORKFLOW = `schema_version: '1.0'
workflow:
  id: hello
  name: Hello
  tags: [greeting]
  nodes:
    - { id: a, type: input }
    - { id: b, type: output }
  edges:
    - { from: a, to: b }
`;

const INVALID_WORKFLOW = `schema_version: '1.0'
workflow:
  nodes: []
`;

const VALID_AGENT = `id: summarizer
name: Summarizer
model: claude-sonnet-4-6
provider: anthropic
system_prompt: Summarize the input.
`;

// A workflow that interpolates a `secret`-typed input into agent text → WorkflowSecretLeakError at parse.
const SECRET_LEAK_WORKFLOW = `schema_version: '1.0'
workflow:
  id: leaky
  inputs:
    - name: api_key
      type: secret
  agents:
    - id: ag
      model: claude-sonnet-4-6
      provider: anthropic
      system_prompt: 'system'
  nodes:
    - id: n
      type: agent
      agent_ref: ag
      prompt_template: 'use {{inputs.api_key}}'
  edges: []
`;

describe('discoverCatalog', () => {
  let proj: string;
  let configDir: string;
  // The operator home every read is admitted against: a fresh directory, never the real one (it is a required argument).
  let home: string;

  beforeEach(() => {
    proj = mkdtempSync(join(tmpdir(), 'relavium-catalog-'));
    home = mkdtempSync(join(tmpdir(), 'relavium-catalog-home-'));
    configDir = join(proj, '.relavium');
    mkdirSync(configDir);
    vi.clearAllMocks();
  });
  afterEach(() => {
    rmSync(proj, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  function write(kind: 'workflows' | 'agents', name: string, body: string): void {
    const dir = join(configDir, kind);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, name), body, 'utf8');
  }

  it('parses valid workflows (id, name, tags) and flags an unparseable one', () => {
    write('workflows', 'hello.relavium.yaml', VALID_WORKFLOW);
    write('workflows', 'broken.relavium.yaml', INVALID_WORKFLOW);

    const entries = discoverCatalog({
      projectConfigDir: configDir,
      cwd: proj,
      homeDir: home,
      kind: 'workflows',
    });
    expect(entries.map((e) => e.slug)).toEqual(['broken', 'hello']); // sorted by slug

    const hello = entries.find((e) => e.slug === 'hello');
    expect(hello?.valid).toBe(true);
    expect(hello?.name).toBe('Hello');
    expect(hello?.tags).toEqual(['greeting']);
    expect(hello?.path).toBe(join('.relavium', 'workflows', 'hello.relavium.yaml')); // cwd-relative

    const broken = entries.find((e) => e.slug === 'broken'); // slug falls back to the filename stem
    expect(broken?.valid).toBe(false);
    expect(broken?.error).toBeTruthy();
  });

  it('parses agents (no tags) under the agents kind', () => {
    write('agents', 'summarizer.agent.yaml', VALID_AGENT);

    const entries = discoverCatalog({
      projectConfigDir: configDir,
      cwd: proj,
      homeDir: home,
      kind: 'agents',
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.slug).toBe('summarizer');
    expect(entries[0]?.name).toBe('Summarizer');
    expect(entries[0]?.valid).toBe(true);
    expect(entries[0]?.tags).toEqual([]);
  });

  it('returns an empty catalog for a missing directory', () => {
    // No `workflows/` was created under .relavium/.
    expect(
      discoverCatalog({ projectConfigDir: configDir, cwd: proj, homeDir: home, kind: 'workflows' }),
    ).toEqual([]);
  });

  it('flags an invalid agent file (only valid agents are listed clean)', () => {
    write('agents', 'broken.agent.yaml', 'id: Not_Kebab\nmodel: m\n'); // missing required fields + bad id

    const entries = discoverCatalog({
      projectConfigDir: configDir,
      cwd: proj,
      homeDir: home,
      kind: 'agents',
    });
    const broken = entries.find((e) => e.slug === 'broken'); // slug falls back to the filename stem
    expect(broken?.valid).toBe(false);
    expect(broken?.error).toBeTruthy();
  });

  it('surfaces the YAML syntax line/column in a broken agent entry (Step 13, end-to-end via parseReason)', () => {
    write('agents', 'syntax.agent.yaml', 'id: x\n  : : :'); // a genuine YAML SYNTAX fault (not a schema miss)

    const entries = discoverCatalog({
      projectConfigDir: configDir,
      cwd: proj,
      homeDir: home,
      kind: 'agents',
    });
    const broken = entries.find((e) => e.slug === 'syntax');
    expect(broken?.valid).toBe(false);
    // parseReason passes the AgentParseError.message through — so the position Step 13 attached is visible on
    // the catalog surface (the discipline: field paths / integers only, never an authored value).
    expect(broken?.error).toMatch(/line \d+, column \d+/);
  });

  it('throws an exit-2 invocation error when the catalog path is not a directory (ENOTDIR)', () => {
    // A regular file where the `workflows/` directory is expected → readdirSync raises ENOTDIR (not ENOENT),
    // which is a real fault, not an empty catalog. Cross-platform (no chmod/perms needed).
    writeFileSync(join(configDir, 'workflows'), 'not a directory', 'utf8');

    try {
      discoverCatalog({ projectConfigDir: configDir, cwd: proj, homeDir: home, kind: 'workflows' });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(isCliError(err)).toBe(true);
      if (isCliError(err)) {
        expect(err.code).toBe('invalid_invocation');
        expect(err.exitCode).toBe(EXIT_CODES.invalidInvocation);
        expect(err.message).toMatch(/could not read the workflows catalog/);
      }
    }
  });

  it('flags a secret-taint workflow as invalid, surfacing only the taint path (no value)', () => {
    write('workflows', 'leaky.relavium.yaml', SECRET_LEAK_WORKFLOW);

    const entries = discoverCatalog({
      projectConfigDir: configDir,
      cwd: proj,
      homeDir: home,
      kind: 'workflows',
    });
    const leaky = entries.find((e) => e.slug === 'leaky'); // slug falls back to the filename stem
    expect(leaky?.valid).toBe(false);
    // The reason is the field-named WorkflowSecretLeakError message — a taint PATH (`inputs.api_key`), the
    // symbol reference, never a resolved value (there is none at parse time). `parseReason` only echoes a
    // typed WorkflowParseError/AgentParseError message, so no arbitrary error text reaches the entry.
    expect(leaky?.error).toContain('inputs.api_key');
  });

  describe('the size of one catalog directory', () => {
    function writeMany(count: number): void {
      for (let n = 0; n < count; n += 1) {
        const id = `wf-${String(n).padStart(4, '0')}`;
        write('workflows', `${id}.relavium.yaml`, VALID_WORKFLOW.replace('id: hello', `id: ${id}`));
      }
    }

    it('is 500 files: the number commands.md and home.md state', () => {
      expect(MAX_CATALOG_FILES).toBe(500);
    });

    // Five hundred files are written and parsed one by one: the explicit bound keeps a slow Windows runner off the default's edge.
    it('lists a directory of exactly the cap, every file of it', { timeout: 20_000 }, () => {
      writeMany(MAX_CATALOG_FILES);
      const entries = discoverCatalog({
        projectConfigDir: configDir,
        cwd: proj,
        homeDir: home,
        kind: 'workflows',
      });
      expect(entries).toHaveLength(MAX_CATALOG_FILES);
      expect(entries.every((entry) => entry.valid)).toBe(true);
    });

    it('refuses a directory one file over the cap with "too many workflow files", before opening any of them', () => {
      writeMany(MAX_CATALOG_FILES + 1);
      vi.mocked(openSync).mockClear();
      let caught: unknown;
      try {
        discoverCatalog({
          projectConfigDir: configDir,
          cwd: proj,
          homeDir: home,
          kind: 'workflows',
        });
      } catch (error) {
        caught = error;
      }
      expect(isCliError(caught), 'a refusal the surfaces already show as output').toBe(true);
      if (!isCliError(caught)) return;
      expect(caught.code).toBe('invalid_invocation');
      expect(caught.message).toContain('too many workflow files');
      expect(caught.message).toContain(String(MAX_CATALOG_FILES));
      expect(
        openSync,
        'no file was opened: the bound is checked on the names',
      ).not.toHaveBeenCalled();
    });

    it('says "agent" for the agents catalog, and counts only the YAML files of the directory', () => {
      for (let n = 0; n < MAX_CATALOG_FILES + 1; n += 1)
        write('agents', `a-${String(n).padStart(4, '0')}.agent.yaml`, VALID_AGENT);
      expect(() =>
        discoverCatalog({ projectConfigDir: configDir, cwd: proj, homeDir: home, kind: 'agents' }),
      ).toThrow(/too many agent files/);
      // A directory full of other files is not a big catalog.
      for (let n = 0; n < MAX_CATALOG_FILES + 1; n += 1)
        write('workflows', `n-${String(n)}.txt`, 'x');
      expect(
        discoverCatalog({
          projectConfigDir: configDir,
          cwd: proj,
          homeDir: home,
          kind: 'workflows',
        }),
      ).toEqual([]);
    });
  });

  describe('the byte budget of one scan', () => {
    // Under the parser's own character cap (MAX_SOURCE_CHARS), so a padded file is still a VALID workflow and "read normally" shows.
    const FILE_BYTES = 1_900_000;
    const SKIPPED =
      'skipped: the catalog is larger than 16 MiB; move some files out of .relavium/workflows/';

    /** A valid workflow whose first line is one long comment, so the file is exactly `bytes` long: one `Buffer.alloc`, no loop. */
    function paddedWorkflow(id: string, bytes: number): Buffer {
      const body = Buffer.from(VALID_WORKFLOW.replace('id: hello', `id: ${id}`));
      const head = Buffer.from('# ');
      return Buffer.concat([
        head,
        Buffer.alloc(bytes - head.length - body.length - 1, 'x'),
        Buffer.from('\n'),
        body,
      ]);
    }
    function writeBytes(name: string, body: Buffer): void {
      mkdirSync(join(configDir, 'workflows'), { recursive: true });
      writeFileSync(join(configDir, 'workflows', name), body);
    }
    const scan = () =>
      discoverCatalog({ projectConfigDir: configDir, cwd: proj, homeDir: home, kind: 'workflows' });

    it('is 16 MiB, the number the skipped files name', () => {
      expect(MAX_CATALOG_SCAN_BYTES).toBe(16 * 1024 * 1024);
    });

    it('reads the files that fit and refuses the one that crosses the budget, and every file after it, unread', () => {
      // Twelve files in name order: eight fit (15.2 MB), the ninth crosses 16 MiB, the tenth is as big, the eleventh is tiny and would
      // fit in what is left, and the last is a link out of the project that the read would refuse for another reason. All of them are
      // skipped: once the budget is spent, every later file is, and none is even looked at.
      for (let n = 0; n < 10; n += 1) {
        writeBytes(
          `wf-${String(n).padStart(2, '0')}.relavium.yaml`,
          paddedWorkflow(`wf-${String(n).padStart(2, '0')}`, FILE_BYTES),
        );
      }
      writeBytes(
        'wf-10.relavium.yaml',
        Buffer.from(VALID_WORKFLOW.replace('id: hello', 'id: wf-10')),
      );
      writeFileSync(join(proj, 'outside.yaml'), VALID_WORKFLOW);
      symlinkSync(
        join(proj, 'outside.yaml'),
        join(configDir, 'workflows', 'wf-11.relavium.yaml'),
        'file',
      );

      const entries = scan();
      expect(entries.map((e) => [e.slug, e.valid])).toEqual([
        ...Array.from({ length: 8 }, (_, n) => [`wf-0${String(n)}`, true]),
        ['wf-08', false],
        ['wf-09', false],
        ['wf-10', false],
        ['wf-11', false],
      ]);
      expect(entries.slice(0, 8).every((e) => e.nodeCount === 2 && e.error === undefined)).toBe(
        true,
      );
      expect(entries.slice(8).map((e) => e.error)).toEqual([SKIPPED, SKIPPED, SKIPPED, SKIPPED]);
      expect(entries[8]?.path).toBe(join('.relavium', 'workflows', 'wf-08.relavium.yaml'));
      // Refused, not partly read: only the eight files that fit were ever opened.
      const opened = vi
        .mocked(openSync)
        .mock.calls.filter(([path]) => String(path).includes('wf-'));
      expect(opened).toHaveLength(8);
    });

    it('spends the budget in file-name order, whatever order the directory lists the names in', async () => {
      const native = await vi.importActual<typeof import('node:fs')>('node:fs');
      for (let n = 0; n < 10; n += 1) {
        const id = `wf-${String(n).padStart(2, '0')}`;
        writeBytes(`${id}.relavium.yaml`, paddedWorkflow(id, FILE_BYTES));
      }
      const inNameOrder = scan();
      // The directory now lists its names last-first; the first eight BY NAME are still the ones read.
      vi.mocked(readdirSync).mockImplementationOnce((dir, options) =>
        native.readdirSync(dir, options).reverse(),
      );
      expect(scan()).toEqual(inNameOrder);
      expect(inNameOrder.filter((e) => e.valid).map((e) => e.slug)).toEqual(
        Array.from({ length: 8 }, (_, n) => `wf-0${String(n)}`),
      );
    });

    it('gives the same answer on a second read of the same directory', () => {
      for (let n = 0; n < 10; n += 1) {
        writeBytes(
          `wf-${String(n).padStart(2, '0')}.relavium.yaml`,
          paddedWorkflow(`wf-${String(n).padStart(2, '0')}`, FILE_BYTES),
        );
      }
      const first = scan();
      expect(first.filter((e) => e.valid)).toHaveLength(8);
      expect(scan()).toEqual(first);
    });

    it('takes a total of exactly the budget, and refuses a file that would take it one byte past', () => {
      // Eight files of 2 MiB (the parser cap is also 2 Mi characters, so these are valid) are exactly 16 MiB: all read.
      for (let n = 0; n < 8; n += 1) {
        writeBytes(
          `wf-${String(n)}.relavium.yaml`,
          paddedWorkflow(`wf-${String(n)}`, MAX_SOURCE_CHARS),
        );
      }
      expect(scan().every((e) => e.valid)).toBe(true);
      // One more byte of anything after them does not fit.
      writeBytes(
        'wf-9.relavium.yaml',
        Buffer.from(VALID_WORKFLOW.replace('id: hello', 'id: wf-9')),
      );
      const entries = scan();
      expect(entries.filter((e) => e.valid)).toHaveLength(8);
      expect(entries.find((e) => e.slug === 'wf-9')?.error).toBe(SKIPPED);
    });

    it('does not carry a spent budget into the next scan', () => {
      for (let n = 0; n < 10; n += 1) {
        writeBytes(`wf-${String(n)}.relavium.yaml`, paddedWorkflow(`wf-${String(n)}`, FILE_BYTES));
      }
      expect(scan().filter((e) => !e.valid)).toHaveLength(2);
      rmSync(join(configDir, 'workflows'), { recursive: true });
      writeBytes('small.relavium.yaml', Buffer.from(VALID_WORKFLOW));
      expect(scan().map((e) => [e.slug, e.valid])).toEqual([['hello', true]]);
    });

    it('applies to the agents catalog and names its directory', () => {
      mkdirSync(join(configDir, 'agents'), { recursive: true });
      for (let n = 0; n < 10; n += 1) {
        const body = Buffer.from(VALID_AGENT.replace('id: summarizer', `id: ag-${String(n)}`));
        const head = Buffer.from('# ');
        writeFileSync(
          join(configDir, 'agents', `ag-${String(n)}.agent.yaml`),
          Buffer.concat([
            head,
            Buffer.alloc(FILE_BYTES - head.length - body.length - 1, 'x'),
            Buffer.from('\n'),
            body,
          ]),
        );
      }
      const entries = discoverCatalog({
        projectConfigDir: configDir,
        cwd: proj,
        homeDir: home,
        kind: 'agents',
      });
      expect(entries.filter((e) => e.valid)).toHaveLength(8);
      expect(entries.filter((e) => !e.valid).map((e) => e.error)).toEqual([
        SKIPPED.replace('/workflows/', '/agents/'),
        SKIPPED.replace('/workflows/', '/agents/'),
      ]);
    });
  });

  it('ignores non-YAML files', () => {
    write('workflows', 'hello.relavium.yaml', VALID_WORKFLOW);
    write('workflows', 'README.md', '# not a workflow');

    const entries = discoverCatalog({
      projectConfigDir: configDir,
      cwd: proj,
      homeDir: home,
      kind: 'workflows',
    });
    expect(entries.map((e) => e.slug)).toEqual(['hello']);
  });

  it('discovers .relavium.yml files and strips the compound suffix for the slug fallback', () => {
    // An invalid `.relavium.yml` so the slug comes from the filename stem — proving fileStem strips
    // `.relavium.yml` to `review` (not `review.relavium`) and that `.yml` is a discovered extension.
    write('workflows', 'review.relavium.yml', INVALID_WORKFLOW);

    const entries = discoverCatalog({
      projectConfigDir: configDir,
      cwd: proj,
      homeDir: home,
      kind: 'workflows',
    });
    expect(entries.map((e) => e.slug)).toEqual(['review']);
    expect(entries[0]?.valid).toBe(false);
  });

  it('refuses an oversized file from its admitting stat before reading a byte', () => {
    write('workflows', 'big.yaml', 'a'.repeat(MAX_SOURCE_CHARS * 4 + 1));
    const entries = discoverCatalog({
      projectConfigDir: configDir,
      cwd: proj,
      homeDir: home,
      kind: 'workflows',
    });
    expect(entries.map((entry) => ({ valid: entry.valid, error: entry.error }))).toEqual([
      { valid: false, error: 'exceeds the size limit' },
    ]);
    expect(vi.mocked(readSync)).not.toHaveBeenCalled();
  });

  describe('malformed UTF-8 (review P05-2)', () => {
    /** A valid agent whose prompt holds `bytes` (so the file is well formed except for them). */
    function agentWithPromptBytes(bytes: readonly number[]): Buffer {
      return Buffer.concat([
        Buffer.from(
          'id: summarizer\nname: Summarizer\nmodel: claude-sonnet-4-6\nprovider: anthropic\nsystem_prompt: "Summarize ',
        ),
        Buffer.from(bytes),
        Buffer.from(' the input."\n'),
      ]);
    }
    function writeBuffer(kind: 'workflows' | 'agents', name: string, body: Buffer): void {
      mkdirSync(join(configDir, kind), { recursive: true });
      writeFileSync(join(configDir, kind, name), body);
    }

    it.each([
      ['a lone continuation byte', [0x80]],
      ['an invalid start byte', [0xff, 0xfe]],
      ['a truncated three-byte sequence', [0xe2, 0x82]],
      ['an overlong encoding', [0xc0, 0xaf]],
      ['an encoded surrogate', [0xed, 0xa0, 0x80]],
    ])('lists %s as a refused file with a fixed reason, not as a valid entry', (_label, bytes) => {
      writeBuffer('agents', 'bad.agent.yaml', agentWithPromptBytes(bytes));
      const entries = discoverCatalog({
        projectConfigDir: configDir,
        cwd: proj,
        homeDir: home,
        kind: 'agents',
      });
      expect(
        entries.map((entry) => ({ slug: entry.slug, valid: entry.valid, error: entry.error })),
      ).toEqual([{ slug: 'bad', valid: false, error: 'not valid UTF-8' }]);
    });

    it('refuses a workflow the same way', () => {
      writeBuffer(
        'workflows',
        'bad.relavium.yaml',
        Buffer.concat([
          Buffer.from('# '),
          Buffer.from([0xff]),
          Buffer.from('\n'),
          Buffer.from(VALID_WORKFLOW),
        ]),
      );
      const entries = discoverCatalog({
        projectConfigDir: configDir,
        cwd: proj,
        homeDir: home,
        kind: 'workflows',
      });
      expect(entries.map((entry) => [entry.slug, entry.valid, entry.error])).toEqual([
        ['bad', false, 'not valid UTF-8'],
      ]);
    });

    it('still lists well-formed multibyte text, and a file that begins with a byte-order mark, as before', () => {
      writeBuffer('agents', 'wide.agent.yaml', agentWithPromptBytes([...Buffer.from('日本語 €')]));
      writeBuffer(
        'workflows',
        'bom.relavium.yaml',
        Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(VALID_WORKFLOW)]),
      );
      expect(
        discoverCatalog({
          projectConfigDir: configDir,
          cwd: proj,
          homeDir: home,
          kind: 'agents',
        }).map((entry) => [entry.slug, entry.valid]),
      ).toEqual([['summarizer', true]]);
      expect(
        discoverCatalog({
          projectConfigDir: configDir,
          cwd: proj,
          homeDir: home,
          kind: 'workflows',
        }).map((entry) => [entry.slug, entry.valid]),
      ).toEqual([['hello', true]]);
    });
  });

  it('admits a dense multibyte file over the character cap in bytes but within it in characters', () => {
    // Three bytes per character: half the cap in characters is one and a half times it in bytes.
    write('workflows', 'dense.yaml', `# ${'€'.repeat(MAX_SOURCE_CHARS / 2)}\n${VALID_WORKFLOW}`);
    const entries = discoverCatalog({
      projectConfigDir: configDir,
      cwd: proj,
      homeDir: home,
      kind: 'workflows',
    });
    expect(entries.map((entry) => ({ slug: entry.slug, valid: entry.valid }))).toEqual([
      { slug: 'hello', valid: true },
    ]);
  });

  it('flags a symlinked .yaml that resolves to a non-regular file (no readFileSync hang)', () => {
    write('workflows', 'hello.relavium.yaml', VALID_WORKFLOW); // ensures workflows/ exists
    // A `.yaml` symlinked to a DIRECTORY (statSync follows it → not a regular file). The same guard rejects a
    // symlink to a FIFO/character device (e.g. /dev/zero) BEFORE readFileSync — which would otherwise block.
    symlinkSync(configDir, join(configDir, 'workflows', 'loop.yaml'), 'junction');

    const entries = discoverCatalog({
      projectConfigDir: configDir,
      cwd: proj,
      homeDir: home,
      kind: 'workflows',
    });
    const loop = entries.find((e) => e.slug === 'loop');
    expect(loop?.valid).toBe(false);
    expect(loop?.error).toBe('not a regular file');
  });

  it.each(['workflows', 'agents'] as const)(
    'refuses an outside %s catalog directory before listing it (ADR-0105)',
    (kind) => {
      const outside = join(proj, 'outside-catalog');
      mkdirSync(outside);
      writeFileSync(join(outside, 'private.yaml'), VALID_WORKFLOW);
      symlinkSync(outside, join(configDir, kind), 'junction');
      vi.clearAllMocks();

      expect(() =>
        discoverCatalog({ projectConfigDir: configDir, cwd: proj, homeDir: home, kind }),
      ).toThrow(/could not read the .* catalog directory/);
      expect(readdirSync).not.toHaveBeenCalled();
      expect(openSync).not.toHaveBeenCalled();
      expect(readSync).not.toHaveBeenCalled();
    },
  );

  it.each(['workflows', 'agents'] as const)(
    'flags an outside-file symlink in %s before opening or reading its target (ADR-0105)',
    (kind) => {
      const outside = join(proj, 'private.yaml');
      writeFileSync(outside, kind === 'workflows' ? VALID_WORKFLOW : VALID_AGENT);
      mkdirSync(join(configDir, kind));
      symlinkSync(outside, join(configDir, kind, 'escaped.yaml'), 'file');
      vi.clearAllMocks();

      expect(
        discoverCatalog({ projectConfigDir: configDir, cwd: proj, homeDir: home, kind }),
      ).toEqual([
        {
          slug: 'escaped',
          name: undefined,
          tags: [],
          path: join('.relavium', kind, 'escaped.yaml'),
          valid: false,
          error: 'outside the project catalog',
        },
      ]);
      expect(openSync).not.toHaveBeenCalled();
      expect(readSync).not.toHaveBeenCalled();
    },
  );

  it.each(['workflows', 'agents'] as const)(
    'reads a contained-file symlink in %s through the bounded fd path (ADR-0105)',
    (kind) => {
      const target = join(configDir, 'contained-source.txt');
      writeFileSync(target, kind === 'workflows' ? VALID_WORKFLOW : VALID_AGENT);
      mkdirSync(join(configDir, kind));
      symlinkSync(target, join(configDir, kind, 'alias.yaml'), 'file');
      vi.clearAllMocks();

      const entries = discoverCatalog({
        projectConfigDir: configDir,
        cwd: proj,
        homeDir: home,
        kind,
      });
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        slug: kind === 'workflows' ? 'hello' : 'summarizer',
        path: join('.relavium', kind, 'alias.yaml'),
        valid: true,
      });
      expect(openSync).toHaveBeenCalledOnce();
      expect(readSync).toHaveBeenCalled();
    },
  );
});
