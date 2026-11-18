import { Box, Text, useApp, useStdout, type DOMElement } from 'ink';
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
  cardKeyRows,
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
  keyLabelParts,
  type CallListRow,
  type FullChrome,
  type InspectionPending,
} from './tool-review-screen.js';
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
  const { page, chrome } = reviewScreen(
    snapshot,
    props.size,
    props.clipboard !== undefined,
    identity,
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
    return <Text>Terminal too small — resize to at least 80×24. {reviewExitHint(review)}</Text>;
  if (blocked === review || page?.valid === false || identity?.valid === false)
    return (
      <Text>
        {identity?.valid === false
          ? 'Review unavailable — the tool identity does not fit; enlarge terminal.'
          : 'Review unavailable — enlarge terminal, narrow change, or [v] full view / [p] code points.'}{' '}
        {reviewExitHint(review)}
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
        }
      : undefined,
    searching: review.searching,
  });
}

/**
 * What the keys do on a review that cannot be shown: `Ctrl+N` denies without ending the turn, Esc stops it. Inside a
 * modal sub-state (a typed denial reason, the full view's search) an unseen frame leaves `Ctrl+N` inert — the model
 * only lets those states act on a frame the person can read — so only Esc is true there.
 */
function reviewExitHint(review: ToolReviewState): string {
  if (review.kind !== 'approval') return 'Esc closes.';
  const modal = review.denial !== undefined || review.searching;
  return modal ? 'Esc stops the turn.' : '[Ctrl+N] denies · Esc stops the turn.';
}

const RULE_LABEL = ' Approval needed ';

/** The thin rule that opens the card: it says the turn is waiting on the person, and is yellow where colour is on. */
function approvalRule(columns: number): string {
  return `\u2500${RULE_LABEL}${'\u2500'.repeat(Math.max(1, columns - 2 - RULE_LABEL.length))}`;
}

