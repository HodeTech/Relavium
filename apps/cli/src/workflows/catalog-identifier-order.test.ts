import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { discoverCatalog, type CatalogKind } from './catalog.js';

function valid(kind: CatalogKind, id: string): string {
  return kind === 'workflows'
    ? `schema_version: '1.0'\nworkflow:\n  id: ${id}\n  name: Fixture ${id}\n  tags: [greeting]\n  nodes:\n    - { id: a, type: input }\n    - { id: b, type: output }\n  edges:\n    - { from: a, to: b }\n`
    : `id: ${id}\nname: Fixture ${id}\nmodel: claude-sonnet-4-6\nprovider: anthropic\nsystem_prompt: Summarize the input.\n`;
}

describe('disk catalog identifier ordering', () => {
  for (const kind of ['workflows', 'agents'] satisfies CatalogKind[]) {
    it(`[CATALOG-IDENTIFIERS] ${kind} orders invalid mixed-case fallback stems alongside valid kebab IDs`, () => {
      const project = mkdtempSync(join(tmpdir(), 'relavium-catalog-order-'));
      const configDir = join(project, '.relavium');
      const dir = join(configDir, kind);
      mkdirSync(dir, { recursive: true });
      try {
        for (const id of ['a_b', 'a-b', 'a', 'Z']) {
          // Mixed-case/underscore values are filenames of deliberately INVALID documents, never fake
          // valid authored identifiers. Their fallback stems are real catalog-visible identifiers.
          const body =
            id === 'Z' || id === 'a_b' ? 'id: synthetic-invalid-private-value\n' : valid(kind, id);
          writeFileSync(join(dir, `${id}.yaml`), body, 'utf8');
        }
        const entries = discoverCatalog({ projectConfigDir: configDir, cwd: project, kind });
        expect(
          entries.map(({ slug }) => slug),
          '[CATALOG-ORDINAL] actual disk discovery sorts fallback and authored identifiers together',
        ).toEqual(['Z', 'a', 'a-b', 'a_b']);
        expect(entries.map(({ path }) => path)).toEqual([
          join('.relavium', kind, 'Z.yaml'),
          join('.relavium', kind, 'a.yaml'),
          join('.relavium', kind, 'a-b.yaml'),
          join('.relavium', kind, 'a_b.yaml'),
        ]);
        expect(entries.map(({ valid: isValid }) => isValid)).toEqual([false, true, true, false]);
        for (const entry of entries.filter(({ valid: isValid }) => isValid)) {
          expect(entry.name).toBe(`Fixture ${entry.slug}`);
          expect(entry.tags).toEqual(kind === 'workflows' ? ['greeting'] : []);
          expect(entry.error).toBeUndefined();
        }
        for (const entry of entries.filter(({ valid: isValid }) => !isValid)) {
          expect(entry.name).toBeUndefined();
          expect(entry.tags).toEqual([]);
          expect(entry.error).toMatch(kind === 'workflows' ? /^schema_version:/ : /model: missing/);
          expect(entry.error).not.toContain('synthetic-invalid-private-value');
        }
      } finally {
        rmSync(project, { recursive: true, force: true });
      }
    });
  }
});
