import { sanitizeUntrustedInline } from '../sanitize.js';
import type { ToolDisplay } from './tool-display.js';
import type { CommandCardFacts } from '../../chat/command-facts.js';
import type { DisplayPathRoots } from '../notation.js';
import { glyph, plainFormInForce, statusCell, statusCellWidth } from './glyphs.js';
import {
  exitKey,
  keyToken,
  legend,
  legendItems,
  type LegendItem,
  type LegendRender,
} from './legend.js';
import { exitRow, sentenceRow } from './legend-row.js';
import {
  cardKeyLegend,
  commandFactRows,
  endingsWarning,
  wrapWords,
  type CardKeyInput,
} from './tool-review-card.js';
import {
  escapeReviewCharacter,
  ROW_TOKENS_PER_COLUMN,
  type ReviewDocument,
  type ReviewPage,
} from './tool-review-projection.js';
import { displayWidth } from './viewport.js';
import { popupGeometry } from '../../popups/geometry.js';

/**
 * The wording and arithmetic of the full view and the tool-call list ([ADR-0134](../../../../../docs/decisions/0134-the-full-view-and-the-tool-details-are-one-readable-inspection-screen.md)).
 *
 * Framework-free and pure, like the card's ({@link ./tool-review-card.ts}): the model, which budgets the page's rows, and
 * the view, which draws them, both take their chrome from here, so they cannot disagree about how many rows it is and the
 * words are testable without React. Nothing here touches the safety machinery: what must be inspected, what an answer needs
 * and what a frame must contain are still decided by the review state machine and the projection. This module only says it.
 */

/** Rows left empty under the screen: a frame as tall as the terminal makes Ink clear it on every repaint. */
export const FULL_SPARE_ROWS = 1;
/** The rows the body is given when a caller does not say how many the chrome takes (a test, a card-less probe). */
export const FULL_DEFAULT_CHROME_ROWS = 12;

const SEPARATOR = ' · ';

/** The columns a row may use: the card's rule, a margin on each side. */
function usableColumns(columns: number): number {
  return Math.max(1, columns - 2);
}

/** `left`, then spaces, then `right` flush to the edge — or `undefined` when the two do not fit one row. */
function flush(left: string, right: string, width: number): string | undefined {
  if (right.length === 0) return displayWidth(left) <= width ? left : undefined;
  const gap = width - displayWidth(left) - displayWidth(right);
  return gap >= 2 ? `${left}${' '.repeat(gap)}${right}` : undefined;
}

export type ScreenKind = 'approval' | 'details';

/** What of an affirmative answer's inspection is still owed, by cause: the lock sentence says which. */
export interface InspectionPending {
  /** The whole target has not been on screen yet. */
  readonly target: boolean;
  /** How many masked ranges are still to be revealed and drawn. */
  readonly masks: number;
}

/** The counts the full view always carries (ADR-0129 §3): the change, its bytes, and the masked values. */
export function fullCounts(document: ReviewDocument | undefined): string {
  if (document === undefined) return '';
  const count = document.masks.length;
  const masks = `${count} masked value${count === 1 ? '' : 's'}`;
  const diff = document.preview.diff;
  if (diff !== undefined)
    return `+${diff.stats.addedLines} -${diff.stats.removedLines}${SEPARATOR}${document.changedBytes} bytes${SEPARATOR}${masks}`;
  return count > 0 ? masks : '';
}

/**
 * The header: the screen's name, the tool's identity and the counts, on one row when they fit and on as many as they need
 * when they do not. The identity rows arrive already escaped and fitted (`toolReviewIdentity`): they are the mandatory
 * part and are never shortened here, only moved to a row of their own.
 */
export function fullHeaderRows(input: {
  readonly title: string;
  readonly counts: string;
  readonly identity: readonly string[];
  readonly columns: number;
}): readonly string[] {
  const width = usableColumns(input.columns);
  const title = input.title;
  const identity = input.identity.join(SEPARATOR);
  const left = identity.length === 0 ? title : `${title}${SEPARATOR}${identity}`;
  const one = flush(left, input.counts, width);
  if (one !== undefined) return [one];
  const head = flush(title, input.counts, width) ?? title;
  // The identity moves under the title as ONE row when its parts fit side by side, and as a row each only when they do not.
  return identity.length > 0 && displayWidth(identity) <= width
    ? [head, identity]
    : [head, ...input.identity];
}

