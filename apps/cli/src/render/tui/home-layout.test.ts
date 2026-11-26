/**
 * The empty Home's block as data ([ADR-0146](../../../../../docs/decisions/0146-the-home-and-the-chat-share-one-calm-layout-and-the-first-run-has-no-dead-end.md)
 * §1). The numbers below are MEASURED from the two frames the maintainer chose (`home-empty-80x24.png`, `home-empty-100x30.png`): the
 * 68-column rail at 80 columns has its nodes at columns 0, 33 and 67, its labels start at 0, 25 and 55, its notes at 0, 26 and 54. They are
 * written here as literals, not computed, so a formula that drifts fails against the frame and not against itself.
 */
import { describe, expect, it } from 'vitest';

import {
  EXAMPLE_PROMPT,
  exampleText,
  HOME_BLOCK_ROWS,
  HOME_RAIL_MAX_WIDTH,
  homeMargin,
  homeRailWidth,
  homeTopGap,
  RAIL_FULL_MIN_WIDTH,
  RAIL_LABELS,
  railNodeColumns,
  railRows,
  thinRule,
  WORDMARK,
} from './home-layout.js';
import { displayWidth } from './viewport.js';

const spaces = (count: number): string => ' '.repeat(count);

describe('the Home margin and the rail width', () => {
  it('is 6 columns from 80 up to 99 and anything below 100, and 8 from 100', () => {
    for (const columns of [20, 79, 80, 90, 99]) expect(homeMargin(columns)).toBe(6);
    for (const columns of [100, 101, 120, 200]) expect(homeMargin(columns)).toBe(8);
  });

  it('is the columns the two margins leave, 68 at 80 and 84 at 100', () => {
    expect(homeRailWidth(80)).toBe(68);
    expect(homeRailWidth(99)).toBe(87);
    expect(homeRailWidth(100)).toBe(84);
  });

  it('is capped at 96 from 112 columns, however wide the terminal is', () => {
    expect(HOME_RAIL_MAX_WIDTH).toBe(96);
    expect(homeRailWidth(111)).toBe(95);
    expect(homeRailWidth(112)).toBe(96);
    expect(homeRailWidth(120)).toBe(96);
    expect(homeRailWidth(200)).toBe(96);
  });

  it('is never negative and never a NaN for a terminal narrower than its margins', () => {
    expect(homeRailWidth(10)).toBe(0);
    expect(homeRailWidth(0)).toBe(0);
    expect(homeRailWidth(Number.NaN)).toBe(0);
  });
});

describe('the wordmark and the block', () => {
  it('is the spaced wordmark, two spaces between its eight letters, 22 columns', () => {
    expect(WORDMARK).toBe('R  E  L  A  V  I  U  M');
    expect(displayWidth(WORDMARK)).toBe(22);
  });

  it('is twelve rows: wordmark, blank, rail, tagline, note, blank, blank, prompt, rule, status, blank, hint', () => {
    expect(HOME_BLOCK_ROWS).toBe(12);
  });
});

describe('the rail nodes', () => {
  it('sit at the left end, the middle column and the right end of the 68-column rail: 0, 33, 67', () => {
    expect(railNodeColumns(68)).toEqual([0, 33, 67]);
  });

  it('sit at 0, 41 and 83 on the 84-column rail of 100 columns, and at 0, 47 and 95 on the widest', () => {
    expect(railNodeColumns(84)).toEqual([0, 41, 83]);
    expect(railNodeColumns(96)).toEqual([0, 47, 95]);
  });

  it('keep the middle node at the floor of half the last column, for an even and an odd width', () => {
    expect(railNodeColumns(69)).toEqual([0, 34, 68]);
    expect(railNodeColumns(70)).toEqual([0, 34, 69]);
  });

  it('collapse onto column 0 on a rail one column wide, and never go negative on none', () => {
    expect(railNodeColumns(1)).toEqual([0, 0, 0]);
    expect(railNodeColumns(0)).toEqual([0, 0, 0]);
  });
});

describe('the rail labels', () => {
  it('are the three phrases of the tagline with their notes, the first one strong', () => {
    expect(RAIL_LABELS).toEqual([
      { label: 'Start as an agent', note: 'talk to an agent', strong: true },
      { label: 'Ship the workflow', note: 'save it as YAML' },
      { label: 'Own every run', note: 'every run kept' },
    ]);
  });
});

