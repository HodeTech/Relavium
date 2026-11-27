import { Box, useApp, useStdout, type DOMElement } from 'ink';
import { Text } from './text.js';
import { denialReasonDisclosure } from './chat-projection.js';
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from 'react';
import type { ChatStoreController, ChatStoreSnapshot } from './chat-store.js';
import {
  createMeasuredFrameAcknowledgement,
  reviewTerminalFits,
  TERMINAL_TOO_SMALL_TEXT,
} from './measured-frame-acknowledgement.js';
import {
  inspectionPending,
  reviewInspected,
  reviewOffersAlways,
  reviewRequiredTarget,
  toolReviewPage,
  toolReviewTarget,
  type ToolReviewState,
} from './tool-review-model.js';
import {
  cardKeyLegend,
  cardScopePhrase,
  cardStats,
  cardVerb,
  cardWarnings,
} from './tool-review-card.js';
import {
  callListView,
  fullChrome,
  fullBodyRows,
  fullStatusRow,
  inspectionBottomEdge,
  inspectionGeometry,
  inspectionOrigin,
  inspectionTitle,
  inspectionTopEdge,
  type CallListRow,
  type FullChrome,
  type InspectionGeometry,
  type InspectionPending,
} from './tool-review-screen.js';
import { glyph, glyphOf, withGlyphForm } from './glyphs.js';
import {
  exitKey,
  keyToken,
  legend,
  legendItems,
  legendRows,
  type LegendExit,
  type LegendItem,
  type LegendRender,
} from './legend.js';
import { rowSegments } from './legend-row.js';
import { EmphText } from './emphasis-view.js';
import { emphasisDescription, SELECTED_ROW, type EmphasisSet } from './emphasis.js';
import { sheetRule, type SheetRole } from './sheet-frame.js';
import { useWaitClock, type WaitClockForm } from './wait-clock.js';
import { colorProps, dimProps } from './projection.js';
import {
  createReviewDocument,
  escapeReviewText,
  projectReviewPage,
  REVIEW_START,
  type ReviewPage,
} from './tool-review-projection.js';
import { attemptClipboardWrite, type ClipboardWriter } from '../clipboard.js';
import { sanitizeUntrustedInline } from '../sanitize.js';
import { displayWidth, inkSafe } from './viewport.js';

const escaped = (text: string): string => escapeReviewText(text).join('');

function inputDisplay(text: string): string {
  let output = '',
    count = 0;
  const chars = [...text];
  const tokens = escapeReviewText(text);
  for (const token of tokens) {
    if (output.length + token.length > 40) break;
    output += token;
    count++;
  }
  return (
    output + (count < chars.length ? `… (${chars.length - count} input characters omitted)` : '')
  );
}

/** Identity is mandatory, never abbreviated into another tool's apparent grant scope. */
export function toolReviewIdentity(
  toolId: string,
  label: 'action' | 'outcome',
  value: string,
  columns: number,
): Pick<ReviewPage, 'rows' | 'valid'> {
  const document = createReviewDocument({
    kind: 'operation',
    fields: [
      { name: 'tool', value: toolId },
      { name: label, value },
    ],
  });
  const page = projectReviewPage(
    {
      ...document,
      lines: document.lines
        .filter((_, index) => index % 2 === 1)
        .map((line, index) => ({
          ...line,
          label: index === 0 ? 'tool' : label,
        })),
    },
    REVIEW_START,
    Math.max(0, columns - 2),
    2,
  );
  return {
    rows: page.rows,
    valid:
      page.valid &&
      page.next === undefined &&
      document.masks.length === 0 &&
      toolId.length > 0 &&
      value.length > 0,
  };
}