export interface FullWarningInput {
  readonly kind: ScreenKind;
  readonly document: ReviewDocument | undefined;
  readonly pending: InspectionPending;
  readonly columns: number;
  /** A command's standing, directory and warnings (ADR-0118 §1), shown above the locks on its full view too. */
  readonly commandFacts?: CommandCardFacts | undefined;
  /** What the command's directory is shortened against (see {@link commandFactRows}); absent ⇒ the roots the facts carry, and with none, as the host gave it. */
  readonly paths?: DisplayPathRoots | undefined;
}

/**
 * Only the warnings that apply, already wrapped. A lock names its cause and the way out; once the requirement is met the
 * sentence is gone (a zero is not displayed as a fact), and the line-endings sentence appears only for a change of
 * convention — the card's rule, from the card's function.
 */
export function fullWarnings(input: FullWarningInput): readonly string[] {
  const warnings: string[] =
    input.kind === 'approval' && input.commandFacts !== undefined
      ? [...commandFactRows(input.commandFacts, usableColumns(input.columns), false, input.paths)]
      : [];
  if (input.kind === 'approval') {
    if (input.pending.target) {
      // A target that hides a masked value is only "on screen" once that value is revealed too: say both keys.
      const targetField =
        input.document?.preview.target === undefined ? undefined : input.document.lines[0]?.field;
      const masked =
        targetField !== undefined &&
        (input.document?.masks.some((mask) => mask.field === targetField) ?? false);
      warnings.push(
        masked
          ? `${glyph('warning')} Allow is locked until the whole target has been on screen — press ${keyToken('Home')}, reveal its masked value with ${keyToken('r')}, and page through it (${keyToken('PgDn')}).`
          : `${glyph('warning')} Allow is locked until the whole target has been on screen — press ${keyToken('Home')} and page through it (${keyToken('PgDn')}).`,
      );
    }
    if (input.pending.masks > 0) {
      const one = input.pending.masks === 1;
      warnings.push(
        `${glyph('warning')} Allow is locked until ${one ? 'the masked value has' : 'every masked value has'} been revealed — press ${keyToken('r')}, then scroll over ${one ? 'it' : 'each'}.`,
      );
    }
  }
  const diff = input.document?.preview.diff;
  if (diff !== undefined) {
    const endings = endingsWarning(diff);
    if (endings !== undefined) warnings.push(`${glyph('warning')} Line endings: ${endings}.`);
  }
  return warnings.flatMap((warning) => wrapWords(warning, usableColumns(input.columns)));
}

export interface FullStatusInput {
  readonly page: ReviewPage | undefined;
  readonly document: ReviewDocument | undefined;
  readonly revealed: boolean;
  readonly numeric: boolean;
  readonly columns: number;
}

/** How far down the listing the page reaches, as a whole percent (100 at the end and for an empty listing). */
function positionPercent(position: { readonly total: number; readonly below: number }): number {
  if (position.total === 0 || position.below === 0) return 100;
  return Math.max(1, Math.floor((100 * (position.total - position.below)) / position.total));
}
/** The sentence about the changed lines off the page: none known (undefined), none off the page, or the sides that have some. */
function changesPhrase(
  off: readonly string[] | undefined,
  none: string,
  some: (list: string) => string,
): string | undefined {
  if (off === undefined) return undefined;
  return off.length === 0 ? none : some(off.join(', '));
}
/**
 * The status rule under the body: how far down the listing the page reaches, which changed lines are NOT on it (the
 * card's "not shown" count, by side), and the two view modes a person must not forget they are in. One row, whatever it says.
 */