describe('the rail rows at 80 columns (68 wide), as measured from the frame', () => {
  const rows = railRows(68, false);

  it('starts the labels at 0, 25 and 55 and the notes at 0, 26 and 54', () => {
    expect(rows.placements.map((place) => place.labelStart)).toEqual([0, 25, 55]);
    expect(rows.placements.map((place) => place.noteStart)).toEqual([0, 26, 54]);
    expect(rows.placements.map((place) => place.nodeColumn)).toEqual([0, 33, 67]);
  });

  it('draws the labels row exactly: the left label at 0, the middle one centred on its node, the right one ending at the last column', () => {
    expect(rows.labels).toBe(
      `Start as an agent${spaces(8)}Ship the workflow${spaces(13)}Own every run`,
    );
    expect(rows.labels.length).toBe(68);
  });

  it('draws the notes row exactly', () => {
    expect(rows.notes).toBe(
      `talk to an agent${spaces(10)}save it as YAML${spaces(13)}every run kept`,
    );
    expect(rows.notes.length).toBe(68);
  });

  it('draws the node row exactly: the current step, the dashed rail, a pending node at the middle column and at the end', () => {
    expect(rows.node).toBe(`◉${'╌'.repeat(32)}○${'╌'.repeat(33)}○`);
    expect(displayWidth(rows.node)).toBe(68);
  });

  it('marks only the first label strong', () => {
    expect(rows.placements.map((place) => place.strong)).toEqual([true, false, false]);
    expect(rows.placements.map((place) => place.label)).toEqual([
      'Start as an agent',
      'Ship the workflow',
      'Own every run',
    ]);
  });
});

describe('the rail rows at 100 columns (84 wide), as measured from the frame', () => {
  it('starts the labels at 0, 33 and 71 and the notes at 0, 34 and 70', () => {
    const rows = railRows(homeRailWidth(100), false);
    expect(rows.placements.map((place) => place.nodeColumn)).toEqual([0, 41, 83]);
    expect(rows.placements.map((place) => place.labelStart)).toEqual([0, 33, 71]);
    expect(rows.placements.map((place) => place.noteStart)).toEqual([0, 34, 70]);
  });
});

describe('the rail rows at every width the Home can draw', () => {
  const widths = Array.from(
    { length: 96 - RAIL_FULL_MIN_WIDTH + 1 },
    (_, i) => RAIL_FULL_MIN_WIDTH + i,
  );

  it('makes the node, labels and notes rows exactly as wide as the rail, from 62 to 96', () => {
    for (const width of widths) {
      const rows = railRows(width, false);
      expect(displayWidth(rows.node), `node ${String(width)}`).toBe(width);
      expect(rows.labels.length, `labels ${String(width)}`).toBe(width);
      expect(rows.notes.length, `notes ${String(width)}`).toBe(width);
    }
  });

  it('hangs the first from column 0, centres the second on its node and ends the third on the last column, labels and notes alike', () => {
    for (const width of widths) {
      const [first, second, third] = railRows(width, false).placements;
      const middle = Math.floor((width - 1) / 2);
      expect(first?.labelStart).toBe(0);
      expect(first?.noteStart).toBe(0);
      expect(second?.labelStart).toBe(middle - Math.floor('Ship the workflow'.length / 2));
      expect(second?.noteStart).toBe(middle - Math.floor('save it as YAML'.length / 2));
      expect((third?.labelStart ?? 0) + 'Own every run'.length).toBe(width);
      expect((third?.noteStart ?? 0) + 'every run kept'.length).toBe(width);
    }
  });

  it('leaves at least two spaces between any two labels and between any two notes, from 62 to 96', () => {
    for (const width of widths) {
      const { placements } = railRows(width, false);
      for (const [a, b] of [
        [0, 1],
        [1, 2],
      ] as const) {
        const left = placements[a];
        const right = placements[b];
        const labelGap =
          (right?.labelStart ?? 0) - ((left?.labelStart ?? 0) + (left?.label.length ?? 0));
        const noteGap =
          (right?.noteStart ?? 0) - ((left?.noteStart ?? 0) + (left?.note.length ?? 0));
        expect(
          labelGap,
          `labels ${String(a)}/${String(b)} at ${String(width)}`,
        ).toBeGreaterThanOrEqual(2);
        expect(
          noteGap,
          `notes ${String(a)}/${String(b)} at ${String(width)}`,
        ).toBeGreaterThanOrEqual(2);
      }
    }
  });

  it('puts every label and note on the row where the placement says it starts', () => {
    for (const width of widths) {
      const rows = railRows(width, false);
      for (const place of rows.placements) {
        expect(rows.labels.slice(place.labelStart, place.labelStart + place.label.length)).toBe(
          place.label,
        );
        expect(rows.notes.slice(place.noteStart, place.noteStart + place.note.length)).toBe(
          place.note,
        );
      }
    }
  });
});