/** Shared live review overlay. Input stays with the host's existing single owner. */
export function ToolReviewHost(
  props: Readonly<{
    store: ChatStoreController;
    size: { cols: number; rows: number };
    hasCustody: () => boolean;
    clipboard?: ClipboardWriter | undefined;
    /** Whether colour output is on (the card colours additions, removals and warnings). */
    color?: boolean | undefined;
    /**
     * How the sheet's wait clock is drawn (ADR-0147 §2): `ticking` in the alternate screen, the static `waiting since HH:MM` inline (the
     * default: a host that does not say starts no timer).
     */
    waitClock?: WaitClockForm | undefined;
  }>,
): ReactElement | null {
  const snapshot = useSyncExternalStore(props.store.subscribe, props.store.getSnapshot);
  const review = snapshot.review;
  // The wait clock: a display value of this host, not of the store's snapshot, re-rendered by the host's own one-second timer while the card
  // is on screen; no guard reads it (ADR-0147 §2).
  const clock = useWaitClock(cardWaitOrigin(snapshot), props.waitClock);
  // The answer lockout as the grants draw it (`(wait)`): the store's display value, beside the snapshot; one repaint when it opens.
  const locked = useSyncExternalStore(
    props.store.answerLock.subscribe,
    props.store.answerLock.read,
  );
  const app = useApp();
  const { stdout } = useStdout();
  const ref = useRef<DOMElement | null>(null);
  const latest = useRef(props);
  latest.current = props;
  const pageRef = useRef<ReviewPage | undefined>(undefined);
  const [blocked, setBlocked] = useState<typeof review>(undefined);
  const [acknowledgement] = useState(() =>
    createMeasuredFrameAcknowledgement({
      current: () => latest.current.store.getSnapshot().review,
      getSize: () => latest.current.size,
      hasCustody: () =>
        latest.current.hasCustody() &&
        stdout.writable &&
        !stdout.destroyed &&
        !stdout.writableEnded &&
        !stdout.errored,
      onAcknowledge: (current) => {
        if (current !== undefined)
          latest.current.store.acknowledgeReviewFrame(current, pageRef.current);
      },
    }),
  );
  useEffect(() => {
    props.store.bindReviewVisibility(() =>
      acknowledgement.visible(props.store.getSnapshot().review),
    );
    const clipboard = props.clipboard;
    props.store.bindReviewClipboard(
      clipboard === undefined
        ? undefined
        : async (text) => (await attemptClipboardWrite(clipboard, text)).kind === 'written',
    );
    return () => {
      props.store.bindReviewVisibility(undefined);
      props.store.bindReviewClipboard(undefined);
    };
  }, [props.store, props.clipboard, acknowledgement]);
  useEffect(() => () => acknowledgement.dispose(), [acknowledgement]);
  useLayoutEffect(() => {
    acknowledgement.invalidate();
    props.store.invalidateToolReview();
  }, [props.size.cols, props.size.rows, props.store, acknowledgement]);
  // The size the page is projected for: the terminal's for the card, the inspection popup's for the full view and the call list (ADR-0148 §7),
  // from the one geometry that also sizes the popup's frame below.
  const pageSize = reviewPageSize(review, props.size);
  const identity = reviewIdentity(snapshot, pageSize.cols);
  // The rows the card is built from carry glyphs of the table: the plain forms when colour is explicitly off (an absent `color` is the Unicode
  // form, as a view mounted without the prop always drew), and none of them is wider than its Unicode glyph, so the measured frame is the same.
  const plain = props.color === false;
  const { page, chrome } = withGlyphForm(plain, () =>
    reviewScreen(snapshot, props.size, props.clipboard !== undefined, identity, locked),
  );
  pageRef.current = page;
  useLayoutEffect(() => {
    if (blocked !== undefined && blocked !== review) setBlocked(undefined);
    if (review === undefined) acknowledgement.invalidate();
    if (
      review === undefined ||
      !reviewTerminalFits(props.size) ||
      blocked === review ||
      page?.valid === false ||
      identity?.valid === false
    )
      return;
    if (!acknowledgement.commit(review, ref.current, () => app.waitUntilRenderFlush()))
      setBlocked(review);
  });
  if (review === undefined) return null;
  if (!reviewTerminalFits(props.size))
    return <Text>{reviewExitHint(review, TERMINAL_TOO_SMALL_TEXT, props.size.cols)}</Text>;
  if (blocked === review || page?.valid === false || identity?.valid === false)
    return (
      <Text>
        {reviewExitHint(
          review,
          reviewUnavailableText({
            identityInvalid: identity?.valid === false,
            commandTooLarge: review.facts !== undefined && review.document?.valid === false,
            onCard: review.screen === 'card',
          }),
          props.size.cols,
        )}
      </Text>
    );
  if (review.screen === 'card') {
    // The docked card (ADR-0129): the conversation stays above it, so this root draws only the card.
    return (
      <Box ref={ref} flexDirection="column" flexShrink={0}>
        <ReviewCard
          snapshot={snapshot}
          review={review}
          page={page}
          identity={identity}
          columns={props.size.cols}
          rows={props.size.rows}
          color={props.color === true}
          plain={plain}
          clock={clock}
          locked={locked}
        />
      </Box>
    );
  }
  // The full view and the call list: the large inspection popup the sheet owns (ADR-0148 §7), the page drawn inside its frame. The terminal
  // fits (checked above), so the popup's geometry exists.
  return (
    <InspectionFrame
      geometry={inspectionGeometry(props.size)}
      columns={props.size.cols}
      title={inspectionTitle(review.kind, review.facts !== undefined)}
      origin={inspectionOrigin(review.kind)}
      color={props.color === true}
      plain={plain}
      contentRef={ref}
    >
      {review.screen === 'list' ? (
        <ReviewCallList
          snapshot={snapshot}
          review={review}
          columns={pageSize.cols}
          rows={pageSize.rows}
          color={props.color === true}
          plain={plain}
        />
      ) : (
        chrome !== undefined && (
          <ReviewScreen
            review={review}
            page={page}
            chrome={chrome}
            columns={pageSize.cols}
            rows={pageSize.rows}
            color={props.color === true}
            plain={plain}
          />
        )
      )}
    </InspectionFrame>
  );
}

/**
 * The size a review's page is projected for (ADR-0148 §7): the terminal's for the docked card, and for the full view and the call list the
 * inspection popup's page ({@link inspectionGeometry}), so the page, the required target, the identity and the copy all fit the popup they are
 * drawn in. Below the popup's floor the terminal's (nothing is drawn there but the refusal).
 */
export function reviewPageSize(
  review: ToolReviewState | undefined,
  size: { readonly cols: number; readonly rows: number },
): { readonly cols: number; readonly rows: number } {
  if (review === undefined || review.screen === 'card') return size;
  return inspectionGeometry(size)?.page ?? size;
}

