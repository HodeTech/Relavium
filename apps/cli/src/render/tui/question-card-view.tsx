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
import { colorProps, dimProps } from './projection.js';
import { projectQuestionCard, type QuestionRowTone } from './question-card.js';
import { currentQuestion, type QuestionCardState } from './question-card-model.js';

/**
 * The question being shown, by identity. The measured-frame acknowledgement is keyed on it — not on the whole card state — so a
 * keystroke that only moves the highlight or types a letter does not need a fresh acknowledgement (the person who pressed it
 * saw the card), while moving to the NEXT question does: a key typed ahead of a question the person has not seen yet cannot
 * choose for them (ADR-0132 §3).
 */
function shownQuestion(card: QuestionCardState | undefined): object | undefined {
  return card === undefined ? undefined : currentQuestion(card);
}

function toneProps(tone: QuestionRowTone, color: boolean): Record<string, unknown> {
  switch (tone) {
    case 'header':
      return { bold: true };
    case 'highlight':
      return color ? { color: 'cyan', bold: true } : { bold: true };
    case 'description':
    case 'own':
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
  const committed = useRef<object | undefined>(undefined);
  const [blocked, setBlocked] = useState<object | undefined>(undefined);
  const [acknowledgement] = useState(() =>
    createMeasuredFrameAcknowledgement<object | undefined>({
      current: () => shownQuestion(latest.current.store.getSnapshot().question),
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
      acknowledgement.visible(shownQuestion(props.store.getSnapshot().question)),
    );
    return () => props.store.bindQuestionVisibility(undefined);
  }, [props.store, acknowledgement]);
  useEffect(() => () => acknowledgement.dispose(), [acknowledgement]);
  // A resize changes what is on screen: forget what was acknowledged, so the card must be measured and flushed again.
  useLayoutEffect(() => {
    acknowledgement.invalidate();
    committed.current = undefined;
  }, [props.size.cols, props.size.rows, acknowledgement]);
  const shown = shownQuestion(card);
  useLayoutEffect(() => {
    if (shown === undefined) {
      acknowledgement.invalidate();
      committed.current = undefined;
      if (blocked !== undefined) setBlocked(undefined);
      return;
    }
    if (blocked !== undefined && blocked !== shown) setBlocked(undefined);
    if (!reviewTerminalFits(props.size) || blocked === shown || committed.current === shown) return;
    committed.current = shown;
    if (!acknowledgement.commit(shown, ref.current, () => app.waitUntilRenderFlush()))
      setBlocked(shown);
  });
  if (card === undefined) return null;
  if (!reviewTerminalFits(props.size))
    return (
      <Text>Terminal too small — resize to at least 80×24. Esc or Ctrl-C stops the turn.</Text>
    );
  if (blocked === shown)
    return <Text>Question unavailable — enlarge the terminal. Esc or Ctrl-C stops the turn.</Text>;
  const color = props.color === true;
  const view = projectQuestionCard(card, props.size.cols);
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
