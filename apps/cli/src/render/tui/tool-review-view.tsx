import { Box, Text, useApp, useStdout, type DOMElement } from 'ink';
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
        <Text>Reason to deny: {inputDisplay(review.denial)}█ · Enter deny · Esc abort</Text>
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