/**
 * The inspection popup's frame (ADR-0148 §7): a box of the popup's size, `columns − 2` by `rows − 1`, centred, with its top edge (the popup's
 * name and where it came from), the screen across the box's whole width, and its bottom edge. The measured-frame acknowledgement is handed the
 * CONTENT node (`contentRef`), which has no fixed size of its own: a row one cell too wide wraps and an extra row is an extra row, and either makes
 * it taller than the box, which the acknowledgement refuses (Allow stays locked). The box is in the flow, in the body's place (the chat is hidden
 * while it is open), in both renderers: it is as tall as the full screen it replaces was, so nothing can be drawn over it.
 */
function InspectionFrame(
  props: Readonly<{
    /** Absent below the popup's floor, where the host has drawn the refusal already: nothing is drawn. */
    geometry: InspectionGeometry | undefined;
    columns: number;
    title: string;
    origin: string;
    color: boolean;
    plain: boolean;
    contentRef: RefObject<DOMElement | null>;
    children: ReactNode;
  }>,
): ReactElement | null {
  if (props.geometry === undefined) return null;
  const { box } = props.geometry;
  const top = withGlyphForm(props.plain, () =>
    inspectionTopEdge(props.title, props.origin, box.width),
  );
  const bottom = withGlyphForm(props.plain, () => inspectionBottomEdge(box.width));
  return (
    <Box
      width={box.width}
      height={box.height}
      marginLeft={Math.max(0, Math.floor((props.columns - box.width) / 2))}
      flexDirection="column"
      flexShrink={0}
    >
      <Box ref={props.contentRef} flexDirection="column" flexGrow={1} flexShrink={0}>
        <Text wrap="truncate-end">
          <Text {...dimProps(props.color)}>{top.lead}</Text>
          <EmphText emphasis="bold">{top.title}</EmphText>
          <Text {...dimProps(props.color)}>{top.rest}</Text>
        </Text>
        <Box flexDirection="column" flexGrow={1}>
          {props.children}
        </Box>
        <Text {...dimProps(props.color)} wrap="truncate-end">
          {bottom}
        </Text>
      </Box>
    </Box>
  );
}

/**
 * The page a review screen draws and the chrome around it, from one snapshot. The full view's chrome is counted once, here,
 * and the page is given exactly the rows that are left: the model that sizes the body and the view that draws the rest cannot
 * disagree (ADR-0134 §3). Exported so a test derives "the page the host drew" from the same function the host uses.
 */
export function reviewScreen(
  snapshot: ChatStoreSnapshot,
  terminal: { readonly cols: number; readonly rows: number },
  canCopy: boolean,
  identity: Pick<ReviewPage, 'rows' | 'valid'> | undefined = reviewIdentity(
    snapshot,
    reviewPageSize(snapshot.review, terminal).cols,
  ),
  /** The answer lockout holds the grants now (the store's `answerLock`): the full view's grants row reads `(wait)`. */
  locked = false,
): { readonly page: ReviewPage | undefined; readonly chrome: FullChrome | undefined } {
  // The full view's page is projected for the inspection popup it is drawn in (ADR-0148 §7); the card's for the terminal.
  const size = reviewPageSize(snapshot.review, terminal);
  const review = snapshot.review;
  if (review === undefined) return { page: undefined, chrome: undefined };
  if (review.screen !== 'full')
    return { page: toolReviewPage(review, size.cols, size.rows), chrome: undefined };
  // The chrome's ROW COUNT does not depend on the page (the key rows are always two, the status rule one), only its words
  // do, so it is sized before the page exists and drawn after.
  const requiredTarget = reviewRequiredTarget(review, size.cols, size.rows);
  const pending = inspectionPending(review, requiredTarget);
  const sizing = buildFullChrome(snapshot, review, size.cols, identity, canCopy, pending, locked);
  const page = toolReviewPage(review, size.cols, size.rows, sizing.rows);
  return {
    page,
    chrome: buildFullChrome(snapshot, review, size.cols, identity, canCopy, pending, locked, page),
  };
}

/**
 * What a command card adds to its answer rows (ADR-0118 §1): the grants are worded for THIS exact command, `Ctrl+O` is offered
 * when the store can write one (and the page shows everything it would remember), and its question has its own sentence.
 */
function commandKeys(
  snapshot: ChatStoreSnapshot,
  review: ToolReviewState,
  page: ReviewPage | undefined,
): { command?: true; remember?: boolean; confirmRemember?: boolean } {
  const facts = review.facts;
  if (facts === undefined) return {};
  const remember = reviewOffersAlways(review, page, facts.offers.remember);
  return { command: true, remember, confirmRemember: snapshot.rememberConfirm && remember };
}

