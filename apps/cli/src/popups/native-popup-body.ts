/**
 * The native prompt channel as a popup body ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
 * §2 "One shared pure frame with two body drivers"): when a flow sets the channel's optional `popup` descriptor, its prompt is drawn inside
 * the popup frame instead of as a card. The channel keeps every rule it has (its keys, its validation, its secret handling, its acknowledgement);
 * this module only turns its snapshot into the frame's body rows and legend.
 *
 * Only the prompts a popup flow is made of are framed here: a choice (`select`), a text or a masked field (`text`, `password`) and a wait
 * (`busy`, static: nothing ticks in a popup's body). A picker keeps its card (its live result list is a screen of its own), and so does a chord
 * card: a chord step moves into a popup only in the increment that brings its evidence and its security sitting (§9). Used by the flows of
 * unit 6; this part plumbs it and tests it.
 */

import { exitKey, type LegendExit, type LegendItem } from '../render/tui/legend.js';
import { nativeLeave, type NativePromptSnapshot } from '../render/tui/native-prompt-channel.js';
import { glyph } from '../render/tui/glyphs.js';
import {
  clipLine,
  markedWindow,
  windowMarkers,
  type SheetLine,
} from '../render/tui/sheet-frame.js';
import { popupText } from './frame-model.js';

const FRAMED_KINDS: ReadonlySet<NativePromptSnapshot['kind']> = new Set([
  'select',
  'text',
  'password',
  'busy',
]);

/** Whether the channel's open prompt is drawn as a popup: a flow set the descriptor, and the prompt is one a popup frame draws. */
export function nativeFramed(snapshot: NativePromptSnapshot): boolean {
  return snapshot.active && snapshot.popup !== undefined && FRAMED_KINDS.has(snapshot.kind);
}

/** The body rows a framed prompt would like, before any window. */
export function nativeNaturalRows(snapshot: NativePromptSnapshot): number {
  return (
    (snapshot.note === '' ? 0 : 1) +
    (snapshot.message === '' ? 0 : 1) +
    (snapshot.kind === 'select' ? Math.max(1, snapshot.options.length) : 0) +
    (snapshot.kind === 'text' || snapshot.kind === 'password' ? 1 : 0) +
    (snapshot.error === '' ? 0 : 1)
  );
}

/** The body rows of a framed prompt, a list in at most `listRows` rows, each clipped to `width`. Run inside `withGlyphForm`. */
export function nativePopupBody(
  snapshot: NativePromptSnapshot,
  geometry: { readonly bodyRows: number; readonly listRows: number; readonly innerWidth: number },
): readonly SheetLine[] {
  const width = geometry.innerWidth;
  const line = (kind: SheetLine['kind'], text: string): SheetLine => ({
    kind,
    text: clipLine(text, width),
  });
  const out: SheetLine[] = [];
  if (snapshot.note !== '') out.push(line('text', popupText(snapshot.note)));
  if (snapshot.message !== '') out.push(line('message', popupText(snapshot.message)));
  if (snapshot.kind === 'select') {
    const fixed = out.length + (snapshot.error === '' ? 0 : 1);
    const height = Math.max(1, Math.min(geometry.listRows, geometry.bodyRows - fixed));
    const window = markedWindow(snapshot.options.length, snapshot.selected, height);
    const markers = windowMarkers(window);
    for (let index = window.start; index < window.end; index += 1) {
      if (index === window.start && markers.above !== undefined)
        out.push(line('marker', `  ${markers.above}`));
      else if (index === window.end - 1 && markers.below !== undefined)
        out.push(line('marker', `  ${markers.below}`));
      else {
        const option = snapshot.options[index];
        if (option === undefined) continue;
        const selected = index === snapshot.selected;
        const hint = option.hint === undefined ? '' : `  ${popupText(option.hint)}`;
        out.push(
          line(
            selected ? 'selected' : 'row',
            `${selected ? glyph('selection') : ' '} ${popupText(option.label)}${hint}`,
          ),
        );
      }
    }
  }
  // What is typed is the channel's display: bullets for a secret, never the secret itself.
  if (snapshot.kind === 'text' || snapshot.kind === 'password')
    out.push(line('row', `> ${snapshot.display}`));
  if (snapshot.error !== '') out.push(line('failed', popupText(snapshot.error)));
  return out.slice(0, geometry.bodyRows);
}

/** The legend of a framed prompt: what its keys do, and the way back the channel's `escape` gives it, in the descriptor's words. */
export function nativePopupLegend(snapshot: NativePromptSnapshot): {
  readonly items: readonly LegendItem[];
  readonly exit: LegendExit;
} {
  const back = snapshot.escape === 'back';
  const { before, exit } = nativeLeave(back, snapshot.kind === 'busy' ? 'cancels it' : undefined);
  const label = snapshot.popup?.exitLabel ?? '';
  const named = exit.class === 'close' && label !== '' ? exitKey.close(exit.keys, label) : exit;
  const keys: LegendItem[] =
    snapshot.kind === 'select'
      ? [
          { keys: '↑/↓', verb: 'select' },
          { keys: 'Enter', verb: 'choose' },
        ]
      : snapshot.kind === 'text' || snapshot.kind === 'password'
        ? [{ keys: 'Enter', verb: 'continue' }]
        : [];
  return { items: [...keys, ...before], exit: named };
}
