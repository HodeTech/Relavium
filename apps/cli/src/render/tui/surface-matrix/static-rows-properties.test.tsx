import '../force-color.js';

/**
 * The rows Ink prints once through `<Static>` are scrollback, and the matrix measures the live frame without them and without anything else
 * ([ADR-0146](../../../../../../docs/decisions/0146-the-home-and-the-chat-share-one-calm-layout-and-the-first-run-has-no-dead-end.md) §4: the
 * chat the Home hosts introduces itself with a two-row header that the inline renderer prints into the terminal's history). What it pins: the
 * mount counts exactly the rows the tree marks `internal_static`, in the render that prints them; the height and a popup's live region are read
 * over the live rows; and every way of hiding a live row behind the count (a header the live frame draws itself, a count beyond the screen,
 * rows a test appends to the terminal's bytes, a taller live frame) still fails.
 */
import { Box, Static, Text } from 'ink';
import type { ReactElement } from 'react';
import { describe, expect, it } from 'vitest';

import { runCell, withSurface } from './cells.js';
import { mountInk, type InkMount } from './mount.js';
import { recordBaseline } from './popup-fixture.js';
import {
  checkHeight,
  checkPopupBox,
  liveLines,
  type Observation,
  type PopupBox,
} from './properties.js';
import { describeFrame, observe, problemsOf } from './run-cell.js';
import type { HomeSurface } from './surface-types.js';
import { CHAT_SURFACES } from './surfaces-chat.js';
import type { Variant } from './variants.js';

const INLINE_80: Variant = { renderer: 'inline', color: false, size: { cols: 80, rows: 24 } };
const ALT_80: Variant = { renderer: 'alt', color: false, size: { cols: 80, rows: 24 } };

const observation = (
  variant: Variant,
  lines: readonly string[],
  staticRows?: number,
): Observation => ({ variant, lines, raw: lines.join('\n'), staticRows });

const numbered = (count: number, prefix: string): string[] =>
  Array.from({ length: count }, (_, index) => `${prefix} ${String(index + 1)}`);

/** A blank row is a row of one space: an empty `Text` draws no row at all. */
const rowText = (row: string): string => (row === '' ? ' ' : row);

/** A tree that prints `printed` through `<Static>` and draws `live` as its own rows. */
const tree = (printed: readonly string[], live: readonly string[]): ReactElement => (
  <>
    <Static items={[...printed]}>
      {(item, index) => <Text key={index}>{rowText(item)}</Text>}
    </Static>
    <Box flexDirection="column">
      {live.map((row, index) => (
        <Text key={index}>{rowText(row)}</Text>
      ))}
    </Box>
  </>
);

async function mounted(body: ReactElement, variant: Variant): Promise<InkMount> {
  const mount = mountInk(body, variant);
  await mount.settle();
  return mount;
}

describe('the rows the mount counts as printed through <Static>', () => {
  it('counts the rows of the first commit (a tree that prints before the probe could find the root)', async () => {
    const mount = await mounted(tree(['one', 'two'], ['live a', 'live b']), INLINE_80);
    expect(mount.frame()).toEqual(['one', 'two', 'live a', 'live b']);
    expect(mount.staticRows()).toBe(2);
    mount.unmount();
  });

  it('counts the rows a later render prints, once each, and not again when only the live frame changes', async () => {
    const mount = await mounted(tree(['one', 'two'], ['live a']), INLINE_80);
    mount.rerender(tree(['one', 'two', 'three'], ['live a']));
    await mount.settle();
    expect(mount.staticRows()).toBe(3);
    mount.rerender(tree(['one', 'two', 'three'], ['live b', 'live c']));
    await mount.settle();
    mount.rerender(tree(['one', 'two', 'three'], ['live d']));
    await mount.settle();
    expect(mount.frame()).toEqual(['one', 'two', 'three', 'live d']);
    expect(mount.staticRows(), 'a render that prints nothing adds nothing').toBe(3);
    mount.unmount();
  });

  it('counts none for a tree with no <Static>, in either renderer', async () => {
    for (const variant of [INLINE_80, ALT_80]) {
      const mount = await mounted(tree([], numbered(3, 'row')), variant);
      expect(mount.staticRows(), variant.renderer).toBe(0);
      mount.unmount();
    }
  });

  it('counts none for rows the live frame draws itself, whatever they say: only the tree’s own marker excludes a row', async () => {
    const mount = await mounted(tree([], ['R  E  L  A  V  I  U  M', '', 'live a']), INLINE_80);
    expect(mount.frame()).toHaveLength(3);
    expect(mount.staticRows()).toBe(0);
    mount.unmount();
  });

  it('counts none for one blank static row (Ink prints nothing for it), and counts two (it prints those)', async () => {
    const blank = await mounted(tree([' '], ['live a']), INLINE_80);
    expect(blank.frame()).toEqual(['live a']);
    expect(blank.staticRows(), 'nothing was printed, so nothing is scrollback').toBe(0);
    blank.unmount();
    const two = await mounted(tree([' ', ' '], ['live a']), INLINE_80);
    expect(two.frame()).toEqual(['', '', 'live a']);
    expect(two.staticRows()).toBe(2);
    two.unmount();
  });
});