/** The full view's chrome for one frame: what `fullChrome` needs from the store, the review and the page being drawn. */
function buildFullChrome(
  snapshot: ChatStoreSnapshot,
  review: ToolReviewState,
  columns: number,
  identity: Pick<ReviewPage, 'rows' | 'valid'> | undefined,
  canCopy: boolean,
  pending: InspectionPending,
  locked: boolean,
  page?: ReviewPage,
): FullChrome {
  const document = review.document;
  const approval = review.kind === 'approval';
  const cacheable = reviewOffersAlways(review, page, snapshot.approval?.cacheable === true);
  return fullChrome({
    kind: review.kind,
    title: reviewTitle(review),
    columns,
    document,
    identity: identity?.rows ?? [],
    // A row is kept for the target whatever the cursor does, so the body's height never depends on where it is: the target is
    // drawn there while the body is scrolled away from it, and the row is blank at the top, where the body's own first row IS the
    // target (and, when it was shortened, the only place to read all of it).
    hasTarget: document?.preview.target !== undefined,
    pending,
    nav: {
      hasChanges: (document?.changeStarts.length ?? 0) > 0,
      hasMasks: (document?.masks.length ?? 0) > 0,
      canCopy,
      revealed: review.reveal,
      numeric: review.numeric,
    },
    keys: approval
      ? {
          inspected: !pending.target && pending.masks === 0,
          cacheable,
          scope: escaped(cardScopePhrase(snapshot.approval?.request.toolId ?? '')),
          confirmAlways: snapshot.alwaysConfirm && cacheable,
          ...commandKeys(snapshot, review, page),
          locked,
          columns: Math.max(1, columns - 2),
        }
      : undefined,
    searching: review.searching,
    commandFacts: approval ? review.facts : undefined,
  });
}

/** `Ctrl+N` denies without ending the turn: the one answer a review that cannot be shown still takes. */
const DENY_KEY: LegendItem = { keys: 'Ctrl+N', verb: 'Deny', role: 'danger' };
/** The stop key, named where `Esc` is the exit and so does something else. */
const STOP_KEY: LegendItem = { keys: 'Ctrl+C', verb: 'stops the turn', role: 'warn' };

/**
 * What `explanation` (why the review is not shown) is followed by: what the keys do on a review that cannot be shown. `Ctrl+N` denies
 * without ending the turn; on the card Esc stops it, on the full view Esc steps back to the card and `Ctrl+C` stops it (ADR-0137 §4).
 * Inside a modal sub-state (a typed denial reason, the full view's search) an unseen frame leaves `Ctrl+N` inert — the model only lets
 * those states act on a frame the person can read — so only the two exits are true there: Esc closes the box and `Ctrl+C` stops the turn.
 * The explanation is the legend's first item, its closing full stop dropped (a legend has none).
 */
function reviewExitHint(review: ToolReviewState, explanation: string, columns: number): string {
  const because: LegendItem = { text: explanation.replace(/\.$/u, '') };
  // Drawn in rows cut between items, so a terminal too narrow for one row never splits `[Ctrl+C]` from what it does.
  const rows = (items: readonly LegendItem[], exit: LegendExit): string =>
    legendRows(items, exit, columns, displayWidth).join('\n');
  if (review.kind !== 'approval') return rows([because], exitKey.close());
  const modal = review.denial !== undefined || review.searching;
  if (modal) return rows([because, STOP_KEY], exitKey.close('Esc', 'close the box'));
  return review.screen === 'card'
    ? rows([because, DENY_KEY], exitKey.decide('stops the turn'))
    : rows([because, DENY_KEY, STOP_KEY], exitKey.step());
}

/** What the approval sheet's rule says it is (ADR-0147 §1): fixed host text. */
const RULE_LABEL = 'Approval needed';

/** What the card says in place of itself when it cannot be drawn: the identity, a command too large to show, or the screen. */
export function reviewUnavailableText(why: {
  readonly identityInvalid: boolean;
  readonly commandTooLarge: boolean;
  readonly onCard: boolean;
}): string {
  if (why.identityInvalid)
    return 'Review unavailable — the tool identity does not fit; enlarge terminal.';
  if (why.commandTooLarge)
    return 'A command is waiting, but it is too large for this card to show (more than 63 arguments, or an argument or the whole line over 4,096 characters), so it cannot be approved here. Denying tells the model to run it as smaller commands.';
  // `[v]` opens the full view from the card; on the full view it does nothing, so the sentence does not offer it.
  return why.onCard
    ? `Review unavailable — enlarge terminal, narrow change, or ${keyToken('v')} full view / ${keyToken('p')} code points.`
    : `Review unavailable — enlarge terminal, narrow change, or ${keyToken('p')} code points.`;
}

/** The card's title rows: a delivered saved result's, an unlabelled call's, or the verb and the target's rows. */
export function cardTitleRows(input: {
  readonly savedResult: boolean;
  readonly verb: string;
  readonly toolId: string;
  readonly targetRows: readonly string[];
  /** A command's card: its title wraps under its own first word. */
  readonly command: boolean;
}): string[] {
  const { verb, targetRows } = input;
  if (input.savedResult)
    return [
      'Deliver saved result \u2014 no new filesystem operation',
      ...targetRows.map((row) => `  ${row}`),
    ];
  if (targetRows.length === 0)
    return [`${verb} ${inputDisplay(sanitizeUntrustedInline(input.toolId))}`];
  // A command's title wraps under its own first word, so a continuation of the line is not mistaken for an argument's row below.
  const indent = ' '.repeat(input.command ? verb.length + 1 : 2);
  return targetRows.map((row, index) => (index === 0 ? `${verb} ${row}` : `${indent}${row}`));
}

