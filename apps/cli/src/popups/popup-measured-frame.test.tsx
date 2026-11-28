// Chalk's level is read once, when it is first imported (see `force-color.ts`).
import '../render/tui/force-color.js';

/**
 * The measured-frame proof covers the popup ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
 * §2, §4, §9 condition 2), on the real renderer:
 *
 * - **the content node, not the box**: the acknowledgement is handed the popup's content node, which has no fixed size, so a body row one cell
 *   too wide and one row too many each REFUSE it (the two mutation tests the ADR names); a fixed-size box over the same rows would have measured
 *   its own size and passed (the probe below shows why the content node is the one measured);
 * - **occlusion**: a later sibling drawn over the popup passes the repository's bounds check, so the drawn frame is compared with the popup's own
 *   rows; in the real hosts no later sibling exists (the slot is the last child and the only absolute node: `popup-absolute-only.test.ts`).
 */
import { Box, Text, type DOMElement } from 'ink';
import { describe, expect, it } from 'vitest';

import { withGlyphForm } from '../render/tui/glyphs.js';
import { exitKey } from '../render/tui/legend.js';
import { fitsTerminalBounds } from '../render/tui/measured-frame-acknowledgement.js';
import { mountInk } from '../render/tui/surface-matrix/mount.js';
import type { Variant } from '../render/tui/surface-matrix/variants.js';
import type { SheetLine } from '../render/tui/sheet-frame.js';
import { naturalBodyRows, popupBody, popupFrameLines, type PopupContent } from './frame-model.js';
import { popupGeometry, type PopupBoxGeometry } from './geometry.js';
import { createPopupAcknowledgement, popupFrameMatches } from './popup-acknowledgement.js';
import { expectedFrame, PopupFrameView } from './popup-slot.js';

const VARIANT: Variant = { renderer: 'alt', color: false, size: { cols: 80, rows: 24 } };
const SIZE = { cols: 80, rows: 24 } as const;
const CONTENT: PopupContent = {
  kind: 'list',
  rows: [
    { id: 'a', label: 'alpha' },
    { id: 'b', label: 'bravo' },
    { id: 'c', label: 'charlie' },
  ],
};

function model(): { readonly geometry: PopupBoxGeometry; readonly lines: readonly SheetLine[] } {
  const state = { selected: 0, offset: 0 };
  const geometry = popupGeometry({
    columns: 80,
    rows: 24,
    kind: 'standard',
    placement: 'overlay',
    rail: false,
    bodyRows: naturalBodyRows(CONTENT, state),
  });
  if (!geometry.fits) throw new Error('refused');
  const lines = withGlyphForm(true, () =>
    popupFrameLines(
      {
        title: 'Probe',
        origin: 'home',
        steps: ['One'],
        stepIndex: 0,
        legend: { items: [], exit: exitKey.close() },
      },
      popupBody(CONTENT, state, geometry),
      geometry,
    ),
  );
  return { geometry, lines };
}

const BODY = Array.from(
  { length: 23 },
  (_, index) => `${String(index).padStart(2, '0')} ${'x'.repeat(77)}`,
);

/** A full-screen body, the popup in its slot, and (for the occlusion probe) a later sibling drawn over it. */
function Screen(
  props: Readonly<{
    lines: readonly SheetLine[];
    geometry: PopupBoxGeometry;
    contentRef: (node: DOMElement | null) => void;
    occluder?: boolean;
  }>,
) {
  return (
    <Box width={80} height={24} flexDirection="column">
      {BODY.map((line) => (
        <Text key={line}>{line}</Text>
      ))}
      <PopupFrameView
        lines={props.lines}
        color={false}
        placement="overlay"
        left={props.geometry.left}
        top={props.geometry.top}
        contentRef={props.contentRef}
      />
      {props.occluder === true ? (
        <Box
          position="absolute"
          marginTop={props.geometry.top + 2}
          marginLeft={props.geometry.left + 10}
        >
          <Text>LATER SIBLING</Text>
        </Box>
      ) : null}
    </Box>
  );
}

/** Mount the screen and run the acknowledgement on its content node: whether the commit was taken, and whether the frame was acknowledged. */
async function acknowledge(
  lines: readonly SheetLine[],
  geometry: PopupBoxGeometry,
  checkedAgainst: PopupBoxGeometry = geometry,
) {
  let node: DOMElement | null = null;
  const m = mountInk(
    <Screen
      lines={lines}
      geometry={geometry}
      contentRef={(element) => {
        node = element;
      }}
    />,
    VARIANT,
  );
  try {
    await m.settle();
    const snapshot = {};
    let shown = 0;
    const acknowledgement = createPopupAcknowledgement({
      current: () => snapshot,
      getSize: () => SIZE,
      hasCustody: () => true,
      shown: () => {
        shown += 1;
      },
    });
    const committed = acknowledgement.commit(snapshot, node, expectedFrame(checkedAgainst), () =>
      m.settle(),
    );
    await m.settle();
    await m.settle();
    return {
      committed,
      visible: acknowledgement.visible(snapshot),
      shown,
      node: node as DOMElement | null,
    };
  } finally {
    m.unmount();
  }
}

