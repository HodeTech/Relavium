import { Box, Text, useInput } from 'ink';
import { render } from 'ink-testing-library';
import { useState } from 'react';
import type { ReactElement } from 'react';
import { describe, expect, it } from 'vitest';

/**
 * The ink-7 harness smoke test (2.6.F Step 3, ADR-0068 part f) — the workspace's FIRST `.test.tsx`.
 *
 * ink-testing-library 4.0.0 was authored against ink 5 and declares no `ink` peer (only `@types/react` >= 18),
 * so its compatibility with the ink 7 we adopted at Step 2 is not guaranteed by the dependency graph — it is
 * PINNED here empirically. This proves the harness capabilities the renderer suite depends on hold under ink 7's
 * pure-ESM, React-19 reconciler:
 *   1. mount + `lastFrame()` frame capture,
 *   2. `stdin.write(...)` key delivery reaching a `useInput` handler (incl. the ink-7 raw backspace byte `\x7f`),
 *   3. clean `unmount()` teardown.
 *
 * TIMING CONTRACT (load-bearing for every renderer `.test.tsx`): ink renders through React 19's reconciler, which
 * flushes a state update scheduled from a stdin `data` event on a LATER microtask — so a frame assertion must
 * `await flush()` after a `stdin.write(...)`, never read `lastFrame()` synchronously on the same tick. `flush()`
 * yields the macrotask queue (`setImmediate`) so the commit lands. This is the canonical pattern the component
 * suites reuse; if a future ink / ink-testing-library bump breaks the render/stdin contract, THIS test fails first.
 */

/** Yield until ink's React-19 reconciler has committed the frame scheduled by the preceding `stdin.write`. */
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function Probe(): ReactElement {
  const [text, setText] = useState('start');
  useInput((input, key) => {
    if (key.backspace || key.delete) {
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

describe('ink-7 harness smoke (ink-testing-library 4.0.0)', () => {
  it('mounts and captures the initial frame', async () => {
    const { lastFrame, unmount } = render(<Probe />);
    await flush();
    expect(lastFrame()).toContain('value:start');
    unmount();
  });

  it('delivers a printable keystroke to a useInput handler', async () => {
    const { lastFrame, stdin, unmount } = render(<Probe />);
    await flush();
    stdin.write('X');
    await flush();
    expect(lastFrame()).toContain('value:startX');
    unmount();
  });

  it('maps the ink-7 raw backspace byte (\\x7f) to key.backspace', async () => {
    const { lastFrame, stdin, unmount } = render(<Probe />);
    await flush();
    // ink 7 emits the DEL byte (0x7f) as key.backspace (ink 6 mislabeled it key.delete — ADR-0068; the Step-2
    // reducer already dual-folds both, so the raw parse path is what this pins). Assert the byte reaches the fold.
    stdin.write('\x7f');
    await flush();
    expect(lastFrame()).toContain('value:star');
    unmount();
  });

  it('delivers Enter (\\r) as key.return', async () => {
    const { lastFrame, stdin, unmount } = render(<Probe />);
    await flush();
    stdin.write('\r');
    await flush();
    expect(lastFrame()).toContain('value:submitted');
    unmount();
  });

  it('unmounts without throwing and keeps the final frame a string', async () => {
    const { lastFrame, unmount } = render(<Probe />);
    await flush();
    unmount();
    expect(typeof lastFrame()).toBe('string');
  });
});