export function fullStatusRow(input: FullStatusInput): string {
  const width = usableColumns(input.columns);
  const page = input.page;
  const percent = page === undefined ? undefined : `${positionPercent(page.position)}%`;
  const off =
    page === undefined || (input.document?.changedLines ?? 0) === 0
      ? undefined
      : [
          page.changesAbove > 0 ? `${page.changesAbove} above` : '',
          page.changesBelow > 0 ? `${page.changesBelow} below` : '',
        ].filter((part) => part.length > 0);
  const compose = (modes: readonly string[], changes: string | undefined): string => {
    const parts = [
      ...(percent === undefined ? [] : [percent]),
      ...modes,
      ...(changes === undefined ? [] : [changes]),
    ];
    const text = parts.length === 0 ? '' : ` ${parts.join(SEPARATOR)} `;
    const rule = glyph('thinRule');
    return `${rule}${text}${rule.repeat(Math.max(1, width - rule.length - displayWidth(text)))}`;
  };
  const longModes = [
    ...(input.revealed ? ['masked values revealed (view only)'] : []),
    ...(input.numeric ? ['Unicode code points'] : []),
  ];
  const shortModes = [
    ...(input.revealed ? ['revealed (view only)'] : []),
    ...(input.numeric ? ['code points'] : []),
  ];
  const longChanges = changesPhrase(
    off,
    'every changed line is on this page',
    (list) => `changed lines off this page: ${list}`,
  );
  const shortChanges = changesPhrase(off, 'all changes shown', (list) => `changed: ${list}`);
  // The row is built to fit, never cut by the renderer: the modes a person must not forget outrank the change counts, which
  // shorten and then give way, and the modes shorten last. (Ink would cut the END of a row that is too wide.)
  const tiers: readonly (readonly [readonly string[], string | undefined])[] = [
    [longModes, longChanges],
    [longModes, shortChanges],
    [shortModes, shortChanges],
    [shortModes, undefined],
  ];
  for (const [modes, changes] of tiers) {
    const row = compose(modes, changes);
    if (displayWidth(row) <= width) return row;
  }
  return compose([], undefined);
}

export interface NavLegendInput {
  readonly hasChanges: boolean;
  readonly hasMasks: boolean;
  readonly canCopy: boolean;
  readonly revealed: boolean;
  readonly numeric: boolean;
  readonly columns: number;
}

/** Greedily pack `items` into rows no wider than `width`, each row drawn as a legend row (the items between ` · `). */
function packRows(items: readonly LegendItem[], width: number): readonly LegendRender[] {
  const rows: LegendRender[] = [];
  let row: LegendItem[] = [];
  for (const item of items) {
    if (row.length === 0 || displayWidth(legendItems([...row, item]).text) <= width) row.push(item);
    else {
      rows.push(legendItems(row));
      row = [item];
    }
  }
  if (row.length > 0) rows.push(legendItems(row));
  return rows;
}

/**
 * The movement and inspection keys, only the ones that do something here: `Tab` appears when there is a change to go to, `r` when there is
 * a mask to reveal, `c` when a clipboard is bound. Movement is one group and inspection another, each packed into as few rows as the width
 * allows (one each at 80 columns). `[b]` is not here: it sits with the answers on an approval and with the close note on details.
 */
export function fullNavRows(input: NavLegendInput): readonly LegendRender[] {
  const move: LegendItem[] = [
    { keys: '↑/↓', verb: 'scroll' },
    { keys: 'PgUp/PgDn', verb: 'page' },
    { keys: 'Home/End', verb: 'top/end' },
  ];
  if (input.hasChanges) move.push({ keys: 'Tab/Shift+Tab', verb: 'changes' });
  const tools: LegendItem[] = [{ keys: '/', verb: 'search' }];
  if (input.hasMasks)
    tools.push({ keys: 'r', verb: input.revealed ? 'hide masked' : 'reveal masked' });
  tools.push({ keys: 'p', verb: input.numeric ? 'back to text' : 'Unicode codes' });
  if (input.canCopy) tools.push({ keys: 'c', verb: 'copy page' });
  const width = usableColumns(input.columns);
  return [...packRows(move, width), ...packRows(tools, width)];
}

/** The text of {@link fullNavRows}. */
export function fullNavLegend(input: NavLegendInput): readonly string[] {
  return fullNavRows(input).map((row) => row.text);
}

/** The stop key as an item, where `Esc` is the exit and so the stop key is named beside it (it stops the turn from anywhere). */
const STOP_KEY: LegendItem = { keys: 'Ctrl+C', verb: 'stops the turn', role: 'warn' };

