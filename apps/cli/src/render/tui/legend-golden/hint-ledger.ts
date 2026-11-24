/**
 * What the completeness guard (`legend-completeness.test.ts`) reads: the files that may write a hint-shaped string, how many each
 * writes, and the strings it is allowed not to cover. The shape is {@link isHintShaped} (`hint-shape.ts`).
 *
 * **This is the list the conversion to the builder shrinks.** Step 3 moves a producer onto `legend()`, and the literals of its file
 * disappear: the guard then fails until the count here is lowered (and the entry deleted at zero), so the ledger can only get shorter
 * and a hint written by hand in a file that was already converted is caught. Adding a literal to a file that is listed fails too, until a
 * recorder says what it emits.
 */

/** Production files that write hint-shaped strings by hand, and how many such strings each writes (`apps/cli/src`, `/` separators). */
export const HINT_LITERAL_FILES: Readonly<Record<string, number>> = {
  // `Any other key cancels`: a sentence that says what every key but the listed ones does. It names no key to bracket, so it stays prose
  // beside the legend (ADR-0145 §3: free text between the keys); the handler is the one `any other key` branch of the card it sits on.
  'render/tui/permissions-sheet.ts': 1,
  'render/tui/tab-host-history.ts': 1,
  'render/tui/tool-review-card.ts': 2,
  'render/tui/tool-review-screen.ts': 2,
};

/**
 * A place that may hold a hint-shaped string without being a producer of one, and why. `file` is a path under `apps/cli/src`; a path
 * that ends in `/` is a directory and covers everything under it. `contains` narrows an entry to the one string that contains it, and
 * such an entry fails when it no longer matches anything, so a stale allowance cannot hide a real hint later.
 */
export interface NotALegend {
  readonly file: string;
  readonly contains?: string;
  readonly reason: string;
}

export const NOT_A_LEGEND: readonly NotALegend[] = [
  {
    file: 'render/tui/legend-golden/',
    reason:
      'this directory: the recorders drive the producers and quote what they say, and the guard’s own tables and tests name keys; none of it is shown to a person',
  },
  {
    file: 'render/tui/surface-matrix/',
    reason:
      'the surface matrix harness (MVP-11 Step 3): test support whose rows are fixtures describing surfaces, not a producer of a legend',
  },
];
