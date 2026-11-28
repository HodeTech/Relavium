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
import { CHECKPOINT_STOP, checkpointRule, projectCheckpointCard } from './checkpoint-card.js';
import { withGlyphForm } from './glyphs.js';
import { legend, legendRows } from './legend.js';
import { displayWidth } from './viewport.js';
import {
  createMeasuredFrameAcknowledgement,
  reviewTerminalFits,
  TERMINAL_TOO_SMALL_TEXT,
} from './measured-frame-acknowledgement.js';
import { colorProps, dimProps } from './projection.js';
import { useWaitClock, type WaitClockForm } from './wait-clock.js';

/**
 * The docked continue-checkpoint card ([ADR-0136](../../../../../docs/decisions/0136-a-turn-asks-to-continue-at-a-checkpoint-instead-of-dying-at-a-ceiling.md)
 * §4), drawn below the live region exactly where the approval and question cards are. A sibling of `QuestionCardHost`: it shares
 * only the measured-frame acknowledgement, and input stays with the host's one keyboard owner
 * (`ChatStoreController.handleReviewInput`). Its `Ctrl+Y` counts only once this exact frame has been flushed to the terminal and
 * has been there for the dwell, so a key typed ahead of the card cannot spend rounds.
 */
export function CheckpointCardHost(
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
  const card = snapshot.checkpoint;
  // The wait clock: this host's display value, in no snapshot and read by no guard (ADR-0147 §2).
  const clock = useWaitClock(
    card === undefined ? undefined : snapshot.state.approvalSinceMs,
    props.waitClock,
  );
  // The lockout as the card draws it (`(wait)`): the store's display value, one repaint when it opens; the frame's identity does not change.
  const locked = useSyncExternalStore(
    props.store.answerLock.subscribe,
    props.store.answerLock.read,
  );
  const app = useApp();
  const { stdout } = useStdout();
  const ref = useRef<DOMElement | null>(null);
  const latest = useRef(props);
  latest.current = props;
  const [blocked, setBlocked] = useState<object | undefined>(undefined);
  const [acknowledgement] = useState(() =>
    createMeasuredFrameAcknowledgement<object | undefined>({
      // Keyed on the FRAME the store mints (when the card opens, or is resized or resumed from suspend).
      current: () => latest.current.store.getSnapshot().checkpointFrame,
      getSize: () => latest.current.size,
      hasCustody: () =>
        latest.current.hasCustody() &&
        stdout.writable &&
        !stdout.destroyed &&
        !stdout.writableEnded &&
        !stdout.errored,
      // The dwell before `Ctrl+Y` counts from the moment the exact frame is known to be flushed, not from when it was drawn.
      onAcknowledge: (frame) => {
        if (frame !== undefined) latest.current.store.acknowledgeCheckpointFrame(frame);
      },
    }),
  );
  useEffect(() => {
    props.store.bindCheckpointVisibility(() =>
      acknowledgement.visible(props.store.getSnapshot().checkpointFrame),
    );
    return () => props.store.bindCheckpointVisibility(undefined);
  }, [props.store, acknowledgement]);
  useEffect(() => () => acknowledgement.dispose(), [acknowledgement]);
  // A resize changes what is on screen: forget what was acknowledged. The store also mints a new frame for the open card
  // (`invalidateToolReview` runs on every resize and resume), which is what lets a blocked card recover.
  useLayoutEffect(() => {
    acknowledgement.invalidate();
  }, [props.size.cols, props.size.rows, acknowledgement]);
  const shown = card === undefined ? undefined : snapshot.checkpointFrame;
  // Commit on EVERY render, as the other cards' hosts do: a flush that lost custody is retried by the next render instead of
  // leaving the card silently unanswerable.
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
          CHECKPOINT_STOP,
          props.size.cols,
          displayWidth,
        ).join('\n')}
      </Text>
    );
  if (blocked === shown)
    return (
      <Text>
        {legend([{ text: 'Checkpoint unavailable — enlarge the terminal' }], CHECKPOINT_STOP)}
      </Text>
    );
  const color = props.color === true;
  const view = withGlyphForm(props.color === false, () =>
    projectCheckpointCard(card, props.size.cols, locked),
  );
  return (
    <Box ref={ref} flexDirection="column" flexShrink={0}>
      <Text {...colorProps(color, 'yellow')} wrap="truncate-end">
        {withGlyphForm(props.color === false, () => checkpointRule(props.size.cols, clock))}
      </Text>
      <Text wrap="truncate-end">{view.fact}</Text>
      {view.keys.map((row, index) => (
        <Text key={`keys-${String(index)}`} {...dimProps(color)} wrap="truncate-end">
          {row}
        </Text>
      ))}
    </Box>
  );
}