describe('a rail narrower than 62 columns', () => {
  it('keeps only the LEFT label and its note, never a clipped label', () => {
    for (const width of [61, 55, 40, 20, 17]) {
      const rows = railRows(width, false);
      expect(
        rows.placements.map((place) => place.label),
        String(width),
      ).toEqual(['Start as an agent']);
      expect(rows.labels, String(width)).toBe(`Start as an agent${spaces(width - 17)}`);
      expect(rows.notes, String(width)).toBe(`talk to an agent${spaces(width - 16)}`);
      expect(displayWidth(rows.node), String(width)).toBe(width);
    }
  });

  it('draws the three labels at 62 and the left one only at 61', () => {
    expect(RAIL_FULL_MIN_WIDTH).toBe(62);
    expect(railRows(62, false).placements).toHaveLength(3);
    expect(railRows(61, false).placements).toHaveLength(1);
  });

  it('draws no label at all when the rail is narrower than the first label (16 and below), and never a half of one', () => {
    for (const width of [16, 10, 1, 0]) {
      const rows = railRows(width, false);
      expect(rows.placements, String(width)).toEqual([]);
      expect(rows.labels, String(width)).toBe(spaces(width));
      expect(rows.notes, String(width)).toBe(spaces(width));
    }
  });

  it('draws nothing for a width that is not a number or is negative', () => {
    for (const width of [Number.NaN, -5]) {
      const rows = railRows(width, false);
      expect(rows.node).toBe('');
      expect(rows.labels).toBe('');
      expect(rows.placements).toEqual([]);
    }
  });
});

describe('the rail without colour', () => {
  it('keeps the same node columns and the same labels, in the plain forms @ o and .', () => {
    for (const width of [68, 84, 96, 62]) {
      const colour = railRows(width, false);
      const plain = railRows(width, true);
      const [left, middle, right] = railNodeColumns(width);
      expect(plain.node.length).toBe(width);
      expect(plain.node[left]).toBe('@');
      expect(plain.node[middle]).toBe('o');
      expect(plain.node[right]).toBe('o');
      expect(plain.labels).toBe(colour.labels);
      expect(plain.notes).toBe(colour.notes);
      expect(plain.placements).toEqual(colour.placements);
    }
  });

  it('draws the exact plain node row at 68: @, dots, o, dots, o', () => {
    expect(railRows(68, true).node).toBe(`@${'.'.repeat(32)}o${'.'.repeat(33)}o`);
  });

  it('tells the first node from the others by shape, with colour and without', () => {
    expect(railRows(68, false).node[0]).not.toBe(railRows(68, false).node[33]);
    expect(railRows(68, true).node[0]).not.toBe(railRows(68, true).node[33]);
  });
});

describe('the block above the middle of the screen', () => {
  it('has no gap inline, whatever the height: nothing blank is pushed into the scrollback', () => {
    for (const rows of [10, 24, 30, 40, 100]) expect(homeTopGap(rows, false)).toBe(0);
  });

  it('is 3 rows at 24, 6 at 30 and 11 at 40 in the alternate screen, as the frames draw it', () => {
    expect(homeTopGap(24, true)).toBe(3);
    expect(homeTopGap(30, true)).toBe(6);
    expect(homeTopGap(40, true)).toBe(11);
  });

  it('is zero for a terminal as short as the block or shorter', () => {
    for (const rows of [0, 5, 12, 13, 14, 17, 18])
      expect(homeTopGap(rows, true), String(rows)).toBe(0);
    expect(homeTopGap(19, true)).toBe(0);
    expect(homeTopGap(20, true)).toBe(1);
  });

  it('keeps the block a row short of the screen: gap + 12 never passes rows - 1 for a terminal the block fits', () => {
    for (let rows = HOME_BLOCK_ROWS + 1; rows <= 300; rows += 1) {
      const gap = homeTopGap(rows, true);
      expect(gap, `rows ${String(rows)}`).toBeGreaterThanOrEqual(0);
      expect(gap + HOME_BLOCK_ROWS, `rows ${String(rows)}`).toBeLessThanOrEqual(rows - 1);
    }
  });

  it('is zero for a height that is not a number', () => {
    expect(homeTopGap(Number.NaN, true)).toBe(0);
    expect(homeTopGap(Number.POSITIVE_INFINITY, true)).toBe(0);
  });
});

describe('the prompt example and its rule', () => {
  it('is "summarize the files in this folder"', () => {
    expect(EXAMPLE_PROMPT).toBe('summarize the files in this folder');
  });

  it('is the bare example where colour dims it, and has an "e.g." in front where it cannot', () => {
    expect(exampleText(false)).toBe('summarize the files in this folder');
    expect(exampleText(true)).toBe('e.g. summarize the files in this folder');
  });

  it('is the thin rule of the glyph table repeated, and its plain form without colour', () => {
    expect(thinRule(5, false)).toBe('─────');
    expect(thinRule(5, true)).toBe('-----');
    expect(thinRule(68, false)).toHaveLength(68);
    expect(thinRule(0, false)).toBe('');
    expect(thinRule(-3, true)).toBe('');
  });
});
