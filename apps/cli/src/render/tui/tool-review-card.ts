import type { ToolPreview } from '@relavium/core';

import type { CommandCardFacts } from '../../chat/command-facts.js';
import { sanitizeInline } from '../sanitize.js';
import { glyph } from './glyphs.js';
import { exitKey, keyToken, type LegendItem } from './legend.js';
import { exitRow, itemsRow, sentenceRow, type LegendRow } from './legend-row.js';
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

/** Every word the card's title can open with, so the room it takes is derived from the words, not assumed. */
export const CARD_VERBS = [
  'Create',
  'Edit',
  'Overwrite',
  'Run',
  'Request',
  'Use',
  'Apply',
] as const;
export type CardVerb = (typeof CARD_VERBS)[number];
/**
 * Columns the title spends before the target: the longest verb and the space after it. The target is projected
 * into what is left of the row, so a path that ends at the edge of the projection is also the end of what the
 * title row can draw — and the shortened-target warning and the Allow lock see the same budget.
 */
export const CARD_VERB_COLUMNS = Math.max(...CARD_VERBS.map((verb) => displayWidth(verb))) + 1;

/** What the call does, in one word: the first thing the person needs to know. */
export function cardVerb(
  toolId: string,
  action: string,
  preview: ToolPreview | undefined,
): CardVerb {
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

/**
 * What changed about the line endings, or `undefined` when nothing the person should weigh did: a convention that
 * is the same on both sides says nothing (a CRLF file edited as CRLF), while a different one, a `mixed` side, or a
 * change that only adds or drops the final newline does. The ordinary LF/empty pair (a new, emptied or LF file) is
 * not worth a row either.
 */
export function endingsWarning(diff: NonNullable<ToolPreview['diff']>): string | undefined {
  const before = diff.beforeEndings;
  const after = diff.afterEndings;
  const plain = (endings: string): boolean => endings === 'lf' || endings === 'empty';
  if (!(plain(before) && plain(after))) {
    if (before === 'empty') return endingsWord(after);
    if (before !== after || before === 'mixed')
      return `${endingsWord(before)} \u2192 ${endingsWord(after)}`;
  }
  // Both sides read the same, so only the last line's terminator can differ: `a\nb` and `a\nb\n` are both `lf`.
  const was = diff.before ?? '';
  if (was.length === 0 || diff.after.length === 0) return undefined;
  if (was.endsWith('\n') === diff.after.endsWith('\n')) return undefined;
  return diff.after.endsWith('\n') ? 'final newline added' : 'final newline removed';
}

export interface CardWarningInput {
  readonly document: ReviewDocument | undefined;
  /** The target field did not fit its rows; `hiddenBytes` of it are omitted. */
  readonly shortenedTarget: boolean;
  readonly targetHiddenBytes: number;
  /** Whether every requirement for an affirmative answer has been met. */
  readonly inspected: boolean;
  /** Changed lines this card's body does not draw (`ReviewPage.hiddenChanges`); the person must be told. */
  readonly changesNotShown: number;
  /**
   * Lines of the call this card's body does not draw (`ReviewPage.hiddenLines`), for a preview WITHOUT a diff — a clipped
   * argument vector is what executes, and no changed-line count sees it. Ignored for a diff (it has `changesNotShown`).
   */
  readonly linesNotShown?: number;
  /** The card's drawable width, so a warning is wrapped by US and the row budget is exact. */
  readonly columns: number;
  /** A command's standing, directory and warnings (ADR-0118 §1): drawn before the other warnings. Absent for any other call. */
  readonly commandFacts?: CommandCardFacts | undefined;
  /** The denial reason box is open: a command's plain rows (standing, directory) give way to it; its warnings stay. */
  readonly denialOpen?: boolean | undefined;
}

/** `text` cut to `width` display columns from the FRONT, keeping its end (the part of a path that names where it is). */
function keepEnd(text: string, width: number): string {
  if (displayWidth(text) <= width) return text;
  const kept: string[] = [];
  let used = 1; // the ellipsis
  for (const char of [...text].reverse()) {
    const next = displayWidth(char);
    if (used + next > width) break;
    kept.unshift(char);
    used += next;
  }
  return `\u2026${kept.join('')}`;
}

/** The standing row of a command card: where the command stands before the person answers. */
export function commandStandingRow(facts: CommandCardFacts): string {
  switch (facts.standing) {
    case 'allowlisted':
      // The allowlist is the project's file, not the person's: `auto` asks about such a command all the same.
      return 'Standing: on this project’s allowlist';
    case 'remembered':
      if (facts.filesChanged === true) {
        return 'Standing: remembered for this project; asks because files changed this session';
      }
      return facts.grantOutdated === true
        ? 'Standing: remembered for this project; asks because files changed since'
        : 'Standing: remembered for this project';
    default:
      return 'Standing: not pre-approved';
  }
}

/**
 * The rows a command card adds (ADR-0118 §1), as plain text, wrapped by the caller: the standing, the directory the host pins,
 * and the two warnings, each worded as a fact and neither ever refusing a command. The directory is the host's own path, but it is
 * still shown through the one-line sanitizer.
 */
export function commandFactRows(
  facts: CommandCardFacts,
  columns = 76,
  compact = false,
): readonly string[] {
  const label = 'Runs in: ';
  const rows: string[] = [];
  // While the reason box is open the card has no room to spare: the warnings stay, the plain rows go (the box is for typing).
  if (!compact) {
    const standing = commandStandingRow(facts);
    const directory = sanitizeInline(facts.cwd) || '(the workspace)';
    // One row when the directory still has room to say where it is (it keeps its END), else two: a row saved is a row of the command.
    const separator = ' \u00b7 ';
    const room = columns - displayWidth(standing) - separator.length - label.length;
    if (room >= 24) rows.push(`${standing}${separator}${label}${keepEnd(directory, room)}`);
    else rows.push(standing, `${label}${keepEnd(directory, Math.max(8, columns - label.length))}`);
  }
  // One row each: the key that is not offered is already missing from the legend, so these say why in few words.
  if (facts.runsCode)
    rows.push(
      `${glyph('warning')} Runs code: a shell, an inline script or a wrapper. Remember is not offered.`,
    );
  if (facts.protectedPath)
    rows.push(
      `${glyph('warning')} Names a protected path (its output goes to the model). Allow once only.`,
    );
  return rows;
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
  const warnings: string[] =
    input.commandFacts === undefined
      ? []
      : [...commandFactRows(input.commandFacts, input.columns, input.denialOpen === true)];
  const factRows = warnings.length;
  // The lock sentence is the instruction for getting Allow back, so it is only true until the person has
  // inspected: afterwards the key rows offer Allow, and a warning that still says "locked" would contradict them
  //. The fact itself stays — it is what the person was shown.
  if (input.shortenedTarget) {
    warnings.push(
      input.inspected
        ? `${glyph('warning')} Target shortened \u2014 ${input.targetHiddenBytes} bytes omitted.`
        : `${glyph('warning')} Target shortened \u2014 ${input.targetHiddenBytes} bytes omitted. Press ${keyToken('v')} to read all of it; Allow stays locked until you do.`,
    );
  }
  if (document !== undefined && document.required.length > 0) {
    const count = document.masks.length;
    // A command's masked value can show up in two places (its quoted line and its own row), and it is not a "change".
    const values = `${count} masked value${count === 1 ? '' : 's'} in this ${input.commandFacts === undefined ? 'change' : 'command'}.`;
    warnings.push(
      input.inspected
        ? `${glyph('warning')} ${values}`
        : `${glyph('warning')} ${values} Press ${keyToken('v')}, then ${keyToken('r')} to inspect ${count === 1 ? 'it' : 'them'}; Allow stays locked until you do.`,
    );
  }
  // A change the body cannot reach is the one thing the person must not approve unseen, so it is named — with the
  // way to read it — whenever it is true. (The card also offers no Allow-all then: `cardKeyRows`' caller.)
  if (input.changesNotShown > 0) {
    warnings.push(
      `${glyph('warning')} ${input.changesNotShown} changed line${input.changesNotShown === 1 ? '' : 's'} not shown \u2014 press ${keyToken('v')} for the full diff.`,
    );
  }
  const linesNotShown = input.linesNotShown ?? 0;
  if (document !== undefined && document.preview.diff === undefined && linesNotShown > 0) {
    // The same slot, the same way out as the diff warning above: the full view lists the rest, and no Allow-all is offered.
    const plural = linesNotShown === 1 ? '' : 's';
    const verb = linesNotShown === 1 ? 'is' : 'are';
    warnings.push(
      input.commandFacts === undefined
        ? `${glyph('warning')} ${linesNotShown} line${plural} of this call ${verb} not shown \u2014 press ${keyToken('v')} for the full view.`
        : `${glyph('warning')} ${linesNotShown} row${plural} of this command ${verb} not shown \u2014 press ${keyToken('v')}${commandRowsOfferNote(input.commandFacts.offers)}`,
    );
  }
  const diff = document?.preview.diff;
  if (diff !== undefined) {
    const endings = endingsWarning(diff);
    if (endings !== undefined) warnings.push(`${glyph('warning')} Line endings: ${endings}.`);
  }
  // The generic lock sentence only when nothing above already explained the lock (a command's own fact rows never do).
  if (warnings.length === factRows && !input.inspected) {
    warnings.push(
      `${glyph('warning')} Allow is locked until the required content has been inspected (${keyToken('v')}).`,
    );
  }
  return warnings.flatMap((warning) => wrapWords(warning, input.columns));
}

/**
 * The one note a card shows (once per card) when an affirmative key was not counted because of what the keyboard was doing,
 * not because the card was not ready: it tells the person the press was not lost by accident and what to do. A refusal
 * because the card has only just appeared says nothing (the person sees the card; the dwell is short). The typing note does
 * not say WHEN the keys were typed: they may have been typed before the card existed.
 */
export const CARD_TYPEAHEAD_NOTE =
  'Keys were typed just before this answer — wait a moment, then press again.';
export const CARD_LOCKOUT_NOTE =
  'This card opened right after your last answer — wait, then press again.';
/** An Enter that came before the question could be read, or after it had lapsed: the question is gone and nothing was granted. */
export const CARD_ENTER_NOTE = `Too early or too late for ${keyToken('Enter')} — nothing was allowed. Press the key again.`;

/** How a tool's `[Ctrl+G]` scope reads: what "always" would cover, in the person's words. */
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
  /** The first `Ctrl+G` was pressed and the card is waiting for ENTER (PR #99 corrective sitting G1, security sitting H1). */
  readonly confirmAlways?: boolean;
  /** The card is a command's (ADR-0118 §1): the grants are worded for THIS exact command, not for a tool. */
  readonly command?: boolean;
  /** Whether `Ctrl+O` (remember this exact command for this project) is offered. */
  readonly remember?: boolean;
  /** The first `Ctrl+O` was pressed and the card is waiting for ENTER. */
  readonly confirmRemember?: boolean;
}

