import '../force-color.js';

import { Box, Text } from 'ink';
import { cleanup, render as renderCapture } from 'ink-testing-library';
import { afterEach, describe, expect, it } from 'vitest';

import { RootApp } from '../home-app.js';
import { createHomeController } from '../home-controller.js';
import { settleFrames } from '../harness-util.js';
import { runCell } from './cells.js';
import { mountInk } from './mount.js';
import {
  checkExitKey,
  checkHeight,
  checkNoColour,
  checkNoScrollbackClear,
  checkProperties,
  checkWidth,
  colourSequences,
  sgrSetsColour,
  stripAnsi,
  type Observation,
} from './properties.js';
import { observe, problemsOf } from './run-cell.js';
import type { HomeSurface, Surface } from './surface-types.js';
import { ScreenEmulator } from './terminal.js';
import { BELOW_FLOOR_VARIANT, FLOOR_VARIANTS, cellsOf, type Variant } from './variants.js';
import { CHAT_SURFACES } from './surfaces-chat.js';
import { HOME_SURFACES } from './surfaces-home.js';
import { EMPTY_SNAPSHOT } from './home-host.js';

/**
 * The matrix tested against itself: that the fake terminal shows what Ink drew, that each property fails on a surface that breaks it (so a
 * green matrix means something), and that an entry cannot rot: a known failure that no longer fails, a landmark that is not on screen and
 * an exit key that is not shown all fail the cell.
 */
afterEach(cleanup);

const ESC = String.fromCharCode(0x1b);
const sgr = (params: string): string => `${ESC}[${params}m`;

const ALT_80: Variant = { renderer: 'alt', color: false, size: { cols: 80, rows: 24 } };
const INLINE_80: Variant = { renderer: 'inline', color: false, size: { cols: 80, rows: 24 } };
const INLINE_80_COLOUR: Variant = { ...INLINE_80, color: true };

const observation = (
  variant: Variant,
  lines: readonly string[],
  raw = lines.join('\n'),
): Observation => ({
  variant,
  lines,
  raw,
});

describe('the fake terminal', () => {
  it('shows what Ink left: the erase-and-rewrite cycle replaces the frame and leaves nothing of the old one', () => {
    const screen = new ScreenEmulator();
    // Ink's log-update: write the frame, then for the next frame erase its lines (`ESC[2K ESC[1A` per extra line, `ESC[G`) and write again.
    screen.feed('one\ntwo\nthree\n');
    screen.feed(`${ESC}[2K${ESC}[1A${ESC}[2K${ESC}[1A${ESC}[2K${ESC}[1A${ESC}[2K${ESC}[G`);
    screen.feed('only\n');
    expect(screen.lines()).toEqual(['only']);
  });

  it('keeps styling out of the lines and out of the width, and clears on a clear-terminal', () => {
    const screen = new ScreenEmulator();
    screen.feed(`${sgr('1')}${sgr('31')}bold red${sgr('39')}${sgr('22')}\nplain\n`);
    expect(screen.lines()).toEqual(['bold red', 'plain']);
    screen.feed(`${ESC}[2J${ESC}[3J${ESC}[H`);
    expect(screen.screenClears).toBe(1);
    expect(screen.scrollbackClears).toBe(1);
    expect(screen.lines()).toEqual([]);
    screen.feed(`kept\n${ESC}[3J`);
    expect(screen.lines(), 'a scrollback clear leaves the screen').toEqual(['kept']);
  });

  it('ignores private modes, the synchronized-output markers and OSC strings', () => {
    const screen = new ScreenEmulator();
    screen.feed(
      `${ESC}[?1049h${ESC}[?25l${ESC}[?2026hhello${ESC}]52;c;AAAA\u0007 world${ESC}[?2026l\n`,
    );
    expect(screen.lines()).toEqual(['hello world']);
  });

  it('draws what ink-testing-library draws for a real Home, in the full-screen and the inline renderer', async () => {
    for (const variant of [ALT_80, INLINE_80]) {
      const controller = createHomeController({
        doctorProbes: { keychain: () => {}, config: () => {}, toolHost: {} },
        startChat: () => new Promise<never>(() => {}),
        homeStore: { read: () => EMPTY_SNAPSHOT },
        schedule: () => () => {},
        onExit: () => {},
        onError: (cause) => {
          throw cause;
        },
      });
      const tree = (
        <RootApp
          controller={controller}
          nowMs={() => 0}
          color={false}
          getSize={() => variant.size}
          subscribeResize={() => () => {}}
          {...(variant.renderer === 'alt' ? { alternateScreen: true } : {})}
        />
      );
      const mine = mountInk(tree, variant);
      await mine.settle();
      const reference = renderCapture(tree);
      await settleFrames();
      const plain = (reference.lastFrame() ?? '')
        .split('\n')
        .map((line) => stripAnsi(line).trimEnd());
      expect(
        mine.frame().map((line) => line.trimEnd()),
        variant.renderer,
      ).toEqual(plain);
      mine.unmount();
      cleanup();
    }
  });
});

