import { Box, useApp, useStdout, type DOMElement } from 'ink';
import { Text } from './text.js';
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
  TERMINAL_TOO_SMALL_TEXT,
} from './measured-frame-acknowledgement.js';
import { sanitizeInline } from '../sanitize.js';
import { EmphText } from './emphasis-view.js';
import { SELECTED_ROW, type EmphasisSet } from './emphasis.js';
import { withGlyphForm } from './glyphs.js';
import { colorProps, dimProps } from './projection.js';
import { legend, legendRows } from './legend.js';
import { screenText } from './screen-text.js';
import { displayWidth } from './viewport.js';
import {
  QUESTION_STOP,
  projectQuestionCard,
  questionRule,
  type QuestionRowTone,
} from './question-card.js';
import { useWaitClock, type WaitClockForm } from './wait-clock.js';

/** The colour of a row by its tone (none with colour off); the weight of a row is {@link toneEmphasis}, which colour does not switch. */
function toneProps(tone: QuestionRowTone, color: boolean): Record<string, unknown> {
  switch (tone) {
    case 'highlight':
      return colorProps(color, 'cyan');
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

/** The header is bold and the highlighted option is the selected row, with colour on and off alike. */
function toneEmphasis(tone: QuestionRowTone): EmphasisSet | undefined {
  if (tone === 'header') return 'bold';
  return tone === 'highlight' ? SELECTED_ROW : undefined;
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
    /** How the sheet's wait clock is drawn (ADR-0147 §2): `ticking` in the alternate screen, static inline (the default: no timer). */
    waitClock?: WaitClockForm | undefined;
  }>,
): ReactElement | null {
  const snapshot = useSyncExternalStore(props.store.subscribe, props.store.getSnapshot);
  const card = snapshot.question;
  // The wait clock: this host's display value, in no snapshot and read by no guard (ADR-0147 §2).
  const clock = useWaitClock(
    card === undefined ? undefined : snapshot.state.approvalSinceMs,
    props.waitClock ?? 'static',
  );
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
        {legendRows(
          [{ text: TERMINAL_TOO_SMALL_TEXT }],
          QUESTION_STOP,
          props.size.cols,
          displayWidth,
        ).join('\n')}
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
        {withGlyphForm(props.color === false, () => questionRule(props.size.cols, clock))}
      </Text>
      {view.body.map((row, index) => (
        <EmphText
          key={index}
          {...toneProps(row.tone, color)}
          emphasis={toneEmphasis(row.tone)}
          wrap="truncate-end"
        >
          {/* the model's header and option labels are drawn inside a style pair: the core refuses a control character in them, and this is the floor under that;
              then the screen's filter, as for a reply's row: what a terminal draws wider than the card measured (skin tones on a letter: the core's
              bounds let a row of them reach 108 columns at 80) never wraps the card (MVP-11 unit 9, review round 2, S2-4) */}
          {screenText(sanitizeInline(row.text)) || ' '}
        </EmphText>
      ))}
      {view.keys.map((row, index) => (
        <Text key={`keys-${String(index)}`} {...dimProps(color)} wrap="truncate-end">
          {row}
        </Text>
      ))}
    </Box>
  );
}