describe('the height is read over the live rows', () => {
  it('a screen of 25 rows whose first two are scrollback is a live frame of 23: it fits a 24-row terminal', () => {
    const lines = numbered(25, 'row');
    expect(checkHeight(observation(INLINE_80, lines, 2))).toEqual([]);
    expect(checkHeight(observation(INLINE_80, lines, 0))[0]?.property).toBe('height');
    expect(checkHeight(observation(INLINE_80, lines))[0]?.property, 'no count, none excluded').toBe(
      'height',
    );
  });

  it('a live frame that really is as tall as the terminal still fails, whatever is above it', () => {
    expect(checkHeight(observation(INLINE_80, numbered(26, 'row'), 2))[0]?.property).toBe('height');
    expect(checkHeight(observation(INLINE_80, numbered(24, 'row'), 0))[0]?.property).toBe('height');
    expect(checkHeight(observation(INLINE_80, numbered(23, 'row'), 0))).toEqual([]);
  });

  it('says how many rows it did not count, so a reader can tell the two readings apart', () => {
    const [violation] = checkHeight(observation(INLINE_80, numbered(26, 'row'), 2));
    expect(violation?.message).toBe(
      '24 lines on a 24-row terminal (at most 23; 2 more row(s) are scrollback and not counted)',
    );
    expect(checkHeight(observation(INLINE_80, numbered(24, 'row'), 0))[0]?.message).toBe(
      '24 lines on a 24-row terminal (at most 23)',
    );
  });

  it.each([
    ['more rows than the screen has', 99],
    ['a negative count', -1],
    ['a fraction', 1.5],
    ['not a number', Number.NaN],
  ])(
    'a count that is %s excludes nothing: a live row cannot be hidden behind a bad number',
    (_name, count) => {
      const lines = numbered(24, 'row');
      expect(liveLines(observation(INLINE_80, lines, count))).toEqual(lines);
      expect(checkHeight(observation(INLINE_80, lines, count))[0]?.property).toBe('height');
    },
  );

  it('a count of every row on the screen leaves an empty live frame, as it should', () => {
    expect(liveLines(observation(INLINE_80, ['a', 'b'], 2))).toEqual([]);
  });
});

describe('a popup in the flow is the live region and nothing else', () => {
  const rows = ['─ Report ─', 'a row', 'Esc close'];
  const box: PopupBox = { placement: 'replace', top: 0, left: 0, width: 10, height: 3, rows };
  const header = ['R  E  L  A  V  I  U  M', ''];
  const check = (lines: readonly string[], staticRows: number): string[] =>
    checkPopupBox(observation(INLINE_80, lines, staticRows), [], box).map((v) => v.message);

  it('passes with the header above it only when the header is what Ink printed once', () => {
    expect(check([...header, ...rows], 2)).toEqual([]);
    expect(check([...header, ...rows], 0)).toEqual([
      'the live region is not exactly the popup’s rows',
    ]);
  });

  it('fails for one popup row that is not its own, with a header above', () => {
    expect(check([...header, '─ Report ─', 'a rov', 'Esc close'], 2)).toEqual([
      'the live region is not exactly the popup’s rows',
    ]);
  });

  it('fails for a row too many and for a row too few in the live region', () => {
    expect(check([...header, 'extra', ...rows], 2)).toHaveLength(1);
    expect(check([...header, ...rows.slice(1)], 2)).toHaveLength(1);
  });

  it('fails when the count is one too many (it swallows the popup’s first row) or one too few (the header is live)', () => {
    expect(check([...header, ...rows], 3)).toHaveLength(1);
    expect(check([...header, ...rows], 1)).toHaveLength(1);
  });
});