describe('the five properties, each on a surface that breaks it', () => {
  const clean = observation(ALT_80, ['a short frame', 'Esc closes']);

  it('height: a frame as tall as the terminal fails, one line less passes', () => {
    expect(
      checkHeight(
        observation(
          ALT_80,
          Array.from({ length: 23 }, () => 'x'),
        ),
      ),
    ).toEqual([]);
    expect(
      checkHeight(
        observation(
          ALT_80,
          Array.from({ length: 24 }, () => 'x'),
        ),
      )[0]?.property,
    ).toBe('height');
  });

  it('width: a line one column too wide fails, by display width (a wide character counts twice)', () => {
    expect(checkWidth(observation(ALT_80, ['x'.repeat(80)]))).toEqual([]);
    expect(checkWidth(observation(ALT_80, ['x'.repeat(81)]))[0]?.property).toBe('width');
    expect(
      checkWidth(observation(ALT_80, ['界'.repeat(41)]))[0]?.property,
      '41 wide characters are 82 columns',
    ).toBe('width');
    expect(checkWidth(observation(ALT_80, ['界'.repeat(40)]))).toEqual([]);
  });

  it('exit key: the frame must show it', () => {
    expect(checkExitKey(clean, 'Esc')).toEqual([]);
    expect(checkExitKey(clean, 'Ctrl+C')[0]?.property).toBe('exit-key');
  });

  it('scrollback clear: inline output with ESC[3J fails, alternate-screen output is not held to it', () => {
    const raw = `frame${ESC}[2J${ESC}[3J${ESC}[H`;
    expect(checkNoScrollbackClear(observation(INLINE_80, ['x'], raw))[0]?.property).toBe(
      'no-scrollback-clear',
    );
    expect(checkNoScrollbackClear(observation(ALT_80, ['x'], raw))).toEqual([]);
    expect(checkNoScrollbackClear(observation(INLINE_80, ['x'], `${ESC}[2J${ESC}[H`))).toEqual([]);
  });

  it('colour: with colour off every colour SGR fails, and bold, dim, inverse and underline do not', () => {
    for (const params of [
      '31',
      '92',
      '38;5;12',
      '38;2;1;2;3',
      '48;2;1;2;3',
      '41',
      '103',
      '1;32',
      '0;34',
    ]) {
      expect(
        checkNoColour(observation(INLINE_80, ['x'], `${sgr(params)}x`))[0]?.property,
        params,
      ).toBe('no-colour');
    }
    for (const params of ['0', '1', '2', '3', '4', '7', '22', '27', '39', '49']) {
      expect(checkNoColour(observation(INLINE_80, ['x'], `${sgr(params)}x`)), params).toEqual([]);
    }
    expect(
      checkNoColour(observation(INLINE_80_COLOUR, ['x'], `${sgr('31')}x`)),
      'colour on: not asserted',
    ).toEqual([]);
    expect(colourSequences(`${sgr('1')}a${sgr('32')}b`)).toEqual(['\\u001b[32m']);
    expect(sgrSetsColour('1;4')).toBe(false);
  });

  it('all of them together', () => {
    expect(checkProperties(clean, { exitKey: 'Esc' })).toEqual([]);
    expect(checkProperties(clean, { exitKey: 'Ctrl+C' }).map((v) => v.property)).toEqual([
      'exit-key',
    ]);
    expect(checkProperties(clean, {})).toEqual([]);
  });
});

/** The surfaces to break on purpose: the empty keyed Home and the idle stand-alone chat, which pass in the cells the mutations use. */
const HOME = HOME_SURFACES.find((entry) => entry.id === 'home.empty-keyed');
const PALETTE = HOME_SURFACES.find((entry) => entry.id === 'home.palette');
const CHAT_IDLE = CHAT_SURFACES.find((entry) => entry.id === 'standalone-chat.idle');
if (HOME === undefined || PALETTE === undefined || CHAT_IDLE === undefined)
  throw new Error('the baseline surfaces are not registered');

const problemsWith = async (
  entry: Surface,
  variant: Variant,
  tamper?: (chunk: string) => string,
): Promise<string[]> => problemsOf(entry, await runCell(entry, variant, { tamper }));

