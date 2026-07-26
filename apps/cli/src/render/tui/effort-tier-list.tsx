import { Box, Text } from 'ink';
import type { ReactElement } from 'react';

import { type ReasoningEffort } from '@relavium/shared';

import { effortRowLabel, projectEffortToRow } from '../../chat/effort-notice.js';
import { sanitizeInline } from './chat-projection.js';
import { colorProps, dimProps } from './projection.js';

/**
 * The shared reasoning-effort tier list (ADR-0066/0071) — the per-model picker body used by BOTH the `/models`
 * effort sub-step ({@link model-picker-view.tsx}'s `EffortSubList`, reached after choosing a reasoning model on a
 * reseat surface) and the standalone `/effort` overlay ({@link effort-picker.ts}). One canonical presentation so the
 * two entry points can never drift: each tier + its one-line hint, the highlighted row in cyan, and a `✓` on the
 * session's currently-bound effort. The header suffix (a provider-controlled model name) is sanitized at this display
 * boundary, exactly as the model rows are — a crafted name can neither forge a row nor inject a terminal escape.
 *
 * PURE: it owns no `useInput`; the surface routes keys to the fold and re-renders this from the resulting state.
 */
export interface EffortTierListProps {
  /**
   * The tiers to show — the ones THIS MODEL accepts (ADR-0071 §6), never the fixed five. `gpt-5.4-pro` rejects
   * `low` and `gemini-2.5-pro` cannot be turned off; offering a row the provider would 400 on is the bug.
   */
  readonly tiers: readonly ReasoningEffort[];
  /** The bound model id — decides a tier's DISPLAY label (a budget model's `medium` reads "on"; ADR-0066 amendment).
   *  Not shown itself; the header suffix names the model. */
  readonly model: string;
  /** The highlighted tier index (already clamped by the caller's fold, but re-clamped here for display safety). */
  readonly selected: number;
  /** The session's currently-bound effort — the `✓` marker; `undefined` ⇒ no tier bound (the provider default). */
  readonly current: ReasoningEffort | undefined;
  /** A trailing context label after the "Reasoning effort" header (e.g. the bound model's name) — sanitized here;
   *  `undefined` ⇒ no suffix. */
  readonly labelSuffix?: string | undefined;
  /** The nav-hint footer — differs by entry point ("Esc back" in the model sub-step vs "Esc cancel" standalone). */
  readonly footer: string;
  readonly color: boolean;
}

export function EffortTierList(props: Readonly<EffortTierListProps>): ReactElement {
  const { tiers, model, selected, current, labelSuffix, footer, color } = props;
  // Re-clamp for display: a caller could pass an out-of-range index (a shrunk source, a stale render) — never index
  // past the end of a list whose length now varies per model (`gpt-5-pro` has ONE row).
  const highlighted = Math.max(0, Math.min(selected, tiers.length - 1));
  // The ✓ lands on the row that REPRESENTS the bound tier — projected, so a bound tier that was deduped away
  // (deepseek `low` → the `high` row) or collapsed (a budget model's bound `high` → the `on` row) still marks a row.
  const currentRow = current === undefined ? undefined : projectEffortToRow(model, tiers, current);
  const suffix = labelSuffix === undefined || labelSuffix.length === 0 ? '' : ` · ${labelSuffix}`;
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text {...colorProps(color, 'cyan')} wrap="truncate-end">
        Reasoning effort
        <Text {...dimProps(color)}>{sanitizeInline(suffix)}</Text>
      </Text>
      {tiers.map((effort, index) => {
        const isSelected = index === highlighted;
        const isCurrent = effort === currentRow;
        const rowColor = isSelected ? colorProps(color, 'cyan') : {};
        const { label, hint } = effortRowLabel(model, effort);
        return (
          <Text key={effort} {...rowColor} wrap="truncate-end">
            {`${isSelected ? '›' : ' '} ${isCurrent ? '✓' : ' '} ${label} · `}
            <Text {...dimProps(color)}>{hint}</Text>
          </Text>
        );
      })}
      <Text {...dimProps(color)} wrap="truncate-end">
        {footer}
      </Text>
    </Box>
  );
}
