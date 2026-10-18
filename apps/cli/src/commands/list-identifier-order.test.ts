import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createClient, runMigrations } from '@relavium/db';
import { describe, expect, it } from 'vitest';

import { captureIo, seedRun } from '../test-support.js';
import type { CatalogEntry } from '../workflows/catalog.js';
import { listCommand, type ListCommandDeps } from './list.js';

describe('actual list tag identifier order', () => {
  it('[LIST-TAG-IDENTIFIERS] keeps exact ordinal headers, every bucket membership and untagged last', async () => {
    const project = mkdtempSync(join(tmpdir(), 'relavium-list-order-'));
    mkdirSync(join(project, '.relavium'));
    const client = createClient(':memory:');
    runMigrations(client.db);
    const { io, out, err } = captureIo();
    const catalog: CatalogEntry[] = [
      {
        slug: 'untagged',
        name: 'Untagged fixture',
        tags: [],
        path: '.relavium/workflows/untagged.yaml',
        valid: true,
      },
      {
        slug: 'multi-tag',
        name: 'Multi tag fixture',
        tags: ['a_b', 'a-b', 'a', 'Z'],
        path: '.relavium/workflows/multi-tag.yaml',
        valid: true,
      },
    ];
    const deps: ListCommandDeps = {
      io,
      global: {
        json: false,
        color: false,
        cwd: project,
        configPath: undefined,
        verbosity: 'normal',
      },
      openDb: () => ({ db: client.db, close: () => {} }),
      discoverCatalog: () => catalog,
    };
    try {
      await seedRun(client.db, { slug: 'multi-tag', runId: 'r-order', state: 'completed' });
      expect(listCommand({ agents: false }, deps)).toBe(0);
      const lines = out().split('\n');
      expect(
        lines.filter((line) => /^ {2}(?:#|\(untagged\))/.test(line)),
        '[LIST-TAG-HEADERS] complete header lines avoid #a prefix collisions',
      ).toEqual(['  #Z', '  #a', '  #a-b', '  #a_b', '  (untagged)']);
      const tagged = lines.filter((line) => line.startsWith('    multi-tag '));
      expect(tagged).toHaveLength(4);
      expect(tagged.every((line) => line.includes('[last: completed]'))).toBe(true);
      const untagged = lines.filter((line) => line.startsWith('    untagged '));
      expect(untagged).toHaveLength(1);
      expect(untagged[0]).toContain('[last: —]');
      expect(lines.filter((line) => line.startsWith('    ')).at(-1)).toBe(untagged[0]);
      expect(err()).toBe('');
    } finally {
      client.sqlite.close();
      rmSync(project, { recursive: true, force: true });
    }
  });
});