/**
 * The five properties, broken through the SAME cell the registered surfaces go through, in each host: a hook on every chunk the terminal
 * receives (a test-only wrapper around the output; nothing of production changes). The inline cells of the chat are used where a property
 * is about the inline renderer, because the full-screen chat is at its known height.
 */
describe.each([
  {
    entry: HOME,
    host: 'the Home',
    greeting: 'Welcome to Relavium.',
    exitKey: 'Ctrl+C',
    plain: ALT_80,
  },
  {
    entry: CHAT_IDLE,
    host: 'the stand-alone chat',
    greeting: 'for commands',
    exitKey: 'Ctrl+C',
    plain: INLINE_80,
  },
])('a mounted surface of $host that is made to break each property fails the cell', (target) => {
  const { entry, plain, exitKey, greeting } = target;
  const inline = { ...INLINE_80 };
  const fullScreen = { ...ALT_80 };

  it('control: untouched, it has no problem in any cell', async () => {
    for (const variant of cellsOf(undefined)) {
      expect(await problemsWith(entry, variant), JSON.stringify(variant)).toEqual([]);
    }
  });

  it('a line over the height budget (the frame grows by thirty lines)', async () => {
    const problems = await problemsWith(
      entry,
      plain,
      (chunk) => `${chunk}${'padding\n'.repeat(30)}`,
    );
    expect(problems.some((problem) => problem.startsWith('height:'))).toBe(true);
  });

  it('a widened line (a line of the frame is 120 columns wide)', async () => {
    const problems = await problemsWith(entry, plain, (chunk) =>
      chunk.replace(greeting, 'W'.repeat(120)),
    );
    expect(problems.some((problem) => problem.startsWith('width:'))).toBe(true);
  });

  it('a hidden exit key (the key is rewritten out of the frame)', async () => {
    const problems = await problemsWith(entry, plain, (chunk) =>
      chunk.replaceAll(exitKey, 'Ctrl+?'),
    );
    expect(problems.some((problem) => problem.startsWith('exit-key:'))).toBe(true);
  });

  it('a scrollback clear in the inline output (ESC[3J after each frame), and not in the full-screen one', async () => {
    const tamper = (chunk: string): string => `${chunk}${ESC}[3J`;
    const found = await problemsWith(entry, inline, tamper);
    expect(found.some((problem) => problem.startsWith('no-scrollback-clear:'))).toBe(true);
    expect(
      (await problemsWith(entry, fullScreen, tamper)).some((problem) =>
        problem.startsWith('no-scrollback-clear:'),
      ),
    ).toBe(false);
  });

  it('a colour sequence with colour off (a red SGR opens every frame), and not with colour on', async () => {
    const red = (chunk: string): string => `${sgr('31')}${chunk}`;
    const problems = await problemsWith(entry, inline, red);
    expect(problems.some((problem) => problem.startsWith('no-colour:'))).toBe(true);
    const withColour = await problemsWith(entry, INLINE_80_COLOUR, red);
    expect(withColour, 'colour on: the same bytes are not a problem').toEqual([]);
  });

  it('colour on really draws colour, so the colour-off check could see a leak', async () => {
    const result = await runCell(entry, INLINE_80_COLOUR);
    expect(colourSequences(result.observation.raw).length).toBeGreaterThan(0);
  });

  it('an entry that names an exit key the frame does not show', async () => {
    const wrong: Surface = { ...entry, exitKey: 'Ctrl+Q' };
    expect(
      (await problemsWith(wrong, plain)).some((problem) => problem.startsWith('exit-key:')),
    ).toBe(true);
  });

  it('a landmark that is not on screen is a surface that did not open', async () => {
    const lost: Surface = { ...entry, landmark: 'text that is never drawn' };
    expect(
      (await problemsWith(lost, plain)).some((problem) => problem.startsWith('surface-shown:')),
    ).toBe(true);
  });

  it('below the floor the expected text must be there, and a surface that says nothing fails', async () => {
    const mute: Surface = { ...entry, belowFloor: /this text is never drawn/u };
    const problems = await problemsWith(mute, BELOW_FLOOR_VARIANT);
    expect(problems.some((problem) => problem.startsWith('surface-shown:'))).toBe(true);
  });
});

describe('a surface whose opening key does nothing is not on screen', () => {
  it('the palette whose key is never pressed', async () => {
    const dead: HomeSurface = { ...PALETTE, open: async () => {} };
    expect(
      (await problemsWith(dead, ALT_80)).some((problem) => problem.startsWith('surface-shown:')),
    ).toBe(true);
  });
});

