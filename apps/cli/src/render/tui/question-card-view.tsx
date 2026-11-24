import { Box, Text, useApp, useStdout, type DOMElement } from 'ink';
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactElement,
} from 'react';

import type { ChatStoreController } from './chat-store.js';
import {
  createMeasuredFrameAcknowledgement,
  reviewTerminalFits,
} from './measured-frame-acknowledgement.js';
import { withGlyphForm } from './glyphs.js';
import { colorProps, dimProps } from './projection.js';
import { legend } from './legend.js';
import { QUESTION_STOP, projectQuestionCard, type QuestionRowTone } from './question-card.js';

function toneProps(tone: QuestionRowTone, color: boolean): Record<string, unknown> {
  switch (tone) {
    case 'header':
      return { bold: true };
    case 'highlight':
      return color ? { color: 'cyan', bold: true } : { bold: true };
    case 'chosen':
      return colorProps(color, 'green');
    case 'description':
    case 'own':
    case 'pending':
      return dimProps(color);
    case 'hint':
      return colorProps(color, 'yellow');
    default:
      return {};
  }
}

/**
 * The docked `ask_user` card ([ADR-0132](../../../../../docs/decisions/0132-the-model-can-ask-the-user-a-structured-question.md)), drawn
 * below the live region exactly where the approval card is. A sibling of `ToolReviewHost`, not a mode of it: a question is not a
 * tool review, its rule says it is not an approval, and it shares only the measured-frame acknowledgement. Input stays with the
 * host's existing single keyboard owner (`ChatStoreController.handleReviewInput`).
 */
export function QuestionCardHost(
  props: Readonly<{
    store: ChatStoreController;
    size: { cols: number; rows: number };
    hasCustody: () => boolean;
    /** Whether colour output is on. */
    color?: boolean | undefined;
  }>,
): ReactElement | null {
  const snapshot = useSyncExternalStore(props.store.subscribe, props.store.getSnapshot);
  const card = snapshot.question;
  const app = useApp();
  const { stdout } = useStdout();
  const ref = useRef<DOMElement | null>(null);
  const latest = useRef(props);
  latest.current = props;
  const [blocked, setBlocked] = useState<object | undefined>(undefined);
  const [acknowledgement] = useState(() =>
    createMeasuredFrameAcknowledgement<object | undefined>({
      // Keyed on the FRAME the store mints (when the card opens, moves to its next question, or is resized/resumed) — not on the
      // whole card state, so a key that only moves the highlight or types a letter needs no fresh acknowledgement, while a
      // question the person has not seen yet does (ADR-0132 §3).
      current: () => latest.current.store.getSnapshot().questionFrame,
      getSize: () => latest.current.size,
      hasCustody: () =>
        latest.current.hasCustody() &&
        stdout.writable &&
        !stdout.destroyed &&
        !stdout.writableEnded &&
        !stdout.errored,
    }),
  );
  useEffect(() => {
    props.store.bindQuestionVisibility(() =>
      acknowledgement.visible(props.store.getSnapshot().questionFrame),
    );
    return () => props.store.bindQuestionVisibility(undefined);
  }, [props.store, acknowledgement]);
  useEffect(() => () => acknowledgement.dispose(), [acknowledgement]);
  // A resize changes what is on screen: forget what was acknowledged. The store also mints a new frame for the open question
  // (`invalidateToolReview` runs on every resize and resume), which is what lets a card that was blocked recover.
  useLayoutEffect(() => {
    acknowledgement.invalidate();
  }, [props.size.cols, props.size.rows, acknowledgement]);
  const shown = card === undefined ? undefined : snapshot.questionFrame;
  // Commit on EVERY render, as the approval card's host does: a flush that lost custody (Ctrl-Z in the window) is retried by
  // the next render instead of leaving the card silently unanswerable.
  useLayoutEffect(() => {
    if (shown === undefined) {
      acknowledgement.invalidate();
      if (blocked !== undefined) setBlocked(undefined);
      return;
    }
    if (blocked !== undefined && blocked !== shown) setBlocked(undefined);
    if (!reviewTerminalFits(props.size) || blocked === shown) return;
    if (!acknowledgement.commit(shown, ref.current, () => app.waitUntilRenderFlush()))
      setBlocked(shown);
  });
  if (card === undefined) return null;
  if (!reviewTerminalFits(props.size))
    return (
      <Text>
        {legend([{ text: 'Terminal too small — resize to at least 80×24' }], QUESTION_STOP)}
      </Text>
    );
  if (blocked === shown)
    return (
      <Text>
        {legend([{ text: 'Question unavailable — enlarge the terminal' }], QUESTION_STOP)}
      </Text>
    );
  const color = props.color === true;
  // The card's marks are the glyph table's; an absent `color` is the Unicode form (a view mounted without the prop draws as it always did).
  const view = withGlyphForm(props.color === false, () =>
    projectQuestionCard(card, props.size.cols, {
      guideNote: snapshot.mode === 'accept-edits' || snapshot.mode === 'auto',
    }),
  );
  return (
    <Box ref={ref} flexDirection="column" flexShrink={0}>
      <Text {...colorProps(color, 'cyan')} wrap="truncate-end">
        {view.rule}
      </Text>
      {view.body.map((row, index) => (
        <Text key={index} {...toneProps(row.tone, color)} wrap="truncate-end">
          {row.text.length === 0 ? ' ' : row.text}
        </Text>
      ))}
      {view.keys.map((row, index) => (
        <Text key={`keys-${String(index)}`} {...dimProps(color)} wrap="truncate-end">
          {row}
        </Text>
      ))}
    </Box>
  );
}
