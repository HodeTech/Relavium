import './force-color.js';

import { Box, Text } from 'ink';
import { cleanup, render } from 'ink-testing-library';
import type { ReactElement } from 'react';
import stringWidth from 'string-width';
import { afterEach, describe, expect, it } from 'vitest';

import { Emph, EmphText } from './emphasis-view.js';
import { emphasize } from './emphasis.js';
import { openAtEndOfEachRow, plain, styleRuns, stylesOver } from './emphasis-test-kit.js';

/**
 * The ink side of the one emphasis rule (`emphasis.ts`), with chalk at truecolor (`./force-color.js`, so a frame shows every style that is
 * drawn): the components write the pair around their children, close it on every row that is wrapped or cut, add no width, and do not
 * leak a style onto the next row. `emphasis-selection.test.tsx` reads the same rule with chalk OFF.
 */
afterEach(cleanup);

function frameOf(element: ReactElement, width = 20): string {
  const view = render(<Box width={width}>{element}</Box>);
  const frame = view.lastFrame() ?? '';
  view.unmount();
  return frame;
}

describe('Emph', () => {
  it('writes the pair around text and around nested <Text> children, and the words are untouched', () => {
    const frame = frameOf(
      <Text>
        <Emph kinds="inverse">
          {'head '}
          <Text dimColor>words</Text>
        </Emph>
        {' tail'}
      </Text>,
    );
    expect(plain(frame)).toBe('head words tail');
    expect(stylesOver(frame, 'head')).toEqual(['inverse']);
    expect(stylesOver(frame, 'words')).toEqual(['dim', 'inverse']);
    expect(stylesOver(frame, 'tail')).toEqual([]);
  });

  it('writes nothing for no style and for nothing to draw: an empty filter does not leave an empty pair', () => {
    expect(
      frameOf(
        <Text>
          {'a'}
          <Emph kinds={undefined}>b</Emph>c
        </Text>,
      ),
    ).toBe('abc');
    expect(
      frameOf(
        <Text>
          {'a'}
          <Emph kinds={[]}>b</Emph>c
        </Text>,
      ),
    ).toBe('abc');
    expect(
      frameOf(
        <Text>
          {'a'}
          <Emph kinds="bold">{''}</Emph>c
        </Text>,
      ),
    ).toBe('ac');
    expect(
      frameOf(
        <Text>
          {'a'}
          <Emph kinds="bold">{undefined}</Emph>c
        </Text>,
      ),
    ).toBe('ac');
  });
});

describe('Emph, as the element it returns', () => {
  // Ink's own output layer drops a style that covers no character, so an empty pair is invisible in a frame: the element is what shows it.
  const childrenOf = (element: ReactElement): unknown => {
    const props: unknown = element.props;
    return typeof props === 'object' && props !== null && 'children' in props
      ? props.children
      : undefined;
  };

  it('is its children and nothing else when there is nothing to draw, or no style: no bytes are written for nothing', () => {
    expect(childrenOf(Emph({ kinds: 'bold', children: '' }))).toBe('');
    expect(childrenOf(Emph({ kinds: 'bold', children: undefined }))).toBeUndefined();
    expect(childrenOf(Emph({ kinds: undefined, children: 'x' }))).toBe('x');
    expect(childrenOf(Emph({ kinds: [], children: 'x' }))).toBe('x');
  });

  it('is the opening sequence, the children and the closing sequence otherwise', () => {
    expect(childrenOf(Emph({ kinds: ['bold', 'inverse'], children: 'x' }))).toEqual([
      '\u001b[1m\u001b[7m',
      'x',
      '\u001b[27m\u001b[22m',
    ]);
  });
});

describe('EmphText', () => {
  it('is ink’s <Text> with its weight drawn by the rule: colour and bold together, over the words', () => {
    const frame = frameOf(
      <EmphText color="cyan" emphasis={['bold', 'inverse']}>
        selected
      </EmphText>,
    );
    expect(plain(frame)).toBe('selected');
    expect(stylesOver(frame, 'selected')).toEqual(['bold', 'colour', 'inverse']);
  });

  it('refuses a raw bold, inverse or underline prop: the type has none', () => {
    // @ts-expect-error -- ink draws `bold` through chalk, which is off under NO_COLOR: a view asks for it by `emphasis`
    const bold = <EmphText bold>x</EmphText>;
    // @ts-expect-error -- as above, for `inverse`
    const inverse = <EmphText inverse>x</EmphText>;
    // @ts-expect-error -- as above, for `underline`
    const underline = <EmphText underline>x</EmphText>;
    expect([bold, inverse, underline]).toHaveLength(3);
  });
});