/** The card's wait clock's origin: the moment the person's wait began, while the docked card is on screen (none on the popup or with no card). */
function cardWaitOrigin(snapshot: ChatStoreSnapshot): number | undefined {
  return snapshot.review?.screen === 'card' ? snapshot.state.approvalSinceMs : undefined;
}

/** The card's title rows, bold; the first carries the numbers flush right when they fit beside it (`gap`, {@link titleStatsGap}). */
function CardTitleRows(
  props: Readonly<{
    rows: readonly string[];
    stats: string;
    gap: number | undefined;
    color: boolean;
  }>,
): ReactElement {
  return (
    <>
      {keyed(props.rows, (row) => row).map(({ key, item: row, index }) =>
        index === 0 && props.gap !== undefined ? (
          <Box key={key}>
            <EmphText emphasis="bold">{row}</EmphText>
            <Text {...dimProps(props.color)}>{`${' '.repeat(props.gap)}${props.stats}`}</Text>
          </Box>
        ) : (
          <EmphText key={key} emphasis="bold">
            {row}
          </EmphText>
        ),
      )}
    </>
  );
}

/** The summary row's words: the tool's identity, and the numbers when the title row could not hold them. */
function summaryText(identity: string, stats: string, gap: number | undefined): string {
  return [identity, gap === undefined ? stats : '']
    .filter((part) => part.length > 0)
    .join(' \u00b7 ');
}

/**
 * The spaces between the card's first title row and its numbers (`+3 -1 · 214 bytes`), when both fit the card's drawable width with at least two
 * columns between them (ADR-0147 §1: what it is on the left, the numbers on the right); `undefined` when they do not, and the numbers stay on the
 * summary row. The title row is never shortened for them: the target's rows are fitted by the projection the Allow lock reads. A title row with a
 * run of two or more spaces keeps them off too: the target is the model's text, and such a run is how it would imitate the gap and set its own
 * numbers where the host's stand, so the host's never stand beside them (unit 8 fix wave, S-10).
 */
export function titleStatsGap(
  first: string | undefined,
  stats: string,
  columns: number,
): number | undefined {
  if (first === undefined || stats === '' || first.includes('  ')) return undefined;
  const gap = Math.max(1, columns - 2) - displayWidth(first) - displayWidth(stats);
  return gap >= 2 ? gap : undefined;
}

/**
 * The heavy rule that opens the approval sheet (ADR-0147 §1): it says the turn is waiting on the person and for how long (`clock`, the host's
 * display value), and is amber where colour is on. As wide as the thin rule it replaced, so the card's rows do not move.
 */
function approvalRule(columns: number, clock: string): string {
  return sheetRule(RULE_LABEL, clock, Math.max(1, columns - 1)).text;
}

/** The colour of a key stretch by the role its builder gave it: allow green, deny red, a stop yellow, other keys cyan, the words dim; nothing with colour off. */
function keyColour(role: SheetRole, color: boolean): Record<string, unknown> {
  if (!color) return {};
  switch (role) {
    case 'ok':
      return { color: 'green' };
    case 'danger':
      return { color: 'red' };
    case 'warn':
      return { color: 'yellow' };
    case 'strong':
      return { color: 'cyan' };
    case 'dim':
      return { dimColor: true };
  }
}

/** The weight of a key stretch, with colour on and off alike: a key is bold, the words around it are not. */
function keyEmphasis(role: SheetRole): EmphasisSet | undefined {
  return role === 'dim' ? undefined : 'bold';
}

/**
 * A key legend's stretch as a description: its colour (none with colour off) and its weight, which is there with colour off too. The view
 * draws the colour as a prop and the weight with the one emphasis rule ({@link keyColour}, {@link keyEmphasis}); the description is what
 * a test and the legend golden read.
 */
export function keyTone(role: SheetRole, color: boolean): Record<string, unknown> {
  return { ...keyColour(role, color), ...emphasisDescription(keyEmphasis(role)) };
}

/**
 * Rows of text with a React key made of the text and the number of equal rows before it, so a key never depends on where a row
 * sits among the others. (`index` is handed back for the few rows whose look depends on their place, such as a title.)
 */
function keyed<T>(
  items: readonly T[],
  textOf: (item: T) => string,
): readonly { readonly key: string; readonly item: T; readonly index: number }[] {
  const seen = new Map<string, number>();
  return items.map((item, index) => {
    const text = textOf(item);
    const earlier = seen.get(text) ?? 0;
    seen.set(text, earlier + 1);
    return { key: `${earlier}:${text}`, item, index };
  });
}

function KeyRow({
  row,
  color,
  question = false,
}: Readonly<{ row: LegendRender; color: boolean; question?: boolean }>): ReactElement {
  if (question)
    return (
      <EmphText wrap="truncate-end" emphasis="bold">
        {row.text}
      </EmphText>
    );
  return (
    <Text wrap="truncate-end">
      {keyed(rowSegments(row), (segment) => segment.text).map(({ key, item: segment }) => (
        <EmphText
          key={key}
          {...keyColour(segment.role, color)}
          emphasis={keyEmphasis(segment.role)}
        >
          {segment.text}
        </EmphText>
      ))}
    </Text>
  );
}

