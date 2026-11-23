import type { RunStatus } from '@relavium/shared';
import { describe, expect, it } from 'vitest';

import {
  DEFINED_ROWS_MAX,
  NOT_IN_CATALOG,
  buildDefinedModel,
  type DefinedEntry,
  type DefinedPin,
  type DefinedRow,
} from './defined-model.js';
import { RUN_STATUS_GLYPH } from './history-model.js';
import { MAX_IDENTIFIER_CHARS } from './run-detail-model.js';

/**
 * The Defined tab's model (MVP-8 step 4): the catalog's workflows with their pins, pinned first, a row for a pin the
 * catalog no longer carries, bounded. A pin's ref comes from `history.db`, which accepts any text, so it is a label:
 * these tests hold that it is shown as sanitized text and never becomes a path.
 */

const ESC = String.fromCharCode(0x1b);
const RLO = String.fromCharCode(0x202e);
const BEL = String.fromCharCode(0x07);

const entry = (slug: string, extra: Partial<DefinedEntry> = {}): DefinedEntry => ({
  slug,
  name: undefined,
  path: `.relavium/workflows/${slug}.relavium.yaml`,
  valid: true,
  nodeCount: 3,
  ...extra,
});

const pin = (ref: string, rowid: number, extra: Partial<DefinedPin> = {}): DefinedPin => ({
  kind: 'workflow',
  ref,
  rowid,
  oversized: false,
  ...extra,
});

/** Every string value of a row, so a check can look at all of them and not at the fields this test remembers. */
function stringsOf(row: DefinedRow): string[] {
  return Object.values(row).filter((value): value is string => typeof value === 'string');
}

// The characters the terminal floor must have removed: controls (C0, DEL, C1) and format characters (bidi, zero-width).
const UNSAFE = /[\p{Cc}\p{Cf}]/u;

