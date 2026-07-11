import { Box, Text, measureElement, type DOMElement } from 'ink';
import { useEffect, useRef, useState, type ComponentProps, type ReactElement } from 'react';

import { colorProps, dimProps } from './projection.js';
import { lineSpan, splitRow, type SelectionRange } from './selection.js';
import { effectiveOffset, type ScrollState, type ViewportGeometry } from './scroll.js';
import { windowLines, type DisplayLine } from './viewport.js';

/**
 * The full-screen alt-screen transcript **viewport** (2.6.F Step 4b, [ADR-0068](../../../../docs/decisions/0068-full-screen-tui-renderer-ink7-harness.md) §c) —
 * the counterpart of ink's `<Static>` for the inline renderer. The alt buffer has no native scrollback, so instead of
 * printing every entry once (which `<Static>` does, writing to a scrollback the alt buffer lacks) the transcript is
 * flattened to width-wrapped {@link DisplayLine}s ({@link wrapTranscript}) and only the visible window is rendered.
 *
 * The window height is the box's flexbox-allocated leftover space: this Box is `flexGrow` beside the fixed live
 * region (the prompt / busy line / footer), so ink sizes it to `terminalRows − liveRegion`. We read that back with
 * `measureElement` (post-commit, in the effect) rather than re-deriving the live-region height — a stale offset or a
 * wrong count would corrupt the scroll position (the named risk in ADR-0068 §c). At steady state the height is
 * stable, so the measure/re-window CONVERGES; when the live region changes size (an overlay opens, a reasoning panel
 * appears) the height re-settles over a few frames, and `overflowY: hidden` clips the transient — cosmetic. The
 * height state seeds at 0, so the FIRST paint (before the post-commit measure lands) renders a BLANK transcript
 * region for one frame — deliberately: seeding an over-estimated terminal-rows height instead made the first frame
 * window PAST the real box capacity, and ink's write-coalescing rendered a non-contiguous (garbled) slice — a blank
 * frame is the safe transient (Step-4b-1 Sonnet review).
 *
 * SCROLL (Step 4b-2) passes an explicit `offset`; at Step 4b-1 `offset` is omitted and the window follows the TAIL
 * (an offset past the end clamps to the last full screen), so every append pins to the bottom.
 */

/** Map a display-line style to its ink `<Text>` color props, mirroring `TranscriptLine` exactly (assistant text is
 *  uncolored). Typed as a `<Text>` prop subset (not `Record<string, unknown>`) so a mistyped/invalid prop is caught. */
function styleProps(
  style: DisplayLine['style'],
  color: boolean,
): Partial<ComponentProps<typeof Text>> {
  switch (style) {
    case 'user':
      return colorProps(color, 'cyan');
    case 'notice':
      return dimProps(color);
    case 'summary':
      return colorProps(color, 'gray');
    case 'hint':
      return colorProps(color, 'yellow');
    case 'assistant':
      return {};
  }
}

export interface TranscriptViewportProps {
  /** The full transcript already flattened to width-wrapped, style-tagged display lines (`wrapTranscript`). */
  readonly lines: readonly DisplayLine[];
  readonly color: boolean;
  /** The owner-held scroll/auto-follow state (2.6.F Step 4b-2); the viewport derives the effective top-line offset
   *  from it + its own measured height (tail while following, else the clamped frozen offset). */
  readonly scroll: ScrollState;
  /** The active mouse selection, in WRAPPED-transcript coordinates (2.6.F Step 6). Absent ⇒ nothing highlighted. The
   *  viewport owns no selection state: it renders what its owner reduced, exactly as it does for `scroll`. */
  readonly selection?: SelectionRange | undefined;
  /** Reports the live geometry UP after each measure — total wrapped lines, the measured visible-row height, and the
   *  box's position in ink's frame — so the owner's scroll keymap can `reduceScroll` against the SAME geometry the
   *  viewport windows with (the height lives here, behind `measureElement`), and its MOUSE handler can turn a terminal
   *  row into a transcript line (Step 6). Omitted ⇒ not lifted (a caller with no scroll keymap). */
  readonly onMeasure?: ((geom: ViewportGeometry) => void) | undefined;
}

