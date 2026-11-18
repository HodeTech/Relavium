import { Box, Text, type DOMElement } from 'ink';
import { cleanup, render } from 'ink-testing-library';
import { afterEach, expect, it } from 'vitest';
import { createMeasuredFrameAcknowledgement } from './measured-frame-acknowledgement.js';
import { settleFrames } from './harness-util.js';

afterEach(cleanup);

it('forgets observed and pending frame evidence when terminal custody is lost', async () => {
  let node: DOMElement | null = null;
  render(
    <Box
      ref={(value) => {
        node = value;
      }}
      width={70}
      height={5}
    >
      <Text>Review</Text>
    </Box>,
  );
  await settleFrames();
  let custody = true;
  const snapshot = {};
  const frame = createMeasuredFrameAcknowledgement({
    current: () => snapshot,
    getSize: () => ({ cols: 80, rows: 24 }),
    hasCustody: () => custody,
  });
  expect(frame.commit(snapshot, node, () => Promise.resolve())).toBe(true);
  await Promise.resolve();
  expect(frame.visible(snapshot)).toBe(true);
  let release: (() => void) | undefined;
  frame.commit(
    snapshot,
    node,
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  custody = false;
  expect(frame.visible(snapshot)).toBe(false);
  custody = true;
  expect(frame.visible(snapshot)).toBe(false);
  release?.();
  await Promise.resolve();
  expect(frame.visible(snapshot)).toBe(false);
  frame.commit(snapshot, node, () => Promise.resolve());
  await Promise.resolve();
  expect(frame.visible(snapshot)).toBe(true);
  frame.dispose();
});