/**
 * The second row while a session-wide or remember question waits in the FULL view (ADR-0137 §4). Any other key cancels the question
 * and grants nothing; `Esc` is one of them and, here, also steps back to the card, so the card's `Esc stops the turn` would be false;
 * `Ctrl+C` stops the turn from anywhere and is named, because the stop key stays named wherever it works. The command variants
 * (an Enter confirms) and the tool variant (any key) differ only in their first words.
 */
export const FULL_CONFIRM_ENTER_LEGEND: LegendRender = exitRow(
  [{ keys: 'Enter', verb: 'confirm' }, { text: 'any other key cancels' }, STOP_KEY],
  exitKey.step(),
);
export const FULL_CONFIRM_ANY_LEGEND: LegendRender = exitRow(
  [{ text: 'any other key cancels' }, STOP_KEY],
  exitKey.step(),
);
export const FULL_CONFIRM_ENTER_ROW = FULL_CONFIRM_ENTER_LEGEND.text;
export const FULL_CONFIRM_ANY_ROW = FULL_CONFIRM_ANY_LEGEND.text;
/**
 * The full view's second answer row: the refusals that exist here, the way back, and the stop key. `Esc` steps back to the card
 * (ADR-0137 §4) and `Ctrl+C` stops the turn; the row names both, so neither is learned by pressing it.
 */
export const FULL_DENY_LEGEND: LegendRender = exitRow(
  [
    { keys: 'Ctrl+N', verb: 'Deny', role: 'danger' },
    { keys: 'b', verb: 'back to the card' },
    STOP_KEY,
  ],
  exitKey.step(),
);
export const FULL_DENY_ROW = FULL_DENY_LEGEND.text;

/** The grants row the card shows, then the refusals: the same words, minus the keys that only exist on the card, plus the way back. */
export function fullAnswerLegend(input: CardKeyInput): readonly [LegendRender, LegendRender] {
  const rows = cardKeyLegend(input);
  if (input.confirmAlways === true || input.confirmRemember === true)
    return [
      rows[0],
      input.confirmRemember === true || input.command === true
        ? FULL_CONFIRM_ENTER_LEGEND
        : FULL_CONFIRM_ANY_LEGEND,
    ];
  // The full view names what is owed in its warning row; the row here only says that Allow is off, not the card's generic cause.
  return [
    input.inspected ? rows[0] : sentenceRow('(Allow is locked — see the warning above)'),
    FULL_DENY_LEGEND,
  ];
}

/** The text of {@link fullAnswerLegend}'s two rows. */
export function fullAnswerRows(input: CardKeyInput): readonly [string, string] {
  const [grants, refusals] = fullAnswerLegend(input);
  return [grants.text, refusals.text];
}

/**
 * The two answer rows while the full view's search box is open (ADR-0115 §3). The box owns the keyboard: a chord is not an answer in
 * it and `b` is typing, so the card's rows would name keys that do nothing. `Esc` closes the box and `Ctrl+C` is what stops the turn.
 */
export function fullSearchLegend(): readonly [LegendRender, LegendRender] {
  return [
    exitRow([{ keys: 'Enter', verb: 'find' }], exitKey.close('Esc', 'close the search box')),
    legendItems([STOP_KEY]),
  ];
}

/** The text of {@link fullSearchLegend}'s two rows. */
export function fullSearchRows(): readonly [string, string] {
  const [find, stop] = fullSearchLegend();
  return [find.text, stop.text];
}

/** The sentence ADR-0129 §5 moved from the card to the full view. */
export const FULL_PROTECTED_NOTE = 'Approval cannot override protected-path or permission denials.';
/** A command card's full view says the opposite of that sentence: a command is not held to the file tools' path rules. */
export const FULL_COMMAND_NOTE =
  'Approving runs exactly this command; file-tool path rules do not limit it.';
/** The one line a details screen ends on: the way back to the list, what viewing does, and the key that closes. */
export const DETAILS_CLOSE_LEGEND: LegendRender = exitRow(
  [{ keys: 'b', verb: 'back to the list' }, { text: 'viewing never executes a tool' }],
  exitKey.close(),
);
export const DETAILS_CLOSE_NOTE = DETAILS_CLOSE_LEGEND.text;

