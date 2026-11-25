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
} from 'react';
import type { ChatStoreController, ChatStoreSnapshot } from './chat-store.js';
import {
  createMeasuredFrameAcknowledgement,
  reviewTerminalFits,
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
  type CallListRow,
  type FullChrome,
  type InspectionPending,
} from './tool-review-screen.js';
import { glyph, glyphOf, withGlyphForm } from './glyphs.js';
import {
  exitKey,
  keyToken,
  legend,
  legendItems,
  type LegendItem,
  type LegendRender,
} from './legend.js';
import { rowSegments } from './legend-row.js';
import { EmphText } from './emphasis-view.js';
import { emphasisDescription, SELECTED_ROW, type EmphasisSet } from './emphasis.js';
import type { SheetRole } from './sheet-frame.js';
import { colorProps, dimProps } from './projection.js';
import {
  createReviewDocument,
  escapeReviewCharacter,
  projectReviewPage,
  REVIEW_START,
  type ReviewPage,
} from './tool-review-projection.js';
import { attemptClipboardWrite, type ClipboardWriter } from '../clipboard.js';
import { sanitizeUntrustedInline } from '../sanitize.js';

const escaped = (text: string): string =>
  [...text].map((char) => escapeReviewCharacter(char, false)).join('');

function inputDisplay(text: string): string {
  let output = '',
    count = 0;
  const chars = [...text];
  for (const char of chars) {
    const token = escapeReviewCharacter(char, false);
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
  }>,
): ReactElement | null {
  const snapshot = useSyncExternalStore(props.store.subscribe, props.store.getSnapshot);
  const review = snapshot.review;
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
  const identity = reviewIdentity(snapshot, props.size.cols);
  // The rows the card is built from carry glyphs of the table: the plain forms when colour is explicitly off (an absent `color` is the Unicode
  // form, as a view mounted without the prop always drew), and none of them is wider than its Unicode glyph, so the measured frame is the same.
  const plain = props.color === false;
  const { page, chrome } = withGlyphForm(plain, () =>
    reviewScreen(snapshot, props.size, props.clipboard !== undefined, identity),
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
    return <Text>{reviewExitHint(review, 'Terminal too small — resize to at least 80×24')}</Text>;
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
        />
      </Box>
    );
  }
  return (
    <Box ref={ref} flexDirection="column" flexShrink={0}>
      {review.screen === 'list' ? (
        <ReviewCallList
          snapshot={snapshot}
          review={review}
          columns={props.size.cols}
          rows={props.size.rows}
          color={props.color === true}
          plain={plain}
        />
      ) : (
        chrome !== undefined && (
          <ReviewScreen
            review={review}
            page={page}
            chrome={chrome}
            columns={props.size.cols}
            rows={props.size.rows}
            color={props.color === true}
            plain={plain}
          />
        )
      )}
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
  size: { readonly cols: number; readonly rows: number },
  canCopy: boolean,
  identity: Pick<ReviewPage, 'rows' | 'valid'> | undefined = reviewIdentity(snapshot, size.cols),
): { readonly page: ReviewPage | undefined; readonly chrome: FullChrome | undefined } {
  const review = snapshot.review;
  if (review === undefined) return { page: undefined, chrome: undefined };
  if (review.screen !== 'full')
    return { page: toolReviewPage(review, size.cols, size.rows), chrome: undefined };
  // The chrome's ROW COUNT does not depend on the page (the key rows are always two, the status rule one), only its words
  // do, so it is sized before the page exists and drawn after.
  const requiredTarget = reviewRequiredTarget(review, size.cols, size.rows);
  const pending = inspectionPending(review, requiredTarget);
  const sizing = buildFullChrome(snapshot, review, size.cols, identity, canCopy, pending);
  const page = toolReviewPage(review, size.cols, size.rows, sizing.rows);
  return {
    page,
    chrome: buildFullChrome(snapshot, review, size.cols, identity, canCopy, pending, page),
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
function reviewExitHint(review: ToolReviewState, explanation: string): string {
  const because: LegendItem = { text: explanation.replace(/\.$/u, '') };
  if (review.kind !== 'approval') return legend([because], exitKey.close());
  const modal = review.denial !== undefined || review.searching;
  if (modal) return legend([because, STOP_KEY], exitKey.close('Esc', 'close the box'));
  return review.screen === 'card'
    ? legend([because, DENY_KEY], exitKey.decide('stops the turn'))
    : legend([because, DENY_KEY, STOP_KEY], exitKey.step());
}

const RULE_LABEL = ' Approval needed ';

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

/** The thin rule that opens the card: it says the turn is waiting on the person, and is yellow where colour is on. */
function approvalRule(columns: number): string {
  const rule = glyph('thinRule');
  return `${rule}${RULE_LABEL}${rule.repeat(Math.max(1, columns - 2 - RULE_LABEL.length))}`;
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
  };
  const keys = cardKeyLegend(keyInput);
  const questionOpen = keyInput.confirmAlways || keyInput.confirmRemember === true;
  const cut = (page?.hiddenLines ?? 0) > 0;
  return (
    <>
      <Text {...colorProps(color, 'yellow')} wrap="truncate-end">
        {approvalRule(columns)}
      </Text>
      {keyed(titleRows, (row) => row).map(({ key, item: row }) => (
        <EmphText key={key} emphasis="bold">
          {row}
        </EmphText>
      ))}
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
          <Text {...dimProps(color)}>
            {[identityText, stats].filter((part) => part.length > 0).join(' \u00b7 ')}
          </Text>
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
          <Text wrap="truncate-end">{`Reason to deny: ${inputDisplay(review.denial)}${glyphOf('caret', plain)}`}</Text>
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
