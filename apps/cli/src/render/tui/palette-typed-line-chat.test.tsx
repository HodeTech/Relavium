import { cleanup, render as renderCapture } from 'ink-testing-library';
import { useStdout } from 'ink';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ChatApp } from './chat-ink.js';
import { createChatStore } from './chat-store.js';
import { settleFrames, waitFor } from './harness-util.js';
import { INLINE_TRANSCRIPT_BOUND } from './session-view-model.js';

/**
 * A line typed in the `/` palette of a stand-alone chat is a line, not a query to throw away (MVP-11 Step 2 review round 2, U1, A2). `/` at an
 * empty prompt opens the palette, so `/doctor --deep` became a query that matches no row and `Enter` closed the palette and emptied the draft;
 * `/resume` said 'no matching command' and then lost the text. The line now goes down the dispatch a typed line takes, through the mounted
 * `ChatApp`, so the keys are real bytes. The Home-hosted chat is `palette-typed-line.test.ts`. A new file.
 */
afterEach(cleanup);

function WritableCapture(props: { readonly children: ReactElement }): ReactElement {
  const { stdout } = useStdout();
  Object.defineProperty(stdout, 'writable', { value: true });
  return props.children;
}

function mountChat() {
  const store = createChatStore(false, undefined, INLINE_TRANSCRIPT_BOUND);
  const submitted: string[] = [];
  const h = renderCapture(
    <WritableCapture>
      <ChatApp
        store={store}
        onSubmit={(message) => {
          submitted.push(message);
          return Promise.resolve();
        }}
        shouldStop={() => false}
        onExit={vi.fn()}
        onError={() => {}}
        onModeChange={() => {}}
      />
    </WritableCapture>,
  );
  return { h, submitted };
}

async function typeInPalette(h: ReturnType<typeof mountChat>['h'], text: string): Promise<void> {
  await waitFor(() => (h.lastFrame() ?? '').length > 0);
  h.stdin.write('/');
  await waitFor(() => (h.lastFrame() ?? '').includes('Enter run'));
  for (const char of text) h.stdin.write(char);
  await settleFrames();
  h.stdin.write('\r');
}

describe('a line typed in the palette of a stand-alone chat', () => {
  it.each(['/doctor --deep', '/cost --release', '/trim 20', '/effort high', '/mode plan'])(
    '%s is sent to the chat’s own dispatch with its arguments, and the palette closes',
    async (line) => {
      const { h, submitted } = mountChat();
      await typeInPalette(h, line.slice(1));
      await waitFor(() => submitted.length > 0);
      expect(submitted).toEqual([line]);
      expect(h.lastFrame() ?? '').not.toContain('Enter run');
    },
  );

  it.each(['/resume', '/res', '/sta', '/sav', '/su', '/end', '/ini', '/sa'])(
    '%s, which matches no row that may be run or has none highlighted, is sent as typed and runs no row in its place',
    async (line) => {
      const { h, submitted } = mountChat();
      await typeInPalette(h, line.slice(1));
      await waitFor(() => submitted.length > 0);
      expect(
        submitted,
        'the line the person typed: /clear, /compact and /trim run nothing',
      ).toEqual([line]);
    },
  );

  it('still runs the highlighted row for a query that has one, and /models for the empty one', async () => {
    const { h, submitted } = mountChat();
    await typeInPalette(h, 'cost');
    await waitFor(() => submitted.length > 0);
    expect(submitted).toEqual(['/cost']);
    const again = mountChat();
    await typeInPalette(again.h, '');
    await waitFor(() => again.submitted.length > 0);
    expect(again.submitted).toEqual(['/models']);
  });

  it('sends the line without the blanks around it, and a query of blanks is the empty query: the first row', async () => {
    const trailing = mountChat();
    await typeInPalette(trailing.h, 'trim 20  ');
    await waitFor(() => trailing.submitted.length > 0);
    expect(trailing.submitted).toEqual(['/trim 20']);
    const blanks = mountChat();
    await typeInPalette(blanks.h, '   ');
    await waitFor(() => blanks.submitted.length > 0);
    expect(
      blanks.submitted,
      'blanks filter nothing: Enter runs the first row, as for an empty query',
    ).toEqual(['/models']);
  });
});