export interface FullChromeInput {
  readonly kind: ScreenKind;
  /** The screen's name: `Review`, `Details`, or the saved-result sentence. */
  readonly title: string;
  readonly columns: number;
  readonly document: ReviewDocument | undefined;
  /** The escaped identity rows (`tool …`, `action …` / `outcome …`). */
  readonly identity: readonly string[];
  /** The document has a target (a row is kept for it: the target when scrolled away from it, blank at the top). */
  readonly hasTarget: boolean;
  readonly pending: InspectionPending;
  readonly nav: Omit<NavLegendInput, 'columns'>;
  /** The card's key input, for an approval; absent for a details screen. */
  readonly keys: CardKeyInput | undefined;
  readonly searching: boolean;
  /** A command's facts (ADR-0118 §1); absent for any other call. */
  readonly commandFacts?: CommandCardFacts | undefined;
  /** What a command's directory is shortened against; absent ⇒ the roots the facts carry, and with none, as the host gave it. */
  readonly paths?: DisplayPathRoots | undefined;
}

export interface FullChrome {
  readonly header: readonly string[];
  readonly warnings: readonly string[];
  readonly nav: readonly string[];
  readonly answers: readonly string[];
  readonly note: string;
  /** The same rows as {@link FullChrome.nav}, {@link FullChrome.answers} and {@link FullChrome.note}, with where their keys are, for a view to colour. */
  readonly legends: {
    readonly nav: readonly LegendRender[];
    readonly answers: readonly LegendRender[];
    readonly note: LegendRender;
  };
  readonly hasTarget: boolean;
  readonly searching: boolean;
  /** Every row the screen spends outside the body, status rule included. */
  readonly rows: number;
}

/** The answer rows of the full view: none for a details screen, the search rows while a search is typed, else the approval's. */
function fullAnswers(keys: CardKeyInput | undefined, searching: boolean): readonly LegendRender[] {
  if (keys === undefined) return [];
  return searching ? fullSearchLegend() : fullAnswerLegend(keys);
}

/** The closing note of the full view: a details screen's, a command's, or the protected-path sentence of any other approval. */
function fullNote(kind: ScreenKind, commandFacts: CommandCardFacts | undefined): LegendRender {
  if (kind !== 'approval') return DETAILS_CLOSE_LEGEND;
  return sentenceRow(commandFacts === undefined ? FULL_PROTECTED_NOTE : FULL_COMMAND_NOTE);
}

/** Everything the full view draws around its body, and how many rows that is. The one source the model and the view share. */
export function fullChrome(input: FullChromeInput): FullChrome {
  const header = fullHeaderRows({
    title: input.title,
    counts: fullCounts(input.document),
    identity: input.identity,
    columns: input.columns,
  });
  const warnings = fullWarnings({
    kind: input.kind,
    document: input.document,
    pending: input.pending,
    columns: input.columns,
    commandFacts: input.commandFacts,
    paths: input.paths,
  });
  const nav = fullNavRows({ ...input.nav, columns: input.columns });
  const answers = fullAnswers(input.keys, input.searching);
  const note = fullNote(input.kind, input.commandFacts);
  const rows =
    header.length +
    (input.hasTarget ? 1 : 0) +
    warnings.length +
    1 +
    nav.length +
    answers.length +
    1 +
    // The message row is always there, empty or not: a row that came and went would move the body by one on every note, and
    // the limits of a motion are taken from the page drawn BEFORE it.
    1 +
    (input.searching ? 1 : 0);
  return {
    header,
    warnings,
    nav: nav.map((row) => row.text),
    answers: answers.map((row) => row.text),
    note: note.text,
    legends: { nav, answers, note },
    hasTarget: input.hasTarget,
    searching: input.searching,
    rows,
  };
}

/**
 * The rows the inspection popup spends on its frame around the screen ([ADR-0148](../../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
 * §7): its top edge (the popup's name and where it came from) and its bottom edge. Everything between them is the full view's own screen, its
 * legends last.
 */
export const INSPECTION_EDGE_ROWS = 2;

