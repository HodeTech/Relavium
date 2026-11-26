import type { PopupFrame } from '../../../popups/popup-reducer.js';
import type { PopupBox, PropertyId } from './properties.js';
import type { Variant } from './variants.js';

/**
 * The registry of the surface matrix ([ADR-0145](../../../../../../docs/decisions/0145-the-cli-has-one-surface-language.md) §10): one entry
 * per surface of the product that can be mounted with the injection points the hosts already have, each saying how to put it on screen,
 * what marks it as shown, and which key leaves it. Every later step of MVP-11 registers its rows here.
 */

/**
 * A property a surface is KNOWN not to hold today. The matrix expects the failure and FAILS when the property starts holding, so the entry
 * cannot rot into a lie: whoever fixes the surface deletes the entry in the same commit.
 */
export interface KnownFailure {
  readonly property: PropertyId;
  /** What is wrong and where it is owned (a step of MVP-11, a register entry). */
  readonly reason: string;
  /** The cells in which it fails; absent ⇒ every cell the surface is mounted in. In the others the property must hold. */
  readonly where?: ((variant: Variant) => boolean) | undefined;
  /**
   * For a `height` failure: the most lines the surface may draw while it is known to fail. A known failure is not a licence to grow, so a
   * frame taller than this is a problem of its own.
   */
  readonly maxLines?: ((variant: Variant) => number) | undefined;
}

/** What every host's entry says, whatever the host. */
export interface SurfaceBase {
  /** `<host>.<name>`, matching a row of `PRODUCT_SURFACES`. */
  readonly id: string;
  readonly title: string;
  /**
   * The words of the key that leaves the surface and must be on screen (`Esc`, `Ctrl+C`): the least that is true today, so a rewording of
   * the legend by a later step does not break the row.
   */
  readonly exitKey: string;
  /** Text that is on screen only when THIS surface is: the guard against a surface that never opened and a frame that passes by being empty. */
  readonly landmark: string | RegExp;
  /**
   * Words that only the surface's SELECTED row has (a command's name, a model's): the matrix asserts that the last time they were written
   * to the terminal they were bold and inverse, in every cell, colour off included (ADR-0145 §5: the selection is the marker AND an inverse
   * row, because the marker alone cannot tell a selected row from the prompt), and that its row carries the marker (`›` with colour, `>`
   * without). Several words are several selections (a list's row and the tab above it). Absent for a surface that draws no selection.
   */
  readonly selectedRow?: string | readonly string[] | undefined;
  /**
   * The surface's own legend row, exactly as drawn (`↑/↓ select · Enter run · Esc close`): the matrix asserts it is on ONE row of the frame,
   * whole, in every cell where the surface renders (a popup drawn over the body: alone in the box's own columns of one of the box's rows, since
   * the dimmed backdrop shows beside it: `checkLegendRow`). An exit key and a landmark can survive a layout that draws a list over the legend,
   * so this is the property that names it. Absent for a surface whose legend is not one fixed row.
   */
  readonly legendRow?: string | readonly string[] | undefined;
  /**
   * What the surface does below the floor (60×20): a pattern its below-floor text matches (the default is the Home's "too small" notice and
   * the sheets' "enlarge the terminal"), or `'renders'` for a surface that draws normally there and keeps every property, exit key included.
   */
  readonly belowFloor?: RegExp | 'renders' | undefined;
  /** The cells to mount in, when it is not all of them (a surface that exists in one renderer only). Absent ⇒ every cell. */
  readonly variants?: ((variant: Variant) => boolean) | undefined;
  readonly knownFailure?: KnownFailure | readonly KnownFailure[] | undefined;
  readonly notes?: string | undefined;
  /**
   * The surface is a popup (ADR-0148): where it is drawn in this cell and what its rows are, from the one geometry function and the frame
   * model. The matrix then expects exactly one absolutely positioned node (the slot, last in the tree), the popup's own rows in its box, no
   * cell outside it changed from the frame the surface recorded before opening it (`popup-fixture.ts`), and, in the alternate screen with colour
   * on, every cell of that body dim on a body that held bold, inverse and coloured spans (`backdrop-dim`, ADR-0148 §4). Absent ⇒ the tree
   * positions nothing.
   *
   * **The body each popup surface sits over** (each records it with `recordBaseline` before it opens the popup, and says so in its `notes`):
   *
   * | surface | the body behind the popup |
   * | --- | --- |
   * | `home.popup` | the empty, keyed landing: the banner, the wordmark (bold), the hints, the prompt and its cursor (inverse) |
   * | `home.popup-populated` | the populated landing: the attention row of a failed run, the strips of conversations, runs and agents |
   * | `home.popup-selected-row` | the same, with the failed run focused by `↓`: a bold-and-inverse row under the dim (a popup cannot open over a tab screen) |
   * | `chat.popup`, `standalone-chat.popup` | one short exchange with a strong word, and the prompt with its cursor |
   * | `chat.popup-rich`, `standalone-chat.popup-rich` | a user turn, a tool row, a markdown answer (heading, strong, code, quote, list, table, fenced block), a second exchange and a draft in the prompt |
   * | `home.doctor-*` | the empty, keyed landing (the `/doctor` popup, opened by typing the command, in each of its states) |
   * | `chat.doctor-*`, `standalone-chat.doctor-*` | one short exchange with a strong word, and the prompt with its cursor |
   * | `chat.report-*`, `standalone-chat.report-*` | the same short exchange (the `/agent`, `/cost`, `/workflows` and `/help` popups, in each state) |
   *
   * A product popup's rows come from `live`, the frame its host has open now, through the same geometry and frame model (`popupBoxOf`): the
   * check is then that the terminal shows exactly that frame, in its box, over an unchanged body. `locked` is the host's lock now
   * (`PopupHost.lock`): the slot draws a waiting legend part (`(wait)`) while it holds, and so does the expected box.
   */
  readonly popup?:
    | ((variant: Variant, live?: PopupFrame, locked?: boolean) => PopupBox)
    | undefined;
  /**
   * A popup surface whose body behind it holds NO inverse cell BY DESIGN, and the reason (one line, never empty). Read ONLY by `checkBackdropDim`,
   * and there only to drop its demand that the body held an inverse cell before the popup opened; the demands that the body held a bold cell and a
   * coloured one, and every assertion that the backdrop is dim, stay. The demand exists so the dim check cannot pass on a plain body; a body whose
   * only selection is a tinted Attention row (`›`, bold and the tint, no inverse: MVP-11 unit 7) is not plain, and has none. A surface that does not
   * say this is held to the whole demand, and `backdrop-properties.test.ts` pins the surfaces that do.
   */
  readonly backdropHasNoInverse?: string | undefined;
}

export const knownFailuresOf = (entry: SurfaceBase): readonly KnownFailure[] => {
  const known = entry.knownFailure;
  if (known === undefined) return [];
  return 'property' in known ? [known] : known;
};

/** The notice a surface is expected to show below the floor unless it says otherwise. */
export const DEFAULT_BELOW_FLOOR = /too small|nlarge the terminal/iu;