describe('through the same mount a cell goes through', () => {
  /** A surface whose frame is `live 1 …`: its exit key and its landmark are on the first live row, or on the popup's rows. */
  const entry = (popup?: HomeSurface['popup']): HomeSurface => ({
    host: 'home',
    id: 'home.static-rows',
    title: 'a tree that prints a header through <Static>',
    exitKey: popup === undefined ? 'live 1' : 'Esc',
    landmark: popup === undefined ? 'live 1' : 'a row',
    open: async () => {},
    ...(popup === undefined ? {} : { popup }),
  });
  const header = ['R  E  L  A  V  I  U  M', ''];

  it('a header printed through <Static> above a live frame of rows − 1 lines is clean; one live row more fails', async () => {
    const fits = await mounted(tree(header, numbered(23, 'live')), INLINE_80);
    expect(fits.frame()).toHaveLength(25);
    expect(observe(entry(), fits).violations).toEqual([]);
    fits.unmount();
    const full = await mounted(tree(header, numbered(24, 'live')), INLINE_80);
    expect(observe(entry(), full).violations.map((v) => v.property)).toEqual(['height']);
    full.unmount();
  });

  it('the same rows drawn by the live frame (not printed through <Static>) fail: 2 extra rows in the live region are counted', async () => {
    const drawn = await mounted(tree([], [...header, ...numbered(22, 'live')]), INLINE_80);
    expect(drawn.frame()).toHaveLength(24);
    expect(observe(entry(), drawn).violations.map((v) => v.property)).toEqual(['height']);
    drawn.unmount();
  });

  it('a known height failure is bounded over the live rows too: the header is not part of what may not grow', async () => {
    const known: HomeSurface = {
      ...entry(),
      knownFailure: {
        property: 'height',
        reason: 'known to fill the terminal in this test, and no more than that',
        maxLines: (variant) => variant.size.rows,
      },
    };
    const full = await mounted(tree(header, numbered(24, 'live')), INLINE_80);
    expect(full.frame()).toHaveLength(26);
    expect(problemsOf(known, observe(known, full))).toEqual([]);
    full.unmount();
    const over = await mounted(tree(header, numbered(25, 'live')), INLINE_80);
    expect(
      problemsOf(known, observe(known, over)).some((problem) =>
        problem.includes('more than the 24 the known failure allows'),
      ),
    ).toBe(true);
    over.unmount();
  });

  it('a popup in the flow under a printed header is exactly its rows; the same popup under a drawn header is not', async () => {
    const rows = ['─ Report ─', 'a row', 'Esc close'];
    const popup: HomeSurface['popup'] = () => ({
      placement: 'replace',
      top: 0,
      left: 0,
      width: 10,
      height: 3,
      rows,
    });
    const printed = await mounted(tree(header, rows), INLINE_80);
    recordBaseline(printed);
    expect(observe(entry(popup), printed).violations).toEqual([]);
    printed.unmount();
    const drawn = await mounted(tree([], [...header, ...rows]), INLINE_80);
    recordBaseline(drawn);
    expect(observe(entry(popup), drawn).violations.map((v) => v.property)).toEqual(['popup-box']);
    drawn.unmount();
  });

  it('names the scrollback rows in the frame of a failing cell', async () => {
    const mount = await mounted(tree(header, numbered(24, 'live')), INLINE_80);
    const result = observe(entry(), mount);
    const described = describeFrame(result).split('\n');
    expect(described[0]).toBe(
      '(rows 1–2 were printed once through <Static>: scrollback, not the live frame)',
    );
    expect(described[1]).toBe(' 1│R  E  L  A  V  I  U  M');
    mount.unmount();
    const plain = await mounted(tree([], ['live 1']), INLINE_80);
    expect(describeFrame(observe(entry(), plain)).split('\n')).toEqual([' 1│live 1']);
    plain.unmount();
  });
});

describe('the chat the Home hosts, in the inline renderer', () => {
  const surface = (id: string) => {
    const found = CHAT_SURFACES.find((candidate) => candidate.id === id);
    if (found === undefined) throw new Error(`no surface ${id}`);
    return found;
  };

  it('prints its two-row header through <Static>: the screen is two rows longer than the live frame', async () => {
    const result = await runCell(surface('chat.mode-prompt'), INLINE_80);
    expect(result.observation.staticRows).toBe(2);
    // the header stands at the content column of the grid (unit 9): 6 columns in at 80
    expect(result.observation.lines.slice(0, 2)).toEqual([
      `${' '.repeat(6)}R  E  L  A  V  I  U  M`,
      '',
    ]);
    expect(result.observation.lines).toHaveLength(24);
    expect(result.violations).toEqual([]);
    expect(
      checkHeight({ ...result.observation, staticRows: 0 })[0]?.property,
      'without the count the same screen is a full terminal: the exclusion is what makes it fit, and it is only these two rows',
    ).toBe('height');
  });

  it('is the popup and nothing else in its live region, and is not once its header is taken for live', async () => {
    const entry = surface('chat.popup');
    const problemsWith = async (count: number | undefined): Promise<string[]> =>
      withSurface(entry, INLINE_80, {}, (mount) => {
        if (count !== undefined) mount.staticRows = () => count;
        return problemsOf(entry, observe(entry, mount));
      });
    expect(await problemsWith(undefined)).toEqual([]);
    expect((await problemsWith(0))[0]).toContain('popup-box: the live region is not exactly');
    expect((await problemsWith(1))[0]).toContain('popup-box: the live region is not exactly');
  });

  it('still fails a live frame that is taller than the terminal, with its header excluded', async () => {
    const growing = (chunk: string): string => `${chunk}${'padding\n'.repeat(30)}`;
    const result = await runCell(surface('chat.idle'), INLINE_80, { tamper: growing });
    expect(result.observation.staticRows).toBe(2);
    expect(problemsOf(surface('chat.idle'), result).some((p) => p.startsWith('height:'))).toBe(
      true,
    );
  });
});
