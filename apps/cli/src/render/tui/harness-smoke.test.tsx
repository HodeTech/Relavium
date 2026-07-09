import { Box, Text, useInput } from 'ink';
import { cleanup, render } from 'ink-testing-library';
import { useState } from 'react';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import { waitFor } from './harness-util.js';

/**
 * The ink-7 harness smoke test (2.6.F Step 3, ADR-0068 part f) — the workspace's FIRST `.test.tsx`.
 *
 * ink-testing-library 4.0.0 was authored against ink 5 and declares no `ink` peer (only `@types/react` >= 18),
 * so its compatibility with the ink 7 we adopted at Step 2 is not guaranteed by the dependency graph — it is
 * PINNED here empirically. This proves the harness capabilities the renderer suite depends on hold under ink 7's
 * pure-ESM, React-19 reconciler:
 *   1. mount + `lastFrame()` frame capture,
 *   2. `stdin.write(...)` key delivery reaching a `useInput` handler,
 *   3. the ink-7-SPECIFIC contract: the raw DEL byte `\x7f` is labelled `key.backspace` (ink 6 labelled it
 *      `key.delete` — ADR-0068(a)); the backspace Probe below checks `key.backspace` ONLY, so this test FAILS
 *      under ink-6 semantics — it is a genuine ink-major discriminator, not merely a liveness canary,
 *   4. clean `unmount()` teardown.
 *
 * Every frame assertion is an EXACT match on the (trimmed) one-line frame, never `toContain`. That is load-bearing,
 * not style: `"value:start".includes("value:star")` is TRUE, so a `toContain('value:star')` backspace assertion
 * passes against the UNCHANGED initial frame and silently stops discriminating ink 6 (where the DEL byte arrives as
 * `key.delete`, the Probe ignores it, and nothing is deleted). The Probe renders exactly one line, so equality is
 * both available and the only assertion that can fail for the right reason.
 *
 * TIMING CONTRACT (load-bearing for every renderer `.test.tsx`): ink renders through React 19's reconciler, which
 * flushes a state update scheduled from a stdin `data` event on a LATER microtask — so a frame assertion must
 * `await flush()` after a `stdin.write(...)`, never read `lastFrame()` synchronously on the same tick (see
 * {@link flush} for why one macrotask yield suffices). If a future ink / ink-testing-library bump breaks the
 * render/stdin contract or the `key.backspace` labelling, THIS test fails first — localizing the regression to the
 * harness rather than to a component suite. `afterEach(cleanup)` unmounts every instance even when an assertion
 * throws, so a failing test cannot leak a live ink tree (with its stdin/store listeners) into the rest of the run.
 */

afterEach(cleanup);

function Probe(): ReactElement {
  const [text, setText] = useState('start');
  useInput((input, key) => {
    // Check `key.backspace` ONLY (not `|| key.delete`) so the `\x7f` case discriminates ink 7 (backspace) from
    // ink 6 (delete). The PRODUCTION reducers deliberately dual-fold both for defence — that belt-and-suspenders is
    // unit-tested in chat-input.test.ts; here the point is to pin ink 7's raw labelling itself.
    if (key.backspace) {
      setText((cur) => cur.slice(0, -1));
      return;
    }
    if (key.return) {
      setText('submitted');
      return;
    }
    setText((cur) => cur + input);
  });
  return (
    <Box>
      <Text>value:{text}</Text>
    </Box>
  );
}

/** The Probe's single rendered line, trimmed — so every assertion below can be an EXACT match (see the header). */
const frameOf = (lastFrame: () => string | undefined): string => (lastFrame() ?? '').trim();

describe('ink-7 harness smoke (ink-testing-library 4.0.0)', () => {
  it('mounts and captures the initial frame', async () => {
    const { lastFrame } = render(<Probe />);
    await waitFor(() => frameOf(lastFrame) === 'value:start');
    expect(frameOf(lastFrame)).toBe('value:start');
  });

  // The three key-delivery cases share ONE shape (mount → settle → write one byte → assert the next frame), so they
  // are parameterized rather than restated. The `\x7f` case is the load-bearing one: the Probe folds `key.backspace`
  // ONLY, so under ink 6 the DEL byte arrives as `key.delete`, nothing is deleted, and the frame stays `value:start`
  // — which is NOT equal to `value:star`, so the case fails. That exact-equality is what makes this suite an ink-MAJOR
  // discriminator rather than a liveness canary (empirically: ink 7 reports `bs:1 del:0` for `\x7f`).
  it.each([
    {
      name: 'delivers a printable keystroke to a useInput handler',
      bytes: 'X',
      frame: 'value:startX',
    },
    {
      name: 'labels the ink-7 raw backspace byte (\\x7f) as key.backspace, not key.delete',
      bytes: '\x7f',
      frame: 'value:star',
    },
    { name: 'delivers Enter (\\r) as key.return', bytes: '\r', frame: 'value:submitted' },
  ])('$name', async ({ bytes, frame }) => {
    const { lastFrame, stdin } = render(<Probe />);
    await waitFor(() => frameOf(lastFrame) === 'value:start');
    stdin.write(bytes);
    await waitFor(() => frameOf(lastFrame) === frame);
    expect(frameOf(lastFrame)).toBe(frame);
  });

  it('tears down cleanly — a second mount in the same file is unaffected (afterEach cleanup)', async () => {
    const { lastFrame } = render(<Probe />);
    // The prior tests each mounted + relied on `afterEach(cleanup)` to unmount; this one only asserts a fresh mount
    // still captures its own initial frame (no cross-test bleed from a leaked instance).
    await waitFor(() => frameOf(lastFrame) === 'value:start');
    expect(frameOf(lastFrame)).toBe('value:start');
  });
});
