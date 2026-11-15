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
  reviewInspected,
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
  const page =
    review === undefined ? undefined : toolReviewPage(review, props.size.cols, props.size.rows);
  const identity = reviewIdentity(snapshot, props.size.cols);
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
    return <Text>Terminal too small — resize to at least 80×24. Esc cancels.</Text>;
  if (blocked === review || page?.valid === false || identity?.valid === false)
    return (
      <Text>
        Review unavailable — enlarge terminal, narrow change, or [v] full view / [p] code points.
        Esc cancels.
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
      <Text bold>{reviewTitle(review)}</Text>
      {review.screen === 'list' ? (
        <ReviewCallList snapshot={snapshot} review={review} rows={props.size.rows} />
      ) : (
        <ReviewContent
          snapshot={snapshot}
          review={review}
          page={page}
          identity={identity}
          columns={props.size.cols}
          rows={props.size.rows}
        />
      )}
      {review.message !== '' && <Text>{escaped(review.message)}</Text>}
    </Box>
  );
}

const RULE_LABEL = ' Approval needed ';

/** The thin rule that opens the card: it says the turn is waiting on the person, and is yellow where colour is on. */
function approvalRule(columns: number): string {
  return `\u2500${RULE_LABEL}${'\u2500'.repeat(Math.max(1, columns - 2 - RULE_LABEL.length))}`;
}

/** Colour a key legend: the answers stand out (allow green, deny red, the rest cyan), the words stay dim. */
function keyTone(part: string, color: boolean): Record<string, unknown> {
  if (!color) return {};
  if (part === '[y]' || part === '[a]') return { color: 'green', bold: true };
  if (part === '[n]') return { color: 'red', bold: true };
  if (part === 'Esc') return { color: 'yellow', bold: true };
  if (/^\[[cv]\]$/u.test(part)) return { color: 'cyan', bold: true };
  return { dimColor: true };
}