describe('buildDefinedModel', () => {
  describe('ordering', () => {
    it('puts pinned rows first in the order of the pins, then the rest in catalog order, each marked', () => {
      const model = buildDefinedModel({
        entries: [entry('alpha'), entry('bravo'), entry('charlie'), entry('delta')],
        // `listPins` order: newest pin first.
        pins: [pin('charlie', 31), pin('alpha', 12)],
      });
      expect(model.rows.map((row) => row.slug)).toEqual(['charlie', 'alpha', 'bravo', 'delta']);
      expect(model.rows.map((row) => row.pinWord)).toEqual([
        'pinned',
        'pinned',
        'unpinned',
        'unpinned',
      ]);
      expect(model.rows.map((row) => row.pinned)).toEqual([true, true, false, false]);
      expect(model.rows.map((row) => row.pinRowid)).toEqual([31, 12, undefined, undefined]);
      expect(model.more).toBe(0);
      expect(model.moreText).toBeUndefined();
      expect(model.total).toBe(4);
    });

    it('lists an unpinned row as unpinned, with no row handle', () => {
      const [row] = buildDefinedModel({ entries: [entry('solo')], pins: [] }).rows;
      expect(row).toMatchObject({ state: 'ready', pinned: false, pinWord: 'unpinned' });
      expect(row).not.toHaveProperty('pinRowid');
    });

    it('ranks a pin that is not in the catalog among the pinned rows by its place in the pin list', () => {
      const model = buildDefinedModel({
        entries: [entry('alpha'), entry('bravo')],
        pins: [pin('alpha', 1), pin('gone', 2), pin('bravo', 3)],
      });
      expect(model.rows.map((row) => row.slug)).toEqual(['alpha', 'gone', 'bravo']);
      expect(model.rows.map((row) => row.state)).toEqual(['ready', 'not-in-catalog', 'ready']);
    });

    it('ignores a pin of another kind', () => {
      const model = buildDefinedModel({
        entries: [entry('alpha')],
        pins: [{ kind: 'run', ref: 'alpha', rowid: 9, oversized: false }],
      });
      expect(model.rows).toHaveLength(1);
      expect(model.rows[0]?.pinned).toBe(false);
    });
  });

  describe('what a row says', () => {
    it('carries the name, the node count and the latest run status with its glyph', () => {
      const lastRuns = new Map<string, RunStatus>([
        ['alpha', 'failed'],
        ['bravo', 'completed'],
      ]);
      const model = buildDefinedModel({
        entries: [
          entry('alpha', { name: 'Alpha flow', nodeCount: 7 }),
          entry('bravo', { nodeCount: 1 }),
          entry('charlie'),
        ],
        pins: [],
        lastRuns,
      });
      expect(model.rows[0]).toMatchObject({
        slug: 'alpha',
        name: 'Alpha flow',
        nodeCount: 7,
        lastRunStatus: 'failed',
        lastRunGlyph: RUN_STATUS_GLYPH.failed,
        path: '.relavium/workflows/alpha.relavium.yaml',
        entryIndex: 0,
      });
      expect(model.rows[1]).toMatchObject({ nodeCount: 1, lastRunStatus: 'completed' });
      // A workflow that never ran has no status, and an entry without a count has none.
      expect(model.rows[2]).not.toHaveProperty('lastRunStatus');
      expect(model.rows[2]).not.toHaveProperty('lastRunGlyph');
    });

    it('shows a file that did not parse with its reason, no count and no last run', () => {
      const [row] = buildDefinedModel({
        entries: [
          entry('broken', {
            valid: false,
            error: 'workflow: at least one node',
            nodeCount: 9,
          }),
        ],
        pins: [],
        lastRuns: new Map<string, RunStatus>([['broken', 'completed']]),
      }).rows;
      expect(row).toMatchObject({ state: 'invalid', note: 'workflow: at least one node' });
      expect(row).not.toHaveProperty('nodeCount');
      expect(row).not.toHaveProperty('lastRunStatus');
    });

    it('drops a node count that is not a count', () => {
      const rows = buildDefinedModel({
        entries: [
          entry('negative', { nodeCount: -1 }),
          entry('fraction', { nodeCount: 2.5 }),
          entry('nan', { nodeCount: Number.NaN }),
          entry('zero', { nodeCount: 0 }),
        ],
        pins: [],
      }).rows;
      expect(rows.map((row) => row.nodeCount)).toEqual([undefined, undefined, undefined, 0]);
    });
  });

  describe('a pin the catalog does not carry', () => {
    it('reads "not in catalog", keeps the pin handle, and knows no path', () => {
      const model = buildDefinedModel({
        entries: [entry('alpha')],
        pins: [pin('renamed-away', 44)],
        lastRuns: new Map<string, RunStatus>([['renamed-away', 'completed']]),
      });
      const [gone] = model.rows;
      expect(gone).toMatchObject({
        state: 'not-in-catalog',
        slug: 'renamed-away',
        note: NOT_IN_CATALOG,
        pinned: true,
        pinWord: 'pinned',
        pinRowid: 44,
        lastRunStatus: 'completed',
      });
      expect(NOT_IN_CATALOG).toBe('not in catalog');
      expect(gone).not.toHaveProperty('path');
      expect(gone).not.toHaveProperty('entryIndex');
      expect(gone).not.toHaveProperty('nodeCount');
    });
  });

  describe('a ref is text, never a path', () => {
    it('shows `../../x` as the text it is, and gives the row no path and no catalog entry', () => {
      const model = buildDefinedModel({
        entries: [entry('alpha')],
        pins: [pin('../../x', 5)],
      });
      const crafted = model.rows.find((row) => row.pinRowid === 5);
      expect(crafted?.slug).toBe('../../x');
      expect(crafted?.state).toBe('not-in-catalog');
      // Nothing about the row is derived from the ref: it has the fields of a pin with no entry, and only those.
      expect(Object.keys(crafted ?? {}).sort()).toEqual(
        ['note', 'pinRowid', 'pinWord', 'pinned', 'slug', 'state'].sort(),
      );
      expect(crafted).not.toHaveProperty('path');
      // The only string that carries the ref is the label.
      expect(stringsOf(crafted as DefinedRow).filter((text) => text.includes('x'))).toEqual([
        '../../x',
      ]);
    });

    it('keeps a catalog row on the path the catalog read it from, whatever the pins say', () => {
      const model = buildDefinedModel({
        entries: [entry('alpha')],
        pins: [pin('alpha', 1), pin('../alpha', 2)],
      });
      expect(model.rows.find((row) => row.entryIndex === 0)?.path).toBe(
        '.relavium/workflows/alpha.relavium.yaml',
      );
      expect(model.rows.find((row) => row.pinRowid === 2)).not.toHaveProperty('path');
    });

    it('never matches a pin to an entry by anything but its exact slug', () => {
      const model = buildDefinedModel({
        entries: [entry('alpha'), entry('beta')],
        pins: [pin('./alpha', 1), pin('alpha/../beta', 2), pin('ALPHA', 3)],
      });
      expect(model.rows.filter((row) => row.state === 'ready').every((row) => !row.pinned)).toBe(
        true,
      );
      expect(model.rows.filter((row) => row.state === 'not-in-catalog')).toHaveLength(3);
    });
  });

  describe('sanitizing', () => {
    it('removes escape and bidirectional characters from every string of every row', () => {
      const model = buildDefinedModel({
        entries: [
          entry(`al${ESC}[31mpha`, {
            name: `Name${RLO}evil${BEL}`,
            path: `.relavium/workflows/a${ESC}]0;title${BEL}.yaml`,
          }),
          entry('broken', { valid: false, error: `bad${ESC}[2Jthing${RLO}` }),
        ],
        pins: [pin(`gone${ESC}[31m${RLO}\nrow`, 1)],
      });
      expect(model.rows).toHaveLength(3);
      for (const row of model.rows) {
        for (const text of stringsOf(row)) expect(text).not.toMatch(UNSAFE);
      }
      const missing = model.rows.find((row) => row.state === 'not-in-catalog');
      expect(missing?.slug).not.toContain('\n');
    });

    it('does not use the sanitized label to find a pin: the match is on the raw slug', () => {
      // The label of this entry strips the escape; the pin was made on the escaped slug and matches it exactly.
      const raw = `a${ESC}[31mb`;
      const [row] = buildDefinedModel({ entries: [entry(raw)], pins: [pin(raw, 4)] }).rows;
      expect(row?.pinned).toBe(true);
      expect(row?.slug).not.toMatch(UNSAFE);
    });

    it('bounds a long slug and name to a row, with an ellipsis that marks the cut', () => {
      const long = 'x'.repeat(MAX_IDENTIFIER_CHARS * 3);
      const [row] = buildDefinedModel({
        entries: [entry('long', { name: long })],
        pins: [],
      }).rows;
      expect(Array.from(row?.name ?? '').length).toBe(MAX_IDENTIFIER_CHARS + 1);
      expect(row?.name?.endsWith('…')).toBe(true);
    });
  });

  describe('an over-long pin', () => {
    it('is a row of its own that ends with an ellipsis, matches no entry and keeps its handle', () => {
      const preview = 'p'.repeat(64);
      const model = buildDefinedModel({
        // An entry whose slug is exactly the preview must not be taken for the pin.
        entries: [entry(preview)],
        pins: [pin(preview, 77, { oversized: true })],
        lastRuns: new Map<string, RunStatus>([[preview, 'completed']]),
      });
      expect(model.rows).toHaveLength(2);
      const over = model.rows.find((row) => row.pinRowid === 77);
      expect(over).toMatchObject({
        state: 'not-in-catalog',
        slug: `${preview}…`,
        pinOversized: true,
        note: NOT_IN_CATALOG,
      });
      // A cut ref names no workflow, so no run is looked up under it.
      expect(over).not.toHaveProperty('lastRunStatus');
      const real = model.rows.find((row) => row.state === 'ready');
      expect(real?.pinned).toBe(false);
    });
  });

  describe('the bound', () => {
    const many = (count: number): DefinedEntry[] =>
      Array.from({ length: count }, (_, index) => entry(`wf-${String(index).padStart(4, '0')}`));

    it('holds exactly the bound without a remainder', () => {
      const model = buildDefinedModel({ entries: many(DEFINED_ROWS_MAX), pins: [] });
      expect(model.rows).toHaveLength(DEFINED_ROWS_MAX);
      expect(model.more).toBe(0);
      expect(model.moreText).toBeUndefined();
      expect(DEFINED_ROWS_MAX).toBe(200);
    });

    it('draws 200 rows and counts the rest as "N more"', () => {
      const model = buildDefinedModel({ entries: many(DEFINED_ROWS_MAX + 53), pins: [] });
      expect(model.rows).toHaveLength(DEFINED_ROWS_MAX);
      expect(model.more).toBe(53);
      expect(model.moreText).toBe('53 more');
      expect(model.total).toBe(DEFINED_ROWS_MAX + 53);
    });

    it('cuts the unpinned rows and never a pin, even a pin on the last entry or on no entry', () => {
      const entries = many(DEFINED_ROWS_MAX + 40);
      const last = entries[entries.length - 1]?.slug ?? '';
      const model = buildDefinedModel({
        entries,
        pins: [pin(last, 1), pin('missing-one', 2)],
      });
      expect(model.rows).toHaveLength(DEFINED_ROWS_MAX);
      expect(model.rows[0]?.slug).toBe(last);
      expect(model.rows[1]?.slug).toBe('missing-one');
      expect(model.rows.filter((row) => row.pinned)).toHaveLength(2);
      // 240 entries and one pin with no entry: 241 rows, 41 left out.
      expect(model.more).toBe(41);
      expect(model.moreText).toBe('41 more');
    });
  });
});
