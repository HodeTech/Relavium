import { describe, expect, it } from 'vitest';

import type { CatalogEntry } from '../workflows/catalog.js';
import { catalogNotice, costNotice } from './repl-info.js';

const entry = (slug: string, valid = true): CatalogEntry => ({
  slug,
  name: undefined,
  tags: [],
  path: `${slug}.relavium.yaml`,
  valid,
});

describe('costNotice', () => {
  it('formats the cumulative spend in USD (micro-cents → $X.XXXX)', () => {
    expect(costNotice(0)).toBe('Session cost: $0.0000');
    expect(costNotice(5_000_000)).toBe('Session cost: $0.0500');
  });
});

describe('catalogNotice', () => {
  it('groups workflows + agents with counts; flags invalid entries (never drops them)', () => {
    const notice = catalogNotice([entry('deploy'), entry('broken', false)], [entry('coder')]);
    expect(notice).toContain('Workflows (2):');
    expect(notice).toContain('  deploy');
    expect(notice).toContain('  broken (invalid)');
    expect(notice).toContain('Agents (1):');
    expect(notice).toContain('  coder');
  });

  it('an empty kind reads "none"', () => {
    expect(catalogNotice([], [])).toBe('Workflows: none\nAgents: none');
  });

  it('sanitizes a slug so a crafted entry cannot inject control sequences into the notice', () => {
    const notice = catalogNotice([entry(`evil${String.fromCharCode(27)}[31m`)], []);
    expect(notice).not.toContain(String.fromCharCode(27)); // ESC stripped at the display boundary
  });
});