describe('the acknowledgement measures the content node, exactly', () => {
  it('takes the frame the geometry describes, and reports it shown once', async () => {
    const { geometry, lines } = model();
    const result = await acknowledge(lines, geometry);
    expect(result).toMatchObject({ committed: true, visible: true, shown: 1 });
  });

  it('MUTATION: a body row one cell too wide refuses it', async () => {
    const { geometry, lines } = model();
    const wide = lines.map((line, index) =>
      index === 2 ? { ...line, text: `${line.text}x` } : line,
    );
    const result = await acknowledge(wide, geometry);
    expect(result).toMatchObject({ committed: false, visible: false, shown: 0 });
  });

  it('MUTATION: one extra row refuses it', async () => {
    const { geometry, lines } = model();
    const taller = [...lines.slice(0, 2), lines[1] ?? lines[0]!, ...lines.slice(2)];
    const result = await acknowledge(taller, geometry);
    expect(result).toMatchObject({ committed: false, visible: false, shown: 0 });
  });

  it('a frame drawn somewhere other than the geometry’s place refuses it', async () => {
    const { geometry, lines } = model();
    // drawn where the geometry says, checked against a geometry one row lower, and one column to the right
    expect(
      (await acknowledge(lines, geometry, { ...geometry, top: geometry.top + 1 })).committed,
    ).toBe(false);
    expect(
      (await acknowledge(lines, geometry, { ...geometry, left: geometry.left + 1 })).committed,
    ).toBe(false);
  });

  it('the probe behind the rule: a fixed-size box hides what spilled out of it, the content node does not', async () => {
    let box: DOMElement | null = null;
    let content: DOMElement | null = null;
    const { geometry, lines } = model();
    const taller = [...lines, ...lines];
    const m = mountInk(
      <Box width={80} height={24} flexDirection="column">
        <Box
          ref={(element) => {
            box = element;
          }}
          position="absolute"
          marginTop={geometry.top}
          marginLeft={geometry.left}
          width={geometry.width}
          height={geometry.height}
        >
          <Box
            ref={(element) => {
              content = element;
            }}
            flexDirection="column"
            flexShrink={0}
            alignSelf="flex-start"
          >
            {taller.map((line, index) => (
              <Text key={String(index)}>{line.text}</Text>
            ))}
          </Box>
        </Box>
      </Box>,
      VARIANT,
    );
    try {
      await m.settle();
      const boxNode = box as DOMElement | null;
      const contentNode = content as DOMElement | null;
      if (boxNode === null || contentNode === null) throw new Error('not mounted');
      expect(
        popupFrameMatches(boxNode, expectedFrame(geometry), SIZE),
        'the box measures its own size',
      ).toBe(true);
      expect(
        popupFrameMatches(contentNode, expectedFrame(geometry), SIZE),
        'the content measures what it drew',
      ).toBe(false);
    } finally {
      m.unmount();
    }
  });
});

/** Every row of the popup's box in the DRAWN frame is the popup's own row (Ink trims a row's trailing spaces). */
function popupRowsIntact(
  frame: readonly string[],
  lines: readonly SheetLine[],
  geometry: PopupBoxGeometry,
): boolean {
  return lines.every(
    (line, index) =>
      Array.from(frame[geometry.top + index] ?? '')
        .slice(geometry.left, geometry.left + geometry.width)
        .join('')
        .trimEnd() === line.text.trimEnd(),
  );
}

describe('occlusion (the spike’s hazard): the bounds check cannot see it, the drawn frame can', () => {
  it('a later sibling drawn over the popup passes the bounds check and the geometry check, and only the drawn-frame comparison fails', async () => {
    const { geometry, lines } = model();
    let node: DOMElement | null = null;
    const m = mountInk(
      <Screen
        lines={lines}
        geometry={geometry}
        occluder
        contentRef={(element) => {
          node = element;
        }}
      />,
      VARIANT,
    );
    try {
      await m.settle();
      const content = node as DOMElement | null;
      if (content === null) throw new Error('not mounted');
      expect(fitsTerminalBounds(content, SIZE)).toBe(true);
      expect(popupFrameMatches(content, expectedFrame(geometry), SIZE)).toBe(true);
      expect(m.frame().join('\n')).toContain('LATER SIBLING');
      expect(popupRowsIntact(m.frame(), lines, geometry)).toBe(false);
    } finally {
      m.unmount();
    }
  });

  it('with nothing after it, the drawn frame is exactly the popup’s rows (opaque over the body behind it)', async () => {
    const { geometry, lines } = model();
    const m = mountInk(
      <Screen lines={lines} geometry={geometry} contentRef={() => undefined} />,
      VARIANT,
    );
    try {
      await m.settle();
      expect(popupRowsIntact(m.frame(), lines, geometry)).toBe(true);
    } finally {
      m.unmount();
    }
  });

  it('MUTATION: a row one cell short of the frame width lets the body show through at its edge (the padding is load-bearing)', async () => {
    const { geometry, lines } = model();
    const short = lines.map((line, index) =>
      index === 1 ? { ...line, text: line.text.slice(0, -1) } : line,
    );
    const m = mountInk(
      <Screen lines={short} geometry={geometry} contentRef={() => undefined} />,
      VARIANT,
    );
    try {
      await m.settle();
      const row = Array.from(m.frame()[geometry.top + 1] ?? '');
      expect(row[geometry.left + geometry.width - 1]).toBe('x');
    } finally {
      m.unmount();
    }
  });
});
