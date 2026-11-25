/**
 * The `/effort` popup in a chat ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md) §1, §3,
 * §6; [MVP-11 §4.4](../../../../docs/roadmap/phases/mvp-11.md#44-reports-and-settings-as-popups)): one list of the reasoning tiers THIS model
 * takes (`effortTiersFor`, ADR-0071 §6: a tier the provider would refuse is not on the list), the tier in force marked `current`, opened on it
 * so a bare `Enter` changes nothing. `Enter` applies the highlighted tier to the session (no reseat, no config write), closes the popup, and the
 * host's notification says what changed; nothing is written into the transcript (the residue rule, §6). It replaces the docked tier overlay.
 *
 * Pure builders: the rows and the spec. The opener that answers `Enter` is `settings-session.ts`; neither is loaded until the person first opens
 * a setting (`settings-port.ts`).
 *
 * The rows are the product's words (a tier's label and hint, `effortRowLabel`); the model id, the one string a provider or a project wrote, is
 * read for the labels and never drawn.
 */

import type { ReasoningEffort } from '@relavium/shared';

import { effortRowLabel, projectEffortToRow } from '../chat/effort-notice.js';
import type { PopupContent, PopupListRow, PopupOrigin } from './frame-model.js';
import type { PopupSpec } from './popup-reducer.js';

/** The word beside the tier in force. */
export const EFFORT_CURRENT = 'current';

/** What the popup says when the model has no tier to choose after all (it was routed here a moment before: never expected). */
export const EFFORT_NONE = {
  what: 'This model has no reasoning effort to choose.',
  next: 'Choose a model that reasons with /models.',
} as const;

/**
 * The row the tier `tier` is drawn as, and the row that stands for the tier in force: a tier deduped away (DeepSeek's `low` sends `high`) or
 * collapsed (a budget model's `high` is its `on`) is marked on the row that represents it, as the overlay marked it.
 */
function currentRowOf(
  model: string,
  tiers: readonly ReasoningEffort[],
  current: ReasoningEffort | undefined,
): ReasoningEffort | undefined {
  return current === undefined ? undefined : projectEffortToRow(model, tiers, current);
}

/** The list of tiers: each its label (`on` for a budget model) and its one-line hint, the one in force with `current` after it. */
export function effortContent(
  model: string,
  tiers: readonly ReasoningEffort[],
  current: ReasoningEffort | undefined,
): PopupContent {
  if (tiers.length === 0) return { kind: 'empty', ...EFFORT_NONE };
  const marked = currentRowOf(model, tiers, current);
  const rows = tiers.map((tier): PopupListRow => {
    const { label, hint } = effortRowLabel(model, tier);
    return { id: tier, label, detail: tier === marked ? `${hint} · ${EFFORT_CURRENT}` : hint };
  });
  return { kind: 'list', rows };
}

/**
 * The row the popup opens on: the tier in force, projected onto the row that represents it; with none in force (the provider's default) the
 * neutral `medium`, projected the same way, as the overlay opened (a graded model with no `medium` row opens on its wire twin, never on `off`).
 */
export function effortInitialRow(
  model: string,
  tiers: readonly ReasoningEffort[],
  current: ReasoningEffort | undefined,
): string | undefined {
  return projectEffortToRow(model, tiers, current ?? 'medium');
}

/** The popup's spec: one step, `Enter` applies, `Esc` closes (nothing changes), opened on the row of the tier in force. */
export function effortSpec(
  origin: PopupOrigin,
  content: PopupContent,
  initialRow: string | undefined,
): PopupSpec {
  return {
    id: 'effort',
    title: '/effort',
    origin,
    steps: [{ name: 'Effort', content, enter: 'apply', initialRow }],
  };
}
