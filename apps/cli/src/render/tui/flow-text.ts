import { inertLegendText } from './legend.js';
import { authorLine } from './run-card-model.js';

/**
 * The full scrub of the words a Home flow draws in its popup that a project, a file, a provider, a model or a person wrote
 * ([ADR-0148](../../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md) §1, §3;
 * [ADR-0145](../../../../../docs/decisions/0145-the-cli-has-one-surface-language.md) §5): a slug, a path, a model id, a refusal that quotes one.
 *
 * It IS the popups' scrub (`scrubPopupText`, `popups/popup-text.ts`): the run cards' author-text floor (`authorLine`: secrets scrubbed, control,
 * bidirectional and invisible characters removed, compatibility forms folded, host glyphs blanked, an answer chord such as `Ctrl+Y` replaced),
 * then the legend's key tokens and separators made inert. It is written here because the flows of `/init`, `/import`, `/pricing` and the
 * Defined tab's export are in the Home's first paint and `popup-text.ts` is loaded only when a report popup opens (`popups/lazy-load.test.ts`);
 * `flow-text.test.ts` (beside this file) holds the two equal over the hostile corpus, so they cannot drift apart.
 *
 * Applied by the flow BEFORE the text reaches the channel: the popup body's own pass on a chord step (`inertLegendText`) is not a scrub (a bare
 * `Press Ctrl+Y now` and a key-shaped string would be drawn as written), and a select step has no such pass at all.
 */
export function flowText(text: string): string {
  return inertLegendText(authorLine(text));
}

/**
 * The words of the one option that closes a flow's refusal or failed last step (`/init`, `/import`, `/pricing`, `/export`, `/run`): written
 * once, here, so five flows cannot say it five ways. A PRODUCT constant, never data: it goes to the channel without the scrub.
 */
export const FLOW_CLOSE_LABEL = 'Close';