/** Strip a framing label (`target `, `tool `) from a projected row: it is generated text, never source. */
function withoutLabel(row: string, label: string): string {
  return row.startsWith(`${label} `) ? row.slice(label.length + 1) : row;
}

/** A call's fields on the card, as the full view draws them: a name in bold, a value indented under it (a bare value just indented). */
function cardRowText(
  row: string,
  label: string | undefined,
  kind: ReviewPage['kinds'][number],
): string {
  if (label === 'field name') return withoutLabel(row, label);
  if (label === 'field value') return `  ${withoutLabel(row, label) || '(empty)'}`;
  return cardBodyRow(row, kind);
}
/** A call's field name is bold on the card, with colour on and off alike; every other row has only its colour. */
function cardRowEmphasis(label: string | undefined): EmphasisSet | undefined {
  return label === 'field name' ? 'bold' : undefined;
}

/** One diff row as drawn on the card: context rows lose the `=` framing mark and are dimmed. */
function cardBodyRow(row: string, kind: ReviewPage['kinds'][number]): string {
  return kind === 'context' && row.startsWith('=') ? ` ${row.slice(1)}` : row;
}

/** The colour of a diff row by its role: additions green, removals red, context dim, anything else plain. */
function rowTone(kind: ReviewPage['kinds'][number], color: boolean): Record<string, unknown> {
  if (kind === 'added') return colorProps(color, 'green');
  if (kind === 'removed') return colorProps(color, 'red');
  return kind === 'context' ? dimProps(color) : {};
}

/**
 * The docked approval card ([ADR-0129](../../../../../docs/decisions/0129-the-approval-card-is-docked-bounded-and-says-only-what-matters.md)).
 * Title, diff body, one summary row, only the warnings that apply, and two key rows. Everything it shows comes from
 * the same projected page the safety machinery acknowledges; this component only chooses the words and colours.
 */
interface ReviewCardProps {
  readonly snapshot: ChatStoreSnapshot;
  readonly review: ToolReviewState;
  readonly page: ReviewPage | undefined;
  readonly identity: Pick<ReviewPage, 'rows' | 'valid'> | undefined;
  readonly columns: number;
  readonly rows: number;
  readonly color: boolean;
  /** The glyph table's plain forms: colour is explicitly off. */
  readonly plain: boolean;
  /** The wait clock's text (the host's display value, ADR-0147 §2): drawn in the rule, read by nothing else. */
  readonly clock: string;
  /** The answer lockout holds the grants (the store's `answerLock`, a display value): they read `(wait)`. */
  readonly locked: boolean;
}

/** The card, its rows built in the glyph form the colour setting asks for. */
function ReviewCard(props: Readonly<ReviewCardProps>): ReactElement {
  return withGlyphForm(props.plain, () => ReviewCardBody(props));
}

