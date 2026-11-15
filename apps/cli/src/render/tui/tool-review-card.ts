import type { ToolPreview } from '@relavium/core';

import type { ReviewDocument } from './tool-review-projection.js';
import { displayWidth } from './viewport.js';

/**
 * The docked approval card's wording and arithmetic ([ADR-0129](../../../../../docs/decisions/0129-the-approval-card-is-docked-bounded-and-says-only-what-matters.md)).
 *
 * Framework-free and pure, so the model (which budgets the card's rows) and the view (which draws them) cannot
 * disagree about how many rows the chrome takes, and the words are testable without React. Nothing here touches
 * the safety machinery: what must be inspected, what disables an answer and what a frame must contain are still
 * decided by the review state machine and projection. This module only decides how the card SAYS it.
 */

/** The transcript rows that stay on screen above the card, whatever the terminal size. */
export const CARD_MIN_TRANSCRIPT_ROWS = 8;
/** Rows the live region needs besides the card (the busy line, the footer, the hint). */
const LIVE_REGION_ROWS = 4;
/** The most body rows the card ever shows: a longer change is cut with an exact count. */
export const CARD_MAX_BODY_ROWS = 60;
/** The answer-key rows and the stop hint: always these two rows, so the budget never depends on the labels. */
export const CARD_KEY_ROWS = 2;
/** The thin rule that separates the card from the conversation above it. */
export const CARD_RULE_ROWS = 1;

/**
 * The most rows the docked card may take: three fifths of the terminal, and never so many that fewer than
 * {@link CARD_MIN_TRANSCRIPT_ROWS} transcript rows remain. At the 80×24 floor that is twelve rows, so a short
 * change is shown whole on a larger terminal while the conversation stays in view on a small one.
 */
export function cardRowBudget(terminalRows: number): number {
  return Math.max(
    8,
    Math.min(
      Math.floor((terminalRows * 3) / 5),
      terminalRows - CARD_MIN_TRANSCRIPT_ROWS - LIVE_REGION_ROWS,
    ),
  );
}

/** What the call does, in one word: the first thing the person needs to know. */
export function cardVerb(toolId: string, action: string, preview: ToolPreview | undefined): string {
  const diff = preview?.diff;
  if (diff !== undefined) {
    if (diff.before === null) return 'Create';
    return toolId === 'edit_file' ? 'Edit' : 'Overwrite';
  }
  switch (action) {
    case 'process':
      return 'Run';
    case 'egress':
      return 'Request';
    case 'os':
      return 'Use';
    default:
      return 'Apply';
  }
}

/** `+17 −0 · 468 bytes` for a change; empty for a preview that carries no diff. */
export function cardStats(document: ReviewDocument | undefined): string {
  const diff = document?.preview.diff;
  if (document === undefined || diff === undefined) return '';
  return `+${diff.stats.addedLines} −${diff.stats.removedLines} · ${document.changedBytes} bytes`;
}

/** How a side's line-ending convention reads in a warning. */
function endingsWord(endings: string): string {
  switch (endings) {
    case 'lf':
      return 'LF';
    case 'crlf':
      return 'CRLF';
    case 'mixed':
      return 'mixed';
    case 'none':
      return 'no final newline';
    default:
      return 'empty';
  }
}

export interface CardWarningInput {
  readonly document: ReviewDocument | undefined;
  /** The target field did not fit its rows; `hiddenBytes` of it are omitted. */
  readonly shortenedTarget: boolean;
  readonly targetHiddenBytes: number;
  /** Whether every requirement for an affirmative answer has been met. */
  readonly inspected: boolean;
  /** The card's drawable width, so a warning is wrapped by US and the row budget is exact. */
  readonly columns: number;
}

/** Word-wrap `text` to `width` display columns; a continuation row is indented two columns. */
export function wrapWords(text: string, width: number): readonly string[] {
  const limit = Math.max(8, width);
  const rows: string[] = [];
  let row = '';
  for (const word of text.split(' ')) {
    const candidate = row.length === 0 ? word : `${row} ${word}`;
    if (displayWidth(candidate) <= limit || row.length === 0) {
      row = candidate;
    } else {
      rows.push(row);
      row = `  ${word}`;
    }
  }
  if (row.length > 0) rows.push(row);
  return rows;
}

/**
 * The warning rows, each warning only when it applies and already wrapped to the card's width. A clean change
 * carries none: a zero is not displayed as a fact, and the full view always lists the counts (ADR-0129 §3).
 */
export function cardWarnings(input: CardWarningInput): readonly string[] {
  const { document } = input;
  const warnings: string[] = [];
  if (input.shortenedTarget) {
    warnings.push(
      `\u26a0 Target shortened \u2014 ${input.targetHiddenBytes} bytes omitted. Press [v] to read all of it; Allow stays locked until you do.`,
    );
  }
  if (document !== undefined && document.required.length > 0) {
    const count = document.masks.length;
    warnings.push(
      `\u26a0 ${count} masked value${count === 1 ? '' : 's'} in this change. Press [v], then [r] to inspect ${count === 1 ? 'it' : 'them'}; Allow stays locked until you do.`,
    );
  }
  const diff = document?.preview.diff;
  if (diff !== undefined) {
    const before = diff.beforeEndings;
    const after = diff.afterEndings;
    const plain = (endings: string): boolean => endings === 'lf' || endings === 'empty';
    if (!(plain(before) && plain(after))) {
      warnings.push(
        before === 'empty'
          ? `\u26a0 Line endings: ${endingsWord(after)}.`
          : `\u26a0 Line endings: ${endingsWord(before)} \u2192 ${endingsWord(after)}.`,
      );
    }
  }
  if (warnings.length === 0 && !input.inspected) {
    warnings.push('\u26a0 Allow is locked until the required content has been inspected ([v]).');
  }
  return warnings.flatMap((warning) => wrapWords(warning, input.columns));
}

/** How a tool's `[a]` scope reads: what "always" would cover, in the person's words. */
export function cardScopePhrase(toolId: string): string {
  if (toolId === 'write_file') return 'file writes';
  if (toolId === 'edit_file') return 'file edits';
  const shown = [...toolId].length > 16 ? `${[...toolId].slice(0, 15).join('')}…` : toolId;
  return `${shown} calls`;
}

export interface CardKeyInput {
  /** `false` while Allow is locked behind an inspection. */
  readonly inspected: boolean;
  /** Whether an "always" answer would be remembered. */
  readonly cacheable: boolean;
  /** The already-escaped scope phrase ({@link cardScopePhrase}, escaped by the caller). */
  readonly scope: string;
}

/** The two key rows: the answers, then the rest. Allow is not offered while it is locked. */
export function cardKeyRows(input: CardKeyInput): readonly [string, string] {
  const answers = input.inspected
    ? `[y] Allow   ${input.cacheable ? `[a] Allow all ${input.scope} this session   ` : ''}[n] Deny`
    : '[n] Deny   (Allow is locked until you inspect the change)';
  return [answers, '[c] Deny + reason   [v] Full diff   Esc stops the turn'];
}

/** Rows a denial-reason capture takes beyond the key rows it replaces (the disclosure above the input). */
export function cardDenialExtraRows(disclosureRows: number): number {
  return disclosureRows + 1;
}