/** The sentence that ends a command card's "rows not shown" warning: what stays unavailable while a row is off screen. */
function commandRowsOfferNote(offers: CommandCardFacts['offers']): string {
  return offers.session || offers.remember
    ? '; This session and Remember are offered only while every row is on screen.'
    : '.';
}

/** What the key that stops a turn does, said the same on every card that has one. */
const STOPS_THE_TURN = 'stops the turn';

/** The question a command's wider grant asks, second row: what Enter does, what every other key does, and the stop key. */
const COMMAND_CONFIRM_ITEMS: readonly LegendItem[] = [
  { keys: 'Enter', verb: 'confirm' },
  { text: 'any other key cancels, allowing nothing' },
];

/** The grants the card offers once the call has been inspected: Allow, and the grants beside it, each as the answer it is. */
function allowItems(input: CardKeyInput): readonly LegendItem[] {
  const command = input.command === true;
  const items: LegendItem[] = [
    { keys: 'Ctrl+Y', verb: command ? 'Allow once' : 'Allow', role: 'ok' },
  ];
  if (input.cacheable)
    items.push({
      keys: 'Ctrl+G',
      verb: command ? 'Allow this session' : `Allow all ${input.scope} this session`,
      role: 'ok',
    });
  if (input.remember === true) items.push({ keys: 'Ctrl+O', verb: 'Allow + remember', role: 'ok' });
  return items;
}