/**
 * The box's position in ink's FRAME, by summing yoga's computed offsets up the `parentNode` chain. `measureElement`
 * only exposes width/height, and a mouse report carries an absolute terminal row — so this is the missing half of the
 * mapping (2.6.F Step 6).
 *
 * MEASURED, not assumed: `transcript-viewport.test.tsx` renders a real ink tree and asserts this equals the frame's
 * own line index for the viewport's first row, with and without a header above it and with the live region grown.
 */
function frameOffset(node: DOMElement): { top: number; left: number } {
  let top = 0;
  let left = 0;
  let current: DOMElement | undefined = node;
  while (current !== undefined) {
    top += current.yogaNode?.getComputedTop() ?? 0;
    left += current.yogaNode?.getComputedLeft() ?? 0;
    current = current.parentNode;
  }
  return { top, left };
}

export function TranscriptViewport(props: Readonly<TranscriptViewportProps>): ReactElement {
  const ref = useRef<DOMElement | null>(null);
  // Seed 0 (a one-frame blank transcript before the post-commit measure lands) — the SAFE transient. Seeding an
  // over-estimated terminal-rows height instead windowed past the real box capacity and rendered a garbled,
  // non-contiguous slice on the first frame (Step-4b-1 Sonnet review).
  const [height, setHeight] = useState(0);
  // Measure AFTER every commit: re-clamp the window AND lift the live geometry up (so the owner's scroll keymap
  // reduces against the SAME {totalLines, height} the viewport windows with). The Box's height is flexbox-driven (the
  // leftover space beside the fixed live region), so `setHeight` only fires on a real change (resize / a live-region
  // size change / first layout), converging — never an unconditional loop (the `!==` guard). No dependency array on
  // purpose: a live turn re-renders constantly. `ref.current` is null-guarded (a not-yet-mounted node); `onMeasure`
  // only updates a caller ref (no re-render), so firing it each commit is cheap.
  useEffect(() => {
    const node = ref.current;
    if (node === null) return;
    const measured = measureElement(node);
    const { top, left } = frameOffset(node);
    props.onMeasure?.({
      totalLines: props.lines.length,
      height: measured.height,
      width: measured.width,
      top,
      left,
    });
    if (measured.height !== height) setHeight(measured.height);
  });
  // The effective top-line offset from the scroll state: the tail (maxOffset) while following, else the clamped
  // frozen offset (Step 4b-2). `windowLines` re-clamps too (belt-and-suspenders against a stale offset).
  const offset = effectiveOffset(props.scroll, { totalLines: props.lines.length, height });
  const visible = windowLines(props.lines, offset, height);
  return (
    <Box ref={ref} flexGrow={1} flexShrink={1} flexDirection="column" overflowY="hidden">
      {/* The array index IS the row identity: `visible` is a positional `slice` of the wrapped transcript (a fixed
          grid of `height` terminal rows), and each row is a STATELESS <Text>. So an index key lets React reuse row
          `i` and just swap its text/props — the cheapest and most faithful reconciliation for a scrolling viewport.
          A content-derived key would be strictly worse on both counts: blank rows all render as `' '` and repeated
          lines are common, so keys would COLLIDE (duplicate-key warning + wrong reuse), and every scroll notch would
          churn mounts instead of updating text. The usual index-key hazard (reordering items that own state) cannot
          arise here — nothing below holds state. */}
      {visible.map((line, index) => {
        // A blank row renders as a single space so it still occupies a terminal row — and so a selection that spans it
        // has something to highlight, exactly as the emulator's own selection would show.
        const text = line.text === '' ? ' ' : line.text;
        // `index` is the row on screen; the SELECTION lives in absolute wrapped-transcript coordinates, so translate.
        const span =
          props.selection === undefined ? undefined : lineSpan(offset + index, props.selection);
        const segments = span === undefined ? undefined : splitRow(text, span);
        return (
          <Text
            key={index} // NOSONAR — positional grid row, not a reorderable stateful item (see the comment above)
            {...styleProps(line.style, props.color)}
          >
            {segments === undefined ? (
              text
            ) : (
              <>
                {segments.before}
                <Text inverse>{segments.selected}</Text>
                {segments.after}
              </>
            )}
          </Text>
        );
      })}
    </Box>
  );
}