describe('a row that is cut or wrapped does not leak its style onto the next', () => {
  const long = 'the selected row is longer than the box it is drawn in';

  it('wrap="truncate-end" cuts inside the span and still closes it, and the row below is plain', () => {
    const frame = frameOf(
      <Box flexDirection="column">
        <Text wrap="truncate-end">
          <Emph kinds={['bold', 'inverse']}>{long}</Emph>
        </Text>
        <Text>below</Text>
      </Box>,
      12,
    );
    const rows = frame.split('\n');
    expect(rows).toHaveLength(2);
    expect(plain(rows[0] ?? '')).toBe(`${long.slice(0, 11)}…`);
    expect(openAtEndOfEachRow(frame)).toEqual([[], []]);
    expect(stylesOver(frame, 'below')).toEqual([]);
  });

  it('wrap="wrap" closes the span at the end of each row it spans and opens it again on the next', () => {
    const frame = frameOf(
      <Box flexDirection="column">
        <Text wrap="wrap">
          <Emph kinds={['bold', 'inverse']}>{long}</Emph>
        </Text>
        <Text>below</Text>
      </Box>,
      12,
    );
    const rows = frame.split('\n');
    expect(rows.length).toBeGreaterThan(3);
    expect(openAtEndOfEachRow(frame).every((open) => open.length === 0)).toBe(true);
    // every row of the wrapped text is itself bold and inverse, and the one after it is not
    for (const row of rows.slice(0, -1))
      expect(styleRuns(row)[0]?.styles, JSON.stringify(plain(row))).toEqual(['bold', 'inverse']);
    expect(stylesOver(frame, 'below')).toEqual([]);
  });
});

describe('widths', () => {
  it('a row that exactly fills its box does not wrap for the sequences, and is not cut', () => {
    // 12 columns of text in a 12-column box: any width counted for the escape bytes wraps it or cuts it with an ellipsis.
    const text = 'abcdefghijkl';
    for (const wrap of ['wrap', 'truncate-end'] as const) {
      const frame = frameOf(
        <Text wrap={wrap}>{emphasize(text, ['bold', 'inverse', 'underline'])}</Text>,
        12,
      );
      const rows = frame.split('\n');
      expect(rows, wrap).toHaveLength(1);
      expect(stringWidth(rows[0] ?? ''), wrap).toBe(12);
      expect(plain(frame), wrap).toBe(text);
    }
  });

  it('a wide character costs two columns, styled or not', () => {
    const frame = frameOf(<Text>{emphasize('界界界', 'inverse')}</Text>, 6);
    expect(frame.split('\n')).toHaveLength(1);
    expect(stringWidth(frame)).toBe(6);
  });
});

describe('why the stretches of a line are siblings and never nested', () => {
  it('a close of bold ends the bold of the line around it, so a bold stretch nested in a bold line leaves the rest of the line plain', () => {
    // The pair cannot know what it sits in: the inner ESC[22m ends the outer bold too. The sheet painter therefore draws the stretches of a
    // line side by side, each with the styles of the line and of its role together, never one inside the other.
    const nested = frameOf(
      <Text>
        <Emph kinds="bold">
          {'aa '}
          <Emph kinds="bold">{'bb'}</Emph>
          {' cc'}
        </Emph>
      </Text>,
    );
    expect(stylesOver(nested, 'cc')).toEqual([]);
    const siblings = frameOf(
      <Text>
        <Emph kinds="bold">{'aa '}</Emph>
        <Emph kinds="bold">{'bb'}</Emph>
        <Emph kinds="bold">{' cc'}</Emph>
      </Text>,
    );
    expect(stylesOver(siblings, 'cc')).toEqual(['bold']);
  });

  it('a stretch drawn bold and a stretch drawn dim are separate runs: the dimmed words of a selected row take its inverse but not its bold', () => {
    const frame = frameOf(
      <Text>
        <Emph kinds={['bold', 'inverse']}>{'head '}</Emph>
        <Text dimColor>
          <Emph kinds="inverse">{'words'}</Emph>
        </Text>
      </Text>,
    );
    expect(stylesOver(frame, 'head')).toEqual(['bold', 'inverse']);
    expect(stylesOver(frame, 'words')).toEqual(['dim', 'inverse']);
  });
});
