import './force-color.js';

import { Box, Text as InkText } from 'ink';
import { memo, type ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { createPopupAcknowledgement } from '../../popups/popup-acknowledgement.js';
import { createPopupHost, type PopupHostSnapshot } from '../../popups/popup-host.js';
import { dimsBackdrop, slotDrawing, type PopupSlotProps } from '../../popups/popup-slot.js';
import { openFrame } from '../../popups/popup-reducer.js';
import { emphasize, SELECTED_ROW } from './emphasis.js';
import { Emph } from './emphasis-view.js';
import { createChordHistory } from './chord-guard.js';
import { createNativePromptAcknowledgement } from './native-prompt-acknowledgement.js';
import { createNativePromptChannel, type NativePromptSnapshot } from './native-prompt-channel.js';
import { withSurface } from './surface-matrix/cells.js';
import { KEYS } from './surface-matrix/home-host.js';
import { mountInk } from './surface-matrix/mount.js';
import { baselineCellsOf } from './surface-matrix/popup-fixture.js';
import { testReportPopup } from './surface-matrix/popup-fixture.js';
import type { PopupBox } from './surface-matrix/properties.js';
import { ALL_SURFACES } from './surface-matrix/all-surfaces.js';
import type { ScreenCell } from './surface-matrix/terminal.js';
import type { Variant } from './surface-matrix/variants.js';
import { BackdropDim, Text, useBackdropDim } from './text.js';

/**
 * The dimmed backdrop of an open popup ([ADR-0148](../../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
 * §4), proved cell by cell. Part 1 is the route on its own (one `Text`, one context), part 2 is the predicate the slot and the hosts share, and
 * part 3 is the three hosts with a popup open over a body that holds bold, inverse and coloured spans: every cell outside the popup dim, the
 * popup itself not dim, and no dim left after it closes.
 */

const ALT: Variant = { renderer: 'alt', color: true, size: { cols: 80, rows: 24 } };

async function drawn(tree: ReactElement): Promise<{ cells: ScreenCell[][]; raw: string }> {
  const mount = mountInk(tree, ALT);
  try {
    await mount.settle();
    return { cells: mount.cells(), raw: mount.raw() };
  } finally {
    mount.unmount();
  }
}

const textOf = (row: readonly ScreenCell[] | undefined): string =>
  (row ?? []).map((cell) => cell.char).join('');
const glyphs = (row: readonly ScreenCell[] | undefined): ScreenCell[] =>
  (row ?? []).filter((cell) => cell.char !== ' ');

// ---- 1. the route ----------------------------------------------------------------------------------------------------------------

/** ink's own `Text`, with the sample's styles written as ink writes them (the bold and inverse props, and the literal pair of the one rule). */
const inkSample = (
  <Box flexDirection="column">
    <InkText color="cyan">
      plain <InkText bold>bold</InkText> then <InkText inverse>inverse</InkText> tail
    </InkText>
    <InkText dimColor>already dim</InkText>
    <InkText>
      {'before '}
      {emphasize('sel', SELECTED_ROW)}
      {' after'}
    </InkText>
    <InkText color="red" underline>
      nested <InkText color="green">green</InkText> back
    </InkText>
  </Box>
);

/** The same sample through the route: the `Text` of the CLI, and the pair through `Emph`. */
const routeSample = (
  <Box flexDirection="column">
    <Text color="cyan">
      plain <Text bold>bold</Text> then <Text inverse>inverse</Text> tail
    </Text>
    <Text dimColor>already dim</Text>
    <Text>
      {'before '}
      <Emph kinds={SELECTED_ROW}>sel</Emph>
      {' after'}
    </Text>
    <Text color="red" underline>
      nested <Text color="green">green</Text> back
    </Text>
  </Box>
);

describe('the route: outside a dimmed backdrop it is ink’s Text', () => {
  it('writes the same bytes as ink for bold, inverse, colour, a literal pair and a nested Text, with no provider and with a provider that is off', async () => {
    const ink = await drawn(inkSample);
    expect((await drawn(routeSample)).raw).toBe(ink.raw);
    expect((await drawn(<BackdropDim dimmed={false}>{routeSample}</BackdropDim>)).raw).toBe(
      ink.raw,
    );
    for (const code of ['1', '7', '36', '4'])
      expect(ink.raw, `the sample really carries SGR ${code}`).toContain(`\u001b[${code}m`);
  });
});

describe('the route: inside a dimmed backdrop every glyph is dim', () => {
  it('draws every glyph of the sample dim: after a bold span, after an inverse span, after the literal pair of a selected row, after a nested Text', async () => {
    const { cells } = await drawn(<BackdropDim dimmed>{routeSample}</BackdropDim>);
    const rows = cells.filter((row) => glyphs(row).length > 0);
    expect(rows.map(textOf)).toEqual([
      'plain bold then inverse tail',
      'already dim',
      'before sel after',
      'nested green back',
    ]);
    for (const row of rows)
      expect(
        glyphs(row).filter((cell) => !cell.style.dim),
        textOf(row),
      ).toEqual([]);
  });

  it('keeps what dim does not contradict: the inverse cells, the colours and the underline stay, and the bold is the one weight that goes', async () => {
    const { cells } = await drawn(<BackdropDim dimmed>{routeSample}</BackdropDim>);
    const all = cells.flat();
    /** The cells of `word` in the row that reads `line` (each of them, not a letter of the same name elsewhere in the sample). */
    const cellsOf = (line: string, word: string): readonly ScreenCell[] => {
      const row = cells.find((candidate) => textOf(candidate).trim() === line);
      const at = textOf(row).indexOf(word);
      expect(at, `${word} in ${line}`).toBeGreaterThanOrEqual(0);
      return (row ?? []).slice(at, at + word.length);
    };
    // The inverse span and the selected row's literal pair (`Emph`) keep their inverse, every cell of them (MVP-11 step 4 round 2, H10:
    // the `s` of `inverse` used to stand in for the `sel` span).
    expect(
      cellsOf('plain bold then inverse tail', 'inverse').every((cell) => cell.style.inverse),
    ).toBe(true);
    expect(cellsOf('before sel after', 'sel').every((cell) => cell.style.inverse)).toBe(true);
    expect(cellsOf('before sel after', 'before').some((cell) => cell.style.inverse)).toBe(false);
    expect(all.some((cell) => cell.style.fg === '36')).toBe(true);
    expect(all.some((cell) => cell.style.fg === '32')).toBe(true);
    expect(all.some((cell) => cell.style.underline)).toBe(true);
    expect(
      all.filter((cell) => cell.style.bold),
      'a dimmed backdrop draws no bold: the renderer’s encoder drops the dim after a bold-and-dim cell',
    ).toEqual([]);
  });

  it('draws the cell after a bold span dim, which is the cell the renderer’s re-encoding loses when the bold is kept', async () => {
    const { cells } = await drawn(
      <BackdropDim dimmed>
        <Text>
          a <Text bold>B</Text> c
        </Text>
        <Text>
          before <Emph kinds="bold">E</Emph> after
        </Text>
        <Text bold>whole</Text>
        <Text>tail</Text>
      </BackdropDim>,
    );
    const rows = cells.filter((row) => glyphs(row).length > 0);
    expect(rows.map(textOf)).toEqual(['a B c', 'before E after', 'whole', 'tail']);
    for (const row of rows) expect(glyphs(row).every((cell) => cell.style.dim)).toBe(true);
  });

  it('ORs its own dim: a Text that asked for dimColor is dim whether or not the backdrop is', async () => {
    const off = await drawn(routeSample);
    const dimRow = off.cells.find((row) => textOf(row) === 'already dim');
    expect(dimRow?.slice(0, 11).every((cell) => cell.style.dim)).toBe(true);
    const other = off.cells.find((row) => textOf(row).startsWith('plain'));
    expect(
      other?.some((cell) => cell.style.dim),
      'nothing else is dim outside the backdrop',
    ).toBe(false);
    const on = await drawn(<BackdropDim dimmed>{routeSample}</BackdropDim>);
    expect(
      on.cells
        .find((row) => textOf(row) === 'already dim')
        ?.slice(0, 11)
        .every((cell) => cell.style.dim),
    ).toBe(true);
  });
});

describe('the provider: no host node, and a boolean that moves only when a popup opens or closes', () => {
  it('renders no node of its own: the box’s children are the text nodes themselves, and the frame is the same with and without it', async () => {
    const mount = mountInk(
      <Box flexDirection="column">
        <BackdropDim dimmed>
          <Text>one</Text>
          <Text>two</Text>
        </BackdropDim>
      </Box>,
      ALT,
    );
    try {
      await mount.settle();
      const names = (mount.root()?.childNodes ?? [])
        .filter((node) => node.nodeName !== '#text')
        .flatMap((node) =>
          node.nodeName === 'ink-box' ? node.childNodes.map((child) => child.nodeName) : [],
        );
      expect(names).toEqual(['ink-text', 'ink-text']);
    } finally {
      mount.unmount();
    }
    const bare = await drawn(
      <Box flexDirection="column">
        <Text>one</Text>
        <Text>two</Text>
      </Box>,
    );
    const wrapped = await drawn(
      <Box flexDirection="column">
        <BackdropDim dimmed={false}>
          <Text>one</Text>
          <Text>two</Text>
        </BackdropDim>
      </Box>,
    );
    expect(textOf(wrapped.cells[0])).toBe(textOf(bare.cells[0]));
    expect(wrapped.raw).toBe(bare.raw);
  });

  it('re-renders its readers when the boolean flips and not when its parent re-renders with the same one', async () => {
    let renders = 0;
    const Reader = memo(function Reader(): ReactElement {
      useBackdropDim();
      renders += 1;
      return <Text>reader</Text>;
    });
    const tree = (dimmed: boolean, tick: number): ReactElement => (
      <Box flexDirection="column">
        <Text>{String(tick)}</Text>
        <BackdropDim dimmed={dimmed}>
          <Reader />
        </BackdropDim>
      </Box>
    );
    const mount = mountInk(tree(false, 0), ALT);
    try {
      await mount.settle();
      expect(renders).toBe(1);
      for (const tick of [1, 2, 3]) {
        mount.rerender(tree(false, tick));
        await mount.settle();
      }
      expect(renders, 'a popup tick that leaves the boolean alone re-renders no reader').toBe(1);
      mount.rerender(tree(true, 4));
      await mount.settle();
      expect(renders).toBe(2);
      mount.rerender(tree(true, 5));
      await mount.settle();
      expect(renders).toBe(2);
    } finally {
      mount.unmount();
    }
  });
});

// ---- 2. the predicate ------------------------------------------------------------------------------------------------------------

const frame = openFrame(testReportPopup('home'), 1);
const closed: PopupHostSnapshot = { open: false, depth: 0, placement: 'overlay', frame: undefined };
const open = (placement: 'overlay' | 'replace'): PopupHostSnapshot => ({
  open: true,
  depth: 1,
  placement,
  frame,
});

const SIZE = { cols: 80, rows: 24 };
const history = createChordHistory();
const popupHost = createPopupHost({ history, placement: 'overlay' });
const popupAcknowledgement = createPopupAcknowledgement<PopupHostSnapshot>({
  current: popupHost.getSnapshot,
  getSize: () => SIZE,
  hasCustody: () => true,
  shown: () => {},
});
const channel = createNativePromptChannel({ history });
const nativeAcknowledgement = createNativePromptAcknowledgement(channel.ui, () => SIZE);

/** A native prompt a flow drew as a popup (the descriptor is set), as a card (it is not), or one that is not open. */
const CARD: NativePromptSnapshot = {
  active: true,
  kind: 'select',
  message: 'Pick one',
  note: '',
  options: [{ value: 'a', label: 'A' }],
  selected: 0,
  display: '',
  error: '',
  escape: 'cancel',
  details: [],
};
const PROMPT: NativePromptSnapshot = {
  ...CARD,
  popup: {
    title: '/providers',
    origin: 'home',
    stepIndex: 1,
    stepCount: 1,
    exitLabel: 'close',
    depth: 1,
  },
};
const IDLE: NativePromptSnapshot = { ...PROMPT, active: false };
/** A picker a flow framed is drawn in the popup frame too (unit 6: every prompt kind is framed when the descriptor is set). */
const PICKER: NativePromptSnapshot = { ...PROMPT, kind: 'picker' };

const WIRED: Pick<PopupSlotProps, 'host' | 'acknowledgement'> = {
  host: popupHost,
  acknowledgement: popupAcknowledgement,
};
const UNWIRED: Pick<PopupSlotProps, 'host' | 'acknowledgement'> = {
  host: undefined,
  acknowledgement: undefined,
};
const nativeOf = (snapshot: NativePromptSnapshot): Pick<PopupSlotProps, 'native'> => ({
  native: { snapshot, acknowledgement: nativeAcknowledgement },
});

describe('the one predicate: what the slot draws is what the hosts dim behind', () => {
  const dims = (
    props: Pick<PopupSlotProps, 'host' | 'acknowledgement' | 'native' | 'placement'>,
    snapshot: PopupHostSnapshot,
    color = true,
  ): boolean => dimsBackdrop(slotDrawing(props, snapshot), color);

  it('a popup of the popup host in the overlay dims the body, with colour on', () => {
    expect(dims({ ...WIRED, native: undefined, placement: 'overlay' }, open('overlay'))).toBe(true);
  });

  it('with colour off it does not (chalk prints no dim, and the popup is opaque and framed anyway)', () => {
    expect(
      dims({ ...WIRED, native: undefined, placement: 'overlay' }, open('overlay'), false),
    ).toBe(false);
  });

  it('inline (the popup replaces the body) nothing is dimmed', () => {
    expect(dims({ ...WIRED, native: undefined, placement: 'replace' }, open('replace'))).toBe(
      false,
    );
  });

  it('with no popup open, or a host that is not wired, nothing is dimmed', () => {
    expect(dims({ ...WIRED, native: undefined, placement: 'overlay' }, closed)).toBe(false);
    expect(dims({ ...UNWIRED, native: undefined, placement: 'overlay' }, open('overlay'))).toBe(
      false,
    );
    expect(
      dims(
        { host: popupHost, acknowledgement: undefined, native: undefined, placement: 'overlay' },
        open('overlay'),
      ),
    ).toBe(false);
  });

  it('a native prompt a flow drew as a popup, in the overlay, dims the body (the popup host closed or not)', () => {
    expect(dims({ ...UNWIRED, ...nativeOf(PROMPT), placement: 'overlay' }, closed)).toBe(true);
    expect(dims({ ...WIRED, ...nativeOf(PROMPT), placement: 'overlay' }, closed)).toBe(true);
  });

  it('a native prompt drawn inline, as a card or not open, dims nothing; a framed picker in the overlay dims as any framed prompt does', () => {
    expect(dims({ ...UNWIRED, ...nativeOf(PROMPT), placement: 'replace' }, closed)).toBe(false);
    for (const snapshot of [CARD, IDLE])
      expect(dims({ ...UNWIRED, ...nativeOf(snapshot), placement: 'overlay' }, closed)).toBe(false);
    expect(dims({ ...UNWIRED, ...nativeOf(PICKER), placement: 'overlay' }, closed)).toBe(true);
  });

  it('says which of the two the slot draws, and the native prompt wins when both are there', () => {
    expect(
      slotDrawing({ ...WIRED, ...nativeOf(PROMPT), placement: 'overlay' }, open('overlay')),
    ).toEqual({
      source: 'native',
      placement: 'overlay',
    });
    expect(
      slotDrawing({ ...WIRED, native: undefined, placement: 'overlay' }, open('overlay')),
    ).toEqual({
      source: 'host',
      placement: 'overlay',
    });
  });

  it('is the same boolean for every state of one open popup: a popup’s own tick never moves it', () => {
    const props = { ...WIRED, native: undefined, placement: 'overlay' } as const;
    const base = open('overlay');
    const ticked: PopupHostSnapshot = { ...base, frame: { ...frame, stepIndex: frame.stepIndex } };
    expect(dims(props, ticked)).toBe(dims(props, base));
  });
});

// ---- 3. the hosts ----------------------------------------------------------------------------------------------------------------

// The test layer's report popups: their box is known before they are mounted. A product popup (`/doctor`, the four reports `/agent`, `/cost`,
// `/workflows` and `/help`, the settings `/effort`, `/mode`, `/models` and `/permissions`, and the test layer's form and effect list) draws the frame its host has open, and the
// matrix's own backdrop property checks every cell of it (`checkBackdropDim`, run in every alternate-screen colour cell). So does each framed
// native prompt of the matrix (`.native-popup-*`: a field, a wait or a chord step has no selected row for the check below to find).
const FRAMED_FLOW_SURFACE =
  /^home\.(provider-|native-|init-|import-|export-|pricing-|resume-|run-launch)/u;
const POPUP_SURFACES = ALL_SURFACES.filter(
  (surface) =>
    surface.popup !== undefined &&
    !surface.id.includes('.doctor-') &&
    !surface.id.includes('.report-') &&
    !surface.id.includes('.settings-') &&
    !surface.id.includes('.permissions-') &&
    !surface.id.includes('.native-popup-') &&
    !surface.id.includes('.export-confirm') &&
    // The unreadable run's card is a report popup whose box exists only while the card is open (its body has no inverse cell by design: the
    // surface declares it, and the matrix's own backdrop check, with its self-tests, covers every cell of it).
    !surface.id.includes('.unreadable-run-card') &&
    // The flows of unit 6 are framed native prompts too (a field, a wait, a chord step or a Done step): their box is where the live flow
    // draws it, so it exists only while a surface has the flow open, and the matrix's own backdrop check covers every cell of each.
    !FRAMED_FLOW_SURFACE.test(surface.id),
);

/** Where the popup of `entry` is drawn in `ALT`, and the cells inside it. */
const boxOf = (box: PopupBox, cells: readonly (readonly ScreenCell[])[]): ScreenCell[] =>
  cells
    .slice(box.top, box.top + box.height)
    .flatMap((row) => row.slice(box.left, box.left + box.width));

describe('the three hosts, with a popup open over a body of bold, inverse and coloured spans', () => {
  it('has a surface in each host, over a plain body and over a rich one', () => {
    expect(POPUP_SURFACES.map((surface) => surface.id).sort()).toEqual([
      'chat.popup',
      'chat.popup-rich',
      'home.popup',
      'home.popup-populated',
      'home.popup-selected-row',
      'standalone-chat.popup',
      'standalone-chat.popup-rich',
    ]);
  });

  describe.each(POPUP_SURFACES.map((surface) => [surface.id, surface] as const))(
    '%s',
    (_id, entry) => {
      const box = entry.popup?.(ALT);
      if (box === undefined) throw new Error('not a popup surface');

      it('draws every cell outside the popup dim, and the popup itself not dim (its selected row keeps its bold and its inverse)', async () => {
        await withSurface(entry, ALT, {}, (mount) => {
          const before = baselineCellsOf(mount);
          expect(before, 'the surface recorded the body before it opened the popup').toBeDefined();
          const now = mount.cells();
          const outside = now.flatMap((row, rowIndex) =>
            row.filter(
              (cell, column) =>
                (cell.char !== ' ' || cell.style.inverse || cell.style.bg !== undefined) &&
                !(
                  rowIndex >= box.top &&
                  rowIndex < box.top + box.height &&
                  column >= box.left &&
                  column < box.left + box.width
                ) &&
                !cell.style.dim,
            ),
          );
          expect(outside.map((cell) => cell.char)).toEqual([]);
          const inside = boxOf(box, now);
          const selected = inside.filter((cell) => cell.style.inverse);
          expect(selected.length, 'the popup’s selected row is on screen').toBeGreaterThan(0);
          expect(selected.every((cell) => !cell.style.dim && cell.style.bold)).toBe(true);
          expect(inside.some((cell) => cell.style.bold && cell.char !== ' ')).toBe(true);
        });
      });

      it('closed by the host, leaves the screen as it was before the popup opened: the same text and the same attributes, no dim left', async () => {
        await withSurface(entry, ALT, {}, async (mount) => {
          const before = baselineCellsOf(mount);
          expect(before).toBeDefined();
          mount.popups.closeAll('command');
          await mount.until(() => !mount.text().includes('Test report'));
          await mount.settle();
          const after = mount.cells();
          expect(after.map(textOf)).toEqual((before ?? []).map(textOf));
          expect(after).toEqual(before);
        });
      });

      it('closed by Esc, the way a person closes it, leaves the same screen', async () => {
        await withSurface(entry, ALT, {}, async (mount) => {
          const before = baselineCellsOf(mount);
          mount.key(KEYS.escape);
          // A lone Esc is held back a moment while the input layer rules out an escape sequence.
          await vi.waitFor(() => expect(mount.popups.getSnapshot().open).toBe(false), {
            timeout: 3000,
            interval: 15,
          });
          await mount.settle();
          expect(mount.text()).not.toContain('Test report');
          expect(mount.cells()).toEqual(before);
        });
      });
    },
  );

  it('draws the body the same with no popup ever opened as after one opened and closed (no dim entered anything that outlives the popup)', async () => {
    const entry = POPUP_SURFACES.find((surface) => surface.id === 'chat.popup-rich');
    if (entry === undefined) throw new Error('the rich chat surface is not registered');
    await withSurface(entry, ALT, {}, async (mount) => {
      const before = baselineCellsOf(mount);
      mount.popups.closeAll('command');
      await mount.until(() => !mount.text().includes('Test report'));
      await mount.settle();
      // The popup opened and closed once; open it a second time and close it again: the body is still the body.
      mount.popups.openForUser(testReportPopup('chat'));
      await mount.until(() => mount.text().includes('Test report'));
      mount.popups.closeAll('command');
      await mount.until(() => !mount.text().includes('Test report'));
      await mount.settle();
      expect(mount.cells()).toEqual(before);
    });
  });
});
