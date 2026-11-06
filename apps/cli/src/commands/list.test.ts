import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createClient, runMigrations, type Db, type DbClient } from '@relavium/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { EXIT_CODES } from '../process/exit-codes.js';
import type { GlobalOptions } from '../process/options.js';
import { captureIo, parseNdjson, seedRun } from '../test-support.js';
import type { CatalogEntry } from '../workflows/catalog.js';
import { listCommand, type ListCommandDeps } from './list.js';

describe('listCommand', () => {
  let client: DbClient;
  let db: Db;
  let projectDir: string; // a temp dir that contains a `.relavium/` so project discovery succeeds

  beforeEach(() => {
    client = createClient(':memory:');
    runMigrations(client.db);
    db = client.db;
    projectDir = mkdtempSync(join(tmpdir(), 'relavium-list-'));
    mkdirSync(join(projectDir, '.relavium'));
  });
  afterEach(() => {
    client.sqlite.close();
    rmSync(projectDir, { recursive: true, force: true });
  });

  function globalOptions(cwd: string, json = false): GlobalOptions {
    return { json, color: false, cwd, configPath: undefined, verbosity: 'normal' };
  }

  function deps(
    io: ReturnType<typeof captureIo>['io'],
    opts: {
      readonly json?: boolean;
      readonly catalog: readonly CatalogEntry[];
      readonly cwd?: string;
    },
  ): ListCommandDeps {
    return {
      io,
      global: globalOptions(opts.cwd ?? projectDir, opts.json ?? false),
      openDb: () => ({ db, close: () => {} }),
      discoverCatalog: () => [...opts.catalog],
    };
  }

  const WORKFLOWS: CatalogEntry[] = [
    {
      slug: 'code-review',
      name: 'Code Review',
      tags: ['review'],
      path: '.relavium/workflows/code-review.relavium.yaml',
      valid: true,
    },
    {
      slug: 'hello',
      name: 'Hello',
      tags: [],
      path: '.relavium/workflows/hello.relavium.yaml',
      valid: true,
    },
  ];

  it('--runs lists every recorded run newest first with its workflow slug, outside any project (MVP-1)', async () => {
    await seedRun(db, { slug: 'code-review', runId: 'r-old', state: 'completed', atMs: 1_000 });
    await seedRun(db, { slug: 'hello', runId: 'r-new', state: 'failed', atMs: 2_000 });
    const outside = mkdtempSync(join(tmpdir(), 'relavium-list-runs-'));
    try {
      const human = captureIo();
      expect(
        listCommand({ agents: false, runs: true }, deps(human.io, { catalog: [], cwd: outside })),
      ).toBe(EXIT_CODES.success);
      const lines = human.out().trim().split('\n');
      expect(lines).toHaveLength(2);
      expect(lines[0]).toMatch(/^r-new {2}failed {5}hello {2}/u);
      expect(lines[1]).toMatch(/^r-old {2}completed {2}code-review {2}/u);
      const machine = captureIo();
      listCommand(
        { agents: false, runs: true },
        deps(machine.io, { catalog: [], cwd: outside, json: true }),
      );
      const records = parseNdjson(machine.out());
      expect(records.map((record) => record['runId'])).toEqual(['r-new', 'r-old']);
      expect(records[1]).toMatchObject({
        kind: 'runs',
        workflow: 'code-review',
        status: 'completed',
      });
      expect(records[1]).not.toHaveProperty('totalCostMicrocents');
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('--runs reports an empty history plainly', () => {
    const { io, out } = captureIo();
    expect(listCommand({ agents: false, runs: true }, deps(io, { catalog: [] }))).toBe(
      EXIT_CODES.success,
    );
    expect(out()).toBe('No runs recorded.\n');
  });

  it('groups workflows by tag and overlays last-run status from durable history', async () => {
    const { io, out } = captureIo();
    await seedRun(db, { slug: 'code-review', runId: 'r1', state: 'completed' }); // last-run overlay

    expect(listCommand({ agents: false }, deps(io, { catalog: WORKFLOWS }))).toBe(
      EXIT_CODES.success,
    );
    const text = out();
    expect(text).toContain('#review');
    expect(text).toContain('code-review');
    expect(text).toContain('[last: completed]'); // the seeded run's status
    expect(text).toContain('(untagged)');
    expect(text).toContain('[last: —]'); // `hello` was never run
  });

  it('--json emits one NDJSON record per workflow, lastRun null when never run', async () => {
    const { io, out } = captureIo();
    await seedRun(db, { slug: 'code-review', runId: 'r1', state: 'completed' });

    listCommand({ agents: false }, deps(io, { catalog: WORKFLOWS, json: true }));
    const records = parseNdjson<{
      kind: string;
      slug: string;
      lastRun: { status: string } | null;
    }>(out());
    expect(records).toHaveLength(2);
    expect(records.every((r) => r.kind === 'workflows')).toBe(true);
    expect(records.find((r) => r.slug === 'code-review')?.lastRun?.status).toBe('completed');
    expect(records.find((r) => r.slug === 'hello')?.lastRun).toBeNull();
  });

  it('lists agents (no last-run overlay) under --agents', () => {
    const { io, out } = captureIo();
    const agents: CatalogEntry[] = [
      {
        slug: 'summarizer',
        name: 'Summarizer',
        tags: [],
        path: '.relavium/agents/summarizer.agent.yaml',
        valid: true,
      },
    ];

    expect(listCommand({ agents: true }, deps(io, { catalog: agents }))).toBe(EXIT_CODES.success);
    const text = out();
    expect(text).toContain('Agents (1)');
    expect(text).toContain('summarizer');
    expect(text).not.toContain('last:'); // agents have no runs
  });

  it('flags an unparseable catalog entry rather than hiding it', () => {
    const { io, out } = captureIo();
    const catalog: CatalogEntry[] = [
      {
        slug: 'broken',
        name: undefined,
        tags: [],
        path: '.relavium/workflows/broken.yaml',
        valid: false,
        error: 'invalid agent: id',
      },
    ];
    listCommand({ agents: false }, deps(io, { catalog }));
    expect(out()).toContain('broken');
    expect(out()).toContain('(invalid');
  });

  it('SANITIZES a parse reason before it reaches the terminal', () => {
    // A parse reason is artifact-derived by definition — it names fields an author wrote — and this line
    // goes to `process.stdout.write` with no `renderError` boundary in front of it. A review reproduced
    // `ESC[2J` and `U+202E` on a real terminal through exactly this path, twice per line.
    const { io, out } = captureIo();
    const catalog: CatalogEntry[] = [
      {
        slug: 'broken',
        name: undefined,
        tags: [],
        path: '.relavium/workflows/broken.yaml',
        valid: false,
        error: 'invalid: \u001b[2J\u001b[1;31mPWNED\u202edrowssap',
      },
    ];
    listCommand({ agents: false }, deps(io, { catalog }));
    const text = out();
    expect(text).toContain('(invalid');
    expect(text).not.toContain('\u001b'); // no CSI / OSC reaches the terminal
    expect(text).not.toContain('\u202e'); // nor a Trojan-Source bidi override
  });

  it('SANITIZES every catalog name, tag and file-name slug before it reaches the terminal', () => {
    // `/export` writes a session's title as `workflow.name`, and a cloned repository can commit any name, tag
    // or file name: a window-title OSC, a screen clear or a bidi override must not reach the terminal through
    // a workflow line, a tag header or an agent line.
    const hostile = '\u001b]0;PWNED\u0007\u001b[2J\u202e';
    const workflows: CatalogEntry[] = [
      {
        slug: 'fix-bug',
        name: `fix ${hostile} bug`,
        tags: [`ops${hostile}`],
        path: '.relavium/workflows/fix-bug.relavium.yaml',
        valid: true,
      },
      {
        slug: `stem${hostile}`,
        name: undefined,
        tags: [],
        path: `.relavium/workflows/stem${hostile}.relavium.yaml`,
        valid: false,
        error: 'invalid: workflow.id',
      },
    ];
    const agents: CatalogEntry[] = [
      {
        slug: 'helper',
        name: `Helper ${hostile}`,
        tags: [],
        path: '.relavium/agents/helper.agent.yaml',
        valid: true,
      },
    ];
    for (const [isAgents, catalog] of [
      [false, workflows],
      [true, agents],
    ] as const) {
      const { io, out } = captureIo();
      listCommand({ agents: isAgents }, deps(io, { catalog }));
      const text = out();
      expect(text).toContain(isAgents ? 'helper' : 'fix-bug');
      expect(text).not.toContain('\u001b');
      expect(text).not.toContain('\u0007');
      expect(text).not.toContain('\u202e');
    }
    const { io, out } = captureIo();
    listCommand({ agents: false }, deps(io, { catalog: workflows }));
    const lines = out().split('\n');
    expect(lines.some((line) => line.startsWith('  #ops'))).toBe(true);
    expect(lines.some((line) => line.includes('— fix ') && line.endsWith(' bug  [last: —]'))).toBe(
      true,
    );
    expect(lines.some((line) => line.startsWith('    stem') && line.includes('(invalid'))).toBe(
      true,
    );
  });

  it('does not borrow a real workflow last-run for an invalid entry sharing its slug', async () => {
    const { io, out } = captureIo();
    // Seed a completed run for the real 'code-review' workflow. The catalog has a VALID entry ('hello', so the
    // history db IS opened) PLUS an INVALID file whose filename-stem fallback slug collides with 'code-review'
    // — the invalid entry must NOT inherit that run's status (its slug is not a trusted workflow id).
    await seedRun(db, { slug: 'code-review', runId: 'r1', state: 'completed' });
    const catalog: CatalogEntry[] = [
      {
        slug: 'hello',
        name: 'Hello',
        tags: [],
        path: '.relavium/workflows/hello.relavium.yaml',
        valid: true,
      },
      {
        slug: 'code-review',
        name: undefined,
        tags: [],
        path: '.relavium/workflows/code-review.relavium.yaml',
        valid: false,
        error: 'invalid',
      },
    ];
    listCommand({ agents: false }, deps(io, { catalog }));
    const lines = out().split('\n');
    const brokenLine = lines.find((l) => l.includes('code-review'));
    expect(brokenLine).toContain('(invalid');
    expect(brokenLine).not.toContain('[last: completed]'); // must NOT borrow the real workflow's run
    expect(brokenLine).toContain('[last: —]'); // shows no trusted history instead
  });

  it('reports an empty catalog clearly', () => {
    const { io, out } = captureIo();
    expect(listCommand({ agents: false }, deps(io, { catalog: [] }))).toBe(EXIT_CODES.success);
    expect(out()).toContain('No workflows found');
  });

  it('reports clearly when not inside a .relavium/ project (exit 0)', () => {
    const { io, out } = captureIo();
    const outside = mkdtempSync(join(tmpdir(), 'relavium-noproj-'));
    try {
      expect(listCommand({ agents: false }, deps(io, { catalog: [], cwd: outside }))).toBe(
        EXIT_CODES.success,
      );
      expect(out()).toContain('No .relavium/ project found');
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('prints a directory name with control characters on one line, on stdout and under --json on stderr', () => {
    const outside = mkdtempSync(join(tmpdir(), 'relavium-noproj-'));
    const hostile = join(outside, 'x\u001b]0;PWNED\u0007\u001b[2J');
    mkdirSync(hostile);
    try {
      const human = captureIo();
      listCommand({ agents: false }, deps(human.io, { catalog: [], cwd: hostile }));
      expect(human.out()).toContain('No .relavium/ project found from ');
      expect(human.out()).not.toContain('\u001b');
      expect(human.out()).not.toContain('\u0007');
      const machine = captureIo();
      listCommand({ agents: false }, deps(machine.io, { catalog: [], cwd: hostile, json: true }));
      expect(machine.err()).toContain('no .relavium/ project found from ');
      expect(machine.err()).not.toContain('\u001b');
      expect(machine.err()).not.toContain('\u0007');
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('--runs prints history identifiers with control characters on one line', async () => {
    await seedRun(db, {
      slug: 'wf\u001b[2J\u202e',
      runId: 'r\u001b]0;PWNED\u0007',
      state: 'completed',
    });
    const { io, out } = captureIo();
    listCommand({ agents: false, runs: true }, deps(io, { catalog: [] }));
    const text = out();
    expect(text).toMatch(/^r.*completed {2}wf/u);
    expect(text).not.toContain('\u001b');
    expect(text).not.toContain('\u0007');
    expect(text).not.toContain('\u202e');
  });
});