/** The sizes the inspection popup is drawn at and its page is projected for: one source for the frame, the page, the target and the copy. */
export interface InspectionGeometry {
  /** The popup's box (`popupGeometry`, kind `inspection`): `columns − 2` by `rows − 1`, 78 × 23 at 80×24. */
  readonly box: { readonly width: number; readonly height: number; readonly left: number };
  /**
   * The size every page computation is given in place of the terminal's: the terminal's columns, so a row of the screen is the box's width
   * (`usableColumns` of it: the page is drawn across the whole box, which stands in the body's place with nothing behind it to keep a margin
   * from), and as tall as the rows the box leaves its screen once its two edges are drawn (with the spare row the page model keeps).
   */
  readonly page: { readonly cols: number; readonly rows: number };
}

/**
 * The ONE geometry of the inspection popup for a terminal of `size` (ADR-0148 §7: "one function feeds the popup frame, the page model, the
 * required-target and identity computations and the copy"), or `undefined` below the popup's floor. The page is projected from `page`, so a page
 * fitted to one geometry is never drawn in another.
 */
export function inspectionGeometry(size: {
  readonly cols: number;
  readonly rows: number;
}): InspectionGeometry | undefined {
  const box = popupGeometry({
    columns: size.cols,
    rows: size.rows,
    kind: 'inspection',
    placement: 'overlay',
    rail: false,
  });
  if (!box.fits) return undefined;
  return {
    box: { width: box.width, height: box.height, left: box.left },
    page: { cols: box.width + 2, rows: box.height - INSPECTION_EDGE_ROWS + FULL_SPARE_ROWS },
  };
}

/** The inspection popup's name on its top edge: what the card's `[v]` called it, or the command that opened the call list. */
export function inspectionTitle(kind: ScreenKind, command: boolean): string {
  if (kind !== 'approval') return '/details';
  return command ? 'Full view' : 'Full diff';
}

/** Where the inspection popup came from, on its top edge's right. */
export function inspectionOrigin(kind: ScreenKind): string {
  return kind === 'approval' ? 'from the approval' : 'from chat';
}

/**
 * The inspection popup's top edge, `width` columns: ` ─ <title> ───── <origin> ─ `, a blank cell at each end (the frame's side margin), the
 * title clipped first. Host text only: the title and the origin are product constants.
 */
export function inspectionTopEdge(
  title: string,
  origin: string,
  width: number,
): { readonly lead: string; readonly title: string; readonly rest: string } {
  const rule = glyph('thinRule');
  const inner = Math.max(1, width - 2);
  const room = Math.max(1, inner - displayWidth(origin) - 7);
  const shown = displayWidth(title) <= room ? title : `${[...title].slice(0, room - 1).join('')}…`;
  const lead = ` ${rule} `;
  const tail = ` ${origin} ${rule} `;
  const between = Math.max(
    1,
    width - displayWidth(lead) - displayWidth(shown) - 1 - displayWidth(tail),
  );
  return { lead, title: shown, rest: ` ${rule.repeat(between)}${tail}` };
}

/** The inspection popup's bottom edge, `width` columns: the rule over the inner width, a blank cell at each end. */
export function inspectionBottomEdge(width: number): string {
  return ` ${glyph('thinRule').repeat(Math.max(1, width - 2))} `;
}

/** The most rows a page of the full view ever holds, however tall the terminal (a page consumes at most 200 display rows). */
export const FULL_BODY_ROWS_CAP = 200;
/** The body rows a terminal of `terminalRows` leaves once the chrome and the spare row are taken. */
export function fullBodyRows(terminalRows: number, chromeRows: number): number {
  return Math.min(FULL_BODY_ROWS_CAP, Math.max(1, terminalRows - FULL_SPARE_ROWS - chromeRows));
}

/**
 * `text` made safe for a terminal row and cut to `width` columns with an ellipsis; an escape token is never cut. The cut string
 * is measured as the whole string it is — tokens can join into wider clusters, so summing their widths could draw a row wider
 * than the room it was fitted to. The pieces are grown by their own widths (a close estimate, not a bound), and when the whole
 * is too wide the largest fitting count is found by halving, each probe a whole-string measure, so the cost is the text times
 * its logarithm; at most three pieces per column are considered at either end. A cut never separates a base from the mark after
 * it. `keep: 'middle'` keeps the start and the end (a path keeps its name), `'start'` the start.
 */
