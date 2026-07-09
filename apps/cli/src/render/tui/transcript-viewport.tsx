import { Box, Text, measureElement, type DOMElement } from 'ink';
import { useEffect, useRef, useState, type ComponentProps, type ReactElement } from 'react';

import { colorProps, dimProps } from './projection.js';
import { effectiveOffset, type ScrollGeometry, type ScrollState } from './scroll.js';
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
  /** Reports the live geometry (total wrapped lines + the measured visible-row height) UP after each measure, so the
   *  owner's scroll keymap can `reduceScroll` against the SAME geometry the viewport windows with (the height lives
   *  here, behind `measureElement`). Omitted ⇒ not lifted (a caller with no scroll keymap). */
  readonly onMeasure?: ((geom: ScrollGeometry) => void) | undefined;
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
    props.onMeasure?.({ totalLines: props.lines.length, height: measured.height });
    if (measured.height !== height) setHeight(measured.height);
  });
  // The effective top-line offset from the scroll state: the tail (maxOffset) while following, else the clamped
  // frozen offset (Step 4b-2). `windowLines` re-clamps too (belt-and-suspenders against a stale offset).
  const offset = effectiveOffset(props.scroll, { totalLines: props.lines.length, height });
  const visible = windowLines(props.lines, offset, height);
  return (
    <Box ref={ref} flexGrow={1} flexShrink={1} flexDirection="column" overflowY="hidden">
      {visible.map((line, index) => (
        <Text key={index} {...styleProps(line.style, props.color)}>
          {line.text === '' ? ' ' : line.text}
        </Text>
      ))}
    </Box>
  );
}
