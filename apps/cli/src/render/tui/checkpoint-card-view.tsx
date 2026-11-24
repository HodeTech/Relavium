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
import { CHECKPOINT_STOP, projectCheckpointCard } from './checkpoint-card.js';
import { withGlyphForm } from './glyphs.js';
import { legend } from './legend.js';
import {
  createMeasuredFrameAcknowledgement,
  reviewTerminalFits,
} from './measured-frame-acknowledgement.js';
import { colorProps, dimProps } from './projection.js';

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
  }>,
): ReactElement | null {
  const snapshot = useSyncExternalStore(props.store.subscribe, props.store.getSnapshot);
  const card = snapshot.checkpoint;
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
        {legend(
          [{ text: 'Checkpoint: terminal too small — resize to at least 80×24' }],
          CHECKPOINT_STOP,
        )}
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
    projectCheckpointCard(card, props.size.cols),
  );
  return (
    <Box ref={ref} flexDirection="column" flexShrink={0}>
      <Text {...colorProps(color, 'yellow')} wrap="truncate-end">
        {view.rule}
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
