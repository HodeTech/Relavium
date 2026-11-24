import type { KnownFailure } from './registry.js';

/**
 * The failures the matrix found the first time it ran, each owned by a later step of MVP-11 or by the register. An entry is an expected
 * failure: the matrix FAILS when the property starts to hold, so whoever fixes the surface deletes the entry in the same commit.
 */

/**
 * Every full-screen chat surface that draws the conversation viewport is exactly `rows` lines tall: `ChatApp` and the Home's `ChatRegion`
 * bound the viewport to the terminal (`height: viewport.rows`, [ADR-0068](../../../../../../docs/decisions/0068-full-screen-tui-renderer-ink7-harness.md)
 * §c), so the live frame fills the screen. The plan's bound is `rows − 1` ([MVP-11 §5.6](../../../../../../docs/roadmap/phases/mvp-11.md)):
 * Ink 7.1 writes a frame as tall as the terminal without a trailing newline and treats it as full-screen (its `shouldClearTerminalForFrame`
 * clears the whole terminal when such a frame is left for a shorter one and when the tree unmounts, and for every such frame on a Windows
 * console). Either the chat's viewport changes to `rows − 1`, or the plan's bound for the full-screen chat is relaxed to `rows` in one
 * place; until one of them is ruled, the matrix pins "never taller than the terminal" so it cannot grow.
 */
export const FULL_SCREEN_CHAT_FILLS_THE_TERMINAL: KnownFailure = {
  property: 'height',
  reason:
    'the full-screen chat viewport is bounded to exactly `rows` lines (ADR-0068 §c), not `rows − 1`',
  where: (variant) => variant.renderer === 'alt',
  maxLines: (variant) => variant.size.rows,
};

/**
 * The Home-hosted chat's `/` palette, inline, is taller than an 80×24 terminal and so makes Ink clear the scrollback. Cause: `home-app.tsx`'s
 * `ChatRegion` passes `maxRows` to `PaletteView` only when it has a viewport (the full-screen renderer), so the inline palette lists every
 * entry; `ChatApp` passes `rows − 1` in both renderers.
 */
export const HOSTED_CHAT_PALETTE_OVERFLOWS_INLINE: readonly KnownFailure[] = [
  {
    property: 'height',
    reason:
      'the palette of the chat the Home hosts is not windowed in the inline renderer (ChatRegion passes maxRows only with a viewport): 29 lines at 80×24',
    where: (variant) => variant.renderer === 'inline' && variant.size.rows === 24,
    maxLines: () => 29,
  },
  {
    property: 'no-scrollback-clear',
    reason:
      'a frame taller than the terminal makes Ink write its clear-terminal sequence, which wipes the scrollback',
    where: (variant) => variant.renderer === 'inline' && variant.size.rows === 24,
  },
];

/** The stand-alone chat's `/` palette, inline at 80×24, fills the terminal to its last row. */
export const STANDALONE_CHAT_PALETTE_FILLS_INLINE: KnownFailure = {
  property: 'height',
  reason:
    'the palette of the stand-alone chat is 24 lines at 80×24 (a full terminal), one more than the bound',
  where: (variant) => variant.renderer === 'inline' && variant.size.rows === 24,
  maxLines: (variant) => variant.size.rows,
};