function ReviewCardBody({
  snapshot,
  review,
  page,
  identity,
  columns,
  rows,
  color,
  plain,
  clock,
  locked,
}: Readonly<ReviewCardProps>): ReactElement {
  const request = snapshot.approval?.request;
  const toolId = request?.toolId ?? '';
  const document = review.document;
  const target = toolReviewTarget(review, columns, rows);
  const verb = cardVerb(toolId, request?.action ?? '', document?.preview);
  const targetRows = (target?.rows ?? []).map((row) => withoutLabel(row, 'target'));
  // A delivered saved result is not a new operation: its card says so, and shows no invented fresh diff.
  const savedResult = document?.preview.kind === 'saved-result';
  const titleRows = cardTitleRows({
    savedResult,
    verb,
    toolId,
    targetRows,
    command: review.facts !== undefined,
  });
  const identityText = withoutLabel(identity?.rows[0] ?? '', 'tool');
  const stats = cardStats(document);
  // The lock is read from the page being drawn (its shortened target), not only from the state an acknowledged
  // frame has updated, so the first frame — and the first frame after a resize — already says Allow is locked.
  const inspected = reviewInspected(review, page?.requiredTarget);
  const warnings = cardWarnings({
    document,
    shortenedTarget: target?.next !== undefined || target?.valid === false,
    targetHiddenBytes: target?.hiddenBytes ?? 0,
    inspected,
    changesNotShown: page?.hiddenChanges ?? 0,
    linesNotShown: page?.hiddenLines ?? 0,
    columns: Math.max(1, columns - 2),
    commandFacts: review.facts,
    denialOpen: review.denial !== undefined,
  });
  const keyInput = {
    inspected,
    cacheable: reviewOffersAlways(review, page, snapshot.approval?.cacheable === true),
    scope: escaped(cardScopePhrase(toolId)),
    // The question lives only while the card still offers the grant it asks about.
    confirmAlways:
      snapshot.alwaysConfirm &&
      reviewOffersAlways(review, page, snapshot.approval?.cacheable === true),
    ...commandKeys(snapshot, review, page),
    locked,
    columns: Math.max(1, columns - 2),
  };
  const keys = cardKeyLegend(keyInput);
  const questionOpen = keyInput.confirmAlways || keyInput.confirmRemember === true;
  const cut = (page?.hiddenLines ?? 0) > 0;
  // The title line (ADR-0147 §1): what it is on the left, the numbers on the right, when the first title row has room for them beside it; else
  // they stay on the summary row. The row count is the same either way (the summary row carries the tool's identity regardless).
  const statsGap = titleStatsGap(titleRows[0], stats, columns);
  return (
    <>
      <Text {...colorProps(color, 'yellow')} wrap="truncate-end">
        {approvalRule(columns, clock)}
      </Text>
      <CardTitleRows rows={titleRows} stats={stats} gap={statsGap} color={color} />
      {keyed(page?.rows ?? [], (row) => row).map(({ key, item: row, index }) => {
        const kind = page?.kinds[index] ?? 'meta';
        const label = page?.labels[index];
        return (
          <EmphText
            key={key}
            {...(label === 'field name' ? {} : rowTone(kind, color))}
            emphasis={cardRowEmphasis(label)}
          >
            {cardRowText(row, label, kind) || ' '}
          </EmphText>
        );
      })}
      {review.facts === undefined && (
        <Box justifyContent="space-between">
          <Text {...dimProps(color)}>{summaryText(identityText, stats, statsGap)}</Text>
          {cut && (
            <Text {...dimProps(color)}>
              {`\u2026 ${page?.hiddenLines ?? 0} more line${page?.hiddenLines === 1 ? '' : 's'} (${page?.hiddenBytes ?? 0} bytes hidden)`}
            </Text>
          )}
        </Box>
      )}
      {keyed(warnings, (warning) => warning).map(({ key, item: warning }) => (
        // A warning is yellow; a plain fact (a command's standing and directory) is dimmed, so the one row that matters stands out.
        <Text
          key={key}
          {...(review.facts !== undefined &&
          !warning.startsWith(glyph('warning')) &&
          !warning.startsWith(' ')
            ? dimProps(color)
            : colorProps(color, 'yellow'))}
        >
          {warning}
        </Text>
      ))}
      {review.denial !== undefined ? (
        <Box flexDirection="column">
          <Text {...dimProps(color)}>
            {denialReasonDisclosure(Math.max(1, columns - 2)).join('\n')}
          </Text>
          <Text wrap="truncate-end">{`Reason to deny: ${inkSafe(inputDisplay(review.denial))}${glyphOf('caret', plain)}`}</Text>
          <Text wrap="truncate-end">
            {legend(
              [{ keys: 'Enter', verb: 'deny and continue' }, STOP_KEY],
              exitKey.close('Esc', 'close this box'),
            )}
          </Text>
        </Box>
      ) : (
        keyed(keys, (row) => row.text).map(({ key, item: row, index }) => (
          <KeyRow
            key={key}
            row={row}
            color={color}
            // The question a wider grant asks is what the person must read now: its first row is the card's plainest text.
            question={index === 0 && questionOpen}
          />
        ))
      )}
      {review.message !== '' && <Text>{escaped(review.message)}</Text>}
    </>
  );
}

function reviewIdentity(
  snapshot: ChatStoreSnapshot,
  columns: number,
): Pick<ReviewPage, 'rows' | 'valid'> | undefined {
  const review = snapshot.review;
  if (review === undefined || review.screen === 'list') return undefined;
  if (review.kind === 'approval' && snapshot.approval !== undefined)
    return toolReviewIdentity(
      snapshot.approval.request.toolId,
      'action',
      snapshot.approval.request.action,
      columns,
    );
  const selectedCall =
    review.callId === undefined ? undefined : snapshot.toolDisplays.get(review.callId);
  return toolReviewIdentity(
    selectedCall?.toolId ?? '',
    'outcome',
    selectedCall?.outcome ?? 'unknown',
    columns,
  );
}
function reviewTitle(review: ToolReviewState): string {
  if (review.kind !== 'approval') return 'Details';
  if (review.document?.preview.kind === 'saved-result')
    return 'Deliver saved result — no new filesystem operation';
  return 'Review';
}
/** The tool-call list ([ADR-0134](../../../../../docs/decisions/0134-the-full-view-and-the-tool-details-are-one-readable-inspection-screen.md) §5). */
function ReviewCallList({
  snapshot,
  review,
  columns,
  rows,
  color,
  plain,
}: Readonly<{
  snapshot: ChatStoreSnapshot;
  review: ToolReviewState;
  columns: number;
  rows: number;
  color: boolean;
  /** The glyph table's plain forms: colour is explicitly off. */
  plain: boolean;
}>): ReactElement {
  const view = withGlyphForm(plain, () =>
    callListView({
      calls: [...snapshot.toolDisplays.values()],
      selected: review.selected,
      columns,
      terminalRows: rows,
    }),
  );
  return (
    <>
      <EmphText emphasis="bold" wrap="truncate-end">
        {view.title}
      </EmphText>
      {view.empty !== undefined && <Text wrap="truncate-end">{view.empty}</Text>}
      {keyed(view.rows, (row) => row.text).map(({ key, item: row }) => (
        <EmphText
          key={key}
          wrap="truncate-end"
          {...callToneProps(row.tone, color)}
          emphasis={row.selected ? SELECTED_ROW : undefined}
        >
          {row.text}
        </EmphText>
      ))}
      {view.status.length > 0 && (
        <Text wrap="truncate-end" {...dimProps(color)}>
          {view.status}
        </Text>
      )}
      <Text wrap="truncate-end" {...dimProps(color)}>
        {view.hint}
      </Text>
    </>
  );
}

