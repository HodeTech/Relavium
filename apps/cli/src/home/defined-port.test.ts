/**
 * The `/workflows` popup's read ([ADR-0140](../../../../docs/decisions/0140-management-browsers-the-run-drill-down-and-the-durable-run-detail.md)
 * §2, MVP-8 step 4, increment 4b): the catalog and the pins in, rows that name their entries by index out. The export half of the same
 * file is proved with the card in `render/tui/export-card.test.ts`, over a real temporary project.
 */
import type { RunStatus } from '@relavium/shared';
import { describe, expect, it, vi } from 'vitest';

import type { CatalogEntry } from '../workflows/catalog.js';
import { createDefinedPort } from './defined-port.js';

const entry = (slug: string, over: Partial<CatalogEntry> = {}): CatalogEntry => ({
  slug,
  name: undefined,
  tags: [],
  path: `.relavium/workflows/${slug}.relavium.yaml`,
  valid: true,
  ...over,
});

describe('createDefinedPort', () => {
  it('reads the catalog and the pins now, every time, and names each catalog row’s entry by its index', () => {
    let entries = [entry('alpha', { nodeCount: 2 }), entry('beta')];
    const list = vi.fn(() => entries);
    const pins = vi.fn(() => [
      { kind: 'workflow' as const, ref: 'beta', rowid: 4, oversized: false },
    ]);
    const port = createDefinedPort({ catalog: { list }, pins });

    const first = port.read();
    expect(first.model.rows.map((row) => [row.slug, row.pinned, row.entryIndex])).toEqual([
      ['beta', true, 1],
      ['alpha', false, 0],
    ]);
    expect(first.slugOf(0)).toBe('alpha');
    expect(first.slugOf(1)).toBe('beta');
    expect(first.slugOf(2), 'no entry sits there').toBeUndefined();
    expect(first.slugOf(-1)).toBeUndefined();
    // The path is the catalog's own for the same entry (the raw path a launch compares, not a row's sanitized label).
    expect(first.pathOf(0)).toBe('.relavium/workflows/alpha.relavium.yaml');
    expect(first.pathOf(1)).toBe('.relavium/workflows/beta.relavium.yaml');
    expect(first.pathOf(2), 'no entry sits there').toBeUndefined();
    expect(first.pathOf(-1)).toBeUndefined();

    // The catalog changed: a read already taken keeps naming the entries it listed, and the next read lists the new ones.
    entries = [entry('gamma')];
    expect(first.slugOf(0)).toBe('alpha');
    const second = port.read();
    expect(second.slugOf(0)).toBe('gamma');
    expect(list).toHaveBeenCalledTimes(2);
    expect(pins).toHaveBeenCalledTimes(2);
    // The pin of a workflow the catalog lost stays as a row of its own, and has no entry to name.
    expect(second.model.rows.map((row) => [row.slug, row.state, row.entryIndex])).toEqual([
      ['beta', 'not-in-catalog', undefined],
      ['gamma', 'ready', 0],
    ]);
  });

  it('names the root of a pin of another project from ~ when it was given the directory and the home (ADR-0145 §8)', () => {
    const otherPin = { kind: 'workflow' as const, ref: 'deploy', rowid: 9, oversized: false };
    const read = (paths?: { cwd: string; home: string }) =>
      createDefinedPort({
        catalog: { list: () => [] },
        pins: () => [],
        allPins: () => [{ ...otherPin, projectRoot: '/home/ada/other' }],
        ...(paths === undefined ? {} : { paths }),
      })
        .read()
        .model.rows.map((row) => row.projectRoot);
    expect(read({ cwd: '/home/ada/work/app', home: '/home/ada' })).toEqual(['~/other']);
    expect(read()).toEqual(['/home/ada/other']);
  });

  it('adds each workflow’s latest run, by slug, to a ready row only, and shows none when no read is given', () => {
    const catalog = { list: () => [entry('alpha'), entry('torn', { valid: false, error: 'bad' })] };
    const at = '2026-11-27T10:00:00.000Z';
    const latestRuns = vi.fn(
      () =>
        new Map<string, { status: RunStatus; at: string }>([
          ['alpha', { status: 'completed', at }],
          ['torn', { status: 'failed', at }],
        ]),
    );
    const withRuns = createDefinedPort({ catalog, pins: () => [], latestRuns }).read();
    expect(
      withRuns.model.rows.map((row) => [
        row.slug,
        row.lastRunStatus,
        row.lastRunGlyph,
        row.lastRunAt,
      ]),
    ).toEqual([
      ['alpha', 'completed', '✓', at],
      ['torn', undefined, undefined, undefined], // a file that did not parse borrows no run
    ]);
    expect(latestRuns, 'status and age come from ONE read').toHaveBeenCalledTimes(1);
    const without = createDefinedPort({ catalog, pins: () => [] }).read();
    expect(without.model.rows.map((row) => row.lastRunStatus)).toEqual([undefined, undefined]);
  });

  it('lists the workflow pins of other projects as rows, the run pins of the store not at all', () => {
    const mine = {
      kind: 'workflow' as const,
      ref: 'beta',
      rowid: 4,
      oversized: false,
      projectRoot: '/p',
    };
    const other = {
      kind: 'workflow' as const,
      ref: 'x',
      rowid: 5,
      oversized: false,
      projectRoot: '/q',
    };
    const run = { kind: 'run' as const, ref: 'run-1', rowid: 6, oversized: false, projectRoot: '' };
    const read = createDefinedPort({
      catalog: { list: () => [entry('beta')] },
      pins: () => [mine],
      allPins: () => [mine, other, run],
    }).read();
    expect(read.model.rows.map((row) => [row.slug, row.state])).toEqual([
      ['beta', 'ready'],
      ['x', 'other-project'],
    ]);
  });

  it('lets a failing catalog or a failing pin read throw, so the tab says it cannot list rather than draw half of it', () => {
    const boom = (): never => {
      throw new Error('boom');
    };
    expect(() => createDefinedPort({ catalog: { list: boom }, pins: () => [] }).read()).toThrow(
      'boom',
    );
    expect(() => createDefinedPort({ catalog: { list: () => [] }, pins: boom }).read()).toThrow(
      'boom',
    );
  });
});