export function escapedFit(
  text: string,
  width: number,
  keep: 'start' | 'middle' = 'start',
): string {
  if (width <= 0) return '';
  const tokens = [...text].map((char) => escapeReviewCharacter(char, false));
  const whole = tokens.join('');
  if (displayWidth(whole) <= width) return whole;
  const cap = Math.max(16, ROW_TOKENS_PER_COLUMN * width);
  /**
   * The longest run of `pieces`, from the start, that fits with `rest` added: grown by the pieces' own widths (an estimate:
   * short for a keycap, long for some emoji), then the largest fitting count is found by halving — each probe a whole-string
   * measure, verified because width is not monotone in the prefix — so the cost is the text times its logarithm.
   */
  const fit = (
    pieces: readonly string[],
    budget: number,
    rest: (joined: string) => string,
  ): string[] => {
    let count = 0;
    let sum = 0;
    for (const piece of pieces) {
      if (count >= cap) break;
      const pieceWidth = displayWidth(piece);
      if (sum + pieceWidth > budget) break;
      sum += pieceWidth;
      count++;
    }
    const fits = (n: number): boolean => displayWidth(rest(pieces.slice(0, n).join(''))) <= width;
    if (!fits(count)) {
      let low = 0;
      let high = count - 1;
      while (low < high) {
        const probe = (low + high + 1) >> 1;
        if (fits(probe)) low = probe;
        else high = probe - 1;
      }
      count = low;
    }
    return pieces.slice(0, count);
  };
  /** A cut never separates a base from the zero-width mark after it (the piece just left out). */
  const keepsCluster = (kept: string[], next: string | undefined): string[] =>
    kept.length > 1 &&
    next !== undefined &&
    displayWidth(next) === 0 &&
    displayWidth(kept.at(-1) ?? '') > 0
      ? kept.slice(0, -1)
      : kept;
  const startFit = (budget: number): string => {
    const kept = fit(tokens, budget, (joined) => `${joined}…`);
    // Giving the base back only when the shorter cut still fits (width is not monotone: a modifier can narrow a cluster).
    const shorter = keepsCluster(kept, tokens[kept.length]);
    return displayWidth(`${shorter.join('')}…`) <= width ? shorter.join('') : kept.join('');
  };
  if (keep === 'middle' && width >= 5) {
    const budget = width - 1;
    const first = startFit(Math.floor(budget / 3));
    // The tail is grown from the END, so it is fitted over the reversed tokens and put back in order; a mark whose base was
    // left out would open the tail, so it is dropped.
    const reversed = fit(
      [...tokens].reverse(),
      budget - displayWidth(first),
      (joined) => `${first}…${[...joined].reverse().join('')}`,
    );
    while (reversed.length > 0 && displayWidth(reversed.at(-1) ?? '') === 0) reversed.pop();
    const joined = `${first}…${reversed.toReversed().join('')}`;
    if (displayWidth(joined) <= width) return joined;
  }
  return `${startFit(width - 1)}…`;
}

export type CallTone = 'ok' | 'bad' | 'warn' | 'dim';
export interface CallListRow {
  readonly text: string;
  readonly selected: boolean;
  readonly tone: CallTone;
}
export interface CallListView {
  readonly title: string;
  readonly rows: readonly CallListRow[];
  /** What the list says instead of rows when there are no calls. */
  readonly empty: string | undefined;
  readonly status: string;
  readonly hint: string;
  /** Rows the whole list takes. */
  readonly height: number;
}

/** What a call list entry needs from a {@link ToolDisplay}. */
export type CallListEntry = Pick<ToolDisplay, 'callId' | 'toolId' | 'outcome' | 'target' | 'stats'>;

/** A mark that is not a table glyph (`?`, `…`), padded to the list's status column in the form in force. */
const statusColumn = (mark: string): string => mark.padEnd(statusCellWidth(plainFormInForce()));

/**
 * A call's mark, its word (the glyph is never alone) and its tone; the marks are the glyph table's, in the form in force, each padded to the
 * list's status column (`ok` is two columns without colour, `/` and `x` one), so the tool names start in one column in both forms.
 */