function callToneProps(tone: CallListRow['tone'], color: boolean): Record<string, unknown> {
  if (tone === 'bad') return colorProps(color, 'red');
  if (tone === 'warn') return colorProps(color, 'yellow');
  if (tone === 'dim') return dimProps(color);
  return {};
}

/** A body row of the full view: diff rows as the card draws them, a call's fields as a name and an indented value. */
function bodyRow(
  row: string,
  kind: ReviewPage['kinds'][number],
  label: string,
  color: boolean,
  continued = false,
): {
  readonly text: string;
  readonly props: Record<string, unknown>;
  readonly emphasis?: EmphasisSet;
} {
  if (label === 'field name')
    return { text: withoutLabel(row, label), props: {}, emphasis: 'bold' };
  if (label === 'field value') return { text: `  ${withoutLabel(row, label)}`, props: {} };
  // The rows of a wrapped target all start with its label; the later ones are indented under it, as the card does, so the
  // path does not read as several.
  if (label === 'target' && continued)
    return { text: `${' '.repeat(label.length + 1)}${withoutLabel(row, label)}`, props: {} };
  return { text: cardBodyRow(row, kind), props: rowTone(kind, color) };
}

/**
 * The full view and the tool details: one readable inspection screen. The header, the warnings, the status rule and the
 * legends all come from `fullChrome` (the page was sized by its row count); this component only draws them and the
 * page's rows, which are the same projected rows the safety machinery acknowledges.
 */
function ReviewScreen({
  review,
  page,
  chrome,
  columns,
  rows,
  color,
  plain,
}: Readonly<{
  review: ToolReviewState;
  page: ReviewPage | undefined;
  chrome: FullChrome;
  columns: number;
  rows: number;
  color: boolean;
  /** The glyph table's plain forms: colour is explicitly off. */
  plain: boolean;
}>): ReactElement {
  const document = review.document;
  const target = chrome.hasTarget ? toolReviewTarget(review, columns, rows) : undefined;
  const targetText = withoutLabel(target?.rows[0] ?? '', 'target');
  const body = fullBodyRows(rows, chrome.rows);
  const drawn = page?.rows.length ?? 0;
  const targetEllipsis = target?.next !== undefined || (target?.rows.length ?? 0) > 1 ? ' …' : '';
  return (
    <>
      {keyed(chrome.header, (row) => row).map(({ key, item: row, index }) => (
        <EmphText key={key} emphasis={index === 0 ? 'bold' : undefined} wrap="truncate-end">
          {row}
        </EmphText>
      ))}
      {chrome.hasTarget && (
        <Text wrap="truncate-end" {...dimProps(color)}>
          {review.cursor.line > 0 ? `target ${targetText}${targetEllipsis}` : ' '}
        </Text>
      )}
      {keyed(chrome.warnings, (warning) => warning).map(({ key, item: warning }) => (
        <Text key={key} wrap="truncate-end" {...colorProps(color, 'yellow')}>
          {warning}
        </Text>
      ))}
      {keyed(page?.rows ?? [], (row) => row).map(({ key, item: row, index }) => {
        const drawnRow = bodyRow(
          row,
          page?.kinds[index] ?? 'meta',
          page?.labels[index] ?? '',
          color,
          index > 0 && page?.labels[index] === page?.labels[index - 1],
        );
        return (
          // Not cut by the renderer: a row is fitted to its page by the projection, and one that were wider would wrap, make the
          // frame taller than the terminal and be refused by the measured acknowledgement — never silently hide what it shows.
          <EmphText key={key} {...drawnRow.props} emphasis={drawnRow.emphasis}>
            {drawnRow.text || ' '}
          </EmphText>
        );
      })}
      {Array.from({ length: Math.max(0, body - drawn) }, (_, index) => (
        <Text key={`pad-${index}`}> </Text>
      ))}
      <Text wrap="truncate-end" {...dimProps(color)}>
        {withGlyphForm(plain, () =>
          fullStatusRow({
            page,
            document,
            revealed: review.reveal,
            numeric: review.numeric,
            columns,
          }),
        )}
      </Text>
      <Text wrap="truncate-end">{review.message === '' ? ' ' : escaped(review.message)}</Text>
      {review.searching && (
        <Text wrap="truncate-end">
          {
            legendItems([
              {
                text: `Search visible source: ${inputDisplay(review.query ?? '')}${glyphOf('caret', plain)}`,
              },
              { keys: 'Enter', verb: 'find' },
            ]).text
          }
        </Text>
      )}
      {keyed(chrome.legends.nav, (row) => row.text).map(({ key, item: row }) => (
        <KeyRow key={`nav-${key}`} row={row} color={color} />
      ))}
      {keyed(chrome.legends.answers, (row) => row.text).map(({ key, item: row }) => (
        <KeyRow key={`answer-${key}`} row={row} color={color} />
      ))}
      {review.kind === 'approval' ? (
        <Text wrap="truncate-end" {...dimProps(color)}>
          {chrome.note}
        </Text>
      ) : (
        <KeyRow row={chrome.legends.note} color={color} />
      )}
    </>
  );
}