function KeyRow({ row, color }: Readonly<{ row: string; color: boolean }>): ReactElement {
  const parts = row.split(/(\[[acnvy]\]|Esc)/u).filter((part) => part.length > 0);
  return (
    <Text wrap="truncate-end">
      {parts.map((part, index) => (
        <Text key={index} {...keyTone(part, color)}>
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
  const inspected = reviewInspected(review);
  const warnings = cardWarnings({
    document,
    shortenedTarget: target?.next !== undefined || target?.valid === false,
    targetHiddenBytes: target?.hiddenBytes ?? 0,
    inspected,
    columns: Math.max(1, columns - 2),
  });
  const keys = cardKeyRows({
    inspected,
    cacheable: snapshot.approval?.cacheable === true,
    scope: escaped(cardScopePhrase(toolId)),
  });
  const cut = (page?.hiddenLines ?? 0) > 0;
  return (
    <>
      <Text {...colorProps(color, 'yellow')} wrap="truncate-end">
        {approvalRule(columns)}
      </Text>
      {titleRows.map((row, index) => (
        <Text key={`title-${index}`} bold wrap="truncate-end">
          {row}
        </Text>
      ))}
      {(page?.rows ?? []).map((row, index) => {
        const kind = page?.kinds[index] ?? 'meta';
        const props =
          kind === 'added'
            ? colorProps(color, 'green')
            : kind === 'removed'
              ? colorProps(color, 'red')
              : kind === 'context'
                ? dimProps(color)
                : {};
        return (
          <Text key={index} {...props}>
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
  if (review.kind !== 'approval') return 'Tool details';
  if (review.document?.preview.kind === 'saved-result')
    return 'Deliver saved result — no new filesystem operation';
  return 'Review tool operation';
}
function ReviewCallList({
  snapshot,
  review,
  rows,
}: Readonly<{ snapshot: ChatStoreSnapshot; review: ToolReviewState; rows: number }>): ReactElement {
  const calls = [...snapshot.toolDisplays.values()];
  const selectedStart = Math.max(0, review.selected - 3);
  return (
    <>
      {calls.length === 0 && (
        <Text>No retained live tools. Historical previews are unavailable.</Text>
      )}
      {calls.slice(selectedStart, selectedStart + Math.max(1, rows - 8)).map((call, index) => (
        <Text key={call.callId}>
          {review.selected === selectedStart + index ? '> ' : '  '}
          {inputDisplay(sanitizeUntrustedInline(call.toolId))} — {call.outcome}
          {call.document === undefined ? ' · preview unavailable' : ''}
        </Text>
      ))}
      <Text>↑/↓ choose · Enter details · Esc close</Text>
    </>
  );
}
function ReviewContent({
  snapshot,
  review,
  page,
  identity,
  columns,
  rows,
}: Readonly<{
  snapshot: ChatStoreSnapshot;
  review: ToolReviewState;
  page: ReviewPage | undefined;
  identity: Pick<ReviewPage, 'rows' | 'valid'> | undefined;
  columns: number;
  rows: number;
}>): ReactElement {
  const document = review.document,
    diff = document?.preview.diff;
  const target = review.screen === 'card' ? toolReviewTarget(review, columns, rows) : undefined;
  return (
    <>
      {(identity?.rows ?? []).map((row, index) => (
        <Text key={`identity-${index}`}>{row}</Text>
      ))}
      {(target?.rows ?? []).map((row, index) => (
        <Text key={`target-${index}`}>{row}</Text>
      ))}
      {target?.next !== undefined && (
        <Text>Target shortened · {target.hiddenBytes} bytes omitted · [v] inspect full target</Text>
      )}
      <Text>
        {document?.changedLines ?? 0} changed lines · {document?.changedBytes ?? 0} changed bytes ·{' '}
        {document?.masks.length ?? 0} masked spans
      </Text>
      {diff !== undefined && (
        <Text>
          {diff.before === null ? 'New file · ' : ''}
          {diff.before === '' ? 'Before: empty file · ' : ''}
          {diff.after === '' ? 'After: empty file · ' : ''}endings {diff.beforeEndings} →{' '}
          {diff.afterEndings}
        </Text>
      )}
      {(document?.masks.length ?? 0) !== 0 && (
        <Text>
          Approval includes masked bytes. Changed/flagged masks require [v], [r] and visible
          inspection.
        </Text>
      )}
      {(page?.rows ?? []).map((row, index) => (
        <Text key={index}>{row || ' '}</Text>
      ))}
      <Text>
        {page?.hiddenLines ?? 0} hidden lines · {page?.hiddenBytes ?? 0} hidden bytes ·{' '}
        {review.reveal ? 'REVEALED (view only)' : 'masked view'}
      </Text>
      {review.kind === 'approval' && (
        <Text>
          {reviewInspected(review)
            ? 'Inspection requirements met.'
            : 'Approval disabled — inspect required target / masked spans.'}
        </Text>
      )}
      {review.denial !== undefined && (
        <Box flexDirection="column">
          <Text>{denialReasonDisclosure(Math.max(1, columns - 2)).join('\n')}</Text>
          <Text wrap="truncate-end">Reason to deny: {inputDisplay(review.denial)}█</Text>
          <Text wrap="truncate-end">Enter deny · Esc abort</Text>
        </Box>
      )}
      {review.searching && (
        <Text>Search visible source: {inputDisplay(review.query ?? '')}█ · Enter find</Text>
      )}
      <Text>
        {review.screen === 'card'
          ? '[v] full view · [c] reason to deny'
          : 'PgUp/PgDn pages · Home start · [r] reveal · [p] code points · / search · [c] copy masked page · [b] back'}
      </Text>
      {review.kind === 'approval' ? (
        <>
          <Text>
            {snapshot.approval?.cacheable === true
              ? '[y] once · [a] always for named tool (session) · [n] deny · Esc/Ctrl-C abort'
              : '[y] once · [n] deny · Esc/Ctrl-C abort'}
          </Text>
          <Text>Approval cannot override protected-path or permission denials.</Text>
        </>
      ) : (
        <Text>Esc/Ctrl-C close · viewing never executes a tool</Text>
      )}
    </>
  );
}
