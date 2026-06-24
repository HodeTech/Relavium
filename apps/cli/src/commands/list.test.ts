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
});
