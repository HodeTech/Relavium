import { sanitizeUntrustedInline } from '../sanitize.js';
import type { ToolDisplay } from './tool-display.js';
import type { CommandCardFacts } from '../../chat/command-facts.js';
import {
  cardKeyRows,
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
const RULE = '─';

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
    return `+${diff.stats.addedLines} −${diff.stats.removedLines}${SEPARATOR}${document.changedBytes} bytes${SEPARATOR}${masks}`;
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
}

/**
 * Only the warnings that apply, already wrapped. A lock names its cause and the way out; once the requirement is met the
 * sentence is gone (a zero is not displayed as a fact), and the line-endings sentence appears only for a change of
 * convention — the card's rule, from the card's function.
 */
export function fullWarnings(input: FullWarningInput): readonly string[] {
  const warnings: string[] =
    input.kind === 'approval' && input.commandFacts !== undefined
      ? [...commandFactRows(input.commandFacts, usableColumns(input.columns))]
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
          ? '⚠ Allow is locked until the whole target has been on screen — press Home, reveal its masked value with [r], and page through it (PgDn).'
          : '⚠ Allow is locked until the whole target has been on screen — press Home and page through it (PgDn).',
      );
    }
    if (input.pending.masks > 0) {
      const one = input.pending.masks === 1;
      warnings.push(
        `⚠ Allow is locked until ${one ? 'the masked value has' : 'every masked value has'} been revealed — press [r], then scroll over ${one ? 'it' : 'each'}.`,
      );
    }
  }
  const diff = input.document?.preview.diff;
  if (diff !== undefined) {
    const endings = endingsWarning(diff);
    if (endings !== undefined) warnings.push(`⚠ Line endings: ${endings}.`);
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
    return `${RULE}${text}${RULE.repeat(Math.max(1, width - RULE.length - displayWidth(text)))}`;
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

/** The gap between two keys of a legend row: the card's. */
const KEY_GAP = '   ';

/** Greedily pack `items` into rows no wider than `width`. */
function packRows(items: readonly string[], width: number): readonly string[] {
  const rows: string[] = [];
  let row = '';
  for (const item of items) {
    const candidate = row.length === 0 ? item : `${row}${KEY_GAP}${item}`;
    if (row.length === 0 || displayWidth(candidate) <= width) row = candidate;
    else {
      rows.push(row);
      row = item;
    }
  }
  if (row.length > 0) rows.push(row);
  return rows;
}

/**
 * The movement and inspection keys, in the card's `[key] words` style, only the ones that do something here: `Tab` appears
 * when there is a change to go to, `r` when there is a mask to reveal, `c` when a clipboard is bound. Movement is one group
 * and inspection another, each packed into as few rows as the width allows (one each at 80 columns). `[b]` is not here: it
 * sits with the answers on an approval and with the close note on details.
 */
export function fullNavLegend(input: NavLegendInput): readonly string[] {
  const move = ['[\u2191\u2193] scroll', '[PgUp/PgDn] page', '[Home/End] top/end'];
  if (input.hasChanges) move.push('[Tab/Shift+Tab] changes');
  const tools = ['[/] search'];
  if (input.hasMasks) tools.push(input.revealed ? '[r] hide masked' : '[r] reveal masked');
  tools.push(input.numeric ? '[p] back to text' : '[p] Unicode codes');
  if (input.canCopy) tools.push('[c] copy page');
  const width = usableColumns(input.columns);
  return [...packRows(move, width), ...packRows(tools, width)];
}

/**
 * The second row while a session-wide or remember question waits in the FULL view (ADR-0137 §4). Any other key cancels the question
 * and grants nothing; `Esc` is one of them and, here, also steps back to the card, so the card's `Esc stops the turn` would be false;
 * `Ctrl+C` stops the turn from anywhere and is named, because the stop key stays named wherever it works. The command variants
 * (an Enter confirms) and the tool variant (any key) differ only in their first words.
 */
export const FULL_CONFIRM_ENTER_ROW =
  'Enter confirms · any other key cancels · Esc back · Ctrl+C stops the turn';
export const FULL_CONFIRM_ANY_ROW = 'Any other key cancels · Esc back · Ctrl+C stops the turn';
/**
 * The full view's second answer row: the refusals that exist here, the way back, and the stop key. `Esc` steps back to the card
 * (ADR-0137 §4) and `Ctrl+C` stops the turn; the row names both, so neither is learned by pressing it.
 */
export const FULL_DENY_ROW =
  '[Ctrl+N] Deny   [b] Back to the card   Esc back   Ctrl+C stops the turn';

/** The grants row the card shows, then the refusals: the same words, minus the keys that only exist on the card, plus the way back. */
export function fullAnswerRows(input: CardKeyInput): readonly [string, string] {
  const rows = cardKeyRows(input);
  if (input.confirmAlways === true || input.confirmRemember === true)
    return [
      rows[0],
      input.confirmRemember === true || input.command === true
        ? FULL_CONFIRM_ENTER_ROW
        : FULL_CONFIRM_ANY_ROW,
    ];
  // The full view names what is owed in its warning row; the row here only says that Allow is off, not the card's generic cause.
  return [input.inspected ? rows[0] : '(Allow is locked — see the warning above)', FULL_DENY_ROW];
}

/**
 * The two answer rows while the full view's search box is open (ADR-0115 §3). The box owns the keyboard: a chord is not an answer in
 * it and `b` is typing, so the card's rows would name keys that do nothing. `Esc` closes the box and `Ctrl+C` is what stops the turn.
 */
export function fullSearchRows(): readonly [string, string] {
  return ['Enter finds · Esc closes the search box', 'Ctrl+C stops the turn'];
}

/** The sentence ADR-0129 §5 moved from the card to the full view. */
export const FULL_PROTECTED_NOTE = 'Approval cannot override protected-path or permission denials.';
/** A command card's full view says the opposite of that sentence: a command is not held to the file tools' path rules. */
export const FULL_COMMAND_NOTE =
  'Approving runs exactly this command; file-tool path rules do not limit it.';
/** The one line a details screen ends on. */
export const DETAILS_CLOSE_NOTE =
  '[b] Back to the list   Esc closes · viewing never executes a tool';

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
}

