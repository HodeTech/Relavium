/**
 * The surface matrix's two popup properties ([ADR-0148](../../../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
 * §2, §4), each shown to fail on a frame or a tree made to break it: the overlay layer (one absolutely positioned node while a popup is open,
 * none otherwise, and it is last all the way up to the root) and the popup box (its own rows in its box, no cell outside it changed; inline,
 * the live region is the popup and nothing else).
 */
import { Box, Static, Text } from 'ink';
import { describe, expect, it } from 'vitest';

import { mountInk } from './mount.js';
import { checkOverlayLayer, checkPopupBox, type Observation, type PopupBox } from './properties.js';
import type { Variant } from './variants.js';

const ALT: Variant = { renderer: 'alt', color: false, size: { cols: 20, rows: 8 } };

async function layerOf(tree: Parameters<typeof mountInk>[0], popup: boolean): Promise<string[]> {
  const m = mountInk(tree, ALT);
  try {
    await m.settle();
    return checkOverlayLayer(m.root(), popup).map((violation) => violation.message);
  } finally {
    m.unmount();
  }
}

describe('the overlay layer', () => {
  it('holds with no absolute node and no popup, and with one, last, for a popup', async () => {
    expect(await layerOf(<Text>body</Text>, false)).toEqual([]);
    expect(
      await layerOf(
        <Box flexDirection="column">
          <Text>body</Text>
          <Box position="absolute">
            <Text>popup</Text>
          </Box>
        </Box>,
        true,
      ),
    ).toEqual([]);
  });

  it('fails for an absolute node with no popup, for a second one, and for none where a popup is', async () => {
    const one = (
      <Box flexDirection="column">
        <Text>body</Text>
        <Box position="absolute">
          <Text>x</Text>
        </Box>
      </Box>
    );
    expect(await layerOf(one, false)).toHaveLength(1);
    expect(
      await layerOf(
        <Box flexDirection="column">
          <Box position="absolute">
            <Text>a</Text>
          </Box>
          <Box position="absolute">
            <Text>b</Text>
          </Box>
        </Box>,
        true,
      ),
    ).toHaveLength(1);
    expect(await layerOf(<Text>body</Text>, true)).toHaveLength(1);
  });

  it('fails when a later sibling follows the absolute node (it could be drawn over the popup)', async () => {
    const messages = await layerOf(
      <Box flexDirection="column">
        <Box position="absolute">
          <Text>popup</Text>
        </Box>
        <Text>later</Text>
      </Box>,
      true,
    );
    expect(messages).toEqual([
      'the absolutely positioned node is not the last child of the root: a later sibling can be drawn over it',
    ]);
  });

  it('does not count the renderer’s own static region (the scrollback lines Ink lays out apart)', async () => {
    expect(
      await layerOf(
        <>
          <Static items={['printed']}>{(item) => <Text key={item}>{item}</Text>}</Static>
          <Text>live</Text>
        </>,
        false,
      ),
    ).toEqual([]);
  });
});

const observation = (
  lines: readonly string[],
  renderer: 'alt' | 'inline' = 'alt',
): Observation => ({
  variant: { ...ALT, renderer },
  lines,
  raw: '',
});

const BOX: PopupBox = {
  placement: 'overlay',
  top: 1,
  left: 2,
  width: 4,
  height: 2,
  rows: ['─ab─', '────'],
};
const BEFORE = ['0123456789', '0123456789', '0123456789'];

describe('the popup box', () => {
  it('holds when the box is the popup’s rows and every other cell is the frame it opened over', () => {
    expect(
      checkPopupBox(observation(['0123456789', '01─ab─6789', '01────6789']), BEFORE, BOX),
    ).toEqual([]);
  });

  it('fails when something drew over the popup’s rows (occlusion)', () => {
    expect(
      checkPopupBox(observation(['0123456789', '01─XX─6789', '01────6789']), BEFORE, BOX),
    ).toHaveLength(1);
  });

  it('fails when a cell outside the box changed', () => {
    const changed = checkPopupBox(
      observation(['0123456789', '01─ab─678X', '01────6789']),
      BEFORE,
      BOX,
    );
    expect(changed.map((violation) => violation.message)).toEqual([
      'the cell 2:10 outside the popup changed',
    ]);
    expect(
      checkPopupBox(observation(['0123456789', '01─ab─6789', '01────6789', 'extra']), BEFORE, BOX),
    ).toHaveLength(1);
  });

  it('inline: holds when the live region is the popup’s rows, and fails with anything else in it', () => {
    const inline: PopupBox = { ...BOX, placement: 'replace' };
    expect(checkPopupBox(observation(['─ab─', '────'], 'inline'), [], inline)).toEqual([]);
    expect(checkPopupBox(observation(['body', '─ab─', '────'], 'inline'), [], inline)).toHaveLength(
      1,
    );
  });
});