describe('a known failure cannot rot', () => {
  it('fails the cell when the property starts to hold, naming the entry to remove', async () => {
    const stale: HomeSurface = {
      ...HOME,
      knownFailure: {
        property: 'height',
        reason: 'a failure the surface no longer has, kept by mistake',
      },
    };
    const problems = problemsOf(stale, await runCell(stale, ALT_80));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('no longer fails here: remove it from the entry');
  });

  it('is an expected failure where it says so and a plain violation in the other cells', async () => {
    const growing = (chunk: string): string => `${chunk}${'padding\n'.repeat(30)}`;
    const only80: HomeSurface = {
      ...HOME,
      knownFailure: {
        property: 'height',
        reason: 'the surface is known to be too tall at 80 columns in this test',
        where: (variant) => variant.size.cols === 80,
      },
    };
    expect(problemsOf(only80, await runCell(only80, ALT_80, { tamper: growing }))).toEqual([]);
    const wide: Variant = { renderer: 'alt', color: false, size: { cols: 100, rows: 30 } };
    expect(
      problemsOf(only80, await runCell(only80, wide, { tamper: growing })).some((p) =>
        p.startsWith('height:'),
      ),
    ).toBe(true);
  });

  it('does not let a known height failure grow: the bound is still held', async () => {
    const bounded: HomeSurface = {
      ...HOME,
      landmark: 'row 0',
      knownFailure: {
        property: 'height',
        reason: 'known to fill the terminal in this test, and no more than that',
        maxLines: (variant) => variant.size.rows,
      },
    };
    const rowsOf = (count: number) => (
      <Box flexDirection="column">
        {Array.from({ length: count }, (_, index) => (
          <Text key={index}>{index === 0 ? 'Ctrl+C row 0' : `row ${String(index)}`}</Text>
        ))}
      </Box>
    );
    const observeRows = async (count: number) => {
      const mount = mountInk(rowsOf(count), ALT_80);
      await mount.settle();
      const result = { ...observe(bounded, mount) };
      mount.unmount();
      return result;
    };
    const full = await observeRows(24);
    expect(full.violations.map((violation) => violation.property)).toContain('height');
    expect(
      problemsOf(bounded, full),
      'the terminal full is the known failure, and within its bound',
    ).toEqual([]);
    const over = await observeRows(25);
    expect(
      problemsOf(bounded, over).some((problem) =>
        problem.includes('more than the 24 the known failure allows'),
      ),
    ).toBe(true);
  });
});

describe('real components that break a property are caught through the same mount', () => {
  const entry: HomeSurface = {
    host: 'home',
    id: 'home.mutant',
    title: 'a mutant',
    exitKey: 'Esc',
    landmark: 'mutant',
    open: async () => {},
  };

  const observeTree = async (tree: React.ReactElement, variant: Variant) => {
    const mount = mountInk(tree, variant);
    await mount.settle();
    const result = observe(entry, mount);
    mount.unmount();
    return result;
  };

  it('a component that grows past the terminal after its first frame (the inline renderer clears the scrollback)', async () => {
    const rows = (count: number) => (
      <Box flexDirection="column">
        <Text>mutant · Esc closes</Text>
        {Array.from({ length: count }, (_, index) => (
          <Text key={index}>row {String(index)}</Text>
        ))}
      </Box>
    );
    const mount = mountInk(rows(3), INLINE_80);
    await mount.settle();
    expect(observe(entry, mount).violations).toEqual([]);
    mount.rerender(rows(40));
    await mount.settle();
    const result = observe(entry, mount);
    mount.unmount();
    expect(result.violations.map((violation) => violation.property)).toContain('height');
    expect(
      result.violations.map((violation) => violation.property),
      'a frame taller than the terminal makes Ink clear the whole terminal, scrollback included',
    ).toContain('no-scrollback-clear');
  });

  it('a component with a colour it was not given (a red Text with colour off)', async () => {
    const tree = (
      <Box>
        <Text color="red">mutant · Esc closes</Text>
      </Box>
    );
    const result = await observeTree(tree, INLINE_80);
    expect(result.violations.map((violation) => violation.property)).toContain('no-colour');
  });

  it('a component that fits is clean', async () => {
    const result = await observeTree(
      <Box>
        <Text>mutant · Esc closes</Text>
      </Box>,
      INLINE_80,
    );
    expect(result.violations).toEqual([]);
  });
});

describe('the variants', () => {
  it('are the eight cells of the three axes and the one below the floor', () => {
    expect(FLOOR_VARIANTS).toHaveLength(8);
    expect(cellsOf(undefined)).toHaveLength(9);
    expect(new Set(cellsOf(undefined).map((variant) => JSON.stringify(variant))).size).toBe(9);
    expect(cellsOf((variant) => variant.renderer === 'inline')).toHaveLength(4);
  });
});
