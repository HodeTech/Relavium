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
 *      `key.delete` — ADR-0068(a)); the backspace Probe below checks `key.backspace` ONLY, so this test would FAIL
 *      under ink-6 semantics — it is a genuine ink-major discriminator, not merely a liveness canary,
 *   4. clean `unmount()` teardown.
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

const frameOf = (lastFrame: () => string | undefined): string => lastFrame() ?? '';

describe('ink-7 harness smoke (ink-testing-library 4.0.0)', () => {
  it('mounts and captures the initial frame', async () => {
    const { lastFrame } = render(<Probe />);
    await waitFor(() => frameOf(lastFrame).includes('value:start'));
    expect(lastFrame()).toContain('value:start');
  });

  it('delivers a printable keystroke to a useInput handler', async () => {
    const { lastFrame, stdin } = render(<Probe />);
    await waitFor(() => frameOf(lastFrame).includes('value:start'));
    stdin.write('X');
    await waitFor(() => frameOf(lastFrame).includes('value:startX'));
    expect(lastFrame()).toContain('value:startX');
  });

  it('labels the ink-7 raw backspace byte (\\x7f) as key.backspace, not key.delete', async () => {
    const { lastFrame, stdin } = render(<Probe />);
    await waitFor(() => frameOf(lastFrame).includes('value:start'));
    // The Probe folds `key.backspace` ONLY — under ink 6 the DEL byte arrives as key.delete and NOTHING would
    // change, so this assertion (one char removed → "star") fails on ink 6. That makes it the suite's true ink-7
    // discriminator (empirically: ink 7 reports `bs:1 del:0` for `\x7f`).
    stdin.write('\x7f');
    await waitFor(() => frameOf(lastFrame).includes('value:star'));
    expect(lastFrame()).toContain('value:star');
  });

  it('delivers Enter (\\r) as key.return', async () => {
    const { lastFrame, stdin } = render(<Probe />);
    await waitFor(() => frameOf(lastFrame).includes('value:start'));
    stdin.write('\r');
    await waitFor(() => frameOf(lastFrame).includes('value:submitted'));
    expect(lastFrame()).toContain('value:submitted');
  });

  it('tears down cleanly — a second mount in the same file is unaffected (afterEach cleanup)', async () => {
    const { lastFrame } = render(<Probe />);
    // The prior tests each mounted + relied on `afterEach(cleanup)` to unmount; this one only asserts a fresh mount
    // still captures its own initial frame (no cross-test bleed from a leaked instance).
    await waitFor(() => frameOf(lastFrame).includes('value:start'));
    expect(lastFrame()).toContain('value:start');
  });
});