export interface FullChrome {
  readonly header: readonly string[];
  readonly warnings: readonly string[];
  readonly nav: readonly string[];
  readonly answers: readonly string[];
  readonly note: string;
  readonly hasTarget: boolean;
  readonly searching: boolean;
  /** Every row the screen spends outside the body, status rule included. */
  readonly rows: number;
}

/** The answer rows of the full view: none for a details screen, the search rows while a search is typed, else the approval's. */
function fullAnswers(keys: CardKeyInput | undefined, searching: boolean): readonly string[] {
  if (keys === undefined) return [];
  return searching ? fullSearchRows() : fullAnswerRows(keys);
}

/** The closing note of the full view: a details screen's, a command's, or the protected-path sentence of any other approval. */
function fullNote(kind: ScreenKind, commandFacts: CommandCardFacts | undefined): string {
  if (kind !== 'approval') return DETAILS_CLOSE_NOTE;
  return commandFacts === undefined ? FULL_PROTECTED_NOTE : FULL_COMMAND_NOTE;
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
  });
  const nav = fullNavLegend({ ...input.nav, columns: input.columns });
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
    nav,
    answers,
    note,
    hasTarget: input.hasTarget,
    searching: input.searching,
    rows,
  };
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

/**
 * Split a key legend into its `[key]` labels, `Esc`, `Ctrl+C` (the stop key every legend names) and the words between, in one pass over the row. A label is a `[`, at least one
 * character and the next `]`; a `[` with no `]` after it is plain text. (The same split a regular expression gave, which backtracked
 * quadratically on a long run of `[`.)
 */
export function keyLabelParts(row: string): readonly string[] {
  const parts: string[] = [];
  let plain = 0;
  let close = row.indexOf(']');
  let index = 0;
  while (index < row.length) {
    let end = -1;
    if (row[index] === '[' && close !== -1) {
      if (close <= index) close = row.indexOf(']', index + 1);
      if (close > index + 1) end = close + 1;
    } else if (row.startsWith('Esc', index)) {
      end = index + 3;
    } else if (row.startsWith('Ctrl+C', index)) {
      end = index + 6;
    }
    if (end === -1) {
      index++;
      continue;
    }
    if (index > plain) parts.push(row.slice(plain, index));
    parts.push(row.slice(index, end));
    index = end;
    plain = end;
  }
  if (plain < row.length) parts.push(row.slice(plain));
  return parts;
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

const OUTCOME_MARK: Record<ToolDisplay['outcome'], { mark: string; word: string; tone: CallTone }> =
  {
    success: { mark: '✓', word: '', tone: 'ok' },
    failure: { mark: '✗', word: 'failed', tone: 'bad' },
    denied: { mark: '⊘', word: 'denied', tone: 'warn' },
    unknown: { mark: '?', word: 'outcome unknown', tone: 'warn' },
    running: { mark: '…', word: 'running', tone: 'dim' },
  };

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
  const hint = '↑↓ PgUp/PgDn select · Enter open · Home/End oldest/newest · Esc closes';
  const count = input.calls.length;
  if (count === 0)
    return {
      title: 'Tool calls',
      rows: [],
      empty: 'No tool calls yet. Earlier sessions keep no previews.',
      status: '',
      hint: 'Esc closes',
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
    const outcome = OUTCOME_MARK[call.outcome];
    const tool = escapedFit(sanitizeUntrustedInline(call.toolId), toolWidth);
    const right = [
      call.stats === undefined ? '' : `+${call.stats.addedLines} −${call.stats.removedLines}`,
      outcome.word,
    ]
      .filter((part) => part.length > 0)
      .join(SEPARATOR);
    const head = `${start + index === selected ? '>' : ' '} ${outcome.mark} ${tool}${' '.repeat(Math.max(0, toolWidth - displayWidth(tool)))}`;
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