/** The first key row while Allow is locked: what the person has to do first. */
function lockedAllowRow(command: boolean): LegendRow {
  return sentenceRow(
    command
      ? '(Allow is locked until you read the whole command)'
      : '(Allow is locked until you inspect the change)',
  );
}

/**
 * The two key rows, as rows a view can colour by role ({@link cardKeyRows} is their text): the grants, then the refusals and the key that
 * leaves. Every answer is a Ctrl chord (see `reviewAnswerKey`), and the legend spells them out; the rows are laid out so that, at 80
 * columns, the longest scope phrase still leaves both rows whole and Deny is never the part a narrow terminal cuts. Allow is not offered
 * while it is locked. While the session-wide grant waits for its confirmation both rows say what the next key does — one question, two
 * rows, so the card keeps its two key rows (and the layout its budget) and no scope phrase can push "any other key cancels" off the end of
 * a row. The confirmation is ENTER, never a second `Ctrl+G`: the same key twice is what a held key produces.
 */
export function cardKeyLegend(input: CardKeyInput): readonly [LegendRow, LegendRow] {
  const stop = exitKey.decide(STOPS_THE_TURN);
  const enter = keyToken('Enter');
  if (input.confirmRemember === true)
    return [
      sentenceRow(
        `Press ${enter} to allow this exact command now and remember it for this project`,
      ),
      exitRow(COMMAND_CONFIRM_ITEMS, stop),
    ];
  if (input.confirmAlways === true)
    return [
      sentenceRow(
        input.command === true
          ? `Press ${enter} to allow this exact command for this session`
          : `Press ${enter} to allow all ${input.scope} this session`,
      ),
      exitRow(
        input.command === true ? COMMAND_CONFIRM_ITEMS : [{ text: 'Any other key cancels' }],
        stop,
      ),
    ];
  const command = input.command === true;
  const grants = input.inspected ? itemsRow(allowItems(input)) : lockedAllowRow(command);
  return [
    grants,
    exitRow(
      [
        { keys: 'Ctrl+N', verb: 'Deny', role: 'danger' },
        { keys: 'Ctrl+R', verb: 'Deny + reason' },
        { keys: 'v', verb: command ? 'full view' : 'full diff' },
      ],
      stop,
    ),
  ];
}

/** The text of {@link cardKeyLegend}'s two rows. */
export function cardKeyRows(input: CardKeyInput): readonly [string, string] {
  const [grants, refusals] = cardKeyLegend(input);
  return [grants.text, refusals.text];
}

/** Rows a denial-reason capture takes beyond the key rows it replaces (the disclosure above the input). */
export function cardDenialExtraRows(disclosureRows: number): number {
  return disclosureRows + 1;
}