/** Colour a key legend: the answers stand out (allow green, deny red, the rest cyan), the words stay dim. */
function keyTone(part: string, color: boolean): Record<string, unknown> {
  if (!color) return {};
  if (part === '[Ctrl+Y]' || part === '[Ctrl+G]') return { color: 'green', bold: true };
  if (part === '[Ctrl+N]') return { color: 'red', bold: true };
  if (part === 'Esc') return { color: 'yellow', bold: true };
  // Every other key (`[v]`, `[Ctrl+R]`, `[PgUp/PgDn]`, `[p]`, …) is a cyan label.
  if (part.startsWith('[') && part.endsWith(']')) return { color: 'cyan', bold: true };
  return { dimColor: true };
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

function KeyRow({ row, color }: Readonly<{ row: string; color: boolean }>): ReactElement {
  return (
    <Text wrap="truncate-end">
      {keyed(keyLabelParts(row), (part) => part).map(({ key, item: part }) => (
        <Text key={key} {...keyTone(part, color)}>
          {part}
        </Text>
      ))}
    </Text>
  );
}

/** Strip a framing label (`target `, `tool `) from a projected row: it is generated text, never source. */
function withoutLabel(row: string, label: string): string {
  return row.startsWith(`${label} `) ? row.slice(label.length + 1) : row;
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
function ReviewCard({
  snapshot,
  review,
  page,
  identity,
  columns,
  rows,
  color,
}: Readonly<{
  snapshot: ChatStoreSnapshot;
  review: ToolReviewState;
  page: ReviewPage | undefined;
  identity: Pick<ReviewPage, 'rows' | 'valid'> | undefined;
  columns: number;
  rows: number;
  color: boolean;
}>): ReactElement {
  const request = snapshot.approval?.request;
  const toolId = request?.toolId ?? '';
  const document = review.document;
  const target = toolReviewTarget(review, columns, rows);
  const verb = cardVerb(toolId, request?.action ?? '', document?.preview);
  const targetRows = (target?.rows ?? []).map((row) => withoutLabel(row, 'target'));
  // A delivered saved result is not a new operation: its card says so, and shows no invented fresh diff.
  const savedResult = document?.preview.kind === 'saved-result';
  const titleRows = savedResult
    ? [
        'Deliver saved result \u2014 no new filesystem operation',
        ...targetRows.map((row) => `  ${row}`),
      ]
    : targetRows.length === 0
      ? [`${verb} ${inputDisplay(sanitizeUntrustedInline(toolId))}`]
      : targetRows.map((row, index) => (index === 0 ? `${verb} ${row}` : `  ${row}`));
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
  });
  const keys = cardKeyRows({
    inspected,
    cacheable: reviewOffersAlways(review, page, snapshot.approval?.cacheable === true),
    scope: escaped(cardScopePhrase(toolId)),
    // The question lives only while the card still offers the grant it asks about.
    confirmAlways:
      snapshot.alwaysConfirm &&
      reviewOffersAlways(review, page, snapshot.approval?.cacheable === true),
  });
  const cut = (page?.hiddenLines ?? 0) > 0;
  return (
    <>
      <Text {...colorProps(color, 'yellow')} wrap="truncate-end">
        {approvalRule(columns)}
      </Text>
      {keyed(titleRows, (row) => row).map(({ key, item: row }) => (
        <Text key={key} bold>
          {row}
        </Text>
      ))}
      {keyed(page?.rows ?? [], (row) => row).map(({ key, item: row, index }) => {
        const kind = page?.kinds[index] ?? 'meta';
        return (
          <Text key={key} {...rowTone(kind, color)}>
            {cardBodyRow(row, kind) || ' '}
          </Text>
        );
      })}
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
      {warnings.map((warning, index) => (
        <Text key={`warn-${index}`} {...colorProps(color, 'yellow')}>
          {warning}
        </Text>
      ))}
      {review.denial !== undefined ? (
        <Box flexDirection="column">
          <Text {...dimProps(color)}>
            {denialReasonDisclosure(Math.max(1, columns - 2)).join('\n')}
          </Text>
          <Text wrap="truncate-end">{`Reason to deny: ${inputDisplay(review.denial)}\u2588`}</Text>
          <Text wrap="truncate-end">{'Enter denies and continues \u00b7 Esc stops the turn'}</Text>
        </Box>
      ) : (
        keys.map((row, index) => <KeyRow key={`keys-${index}`} row={row} color={color} />)
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
}: Readonly<{
  snapshot: ChatStoreSnapshot;
  review: ToolReviewState;
  columns: number;
  rows: number;
  color: boolean;
}>): ReactElement {
  const view = callListView({
    calls: [...snapshot.toolDisplays.values()],
    selected: review.selected,
    columns,
    terminalRows: rows,
  });
  return (
    <>
      <Text bold wrap="truncate-end">
        {view.title}
      </Text>
      {view.empty !== undefined && <Text wrap="truncate-end">{view.empty}</Text>}
      {keyed(view.rows, (row) => row.text).map(({ key, item: row }) => (
        <Text key={key} wrap="truncate-end" {...callRowProps(row, color)}>
          {row.text}
        </Text>
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

function callRowProps(row: CallListRow, color: boolean): Record<string, unknown> {
  const tone = callToneProps(row.tone, color);
  return row.selected ? { ...tone, bold: true } : tone;
}

/** A body row of the full view: diff rows as the card draws them, a call's fields as a name and an indented value. */
function bodyRow(
  row: string,
  kind: ReviewPage['kinds'][number],
  label: string,
  color: boolean,
  continued = false,
): { readonly text: string; readonly props: Record<string, unknown> } {
  if (label === 'field name') return { text: withoutLabel(row, label), props: { bold: true } };
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
}: Readonly<{
  review: ToolReviewState;
  page: ReviewPage | undefined;
  chrome: FullChrome;
  columns: number;
  rows: number;
  color: boolean;
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
        <Text key={key} bold={index === 0} wrap="truncate-end">
          {row}
        </Text>
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
          <Text key={key} {...drawnRow.props}>
            {drawnRow.text || ' '}
          </Text>
        );
      })}
      {Array.from({ length: Math.max(0, body - drawn) }, (_, index) => (
        <Text key={`pad-${index}`}> </Text>
      ))}
      <Text wrap="truncate-end" {...dimProps(color)}>
        {fullStatusRow({
          page,
          document,
          revealed: review.reveal,
          numeric: review.numeric,
          columns,
        })}
      </Text>
      <Text wrap="truncate-end">{review.message === '' ? ' ' : escaped(review.message)}</Text>
      {review.searching && (
        <Text wrap="truncate-end">
          Search visible source: {inputDisplay(review.query ?? '')}█ · Enter find
        </Text>
      )}
      {keyed(chrome.nav, (row) => row).map(({ key, item: row }) => (
        <KeyRow key={`nav-${key}`} row={row} color={color} />
      ))}
      {keyed(chrome.answers, (row) => row).map(({ key, item: row }) => (
        <KeyRow key={`answer-${key}`} row={row} color={color} />
      ))}
      {review.kind === 'approval' ? (
        <Text wrap="truncate-end" {...dimProps(color)}>
          {chrome.note}
        </Text>
      ) : (
        <KeyRow row={chrome.note} color={color} />
      )}
    </>
  );
}