function outcomeMark(outcome: ToolDisplay['outcome']): {
  mark: string;
  word: string;
  tone: CallTone;
} {
  switch (outcome) {
    case 'success':
      // A success carries no word of its own here: the row already says what the call was (its tool, its target and its change), and a word
      // on every success row would take the target's columns on each of them (the call list's one status glyph without a word, ADR-0145 §5).
      return { mark: statusCell('completed'), word: '', tone: 'ok' };
    case 'failure':
      return { mark: statusCell('failed'), word: 'failed', tone: 'bad' };
    case 'denied':
      return { mark: statusCell('cancelled'), word: 'denied', tone: 'warn' };
    case 'unknown':
      return { mark: statusColumn('?'), word: 'outcome unknown', tone: 'warn' };
    case 'running':
      return { mark: statusColumn('…'), word: 'running', tone: 'dim' };
  }
}

/** The widest the tool-name column grows, so one long name cannot take the targets' room. */
const TOOL_COLUMN_MAX = 22;
/** The least a target may be given before it is left out of the row. */
const TARGET_MIN = 8;
/** Rows around the list: the title, the status row and the key hint. */
const LIST_CHROME_ROWS = 3;

/** How many calls the list can show at once on a terminal of this height. */
export function callListCapacity(terminalRows: number): number {
  return Math.max(1, terminalRows - FULL_SPARE_ROWS - LIST_CHROME_ROWS);
}

/**
 * The tool-call list: oldest first, the newest at the bottom, a window that keeps the selection in view. A row says what
 * the call did — its mark, its tool, what it touched, what it changed — never what it returned: a result can carry secrets,
 * and it is read in the details view, through the masks. Every model-named string is escaped before it is drawn.
 */
export function callListView(input: {
  readonly calls: readonly CallListEntry[];
  readonly selected: number;
  readonly columns: number;
  readonly terminalRows: number;
}): CallListView {
  const width = usableColumns(input.columns);
  const hint = legend(
    [
      { keys: ['↑/↓', 'PgUp/PgDn'], verb: 'select' },
      { keys: 'Enter', verb: 'open' },
      { keys: 'Home/End', verb: 'oldest/newest' },
    ],
    exitKey.close(),
  );
  const count = input.calls.length;
  if (count === 0)
    return {
      title: 'Tool calls',
      rows: [],
      empty: 'No tool calls yet. Earlier sessions keep no previews.',
      status: '',
      hint: legend([], exitKey.close()),
      height: 3,
    };
  const capacity = callListCapacity(input.terminalRows);
  const selected = Math.min(Math.max(0, input.selected), count - 1);
  const start = Math.max(0, Math.min(selected - Math.floor(capacity / 2), count - capacity));
  const visible = input.calls.slice(start, start + capacity);
  const toolWidth = Math.min(
    TOOL_COLUMN_MAX,
    Math.max(
      ...visible.map((call) =>
        displayWidth(escapedFit(sanitizeUntrustedInline(call.toolId), TOOL_COLUMN_MAX)),
      ),
    ),
  );
  const rows = visible.map((call, index): CallListRow => {
    const outcome = outcomeMark(call.outcome);
    const tool = escapedFit(sanitizeUntrustedInline(call.toolId), toolWidth);
    const right = [
      call.stats === undefined ? '' : `+${call.stats.addedLines} -${call.stats.removedLines}`,
      outcome.word,
    ]
      .filter((part) => part.length > 0)
      .join(SEPARATOR);
    const head = `${start + index === selected ? glyph('selection') : ' '} ${outcome.mark} ${tool}${' '.repeat(Math.max(0, toolWidth - displayWidth(tool)))}`;
    const room = width - displayWidth(head) - (right.length > 0 ? displayWidth(right) + 2 : 0) - 2;
    const target =
      call.target !== undefined && room >= TARGET_MIN
        ? `  ${escapedFit(call.target, room, 'middle')}`
        : '';
    const left = `${head}${target}`;
    return {
      text: right.length === 0 ? left : (flush(left, right, width) ?? left),
      selected: start + index === selected,
      tone: outcome.tone,
    };
  });
  const older = start;
  const newer = count - start - visible.length;
  const status = [
    `call ${selected + 1} of ${count}`,
    older > 0 ? `${older} older above` : '',
    newer > 0 ? `${newer} newer below` : '',
  ]
    .filter((part) => part.length > 0)
    .join(SEPARATOR);
  return {
    title: 'Tool calls',
    rows,
    empty: undefined,
    status,
    hint,
    height: rows.length + LIST_CHROME_ROWS,
  };
}
